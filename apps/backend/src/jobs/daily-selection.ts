import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { aiClient } from "../ai/client";
import { loadPrompts } from "../ai/prompts";
import {
  parseDailyMembersResponse,
  parseDailyNarrateResponse,
  parseDailySelectResponse,
} from "../ai/response-parser";
import { db, schema } from "../db";
import { createStorageAdapter } from "../storage";
import { buildCandidatePool, getRecentPickedPhotoIds } from "./daily-selection/candidate-pool";
import { buildRelatedPool } from "./daily-selection/related-pool";

/**
 * 生成北京时间 YYYY-MM-DD 格式的日期字符串
 */
function formatPickDate(): string {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const y = shanghai.getFullYear();
  const m = String(shanghai.getMonth() + 1).padStart(2, "0");
  const d = String(shanghai.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * daily-selection Worker
 *
 * 新三阶段 AI 流水线：
 * 0. 构造 4 源候选池（historyToday / sameMonth / sameSeason / agedRandom）
 * 1. 文本模型评选 hero（带 source / yearsAgo 标签）
 * 1.5. 构造 hero 关联候选池 → AI 选 members（视频 hero 跳过）
 * 2. 视觉模型为 hero 生成怀旧叙事（不变）
 * 3. 写入 dailyPicks（含 members JSON 列）
 */
export async function dailySelectionWorker(job: Job): Promise<void> {
  job.log("开始每日精选（新版 4 源候选池）");

  const pickDate = formatPickDate();
  job.log(`pickDate: ${pickDate}`);

  // ---- 阶段 0: 构造候选池 ----
  const recentIds = await getRecentPickedPhotoIds(30);
  job.log(`最近 30 天去重池: ${recentIds.size} 个 photoId`);

  const candidates = await buildCandidatePool({
    now: new Date(),
    excludeIds: recentIds,
    maxN: 20,
  });

  job.log(`4 源候选池共 ${candidates.length} 张候选`);

  if (candidates.length === 0) {
    job.log("今日无候选照片，跳过每日精选");
    return;
  }

  // ---- 阶段 1: 文本评选 hero ----
  job.log("阶段 1: 文本模型评选 hero...");

  const selectPrompts = await loadPrompts("v2", "daily/select");

  // 构建候选摘要文本（带 source / yearsAgo 标签）
  const SOURCE_LABELS: Record<string, string> = {
    historyToday: "历史上的今天",
    sameMonth: "同月份",
    sameSeason: "同季节",
    agedRandom: "久远抽样",
  };

  const candidateSummaries = candidates
    .map((c, i) => {
      const emotionalSummary =
        c.emotionalAnalysis && typeof c.emotionalAnalysis === "object"
          ? `${(c.emotionalAnalysis as Record<string, unknown>).primary || "未知"} / ${(c.emotionalAnalysis as Record<string, unknown>).secondary || "未知"}`
          : "未知";
      const mt =
        (c.mediaType ?? "image") === "video"
          ? `[视频 ${Math.round(c.durationSec ?? 0)} 秒]`
          : "[图片]";
      const sourceLabel = SOURCE_LABELS[c.source] ?? c.source;
      const yearsLabel = c.yearsAgo >= 1 ? `${c.yearsAgo} 年前` : "近期";
      return [
        `[${i}] ${mt} [来源: ${sourceLabel} / ${yearsLabel}] 美学评分: ${c.aestheticScore ?? "N/A"} 加权分: ${c.weightedScore.toFixed(2)}`,
        `    情感: ${emotionalSummary}`,
        `    标签: ${Array.isArray(c.tags) ? (c.tags as { name: string }[]).map((t) => t.name).join("、") : "无"}`,
        `    描述: ${(c.narrative ?? "无描述").slice(0, 80)}`,
      ].join("\n");
    })
    .join("\n\n");

  const selectUserPrompt = selectPrompts.user.replace("{候选摘要列表}", candidateSummaries);
  job.log(`候选摘要长度: ${selectUserPrompt.length} chars`);

  let selectedIndex = 0;

  try {
    const selectRawResponse = await aiClient.chat(selectUserPrompt, selectPrompts.system);
    job.log(`评选响应长度: ${selectRawResponse.length} chars`);

    const {
      parsed: selectParsed,
      error: selectError,
      fallback: selectFallback,
    } = parseDailySelectResponse(selectRawResponse);

    if (selectError) {
      job.log(`评选解析警告: ${selectError}`);
    }

    const selected = selectParsed ?? selectFallback;
    selectedIndex = Math.min(Math.max(0, selected.selectedIndex), candidates.length - 1);
  } catch (err) {
    // 阶段 1 AI 失败 → fallback: 选 weightedScore 最高的候选（已按分降序）
    job.log(
      `阶段 1 AI 失败: ${err instanceof Error ? err.message : String(err)}，fallback 到最高加权分照片`,
    );
    selectedIndex = 0;
  }

  const hero = candidates[selectedIndex];
  if (!hero) {
    job.log("内部错误: 胜者索引无效");
    return;
  }

  job.log(
    `选中 hero: index=${selectedIndex}, photoId=${hero.photoId}, source=${hero.source}, yearsAgo=${hero.yearsAgo}`,
  );

  // ---- 阶段 1.5: hero 关联候选池 + AI 选 members ----
  const isVideo = (hero.mediaType ?? "image") === "video";
  let members: { photoId: string; caption: string }[] = [];

  if (isVideo) {
    // 视频 hero 跳过阶段 1.5（设计文档明确不构造关联池）
    job.log("视频 hero: 跳过阶段 1.5，members = []");
  } else {
    job.log("阶段 1.5: 构造关联候选池...");

    // 排除集合 = 30 天去重 + hero 自身
    const excludeForRelated = new Set([...recentIds, hero.photoId]);
    const related = await buildRelatedPool(hero, excludeForRelated);
    job.log(`关联候选池: ${related.length} 张`);

    if (related.length > 0) {
      try {
        const membersPrompts = await loadPrompts("v2", "daily/members");

        // 构造 hero 信息
        const heroEmotion =
          hero.emotionalAnalysis && typeof hero.emotionalAnalysis === "object"
            ? `${(hero.emotionalAnalysis as Record<string, unknown>).primary || "未知"}`
            : "未知";
        const heroTagsStr = Array.isArray(hero.tags)
          ? (hero.tags as { name: string }[]).map((t) => t.name).join("、")
          : "无";

        // 构造关联候选摘要（candidate narrative 截断到 80 字）
        const relatedSummaries = related
          .map((r, i) => {
            const mt = (r.mediaType ?? "image") === "video" ? "[视频]" : "[图片]";
            const rEmotion =
              r.emotionalAnalysis && typeof r.emotionalAnalysis === "object"
                ? `${(r.emotionalAnalysis as Record<string, unknown>).primary || "未知"}`
                : "未知";
            const rTags = Array.isArray(r.tags)
              ? (r.tags as { name: string }[]).map((t) => t.name).join("、")
              : "无";
            const desc = (r.narrative ?? "无描述").slice(0, 80);
            return [
              `[候选${i}] ${mt} 时间: ${r.takenAt ?? "未知"}`,
              `  情感: ${rEmotion} | 标签: ${rTags}`,
              `  描述: ${desc}`,
            ].join("\n");
          })
          .join("\n\n");

        const membersUserPrompt = membersPrompts.user
          .replace("{hero_taken_at}", hero.takenAt ?? "未知")
          .replace("{hero_emotion}", heroEmotion)
          .replace("{hero_tags}", heroTagsStr)
          .replace("{hero_narrative}", (hero.narrative ?? "无描述").slice(0, 80))
          .replace("{候选摘要列表}", relatedSummaries);

        const membersRawResponse = await aiClient.chat(membersUserPrompt, membersPrompts.system);
        job.log(`members 响应长度: ${membersRawResponse.length} chars`);

        const { parsed: membersParsed, error: membersError } = parseDailyMembersResponse(
          membersRawResponse,
          related.length,
        );

        if (membersError) {
          job.log(`members 解析警告: ${membersError}`);
        }

        if (membersParsed && membersParsed.members.length > 0) {
          // 将 index 映射到真实 photoId（parser 已过滤越界，此处再做防御性 filter 满足类型收窄）
          members = membersParsed.members.flatMap((m) => {
            const r = related[m.index];
            return r ? [{ photoId: r.photoId, caption: m.caption }] : [];
          });
          job.log(`AI 选出 ${members.length} 张 members`);
        }
      } catch (err) {
        job.log(
          `阶段 1.5 AI 失败: ${err instanceof Error ? err.message : String(err)}，fallback 到 members = []`,
        );
        members = [];
      }
    }
  }

  // ---- 阶段 2: 视觉模型怀旧叙事（不变，仅针对 hero）----
  job.log("阶段 2: 视觉模型生成怀旧叙事...");

  const promptPath = isVideo ? "daily/narrate-video" : "daily/narrate";
  const narratePrompts = await loadPrompts("v2", promptPath);

  // 元数据注入：narrate prompt 含 {date}/{years_ago}/{tags}/{emotions}/{narrative} 占位符。
  // 不替换会把字面量原样发给 AI，导致叙事质量塌陷。
  const heroDate = (hero.takenAt ?? "").split("T")[0]?.split(" ")[0] || "未知日期";
  const heroTagsForNarrate = Array.isArray(hero.tags)
    ? (hero.tags as { name: string }[]).map((t) => t.name).join("、")
    : "无";
  const heroEmotions =
    hero.emotionalAnalysis && typeof hero.emotionalAnalysis === "object"
      ? `${(hero.emotionalAnalysis as Record<string, unknown>).primary || "未知"} / ${(hero.emotionalAnalysis as Record<string, unknown>).secondary || "未知"}`
      : "未知";

  let userText = narratePrompts.user
    .replace("{date}", heroDate)
    .replace("{years_ago}", String(hero.yearsAgo ?? 0))
    .replace("{tags}", heroTagsForNarrate)
    .replace("{emotions}", heroEmotions)
    .replace("{narrative}", hero.narrative ?? "无描述");

  if (isVideo) {
    // 读取 hero 的 photoAnalyses 获取 transcript / videoPacing
    const analysisRows = await db
      .select({
        transcript: schema.photoAnalyses.transcript,
        videoPacing: schema.photoAnalyses.videoPacing,
      })
      .from(schema.photoAnalyses)
      .where(eq(schema.photoAnalyses.photoId, hero.photoId))
      .limit(1);
    const analysis = analysisRows[0];
    const transcriptExcerpt = (analysis?.transcript ?? "").slice(0, 200) || "（无转录）";
    const videoPacing = analysis?.videoPacing ?? "未知";
    userText = userText
      .replace("{transcript_excerpt}", transcriptExcerpt)
      .replace("{video_pacing}", videoPacing);
  }

  let narrateResult: {
    title: string;
    narrative: string;
    score: number;
  };

  try {
    const adapter = createStorageAdapter(hero.sourceType);
    let buffer: Buffer;
    const mimeType = "image/jpeg";

    if (isVideo) {
      if (!hero.thumbnailPath) {
        throw new Error("视频无 cover 缩略图");
      }
      const fs = await import("node:fs/promises");
      const coverBuffer = await fs.readFile(hero.thumbnailPath);
      buffer = await sharp(coverBuffer)
        .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } else {
      buffer = await adapter.getFileBuffer(hero.filePath);
      const { isHeicBuffer, convertHeicToJpeg } = await import("../lib/heic");
      if (isHeicBuffer(buffer)) {
        buffer = await convertHeicToJpeg(buffer, {
          maxWidth: 2048,
          maxHeight: 2048,
          quality: 85,
        });
      } else {
        buffer = await sharp(buffer)
          .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
      }
    }

    const base64 = buffer.toString("base64");
    job.log(`Hero 照片大小: ${buffer.length} bytes`);

    const narrateRawResponse = await aiClient.analyzePhoto(
      base64,
      mimeType,
      narratePrompts.system,
      userText,
    );

    job.log(`叙事响应长度: ${narrateRawResponse.length} chars`);

    const {
      parsed: narrateParsed,
      error: narrateError,
      fallback: narrateFallback,
    } = parseDailyNarrateResponse(narrateRawResponse);

    if (narrateError) {
      job.log(`叙事解析警告: ${narrateError}`);
    }

    narrateResult = narrateParsed ?? narrateFallback;
  } catch (err) {
    job.log(`阶段 2 AI 失败: ${err instanceof Error ? err.message : String(err)}，使用模板文案`);
    narrateResult = {
      title: "今日拾光",
      narrative: "这张照片记录了一个值得怀念的瞬间。虽然未能自动生成文案，但回忆本身已足够珍贵。",
      score: 5.0,
    };
  }

  job.log(`叙事结果: title="${narrateResult.title}", score=${narrateResult.score}`);

  // ---- 写库 ----
  const insertedRows = await db
    .insert(schema.dailyPicks)
    .values({
      id: crypto.randomUUID(),
      photoId: hero.photoId,
      pickDate,
      title: narrateResult.title,
      narrative: narrateResult.narrative,
      score: narrateResult.score,
      members,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .returning();

  // 同日重跑时 onConflictDoNothing 不会插入，需要查出已有 pick 用于阶段 3 update
  let pickRow = insertedRows[0];
  if (!pickRow) {
    const existing = await db
      .select()
      .from(schema.dailyPicks)
      .where(eq(schema.dailyPicks.pickDate, pickDate))
      .limit(1);
    pickRow = existing[0];
  }

  job.log(`每日精选写入成功，members: ${members.length} 张`);

  // ---- 阶段 3: Satori 合成默认尺寸壁纸（5120×2880），失败不阻塞 ----
  // 视频精选不合成壁纸图（设计文档：mac App 视频路径走 dynamic .heic）
  if (pickRow && !isVideo) {
    try {
      job.log("阶段 3: 合成默认壁纸图 5120×2880");
      const photoRows = await db
        .select()
        .from(schema.photos)
        .where(eq(schema.photos.id, hero.photoId))
        .limit(1);
      const heroPhoto = photoRows[0];
      if (!heroPhoto) {
        throw new Error(`hero photoId=${hero.photoId} 在 photos 表未找到`);
      }

      const { composeAndSave } = await import("../lib/wallpaper/composer");
      const composedPath = await composeAndSave({
        pick: pickRow,
        photo: heroPhoto,
        width: 5120,
        height: 2880,
        cacheKey: "default",
      });

      await db
        .update(schema.dailyPicks)
        .set({ composedImagePath: composedPath })
        .where(eq(schema.dailyPicks.id, pickRow.id));

      job.log(`阶段 3 完成: ${composedPath}`);
    } catch (err) {
      job.log(`阶段 3 失败（不影响精选）: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (isVideo) {
    job.log("阶段 3 跳过：胜出照片为视频，本次不合成壁纸图");
  }

  job.log("每日精选完成");
}

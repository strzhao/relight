import path from "node:path";
import type { Job } from "bullmq";
import { desc, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { aiClient } from "../ai/client";
import { loadPrompts } from "../ai/prompts";
import { parseDailyNarrateResponse, parseDailySelectResponse } from "../ai/response-parser";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { createStorageAdapter } from "../storage";

/** 候选照片上限 */
const MAX_CANDIDATES = 20;

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
 * 两阶段 AI 流水线：
 * 1. 查询今日月日匹配的已分析照片 → 构建候选摘要 → aiClient.chat() 文本模型评选胜者
 * 2. 对胜者照片调用 aiClient.analyzePhoto() 视觉模型 → 生成怀旧标题和文案
 * 3. onConflictDoNothing 写入 daily_picks（pickDate UNIQUE 去重）
 */
export async function dailySelectionWorker(job: Job): Promise<void> {
  job.log("开始每日精选");

  // 生成今日 pickDate（北京时间 YYYY-MM-DD 纯日期字符串）
  const pickDate = formatPickDate();
  job.log(`pickDate: ${pickDate}`);

  // 提取月-日用于候选查询
  const now = new Date();
  const shanghaiNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const monthDay = `${String(shanghaiNow.getMonth() + 1).padStart(2, "0")}-${String(shanghaiNow.getDate()).padStart(2, "0")}`;
  job.log(`月日匹配: ${monthDay}`);

  // 1. 查询候选照片（本月日匹配 + 已有分析记录）
  const candidates = await db
    .select({
      photo: schema.photos,
      analysis: schema.photoAnalyses,
      sourceType: schema.storageSources.type,
      sourceRootPath: schema.storageSources.rootPath,
    })
    .from(schema.photos)
    .innerJoin(schema.photoAnalyses, eq(schema.photos.id, schema.photoAnalyses.photoId))
    .innerJoin(schema.storageSources, eq(schema.photos.storageSourceId, schema.storageSources.id))
    .where(
      sql`strftime('%m-%d', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) = ${monthDay}`,
    )
    .orderBy(desc(schema.photoAnalyses.aestheticScore))
    .limit(MAX_CANDIDATES);

  job.log(`查询到 ${candidates.length} 张候选照片`);

  if (candidates.length === 0) {
    job.log("今日无候选照片，跳过每日精选");
    return;
  }

  // 2. 阶段 1: 文本评选（带 fallback）
  job.log("阶段 1: 文本模型评选...");

  const selectPrompts = await loadPrompts("v2", "daily/select");

  // 构建候选摘要文本
  const candidateSummaries = candidates
    .map((c, i) => {
      const a = c.analysis;
      const emotionalSummary = a.emotionalAnalysis
        ? `${(a.emotionalAnalysis as Record<string, unknown>).primary || "未知"} / ${(a.emotionalAnalysis as Record<string, unknown>).secondary || "未知"}`
        : "未知";
      const mt =
        (c.photo.mediaType ?? "image") === "video"
          ? `[视频 ${Math.round(c.photo.durationSec ?? 0)} 秒]`
          : "[图片]";
      return [
        `[${i}] ${mt} 美学评分: ${a.aestheticScore ?? "N/A"}`,
        `    情感: ${emotionalSummary}`,
        `    标签: ${Array.isArray(a.tags) ? (a.tags as { name: string }[]).map((t) => t.name).join("、") : "无"}`,
        `    描述: ${a.narrative ?? "无描述"}`,
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
    // 阶段 1 AI 失败 → fallback: 选 aestheticScore 最高的（列表已按分降序排列）
    job.log(
      `阶段 1 AI 失败: ${err instanceof Error ? err.message : String(err)}，fallback 到最高分照片`,
    );
    // candidates 已按 aestheticScore DESC 排序，index 0 即最高分
    selectedIndex = 0;
  }

  // selectedIndex 已通过 Math.min/max 夹紧到 [0, candidates.length)
  const winner = candidates[selectedIndex];
  if (!winner) {
    // 理论不可达：夹紧逻辑已保证索引有效
    job.log("内部错误: 胜者索引无效");
    return;
  }

  job.log(`选中照片: index=${selectedIndex}, photoId=${winner.photo.id}`);

  // 3. 阶段 2: 视觉模型怀旧叙事（带 fallback）
  job.log("阶段 2: 视觉模型生成怀旧叙事...");

  const isVideo = (winner.photo.mediaType ?? "image") === "video";
  const promptPath = isVideo ? "daily/narrate-video" : "daily/narrate";
  const narratePrompts = await loadPrompts("v2", promptPath);

  // 视频路径：替换 user prompt 中的占位符（transcript_excerpt / video_pacing）
  let userText = narratePrompts.user;
  if (isVideo) {
    const transcriptExcerpt = (winner.analysis.transcript ?? "").slice(0, 200) || "（无转录）";
    const videoPacing = winner.analysis.videoPacing ?? "未知";
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
    // 读取胜者媒体文件
    const adapter = createStorageAdapter(winner.sourceType);
    const fullPath = path.join(winner.sourceRootPath, winner.photo.filePath);
    let buffer: Buffer;
    const mimeType = "image/jpeg";

    if (isVideo) {
      // 视频：读取 cover 缩略图（避免读取整个视频文件 OOM + sharp 不支持视频解码）
      if (!winner.photo.thumbnailPath) {
        throw new Error("视频无 cover 缩略图");
      }
      const fs = await import("node:fs/promises");
      const coverBuffer = await fs.readFile(winner.photo.thumbnailPath);
      buffer = await sharp(coverBuffer)
        .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } else {
      buffer = await adapter.getFileBuffer(fullPath);
      // 按 magic byte 判断 HEIC（兼容扩展名错配，如 iOS 备份的 .JPEG 实为 HEIC）
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
    job.log(`胜者照片大小: ${buffer.length} bytes`);

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
    // 阶段 2 AI 失败 → fallback: 使用模板文案
    job.log(`阶段 2 AI 失败: ${err instanceof Error ? err.message : String(err)}，使用模板文案`);
    narrateResult = {
      title: "今日拾光",
      narrative: "这张照片记录了一个值得怀念的瞬间。虽然未能自动生成文案，但回忆本身已足够珍贵。",
      score: 5.0,
    };
  }

  job.log(`叙事结果: title="${narrateResult.title}", score=${narrateResult.score}`);

  // 4. 写入 daily_picks（onConflictDoNothing 去重）
  await db
    .insert(schema.dailyPicks)
    .values({
      id: crypto.randomUUID(),
      photoId: winner.photo.id,
      pickDate,
      title: narrateResult.title,
      narrative: narrateResult.narrative,
      score: narrateResult.score,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing();

  job.log("每日精选写入成功");

  job.log("每日精选完成");
}

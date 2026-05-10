import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import pLimit from "p-limit";
import sharp from "sharp";
import { aiClient } from "../ai/client";
import { loadPrompts } from "../ai/prompts";
import { parseDailyMembersResponse, parseDailyNarrateResponse } from "../ai/response-parser";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { createStorageAdapter } from "../storage";
import { buildCandidatePool, getRecentPickedPhotoIds } from "./daily-selection/candidate-pool";
import type { ClusteredCandidate } from "./daily-selection/cluster";
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

/** 单张候选的处理结果 */
interface EntryResult {
  rank: number;
  photoId: string;
  title: string;
  narrative: string;
  score: number;
  members: { photoId: string; caption: string }[];
}

/**
 * 为单张候选生成 narrate（title + narrative + score）+ members
 *
 * @param candidate - 候选照片（含 AI 分析元数据）
 * @param rank - 候选序号（0-19）
 * @param otherHeroIds - 已选作其它 entry hero 的 photoId 集合（跨 entry members 互斥）
 * @param recentIds - 30 天去重 Set（用于构建关联池排除集）
 * @param log - 日志函数
 */
async function processSingleEntry(
  candidate: ClusteredCandidate,
  rank: number,
  otherHeroIds: Set<string>,
  recentIds: Set<string>,
  log: (msg: string) => void,
): Promise<EntryResult> {
  const isVideo = (candidate.mediaType ?? "image") === "video";

  // ---- narrate（vision 模型）----
  let narrateResult: { title: string; narrative: string; score: number };

  try {
    const promptPath = isVideo ? "daily/narrate-video" : "daily/narrate";
    const narratePrompts = await loadPrompts("v2", promptPath);

    const heroDate = (candidate.takenAt ?? "").split("T")[0]?.split(" ")[0] || "未知日期";
    const heroTagsForNarrate = Array.isArray(candidate.tags)
      ? (candidate.tags as { name: string }[]).map((t) => t.name).join("、")
      : "无";
    const heroEmotions =
      candidate.emotionalAnalysis && typeof candidate.emotionalAnalysis === "object"
        ? `${(candidate.emotionalAnalysis as Record<string, unknown>).primary || "未知"} / ${(candidate.emotionalAnalysis as Record<string, unknown>).secondary || "未知"}`
        : "未知";

    let userText = narratePrompts.user
      .replace("{date}", heroDate)
      .replace("{years_ago}", String(candidate.yearsAgo ?? 0))
      .replace("{tags}", heroTagsForNarrate)
      .replace("{emotions}", heroEmotions)
      .replace("{narrative}", candidate.narrative ?? "无描述");

    if (isVideo) {
      const analysisRows = await db
        .select({
          transcript: schema.photoAnalyses.transcript,
          videoPacing: schema.photoAnalyses.videoPacing,
        })
        .from(schema.photoAnalyses)
        .where(eq(schema.photoAnalyses.photoId, candidate.photoId))
        .limit(1);
      const analysis = analysisRows[0];
      const transcriptExcerpt = (analysis?.transcript ?? "").slice(0, 200) || "（无转录）";
      const videoPacing = analysis?.videoPacing ?? "未知";
      userText = userText
        .replace("{transcript_excerpt}", transcriptExcerpt)
        .replace("{video_pacing}", videoPacing);
    }

    const adapter = createStorageAdapter(candidate.sourceType);
    let buffer: Buffer;
    const mimeType = "image/jpeg";

    if (isVideo) {
      if (!candidate.thumbnailPath) {
        throw new Error("视频无 cover 缩略图");
      }
      const fs = await import("node:fs/promises");
      const coverBuffer = await fs.readFile(candidate.thumbnailPath);
      buffer = await sharp(coverBuffer)
        .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } else {
      buffer = await adapter.getFileBuffer(candidate.filePath);
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
    const narrateRawResponse = await aiClient.analyzePhoto(
      base64,
      mimeType,
      narratePrompts.system,
      userText,
    );

    const {
      parsed: narrateParsed,
      error: narrateError,
      fallback: narrateFallback,
    } = parseDailyNarrateResponse(narrateRawResponse);

    if (narrateError) {
      log(`[rank=${rank}] narrate 解析警告: ${narrateError}`);
    }

    narrateResult = narrateParsed ?? narrateFallback;
    log(
      `[rank=${rank}] narrate 完成: title="${narrateResult.title}", score=${narrateResult.score}`,
    );
  } catch (err) {
    log(
      `[rank=${rank}] narrate 失败: ${err instanceof Error ? err.message : String(err)}，使用 fallback 文案`,
    );
    narrateResult = {
      title: "今日拾光",
      narrative: "这张照片记录了一个值得怀念的瞬间。",
      score: 5.0,
    };
  }

  // ---- members 选择（仅图片类候选）----
  let members: { photoId: string; caption: string }[] = [];

  if (!isVideo) {
    try {
      // 排除集 = 30 天去重 + candidate 自身 + 其它 entry 的 hero photoId（避免跨 entry 重复）
      const excludeForRelated = new Set([...recentIds, candidate.photoId, ...otherHeroIds]);
      // 同簇兄弟优先做 members，使聚类后的"主题代表"在叙事上不丢失现场感
      const related = await buildRelatedPool(candidate, excludeForRelated, {
        maxRelated: 20,
        priorityIds: new Set(candidate.clusterSiblingIds),
      });

      if (related.length > 0) {
        const membersPrompts = await loadPrompts("v2", "daily/members");

        const heroEmotion =
          candidate.emotionalAnalysis && typeof candidate.emotionalAnalysis === "object"
            ? `${(candidate.emotionalAnalysis as Record<string, unknown>).primary || "未知"}`
            : "未知";
        const heroTagsStr = Array.isArray(candidate.tags)
          ? (candidate.tags as { name: string }[]).map((t) => t.name).join("、")
          : "无";

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
          .replace("{hero_taken_at}", candidate.takenAt ?? "未知")
          .replace("{hero_emotion}", heroEmotion)
          .replace("{hero_tags}", heroTagsStr)
          .replace("{hero_narrative}", (candidate.narrative ?? "无描述").slice(0, 80))
          .replace("{候选摘要列表}", relatedSummaries);

        const membersRawResponse = await aiClient.chat(membersUserPrompt, membersPrompts.system);
        const { parsed: membersParsed, error: membersError } = parseDailyMembersResponse(
          membersRawResponse,
          related.length,
        );

        if (membersError) {
          log(`[rank=${rank}] members 解析警告: ${membersError}`);
        }

        if (membersParsed && membersParsed.members.length > 0) {
          members = membersParsed.members.flatMap((m) => {
            const r = related[m.index];
            return r ? [{ photoId: r.photoId, caption: m.caption }] : [];
          });
        }

        log(`[rank=${rank}] members: ${members.length} 张`);
      }
    } catch (err) {
      log(
        `[rank=${rank}] members 失败: ${err instanceof Error ? err.message : String(err)}，fallback 到 []`,
      );
      members = [];
    }
  }

  return {
    rank,
    photoId: candidate.photoId,
    title: narrateResult.title,
    narrative: narrateResult.narrative,
    score: narrateResult.score,
    members,
  };
}

/**
 * daily-selection Worker
 *
 * 新版多入选流水线（20 张）：
 * 0. 构造 4 源候选池（最多 20 张）
 * 1. pLimit(CONCURRENCY) 并行处理每张候选：narrate + members
 * 2. 事务写库：upsert dailyPicks（同步 entries[0] 主字段）+ DELETE/bulk INSERT entries
 * 3. 仅为 entries[0] 合成 5K 壁纸
 */
export async function dailySelectionWorker(job: Job): Promise<void> {
  job.log("开始每日精选（新版 20 张多入选流水线）");

  const pickDate = formatPickDate();
  job.log(`pickDate: ${pickDate}`);

  const concurrency = Number.parseInt(
    process.env.DAILY_SELECTION_CONCURRENCY ?? String(config.dailySelectionConcurrency ?? 2),
    10,
  );
  job.log(`并发度: ${concurrency}`);

  // ---- 阶段 0: 构造候选池 ----
  const recentIds = await getRecentPickedPhotoIds(30);
  job.log(`最近 30 天去重池: ${recentIds.size} 个 photoId`);

  const candidates = await buildCandidatePool({
    now: new Date(),
    excludeIds: recentIds,
    maxN: 12,
  });

  job.log(`4 源候选池共 ${candidates.length} 张候选`);

  if (candidates.length === 0) {
    job.log("今日无候选照片，跳过每日精选");
    return;
  }

  // ---- 阶段 1: 并行处理每张候选（narrate + members）----
  job.log(`阶段 1: 并行处理 ${candidates.length} 张候选（concurrency=${concurrency}）`);

  const limit = pLimit(concurrency);

  // 所有 hero photoId 集合，用于跨 entry members 互斥
  const allHeroIds = new Set(candidates.map((c) => c.photoId));

  const entryResults: EntryResult[] = await Promise.all(
    candidates.map((candidate, idx) =>
      limit(async () => {
        // 其它 entry 的 hero photoId（排除自身）
        const otherHeroIds = new Set([...allHeroIds].filter((id) => id !== candidate.photoId));
        job.log(`[rank=${idx}] 开始处理 photoId=${candidate.photoId}`);
        try {
          return await processSingleEntry(candidate, idx, otherHeroIds, recentIds, (msg) =>
            job.log(msg),
          );
        } catch (err) {
          // 单张失败 → fallback，不阻塞其它
          job.log(
            `[rank=${idx}] 处理失败: ${err instanceof Error ? err.message : String(err)}，使用 fallback`,
          );
          return {
            rank: idx,
            photoId: candidate.photoId,
            title: "今日拾光",
            narrative: "这张照片记录了一个值得怀念的瞬间。",
            score: 5.0,
            members: [],
          } satisfies EntryResult;
        }
      }),
    ),
  );

  // 按 rank 升序排序（并行可能乱序）
  entryResults.sort((a, b) => a.rank - b.rank);

  job.log(`阶段 1 完成，共 ${entryResults.length} 条 entry`);

  // rank=0 是 primary entry，同步到 dailyPicks 主字段
  const primary = entryResults[0];
  if (!primary) {
    job.log("内部错误：entryResults 为空");
    return;
  }

  // ---- 阶段 2: 写库（事务：DELETE + bulk INSERT + upsert dailyPicks）----
  job.log("阶段 2: 写库...");

  // 注意：better-sqlite3 的事务不支持 async，所以把 DB 操作分为：
  // 1) upsert dailyPicks（获取 pickId）
  // 2) 在同步事务里 DELETE + bulk INSERT entries

  // upsert dailyPicks（同步 entries[0]）
  const upsertedRows = await db
    .insert(schema.dailyPicks)
    .values({
      id: crypto.randomUUID(),
      photoId: primary.photoId,
      pickDate,
      title: primary.title,
      narrative: primary.narrative,
      score: primary.score,
      members: primary.members,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.dailyPicks.pickDate,
      set: {
        photoId: primary.photoId,
        title: primary.title,
        narrative: primary.narrative,
        score: primary.score,
        members: primary.members,
        composedImagePath: null,
      },
    })
    .returning();

  const pickRow = upsertedRows[0];
  if (!pickRow) {
    job.log("内部错误：upsert dailyPicks 返回空");
    return;
  }

  job.log(`dailyPicks upsert 成功，pickId=${pickRow.id}`);

  // DELETE 当日旧 entries + bulk INSERT 新 entries（better-sqlite3 同步事务，原子性保证）
  // patterns.md：drizzle async transaction 在 better-sqlite3 上抛 `Transaction function cannot return a promise`
  // 因此 callback 必须同步——所有数据已在 entryResults 中准备好，事务体内只做 DB 写入
  const db2 = (await import("../db")).db;
  const now = new Date().toISOString();
  const BATCH_SIZE = 10; // 分批避免 SQLite 参数限制 999

  db2.transaction((tx) => {
    tx.delete(schema.dailyPickEntries)
      .where(sql`${schema.dailyPickEntries.dailyPickId} = ${pickRow.id}`)
      .run();

    for (let i = 0; i < entryResults.length; i += BATCH_SIZE) {
      const batch = entryResults.slice(i, i + BATCH_SIZE);
      tx.insert(schema.dailyPickEntries)
        .values(
          batch.map((entry) => ({
            id: crypto.randomUUID(),
            dailyPickId: pickRow.id,
            rank: entry.rank,
            photoId: entry.photoId,
            title: entry.title,
            narrative: entry.narrative,
            score: entry.score,
            members: entry.members,
            createdAt: now,
          })),
        )
        .run();
    }
  });

  job.log(`entries 写入成功，共 ${entryResults.length} 条`);

  // ---- 阶段 3: 仅为 entries[0] 合成 5K 壁纸（不变）----
  const primaryCandidate = candidates[0];
  const isVideo = primaryCandidate ? (primaryCandidate.mediaType ?? "image") === "video" : false;

  if (pickRow && !isVideo && primaryCandidate) {
    try {
      job.log("阶段 3: 合成默认壁纸图 5120×2880");
      const photoRows = await db
        .select()
        .from(schema.photos)
        .where(eq(schema.photos.id, primary.photoId))
        .limit(1);
      const heroPhoto = photoRows[0];
      if (!heroPhoto) {
        throw new Error(`hero photoId=${primary.photoId} 在 photos 表未找到`);
      }

      const { composeAndSave } = await import("../lib/wallpaper/composer");
      const composedPath = await composeAndSave({
        pick: {
          ...pickRow,
          composedImageUrl: null,
          members: primary.members,
        },
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
    job.log("阶段 3 跳过：primary 照片为视频，本次不合成壁纸图");
  }

  job.log("每日精选完成");
}

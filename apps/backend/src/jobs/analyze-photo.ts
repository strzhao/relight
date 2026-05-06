import { execFile } from "node:child_process";
import path from "node:path";
import type { TagCategory } from "@relight/shared";
import type { Job } from "bullmq";
import { eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { aiClient } from "../ai/client";
import { evaluateResponse } from "../ai/evaluation/evaluator";
import { loadPrompts } from "../ai/prompts";
import { parseAnalysisResponse } from "../ai/response-parser";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { detectVideoCapability } from "../lib/video/ffmpeg";
import { analyzeVideoForAI } from "../lib/video/index";
import { createStorageAdapter } from "../storage";

/** AI 视觉模型支持的图片格式（含需转换后支持的格式） */
const AI_SUPPORTED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".bmp",
  ".tiff",
  ".dng",
]);

/** 视频格式（走视频分支） */
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"]);

/** 需要 dcraw 提取 JPEG 预览的 RAW 格式 */
const RAW_EXTENSIONS = new Set([".dng"]);

const DCRAW_PATH = "/opt/homebrew/bin/dcraw";

interface AnalyzeJobData {
  photoId: string;
}

/**
 * analyze-photo Worker
 *
 * 流程：
 * 1. 读取照片记录
 * 2. 读取文件并 base64 编码
 * 3. 加载 AI Prompt
 * 4. 调用 AI 视觉模型分析
 * 5. 解析 AI 响应
 * 6. 写入 tags / photoTags / photoAnalyses
 */
export async function analyzePhotoWorker(job: Job<AnalyzeJobData>): Promise<void> {
  const { photoId } = job.data;
  job.log(`开始 AI 分析照片: ${photoId}`);

  // 1. 读取照片记录
  const rows = await db.select().from(schema.photos).where(eq(schema.photos.id, photoId));

  const photo = rows[0];
  if (!photo) {
    throw new Error(`照片不存在: ${photoId}`);
  }

  // 查找存储源
  const sourceRows = await db
    .select()
    .from(schema.storageSources)
    .where(eq(schema.storageSources.id, photo.storageSourceId));

  const source = sourceRows[0];
  if (!source) {
    throw new Error(`存储源不存在: ${photo.storageSourceId}`);
  }

  // === 格式分流 ===
  const ext = path.extname(photo.filePath).toLowerCase();

  // 视频分支：走 ffmpeg 抽帧 + Whisper 转录 + vision 视频专属 prompt
  if (VIDEO_EXTENSIONS.has(ext)) {
    await analyzeVideoBranch(photo, job, ext);
    return;
  }

  // === 格式门：跳过不支持的图片格式，写入占位记录避免重复入队 ===
  if (!AI_SUPPORTED_EXTENSIONS.has(ext)) {
    job.log(`跳过不支持的格式: ${ext}，写入占位记录避免重复入队`);

    const existingAnalysis = await db
      .select({ id: schema.photoAnalyses.id })
      .from(schema.photoAnalyses)
      .where(eq(schema.photoAnalyses.photoId, photoId));

    if (existingAnalysis.length === 0) {
      await db.insert(schema.photoAnalyses).values({
        id: crypto.randomUUID(),
        photoId,
        aiModel: "skipped",
        narrative: `不支持的格式 (${ext})：当前 AI 视觉模型仅支持图片格式。该文件已入库，等待后续视频格式支持。`,
        rawResponse: JSON.stringify({ skipped: true, reason: "unsupported_format", ext }),
        processedAt: new Date().toISOString(),
      });
    }
    return;
  }

  // 2. 读取文件并准备发送 AI
  // DNG/RAW: dcraw 提取 JPEG 预览 → resize → base64
  // HEIC: heic-decode 转 JPEG → base64
  // 其他: 直接读取 → base64
  const adapter = createStorageAdapter(source.type);
  let buffer: Buffer;
  let mimeType: string;

  if (RAW_EXTENSIONS.has(ext)) {
    job.log("DNG/RAW 文件，使用 dcraw 提取 JPEG 预览");
    buffer = await extractRawPreview(photo.filePath);
    const sharp = await import("sharp");
    buffer = await sharp
      .default(buffer)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    mimeType = "image/jpeg";
  } else {
    buffer = await adapter.getFileBuffer(photo.filePath);
    const { isHeicBuffer, convertHeicToJpeg } = await import("../lib/heic");
    if (isHeicBuffer(buffer)) {
      job.log("检测到 HEIC 内容（按 magic byte），转换为 JPEG 后发送 AI 分析");
      buffer = await convertHeicToJpeg(buffer, {
        maxWidth: 1024,
        maxHeight: 1024,
        quality: 75,
      });
    } else {
      job.log("缩放图片到 1024px 以减少 AI payload");
      buffer = await sharp(buffer)
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
    }
    mimeType = "image/jpeg";
  }

  const base64 = buffer.toString("base64");

  job.log(`文件大小: ${buffer.length} bytes, MIME: ${mimeType}`);

  // 上报初始进度 — 文件读取/转码完成，即将调用 AI
  await job.updateProgress({
    phase: "processing",
    totalFiles: 1,
    processed: 0,
    newCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    regeneratedCount: 0,
    currentFile: photo.filePath,
  });

  // 3. 加载 AI Prompt（使用配置的版本）
  const prompts = await loadPrompts(config.ai.promptVersion);

  job.log("调用 AI 视觉模型分析...");

  // 4. 调用 AI（分离 system/user 提示词传递）
  const rawResponse = await aiClient.analyzePhoto(base64, mimeType, prompts.system, prompts.user);

  job.log(`AI 响应长度: ${rawResponse.length} chars`);

  // 5. 解析响应
  const { parsed, error, fallback } = parseAnalysisResponse(rawResponse);

  if (error) {
    job.log(`解析警告: ${error}`);
  }

  const result = parsed ?? fallback;

  // 5a. 评估分析质量
  const evalResult = evaluateResponse(result, rawResponse, error);
  console.log(
    "[analyze-photo] 评估:",
    JSON.stringify({
      photoId,
      totalScore: evalResult.totalScore,
      dimensions: evalResult.dimensions.map((d) => ({ name: d.name, score: d.score })),
    }),
  );

  // 6. 写入数据库：tags + photoTags + photoAnalyses
  const now = new Date().toISOString();

  // 6a. 标签去重后写入 tags 表，建立 photo_tags 关联
  const tagMap = new Map<string, { name: string; category: TagCategory; confidence: number }>();

  for (const t of result.tags) {
    const key = `${t.category}:${t.name}`;
    const existing = tagMap.get(key);
    if (!existing || existing.confidence < t.confidence) {
      tagMap.set(key, t);
    }
  }

  const uniqueTags = [...tagMap.values()];
  const tagNames = uniqueTags.map((t) => t.name);

  // 批量查询已有标签
  const existingTags = await db
    .select()
    .from(schema.tags)
    .where(inArray(schema.tags.name, tagNames));

  const existingTagMap = new Map(existingTags.map((t) => [t.name, t]));

  // 为新标签预生成 ID，批量插入（onConflictDoUpdate 应对竞争条件）
  const newTags = uniqueTags
    .filter((t) => !existingTagMap.has(t.name))
    .map((t) => ({
      id: crypto.randomUUID(),
      name: t.name,
      category: t.category,
      createdAt: now,
    }));

  if (newTags.length > 0) {
    await db
      .insert(schema.tags)
      .values(newTags)
      .onConflictDoUpdate({
        target: schema.tags.name,
        set: { category: sql`excluded.category` },
      });
  }

  // 更新已有标签的 category（如有变化）
  for (const t of uniqueTags) {
    const existing = existingTagMap.get(t.name);
    if (existing && existing.category !== t.category) {
      await db
        .update(schema.tags)
        .set({ category: t.category })
        .where(eq(schema.tags.id, existing.id));
    }
  }

  // 构建 name → id 映射
  const tagNameToId = new Map<string, string>();
  for (const t of existingTags) tagNameToId.set(t.name, t.id);
  for (const t of newTags) tagNameToId.set(t.name, t.id);

  // 批量插入 photoTags（onConflictDoNothing 替代 try-catch）
  const photoTagValues = uniqueTags
    .map((t) => {
      const tagId = tagNameToId.get(t.name);
      return tagId ? { photoId, tagId, confidence: t.confidence } : null;
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  await db.insert(schema.photoTags).values(photoTagValues).onConflictDoNothing();

  // 6b. 检查是否已有分析记录（幂等性）
  const existingAnalysis = await db
    .select({ id: schema.photoAnalyses.id })
    .from(schema.photoAnalyses)
    .where(eq(schema.photoAnalyses.photoId, photoId));

  if (existingAnalysis.length > 0) {
    // 更新现有记录
    await db
      .update(schema.photoAnalyses)
      .set({
        aiModel: config.ai.visionModel,
        narrative: result.narrative,
        aestheticScore: result.aestheticScore,
        tags: result.tags,
        composition: result.composition,
        colorAnalysis: result.colorAnalysis,
        emotionalAnalysis: result.emotionalAnalysis,
        usageSuggestions: result.usageSuggestions,
        promptVersion: config.ai.promptVersion,
        rawResponse,
        processedAt: now,
      })
      .where(eq(schema.photoAnalyses.photoId, photoId));
  } else {
    // 插入新记录
    await db.insert(schema.photoAnalyses).values({
      id: crypto.randomUUID(),
      photoId,
      aiModel: config.ai.visionModel,
      narrative: result.narrative,
      aestheticScore: result.aestheticScore,
      tags: result.tags,
      composition: result.composition,
      colorAnalysis: result.colorAnalysis,
      emotionalAnalysis: result.emotionalAnalysis,
      usageSuggestions: result.usageSuggestions,
      promptVersion: config.ai.promptVersion,
      rawResponse,
      processedAt: now,
    });
  }

  const tagCount = tagMap.size;
  job.log(`AI 分析完成: ${tagCount} 个标签, 美学评分: ${result.aestheticScore}`);

  // 上报完成进度 — 所有 DB 写入已成功
  await job.updateProgress({
    phase: "completed",
    totalFiles: 1,
    processed: 1,
    newCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    regeneratedCount: 0,
  });
}

/**
 * 视频分析分支：复用同一队列，但走专门的处理流水线。
 *
 * 流程：
 * 1. 检测 ffmpeg 能力（缺失 → 写 skipped 占位）
 * 2. analyzeVideoForAI：抽帧 → 雪碧图 → 抽音 → Whisper 转录
 * 3. 加载 v2/video prompts，注入 transcript / duration / frame_count
 * 4. 调用 vision 模型分析雪碧图
 * 5. 解析响应（通用字段 + 视频专属字段 videoPacing/motionScore/videoNarrative）
 * 6. 写 photoAnalyses（含视频字段），upsert
 *
 * 失败降级：任何步骤失败都写 aiModel="video-failed:{reason}" 占位（不抛异常）
 */
async function analyzeVideoBranch(
  photo: typeof schema.photos.$inferSelect,
  job: Job<AnalyzeJobData>,
  ext: string,
): Promise<void> {
  const photoId = photo.id;
  const now = new Date().toISOString();

  // 1. ffmpeg 能力检测
  // 用 available 综合字段（合并 ffmpegOk && ffprobeOk && config.video.enabled）
  // 这样 VIDEO_ENABLED=false 时也能正确跳过
  const cap = await detectVideoCapability();
  if (!cap.available) {
    const reason = !cap.ffmpegOk || !cap.ffprobeOk ? "ffmpeg_missing" : "video_disabled";
    job.log(
      `视频分析跳过：${reason} (ffmpegOk=${cap.ffmpegOk}, ffprobeOk=${cap.ffprobeOk}, available=${cap.available})`,
    );
    await upsertVideoPlaceholder(photoId, "skipped", reason, now);
    return;
  }

  // 2. 抽帧 + 雪碧图 + 转录（任一失败都降级）
  let videoResult: Awaited<ReturnType<typeof analyzeVideoForAI>>;
  try {
    job.log("视频分析：抽帧 + 雪碧图 + 转录");
    videoResult = await analyzeVideoForAI(photo.filePath, (msg) => job.log(`[video] ${msg}`));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    job.log(`视频处理失败: ${reason}`);
    const failureKind = reason.toLowerCase().includes("probe") ? "probe" : "extract";
    await upsertVideoPlaceholder(photoId, `video-failed:${failureKind}`, reason, now);
    return;
  }

  const { spriteBuffer, transcript, segments, durationSec, hasAudio } = videoResult;

  // 3. 加载视频 prompts + 占位替换
  const prompts = await loadPrompts(config.ai.promptVersion, "video");
  const userPrompt = prompts.user
    .replace(/\{frame_count\}/g, String(config.video.frameCount))
    .replace(/\{duration\}/g, durationSec.toFixed(1))
    .replace(/\{transcript\}/g, transcript ?? (hasAudio ? "(转录失败)" : "(无音轨)"));

  // 上报进度
  await job.updateProgress({
    phase: "processing",
    totalFiles: 1,
    processed: 0,
    newCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    regeneratedCount: 0,
    currentFile: photo.filePath,
  });

  // 4. 调用 vision 模型
  const base64 = spriteBuffer.toString("base64");
  job.log(`雪碧图大小: ${spriteBuffer.length} bytes，调用 vision 模型...`);

  let rawResponse: string;
  try {
    rawResponse = await aiClient.analyzePhoto(base64, "image/jpeg", prompts.system, userPrompt);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    job.log(`vision 调用失败: ${reason}`);
    await upsertVideoPlaceholder(photoId, "video-failed:vision", reason, now);
    return;
  }

  job.log(`AI 响应长度: ${rawResponse.length} chars`);

  // 5. 解析响应
  const { parsed, error: parseError, fallback } = parseAnalysisResponse(rawResponse);
  if (parseError) job.log(`解析警告: ${parseError}`);
  const result = parsed ?? fallback;

  // 5a. 视频专属字段从 rawResponse 单独提取（不在通用 schema 中）
  const videoExtras = extractVideoFields(rawResponse);

  // 6. 写入数据库（标签 + photoAnalyses）
  await writeTagsAndAnalysis({
    photoId,
    result,
    rawResponse,
    transcript,
    segments,
    videoExtras,
    now,
    job,
  });

  await job.updateProgress({
    phase: "completed",
    totalFiles: 1,
    processed: 1,
    newCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    regeneratedCount: 0,
  });
}

/** 视频专属字段的容错提取（绕过通用 schema 的 strip 行为） */
function extractVideoFields(rawResponse: string): {
  videoPacing: string | null;
  motionScore: number | null;
  videoNarrative: string | null;
} {
  const empty = { videoPacing: null, motionScore: null, videoNarrative: null };
  const blockMatch = rawResponse.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = blockMatch?.[1] ?? rawResponse.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonStr) return empty;

  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;
    const videoPacing = typeof obj.videoPacing === "string" ? obj.videoPacing : null;
    const motionScore =
      typeof obj.motionScore === "number" && obj.motionScore >= 0 && obj.motionScore <= 100
        ? obj.motionScore
        : null;
    const videoNarrative = typeof obj.videoNarrative === "string" ? obj.videoNarrative : null;
    return { videoPacing, motionScore, videoNarrative };
  } catch {
    return empty;
  }
}

/** 写入 tags + photoAnalyses，含视频专属字段。复用 image 路径的 tag 逻辑。 */
async function writeTagsAndAnalysis(opts: {
  photoId: string;
  result: ReturnType<typeof parseAnalysisResponse>["fallback"];
  rawResponse: string;
  transcript: string | null;
  segments: { start: number; end: number; text: string }[];
  videoExtras: ReturnType<typeof extractVideoFields>;
  now: string;
  job: Job<AnalyzeJobData>;
}): Promise<void> {
  const { photoId, result, rawResponse, transcript, segments, videoExtras, now, job } = opts;

  // tag upsert（与图片路径相同逻辑）
  const tagMap = new Map<string, { name: string; category: TagCategory; confidence: number }>();
  for (const t of result.tags) {
    const key = `${t.category}:${t.name}`;
    const existing = tagMap.get(key);
    if (!existing || existing.confidence < t.confidence) tagMap.set(key, t);
  }
  const uniqueTags = [...tagMap.values()];
  const tagNames = uniqueTags.map((t) => t.name);

  const existingTags = await db
    .select()
    .from(schema.tags)
    .where(inArray(schema.tags.name, tagNames));
  const existingTagMap = new Map(existingTags.map((t) => [t.name, t]));
  const newTags = uniqueTags
    .filter((t) => !existingTagMap.has(t.name))
    .map((t) => ({
      id: crypto.randomUUID(),
      name: t.name,
      category: t.category,
      createdAt: now,
    }));

  if (newTags.length > 0) {
    await db
      .insert(schema.tags)
      .values(newTags)
      .onConflictDoUpdate({
        target: schema.tags.name,
        set: { category: sql`excluded.category` },
      });
  }

  const tagNameToId = new Map<string, string>();
  for (const t of existingTags) tagNameToId.set(t.name, t.id);
  for (const t of newTags) tagNameToId.set(t.name, t.id);

  const photoTagValues = uniqueTags
    .map((t) => {
      const tagId = tagNameToId.get(t.name);
      return tagId ? { photoId, tagId, confidence: t.confidence } : null;
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  if (photoTagValues.length > 0) {
    await db.insert(schema.photoTags).values(photoTagValues).onConflictDoNothing();
  }

  // 视频字段：把 videoNarrative 合并到 narrative（前缀），以便前端读 narrative 时也看到时序描述
  const fullNarrative = videoExtras.videoNarrative
    ? `${result.narrative}\n\n[镜头时序] ${videoExtras.videoNarrative}`
    : result.narrative;

  // photoAnalyses upsert
  const existingAnalysis = await db
    .select({ id: schema.photoAnalyses.id })
    .from(schema.photoAnalyses)
    .where(eq(schema.photoAnalyses.photoId, photoId));

  const baseValues = {
    aiModel: config.ai.visionModel,
    narrative: fullNarrative,
    aestheticScore: result.aestheticScore,
    tags: result.tags,
    composition: result.composition,
    colorAnalysis: result.colorAnalysis,
    emotionalAnalysis: result.emotionalAnalysis,
    usageSuggestions: result.usageSuggestions,
    promptVersion: config.ai.promptVersion,
    rawResponse,
    processedAt: now,
    transcript,
    transcriptSegments: segments.length > 0 ? segments : null,
    videoPacing: videoExtras.videoPacing,
    motionScore: videoExtras.motionScore,
  };

  if (existingAnalysis.length > 0) {
    await db
      .update(schema.photoAnalyses)
      .set(baseValues)
      .where(eq(schema.photoAnalyses.photoId, photoId));
  } else {
    await db.insert(schema.photoAnalyses).values({
      id: crypto.randomUUID(),
      photoId,
      ...baseValues,
    });
  }

  job.log(`视频分析完成: ${tagMap.size} 个标签, 美学评分: ${result.aestheticScore}`);
}

/** 写视频分析占位记录（跳过/失败场景，确保不重复入队）。 */
async function upsertVideoPlaceholder(
  photoId: string,
  aiModel: string,
  reason: string,
  now: string,
): Promise<void> {
  const existing = await db
    .select({ id: schema.photoAnalyses.id })
    .from(schema.photoAnalyses)
    .where(eq(schema.photoAnalyses.photoId, photoId));

  const values = {
    aiModel,
    narrative: aiModel.startsWith("video-failed")
      ? `视频分析失败：${reason}。该文件已入库，可后续重试。`
      : `视频暂时无法分析 (${reason})。`,
    rawResponse: JSON.stringify({ skipped: aiModel === "skipped", reason }),
    processedAt: now,
  };

  if (existing.length > 0) {
    await db
      .update(schema.photoAnalyses)
      .set(values)
      .where(eq(schema.photoAnalyses.photoId, photoId));
  } else {
    await db.insert(schema.photoAnalyses).values({
      id: crypto.randomUUID(),
      photoId,
      ...values,
    });
  }
}

/**
 * 使用 dcraw -e -c 提取 RAW 文件中的嵌入 JPEG 预览。
 * dcraw -e 仅提取相机内嵌的 JPEG 预览，不进行 RAW 冲印，
 * 速度快（< 1 秒），输出标准 JPEG 可直接用于 AI 分析。
 */
async function extractRawPreview(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      DCRAW_PATH,
      ["-e", "-c", filePath],
      {
        encoding: "buffer",
        maxBuffer: 200 * 1024 * 1024, // 200MB 上限
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const stderrMsg = stderr
            ? Buffer.isBuffer(stderr)
              ? stderr.toString("utf8")
              : stderr
            : "";
          reject(
            new Error(`dcraw 提取预览失败: ${error.message}${stderrMsg ? ` — ${stderrMsg}` : ""}`),
          );
          return;
        }
        resolve(stdout as Buffer);
      },
    );
  });
}

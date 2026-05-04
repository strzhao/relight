import { execFile } from "node:child_process";
import path from "node:path";
import type { TagCategory } from "@relight/shared";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { aiClient } from "../ai/client";
import { evaluateResponse } from "../ai/evaluation/evaluator";
import { loadPrompts } from "../ai/prompts";
import { parseAnalysisResponse } from "../ai/response-parser";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { createStorageAdapter } from "../storage";

/** AI 视觉模型支持的格式（含需转换后支持的格式） */
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

  // === 格式门：跳过不支持的格式，写入占位记录避免重复入队 ===
  const ext = path.extname(photo.filePath).toLowerCase();

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
    // resize 与 HEIC 一致的尺寸上限
    const sharp = await import("sharp");
    buffer = await sharp
      .default(buffer)
      .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    mimeType = "image/jpeg";
  } else if (ext.endsWith(".heic") || ext.endsWith(".heif")) {
    job.log("检测到 HEIC 文件，转换为 JPEG 后发送 AI 分析");
    const { heicFileToJpeg } = await import("../lib/heic");
    buffer = await heicFileToJpeg(photo.filePath, {
      maxWidth: 2048,
      maxHeight: 2048,
      quality: 85,
    });
    mimeType = "image/jpeg";
  } else {
    buffer = await adapter.getFileBuffer(photo.filePath);
    mimeType = adapter.getMimeType(photo.filePath);
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

  for (const [, t] of tagMap) {
    // upsert tag
    const existingTags = await db
      .select({ id: schema.tags.id })
      .from(schema.tags)
      .where(eq(schema.tags.name, t.name));

    let tagId: string;
    if (existingTags[0]) {
      tagId = existingTags[0].id;
      // 更新 category 以防变化
      await db.update(schema.tags).set({ category: t.category }).where(eq(schema.tags.id, tagId));
    } else {
      tagId = crypto.randomUUID();
      await db.insert(schema.tags).values({
        id: tagId,
        name: t.name,
        category: t.category,
        createdAt: now,
      });
    }

    // 插入 photo_tags（复合主键，重复则忽略）
    try {
      await db.insert(schema.photoTags).values({
        photoId,
        tagId,
        confidence: t.confidence,
      });
    } catch {
      // 复合主键冲突，忽略
    }
  }

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

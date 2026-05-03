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

  // 2. 读取文件并 base64 编码（HEIC 需先转为 JPEG）
  const adapter = createStorageAdapter(source.type);
  let buffer = await adapter.getFileBuffer(photo.filePath);
  let mimeType = adapter.getMimeType(photo.filePath);

  const ext = photo.filePath.toLowerCase();
  if (ext.endsWith(".heic") || ext.endsWith(".heif")) {
    job.log("检测到 HEIC 文件，转换为 JPEG 后发送 AI 分析");
    const { heicFileToJpeg } = await import("../lib/heic");
    buffer = await heicFileToJpeg(photo.filePath, {
      maxWidth: 2048,
      maxHeight: 2048,
      quality: 85,
    });
    mimeType = "image/jpeg";
  }

  const base64 = buffer.toString("base64");

  job.log(`文件大小: ${buffer.length} bytes, MIME: ${mimeType}`);

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
}

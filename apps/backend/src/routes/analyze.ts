import { analyzeFilesSchema } from "@relight/shared";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";
import { analyzeQueue } from "../jobs/queues";

export const analyzeRouter = new Hono().post("/", async (c) => {
  // 1. 解析请求体
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "请求体不能为空" }, 400);
  }

  const parsed = analyzeFilesSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.message }, 400);
  }

  const { photoIds, force } = parsed.data;

  // 2. 验证照片存在性
  const photos = await db
    .select({
      id: schema.photos.id,
      filePath: schema.photos.filePath,
    })
    .from(schema.photos)
    .where(inArray(schema.photos.id, photoIds));

  const existingIds = new Set(photos.map((p) => p.id));
  const missingIds = photoIds.filter((id) => !existingIds.has(id));

  if (missingIds.length > 0) {
    return c.json(
      {
        success: false,
        error: `以下照片不存在: ${missingIds.join(", ")}`,
      },
      400,
    );
  }

  // 3. 过滤已分析的照片（force=true 时跳过过滤）
  let toAnalyze = photoIds;

  if (!force) {
    const analyzed = await db
      .select({ photoId: schema.photoAnalyses.photoId })
      .from(schema.photoAnalyses)
      .where(inArray(schema.photoAnalyses.photoId, photoIds));

    const analyzedIds = new Set(analyzed.map((a) => a.photoId));
    toAnalyze = photoIds.filter((id) => !analyzedIds.has(id));
  }

  const skippedCount = photoIds.length - toAnalyze.length;

  // 4. 入队分析任务
  const jobIds: string[] = [];

  for (const photoId of toAnalyze) {
    const job = await analyzeQueue.add(`analyze:${photoId}`, { photoId });
    jobIds.push(job.id ?? `analyze:${photoId}`);
  }

  // 5. 返回结果
  return c.json({
    success: true,
    data: {
      queuedCount: toAnalyze.length,
      skippedCount,
      jobIds,
    },
  });
});

import { analyzeFilesSchema } from "@relight/shared";
import { QueueEvents } from "bullmq";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db, schema } from "../db";
import { analyzeQueue } from "../jobs/queues";
import { config } from "../lib/config";

/** 共享 QueueEvents 实例，避免每个 SSE 连接创建新 Redis 连接 */
const analyzeQueueEvents = new QueueEvents("analyze-photo", {
  connection: { url: config.redisUrl },
});

export const analyzeRouter = new Hono()
  .post("/", async (c) => {
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

    // 预检查：查询照片对应的存储源状态
    const storageSourceIds = await db
      .select({ storageSourceId: schema.photos.storageSourceId })
      .from(schema.photos)
      .where(inArray(schema.photos.id, photoIds));

    const uniqueSourceIds = [...new Set(storageSourceIds.map((r) => r.storageSourceId))];

    const sources = await db
      .select({
        id: schema.storageSources.id,
        status: schema.storageSources.status,
      })
      .from(schema.storageSources)
      .where(inArray(schema.storageSources.id, uniqueSourceIds));

    const blockedStatuses = ["inaccessible", "unmounted", "permission_denied"] as const;
    const blockedSource = sources.find(
      (s) => s.status && blockedStatuses.includes(s.status as (typeof blockedStatuses)[number]),
    );

    if (blockedSource) {
      return c.json(
        {
          success: false,
          error: `存储源不可用：${blockedSource.status}，请检查路径后重试`,
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
  })
  /** GET /api/analyze/jobs/:jobId/events — SSE 推送单个分析任务的完成/失败事件 */
  .get("/jobs/:jobId/events", async (c) => {
    const jobId = c.req.param("jobId");

    return streamSSE(c, async (stream) => {
      const signal = c.req.raw.signal;
      let cleaned = false;

      const onCompleted = async (args: { jobId: string }) => {
        if (args.jobId !== jobId) return;
        try {
          await stream.writeSSE({
            data: JSON.stringify({ jobId, status: "completed" }),
            event: "completed",
          });
        } catch {
          // 客户端可能已断开，忽略写入错误
        }
        stream.close().catch(() => {});
      };

      const onFailed = async (args: { jobId: string; failedReason: string }) => {
        if (args.jobId !== jobId) return;
        try {
          await stream.writeSSE({
            data: JSON.stringify({
              jobId,
              status: "failed",
              error: args.failedReason,
            }),
            event: "failed",
          });
        } catch {
          // 客户端可能已断开
        }
        stream.close().catch(() => {});
      };

      analyzeQueueEvents.on("completed", onCompleted);
      analyzeQueueEvents.on("failed", onFailed);

      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        analyzeQueueEvents.off("completed", onCompleted);
        analyzeQueueEvents.off("failed", onFailed);
      };

      signal.addEventListener(
        "abort",
        () => {
          cleanup();
        },
        { once: true },
      );

      // 等待事件或客户端断开
      while (!signal.aborted) {
        await stream.sleep(1000);
      }

      await cleanup();
    });
  });

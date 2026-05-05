import { QueueEvents, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { analyzePhotoWorker } from "../jobs/analyze-photo";
import { dailySelectionWorker } from "../jobs/daily-selection";
import { scanStorageWorker } from "../jobs/scan-storage";
import { config } from "../lib/config";

const connection = { url: config.redisUrl };

// 创建三个 Worker 实例
const scanWorker = new Worker("scan-storage", scanStorageWorker, {
  connection,
});

const analyzeWorker = new Worker("analyze-photo", analyzePhotoWorker, {
  connection,
  concurrency: 4,
});

const dailyWorker = new Worker("daily-selection", dailySelectionWorker, {
  connection,
});

// QueueEvents 监听器 — 追踪批量分析进度
const analyzeEvents = new QueueEvents("analyze-photo", { connection });

async function finalizeBatchIfDone(batchId: string) {
  const [batch] = await db
    .select()
    .from(schema.analyzeBatches)
    .where(eq(schema.analyzeBatches.id, batchId));

  if (batch && !batch.finishedAt && batch.completedCount + batch.failedCount >= batch.totalCount) {
    await db
      .update(schema.analyzeBatches)
      .set({ finishedAt: new Date().toISOString() })
      .where(eq(schema.analyzeBatches.id, batchId));
  }
}

analyzeEvents.on("completed", async ({ jobId }) => {
  try {
    const [mapping] = await db
      .select({ batchId: schema.analyzeBatchJobs.batchId })
      .from(schema.analyzeBatchJobs)
      .where(eq(schema.analyzeBatchJobs.jobId, jobId));

    if (!mapping) return;

    await db
      .update(schema.analyzeBatches)
      .set({ completedCount: sql`completed_count + 1` })
      .where(eq(schema.analyzeBatches.id, mapping.batchId));

    await finalizeBatchIfDone(mapping.batchId);
  } catch {
    // 忽略错误，不影响分析流程
  }
});

analyzeEvents.on("failed", async ({ jobId }) => {
  try {
    const [mapping] = await db
      .select({ batchId: schema.analyzeBatchJobs.batchId })
      .from(schema.analyzeBatchJobs)
      .where(eq(schema.analyzeBatchJobs.jobId, jobId));

    if (!mapping) return;

    await db
      .update(schema.analyzeBatches)
      .set({ failedCount: sql`failed_count + 1` })
      .where(eq(schema.analyzeBatches.id, mapping.batchId));

    await finalizeBatchIfDone(mapping.batchId);
  } catch {
    // 忽略错误
  }
});

// 优雅关闭
async function shutdown(signal: string): Promise<void> {
  console.log(`[workers] 收到 ${signal} 信号，正在关闭 Worker...`);
  try {
    await Promise.all([
      scanWorker.close(false),
      analyzeWorker.close(false),
      dailyWorker.close(false),
      analyzeEvents.close(),
    ]);
    console.log("[workers] 所有 Worker 已关闭");
    process.exit(0);
  } catch (err) {
    console.error("[workers] Worker 关闭失败:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Worker 事件日志
scanWorker.on("completed", (job) => {
  console.log(`[scan-storage] 任务完成: ${job.id}`);
});
scanWorker.on("failed", (job, err) => {
  console.error(`[scan-storage] 任务失败: ${job?.id}`, err.message);
});

analyzeWorker.on("completed", (job) => {
  console.log(`[analyze-photo] 任务完成: ${job.id}`);
});
analyzeWorker.on("failed", (job, err) => {
  console.error(`[analyze-photo] 任务失败: ${job?.id}`, err.message);
});

dailyWorker.on("completed", (job) => {
  console.log(`[daily-selection] 任务完成: ${job.id}`);
});
dailyWorker.on("failed", (job, err) => {
  console.error(`[daily-selection] 任务失败: ${job?.id}`, err.message);
});

console.log("[workers] BullMQ Worker 进程已启动");
console.log(`[workers] Redis: ${config.redisUrl}`);

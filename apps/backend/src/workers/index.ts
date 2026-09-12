import * as os from "node:os";
import { QueueEvents, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import Redis from "ioredis";
import { db, schema } from "../db";
import { analyzePhotoWorker } from "../jobs/analyze-photo";
import { dailyPushWorker } from "../jobs/daily-push";
import { dailySelectionWorker } from "../jobs/daily-selection";
import { dailyVideoWorker } from "../jobs/daily-video";
import { detectFacesWorker } from "../jobs/detect-faces";
import { scanStorageWorker } from "../jobs/scan-storage";
import { wallpaperVideoWorker } from "../jobs/wallpaper-video";
import { buildInfo } from "../lib/build-info";
import { config } from "../lib/config";

const connection = { url: config.redisUrl };

// === Worker 元数据心跳 ===
const workerMetaKey = `${config.bullmqPrefix}:worker:meta`;
const workerStartedAt = new Date().toISOString();

/** ioredis 实例，仅用于写入 worker meta key */
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

async function writeWorkerMeta(): Promise<void> {
  const meta = JSON.stringify({
    commit: buildInfo.commit,
    commitTime: buildInfo.commitTime,
    startedAt: workerStartedAt,
    pid: process.pid,
    hostname: os.hostname(),
  });
  await redis.set(workerMetaKey, meta, "EX", 120);
}

// 启动心跳（每 60s 续期，TTL 120s）
const heartbeatTimer = setInterval(() => {
  writeWorkerMeta().catch((err) => {
    console.error("[workers] 心跳写入失败:", err);
  });
}, 60_000);

// 初始 meta 写入（fire-and-forget — Redis 不可用时不阻塞模块加载）
writeWorkerMeta().catch((err) => {
  console.error("[workers] 初始 meta 写入失败:", err);
});

// 创建三个 Worker 实例
const scanWorker = new Worker("scan-storage", scanStorageWorker, {
  connection,
  prefix: config.bullmqPrefix,
});

const analyzeWorker = new Worker("analyze-photo", analyzePhotoWorker, {
  connection,
  concurrency: 4,
  prefix: config.bullmqPrefix,
});

const dailyWorker = new Worker("daily-selection", dailySelectionWorker, {
  connection,
  prefix: config.bullmqPrefix,
});

// 人脸检测 Worker — concurrency=2（ONNX CPU 密集，与 analyze 抢资源时调低）
const detectFacesWorkerInstance = new Worker("detect-faces", detectFacesWorker, {
  connection,
  concurrency: 2,
  prefix: config.bullmqPrefix,
});

// 每日精选壁纸企业微信群推送 Worker — 每天 10:00 触发，串行单任务即可
const dailyPushWorkerInstance = new Worker("daily-push", dailyPushWorker, {
  connection,
  prefix: config.bullmqPrefix,
});

// 每日视频生成 Worker — 每天 10:00 触发（有主题才做，spawn claude -p 渲染）
const dailyVideoWorkerInstance = new Worker("daily-video", dailyVideoWorker, {
  connection,
  prefix: config.bullmqPrefix,
});

// 壁纸视频生成 Worker — daily-selection 阶段 4 链式触发（串行单任务；单条 spawn 90min 级）
const wallpaperVideoWorkerInstance = new Worker("wallpaper-video", wallpaperVideoWorker, {
  connection,
  prefix: config.bullmqPrefix,
});

// QueueEvents 监听器 — 追踪批量分析进度
const analyzeEvents = new QueueEvents("analyze-photo", { connection, prefix: config.bullmqPrefix });

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
  clearInterval(heartbeatTimer);
  try {
    await redis.del(workerMetaKey);
    await redis.quit();
    await Promise.all([
      scanWorker.close(false),
      analyzeWorker.close(false),
      dailyWorker.close(false),
      detectFacesWorkerInstance.close(false),
      dailyPushWorkerInstance.close(false),
      dailyVideoWorkerInstance.close(false),
      wallpaperVideoWorkerInstance.close(false),
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

detectFacesWorkerInstance.on("completed", (job) => {
  console.log(`[detect-faces] 任务完成: ${job.id}`);
});
detectFacesWorkerInstance.on("failed", (job, err) => {
  console.error(`[detect-faces] 任务失败: ${job?.id}`, err.message);
});

dailyPushWorkerInstance.on("completed", (job) => {
  console.log(`[daily-push] 任务完成: ${job.id}`);
});
dailyPushWorkerInstance.on("failed", (job, err) => {
  console.error(`[daily-push] 任务失败: ${job?.id}`, err.message);
});

dailyVideoWorkerInstance.on("completed", (job) => {
  console.log(`[daily-video] 任务完成: ${job.id}`);
});
dailyVideoWorkerInstance.on("failed", (job, err) => {
  console.error(`[daily-video] 任务失败: ${job?.id}`, err.message);
});

wallpaperVideoWorkerInstance.on("completed", (job) => {
  console.log(`[wallpaper-video] 任务完成: ${job.id}`);
});
wallpaperVideoWorkerInstance.on("failed", (job, err) => {
  console.error(`[wallpaper-video] 任务失败（当日回退静态）: ${job?.id}`, err.message);
});

console.log(
  `[workers] BullMQ Worker 进程已启动 commit=${buildInfo.commit} commitTime=${buildInfo.commitTime} pid=${process.pid}`,
);
console.log(`[workers] Redis: ${config.redisUrl}`);

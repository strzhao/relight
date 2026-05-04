import type {
  QueueJobCounts,
  QueueJobDetail,
  QueueJobSummary,
  QueueSnapshot,
  ScanProgress,
} from "@relight/shared";
import type { Queue } from "bullmq";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db, schema } from "../db";
import { analyzeQueue, dailyQueue, scanQueue } from "../jobs/queues";

/** 队列配置项 */
interface QueueConfig {
  queue: Queue;
  label: string;
  description: string;
  isActive: boolean;
  badge: string | null;
}

/** 已知队列配置 */
const queueConfigs: Record<string, QueueConfig> = {
  "scan-storage": {
    queue: scanQueue,
    label: "扫描存储",
    description: "扫描存储源中的新照片",
    isActive: true,
    badge: null,
  },
  "analyze-photo": {
    queue: analyzeQueue,
    label: "AI 分析",
    description: "对照片进行 AI 多维度分析",
    isActive: true,
    badge: null,
  },
  "daily-selection": {
    queue: dailyQueue,
    label: "每日精选",
    description: "从分析结果中精选每日照片",
    isActive: false,
    badge: "即将支持",
  },
};

const KNOWN_QUEUES = Object.keys(queueConfigs);

function getConfig(name: string): QueueConfig | undefined {
  return queueConfigs[name];
}

/** 从 BullMQ getJobCounts 返回值提取类型化计数 */
async function getTypedCounts(queue: Queue): Promise<QueueJobCounts> {
  const raw = await queue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed",
    "paused",
  );
  return {
    waiting: raw.waiting ?? 0,
    active: raw.active ?? 0,
    completed: raw.completed ?? 0,
    failed: raw.failed ?? 0,
    delayed: raw.delayed ?? 0,
    paused: raw.paused ?? 0,
  };
}

/** 从 BullMQ job 推断统一状态 */
function inferState(job: Record<string, unknown>): QueueJobSummary["state"] {
  if (job.failedReason) return "failed";
  if (job.finishedOn) return "completed";
  if (job.processedOn) return "active";
  if (job.delayed) return "delayed";
  return "waiting";
}

/** 将 BullMQ Job 转为 QueueJobSummary */
function toJobSummary(
  job: Record<string, unknown>,
  progress?: ScanProgress | number | null,
  photoLabelMap?: Map<string, string>,
): QueueJobSummary {
  const data = job.data as Record<string, unknown> | undefined;
  const rawName = String(job.name ?? "");
  let displayName = rawName;
  if (data?.photoId) {
    const label = photoLabelMap?.get(String(data.photoId));
    if (label) {
      displayName = label;
    }
  }

  return {
    id: String(job.id ?? ""),
    name: displayName,
    state: inferState(job),
    timestamp: Number(job.timestamp ?? 0),
    processedOn: job.processedOn ? Number(job.processedOn) : null,
    finishedOn: job.finishedOn ? Number(job.finishedOn) : null,
    attemptsMade: Number(job.attemptsMade ?? 0),
    failedReason: job.failedReason ? String(job.failedReason) : null,
    progress: progress && typeof progress === "object" ? (progress as ScanProgress) : null,
  };
}

/** 获取队列快照（counts + recentJobs + aggregateProgress） */
async function getQueueSnapshot(queue: Queue): Promise<QueueSnapshot> {
  const counts = await getTypedCounts(queue);
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getJobs("waiting", 0, 4),
    queue.getJobs("active", 0, 4),
    queue.getJobs("completed", 0, 4),
    queue.getJobs("failed", 0, 4),
    queue.getJobs("delayed", 0, 4),
  ]);

  // 收集所有 analyze 作业的 photoId，批量查询 filePath 用于展示名
  const allRawJobs = [...waiting, ...active, ...completed, ...failed, ...delayed];
  const photoIds = new Set(
    allRawJobs
      .map((j) => (j.data as Record<string, unknown> | undefined)?.photoId)
      .filter((id): id is string => typeof id === "string"),
  );

  let photoLabelMap: Map<string, string> | undefined;
  if (photoIds.size > 0) {
    const photoRows = await db
      .select({ id: schema.photos.id, filePath: schema.photos.filePath })
      .from(schema.photos)
      .where(inArray(schema.photos.id, [...photoIds]));
    photoLabelMap = new Map(
      photoRows.map((p) => [p.id, p.filePath.split("/").pop() ?? p.filePath]),
    );
  }

  const statePriority: Record<string, number> = {
    active: 0,
    completed: 1,
    failed: 1,
    delayed: 2,
    waiting: 3,
  };

  const allJobs = allRawJobs
    .map((j) =>
      toJobSummary(
        j as unknown as Record<string, unknown>,
        j.progress as ScanProgress | number | null,
        photoLabelMap,
      ),
    )
    .sort((a, b) => {
      const pa = statePriority[a.state] ?? 4;
      const pb = statePriority[b.state] ?? 4;
      if (pa !== pb) return pa - pb;
      return b.timestamp - a.timestamp;
    })
    .slice(0, 20);

  // 计算 aggregateProgress：汇总所有 active 作业的 progress
  let aggregateProgress: QueueSnapshot["aggregateProgress"] = null;
  const activeWithProgress = active
    .map((j) => j.progress as ScanProgress | number | string | undefined | null)
    .filter((p): p is ScanProgress => typeof p === "object" && p !== null && "phase" in p);

  if (activeWithProgress.length > 0) {
    aggregateProgress = activeWithProgress.reduce(
      (acc, p) => ({
        totalFiles: acc.totalFiles + (p.totalFiles || 0),
        processed: acc.processed + (p.processed || 0),
        newCount: acc.newCount + (p.newCount || 0),
        skippedCount: acc.skippedCount + (p.skippedCount || 0),
        errorCount: acc.errorCount + (p.errorCount || 0),
        updatedCount: acc.updatedCount + (p.updatedCount || 0),
        regeneratedCount: acc.regeneratedCount + (p.regeneratedCount || 0),
      }),
      {
        totalFiles: 0,
        processed: 0,
        newCount: 0,
        skippedCount: 0,
        errorCount: 0,
        updatedCount: 0,
        regeneratedCount: 0,
      },
    );
  }

  return {
    timestamp: new Date().toISOString(),
    counts,
    recentJobs: allJobs,
    aggregateProgress,
  };
}

export const queuesRouter = new Hono()
  /** GET /api/queues — 队列列表 + 实时计数（侧边栏轮询） */
  .get("/", async (c) => {
    const results = await Promise.all(
      KNOWN_QUEUES.map(async (name) => {
        const cfg = getConfig(name);
        if (!cfg) return null;
        let qCounts: QueueJobCounts | null = null;
        try {
          qCounts = await getTypedCounts(cfg.queue);
        } catch {
          // Redis 不可用时返回 null
        }
        return {
          name,
          label: cfg.label,
          description: cfg.description,
          isActive: cfg.isActive,
          badge: cfg.badge,
          counts: qCounts,
        };
      }),
    );

    return c.json({ success: true, data: results.filter(Boolean) });
  })

  /** GET /api/queues/:name/events — SSE 推送队列快照（3s 间隔） */
  .get("/:name/events", async (c) => {
    const name = c.req.param("name");
    const cfg = getConfig(name);

    if (!cfg) {
      return c.json({ success: false, error: `未知队列: ${name}` }, 404);
    }

    if (!cfg.isActive) {
      return c.json({ success: false, error: "该队列暂未开放" }, 403);
    }

    return streamSSE(c, async (stream) => {
      const signal = c.req.raw.signal;

      const push = async () => {
        try {
          const snapshot = await getQueueSnapshot(cfg.queue);
          await stream.writeSSE({
            data: JSON.stringify(snapshot),
            event: "snapshot",
          });
        } catch {
          await stream.writeSSE({
            data: JSON.stringify({ error: "Redis 连接失败" }),
            event: "error",
          });
        }
      };

      // 立即推送第一帧
      await push();

      // 每 3 秒推送
      const interval = setInterval(async () => {
        if (signal.aborted) return;
        await push();
      }, 3000);

      // 客户端断开时清理
      const onAbort = () => {
        clearInterval(interval);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      // 持续写入 sleep 防止 stream 关闭
      while (!signal.aborted) {
        await stream.sleep(1000);
      }

      clearInterval(interval);
    });
  })

  /** GET /api/queues/:name/jobs/:jobId — 单个作业详情 */
  .get("/:name/jobs/:jobId", async (c) => {
    const name = c.req.param("name");
    const jobId = c.req.param("jobId");
    const cfg = getConfig(name);

    if (!cfg) {
      return c.json({ success: false, error: `未知队列: ${name}` }, 404);
    }

    try {
      const job = await cfg.queue.getJob(jobId);
      if (!job) {
        return c.json({ success: false, error: "作业不存在" }, 404);
      }

      const state = await job.getState();

      const detail: QueueJobDetail = {
        id: job.id ?? "",
        name: job.name,
        state: state as QueueJobDetail["state"],
        timestamp: job.timestamp,
        processedOn: job.processedOn ?? null,
        finishedOn: job.finishedOn ?? null,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason ?? null,
        data: job.data,
        progress: job.progress as ScanProgress | null,
        returnvalue: job.returnvalue,
        opts: job.opts as Record<string, unknown>,
        stacktrace: job.stacktrace ?? [],
      };

      return c.json({ success: true, data: detail });
    } catch {
      return c.json({ success: false, error: "获取作业详情失败" }, 500);
    }
  });

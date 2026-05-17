import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { count, desc, sql } from "drizzle-orm";
import { Hono } from "hono";
import Redis from "ioredis";
import { db, schema } from "../db";
import { analyzeQueue, dailyQueue, detectFacesQueue, scanQueue } from "../jobs/queues";
import { config } from "../lib/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8")) as {
  version: string;
};

type Status = "running" | "degraded" | "down";

/** 北京时间今天 00:00 的 ISO 字符串（用于 todayAdded 统计） */
function todayStartIsoBeijing(): string {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  beijing.setUTCHours(0, 0, 0, 0);
  return new Date(beijing.getTime() - 8 * 3600 * 1000).toISOString();
}

async function probeRedis(): Promise<{ status: Status; latencyMs: number | null }> {
  const r = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
    lazyConnect: true,
  });
  try {
    await r.connect();
    const t0 = Date.now();
    await r.ping();
    const latencyMs = Date.now() - t0;
    return { status: "running", latencyMs };
  } catch {
    return { status: "down", latencyMs: null };
  } finally {
    r.quit().catch(() => {});
  }
}

async function probeWorkers(): Promise<{
  status: Status;
  lastHeartbeatAgoSec: number | null;
  commit: string | null;
}> {
  const r = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
    lazyConnect: true,
  });
  try {
    await r.connect();
    const key = `${config.bullmqPrefix}:worker:meta`;
    // Worker 写入时 EX 120，每 60s 续期一次。TTL 才是心跳新鲜度，
    // startedAt 只是开机时间（worker 跑越久越大，不能用来判活）
    const [metaRaw, ttl] = await Promise.all([r.get(key), r.ttl(key)]);
    if (!metaRaw || ttl <= 0) {
      return { status: "down", lastHeartbeatAgoSec: null, commit: null };
    }
    const meta = JSON.parse(metaRaw) as { startedAt: string; commit?: string };
    const lastHeartbeatAgoSec = Math.max(0, 120 - ttl);
    return { status: "running", lastHeartbeatAgoSec, commit: meta.commit ?? null };
  } catch {
    return { status: "down", lastHeartbeatAgoSec: null, commit: null };
  } finally {
    r.quit().catch(() => {});
  }
}

async function probeQueueDepth(): Promise<{
  scan: number;
  analyze: number;
  daily: number;
  faces: number;
} | null> {
  try {
    const [scanCounts, analyzeCounts, dailyCounts, facesCounts] = await Promise.all([
      scanQueue.getJobCounts(),
      analyzeQueue.getJobCounts(),
      dailyQueue.getJobCounts(),
      detectFacesQueue.getJobCounts(),
    ]);
    const pending = (cs: Record<string, number>) =>
      (cs.waiting ?? 0) + (cs.active ?? 0) + (cs.delayed ?? 0);
    return {
      scan: pending(scanCounts),
      analyze: pending(analyzeCounts),
      daily: pending(dailyCounts),
      faces: pending(facesCounts),
    };
  } catch {
    return null;
  }
}

async function probeCron(): Promise<{
  status: Status;
  lastDailyPickDate: string | null;
  nextRunAt: string | null;
}> {
  let nextRunAt: string | null = null;
  let cronRegistered = false;
  try {
    const repeatables = await dailyQueue.getRepeatableJobs();
    // BullMQ getRepeatableJobs 返回对象的 id 是内部哈希而非用户 jobId，
    // 这里改按 name 匹配（registerDailyRepeatableJob 用 "daily-selection-cron" 作 name）
    const job = repeatables.find((j) => j.name === "daily-selection-cron");
    if (job) {
      cronRegistered = true;
      nextRunAt = job.next ? new Date(job.next).toISOString() : null;
    }
  } catch {
    // Redis 挂了或队列 API 出错，cron 算 down
  }

  let lastDailyPickDate: string | null = null;
  try {
    const [latest] = await db
      .select({ pickDate: schema.dailyPicks.pickDate })
      .from(schema.dailyPicks)
      .orderBy(desc(schema.dailyPicks.pickDate))
      .limit(1);
    lastDailyPickDate = latest?.pickDate ?? null;
  } catch {
    // DB 出错时降级
  }

  return {
    status: cronRegistered ? "running" : "down",
    lastDailyPickDate,
    nextRunAt,
  };
}

async function repositoryStats(): Promise<{
  photoCount: number;
  todayAdded: number;
  pendingAnalysis: number;
  storageBytes: number;
} | null> {
  try {
    const todayIso = todayStartIsoBeijing();
    const [photoCount] = await db.select({ total: count() }).from(schema.photos);
    const [todayAdded] = await db
      .select({ total: count() })
      .from(schema.photos)
      .where(sql`${schema.photos.createdAt} >= ${todayIso}`);
    const [pendingAnalysis] = await db
      .select({ total: count() })
      .from(schema.photos)
      .where(
        sql`NOT EXISTS (SELECT 1 FROM photo_analyses WHERE photo_analyses.photo_id = ${schema.photos.id})`,
      );
    const [storageBytes] = await db
      .select({ total: sql<number>`COALESCE(SUM(${schema.photos.fileSize}), 0)` })
      .from(schema.photos);

    return {
      photoCount: photoCount?.total ?? 0,
      todayAdded: todayAdded?.total ?? 0,
      pendingAnalysis: pendingAnalysis?.total ?? 0,
      storageBytes: Number(storageBytes?.total ?? 0),
    };
  } catch {
    return null;
  }
}

export const runtimeRouter = new Hono().get("/status", async (c) => {
  const [redis, workers, queueDepth, cron, repo] = await Promise.all([
    probeRedis(),
    probeWorkers(),
    probeQueueDepth(),
    probeCron(),
    repositoryStats(),
  ]);

  const services = {
    api: {
      status: "running" as Status,
      port: config.port,
      uptimeSec: Math.floor(process.uptime()),
      pid: process.pid,
    },
    workers: {
      status: workers.status,
      lastHeartbeatAgoSec: workers.lastHeartbeatAgoSec,
      commit: workers.commit,
      queueDepth,
    },
    redis,
    cron,
  };

  const statuses: Status[] = [services.api.status, workers.status, redis.status, cron.status];
  const overall: Status = statuses.some((s) => s === "down")
    ? "down"
    : statuses.some((s) => s === "degraded")
      ? "degraded"
      : "running";

  return c.json({
    success: true,
    data: {
      overall,
      version: pkg.version,
      services,
      repository: repo,
    },
  });
});

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db, schema } from "./db";
import { dailyPushQueue, dailyQueue, dailyVideoQueue, scanQueue } from "./jobs/queues";
import { AppError } from "./lib/errors";
import { localhostOnly, localhostOnlyStrict } from "./lib/middleware/localhost-only";
import {
  adminRouter,
  analyzeRouter,
  burstsRouter,
  dailyRouter,
  healthRouter,
  personsRouter,
  photosRouter,
  pluginsRouter,
  queuesRouter,
  runtimeRouter,
  scanRouter,
  settingsRouter,
  storageRouter,
  tagsRouter,
  videosRouter,
} from "./routes";
import { pushRouter } from "./routes/push";
import { runtimeConfigRouter } from "./routes/runtime-config";
import { workersControlRouter } from "./routes/workers-control";
import { workersLogsRouter } from "./routes/workers-logs";

/** 注册每日精选重复任务（每天北京时间凌晨 0:00） */
export async function registerDailyRepeatableJob(): Promise<void> {
  await dailyQueue.add(
    "daily-selection-cron",
    {},
    {
      repeat: { pattern: "0 0 * * *", tz: "Asia/Shanghai" },
      jobId: "daily-selection-cron",
    },
  );
}

/** 注册每日壁纸推送重复任务（每天北京时间 10:00，与每日精选 0:00 解耦） */
export async function registerDailyPushRepeatableJob(): Promise<void> {
  await dailyPushQueue.add(
    "daily-push-cron",
    {},
    {
      repeat: { pattern: "0 10 * * *", tz: "Asia/Shanghai" },
      jobId: "daily-push-cron",
    },
  );
}

/** 注册每日视频生成重复任务（每天北京时间 03:00：daily-selection 0:00 / scan 2:00 之后，push 10:00 之前） */
export async function registerDailyVideoRepeatableJob(): Promise<void> {
  await dailyVideoQueue.add(
    "daily-video-cron",
    {},
    {
      repeat: { pattern: "0 3 * * *", tz: "Asia/Shanghai" },
      jobId: "daily-video-cron",
    },
  );
}

/** 注册扫描重复任务（每天北京时间凌晨 2:00，避开每日精选 0:00） */
export async function registerScanRepeatableJob(): Promise<void> {
  const sources = await db
    .select({ id: schema.storageSources.id })
    .from(schema.storageSources)
    .where(eq(schema.storageSources.enabled, true));

  for (const source of sources) {
    await scanQueue.add(
      `scan-cron:${source.id}`,
      { storageSourceId: source.id },
      {
        repeat: { pattern: "0 2 * * *", tz: "Asia/Shanghai" },
        jobId: `scan-cron:${source.id}`,
      },
    );
  }
}

export function createApp(): Hono {
  const app = new Hono();

  const allowedOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.use(
    "*",
    cors({
      origin: (origin) => {
        // Hono cors() 实现：返回 falsy（"" / null）→ 不下发 ACAO 头
        // - Mac App / 同源请求无 Origin 头：返回 "" 不下发 ACAO，URLSession 本身不做 CORS 检查 → 不受影响
        // - 浏览器请求带 Origin：白名单内 echo back（值！不要用 *），否则不下发
        if (!origin) return "";
        return allowedOriginPattern.test(origin) ? origin : null;
      },
      credentials: false,
    }),
  );

  app.use("/api/runtime/*", localhostOnly);
  app.use("/api/push/*", localhostOnlyStrict);

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { success: false, error: err.message, code: err.code },
        err.statusCode as 400 | 404 | 500,
      );
    }
    console.error("未预期的错误:", err);
    return c.json({ success: false, error: "服务器内部错误" }, 500);
  });

  app.route("/api/health", healthRouter);
  app.route("/api/runtime", runtimeRouter);
  app.route("/api/runtime/workers", workersControlRouter);
  app.route("/api/runtime/workers/logs", workersLogsRouter);
  app.route("/api/runtime/config", runtimeConfigRouter);
  app.route("/api/photos", photosRouter);
  app.route("/api/daily", dailyRouter);
  app.route("/api/push", pushRouter);
  app.route("/api/tags", tagsRouter);
  app.route("/api/admin", adminRouter);
  app.route("/api/scan", scanRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/queues", queuesRouter);
  app.route("/api/storage", storageRouter);
  app.route("/api/analyze", analyzeRouter);
  app.route("/api/bursts", burstsRouter);
  app.route("/api/persons", personsRouter);
  app.route("/api/plugins", pluginsRouter);
  app.route("/api/videos", videosRouter);

  return app;
}

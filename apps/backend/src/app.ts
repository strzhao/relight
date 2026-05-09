import { Hono } from "hono";
import { cors } from "hono/cors";
import { dailyQueue } from "./jobs/queues";
import { AppError } from "./lib/errors";
import {
  adminRouter,
  analyzeRouter,
  burstsRouter,
  dailyRouter,
  healthRouter,
  photosRouter,
  queuesRouter,
  scanRouter,
  settingsRouter,
  storageRouter,
  tagsRouter,
} from "./routes";

/** 注册每日精选重复任务（每天北京时间 6:00 AM） */
export async function registerDailyRepeatableJob(): Promise<void> {
  await dailyQueue.add(
    "daily-selection-cron",
    {},
    {
      repeat: { pattern: "0 6 * * *", tz: "Asia/Shanghai" },
      jobId: "daily-selection-cron",
    },
  );
}

export function createApp(): Hono {
  const app = new Hono();

  app.use("*", cors());

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
  app.route("/api/photos", photosRouter);
  app.route("/api/daily", dailyRouter);
  app.route("/api/tags", tagsRouter);
  app.route("/api/admin", adminRouter);
  app.route("/api/scan", scanRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/queues", queuesRouter);
  app.route("/api/storage", storageRouter);
  app.route("/api/analyze", analyzeRouter);
  app.route("/api/bursts", burstsRouter);

  return app;
}

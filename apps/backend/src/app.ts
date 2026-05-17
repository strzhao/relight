import { Hono } from "hono";
import { cors } from "hono/cors";
import { dailyQueue } from "./jobs/queues";
import { AppError } from "./lib/errors";
import { localhostOnly } from "./lib/middleware/localhost-only";
import {
  adminRouter,
  analyzeRouter,
  burstsRouter,
  dailyRouter,
  healthRouter,
  personsRouter,
  photosRouter,
  queuesRouter,
  runtimeRouter,
  scanRouter,
  settingsRouter,
  storageRouter,
  tagsRouter,
} from "./routes";
import { workersControlRouter } from "./routes/workers-control";

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
  app.route("/api/persons", personsRouter);

  return app;
}

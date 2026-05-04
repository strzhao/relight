import { Hono } from "hono";
import { cors } from "hono/cors";
import { AppError } from "./lib/errors";
import {
  adminRouter,
  analyzeRouter,
  dailyRouter,
  healthRouter,
  photosRouter,
  queuesRouter,
  scanRouter,
  settingsRouter,
  storageRouter,
  tagsRouter,
} from "./routes";

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

  return app;
}

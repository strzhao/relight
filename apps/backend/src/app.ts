import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  adminRouter,
  dailyRouter,
  healthRouter,
  photosRouter,
  queuesRouter,
  scanRouter,
  settingsRouter,
  tagsRouter,
} from "./routes";

export function createApp(): Hono {
  const app = new Hono();

  app.use("*", cors());

  app.route("/api/health", healthRouter);
  app.route("/api/photos", photosRouter);
  app.route("/api/daily", dailyRouter);
  app.route("/api/tags", tagsRouter);
  app.route("/api/admin", adminRouter);
  app.route("/api/scan", scanRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/queues", queuesRouter);

  return app;
}

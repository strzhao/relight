import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  analyzeRouter,
  dailyRouter,
  healthRouter,
  photosRouter,
  scanRouter,
  settingsRouter,
  storageRouter,
  tagsRouter,
} from "./routes";

export function createApp(): Hono {
  const app = new Hono();

  app.use("*", cors());

  app.route("/api/health", healthRouter);
  app.route("/api/photos", photosRouter);
  app.route("/api/daily", dailyRouter);
  app.route("/api/tags", tagsRouter);
  app.route("/api/scan", scanRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/storage", storageRouter);
  app.route("/api/analyze", analyzeRouter);

  return app;
}

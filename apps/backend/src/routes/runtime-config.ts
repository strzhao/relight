import { Hono } from "hono";
import { config } from "../lib/config";

function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

export const runtimeConfigRouter = new Hono().get("/", async (c) => {
  return c.json({
    success: true,
    data: {
      storageRoot: config.storageRoot,
      aiBaseUrl: config.ai.baseUrl,
      aiModel: config.ai.model,
      aiVisionModel: config.ai.visionModel,
      redisUrl: config.redisUrl,
      databasePath: config.databasePath,
      bullmqPrefix: config.bullmqPrefix,
      aiApiKey: maskApiKey(config.ai.apiKey),
      webPort: config.webPort,
    },
  });
});

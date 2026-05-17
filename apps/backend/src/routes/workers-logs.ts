import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Hono } from "hono";

const PM2_LOG_DIR = path.join(os.homedir(), ".pm2/logs");

async function tailLines(file: string, n: number): Promise<string[]> {
  const buf: string[] = [];
  try {
    const rl = createInterface({
      input: createReadStream(file),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      buf.push(line);
      if (buf.length > n) buf.shift();
    }
  } catch {
    return [];
  }
  return buf;
}

export const workersLogsRouter = new Hono().get("/", async (c) => {
  const linesParam = Number(c.req.query("lines") ?? 200);
  const lines = Math.min(Math.max(1, linesParam), 1000);
  const [stdout, stderr] = await Promise.all([
    tailLines(path.join(PM2_LOG_DIR, "relight-workers-out.log"), lines),
    tailLines(path.join(PM2_LOG_DIR, "relight-workers-error.log"), lines),
  ]);
  return c.json({ success: true, data: { stdout, stderr } });
});

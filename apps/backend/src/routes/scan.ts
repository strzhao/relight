import { scanNowSchema } from "@relight/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";
import { scanQueue } from "../jobs/queues";

export const scanRouter = new Hono()
  .get("/", (c) => c.json({ success: true, data: [], total: 0 }))
  .post("/", async (c) => {
    // 获取请求体（接收前端传来的 storageSourceId）
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // body 为空，使用默认值
    }

    const parsed = scanNowSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.message }, 400);
    }

    // 如果没有指定 storageSourceId，取第一个启用的存储源
    let storageSourceId = parsed.data.storageSourceId;
    if (!storageSourceId) {
      const sources = await db
        .select({ id: schema.storageSources.id })
        .from(schema.storageSources)
        .where(eq(schema.storageSources.enabled, true))
        .limit(1);

      if (!sources[0]) {
        return c.json({ success: false, error: "没有可用的存储源，请先配置" }, 400);
      }
      storageSourceId = sources[0].id;
    }

    // 入队扫描任务（传递 skipAnalysis）
    const skipAnalysis = parsed.data.skipAnalysis ?? false;
    const job = await scanQueue.add(`scan:${storageSourceId}`, {
      storageSourceId,
      skipAnalysis,
    });

    return c.json({
      success: true,
      data: { jobId: job.id, storageSourceId },
    });
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");

    // 查找扫描日志
    const logs = await db
      .select()
      .from(schema.scanLogs)
      .where(eq(schema.scanLogs.storageSourceId, id))
      .orderBy(schema.scanLogs.startedAt);

    const latestLog = logs[logs.length - 1];

    if (!latestLog) {
      return c.json({
        success: true,
        data: { id, status: "pending", message: "暂无扫描记录" as const },
      });
    }

    let status: "running" | "completed" | "failed";
    let errorMessage: string | undefined;

    if (!latestLog.finishedAt) {
      status = "running";
    } else if (latestLog.newCount === 0 && latestLog.errorCount > 0) {
      status = "failed";
      errorMessage = `扫描失败：${latestLog.errorCount} 个错误`;
    } else {
      status = "completed";
    }

    return c.json({
      success: true,
      data: {
        id: latestLog.id,
        storageSourceId: latestLog.storageSourceId,
        status,
        errorMessage,
        scannedCount: latestLog.scannedCount,
        newCount: latestLog.newCount,
        errorCount: latestLog.errorCount,
        startedAt: latestLog.startedAt,
        finishedAt: latestLog.finishedAt,
      },
    });
  });

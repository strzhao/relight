import { scanNowSchema } from "@relight/shared";
import type { ScanProgressEvent } from "@relight/shared";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db, schema } from "../db";
import { scanQueue } from "../jobs/queues";

const STALE_THRESHOLD_MINUTES = 30;

export const scanRouter = new Hono()
  .get("/", (c) => c.json({ success: true, data: [], total: 0 }))
  .post("/", async (c) => {
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

    // 预检查：存储源可达性状态
    const [sourceCheck] = await db
      .select({
        id: schema.storageSources.id,
        status: schema.storageSources.status,
        name: schema.storageSources.name,
      })
      .from(schema.storageSources)
      .where(eq(schema.storageSources.id, storageSourceId));

    if (!sourceCheck) {
      return c.json({ success: false, error: "存储源不存在" }, 404);
    }

    const blockedStatuses = ["inaccessible", "unmounted", "permission_denied"] as const;
    if (
      sourceCheck.status &&
      blockedStatuses.includes(sourceCheck.status as (typeof blockedStatuses)[number])
    ) {
      return c.json(
        {
          success: false,
          error: `存储源不可用：${sourceCheck.status}，请检查路径后重试`,
        },
        400,
      );
    }

    // 并发守护：检查是否有 active scan（排除 stale 超过阈值日寸）
    const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000).toISOString();

    const [activeScan] = await db
      .select({ id: schema.scanLogs.id })
      .from(schema.scanLogs)
      .where(
        and(
          eq(schema.scanLogs.storageSourceId, storageSourceId),
          isNull(schema.scanLogs.finishedAt),
          gt(schema.scanLogs.startedAt, staleCutoff),
        ),
      )
      .limit(1);

    if (activeScan) {
      return c.json(
        {
          success: false,
          error: "该存储源已有正在进行的扫描任务",
          data: { activeScanLogId: activeScan.id },
        },
        409,
      );
    }

    // 创建 scan_log（事务）
    const scanLogId = crypto.randomUUID();
    const now = new Date().toISOString();
    const skipAnalysis = parsed.data.skipAnalysis ?? false;
    const forceRegenerate = parsed.data.forceRegenerate ?? false;

    const job = await scanQueue.add(`scan:${storageSourceId}`, {
      storageSourceId,
      scanLogId,
      skipAnalysis,
      forceRegenerate,
    });

    // 入队成功后写入 scan_log
    await db.insert(schema.scanLogs).values({
      id: scanLogId,
      storageSourceId,
      jobId: job.id ?? null,
      scannedCount: 0,
      newCount: 0,
      errorCount: 0,
      startedAt: now,
      finishedAt: null,
    });

    return c.json({
      success: true,
      data: { jobId: job.id, scanLogId, storageSourceId },
    });
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");

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
  })
  /** GET /api/scan/:id/events — SSE 推送扫描进度 */
  .get("/:id/events", async (c) => {
    const scanLogId = c.req.param("id");

    return streamSSE(c, async (stream) => {
      const signal = c.req.raw.signal;
      let completed = false;

      const push = async () => {
        if (completed) return;

        try {
          // 读取 scan_log
          const [log] = await db
            .select()
            .from(schema.scanLogs)
            .where(eq(schema.scanLogs.id, scanLogId))
            .limit(1);

          if (!log) {
            await stream.writeSSE({
              data: JSON.stringify({ error: "扫描记录不存在" }),
              event: "error",
            });
            completed = true;
            return;
          }

          // 检测 stale（超过阈值且未完成）
          const staleCutoff = new Date(
            Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000,
          ).toISOString();

          if (!log.finishedAt && log.startedAt < staleCutoff) {
            const event: ScanProgressEvent = {
              scanLogId,
              status: "stale",
              phase: null,
              totalFiles: log.scannedCount,
              processed: log.scannedCount,
              newCount: log.newCount,
              updatedCount: 0,
              skippedCount: 0,
              errorCount: log.errorCount,
              regeneratedCount: 0,
              startedAt: log.startedAt,
              finishedAt: null,
            };
            await stream.writeSSE({
              data: JSON.stringify(event),
              event: "error",
            });
            completed = true;
            return;
          }

          // 读取 BullMQ job progress（如果有 jobId）
          let progress: Record<string, unknown> | null = null;
          if (log.jobId) {
            try {
              const job = await scanQueue.getJob(log.jobId);
              if (job) {
                const rawProgress = await job.progress;
                if (rawProgress && typeof rawProgress === "object") {
                  progress = rawProgress as Record<string, unknown>;
                }
              }
            } catch {
              // BullMQ 不可用，降级使用 scan_log 数据
            }
          }

          const isFinished = log.finishedAt != null;
          const status: ScanProgressEvent["status"] = isFinished
            ? log.newCount === 0 && log.errorCount > 0
              ? "failed"
              : "completed"
            : "running";

          const event: ScanProgressEvent = {
            scanLogId,
            status,
            phase: (progress?.phase as ScanProgressEvent["phase"]) ?? null,
            totalFiles: (progress?.totalFiles as number) ?? log.scannedCount,
            processed: (progress?.processed as number) ?? log.scannedCount,
            newCount: (progress?.newCount as number) ?? log.newCount,
            updatedCount: (progress?.updatedCount as number) ?? 0,
            skippedCount: (progress?.skippedCount as number) ?? 0,
            errorCount: (progress?.errorCount as number) ?? log.errorCount,
            regeneratedCount: (progress?.regeneratedCount as number) ?? 0,
            startedAt: log.startedAt,
            finishedAt: log.finishedAt,
          };

          await stream.writeSSE({
            data: JSON.stringify(event),
            event: "progress",
          });

          if (isFinished) {
            completed = true;
          }
        } catch (err) {
          await stream.writeSSE({
            data: JSON.stringify({
              error: err instanceof Error ? err.message : "推送进度失败",
            }),
            event: "error",
          });
        }
      };

      // 立即推送第一帧
      await push();

      // 每 1 秒推送（比队列 SSE 的 3s 更频繁）
      const interval = setInterval(() => {
        if (signal.aborted || completed) {
          clearInterval(interval);
          return;
        }
        push().catch(() => {
          clearInterval(interval);
        });
      }, 1000);

      const onAbort = () => {
        clearInterval(interval);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      // 保持连接活跃
      while (!signal.aborted && !completed) {
        await stream.sleep(1000);
      }

      clearInterval(interval);
    });
  });

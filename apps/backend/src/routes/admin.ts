import { count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";
import { analyzeQueue, dailyQueue, scanQueue } from "../jobs/queues";
import { config } from "../lib/config";

export const adminRouter = new Hono()
  /**
   * GET /api/admin/stats
   * 综合统计：照片总数、已分析数、均分、通过率（>=8）、存储源统计、最近分析
   */
  .get("/stats", async (c) => {
    try {
      // 照片总数
      const [photoCounts] = await db
        .select({ total: count() })
        .from(schema.photos);

      // 已分析数
      const [analyzedCounts] = await db
        .select({ total: count() })
        .from(schema.photoAnalyses);

      // 平均美学评分
      const [avgScore] = await db
        .select({ avg: sql<number>`AVG(${schema.photoAnalyses.aestheticScore})` })
        .from(schema.photoAnalyses);

      // 通过率（aestheticScore >= 8）
      const [passCount] = await db
        .select({ total: count() })
        .from(schema.photoAnalyses)
        .where(sql`${schema.photoAnalyses.aestheticScore} >= 8`);

      const analyzedTotal = analyzedCounts?.total ?? 0;
      const avgAestheticScore = avgScore?.avg != null ? Math.round(Number(avgScore.avg) * 100) / 100 : 0;
      const passRate = analyzedTotal > 0 ? Math.round((Number(passCount?.total ?? 0) / analyzedTotal) * 100) / 100 : 0;

      // 存储源统计
      const sources = await db
        .select({
          id: schema.storageSources.id,
          name: schema.storageSources.name,
          type: schema.storageSources.type,
          lastScanAt: schema.storageSources.lastScanAt,
        })
        .from(schema.storageSources);

      // 存储源统计 — 使用 GROUP BY 单次查询替代 N+1
      const photoCountsBySource = await db
        .select({
          storageSourceId: schema.photos.storageSourceId,
          total: count(),
        })
        .from(schema.photos)
        .groupBy(schema.photos.storageSourceId);

      const analyzedCountsBySource = await db
        .select({
          storageSourceId: schema.photos.storageSourceId,
          total: count(),
        })
        .from(schema.photoAnalyses)
        .innerJoin(schema.photos, eq(schema.photoAnalyses.photoId, schema.photos.id))
        .groupBy(schema.photos.storageSourceId);

      const photoCountMap = new Map(
        photoCountsBySource.map((r) => [r.storageSourceId, r.total]),
      );
      const analyzedCountMap = new Map(
        analyzedCountsBySource.map((r) => [r.storageSourceId, r.total]),
      );

      const storageSourcesStats = sources.map((source) => ({
        id: source.id,
        name: source.name,
        type: source.type,
        photoCount: photoCountMap.get(source.id) ?? 0,
        analyzedCount: analyzedCountMap.get(source.id) ?? 0,
        lastScanAt: source.lastScanAt,
      }));

      // 最近分析（最近 5 条）
      const recentAnalyses = await db
        .select({
          id: schema.photoAnalyses.id,
          filePath: schema.photos.filePath,
          aiModel: schema.photoAnalyses.aiModel,
          aestheticScore: schema.photoAnalyses.aestheticScore,
          narrative: schema.photoAnalyses.narrative,
          processedAt: schema.photoAnalyses.processedAt,
        })
        .from(schema.photoAnalyses)
        .innerJoin(schema.photos, eq(schema.photoAnalyses.photoId, schema.photos.id))
        .orderBy(desc(schema.photoAnalyses.processedAt))
        .limit(5);

      return c.json({
        success: true,
        data: {
          totalPhotos: photoCounts?.total ?? 0,
          analyzedPhotos: analyzedTotal,
          avgAestheticScore,
          passRate,
          storageSources: storageSourcesStats,
          recentAnalyses,
        },
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : "未知错误" },
        500,
      );
    }
  })
  /**
   * GET /api/admin/queues
   * 队列状态：scan-storage / analyze-photo / daily-selection 的 job 计数
   */
  .get("/queues", async (c) => {
    try {
      // 为 BullMQ getJobCounts 设置 5s 超时（Redis 可能不可用）
      const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
        Promise.race([
          promise,
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error("Redis 连接超时")), ms),
          ),
        ]);

      const [scanCounts, analyzeCounts, dailyCounts] = await Promise.all([
        withTimeout(scanQueue.getJobCounts(), 5000),
        withTimeout(analyzeQueue.getJobCounts(), 5000),
        withTimeout(dailyQueue.getJobCounts(), 5000),
      ]);

      return c.json({
        success: true,
        data: [
          { name: "scan-storage", counts: scanCounts },
          { name: "analyze-photo", counts: analyzeCounts },
          { name: "daily-selection", counts: dailyCounts },
        ],
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : "未知错误" },
        500,
      );
    }
  })
  /**
   * GET /api/admin/health
   * 健康检查：API 自身、DB ping、Redis ping、AI 配置（3s 超时）
   */
  .get("/health", async (c) => {
    const components: Array<{
      component: string;
      status: "healthy" | "degraded" | "unhealthy";
      message?: string;
    }> = [];

    // 1. API 自身健康（路由存在即 healthy）
    components.push({ component: "api", status: "healthy" });

    // 2. DB ping
    try {
      await db.select({ val: sql`1` }).from(sql`(SELECT 1)`);
      components.push({ component: "database", status: "healthy" });
    } catch {
      components.push({
        component: "database",
        status: "unhealthy",
        message: "数据库连接失败",
      });
    }

    // 3. Redis ping（通过 BullMQ queue 间接检查，5s 超时）
    try {
      const scanCounts = await Promise.race([
        scanQueue.getJobCounts(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Redis 连接超时")), 5000),
        ),
      ]);
      components.push({
        component: "redis",
        status: "healthy",
        message: `scan 队列: ${JSON.stringify(scanCounts)}`,
      });
    } catch {
      components.push({
        component: "redis",
        status: "unhealthy",
        message: "Redis 连接失败",
      });
    }

    // 4. AI 配置检查（3s 超时）
    const aiConfigured = config.ai.baseUrl && config.ai.apiKey && config.ai.model;
    if (!aiConfigured) {
      components.push({
        component: "ai",
        status: "degraded",
        message: "AI 配置不完整",
      });
    } else {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        // 用 fetch 快速 ping AI 服务（如果有 models 端点）
        const aiUrl = config.ai.baseUrl.replace(/\/+$/, "");
        const res = await fetch(`${aiUrl}/models`, {
          headers: { Authorization: `Bearer ${config.ai.apiKey}` },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          components.push({ component: "ai", status: "healthy" });
        } else {
          components.push({
            component: "ai",
            status: "degraded",
            message: `AI 服务返回 ${res.status}`,
          });
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          components.push({
            component: "ai",
            status: "degraded",
            message: "AI 服务连接超时（>3s）",
          });
        } else {
          components.push({
            component: "ai",
            status: "degraded",
            message: error instanceof Error ? error.message : "AI 服务不可达",
          });
        }
      }
    }

    const overall = components.some((c) => c.status === "unhealthy")
      ? "unhealthy"
      : components.some((c) => c.status === "degraded")
        ? "degraded"
        : "healthy";

    return c.json({
      success: true,
      data: { overall, components },
    }, overall === "unhealthy" ? 503 : 200);
  })
  /**
   * GET /api/admin/photos
   * 分页照片分析列表，支持 sortBy "aestheticScore" | "processedAt"
   */
  .get("/photos", async (c) => {
    try {
      const page = Number(c.req.query("page")) || 1;
      const pageSize = Math.min(Number(c.req.query("pageSize")) || 20, 100);
      const sortBy = c.req.query("sortBy") === "aestheticScore" ? "aestheticScore" : "processedAt";

      const offset = (page - 1) * pageSize;

      // 总数
      const [countResult] = await db
        .select({ total: count() })
        .from(schema.photoAnalyses);

      const total = countResult?.total ?? 0;

      // 分页数据
      const rows = await db
        .select({
          id: schema.photoAnalyses.id,
          filePath: schema.photos.filePath,
          aiModel: schema.photoAnalyses.aiModel,
          aestheticScore: schema.photoAnalyses.aestheticScore,
          narrative: schema.photoAnalyses.narrative,
          processedAt: schema.photoAnalyses.processedAt,
        })
        .from(schema.photoAnalyses)
        .innerJoin(schema.photos, eq(schema.photoAnalyses.photoId, schema.photos.id))
        .orderBy(
          sortBy === "aestheticScore"
            ? desc(schema.photoAnalyses.aestheticScore)
            : desc(schema.photoAnalyses.processedAt),
        )
        .limit(pageSize)
        .offset(offset);

      return c.json({
        success: true,
        data: {
          data: rows,
          total,
          page,
          pageSize,
        },
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : "未知错误" },
        500,
      );
    }
  });

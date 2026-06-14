import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";
import { PLUGINS } from "../plugins/registry";

export const pluginsRouter = new Hono()
  // GET /api/plugins — 插件列表
  .get("/", (c) => {
    const plugins = PLUGINS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      icon: p.icon,
      params: p.params,
    }));
    return c.json({ success: true, data: plugins });
  })
  // GET /api/plugins/:id — 插件详情 + 最近任务
  .get("/:id", async (c) => {
    const plugin = PLUGINS.find((p) => p.id === c.req.param("id"));
    if (!plugin) return c.json({ success: false, error: "插件不存在" }, 404);

    const recentTasks = await db
      .select()
      .from(schema.pluginTasks)
      .where(eq(schema.pluginTasks.pluginId, plugin.id))
      .orderBy(desc(schema.pluginTasks.createdAt))
      .limit(10);

    return c.json({
      success: true,
      data: {
        plugin: {
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          icon: plugin.icon,
          params: plugin.params,
        },
        recentTasks,
      },
    });
  })
  // GET /api/plugins/:id/tasks — 任务列表（分页）
  .get("/:id/tasks", async (c) => {
    const pluginId = c.req.param("id");
    const page = Number(c.req.query("page") ?? 1);
    const pageSize = Number(c.req.query("pageSize") ?? 10);

    const tasks = await db
      .select()
      .from(schema.pluginTasks)
      .where(eq(schema.pluginTasks.pluginId, pluginId))
      .orderBy(desc(schema.pluginTasks.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return c.json({ success: true, data: { tasks } });
  })
  // GET /api/plugins/:id/tasks/:taskId — 单任务详情
  .get("/:id/tasks/:taskId", async (c) => {
    const [task] = await db
      .select()
      .from(schema.pluginTasks)
      .where(
        and(
          eq(schema.pluginTasks.id, c.req.param("taskId")),
          eq(schema.pluginTasks.pluginId, c.req.param("id")),
        ),
      )
      .limit(1);

    if (!task) return c.json({ success: false, error: "任务不存在" }, 404);
    return c.json({ success: true, data: task });
  })
  // GET /api/plugins/:id/tasks/:taskId/photos/:index — 服务单张照片文件
  .get("/:id/tasks/:taskId/photos/:index", async (c) => {
    const [task] = await db
      .select()
      .from(schema.pluginTasks)
      .where(
        and(
          eq(schema.pluginTasks.id, c.req.param("taskId")),
          eq(schema.pluginTasks.pluginId, c.req.param("id")),
        ),
      )
      .limit(1);

    if (!task?.result) return c.json({ success: false, error: "任务或结果不存在" }, 404);

    try {
      const result = JSON.parse(task.result);
      const idx = Number(c.req.param("index"));
      const photo = result.photos?.[idx];
      if (!photo?.outputPath) return c.json({ success: false, error: "照片不存在" }, 404);

      const { readFile, access } = await import("node:fs/promises");
      try {
        await access(photo.outputPath);
      } catch {
        return c.json({ success: false, error: "文件不存在" }, 404);
      }
      const buf = await readFile(photo.outputPath);
      return new Response(buf, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" },
      });
    } catch {
      return c.json({ success: false, error: "读取照片失败" }, 500);
    }
  })
  // GET /api/plugins/:id/tasks/:taskId/photos — 任务关联的照片列表
  .get("/:id/tasks/:taskId/photos", async (c) => {
    const [task] = await db
      .select()
      .from(schema.pluginTasks)
      .where(
        and(
          eq(schema.pluginTasks.id, c.req.param("taskId")),
          eq(schema.pluginTasks.pluginId, c.req.param("id")),
        ),
      )
      .limit(1);

    if (!task) return c.json({ success: false, error: "任务不存在" }, 404);
    if (!task.result) return c.json({ success: true, data: { photos: [], stats: null } });

    let parsed: {
      stats?: {
        totalInWindow: number;
        clustersFound: number;
        selected: number;
        copied: number;
        failed: number;
      };
      timeWindow?: { start: string; end: string };
      clusters?: Array<{
        id: number;
        timeRange: { start: string; end: string };
        gpsCenter: { lat: number; lng: number } | null;
        isSelected: boolean;
        stats: { total: number; withFoodTags: number; withGps: number; screenshots: number };
      }>;
      selectedCluster?: number | null;
      photos?: Array<{
        path: string;
        outputPath: string;
        takenAt: string;
        tags: string[];
        inCluster: number;
      }>;
    };
    try {
      parsed = JSON.parse(task.result);
    } catch {
      return c.json({ success: false, error: "任务结果解析失败" }, 500);
    }

    const resultPhotos = parsed.photos ?? [];

    if (resultPhotos.length === 0) {
      return c.json({
        success: true,
        data: { photos: [], stats: parsed.stats ?? null, timeWindow: parsed.timeWindow ?? null },
      });
    }

    // Resolve file paths to photo IDs
    const filePaths = resultPhotos.map((p) => p.path);
    const dbPhotos = await db
      .select({
        id: schema.photos.id,
        filePath: schema.photos.filePath,
        thumbnailPath: schema.photos.thumbnailPath,
        width: schema.photos.width,
        height: schema.photos.height,
      })
      .from(schema.photos)
      .where(inArray(schema.photos.filePath, filePaths));

    const pathToPhoto = new Map(dbPhotos.map((p) => [p.filePath, p]));

    const photos = resultPhotos.map((rp) => {
      const dbPhoto = pathToPhoto.get(rp.path);
      return {
        ...rp,
        photoId: dbPhoto?.id ?? null,
        thumbnailPath: dbPhoto?.thumbnailPath ?? null,
        width: dbPhoto?.width ?? 0,
        height: dbPhoto?.height ?? 0,
      };
    });

    return c.json({
      success: true,
      data: {
        photos,
        stats: parsed.stats ?? null,
        timeWindow: parsed.timeWindow ?? null,
        clusters: parsed.clusters ?? null,
        selectedCluster: parsed.selectedCluster ?? null,
      },
    });
  })
  // POST /api/plugins/:id/run — 触发运行
  .post("/:id/run", async (c) => {
    const plugin = PLUGINS.find((p) => p.id === c.req.param("id"));
    if (!plugin) return c.json({ success: false, error: "插件不存在" }, 404);

    const body = await c.req.json().catch(() => ({}));
    // 验证必填参数
    const requiredParams = plugin.params.filter((p) => p.required).map((p) => p.key);
    for (const key of requiredParams) {
      if (!body[key]) {
        return c.json({ success: false, error: `缺少必填参数: ${key}` }, 400);
      }
    }
    const taskId = crypto.randomUUID();

    await db.insert(schema.pluginTasks).values({
      id: taskId,
      pluginId: plugin.id,
      status: "running",
      params: JSON.stringify(body),
      startedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    // 异步运行（不阻塞响应）
    plugin
      .run(body)
      .then(async (result) => {
        await db
          .update(schema.pluginTasks)
          .set({
            status: "done",
            result: JSON.stringify(result),
            finishedAt: new Date().toISOString(),
          })
          .where(eq(schema.pluginTasks.id, taskId));
      })
      .catch(async (err) => {
        await db
          .update(schema.pluginTasks)
          .set({
            status: "failed",
            error: String(err),
            finishedAt: new Date().toISOString(),
          })
          .where(eq(schema.pluginTasks.id, taskId));
      });

    return c.json({ success: true, data: { taskId } });
  });

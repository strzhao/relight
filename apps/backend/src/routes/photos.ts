import fs from "node:fs/promises";
import path from "node:path";
import { analyzePhotosSchema, photoQuerySchema } from "@relight/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";
import { analyzeQueue } from "../jobs/queues";
import { convertHeicToJpeg, isHeicFile } from "../lib/heic";
import { createStorageAdapter } from "../storage";

export const photosRouter = new Hono()
  /** 照片列表（分页 + 过滤 + 排序） */
  .get("/", async (c) => {
    const query = c.req.query();
    const parsed = photoQuerySchema.safeParse(query);

    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.message }, 400);
    }

    const { page, pageSize, tagId, storageSourceId, sortBy, order, dateFrom, dateTo } = parsed.data;

    // 构建 WHERE 条件
    const conditions = [];

    if (storageSourceId) {
      conditions.push(eq(schema.photos.storageSourceId, storageSourceId));
    }

    if (tagId) {
      // 过滤有指定标签的照片
      conditions.push(
        sql`${schema.photos.id} IN (
          SELECT ${schema.photoTags.photoId}
          FROM ${schema.photoTags}
          WHERE ${eq(schema.photoTags.tagId, tagId)}
        )`,
      );
    }

    // 使用 COALESCE(takenAt, createdAt) 作为有效日期列
    const effectiveDate = sql`COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})`;

    if (dateFrom) {
      conditions.push(sql`date(${effectiveDate}) >= ${dateFrom}`);
    }

    if (dateTo) {
      conditions.push(sql`date(${effectiveDate}) <= ${dateTo}`);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // 排序
    const sortColumn =
      sortBy === "takenAt"
        ? effectiveDate
        : sortBy === "fileSize"
          ? schema.photos.fileSize
          : schema.photos.createdAt;

    const orderBy = order === "asc" ? asc(sortColumn) : desc(sortColumn);

    // 查询总数
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.photos)
      .where(where);

    const total = countResult[0]?.count ?? 0;

    // 查询分页数据
    const offset = (page - 1) * pageSize;
    const photos = await db
      .select()
      .from(schema.photos)
      .where(where)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset);

    return c.json({
      success: true,
      data: photos,
      total,
      page,
      pageSize,
    });
  })

  /** 照片详情（JOIN 关联信息） */
  .get("/:id", async (c) => {
    const id = c.req.param("id");

    // 查询照片基本信息
    const photos = await db.select().from(schema.photos).where(eq(schema.photos.id, id));

    const photo = photos[0];
    if (!photo) {
      return c.json({ success: false, error: "照片不存在" }, 404);
    }

    // 查询关联的标签
    const photoTagRows = await db
      .select({
        photoId: schema.photoTags.photoId,
        tagId: schema.photoTags.tagId,
        confidence: schema.photoTags.confidence,
        tagName: schema.tags.name,
        tagCategory: schema.tags.category,
      })
      .from(schema.photoTags)
      .innerJoin(schema.tags, eq(schema.photoTags.tagId, schema.tags.id))
      .where(eq(schema.photoTags.photoId, id));

    // 查询分析记录
    const analyses = await db
      .select()
      .from(schema.photoAnalyses)
      .where(eq(schema.photoAnalyses.photoId, id));

    // 查询存储源
    const sources = await db
      .select()
      .from(schema.storageSources)
      .where(eq(schema.storageSources.id, photo.storageSourceId));

    return c.json({
      success: true,
      data: {
        ...photo,
        tags: photoTagRows,
        analyses,
        storageSource: sources[0] ?? null,
      },
    });
  })

  /** 缩略图 */
  .get("/:id/thumbnail", async (c) => {
    const id = c.req.param("id");

    // 查询照片的缩略图路径
    const photos = await db
      .select({ thumbnailPath: schema.photos.thumbnailPath })
      .from(schema.photos)
      .where(eq(schema.photos.id, id));

    const photo = photos[0];

    if (!photo?.thumbnailPath) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
        <rect fill="#f3f4f6" width="200" height="200"/>
        <text fill="#9ca3af" font-family="system-ui" font-size="14" text-anchor="middle" x="100" y="104">无缩略图</text>
      </svg>`;
      return c.body(svg, 200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      });
    }

    try {
      const stat = await fs.stat(photo.thumbnailPath);
      const buffer = await fs.readFile(photo.thumbnailPath);
      const etag = `"${stat.mtimeMs.toFixed(0)}"`;
      return c.body(buffer, 200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600",
        ETag: etag,
      });
    } catch {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
        <rect fill="#fef2f2" width="200" height="200"/>
        <text fill="#ef4444" font-family="system-ui" font-size="14" text-anchor="middle" x="100" y="104">缩略图缺失</text>
      </svg>`;
      return c.body(svg, 200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      });
    }
  })

  /** 原始文件 */
  .get("/:id/original", async (c) => {
    const id = c.req.param("id");

    // 查询照片基本信息 + 关联的存储源
    const photos = await db
      .select({
        filePath: schema.photos.filePath,
        fileName: schema.photos.filePath,
        storageSourceId: schema.photos.storageSourceId,
        rootPath: schema.storageSources.rootPath,
        storageType: schema.storageSources.type,
      })
      .from(schema.photos)
      .innerJoin(schema.storageSources, eq(schema.photos.storageSourceId, schema.storageSources.id))
      .where(eq(schema.photos.id, id));

    const photo = photos[0];
    if (!photo) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
        <rect fill="#fef2f2" width="200" height="200"/>
        <text fill="#ef4444" font-family="system-ui" font-size="14" text-anchor="middle" x="100" y="104">照片不存在</text>
      </svg>`;
      return c.body(svg, 200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      });
    }

    const fullPath = path.resolve(photo.rootPath, photo.filePath);

    // 检查文件是否存在
    try {
      await fs.access(fullPath);
    } catch {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
        <rect fill="#fef2f2" width="200" height="200"/>
        <text fill="#ef4444" font-family="system-ui" font-size="14" text-anchor="middle" x="100" y="104">文件不存在</text>
      </svg>`;
      return c.body(svg, 200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      });
    }

    try {
      const adapter = createStorageAdapter(photo.storageType);
      let buffer = await adapter.getFileBuffer(fullPath);
      let contentType = adapter.getMimeType(fullPath);
      const etagBase = `${photo.filePath}`;

      // HEIC 转码为 JPEG
      if (isHeicFile(fullPath)) {
        buffer = await convertHeicToJpeg(buffer);
        contentType = "image/jpeg";
      }

      return c.body(buffer, 200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
        ETag: `"${Buffer.from(etagBase).toString("base64").slice(0, 32)}"`,
      });
    } catch {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
        <rect fill="#fef2f2" width="200" height="200"/>
        <text fill="#ef4444" font-family="system-ui" font-size="14" text-anchor="middle" x="100" y="104">读取失败</text>
      </svg>`;
      return c.body(svg, 200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      });
    }
  })

  /** 批量触发 AI 分析 */
  .post("/analyze", async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "请求体不能为空" }, 400);
    }

    const parsed = analyzePhotosSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.message }, 400);
    }

    const { photoIds, force } = parsed.data;

    // 验证照片存在
    const existingPhotos = await db
      .select({ id: schema.photos.id })
      .from(schema.photos)
      .where(inArray(schema.photos.id, photoIds));

    const existingIds = new Set(existingPhotos.map((p) => p.id));
    const validIds = photoIds.filter((id) => existingIds.has(id));

    if (validIds.length === 0) {
      return c.json({ success: false, error: "所有照片都不存在" }, 400);
    }

    // 过滤已分析的照片（force=true 时跳过过滤）
    let toAnalyze = validIds;

    if (!force) {
      const analyzed = await db
        .select({ photoId: schema.photoAnalyses.photoId })
        .from(schema.photoAnalyses)
        .where(inArray(schema.photoAnalyses.photoId, validIds));

      const analyzedIds = new Set(analyzed.map((a) => a.photoId));
      toAnalyze = validIds.filter((id) => !analyzedIds.has(id));
    }

    const skippedCount = validIds.length - toAnalyze.length;

    const jobs = toAnalyze.map((photoId) => analyzeQueue.add(`analyze:${photoId}`, { photoId }));
    await Promise.all(jobs);

    return c.json({
      success: true,
      data: { enqueued: toAnalyze.length, skippedCount },
    });
  });

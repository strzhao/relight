import fs from "node:fs/promises";
import { photoQuerySchema } from "@relight/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";

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
      return c.text("No thumbnail available", 404);
    }

    try {
      const buffer = await fs.readFile(photo.thumbnailPath);
      return c.body(buffer, 200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      });
    } catch {
      return c.text("Thumbnail file not found", 404);
    }
  });

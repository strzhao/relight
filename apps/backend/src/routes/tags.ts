import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";

export const tagsRouter = new Hono()
  /** 标签列表（含照片计数） */
  .get("/", async (c) => {
    // 查询标签及其关联的照片数量
    const rows = await db
      .select({
        id: schema.tags.id,
        name: schema.tags.name,
        category: schema.tags.category,
        createdAt: schema.tags.createdAt,
        photoCount: sql<number>`COUNT(${schema.photoTags.photoId})`,
      })
      .from(schema.tags)
      .leftJoin(schema.photoTags, sql`${schema.tags.id} = ${schema.photoTags.tagId}`)
      .groupBy(schema.tags.id)
      .orderBy(sql`photoCount DESC`);

    return c.json({
      success: true,
      data: rows,
    });
  });

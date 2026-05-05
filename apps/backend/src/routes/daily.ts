import { desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";

export const dailyRouter = new Hono()
  /**
   * 今日精选
   * GET /api/daily/today
   */
  .get("/today", async (c) => {
    // 生成北京时间 YYYY-MM-DD 格式的日期字符串
    const now = new Date();
    const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const pickDate = `${shanghai.getFullYear()}-${String(shanghai.getMonth() + 1).padStart(2, "0")}-${String(shanghai.getDate()).padStart(2, "0")}`;

    const rows = await db
      .select()
      .from(schema.dailyPicks)
      .where(eq(schema.dailyPicks.pickDate, pickDate))
      .limit(1);

    const pick = rows[0];

    if (!pick) {
      return c.json({ success: true, data: null });
    }

    // 关联查询照片信息
    const photos = await db.select().from(schema.photos).where(eq(schema.photos.id, pick.photoId));

    const photo = photos[0] ?? null;

    return c.json({
      success: true,
      data: {
        ...pick,
        photo,
      },
    });
  })

  /**
   * 每日精选列表（分页）
   * GET /api/daily?page=1&pageSize=20
   */
  .get("/", async (c) => {
    const query = c.req.query();
    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize ?? "20", 10) || 20));
    const offset = (page - 1) * pageSize;

    // 查询总数
    const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.dailyPicks);

    const total = countResult[0]?.count ?? 0;

    // 查询分页数据
    const picks = await db
      .select()
      .from(schema.dailyPicks)
      .orderBy(desc(schema.dailyPicks.pickDate))
      .limit(pageSize)
      .offset(offset);

    // 批量关联查询照片
    const photoIds = picks.map((p) => p.photoId);
    const photoMap = new Map<string, typeof schema.photos.$inferSelect>();

    if (photoIds.length > 0) {
      const photoRows = await db
        .select()
        .from(schema.photos)
        .where(inArray(schema.photos.id, photoIds));

      for (const photo of photoRows) {
        photoMap.set(photo.id, photo);
      }
    }

    const data = picks.map((pick) => ({
      ...pick,
      photo: photoMap.get(pick.photoId) ?? null,
    }));

    return c.json({
      success: true,
      data,
      total,
      page,
      pageSize,
    });
  })

  /**
   * 每日精选详情
   * GET /api/daily/:id
   */
  .get("/:id", async (c) => {
    const id = c.req.param("id");

    const rows = await db.select().from(schema.dailyPicks).where(eq(schema.dailyPicks.id, id));

    const pick = rows[0];

    if (!pick) {
      return c.json({ success: false, error: "精选记录不存在" }, 404);
    }

    // 关联查询照片
    const photos = await db.select().from(schema.photos).where(eq(schema.photos.id, pick.photoId));

    const photo = photos[0] ?? null;

    return c.json({
      success: true,
      data: {
        ...pick,
        photo,
      },
    });
  });

import { desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";

type PhotoRow = typeof schema.photos.$inferSelect;

/**
 * 将 dailyPick 的 members JSON 解析并填充 photo 详情
 * - NULL members → 归一化为 []
 * - 批量 JOIN photos 表
 * - 过滤游离 photoId（photo 已删除）
 */
async function enrichMembers(
  memberIds: { photoId: string; caption: string }[],
): Promise<{ photoId: string; caption: string; photo: PhotoRow }[]> {
  if (memberIds.length === 0) return [];

  const ids = memberIds.map((m) => m.photoId);
  const photoRows = await db.select().from(schema.photos).where(inArray(schema.photos.id, ids));

  const photoMap = new Map<string, PhotoRow>();
  for (const p of photoRows) {
    photoMap.set(p.id, p);
  }

  return memberIds
    .map((m) => {
      const photo = photoMap.get(m.photoId);
      if (!photo) return null; // 游离 photoId，过滤掉
      return { photoId: m.photoId, caption: m.caption, photo };
    })
    .filter((item): item is { photoId: string; caption: string; photo: PhotoRow } => item !== null);
}

/**
 * 从 DB 行中安全解析 members（NULL 兜底为 []）
 */
function parseMembers(raw: unknown): { photoId: string; caption: string }[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as { photoId: string; caption: string }[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}

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

    // 填充 members
    const rawMembers = parseMembers(pick.members);
    const members = await enrichMembers(rawMembers);

    return c.json({
      success: true,
      data: {
        ...pick,
        members,
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

    // 批量关联查询 hero 照片
    const heroPhotoIds = picks.map((p) => p.photoId);
    const heroPhotoMap = new Map<string, PhotoRow>();

    if (heroPhotoIds.length > 0) {
      const heroPhotoRows = await db
        .select()
        .from(schema.photos)
        .where(inArray(schema.photos.id, heroPhotoIds));

      for (const photo of heroPhotoRows) {
        heroPhotoMap.set(photo.id, photo);
      }
    }

    // 填充每个 pick 的 members
    const data = await Promise.all(
      picks.map(async (pick) => {
        const rawMembers = parseMembers(pick.members);
        const members = await enrichMembers(rawMembers);
        return {
          ...pick,
          members,
          photo: heroPhotoMap.get(pick.photoId) ?? null,
        };
      }),
    );

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

    // 填充 members
    const rawMembers = parseMembers(pick.members);
    const members = await enrichMembers(rawMembers);

    return c.json({
      success: true,
      data: {
        ...pick,
        members,
        photo,
      },
    });
  });

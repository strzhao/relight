import crypto from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";

/** 模块级互斥锁：防止并发重复合成同一 (pickDate_WxH) */
const composingMap = new Map<string, Promise<string>>();

/** 将 composedImagePath 转换为 API URL */
function toComposedImageUrl(
  pickDate: string,
  composedImagePath: string | null | undefined,
): string | null {
  if (!composedImagePath) return null;
  return `/api/daily/${pickDate}/wallpaper`;
}

export const dailyRouter = new Hono()
  /**
   * 今日精选
   * GET /api/daily/today
   */
  .get("/today", async (c) => {
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

    const photos = await db.select().from(schema.photos).where(eq(schema.photos.id, pick.photoId));
    const photo = photos[0] ?? null;

    return c.json({
      success: true,
      data: {
        ...pick,
        composedImageUrl: toComposedImageUrl(pick.pickDate, pick.composedImagePath),
        photo,
      },
    });
  })

  /**
   * 按日期合成壁纸图（实时合成 + 磁盘缓存）
   * GET /api/daily/:pickDate/wallpaper?width=W&height=H
   *
   * 注意：此路由必须在 /:id 前注册，避免路由歧义
   */
  .get("/:pickDate/wallpaper", async (c) => {
    const pickDate = c.req.param("pickDate");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickDate)) {
      return c.json({ success: false, error: "pickDate 格式错误，应为 YYYY-MM-DD" }, 400);
    }

    const query = c.req.query();
    const widthStr = query.width;
    const heightStr = query.height;

    let width: number;
    let height: number;

    if (!widthStr && !heightStr) {
      width = 5120;
      height = 2880;
    } else if (!widthStr || !heightStr) {
      return c.json({ success: false, error: "width 和 height 必须同时提供" }, 400);
    } else {
      width = Number.parseInt(widthStr, 10);
      height = Number.parseInt(heightStr, 10);
      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width < 1 ||
        width > 8192 ||
        height < 1 ||
        height > 8192
      ) {
        return c.json({ success: false, error: "width/height 必须在 1-8192 范围内" }, 400);
      }
    }

    const rows = await db
      .select()
      .from(schema.dailyPicks)
      .where(eq(schema.dailyPicks.pickDate, pickDate))
      .limit(1);

    const pick = rows[0];
    if (!pick) {
      return c.json({ success: false, error: "精选记录不存在" }, 404);
    }

    const photoRows = await db
      .select()
      .from(schema.photos)
      .where(eq(schema.photos.id, pick.photoId));
    const photo = photoRows[0];
    if (!photo) {
      return c.json({ success: false, error: "照片不存在" }, 404);
    }

    const { composedCachePath } = await import("../lib/wallpaper/composer");
    const cacheFilePath = widthStr
      ? composedCachePath(pickDate, width, height)
      : (pick.composedImagePath ?? composedCachePath(pickDate, width, height));

    const sendFile = async (filePath: string) => {
      const buf = await readFile(filePath);
      const etag = `"${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)}"`;

      const ifNoneMatch = c.req.header("if-none-match");
      if (ifNoneMatch === etag) {
        return c.newResponse(null, 304);
      }

      return c.newResponse(buf, 200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400, immutable",
        ETag: etag,
      });
    };

    try {
      await access(cacheFilePath);
      return sendFile(cacheFilePath);
    } catch {
      // 缓存未命中，触发合成
    }

    const lockKey = widthStr ? `${pickDate}_${width}x${height}` : `${pickDate}_default`;

    let composePromise = composingMap.get(lockKey);
    if (!composePromise) {
      composePromise = (async () => {
        try {
          const { composeAndSave, composedCachePath: cachePath } = await import(
            "../lib/wallpaper/composer"
          );

          const cacheKey = widthStr ? `${width}x${height}` : "default";
          const outPath = await composeAndSave({
            pick: { ...pick, composedImageUrl: null },
            photo,
            width,
            height,
            cacheKey,
          });
          return outPath;
        } finally {
          composingMap.delete(lockKey);
        }
      })();
      composingMap.set(lockKey, composePromise);
    }

    try {
      const outPath = await composePromise;
      return sendFile(outPath);
    } catch (err) {
      console.warn(
        `[daily/wallpaper] 合成壁纸失败 ${pickDate} ${width}x${height}: ${(err as Error).message}`,
      );
      return c.redirect(`/api/photos/${photo.id}/original`, 302);
    }
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

    const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.dailyPicks);
    const total = countResult[0]?.count ?? 0;

    const picks = await db
      .select()
      .from(schema.dailyPicks)
      .orderBy(desc(schema.dailyPicks.pickDate))
      .limit(pageSize)
      .offset(offset);

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
      composedImageUrl: toComposedImageUrl(pick.pickDate, pick.composedImagePath),
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

    const photos = await db.select().from(schema.photos).where(eq(schema.photos.id, pick.photoId));
    const photo = photos[0] ?? null;

    return c.json({
      success: true,
      data: {
        ...pick,
        composedImageUrl: toComposedImageUrl(pick.pickDate, pick.composedImagePath),
        photo,
      },
    });
  });

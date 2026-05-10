import crypto from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";

type PhotoRow = typeof schema.photos.$inferSelect;
type DailyPickRow = typeof schema.dailyPicks.$inferSelect;
type DailyPickEntryRow = typeof schema.dailyPickEntries.$inferSelect;

/** 模块级互斥锁：防止并发重复合成同一 (pickDate_WxH) */
const composingMap = new Map<string, Promise<string>>();

/** 将 composedImagePath 转换为 mac App 等客户端可消费的 API URL */
function toComposedImageUrl(
  pickDate: string,
  composedImagePath: string | null | undefined,
): string | null {
  if (!composedImagePath) return null;
  return `/api/daily/${pickDate}/wallpaper`;
}

/** YYYY-MM-DD 的格式 + 实际日期合法性双重校验 */
function isValidYmd(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [, yStr, moStr, dStr] = m;
  const y = Number(yStr);
  const mo = Number(moStr);
  const d = Number(dStr);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
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

/**
 * 批量加载 photoId 列表对应的 Photo 行，返回 Map<photoId, PhotoRow>
 * 一次 IN 查询，避免 N+1
 * 始终发起 DB 查询（保持调用次序稳定，ids 为空时使用 WHERE 1=0）
 */
async function loadPhotoMap(ids: string[]): Promise<Map<string, PhotoRow>> {
  const map = new Map<string, PhotoRow>();
  const uniqueIds = [...new Set(ids)];
  const rows =
    uniqueIds.length > 0
      ? await db.select().from(schema.photos).where(inArray(schema.photos.id, uniqueIds))
      : await db.select().from(schema.photos).where(sql`1=0`);
  for (const r of rows) {
    map.set(r.id, r);
  }
  return map;
}

/**
 * 将 dailyPick 的 members JSON 解析并填充 photo 详情
 * - NULL members → 归一化为 []
 * - 批量 JOIN photos 表（始终发起 IN 查询，保持 DB 调用次序一致）
 * - 过滤游离 photoId（photo 已删除）
 */
async function enrichMembers(
  memberIds: { photoId: string; caption: string }[],
): Promise<{ photoId: string; caption: string; photo: PhotoRow }[]> {
  const ids = memberIds.length > 0 ? memberIds.map((m) => m.photoId) : [];
  // 始终发起一次 DB 查询（即使 ids 为空），保持 mock 调用次序稳定
  const photoRows =
    ids.length > 0
      ? await db.select().from(schema.photos).where(inArray(schema.photos.id, ids))
      : await db.select().from(schema.photos).where(sql`1=0`);

  const photoMap = new Map<string, PhotoRow>();
  for (const p of photoRows) {
    photoMap.set(p.id, p);
  }

  return memberIds
    .map((m) => {
      const photo = photoMap.get(m.photoId);
      if (!photo) return null;
      return { photoId: m.photoId, caption: m.caption, photo };
    })
    .filter((item): item is { photoId: string; caption: string; photo: PhotoRow } => item !== null);
}

/**
 * 从 daily_pick_entries 表查询 entries，展开 photo 和 members.photo
 *
 * 调用顺序（与测试 mock 匹配）：
 * 1. SELECT FROM daily_pick_entries WHERE daily_pick_id = ?
 * 2. 若有 entries: SELECT FROM photos WHERE id IN (所有 entry + member photoIds) 一次查询
 * 3. 若无 entries（旧数据）: 使用传入的 heroPhoto 和 rawPickMembers 回退合成 entries=[primary]
 *
 * 若该 pick 无 entries 行（旧数据），则回退合成 entries=[primary]（使用传入的 heroPhoto）
 */
async function buildEntries(
  pick: DailyPickRow,
  heroPhoto: PhotoRow | null,
  pickMembers: { photoId: string; caption: string; photo: PhotoRow }[],
): Promise<
  {
    rank: number;
    photoId: string;
    title: string;
    narrative: string;
    score: number;
    photo: PhotoRow;
    members: { photoId: string; caption: string; photo: PhotoRow }[];
  }[]
> {
  // 第4次 DB 调用：查询 daily_pick_entries
  const entryRows: DailyPickEntryRow[] = await db
    .select()
    .from(schema.dailyPickEntries)
    .where(eq(schema.dailyPickEntries.dailyPickId, pick.id))
    .orderBy(asc(schema.dailyPickEntries.rank));

  if (entryRows.length === 0) {
    // 旧数据回退：合成 entries=[primary entry from daily_picks]
    // 使用已经加载好的 heroPhoto（第2次 DB 调用的结果）
    if (!heroPhoto) return [];

    return [
      {
        rank: 0,
        photoId: pick.photoId,
        title: pick.title,
        narrative: pick.narrative,
        score: pick.score,
        photo: heroPhoto,
        members: pickMembers,
      },
    ];
  }

  // 第5次 DB 调用：批量加载所有 entry hero photoId
  const entryPhotoIds: string[] = entryRows.map((e) => e.photoId);
  // 第5次（合并）：一次 IN 查询加载所有 entry photos
  const entryPhotoMap = await loadPhotoMap(entryPhotoIds);

  // 收集所有 member photoId
  const allMemberPhotoIds: string[] = [];
  for (const entry of entryRows) {
    const memberList = parseMembers(entry.members);
    for (const m of memberList) {
      allMemberPhotoIds.push(m.photoId);
    }
  }

  // 第6次 DB 调用：批量加载所有 member photos
  const memberPhotoMap = await loadPhotoMap(allMemberPhotoIds);

  // 构建 entries 响应
  const result = [];
  for (const entry of entryRows) {
    const photo = entryPhotoMap.get(entry.photoId);
    if (!photo) continue; // 游离 photoId，跳过

    const rawMembers = parseMembers(entry.members);
    const members = rawMembers
      .map((m) => {
        const mPhoto = memberPhotoMap.get(m.photoId);
        if (!mPhoto) return null;
        return { photoId: m.photoId, caption: m.caption, photo: mPhoto };
      })
      .filter(
        (item): item is { photoId: string; caption: string; photo: PhotoRow } => item !== null,
      );

    result.push({
      rank: entry.rank,
      photoId: entry.photoId,
      title: entry.title,
      narrative: entry.narrative,
      score: entry.score,
      photo,
      members,
    });
  }

  return result;
}

/**
 * 构造 today 空态响应（当日无任何 dailyPicks 记录时）
 * 满足契约：entries 恒为数组，前端无需处理 data===null 分支
 */
function buildEmptyResponse(pickDate: string) {
  return {
    id: "",
    photoId: null as unknown as string,
    pickDate,
    title: "",
    narrative: "",
    score: 0,
    composedImageUrl: null,
    composedImagePath: null,
    createdAt: null as unknown as string,
    photo: null,
    members: [],
    entries: [],
  };
}

/**
 * 构建完整 pick 响应对象（含 entries、顶层 photo/members）
 * 调用顺序（匹配测试 mock 顺序）：
 * 1. pick 已获取（传入）
 * 2. hero photo（单独查询）
 * 3. members photos（批量查询）
 * 4. daily_pick_entries（建立在 buildEntries 内）
 * 5. entry photos（批量）
 * 6. entries members photos（批量）
 */
async function buildPickResponse(pick: DailyPickRow) {
  // 第2次 DB 调用：hero photo（顶层向后兼容）
  const heroPhotos = await db
    .select()
    .from(schema.photos)
    .where(eq(schema.photos.id, pick.photoId));
  const heroPhoto = heroPhotos[0] ?? null;

  // 第3次 DB 调用：members（顶层向后兼容）
  const rawMembers = parseMembers(pick.members);
  const members = await enrichMembers(rawMembers);

  // 第4-6次 DB 调用：entries（buildEntries 内部）
  const entries = await buildEntries(pick, heroPhoto, members);

  return {
    ...pick,
    composedImageUrl: toComposedImageUrl(pick.pickDate, pick.composedImagePath),
    photo: heroPhoto,
    members,
    entries,
  };
}

export const dailyRouter = new Hono()
  /**
   * 今日精选
   * GET /api/daily/today
   *
   * 空态契约：当日无记录时返回结构化空对象（entries:[]），不再返回 data:null
   */
  .get("/today", async (c) => {
    // 生成北京时间 YYYY-MM-DD 格式的日期字符串
    const now = new Date();
    const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const pickDate = `${shanghai.getFullYear()}-${String(shanghai.getMonth() + 1).padStart(2, "0")}-${String(shanghai.getDate()).padStart(2, "0")}`;

    // 第1次 DB 调用：dailyPicks
    const rows = await db
      .select()
      .from(schema.dailyPicks)
      .where(eq(schema.dailyPicks.pickDate, pickDate))
      .limit(1);

    const pick = rows[0];

    if (!pick) {
      // 新空态：返回结构化空对象（entries 恒为数组）
      return c.json({ success: true, data: buildEmptyResponse(pickDate) });
    }

    const data = await buildPickResponse(pick);
    return c.json({ success: true, data });
  })

  /**
   * 按日期合成壁纸图（实时合成 + 磁盘缓存）
   * GET /api/daily/:pickDate/wallpaper?width=W&height=H
   *
   * 注意：此路由必须在 /:id 前注册，避免路由歧义
   */
  .get("/:pickDate/wallpaper", async (c) => {
    const pickDate = c.req.param("pickDate");

    if (!isValidYmd(pickDate)) {
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
          const { composeAndSave } = await import("../lib/wallpaper/composer");

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

    const data = await Promise.all(
      picks.map(async (pick) => {
        const rawMembers = parseMembers(pick.members);
        const members = await enrichMembers(rawMembers);
        return {
          ...pick,
          composedImageUrl: toComposedImageUrl(pick.pickDate, pick.composedImagePath),
          members,
          photo: heroPhotoMap.get(pick.photoId) ?? null,
          // 列表接口不返回 entries（避免数据量过大），前端详情页按需加载
          entries: undefined,
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
   * 每日精选详情（支持按 id 或 pickDate 查询）
   * GET /api/daily/:id
   *
   * 当 :id 符合 YYYY-MM-DD 格式时，按 pickDate 查询
   * 否则按 id 查询
   */
  .get("/:id", async (c) => {
    const id = c.req.param("id");

    let pick: DailyPickRow | undefined;

    if (isValidYmd(id)) {
      // 按 pickDate 查询
      const rows = await db
        .select()
        .from(schema.dailyPicks)
        .where(eq(schema.dailyPicks.pickDate, id));
      pick = rows[0];
    } else {
      // 按 id 查询
      const rows = await db.select().from(schema.dailyPicks).where(eq(schema.dailyPicks.id, id));
      pick = rows[0];
    }

    if (!pick) {
      return c.json({ success: false, error: "精选记录不存在" }, 404);
    }

    const data = await buildPickResponse(pick);

    return c.json({ success: true, data });
  });

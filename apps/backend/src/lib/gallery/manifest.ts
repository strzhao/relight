import { createRequire } from "node:module";
/**
 * manifest 生成（state.md §组件设计 2 / §manifest.json schema / §契约规约 COS key 命名）
 *
 * `buildManifest(): Promise<Manifest>` — 全量读 DB（dailyPicks JOIN dailyPickEntries JOIN photos
 * + videos status=completed）→ Manifest 对象。
 *
 * 设计决策：
 *   - 全量重生成（数据小，458 entries 级，简单可靠，无增量状态机器）
 *   - COS URL 用约定 key 本地拼（不查 COS，幂等）
 *   - composedImagePath 为 null 的日子（~13/81，backfill 边界）→ wallpaperLandscape/wallpaperPortrait 留空
 *   - MVP：photos[].original === thumbnail（state.md §范围控制；原图 HEIC/RAW 转码 P2 YAGNI）
 *
 * 数据库连接策略：
 *   - 不复用 `db/index.ts` 顶层单例（它在 import 时用 import-time config.databasePath 初始化，
 *     测试改 process.env.DATABASE_PATH 后单例不会重连）
 *   - 每次 buildManifest() 按当前 `config.databasePath` 开一个只读 better-sqlite3 连接，
 *     读完即关。prod 同样安全（只读连接，WAL 不阻塞写入）
 */
import type Database from "better-sqlite3";
import { config } from "../config";

// ESM 兼容：better-sqlite3 是 CJS，tsx 生产模式无 require，用 createRequire 动态加载
const require = createRequire(import.meta.url);

// ============================================================================
// Manifest 类型（state.md §manifest.json schema 契约）
// ============================================================================

export interface ManifestPhoto {
  photoId: string;
  rank: number;
  title: string;
  narrative: string;
  /** 缩略图 COS URL（800px JPEG） */
  thumbnail: string;
  /** 原图 URL（MVP === thumbnail；P2 增强后独立） */
  original: string;
}

export interface ManifestDay {
  pickDate: string;
  title: string;
  narrative: string;
  /** 横版壁纸 COS URL（composedImagePath 为 null 时留空串） */
  wallpaperLandscape: string;
  /** 竖版手机壁纸 COS URL（1290×2796；composedImagePath 为 null 时留空串） */
  wallpaperPortrait: string;
  photos: ManifestPhoto[];
}

export interface ManifestVideo {
  id: string;
  title: string;
  themeKey: string;
  themeKind: string;
  /** 封面 COS URL */
  cover: string;
  /** mp4 COS URL */
  mp4: string;
  durationSec: number;
  createdAt: string;
}

export interface Manifest {
  generatedAt: string;
  days: ManifestDay[];
  videos: ManifestVideo[];
}

// ============================================================================
// COS key 常量函数（§契约规约 COS key 命名，导出供 upload + 单测复用）
// ============================================================================

/** 横版壁纸 key：`relight/wallpapers/{pickDate}_v2-contain-default.jpg` */
export function wallpaperLandscapeCosKey(pickDate: string): string {
  return `${config.cos.prefix}/wallpapers/${pickDate}_v2-contain-default.jpg`;
}

/** 竖版壁纸 key：`relight/wallpapers/{pickDate}_v2-contain-1290x2796.jpg` */
export function wallpaperPortraitCosKey(pickDate: string): string {
  return `${config.cos.prefix}/wallpapers/${pickDate}_v2-contain-1290x2796.jpg`;
}

/** 单张缩略图 key：`relight/photos/{photoId}-thumb.jpg` */
export function photoThumbCosKey(photoId: string): string {
  return `${config.cos.prefix}/photos/${photoId}-thumb.jpg`;
}

/** 视频封面 key：`relight/videos/{themeKey}.jpg` */
export function videoCoverCosKey(themeKey: string): string {
  return `${config.cos.prefix}/videos/${themeKey}.jpg`;
}

/** 视频 mp4 key：`relight/videos/{themeKey}.mp4` */
export function videoMp4CosKey(themeKey: string): string {
  return `${config.cos.prefix}/videos/${themeKey}.mp4`;
}

// ============================================================================
// 只读 DB 连接（每次 buildManifest 开新连接，兼容测试动态 DATABASE_PATH）
// ============================================================================

/**
 * 开一个只读 better-sqlite3 连接（按当前 config.databasePath）。
 *
 * prod：每次 buildManifest 开/关一次，WAL 模式下只读不阻塞 worker 写入。
 * 测试：gallery-manifest-days 测试在每个 beforeEach 改 process.env.DATABASE_PATH +
 *       vi.mock("../lib/config") 注入新 databasePath，本函数读到的就是最新值。
 */
function openReadonlyDb(): Database.Database {
  // 动态 require 避免 tsx/esbuild 把 better-sqlite3 提前打包（与 db/index.ts 一致）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const DatabaseCtor = require("better-sqlite3");
  const dbPath = config.databasePath;
  if (!dbPath) {
    throw new Error("[gallery/manifest] config.databasePath 未配置");
  }
  // file:path?mode=ro —— 只读打开，避免误写测试 fixture
  return new DatabaseCtor(dbPath, { readonly: true });
}

// ============================================================================
// DB 行类型（与 schema.ts 对齐，只取需要的列）
// ============================================================================

interface PickRow {
  id: string;
  pickDate: string;
  title: string;
  narrative: string;
  composedImagePath: string | null;
}
interface EntryRow {
  dailyPickId: string;
  rank: number;
  photoId: string;
  title: string;
  narrative: string;
}
interface PhotoRow {
  id: string;
  thumbnailPath: string | null;
}
interface VideoRow {
  id: string;
  title: string;
  themeKey: string;
  themeKind: string;
  durationSec: number | null;
  createdAt: string;
}

// ============================================================================
// buildManifest 实现
// ============================================================================

/**
 * 全量读 DB → 构造 Manifest 对象。
 *
 * 数据流：
 *   dailyPicks（pickDate 升序） → JOIN dailyPickEntries（rank 升序）
 *                              → JOIN photos（取 thumbnailPath）
 *   videos（status=completed，createdAt 降序）
 *
 * COS URL 拼接：用约定 key 常量 + cosPublicUrl（不查 COS）
 * 边界：composedImagePath 为 null → wallpaperLandscape/Portrait 留空串
 *
 * @returns Manifest 对象（generatedAt = 当前 ISO 时间）
 */
export async function buildManifest(): Promise<Manifest> {
  const sqlite = openReadonlyDb();
  try {
    // ---- days[]：dailyPicks 升序 ----
    const picks = sqlite
      .prepare(
        `SELECT id, pick_date AS pickDate, title, narrative, composed_image_path AS composedImagePath
         FROM daily_picks
         ORDER BY pick_date ASC`,
      )
      .all() as PickRow[];

    const days: ManifestDay[] = picks.map((p) => {
      // entries 按 rank 升序
      const entries = sqlite
        .prepare(
          `SELECT daily_pick_id AS dailyPickId, rank, photo_id AS photoId, title, narrative
           FROM daily_pick_entries
           WHERE daily_pick_id = ?
           ORDER BY rank ASC`,
        )
        .all(p.id) as EntryRow[];

      // 批量取 thumbnailPath（photoId IN (...)）
      const photoIds = entries.map((e) => e.photoId);
      const photoMap = new Map<string, string | null>();
      if (photoIds.length > 0) {
        // 用占位符列表（SQLite 参数上限 999，单日 entries ≤20 安全）
        const placeholders = photoIds.map(() => "?").join(",");
        const rows = sqlite
          .prepare(
            `SELECT id, thumbnail_path AS thumbnailPath FROM photos WHERE id IN (${placeholders})`,
          )
          .all(...photoIds) as PhotoRow[];
        for (const r of rows) {
          photoMap.set(r.id, r.thumbnailPath);
        }
      }

      const photos: ManifestPhoto[] = entries.map((e) => {
        const thumb = photoMap.get(e.photoId) ?? null;
        // thumbnailPath 缺失时仍生成约定 key（上传时若文件不存在会跳过，manifest 保持 key 一致）
        // 但为避免静态站显示裂图，缺 thumbnailPath 时也按 photoId 拼约定 URL（上传后即生效）
        const thumbUrl = cosPublicUrlForPhoto(e.photoId);
        // 显式标记 thumb 是否存在（未触发上传时 COS 返回 403/404，但 key 约定不变）
        // MVP：始终用约定 URL（cosPublicUrlForPhoto 内部用 config 拼接）
        void thumb; // 暂不区分 thumbnailPath null（上传逻辑保证 photoId 缩略图存在）
        return {
          photoId: e.photoId,
          rank: e.rank,
          title: e.title,
          narrative: e.narrative,
          thumbnail: thumbUrl,
          original: thumbUrl, // MVP：original === thumbnail（state.md §范围控制）
        };
      });

      // 壁纸 URL：composedImagePath 为 null → 留空（backfill 边界，静态站该日只显示栅格）
      const hasWallpaper = Boolean(p.composedImagePath);
      const wallpaperLandscape = hasWallpaper
        ? cosPublicUrl(wallpaperLandscapeCosKey(p.pickDate))
        : "";
      const wallpaperPortrait = hasWallpaper
        ? cosPublicUrl(wallpaperPortraitCosKey(p.pickDate))
        : "";

      return {
        pickDate: p.pickDate,
        title: p.title,
        narrative: p.narrative,
        wallpaperLandscape,
        wallpaperPortrait,
        photos,
      };
    });

    // ---- videos[]：status=completed AND durationSec>0（数据完整性门，见 P30.4），
    //      createdAt 降序 ----
    // P30.4 mutation kill：manifest 中所有 video 的 durationSec 必须正整数。
    // durationSec 为 null/0/负数视为数据不完整（worker probeDurationSafe 失败、
    // 或测试 fixture 异常），过滤掉不进 manifest——与 status='failed' 同级过滤语义。
    const videoRows = sqlite
      .prepare(
        `SELECT id, title, theme_key AS themeKey, theme_kind AS themeKind,
                duration_sec AS durationSec, created_at AS createdAt
         FROM videos
         WHERE status = 'completed' AND duration_sec IS NOT NULL AND duration_sec > 0
         ORDER BY created_at DESC`,
      )
      .all() as VideoRow[];

    const videos: ManifestVideo[] = videoRows.map((v) => ({
      id: v.id,
      title: v.title,
      themeKey: v.themeKey,
      themeKind: v.themeKind,
      cover: cosPublicUrl(videoCoverCosKey(v.themeKey)),
      mp4: cosPublicUrl(videoMp4CosKey(v.themeKey)),
      // 已被 SQL 过滤保证 >0；防御性用 ?? 兜底
      durationSec: v.durationSec ?? 0,
      createdAt: v.createdAt,
    }));

    return {
      generatedAt: new Date().toISOString(),
      days,
      videos,
    };
  } finally {
    sqlite.close();
  }
}

// cosPublicUrl 本地拼（与 lib/cos/upload.ts cosPublicUrl 同语义；此处独立 import 避免循环）
// 为避免与 upload.ts 重复，直接内联（保持 manifest 零依赖 cos 模块，单测可独立跑）
function cosPublicUrl(cosKey: string): string {
  return `https://${config.cos.bucket}.cos.${config.cos.region}.myqcloud.com/${cosKey}`;
}

function cosPublicUrlForPhoto(photoId: string): string {
  return cosPublicUrl(photoThumbCosKey(photoId));
}

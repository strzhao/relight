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
  /** 缩略图 COS URL（800px JPEG，blur-up 占位 + 视口外懒加载） */
  thumbnail: string;
  /** 中尺寸图 COS URL（~1600px，全屏铺满清晰）；mid 生成/上传失败时 === thumbnail（800px fallback） */
  original: string;
  /** 拍摄时刻 ISO 8601 字符串或 null（dateline 缺失不渲染） */
  takenAt: string | null;
  /** 原图像素宽（流单元占位防 CLS，0=未知前端 fallback 3/4） */
  width: number;
  /** 原图像素高（0=未知） */
  height: number;
  /**
   * 人脸聚焦中心（归一化 0-1，4 位小数）；null = 无人脸/全低质，前端 fallback center。
   * 来源：faces 表最大面积脸（bboxW*bboxH DESC）的 bbox 中心，按 photo.width/height 归一化，
   * 钳制 [0.02, 0.98] 防贴边脸把图推出视口；detection_score < qualityLowDetectionScore 的脸不参与。
   */
  faceFocus: { x: number; y: number } | null;
}

export interface ManifestDay {
  pickDate: string;
  title: string;
  narrative: string;
  /** 横版壁纸 COS URL（composedImagePath 为 null 时留空串） */
  wallpaperLandscape: string;
  /** 竖版手机壁纸 COS URL（1290×2796；composedImagePath 为 null 时留空串） */
  wallpaperPortrait: string;
  /**
   * 横版壁纸视频 COS URL（Aerial 用，.mov）。
   * 条件展开：仅当 DB 回执列非空时字段存在（null/空串 → JSON 中字段缺省，不输出空串——
   * 冻结场景 4.P2 要求开关关闭时字段不存在）。
   */
  wallpaperVideoLandscape?: string;
  /** 竖版壁纸视频 COS URL（画廊壁纸卡用，.mp4；条件展开同上）。 */
  wallpaperVideoPortrait?: string;
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

/** 横版壁纸视频 key：`relight/wallpaper-videos/{pickDate}_landscape.mov` */
export function wallpaperVideoLandscapeCosKey(pickDate: string): string {
  return `${config.cos.prefix}/wallpaper-videos/${pickDate}_landscape.mov`;
}

/** 竖版壁纸视频 key：`relight/wallpaper-videos/{pickDate}_portrait.mp4` */
export function wallpaperVideoPortraitCosKey(pickDate: string): string {
  return `${config.cos.prefix}/wallpaper-videos/${pickDate}_portrait.mp4`;
}

/** 单张缩略图 key：`relight/photos/{photoId}-thumb.jpg` */
export function photoThumbCosKey(photoId: string): string {
  return `${config.cos.prefix}/photos/${photoId}-thumb.jpg`;
}

/** 单张中尺寸图 key：`relight/photos/{photoId}-mid.jpg`（~1600px，与 thumb 同目录平铺） */
export function photoMidCosKey(photoId: string): string {
  return `${config.cos.prefix}/photos/${photoId}-mid.jpg`;
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
  wallpaperVideoLandscapeUrl: string | null;
  wallpaperVideoPortraitUrl: string | null;
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
  takenAt: string | null;
  width: number;
  height: number;
}
interface FaceRow {
  photoId: string;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
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
        `SELECT id, pick_date AS pickDate, title, narrative, composed_image_path AS composedImagePath,
                wallpaper_video_landscape_url AS wallpaperVideoLandscapeUrl,
                wallpaper_video_portrait_url AS wallpaperVideoPortraitUrl
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

      // 批量取 thumbnailPath + takenAt + width + height（photoId IN (...)）
      const photoIds = entries.map((e) => e.photoId);
      const photoMap = new Map<string, PhotoRow>();
      // 人脸聚焦：photoId → 主脸（最大面积 bboxW*bboxH DESC，score >= qualityLowDetectionScore）
      const faceMap = new Map<string, FaceRow>();
      if (photoIds.length > 0) {
        // 用占位符列表（SQLite 参数上限 999，单日 entries ≤20 安全）
        const placeholders = photoIds.map(() => "?").join(",");
        const rows = sqlite
          .prepare(
            `SELECT id, thumbnail_path AS thumbnailPath, taken_at AS takenAt,
                    width, height
             FROM photos WHERE id IN (${placeholders})`,
          )
          .all(...photoIds) as PhotoRow[];
        for (const r of rows) {
          photoMap.set(r.id, r);
        }
        // 人脸聚焦主脸查询：窗口函数取每 photoId 最大面积脸（SQLite ≥3.25，better-sqlite3 自带）。
        // try/catch 旁路容错：faces 表缺失/查询失败 → faceMap 空 → 全部 faceFocus=null（不阻塞 manifest）
        try {
          const lowScore = config.face.qualityLowDetectionScore;
          const faceRows = sqlite
            .prepare(
              `SELECT photo_id AS photoId, bbox_x AS bboxX, bbox_y AS bboxY,
                      bbox_w AS bboxW, bbox_h AS bboxH
               FROM (
                 SELECT f.photo_id, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h,
                        ROW_NUMBER() OVER (
                          PARTITION BY f.photo_id
                          ORDER BY (f.bbox_w * f.bbox_h) DESC, f.detection_score DESC
                        ) AS rn
                 FROM faces f
                 WHERE f.photo_id IN (${placeholders}) AND f.detection_score >= ?
               )
               WHERE rn = 1`,
            )
            .all(...photoIds, lowScore) as FaceRow[];
          for (const f of faceRows) {
            faceMap.set(f.photoId, f);
          }
        } catch (err) {
          console.warn(
            "[gallery/manifest] faces 查询失败，faceFocus 全部为 null:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      const photos: ManifestPhoto[] = entries.map((e) => {
        // thumbnailPath 缺失时仍生成约定 key（上传时若文件不存在会跳过，manifest 保持 key 一致）
        const thumbUrl = cosPublicUrl(photoThumbCosKey(e.photoId));
        // original 指向 mid 尺寸图（~1600px）；mid 生成/上传失败时由前端 <img onerror> fallback thumb
        // （约定式 COS key——buildManifest 全量重生成不查 COS，保持无状态；S9.PM3 fixture 在测试层注入）
        const midUrl = cosPublicUrl(photoMidCosKey(e.photoId));
        const row = photoMap.get(e.photoId);
        // 人脸聚焦归一化：主脸 bbox 中心 / 原图像素维度，钳制 [0.02, 0.98] 防贴边脸把图推出视口
        let faceFocus: { x: number; y: number } | null = null;
        const face = faceMap.get(e.photoId);
        const w = row?.width ?? 0;
        const h = row?.height ?? 0;
        if (face && w > 0 && h > 0) {
          const clamp = (v: number) => Math.max(0.02, Math.min(0.98, v));
          faceFocus = {
            x: Number(clamp((face.bboxX + face.bboxW / 2) / w).toFixed(4)),
            y: Number(clamp((face.bboxY + face.bboxH / 2) / h).toFixed(4)),
          };
        }
        return {
          photoId: e.photoId,
          rank: e.rank,
          title: e.title,
          narrative: e.narrative,
          thumbnail: thumbUrl,
          original: midUrl,
          takenAt: row?.takenAt ?? null,
          width: w,
          height: h,
          faceFocus,
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

      // 壁纸视频字段：条件展开——仅当 DB 回执列非空时注入（null/空串 → 字段缺省，
      // 不输出空串；冻结场景 4.P2 要求开关关闭时字段不存在）。值 = COS 上传回执 URL
      //（manifest 资源 URL 用回执而非约定 key 拼——死链教训）。
      const day: ManifestDay = {
        pickDate: p.pickDate,
        title: p.title,
        narrative: p.narrative,
        wallpaperLandscape,
        wallpaperPortrait,
        photos,
      };
      if (p.wallpaperVideoLandscapeUrl) {
        day.wallpaperVideoLandscape = p.wallpaperVideoLandscapeUrl;
      }
      if (p.wallpaperVideoPortraitUrl) {
        day.wallpaperVideoPortrait = p.wallpaperVideoPortraitUrl;
      }
      return day;
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

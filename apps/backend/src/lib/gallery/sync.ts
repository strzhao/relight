import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
/**
 * manifest 推送 + 当日资源同步（state.md §组件设计 3 + §组件设计 4/5 接入点）
 *
 *   pushManifest(manifest): scp .tmp → ssh mv 原子覆盖 VPS manifest.json（失败 console.warn 不 throw）
 *   syncDayToGallery(pickDate, wallpaperPaths, entryPhotoIds): 上传当日壁纸+缩略图 + buildManifest + pushManifest
 *   syncVideoToGallery(video): 上传 mp4+封面 + buildManifest + pushManifest
 *
 * 容错契约（§契约规约 容错契约）：
 *   所有 gallery 相关调用失败 → console.warn + job.log，**不 throw**
 *   （画廊是旁路，不阻塞精选/视频主流程；knowledge「格式门 return 非 throw」同构模式）
 *
 * 返回值契约（§契约规约 函数签名）：全部 Promise<void>——容错旁路不返回成功/失败状态，
 * 推送结果由 pushManifest 内部 console.log/warn 自行记录，调用方无需感知。
 *
 * 依赖：
 *   - child_process execFile('scp'/'ssh')，不引 ssh2
 *   - pLimit（已装）并发上传缩略图
 *   - upload.ts（COS 上传）
 *   - manifest.ts（buildManifest）
 *   - config.ts（gallery VPS 目标）
 */
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import pLimit from "p-limit";
import { config } from "../config";
import { uploadFile } from "../cos/upload";
import {
  type Manifest,
  buildManifest,
  videoCoverCosKey,
  videoMp4CosKey,
  wallpaperLandscapeCosKey,
  wallpaperPortraitCosKey,
} from "./manifest";

// ESM 兼容：better-sqlite3 是 CJS，tsx 生产模式无 require，用 createRequire 动态加载
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

// ============================================================================
// pushManifest：scp .tmp → ssh mv 原子覆盖
// ============================================================================

/**
 * 把 manifest JSON 推送到 VPS（原子覆盖）。
 *
 * 流程（state.md §组件设计 3）：
 *   1. JSON.stringify → 本地 .tmp 文件（os.tmpdir）
 *   2. scp .tmp 到 `${vpsPath}/manifest.json.tmp`
 *   3. ssh mv manifest.json.tmp manifest.json（原子覆盖）
 *
 * 容错：失败 console.warn，**不 throw**（画廊旁路）。
 * 跳过条件：vpsHost/vpsPath/vpsKey 任一未配置（本机开发）→ console.warn 跳过。
 */
export async function pushManifest(manifest: Manifest): Promise<void> {
  const { vpsHost, vpsUser, vpsKey, vpsPath } = config.gallery;
  if (!vpsHost || !vpsPath || !vpsKey) {
    console.warn(
      "[gallery/sync] GALLERY_VPS_HOST/PATH/KEY 未配置，跳过 manifest 推送（本机开发模式）",
    );
    return;
  }

  const targetTmp = `${vpsPath}/manifest.json.tmp`;
  const targetFinal = `${vpsPath}/manifest.json`;
  const localTmp = path.join(
    // 用 process temp 目录，避免污染 STORAGE_ROOT
    await import("node:os").then((m) => m.tmpdir()),
    `relight-manifest-${Date.now()}.json.tmp`,
  );

  const sshBase = [
    "-i",
    vpsKey,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
  ];

  try {
    // 1. 写本地 tmp（动态 import 避免顶层 fs/promises 污染）
    const { writeFile } = await import("node:fs/promises");
    await writeFile(localTmp, JSON.stringify(manifest, null, 2), "utf8");

    // 2. scp 到 VPS .tmp
    const scpArgs = [...sshBase, localTmp, `${vpsUser}@${vpsHost}:${targetTmp}`];
    await execFileAsync("scp", scpArgs, { timeout: 30_000 });

    // 3. ssh mv 原子覆盖
    const mvCmd = `mv -f ${shellQuote(targetTmp)} ${shellQuote(targetFinal)}`;
    await execFileAsync("ssh", [...sshBase, `${vpsUser}@${vpsHost}`, mvCmd], {
      timeout: 15_000,
    });

    console.log(`[gallery/sync] manifest 推送成功 → ${targetFinal}`);
  } catch (err) {
    // 容错契约：失败 console.warn 不 throw（画廊旁路）
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[gallery/sync] manifest 推送失败（不阻塞主流程）: ${msg}`);
  } finally {
    // 清理本地 tmp（best effort）
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(localTmp);
    } catch {
      // ignore
    }
  }
}

/** shell quote：单引号包裹 + 转义内部单引号（shell 原生安全，防 $/反引号/! 等元字符注入；qa-reviewer B1 硬化） */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ============================================================================
// syncDayToGallery：当日精选资源同步（daily-selection 阶段3 接入）
// ============================================================================

export interface DayWallpaperPaths {
  /** 横版壁纸本地路径（composedImagePath）；null/undefined 跳过横版上传 */
  landscape?: string | null;
  /** 竖版壁纸本地路径（portraitPath）；null/undefined 跳过竖版上传 */
  portrait?: string | null;
}

/** 把 log 参数规范化成函数（容忍测试/调用方传非函数） */
function safeLogger(log: unknown): (msg: string) => void {
  return typeof log === "function" ? (log as (m: string) => void) : console.log;
}

/**
 * 仅上传当日资源（壁纸 + entries 缩略图），不刷 manifest。
 *
 * 供 backfill CLI 批量场景复用（回填多天时省 ssh 次数，最后统一刷一次 manifest）。
 * 容错：失败 throw 给调用方（CLI 记录失败继续下一天）。
 *
 * @param pickDate 当日日期
 * @param composedImagePath 横版壁纸本地路径（null 跳过）
 * @param portraitPath 竖版壁纸本地路径（null 跳过）
 * @param entryPhotoIds 当日 entries photoId 列表
 * @param log 日志回调（非函数时降级 console.log）
 */
export async function uploadDayAssets(
  pickDate: string,
  composedImagePath: string | null | undefined,
  portraitPath: string | null | undefined,
  entryPhotoIds: string[],
  log: ((msg: string) => void) | unknown = console.log,
): Promise<void> {
  const safeLog = safeLogger(log);
  // 1. 横版壁纸
  if (composedImagePath) {
    await safeUploadFile(
      composedImagePath,
      wallpaperLandscapeCosKey(pickDate),
      "image/jpeg",
      safeLog,
    );
  }
  // 2. 竖版壁纸
  if (portraitPath) {
    await safeUploadFile(portraitPath, wallpaperPortraitCosKey(pickDate), "image/jpeg", safeLog);
  }
  // 3. 并发上传缩略图（pLimit 5）
  if (entryPhotoIds.length > 0) {
    const limit = pLimit(5);
    const thumbPaths = await fetchThumbnailPaths(entryPhotoIds);
    await Promise.all(
      entryPhotoIds.map((photoId) =>
        limit(async () => {
          const local = thumbPaths.get(photoId);
          if (!local) {
            safeLog(`[gallery/sync] photoId=${photoId} thumbnailPath 为空，跳过上传`);
            return;
          }
          await safeUploadFile(local, photoThumbKey(photoId), "image/jpeg", safeLog);
        }),
      ),
    );
  }
}

/**
 * 同步当日精选到画廊（上传壁纸 + 当日 entries 缩略图 + 刷 manifest）。
 *
 * 调用点：daily-selection.ts 阶段3 完成（横版 697 / 竖版 716 后）。
 * 容错：整函数 try/catch，失败 console.warn + job.log，**不 throw**（画廊旁路）。
 * catch 块只用 console.warn（不依赖 log 参数，避免 log 非函数时二次 throw）。
 *
 * @param pickDate 当日日期（YYYY-MM-DD）
 * @param wallpaperPaths 壁纸本地路径（任一为 null 则跳过对应上传）
 * @param entryPhotoIds 当日 entries 的 photoId 列表（用于上传 thumbnailPath）
 * @param log job.log 回调（可选，非函数时降级 console.log）
 */
export async function syncDayToGallery(
  pickDate: string,
  wallpaperPaths: DayWallpaperPaths,
  entryPhotoIds: string[],
  log: ((msg: string) => void) | unknown = console.log,
): Promise<void> {
  const safeLog = safeLogger(log);
  try {
    // 1-3. 上传资源（复用 uploadDayAssets）
    await uploadDayAssets(
      pickDate,
      wallpaperPaths.landscape ?? null,
      wallpaperPaths.portrait ?? null,
      entryPhotoIds,
      safeLog,
    );

    // 4. buildManifest + pushManifest（推送结果由 pushManifest 内部 log 记录）
    const manifest = await buildManifest();
    await pushManifest(manifest);
    safeLog(`[gallery/sync] day=${pickDate} 同步完成`);
  } catch (err) {
    // catch 块只用 console.warn（不依赖 log 参数，避免 log 非函数时二次 throw 逃出容错边界）
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[gallery/sync] day=${pickDate} 同步失败（不阻塞精选）: ${msg}`);
    try {
      safeLog(`[gallery/sync] day=${pickDate} 同步失败: ${msg}`);
    } catch {
      // log 本身坏的，忽略
    }
  }
}

// ============================================================================
// syncVideoToGallery：视频资源同步（daily-video 接入）
// ============================================================================

export interface VideoAssets {
  /** 视频主题指纹（trip=`<region>-<year>` / person=`<personId>-<toYear>`），COS key 用 */
  themeKey: string;
  /** mp4 本地路径 */
  mp4Path: string;
  /** 封面 jpg 本地路径 */
  coverPath: string;
}

/**
 * 仅上传视频资源（mp4 + 封面），不刷 manifest。
 * 供 backfill CLI 复用。失败 throw 给调用方。
 */
export async function uploadVideoAssets(
  assets: VideoAssets,
  log: ((msg: string) => void) | unknown = console.log,
): Promise<void> {
  const safeLog = safeLogger(log);
  await safeUploadFile(assets.mp4Path, videoMp4CosKey(assets.themeKey), "video/mp4", safeLog);
  await safeUploadFile(assets.coverPath, videoCoverCosKey(assets.themeKey), "image/jpeg", safeLog);
}

/**
 * 同步视频到画廊（上传 mp4 + 封面 + 刷 manifest）。
 *
 * 调用点：daily-video.ts 视频渲染成功后（writeCompletedVideo 后、pushVideoNotification 前）。
 * 容错：整函数 try/catch，失败 console.warn + job.log，**不 throw**（画廊旁路）。
 */
export async function syncVideoToGallery(
  assets: VideoAssets,
  log: ((msg: string) => void) | unknown = console.log,
): Promise<void> {
  const safeLog = safeLogger(log);
  try {
    // 1-2. 上传资源
    await uploadVideoAssets(assets, safeLog);
    // 3. buildManifest + pushManifest（推送结果由 pushManifest 内部 log 记录）
    const manifest = await buildManifest();
    await pushManifest(manifest);
    safeLog(`[gallery/sync] video themeKey=${assets.themeKey} 同步完成`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[gallery/sync] video themeKey=${assets.themeKey} 同步失败（不阻塞视频推送）: ${msg}`,
    );
    try {
      safeLog(`[gallery/sync] video themeKey=${assets.themeKey} 同步失败: ${msg}`);
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// 内部 helper
// ============================================================================

/** photoId → thumbnailPath 缩略图 key（避免与 manifest.ts photoThumbCosKey 循环，内联） */
function photoThumbKey(photoId: string): string {
  return `${config.cos.prefix}/photos/${photoId}-thumb.jpg`;
}

/**
 * 安全上传（文件不存在跳过，上传失败 throw 给上层 try/catch）。
 * 文件存在检查避免「缩略图未生成」时 COS 上传抛 EENOENT。
 */
async function safeUploadFile(
  localPath: string,
  cosKey: string,
  contentType: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await access(localPath);
  } catch {
    log(`[gallery/sync] 本地文件不存在，跳过上传: ${localPath}`);
    return;
  }
  await uploadFile(localPath, cosKey, contentType);
}

/** 批量查 photoId → thumbnailPath（开只读 DB，与 manifest.ts 同模式） */
async function fetchThumbnailPaths(photoIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (photoIds.length === 0) return out;
  // 动态 require better-sqlite3（与 manifest.ts openReadonlyDb 一致）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const DatabaseCtor = require("better-sqlite3");
  const db = new DatabaseCtor(config.databasePath, { readonly: true });
  try {
    // 分批避免 999 参数限制（单日 ≤20，多日 backfill 可能超）
    const BATCH = 500;
    for (let i = 0; i < photoIds.length; i += BATCH) {
      const batch = photoIds.slice(i, i + BATCH);
      const placeholders = batch.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT id, thumbnail_path AS thumbnailPath FROM photos WHERE id IN (${placeholders})`,
        )
        .all(...batch) as Array<{ id: string; thumbnailPath: string | null }>;
      for (const r of rows) {
        out.set(r.id, r.thumbnailPath);
      }
    }
    return out;
  } finally {
    db.close();
  }
}

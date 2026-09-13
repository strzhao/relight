import { mkdir, rm } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";
/**
 * wallpaper-video Worker：每日精选完成后对 hero 照片做微动化，产出横竖两条壁纸视频
 * （动态视频壁纸，state.md ## 后端设计 4 / ## 契约规约；v2 增量任务 15 双轨转码改造）。
 *
 * 触发：daily-selection 阶段 4 链式 enqueue（wallpaperVideoQueue.add，one-off，无 repeatable）。
 * 流程（runWallpaperVideo，v2）：
 *   1. 开关关（config.wallpaperVideoEnabled）→ log skip 返回
 *   2. 取 dailyPicks + hero photo（无记录 / hero 是视频 / composedImagePath null → skip）
 *   3. faces 表取 hero 最大人脸 bbox（面积最大；无脸 → null 中心构图回退）
 *   4. 串行两侧，每侧（v2 串接）：
 *      preprocess（人脸构图裁剪）→ spawn honeydo 生成（seconds 默认 4，双锚定）
 *      → buildLoop（palindrome 拼接至 loopSeconds 默认 8）
 *      → renderTextOverlay（Remotion 文字层合成，杂志排版）
 *      → 双轨转码（横 Aerial：hvc1 .mov 1920×1080 无音轨，输入=Remotion 成品；
 *                 竖 Gallery：libx264 crf18 + aac 128k mp4 带音轨）
 *      → COS 上传 ×1/侧（回执 URL，失败返回空串；回执非空串才写 DB 列）
 *   5. syncDayToGallery（复用，重建 manifest 推 VPS）
 *
 * 容错：单侧生成/上传失败不阻塞另一侧与主流程——失败当日回退静态壁纸（既有链路不动）。
 * 注意：本 Worker 串行（concurrency 1），单条 spawn 90min 级；queue defaultJobOptions
 * attempts: 1（失败不重试，重试会连环占串行 Worker 且重复烧 GPU）。
 */
import type { Job } from "bullmq";
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { uploadFile } from "../lib/cos/upload";
import {
  wallpaperVideoLandscapeCosKey,
  wallpaperVideoPortraitCosKey,
} from "../lib/gallery/manifest";
import {
  type FaceBbox,
  WALLPAPER_VIDEO_LANDSCAPE_CANVAS,
  WALLPAPER_VIDEO_LANDSCAPE_RES,
  WALLPAPER_VIDEO_PORTRAIT_CANVAS,
  WALLPAPER_VIDEO_PORTRAIT_RES,
  assertVideoSpawnPrerequisites,
  buildLoop,
  clampWallpaperVideoSeconds,
  preprocessHeroFrame,
  renderTextOverlay,
  spawnHoneydoVideo,
  transcodeForAerial,
  transcodeForGallery,
} from "../lib/wallpaper/video";

/** 本地产物目录：{STORAGE_ROOT}/wallpaper-videos/ */
function wallpaperVideoDir(): string {
  return path.join(config.storageRoot, "wallpaper-videos");
}

/**
 * faces 表取该照片面积最大的人脸 bbox（人脸构图裁剪用；无脸 → null 中心构图回退）。
 * bbox 为 EXIF 旋转后原图像素坐标（detect-faces 主流程 rotate 后检测，同空间）。
 */
export async function getLargestFaceBbox(photoId: string): Promise<FaceBbox | null> {
  const rows = await db
    .select({
      x: schema.faces.bboxX,
      y: schema.faces.bboxY,
      w: schema.faces.bboxW,
      h: schema.faces.bboxH,
    })
    .from(schema.faces)
    .where(eq(schema.faces.photoId, photoId))
    .orderBy(desc(sql`${schema.faces.bboxW} * ${schema.faces.bboxH}`))
    .limit(1);
  const r = rows[0];
  return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
}

/** 单侧「预裁剪→生成→buildLoop→renderTextOverlay→转码→上传→写列」；失败 throw 给上层（旁路：log 后继续另一侧） */
async function produceOneSide(opts: {
  pickDate: string;
  pickId: string;
  photoPath: string;
  faceBbox: FaceBbox | null;
  meta: { title: string; narrative: string; takenAt?: string | null };
  canvas: { width: number; height: number };
  res: string;
  ext: "mov" | "mp4";
  cosKey: string;
  contentType: string;
  dbColumn: "wallpaperVideoLandscapeUrl" | "wallpaperVideoPortraitUrl";
  transcode: (src: string, dst: string) => Promise<void>;
  log: (m: string) => void;
}): Promise<string> {
  const {
    pickDate,
    pickId,
    photoPath,
    faceBbox,
    meta,
    canvas,
    res,
    ext,
    cosKey,
    contentType,
    dbColumn,
    transcode,
    log,
  } = opts;
  const side = ext === "mov" ? "landscape" : "portrait";

  // 1. sharp 预裁剪（v2 人脸构图：faces bbox → 脸占画布 ≥1/4；无 bbox → 中心构图回退）
  const framePath = await preprocessHeroFrame(photoPath, canvas.width, canvas.height, { faceBbox });
  // 中间产物（raw 生成 / loop 拼接 / overlay 合成）——转码完成后逐级清理
  const rawPath = path.join(wallpaperVideoDir(), `${pickDate}-${side}-raw.mp4`);
  let loopPath: string | null = null;
  let overlaidPath: string | null = null;
  try {
    // 2. spawn honeydo（双锚定伪循环：--first-frame 与 --last-frame 同图；seconds 默认 4）
    const seconds = clampWallpaperVideoSeconds(config.wallpaperVideoSeconds);
    log(`[wallpaper-video] ${pickDate} ${res} 生成开始（seconds=${seconds}）`);
    await spawnHoneydoVideo({
      cliPath: config.honeydoCliPath,
      prompt: config.wallpaperVideoPrompt,
      firstFrame: framePath,
      lastFrame: framePath,
      outPath: rawPath,
      seconds,
      res,
      timeoutMs: config.wallpaperVideoSpawnTimeoutMs,
    });
    log(`[wallpaper-video] ${pickDate} ${res} 生成完成 → ${rawPath}`);

    // 3. buildLoop：palindrome 拼接至 loopSeconds（默认 8s；4s 单条 ×2）
    const loop = await buildLoop(rawPath, config.wallpaperVideoLoopSeconds);
    loopPath = loop.loopPath;
    log(
      `[wallpaper-video] ${pickDate} ${res} palindrome 拼接完成（segments=${loop.segments}）→ ${loopPath}`,
    );

    // 4. renderTextOverlay：Remotion 文字层合成（杂志排版：日期/标题/footer 拍摄时刻）
    const overlay = await renderTextOverlay(loopPath, {
      pickDate,
      title: meta.title,
      narrative: meta.narrative,
      takenAt: meta.takenAt,
    });
    overlaidPath = overlay.overlaidPath;
    log(`[wallpaper-video] ${pickDate} ${res} 文字层合成完成 → ${overlaidPath}`);

    // 5. 转码（横 Aerial：HEVC .mov 1920×1080 无音轨；竖 Gallery：H.264 mp4 带音轨）
    //    v2：双轨输入 = Remotion 成品
    const dstPath = path.join(wallpaperVideoDir(), `${pickDate}-${side}.${ext}`);
    await transcode(overlaidPath, dstPath);
    log(`[wallpaper-video] ${pickDate} ${res} 转码完成 → ${dstPath}`);
    await rm(rawPath, { force: true }).catch(() => {});
    await rm(loopPath, { force: true }).catch(() => {});
    await rm(overlaidPath, { force: true }).catch(() => {});

    // 6. COS 上传（回执 URL；失败/凭据缺失返回空串，不 throw）
    try {
      await access(dstPath);
    } catch {
      log(`[wallpaper-video] ${pickDate} ${res} 产物缺失，跳过上传: ${dstPath}`);
      return "";
    }
    const url = await uploadFile(dstPath, cosKey, contentType);
    if (!url) {
      log(`[wallpaper-video] ${pickDate} ${res} COS 上传返回空串（失败/凭据缺失），不写 DB 列`);
      return "";
    }

    // 7. 回执非空串才写 DB 列（单行 UPDATE，无多表事务）
    await db
      .update(schema.dailyPicks)
      .set({ [dbColumn]: url })
      .where(eq(schema.dailyPicks.id, pickId));
    log(`[wallpaper-video] ${pickDate} ${res} 上传成功 → ${url}`);
    return url;
  } finally {
    await rm(framePath, { force: true }).catch(() => {});
    // 失败路径清理已产出的中间产物（成功路径已在上方清理）
    if (loopPath) await rm(loopPath, { force: true }).catch(() => {});
    if (overlaidPath) await rm(overlaidPath, { force: true }).catch(() => {});
  }
}

/**
 * 壁纸视频主流程（Worker 与 rerun CLI 共用）。
 *
 * @returns 两条 COS URL（失败/跳过为空串——调用方/CLI 末行 JSON 契约 <url|"">）
 */
export async function runWallpaperVideo(
  pickDate: string,
  log: (m: string) => void = console.log,
): Promise<{ landscape: string; portrait: string }> {
  // 1. 开关关 → skip（当日回退静态，零 honeydo 调用）
  if (!config.wallpaperVideoEnabled) {
    log("[wallpaper-video] skip：功能开关关闭（DAILY_WALLPAPER_VIDEO=false），维持静态壁纸链路");
    return { landscape: "", portrait: "" };
  }

  // 2. 取当日 hero（无记录 / hero 是视频 / 无合成壁纸 → skip）
  const pickRows = await db
    .select()
    .from(schema.dailyPicks)
    .where(eq(schema.dailyPicks.pickDate, pickDate))
    .limit(1);
  const pick = pickRows[0];
  if (!pick) {
    log(`[wallpaper-video] skip：dailyPicks 无 ${pickDate} 记录`);
    return { landscape: "", portrait: "" };
  }

  const photoRows = await db
    .select()
    .from(schema.photos)
    .where(eq(schema.photos.id, pick.photoId))
    .limit(1);
  const hero = photoRows[0];
  if (!hero) {
    log(`[wallpaper-video] skip：hero photoId=${pick.photoId} 不存在`);
    return { landscape: "", portrait: "" };
  }
  if ((hero.mediaType ?? "image") === "video") {
    log("[wallpaper-video] skip：hero 是视频，当日不出壁纸视频（Mac 走旧 dynamic HEIC 链路）");
    return { landscape: "", portrait: "" };
  }
  if (!pick.composedImagePath) {
    log("[wallpaper-video] skip：composedImagePath 为空（无静态壁纸，不生成视频）");
    return { landscape: "", portrait: "" };
  }

  // 前置校验（honeydo bin / ffmpeg / 原图 / Remotion 文字层工程四组存在）
  await assertVideoSpawnPrerequisites(hero.filePath);

  // 3. faces 表取 hero 最大人脸 bbox（两侧共用；无脸 → 中心构图回退）
  const faceBbox = await getLargestFaceBbox(hero.id);
  log(
    `[wallpaper-video] ${pickDate} 人脸构图 bbox=${
      faceBbox ? `${faceBbox.w}×${faceBbox.h}@(${faceBbox.x},${faceBbox.y})` : "无（中心构图）"
    }`,
  );

  await mkdir(wallpaperVideoDir(), { recursive: true });

  // 4. 串行两侧「生成→buildLoop→renderTextOverlay→转码」；单侧失败旁路 log，不阻塞另一侧
  const meta = { title: pick.title, narrative: pick.narrative, takenAt: hero.takenAt ?? null };
  let landscape = "";
  let portrait = "";
  try {
    landscape = await produceOneSide({
      pickDate,
      pickId: pick.id,
      photoPath: hero.filePath,
      faceBbox,
      meta,
      canvas: WALLPAPER_VIDEO_LANDSCAPE_CANVAS,
      res: WALLPAPER_VIDEO_LANDSCAPE_RES,
      ext: "mov",
      cosKey: wallpaperVideoLandscapeCosKey(pickDate),
      contentType: "video/quicktime",
      dbColumn: "wallpaperVideoLandscapeUrl",
      transcode: transcodeForAerial,
      log,
    });
  } catch (err) {
    log(
      `[wallpaper-video] ${pickDate} 横版失败（当日回退静态）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    portrait = await produceOneSide({
      pickDate,
      pickId: pick.id,
      photoPath: hero.filePath,
      faceBbox,
      meta,
      canvas: WALLPAPER_VIDEO_PORTRAIT_CANVAS,
      res: WALLPAPER_VIDEO_PORTRAIT_RES,
      ext: "mp4",
      cosKey: wallpaperVideoPortraitCosKey(pickDate),
      contentType: "video/mp4",
      dbColumn: "wallpaperVideoPortraitUrl",
      transcode: transcodeForGallery,
      log,
    });
  } catch (err) {
    log(
      `[wallpaper-video] ${pickDate} 竖版失败（当日回退静态）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 5. 画廊同步（复用 syncDayToGallery：重建 manifest + 推 VPS；幂等重传静态图无害）。
  //    旁路容错：失败 log 不 throw（画廊是旁路）。
  if (landscape || portrait) {
    try {
      const { syncDayToGallery } = await import("../lib/gallery/sync");
      await syncDayToGallery(
        pickDate,
        { landscape: pick.composedImagePath, portrait: null },
        [],
        log,
      );
    } catch (err) {
      log(
        `[wallpaper-video] 画廊同步失败（不阻塞）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  log(
    `[wallpaper-video] ${pickDate} 完成 landscape=${landscape || "（空）"} portrait=${portrait || "（空）"}`,
  );
  return { landscape, portrait };
}

/**
 * BullMQ Worker 入口（queues.ts wallpaperVideoQueue → workers/index.ts 注册）。
 * job.data: { pickDate }（daily-selection 阶段 4 / rerun CLI 入队）。
 */
export async function wallpaperVideoWorker(job: Job): Promise<void> {
  const pickDate = (job.data as { pickDate?: string } | undefined)?.pickDate;
  if (!pickDate) {
    job.log("[wallpaper-video] skip：job.data.pickDate 缺失");
    return;
  }
  job.log(`[wallpaper-video] start pickDate=${pickDate}`);
  await runWallpaperVideo(pickDate, (m) => job.log(m));
  job.log("[wallpaper-video] done");
}

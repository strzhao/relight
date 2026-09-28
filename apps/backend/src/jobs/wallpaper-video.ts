import { mkdir, rm } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";
/**
 * wallpaper-video Worker：每日精选完成后对 hero 照片做微动化，产出**单腿原生比例**壁纸视频
 * （动态视频壁纸，state.md ## 后端设计 4 / ## 契约规约；20260928 单腿原生比例改版）。
 *
 * 触发：daily-selection 阶段 4 链式 enqueue（wallpaperVideoQueue.add，one-off，无 repeatable）。
 * 流程（runWallpaperVideo，20260928）：
 *   1. 开关关（config.wallpaperVideoEnabled）→ log skip 返回
 *   2. 取 dailyPicks + hero photo（无记录 / hero 是视频 / composedImagePath null → skip）
 *   3. faces 表取 hero 最大人脸 bbox（仅用于 prompt 分层默认；预裁剪已去除人脸窗口）
 *      + sharp 读 hero EXIF 旋转后尺寸 → computeNativeCanvas 算单腿原生画布
 *   4. 单腿串接（produceNativeSide）：
 *      preprocess（cover 微裁至画布）→ spawn honeydo 生成（seconds 默认 4，双锚定，
 *      -r 720p + --width/--height 画布显式覆盖）→ buildLoop（palindrome 拼接至 loopSeconds 默认 8）
 *      → renderTextOverlay（Remotion 文字层，props 携画布宽高，comp 按画布比例选）
 *      → 转码 A（画廊原生）：transcodeForGallery 无尺寸透传（分辨率==画布）→ 尺寸护栏断言
 *        → 上传 COS `relight/wallpaper-videos/{pickDate}_native.mp4` → 写 wallpaper_video_native_url
 *      → 转码 B（条件 Aerial）：画布比例 ∈ [1.5,1.9] 才产出——transcodeForAerialNative
 *        （居中裁 16:9 → 1920×1080 hvc1 .mov）→ 尺寸护栏断言 → 上传现有 `_landscape.mov` key
 *        → 写 wallpaper_video_landscape_url（语义收窄为「16:9 适配版」）
 *      窗口外：.mov 与 landscape 列都不产出 → mac App 拿空列走既有静态回退（零改动）
 *   5. syncDayToGallery（复用，重建 manifest 推 VPS）
 *
 * 失败语义（契约 8）：任一环节 throw → 当日 wallpaper_video_native_url / wallpaper_video_landscape_url
 * 均空（护栏在任一回执列写入之前执行）→ 画廊静态卡 + mac 静态壁纸；job 不向调度层抛（旁路容错）。
 * 注意：本 Worker 串行（concurrency 1），单条 spawn 90min 级；queue defaultJobOptions
 * attempts: 1（失败不重试，重试会连环占串行 Worker 且重复烧 GPU）。
 */
import type { Job } from "bullmq";
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { uploadFile } from "../lib/cos/upload";
import { wallpaperVideoLandscapeCosKey, wallpaperVideoNativeCosKey } from "../lib/gallery/manifest";
// 画布 SSOT（20260928 单腿原生）：computeNativeCanvas 从 native-canvas.ts 引入
import { computeNativeCanvas } from "../lib/wallpaper/native-canvas";
import {
  DimensionAssertError,
  type FaceBbox,
  WALLPAPER_VIDEO_RES,
  assertVideoDimensions,
  assertVideoSpawnPrerequisites,
  buildLoop,
  clampWallpaperVideoSeconds,
  isAerialCompatCanvas,
  preprocessHeroFrame,
  readOrientedDimensions,
  renderTextOverlay,
  spawnHoneydoVideo,
  transcodeForAerialNative,
  transcodeForGallery,
} from "../lib/wallpaper/video";

/** 本地产物目录：{STORAGE_ROOT}/wallpaper-videos/ */
function wallpaperVideoDir(): string {
  return path.join(config.storageRoot, "wallpaper-videos");
}

/**
 * faces 表取该照片面积最大的人脸 bbox（仅 prompt 分层默认用；无脸 → null → 风景默认 prompt）。
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

/**
 * 单腿「预裁剪→生成→buildLoop→renderTextOverlay→双转码→上传→写列」；失败 throw 给上层
 * （runWallpaperVideo 旁路：log 后当日回退静态——契约 8 两列均空）。
 *
 * 顺序刻意安排：**两条转码 + 尺寸护栏全部通过后才上传/写列**——护栏阻断（场景 5）时
 * native/landscape 两列必然均空，不产生「native 已入库但 .mov 护栏失败」的半成品日。
 */
async function produceNativeSide(opts: {
  pickDate: string;
  pickId: string;
  photoPath: string;
  meta: { title: string; narrative: string; takenAt?: string | null };
  canvas: { width: number; height: number };
  /** 生成 prompt（解析链：pick.motionPrompt → faceBbox 分层默认） */
  prompt: string;
  log: (m: string) => void;
}): Promise<{ nativeUrl: string; landscapeUrl: string }> {
  const { pickDate, pickId, photoPath, meta, canvas, prompt, log } = opts;
  const aerial = isAerialCompatCanvas(canvas);

  // 1. sharp 预裁剪（cover 微裁至画布；原生比例下构图已忠实，无人脸窗口）
  const framePath = await preprocessHeroFrame(photoPath, canvas.width, canvas.height);
  // 中间产物（raw 生成 / loop 拼接 / overlay 合成）——转码完成后逐级清理
  const rawPath = path.join(wallpaperVideoDir(), `${pickDate}-native-raw.mp4`);
  const nativeDstPath = path.join(wallpaperVideoDir(), `${pickDate}-native.mp4`);
  const aerialDstPath = path.join(wallpaperVideoDir(), `${pickDate}-landscape.mov`);
  let loopPath: string | null = null;
  let overlaidPath: string | null = null;
  try {
    // 2. spawn honeydo（双锚定伪循环：--first-frame 与 --last-frame 同图；seconds 默认 4；
    //    契约 6：-r 720p 保留保 stdout 回执语义，画布两轴经 --width/--height 显式覆盖）
    const seconds = clampWallpaperVideoSeconds(config.wallpaperVideoSeconds);
    log(
      `[wallpaper-video] ${pickDate} native ${canvas.width}×${canvas.height} 生成开始（seconds=${seconds}，aerial 兼容窗口=${aerial}）`,
    );
    await spawnHoneydoVideo({
      cliPath: config.honeydoCliPath,
      prompt,
      firstFrame: framePath,
      lastFrame: framePath,
      outPath: rawPath,
      seconds,
      res: WALLPAPER_VIDEO_RES,
      width: canvas.width,
      height: canvas.height,
      timeoutMs: config.wallpaperVideoSpawnTimeoutMs,
    });
    log(`[wallpaper-video] ${pickDate} native 生成完成 → ${rawPath}`);

    // 3. buildLoop：palindrome 拼接至 loopSeconds（默认 8s；4s 单条 ×2）
    const loop = await buildLoop(rawPath, config.wallpaperVideoLoopSeconds);
    loopPath = loop.loopPath;
    log(
      `[wallpaper-video] ${pickDate} native palindrome 拼接完成（segments=${loop.segments}）→ ${loopPath}`,
    );

    // 4. renderTextOverlay：Remotion 文字层合成（props 携画布宽高；comp 按画布比例选）
    const overlay = await renderTextOverlay(loopPath, {
      pickDate,
      title: meta.title,
      narrative: meta.narrative,
      takenAt: meta.takenAt,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    });
    overlaidPath = overlay.overlaidPath;
    log(`[wallpaper-video] ${pickDate} native 文字层合成完成 → ${overlaidPath}`);

    // 5. 转码 A（画廊原生）：H.264 mp4 无尺寸透传（分辨率==画布）+ 尺寸护栏
    await transcodeForGallery(overlaidPath, nativeDstPath);
    await assertVideoDimensions(nativeDstPath, canvas.width, canvas.height);
    log(
      `[wallpaper-video] ${pickDate} native 转码完成（${canvas.width}×${canvas.height}）→ ${nativeDstPath}`,
    );

    // 6. 转码 B（条件 Aerial）：画布比例 ∈ [1.5,1.9] 才产出 16:9 微裁 .mov + 尺寸护栏；
    //    窗口外不产出 → landscape 列保持空 → mac 当日走静态回退（WallpaperCoordinator 天然兼容）
    if (aerial) {
      await transcodeForAerialNative(overlaidPath, aerialDstPath);
      await assertVideoDimensions(aerialDstPath, 1920, 1080);
      log(`[wallpaper-video] ${pickDate} aerial 16:9 微裁转码完成（1920×1080）→ ${aerialDstPath}`);
    }

    // 中间产物清理（两条转码均成功后）
    await rm(rawPath, { force: true }).catch(() => {});
    await rm(loopPath, { force: true }).catch(() => {});
    await rm(overlaidPath, { force: true }).catch(() => {});

    // 7. COS 上传（回执 URL；失败/凭据缺失返回空串，不 throw）
    let nativeUrl = "";
    try {
      await access(nativeDstPath);
      nativeUrl = await uploadFile(
        nativeDstPath,
        wallpaperVideoNativeCosKey(pickDate),
        "video/mp4",
      );
      if (!nativeUrl) {
        log(`[wallpaper-video] ${pickDate} native COS 上传返回空串（失败/凭据缺失），不写 DB 列`);
      }
    } catch {
      log(`[wallpaper-video] ${pickDate} native 产物缺失，跳过上传: ${nativeDstPath}`);
    }

    let landscapeUrl = "";
    if (aerial) {
      try {
        await access(aerialDstPath);
        landscapeUrl = await uploadFile(
          aerialDstPath,
          wallpaperVideoLandscapeCosKey(pickDate),
          "video/quicktime",
        );
        if (!landscapeUrl) {
          log(`[wallpaper-video] ${pickDate} aerial COS 上传返回空串（失败/凭据缺失），不写 DB 列`);
        }
      } catch {
        log(`[wallpaper-video] ${pickDate} aerial 产物缺失，跳过上传: ${aerialDstPath}`);
      }
    }

    // 8. 回执非空串才写 DB 列（单行 UPDATE，合并两列）
    const cols: Record<string, string> = {};
    if (nativeUrl) cols.wallpaperVideoNativeUrl = nativeUrl;
    if (landscapeUrl) cols.wallpaperVideoLandscapeUrl = landscapeUrl;
    if (Object.keys(cols).length > 0) {
      await db.update(schema.dailyPicks).set(cols).where(eq(schema.dailyPicks.id, pickId));
    }
    log(
      `[wallpaper-video] ${pickDate} 完成 native=${nativeUrl || "（空）"} aerial=${landscapeUrl || "（空）"}`,
    );
    return { nativeUrl, landscapeUrl };
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
 * @returns native 与 16:9 兼容两条 COS URL（失败/跳过为空串——调用方/CLI 末行 JSON 契约）
 */
export async function runWallpaperVideo(
  pickDate: string,
  log: (m: string) => void = console.log,
): Promise<{ native: string; landscape: string }> {
  // 1. 开关关 → skip（当日回退静态，零 honeydo 调用）
  if (!config.wallpaperVideoEnabled) {
    log("[wallpaper-video] skip：功能开关关闭（DAILY_WALLPAPER_VIDEO=false），维持静态壁纸链路");
    return { native: "", landscape: "" };
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
    return { native: "", landscape: "" };
  }

  const photoRows = await db
    .select()
    .from(schema.photos)
    .where(eq(schema.photos.id, pick.photoId))
    .limit(1);
  const hero = photoRows[0];
  if (!hero) {
    log(`[wallpaper-video] skip：hero photoId=${pick.photoId} 不存在`);
    return { native: "", landscape: "" };
  }
  if ((hero.mediaType ?? "image") === "video") {
    log("[wallpaper-video] skip：hero 是视频，当日不出壁纸视频（Mac 走旧 dynamic HEIC 链路）");
    return { native: "", landscape: "" };
  }
  if (!pick.composedImagePath) {
    log("[wallpaper-video] skip：composedImagePath 为空（无静态壁纸，不生成视频）");
    return { native: "", landscape: "" };
  }

  // 前置校验（honeydo bin / ffmpeg / 原图 / Remotion 文字层工程四组存在）
  await assertVideoSpawnPrerequisites(hero.filePath);

  // 3. hero EXIF 旋转后尺寸 → 单腿原生画布（SSOT computeNativeCanvas）；
  //    faces 表取 hero 最大人脸 bbox（仅 prompt 分层默认；预裁剪已无人脸窗口）
  const dims = await readOrientedDimensions(hero.filePath);
  const canvas = computeNativeCanvas(dims.width, dims.height);
  log(
    `[wallpaper-video] ${pickDate} 原生画布 ${canvas.width}×${canvas.height}（原图 ${dims.width}×${dims.height}）`,
  );

  const faceBbox = await getLargestFaceBbox(hero.id);
  log(
    `[wallpaper-video] ${pickDate} 人脸 bbox=${
      faceBbox ? `${faceBbox.w}×${faceBbox.h}@(${faceBbox.x},${faceBbox.y})` : "无"
    }（仅 prompt 分层用）`,
  );

  await mkdir(wallpaperVideoDir(), { recursive: true });

  // 4. 单腿「生成→buildLoop→renderTextOverlay→双转码→上传→写列」；
  //    任一环节 throw → 旁路 log，当日回退静态（契约 8 两列均空，不影响精选主流程）
  const meta = { title: pick.title, narrative: pick.narrative, takenAt: hero.takenAt ?? null };
  // prompt 解析链（2026-09-13 契约修订）：AI narrate 的 motionPrompt 优先，
  // 缺失时按有无人脸分层默认（人物收敛 / 风景放开），不再全场景共用一句。
  const prompt =
    pick.motionPrompt?.trim() ||
    (faceBbox ? config.wallpaperVideoPromptPerson : config.wallpaperVideoPromptScene);
  log(
    `[wallpaper-video] ${pickDate} prompt 来源=${
      pick.motionPrompt?.trim() ? "AI motionPrompt" : faceBbox ? "默认人物" : "默认风景"
    }`,
  );
  let native = "";
  let landscape = "";
  try {
    const produced = await produceNativeSide({
      pickDate,
      pickId: pick.id,
      photoPath: hero.filePath,
      meta,
      prompt,
      canvas,
      log,
    });
    native = produced.nativeUrl;
    landscape = produced.landscapeUrl;
  } catch (err) {
    log(
      `[wallpaper-video] ${pickDate} native 腿失败（当日回退静态）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (err instanceof DimensionAssertError) {
      // 设计 D2/验收 5.P1：尺寸护栏失败必须传播（worker 标记 job 失败 / rerun CLI exit≠0）；
      // 两列未写 → 当日自然回退静态（契约 8 fail-safe 语义不变）
      throw err;
    }
    // 其余失败（spawn/上传/DB 等）→ 既有旁路容错：吞掉返回空列（契约 8，不影响精选主流程）
  }

  // 5. 画廊同步（复用 syncDayToGallery：重建 manifest + 推 VPS；幂等重传静态图无害）。
  //    旁路容错：失败 log 不 throw（画廊是旁路）。
  if (native || landscape) {
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
    `[wallpaper-video] ${pickDate} 完成 native=${native || "（空）"} landscape=${landscape || "（空）"}`,
  );
  return { native, landscape };
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

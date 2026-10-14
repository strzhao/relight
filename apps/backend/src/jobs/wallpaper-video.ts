import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";
/**
 * wallpaper-video Worker：每日精选完成后对 hero 照片做微动化，产出**单腿原生比例生成 +
 * 双排版卡分发**的壁纸视频（动态视频壁纸，state.md ## 后端设计 4 / ## 契约规约；
 * 20260928 单腿原生改版 + 20261009 排版解耦改版）。
 *
 * 触发：daily-selection 阶段 4 链式 enqueue（wallpaperVideoQueue.add，one-off，无 repeatable）。
 * 流程（runWallpaperVideo，20261009）：
 *   1. 开关关（config.wallpaperVideoEnabled）→ log skip 返回
 *   2. 取 dailyPicks + hero photo（无记录 / hero 是视频 / composedImagePath null → skip）
 *   3. faces 表取 hero 最大人脸 bbox（仅用于 prompt 分层默认；预裁剪已去除人脸窗口）
 *      + sharp 读 hero EXIF 旋转后尺寸 → computeNativeCanvas 算单腿原生画布
 *   4. 单腿串接（produceNativeSide）：
 *      preprocess（cover 微裁至画布）→ 生成引擎（20261014 双引擎二选一：
 *        h3c = antirez h3.c 原生 Metal BF16 零量化（默认，A/B 定案消除 int8 幻觉；
 *        画布预算钳到 H3C_CANVAS_PIXEL_BUDGET=768×1344）/
 *        honeydo = mmh3turbo int8（env WALLPAPER_VIDEO_ENGINE=honeydo 回滚）；
 *        seconds 默认 4，双锚定，honeydo 走 -r 720p + --width/--height 显式覆盖）
 *      → renderTextOverlay 双卡（20261014 起跳过 palindrome——倒放观感被否，单腿直出）
 *      → renderTextOverlay ×2（20261009 排版解耦：comp 尺寸恒定、与生成画布解耦——
 *        landscape=16:9 杂志卡 1920×1080（对齐 mac 静态壁纸观感；原生 loop 照片窗 contain）
 *        + portrait=竖版全屏卡 1290×2796（对齐手机静态壁纸 B 方案；loop cover 铺满））
 *      → 三条转码 + 尺寸护栏全过才上传/写列：
 *        转码 A（16:9 卡）：transcodeForGallery → 断言 1920×1080
 *          → 上传 `_native.mp4` key → 写 wallpaper_video_native_url（画廊主视频，布局==mac 壁纸）
 *        转码 B（竖版卡）：transcodeForGallery → 断言 1290×2796
 *          → 上传 `_portrait.mp4` key → 写 wallpaper_video_portrait_url（手机竖版动态壁纸复活）
 *        转码 C（Aerial）：16:9 卡已恒在兼容窗口——transcodeForAerialNative（16:9 输入恒等裁
 *          → 1920×1080 hvc1 .mov）→ 断言 → 上传 `_landscape.mov` key
 *          → 写 wallpaper_video_landscape_url（mac App 302 消费，恒产出不再看画布窗口）
 *   5. syncDayToGallery（复用，重建 manifest 推 VPS）
 *
 * 失败语义（契约 8）：任一环节 throw → 当日 native/portrait/landscape 三列均空
 * （护栏在任一回执列写入之前执行）→ 画廊静态卡 + mac 静态壁纸；job 不向调度层抛（旁路容错）。
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
  wallpaperVideoNativeCosKey,
  wallpaperVideoPortraitCosKey,
} from "../lib/gallery/manifest";
// 画布 SSOT（20260928 单腿原生）：computeNativeCanvas 从 native-canvas.ts 引入；
// 20261014 引擎感知预算：h3c 引擎传 H3C_CANVAS_PIXEL_BUDGET（引擎超限硬报错）
import { H3C_CANVAS_PIXEL_BUDGET, computeNativeCanvas } from "../lib/wallpaper/native-canvas";
import {
  DimensionAssertError,
  type FaceBbox,
  WALLPAPER_VIDEO_RES,
  assertVideoDimensions,
  assertVideoSpawnPrerequisites,
  clampWallpaperVideoSeconds,
  measureVideoMotion,
  preprocessHeroFrame,
  readOrientedDimensions,
  renderTextOverlay,
  spawnH3cVideo,
  spawnHoneydoVideo,
  transcodeForAerialNative,
  transcodeForGallery,
  withH3NegativeList,
  withMotionBoost,
} from "../lib/wallpaper/video";

/** 排版卡恒定尺寸（与 wallpaper-overlay Root.tsx 两 comp 一致；20261009 排版解耦） */
const LANDSCAPE_CARD_DIMS = { width: 1920, height: 1080 } as const;
const PORTRAIT_CARD_DIMS = { width: 1290, height: 2796 } as const;

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
 * 单腿「预裁剪→生成→双卡 renderTextOverlay→三转码→上传→写列」；失败 throw 给上层
 * （runWallpaperVideo 旁路：log 后当日回退静态——契约 8 三列均空）。
 *
 * 顺序刻意安排：**三条转码 + 尺寸护栏全部通过后才上传/写列**——护栏阻断（场景 5）时
 * native/portrait/landscape 三列必然均空，不产生「某列已入库但其余护栏失败」的半成品日。
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
}): Promise<{ nativeUrl: string; landscapeUrl: string; portraitUrl: string }> {
  const { pickDate, pickId, photoPath, meta, canvas, prompt, log } = opts;

  // 1. sharp 预裁剪（cover 微裁至画布；原生比例下构图已忠实，无人脸窗口）
  const framePath = await preprocessHeroFrame(photoPath, canvas.width, canvas.height);
  // 中间产物（raw 生成 / loop 拼接 / 双卡 overlay 合成）——转码完成后逐级清理
  const rawPath = path.join(wallpaperVideoDir(), `${pickDate}-native-raw.mp4`);
  // 终产物三件套：16:9 卡（画廊主视频）/ 竖版卡（手机）/ Aerial .mov（mac）
  const cardDstPath = path.join(wallpaperVideoDir(), `${pickDate}-native.mp4`);
  const portraitDstPath = path.join(wallpaperVideoDir(), `${pickDate}-portrait.mp4`);
  const aerialDstPath = path.join(wallpaperVideoDir(), `${pickDate}-landscape.mov`);
  let overlayLandscapePath: string | null = null;
  let overlayPortraitPath: string | null = null;
  try {
    // 2. spawn 生成引擎（20261014 双引擎：h3c = h3.c BF16 零量化（默认）/
    //    honeydo = mmh3turbo int8（回滚）；双锚定伪循环：--first-frame 与 --last-frame 同图；
    //    honeydo 契约 6：-r 720p 保留保 stdout 回执语义，画布两轴经 --width/--height 显式覆盖）
    //    20261014 运动量验收门：生成后实测峰值偏移，低于门槛且引擎可换 seed（h3c）时重试——
    //    同引擎同 prompt 不同 seed/画布的 draw 方差极大（实测 0.45%~9.32%），近静止样本不入库；
    //    全部尝试都不达标时取最优一支继续（发静态优于发空，门槛可经 env 归零关闭）。
    const seconds = clampWallpaperVideoSeconds(config.wallpaperVideoSeconds);
    const engine = config.wallpaperVideoEngine === "h3c" ? "h3c" : "honeydo";
    const maxAttempts = engine === "h3c" ? Math.max(1, config.wallpaperVideoMotionMaxAttempts) : 1;
    const minPeak = config.wallpaperVideoMotionMinPeak;
    log(
      `[wallpaper-video] ${pickDate} native ${canvas.width}×${canvas.height} 生成开始（engine=${engine} seconds=${seconds} 运动门≥${minPeak}%×${maxAttempts}次）`,
    );
    let attemptRawPath = rawPath;
    // peak -1 = 尚无实测；Infinity = 测量失败 fail-open 放行
    let best: { path: string; peak: number } = { path: rawPath, peak: -1 };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attemptRawPath =
        maxAttempts > 1
          ? path.join(wallpaperVideoDir(), `${pickDate}-native-raw-a${attempt}.mp4`)
          : rawPath;
      if (engine === "h3c") {
        const seed = config.h3c.seed + attempt - 1;
        // 动作强化阶梯：attempt 1 = L1 常规放大；attempt 2 = L2 激进修正
        // （重试换的是力度档位，不只是 seed——纯换 seed 实测无效）
        const boostLevel = attempt >= 2 ? 2 : 1;
        const boosted =
          engine === "h3c" && config.h3c.motionPromptBoost
            ? withMotionBoost(prompt, boostLevel)
            : prompt;
        // 负面清单护栏独立于动作强化开关（防幻觉加字/切镜/变形/自加配乐）
        const attemptPrompt = withH3NegativeList(boosted);
        log(
          `[wallpaper-video] ${pickDate} 尝试 ${attempt}/${maxAttempts}（seed=${seed}${config.h3c.lastFrameAnchor ? " 双锚定" : " 单锚定"}${config.h3c.motionPromptBoost ? ` 动作强化L${boostLevel}` : ""}）`,
        );
        await spawnH3cVideo({
          binPath: config.h3c.binPath,
          modelDir: config.h3c.modelDir,
          prompt: attemptPrompt,
          firstFrame: framePath,
          // 20261014 定案：双锚两端钉死保人脸身份（单锚中段 ArcFace cos 崩到
          // 0.09~0.76，双锚 0.83~0.97）；运动量靠动作强化后缀（原 prompt 生产
          // peak 0.45% → 强化后 8.91%），不再靠去锚。回环由 palindrome 镜像保证
          lastFrame: config.h3c.lastFrameAnchor ? framePath : undefined,
          outPath: attemptRawPath,
          seconds,
          width: canvas.width,
          height: canvas.height,
          timeoutMs: config.wallpaperVideoSpawnTimeoutMs,
          steps: config.h3c.steps,
          layers: config.h3c.layers,
          reuse: config.h3c.reuse,
          seed,
          ssdStreaming: config.h3c.ssdStreaming,
        });
      } else {
        await spawnHoneydoVideo({
          cliPath: config.honeydoCliPath,
          prompt,
          firstFrame: framePath,
          lastFrame: framePath,
          outPath: attemptRawPath,
          seconds,
          res: WALLPAPER_VIDEO_RES,
          width: canvas.width,
          height: canvas.height,
          timeoutMs: config.wallpaperVideoSpawnTimeoutMs,
        });
      }
      // 运动量实测（fail-open：测量异常不阻塞发布，仅告警放行）
      let motion: Awaited<ReturnType<typeof measureVideoMotion>> | null = null;
      try {
        motion = await measureVideoMotion(attemptRawPath);
      } catch (e) {
        log(
          `[wallpaper-video] ${pickDate} 运动量测量失败（fail-open 放行）: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      if (motion) {
        log(
          `[wallpaper-video] ${pickDate} 运动量 peak=${motion.peak.toFixed(2)}% 帧间avg=${motion.fdiffAvg.toFixed(3)}%（门槛 ${minPeak}%）`,
        );
        if (motion.peak > best.peak) best = { path: attemptRawPath, peak: motion.peak };
        if (motion.peak >= minPeak) break;
        if (attempt < maxAttempts) {
          log(`[wallpaper-video] ${pickDate} 运动量低于门槛，换 seed 重试`);
        }
      } else {
        // 测量失败 fail-open：视为达标放行（不再重试）
        best = { path: attemptRawPath, peak: Number.POSITIVE_INFINITY };
        break;
      }
    }
    // 把最优一支归位到规范 raw 路径，清理未入选的尝试产物
    if (best.path !== rawPath) {
      await rename(best.path, rawPath).catch(async () => {
        // 同目录 rename 不应失败；兜底拷贝防御性保留
        await copyFile(best.path, rawPath);
        await rm(best.path, { force: true }).catch(() => {});
      });
    }
    for (let i = 1; i <= maxAttempts; i++) {
      const p = path.join(wallpaperVideoDir(), `${pickDate}-native-raw-a${i}.mp4`);
      if (p !== best.path) await rm(p, { force: true }).catch(() => {});
    }
    if (best.peak !== Number.POSITIVE_INFINITY && best.peak >= 0) {
      log(
        `[wallpaper-video] ${pickDate} 运动门通过/取优：peak=${best.peak.toFixed(2)}%（门槛 ${minPeak}%）`,
      );
    }
    log(`[wallpaper-video] ${pickDate} native 生成完成 → ${rawPath}`);

    // 3. renderTextOverlay ×2（20261009 排版解耦；20261014 起跳过 palindrome 拼接——
    //    用户裁决倒放观感诡异，单腿直出，回环由双锚定首尾归位 + 播放器循环保证）：
    //    同一原生腿合成两张排版卡——16:9 杂志卡（布局==mac 静态壁纸，照片窗 contain）
    //    + 竖版全屏卡（==手机静态壁纸 B 方案，cover）
    const overlayMeta = {
      pickDate,
      title: meta.title,
      narrative: meta.narrative,
      takenAt: meta.takenAt,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    };
    const overlayLandscape = await renderTextOverlay(rawPath, overlayMeta, "landscape");
    overlayLandscapePath = overlayLandscape.overlaidPath;
    log(`[wallpaper-video] ${pickDate} 16:9 卡文字层合成完成 → ${overlayLandscapePath}`);
    const overlayPortrait = await renderTextOverlay(rawPath, overlayMeta, "portrait");
    overlayPortraitPath = overlayPortrait.overlaidPath;
    log(`[wallpaper-video] ${pickDate} 竖版卡文字层合成完成 → ${overlayPortraitPath}`);

    // 5. 三条转码 + 尺寸护栏（全过才进入上传/写列）
    //    A（16:9 卡）：H.264 mp4 → 画廊主视频 + Aerial 转码源
    await transcodeForGallery(overlayLandscapePath, cardDstPath);
    await assertVideoDimensions(cardDstPath, LANDSCAPE_CARD_DIMS.width, LANDSCAPE_CARD_DIMS.height);
    log(
      `[wallpaper-video] ${pickDate} 16:9 卡转码完成（${LANDSCAPE_CARD_DIMS.width}×${LANDSCAPE_CARD_DIMS.height}）→ ${cardDstPath}`,
    );
    //    B（竖版卡）：H.264 mp4 → 手机竖版动态壁纸
    await transcodeForGallery(overlayPortraitPath, portraitDstPath);
    await assertVideoDimensions(
      portraitDstPath,
      PORTRAIT_CARD_DIMS.width,
      PORTRAIT_CARD_DIMS.height,
    );
    log(
      `[wallpaper-video] ${pickDate} 竖版卡转码完成（${PORTRAIT_CARD_DIMS.width}×${PORTRAIT_CARD_DIMS.height}）→ ${portraitDstPath}`,
    );
    //    C（Aerial）：16:9 卡输入 → 恒等裁（crop filter 对 16:9 为 no-op）→ hvc1 .mov；
    //    20261009 起源恒 16:9，不再依赖画布比例窗口 → mac 恒拿到动态壁纸
    await transcodeForAerialNative(cardDstPath, aerialDstPath);
    await assertVideoDimensions(
      aerialDstPath,
      LANDSCAPE_CARD_DIMS.width,
      LANDSCAPE_CARD_DIMS.height,
    );
    log(`[wallpaper-video] ${pickDate} aerial 16:9 转码完成（1920×1080）→ ${aerialDstPath}`);

    // 中间产物清理（三条转码均成功后）
    await rm(rawPath, { force: true }).catch(() => {});
    await rm(overlayLandscapePath, { force: true }).catch(() => {});
    await rm(overlayPortraitPath, { force: true }).catch(() => {});

    // 6. COS 上传（回执 URL；失败/凭据缺失返回空串，不 throw）
    let nativeUrl = "";
    try {
      await access(cardDstPath);
      nativeUrl = await uploadFile(cardDstPath, wallpaperVideoNativeCosKey(pickDate), "video/mp4");
      if (!nativeUrl) {
        log(`[wallpaper-video] ${pickDate} 16:9 卡 COS 上传返回空串（失败/凭据缺失），不写 DB 列`);
      }
    } catch {
      log(`[wallpaper-video] ${pickDate} 16:9 卡产物缺失，跳过上传: ${cardDstPath}`);
    }

    let portraitUrl = "";
    try {
      await access(portraitDstPath);
      portraitUrl = await uploadFile(
        portraitDstPath,
        wallpaperVideoPortraitCosKey(pickDate),
        "video/mp4",
      );
      if (!portraitUrl) {
        log(`[wallpaper-video] ${pickDate} 竖版卡 COS 上传返回空串（失败/凭据缺失），不写 DB 列`);
      }
    } catch {
      log(`[wallpaper-video] ${pickDate} 竖版卡产物缺失，跳过上传: ${portraitDstPath}`);
    }

    let landscapeUrl = "";
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

    // 7. 回执非空串才写 DB 列（单行 UPDATE，合并三列）
    const cols: Record<string, string> = {};
    if (nativeUrl) cols.wallpaperVideoNativeUrl = nativeUrl;
    if (landscapeUrl) cols.wallpaperVideoLandscapeUrl = landscapeUrl;
    if (portraitUrl) cols.wallpaperVideoPortraitUrl = portraitUrl;
    if (Object.keys(cols).length > 0) {
      await db.update(schema.dailyPicks).set(cols).where(eq(schema.dailyPicks.id, pickId));
    }
    log(
      `[wallpaper-video] ${pickDate} 完成 native=${nativeUrl || "（空）"} portrait=${portraitUrl || "（空）"} aerial=${landscapeUrl || "（空）"}`,
    );
    return { nativeUrl, landscapeUrl, portraitUrl };
  } finally {
    await rm(framePath, { force: true }).catch(() => {});
    // 失败路径清理已产出的中间产物（成功路径已在上方清理）
    if (overlayLandscapePath) await rm(overlayLandscapePath, { force: true }).catch(() => {});
    if (overlayPortraitPath) await rm(overlayPortraitPath, { force: true }).catch(() => {});
  }
}

/**
 * 壁纸视频主流程（Worker 与 rerun CLI 共用）。
 *
 * @returns native（16:9 卡）/ portrait（竖版卡）/ landscape（Aerial .mov）三条 COS URL
 * （失败/跳过为空串——调用方/CLI 末行 JSON 契约）
 */
export async function runWallpaperVideo(
  pickDate: string,
  log: (m: string) => void = console.log,
): Promise<{ native: string; landscape: string; portrait: string }> {
  // 1. 开关关 → skip（当日回退静态，零 honeydo 调用）
  if (!config.wallpaperVideoEnabled) {
    log("[wallpaper-video] skip：功能开关关闭（DAILY_WALLPAPER_VIDEO=false），维持静态壁纸链路");
    return { native: "", landscape: "", portrait: "" };
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
    return { native: "", landscape: "", portrait: "" };
  }

  const photoRows = await db
    .select()
    .from(schema.photos)
    .where(eq(schema.photos.id, pick.photoId))
    .limit(1);
  const hero = photoRows[0];
  if (!hero) {
    log(`[wallpaper-video] skip：hero photoId=${pick.photoId} 不存在`);
    return { native: "", landscape: "", portrait: "" };
  }
  if ((hero.mediaType ?? "image") === "video") {
    log("[wallpaper-video] skip：hero 是视频，当日不出壁纸视频（Mac 走旧 dynamic HEIC 链路）");
    return { native: "", landscape: "", portrait: "" };
  }
  if (!pick.composedImagePath) {
    log("[wallpaper-video] skip：composedImagePath 为空（无静态壁纸，不生成视频）");
    return { native: "", landscape: "", portrait: "" };
  }

  // 前置校验（honeydo bin / ffmpeg / 原图 / Remotion 文字层工程四组存在）
  await assertVideoSpawnPrerequisites(hero.filePath);

  // 3. hero EXIF 旋转后尺寸 → 单腿原生画布（SSOT computeNativeCanvas；20261014 引擎感知
  //    预算：h3c 引擎像素积钳到 768×1344，honeydo 维持 1177600）；
  //    faces 表取 hero 最大人脸 bbox（仅 prompt 分层默认；预裁剪已无人脸窗口）
  const dims = await readOrientedDimensions(hero.filePath);
  const canvas =
    config.wallpaperVideoEngine === "h3c"
      ? computeNativeCanvas(dims.width, dims.height, { maxPixels: H3C_CANVAS_PIXEL_BUDGET })
      : computeNativeCanvas(dims.width, dims.height);
  log(
    `[wallpaper-video] ${pickDate} 原生画布 ${canvas.width}×${canvas.height}（原图 ${dims.width}×${dims.height}，engine=${config.wallpaperVideoEngine}）`,
  );

  const faceBbox = await getLargestFaceBbox(hero.id);
  log(
    `[wallpaper-video] ${pickDate} 人脸 bbox=${
      faceBbox ? `${faceBbox.w}×${faceBbox.h}@(${faceBbox.x},${faceBbox.y})` : "无"
    }（仅 prompt 分层用）`,
  );

  await mkdir(wallpaperVideoDir(), { recursive: true });

  // 4. 单腿「生成→renderTextOverlay 双卡→三转码→上传→写列」；
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
  let portrait = "";
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
    portrait = produced.portraitUrl;
  } catch (err) {
    log(
      `[wallpaper-video] ${pickDate} native 腿失败（当日回退静态）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (err instanceof DimensionAssertError) {
      // 设计 D2/验收 5.P1：尺寸护栏失败必须传播（worker 标记 job 失败 / rerun CLI exit≠0）；
      // 三列未写 → 当日自然回退静态（契约 8 fail-safe 语义不变）
      throw err;
    }
    // 其余失败（spawn/上传/DB 等）→ 既有旁路容错：吞掉返回空列（契约 8，不影响精选主流程）
  }

  // 5. 画廊同步（复用 syncDayToGallery：重建 manifest + 推 VPS；幂等重传静态图无害）。
  //    旁路容错：失败 log 不 throw（画廊是旁路）。
  if (native || landscape || portrait) {
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
    `[wallpaper-video] ${pickDate} 完成 native=${native || "（空）"} portrait=${portrait || "（空）"} landscape=${landscape || "（空）"}`,
  );
  return { native, landscape, portrait };
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

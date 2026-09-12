/**
 * 壁纸视频生成模块（动态视频壁纸，state.md ## 后端设计 3 / ## 契约规约 计算/spawn 契约；v2 增量任务 12-15）
 *
 *   preprocessHeroFrame(photoPath, width, height, opts) → tmp png 绝对路径
 *     sharp cover 裁剪+resize 到目标画布比例（横 1280×704 / 竖 704×1216，32 倍数约束）。
 *     v2 人脸构图裁剪：opts.faceBbox（faces 表最大 bbox）→「脸占画布高度 ≥1/4」推 crop
 *     窗口（中心对齐人脸）；缺失/退化 → 回退现状中心构图。
 *     honeydo first-frame 引擎直接 LANCZOS 拉伸到画布——调用方必须先按画布比例 cover-crop，
 *     否则非 16:9 源图会被拉变形。
 *
 *   spawnHoneydoVideo({cliPath, prompt, firstFrame, lastFrame, outPath, seconds, res, timeoutMs})
 *     → {outPath, duration, stdout}
 *     照 claude-runner 骨架：绝对路径 spawn、stdio ["ignore","pipe","pipe"]、AbortController 超时、
 *     stdout 累积后 JSON.parse 取 {out, duration, res}，stderr 累积留证；
 *     非零退出 / JSON 解析失败 / 产物文件不存在 / 超时 abort → throw HoneydoSpawnError
 *     （message 含 stdout tail ≤2000 字符与超时毫秒数）。
 *
 *   buildLoop(src, targetSeconds) → {loopPath, segments}（v2 增量任务 13）
 *     palindrome 拼接（split/reverse/concat，forward+reverse 交替；音轨 areverse 同构）
 *     至 ≥targetSeconds ∧ 偶数段；错误枚举 LoopBuildError（ffmpeg 失败 / 拼接后时长 < targetSeconds-1）。
 *
 *   renderTextOverlay(videoPath, meta, opts) → {overlaidPath}（v2 增量任务 14）
 *     spawn `npx remotion render`（cwd=videoWorkspacePath/wallpaper-overlay 工程、npx 绝对路径、
 *     AbortController 900s 超时（v2.1）、stdout tail 留证）；错误枚举 OverlayRenderError
 *     （工程/Remotion 运行时缺失不自动安装 / 非零退出 / 产物缺失 / 超时）。
 *
 *   transcodeForAerial(src, dst)：HEVC(hvc1) .mov 1920×1080 无音轨 +faststart（Aerial 用，
 *     v2 输入=Remotion 成品）。hevc_videotoolbox 失败 fallback libx265。超时 600s。
 *   transcodeForGallery(src, dst)（v2）：H.264 mp4 重编码保留音轨（libx264 crf18 + aac 128k
 *     +faststart，画廊静音自动播放+点击开声）。超时 120s。
 *
 *   assertVideoSpawnPrerequisites(photoPath)：honeydo bin、ffmpeg、原图路径 +
 *     wallpaper-overlay 工程/Remotion 运行时/字体 存在校验（缺失报错，不自动安装）。
 */
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config";
import { convertHeicToJpeg, isHeicBuffer } from "../heic";

// ============================================================================
// 画布与档位常量（honeydo 32 倍数约束：720p=1280×704、portrait=704×1216）
// ============================================================================

/** 横版生成画布（honeydo res 档 720p） */
export const WALLPAPER_VIDEO_LANDSCAPE_CANVAS = { width: 1280, height: 704 } as const;
/** 竖版生成画布（honeydo res 档 portrait） */
export const WALLPAPER_VIDEO_PORTRAIT_CANVAS = { width: 704, height: 1216 } as const;
/** honeydo res 档位：横版 */
export const WALLPAPER_VIDEO_LANDSCAPE_RES = "720p";
/** honeydo res 档位：竖版 */
export const WALLPAPER_VIDEO_PORTRAIT_RES = "portrait";

// ============================================================================
// HoneydoSpawnError
// ============================================================================

/** spawn honeydo 失败（非零退出 / JSON 解析失败 / 产物缺失 / 超时 abort） */
export class HoneydoSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoneydoSpawnError";
  }
}

/** stdout tail 上限（契约：message 含 stdout tail ≤2000 字符） */
const STDOUT_TAIL_LIMIT = 2000;

function stdoutTail(stdout: string): string {
  const tail = stdout.slice(-STDOUT_TAIL_LIMIT);
  return tail || "（空）";
}

// ============================================================================
// preprocessHeroFrame（v2：人脸构图裁剪）
// ============================================================================

/** 人脸 bbox（EXIF 旋转后原图像素坐标——detect-faces 主流程 rotate 后检测，同空间） */
export interface FaceBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PreprocessHeroFrameOptions {
  /** hero 照片 faces 表最大 bbox（面积最大）；null/缺省 → 回退现状中心构图（契约） */
  faceBbox?: FaceBbox | null;
}

/**
 * 「脸占画布 ≥1/4」的裁剪窗口推导（recipes 纪律：人脸占比 ≥1/4）。
 *
 * 口径：脸 bbox 高度映射到画布后 ≥ 画布高度的 1/4（横竖版同为「脸高占画幅高 ≥1/4」）。
 * 缩放关系 face_canvas_h = fh × canvasH / winH ⟹ 约束 ⟺ 窗口高 winH ≤ 4 × fh。
 * 窗口高 = clamp(4×fh, 下限=画布高（防输入图超分放大，画质优先）, 上限=全幅 cover 窗口高
 * （脸在整图已 ≥1/4 时不再放大）)；窗口宽 = 窗口高 × 画布比例；中心对齐人脸中心，clamp 图内。
 *
 * @returns 裁剪窗口 {left, top, width, height}；无法按人脸构图时返回 null（中心构图回退）
 */
function computeFaceCropWindow(
  imgW: number,
  imgH: number,
  canvasW: number,
  canvasH: number,
  face: FaceBbox,
): { left: number; top: number; width: number; height: number } | null {
  // bbox 合法性：先 clamp 进图内，退化（宽/高 ≤0）则放弃人脸构图
  const fx = Math.min(Math.max(face.x, 0), imgW - 1);
  const fy = Math.min(Math.max(face.y, 0), imgH - 1);
  const fw = Math.min(face.w, imgW - fx);
  const fh = Math.min(face.h, imgH - fy);
  if (!(fw > 0 && fh > 0)) return null;

  const ratio = canvasW / canvasH;
  // 全幅 cover 窗口高（保持画布比例的最大窗口）
  const fullH = Math.min(imgH, imgW / ratio);
  // 下限：窗口高 ≥ 画布高 → 缩放系数 ≤1，不超分放大（v2 画质优先）
  const minWinH = Math.min(canvasH, fullH);
  const winH = Math.min(Math.max(Math.min(fullH, 4 * fh), minWinH), imgH);
  const winW = Math.min(Math.round(winH * ratio), imgW);
  const winHr = Math.round(winH);

  // 窗口中心对齐人脸中心，clamp 到图内
  const cx = fx + fw / 2;
  const cy = fy + fh / 2;
  const left = Math.min(Math.max(Math.round(cx - winW / 2), 0), imgW - winW);
  const top = Math.min(Math.max(Math.round(cy - winHr / 2), 0), imgH - winHr);
  return { left, top, width: winW, height: winHr };
}

/**
 * hero 原图预裁剪：sharp cover 裁剪+resize 到目标画布（width×height），产 tmp png。
 *
 * HEIC 源先经 convertHeicToJpeg 解码（复用 lib/heic，与 composer 同源）；
 * .rotate() 按 EXIF 方向摆正后再裁剪（faces bbox 与 detect-faces 同为 rotate 后空间）。
 *
 * v2 人脸构图裁剪：opts.faceBbox 非空 → 按「脸占画布 ≥1/4」推 crop 窗口（中心对齐人脸）；
 * 缺失/退化 → 回退现状中心构图（契约）。
 *
 * @returns tmp png 绝对路径（调用方负责清理）
 */
export async function preprocessHeroFrame(
  photoPath: string,
  width: number,
  height: number,
  opts: PreprocessHeroFrameOptions = {},
): Promise<string> {
  let buf = await import("node:fs/promises").then((m) => m.readFile(photoPath));
  if (isHeicBuffer(buf)) {
    buf = await convertHeicToJpeg(buf, { quality: 90 }); // 不预缩：faces bbox 是旋转后原图像素坐标，预缩会错配（v2.1 修复）
  }
  const outPath = path.join(
    tmpdir(),
    `wallpaper-video-frame-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );

  if (opts.faceBbox) {
    // 人脸构图：先 rotate 摆正拿真实尺寸，再按窗口 extract → resize（两步避免模糊语义）
    const rotated = await sharp(buf).rotate().toBuffer();
    const meta = await sharp(rotated).metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    const win =
      imgW > 0 && imgH > 0 ? computeFaceCropWindow(imgW, imgH, width, height, opts.faceBbox) : null;
    if (win) {
      await sharp(rotated)
        .extract(win)
        .resize(width, height, { fit: "cover" })
        .png()
        .toFile(outPath);
      return outPath;
    }
    // bbox 退化 → 落入中心构图回退
  }

  await sharp(buf)
    .rotate()
    .resize(width, height, { fit: "cover", position: "centre" })
    .png()
    .toFile(outPath);
  return outPath;
}

// ============================================================================
// spawnHoneydoVideo
// ============================================================================

export interface HoneydoVideoOptions {
  /** honeydo CLI 绝对路径（config.honeydoCliPath） */
  cliPath: string;
  /** 生成 prompt（config.wallpaperVideoPrompt） */
  prompt: string;
  /** 首帧图路径（预裁剪 tmp png） */
  firstFrame: string;
  /** 尾帧图路径（双锚定伪循环：与 firstFrame 同图） */
  lastFrame: string;
  /** 产物 mp4 路径 */
  outPath: string;
  /** 时长秒（1-15；越界由 honeydo exit 2 兜底为 HoneydoSpawnError） */
  seconds: number;
  /** 分辨率档（720p / portrait） */
  res: string;
  /** 超时 ms（默认 config.wallpaperVideoSpawnTimeoutMs，NaN/≤0 → 5400000） */
  timeoutMs?: number;
}

export interface HoneydoVideoResult {
  outPath: string;
  duration: number;
  stdout: string;
}

/** honeydo video gen stdout 机读 JSON 形状 */
interface HoneydoJsonOutput {
  out?: string;
  duration?: number | string;
  res?: string;
}

const DEFAULT_HONEYDO_TIMEOUT_MS = 5_400_000;

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  const v = timeoutMs ?? config.wallpaperVideoSpawnTimeoutMs;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_HONEYDO_TIMEOUT_MS;
}

/**
 * spawn honeydo video gen（首尾帧双锚定图生视频）。
 *
 * 成功：stdout 机读 JSON（{out, duration, res}）→ 返回 {outPath, duration, stdout}。
 * 失败：非零退出 / JSON 解析失败 / 产物文件不存在 / 超时 → HoneydoSpawnError。
 */
export async function spawnHoneydoVideo(opts: HoneydoVideoOptions): Promise<HoneydoVideoResult> {
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);

  const args = [
    "video",
    "gen",
    opts.prompt,
    "--first-frame",
    opts.firstFrame,
    "--last-frame",
    opts.lastFrame,
    "-o",
    opts.outPath,
    "-r",
    opts.res,
    "--seconds",
    String(opts.seconds),
  ];

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const proc = spawn(opts.cliPath, args, {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      // 超时 SIGTERM（manual kill 而非 AbortController signal：'error' AbortError 会在
      // stdio 冲刷前触发，stdout tail 会丢——契约要求超时 message 含 stdout tail，
      // 因此 kill 后等 'close'（stdio 全部冲刷完）再走超时分支）。
      // SIGTERM 后 5s 仍未退出（子进程持有 stdio / 忽略 TERM）→ SIGKILL 升级。
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGTERM");
        } catch {
          // 已退出忽略
        }
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // 已退出忽略
          }
        }, 5_000).unref();
      }, timeoutMs);
      proc.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve(code ?? -1);
      });
    });

    if (timedOut) {
      throw new HoneydoSpawnError(
        `honeydo video gen 超时（${timeoutMs}ms）（stdout=${stdoutTail(stdout)}）`,
      );
    }

    if (exitCode !== 0) {
      throw new HoneydoSpawnError(
        `honeydo video gen 退出码 ${exitCode}（stderr=${stderr.slice(-500) || "（空）"} | stdout=${stdoutTail(stdout)}）`,
      );
    }

    // stdout 机读 JSON 解析：整体 parse，失败再从尾部按行找 JSON 对象（容进度行混入）
    let parsed: HoneydoJsonOutput | null = null;
    try {
      parsed = JSON.parse(stdout.trim()) as HoneydoJsonOutput;
    } catch {
      const lines = stdout.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line || !line.startsWith("{")) continue;
        try {
          parsed = JSON.parse(line) as HoneydoJsonOutput;
          break;
        } catch {
          // 继续向前找
        }
      }
    }
    if (!parsed || typeof parsed !== "object") {
      throw new HoneydoSpawnError(
        `honeydo video gen stdout 非 JSON（stdout=${stdoutTail(stdout)}）`,
      );
    }

    const producedPath = typeof parsed.out === "string" && parsed.out ? parsed.out : opts.outPath;
    // 产物文件存在校验
    try {
      await access(producedPath);
    } catch {
      throw new HoneydoSpawnError(
        `honeydo video gen 产物文件不存在: ${producedPath}（stdout=${stdoutTail(stdout)}）`,
      );
    }

    const duration = Number(parsed.duration ?? 0);
    return {
      outPath: producedPath,
      duration: Number.isFinite(duration) ? duration : 0,
      stdout,
    };
  } catch (e) {
    if (e instanceof HoneydoSpawnError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new HoneydoSpawnError(`honeydo video gen spawn 失败: ${msg}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ============================================================================
// ffmpeg 转码
// ============================================================================

/** ffmpeg 超时：Aerial 转码 600s / 画廊 remux 120s */
const AERIAL_TRANSCODE_TIMEOUT_MS = 600_000;
const GALLERY_TRANSCODE_TIMEOUT_MS = 120_000;

function spawnFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let stderr = "";
    const proc = spawn(config.video.ffmpegPath, args, {
      signal: ac.signal,
      killSignal: "SIGTERM",
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}（stderr=${stderr.slice(-500)}）`));
    });
  });
}

/**
 * Aerial 用转码：HEVC(hvc1) .mov 1920×1080 无音轨 +faststart。
 *
 * hevc_videotoolbox 失败（非本机硬件编码器/旧系统）→ fallback libx265 -crf 22。
 * 超时 600s。
 */
export async function transcodeForAerial(src: string, dst: string): Promise<void> {
  const common = [
    "-y",
    "-i",
    src,
    "-vf",
    "scale=1920:1080:flags=lanczos",
    "-an",
    "-movflags",
    "+faststart",
  ];
  try {
    await spawnFfmpeg(
      [...common, "-c:v", "hevc_videotoolbox", "-b:v", "8M", "-tag:v", "hvc1", dst],
      AERIAL_TRANSCODE_TIMEOUT_MS,
    );
  } catch {
    await spawnFfmpeg(
      [...common, "-c:v", "libx265", "-crf", "22", "-tag:v", "hvc1", dst],
      AERIAL_TRANSCODE_TIMEOUT_MS,
    );
  }
}

/**
 * 画廊用转码（v2）：H.264 mp4 重编码，**保留音轨**（libx264 crf18 + aac 128k +faststart）。
 * 输入 = Remotion 文字层成品（同分辨率）；画廊静音自动播放 + 点击开声。超时 120s。
 */
export async function transcodeForGallery(src: string, dst: string): Promise<void> {
  await spawnFfmpeg(
    [
      "-y",
      "-i",
      src,
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      dst,
    ],
    GALLERY_TRANSCODE_TIMEOUT_MS,
  );
}

// ============================================================================
// buildLoop（v2 增量任务 13：palindrome 拼接至目标时长）
// ============================================================================

/** buildLoop 拼接失败（ffmpeg 失败 / 拼接后时长 < targetSeconds-1） */
export class LoopBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopBuildError";
  }
}

/** renderTextOverlay 失败（remotion 非零退出 / 产物缺失 / 超时 900s，v2.1） */
export class OverlayRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverlayRenderError";
  }
}

export interface LoopBuildResult {
  loopPath: string;
  segments: number;
}

/** loopSeconds 兜底默认（契约：默认 8；env 解析 NaN/非法时防御） */
const DEFAULT_LOOP_SECONDS = 8;
/** palindrome 拼接超时（reverse 需全片缓冲，90 帧级毫秒完成；600s 冗余） */
const LOOP_BUILD_TIMEOUT_MS = 600_000;

interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

/** ffprobe 探测容器/流信息（时长/分辨率/帧率/是否有音轨） */
async function probeVideoFile(p: string): Promise<ProbeResult> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const stdout = await promisify(execFile)(
    config.video.ffprobePath,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", p],
    { timeout: 30_000 },
  ).then((r) => r.stdout as string);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
    }>;
  };
  const videoStream = (parsed.streams ?? []).find((s) => s.codec_type === "video");
  const fpsStr = videoStream?.avg_frame_rate || videoStream?.r_frame_rate || "24/1";
  const [num, den] = fpsStr.split("/").map((n) => Number(n));
  const fps = num !== undefined && den !== undefined && den > 0 ? num / den : 24;
  return {
    duration: Number(parsed.format?.duration ?? 0),
    width: videoStream?.width ?? 0,
    height: videoStream?.height ?? 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 24,
    hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === "audio"),
  };
}

/**
 * palindrome 拼接（v2 增量任务 13）：forward+reverse 一对来回，无缝循环。
 *
 * 单段时长 d → 2k 段（k = ceil(target / 2d)），产物时长 ≈ 2k·d ≥ target ∧ 偶数段
 * （契约：产物时长 ≥ targetSeconds ∧ 为单段时长整数倍 ±1 帧容差）。
 * 音轨同构 palindrome（odd 段 areverse），保证画廊轨有环境音；无音轨源 → 纯视频。
 * 重编码 libx264 crf17（reverse/concat 必须经滤镜重编码）。
 *
 * 错误枚举 LoopBuildError：ffprobe 失败 / ffmpeg 失败 / 拼接后时长 < targetSeconds-1。
 */
export async function buildLoop(src: string, targetSeconds: number): Promise<LoopBuildResult> {
  const t =
    Number.isFinite(targetSeconds) && targetSeconds > 0 ? targetSeconds : DEFAULT_LOOP_SECONDS;

  let probe: ProbeResult;
  try {
    probe = await probeVideoFile(src);
  } catch (e) {
    throw new LoopBuildError(
      `buildLoop ffprobe 探测失败: ${e instanceof Error ? e.message : String(e)} (${src})`,
    );
  }
  const srcDur = probe.duration;
  if (!(srcDur > 0)) {
    throw new LoopBuildError(`buildLoop 源时长无效: ${srcDur}s (${src})`);
  }

  const pairs = Math.max(1, Math.ceil(t / (2 * srcDur)));
  const segments = pairs * 2;
  const loopPath = path.join(
    path.dirname(src),
    `${path.basename(src).replace(/\.mp4$/i, "")}-loop.mp4`,
  );

  // filter_complex：split 2k → odd 段 reverse/areverse → concat（forward,reverse,… 交替）
  const n = segments;
  const parts: string[] = [];
  const vLabels: string[] = [];
  const aLabels: string[] = [];
  for (let i = 0; i < n; i++) {
    vLabels.push(`[v${i}]`);
    if (probe.hasAudio) aLabels.push(`[a${i}]`);
  }
  parts.push(`[0:v]split=${n}${vLabels.join("")}`);
  if (probe.hasAudio) parts.push(`[0:a]asplit=${n}${aLabels.join("")}`);
  for (let i = 1; i < n; i += 2) {
    parts.push(`[v${i}]reverse[rv${i}]`);
    if (probe.hasAudio) parts.push(`[a${i}]areverse[ra${i}]`);
  }
  // concat 输入按段交错：段 i = [视频][音频]（v=1:a=1 时 concat 要求逐段 视频+音频 成对）
  const concatIn: string[] = [];
  for (let i = 0; i < n; i++) {
    concatIn.push(i % 2 === 1 ? `[rv${i}]` : `[v${i}]`);
    if (probe.hasAudio) concatIn.push(i % 2 === 1 ? `[ra${i}]` : `[a${i}]`);
  }
  parts.push(
    `${concatIn.join("")}concat=n=${n}:v=1:a=${probe.hasAudio ? 1 : 0}[vout]${probe.hasAudio ? "[aout]" : ""}`,
  );
  const filterComplex = parts.join(";");

  const args = [
    "-y",
    "-i",
    src,
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    ...(probe.hasAudio ? ["-map", "[aout]"] : []),
    "-c:v",
    "libx264",
    "-crf",
    "17",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    ...(probe.hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    "-movflags",
    "+faststart",
    loopPath,
  ];
  try {
    await spawnFfmpeg(args, LOOP_BUILD_TIMEOUT_MS);
  } catch (e) {
    throw new LoopBuildError(
      `buildLoop ffmpeg 拼接失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 产物时长校验（契约错误分支：拼接后时长 < targetSeconds-1 → LoopBuildError）
  let out: ProbeResult;
  try {
    out = await probeVideoFile(loopPath);
  } catch (e) {
    throw new LoopBuildError(
      `buildLoop 产物探测失败: ${e instanceof Error ? e.message : String(e)} (${loopPath})`,
    );
  }
  if (out.duration < t - 1) {
    throw new LoopBuildError(
      `buildLoop 拼接后时长 ${out.duration.toFixed(3)}s < ${t - 1}s（target=${t}s, segments=${n}）`,
    );
  }
  return { loopPath, segments };
}

// ============================================================================
// renderTextOverlay（v2 增量任务 14：Remotion 文字层合成）
// ============================================================================

export interface TextOverlayMeta {
  /** 精选日期 YYYY-MM-DD（masthead 日期 + footer「拍摄于 …」） */
  pickDate: string;
  /** 主标题 */
  title: string;
  /** 叙事文案 */
  narrative: string;
}

/** Remotion 渲染超时（契约：600s） */
const OVERLAY_RENDER_TIMEOUT_MS = 900_000; // v2.1 契约：600→900（红队实测冷启动 bundling+Chrome 可达 600s 级）
/** 输入视频拷入工程 public/ 的固定文件名（staticFile 服务范围；串行渲染逐次覆盖） */
const OVERLAY_PUBLIC_INPUT = "wallpaper-overlay-input.mp4";

/** wallpaper-overlay Remotion 工程根（videoWorkspacePath 下，v2 增量任务 14） */
export function wallpaperOverlayProjectDir(): string {
  return path.join(config.videoWorkspacePath, "wallpaper-overlay");
}

/**
 * Remotion 自带 Chrome Headless Shell 绝对路径（videoWorkspacePath/node_modules/.remotion 缓存，
 * memory-video 工作区首次渲染时已下载——只读复用）。
 *
 * 必须显式传 --browser-executable：remotion 的浏览器缓存目录按「cwd 向上最近 package.json」
 * 解析，本工程 cwd=wallpaper-overlay（自带 package.json）会解析到 wallpaper-overlay/node_modules/.remotion
 * （不存在）→ 触发联网重新下载。显式指定后零下载、确定性渲染。
 */
export function resolveRemotionBrowserExecutable(): string {
  return path.join(
    config.videoWorkspacePath,
    "node_modules",
    ".remotion",
    "chrome-headless-shell",
    "mac-arm64",
    "chrome-headless-shell-mac-arm64",
    "chrome-headless-shell",
  );
}

/** remotion CLI 解析基准：npx 与 node 同目录（nvm 布局；PM2 PATH 不保证，须绝对路径） */
function resolveNpxPath(): string {
  return path.join(path.dirname(process.execPath), "npx");
}

/**
 * Remotion 文字层合成（v2 增量任务 14）：spawn `npx remotion render`
 * （cwd=wallpaper-overlay 工程、npx 绝对路径解析、AbortController 600s 超时、
 * stdout/stderr tail 留证）。
 *
 * 输入视频拷入工程 public/（staticFile 服务范围），渲染完成即清理；
 * composition 按输入分辨率选（宽>高 → landscape，否则 portrait）；
 * --frames=0-N 约束渲染时长 = 输入时长（ffprobe 探测，帧率同源）。
 *
 * 错误枚举 OverlayRenderError：工程/Remotion 运行时缺失（不自动安装）/
 * ffprobe 失败 / remotion 非零退出 / 产物缺失 / 超时。
 *
 * @param opts.timeoutMs 测试注入（默认契约 600s）
 */
export async function renderTextOverlay(
  videoPath: string,
  meta: TextOverlayMeta,
  opts: { timeoutMs?: number } = {},
): Promise<{ overlaidPath: string }> {
  const timeoutMs = opts.timeoutMs ?? OVERLAY_RENDER_TIMEOUT_MS;
  const projectDir = wallpaperOverlayProjectDir();
  const entry = path.join(projectDir, "src", "index.ts");
  try {
    await access(entry);
  } catch {
    throw new OverlayRenderError(`wallpaper-overlay 工程缺失: ${entry}`);
  }
  const remotionBin = path.join(config.videoWorkspacePath, "node_modules", ".bin", "remotion");
  try {
    await access(remotionBin);
  } catch {
    throw new OverlayRenderError(
      `Remotion 运行时缺失: ${remotionBin}（需在 videoWorkspacePath 安装依赖，不自动安装）`,
    );
  }
  // 浏览器：显式使用 workspace 已缓存的 Chrome Headless Shell（避免按 cwd 解析缓存目录
  // 触发联网重下；缺失时仍交由 remotion 默认行为兜底，前置校验已含该检查）
  const browserExecutable = resolveRemotionBrowserExecutable();
  const hasBrowserBin = await access(browserExecutable)
    .then(() => true)
    .catch(() => false);

  // 【v2.1 路径基准修复】videoPath/产物一律绝对化：remotion spawn 的 cwd 是 workspace，
  // 相对路径会写到 workspace/ 下，而 job 的存在性检查以 backend cwd 为基准 → 永远 miss
  //（2026-09-13 实证：两腿皆因此误判失败回退静态）。
  const absVideoPath = path.resolve(videoPath);
  let probe: ProbeResult;
  try {
    probe = await probeVideoFile(absVideoPath);
  } catch (e) {
    throw new OverlayRenderError(
      `renderTextOverlay ffprobe 探测失败: ${e instanceof Error ? e.message : String(e)} (${videoPath})`,
    );
  }
  const compId =
    probe.width > probe.height ? "wallpaper-overlay-landscape" : "wallpaper-overlay-portrait";
  const frames = Math.max(1, Math.ceil(probe.duration * probe.fps));

  // 输入视频拷入工程 public/（渲染完成即清理）
  const publicDir = path.join(projectDir, "public");
  await mkdir(publicDir, { recursive: true });
  const publicVideoPath = path.join(publicDir, OVERLAY_PUBLIC_INPUT);
  await copyFile(absVideoPath, publicVideoPath);

  const overlaidPath = path.join(
    path.dirname(absVideoPath),
    `${path.basename(absVideoPath).replace(/\.mp4$/i, "")}-overlay.mp4`,
  );
  const props = {
    videoPath: OVERLAY_PUBLIC_INPUT,
    pickDate: meta.pickDate,
    title: meta.title,
    narrative: meta.narrative,
  };
  const args = [
    "remotion",
    "render",
    "src/index.ts",
    compId,
    overlaidPath,
    "--props",
    JSON.stringify(props),
    "--frames",
    `0-${frames - 1}`,
    ...(hasBrowserBin ? ["--browser-executable", browserExecutable] : []),
  ];

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killEscalation: ReturnType<typeof setTimeout> | undefined;
  try {
    // AbortController 600s 超时（契约）；kill 后等 'close' 冲刷 stdio 再抛
    // （'error' AbortError 在 stdio 冲刷前触发，直接抛会丢 stdout tail——v1 spawn 教训）。
    // SIGTERM 后 5s 未退出（子进程持有 stdio）→ SIGKILL 升级。
    const exitCode = await new Promise<number>((resolve, reject) => {
      const ac = new AbortController();
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
        killEscalation = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // 已退出忽略
          }
        }, 5_000);
        killEscalation.unref();
      }, timeoutMs);
      const proc = spawn(resolveNpxPath(), args, {
        cwd: projectDir,
        env: { ...process.env },
        signal: ac.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      proc.on("error", (e) => {
        // AbortError：等 'close'（stdio 冲刷）；真 spawn 失败（如 npx 缺失）无 close → 直接 reject
        if (!timedOut) {
          if (timer) clearTimeout(timer);
          if (killEscalation) clearTimeout(killEscalation);
          reject(new OverlayRenderError(`npx remotion render spawn 失败: ${e.message}`));
        }
      });
      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (killEscalation) clearTimeout(killEscalation);
        resolve(code ?? -1);
      });
    });

    if (timedOut) {
      throw new OverlayRenderError(
        `remotion render 超时（${timeoutMs}ms）（stderr=${stderr.slice(-500) || "（空）"} | stdout=${stdoutTail(stdout)}）`,
      );
    }
    if (exitCode !== 0) {
      throw new OverlayRenderError(
        `remotion render 退出码 ${exitCode}（stderr=${stderr.slice(-500) || "（空）"} | stdout=${stdoutTail(stdout)}）`,
      );
    }

    try {
      await access(overlaidPath);
    } catch {
      throw new OverlayRenderError(
        `remotion render 产物文件不存在: ${overlaidPath}（stdout=${stdoutTail(stdout)}）`,
      );
    }
    return { overlaidPath };
  } finally {
    if (timer) clearTimeout(timer);
    if (killEscalation) clearTimeout(killEscalation);
    // 清理拷入 public 的输入视频（工程保持干净，不残留大文件）
    await rm(publicVideoPath, { force: true }).catch(() => {});
  }
}

// ============================================================================
// 前置校验
// ============================================================================

/** 解析可执行文件绝对路径：绝对路径直接 access，命令名走 which */
async function resolveExecutable(p: string): Promise<string> {
  if (p.includes("/")) {
    await access(p);
    return p;
  }
  const { execSync } = await import("node:child_process");
  return execSync(`which ${p}`, { encoding: "utf8" }).trim();
}

/**
 * spawn 前置校验（v2）：honeydo bin、ffmpeg、原图路径三存在 +
 * wallpaper-overlay 工程入口 / Remotion 运行时 / overlay 字体（v2 增量任务 14：
 * workspace 无 remotion 依赖时报错，不自动安装）。
 * 任一缺失 throw Error（范本 assertSpawnPrerequisites）。
 */
export async function assertVideoSpawnPrerequisites(photoPath: string): Promise<void> {
  const overlayDir = wallpaperOverlayProjectDir();
  const checks: Array<{ label: string; p: string; resolve: boolean }> = [
    { label: "honeydo CLI", p: config.honeydoCliPath, resolve: false },
    { label: "ffmpeg", p: config.video.ffmpegPath, resolve: true },
    { label: "hero 原图", p: photoPath, resolve: false },
    // v2 增量任务 14：Remotion 文字层前置（不自动安装）
    {
      label: "Remotion 运行时（videoWorkspacePath/node_modules，不自动安装）",
      p: path.join(config.videoWorkspacePath, "node_modules", ".bin", "remotion"),
      resolve: false,
    },
    {
      label: "wallpaper-overlay 工程",
      p: path.join(overlayDir, "src", "index.ts"),
      resolve: false,
    },
    {
      label: "overlay 字体（Noto Serif SC）",
      p: path.join(overlayDir, "public", "fonts", "NotoSerifSC-Regular.otf"),
      resolve: false,
    },
    {
      label: "Chrome Headless Shell（Remotion 渲染浏览器，不自动安装）",
      p: resolveRemotionBrowserExecutable(),
      resolve: false,
    },
  ];
  for (const c of checks) {
    try {
      if (c.resolve) await resolveExecutable(c.p);
      else await access(c.p);
    } catch {
      throw new Error(`spawn 前置缺失: ${c.label} (${c.p})`);
    }
  }
  if (!config.honeydoCliPath) {
    throw new Error(
      "spawn 前置缺失: honeydo CLI（config.honeydoCliPath 为空，未安装且未设 HONEYDO_CLI_PATH）",
    );
  }
}

// ============================================================================
// seconds clamp（config 契约：运行时 clamp ∈ [1,15]）
// ============================================================================

/** 运行时 clamp 壁纸视频时长 ∈ [1,15]（honeydo CLI 上限 15；非有限 → 默认 4，v2 recipes 纪律） */
export function clampWallpaperVideoSeconds(n: number): number {
  if (!Number.isFinite(n)) return 4;
  return Math.min(15, Math.max(1, Math.round(n)));
}

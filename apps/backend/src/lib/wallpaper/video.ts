/**
 * 壁纸视频生成模块（动态视频壁纸，state.md ## 后端设计 3 / ## 契约规约 计算/spawn 契约；
 * 20260928 单腿原生比例改版：固定横竖两腿 → 单腿原生画布，画布 SSOT 在 lib/wallpaper/native-canvas.ts）
 *
 *   preprocessHeroFrame(photoPath, width, height) → tmp png 绝对路径
 *     sharp cover 微裁+resize 到目标画布（32 倍数约束，画布由 computeNativeCanvas 按原图比例算出）。
 *     原生比例下构图已忠实，预裁仅做比例对齐与预算缩放（20260928 去除 v2 人脸窗口裁剪）。
 *     honeydo first-frame 引擎直接 LANCZOS 拉伸到画布——调用方必须先按画布比例 cover-crop，
 *     否则源图会被拉变形（预裁比例 == 画布比例时拉伸无感）。
 *
 *   spawnHoneydoVideo({cliPath, prompt, firstFrame, lastFrame, outPath, seconds, res, timeoutMs})
 *     → {outPath, duration, stdout}
 *     照 claude-runner 骨架：绝对路径 spawn、stdio ["ignore","pipe","pipe"]、AbortController 超时、
 *     stdout 累积后 JSON.parse 取 {out, duration, res}，stderr 累积留证；
 *     非零退出 / JSON 解析失败 / 产物文件不存在 / 超时 abort → throw HoneydoSpawnError
 *     （message 含 stdout tail ≤2000 字符与超时毫秒数）。
 *
 *   spawnH3cVideo({binPath, modelDir, prompt, firstFrame, lastFrame, outPath, seconds,
 *     width, height, timeoutMs?, steps?, layers?, reuse?, seed?, ssdStreaming?})
 *     → {outPath, stdout}（20261014 h3.c 引擎接入：BF16 零量化，A/B 定案消除 int8 幻觉）
 *     同骨架；无 stdout JSON 回执，成功判据 = 退出码 0 ∧ 产物存在（spawn 前 pre-delete）；
 *     参数档 --steps 20 --layers 45 --reuse 2 --ssd-streaming --seed 42（A/B 验证档）。
 *     画布预算钳制在调用方（computeNativeCanvas + H3C_CANVAS_PIXEL_BUDGET，
 *     引擎对像素积 >768×1344 硬报错退出）。
 *
 *   buildLoop(src, targetSeconds) → {loopPath, segments}（v2 增量任务 13）
 *     palindrome 拼接（split/reverse/concat，forward+reverse 交替；音轨 areverse 同构）
 *     至 ≥targetSeconds ∧ 偶数段；错误枚举 LoopBuildError（ffmpeg 失败 / 拼接后时长 < targetSeconds-1）。
 *
 *   renderTextOverlay(videoPath, meta, opts) → {overlaidPath}（v2 增量任务 14；20260928 props 扩展）
 *     meta 增 canvasWidth/canvasHeight（生成画布，透传 Remotion props + calculateMetadata 动态尺寸）；
 *     comp 选择按画布比例（≥0.9 横版两栏 / <0.9 竖版全屏），不再按输入视频探测尺寸。
 *     spawn `npx remotion render`（cwd=videoWorkspacePath/wallpaper-overlay 工程、npx 绝对路径、
 *     AbortController 900s 超时（v2.1）、stdout tail 留证）；错误枚举 OverlayRenderError
 *     （工程/Remotion 运行时缺失不自动安装 / 非零退出 / 产物缺失 / 超时）。
 *
 *   transcodeForAerialNative(src, dst)（20260928 单腿条件 Aerial）：画布比例 ∈ [1.5,1.9] 才产出——
 *     ffmpeg 居中裁到 16:9 → scale=1920:1080:flags=lanczos,setsar=1（crop 前置保证入 scale 前
 *     比例恰 16:9，绝不拉伸）→ HEVC(hvc1) .mov 带音轨 aac 128k +faststart。
 *     hevc_videotoolbox 失败 fallback libx265。超时 600s。
 *   transcodeForGallery(src, dst)（v2）：H.264 mp4 重编码保留音轨（libx264 crf18 + aac 128k
 *     +faststart，无 -vf 尺寸透传——分辨率 == 源画布），画廊消费原生比例。超时 120s。
 *   assertVideoDimensions(filePath, expectedWidth, expectedHeight)（20260928 尺寸护栏）：
 *     ffprobe 断言转码产物尺寸，不匹配即 throw（job 失败 → 当日回退静态，fail-safe，禁静默失败）。
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
import { buildCaptureDateline } from "./capture";

// ============================================================================
// 档位与兼容窗口常量（20260928 单腿原生：画布 SSOT 在 native-canvas.ts；
// -r 档位保留 720p 保 stdout 回执语义，画布由 --width/--height 显式覆盖）
// ============================================================================

/** honeydo res 档位（契约：-r 保留保 stdout 回执语义；画布两轴经 --width/--height 显式覆盖） */
export const WALLPAPER_VIDEO_RES = "720p";

/** Aerial 兼容窗口（画布长短轴比 ∈ [1.5, 1.9] 才产出 16:9 微裁 .mov；窗外 mac 当日走静态回退） */
export const AERIAL_COMPAT_RATIO_MIN = 1.5;
export const AERIAL_COMPAT_RATIO_MAX = 1.9;

/**
 * 画布是否落在 Aerial 兼容窗口：**方向性比例** canvasWidth/canvasHeight ∈ [1.5, 1.9]
 * （与 D2 overlay comp 选择的 ratio 定义同源——竖版画布 w/h < 1 恒窗外，绝不产 16:9 微裁
 * .mov：竖裁横会砍掉 ~69% 画面，T_crop 纪律只对横版画布成立）。
 */
export function isAerialCompatCanvas(canvas: { width: number; height: number }): boolean {
  if (canvas.height <= 0) return false;
  const ratio = canvas.width / canvas.height;
  return ratio >= AERIAL_COMPAT_RATIO_MIN && ratio <= AERIAL_COMPAT_RATIO_MAX;
}

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
// preprocessHeroFrame（20260928：比例对齐 cover 微裁，去除人脸窗口）
// ============================================================================

/** 人脸 bbox（EXIF 旋转后原图像素坐标——detect-faces 主流程 rotate 后检测，同空间）。
 *  20260928 起仅供 prompt 分层默认（有无人脸）使用，不再参与预裁剪构图。 */
export interface FaceBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * hero 原图预裁剪：sharp cover 微裁+resize 到目标画布（width×height），产 tmp png。
 *
 * 20260928 单腿原生比例：画布由 computeNativeCanvas 按原图比例算出，预裁仅做
 * 「比例对齐 + 预算缩放」（cover 微裁量 ≤ 32 取整容差级），**去除 v2 人脸窗口裁剪**——
 * 原生比例下构图已忠实，不再为脸重构图。HEIC 源先经 convertHeicToJpeg 解码（复用
 * lib/heic，与 composer 同源）；.rotate() 按 EXIF 方向摆正后再裁剪。
 *
 * @returns tmp png 绝对路径（调用方负责清理）
 */
export async function preprocessHeroFrame(
  photoPath: string,
  width: number,
  height: number,
): Promise<string> {
  let buf = await import("node:fs/promises").then((m) => m.readFile(photoPath));
  if (isHeicBuffer(buf)) {
    buf = await convertHeicToJpeg(buf, { quality: 90 });
  }
  const outPath = path.join(
    tmpdir(),
    `wallpaper-video-frame-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );

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

/**
 * 读 hero 原图 **EXIF 旋转后**有效尺寸（与 preprocessHeroFrame 的 .rotate() 同空间）——
 * computeNativeCanvas 的朝向判定必须基于旋转后尺寸，否则带 EXIF 旋转的竖拍照片会算错朝向。
 * HEIC 源先经 convertHeicToJpeg 解码（与 preprocessHeroFrame 同源）。
 * orientation 5-8（90°/270° 旋转）时宽高互换。
 */
export async function readOrientedDimensions(
  photoPath: string,
): Promise<{ width: number; height: number }> {
  let buf = await import("node:fs/promises").then((m) => m.readFile(photoPath));
  if (isHeicBuffer(buf)) {
    buf = await convertHeicToJpeg(buf, { quality: 90 });
  }
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const o = meta.orientation ?? 1;
  const swapped = o >= 5 && o <= 8;
  return { width: swapped ? h : w, height: swapped ? w : h };
}

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
  /**
   * 画布宽（px，32 倍数）——传入时向 CLI 追加 `--width`，逐轴覆盖 res 档位画布；
   * 不传时行为与未支持该参数前逐字一致（C2）。
   *
   * 横版显式传值与 720p 档位等价，但日后若调 -r 720p 档位，横版尺寸会静默不变——
   * 这是刻意的（画布改动只针对竖版：竖版从 portrait 档原值覆盖到 736×1600）。
   */
  width?: number;
  /** 画布高（px，32 倍数）——语义同 width，逐轴覆盖 res 档位画布 */
  height?: number;
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
  // 画布逐轴覆盖（C2：仅在传入时追加，不传时 argv 与现状逐字一致）
  if (opts.width !== undefined) args.push("--width", String(opts.width));
  if (opts.height !== undefined) args.push("--height", String(opts.height));

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
// spawnH3cVideo（20261014 h3.c 引擎接入：BF16 零量化，A/B 定案替代 mmh3turbo 消除幻觉）
// ============================================================================

/** spawn h3.c 失败（非零退出 / 产物缺失 / 超时 abort） */
export class H3cSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "H3cSpawnError";
  }
}

export interface H3cVideoOptions {
  /** h3 可执行文件绝对路径（config.h3c.binPath） */
  binPath: string;
  /** MiniMax-H3 BF16 权重目录（config.h3c.modelDir，FL2VA 子集） */
  modelDir: string;
  /** 生成 prompt（与 honeydo 同源：motionPrompt / 分层默认，含 Audio 环境音指引） */
  prompt: string;
  /** 首帧图路径（预裁剪 tmp png） */
  firstFrame: string;
  /** 尾帧图路径（20261014 运动量实测：双锚定会把成片钉死在锚点——探针 peak 6.86%→15.95%、
   *  帧间 3.3 倍；默认不传，回环由 palindrome 镜像段恒无缝保证；config.h3c.lastFrameAnchor
   *  开启时才传，防身份漂移逃生口） */
  lastFrame?: string;
  /** 产物 mp4 路径（h3.c 内部经 ffmpeg 封装 H.264 + 32kHz AAC） */
  outPath: string;
  /** 时长秒（24fps；引擎内部 5+17n 帧量化——4s→107 帧≈4.46s，buildLoop 兼容） */
  seconds: number;
  /** 画布宽（32 倍数；调用方须已按 H3C_CANVAS_PIXEL_BUDGET 钳像素积，引擎超限硬报错） */
  width: number;
  /** 画布高（同上） */
  height: number;
  /** 超时 ms（默认 config.wallpaperVideoSpawnTimeoutMs） */
  timeoutMs?: number;
  /** 去噪步数（config.h3c.steps，默认 20 = A/B 验证档） */
  steps?: number;
  /** DiT 层数（config.h3c.layers，默认 45 fast 档；50 exact） */
  layers?: number;
  /** 去噪器复用（config.h3c.reuse，默认 2 fast 档） */
  reuse?: number;
  /** 随机种子（config.h3c.seed，默认 42；同输入确定性复现） */
  seed?: number;
  /** SSD 流式读 BF16 DiT 层（默认 true；992² 级画布全驻留会 jetsam OOM，必须开） */
  ssdStreaming?: boolean;
}

export interface H3cVideoResult {
  outPath: string;
  stdout: string;
}

/**
 * spawn h3.c 图生视频（antirez 原生 Metal 引擎，BF16 零量化）。
 *
 * 与 spawnHoneydoVideo 同契约骨架：绝对路径 spawn、stdio pipe、超时 SIGTERM→SIGKILL 升级、
 * stdout/stderr tail 留证；差异 = 回执协议——h3.c 无 stdout 机读 JSON，成功判据为
 * **退出码 0 ∧ 产物文件存在**（spawn 前 pre-delete 产物路径，杜绝陈旧文件误判）。
 * 参数锁定 A/B 验证档：--steps 20 --layers 45 --reuse 2 --ssd-streaming --seed 42。
 */
export async function spawnH3cVideo(opts: H3cVideoOptions): Promise<H3cVideoResult> {
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);

  const args = [
    "-d",
    opts.modelDir,
    "-p",
    opts.prompt,
    "--first-frame",
    opts.firstFrame,
    // 尾帧锚定可选（20261014 运动量实测：默认单锚，见 H3cVideoOptions.lastFrame 注）
    ...(opts.lastFrame ? ["--last-frame", opts.lastFrame] : []),
    "-o",
    opts.outPath,
    "--width",
    String(opts.width),
    "--height",
    String(opts.height),
    "--seconds",
    String(opts.seconds),
    "--steps",
    String(opts.steps ?? 20),
    "--layers",
    String(opts.layers ?? 45),
    "--reuse",
    String(opts.reuse ?? 2),
    "--seed",
    String(opts.seed ?? 42),
    ...((opts.ssdStreaming ?? true) ? ["--ssd-streaming"] : []),
  ];

  // pre-delete 产物：h3.c 无 JSON 回执，成功判据是产物存在——先清场防陈旧文件误判
  await rm(opts.outPath, { force: true }).catch(() => {});

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const proc = spawn(opts.binPath, args, {
        // h3 以 CWD 相对路径加载 Metal 着色器源（h3_gpu.m：source_path 兜底
        // "h3_shaders.metal"），文件只在构建目录——cwd 固定到 bin 同目录；
        // 传入 h3 的全部路径参数（modelDir/首尾帧/产物）均为绝对路径，不受 cwd 影响
        cwd: path.dirname(opts.binPath),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      // 超时 SIGTERM；5s 未退出（子进程持有 stdio）→ SIGKILL 升级；
      // kill 后等 'close'（stdio 冲刷完）再走超时分支，保住 stdout tail。
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
      throw new H3cSpawnError(
        `h3.c 视频生成超时（${timeoutMs}ms）（stderr=${stderr.slice(-500) || "（空）"} | stdout=${stdoutTail(stdout)}）`,
      );
    }

    if (exitCode !== 0) {
      throw new H3cSpawnError(
        `h3.c 视频生成退出码 ${exitCode}（stderr=${stderr.slice(-800) || "（空）"} | stdout=${stdoutTail(stdout)}）`,
      );
    }

    try {
      await access(opts.outPath);
    } catch {
      throw new H3cSpawnError(
        `h3.c 视频生成产物文件不存在: ${opts.outPath}（stderr=${stderr.slice(-500) || "（空）"} | stdout=${stdoutTail(stdout)}）`,
      );
    }

    return { outPath: opts.outPath, stdout };
  } catch (e) {
    if (e instanceof H3cSpawnError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new H3cSpawnError(`h3.c 视频生成 spawn 失败: ${msg}`);
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
 * Aerial 用条件转码（20260928 单腿原生）：HEVC(hvc1) .mov 1920×1080 **带音轨**
 * （aac 128k，2026-09-13 验收要求以后生成的视频带音轨）+faststart。
 *
 * 滤镜链 = **crop 前置 + scale 后置**：先把源居中裁到恰 16:9（`crop=min(iw,ih*16/9):min(ih,iw*9/16)`
 * 横竖超宽窄高统一处理），再 `scale=1920:1080:flags=lanczos,setsar=1` 等比放大——
 * crop 已保证入 scale 前比例恰 16:9，故 scale 无非等比形变（**绝不拉伸**）。
 * 调用方须先以 isAerialCompatCanvas 把关（画布比例 ∈ [1.5,1.9]，最坏裁切占比 ≤0.15）。
 *
 * hevc_videotoolbox 失败（非本机硬件编码器/旧系统）→ fallback libx265 -crf 22。
 * 超时 600s。
 */
export async function transcodeForAerialNative(src: string, dst: string): Promise<void> {
  const common = [
    "-y",
    "-i",
    src,
    "-vf",
    "crop=w='min(iw,ih*16/9)':h='min(ih,iw*9/16)',scale=1920:1080:flags=lanczos,setsar=1",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
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
 * 尺寸护栏（20260928 补洞）：ffprobe 断言转码产物尺寸，不匹配即 throw。
 * 场景 5 契约：禁静默失败——message 显式含「尺寸断言失败」语义与期望/实际值；
 * job 失败 → 当日回执列均空 → 画廊静态卡 + mac 静态壁纸（fail-safe）。
 */
/**
 * 尺寸护栏专用错误类。设计 D2：护栏失败必须传播为 job 失败（worker 标记失败 / rerun CLI exit≠0）；
 * 其余失败（spawn/上传/DB）走既有旁路容错（契约 8，runWallpaperVideo 吞掉返回空列）。
 */
export class DimensionAssertError extends Error {}

export async function assertVideoDimensions(
  filePath: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<void> {
  let probe: ProbeResult;
  try {
    probe = await probeVideoFile(filePath);
  } catch (e) {
    throw new DimensionAssertError(
      `转码产物尺寸断言失败（ffprobe 探测异常）: ${filePath} 期望 ${expectedWidth}×${expectedHeight}，` +
        `探测错误: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (probe.width !== expectedWidth || probe.height !== expectedHeight) {
    throw new DimensionAssertError(
      `转码产物尺寸断言失败: ${filePath} 期望 ${expectedWidth}×${expectedHeight}，` +
        `实际 ${probe.width}×${probe.height}（禁静默失败——错尺寸产物不得入库/上传）`,
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
// measureVideoMotion（20261014 运动量验收门：生成后实测，近静止样本换 seed 重试）
// ============================================================================

export interface VideoMotionStats {
  /** 相对首帧的峰值平均偏移（0-100，占满量程 255 的百分比；标尺：68% 一眼可见 / 1~7% 察觉不到） */
  peak: number;
  /** 相邻帧平均变化（0-100；衡量「动不动」而非「偏多远」） */
  fdiffAvg: number;
  frames: number;
}

/**
 * 无损运动量实测（仓库既有方法移植 TS：gray 320×180 rawvideo → Buffer 内算偏移，
 * 不经 JPEG——压缩噪声会让同一支视频测出 0.9% 与 4.0% 两种结果）。
 *
 * - peak = max_i mean(|frame_i − frame_0|) / 255 × 100
 * - fdiffAvg = mean_i mean(|frame_{i+1} − frame_i|) / 255 × 100
 *
 * 失败（ffprobe/ffmpeg 异常）throw 由调用方 fail-open（运动门是质量增强不是硬依赖，
 * 测量失败不得阻塞发布）。
 */
export async function measureVideoMotion(filePath: string): Promise<VideoMotionStats> {
  const W = 320;
  const H = 180;
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    const chunks: Buffer[] = [];
    const proc = spawn(
      config.video.ffmpegPath,
      [
        "-v",
        "error",
        "-i",
        filePath,
        "-vf",
        `scale=${W}:${H}`,
        "-pix_fmt",
        "gray",
        "-f",
        "rawvideo",
        "-",
      ],
      { signal: ac.signal, stdio: ["ignore", "pipe", "ignore"] },
    );
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`measureVideoMotion ffmpeg 退出码 ${code}`));
    });
  });

  const frameLen = W * H;
  const n = Math.floor(raw.length / frameLen);
  if (n < 2) throw new Error(`measureVideoMotion 帧数不足: ${n} (${filePath})`);
  // noUncheckedIndexedAccess：Buffer 索引访问返回 number|undefined——按仓惯例走
  // for..of 迭代（迭代值恒为 number），首帧/前帧快照用 number[]，越界守卫 ?? 0
  //（subarray 切片恰为 frameLen，守卫永不触发）
  const first: number[] = Array.from(raw.subarray(0, frameLen));
  let peak = 0;
  let fdiffSum = 0;
  let prev: number[] = first;
  for (let i = 1; i < n; i++) {
    const cur = Array.from(raw.subarray(i * frameLen, (i + 1) * frameLen));
    let sumFirst = 0;
    let sumDiff = 0;
    let p = 0;
    for (const v of cur) {
      sumFirst += Math.abs(v - (first[p] ?? 0));
      sumDiff += Math.abs(v - (prev[p] ?? 0));
      p++;
    }
    const avgFirst = sumFirst / frameLen;
    if (avgFirst > peak) peak = avgFirst;
    fdiffSum += sumDiff / frameLen;
    prev = cur;
  }
  return {
    peak: (peak / 255) * 100,
    fdiffAvg: (fdiffSum / (n - 1) / 255) * 100,
    frames: n,
  };
}

// ============================================================================
// renderTextOverlay（v2 增量任务 14：Remotion 文字层合成）
// ============================================================================

export interface TextOverlayMeta {
  /** 精选日期 YYYY-MM-DD（masthead 日期） */
  pickDate: string;
  /** 主标题 */
  title: string;
  /** 叙事文案 */
  narrative: string;
  /** hero 照片拍摄时刻 ISO（footer「拍摄于 …· N 年前」同源 web/静态壁纸）；null/缺省 → footer 不渲染 */
  takenAt?: string | null;
  /** 生成画布宽（20261009 起仅存档透传 props 供排查，不参与 comp 尺寸/分支） */
  canvasWidth: number;
  /** 生成画布高（同上） */
  canvasHeight: number;
}

/** 排版卡变体（20261009 排版解耦）：landscape=16:9 杂志卡 1920×1080 / portrait=竖版全屏卡 1290×2796 */
export type TextOverlayVariant = "landscape" | "portrait";

/**
 * footer 拍摄时刻 dateline（lib/wallpaper/capture.ts 同源封装：
 * `formatPhotoCaptureTime(takenAt)` + 可选「 · N 年前」）。
 * takenAt null/无效 → null（模板 footer 不渲染，与静态壁纸 footer 留白约定一致）。
 */
export { buildCaptureDateline } from "./capture";

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
 * Remotion 文字层合成（v2 增量任务 14；20261009 排版解耦）：spawn `npx remotion render`
 * （cwd=wallpaper-overlay 工程、npx 绝对路径解析、AbortController 600s 超时、
 * stdout/stderr tail 留证）。
 *
 * 输入视频拷入工程 public/（staticFile 服务范围），渲染完成即清理；
 * composition 按 variant 选（landscape=16:9 杂志卡 1920×1080 / portrait=竖版全屏卡
 * 1290×2796——comp 尺寸固定在 Root.tsx，与生成画布解耦；输入 loop 为任意原生比例，
 * comp 内 contain/cover 适配）；props.variant 显式透传（comp 内分支同源）；
 * --frames=0-N 约束渲染时长 = 输入时长（ffprobe 探测，帧率同源）。
 *
 * 错误枚举 OverlayRenderError：工程/Remotion 运行时缺失（不自动安装）/
 * ffprobe 失败 / remotion 非零退出 / 产物缺失 / 超时。
 *
 * @param variant 排版卡变体（同一天两张卡各渲染一次：landscape → 画廊主视频 + Aerial
 *   源；portrait → 手机竖版动态壁纸）
 * @param opts.timeoutMs 测试注入（默认契约 600s）
 */
export async function renderTextOverlay(
  videoPath: string,
  meta: TextOverlayMeta,
  variant: TextOverlayVariant,
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
  // comp 选择（20261009 排版解耦）：按 variant 显式选卡——landscape=16:9 杂志卡
  // （恒 1920×1080）/ portrait=竖版全屏卡（恒 1290×2796），comp 尺寸固定在
  // Root.tsx（不再跟随生成画布）；输入 loop 为任意原生比例，由 comp 内 contain/cover 适配
  const compId =
    variant === "landscape" ? "wallpaper-overlay-landscape" : "wallpaper-overlay-portrait";
  const frames = Math.max(1, Math.ceil(probe.duration * probe.fps));

  // 输入视频拷入工程 public/（渲染完成即清理）
  const publicDir = path.join(projectDir, "public");
  await mkdir(publicDir, { recursive: true });
  const publicVideoPath = path.join(publicDir, OVERLAY_PUBLIC_INPUT);
  await copyFile(absVideoPath, publicVideoPath);

  const overlaidPath = path.join(
    path.dirname(absVideoPath),
    `${path.basename(absVideoPath).replace(/\.mp4$/i, "")}-overlay-${variant}.mp4`,
  );
  // props 契约（20261009 契约修订）：{videoPath, pickDate, title, narrative,
  // captureDateline, canvasWidth, canvasHeight, variant}
  const props = {
    videoPath: OVERLAY_PUBLIC_INPUT,
    pickDate: meta.pickDate,
    title: meta.title,
    narrative: meta.narrative,
    captureDateline: buildCaptureDateline(meta.takenAt),
    canvasWidth: meta.canvasWidth,
    canvasHeight: meta.canvasHeight,
    variant,
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
// 动作强化 prompt 后缀（20261014 定案：双锚保身份 + 强化动作给运动量）
// ============================================================================

/** 动作强化措辞（探针实测，双锚 seed42 帧间avg：原版 0.298% → L1 0.805%(2.7×) →
 *  L2 1.566%(5.3×)，身份 0.81~0.95 / 0.72~0.88 均在历史合格带）。
 *  关键教训：运动藏在**具体动词的强度放大**里（快速/大力/重复），抽象强度短句
 *  （「动作幅度大而明显」）实测无效（生产 0.55% vs 原版 0.45%——纯噪声）。 */
const MOTION_BOOST_L1 = {
  prefix: "动作幅度很大：",
  suffix: "所有人的动作快速而大力，头发衣角大幅飞扬，画面动感强烈。",
} as const;
const MOTION_BOOST_L2 = {
  prefix: "动作幅度很大且速度很快：",
  suffix: "动作快速大力重复不断，头发衣角大幅飞扬。",
} as const;

/**
 * 包覆式动作升级：不改动策展动作描述本身，前加强度框架、后补普适可见动作尾巴，
 * Audio 指引原样保留在末尾——引擎侧放大器，不回写 motion_prompt 列。
 *
 * @param level 1=常规放大（attempt 1）2=激进修正（运动门未过时的 attempt 2）
 */
export function withMotionBoost(prompt: string, level: 1 | 2 = 1): string {
  const idx = prompt.indexOf(" Audio:");
  const body = (idx >= 0 ? prompt.slice(0, idx) : prompt).trim().replace(/。$/, "");
  const audio = (idx >= 0 ? prompt.slice(idx) : "").trimStart();
  const { prefix, suffix } = level >= 2 ? MOTION_BOOST_L2 : MOTION_BOOST_L1;
  return `${prefix}${body}，${suffix}${audio ? ` ${audio}` : ""}`;
}

/** 负面清单（20261014 社区调研采纳）：官方示例把「不做什么」作为主要风格控制手段。
 *  正中 h3.c 实证缺陷——09-30/10-05 幻觉白字（对应「不加文字」）、切镜破坏回环、
 *  五官漂移、自加 BGM。插在 Audio 指引之前，Audio 仍居末尾。 */
const H3_NEGATIVE_TAIL =
  "全程单镜头不切镜，画面中不出现任何字幕、文字或水印，人物五官保持稳定不变形，无背景音乐。";

export function withH3NegativeList(prompt: string): string {
  const idx = prompt.indexOf(" Audio:");
  const body = (idx >= 0 ? prompt.slice(0, idx) : prompt).trim().replace(/。$/, "");
  const audio = (idx >= 0 ? prompt.slice(idx) : "").trimStart();
  return `${body}，${H3_NEGATIVE_TAIL}${audio ? ` ${audio}` : ""}`;
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
 * spawn 前置校验（v2；20261014 引擎感知）：ffmpeg、原图路径 +
 * wallpaper-overlay 工程入口 / Remotion 运行时 / overlay 字体恒检；
 * 生成引擎二选一——h3c：h3 二进制 + BF16 权重目录；honeydo：honeydo bin。
 * 任一缺失 throw Error（范本 assertSpawnPrerequisites）。
 */
export async function assertVideoSpawnPrerequisites(photoPath: string): Promise<void> {
  const overlayDir = wallpaperOverlayProjectDir();
  const engineChecks: Array<{ label: string; p: string; resolve: boolean }> =
    config.wallpaperVideoEngine === "h3c"
      ? [
          { label: "h3.c 二进制", p: config.h3c.binPath, resolve: false },
          { label: "h3.c BF16 权重目录", p: config.h3c.modelDir, resolve: false },
        ]
      : [{ label: "honeydo CLI", p: config.honeydoCliPath, resolve: false }];
  const checks: Array<{ label: string; p: string; resolve: boolean }> = [
    ...engineChecks,
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
  if (config.wallpaperVideoEngine !== "h3c" && !config.honeydoCliPath) {
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

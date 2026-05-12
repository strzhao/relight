import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { config } from "../config";

const execFileAsync = promisify(execFile);

export class VideoProcessingError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "VideoProcessingError";
  }
}

export interface VideoCapability {
  ffmpegOk: boolean;
  ffprobeOk: boolean;
  /** 综合可用性：ffmpegOk && ffprobeOk && config.video.enabled */
  available: boolean;
}

export interface VideoProbeResult {
  width: number;
  height: number;
  durationSec: number;
  videoCodec: string;
  videoFps: number;
  hasAudio: boolean;
  takenAt?: Date;
}

let _capability: VideoCapability | null = null;

/**
 * 检测系统是否已安装 ffmpeg / ffprobe。
 * 结果缓存，进程生命周期内只检测一次。
 */
export async function detectVideoCapability(): Promise<VideoCapability> {
  if (_capability) return _capability;

  const [ffmpegOk, ffprobeOk] = await Promise.all([
    checkExecutable(config.video.ffmpegPath),
    checkExecutable(config.video.ffprobePath),
  ]);

  _capability = {
    ffmpegOk,
    ffprobeOk,
    available: ffmpegOk && ffprobeOk && config.video.enabled,
  };
  return _capability;
}

async function checkExecutable(execPath: string): Promise<boolean> {
  // If the path is just a name (no slashes), try which; otherwise check access
  if (!execPath.includes("/")) {
    try {
      await execFileAsync("which", [execPath], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
  try {
    await fs.access(execPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * ffprobe 探测视频元信息。
 * 超时 10s，失败抛 VideoProcessingError。
 */
export async function probeVideo(filePath: string): Promise<VideoProbeResult> {
  const ffprobe = config.video.ffprobePath;
  let stdout: string;

  try {
    const result = await execFileAsync(
      ffprobe,
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err) {
    throw new VideoProcessingError(
      `ffprobe 失败: ${err instanceof Error ? err.message : String(err)}`,
      "probe",
    );
  }

  let probeData: Record<string, unknown>;
  try {
    probeData = JSON.parse(stdout);
  } catch {
    throw new VideoProcessingError("ffprobe 输出解析失败", "probe");
  }

  const streams = (probeData.streams as Record<string, unknown>[]) ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");
  const format = (probeData.format ?? {}) as Record<string, unknown>;

  if (!videoStream) {
    throw new VideoProcessingError("文件不包含视频流", "probe");
  }

  const width = Number(videoStream.width) || 0;
  const height = Number(videoStream.height) || 0;
  const durationSec = Number(format.duration) || Number(videoStream.duration) || 0;
  const videoCodec = String(videoStream.codec_name ?? "unknown");

  // FPS: avg_frame_rate 格式 "30000/1001" 或 "30/1"
  let videoFps = 0;
  const fpsStr = String(videoStream.avg_frame_rate ?? "0/1");
  const [num, den] = fpsStr.split("/").map(Number);
  if (num && den) videoFps = num / den;

  const hasAudio = !!audioStream;

  // 尝试从 format tags 提取 creation_time 作为 takenAt
  let takenAt: Date | undefined;
  const tags = (format.tags ?? {}) as Record<string, unknown>;
  const creationTime = String(tags.creation_time ?? "");
  if (creationTime) {
    const d = new Date(creationTime);
    if (!Number.isNaN(d.getTime())) takenAt = d;
  }

  return { width, height, durationSec, videoCodec, videoFps, hasAudio, takenAt };
}

/**
 * 从视频抽取 N 帧，优先用 scene-cut 检测，不足时 fallback 时间均匀采样。
 * 返回 Buffer[]（按时间顺序，每帧 768×768 JPEG）。第 0 帧可作为 cover。
 * 临时目录在函数返回后清理。
 *
 * `onSceneTimes` 可选回调会在 scene-cut 分支成功后被调用一次，传入解析自
 * ffmpeg `showinfo` 的每帧 `pts_time`（秒）。fallback 到均匀采样时不会调用。
 */
export async function extractFrames(
  filePath: string,
  count: number,
  opts: { sceneFirst?: boolean; onSceneTimes?: (times: number[]) => void } = {},
): Promise<Buffer[]> {
  const tmpDir = path.join(
    os.tmpdir(),
    `relight-video-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const probe = await probeVideo(filePath);
    const durationSec = probe.durationSec;

    // 超短视频（<3s）直接取单帧
    const effectiveCount = durationSec < 3 ? 1 : count;

    let frames: Buffer[] = [];

    // 先尝试 scene-cut
    if (effectiveCount > 1) {
      frames = await extractSceneCutFrames(
        filePath,
        effectiveCount,
        tmpDir,
        durationSec,
        opts.onSceneTimes,
      );
    }

    // 不足时 fallback 到时间均匀采样
    if (frames.length < effectiveCount) {
      frames = await extractUniformFrames(filePath, effectiveCount, tmpDir, durationSec);
    }

    if (frames.length === 0) {
      throw new VideoProcessingError("无法从视频中提取帧", "extract_frames");
    }

    // 每帧 resize 到 768×768
    const resizedFrames = await Promise.all(
      frames.map((buf) =>
        sharp(buf)
          .resize(768, 768, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer(),
      ),
    );

    return resizedFrames;
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractSceneCutFrames(
  filePath: string,
  count: number,
  tmpDir: string,
  durationSec: number,
  onSceneTimes?: (times: number[]) => void,
): Promise<Buffer[]> {
  const outPattern = path.join(tmpDir, "scene_%04d.jpg");
  const ffmpeg = config.video.ffmpegPath;

  return new Promise<Buffer[]>((resolve) => {
    const args = [
      "-i",
      filePath,
      "-vf",
      `select='gt(scene,0.3)',showinfo`,
      "-vsync",
      "vfr",
      "-frames:v",
      String(count),
      "-q:v",
      "2",
      outPattern,
    ];

    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderrBuf = "";
    if (onSceneTimes) {
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });
    }

    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      proc.kill("SIGKILL");
      resolve([]);
    }, 30_000);

    // ffmpeg 可执行文件不存在/无权限 → ENOENT 走 error 事件，避免 unhandledRejection
    proc.on("error", () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve([]);
    });

    proc.on("close", async (code) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (code !== 0) {
        resolve([]);
        return;
      }
      if (onSceneTimes) {
        const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
        const times: number[] = [];
        let m: RegExpExecArray | null;
        m = re.exec(stderrBuf);
        while (m !== null) {
          const t = Number(m[1]);
          if (Number.isFinite(t) && t >= 0) times.push(t);
          m = re.exec(stderrBuf);
        }
        try {
          onSceneTimes(times);
        } catch {
          // 不影响主流程
        }
      }
      try {
        const files = await readFrameFiles(tmpDir, "scene_");
        resolve(files);
      } catch {
        // readFrameFiles 内部已有 try/catch 返回 []，这层兜底防御未来回归
        resolve([]);
      }
    });
  });
}

async function extractUniformFrames(
  filePath: string,
  count: number,
  tmpDir: string,
  durationSec: number,
): Promise<Buffer[]> {
  const outPattern = path.join(tmpDir, "uniform_%04d.jpg");
  const ffmpeg = config.video.ffmpegPath;
  const fps = durationSec > 0 ? count / durationSec : 1;

  return new Promise<Buffer[]>((resolve, reject) => {
    const args = [
      "-i",
      filePath,
      "-vf",
      `fps=${fps}`,
      "-frames:v",
      String(count),
      "-q:v",
      "2",
      outPattern,
    ];

    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });

    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      proc.kill("SIGKILL");
      reject(new VideoProcessingError("均匀采帧超时", "extract_frames"));
    }, 30_000);

    proc.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      reject(new VideoProcessingError(`ffmpeg spawn 失败: ${err.message}`, "extract_frames"));
    });

    proc.on("close", async (code) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (code !== 0) {
        reject(new VideoProcessingError(`ffmpeg 均匀采帧退出码: ${code}`, "extract_frames"));
        return;
      }
      try {
        const files = await readFrameFiles(tmpDir, "uniform_");
        resolve(files);
      } catch (err) {
        reject(
          new VideoProcessingError(
            `读取帧文件失败: ${err instanceof Error ? err.message : String(err)}`,
            "extract_frames",
          ),
        );
      }
    });
  });
}

async function readFrameFiles(dir: string, prefix: string): Promise<Buffer[]> {
  try {
    const entries = await fs.readdir(dir);
    const frameFiles = entries.filter((f) => f.startsWith(prefix) && f.endsWith(".jpg")).sort();
    return Promise.all(frameFiles.map((f) => fs.readFile(path.join(dir, f))));
  } catch {
    return [];
  }
}

/**
 * 从视频提取音轨为 16kHz mono WAV。
 * 无音轨时返回 null。
 * 超时 60s。
 */
export async function extractAudio(filePath: string, outputPath: string): Promise<string | null> {
  // 先探测是否有音轨
  const probe = await probeVideo(filePath);
  if (!probe.hasAudio) return null;

  const ffmpeg = config.video.ffmpegPath;

  return new Promise<string | null>((resolve, reject) => {
    const args = [
      "-i",
      filePath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-y",
      outputPath,
    ];

    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });

    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      proc.kill("SIGKILL");
      reject(new VideoProcessingError("音频提取超时", "extract_audio"));
    }, 60_000);

    proc.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      reject(new VideoProcessingError(`ffmpeg spawn 失败: ${err.message}`, "extract_audio"));
    });

    proc.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (code !== 0) {
        reject(new VideoProcessingError(`音频提取失败，退出码: ${code}`, "extract_audio"));
        return;
      }
      resolve(outputPath);
    });
  });
}

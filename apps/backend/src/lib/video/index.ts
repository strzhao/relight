import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config";
import { VideoProcessingError, extractAudio, extractFrames, probeVideo } from "./ffmpeg";
import { composeSprite } from "./sprite";
import { transcribeAudio } from "./transcribe";
import type { TranscribeResult } from "./transcribe";

export interface VideoAnalysisResult {
  spriteBuffer: Buffer;
  coverFrameBuffer: Buffer;
  transcript: string | null;
  segments: { start: number; end: number; text: string }[];
  durationSec: number;
  fps: number;
  codec: string;
  hasAudio: boolean;
}

/**
 * 高层 API：对视频做全面分析准备。
 * 调用顺序：probeVideo → extractFrames → composeSprite → extractAudio → transcribeAudio → 清理。
 * transcribe 失败不阻塞 vision 分析（transcript=null）。
 * 抽帧失败则抛错。
 */
export async function analyzeVideoForAI(
  filePath: string,
  jobLog?: (msg: string) => void,
): Promise<VideoAnalysisResult> {
  const log = jobLog ?? ((msg: string) => console.log(`[video] ${msg}`));
  const frameCount = config.video.frameCount;

  // 1. 探测元信息
  log(`探测视频: ${filePath}`);
  const probe = await probeVideo(filePath);
  log(
    `视频信息: ${probe.durationSec.toFixed(1)}s, ${probe.videoCodec}, ${probe.videoFps.toFixed(1)}fps, 音频: ${probe.hasAudio}`,
  );

  // 2. 抽帧
  log(`抽取 ${frameCount} 帧...`);
  const frames = await extractFrames(filePath, frameCount);
  const firstFrameBuffer = frames[0];
  if (!firstFrameBuffer) throw new VideoProcessingError("无法抽取任何帧", "extract_frames");
  log(`成功抽取 ${frames.length} 帧`);

  // 3. 拼雪碧图
  log("拼合雪碧图...");
  const spriteBuffer = await composeSprite(frames);
  log(`雪碧图大小: ${spriteBuffer.length} bytes`);

  // 4. 提取音频 + 转录（失败不抛错）
  let transcript: string | null = null;
  let segments: { start: number; end: number; text: string }[] = [];

  if (probe.hasAudio && config.whisper.enabled) {
    const tmpDir = path.join(
      os.tmpdir(),
      `relight-audio-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    const audioPath = path.join(tmpDir, "audio.wav");

    try {
      log("提取音频...");
      const audioResult = await extractAudio(filePath, audioPath);
      if (audioResult) {
        log("调用 Whisper 转录...");
        const result: TranscribeResult | null = await transcribeAudio(audioResult);
        if (result) {
          transcript = result.text || null;
          segments = result.segments;
          log(`转录完成: ${result.text.length} 字符`);
        } else {
          log("Whisper 转录返回空结果");
        }
      }
    } catch (err) {
      log(`音频处理失败（不阻塞）: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } else if (!probe.hasAudio) {
    log("视频无音轨，跳过转录");
  } else {
    log("Whisper 未启用，跳过转录");
  }

  return {
    spriteBuffer,
    coverFrameBuffer: firstFrameBuffer,
    transcript,
    segments,
    durationSec: probe.durationSec,
    fps: probe.videoFps,
    codec: probe.videoCodec,
    hasAudio: probe.hasAudio,
  };
}

export { VideoProcessingError };

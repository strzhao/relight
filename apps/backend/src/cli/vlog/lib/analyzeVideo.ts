import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { aiClient } from "../../../ai/client";
import { loadPrompts } from "../../../ai/prompts";
import { config } from "../../../lib/config";
import { dHash } from "../../../lib/phash";
import { extractFrames, probeVideo } from "../../../lib/video/ffmpeg";
import { composeSprite } from "../../../lib/video/sprite";
import {
  type VideoAnalysisResponse,
  type VideoAnalysisResult,
  videoAnalysisResponseSchema,
} from "../types";
import { cacheGet, cachePut } from "./cache";
import { err, fileSha256, fileSize, resolveRealPath } from "./util";

export interface AnalyzeVideoOptions {
  promptVersion?: string;
  frames?: number;
  skipAi?: boolean;
  cacheOnly?: boolean;
  /** Optional transcript text to feed into the prompt's {transcript} placeholder. */
  transcriptHint?: string;
  /** Save sprite to this path. If unset, sprite is held only in memory. */
  spriteOutDir?: string;
}

const JSON_BLOCK_RE = /```json\s*([\s\S]*?)\s*```/i;
const JSON_FALLBACK_RE = /\{[\s\S]*\}/;

function tryParseVideoResponse(raw: string): {
  parsed: VideoAnalysisResponse | null;
  error?: string;
} {
  let jsonStr: string | null = null;
  const blockMatch = raw.match(JSON_BLOCK_RE);
  if (blockMatch?.[1]) jsonStr = blockMatch[1].trim();
  else {
    const fb = raw.match(JSON_FALLBACK_RE);
    if (fb?.[0]) jsonStr = fb[0].trim();
  }
  if (!jsonStr) return { parsed: null, error: "no json block" };

  let raw2: unknown;
  try {
    raw2 = JSON.parse(jsonStr);
  } catch (e) {
    return { parsed: null, error: `json parse: ${(e as Error).message}` };
  }
  const result = videoAnalysisResponseSchema.safeParse(raw2);
  if (result.success) return { parsed: result.data };
  return { parsed: null, error: `zod: ${result.error.message}` };
}

/**
 * Find the longest gap between consecutive sceneTimes — that's the most stable segment.
 * If sceneTimes is empty or has 1 entry, return middle 50% of duration.
 */
function computeSuggestedTrim(
  sceneTimes: number[],
  durationSec: number,
): { startSec: number; endSec: number; rationale: string } {
  if (durationSec <= 0) return { startSec: 0, endSec: 0, rationale: "zero duration" };
  if (durationSec < 4) {
    return { startSec: 0, endSec: durationSec, rationale: "shorter than 4s, use full clip" };
  }
  if (sceneTimes.length < 2) {
    const start = durationSec * 0.15;
    const end = durationSec * 0.85;
    return { startSec: start, endSec: end, rationale: "no scene cuts, use middle 70%" };
  }
  const sorted = [...sceneTimes].sort((a, b) => a - b);
  const bounds = [0, ...sorted, durationSec];
  let bestStart = 0;
  let bestEnd = durationSec;
  let bestGap = 0;
  for (let i = 0; i < bounds.length - 1; i++) {
    const gap = (bounds[i + 1] ?? 0) - (bounds[i] ?? 0);
    if (gap > bestGap) {
      bestGap = gap;
      bestStart = bounds[i] ?? 0;
      bestEnd = bounds[i + 1] ?? durationSec;
    }
  }
  const margin = Math.min(0.3, bestGap * 0.1);
  return {
    startSec: Math.max(0, bestStart + margin),
    endSec: Math.min(durationSec, bestEnd - margin),
    rationale: `longest stable gap ${bestGap.toFixed(2)}s between scene cuts`,
  };
}

export async function analyzeVideo(
  filePath: string,
  opts: AnalyzeVideoOptions = {},
): Promise<VideoAnalysisResult> {
  const t0 = Date.now();
  const promptVersion = opts.promptVersion ?? config.ai.promptVersion ?? "v2";
  const frameCount = opts.frames ?? config.video.frameCount ?? 6;
  const realPath = await resolveRealPath(filePath);
  const sha256 = await fileSha256(realPath);
  const fsize = await fileSize(realPath);
  const cacheKey = `video:${sha256}:${promptVersion}:${frameCount}:${opts.skipAi ? "noai" : "ai"}:${opts.transcriptHint ? "tx" : "notx"}`;

  const cached = cacheGet<VideoAnalysisResult>(cacheKey);
  if (cached) {
    return { ...cached, filePath, realPath, cacheHit: true, elapsedMs: Date.now() - t0 };
  }

  if (opts.cacheOnly) {
    return {
      ok: false,
      type: "video",
      filePath,
      realPath,
      sha256,
      fileSize: fsize,
      width: 0,
      height: 0,
      durationSec: 0,
      videoCodec: "",
      videoFps: 0,
      hasAudio: false,
      sceneTimes: [],
      cacheHit: false,
      elapsedMs: Date.now() - t0,
      error: "cache miss in --cache-only mode",
    };
  }

  let probe: Awaited<ReturnType<typeof probeVideo>>;
  try {
    probe = await probeVideo(realPath);
  } catch (e) {
    return {
      ok: false,
      type: "video",
      filePath,
      realPath,
      sha256,
      fileSize: fsize,
      width: 0,
      height: 0,
      durationSec: 0,
      videoCodec: "",
      videoFps: 0,
      hasAudio: false,
      sceneTimes: [],
      cacheHit: false,
      elapsedMs: Date.now() - t0,
      error: `probe failed: ${(e as Error).message}`,
    };
  }

  let sceneTimes: number[] = [];
  let frames: Buffer[] = [];
  try {
    frames = await extractFrames(realPath, frameCount, {
      sceneFirst: true,
      onSceneTimes: (times) => {
        sceneTimes = times;
      },
    });
  } catch (e) {
    err(`[analyzeVideo] extractFrames error: ${(e as Error).message}`);
  }

  if (frames.length === 0) {
    return {
      ok: false,
      type: "video",
      filePath,
      realPath,
      sha256,
      fileSize: fsize,
      width: probe.width,
      height: probe.height,
      durationSec: probe.durationSec,
      videoCodec: probe.videoCodec,
      videoFps: probe.videoFps,
      hasAudio: probe.hasAudio,
      takenAt: probe.takenAt?.toISOString(),
      sceneTimes: [],
      cacheHit: false,
      elapsedMs: Date.now() - t0,
      error: "frame extraction yielded 0 frames",
    };
  }

  const sprite = await composeSprite(frames);
  let spritePath: string | undefined;
  if (opts.spriteOutDir) {
    await fs.mkdir(opts.spriteOutDir, { recursive: true });
    spritePath = path.join(opts.spriteOutDir, `${sha256}.sprite.jpg`);
    await fs.writeFile(spritePath, sprite);
  }

  let phash: string | undefined;
  try {
    if (frames[0]) phash = await dHash(frames[0]);
  } catch (e) {
    err(`[analyzeVideo] dHash failed: ${(e as Error).message}`);
  }

  const suggestedTrim = computeSuggestedTrim(sceneTimes, probe.durationSec);

  let ai: VideoAnalysisResponse | undefined;
  let aiError: string | undefined;

  if (!opts.skipAi) {
    try {
      const prompts = await loadPrompts(promptVersion, "video");
      const userPrompt = prompts.user
        .replace("{frame_count}", String(frames.length))
        .replace("{duration}", probe.durationSec.toFixed(1))
        .replace("{transcript}", opts.transcriptHint?.trim() || "（无音频或无转录）");
      const base64 = sprite.toString("base64");
      const raw = await aiClient.analyzePhoto(base64, "image/jpeg", prompts.system, userPrompt);
      const r = tryParseVideoResponse(raw);
      if (r.parsed) ai = r.parsed;
      else {
        aiError = r.error;
        err(`[analyzeVideo] AI parse fail: ${r.error}`);
      }
    } catch (e) {
      aiError = (e as Error).message;
      err(`[analyzeVideo] AI call failed: ${aiError}`);
    }
  }

  const result: VideoAnalysisResult = {
    ok: !aiError || !!ai,
    type: "video",
    filePath,
    realPath,
    sha256,
    fileSize: fsize,
    width: probe.width,
    height: probe.height,
    durationSec: probe.durationSec,
    videoCodec: probe.videoCodec,
    videoFps: probe.videoFps,
    hasAudio: probe.hasAudio,
    takenAt: probe.takenAt?.toISOString(),
    phash,
    spritePath,
    sceneTimes,
    suggestedTrim,
    ai,
    promptVersion: opts.skipAi ? undefined : promptVersion,
    cacheHit: false,
    elapsedMs: Date.now() - t0,
    error: aiError,
  };

  cachePut(cacheKey, "video", result);
  return result;
}

// Make sprite tmp dir available for callers that don't pass spriteOutDir
export async function defaultSpriteDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), "vlog-sprites");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

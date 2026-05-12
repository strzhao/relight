import fs from "node:fs/promises";
import sharp from "sharp";
import { aiClient } from "../../../ai/client";
import { loadPrompts } from "../../../ai/prompts";
import { parseAnalysisResponse } from "../../../ai/response-parser";
import { config } from "../../../lib/config";
import { convertHeicToJpeg, isHeicBuffer, isHeicFile } from "../../../lib/heic";
import { dHash } from "../../../lib/phash";
import type { ImageAnalysisResult } from "../types";
import { cacheGet, cachePut } from "./cache";
import { err, fileSha256, fileSize, resolveRealPath } from "./util";

const MAX_DIM = 2048;

export interface AnalyzeImageOptions {
  promptVersion?: string;
  skipAi?: boolean;
  cacheOnly?: boolean;
}

export async function analyzeImage(
  filePath: string,
  opts: AnalyzeImageOptions = {},
): Promise<ImageAnalysisResult> {
  const t0 = Date.now();
  const promptVersion = opts.promptVersion ?? config.ai.promptVersion ?? "v2";
  const realPath = await resolveRealPath(filePath);
  const sha256 = await fileSha256(realPath);
  const fsize = await fileSize(realPath);
  const cacheKey = `image:${sha256}:${promptVersion}:${opts.skipAi ? "noai" : "ai"}`;

  const cached = cacheGet<ImageAnalysisResult>(cacheKey);
  if (cached) {
    return { ...cached, filePath, realPath, cacheHit: true, elapsedMs: Date.now() - t0 };
  }
  if (opts.cacheOnly) {
    return {
      ok: false,
      type: "image",
      filePath,
      realPath,
      sha256,
      fileSize: fsize,
      width: 0,
      height: 0,
      cacheHit: false,
      elapsedMs: Date.now() - t0,
      error: "cache miss in --cache-only mode",
    };
  }

  let buf = await fs.readFile(realPath);

  if (isHeicFile(realPath) || isHeicBuffer(buf)) {
    err(`[analyzeImage] HEIC detected → converting: ${realPath}`);
    buf = await convertHeicToJpeg(buf, { quality: 90 });
  }

  const metadata = await sharp(buf).metadata();
  const origWidth = metadata.width ?? 0;
  const origHeight = metadata.height ?? 0;

  let resized = buf;
  if (origWidth > MAX_DIM || origHeight > MAX_DIM) {
    resized = await sharp(buf)
      .resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  }

  let phash: string | undefined;
  try {
    phash = await dHash(resized);
  } catch (e) {
    err(`[analyzeImage] dHash failed: ${(e as Error).message}`);
  }

  let ai: ImageAnalysisResult["ai"];
  let aiError: string | undefined;

  if (!opts.skipAi) {
    try {
      const prompts = await loadPrompts(promptVersion);
      const base64 = resized.toString("base64");
      const raw = await aiClient.analyzePhoto(base64, "image/jpeg", prompts.system, prompts.user);
      const parsed = parseAnalysisResponse(raw);
      if (parsed.parsed) {
        ai = parsed.parsed;
      } else {
        ai = parsed.fallback;
        aiError = parsed.error ?? "ai parse fallback used";
        err(`[analyzeImage] AI parse fallback: ${aiError}`);
      }
    } catch (e) {
      aiError = (e as Error).message;
      err(`[analyzeImage] AI call failed: ${aiError}`);
    }
  }

  const result: ImageAnalysisResult = {
    ok: !aiError || !!ai,
    type: "image",
    filePath,
    realPath,
    sha256,
    fileSize: fsize,
    width: origWidth,
    height: origHeight,
    phash,
    ai,
    promptVersion: opts.skipAi ? undefined : promptVersion,
    cacheHit: false,
    elapsedMs: Date.now() - t0,
    error: aiError,
  };

  cachePut(cacheKey, "image", result);
  return result;
}

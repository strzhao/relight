import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../../../lib/config";
import { extractAudio, probeVideo } from "../../../lib/video/ffmpeg";
import type { TranscriptResult, TranscriptSegment } from "../types";
import { cacheGet, cachePut } from "./cache";
import { classifyFile, err, fileSha256, fileSize, resolveRealPath, toSrt } from "./util";

export interface TranscribeOptions {
  model?: string;
  language?: string;
  wordTimestamps?: boolean;
  /** Engine override (mlx/faster/whisper). Falls back to WHISPER_ENGINE env / config. */
  engine?: string;
  /** Initial prompt to bias Whisper toward domain vocabulary. */
  initialPrompt?: string;
  /** Hard timeout in milliseconds (default 10 min for large models). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function transcribeFile(
  filePath: string,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  const t0 = Date.now();
  const realPath = await resolveRealPath(filePath);
  const sha256 = await fileSha256(realPath);
  const fsize = await fileSize(realPath);
  const model = opts.model ?? process.env.WHISPER_MODEL ?? config.whisper.model;
  const language = opts.language ?? process.env.WHISPER_LANGUAGE ?? config.whisper.language;
  const engine = opts.engine ?? process.env.WHISPER_ENGINE ?? config.whisper.engine;
  const initialPrompt = opts.initialPrompt ?? process.env.WHISPER_INITIAL_PROMPT ?? "";
  const wordTimestamps = opts.wordTimestamps ?? false;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Cache key includes a hash of the initial prompt + engine, so changing
  // prompt/engine invalidates cache and triggers re-transcription.
  const promptHash = initialPrompt
    ? crypto.createHash("sha1").update(initialPrompt).digest("hex").slice(0, 8)
    : "noprompt";
  const cacheKey = `transcript:${sha256}:${engine}:${model}:${language}:${wordTimestamps ? "wt" : "nowt"}:${promptHash}`;

  const cached = cacheGet<TranscriptResult>(cacheKey);
  if (cached) {
    return { ...cached, filePath, realPath, cacheHit: true, elapsedMs: Date.now() - t0 };
  }

  const kind = classifyFile(realPath);
  let audioPath = realPath;
  let audioCleanup: string | null = null;

  try {
    if (kind === "video") {
      const probe = await probeVideo(realPath);
      if (!probe.hasAudio) {
        return buildEmpty(
          filePath,
          realPath,
          sha256,
          fsize,
          model,
          language,
          wordTimestamps,
          t0,
          "video has no audio",
        );
      }
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vlog-asr-"));
      audioPath = path.join(tmpDir, "audio.wav");
      audioCleanup = tmpDir;
      const out = await extractAudio(realPath, audioPath);
      if (!out) {
        return buildEmpty(
          filePath,
          realPath,
          sha256,
          fsize,
          model,
          language,
          wordTimestamps,
          t0,
          "extractAudio returned null",
        );
      }
    }

    const { segments: rawSegments, detectedLanguage } = await runWhisper(audioPath, {
      model,
      language,
      engine,
      initialPrompt,
      wordTimestamps,
      timeoutMs,
    });
    const segments = filterHallucinations(rawSegments);
    const text = segments
      .map((s) => s.text)
      .join("")
      .trim();
    const srt = toSrt(segments);
    const hadHallucinations = rawSegments.length !== segments.length;

    const result: TranscriptResult = {
      ok: true,
      type: "transcript",
      filePath,
      realPath,
      sha256,
      fileSize: fsize,
      language: detectedLanguage || (language === "auto" ? "auto" : language),
      text,
      segments,
      srt,
      model,
      hasWordTimestamps: wordTimestamps && segments.some((s) => (s.words?.length ?? 0) > 0),
      cacheHit: false,
      elapsedMs: Date.now() - t0,
      error: hadHallucinations
        ? `filtered ${rawSegments.length - segments.length}/${rawSegments.length} hallucinated segments`
        : undefined,
    };

    cachePut(cacheKey, "transcript", result);
    return result;
  } catch (e) {
    const msg = (e as Error).message;
    err(`[transcribe] ${msg}`);
    return buildEmpty(filePath, realPath, sha256, fsize, model, language, wordTimestamps, t0, msg);
  } finally {
    if (audioCleanup) {
      fs.rm(audioCleanup, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function buildEmpty(
  filePath: string,
  realPath: string,
  sha256: string,
  fsize: number,
  model: string,
  language: string,
  wordTimestamps: boolean,
  t0: number,
  reason: string,
): TranscriptResult {
  return {
    ok: false,
    type: "transcript",
    filePath,
    realPath,
    sha256,
    fileSize: fsize,
    language: language === "auto" ? "auto" : language,
    text: "",
    segments: [],
    srt: "",
    model,
    hasWordTimestamps: false,
    cacheHit: false,
    elapsedMs: Date.now() - t0,
    error: reason,
  };
}

/**
 * Filter out classic whisper hallucinations on silent / non-speech audio:
 *  - "ご視聴ありがとうございました" / "Thanks for watching"
 *  - 重复 token > 4 次 (e.g. "ionsionsions...")
 *  - 同一文本出现于多于 3 个连续片段
 */
function filterHallucinations(segments: TranscriptSegment[]): TranscriptSegment[] {
  const HALLUCINATION_PHRASES = [
    "ご視聴ありがとうございました",
    "thanks for watching",
    "thank you for watching",
    "subtitles by",
    "字幕由",
  ];
  const out: TranscriptSegment[] = [];
  let prevText = "";
  let repeatCount = 0;
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const lc = text.toLowerCase();
    if (HALLUCINATION_PHRASES.some((p) => lc.includes(p.toLowerCase()))) continue;
    // Detect short token repeat ("ionsions..."): if the same 3-5 char substring repeats >= 4 times
    if (/(.{3,8})\1{3,}/.test(text)) continue;
    if (text === prevText) {
      repeatCount++;
      if (repeatCount >= 2) continue;
    } else {
      repeatCount = 0;
    }
    prevText = text;
    out.push(seg);
  }
  return out;
}

async function runWhisper(
  audioPath: string,
  opts: {
    model: string;
    language: string;
    engine: string;
    initialPrompt: string;
    wordTimestamps: boolean;
    timeoutMs: number;
  },
): Promise<{ segments: TranscriptSegment[]; detectedLanguage: string | undefined }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vlog-asr-out-"));
  try {
    const args = [
      config.whisper.script,
      audioPath,
      "--engine",
      opts.engine,
      "--model",
      opts.model,
      "--language",
      opts.language,
      "--output-format",
      "json",
      "--output-dir",
      tmpDir,
    ];
    if (opts.wordTimestamps) args.push("--word-timestamps");
    if (opts.initialPrompt) args.push("--initial-prompt", opts.initialPrompt);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(config.whisper.python, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderrTail = "";
      proc.stdout?.on("data", () => {});
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4096);
      });
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`whisper timeout (${opts.timeoutMs}ms)`));
      }, opts.timeoutMs);
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(`whisper exit ${code}: ${stderrTail.split("\n").slice(-3).join(" | ")}`),
          );
        } else {
          resolve();
        }
      });
    });

    const stem = path.basename(audioPath, path.extname(audioPath));
    const jsonPath = path.join(tmpDir, `${stem}.json`);
    const raw = await fs.readFile(jsonPath, "utf-8");
    const data = JSON.parse(raw) as {
      text?: string;
      language?: string;
      segments?: Array<{
        start?: number;
        end?: number;
        text?: string;
        words?: Array<{ start?: number; end?: number; word?: string; probability?: number | null }>;
      }>;
    };

    const segments: TranscriptSegment[] = (data.segments ?? []).map((s) => ({
      start: Number(s.start ?? 0),
      end: Number(s.end ?? 0),
      text: String(s.text ?? "").trim(),
      words: s.words?.map((w) => ({
        start: Number(w.start ?? 0),
        end: Number(w.end ?? 0),
        word: String(w.word ?? "").trim(),
        probability: typeof w.probability === "number" ? w.probability : undefined,
      })),
    }));

    return { segments, detectedLanguage: data.language };
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

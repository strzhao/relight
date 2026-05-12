import crypto from "node:crypto";
import fs from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { TranscriptSegment } from "../types";

export const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".bmp",
  ".tiff",
]);
export const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"]);

export function classifyFile(filePath: string): "image" | "video" | "unknown" {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "unknown";
}

export function err(...args: unknown[]): void {
  process.stderr.write(
    `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
  );
}

export async function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function resolveRealPath(filePath: string): Promise<string> {
  return realpath(filePath);
}

export async function fileSize(filePath: string): Promise<number> {
  const s = await stat(filePath);
  return s.size;
}

export function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function pad3(n: number): string {
  return n.toString().padStart(3, "0");
}

export function formatSrtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const totalM = Math.floor(totalS / 60);
  const m = totalM % 60;
  const h = Math.floor(totalM / 60);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

export function toSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((seg, i) => {
      const start = formatSrtTime(seg.start);
      const end = formatSrtTime(seg.end);
      const text = seg.text.trim();
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join("\n");
}

/**
 * Re-base segment timestamps so that `srcStart` becomes 0 and segments outside
 * `[srcStart, srcEnd]` are dropped (or clipped).
 */
export function segmentRebase(
  segments: TranscriptSegment[],
  srcStart: number,
  srcEnd: number,
): TranscriptSegment[] {
  return segments
    .filter((s) => s.end > srcStart && s.start < srcEnd)
    .map((s) => {
      const start = Math.max(0, s.start - srcStart);
      const end = Math.min(srcEnd - srcStart, s.end - srcStart);
      const words = s.words?.map((w) => ({
        start: Math.max(0, w.start - srcStart),
        end: Math.min(srcEnd - srcStart, w.end - srcStart),
        word: w.word,
        probability: w.probability,
      }));
      return { start, end, text: s.text, words };
    });
}

/** Limit the number of concurrently running async tasks. */
export function pLimit<T>(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= concurrency) return;
    const task = queue.shift();
    if (!task) return;
    active++;
    task();
  };
  return (fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = async () => {
        try {
          const out = await fn();
          resolve(out);
        } catch (e) {
          reject(e);
        } finally {
          active--;
          next();
        }
      };
      queue.push(run);
      next();
    });
}

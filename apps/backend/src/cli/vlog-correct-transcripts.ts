/**
 * vlog-correct-transcripts — AI 字幕纠错 CLI
 *
 * 输入 manifest.json，对每个有 transcript 的 video 调 Qwen3.6 让它结合
 * 画面 brief + tags 修正同音错字。仅修改 segments[].text 和 transcript.text，
 * 保持时间码 / words 数组完全不变。
 *
 * 用法：
 *   tsx src/cli/vlog-correct-transcripts.ts <manifestPath> \
 *     [--out <new-manifest.json>] \
 *     [--concurrency 3] \
 *     [--prompt-version v2] \
 *     [--force]    # 忽略 cache
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { aiClient } from "../ai/client";
import { loadPrompts } from "../ai/prompts";
import { cacheGet, cachePut } from "./vlog/lib/cache";
import { err, pLimit } from "./vlog/lib/util";
import {
  type BatchManifest,
  type ManifestVideoEntry,
  type TranscriptSegment,
  batchManifestSchema,
} from "./vlog/types";

interface CliOpts {
  manifestPath: string | null;
  out?: string;
  concurrency: number;
  promptVersion: string;
  force: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    manifestPath: null,
    concurrency: 3,
    promptVersion: "v2",
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--concurrency") opts.concurrency = Number(argv[++i]);
    else if (a === "--prompt-version") opts.promptVersion = argv[++i] ?? "v2";
    else if (a === "--force") opts.force = true;
    else if (a && !a.startsWith("--") && opts.manifestPath === null) opts.manifestPath = a;
  }
  return opts;
}

const JSON_BLOCK_RE = /```json\s*([\s\S]*?)\s*```/i;
const JSON_FALLBACK_RE = /\{[\s\S]*\}/;

function extractJsonString(raw: string): string | null {
  const m = raw.match(JSON_BLOCK_RE);
  if (m?.[1]) return m[1].trim();
  const f = raw.match(JSON_FALLBACK_RE);
  return f?.[0]?.trim() ?? null;
}

const correctResponseSchema = z.object({
  segments: z.array(z.string()),
});

function buildSegmentsBlock(segments: TranscriptSegment[]): string {
  return segments.map((s, i) => `${i + 1}. ${s.text}`).join("\n");
}

function formatLocalTime(iso: string | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  const cn = new Date(d.getTime() + 8 * 3600 * 1000);
  const hh = String(cn.getUTCHours()).padStart(2, "0");
  const mm = String(cn.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function fidFromPath(p: string): string {
  return path.basename(p, path.extname(p));
}

/**
 * Run AI correction on a single video's transcript segments.
 * Returns null if no correction is needed (no transcript / single empty segment / cache hit handled by caller).
 */
async function correctSegments(
  fid: string,
  entry: ManifestVideoEntry,
  prompts: { system: string; user: string },
): Promise<string[] | null> {
  const segments = entry.transcript?.segments ?? [];
  if (segments.length === 0) return null;
  const meaningful = segments.filter((s) => s.text.trim().length > 0);
  if (meaningful.length === 0) return null;

  const tags = (entry.ai?.tags ?? [])
    .slice(0, 6)
    .map((t) => t.name)
    .join("、");
  const brief = (entry.ai?.narrative ?? "").slice(0, 200);

  const userPrompt = prompts.user
    .replace("{fid}", fid)
    .replace("{time}", formatLocalTime(entry.takenAt))
    .replace("{duration}", entry.durationSec.toFixed(1))
    .replace("{brief}", brief || "(无)")
    .replace("{tags}", tags || "(无)")
    .replace("{n}", String(segments.length))
    .replace("{segments}", buildSegmentsBlock(segments));

  const raw = await aiClient.chat(userPrompt, prompts.system, { maxTokens: 4096 });
  const jsonStr = extractJsonString(raw);
  if (!jsonStr) {
    err(`[correct][${fid}] WARN: no json in AI response — keeping original`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    err(`[correct][${fid}] WARN: json parse failed: ${(e as Error).message}`);
    return null;
  }
  const result = correctResponseSchema.safeParse(parsed);
  if (!result.success) {
    err(`[correct][${fid}] WARN: zod fail: ${result.error.message}`);
    return null;
  }
  if (result.data.segments.length !== segments.length) {
    err(
      `[correct][${fid}] WARN: AI returned ${result.data.segments.length} segments, expected ${segments.length} — keeping original`,
    );
    return null;
  }
  // Sanity: each corrected segment must be within ±60% character length of original
  for (let i = 0; i < segments.length; i++) {
    const origLen = segments[i].text.trim().length;
    const newLen = result.data.segments[i].trim().length;
    if (origLen > 0 && (newLen > origLen * 1.6 || newLen < origLen * 0.4)) {
      err(
        `[correct][${fid}] WARN: seg ${i + 1} length diverged (${origLen} → ${newLen}) — keeping original for this seg`,
      );
      result.data.segments[i] = segments[i].text;
    }
  }
  return result.data.segments;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.manifestPath) {
    err(
      "用法: tsx src/cli/vlog-correct-transcripts.ts <manifestPath> [--out <path>] [--concurrency 3] [--force]",
    );
    process.exit(1);
  }
  const manifestPath = path.resolve(opts.manifestPath);
  const outPath = path.resolve(opts.out ?? opts.manifestPath);
  const raw = await fs.readFile(manifestPath, "utf-8");
  const manifest = batchManifestSchema.parse(JSON.parse(raw)) as BatchManifest;

  const prompts = await loadPrompts(opts.promptVersion, "vlog/correct-transcript");
  const videos = manifest.files.filter(
    (f): f is ManifestVideoEntry =>
      f.type === "video" && f.ok && (f.transcript?.segments?.length ?? 0) > 0,
  );
  err(`[correct] manifest has ${videos.length} videos with transcript`);

  const limit = pLimit(opts.concurrency);
  let corrected = 0;
  let cacheHits = 0;
  let unchanged = 0;
  let failed = 0;

  await Promise.all(
    videos.map((v) =>
      limit(async () => {
        const fid = fidFromPath(v.filePath);
        const sha = v.sha256;
        const cacheKey = `correct-transcript:${sha}:${opts.promptVersion}`;
        type Cached = { segments: string[]; sourceHash: string };
        // Use a content-hash of the original transcript so changing ASR
        // invalidates the cache automatically.
        const sourceHash = crypto
          .createHash("sha1")
          .update((v.transcript?.segments ?? []).map((s) => s.text).join("\n"))
          .digest("hex")
          .slice(0, 10);
        if (!opts.force) {
          const cached = cacheGet<Cached>(cacheKey);
          if (cached && cached.sourceHash === sourceHash) {
            applyCorrection(v, cached.segments);
            cacheHits++;
            return;
          }
        }
        try {
          const out = await correctSegments(fid, v, prompts);
          if (!out) {
            unchanged++;
            return;
          }
          applyCorrection(v, out);
          cachePut(cacheKey, "transcript", { segments: out, sourceHash } satisfies Cached);
          corrected++;
          err(`[correct][${fid}] ✓ ${out.length} segs corrected`);
        } catch (e) {
          failed++;
          err(`[correct][${fid}] FAIL: ${(e as Error).message}`);
        }
      }),
    ),
  );

  err(
    `[correct] DONE corrected=${corrected} cacheHits=${cacheHits} unchanged=${unchanged} failed=${failed}`,
  );

  await fs.writeFile(outPath, JSON.stringify(manifest, null, 2), "utf-8");
  err(`[correct] wrote manifest → ${outPath}`);
  process.stdout.write(
    `${JSON.stringify({ ok: true, corrected, cacheHits, unchanged, failed })}\n`,
  );
}

function applyCorrection(v: ManifestVideoEntry, correctedTexts: string[]): void {
  if (!v.transcript) return;
  const segs = v.transcript.segments;
  for (let i = 0; i < segs.length; i++) {
    const newText = correctedTexts[i];
    if (typeof newText === "string") {
      segs[i].text = newText;
      // 注意：words 数组保持不变（词级时间码不可能在 AI 纠错时维护）
      // 渲染时如用 words 做 kinetic 字幕，会与新 text 不匹配，但当前用 bottom-clean 不用 words
    }
  }
  v.transcript.text = segs.map((s) => s.text).join("");
}

main().catch((e) => {
  err("FATAL", (e as Error).stack ?? (e as Error).message);
  process.exit(1);
});

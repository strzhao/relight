/**
 * vlog-storyboard-places — 简化版故事板：按地点分组 + 视频全长 + 时间顺序
 *
 * 与 vlog-storyboard 的关键差异：
 *   - 只用视频，不用照片（用户偏好：照片乱，先去掉）
 *   - AI 只负责分组（地点 / 过渡），不做选片排序
 *   - 视频用完整时长（不做 srcStartSec/srcEndSec 内部裁剪）
 *   - 章节内按 IMG 编号升序（拍摄时间序）
 *   - 章节按时间先后排列
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { aiClient } from "../ai/client";
import { loadPrompts } from "../ai/prompts";
import { cacheGet, cachePut } from "./vlog/lib/cache";
import { err } from "./vlog/lib/util";
import {
  type ManifestVideoEntry,
  type Selection,
  type SelectionGroup,
  type Timeline,
  type TimelineChapter,
  type TimelineClip,
  type TranscriptSegment,
  batchManifestSchema,
  selectionSchema,
  timelineSchema,
} from "./vlog/types";

interface CliOpts {
  manifestPath: string | null;
  theme: string | null;
  language: string;
  out?: string;
  promptVersion: string;
  fps: number;
  width: number;
  height: number;
  bgmSource: string;
  forceRegen: boolean;
  maxClipSec: number;
  timeOffsetHours: number;
  selectionPath: string | null;
}

/** Module-level offset (hours) applied to displayed local times. Set from CLI. */
let displayOffsetHours = 0;

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    manifestPath: null,
    theme: null,
    language: "zh",
    promptVersion: "v2",
    fps: 30,
    width: 1920,
    height: 1080,
    bgmSource: "audio/bgm.m4a",
    forceRegen: false,
    maxClipSec: 60,
    timeOffsetHours: 0,
    selectionPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--theme") opts.theme = argv[++i] ?? null;
    else if (a === "--language") opts.language = argv[++i] ?? "zh";
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--prompt-version") opts.promptVersion = argv[++i] ?? "v2";
    else if (a === "--fps") opts.fps = Number(argv[++i]);
    else if (a === "--width") opts.width = Number(argv[++i]);
    else if (a === "--height") opts.height = Number(argv[++i]);
    else if (a === "--bgm") opts.bgmSource = argv[++i] ?? "audio/bgm.m4a";
    else if (a === "--force") opts.forceRegen = true;
    else if (a === "--max-clip-sec") opts.maxClipSec = Number(argv[++i]);
    else if (a === "--time-offset-hours") opts.timeOffsetHours = Number(argv[++i]);
    else if (a === "--selection") opts.selectionPath = argv[++i] ?? null;
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

const placesResponseSchema = z.object({
  chapters: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      rationale: z.string().optional().default(""),
      fileIds: z.array(z.string()),
    }),
  ),
});

const clusterTitlesResponseSchema = z.object({
  titles: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      kind: z.enum(["place", "transit"]).optional().default("place"),
      rationale: z.string().optional().default(""),
    }),
  ),
});

const videoLabelsResponseSchema = z.object({
  labels: z.array(
    z.object({
      fid: z.string(),
      label: z.string(),
      kind: z.enum(["place", "transit"]).optional().default("place"),
    }),
  ),
});

function fileIdFromEntry(entry: ManifestVideoEntry): string {
  return path.basename(entry.filePath, path.extname(entry.filePath));
}

function buildVideoList(entries: ManifestVideoEntry[]): string {
  return entries
    .map((e) => {
      const id = fileIdFromEntry(e);
      const time = formatLocalTime(e.takenAt);
      const dur = e.durationSec.toFixed(1);
      const tags = (e.ai?.tags ?? [])
        .slice(0, 5)
        .map((t) => t.name)
        .join(",");
      const mood = e.ai?.emotionalAnalysis?.primary ?? "";
      const brief = (e.ai?.narrative ?? "").slice(0, 50).replace(/\n/g, " ");
      const tx = e.transcript?.text?.slice(0, 60).replace(/\n/g, " ") ?? "";
      return `[id=${id}] [拍摄=${time}, 时长=${dur}s, pacing=${e.ai?.videoPacing ?? "?"}] tags=${tags} mood=${mood} ${tx ? `tx="${tx}"` : ""} brief="${brief}"`;
    })
    .join("\n");
}

async function generatePlaces(
  theme: string,
  videos: ManifestVideoEntry[],
  promptVersion: string,
): Promise<z.infer<typeof placesResponseSchema>> {
  const prompts = await loadPrompts(promptVersion, "vlog/storyboard-places");
  const videosList = buildVideoList(videos);
  const userPrompt = prompts.user
    .replace("{theme}", theme)
    .replace("{video_count}", String(videos.length))
    .replace("{videos_list}", videosList);
  err(`[storyboard-places] prompt size ≈ ${prompts.system.length + userPrompt.length} chars`);
  const raw = await aiClient.chat(userPrompt, prompts.system, { maxTokens: 4096 });
  const jsonStr = extractJsonString(raw);
  if (!jsonStr) {
    err(`[storyboard-places] no json block. raw (500):\n${raw.slice(0, 500)}`);
    throw new Error("storyboard-places: no json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`storyboard-places: json parse: ${(e as Error).message}`);
  }
  const result = placesResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`storyboard-places: zod: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Cluster videos by time-gap. A new cluster starts when the gap between
 * consecutive videos (by capture time) exceeds `gapMinutes`.
 */
function clusterByTimeGap(
  videos: ManifestVideoEntry[],
  gapMinutes: number,
): ManifestVideoEntry[][] {
  if (videos.length === 0) return [];
  const gapMs = gapMinutes * 60 * 1000;
  const clusters: ManifestVideoEntry[][] = [];
  let current: ManifestVideoEntry[] = [];
  let lastTime = Number.NEGATIVE_INFINITY;
  for (const v of videos) {
    const t = captureTimeMs(v);
    if (current.length === 0 || t - lastTime > gapMs) {
      if (current.length) clusters.push(current);
      current = [v];
    } else {
      current.push(v);
    }
    lastTime = t;
  }
  if (current.length) clusters.push(current);
  return clusters;
}

async function generateVideoLabels(
  theme: string,
  videos: ManifestVideoEntry[],
  promptVersion: string,
): Promise<z.infer<typeof videoLabelsResponseSchema>> {
  const prompts = await loadPrompts(promptVersion, "vlog/video-labels");
  const videosList = buildVideoList(videos);
  const userPrompt = prompts.user
    .replace("{theme}", theme)
    .replace("{video_count}", String(videos.length))
    .replace("{videos_list}", videosList);
  err(`[video-labels] prompt size ≈ ${prompts.system.length + userPrompt.length} chars`);
  const raw = await aiClient.chat(userPrompt, prompts.system, { maxTokens: 8192 });
  const jsonStr = extractJsonString(raw);
  if (!jsonStr) {
    err(`[video-labels] no json. raw (500):\n${raw.slice(0, 500)}`);
    throw new Error("video-labels: no json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`video-labels: json parse: ${(e as Error).message}`);
  }
  const result = videoLabelsResponseSchema.safeParse(parsed);
  if (!result.success) throw new Error(`video-labels: zod: ${result.error.message}`);
  return result.data;
}

async function generateClusterTitles(
  theme: string,
  clusters: ManifestVideoEntry[][],
  promptVersion: string,
): Promise<z.infer<typeof clusterTitlesResponseSchema>> {
  const prompts = await loadPrompts(promptVersion, "vlog/cluster-titles");
  const clustersText = clusters
    .map((cluster, i) => {
      const first = cluster[0];
      const last = cluster[cluster.length - 1];
      const timeRange = `${formatLocalTime(first?.takenAt)}-${formatLocalTime(last?.takenAt)}`;
      const lines = cluster
        .map((v) => {
          const fid = fileIdFromEntry(v);
          const time = formatLocalTime(v.takenAt);
          const brief = (v.ai?.narrative ?? "").slice(0, 60).replace(/\n/g, " ");
          const tx = v.transcript?.text?.slice(0, 50).replace(/\n/g, " ") ?? "";
          return `    - ${fid} @${time}: ${brief}${tx ? ` tx="${tx}"` : ""}`;
        })
        .join("\n");
      return `### 簇 c${i + 1} (${timeRange}, ${cluster.length} 视频):\n${lines}`;
    })
    .join("\n\n");
  const userPrompt = prompts.user
    .replace("{theme}", theme)
    .replace("{cluster_count}", String(clusters.length))
    .replace("{clusters_text}", clustersText);
  err(`[cluster-titles] prompt size ≈ ${prompts.system.length + userPrompt.length} chars`);
  const raw = await aiClient.chat(userPrompt, prompts.system, { maxTokens: 4096 });
  const jsonStr = extractJsonString(raw);
  if (!jsonStr) throw new Error("cluster-titles: no json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`cluster-titles: json parse: ${(e as Error).message}`);
  }
  const result = clusterTitlesResponseSchema.safeParse(parsed);
  if (!result.success) throw new Error(`cluster-titles: zod: ${result.error.message}`);
  return result.data;
}

function compareImgIds(a: string, b: string): number {
  // IDs are like "IMG_1900"; extract the numeric suffix for ordering.
  const an = Number(a.replace(/[^\d]/g, "") || "0");
  const bn = Number(b.replace(/[^\d]/g, "") || "0");
  return an - bn;
}

function captureTimeMs(entry: ManifestVideoEntry): number {
  if (entry.takenAt) {
    const ms = Date.parse(entry.takenAt);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

function compareByCaptureTime(a: ManifestVideoEntry, b: ManifestVideoEntry): number {
  const ta = captureTimeMs(a);
  const tb = captureTimeMs(b);
  if (ta !== tb) return ta - tb;
  return compareImgIds(fileIdFromEntry(a), fileIdFromEntry(b));
}

function formatLocalTime(iso: string | undefined): string {
  if (!iso) return "??";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "??";
  // Default: convert UTC → CN local time (UTC+8). Adjustable via --time-offset-hours
  // for cases where iPhone's clock was in a wrong timezone.
  const utcMs = d.getTime();
  const local = new Date(utcMs + (8 + displayOffsetHours) * 60 * 60 * 1000);
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

const HOOK_CLIP_FRAMES = 60; // 2s @ 30fps — gives viewer enough time to "read" each shot
const HOOK_TARGET_COUNT = 5; // ≈ 10s cold open

interface HookPick {
  fid: string;
  entry: ManifestVideoEntry;
  chapter: string;
  startSec: number;
  reason: string;
}

const hookPicksResponseSchema = z.object({
  picks: z.array(
    z.object({
      fid: z.string(),
      startSec: z.number().nonnegative(),
      reason: z.string().optional().default(""),
    }),
  ),
});

/**
 * Build the shot list digest that gets fed to the AI for hook picking.
 * One line per shot, grouped by chapter.
 */
function buildHookShotsList(
  timelineChapters: Array<{ title: string; clips: TimelineClip[]; kind?: string }>,
  byId: Map<string, ManifestVideoEntry>,
): string {
  const sections: string[] = [];
  for (const ch of timelineChapters) {
    if (ch.title === "") continue;
    const lines: string[] = [];
    for (const clip of ch.clips) {
      const baseName = path.basename(clip.source, path.extname(clip.source));
      const entry = byId.get(baseName);
      if (!entry) continue;
      if (entry.durationSec < 1.5) continue; // 太短无意义
      const dur = entry.durationSec.toFixed(1);
      const aesthetic = entry.ai?.aestheticScore?.toFixed(1) ?? "?";
      const motion = entry.ai?.motionScore ?? "?";
      const intensity = entry.ai?.emotionalAnalysis?.intensity?.toFixed(2) ?? "?";
      const primary = entry.ai?.emotionalAnalysis?.primary ?? "?";
      const tags = (entry.ai?.tags ?? [])
        .slice(0, 4)
        .map((t) => t.name)
        .join(",");
      const brief = (entry.ai?.narrative ?? "").slice(0, 70).replace(/\n/g, " ");
      const tx = entry.transcript?.text?.slice(0, 40).replace(/\n/g, " ") ?? "";
      lines.push(
        `- [fid=${baseName}] [时长=${dur}s 美学=${aesthetic} 运动=${motion} 情绪=${primary}/${intensity}] tags=${tags} brief="${brief}"${tx ? ` tx="${tx}"` : ""}`,
      );
    }
    if (lines.length > 0) {
      sections.push(`### 章节：${ch.title}\n${lines.join("\n")}`);
    }
  }
  return sections.join("\n\n");
}

/**
 * Ask AI to pick 5 hook clips with 1-second time windows. AI sees aesthetic,
 * motion, emotion, tags, brief (画面摘要), and transcript snippet for each
 * shot grouped by chapter — and decides based on visual storytelling judgment
 * rather than mechanical scoring.
 */
async function pickHookFidsAI(
  theme: string,
  timelineChapters: Array<{ title: string; clips: TimelineClip[] }>,
  byId: Map<string, ManifestVideoEntry>,
  promptVersion: string,
): Promise<HookPick[]> {
  const prompts = await loadPrompts(promptVersion, "vlog/hook");
  const shotsList = buildHookShotsList(timelineChapters, byId);
  // Count unique shots (one per fid)
  const seen = new Set<string>();
  let count = 0;
  for (const ch of timelineChapters) {
    for (const clip of ch.clips) {
      const baseName = path.basename(clip.source, path.extname(clip.source));
      if (!seen.has(baseName)) {
        seen.add(baseName);
        count++;
      }
    }
  }
  const userPrompt = prompts.user
    .replace("{theme}", theme)
    .replace("{count}", String(count))
    .replace("{shots_list}", shotsList);
  err(`[hook] prompt size ≈ ${prompts.system.length + userPrompt.length} chars (${count} shots)`);

  const raw = await aiClient.chat(userPrompt, prompts.system, { maxTokens: 4096 });
  const jsonStr = extractJsonString(raw);
  if (!jsonStr) {
    err(`[hook] no json. raw (500):\n${raw.slice(0, 500)}`);
    throw new Error("hook: no json in AI response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`hook: json parse: ${(e as Error).message}`);
  }
  const result = hookPicksResponseSchema.safeParse(parsed);
  if (!result.success) throw new Error(`hook: zod: ${result.error.message}`);

  // Build a fid → chapter map for resolution
  const fidToChapter = new Map<string, string>();
  for (const ch of timelineChapters) {
    for (const clip of ch.clips) {
      const baseName = path.basename(clip.source, path.extname(clip.source));
      if (!fidToChapter.has(baseName)) fidToChapter.set(baseName, ch.title);
    }
  }

  const picks: HookPick[] = [];
  for (const p of result.data.picks) {
    const entry = byId.get(p.fid);
    if (!entry) {
      err(`[hook] WARN: AI returned unknown fid '${p.fid}' — skipping`);
      continue;
    }
    const winSec = HOOK_CLIP_FRAMES / 30; // assumes 30fps; clamped below
    const maxStart = Math.max(0, entry.durationSec - winSec);
    const startSec = Math.max(0, Math.min(maxStart, p.startSec));
    if (Math.abs(startSec - p.startSec) > 0.5) {
      err(
        `[hook] WARN: AI startSec ${p.startSec.toFixed(1)} for ${p.fid} out of range (dur=${entry.durationSec.toFixed(1)}); clamped to ${startSec.toFixed(1)}`,
      );
    }
    picks.push({
      fid: p.fid,
      entry,
      chapter: fidToChapter.get(p.fid) ?? "?",
      startSec,
      reason: p.reason,
    });
    if (picks.length >= HOOK_TARGET_COUNT) break;
  }

  if (picks.length < HOOK_TARGET_COUNT) {
    err(`[hook] WARN: AI returned ${picks.length} valid picks, expected ${HOOK_TARGET_COUNT}`);
  }
  return picks;
}

function buildHookChapter(picks: HookPick[], fps: number): TimelineChapter {
  let cursor = 0;
  const clips: TimelineClip[] = [];
  const winSec = HOOK_CLIP_FRAMES / fps;
  for (const p of picks) {
    const dur = p.entry.durationSec;
    // AI-provided startSec, clamped to fit a 1s window inside the clip
    const startSec = Math.max(0, Math.min(dur - winSec, p.startSec));
    const endSec = startSec + winSec;
    clips.push({
      id: `hook-${p.fid}-${cursor}`,
      source: `sources/${path.basename(p.entry.filePath)}`,
      kind: "video",
      srcStartSec: startSec,
      srcEndSec: endSec,
      renderStartFrame: cursor,
      renderDurationFrames: HOOK_CLIP_FRAMES,
      subtitles: [],
      subtitleStyle: "off",
      transitionIn: "cut",
      audioGain: 0,
    });
    cursor += HOOK_CLIP_FRAMES;
  }
  return {
    id: "hook",
    title: "", // empty title → Chapter.tsx skips title overlay
    energyCurve: "rising",
    startFrame: 0,
    endFrame: cursor,
    titleCard: { durationFrames: 0 },
    clips,
  };
}

/**
 * Whisper sometimes glues two utterances separated by a long pause into a
 * single segment (segment.end - segment.start >> sum of word durations). The
 * resulting subtitle would display for 10–20s spanning a long silence.
 *
 * Split segment into sub-segments whenever consecutive words have a gap
 * larger than maxGapSec (default 1.5s). Falls back to the original segment
 * when no word timestamps are available.
 */
function splitSegmentByWordGap(seg: TranscriptSegment, maxGapSec = 1.5): TranscriptSegment[] {
  const words = seg.words ?? [];
  if (words.length < 2) return [seg];

  type Word = (typeof words)[number];
  const groups: Word[][] = [[]];
  for (let i = 0; i < words.length; i++) {
    const cur = words[i];
    if (!cur) continue;
    const prev = words[i - 1];
    const lastGroup = groups[groups.length - 1];
    if (prev && cur.start - prev.end > maxGapSec) {
      if (lastGroup && lastGroup.length > 0) groups.push([]);
    }
    groups[groups.length - 1]?.push(cur);
  }
  if (groups.length === 1) return [seg];

  // Rebuild text per group by re-stringing the original chars (word.word may
  // contain leading whitespace per Whisper convention).
  const result: TranscriptSegment[] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    const first = g[0];
    const last = g[g.length - 1];
    if (!first || !last) continue;
    result.push({
      start: first.start,
      end: last.end,
      text: g
        .map((w) => w.word)
        .join("")
        .trim(),
      words: g,
    });
  }
  return result;
}

/**
 * Find an optimal [startSec, endSec] window that fits within maxClipSec
 * while aligning to transcript segment boundaries (no mid-sentence cuts).
 * Strategy:
 *   1. If video is shorter than maxClipSec: use full duration.
 *   2. If no transcript: just take the first maxClipSec.
 *   3. If transcript exists: find longest contiguous run of non-empty segments
 *      that fits within maxClipSec. Snap to segment boundaries. Includes leading
 *      silence up to 1.5s and trailing silence up to 1.5s for natural pacing.
 */
function smartTrim(
  durationSec: number,
  segments: TranscriptSegment[] | undefined,
  maxClipSec: number,
): { startSec: number; endSec: number } {
  if (durationSec <= maxClipSec) return { startSec: 0, endSec: durationSec };

  const validSegs = (segments ?? []).filter((s) => s.end > s.start && s.text.trim().length > 0);
  if (validSegs.length === 0) {
    // No useful transcript — just take from beginning.
    return { startSec: 0, endSec: maxClipSec };
  }

  // Greedy: try each starting segment, extend until we hit maxClipSec budget.
  // Pick the window with the most total spoken time.
  let bestStart = 0;
  let bestEnd = Math.min(durationSec, maxClipSec);
  let bestSpoken = 0;

  for (let i = 0; i < validSegs.length; i++) {
    const startSeg = validSegs[i];
    if (!startSeg) continue;
    const startSec = Math.max(0, startSeg.start - 1.0); // 1s lead-in
    if (startSec + maxClipSec >= durationSec + 0.5) break; // can't extend further usefully
    let lastFittingSegEnd = startSeg.end;
    let spoken = 0;
    for (let j = i; j < validSegs.length; j++) {
      const seg = validSegs[j];
      if (!seg) continue;
      if (seg.end - startSec > maxClipSec) break;
      lastFittingSegEnd = seg.end;
      spoken += seg.end - seg.start;
    }
    const endSec = Math.min(durationSec, lastFittingSegEnd + 1.0); // 1s tail
    if (endSec - startSec > maxClipSec + 0.1) continue;
    if (spoken > bestSpoken) {
      bestSpoken = spoken;
      bestStart = startSec;
      bestEnd = endSec;
    }
  }

  // Sanity: ensure non-empty window
  if (bestEnd - bestStart < 1.0) {
    return { startSec: 0, endSec: Math.min(maxClipSec, durationSec) };
  }
  return { startSec: bestStart, endSec: bestEnd };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  displayOffsetHours = opts.timeOffsetHours;
  if (displayOffsetHours !== 0) {
    err(`[storyboard-places] applying displayOffsetHours=${displayOffsetHours}`);
  }
  if (!opts.manifestPath || !opts.theme) {
    err(
      "用法: tsx src/cli/vlog-storyboard-places.ts <manifestPath> --theme '…' [--language zh] [--out timeline.json] [--prompt-version v2] [--fps 30] [--width 1920] [--height 1080] [--bgm audio/bgm.m4a] [--max-clip-sec 60] [--force]",
    );
    process.exit(1);
  }
  const manifestPath = path.resolve(opts.manifestPath);
  const raw = await fs.readFile(manifestPath, "utf-8");
  const manifest = batchManifestSchema.parse(JSON.parse(raw));

  // Load user selection (optional): exclusions + merge groups.
  let selection: Selection | null = null;
  if (opts.selectionPath) {
    try {
      const selRaw = await fs.readFile(path.resolve(opts.selectionPath), "utf-8");
      selection = selectionSchema.parse(JSON.parse(selRaw));
      err(
        `[storyboard-places] selection loaded: excluded=${selection.excluded.length}, groups=${selection.groups.length}`,
      );
    } catch (e) {
      err(`[storyboard-places] WARN: failed to load selection: ${(e as Error).message}`);
    }
  }
  const excludedSet = new Set<string>(selection?.excluded ?? []);
  const groupByFid = new Map<string, SelectionGroup>();
  for (const g of selection?.groups ?? []) for (const f of g.fids) groupByFid.set(f, g);
  /** Set of fids whose label/order is locked by user grouping — auto algorithms must skip them. */
  const lockedFids = new Set<string>(groupByFid.keys());

  // Keep only videos; filter out user-excluded; sort by actual capture time.
  // IMG numbering on iPhone is NOT chronological across photo+video sequences.
  const allVideos = manifest.files
    .filter((f): f is ManifestVideoEntry => f.type === "video" && f.ok)
    .sort(compareByCaptureTime);

  // Apply user's order override (selection.order) if present.
  // Videos listed in selection.order are reordered to that sequence;
  // missing fids are appended at the end in takenAt order.
  let orderedVideos = allVideos;
  if (selection?.order && selection.order.length > 0) {
    const byFid = new Map(allVideos.map((v) => [fileIdFromEntry(v), v]));
    const seen = new Set<string>();
    const reordered: ManifestVideoEntry[] = [];
    for (const fid of selection.order) {
      const v = byFid.get(fid);
      if (v && !seen.has(fid)) {
        reordered.push(v);
        seen.add(fid);
      }
    }
    for (const v of allVideos) {
      if (!seen.has(fileIdFromEntry(v))) reordered.push(v);
    }
    orderedVideos = reordered;
    err(
      `[storyboard-places] applied user order from selection (${selection.order.length} entries)`,
    );
  }

  const videos = orderedVideos.filter((v) => !excludedSet.has(fileIdFromEntry(v)));
  err(`[storyboard-places] manifest videos: ${allVideos.length}, after exclude: ${videos.length}`);
  const firstVid = videos[0];
  const lastVid = videos[videos.length - 1];
  err(
    `[storyboard-places] time range: ${firstVid ? formatLocalTime(firstVid.takenAt) : "?"} – ${lastVid ? formatLocalTime(lastVid.takenAt) : "?"}`,
  );

  if (videos.length === 0) {
    throw new Error("no video entries in manifest");
  }

  // Validate selection groups: all fids must exist in manifest (after filter)
  if (selection) {
    const availFids = new Set(videos.map(fileIdFromEntry));
    for (const g of selection.groups) {
      const missing = g.fids.filter((f) => !availFids.has(f));
      if (missing.length) {
        err(
          `[storyboard-places] WARN: group ${g.id} references missing/excluded fids: ${missing.join(", ")} — dropping them`,
        );
        g.fids = g.fids.filter((f) => availFids.has(f));
      }
    }
    selection.groups = selection.groups.filter((g) => g.fids.length >= 2);
  }

  // Cache key (include selection hash so changing selection invalidates cache)
  const fileIdsKey = videos.map((v) => v.sha256).join(",");
  const selectionHash = selection
    ? crypto
        .createHash("sha256")
        .update(JSON.stringify({ excluded: selection.excluded, groups: selection.groups }))
        .digest("hex")
        .slice(0, 16)
    : "no-sel";
  const cacheKey = `storyboard-places:${manifestPath}:${opts.theme}:${opts.promptVersion}:${fileIdsKey.slice(0, 64)}:${selectionHash}`;
  if (!opts.forceRegen) {
    const cached = cacheGet<Timeline>(cacheKey);
    if (cached) {
      err("[storyboard-places] cache hit");
      const json = JSON.stringify(cached, null, 2);
      if (opts.out) {
        await fs.mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
        await fs.writeFile(path.resolve(opts.out), json, "utf-8");
      }
      process.stdout.write(`${json}\n`);
      return;
    }
  }

  const byId = new Map<string, ManifestVideoEntry>();
  for (const v of videos) byId.set(fileIdFromEntry(v), v);

  // 1) Ask AI to label EACH video with a place/transit label (single call).
  const labelsResp = await generateVideoLabels(opts.theme, videos, opts.promptVersion);
  const labelByFid = new Map<string, { label: string; kind: "place" | "transit" }>();
  for (const l of labelsResp.labels) {
    labelByFid.set(l.fid, { label: l.label, kind: l.kind });
  }
  err(`[storyboard-places] labeled ${labelByFid.size}/${videos.length} videos (raw)`);

  // 1.1) Override labels for user-grouped videos so they form a single chapter.
  for (const g of selection?.groups ?? []) {
    let groupLabel = g.label ?? null;
    if (!groupLabel) {
      const counts = new Map<string, number>();
      for (const f of g.fids) {
        const lbl = labelByFid.get(f)?.label;
        if (lbl) counts.set(lbl, (counts.get(lbl) ?? 0) + 1);
      }
      if (counts.size > 0) {
        groupLabel = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      }
    }
    if (!groupLabel) groupLabel = labelByFid.get(g.fids[0] ?? "")?.label ?? "用户合并组";
    for (const f of g.fids) {
      labelByFid.set(f, { label: groupLabel, kind: "place" });
    }
    err(`[storyboard-places] group ${g.id} [${g.fids.join(",")}] → label="${groupLabel}"`);
  }

  // 1.5) Window smoothing: a single-video outlier whose label disagrees with
  //      a majority of its place-labeled neighbors (window ±2) is reassigned
  //      to the neighborhood majority. Preserves real content transitions
  //      (e.g. restaurant → transit → park is intact because the change is
  //      sustained for multiple videos in a row).
  let reassigned = 0;
  for (let pass = 0; pass < 3; pass++) {
    let changedThisPass = 0;
    const snapshot = new Map(labelByFid);
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      if (!v) continue;
      const fid = fileIdFromEntry(v);
      if (lockedFids.has(fid)) continue; // user-grouped video: keep its forced label
      const meta = snapshot.get(fid);
      if (!meta || meta.kind !== "place") continue;
      // Window: ±2 positions, ±15min time, exclude transits and self
      const TIME_WINDOW_MS = 15 * 60 * 1000;
      const counts = new Map<string, number>();
      const tCenter = captureTimeMs(v);
      for (let j = Math.max(0, i - 2); j <= Math.min(videos.length - 1, i + 2); j++) {
        if (j === i) continue;
        const vn = videos[j];
        if (!vn) continue;
        if (Math.abs(captureTimeMs(vn) - tCenter) > TIME_WINDOW_MS) continue;
        const m = snapshot.get(fileIdFromEntry(vn));
        if (!m || m.kind !== "place") continue;
        counts.set(m.label, (counts.get(m.label) ?? 0) + 1);
      }
      if (counts.size === 0) continue;
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (!top) continue;
      const [topLabel, topCount] = top;
      // Require ≥ 2 neighbors agreeing AND current label has < 2 supporters
      if (topLabel === meta.label) continue;
      if (topCount < 2) continue;
      const selfCount = counts.get(meta.label) ?? 0;
      if (selfCount >= 1) continue; // at least one neighbor agrees with us → preserve
      err(
        `[storyboard-places] smooth(p${pass}): ${fid} @ ${formatLocalTime(v.takenAt)} '${meta.label}' → '${topLabel}' (window majority ${topCount})`,
      );
      labelByFid.set(fid, { label: topLabel, kind: "place" });
      reassigned++;
      changedThisPass++;
    }
    if (changedThisPass === 0) break;
  }
  if (reassigned > 0)
    err(`[storyboard-places] reassigned ${reassigned} videos via window smoothing`);

  // 2) Walk videos in time order; group consecutive same-label into chapters.
  //    User-defined merge groups are inserted as a single ordered unit at their
  //    earliest member's takenAt position.
  type Segment = {
    id: string;
    title: string;
    rationale: string;
    fileIds: string[];
    kind: "place" | "transit";
  };

  type OrderItem =
    | { kind: "single"; fid: string; anchorMs: number }
    | { kind: "group"; group: SelectionGroup; anchorMs: number };

  const items: OrderItem[] = [];
  const seenGroupIds = new Set<string>();
  for (const v of videos) {
    const fid = fileIdFromEntry(v);
    const grp = groupByFid.get(fid);
    if (grp) {
      if (seenGroupIds.has(grp.id)) continue;
      seenGroupIds.add(grp.id);
      const memberTimes = grp.fids
        .map((f) => byId.get(f))
        .filter((e): e is ManifestVideoEntry => !!e)
        .map((e) => captureTimeMs(e));
      const anchor = memberTimes.length ? Math.min(...memberTimes) : captureTimeMs(v);
      items.push({ kind: "group", group: grp, anchorMs: anchor });
    } else {
      items.push({ kind: "single", fid, anchorMs: captureTimeMs(v) });
    }
  }
  // 不再按 anchorMs 重排——videos 已按 selection.order (用户拖拽顺序) 或 takenAt 排好。

  const chapters: Segment[] = [];
  let cur: Segment | null = null;
  let chCounter = 0;
  let trCounter = 0;

  const appendFids = (fids: string[], label: string, kind: "place" | "transit"): void => {
    if (!cur || cur.title !== label) {
      if (kind === "transit") {
        trCounter++;
        cur = { id: `transit-${trCounter}`, title: label, kind, rationale: "", fileIds: [] };
      } else {
        chCounter++;
        cur = { id: `ch${chCounter}`, title: label, kind, rationale: "", fileIds: [] };
      }
      chapters.push(cur);
    }
    cur.fileIds.push(...fids);
  };

  for (const it of items) {
    if (it.kind === "single") {
      const meta = labelByFid.get(it.fid);
      appendFids([it.fid], meta?.label ?? "未分类", meta?.kind ?? "place");
    } else {
      // group: all members share the same (overridden) label
      const firstMeta = labelByFid.get(it.group.fids[0] ?? "");
      appendFids(it.group.fids, firstMeta?.label ?? "用户合并组", firstMeta?.kind ?? "place");
    }
  }
  err(
    `[storyboard-places] chapters after merge (raw): ${chapters.length} — ${chapters
      .map((c) => `${c.title}(${c.fileIds.length})`)
      .join(", ")}`,
  );

  // 2.5) Second pass: collapse "A → small-B → A" sandwich patterns.
  //      If chapter B has ≤2 clips AND its label differs from both neighbors
  //      with same label, merge B into the previous chapter (relabel B's videos).
  let collapseIters = 0;
  let collapsed = true;
  while (collapsed && collapseIters < 5) {
    collapsed = false;
    for (let i = 1; i < chapters.length - 1; i++) {
      const prev = chapters[i - 1];
      const cur2 = chapters[i];
      const next = chapters[i + 1];
      if (!prev || !cur2 || !next) continue;
      if (cur2.fileIds.length > 2) continue;
      if (cur2.kind === "transit") continue;
      if (prev.title !== next.title) continue;
      if (prev.kind === "transit" || next.kind === "transit") continue;
      // Don't touch user-grouped chapters
      if (cur2.fileIds.some((f) => lockedFids.has(f))) continue;
      if (prev.fileIds.some((f) => lockedFids.has(f))) continue;
      if (next.fileIds.some((f) => lockedFids.has(f))) continue;
      // Merge B into prev (and absorb next too).
      err(
        `[storyboard-places] collapse: ${cur2.title}(${cur2.fileIds.length}) sandwiched between ${prev.title} - merging`,
      );
      prev.fileIds.push(...cur2.fileIds, ...next.fileIds);
      // Reassign labelByFid for cur2's videos so they show as prev's label
      for (const fid of cur2.fileIds) {
        labelByFid.set(fid, { label: prev.title, kind: "place" });
      }
      chapters.splice(i, 2);
      collapsed = true;
      break;
    }
    collapseIters++;
  }
  if (collapseIters > 0) {
    err(`[storyboard-places] sandwich-collapse iterations: ${collapseIters}`);
  }

  // 2.6) Merge consecutive transit chapters (regardless of specific label).
  //      Use a generic title "走路过渡" for merged transits.
  for (let i = chapters.length - 2; i >= 0; i--) {
    const cur2 = chapters[i];
    const next = chapters[i + 1];
    if (!cur2 || !next) continue;
    if (cur2.kind === "transit" && next.kind === "transit") {
      cur2.fileIds.push(...next.fileIds);
      if (cur2.title !== next.title) cur2.title = "走路过渡";
      chapters.splice(i + 1, 1);
    }
  }

  // 2.7) Absorb tiny transit chapters (≤2 clips) between same-place chapters:
  //      A(place X) → small-T → B(place X) → merge T+B into A. The transit
  //      videos become part of the surrounding place chapter (they are
  //      naturally part of "being at X" — walking between exhibits in 公园).
  let absorbedPasses = 0;
  let absorbedAny = true;
  while (absorbedAny && absorbedPasses < 5) {
    absorbedAny = false;
    for (let i = 0; i < chapters.length - 2; i++) {
      const a = chapters[i];
      const t = chapters[i + 1];
      const b = chapters[i + 2];
      if (!a || !t || !b) continue;
      if (a.kind !== "place" || b.kind !== "place") continue;
      if (t.kind !== "transit") continue;
      if (t.fileIds.length > 2) continue;
      if (a.title !== b.title) continue;
      if (t.fileIds.some((f) => lockedFids.has(f))) continue;
      if (a.fileIds.some((f) => lockedFids.has(f))) continue;
      if (b.fileIds.some((f) => lockedFids.has(f))) continue;
      err(
        `[storyboard-places] absorb: ${a.title}(${a.fileIds.length}) ← transit(${t.fileIds.length}) ← ${b.title}(${b.fileIds.length})`,
      );
      a.fileIds.push(...t.fileIds, ...b.fileIds);
      chapters.splice(i + 1, 2);
      absorbedAny = true;
      break;
    }
    absorbedPasses++;
  }
  if (absorbedPasses > 1) err(`[storyboard-places] absorb passes: ${absorbedPasses}`);

  // 2.8) Head/tail single-clip cleanup: if the very first chapter has 1 clip
  //      AND the next chapter is also small (≤2 clips), merge them — prevents
  //      "河畔散步(1) + 街头过渡(1)" leading fragments.
  if (chapters.length >= 2) {
    const a = chapters[0];
    const b = chapters[1];
    if (
      a &&
      b &&
      a.fileIds.length === 1 &&
      b.fileIds.length <= 2 &&
      !a.fileIds.some((f) => lockedFids.has(f)) &&
      !b.fileIds.some((f) => lockedFids.has(f))
    ) {
      err(
        `[storyboard-places] head-merge: ${a.title}(1) + ${b.title}(${b.fileIds.length}) → ${b.title}`,
      );
      b.fileIds = [...a.fileIds, ...b.fileIds];
      chapters.splice(0, 1);
      // If both are place but different labels, prefer the larger / later
      // (kept b's title, which is reasonable)
    }
  }
  err(
    `[storyboard-places] chapters final: ${chapters.length} — ${chapters
      .map((c) => `${c.title}(${c.fileIds.length})`)
      .join(", ")}`,
  );

  err(
    `[storyboard-places] effective chapters: ${chapters.length}, total clips: ${chapters.reduce((s, c) => s + c.fileIds.length, 0)}`,
  );

  // Report unused (videos that AI did not assign to any chapter)
  const assignedIds = new Set(chapters.flatMap((c) => c.fileIds));
  const unused = videos.filter((v) => !assignedIds.has(fileIdFromEntry(v)));
  if (unused.length) {
    err(
      `[storyboard-places] WARN: ${unused.length} videos not assigned: ${unused.map(fileIdFromEntry).join(", ")}`,
    );
  }

  // Build timeline
  const fps = opts.fps;
  // titleCardFrames = 0: chapter title is overlaid on top of the first clip
  // (fading in/out within the clip's own duration) rather than occupying a
  // separate dedicated card period.
  const titleCardFrames = 0;
  const outroFrames = 90; // 3s
  let cursor = 0;

  // task 008: 章节内自定义排序（selection.chapterOrders 覆盖默认顺序）
  // 优先级：selection.chapterOrders[idx] > group.fids 内部序 > 现有 ch.fileIds（即 takenAt 时间序）
  const chapterOrderMap = new Map<number, string[]>();
  for (const co of selection?.chapterOrders ?? []) {
    chapterOrderMap.set(co.chapterIdx, co.customOrder);
  }

  const timelineChapters: TimelineChapter[] = chapters.map((ch, idx) => {
    const startFrame = cursor;
    cursor += titleCardFrames;

    // 应用 chapterOrders 重排（如果存在 + 成员集合一致）
    const customOrder = chapterOrderMap.get(idx);
    if (customOrder && customOrder.length > 0) {
      const chSet = new Set(ch.fileIds);
      const customSet = new Set(customOrder);
      // 仅当 customOrder 是 ch.fileIds 的排列（成员集合相同）才采用
      if (
        customOrder.length === ch.fileIds.length &&
        customOrder.every((f) => chSet.has(f)) &&
        ch.fileIds.every((f) => customSet.has(f))
      ) {
        ch.fileIds = customOrder;
        err(`[storyboard-places] chapter ${idx} reordered by selection.chapterOrders`);
      } else {
        err(`[storyboard-places] WARN: chapterOrders[${idx}] member mismatch, ignored`);
      }
    }

    const clips: TimelineClip[] = ch.fileIds.map((fid, clipIdx) => {
      const entry = byId.get(fid);
      if (!entry) throw new Error(`internal: missing entry ${fid}`); // we already filtered

      // Determine transitionIn: 'cut' when this clip and the previous one belong
      // to the SAME user-defined merge group (express logical continuity).
      const prevFid = clipIdx > 0 ? ch.fileIds[clipIdx - 1] : null;
      const sameGroup =
        prevFid != null &&
        groupByFid.has(fid) &&
        groupByFid.has(prevFid) &&
        groupByFid.get(fid)?.id === groupByFid.get(prevFid)?.id;
      const transitionIn: "crossfade" | "cut" = sameGroup ? "cut" : "crossfade";

      // smart-trim 阶段已前置：srcStartSec=0, srcEndSec=entry.durationSec（契约 C6）
      const srcStartSec = 0;
      const srcEndSec = entry.durationSec;
      const clipDurSec = srcEndSec - srcStartSec;
      const renderDur = Math.max(1, Math.round(clipDurSec * fps));

      // Translate segments (already shifted by smart-trim) to absolute frames.
      // splitSegmentByWordGap is now handled in the smart-trim stage — segments
      // in the manifest are already pre-split. We just need to filter empty ones
      // and map to frame coordinates.
      let subtitles: TimelineClip["subtitles"] = [];
      if (entry.transcript?.segments?.length) {
        const segs = entry.transcript.segments
          .filter((s) => s.end > srcStartSec && s.start < srcEndSec && s.text.trim().length > 0)
          .map((s) => {
            const localStart = Math.max(0, s.start - srcStartSec);
            const localEnd = Math.min(clipDurSec, s.end - srcStartSec);
            return {
              start: localStart,
              end: localEnd,
              text: s.text,
              words: s.words
                ?.filter((w) => w.end > srcStartSec && w.start < srcEndSec)
                .map((w) => ({
                  start: Math.max(0, w.start - srcStartSec),
                  end: Math.min(clipDurSec, w.end - srcStartSec),
                  word: w.word,
                  probability: w.probability,
                })),
            };
          });
        // Whisper segment.start typically precedes the real speech onset by
        // ~150-300ms (the model includes a bit of silence padding at the head
        // of each segment). Without compensation, subtitles appear before the
        // speaker opens their mouth. Shift startFrame by SUBTITLE_LEAD_FRAMES
        // to better align with perceived speech timing. endFrame is left
        // untouched (compresses display time only slightly, ~7 frames).
        const SUBTITLE_LEAD_FRAMES = 7; // ~230ms @ 30fps
        subtitles = segs.map((s) => {
          const rawStart = cursor + Math.round(s.start * fps);
          const endSegFrame = cursor + Math.round(s.end * fps);
          // Don't shift past the segment's end; ensure ≥3-frame display
          const startSegFrame = Math.min(rawStart + SUBTITLE_LEAD_FRAMES, endSegFrame - 3);
          return {
            startFrame: Math.max(startSegFrame, rawStart),
            endFrame: Math.max(startSegFrame + 1, endSegFrame),
            text: s.text,
            words: s.words?.map((w) => {
              const wRaw = cursor + Math.round(w.start * fps);
              const wEnd =
                cursor + Math.max(Math.round(w.end * fps), Math.round(w.start * fps) + 1);
              const wStart = Math.min(wRaw + SUBTITLE_LEAD_FRAMES, wEnd - 1);
              return {
                startFrame: Math.max(wStart, wRaw),
                endFrame: wEnd,
                word: w.word,
              };
            }),
          };
        });
      }

      err(
        `[storyboard-places]   ${fid} @ ${formatLocalTime(entry.takenAt)} ${clipDurSec.toFixed(1)}s subs=${subtitles.length}`,
      );

      // 契约 C6：根据 sourceTrim.status 决定 source 路径
      // 注意：trimmed 文件统一 .mp4 容器（契约 C1），所以引用 sources-trimmed 时文件名用 fid + ".mp4"
      const useTrimmed = entry.sourceTrim?.status === "ok";
      const clipFileName = useTrimmed ? `${fid}.mp4` : path.basename(entry.filePath);
      const sourceDir = useTrimmed ? "sources-trimmed" : "sources";

      const clip: TimelineClip = {
        id: `${fid}-${cursor}`,
        source: `${sourceDir}/${clipFileName}`,
        kind: "video",
        srcStartSec,
        srcEndSec,
        renderStartFrame: cursor,
        renderDurationFrames: renderDur,
        subtitles,
        subtitleStyle: "bottom-clean",
        transitionIn,
        audioGain: 0.8,
      };
      cursor += renderDur;
      return clip;
    });

    return {
      id: ch.id || `ch${idx + 1}`,
      title: ch.title,
      subtitle: undefined,
      energyCurve: "cruise" as const,
      startFrame,
      endFrame: cursor,
      titleCard: { durationFrames: titleCardFrames },
      clips,
    };
  });

  // Hook prologue: 5s cold open chosen by AI (no mechanical scoring).
  let hookPicks: HookPick[] = [];
  try {
    hookPicks = await pickHookFidsAI(opts.theme, timelineChapters, byId, opts.promptVersion);
  } catch (e) {
    err(`[hook] WARN: AI hook picking failed — skipping hook. ${(e as Error).message}`);
  }
  if (hookPicks.length > 0) {
    const hookChapter = buildHookChapter(hookPicks, fps);
    const hookFrames = hookChapter.endFrame;
    err(
      `[storyboard-places] hook: ${hookFrames} frames (${(hookFrames / fps).toFixed(1)}s), ${hookPicks.length} clips`,
    );
    for (const p of hookPicks) {
      err(`[hook]   ${p.fid}@${p.chapter} start=${p.startSec.toFixed(1)}s — ${p.reason}`);
    }
    // Shift everything else by hookFrames
    for (const ch of timelineChapters) {
      ch.startFrame += hookFrames;
      ch.endFrame += hookFrames;
      for (const cl of ch.clips) {
        cl.renderStartFrame += hookFrames;
        for (const sub of cl.subtitles) {
          sub.startFrame += hookFrames;
          sub.endFrame += hookFrames;
          if (sub.words) {
            for (const w of sub.words) {
              w.startFrame += hookFrames;
              w.endFrame += hookFrames;
            }
          }
        }
      }
    }
    timelineChapters.unshift(hookChapter);
    cursor += hookFrames;
  }

  const totalDurationFrames = cursor + outroFrames;

  const timeline: Timeline = {
    type: "vlog",
    version: 1,
    meta: {
      theme: opts.theme,
      language: opts.language,
      targetMinutes: Math.round((totalDurationFrames / fps / 60) * 10) / 10,
      generatedAt: new Date().toISOString(),
      modelInfo: `qwen3.6 + storyboard-places-${opts.promptVersion}`,
    },
    dimensions: { width: opts.width, height: opts.height, fps },
    totalDurationFrames,
    chapters: timelineChapters,
    bgm: { source: opts.bgmSource, gain: 0.18, duckOnSpeech: true },
    outro: { durationFrames: outroFrames, text: opts.theme },
  };

  const validated = timelineSchema.parse(timeline);
  cachePut(cacheKey, "video", validated);

  const json = JSON.stringify(validated, null, 2);
  if (opts.out) {
    const outPath = path.resolve(opts.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, json, "utf-8");
    err(`[storyboard-places] wrote timeline → ${outPath}`);
    // Also write the raw places grouping for human review
    const sbPath = path.join(path.dirname(outPath), "storyboard-places.json");
    await fs.writeFile(
      sbPath,
      JSON.stringify(
        {
          chapters: chapters.map((c) => ({
            id: c.id,
            title: c.title,
            kind: c.kind,
            fileIds: c.fileIds,
            timeRange: `${formatLocalTime(byId.get(c.fileIds[0] ?? "")?.takenAt)}-${formatLocalTime(byId.get(c.fileIds[c.fileIds.length - 1] ?? "")?.takenAt)}`,
          })),
          unused: unused.map(fileIdFromEntry),
        },
        null,
        2,
      ),
      "utf-8",
    );
    err(`[storyboard-places] wrote grouping → ${sbPath}`);
  }

  const totalSeconds = totalDurationFrames / fps;
  err(
    `[storyboard-places] DONE chapters=${timelineChapters.length} clips=${timelineChapters.reduce((s, c) => s + c.clips.length, 0)} totalSec=${totalSeconds.toFixed(1)} (${(totalSeconds / 60).toFixed(1)}min)`,
  );
  process.stdout.write(`${json}\n`);
}

main().catch((e) => {
  err("FATAL", (e as Error).stack ?? (e as Error).message);
  process.exit(1);
});

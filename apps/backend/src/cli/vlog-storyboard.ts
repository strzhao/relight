import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { aiClient } from "../ai/client";
import { loadPrompts } from "../ai/prompts";
import { hammingDistance } from "../lib/phash";
import { cacheGet, cachePut } from "./vlog/lib/cache";
import { err, segmentRebase } from "./vlog/lib/util";
import {
  type ManifestImageEntry,
  type ManifestVideoEntry,
  type StoryboardArc,
  type StoryboardClip,
  type Timeline,
  type TimelineClip,
  type TranscriptSegment,
  batchManifestSchema,
  storyboardArcSchema,
  storyboardClipSchema,
  timelineSchema,
} from "./vlog/types";

interface CliOpts {
  manifestPath: string | null;
  theme: string | null;
  targetMinutes: number;
  language: string;
  out?: string;
  promptVersion: string;
  fps: number;
  width: number;
  height: number;
  bgmSource: string;
  forceRegen: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    manifestPath: null,
    theme: null,
    targetMinutes: 15,
    language: "zh",
    promptVersion: "v2",
    fps: 30,
    width: 1920,
    height: 1080,
    bgmSource: "audio/bgm.m4a",
    forceRegen: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--theme") opts.theme = argv[++i] ?? null;
    else if (a === "--target-minutes") opts.targetMinutes = Number(argv[++i]);
    else if (a === "--language") opts.language = argv[++i] ?? "zh";
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--prompt-version") opts.promptVersion = argv[++i] ?? "v2";
    else if (a === "--fps") opts.fps = Number(argv[++i]);
    else if (a === "--width") opts.width = Number(argv[++i]);
    else if (a === "--height") opts.height = Number(argv[++i]);
    else if (a === "--bgm") opts.bgmSource = argv[++i] ?? "audio/bgm.m4a";
    else if (a === "--force") opts.forceRegen = true;
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

function safeParseJson<T>(
  raw: string,
  schema: z.ZodType<T>,
): { ok: true; data: T } | { ok: false; error: string; rawText: string } {
  const jsonStr = extractJsonString(raw);
  if (!jsonStr) return { ok: false, error: "no json block in response", rawText: raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return { ok: false, error: `json parse: ${(e as Error).message}`, rawText: raw };
  }
  const r = schema.safeParse(parsed);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, error: `zod: ${r.error.message}`, rawText: raw };
}

type ManifestEntry = ManifestImageEntry | ManifestVideoEntry;

function fileIdFromEntry(entry: ManifestEntry): string {
  return path.basename(entry.filePath, path.extname(entry.filePath));
}

function dedupByPhash(entries: ManifestEntry[], threshold = 6): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  for (const e of entries) {
    const h = e.phash;
    if (!h) {
      out.push(e);
      continue;
    }
    let dup = false;
    for (const k of out) {
      if (k.phash && hammingDistance(h, k.phash) <= threshold) {
        const eScore = e.ai?.aestheticScore ?? 0;
        const kScore = k.ai?.aestheticScore ?? 0;
        if (eScore > kScore) {
          // replace k with e
          const idx = out.indexOf(k);
          out[idx] = e;
        }
        dup = true;
        break;
      }
    }
    if (!dup) out.push(e);
  }
  return out;
}

function buildOverallSummary(entries: ManifestEntry[]): string {
  // Aggregate top tags & moods
  const tagCounts = new Map<string, number>();
  const moodCounts = new Map<string, number>();
  let totalDur = 0;
  let videoCount = 0;
  let imageCount = 0;
  for (const e of entries) {
    if (!e.ai) continue;
    if (e.type === "video") {
      videoCount++;
      totalDur += e.durationSec ?? 0;
    } else {
      imageCount++;
    }
    for (const t of e.ai.tags ?? []) {
      tagCounts.set(t.name, (tagCounts.get(t.name) ?? 0) + 1);
    }
    const mood = e.ai.emotionalAnalysis?.primary;
    if (mood) moodCounts.set(mood, (moodCounts.get(mood) ?? 0) + 1);
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([n, c]) => `${n}×${c}`)
    .join("、");
  const topMoods = [...moodCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([n, c]) => `${n}×${c}`)
    .join("、");
  return [
    `图片 ${imageCount} 张，视频 ${videoCount} 段（视频总时长约 ${Math.round(totalDur)} 秒）`,
    `主要标签：${topTags || "（无）"}`,
    `主要情绪：${topMoods || "（无）"}`,
  ].join("\n");
}

export function buildAvailableList(entries: ManifestEntry[]): string {
  return entries
    .map((e) => {
      const id = fileIdFromEntry(e);
      const score = e.ai?.aestheticScore?.toFixed(1) ?? "?";
      const tags = (e.ai?.tags ?? [])
        .slice(0, 5)
        .map((t) => t.name)
        .join(",");
      const mood = e.ai?.emotionalAnalysis?.primary ?? "";
      const brief = (e.ai?.narrative ?? "").slice(0, 60).replace(/\n/g, " ");
      const personNames = (e.persons ?? []).filter((p) => p.name).map((p) => p.name);
      const personsStr = personNames.join("、");
      if (e.type === "video") {
        const dur = e.durationSec.toFixed(1);
        const trim = e.suggestedTrim
          ? `trim=${e.suggestedTrim.startSec.toFixed(1)}-${e.suggestedTrim.endSec.toFixed(1)}`
          : "trim=full";
        const tx = e.transcript?.text?.slice(0, 60).replace(/\n/g, " ") ?? "";
        return `[id=${id}] [vid ${dur}s] [${trim}] [pacing=${e.ai?.videoPacing ?? "?"} motion=${e.ai?.motionScore ?? "?"}] [score=${score}] tags=${tags} mood=${mood}${tx ? ` tx="${tx}"` : ""} brief="${brief}" persons="${personsStr}"`;
      }
      return `[id=${id}] [pic] [score=${score}] tags=${tags} mood=${mood} brief="${brief}" persons="${personsStr}"`;
    })
    .join("\n");
}

async function generateArc(
  theme: string,
  targetMinutes: number,
  entries: ManifestEntry[],
  promptVersion: string,
): Promise<StoryboardArc> {
  const prompts = await loadPrompts(promptVersion, "vlog/storyboard-arc");
  const summary = buildOverallSummary(entries);
  const imageCount = entries.filter((e) => e.type === "image").length;
  const videoCount = entries.filter((e) => e.type === "video").length;
  const userPrompt = prompts.user
    .replace("{theme}", theme)
    .replace("{target_minutes}", String(targetMinutes))
    .replace("{file_count}", String(entries.length))
    .replace("{image_count}", String(imageCount))
    .replace("{video_count}", String(videoCount))
    .replace("{summary}", summary);
  err(`[storyboard] arc pass: prompt size ≈ ${prompts.system.length + userPrompt.length} chars`);
  const raw = await aiClient.chat(userPrompt, prompts.system);
  const r = safeParseJson(raw, storyboardArcSchema);
  if (!r.ok) {
    err(`[storyboard] arc parse failed: ${r.error}`);
    err(`[storyboard] raw response (first 500):\n${r.rawText.slice(0, 500)}`);
    throw new Error(`arc parse: ${r.error}`);
  }
  return r.data;
}

async function generateClipsForChapter(
  theme: string,
  chapter: StoryboardArc["chapters"][number],
  arc: StoryboardArc,
  available: ManifestEntry[],
  previousIds: string[],
  promptVersion: string,
): Promise<StoryboardClip[]> {
  const prompts = await loadPrompts(promptVersion, "vlog/storyboard-clips");
  const userPrompt = prompts.user
    .replace("{chapter_json}", JSON.stringify(chapter))
    .replace("{theme}", theme)
    .replace("{hook_strategy}", arc.hookStrategy)
    .replace("{ending_beat}", arc.endingBeat)
    .replace("{available_list}", buildAvailableList(available))
    .replace("{previous_ids}", previousIds.length ? previousIds.join(", ") : "（无）");
  err(
    `[storyboard] clips pass for ${chapter.id}: prompt size ≈ ${prompts.system.length + userPrompt.length} chars`,
  );
  const raw = await aiClient.chat(userPrompt, prompts.system, { maxTokens: 8192 });
  const jsonStr = extractJsonString(raw);
  if (!jsonStr) {
    err(`[storyboard] clips ${chapter.id}: no json block. raw (500):\n${raw.slice(0, 500)}`);
    return [];
  }
  let parsedObj: unknown;
  try {
    parsedObj = JSON.parse(jsonStr);
  } catch (e) {
    err(`[storyboard] clips ${chapter.id}: json parse fail: ${(e as Error).message}`);
    return [];
  }
  const rawClips = (parsedObj as { clips?: unknown }).clips;
  if (!Array.isArray(rawClips)) {
    err(`[storyboard] clips ${chapter.id}: missing 'clips' array`);
    return [];
  }
  const out: StoryboardClip[] = [];
  for (const c of rawClips) {
    const r = storyboardClipSchema.safeParse(c);
    if (r.success) out.push(r.data);
    else err(`[storyboard] clips ${chapter.id}: clip rejected: ${r.error.message.slice(0, 200)}`);
  }
  return out;
}

function buildTimelineClipsForChapter(
  chapterClips: StoryboardClip[],
  entries: ManifestEntry[],
  fps: number,
  startFrame: number,
): { clips: TimelineClip[]; endFrame: number } {
  const out: TimelineClip[] = [];
  let cursor = startFrame;
  const byId = new Map<string, ManifestEntry>();
  for (const e of entries) byId.set(fileIdFromEntry(e), e);

  for (const sc of chapterClips) {
    const entry = byId.get(sc.fileId);
    if (!entry) {
      err(`[storyboard] WARN clip references unknown fileId: ${sc.fileId}`);
      continue;
    }
    // Force kind to match the manifest entry (AI sometimes mislabels photos as videos)
    const actualKind: "photo" | "video" = entry.type === "video" ? "video" : "photo";
    if (actualKind !== sc.type) {
      err(
        `[storyboard] correcting clip ${sc.fileId}: storyboard said ${sc.type}, manifest says ${actualKind}`,
      );
    }
    const renderDurationFrames = Math.max(1, Math.round(sc.durationSec * fps));
    let subtitles: TimelineClip["subtitles"] = [];
    if (actualKind === "video" && entry.type === "video" && entry.transcript?.segments?.length) {
      const srcStart = sc.startSec ?? 0;
      const srcEnd = sc.endSec ?? entry.durationSec;
      const rebased: TranscriptSegment[] = segmentRebase(
        entry.transcript.segments,
        srcStart,
        srcEnd,
      );
      subtitles = rebased
        .filter((s) => s.text.trim().length > 0)
        .map((s) => {
          const startSegFrame = cursor + Math.round(s.start * fps);
          const endSegFrame = cursor + Math.round(s.end * fps);
          return {
            startFrame: startSegFrame,
            endFrame: Math.max(startSegFrame + 1, endSegFrame),
            text: s.text,
            words: s.words?.map((w) => ({
              startFrame: cursor + Math.round(w.start * fps),
              endFrame: cursor + Math.max(Math.round(w.end * fps), Math.round(w.start * fps) + 1),
              word: w.word,
            })),
          };
        });
    }

    const sourceRel = `sources/${path.basename(entry.filePath)}`;
    // Photos shouldn't have srcStartSec/srcEndSec; force-clear if AI provided them.
    const isVideo = actualKind === "video";
    out.push({
      id: `${sc.fileId}-${cursor}`,
      source: sourceRel,
      kind: actualKind,
      srcStartSec: isVideo ? (sc.startSec ?? 0) : undefined,
      srcEndSec: isVideo ? sc.endSec : undefined,
      renderStartFrame: cursor,
      renderDurationFrames,
      kenBurns: !isVideo ? sc.kenBurns : undefined,
      subtitles,
      subtitleStyle: sc.subtitleStyle,
      transitionIn: sc.transitionIn,
      audioGain: isVideo ? 0.7 : 0,
    });
    cursor += renderDurationFrames;
  }
  return { clips: out, endFrame: cursor };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.manifestPath || !opts.theme) {
    err(
      "用法: tsx src/cli/vlog-storyboard.ts <manifestPath> --theme '…' [--target-minutes 15] [--language zh] [--out timeline.json] [--prompt-version v2] [--fps 30] [--width 1920] [--height 1080] [--bgm audio/bgm.m4a] [--force]",
    );
    process.exit(1);
  }
  const manifestPath = path.resolve(opts.manifestPath);
  const raw = await fs.readFile(manifestPath, "utf-8");
  const manifest = batchManifestSchema.parse(JSON.parse(raw));
  err(`[storyboard] manifest loaded: ${manifest.files.length} entries`);

  // Filter usable: ok + has ai
  const usable = manifest.files.filter((f) => f.ok && f.ai) as ManifestEntry[];
  err(`[storyboard] usable (ok + ai): ${usable.length}`);

  // Phash dedup
  const deduped = dedupByPhash(usable, 6);
  err(`[storyboard] after phash dedup (≤6): ${deduped.length}`);

  // Score floor: drop aestheticScore < 3 unless we'd lose too many
  let filtered = deduped.filter((e) => (e.ai?.aestheticScore ?? 0) >= 3);
  if (filtered.length < deduped.length * 0.6) {
    err("[storyboard] score floor would drop too many; keeping all deduped");
    filtered = deduped;
  } else {
    err(`[storyboard] after score≥3 filter: ${filtered.length}`);
  }

  // Cap to 60 entries
  if (filtered.length > 60) {
    filtered = [...filtered]
      .sort((a, b) => (b.ai?.aestheticScore ?? 0) - (a.ai?.aestheticScore ?? 0))
      .slice(0, 60);
    err("[storyboard] capped to top 60 by aestheticScore");
  }

  // Cache
  const fileIdsKey = filtered
    .map((e) => e.sha256)
    .sort()
    .join(",");
  const cacheKey = `storyboard:${manifestPath}:${opts.theme}:${opts.targetMinutes}:${opts.promptVersion}:${fileIdsKey.slice(0, 64)}`;
  if (!opts.forceRegen) {
    const cached = cacheGet<{ arc: StoryboardArc; timeline: Timeline }>(cacheKey);
    if (cached) {
      err("[storyboard] cache hit, using cached storyboard");
      const json = JSON.stringify(cached.timeline, null, 2);
      if (opts.out) {
        await fs.mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
        await fs.writeFile(path.resolve(opts.out), json, "utf-8");
      }
      process.stdout.write(`${json}\n`);
      return;
    }
  }

  // Pass 1: arc
  const arc = await generateArc(opts.theme, opts.targetMinutes, filtered, opts.promptVersion);
  err(`[storyboard] arc: hook='${arc.hookStrategy.slice(0, 40)}…' chapters=${arc.chapters.length}`);
  for (const ch of arc.chapters) {
    err(`[storyboard]   ${ch.id}: ${ch.title} (${ch.targetMinutes}min, ${ch.energyCurve})`);
  }

  // Pass 2: clips per chapter (sequential to avoid Qwen overload)
  const usedIds = new Set<string>();
  const chapterClips: { chapter: StoryboardArc["chapters"][number]; clips: StoryboardClip[] }[] =
    [];
  for (const ch of arc.chapters) {
    const clips = await generateClipsForChapter(
      opts.theme,
      ch,
      arc,
      filtered,
      [...usedIds],
      opts.promptVersion,
    );
    err(`[storyboard]   ${ch.id} clips: ${clips.length}`);
    for (const c of clips) usedIds.add(c.fileId);
    chapterClips.push({ chapter: ch, clips });
  }

  // Compose timeline
  const fps = opts.fps;
  const titleCardFrames = 60; // 2s at 30fps
  let cursor = 0;
  const timelineChapters = chapterClips.map(({ chapter, clips }) => {
    const startFrame = cursor;
    const titleCardEnd = cursor + titleCardFrames;
    const built = buildTimelineClipsForChapter(clips, filtered, fps, titleCardEnd);
    cursor = built.endFrame;
    return {
      id: chapter.id,
      title: chapter.title,
      subtitle: chapter.subtitle,
      energyCurve: chapter.energyCurve,
      startFrame,
      endFrame: cursor,
      titleCard: { durationFrames: titleCardFrames },
      clips: built.clips,
    };
  });

  const outroFrames = 90; // 3s at 30fps
  const totalDurationFrames = cursor + outroFrames;

  const timeline: Timeline = {
    type: "vlog",
    version: 1,
    meta: {
      theme: opts.theme,
      language: opts.language,
      targetMinutes: opts.targetMinutes,
      generatedAt: new Date().toISOString(),
      modelInfo: `qwen3.6 + storyboard-${opts.promptVersion}`,
    },
    dimensions: { width: opts.width, height: opts.height, fps },
    totalDurationFrames,
    chapters: timelineChapters,
    bgm: { source: opts.bgmSource, gain: 0.25, duckOnSpeech: true },
    outro: { durationFrames: outroFrames, text: opts.theme },
  };

  const validated = timelineSchema.parse(timeline);
  cachePut(cacheKey, "video" /* reuse 'video' kind for storyboards */, {
    arc,
    timeline: validated,
  });

  const json = JSON.stringify(validated, null, 2);
  if (opts.out) {
    const outPath = path.resolve(opts.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, json, "utf-8");
    err(`[storyboard] wrote timeline → ${outPath}`);
    // Also write storyboard.json (the raw arc + clips per chapter, for debugging / human override)
    const sbPath = path.join(path.dirname(outPath), "storyboard.json");
    await fs.writeFile(sbPath, JSON.stringify({ arc, chapters: chapterClips }, null, 2), "utf-8");
    err(`[storyboard] wrote storyboard → ${sbPath}`);
  }

  const totalSeconds = totalDurationFrames / fps;
  err(
    `[storyboard] DONE chapters=${timelineChapters.length} totalFrames=${totalDurationFrames} totalSec=${totalSeconds.toFixed(1)} (${(totalSeconds / 60).toFixed(1)}min)`,
  );
  process.stdout.write(`${json}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    err("FATAL", (e as Error).stack ?? (e as Error).message);
    process.exit(1);
  });
}

/**
 * vlog-frame-extract — 抽帧 + 生成 captioning todo
 *
 * 路径 B：CLI 只抽帧（用 ffmpeg），不调 LLM。
 * 执行 vlog-production skill 的 Claude 读 todo.json + 用 Read 工具看图 +
 * 生成 captions + 写回 manifest.files[].ai.frameCaptions。
 *
 * 用法:
 *   pnpm --filter @relight/backend exec tsx src/cli/vlog-frame-extract.ts <manifestPath>
 *       [--min-duration <sec>]       默认 60（duration < 该值不抽帧）
 *       [--frame-interval <sec>]     默认 20（每 N 秒一帧）
 *       [--max-frames <N>]           默认 15（每 clip 上限）
 *       [--max-edge <px>]            默认 854（最长边 px，控制图片体积）
 *       [--selection <path>]         可选；只抽 selection.order 里非 excluded 的 clip
 *       [--force]                    重抽覆盖既有图
 *       [--concurrency <N>]          默认 2（视频级并发）
 *       [--dry-run]                  只输出抽帧计划，不实际抽
 *
 * 输出:
 *   - <contentDir>/sources-frames/<fid>/frame_<tSec>s.jpg
 *   - <contentDir>/frame-captions-todo.json （Claude 看完后写回 manifest 即可删除）
 *
 * 跳过逻辑：
 *   - 已有 frameCaptions 字段且数量 ≥ 预期帧数 → 跳过（除非 --force）
 *   - 已有图片文件 → 跳过具体帧抽取（仍写入 todo.json，可重做 captioning）
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { err, pLimit } from "./vlog/lib/util";
import type { BatchManifest, ManifestVideoEntry, Selection } from "./vlog/types";
import { batchManifestSchema, selectionSchema } from "./vlog/types";

interface CliOpts {
  manifestPath: string | null;
  minDuration: number;
  frameInterval: number;
  maxFrames: number;
  maxEdge: number;
  selectionPath: string | null;
  force: boolean;
  concurrency: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    manifestPath: null,
    minDuration: 60,
    frameInterval: 20,
    maxFrames: 15,
    maxEdge: 854,
    selectionPath: null,
    force: false,
    concurrency: 2,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--min-duration") opts.minDuration = Number(argv[++i]);
    else if (a === "--frame-interval") opts.frameInterval = Number(argv[++i]);
    else if (a === "--max-frames") opts.maxFrames = Number(argv[++i]);
    else if (a === "--max-edge") opts.maxEdge = Number(argv[++i]);
    else if (a === "--selection") opts.selectionPath = argv[++i] ?? null;
    else if (a === "--force") opts.force = true;
    else if (a === "--concurrency") opts.concurrency = Number(argv[++i]);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (!a.startsWith("--") && opts.manifestPath === null) opts.manifestPath = a;
  }
  return opts;
}

/** 计算应该抽哪些 tSec：从 frameInterval/2 开始，每 frameInterval 一帧，上限 maxFrames */
function planFrameTimes(durationSec: number, intervalSec: number, maxFrames: number): number[] {
  const times: number[] = [];
  // 起点：interval/4 后（避开开头 0-3s 黑场/调焦）；至少 1s
  const startOffset = Math.max(1, intervalSec / 4);
  for (let t = startOffset; t < durationSec - 1; t += intervalSec) {
    times.push(Math.round(t));
    if (times.length >= maxFrames) break;
  }
  return times;
}

interface ExtractedClipPlan {
  fid: string;
  filePath: string;
  durationSec: number;
  narrative: string;
  tags: string;
  framesDir: string; // 相对 contentDir
  frames: { tSec: number; imagePath: string; absImagePath: string }[];
}

async function existsAsync(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/** ffmpeg 抽单帧：精确到 ss + 1 frame + 缩放 */
async function extractOneFrame(
  videoPath: string,
  tSec: number,
  outPath: string,
  maxEdge: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-ss",
      String(tSec),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      "-vf",
      `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`,
      outPath,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
    proc.on("error", reject);
  });
}

/** 给一个 clip 算计划 + （非 dryRun）抽帧 */
async function processClip(
  entry: ManifestVideoEntry,
  contentDir: string,
  opts: CliOpts,
): Promise<ExtractedClipPlan | null> {
  const fid = path.basename(entry.filePath, path.extname(entry.filePath));
  const dur = entry.durationSec;
  if (dur < opts.minDuration) return null;

  const existing = entry.ai?.frameCaptions ?? [];
  const expectedCount = Math.min(
    opts.maxFrames,
    Math.max(1, Math.floor((dur - 1) / opts.frameInterval)),
  );
  if (!opts.force && existing.length >= expectedCount) {
    err(
      `[frame-extract] ${fid} skip: already has ${existing.length} captions (≥ ${expectedCount})`,
    );
    return null;
  }

  const times = planFrameTimes(dur, opts.frameInterval, opts.maxFrames);
  const framesRelDir = path.join("sources-frames", fid);
  const framesAbsDir = path.join(contentDir, framesRelDir);
  await fs.mkdir(framesAbsDir, { recursive: true });

  // 源 mp4：优先用 sources/<baseName>，否则 manifest.filePath（NAS 绝对路径）
  const baseName = path.basename(entry.filePath);
  const sourcesCandidate = path.join(contentDir, "sources", baseName);
  const videoPath = (await existsAsync(sourcesCandidate))
    ? sourcesCandidate
    : (entry.realPath ?? entry.filePath);

  const frames = times.map((t) => {
    const fname = `frame_${t}s.jpg`;
    return {
      tSec: t,
      imagePath: path.join(framesRelDir, fname),
      absImagePath: path.join(framesAbsDir, fname),
    };
  });

  if (opts.dryRun) {
    err(
      `[frame-extract] dry-run ${fid}: dur=${dur.toFixed(1)}s would extract ${frames.length} frames [${times.join(",")}]`,
    );
  } else {
    let extracted = 0;
    let cached = 0;
    for (const f of frames) {
      if (!opts.force && (await existsAsync(f.absImagePath))) {
        cached++;
        continue;
      }
      try {
        await extractOneFrame(videoPath, f.tSec, f.absImagePath, opts.maxEdge);
        extracted++;
      } catch (e) {
        err(`[frame-extract] ${fid} @${f.tSec}s FAILED: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    err(
      `[frame-extract] ${fid} dur=${dur.toFixed(1)}s extracted=${extracted} cached=${cached} total=${frames.length}`,
    );
  }

  return {
    fid,
    filePath: entry.filePath,
    durationSec: dur,
    narrative: entry.ai?.narrative ?? "",
    tags: (entry.ai?.tags ?? []).map((t) => t.name).join(", "),
    framesDir: framesRelDir,
    frames,
  };
}

interface TodoFile {
  schemaVersion: "1";
  generatedAt: string;
  contentDir: string;
  manifestPath: string;
  clips: Array<{
    fid: string;
    durationSec: number;
    narrative: string;
    tags: string;
    framesDir: string;
    frames: Array<{ tSec: number; imagePath: string }>;
  }>;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.manifestPath) {
    err(
      "用法: tsx src/cli/vlog-frame-extract.ts <manifestPath> [--min-duration 60] [--frame-interval 20] [--max-frames 15] [--max-edge 854] [--selection <path>] [--force] [--concurrency 2] [--dry-run]",
    );
    process.exit(1);
  }

  const absManifestPath = path.resolve(opts.manifestPath);
  const contentDir = path.dirname(absManifestPath);

  const raw = await fs.readFile(absManifestPath, "utf-8");
  const manifest: BatchManifest = batchManifestSchema.parse(JSON.parse(raw));

  let selection: Selection | null = null;
  if (opts.selectionPath) {
    try {
      const selRaw = await fs.readFile(opts.selectionPath, "utf-8");
      selection = selectionSchema.parse(JSON.parse(selRaw));
      err(
        `[frame-extract] selection loaded: ${selection.order.length} in order, ${selection.excluded.length} excluded`,
      );
    } catch (e) {
      err(`[frame-extract] WARN failed to load selection: ${(e as Error).message}`);
    }
  }

  const excluded = selection ? new Set(selection.excluded) : null;
  const orderSet = selection ? new Set(selection.order) : null;
  const videoEntries = manifest.files.filter(
    (f): f is ManifestVideoEntry => f.type === "video" && f.ok,
  );

  const targetEntries = videoEntries.filter((e) => {
    if (e.durationSec < opts.minDuration) return false;
    const fid = path.basename(e.filePath, path.extname(e.filePath));
    if (excluded?.has(fid)) return false;
    if (orderSet && !orderSet.has(fid)) return false;
    return true;
  });

  err(
    `[frame-extract] target=${targetEntries.length}/${videoEntries.length} videos (duration ≥ ${opts.minDuration}s${selection ? ", filtered by selection" : ""})`,
  );

  const limit = pLimit<ExtractedClipPlan | null>(opts.concurrency);
  const plans = await Promise.all(
    targetEntries.map((e) => limit(async () => processClip(e, contentDir, opts))),
  );

  const validPlans = plans.filter((p): p is ExtractedClipPlan => p !== null);

  // 写 todo.json
  const todoPath = path.join(contentDir, "frame-captions-todo.json");
  if (validPlans.length === 0) {
    err("[frame-extract] no clips need captioning");
    // 清理旧 todo
    if (await existsAsync(todoPath)) await fs.unlink(todoPath);
    return;
  }

  const todo: TodoFile = {
    schemaVersion: "1",
    generatedAt: new Date().toISOString(),
    contentDir,
    manifestPath: absManifestPath,
    clips: validPlans.map((p) => ({
      fid: p.fid,
      durationSec: p.durationSec,
      narrative: p.narrative,
      tags: p.tags,
      framesDir: p.framesDir,
      frames: p.frames.map((f) => ({ tSec: f.tSec, imagePath: f.imagePath })),
    })),
  };

  if (!opts.dryRun) {
    await fs.writeFile(todoPath, JSON.stringify(todo, null, 2), "utf-8");
    err(`[frame-extract] todo written: ${todoPath} (${validPlans.length} clips)`);
  } else {
    err(`[frame-extract] dry-run done: would write ${todoPath} with ${validPlans.length} clips`);
  }

  err("[frame-extract] DONE — next: 由执行 skill 的 Claude 读 todo.json 看图生成 captions");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    err("FATAL", (e as Error).stack ?? (e as Error).message);
    process.exit(1);
  });
}

/**
 * vlog-smart-trim — 把 smartTrim 算法前置为独立阶段
 *
 * 用法:
 *   pnpm --filter @relight/backend exec tsx src/cli/vlog-smart-trim.ts <manifestPath>
 *       [--max-clip-sec <N>] [--force] [--concurrency <N>] [--dry-run]
 *
 * 输出:
 *   - <contentDir>/sources-trimmed/<fid>.mp4（精华段视频）
 *   - manifest.json 更新（原子写）：durationSec + transcript.segments + sourceTrim 字段
 */
import fs from "node:fs/promises";
import path from "node:path";
import { extractClip, probeVideo } from "../lib/video/ffmpeg";
import { shiftSegments, smartTrimWindow, splitSegmentByWordGap } from "./vlog/lib/smart-trim";
import { err, pLimit } from "./vlog/lib/util";
import type { BatchManifest, ManifestVideoEntry } from "./vlog/types";
import { batchManifestSchema } from "./vlog/types";

interface CliOpts {
  manifestPath: string | null;
  maxClipSec: number;
  force: boolean;
  concurrency: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    manifestPath: null,
    maxClipSec: 50,
    force: false,
    concurrency: 2,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--max-clip-sec") {
      opts.maxClipSec = Number(argv[++i]);
    } else if (a === "--force") {
      opts.force = true;
    } else if (a === "--concurrency") {
      opts.concurrency = Number(argv[++i]);
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (!a.startsWith("--") && opts.manifestPath === null) {
      opts.manifestPath = a;
    }
  }
  return opts;
}

/**
 * 判断 sourceTrim 缓存是否有效：
 *   - trimmedFile 存在
 *   - entry.sourceTrim.status === "ok"
 *   - entry.sourceTrim.startSec / endSec 与计算值一致（允许 ±0.1s 误差）
 */
function isCacheHit(
  trimmedFilePath: string,
  entry: ManifestVideoEntry,
  computedStart: number,
  computedEnd: number,
): boolean {
  // 检查文件存在性（同步，但在 worker 里调用前已 await fs.access）
  const st = entry.sourceTrim;
  if (!st || st.status !== "ok") return false;
  if (Math.abs(st.startSec - computedStart) > 0.1) return false;
  if (Math.abs(st.endSec - computedEnd) > 0.1) return false;
  return true;
}

async function trimmedFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function processEntry(
  entry: ManifestVideoEntry,
  contentDir: string,
  opts: CliOpts,
): Promise<ManifestVideoEntry> {
  const fid = path.basename(entry.filePath, path.extname(entry.filePath));
  const baseName = path.basename(entry.filePath);
  const trimmedDir = path.join(contentDir, "sources-trimmed");
  // 契约 C1：trimmed 文件统一 .mp4 容器（ffmpeg libx264 输出 MP4），扩展名标准化避免 Remotion/Web video 不识别 .MOV/.MTS 等
  const trimmedPath = path.join(trimmedDir, `${fid}.mp4`);
  const sourcePath = path.join(contentDir, "sources", baseName);

  // 1. 先对 segments 做 word-gap split（前置处理）
  const rawSegs = entry.transcript?.segments ?? [];
  const splitSegs = splitSegmentByWordGap(rawSegs, 1.5);

  // 2. 计算 smartTrim 窗口
  const { startSec, endSec } = smartTrimWindow(entry.durationSec, splitSegs, opts.maxClipSec);

  // 3. 缓存判定
  const fileExists = await trimmedFileExists(trimmedPath);
  if (!opts.force && fileExists && isCacheHit(trimmedPath, entry, startSec, endSec)) {
    err(`[smart-trim] cache hit: ${fid}`);
    // 保留现有 sourceTrim 字段（deep copy 已保留，直接返回 entry 原样）
    return entry;
  }

  // 4. dry-run: 不执行实际操作
  if (opts.dryRun) {
    return entry;
  }

  // 5. 确保输出目录存在
  await fs.mkdir(trimmedDir, { recursive: true });

  const originalDurationSec = entry.durationSec;
  const trimmedAt = new Date().toISOString();

  try {
    // 6. ffmpeg 裁切
    await extractClip(sourcePath, startSec, endSec, trimmedPath);

    // 7. ffprobe 取实际 trimmed 时长
    const probe = await probeVideo(trimmedPath);
    const actualTrimmedSec = probe.durationSec;

    // 8. 平移 segments 时间戳
    const shiftedSegs = shiftSegments(splitSegs, startSec, actualTrimmedSec);

    // 9. 构建更新后的 entry（in-memory only）
    const updatedEntry: ManifestVideoEntry = {
      ...entry,
      durationSec: actualTrimmedSec,
      transcript: entry.transcript
        ? {
            ...entry.transcript,
            segments: shiftedSegs,
            updatedAt: trimmedAt,
          }
        : undefined,
      sourceTrim: {
        startSec,
        endSec,
        originalDurationSec,
        trimmedAt,
        status: "ok",
      },
    };

    err(
      `[smart-trim] ok: ${fid} (${startSec.toFixed(1)}-${endSec.toFixed(1)}s → ${actualTrimmedSec.toFixed(1)}s, segs=${shiftedSegs.length})`,
    );
    return updatedEntry;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    err(`[smart-trim] FAILED ${fid}: ${reason}`);

    // 失败时清理可能残留的 trimmed 文件
    try {
      await fs.unlink(trimmedPath);
    } catch {
      // ignore
    }

    // 写 trim_failed 到 entry，保留原始 durationSec + segments
    return {
      ...entry,
      sourceTrim: {
        startSec,
        endSec,
        originalDurationSec,
        trimmedAt,
        status: "trim_failed",
      },
    };
  }
}

export async function runSmartTrim(manifestPath: string, opts: CliOpts): Promise<void> {
  const absManifestPath = path.resolve(manifestPath);
  const contentDir = path.dirname(absManifestPath);

  // 1. 加载 manifest
  const raw = await fs.readFile(absManifestPath, "utf-8");
  const manifest = batchManifestSchema.parse(JSON.parse(raw));

  // 2. 深拷贝得到 working copy
  const workingManifest: BatchManifest = JSON.parse(JSON.stringify(manifest));

  // 3. 过滤出 video entries
  const videoEntries = workingManifest.files.filter(
    (f): f is ManifestVideoEntry => f.type === "video" && f.ok,
  );

  if (opts.dryRun) {
    // dry-run: 统计 would-process vs would-skip
    let wouldProcess = 0;
    let wouldSkip = 0;

    for (const entry of videoEntries) {
      // 契约 C1：trimmed 文件统一 .mp4 扩展名（与 processEntry 一致），避免 .MOV/.MTS 等输入造成 dry-run 缓存判定偏差
      const fid = path.basename(entry.filePath, path.extname(entry.filePath));
      const trimmedPath = path.join(contentDir, "sources-trimmed", `${fid}.mp4`);
      const rawSegs = entry.transcript?.segments ?? [];
      const splitSegs = splitSegmentByWordGap(rawSegs, 1.5);
      const { startSec, endSec } = smartTrimWindow(entry.durationSec, splitSegs, opts.maxClipSec);
      const fileExists = await trimmedFileExists(trimmedPath);
      if (!opts.force && fileExists && isCacheHit(trimmedPath, entry, startSec, endSec)) {
        wouldSkip++;
      } else {
        wouldProcess++;
      }
    }

    err(`[smart-trim] dry-run: would-process ${wouldProcess}, would-skip ${wouldSkip}`);
    return;
  }

  // 4. 并发处理所有 video entries
  const total = videoEntries.length;
  let processed = 0;

  type TrimResult = { fid: string; updated: ManifestVideoEntry };
  const limit = pLimit<TrimResult>(opts.concurrency);

  const promises = videoEntries.map((entry) =>
    limit(async (): Promise<TrimResult> => {
      const updated = await processEntry(entry, contentDir, opts);
      processed++;
      err(`[smart-trim] ${processed}/${total} files processed`);
      return { fid: path.basename(entry.filePath), updated };
    }),
  );

  const results = await Promise.all(promises);

  // 5. 把更新后的 entries 写回 working manifest
  const updatedByFid = new Map(results.map((r) => [r.fid, r.updated]));
  for (let i = 0; i < workingManifest.files.length; i++) {
    const f = workingManifest.files[i];
    if (!f || f.type !== "video") continue;
    const baseName = path.basename(f.filePath);
    const updated = updatedByFid.get(baseName);
    if (updated) {
      workingManifest.files[i] = updated;
    }
  }

  // 6. 原子写 manifest（契约 C8）
  const tmpPath = `${absManifestPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(workingManifest, null, 2), "utf-8");
  await fs.rename(tmpPath, absManifestPath);

  err(`[smart-trim] manifest written: ${absManifestPath}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.manifestPath) {
    err(
      "用法: tsx src/cli/vlog-smart-trim.ts <manifestPath> [--max-clip-sec <N>] [--force] [--concurrency <N>] [--dry-run]",
    );
    process.exit(1);
  }

  await runSmartTrim(opts.manifestPath, opts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    err("FATAL", (e as Error).stack ?? (e as Error).message);
    process.exit(1);
  });
}

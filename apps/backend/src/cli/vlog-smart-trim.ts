/**
 * vlog-smart-trim — Qwen 主导决策 + 代码安全网（方案 C）
 *
 * 用法:
 *   pnpm --filter @relight/backend exec tsx src/cli/vlog-smart-trim.ts <manifestPath>
 *       [--max-clip-sec <N>] [--force] [--concurrency <N>] [--dry-run]
 *       [--selection <path>] [--prompt-version <v>] [--closing-hard-max <sec>]
 *       [--qwen-timeout-ms <ms>]
 *
 * 输出:
 *   - <contentDir>/sources-trimmed/<fid>.mp4（精华段视频）
 *   - manifest.json 更新（原子写）：durationSec + transcript.segments + sourceTrim 字段
 *
 * 决策树（per clip）：
 *   position=first → skip (no ffmpeg, sourceTrim.status="skipped", source="first_skip")
 *   duration ≤ softMax → passthrough (ffmpeg encode-only, source="passthrough")
 *   cache hit → use cached trim (source="qwen_cache")
 *   Qwen ok → snap+cap → ffmpeg (source="qwen")
 *   Qwen fail → smartTrimWindow fallback → ffmpeg (source="fallback")
 */
import fs from "node:fs/promises";
import path from "node:path";
import { extractClip, probeVideo } from "../lib/video/ffmpeg";
import { shiftSegments, splitSegmentByWordGap } from "./vlog/lib/smart-trim";
import {
  CLOSING_HARD_MAX_SEC,
  inferPosition,
  softMaxForPosition,
  trimClipAI,
} from "./vlog/lib/smart-trim-ai";
import { err, pLimit } from "./vlog/lib/util";
import type { BatchManifest, ManifestVideoEntry, Selection, SourceTrim } from "./vlog/types";
import { batchManifestSchema, selectionSchema } from "./vlog/types";

// =========================================================
// CLI interface
// =========================================================

interface CliOpts {
  manifestPath: string | null;
  maxClipSec: number;
  force: boolean;
  concurrency: number;
  dryRun: boolean;
  selectionPath: string | null;
  promptVersion: string;
  closingHardMax: number;
  qwenTimeoutMs: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    manifestPath: null,
    maxClipSec: 120,
    force: false,
    concurrency: 2,
    dryRun: false,
    selectionPath: null,
    promptVersion: "v2",
    closingHardMax: CLOSING_HARD_MAX_SEC,
    qwenTimeoutMs: 30000,
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
    } else if (a === "--selection") {
      opts.selectionPath = argv[++i] ?? null;
    } else if (a === "--prompt-version") {
      opts.promptVersion = argv[++i] ?? "v2";
    } else if (a === "--closing-hard-max") {
      opts.closingHardMax = Number(argv[++i]);
    } else if (a === "--qwen-timeout-ms") {
      opts.qwenTimeoutMs = Number(argv[++i]);
    } else if (!a.startsWith("--") && opts.manifestPath === null) {
      opts.manifestPath = a;
    }
  }
  return opts;
}

// =========================================================
// File helpers
// =========================================================

async function trimmedFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// =========================================================
// processEntry — per-clip decision tree
// =========================================================

async function processEntry(
  entry: ManifestVideoEntry,
  contentDir: string,
  opts: CliOpts,
  selection: Selection | null,
): Promise<ManifestVideoEntry> {
  const fid = path.basename(entry.filePath, path.extname(entry.filePath));
  const baseName = path.basename(entry.filePath);
  const trimmedDir = path.join(contentDir, "sources-trimmed");
  // 契约 C1：trimmed 文件统一 .mp4 容器
  const trimmedPath = path.join(trimmedDir, `${fid}.mp4`);
  const sourcePath = path.join(contentDir, "sources", baseName);

  // 1. 推断 position
  const position = inferPosition(fid, selection);

  // 2. dry-run: 快速 first_skip check
  if (opts.dryRun) {
    if (position === "first") {
      err(`[smart-trim] dry-run: fid=${fid} pos=first action=first_skip`);
      return entry;
    }
    const softMax =
      position === "closing" ? opts.closingHardMax : softMaxForPosition(position, opts.maxClipSec);
    // closing 不 passthrough（总调 Qwen）
    if (position !== "closing" && entry.durationSec <= softMax) {
      err(
        `[smart-trim] dry-run: fid=${fid} pos=${position} would=passthrough dur=${entry.durationSec.toFixed(1)}`,
      );
    } else {
      err(
        `[smart-trim] dry-run: fid=${fid} pos=${position} would=qwen dur=${entry.durationSec.toFixed(1)} softMax=${softMax}`,
      );
    }
    return entry;
  }

  // 3. 调 trimClipAI 获取决策（不做 ffmpeg）
  const decision = await trimClipAI(entry, position, {
    promptVersion: opts.promptVersion,
    qwenTimeoutMs: opts.qwenTimeoutMs,
    maxClipSec: opts.maxClipSec,
    closingHardMaxSec: opts.closingHardMax,
  });

  // 4. first_skip → 不调 ffmpeg
  if (decision.status === "skipped") {
    err(
      `[smart-trim] fid=${fid} pos=first source=first_skip dur=${entry.durationSec.toFixed(1)}→skip`,
    );
    return {
      ...entry,
      sourceTrim: {
        startSec: decision.startSec,
        endSec: decision.endSec,
        originalDurationSec: entry.durationSec,
        status: "skipped",
        source: "first_skip",
        position: "first",
      } satisfies SourceTrim,
    };
  }

  // 5. 准备 ffmpeg 切片
  const { startSec, endSec, source, reason, capped, cappedFrom, fallbackReason } = decision;
  const originalDurationSec = entry.durationSec;
  const trimmedAt = new Date().toISOString();

  // 前置处理 segments（用于 shiftSegments）
  const rawSegs = entry.transcript?.segments ?? [];
  const splitSegs = splitSegmentByWordGap(rawSegs, 1.5);

  await fs.mkdir(trimmedDir, { recursive: true });

  // 6. ffmpeg 裁切
  try {
    await extractClip(sourcePath, startSec, endSec, trimmedPath);
    const probe = await probeVideo(trimmedPath);
    const actualTrimmedSec = probe.durationSec;
    const shiftedSegs = shiftSegments(splitSegs, startSec, actualTrimmedSec);

    err(
      `[smart-trim] fid=${fid} pos=${position} source=${source} dur=${originalDurationSec.toFixed(1)}→${actualTrimmedSec.toFixed(1)} capped=${capped ?? false}`,
    );

    const sourceTrim: SourceTrim = {
      startSec,
      endSec,
      originalDurationSec,
      trimmedAt,
      status: "ok",
      source,
      position,
      ...(reason !== undefined ? { reason } : {}),
      ...(capped ? { capped, cappedFrom } : {}),
      ...(fallbackReason !== undefined ? { fallbackReason } : {}),
    };

    return {
      ...entry,
      durationSec: actualTrimmedSec,
      transcript: entry.transcript
        ? { ...entry.transcript, segments: shiftedSegs, updatedAt: trimmedAt }
        : undefined,
      sourceTrim,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    err(`[smart-trim] FAILED ${fid}: ${errMsg}`);
    try {
      await fs.unlink(trimmedPath);
    } catch {
      /* ignore */
    }

    return {
      ...entry,
      sourceTrim: {
        startSec,
        endSec,
        originalDurationSec,
        trimmedAt,
        status: "trim_failed",
        source,
        position,
        ...(fallbackReason !== undefined ? { fallbackReason } : {}),
      } satisfies SourceTrim,
    };
  }
}

// =========================================================
// runSmartTrim
// =========================================================

export async function runSmartTrim(manifestPath: string, opts: CliOpts): Promise<void> {
  const absManifestPath = path.resolve(manifestPath);
  const contentDir = path.dirname(absManifestPath);

  // 1. 加载 manifest
  const raw = await fs.readFile(absManifestPath, "utf-8");
  const manifest = batchManifestSchema.parse(JSON.parse(raw));

  // 2. 加载 selection（可选）
  let selection: Selection | null = null;
  if (opts.selectionPath) {
    try {
      const selRaw = await fs.readFile(opts.selectionPath, "utf-8");
      selection = selectionSchema.parse(JSON.parse(selRaw));
      err(
        `[smart-trim] selection loaded: ${opts.selectionPath} (${selection.order.length} in order, ${selection.excluded.length} excluded)`,
      );
    } catch (e) {
      err(
        `[smart-trim] WARN failed to load selection: ${(e as Error).message}; all clips = middle`,
      );
    }
  }

  // 3. 深拷贝得到 working copy
  const workingManifest: BatchManifest = JSON.parse(JSON.stringify(manifest));

  // 4. 过滤出 video entries
  const videoEntries = workingManifest.files.filter(
    (f): f is ManifestVideoEntry => f.type === "video" && f.ok,
  );

  // 5. dry-run 模式：输出预计行为（由 processEntry 内部处理，此处只汇总）
  if (opts.dryRun) {
    const counts = { first_skip: 0, passthrough: 0, would_qwen: 0 };

    for (const entry of videoEntries) {
      const fid = path.basename(entry.filePath, path.extname(entry.filePath));
      const position = inferPosition(fid, selection);
      const softMax =
        position === "closing"
          ? opts.closingHardMax
          : softMaxForPosition(position, opts.maxClipSec);

      if (position === "first") {
        counts.first_skip++;
        err(`[smart-trim] dry-run: fid=${fid} pos=first action=first_skip`);
      } else if (position !== "closing" && entry.durationSec <= softMax) {
        // closing 不 passthrough（总调 Qwen）
        counts.passthrough++;
        err(
          `[smart-trim] dry-run: fid=${fid} pos=${position} action=passthrough dur=${entry.durationSec.toFixed(1)}s`,
        );
      } else {
        counts.would_qwen++;
        err(
          `[smart-trim] dry-run: fid=${fid} pos=${position} action=would_call_qwen dur=${entry.durationSec.toFixed(1)}s softMax=${softMax}`,
        );
      }
    }

    err(
      `[smart-trim] dry-run summary: first_skip=${counts.first_skip} passthrough=${counts.passthrough} would_qwen=${counts.would_qwen}`,
    );
    return;
  }

  // 6. 并发处理所有 video entries
  const total = videoEntries.length;
  let processed = 0;

  type TrimResult = { fid: string; updated: ManifestVideoEntry };
  const limit = pLimit<TrimResult>(opts.concurrency);

  const promises = videoEntries.map((entry) =>
    limit(async (): Promise<TrimResult> => {
      const updated = await processEntry(entry, contentDir, opts, selection);
      processed++;
      err(`[smart-trim] ${processed}/${total} files processed`);
      return { fid: path.basename(entry.filePath), updated };
    }),
  );

  const results = await Promise.all(promises);

  // 7. 把更新后的 entries 写回 working manifest
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

  // 8. 原子写 manifest
  const tmpPath = `${absManifestPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(workingManifest, null, 2), "utf-8");
  await fs.rename(tmpPath, absManifestPath);

  err(`[smart-trim] manifest written: ${absManifestPath}`);

  // 9. 汇总日志
  const summary = {
    qwen: 0,
    qwen_cache: 0,
    fallback: 0,
    passthrough: 0,
    first_skip: 0,
    trim_failed: 0,
  };
  for (const r of results) {
    const st = r.updated.sourceTrim;
    if (!st) continue;
    if (st.status === "trim_failed") {
      summary.trim_failed++;
      continue;
    }
    if (st.source === "qwen") summary.qwen++;
    else if (st.source === "qwen_cache") summary.qwen_cache++;
    else if (st.source === "fallback") summary.fallback++;
    else if (st.source === "passthrough") summary.passthrough++;
    else if (st.source === "first_skip") summary.first_skip++;
  }
  err(
    `[smart-trim] DONE qwen=${summary.qwen} qwen_cache=${summary.qwen_cache} fallback=${summary.fallback} passthrough=${summary.passthrough} first_skip=${summary.first_skip} trim_failed=${summary.trim_failed}`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.manifestPath) {
    err(
      "用法: tsx src/cli/vlog-smart-trim.ts <manifestPath> [--max-clip-sec <N>] [--force] [--concurrency <N>] [--dry-run] [--selection <path>] [--prompt-version <v>] [--closing-hard-max <sec>] [--qwen-timeout-ms <ms>]",
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

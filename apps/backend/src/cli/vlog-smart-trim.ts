/**
 * vlog-smart-trim — Claude 决策器 + ffmpeg 执行器
 *
 * 用法:
 *   pnpm --filter @relight/backend exec tsx src/cli/vlog-smart-trim.ts <manifestPath>
 *       --decisions <decisionsPath>
 *       [--max-clip-sec <N>] [--force] [--concurrency <N>] [--dry-run]
 *       [--selection <path>] [--closing-hard-max <sec>]
 *
 * 输入:
 *   - <manifestPath>：vlog manifest.json
 *   - <decisionsPath>：Claude 决策器（在 vlog-production skill 中）生成的 decisions.json
 *
 * 输出:
 *   - <contentDir>/sources-trimmed/<fid>.mp4（精华段视频）
 *   - manifest.json 更新（原子写）：durationSec + transcript.segments + sourceTrim 字段
 *
 * 决策树（per clip）：
 *   position=first → skipped (no ffmpeg, source="first_skip")
 *   decision.skip=true → skipped (no ffmpeg, source="claude")
 *   decisions.json 有此 fid → 用决策 + ffmpeg + source="claude"
 *   decisions.json 缺此 fid 且 duration ≤ softMax → passthrough (encode-only, source="passthrough")
 *   decisions.json 缺此 fid 且需要切 → smartTrimWindow + ffmpeg + source="algo_fallback"
 */
import fs from "node:fs/promises";
import path from "node:path";
import { extractClip, probeVideo } from "../lib/video/ffmpeg";
import {
  CLOSING_HARD_MAX_SEC,
  type SmartTrimPosition,
  inferPosition,
  shiftSegments,
  smartTrimWindow,
  softMaxForPosition,
  splitSegmentByWordGap,
} from "./vlog/lib/smart-trim";
import { err, pLimit } from "./vlog/lib/util";
import type {
  BatchManifest,
  ManifestVideoEntry,
  Selection,
  SourceTrim,
  TrimDecisionEntry,
  TrimDecisionsFile,
} from "./vlog/types";
import { batchManifestSchema, selectionSchema, trimDecisionsFileSchema } from "./vlog/types";

// =========================================================
// CLI interface
// =========================================================

interface CliOpts {
  manifestPath: string | null;
  decisionsPath: string | null;
  maxClipSec: number;
  force: boolean;
  concurrency: number;
  dryRun: boolean;
  selectionPath: string | null;
  closingHardMax: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    manifestPath: null,
    decisionsPath: null,
    maxClipSec: 120,
    force: false,
    concurrency: 2,
    dryRun: false,
    selectionPath: null,
    closingHardMax: CLOSING_HARD_MAX_SEC,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--decisions") {
      opts.decisionsPath = argv[++i] ?? null;
    } else if (a === "--max-clip-sec") {
      opts.maxClipSec = Number(argv[++i]);
    } else if (a === "--force") {
      opts.force = true;
    } else if (a === "--concurrency") {
      opts.concurrency = Number(argv[++i]);
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--selection") {
      opts.selectionPath = argv[++i] ?? null;
    } else if (a === "--closing-hard-max") {
      opts.closingHardMax = Number(argv[++i]);
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

interface ResolvedDecision {
  startSec: number;
  endSec: number;
  source: "claude" | "algo_fallback";
  reason?: string;
  confidence?: number;
  fallbackReason?: SourceTrim["fallbackReason"];
}

/** 解析 per-clip 决策来源：先看 decisions.json，缺失时走 smartTrimWindow */
function resolveDecision(
  fid: string,
  entry: ManifestVideoEntry,
  position: SmartTrimPosition,
  decisions: Map<string, TrimDecisionEntry> | null,
  splitSegs: ReturnType<typeof splitSegmentByWordGap>,
  opts: CliOpts,
): ResolvedDecision | { skip: true; reason?: string; confidence?: number } {
  const d = decisions?.get(fid);
  if (d) {
    if (d.skip === true) return { skip: true, reason: d.reason, confidence: d.confidence };
    return {
      startSec: d.startSec,
      endSec: d.endSec,
      source: "claude",
      reason: d.reason,
      confidence: d.confidence,
    };
  }
  // 算法 fallback：closing 用 closingHardMax，否则用 maxClipSec
  const fallbackMax = position === "closing" ? opts.closingHardMax : opts.maxClipSec;
  const win = smartTrimWindow(entry.durationSec, splitSegs, fallbackMax);
  return {
    startSec: win.startSec,
    endSec: win.endSec,
    source: "algo_fallback",
    fallbackReason: "missing_in_decisions",
  };
}

async function processEntry(
  entry: ManifestVideoEntry,
  contentDir: string,
  opts: CliOpts,
  selection: Selection | null,
  decisions: Map<string, TrimDecisionEntry> | null,
): Promise<ManifestVideoEntry> {
  const fid = path.basename(entry.filePath, path.extname(entry.filePath));
  const baseName = path.basename(entry.filePath);
  const trimmedDir = path.join(contentDir, "sources-trimmed");
  const trimmedPath = path.join(trimmedDir, `${fid}.mp4`);
  const sourcePath = path.join(contentDir, "sources", baseName);

  // 1. 推断 position
  const position = inferPosition(fid, selection);
  const softMax =
    position === "closing" ? opts.closingHardMax : softMaxForPosition(position, opts.maxClipSec);

  // 2. dry-run: 输出预计行为
  if (opts.dryRun) {
    if (position === "first") {
      err(`[smart-trim] dry-run: fid=${fid} pos=first action=first_skip`);
      return entry;
    }
    const decision = decisions?.get(fid);
    if (decision?.skip === true) {
      err(`[smart-trim] dry-run: fid=${fid} pos=${position} action=claude_skip`);
    } else if (decision) {
      const trimDur = (decision.endSec - decision.startSec).toFixed(1);
      err(
        `[smart-trim] dry-run: fid=${fid} pos=${position} action=claude dur=${entry.durationSec.toFixed(1)}→${trimDur}`,
      );
    } else if (position !== "closing" && entry.durationSec <= softMax) {
      err(
        `[smart-trim] dry-run: fid=${fid} pos=${position} action=passthrough dur=${entry.durationSec.toFixed(1)}`,
      );
    } else {
      err(
        `[smart-trim] dry-run: fid=${fid} pos=${position} action=algo_fallback dur=${entry.durationSec.toFixed(1)} softMax=${softMax}`,
      );
    }
    return entry;
  }

  // 3. first 段：永远 skip，不调 ffmpeg
  if (position === "first") {
    err(
      `[smart-trim] fid=${fid} pos=first source=first_skip dur=${entry.durationSec.toFixed(1)}→skip`,
    );
    return {
      ...entry,
      sourceTrim: {
        startSec: 0,
        endSec: entry.durationSec,
        originalDurationSec: entry.durationSec,
        status: "skipped",
        source: "first_skip",
        position: "first",
      } satisfies SourceTrim,
    };
  }

  const originalDurationSec = entry.durationSec;
  const trimmedAt = new Date().toISOString();
  const rawSegs = entry.transcript?.segments ?? [];
  const splitSegs = splitSegmentByWordGap(rawSegs, 1.5);

  // 4. 决策来源
  const resolved = resolveDecision(fid, entry, position, decisions, splitSegs, opts);

  // 4a. claude 显式 skip
  if ("skip" in resolved && resolved.skip) {
    err(`[smart-trim] fid=${fid} pos=${position} source=claude action=skip`);
    return {
      ...entry,
      sourceTrim: {
        startSec: 0,
        endSec: entry.durationSec,
        originalDurationSec,
        trimmedAt,
        status: "skipped",
        source: "claude",
        position,
        ...(resolved.reason !== undefined ? { reason: resolved.reason } : {}),
        ...(resolved.confidence !== undefined ? { confidence: resolved.confidence } : {}),
      } satisfies SourceTrim,
    };
  }

  // 4b. middle 段且没有 claude 决策且时长 ≤ softMax → passthrough
  const hasDecision = decisions?.has(fid) === true;
  if (!hasDecision && position !== "closing" && entry.durationSec <= softMax) {
    await fs.mkdir(trimmedDir, { recursive: true });
    try {
      await extractClip(sourcePath, 0, entry.durationSec, trimmedPath);
      err(
        `[smart-trim] fid=${fid} pos=${position} source=passthrough dur=${entry.durationSec.toFixed(1)}`,
      );
      return {
        ...entry,
        sourceTrim: {
          startSec: 0,
          endSec: entry.durationSec,
          originalDurationSec,
          trimmedAt,
          status: "ok",
          source: "passthrough",
          position,
        } satisfies SourceTrim,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      err(`[smart-trim] FAILED ${fid} (passthrough): ${errMsg}`);
      return {
        ...entry,
        sourceTrim: {
          startSec: 0,
          endSec: entry.durationSec,
          originalDurationSec,
          trimmedAt,
          status: "trim_failed",
          source: "passthrough",
          position,
        } satisfies SourceTrim,
      };
    }
  }

  // 5. 切片：来自 claude 决策 或 algo_fallback
  const { startSec, endSec, source, reason, confidence, fallbackReason } =
    resolved as ResolvedDecision;
  await fs.mkdir(trimmedDir, { recursive: true });

  try {
    await extractClip(sourcePath, startSec, endSec, trimmedPath);
    const probe = await probeVideo(trimmedPath);
    const actualTrimmedSec = probe.durationSec;
    const shiftedSegs = shiftSegments(splitSegs, startSec, actualTrimmedSec);

    err(
      `[smart-trim] fid=${fid} pos=${position} source=${source} dur=${originalDurationSec.toFixed(1)}→${actualTrimmedSec.toFixed(1)}`,
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
      ...(confidence !== undefined ? { confidence } : {}),
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

  // 3. 加载 decisions.json（可选）
  let decisions: Map<string, TrimDecisionEntry> | null = null;
  let decisionsMeta: { generatedAt?: string; generatedBy?: string; totalBudgetSec?: number } = {};
  if (opts.decisionsPath) {
    const decRaw = await fs.readFile(opts.decisionsPath, "utf-8");
    const decFile: TrimDecisionsFile = trimDecisionsFileSchema.parse(JSON.parse(decRaw));
    decisions = new Map(Object.entries(decFile.decisions));
    decisionsMeta = {
      generatedAt: decFile.generatedAt,
      generatedBy: decFile.generatedBy,
      totalBudgetSec: decFile.totalBudgetSec,
    };
    err(
      `[smart-trim] decisions loaded: ${opts.decisionsPath} (${decisions.size} entries, generatedBy=${decisionsMeta.generatedBy ?? "?"}, totalBudgetSec=${decisionsMeta.totalBudgetSec ?? "?"})`,
    );
  } else {
    err(
      "[smart-trim] WARN no --decisions provided; missing clips will fall back to smartTrimWindow algorithm",
    );
  }

  // 4. 深拷贝得到 working copy
  const workingManifest: BatchManifest = JSON.parse(JSON.stringify(manifest));

  // 5. 过滤出 video entries
  const videoEntries = workingManifest.files.filter(
    (f): f is ManifestVideoEntry => f.type === "video" && f.ok,
  );

  // 6. dry-run 模式：输出预计行为（由 processEntry 内部处理）
  if (opts.dryRun) {
    for (const entry of videoEntries) {
      await processEntry(entry, contentDir, opts, selection, decisions);
    }
    err("[smart-trim] dry-run done");
    return;
  }

  // 6. 并发处理所有 video entries
  const total = videoEntries.length;
  let processed = 0;

  type TrimResult = { fid: string; updated: ManifestVideoEntry };
  const limit = pLimit<TrimResult>(opts.concurrency);

  const promises = videoEntries.map((entry) =>
    limit(async (): Promise<TrimResult> => {
      const updated = await processEntry(entry, contentDir, opts, selection, decisions);
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
    claude: 0,
    algo_fallback: 0,
    passthrough: 0,
    first_skip: 0,
    claude_skip: 0,
    trim_failed: 0,
  };
  for (const r of results) {
    const st = r.updated.sourceTrim;
    if (!st) continue;
    if (st.status === "trim_failed") {
      summary.trim_failed++;
      continue;
    }
    if (st.status === "skipped" && st.source === "claude") summary.claude_skip++;
    else if (st.source === "claude") summary.claude++;
    else if (st.source === "algo_fallback") summary.algo_fallback++;
    else if (st.source === "passthrough") summary.passthrough++;
    else if (st.source === "first_skip") summary.first_skip++;
  }
  err(
    `[smart-trim] DONE claude=${summary.claude} algo_fallback=${summary.algo_fallback} passthrough=${summary.passthrough} first_skip=${summary.first_skip} claude_skip=${summary.claude_skip} trim_failed=${summary.trim_failed}`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.manifestPath) {
    err(
      "用法: tsx src/cli/vlog-smart-trim.ts <manifestPath> --decisions <decisionsPath> [--max-clip-sec <N>] [--force] [--concurrency <N>] [--dry-run] [--selection <path>] [--closing-hard-max <sec>]",
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

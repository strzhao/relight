/**
 * vlog-smart-trim — Qwen 主导决策（默认）+ Claude override（--decisions）+ ffmpeg 执行器
 *
 * 用法:
 *   pnpm --filter @relight/backend exec tsx src/cli/vlog-smart-trim.ts <manifestPath>
 *       [--decisions <decisionsPath>]
 *       [--max-clip-sec <N>] [--force] [--concurrency <N>] [--dry-run]
 *       [--selection <path>] [--closing-hard-max <sec>] [--qwen-timeout-ms <ms>]
 *
 * 输入:
 *   - <manifestPath>：vlog manifest.json
 *   - <decisionsPath>（可选）：Claude 决策器生成的 decisions.json；有此文件时 Claude 优先
 *
 * 输出:
 *   - <contentDir>/sources-trimmed/<fid>.mp4（精华段视频）
 *   - manifest.json 更新（原子写）：durationSec + transcript.segments + sourceTrim 字段
 *
 * 决策树（per clip）：
 *   position=first            → skipped (no ffmpeg, source="first_skip")
 *   decision.skip=true        → skipped (no ffmpeg, source="claude")
 *   decisions.json 有此 fid   → 用 Claude 决策 + ffmpeg + source="claude"
 *   缺 decision + dur > softMax → trimClipAI(Qwen) + ffmpeg + source="qwen"/"qwen_cache"
 *   trimClipAI 失败            → smartTrimWindow fallback + ffmpeg + source="algo_fallback"
 *   缺 decision + dur ≤ softMax → passthrough (encode-only, source="passthrough")
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
import { trimClipAI } from "./vlog/lib/smart-trim-ai";
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
  qwenTimeoutMs: number;
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
    qwenTimeoutMs: 30000,
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

interface ResolvedDecision {
  startSec: number;
  endSec: number;
  source: SourceTrim["source"];
  reason?: string;
  confidence?: number;
  capped?: boolean;
  cappedFrom?: number;
  fallbackReason?: SourceTrim["fallbackReason"];
}

/** Claude override 路径：只在 decisions.json 有此 fid 时调用 */
function resolveClaudeDecision(
  fid: string,
  decisions: Map<string, TrimDecisionEntry> | null,
): ResolvedDecision | { skip: true; reason?: string; confidence?: number } | null {
  const d = decisions?.get(fid);
  if (!d) return null;
  if (d.skip === true) return { skip: true, reason: d.reason, confidence: d.confidence };
  return {
    startSec: d.startSec,
    endSec: d.endSec,
    source: "claude",
    reason: d.reason,
    confidence: d.confidence,
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
        `[smart-trim] dry-run: fid=${fid} pos=${position} action=qwen dur=${entry.durationSec.toFixed(1)} softMax=${softMax}`,
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

  // 4. Claude override：decisions.json 有此 fid → Claude 路径
  const claudeResolved = resolveClaudeDecision(fid, decisions);

  // 4a. claude 显式 skip
  if (claudeResolved && "skip" in claudeResolved && claudeResolved.skip) {
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
        ...(claudeResolved.reason !== undefined ? { reason: claudeResolved.reason } : {}),
        ...(claudeResolved.confidence !== undefined
          ? { confidence: claudeResolved.confidence }
          : {}),
      } satisfies SourceTrim,
    };
  }

  // 4b. passthrough：middle + 无 Claude 决策 + dur ≤ softMax（closing 不走此路）
  const hasClaudeDecision = claudeResolved !== null;
  if (!hasClaudeDecision && position !== "closing" && entry.durationSec <= softMax) {
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

  // 5. 决策来源：Claude override 或 Qwen（默认）
  let resolved: ResolvedDecision;
  if (claudeResolved && !("skip" in claudeResolved)) {
    // 5a. Claude 决策（decisions.json hit）
    resolved = claudeResolved;
  } else {
    // 5b. Qwen 路径（默认）：trimClipAI 负责 passthrough / qwen / qwen_cache / fallback
    const aiResult = await trimClipAI(entry, position, {
      maxClipSec: opts.maxClipSec,
      closingHardMaxSec: opts.closingHardMax,
      qwenTimeoutMs: opts.qwenTimeoutMs,
    });

    // trimClipAI 内部已处理 passthrough/first_skip（这里不会到达 first/passthrough，
    // 因为上面已经处理了 first + passthrough 路径，但 trimClipAI 也会正确处理）
    resolved = {
      startSec: aiResult.startSec,
      endSec: aiResult.endSec,
      source: aiResult.source,
      reason: aiResult.reason,
      capped: aiResult.capped,
      cappedFrom: aiResult.cappedFrom,
      fallbackReason: aiResult.fallbackReason,
    };
  }

  // 6. ffmpeg 切片
  const { startSec, endSec, source, reason, confidence, capped, cappedFrom, fallbackReason } =
    resolved;
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
      "[smart-trim] no --decisions provided; clips without Claude override will use Qwen (trimClipAI) as default path",
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
    qwen: 0,
    qwen_cache: 0,
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
    else if (st.source === "qwen") summary.qwen++;
    else if (st.source === "qwen_cache") summary.qwen_cache++;
    else if (st.source === "algo_fallback") summary.algo_fallback++;
    else if (st.source === "passthrough") summary.passthrough++;
    else if (st.source === "first_skip") summary.first_skip++;
  }
  err(
    `[smart-trim] DONE claude=${summary.claude} qwen=${summary.qwen} qwen_cache=${summary.qwen_cache} algo_fallback=${summary.algo_fallback} passthrough=${summary.passthrough} first_skip=${summary.first_skip} claude_skip=${summary.claude_skip} trim_failed=${summary.trim_failed}`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.manifestPath) {
    err(
      "用法: tsx src/cli/vlog-smart-trim.ts <manifestPath> [--decisions <decisionsPath>] [--max-clip-sec <N>] [--force] [--concurrency <N>] [--dry-run] [--selection <path>] [--closing-hard-max <sec>] [--qwen-timeout-ms <ms>]",
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

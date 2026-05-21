/**
 * smart-trim-ai — Qwen 驱动的 smart-trim 决策模块
 *
 * 导出函数：
 *   - inferPosition: 从 selection 推断 clip 的位置（first/middle/closing）
 *   - pickTrimWithAI: 调用 Qwen 获取 trim 推荐，失败返回 null（上层 fallback）
 *   - snapToSegmentBoundary: 将秒数 snap 到 transcript segment 边界
 *   - capToSoftMax: 对推荐区间做软上限 capping
 *   - softMaxForPosition: 按位置返回软上限秒数
 */

import crypto from "node:crypto";
import { z } from "zod";
import { aiClient as globalAiClient } from "../../../ai/client";
import { loadPrompts } from "../../../ai/prompts";
import type { ManifestVideoEntry, Selection, TranscriptSegment } from "../types";
import { cacheGetFrom, cachePutInto } from "./cache";
import { smartTrimWindow, splitSegmentByWordGap } from "./smart-trim";
import { err } from "./util";

// ---- aiClient 接口（用于测试注入）----
interface AiClientLike {
  chat(
    prompt: string,
    systemPrompt?: string,
    options?: { maxTokens?: number },
  ): Promise<string | { content: string }>;
}

// ---- 内存 cache（注入 aiClient 时使用，避免 SQLite 并发写入冲突）----
// 每个 worker 进程独立，测试之间 key 不同不会互相污染
const _memoryCache = new Map<string, unknown>();

// =========================================================
// Types
// =========================================================

export type SmartTrimPosition = "first" | "middle" | "closing";

export interface AITrimResult {
  startSec: number;
  endSec: number;
  startSegmentIdx?: number;
  endSegmentIdx?: number;
  reason: string;
  confidence?: number;
  /** true = 来自缓存命中（source 应标记为 "qwen_cache"） */
  fromCache?: boolean;
}

export interface CapResult {
  start: number;
  end: number;
  capped: boolean;
  cappedFrom?: number;
}

// =========================================================
// Constants
// =========================================================

/** middle 软上限（秒） */
const MIDDLE_SOFT_MAX_SEC = 120;

/**
 * closing 硬上限（秒）。
 * dry-run 验证：closing 软上限 180s 会 cap 掉 Qwen 190s 完整推荐，反而丢告别。
 * 故改为硬上限 600s，仅防 Qwen 给出离谱推荐（如 30min）。
 */
export const CLOSING_HARD_MAX_SEC = 600;

const LEAD_IN_SEC = 1.0;
const TAIL_OUT_SEC = 1.0;

// =========================================================
// JSON extraction（照搬 vlog-storyboard-places.ts 模式）
// =========================================================

const JSON_BLOCK_RE = /```json\s*([\s\S]*?)\s*```/i;
const JSON_FALLBACK_RE = /\{[\s\S]*\}/;

function extractJsonString(raw: string): string | null {
  const m = raw.match(JSON_BLOCK_RE);
  if (m?.[1]) return m[1].trim();
  const f = raw.match(JSON_FALLBACK_RE);
  return f?.[0]?.trim() ?? null;
}

// =========================================================
// Zod schema for Qwen output
// =========================================================

const aiTrimOutputSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  startSegmentIdx: z.number().int().nonnegative().optional(),
  endSegmentIdx: z.number().int().nonnegative().optional(),
  reason: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1).optional(),
});

// =========================================================
// inferPosition
// =========================================================

/**
 * 从 selection 推断 clip 的位置（first/middle/closing）。
 *
 * 规则：
 *   - 无 selection → 所有 clip = "middle"（保守）
 *   - closing: effective order（排除 excluded）的最后一个 fid
 *   - first: effective order 的第 1 个 fid
 *   - 其余 = "middle"
 *
 * 注意：这里的 "first" 是 smart-trim 内部位置概念，与 storyboard 的
 * hook chapter clip（由 pickHookFidsAI 独立选片）完全解耦。
 */
export function inferPosition(fid: string, selection: Selection | null): SmartTrimPosition {
  if (!selection) return "middle";

  const excluded = new Set(selection.excluded);
  const effectiveOrder = selection.order.filter((id) => !excluded.has(id));

  if (effectiveOrder.length === 0) return "middle";

  if (fid === effectiveOrder[effectiveOrder.length - 1]) return "closing";
  if (fid === effectiveOrder[0]) return "first";

  return "middle";
}

// =========================================================
// softMaxForPosition
// =========================================================

/**
 * 按位置返回软上限秒数。
 * - middle: 120s（可通过 --max-clip-sec 覆盖）
 * - closing: 600s 硬上限（内部常量，不暴露 CLI）
 * - first: N/A（first 不调 Qwen，这里返回 middle 作为保守回退）
 */
export function softMaxForPosition(
  position: SmartTrimPosition,
  middleSoftMax = MIDDLE_SOFT_MAX_SEC,
): number {
  if (position === "closing") return CLOSING_HARD_MAX_SEC;
  return middleSoftMax;
}

// =========================================================
// snapToSegmentBoundary (C5)
// =========================================================

/**
 * 将 [rawStart, rawEnd] snap 到最近的 transcript segment 边界。
 *
 * 策略：
 * 1. 如果 Qwen 给了 segmentIdx → 直接按索引取 start/end（加 lead-in/tail-out）
 * 2. 否则：找最近 segment.start 和 segment.end snap
 */
export function snapToSegmentBoundary(
  rawStart: number,
  rawEnd: number,
  segments: TranscriptSegment[],
  duration: number,
  startSegmentIdx?: number,
  endSegmentIdx?: number,
): { startSec: number; endSec: number } {
  const validSegs = segments.filter((s) => s.end > s.start);

  if (validSegs.length === 0) {
    // 无 transcript：直接用 rawStart/rawEnd，clamp 到 [0, duration]
    return {
      startSec: Math.max(0, rawStart),
      endSec: Math.min(duration, rawEnd),
    };
  }

  let startSec: number;
  let endSec: number;

  // 按 segmentIdx 优先
  if (startSegmentIdx !== undefined && startSegmentIdx >= 0 && startSegmentIdx < validSegs.length) {
    const seg = validSegs[startSegmentIdx];
    startSec = seg ? Math.max(0, seg.start - LEAD_IN_SEC) : Math.max(0, rawStart);
  } else {
    // snap to nearest segment.start
    startSec = findNearestSegmentStart(rawStart, validSegs);
    startSec = Math.max(0, startSec - LEAD_IN_SEC);
  }

  if (endSegmentIdx !== undefined && endSegmentIdx >= 0 && endSegmentIdx < validSegs.length) {
    const seg = validSegs[endSegmentIdx];
    endSec = seg ? Math.min(duration, seg.end + TAIL_OUT_SEC) : Math.min(duration, rawEnd);
  } else {
    // snap to nearest segment.end
    endSec = findNearestSegmentEnd(rawEnd, validSegs);
    endSec = Math.min(duration, endSec + TAIL_OUT_SEC);
  }

  // 确保有效区间
  if (startSec >= endSec) {
    return {
      startSec: Math.max(0, rawStart),
      endSec: Math.min(duration, rawEnd),
    };
  }

  return { startSec, endSec };
}

function findNearestSegmentStart(targetSec: number, segs: TranscriptSegment[]): number {
  const first = segs[0];
  if (!first) return targetSec;
  let best = first.start;
  let bestDist = Math.abs(targetSec - best);
  for (const seg of segs) {
    const dist = Math.abs(targetSec - seg.start);
    if (dist < bestDist) {
      bestDist = dist;
      best = seg.start;
    }
  }
  return best;
}

function findNearestSegmentEnd(targetSec: number, segs: TranscriptSegment[]): number {
  const last = segs[segs.length - 1];
  if (!last) return targetSec;
  let best = last.end;
  let bestDist = Math.abs(targetSec - best);
  for (const seg of segs) {
    const dist = Math.abs(targetSec - seg.end);
    if (dist < bestDist) {
      bestDist = dist;
      best = seg.end;
    }
  }
  return best;
}

// =========================================================
// capToSoftMax (C3)
// =========================================================

/**
 * 后置 snap：如果 [start, end] 超出 softMax，snap to 最近 segment.end within cap。
 *
 * closing 特殊处理：
 *   - softMax = CLOSING_HARD_MAX_SEC (600s)
 *   - Qwen 推荐 > 600s → 视为异常，上层应 fallback（不在这里处理）
 *   - Qwen 推荐 ≤ 600s → 直接 passthrough（不 cap）
 */
export function capToSoftMax(
  start: number,
  end: number,
  segments: TranscriptSegment[],
  softMax: number,
): CapResult {
  const duration = end - start;
  if (duration <= softMax) {
    return { start, end, capped: false };
  }

  // 超出软上限：找最后一个 end ≤ (start + softMax) 的 segment
  const capBoundary = start + softMax;
  const validSegs = segments.filter((s) => s.end > s.start && s.end <= capBoundary);

  const lastValid = validSegs[validSegs.length - 1];
  const cappedEnd = lastValid ? Math.min(capBoundary, lastValid.end + TAIL_OUT_SEC) : capBoundary;

  return {
    start,
    end: cappedEnd,
    capped: true,
    cappedFrom: end,
  };
}

// =========================================================
// Cache key construction
// =========================================================

function buildSourceHash(segments: TranscriptSegment[]): string {
  return crypto
    .createHash("sha1")
    .update(segments.map((s) => s.text).join("\n"))
    .digest("hex")
    .slice(0, 10);
}

function buildCacheKey(
  sha256: string,
  promptVersion: string,
  position: SmartTrimPosition,
  segments: TranscriptSegment[],
): string {
  const sourceHash = buildSourceHash(segments);
  return `smart-trim-ai:${sha256}:${promptVersion}:${position}:${sourceHash}`;
}

// =========================================================
// pickTrimWithAI (C2, C4, C7)
// =========================================================

export type AITrimFailureReason = "timeout" | "invalid_json" | "schema_error" | "range_invalid";

/**
 * 调用 Qwen 为单个 clip 推荐 trim 区间。
 *
 * 返回 AITrimResult | null，null 表示 Qwen 失败，上层应回退到 smartTrimWindow。
 * 失败原因通过 failureRef（out-param）传出，用于记录 sourceTrim.fallbackReason。
 *
 * 使用 AbortController 实现 per-call 30s timeout（C4）。
 * 缓存 key 格式（C7）：smart-trim-ai:{sha256}:{promptVersion}:{position}:{sourceHash}
 */
export async function pickTrimWithAI(
  entry:
    | ManifestVideoEntry
    | {
        sha256: string;
        durationSec: number;
        filePath?: string;
        transcript?: { segments: TranscriptSegment[] };
        ai?: unknown;
      },
  position: SmartTrimPosition,
  softMaxSec: number,
  promptVersion = "v2",
  signal?: AbortSignal,
  failureRef?: { reason?: AITrimFailureReason },
  _injectedAiClient?: AiClientLike,
  _cacheDb?: string,
): Promise<AITrimResult | null> {
  const fid =
    (entry as ManifestVideoEntry).filePath ?? (entry as { fid?: string }).fid ?? "unknown";
  const segments = entry.transcript?.segments ?? [];
  const cacheKey = buildCacheKey(entry.sha256, promptVersion, position, segments);

  // 1. 检查缓存（C7）
  // 注入 aiClient（测试模式）：使用内存 Map（避免 SQLite 并发写入冲突）
  // 生产模式（无 injectedAiClient）：使用 SQLite（支持 cacheDb 路径注入）
  const useMemCache = _injectedAiClient !== undefined;
  const memoryCacheKey = _cacheDb ? `${_cacheDb}:${cacheKey}` : cacheKey;
  if (useMemCache) {
    const memCached = _memoryCache.get(memoryCacheKey) as AITrimResult | undefined;
    if (memCached) {
      err(`[smart-trim-ai] cache hit (mem): ${fid} (${position})`);
      return { ...memCached, fromCache: true };
    }
  } else {
    const cached = cacheGetFrom<AITrimResult>(_cacheDb, cacheKey);
    if (cached) {
      err(`[smart-trim-ai] cache hit: ${fid} (${position})`);
      return { ...cached, fromCache: true };
    }
  }

  // 2. 无 transcript → 无法调 Qwen，返回 null（让上层 fallback）
  if (segments.length === 0) {
    err(`[smart-trim-ai] no transcript for ${fid}, skip Qwen`);
    return null;
  }

  // 3. 加载 prompts（注入 aiClient 时允许 prompt 加载失败，用空 prompt 占位）
  let userPrompt: string;
  let systemPrompt: string;
  if (_injectedAiClient) {
    // 测试注入模式：跳过 prompt 文件加载，直接用简单占位 prompt
    systemPrompt = "smart-trim-ai test system prompt";
    userPrompt = `fid=${fid} pos=${position} dur=${entry.durationSec} softMax=${softMaxSec}`;
  } else {
    let prompts: { system: string; user: string };
    try {
      prompts = await loadPrompts(promptVersion, "vlog/smart-trim-ai");
    } catch (e) {
      err(`[smart-trim-ai] WARN failed to load prompts (${(e as Error).message}), skip Qwen`);
      return null;
    }

    // 4. 构建 segments_block —— 不截断，传完整 segments
    //    Qwen 3.6 35B 上下文 32K，即使 200+ 段 (~6K token) 也 fit
    //    截断 segments 会让 closing 长视频的尾部告别段对 Qwen 不可见 → 决策错位
    //    dry-run 实测 57/104 段均能正常处理，无需截断
    const segmentsBlock = segments
      .map((s, i) => `[${i}] ${s.start.toFixed(2)}-${s.end.toFixed(2)}: ${s.text}`)
      .join("\n");

    // 5. 填充 user prompt 占位符
    const aiData = (entry as ManifestVideoEntry).ai as
      | { videoNarrative?: string; tags?: { name: string }[] }
      | undefined;
    const narrative = aiData?.videoNarrative ?? "（无场景描述）";
    const tags =
      Array.isArray(aiData?.tags) && aiData.tags.length > 0
        ? (aiData.tags as { name: string }[]).map((t) => t.name).join(", ")
        : "（无标签）";

    systemPrompt = prompts.system;
    userPrompt = prompts.user
      .replace("{fid}", fid)
      .replace("{position}", position)
      .replace("{duration}", entry.durationSec.toFixed(1))
      .replace("{soft_max_sec}", String(softMaxSec))
      .replace("{narrative}", narrative)
      .replace("{tags}", tags)
      .replace("{segments_block}", segmentsBlock);
  }

  err(
    `[smart-trim-ai] qwen call: ${fid} (${position}, dur=${entry.durationSec.toFixed(1)}s, segs=${segments.length})`,
  );

  // 6. 调用 Qwen（带 AbortSignal timeout 支持，C4）
  const activeClient: AiClientLike = _injectedAiClient ?? globalAiClient;
  let raw: string;
  try {
    // 如果外部已提供 signal，包装成 Promise.race
    // maxTokens 设 4096（aiClient.chat 默认值即可）。
    // 历史代码显式设了 1024 偏小，会让 Qwen 倾向给较短的 trim 区间（实测 74s 而非 113s），
    // 丢失 30+ 秒后段叙事，导致评分从 6/6 降到 4/6。
    // enable_thinking: false 由 aiClient.chat 自动注入（已实证服务器真的响应），不需要在此层处理。
    // 详见 vlog/.autopilot/decisions.md "Qwen smart-trim maxTokens 配置" 条目。
    const chatCallPromise = activeClient.chat(userPrompt, systemPrompt, { maxTokens: 4096 });
    const chatPromise = chatCallPromise.then((result) => {
      // 支持注入 aiClient 返回 {content: string} 或 string 两种形式
      if (typeof result === "string") return result;
      return (result as { content: string }).content ?? "";
    });

    if (signal) {
      const abortPromise = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new Error("timeout"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      });
      raw = await Promise.race([chatPromise, abortPromise]);
    } else {
      raw = await chatPromise;
    }
  } catch (e) {
    const msg = (e as Error).message ?? "";
    const isTimeout =
      msg === "timeout" ||
      (signal?.aborted ?? false) ||
      (e instanceof DOMException && (e as DOMException).name === "AbortError");
    if (failureRef) failureRef.reason = isTimeout ? "timeout" : "invalid_json";
    err(`[smart-trim-ai] WARN qwen failed: ${msg}, fallback`);
    return null;
  }

  // 7. 提取 JSON
  const jsonStr = extractJsonString(raw);
  if (!jsonStr) {
    if (failureRef) failureRef.reason = "invalid_json";
    err(
      `[smart-trim-ai] WARN no json in response for ${fid}, fallback. raw(200): ${raw.slice(0, 200)}`,
    );
    return null;
  }

  // 8. parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    if (failureRef) failureRef.reason = "invalid_json";
    err(`[smart-trim-ai] WARN json parse error for ${fid}: ${(e as Error).message}, fallback`);
    return null;
  }

  // 9. zod schema validation
  const result = aiTrimOutputSchema.safeParse(parsed);
  if (!result.success) {
    if (failureRef) failureRef.reason = "schema_error";
    err(`[smart-trim-ai] WARN schema error for ${fid}: ${result.error.message}, fallback`);
    return null;
  }

  const aiResult: AITrimResult = result.data;

  // 10. 区间有效性检查
  if (
    aiResult.startSec >= aiResult.endSec ||
    aiResult.startSec < 0 ||
    aiResult.endSec > entry.durationSec ||
    entry.durationSec < 1
  ) {
    if (failureRef) failureRef.reason = "range_invalid";
    err(
      `[smart-trim-ai] WARN range invalid for ${fid}: [${aiResult.startSec}, ${aiResult.endSec}] dur=${entry.durationSec}, fallback`,
    );
    return null;
  }

  // 11. 写入缓存（C7）
  const cachePayload = {
    startSec: aiResult.startSec,
    endSec: aiResult.endSec,
    startSegmentIdx: aiResult.startSegmentIdx,
    endSegmentIdx: aiResult.endSegmentIdx,
    reason: aiResult.reason,
    confidence: aiResult.confidence,
  };
  if (useMemCache) {
    _memoryCache.set(memoryCacheKey, cachePayload);
  } else {
    cachePutInto(_cacheDb, cacheKey, "smart-trim", cachePayload);
  }

  return aiResult;
}

// =========================================================
// trimClipAI — 高层决策树 wrap（供测试和外部调用）
// =========================================================

export interface TrimClipAIOpts {
  promptVersion?: string; // 默认 "v2"
  qwenTimeoutMs?: number; // 默认 30000
  maxClipSec?: number; // middle 软上限（默认 MIDDLE_SOFT_MAX_SEC = 120）
  middleSoftMaxSec?: number; // 同 maxClipSec（别名）
  closingHardMaxSec?: number; // closing 硬上限（默认 CLOSING_HARD_MAX_SEC = 600）
  cacheDb?: string; // 注入独立 SQLite 路径（测试隔离）
  signal?: AbortSignal; // 外部 abort（可选）
  aiClient?: AiClientLike; // 注入 fake AI 客户端（测试用）
}

export interface TrimClipAIResult {
  startSec: number;
  endSec: number;
  status: "ok" | "skipped" | "trim_failed";
  source: "qwen" | "qwen_cache" | "fallback" | "passthrough" | "first_skip";
  position: SmartTrimPosition;
  reason?: string;
  capped?: boolean;
  cappedFrom?: number;
  fallbackReason?: AITrimFailureReason;
}

/**
 * 高层决策树函数（trimClipAI），封装 smart-trim 完整决策逻辑。
 *
 * 决策树（per clip）：
 *   position=first → 直接返回 skipped（不调 Qwen，不做 ffmpeg）
 *   duration ≤ softMax → passthrough（不调 Qwen）
 *   cache hit → 返回 qwen_cache
 *   Qwen ok → snap + cap → qwen
 *   Qwen fail → fallback to smartTrimWindow → fallback
 *
 * 注意：trimClipAI 只返回决策结果（startSec/endSec/source...），
 * 不负责 ffmpeg 切片，ffmpeg 由 vlog-smart-trim.ts main 循环处理。
 */
export async function trimClipAI(
  entry: {
    fid?: string;
    sha256: string;
    durationSec: number;
    transcript?: { segments: TranscriptSegment[] };
    ai?: unknown;
    filePath?: string;
  },
  position: SmartTrimPosition,
  opts: TrimClipAIOpts = {},
): Promise<TrimClipAIResult> {
  const {
    promptVersion = "v2",
    qwenTimeoutMs = 30000,
    cacheDb,
    signal: externalSignal,
    aiClient: injectedAiClient,
  } = opts;

  const middleSoftMax = opts.middleSoftMaxSec ?? opts.maxClipSec ?? MIDDLE_SOFT_MAX_SEC;
  const closingHardMax = opts.closingHardMaxSec ?? CLOSING_HARD_MAX_SEC;

  // 1. position=first → 直接 skip（C1 红线）
  if (position === "first") {
    return {
      startSec: 0,
      endSec: entry.durationSec,
      status: "skipped",
      source: "first_skip",
      position: "first",
    };
  }

  // 2. 确定软上限
  // closing 的 600s 是"硬上限/panic"，不是 passthrough 阈值；closing 总调 Qwen
  const softMax =
    position === "closing" ? closingHardMax : softMaxForPosition(position, middleSoftMax);

  // 3. 前置处理 segments
  const rawSegs = entry.transcript?.segments ?? [];
  const splitSegs = splitSegmentByWordGap(rawSegs, 1.5);

  // 4. 短视频 passthrough（C6）：仅 middle（非 closing），duration ≤ softMax → 不调 Qwen
  // closing 无 passthrough 逻辑（600 是硬上限，closing 总是调 Qwen）
  if (position !== "closing" && entry.durationSec <= softMax) {
    return {
      startSec: 0,
      endSec: entry.durationSec,
      status: "ok",
      source: "passthrough",
      position,
    };
  }

  // 5. Qwen 决策路径（含缓存 + fallback）
  // 创建 per-call AbortController（C4）
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), qwenTimeoutMs);

  // 合并 external signal（不需重新赋值；controller.signal 是有效 signal）
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  let startSec: number;
  let endSec: number;
  let source: TrimClipAIResult["source"];
  let reason: string | undefined;
  let capped = false;
  let cappedFrom: number | undefined;
  let fallbackReason: AITrimFailureReason | undefined;

  // 构造传给 pickTrimWithAI 的 entry（兼容 ManifestVideoEntry 接口）
  const pickEntry = {
    sha256: entry.sha256,
    durationSec: entry.durationSec,
    filePath: entry.filePath ?? entry.fid ?? "unknown",
    transcript: entry.transcript,
    ai: entry.ai,
  } as ManifestVideoEntry;

  try {
    const failureRef: { reason?: AITrimFailureReason } = {};
    const aiResult = await pickTrimWithAI(
      pickEntry,
      position,
      softMax,
      promptVersion,
      controller.signal,
      failureRef,
      injectedAiClient,
      cacheDb,
    );

    if (aiResult) {
      // snap + cap（C5 + C3）
      const snapped = snapToSegmentBoundary(
        aiResult.startSec,
        aiResult.endSec,
        splitSegs,
        entry.durationSec,
        aiResult.startSegmentIdx,
        aiResult.endSegmentIdx,
      );

      const capResult = capToSoftMax(snapped.startSec, snapped.endSec, splitSegs, softMax);
      startSec = capResult.start;
      endSec = capResult.end;
      capped = capResult.capped;
      cappedFrom = capResult.cappedFrom;
      reason = aiResult.reason?.slice(0, 500);
      source = aiResult.fromCache ? "qwen_cache" : "qwen";
    } else {
      // Qwen 失败 → fallback to smartTrimWindow（C4）
      // closing fallback 用 180s softMax（B3 修复）
      const fallbackMax = position === "closing" ? 180 : middleSoftMax;
      const fallback = smartTrimWindow(entry.durationSec, splitSegs, fallbackMax);
      startSec = fallback.startSec;
      endSec = fallback.endSec;
      source = "fallback";
      fallbackReason = failureRef.reason;
    }
  } catch (e) {
    // 捕获意外异常，强制 fallback
    err(`[smart-trim-ai] unexpected error in trimClipAI: ${(e as Error).message}, fallback`);
    const fallbackMax = position === "closing" ? 180 : middleSoftMax;
    const fallback = smartTrimWindow(entry.durationSec, splitSegs, fallbackMax);
    startSec = fallback.startSec;
    endSec = fallback.endSec;
    source = "fallback";
    fallbackReason = undefined;
  } finally {
    clearTimeout(timeoutId);
  }

  const result: TrimClipAIResult = {
    startSec,
    endSec,
    status: "ok",
    source,
    position,
  };

  if (reason !== undefined) result.reason = reason;
  if (capped) {
    result.capped = capped;
    if (cappedFrom !== undefined) result.cappedFrom = cappedFrom;
  }
  if (fallbackReason !== undefined) result.fallbackReason = fallbackReason;

  return result;
}

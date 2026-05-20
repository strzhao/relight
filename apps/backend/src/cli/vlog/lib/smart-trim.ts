/**
 * 纯算法函数：smartTrim 窗口计算 + splitSegmentByWordGap + shiftSegments 时间戳平移
 * + position 推断 + softMax 计算。无副作用，可被 vitest 直接测试。
 */
import type { Selection, TranscriptSegment } from "../types";

// =========================================================
// position 推断 + softMax 计算（原 smart-trim-ai 中的工具）
// =========================================================

export type SmartTrimPosition = "first" | "middle" | "closing";

/** middle 段软上限（秒），可由 CLI 覆盖 */
export const MIDDLE_SOFT_MAX_SEC = 120;

/**
 * closing 硬上限（秒）。closing 段算法 fallback 用这个，防止 fallback 给出整段视频。
 */
export const CLOSING_HARD_MAX_SEC = 600;

/**
 * 从 selection 推断 fid 在整片中的位置（first / middle / closing）。
 *
 *  - 无 selection → 所有 clip = middle（保守）
 *  - effective order（排除 excluded）的第 1 个 = first，最后 1 个 = closing
 *  - 其余 = middle
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

/** middle 用 middleSoftMax，closing 用 CLOSING_HARD_MAX_SEC */
export function softMaxForPosition(
  position: SmartTrimPosition,
  middleSoftMax = MIDDLE_SOFT_MAX_SEC,
): number {
  if (position === "closing") return CLOSING_HARD_MAX_SEC;
  return middleSoftMax;
}

/**
 * Find an optimal [startSec, endSec] window that fits within maxClipSec
 * while aligning to transcript segment boundaries (no mid-sentence cuts).
 * Strategy:
 *   1. If video is shorter than maxClipSec: use full duration.
 *   2. If no transcript: just take the first maxClipSec.
 *   3. If transcript exists: find longest contiguous run of non-empty segments
 *      that fits within maxClipSec. Snap to segment boundaries. Includes leading
 *      silence up to 1.0s and trailing silence up to 1.0s for natural pacing.
 */
export function smartTrimWindow(
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
  // The window is always exactly maxClipSec wide (or less if near end of video).
  let bestStart = 0;
  let bestEnd = Math.min(durationSec, maxClipSec);
  let bestSpoken = 0;

  for (let i = 0; i < validSegs.length; i++) {
    const startSeg = validSegs[i];
    if (!startSeg) continue;
    const startSec = Math.max(0, startSeg.start - 1.0); // 1s lead-in
    // Window end must not exceed durationSec
    const windowEnd = Math.min(durationSec, startSec + maxClipSec);
    let spoken = 0;
    for (let j = i; j < validSegs.length; j++) {
      const seg = validSegs[j];
      if (!seg) continue;
      if (seg.end > windowEnd) break;
      spoken += seg.end - seg.start;
    }
    if (spoken > bestSpoken) {
      bestSpoken = spoken;
      bestStart = startSec;
      bestEnd = windowEnd;
    }
  }

  // Sanity: ensure non-empty window
  if (bestEnd - bestStart < 1.0) {
    return { startSec: 0, endSec: Math.min(maxClipSec, durationSec) };
  }
  return { startSec: bestStart, endSec: bestEnd };
}

/**
 * Whisper sometimes glues two utterances separated by a long pause into a
 * single segment (segment.end - segment.start >> sum of word durations). The
 * resulting subtitle would display for 10-20s spanning a long silence.
 *
 * Processes an array of segments, splitting each one wherever consecutive
 * words have a gap larger than gapThresholdSec (default 1.5s). Falls back to
 * the original segment when no word timestamps are available.
 * Returns a flat array of all resulting sub-segments.
 */
export function splitSegmentByWordGap(
  segments: TranscriptSegment[],
  gapThresholdSec = 1.5,
): TranscriptSegment[] {
  return segments.flatMap((seg) => splitOneSeg(seg, gapThresholdSec));
}

/** Internal: split a single segment by word gaps. */
function splitOneSeg(seg: TranscriptSegment, maxGapSec: number): TranscriptSegment[] {
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
 * 平移 transcript segments + words 时间戳，使 startOffsetSec 成为新的 0 点。
 * 同时做边界截断（契约 C7）：
 *   - segment: start < 0 → 0; end > trimmedDurationSec → trimmedDurationSec;
 *              截断后 start >= end → 剔除整个 segment
 *   - words: 下界 max(0, segment.start)；上界 min(trimmedDurationSec, segment.end)；
 *            word 截断后 start >= end → 剔除该 word
 */
export function shiftSegments(
  segments: TranscriptSegment[],
  startOffsetSec: number,
  trimmedDurationSec: number,
): TranscriptSegment[] {
  const result: TranscriptSegment[] = [];

  for (const seg of segments) {
    // 1. 平移 segment 时间戳
    const rawStart = seg.start - startOffsetSec;
    const rawEnd = seg.end - startOffsetSec;

    // 2. 边界截断 segment
    const clampedStart = Math.max(0, rawStart);
    const clampedEnd = Math.max(0, Math.min(trimmedDurationSec, rawEnd));

    // 3. 截断后无效 → 剔除
    if (clampedStart >= clampedEnd) continue;

    // 4. 处理 words（先 segment 后 words）
    let words: TranscriptSegment["words"];
    if (seg.words && seg.words.length > 0) {
      const shiftedWords = [];
      for (const w of seg.words) {
        const wRawStart = w.start - startOffsetSec;
        const wRawEnd = w.end - startOffsetSec;

        // word 下界：max(0, clampedStart)；上界：min(trimmedDurationSec, clampedEnd)
        const wStart = Math.max(0, Math.max(clampedStart, wRawStart));
        const wEnd = Math.max(0, Math.min(trimmedDurationSec, Math.min(clampedEnd, wRawEnd)));

        // word 无效 → 剔除
        if (wStart >= wEnd) continue;

        shiftedWords.push({
          ...w,
          start: wStart,
          end: wEnd,
        });
      }
      words = shiftedWords.length > 0 ? shiftedWords : undefined;
    }

    result.push({
      ...seg,
      start: clampedStart,
      end: clampedEnd,
      words,
    });
  }

  return result;
}

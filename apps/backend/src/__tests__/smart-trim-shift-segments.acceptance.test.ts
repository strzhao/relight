/**
 * 验收测试：shiftSegments 时间戳平移（红队）
 *
 * 覆盖契约 C7：shiftSegments(segments, startOffsetSec, trimmedDurationSec) 的全部边界 case
 *
 * C7 规约：
 *   - 对每个 segment：start -= startOffsetSec; end -= startOffsetSec
 *   - 对每个 word：start -= startOffsetSec; end -= startOffsetSec
 *   - segment 边界截断（先 segment，后 words）：
 *     • start < 0 → 截到 0
 *     • end > trimmedDurationSec → 截到 trimmedDurationSec
 *     • 截断后 start >= end → 剔除整个 segment
 *   - word 边界：上界 = min(trimmedDurationSec, segment.end)；下界 = max(0, segment.start)
 *     • 截断后 start >= end → 剔除该 word
 *
 * 必测 case：
 *   (a) 普通平移（无截断）
 *   (b) segment 跨左边界截断到 0
 *   (c) segment 跨右边界截断到 trimmedDurationSec
 *   (d) word 跨边界截断，上界以 segment.end 为准
 *   (e) word 整个落在 segment 范围外被剔除
 *   (f) word 上界超过 segment.end 应被截到 segment.end
 *
 * 红队铁律：
 *   - 未读 smart-trim.ts 实现代码
 *   - 仅依据设计文档契约 C7 编写
 */
import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../cli/vlog/types";

// ---- 导入被测函数 ----
async function loadShiftSegments(): Promise<
  (
    segments: TranscriptSegment[],
    startOffsetSec: number,
    trimmedDurationSec: number,
  ) => TranscriptSegment[]
> {
  const mod = await import("../cli/vlog/lib/smart-trim");
  if (typeof (mod as Record<string, unknown>).shiftSegments !== "function") {
    throw new Error("smart-trim.ts 必须导出 shiftSegments 函数（契约 C7）");
  }
  return (mod as Record<string, unknown>).shiftSegments as (
    segments: TranscriptSegment[],
    startOffsetSec: number,
    trimmedDurationSec: number,
  ) => TranscriptSegment[];
}

describe("契约 C7: shiftSegments 时间戳平移", () => {
  describe("导出契约", () => {
    it("smart-trim 模块必须导出 shiftSegments 函数", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim");
      expect(typeof (mod as Record<string, unknown>).shiftSegments).toBe("function");
    });

    it("shiftSegments 必须接受 3 个参数（segments, startOffsetSec, trimmedDurationSec）", async () => {
      const fn = await loadShiftSegments();
      expect(fn.length).toBe(3);
    });
  });

  describe("(a) 普通平移：segment 和 word 完全在范围内", () => {
    it("平移后 segment.start 和 segment.end 均减去 startOffsetSec", async () => {
      const fn = await loadShiftSegments();
      const segments: TranscriptSegment[] = [{ start: 10, end: 15, text: "你好", words: [] }];
      const result = fn(segments, 8, 50);
      expect(result).toHaveLength(1);
      expect(result[0]!.start).toBeCloseTo(2, 5);
      expect(result[0]!.end).toBeCloseTo(7, 5);
    });

    it("平移后 word 的 start/end 均减去 startOffsetSec", async () => {
      const fn = await loadShiftSegments();
      const segments: TranscriptSegment[] = [
        {
          start: 10,
          end: 15,
          text: "你好",
          words: [
            { start: 10.2, end: 11.5, word: "你", probability: 0.9 },
            { start: 12.0, end: 13.8, word: "好", probability: 0.85 },
          ],
        },
      ];
      const result = fn(segments, 8, 50);
      expect(result).toHaveLength(1);
      const words = result[0]!.words ?? [];
      expect(words).toHaveLength(2);
      expect(words[0]!.start).toBeCloseTo(2.2, 5);
      expect(words[0]!.end).toBeCloseTo(3.5, 5);
      expect(words[1]!.start).toBeCloseTo(4.0, 5);
      expect(words[1]!.end).toBeCloseTo(5.8, 5);
    });

    it("多个 segment 全部完整平移，顺序保持", async () => {
      const fn = await loadShiftSegments();
      const segments: TranscriptSegment[] = [
        { start: 5, end: 8, text: "第一段", words: [] },
        { start: 10, end: 14, text: "第二段", words: [] },
        { start: 20, end: 25, text: "第三段", words: [] },
      ];
      const result = fn(segments, 4, 30);
      expect(result).toHaveLength(3);
      expect(result[0]!.start).toBeCloseTo(1, 5);
      expect(result[0]!.end).toBeCloseTo(4, 5);
      expect(result[1]!.start).toBeCloseTo(6, 5);
      expect(result[2]!.end).toBeCloseTo(21, 5);
    });
  });

  describe("(b) segment 跨左边界截断到 0", () => {
    it("segment.start 平移后 < 0 → 截到 0（不剔除，只截）", async () => {
      const fn = await loadShiftSegments();
      // startSec=10, segment.start=8（平移后 -2），segment.end=15（平移后 5）
      const segments: TranscriptSegment[] = [{ start: 8, end: 15, text: "跨左边界", words: [] }];
      const result = fn(segments, 10, 50);
      expect(result).toHaveLength(1);
      expect(result[0]!.start).toBe(0);
      expect(result[0]!.end).toBeCloseTo(5, 5);
    });

    it("segment 整体在裁切点之前（start 和 end 都 < 0 平移后）→ 剔除", async () => {
      const fn = await loadShiftSegments();
      // segment.start=2, segment.end=5, startOffset=10 → start=-8, end=-5 → start>=end 后 end 也 <=0 → 剔除
      const segments: TranscriptSegment[] = [{ start: 2, end: 5, text: "裁切前的废话", words: [] }];
      const result = fn(segments, 10, 50);
      // 平移后 start=-8, end=-5; 截断 start→0, end→0（因 end<0 截到 0，此时 start==end=0）→ 剔除
      // 注：根据 C7，截断后 start >= end → 剔除
      expect(result).toHaveLength(0);
    });

    it("segment 被左边界截断后 start=0 < end → 保留", async () => {
      const fn = await loadShiftSegments();
      const segments: TranscriptSegment[] = [{ start: 5, end: 12, text: "部分保留", words: [] }];
      // startOffset=8: start=5-8=-3→0, end=12-8=4; 0<4 → 保留
      const result = fn(segments, 8, 50);
      expect(result).toHaveLength(1);
      expect(result[0]!.start).toBe(0);
      expect(result[0]!.end).toBeCloseTo(4, 5);
    });
  });

  describe("(c) segment 跨右边界截断到 trimmedDurationSec", () => {
    it("segment.end 平移后 > trimmedDurationSec → 截到 trimmedDurationSec", async () => {
      const fn = await loadShiftSegments();
      // segment: start=30, end=55; startOffset=5; trimmedDuration=45
      // 平移后: start=25, end=50; end>45 → 截到 45
      const segments: TranscriptSegment[] = [{ start: 30, end: 55, text: "跨右边界", words: [] }];
      const result = fn(segments, 5, 45);
      expect(result).toHaveLength(1);
      expect(result[0]!.start).toBeCloseTo(25, 5);
      expect(result[0]!.end).toBe(45);
    });

    it("segment 整体在裁切点之后（start 平移后 >= trimmedDurationSec）→ 剔除", async () => {
      const fn = await loadShiftSegments();
      // segment: start=60, end=70; startOffset=5; trimmedDuration=45
      // 平移后: start=55>45=trimmedDuration → start>trimmedDuration → end截到45 → start(55)>=end(45) → 剔除
      const segments: TranscriptSegment[] = [{ start: 60, end: 70, text: "超出范围", words: [] }];
      const result = fn(segments, 5, 45);
      expect(result).toHaveLength(0);
    });
  });

  describe("(d) word 跨边界截断，上界以 segment.end 为准", () => {
    it("word.end 超过 segment.end → word.end 截到 segment.end（不是 trimmedDurationSec）", async () => {
      const fn = await loadShiftSegments();
      // segment: start=10, end=15; word: start=13, end=18（超出 segment.end）
      // startOffset=5; trimmedDuration=50
      // 平移后 segment: start=5, end=10
      // 平移后 word: start=8, end=13
      // word 上界 = min(trimmedDurationSec=50, segment.end=10) = 10 → word.end 截到 10
      const segments: TranscriptSegment[] = [
        {
          start: 10,
          end: 15,
          text: "word 超出",
          words: [{ start: 13, end: 18, word: "超出", probability: 0.8 }],
        },
      ];
      const result = fn(segments, 5, 50);
      expect(result).toHaveLength(1);
      const words = result[0]!.words ?? [];
      expect(words).toHaveLength(1);
      // word.end 应被截到 segment.end（10），而非 trimmedDurationSec（50）
      expect(words[0]!.end).toBeLessThanOrEqual(result[0]!.end);
      expect(words[0]!.end).toBeCloseTo(result[0]!.end, 5);
    });

    it("word.start 小于 segment.start（平移并截断后）→ word.start 截到 segment.start", async () => {
      const fn = await loadShiftSegments();
      // segment 被左边界截断后 start=0; word 也被截
      // segment: start=3, end=12; word: start=1, end=5; startOffset=5; trimmedDuration=50
      // 平移后 segment: start=-2→0, end=7; word: start=-4→下界max(0,segment.start=0)=0, end=0
      // word.start=0 = word.end=0 → start>=end → 剔除
      const segments: TranscriptSegment[] = [
        {
          start: 3,
          end: 12,
          text: "word 跨左",
          words: [
            { start: 1, end: 2.5, word: "跨", probability: 0.7 }, // 整个在左截点前 → 剔除
            { start: 4, end: 7, word: "左", probability: 0.75 }, // 正常平移
          ],
        },
      ];
      const result = fn(segments, 5, 50);
      expect(result).toHaveLength(1); // segment 保留（平移后 start=-2→0, end=7, 0<7）
      const words = result[0]!.words ?? [];
      // 第一个 word 平移后: start=1-5=-4, end=2.5-5=-2.5; 均<=0 → 剔除
      // 第二个 word 平移后: start=4-5=-1→0, end=7-5=2; start<end → 保留
      expect(words).toHaveLength(1);
      expect(words[0]!.word).toBe("左");
    });
  });

  describe("(e) word 整个落在 segment 范围外被剔除", () => {
    it("word 平移后完全落在 segment 之外（高端）→ 剔除", async () => {
      const fn = await loadShiftSegments();
      // segment: start=10, end=15（平移后 start=5, end=10）
      // word: start=20, end=25（平移后 start=15, end=20）— 超出 segment.end=10 → 剔除
      const segments: TranscriptSegment[] = [
        {
          start: 10,
          end: 15,
          text: "word 超出高端",
          words: [{ start: 20, end: 25, word: "超出", probability: 0.9 }],
        },
      ];
      const result = fn(segments, 5, 50);
      expect(result).toHaveLength(1);
      const words = result[0]!.words ?? [];
      expect(words).toHaveLength(0);
    });

    it("word 平移后完全落在 segment 之外（低端）→ 剔除", async () => {
      const fn = await loadShiftSegments();
      // segment: start=15, end=20（平移后 start=5, end=10）
      // word: start=10, end=14（平移后 start=0, end=4）— 低于 segment.start=5 → 剔除
      // 注：按 C7，word 下界取 max(0, segment.start)=5，但 word.end(4) < 5 → word 整个低于下界 → 剔除
      const segments: TranscriptSegment[] = [
        {
          start: 15,
          end: 20,
          text: "word 低于低端",
          words: [{ start: 10, end: 14, word: "低", probability: 0.6 }],
        },
      ];
      const result = fn(segments, 10, 50);
      expect(result).toHaveLength(1);
      const words = result[0]!.words ?? [];
      expect(words).toHaveLength(0);
    });

    it("混合 words：部分在范围内、部分完全超出 → 只剔除超出的", async () => {
      const fn = await loadShiftSegments();
      // segment: start=10, end=18（平移后 start=5, end=13）
      // word A: start=10, end=13（平移后 5-8）— 在范围内，保留
      // word B: start=20, end=25（平移后 15-20）— 超出 segment.end=13 → 剔除
      const segments: TranscriptSegment[] = [
        {
          start: 10,
          end: 18,
          text: "混合",
          words: [
            { start: 10, end: 13, word: "在", probability: 0.9 },
            { start: 20, end: 25, word: "外", probability: 0.8 },
          ],
        },
      ];
      const result = fn(segments, 5, 50);
      expect(result).toHaveLength(1);
      const words = result[0]!.words ?? [];
      expect(words).toHaveLength(1);
      expect(words[0]!.word).toBe("在");
    });
  });

  describe("(f) word 上界超过 segment.end 应被截到 segment.end（BLOCKER-2 修复的关键边界）", () => {
    it("word.end 平移后超过 segment.end → 截到 segment.end（而非 trimmedDurationSec）", async () => {
      const fn = await loadShiftSegments();
      // trimmedDurationSec=50（远大于 segment.end）
      // segment: start=10, end=15（平移后 5-10）
      // word: start=11, end=20（平移后 6-15）— end=15 > segment.end=10 → 截到 10
      const segments: TranscriptSegment[] = [
        {
          start: 10,
          end: 15,
          text: "word 超 segment",
          words: [{ start: 11, end: 20, word: "超出", probability: 0.9 }],
        },
      ];
      const result = fn(segments, 5, 50);
      expect(result).toHaveLength(1);
      const words = result[0]!.words ?? [];
      expect(words).toHaveLength(1);
      // 关键断言：word.end 必须 <= segment.end，不能等于 trimmedDurationSec
      expect(words[0]!.end).toBeLessThanOrEqual(result[0]!.end);
      expect(words[0]!.end).not.toBeCloseTo(50, 2); // 不应被截到 trimmedDurationSec
      expect(words[0]!.end).toBeCloseTo(result[0]!.end, 5); // 应与 segment.end 一致
    });

    it("word.end 平移后等于 segment.end 时应保留（start < end）", async () => {
      const fn = await loadShiftSegments();
      // segment: start=10, end=15（平移后 5-10）
      // word: start=11, end=15（平移后 6-10，恰好等于 segment.end）→ 保留
      const segments: TranscriptSegment[] = [
        {
          start: 10,
          end: 15,
          text: "恰好边界",
          words: [{ start: 11, end: 15, word: "边", probability: 0.9 }],
        },
      ];
      const result = fn(segments, 5, 50);
      expect(result).toHaveLength(1);
      const words = result[0]!.words ?? [];
      expect(words).toHaveLength(1);
      expect(words[0]!.start).toBeCloseTo(6, 5);
      expect(words[0]!.end).toBeCloseTo(10, 5);
    });

    it("segment.end 同时被 trimmedDurationSec 截断时，word 上界取截断后的 segment.end", async () => {
      const fn = await loadShiftSegments();
      // segment: start=20, end=60; startOffset=5; trimmedDuration=45
      // 平移后 segment: start=15, end=55→截到 45
      // word: start=25, end=70（平移后 20-65）— 上界取 min(45, 45)=45 → 截到 45
      const segments: TranscriptSegment[] = [
        {
          start: 20,
          end: 60,
          text: "双重截断",
          words: [{ start: 25, end: 70, word: "双截", probability: 0.85 }],
        },
      ];
      const result = fn(segments, 5, 45);
      expect(result).toHaveLength(1);
      expect(result[0]!.end).toBe(45);
      const words = result[0]!.words ?? [];
      expect(words).toHaveLength(1);
      expect(words[0]!.end).toBeLessThanOrEqual(45);
    });
  });

  describe("边界：空输入 / 无 words", () => {
    it("空 segments 数组 → 返回空数组", async () => {
      const fn = await loadShiftSegments();
      const result = fn([], 10, 50);
      expect(result).toHaveLength(0);
    });

    it("segment 无 words 字段（undefined）→ 不抛错，正常平移", async () => {
      const fn = await loadShiftSegments();
      const segments: TranscriptSegment[] = [
        { start: 10, end: 15, text: "无 words", words: undefined },
      ];
      const result = fn(segments, 5, 50);
      expect(result).toHaveLength(1);
      expect(result[0]!.start).toBeCloseTo(5, 5);
      expect(result[0]!.end).toBeCloseTo(10, 5);
    });

    it("startOffsetSec=0 → segment 时间戳不变", async () => {
      const fn = await loadShiftSegments();
      const segments: TranscriptSegment[] = [
        {
          start: 5,
          end: 10,
          text: "不动",
          words: [{ start: 5.5, end: 8.0, word: "不变", probability: 0.9 }],
        },
      ];
      const result = fn(segments, 0, 50);
      expect(result).toHaveLength(1);
      expect(result[0]!.start).toBeCloseTo(5, 5);
      expect(result[0]!.end).toBeCloseTo(10, 5);
      const words = result[0]!.words ?? [];
      expect(words[0]!.start).toBeCloseTo(5.5, 5);
      expect(words[0]!.end).toBeCloseTo(8.0, 5);
    });
  });
});

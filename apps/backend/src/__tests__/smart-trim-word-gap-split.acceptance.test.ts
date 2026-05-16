/**
 * 验收测试：splitSegmentByWordGap 算法（红队）
 *
 * 设计文档覆盖：
 *   - 1.5s 阈值：相邻 word 间隔 > 1.5s → 拆分 segment
 *   - 1.5s 阈值：相邻 word 间隔 ≤ 1.5s → 不拆分
 *   - 单个 segment 无 words → 降级原样返回（不抛错）
 *   - 多个 segment：只拆 word gap，不合并
 *   - 函数签名：splitSegmentByWordGap(segments, gapThresholdSec=1.5)
 *
 * 红队铁律：未读 smart-trim.ts 实现；仅依据设计文档
 */
import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../cli/vlog/types";

async function loadSplitByWordGap(): Promise<
  (segments: TranscriptSegment[], gapThresholdSec?: number) => TranscriptSegment[]
> {
  const mod = await import("../cli/vlog/lib/smart-trim");
  if (typeof (mod as Record<string, unknown>).splitSegmentByWordGap !== "function") {
    throw new Error("smart-trim.ts 必须导出 splitSegmentByWordGap 函数");
  }
  return (mod as Record<string, unknown>).splitSegmentByWordGap as (
    segments: TranscriptSegment[],
    gapThresholdSec?: number,
  ) => TranscriptSegment[];
}

describe("splitSegmentByWordGap 算法", () => {
  describe("导出契约", () => {
    it("smart-trim 模块必须导出 splitSegmentByWordGap 函数", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim");
      expect(typeof (mod as Record<string, unknown>).splitSegmentByWordGap).toBe("function");
    });
  });

  describe("1.5s 阈值：相邻 word 间隔 > 1.5s → 拆分", () => {
    it("两个 word 间隔 2s（> 1.5s）→ 拆为 2 个 segment", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 10,
          text: "你好 世界",
          words: [
            { start: 0, end: 1.5, word: "你好", probability: 0.9 },
            { start: 3.5, end: 5.0, word: "世界", probability: 0.85 },
            // gap = 3.5 - 1.5 = 2.0s > 1.5s → 拆分
          ],
        },
      ];
      const result = fn(segments);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it("gap 恰好超过 1.5s（1.501s）→ 拆分", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 10,
          text: "刚好超过",
          words: [
            { start: 0, end: 1.0, word: "刚好", probability: 0.9 },
            { start: 2.501, end: 4.0, word: "超过", probability: 0.9 },
            // gap = 2.501 - 1.0 = 1.501 > 1.5 → 拆分
          ],
        },
      ];
      const result = fn(segments);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it("多处 gap > 1.5s → 拆为多个 segment", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 20,
          text: "三段话 中间有静音 最后一段",
          words: [
            { start: 0, end: 1.0, word: "三段话", probability: 0.9 },
            // gap 2s
            { start: 3.0, end: 4.0, word: "中间有静音", probability: 0.85 },
            // gap 2s
            { start: 6.0, end: 7.5, word: "最后一段", probability: 0.88 },
          ],
        },
      ];
      const result = fn(segments);
      // 两处 gap > 1.5s → 至少拆为 3 段
      expect(result.length).toBeGreaterThanOrEqual(3);
    });

    it("拆分后每个子 segment 的 start/end 与其 words 对齐", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 10,
          text: "A B",
          words: [
            { start: 0, end: 1.0, word: "A", probability: 0.9 },
            { start: 3.0, end: 4.5, word: "B", probability: 0.8 },
          ],
        },
      ];
      const result = fn(segments);
      for (const seg of result) {
        if (seg.words && seg.words.length > 0) {
          const minWordStart = Math.min(...seg.words.map((w) => w.start));
          const maxWordEnd = Math.max(...seg.words.map((w) => w.end));
          expect(seg.start).toBeLessThanOrEqual(minWordStart + 0.01);
          expect(seg.end).toBeGreaterThanOrEqual(maxWordEnd - 0.01);
        }
      }
    });

    it("使用自定义阈值 gapThresholdSec=2.0 时，1.8s gap 不触发拆分", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 10,
          text: "自定义阈值",
          words: [
            { start: 0, end: 1.0, word: "自定义", probability: 0.9 },
            { start: 2.8, end: 4.0, word: "阈值", probability: 0.9 },
            // gap = 1.8s；自定义阈值 2.0s → 不拆分
          ],
        },
      ];
      const result = fn(segments, 2.0);
      expect(result).toHaveLength(1);
    });
  });

  describe("1.5s 阈值：相邻 word 间隔 ≤ 1.5s → 不拆分", () => {
    it("相邻 word 间隔恰好 1.5s → 不拆分", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 10,
          text: "恰好",
          words: [
            { start: 0, end: 1.0, word: "恰", probability: 0.9 },
            { start: 2.5, end: 4.0, word: "好", probability: 0.9 },
            // gap = 2.5 - 1.0 = 1.5s → 不拆分
          ],
        },
      ];
      const result = fn(segments);
      expect(result).toHaveLength(1);
    });

    it("相邻 word 间隔 1.0s（< 1.5s）→ 不拆分", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 5,
          text: "紧凑",
          words: [
            { start: 0, end: 0.5, word: "紧", probability: 0.9 },
            { start: 1.5, end: 2.0, word: "凑", probability: 0.9 },
            // gap = 1.0s ≤ 1.5 → 不拆
          ],
        },
      ];
      const result = fn(segments);
      expect(result).toHaveLength(1);
    });

    it("无 gap（words 紧邻）→ 不拆分", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 3,
          text: "连续",
          words: [
            { start: 0, end: 1.0, word: "连", probability: 0.9 },
            { start: 1.0, end: 2.0, word: "续", probability: 0.9 },
            { start: 2.0, end: 3.0, word: "说", probability: 0.9 },
          ],
        },
      ];
      const result = fn(segments);
      expect(result).toHaveLength(1);
    });
  });

  describe("无 words 时降级（不抛错）", () => {
    it("segment 无 words（undefined）→ 降级原样返回，不抛错", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        { start: 0, end: 10, text: "无 words", words: undefined },
      ];
      let result: TranscriptSegment[] | undefined;
      await expect(
        (async () => {
          result = fn(segments);
        })(),
      ).resolves.toBeUndefined();
      expect(result).toBeDefined();
      expect(result!.length).toBeGreaterThanOrEqual(1);
      // 降级：原 segment 或等效形式保留
    });

    it("segment.words 为空数组 → 原样返回，不拆分", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [{ start: 0, end: 10, text: "空 words", words: [] }];
      const result = fn(segments);
      expect(result.length).toBeGreaterThanOrEqual(1);
      // 无 words 无法计算 gap，保留原 segment
    });
  });

  describe("多个 segment：只拆 word gap，不合并 segment", () => {
    it("两个独立 segment → 处理后至少保留 2 个（不合并）", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 5,
          text: "第一段",
          words: [
            { start: 0, end: 1.0, word: "第一", probability: 0.9 },
            { start: 1.2, end: 2.0, word: "段", probability: 0.9 },
          ],
        },
        {
          start: 10,
          end: 15,
          text: "第二段",
          words: [
            { start: 10, end: 11.0, word: "第二", probability: 0.9 },
            { start: 11.2, end: 12.5, word: "段", probability: 0.9 },
          ],
        },
      ];
      const result = fn(segments);
      // 两个 segment 各自 word gap ≤ 1.5s → 不拆；也不合并
      expect(result).toHaveLength(2);
    });

    it("第一个 segment 有大 gap 被拆，第二个 segment 不变 → 结果总数 = 拆分后 + 1", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 10,
          text: "有 gap",
          words: [
            { start: 0, end: 1.0, word: "A", probability: 0.9 },
            { start: 3.5, end: 5.0, word: "B", probability: 0.8 }, // gap=2.5s → 拆
          ],
        },
        {
          start: 20,
          end: 25,
          text: "无 gap",
          words: [
            { start: 20, end: 21.0, word: "C", probability: 0.9 },
            { start: 21.5, end: 22.5, word: "D", probability: 0.9 }, // gap=0.5s → 不拆
          ],
        },
      ];
      const result = fn(segments);
      // 第一个 segment 拆 2 份 + 第二个 segment 1 份 = 3
      expect(result.length).toBeGreaterThanOrEqual(3);
    });

    it("返回结果中 segment 按时间顺序排列", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 20,
          text: "长段含 gap",
          words: [
            { start: 0, end: 1.0, word: "开", probability: 0.9 },
            { start: 5.0, end: 6.5, word: "中", probability: 0.85 }, // gap=4s → 拆
            { start: 12.0, end: 13.5, word: "末", probability: 0.8 }, // gap=5.5s → 再拆
          ],
        },
      ];
      const result = fn(segments);
      for (let i = 1; i < result.length; i++) {
        expect(result[i]!.start).toBeGreaterThanOrEqual(result[i - 1]!.end - 0.01);
      }
    });
  });

  describe("边界输入", () => {
    it("空 segments 数组 → 返回空数组", async () => {
      const fn = await loadSplitByWordGap();
      const result = fn([]);
      expect(result).toHaveLength(0);
    });

    it("单个 word 的 segment → 原样返回，不抛错", async () => {
      const fn = await loadSplitByWordGap();
      const segments: TranscriptSegment[] = [
        {
          start: 0,
          end: 2,
          text: "单",
          words: [{ start: 0, end: 1.5, word: "单", probability: 0.9 }],
        },
      ];
      const result = fn(segments);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });
});

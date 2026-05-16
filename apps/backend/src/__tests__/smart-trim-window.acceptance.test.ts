/**
 * 验收测试：smartTrimWindow 算法（红队）
 *
 * 设计文档场景覆盖：
 *   - durationSec <= maxClipSec → 返回 {startSec: 0, endSec: durationSec}（不裁切）
 *   - segments 为 undefined / 空数组 → 返回 {startSec: 0, endSec: maxClipSec}
 *   - 正常 case：长视频 + segments → 选出"说话最密集"窗口
 *   - 边界 case：segments 长度恰好等于 maxClipSec
 *   - 场景 S3：短视频（durationSec < maxClipSec）不裁
 *   - 场景 S4：静音视频（空 segments）
 *
 * 红队铁律：未读 smart-trim.ts 实现；仅依据设计文档
 */
import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../cli/vlog/types";

async function loadSmartTrimWindow(): Promise<
  (
    durationSec: number,
    segments: TranscriptSegment[] | undefined,
    maxClipSec: number,
  ) => { startSec: number; endSec: number }
> {
  const mod = await import("../cli/vlog/lib/smart-trim");
  if (typeof (mod as Record<string, unknown>).smartTrimWindow !== "function") {
    throw new Error("smart-trim.ts 必须导出 smartTrimWindow 函数");
  }
  return (mod as Record<string, unknown>).smartTrimWindow as (
    durationSec: number,
    segments: TranscriptSegment[] | undefined,
    maxClipSec: number,
  ) => { startSec: number; endSec: number };
}

describe("smartTrimWindow 算法", () => {
  describe("导出契约", () => {
    it("smart-trim 模块必须导出 smartTrimWindow 函数", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim");
      expect(typeof (mod as Record<string, unknown>).smartTrimWindow).toBe("function");
    });
  });

  describe("短视频不裁切（场景 S3）", () => {
    it("durationSec < maxClipSec → 返回 {0, durationSec}（不裁切）", async () => {
      const fn = await loadSmartTrimWindow();
      const result = fn(30, [], 50);
      expect(result.startSec).toBe(0);
      expect(result.endSec).toBeCloseTo(30, 5);
    });

    it("durationSec === maxClipSec → 返回 {0, durationSec}（不裁切）", async () => {
      const fn = await loadSmartTrimWindow();
      const result = fn(50, [], 50);
      expect(result.startSec).toBe(0);
      expect(result.endSec).toBeCloseTo(50, 5);
    });

    it("durationSec 略小于 maxClipSec（49.9）→ 不裁切，endSec=durationSec", async () => {
      const fn = await loadSmartTrimWindow();
      const result = fn(49.9, [], 50);
      expect(result.startSec).toBe(0);
      expect(result.endSec).toBeCloseTo(49.9, 2);
    });
  });

  describe("静音视频 / 无 segments（场景 S4）", () => {
    it("segments 为 undefined → 返回 {0, maxClipSec}", async () => {
      const fn = await loadSmartTrimWindow();
      const result = fn(120, undefined, 50);
      expect(result.startSec).toBe(0);
      expect(result.endSec).toBe(50);
    });

    it("segments 为空数组 → 返回 {0, maxClipSec}", async () => {
      const fn = await loadSmartTrimWindow();
      const result = fn(120, [], 50);
      expect(result.startSec).toBe(0);
      expect(result.endSec).toBe(50);
    });

    it("长静音视频（durationSec=300, segments=[]）→ 返回 {0, maxClipSec=50}", async () => {
      const fn = await loadSmartTrimWindow();
      const result = fn(300, [], 50);
      expect(result.startSec).toBe(0);
      expect(result.endSec).toBe(50);
    });
  });

  describe("返回值约束", () => {
    it("返回值必须包含 startSec 和 endSec 字段", async () => {
      const fn = await loadSmartTrimWindow();
      const result = fn(100, [], 50);
      expect(result).toHaveProperty("startSec");
      expect(result).toHaveProperty("endSec");
    });

    it("startSec 必须 >= 0", async () => {
      const fn = await loadSmartTrimWindow();
      const segments: TranscriptSegment[] = [
        { start: 0, end: 5, text: "开头", words: [] },
        { start: 30, end: 35, text: "中段", words: [] },
        { start: 80, end: 85, text: "末段", words: [] },
      ];
      const result = fn(120, segments, 50);
      expect(result.startSec).toBeGreaterThanOrEqual(0);
    });

    it("endSec 必须 > startSec", async () => {
      const fn = await loadSmartTrimWindow();
      const segments: TranscriptSegment[] = [
        { start: 10, end: 15, text: "第一段", words: [] },
        { start: 20, end: 25, text: "第二段", words: [] },
      ];
      const result = fn(100, segments, 50);
      expect(result.endSec).toBeGreaterThan(result.startSec);
    });

    it("endSec - startSec 必须等于 maxClipSec（在长视频裁切时）", async () => {
      const fn = await loadSmartTrimWindow();
      const segments: TranscriptSegment[] = [
        { start: 10, end: 20, text: "密集段落", words: [] },
        { start: 20, end: 30, text: "连续段落", words: [] },
        { start: 30, end: 40, text: "继续", words: [] },
      ];
      const result = fn(120, segments, 50);
      expect(result.endSec - result.startSec).toBeCloseTo(50, 2);
    });

    it("endSec 不超过 durationSec", async () => {
      const fn = await loadSmartTrimWindow();
      const segments: TranscriptSegment[] = [
        { start: 80, end: 110, text: "末尾大量说话", words: [] },
      ];
      const durationSec = 120;
      const result = fn(durationSec, segments, 50);
      expect(result.endSec).toBeLessThanOrEqual(durationSec);
    });
  });

  describe("选出说话最密集窗口", () => {
    it("说话集中在视频中段 → startSec 应大于 0（不从头裁）", async () => {
      const fn = await loadSmartTrimWindow();
      // 说话全部集中在 40-90s，maxClipSec=50
      const segments: TranscriptSegment[] = [
        { start: 40, end: 45, text: "密集1", words: [] },
        { start: 46, end: 50, text: "密集2", words: [] },
        { start: 51, end: 55, text: "密集3", words: [] },
        { start: 56, end: 60, text: "密集4", words: [] },
        { start: 61, end: 65, text: "密集5", words: [] },
        { start: 70, end: 75, text: "密集6", words: [] },
        { start: 76, end: 80, text: "密集7", words: [] },
        { start: 81, end: 85, text: "密集8", words: [] },
        { start: 86, end: 90, text: "密集9", words: [] },
      ];
      const result = fn(180, segments, 50);
      // 说话集中在 40-90s，窗口应包含这段
      expect(result.startSec).toBeGreaterThanOrEqual(0);
      expect(result.endSec - result.startSec).toBeCloseTo(50, 2);
      // 窗口应覆盖说话最密集的区间，起点不应在 0
      expect(result.startSec).toBeGreaterThan(0);
    });

    it("说话全部集中在开头 → startSec 应约为 0", async () => {
      const fn = await loadSmartTrimWindow();
      const segments: TranscriptSegment[] = [
        { start: 0, end: 5, text: "开头1", words: [] },
        { start: 5, end: 10, text: "开头2", words: [] },
        { start: 10, end: 15, text: "开头3", words: [] },
        { start: 15, end: 20, text: "开头4", words: [] },
      ];
      const result = fn(180, segments, 50);
      expect(result.startSec).toBeCloseTo(0, 2);
      expect(result.endSec).toBeCloseTo(50, 2);
    });

    it("说话全部集中在末尾 → 窗口覆盖末尾，endSec ≈ durationSec", async () => {
      const fn = await loadSmartTrimWindow();
      const durationSec = 180;
      const segments: TranscriptSegment[] = [
        { start: 140, end: 150, text: "末尾1", words: [] },
        { start: 151, end: 160, text: "末尾2", words: [] },
        { start: 161, end: 170, text: "末尾3", words: [] },
        { start: 171, end: 178, text: "末尾4", words: [] },
      ];
      const result = fn(durationSec, segments, 50);
      expect(result.endSec).toBeLessThanOrEqual(durationSec);
      // 末尾最后一个 segment 在 171-178，窗口应包含它
      expect(result.endSec).toBeGreaterThanOrEqual(130);
    });
  });

  describe("边界 case：segments 长度恰好等于 maxClipSec", () => {
    it("单个 segment 恰好 50s（0-50）→ 选中该段，返回 {0, 50}", async () => {
      const fn = await loadSmartTrimWindow();
      const segments: TranscriptSegment[] = [
        { start: 0, end: 50, text: "整段都是说话", words: [] },
      ];
      // durationSec > maxClipSec 才会走裁切逻辑
      const result = fn(100, segments, 50);
      expect(result.startSec).toBeGreaterThanOrEqual(0);
      expect(result.endSec - result.startSec).toBeCloseTo(50, 2);
    });
  });
});

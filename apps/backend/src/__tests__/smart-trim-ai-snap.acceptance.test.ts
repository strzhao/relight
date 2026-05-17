/**
 * 验收测试 T5.2：snapToSegmentBoundary + capToSoftMax（红队）
 *
 * 覆盖契约：
 *   - C3: 软上限 cap（middle=120, closing=180→硬上限 600）
 *   - C5: Segment 边界对齐（snap，不切句中）
 *
 * 契约规约：
 *   snapToSegmentBoundary(rawStart, rawEnd, segments, duration): {startSec, endSec}
 *     - rawStart 在某 segment.start 附近 → snap 到 max(0, segment.start - 1.0)（lead-in 1s）
 *     - rawEnd 在某 segment.end 附近 → snap 到 min(duration, segment.end + 1.0)（tail-out 1s）
 *
 *   capToSoftMax(start, end, segments, softMax): {start, end, capped, cappedFrom}
 *     - duration 超 softMax → 找最大的 segment.end ≤ softMax 作为新 endSec
 *     - duration 在 softMax 内 → 不动，capped=false
 *     - 边界 case [119, 120, 121] for middle（120 不 capped，121 capped）
 *
 * 红队铁律：未读 smart-trim-ai.ts 实现；仅依据设计文档
 */
import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../cli/vlog/types";

interface SnapResult {
  startSec: number;
  endSec: number;
}

interface CapResult {
  start: number;
  end: number;
  capped: boolean;
  cappedFrom?: number;
}

async function loadSnapToSegmentBoundary(): Promise<
  (rawStart: number, rawEnd: number, segments: TranscriptSegment[], duration: number) => SnapResult
> {
  const mod = await import("../cli/vlog/lib/smart-trim-ai");
  const fn = (mod as Record<string, unknown>).snapToSegmentBoundary;
  if (typeof fn !== "function") {
    throw new Error("smart-trim-ai.ts 必须导出 snapToSegmentBoundary 函数");
  }
  return fn as (
    rawStart: number,
    rawEnd: number,
    segments: TranscriptSegment[],
    duration: number,
  ) => SnapResult;
}

async function loadCapToSoftMax(): Promise<
  (start: number, end: number, segments: TranscriptSegment[], softMax: number) => CapResult
> {
  const mod = await import("../cli/vlog/lib/smart-trim-ai");
  const fn = (mod as Record<string, unknown>).capToSoftMax;
  if (typeof fn !== "function") {
    throw new Error("smart-trim-ai.ts 必须导出 capToSoftMax 函数");
  }
  return fn as (
    start: number,
    end: number,
    segments: TranscriptSegment[],
    softMax: number,
  ) => CapResult;
}

// 构建 TranscriptSegment 的辅助函数
function makeSeg(start: number, end: number, text = "说话"): TranscriptSegment {
  return { start, end, text, words: [] };
}

describe("snapToSegmentBoundary 边界 snap（C5）", () => {
  describe("导出契约", () => {
    it("smart-trim-ai 模块必须导出 snapToSegmentBoundary 函数", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      expect(typeof (mod as Record<string, unknown>).snapToSegmentBoundary).toBe("function");
    });
  });

  describe("start snap：rawStart 在 segment.start 附近 → snap 到 max(0, segment.start - 1.0)", () => {
    it("rawStart 接近 segment.start=5 → snap 到 max(0, 5-1)=4", async () => {
      const snap = await loadSnapToSegmentBoundary();
      const segments = [makeSeg(5, 10), makeSeg(15, 20), makeSeg(25, 30)];
      const result = snap(5.3, 20.0, segments, 60);
      // rawStart 接近 segment[0].start=5，snap 到 5-1=4
      expect(result.startSec).toBeCloseTo(4.0, 1);
    });

    it("segment.start=0 时 snap 不小于 0（边界保护）", async () => {
      const snap = await loadSnapToSegmentBoundary();
      const segments = [makeSeg(0, 5), makeSeg(10, 15)];
      const result = snap(0.5, 15.0, segments, 30);
      // segment.start=0，max(0, 0-1)=0
      expect(result.startSec).toBeGreaterThanOrEqual(0);
    });

    it("rawStart 接近 segment.start=10 → snap 到 max(0, 10-1)=9", async () => {
      const snap = await loadSnapToSegmentBoundary();
      const segments = [makeSeg(2, 8), makeSeg(10, 18), makeSeg(22, 28)];
      const result = snap(10.2, 25.0, segments, 60);
      expect(result.startSec).toBeCloseTo(9.0, 1);
    });
  });

  describe("end snap：rawEnd 在 segment.end 附近 → snap 到 min(duration, segment.end + 1.0)", () => {
    it("rawEnd 接近 segment.end=20 → snap 到 min(60, 20+1)=21", async () => {
      const snap = await loadSnapToSegmentBoundary();
      const segments = [makeSeg(5, 10), makeSeg(14, 20), makeSeg(25, 30)];
      const result = snap(4.0, 20.3, segments, 60);
      // rawEnd 接近 segment[1].end=20，snap 到 20+1=21
      expect(result.endSec).toBeCloseTo(21.0, 1);
    });

    it("segment.end + 1 超出 duration 时 → snap 到 duration", async () => {
      const snap = await loadSnapToSegmentBoundary();
      const duration = 25.0;
      const segments = [makeSeg(5, 10), makeSeg(20, 24.5)];
      const result = snap(4.0, 24.8, segments, duration);
      // segment.end=24.5，+1=25.5 > duration=25，应 min(25, 25.5)=25
      expect(result.endSec).toBeLessThanOrEqual(duration);
    });

    it("rawEnd 接近 segment.end=30 → snap 到 30+1=31", async () => {
      const snap = await loadSnapToSegmentBoundary();
      const segments = [makeSeg(5, 10), makeSeg(15, 20), makeSeg(25, 30)];
      const result = snap(9.0, 30.2, segments, 60);
      expect(result.endSec).toBeCloseTo(31.0, 1);
    });
  });

  describe("snap 后结果约束", () => {
    it("snap 后 startSec 应 >= 0", async () => {
      const snap = await loadSnapToSegmentBoundary();
      const segments = [makeSeg(0.5, 5)];
      const result = snap(0.5, 5, segments, 30);
      expect(result.startSec).toBeGreaterThanOrEqual(0);
    });

    it("snap 后 endSec 应不超过 duration", async () => {
      const snap = await loadSnapToSegmentBoundary();
      const duration = 30;
      const segments = [makeSeg(5, 29)];
      const result = snap(4, 29, segments, duration);
      expect(result.endSec).toBeLessThanOrEqual(duration);
    });

    it("snap 后 endSec > startSec（非负 duration）", async () => {
      const snap = await loadSnapToSegmentBoundary();
      const segments = [makeSeg(10, 20), makeSeg(30, 40)];
      const result = snap(10.5, 40.2, segments, 60);
      expect(result.endSec).toBeGreaterThan(result.startSec);
    });
  });
});

describe("capToSoftMax 软上限 cap（C3）", () => {
  describe("导出契约", () => {
    it("smart-trim-ai 模块必须导出 capToSoftMax 函数", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      expect(typeof (mod as Record<string, unknown>).capToSoftMax).toBe("function");
    });
  });

  describe("duration 超 softMax → 找最大的 segment.end ≤ softMax 作为新 endSec", () => {
    it("middle clip: start=0, end=150, softMax=120 → capped=true, endSec ≤ 120", async () => {
      const cap = await loadCapToSoftMax();
      const segments = [
        makeSeg(5, 30),
        makeSeg(35, 60),
        makeSeg(65, 90),
        makeSeg(95, 115), // 最后一个在 120 之内
        makeSeg(125, 145),
      ];
      const result = cap(0, 150, segments, 120);
      expect(result.capped).toBe(true);
      expect(result.end - result.start).toBeLessThanOrEqual(120);
      expect(result.cappedFrom).toBeCloseTo(150, 0);
    });

    it("cap 后 endSec 应 snap 到最近的 segment.end（不切句中）", async () => {
      const cap = await loadCapToSoftMax();
      const segments = [
        makeSeg(0, 50),
        makeSeg(55, 100),
        makeSeg(110, 118), // segment.end=118 ≤ 120
        makeSeg(125, 135),
      ];
      const result = cap(0, 160, segments, 120);
      expect(result.capped).toBe(true);
      // endSec 应 snap 到 118+1=119 或 118（具体取决于实现是否含 tailOut）
      // 关键是不超过 120
      expect(result.end).toBeLessThanOrEqual(120 + 1.0 + 0.01); // +1 for tail-out tolerance
    });
  });

  describe("duration 在 softMax 内 → 不动，capped=false", () => {
    it("middle clip: start=0, end=100, softMax=120 → capped=false, end=100", async () => {
      const cap = await loadCapToSoftMax();
      const segments = [makeSeg(5, 30), makeSeg(35, 90)];
      const result = cap(0, 100, segments, 120);
      expect(result.capped).toBe(false);
      expect(result.end).toBeCloseTo(100, 1);
      expect(result.start).toBeCloseTo(0, 1);
    });

    it("duration 恰好等于 softMax → capped=false", async () => {
      const cap = await loadCapToSoftMax();
      const segments = [makeSeg(5, 110)];
      const result = cap(0, 120, segments, 120);
      expect(result.capped).toBe(false);
    });
  });

  describe("边界 case [119, 120, 121] for middle（softMax=120）", () => {
    it("end=119（< 120）→ capped=false", async () => {
      const cap = await loadCapToSoftMax();
      const segments = [makeSeg(5, 110)];
      const result = cap(0, 119, segments, 120);
      expect(result.capped).toBe(false);
    });

    it("end=120（= 120）→ capped=false（等于不超）", async () => {
      const cap = await loadCapToSoftMax();
      const segments = [makeSeg(5, 115)];
      const result = cap(0, 120, segments, 120);
      expect(result.capped).toBe(false);
    });

    it("end=121（> 120 by 1s）→ capped=true", async () => {
      const cap = await loadCapToSoftMax();
      const segments = [
        makeSeg(5, 30),
        makeSeg(35, 60),
        makeSeg(65, 90),
        makeSeg(95, 118), // last segment within 120
        makeSeg(120.5, 121),
      ];
      const result = cap(0, 121, segments, 120);
      expect(result.capped).toBe(true);
      expect(result.end).toBeLessThanOrEqual(121);
    });
  });

  describe("closing clip 硬上限 600s（C3）", () => {
    it("closing clip: end=400s < 600s → 不 cap（600 是硬上限，400 在内）", async () => {
      const cap = await loadCapToSoftMax();
      const segments = [makeSeg(10, 200), makeSeg(210, 395)];
      // closing softMax=600（硬上限）
      const result = cap(0, 400, segments, 600);
      expect(result.capped).toBe(false);
    });

    it("closing clip: end=190s（Qwen 给完整 190s）→ 不 cap（190 < 600 硬上限）", async () => {
      const cap = await loadCapToSoftMax();
      const segments = [makeSeg(1, 50), makeSeg(55, 100), makeSeg(105, 189)];
      const result = cap(0, 190, segments, 600);
      expect(result.capped).toBe(false);
      expect(result.end).toBeCloseTo(190, 0);
    });

    it("closing clip: end=601s（> 600 硬上限）→ cap 触发", async () => {
      const cap = await loadCapToSoftMax();
      const segments = [
        makeSeg(10, 200),
        makeSeg(210, 395),
        makeSeg(400, 598), // last fitting segment
        makeSeg(600.5, 601),
      ];
      const result = cap(0, 601, segments, 600);
      expect(result.capped).toBe(true);
      expect(result.end).toBeLessThanOrEqual(601);
    });
  });
});

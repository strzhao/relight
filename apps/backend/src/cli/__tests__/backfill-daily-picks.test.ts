/**
 * 纯函数单测：backfill-daily-picks
 *
 * 仅测两个纯函数（无 DB / 无 worker 依赖）：
 * - beijingDateOf: ISO takenAt → Asia/Shanghai YYYY-MM-DD
 * - enumerateMissingDates: [from..to] 逐日（含端点）过滤掉 existing，升序返回
 */
import { describe, expect, it } from "vitest";
import { beijingDateOf, enumerateMissingDates } from "../backfill-daily-picks";

describe("beijingDateOf", () => {
  it("UTC 中午 → 北京同一天", () => {
    // 2026-03-15T12:00:00Z = 北京 20:00 同日
    expect(beijingDateOf("2026-03-15T12:00:00Z")).toBe("2026-03-15");
  });

  it("UTC 20:00 → 北京次日 04:00", () => {
    // 2026-03-15T20:00:00Z = 北京 2026-03-16 04:00
    expect(beijingDateOf("2026-03-15T20:00:00Z")).toBe("2026-03-16");
  });

  it("UTC 16:00 → 北京次日 00:00（临界跨日）", () => {
    // 2026-03-15T16:00:00Z = 北京 2026-03-16 00:00
    expect(beijingDateOf("2026-03-15T16:00:00Z")).toBe("2026-03-16");
  });

  it("UTC 15:59 → 北京同日 23:59（未跨日）", () => {
    // 2026-03-15T15:59:00Z = 北京 2026-03-15 23:59
    expect(beijingDateOf("2026-03-15T15:59:00Z")).toBe("2026-03-15");
  });

  it("忽略毫秒/时区偏移字符串", () => {
    expect(beijingDateOf("2026-07-02T04:00:00.000Z")).toBe("2026-07-02");
  });
});

describe("enumerateMissingDates", () => {
  it("全空 → 返回全段（含端点）", () => {
    expect(enumerateMissingDates("2026-03-01", "2026-03-05", new Set())).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);
  });

  it("过滤 existing", () => {
    const existing = new Set(["2026-03-02", "2026-03-04"]);
    expect(enumerateMissingDates("2026-03-01", "2026-03-05", existing)).toEqual([
      "2026-03-01",
      "2026-03-03",
      "2026-03-05",
    ]);
  });

  it("全部已存在 → 返回 []", () => {
    const existing = new Set([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);
    expect(enumerateMissingDates("2026-03-01", "2026-03-05", existing)).toEqual([]);
  });

  it("from === to 单日", () => {
    expect(enumerateMissingDates("2026-03-15", "2026-03-15", new Set())).toEqual(["2026-03-15"]);
  });

  it("from === to 单日且已存在", () => {
    expect(enumerateMissingDates("2026-03-15", "2026-03-15", new Set(["2026-03-15"]))).toEqual([]);
  });

  it("from > to → 返回 []", () => {
    expect(enumerateMissingDates("2026-03-05", "2026-03-01", new Set())).toEqual([]);
  });

  it("跨月（防止月份溢出）", () => {
    // 2026-01-31 → 2026-02-02，朴素 "month+1/day=31" 写法会溢出到 02-31
    expect(enumerateMissingDates("2026-01-31", "2026-02-02", new Set())).toEqual([
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });

  it("跨年", () => {
    expect(enumerateMissingDates("2025-12-30", "2026-01-02", new Set())).toEqual([
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
    ]);
  });

  it("existing 中含区间外日期不影响结果", () => {
    const existing = new Set(["2025-12-31", "2026-03-15"]);
    expect(enumerateMissingDates("2026-03-01", "2026-03-02", existing)).toEqual([
      "2026-03-01",
      "2026-03-02",
    ]);
  });
});

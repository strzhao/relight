/**
 * 验收测试（红队）：backfill-daily-picks 纯函数 — beijingDateOf / enumerateMissingDates
 *
 * 设计契约来源（state.md 设计文档，红队仅依声明签名黑盒断言，不读任何实现）：
 *
 *   export function beijingDateOf(iso: string): string
 *     // ISO takenAt → Asia/Shanghai YYYY-MM-DD
 *
 *   export function enumerateMissingDates(
 *     from: string, to: string, existing: Set<string>
 *   ): string[]
 *     // [from..to] 逐日含端点，过滤 existing，升序返回；from>to 返回 []
 *
 * 红队铁律：
 *   - 仅依设计文档声明的导出签名写 import（设计契约，不是实现代码）
 *   - 期望值字面量逐字取自设计文档「验证方案」与「验证场景」给出的例子
 *   - 每个用例含强断言（expect.*），失败即挂掉；禁止 try/catch skip / it.skip
 *
 * 覆盖验收点：
 *   - 验收点 1：enumerateMissingDates 基础枚举（设计例 "2024-03-03" 过滤）
 *   - 验收点 1：from > to 返回 []
 *   - 验收点 1：跨月边界 2024-01-30 → 2024-02-02 正确枚举
 *   - 验收点 6：beijingDateOf 时区边界（"2024-06-15T16:00:00Z" → "2024-06-16"）
 */

import { describe, expect, it } from "vitest";
import { beijingDateOf, enumerateMissingDates } from "../backfill-daily-picks";

// ============================================================================
// beijingDateOf — ISO takenAt → Asia/Shanghai YYYY-MM-DD
// ============================================================================

describe("beijingDateOf — ISO → 北京日期（Asia/Shanghai）", () => {
  it('验收点6 字面量：2024-06-15T16:00:00Z（= 北京 6-16 00:00）→ "2024-06-16"', () => {
    // 设计文档逐字期望：UTC 16:00 + 8h = 次日 00:00 北京时间
    expect(beijingDateOf("2024-06-15T16:00:00Z")).toBe("2024-06-16");
  });

  it('时区边界：UTC 15:59Z 仍是北京当日 23:59 → "2024-06-15"', () => {
    // 边界对照：差一分钟即跨日，必须仍是当日
    expect(beijingDateOf("2024-06-15T15:59:59Z")).toBe("2024-06-15");
  });

  it("UTC 00:00Z（北京 08:00）→ 当日（不跨日）", () => {
    expect(beijingDateOf("2024-03-01T00:00:00Z")).toBe("2024-03-01");
  });

  it("UTC 23:59Z（北京次日 07:59）→ 次日", () => {
    expect(beijingDateOf("2024-03-01T23:59:00Z")).toBe("2024-03-02");
  });

  it('冬令时边界（北京始终 UTC+8，无夏令时）：2024-12-31T16:00:00Z → "2025-01-01"', () => {
    // 跨年边界：北京时间元旦 00:00
    expect(beijingDateOf("2024-12-31T16:00:00Z")).toBe("2025-01-01");
  });
});

// ============================================================================
// enumerateMissingDates — [from..to] 含端点、过滤 existing、升序
// ============================================================================

describe("enumerateMissingDates — 区间枚举 + 去重过滤", () => {
  it('验收点1 字面量：("2024-03-01","2024-03-05", {"2024-03-03"}) → 4 日（跳过中间已存在日）', () => {
    const result = enumerateMissingDates("2024-03-01", "2024-03-05", new Set(["2024-03-03"]));
    // 设计文档逐字期望：
    expect(result).toEqual(["2024-03-01", "2024-03-02", "2024-03-04", "2024-03-05"]);
  });

  it("验收点1：from > to → []（空区间）", () => {
    expect(enumerateMissingDates("2024-03-05", "2024-03-01", new Set())).toEqual([]);
  });

  it("验收点1：跨月边界 2024-01-30 → 2024-02-02 正确枚举（含 1-31 + 月跨到 2-1）", () => {
    const result = enumerateMissingDates("2024-01-30", "2024-02-02", new Set());
    // 1-30, 1-31, 2-01, 2-02 共 4 天，逐日升序
    expect(result).toEqual(["2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"]);
  });

  it("from == to（单日区间）且该日缺失 → [from]", () => {
    expect(enumerateMissingDates("2024-03-01", "2024-03-01", new Set())).toEqual(["2024-03-01"]);
  });

  it("from == to 且该日已存在 → []", () => {
    expect(enumerateMissingDates("2024-03-01", "2024-03-01", new Set(["2024-03-01"]))).toEqual([]);
  });

  it("全部日期已存在 → []（无可补）", () => {
    const result = enumerateMissingDates(
      "2024-03-01",
      "2024-03-03",
      new Set(["2024-03-01", "2024-03-02", "2024-03-03"]),
    );
    expect(result).toEqual([]);
  });

  it("existing 集合含范围外日期 → 不影响范围内枚举（边界外的条目被忽略）", () => {
    const result = enumerateMissingDates(
      "2024-03-02",
      "2024-03-04",
      new Set(["2024-03-01", "2024-03-03", "2024-03-05"]),
    );
    // 范围内只有 03-03 已存在，03-02 / 03-04 应保留
    expect(result).toEqual(["2024-03-02", "2024-03-04"]);
  });

  it("结果始终为升序（即使 existing 模式不规则）", () => {
    const result = enumerateMissingDates(
      "2024-03-01",
      "2024-03-05",
      new Set(["2024-03-04", "2024-03-02"]),
    );
    expect(result).toEqual(["2024-03-01", "2024-03-03", "2024-03-05"]);
    // 显式断言升序
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });

  it("跨年边界 2024-12-30 → 2025-01-02 正确枚举", () => {
    const result = enumerateMissingDates("2024-12-30", "2025-01-02", new Set());
    expect(result).toEqual(["2024-12-30", "2024-12-31", "2025-01-01", "2025-01-02"]);
  });
});

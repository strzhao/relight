/**
 * formatPhotoCaptureTime 单元测试（蓝队）
 *
 * 契约（state.md 契约规约 #1）：
 * - 输入 ISO 字符串或 null；返回 "YYYY年MM月DD日 HH:MM" 或 null（无效/空）。
 * - 纯函数，零副作用，不依赖 Date.now()，浏览器/Node/Satori 三端一致。
 * - 月、日、时、分均零填充 2 位；年份 4 位。
 * - 用 new Date(takenAt) 取本地 Y/M/D/H/M（与现有 calcYearsAgo 约定一致）。
 *
 * 时区说明：takenAt 存 ISO（Z 后缀），显示按运行机本地时区取回。
 * 测试用 Intl 检测时区：仅 Asia/Shanghai (+08:00) 时对 P1 锚点断言 "14:30"，
 * 其他时区断言"格式正确 + 时刻与 new Date(iso).getHours/getMinutes 一致"。
 */

import { describe, expect, it } from "vitest";
import { formatPhotoCaptureTime } from "../datetime";

function isShanghaiTz(): boolean {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Shanghai";
  } catch {
    return false;
  }
}

describe("formatPhotoCaptureTime — 契约 #1 格式与边界", () => {
  it("null 输入返回 null", () => {
    expect(formatPhotoCaptureTime(null)).toBeNull();
  });

  it("空字符串输入返回 null", () => {
    expect(formatPhotoCaptureTime("")).toBeNull();
  });

  it("无效日期字符串返回 null", () => {
    expect(formatPhotoCaptureTime("not-a-date")).toBeNull();
  });

  it("无效日期 'invalid' 返回 null", () => {
    expect(formatPhotoCaptureTime("invalid")).toBeNull();
  });

  it("返回值始终匹配 /YYYY年MM月DD日 HH:MM/ 格式（零填充）", () => {
    const out = formatPhotoCaptureTime("2021-06-15T06:30:00.000Z");
    expect(out).not.toBeNull();
    expect(out).toMatch(/^\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}$/);
  });

  it("月份/日期/时/分均零填充 2 位（1 月 5 日 场景，时刻按本地时区）", () => {
    // 2021-01-05T01:05:00Z → 日期段 "2021年01月05日"（月/日零填充）
    // UTC 01:05 在 +00~+14 仍为 5 日；时刻按运行机本地时区取回（零填充）
    const out = formatPhotoCaptureTime("2021-01-05T01:05:00.000Z");
    expect(out).not.toBeNull();
    // 月份零填充：含 "01月"
    expect(out).toMatch(/01月/);
    // 整体格式（月/日/时/分均 2 位零填充）
    expect(out).toMatch(/^\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}$/);
  });
});

describe("formatPhotoCaptureTime — P1 验收锚点（+08:00 机即 14:30）", () => {
  const iso = "2021-06-15T06:30:00.000Z"; // UTC 06:30 → +08:00 = 14:30

  it("返回字符串包含 '2021年06月15日'", () => {
    const out = formatPhotoCaptureTime(iso);
    expect(out).not.toBeNull();
    // UTC 06:30 在 +00 ~ +14 仍为 15 日，在 -12~-1 为 14 日；断言年份+月固定
    expect(out).toMatch(/2021年06月/);
  });

  it.runIf(isShanghaiTz())(
    "在 Asia/Shanghai (+08:00) 时区下，时刻为 '14:30'（P1 精确锚点）",
    () => {
      const out = formatPhotoCaptureTime(iso);
      expect(out).toBe("2021年06月15日 14:30");
    },
  );

  it("时刻与 new Date(iso) 本地 getHours/getMinutes 一致（契约：用本地时区取回）", () => {
    const out = formatPhotoCaptureTime(iso);
    expect(out).not.toBeNull();
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    expect(out).toContain(`${hh}:${mm}`);
  });
});

describe("formatPhotoCaptureTime — 纯函数性（三端一致）", () => {
  it("同一输入多次调用返回相同结果（无 Date.now 依赖）", () => {
    const iso = "2019-12-31T23:59:00.000Z";
    const a = formatPhotoCaptureTime(iso);
    const b = formatPhotoCaptureTime(iso);
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });

  it("年份为 4 位（支持跨世纪）", () => {
    const out = formatPhotoCaptureTime("1995-03-07T10:00:00.000Z");
    expect(out).not.toBeNull();
    expect(out).toMatch(/^1995年/);
  });
});

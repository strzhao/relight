/**
 * 单测：lib/wallpaper/capture.ts — calcYearsAgo + buildCaptureDateline
 * （2026-09-13 契约修订：壁纸视频字幕层 footer 改真实拍摄时刻，
 *   与 web CaptureDateline / 静态壁纸 template.tsx 同源 formatPhotoCaptureTime）
 *
 * 时区说明：moment 文本经 shared formatPhotoCaptureTime 按运行机本地时区取回，
 * 断言只用「年份差」与「null 边界」等时区无关锚点（年份锚点选 UTC 午后时刻，
 * 任意 ±14 时区偏移不跨年）。
 */
import { describe, expect, it } from "vitest";
import { buildCaptureDateline, calcYearsAgo } from "../lib/wallpaper/capture";

describe("calcYearsAgo", () => {
  it("null 输入返回 null", () => {
    expect(calcYearsAgo(null)).toBeNull();
  });

  it("无效日期字符串返回 null", () => {
    expect(calcYearsAgo("not-a-date")).toBeNull();
  });

  it("2016-07-18 在 2026 年运行 → 10", () => {
    expect(calcYearsAgo("2016-07-18T14:35:53.000Z")).toBe(10);
  });

  it("当年日期（< 1 年）→ null", () => {
    const y = new Date().getFullYear();
    expect(calcYearsAgo(`${y}-06-15T00:00:00.000Z`)).toBeNull();
  });

  it("恰好 1 年 → 1", () => {
    const y = new Date().getFullYear();
    expect(calcYearsAgo(`${y - 1}-06-15T00:00:00.000Z`)).toBe(1);
  });
});

describe("buildCaptureDateline", () => {
  it("takenAt null/缺省/无效 → null（footer 不渲染契约）", () => {
    expect(buildCaptureDateline(null)).toBeNull();
    expect(buildCaptureDateline(undefined)).toBeNull();
    expect(buildCaptureDateline("invalid")).toBeNull();
  });

  it("有效 takenAt → 「YYYY年MM月DD日 HH:MM · N 年前」格式（同源 formatPhotoCaptureTime）", () => {
    const out = buildCaptureDateline("2016-07-18T14:35:53.000Z");
    expect(out).toMatch(/^2016年07月1[78]日 \d{2}:\d{2} · 10 年前$/);
  });

  it("当年 takenAt（< 1 年）→ 仅时刻文本，无「· N 年前」段", () => {
    const y = new Date().getFullYear();
    const out = buildCaptureDateline(`${y}-06-15T00:00:00.000Z`);
    expect(out).not.toBeNull();
    expect(out).toMatch(new RegExp(`^${y}年06月1[56]日 \\d{2}:\\d{2}$`));
  });
});

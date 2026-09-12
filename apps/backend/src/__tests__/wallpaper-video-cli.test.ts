/**
 * 单测：wallpaper-video rerun CLI 纯函数（任务 4 契约测试兜底）
 *
 * 契约（state.md ## 契约规约 CLI（rerun）契约）：
 *   命令：npm run wallpaper-video:rerun -- --pickDate=YYYY-MM-DD
 *   参数 --pickDate（必填，isValidYmd 校验）
 *   末行 JSON {pickDate, landscape: <url|"">, portrait: <url|"">}
 */
import { describe, expect, it } from "vitest";
import { formatResultLine, isValidYmd, parsePickDateArg } from "../cli/wallpaper-video";

describe("parsePickDateArg", () => {
  it("--pickDate=2026-09-12 形式", () => {
    expect(parsePickDateArg(["--pickDate=2026-09-12"])).toBe("2026-09-12");
  });

  it("--pickDate 2026-09-12 分离形式", () => {
    expect(parsePickDateArg(["--pickDate", "2026-09-12"])).toBe("2026-09-12");
  });

  it("缺失 → undefined", () => {
    expect(parsePickDateArg([])).toBeUndefined();
    expect(parsePickDateArg(["--other"])).toBeUndefined();
  });
});

describe("isValidYmd", () => {
  it("合法日期通过", () => {
    expect(isValidYmd("2026-09-12")).toBe(true);
    expect(isValidYmd("2024-02-29")).toBe(true); // 闰年
  });

  it("非法输入拒绝", () => {
    expect(isValidYmd("2026-9-12")).toBe(false); // 格式
    expect(isValidYmd("2026-13-01")).toBe(false); // 月份
    expect(isValidYmd("2026-02-30")).toBe(false); // 日期合法性
    expect(isValidYmd("")).toBe(false);
    expect(isValidYmd("today")).toBe(false);
  });
});

describe("formatResultLine", () => {
  it("末行 JSON 契约：成功", () => {
    const line = formatResultLine(
      "2026-09-12",
      "https://b.cos.ap-shanghai.myqcloud.com/relight/wallpaper-videos/2026-09-12_landscape.mov",
      "https://b.cos.ap-shanghai.myqcloud.com/relight/wallpaper-videos/2026-09-12_portrait.mp4",
    );
    const parsed = JSON.parse(line) as Record<string, string>;
    expect(parsed.pickDate).toBe("2026-09-12");
    expect(parsed.landscape).toContain("_landscape.mov");
    expect(parsed.portrait).toContain("_portrait.mp4");
    expect(Object.keys(parsed).sort()).toEqual(["landscape", "pickDate", "portrait"]);
  });

  it("末行 JSON 契约：失败为空串（非 null/缺省）", () => {
    const parsed = JSON.parse(formatResultLine("2026-09-12", "", "")) as Record<string, string>;
    expect(parsed.landscape).toBe("");
    expect(parsed.portrait).toBe("");
  });
});

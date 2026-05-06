/**
 * 单测：format-errors.ts
 *
 * 覆盖 isDeterministicFormatError 的 5 类匹配模式 + 1 个非格式错误
 */
import { describe, expect, it } from "vitest";
import { formatErrorPlaceholder, isDeterministicFormatError } from "../format-errors";

describe("isDeterministicFormatError", () => {
  it("匹配：Support for this compression format has not been built in", () => {
    const err = new Error(
      "Input file has corrupt header: Support for this compression format has not been built in",
    );
    expect(isDeterministicFormatError(err)).toBe(true);
  });

  it("匹配：bad seek to", () => {
    const err = new Error("bad seek to 12345");
    expect(isDeterministicFormatError(err)).toBe(true);
  });

  it("匹配：Warning treated as error due to failOn", () => {
    const err = new Error("Warning treated as error due to failOn policy: Sharp error");
    expect(isDeterministicFormatError(err)).toBe(true);
  });

  it("匹配：error in tile", () => {
    const err = new Error("error in tile (0, 0): decode_area failed");
    expect(isDeterministicFormatError(err)).toBe(true);
  });

  it("匹配：HEIC 转换失败", () => {
    const err = new Error("HEIC 转换失败: invalid sequence");
    expect(isDeterministicFormatError(err)).toBe(true);
  });

  it("不匹配：ECONNREFUSED（瞬时网络错误）", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:8001");
    expect(isDeterministicFormatError(err)).toBe(false);
  });

  it("不匹配：非 Error 对象（字符串）", () => {
    expect(isDeterministicFormatError("some string error")).toBe(false);
  });

  it("不匹配：null", () => {
    expect(isDeterministicFormatError(null)).toBe(false);
  });
});

describe("formatErrorPlaceholder", () => {
  it("返回含 aiModel=format_error 的占位对象", () => {
    const err = new Error("Support for this compression format has not been built in");
    const placeholder = formatErrorPlaceholder(err);
    expect(placeholder.aiModel).toBe("format_error");
    expect(placeholder.narrative).toContain("图片格式无法解析");
    expect(placeholder.narrative).toContain(err.message);
    const raw = JSON.parse(placeholder.rawResponse);
    expect(raw.formatError).toBe(true);
    expect(raw.message).toBe(err.message);
  });
});

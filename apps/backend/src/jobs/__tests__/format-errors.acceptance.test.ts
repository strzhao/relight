/**
 * 验收测试：任务 3 — 错误分类模块 format-errors.ts
 *
 * 契约来源：设计文档「错误分类占位（行为契约）」
 *
 * 验收标准：
 * 1. 模块导出 isDeterministicFormatError(err: unknown): boolean
 * 2. 模块导出 formatErrorPlaceholder(error: Error): { aiModel, narrative, rawResponse }
 * 3. isDeterministicFormatError 对 5 类 message 子串返回 true：
 *    - "Support for this compression format has not been built in"
 *    - "bad seek to 12345"
 *    - "Warning treated as error due to failOn setting"
 *    - "error in tile 0 x 5"
 *    - "HEIC 转换失败：xxx"
 * 4. isDeterministicFormatError 对非格式错误返回 false：
 *    - Error("ECONNREFUSED")
 *    - Error("AI 超时")
 *    - null / undefined / 数字
 * 5. formatErrorPlaceholder(new Error("foo")).aiModel === "format_error"
 * 6. formatErrorPlaceholder 返回的 narrative 包含原始错误信息
 * 7. formatErrorPlaceholder 返回的 rawResponse 是合法 JSON 字符串
 *
 * 测试策略：
 * - 直接 import 并调用目标函数（不使用 mock 绕过）
 * - 纯函数测试，无 IO、无网络、无 Redis 依赖
 *
 * 红队铁律：不读取 format-errors.ts 的实现；测试仅基于设计文档契约。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// =====================================================================
// 动态 import（避免 mock 时机问题，并确保实现存在）
// =====================================================================

type FormatErrorsModule = {
  isDeterministicFormatError: (err: unknown) => boolean;
  formatErrorPlaceholder: (error: Error) => {
    aiModel: string;
    narrative: string;
    rawResponse: string;
  };
};

let mod: FormatErrorsModule;

beforeEach(async () => {
  mod = (await import("../../jobs/format-errors")) as FormatErrorsModule;
});

afterEach(() => {
  // 清理模块缓存，确保每次 import 最新版本
});

// =====================================================================
// 导出契约
// =====================================================================

describe("模块导出契约", () => {
  it("导出 isDeterministicFormatError 函数", () => {
    expect(typeof mod.isDeterministicFormatError).toBe("function");
  });

  it("导出 formatErrorPlaceholder 函数", () => {
    expect(typeof mod.formatErrorPlaceholder).toBe("function");
  });
});

// =====================================================================
// isDeterministicFormatError — 确定性格式错误（返回 true）
// =====================================================================

describe("isDeterministicFormatError — 确定性格式错误 → 返回 true", () => {
  it('"Support for this compression format has not been built in" → true', () => {
    const err = new Error("Support for this compression format has not been built in libvips");
    expect(mod.isDeterministicFormatError(err)).toBe(true);
  });

  it('"bad seek to 12345" → true', () => {
    const err = new Error("bad seek to 12345 in file.tif");
    expect(mod.isDeterministicFormatError(err)).toBe(true);
  });

  it('"Warning treated as error due to failOn setting" → true', () => {
    const err = new Error("Warning treated as error due to failOn setting: invalid image");
    expect(mod.isDeterministicFormatError(err)).toBe(true);
  });

  it('"error in tile 0 x 5" → true', () => {
    const err = new Error("error in tile 0 x 5: corrupt data");
    expect(mod.isDeterministicFormatError(err)).toBe(true);
  });

  it('"HEIC 转换失败：xxx" → true', () => {
    const err = new Error("HEIC 转换失败：invalid heic data");
    expect(mod.isDeterministicFormatError(err)).toBe(true);
  });

  it("message 中包含上述子串即可（不要求精确匹配）", () => {
    const err = new Error(
      "sharp: Support for this compression format has not been built in — please rebuild",
    );
    expect(mod.isDeterministicFormatError(err)).toBe(true);
  });

  it('"bad seek to" 后跟不同数字 → true', () => {
    const err = new Error("bad seek to 99999 in /tmp/broken.tif");
    expect(mod.isDeterministicFormatError(err)).toBe(true);
  });
});

// =====================================================================
// isDeterministicFormatError — 非确定性错误（返回 false）
// =====================================================================

describe("isDeterministicFormatError — 非格式错误 → 返回 false", () => {
  it('Error("ECONNREFUSED") → false（网络错误不是格式错误）', () => {
    const err = new Error("ECONNREFUSED connect localhost:8001");
    expect(mod.isDeterministicFormatError(err)).toBe(false);
  });

  it('Error("AI 超时") → false（AI 超时不是格式错误）', () => {
    const err = new Error("AI 超时");
    expect(mod.isDeterministicFormatError(err)).toBe(false);
  });

  it("null → false（不抛异常）", () => {
    expect(mod.isDeterministicFormatError(null)).toBe(false);
  });

  it("undefined → false（不抛异常）", () => {
    expect(mod.isDeterministicFormatError(undefined)).toBe(false);
  });

  it("数字 42 → false（不抛异常）", () => {
    expect(mod.isDeterministicFormatError(42)).toBe(false);
  });

  it("普通字符串 → false（不抛异常）", () => {
    expect(mod.isDeterministicFormatError("random error")).toBe(false);
  });

  it('Error("") 空消息 → false', () => {
    const err = new Error("");
    expect(mod.isDeterministicFormatError(err)).toBe(false);
  });

  it("Error 实例但 message 不包含任何格式关键词 → false", () => {
    const err = new Error("Unexpected token in JSON at position 0");
    expect(mod.isDeterministicFormatError(err)).toBe(false);
  });
});

// =====================================================================
// formatErrorPlaceholder — 返回值结构契约
// =====================================================================

describe("formatErrorPlaceholder — 返回值结构", () => {
  it("aiModel 固定为 'format_error'", () => {
    const result = mod.formatErrorPlaceholder(new Error("foo"));
    expect(result.aiModel).toBe("format_error");
  });

  it("narrative 字段存在且为字符串", () => {
    const result = mod.formatErrorPlaceholder(new Error("test error message"));
    expect(typeof result.narrative).toBe("string");
    expect(result.narrative.length).toBeGreaterThan(0);
  });

  it("narrative 包含原始错误信息", () => {
    const err = new Error("Support for this compression format has not been built in");
    const result = mod.formatErrorPlaceholder(err);
    expect(result.narrative).toContain(err.message);
  });

  it("rawResponse 是合法 JSON 字符串", () => {
    const result = mod.formatErrorPlaceholder(new Error("bad seek to 0"));
    expect(() => JSON.parse(result.rawResponse)).not.toThrow();
  });

  it("rawResponse 解析后的 JSON 包含错误信息", () => {
    const errMsg = "HEIC 转换失败：bad data";
    const result = mod.formatErrorPlaceholder(new Error(errMsg));
    const parsed = JSON.parse(result.rawResponse) as Record<string, unknown>;
    // rawResponse 应记录原始错误，以便事后审查
    const rawStr = JSON.stringify(parsed);
    expect(rawStr).toContain(errMsg.slice(0, 10)); // 至少包含前缀
  });

  it("返回对象包含 aiModel / narrative / rawResponse 三个字段", () => {
    const result = mod.formatErrorPlaceholder(new Error("test"));
    expect(result).toHaveProperty("aiModel");
    expect(result).toHaveProperty("narrative");
    expect(result).toHaveProperty("rawResponse");
  });

  it("不同错误消息产生不同的 narrative（信息不丢失）", () => {
    const r1 = mod.formatErrorPlaceholder(new Error("error A"));
    const r2 = mod.formatErrorPlaceholder(new Error("error B"));
    expect(r1.narrative).not.toBe(r2.narrative);
  });
});

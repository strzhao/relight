/**
 * 验收测试：AI Config — promptVersion 配置
 *
 * 覆盖设计文档：
 * - config.ai.promptVersion 默认值为 "v2"
 * - config.ai.promptVersion 可从环境变量 AI_PROMPT_VERSION 读取
 * - 向后兼容：设置为 "v1" 时切换回旧版 Prompt
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- 辅助函数 ----

/**
 * 获取 config 模块的新实例。
 * config.ts 在模块加载时读取 process.env，因此需要
 * vi.resetModules() 来确保读取到更新后的环境变量。
 */
async function getFreshConfig() {
  const mod = await import("../lib/config");
  return mod.config;
}

// ---- 测试 ----

describe("AI Config promptVersion — 验收测试", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // 清理 AI_PROMPT_VERSION 环境变量
    // Node.js 中赋值 undefined 会转为字符串 "undefined"，必须用 delete
    // biome-ignore lint/performance/noDelete: process.env 必须用 delete 取消设置
    delete process.env.AI_PROMPT_VERSION;
  });

  afterEach(() => {
    // 恢复原始环境变量
    process.env = { ...originalEnv };
  });

  describe("默认值", () => {
    it("AI_PROMPT_VERSION 未设置时，ai.promptVersion 应默认为 'v2'", async () => {
      // biome-ignore lint/performance/noDelete: process.env 必须用 delete 取消设置
      delete process.env.AI_PROMPT_VERSION;
      const config = await getFreshConfig();

      expect(config.ai).toHaveProperty("promptVersion");
      expect(config.ai.promptVersion).toBe("v2");
    });

    it("AI_PROMPT_VERSION 为空字符串时，应使用默认值 'v2'", async () => {
      process.env.AI_PROMPT_VERSION = "";
      const config = await getFreshConfig();

      // 空字符串可能被视为 falsy，应回退到默认值 v2
      expect(config.ai.promptVersion).toBe("v2");
    });
  });

  describe("环境变量读取", () => {
    it("AI_PROMPT_VERSION=v2 时，ai.promptVersion 应为 'v2'", async () => {
      process.env.AI_PROMPT_VERSION = "v2";
      const config = await getFreshConfig();

      expect(config.ai.promptVersion).toBe("v2");
    });

    it("AI_PROMPT_VERSION=v1 时，ai.promptVersion 应为 'v1'（向后兼容）", async () => {
      process.env.AI_PROMPT_VERSION = "v1";
      const config = await getFreshConfig();

      expect(config.ai.promptVersion).toBe("v1");
    });

    it("AI_PROMPT_VERSION=v3 时，ai.promptVersion 应为 'v3'（未来扩展）", async () => {
      process.env.AI_PROMPT_VERSION = "v3";
      const config = await getFreshConfig();

      expect(config.ai.promptVersion).toBe("v3");
    });
  });

  describe("config 对象整体结构", () => {
    it("config.ai 应保留已有的其他配置字段", async () => {
      // biome-ignore lint/performance/noDelete: process.env 必须用 delete 取消设置
      delete process.env.AI_PROMPT_VERSION;
      const config = await getFreshConfig();

      // 确保新增 promptVersion 不影响已有的配置字段
      expect(config.ai).toHaveProperty("baseUrl");
      expect(config.ai).toHaveProperty("apiKey");
      expect(config.ai).toHaveProperty("visionModel");
      expect(config.ai).toHaveProperty("model");
      expect(config.ai).toHaveProperty("promptVersion");
    });

    it("config.ai.visionModel 应保持从 AI_VISION_MODEL 环境变量读取", async () => {
      process.env.AI_VISION_MODEL = "custom-vision-v2";
      const config = await getFreshConfig();

      expect(config.ai.visionModel).toBe("custom-vision-v2");
    });
  });

  describe("类型安全", () => {
    it("ai.promptVersion 应为 string 类型", async () => {
      const config = await getFreshConfig();

      expect(typeof config.ai.promptVersion).toBe("string");
    });

    it("ai.promptVersion 不应为 undefined 或 null", async () => {
      const config = await getFreshConfig();

      expect(config.ai.promptVersion).toBeDefined();
      expect(config.ai.promptVersion).not.toBeNull();
    });
  });
});

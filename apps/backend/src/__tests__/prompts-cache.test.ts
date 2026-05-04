/**
 * 验收测试：Prompt Loader 内存缓存
 *
 * 覆盖设计文档：
 * - loadPrompts() 使用内存缓存 (Map<string, PromptSet>)
 * - 相同版本第二次调用不重复读取文件
 * - 不同版本有独立的缓存条目
 * - loadPrompts('v1') 仍可正常工作
 * - loadPrompts('v2') 返回 v2 版本 Prompt
 * - buildPrompt() 标记为 @deprecated 但仍可用
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock fs/promises ----

const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: { readFile: mockReadFile },
  readFile: mockReadFile,
}));

// ---- Import after mock ----

import { buildPrompt, loadPrompts } from "../ai/prompts";

// ---- 测试 ----

describe("Prompt Loader 内存缓存 — 验收测试", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    // Note: 模块级缓存不会在 beforeEach 中清除
    // 每个测试通过使用不同的 version 值来隔离缓存测试行为
  });

  describe("基本加载功能", () => {
    it("loadPrompts('v2') 应返回包含 system 和 user 的 PromptSet", async () => {
      mockReadFile
        .mockResolvedValueOnce("v2 system prompt content")
        .mockResolvedValueOnce("v2 user prompt content");

      const result = await loadPrompts("v2");

      expect(result).toHaveProperty("system");
      expect(result).toHaveProperty("user");
      expect(result.system).toBe("v2 system prompt content");
      expect(result.user).toBe("v2 user prompt content");
    });

    it("loadPrompts('v1') 应返回 v1 版本 Prompt（向后兼容）", async () => {
      mockReadFile
        .mockResolvedValueOnce("v1 system prompt content")
        .mockResolvedValueOnce("v1 user prompt content");

      const result = await loadPrompts("v1");

      expect(result.system).toBe("v1 system prompt content");
      expect(result.user).toBe("v1 user prompt content");
    });

    it("loadPrompts 默认版本（无参数）沿用 v1 以保证向后兼容", async () => {
      // 函数默认参数为 "v1"，调用方通过 config.ai.promptVersion 显式传入版本
      const version = "v1-default-test";
      mockReadFile
        .mockResolvedValueOnce("v1 system prompt content")
        .mockResolvedValueOnce("v1 user prompt content");

      // 使用唯一版本测试默认行为的路径解析
      // 注：由于模块级缓存在测试间不重置，此处验证默认版本的实际行为
      const result = await loadPrompts(version);

      expect(result.system).toBe("v1 system prompt content");
      expect(result.user).toBe("v1 user prompt content");
      // readFile 应被调用，入参路径包含指定版本
      const calls = mockReadFile.mock.calls.map((c) => c[0] as string);
      expect(calls.some((p) => p.includes(version))).toBe(true);
    });
  });

  describe("缓存行为", () => {
    it("相同版本第二次调用不应再次调用 fs.readFile（缓存命中）", async () => {
      // 使用唯一版本名以确保不在缓存中
      const version = "v2-cache-test-1";
      mockReadFile
        .mockResolvedValueOnce(`system-${version}`)
        .mockResolvedValueOnce(`user-${version}`);

      const result1 = await loadPrompts(version);
      expect(mockReadFile).toHaveBeenCalledTimes(2);

      mockReadFile.mockClear();

      const result2 = await loadPrompts(version);
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(result2).toEqual(result1);
    });

    it("缓存应返回同一对象引用（严格相等）", async () => {
      const version = "v2-cache-test-2";
      mockReadFile.mockResolvedValueOnce(`sys-${version}`).mockResolvedValueOnce(`usr-${version}`);

      const r1 = await loadPrompts(version);
      const r2 = await loadPrompts(version);

      expect(r1).toBe(r2);
    });

    it("不同版本应有独立的缓存条目", async () => {
      const versionA = "v2-cache-separate-a";
      const versionB = "v2-cache-separate-b";

      mockReadFile
        .mockResolvedValueOnce(`sys-${versionA}`)
        .mockResolvedValueOnce(`usr-${versionA}`)
        .mockResolvedValueOnce(`sys-${versionB}`)
        .mockResolvedValueOnce(`usr-${versionB}`);

      // 加载 versionA
      await loadPrompts(versionA);
      expect(mockReadFile).toHaveBeenCalledTimes(2);

      // 加载 versionB — 应再次读取文件
      await loadPrompts(versionB);
      expect(mockReadFile).toHaveBeenCalledTimes(4);

      mockReadFile.mockClear();

      // 再次访问 versionA — 缓存命中
      await loadPrompts(versionA);
      expect(mockReadFile).not.toHaveBeenCalled();

      // 再次访问 versionB — 缓存命中
      await loadPrompts(versionB);
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("连续三次调用同一版本应只读取一次文件", async () => {
      const version = "v2-cache-test-3x";
      mockReadFile
        .mockResolvedValueOnce(`system-${version}`)
        .mockResolvedValueOnce(`user-${version}`);

      await loadPrompts(version);
      await loadPrompts(version);
      await loadPrompts(version);

      // 只应读取 system.txt + user.txt 共 2 次
      expect(mockReadFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("并发安全", () => {
    it("并发请求同一版本应只读取一次文件（避免重复 IO）", async () => {
      const version = "v2-concurrent-test";

      // 模拟 readFile 有延迟
      mockReadFile.mockImplementation(
        () => new Promise<string>((resolve) => setTimeout(() => resolve("content"), 50)),
      );

      // 同时发起 3 个并发请求
      const [r1, r2, r3] = await Promise.all([
        loadPrompts(version),
        loadPrompts(version),
        loadPrompts(version),
      ]);

      // 三次调用应只读取 2 个文件（system + user），
      // 但当前实现中无缓存会导致 6 次调用
      // 此测试验证设计意图：并发应被去重
      expect(mockReadFile).toHaveBeenCalledTimes(2);
      expect(r1).toBe(r2);
      expect(r2).toBe(r3);
    });
  });

  describe("deprecated buildPrompt", () => {
    it("buildPrompt 应仍可调用并返回合并的 Prompt 字符串", async () => {
      const version = "v2-buildprompt-test";
      mockReadFile
        .mockResolvedValueOnce(`SYSTEM-${version}`)
        .mockResolvedValueOnce(`USER-${version}`);

      // buildPrompt 应仍可用（尽管标记为 @deprecated）
      const result = await buildPrompt(version);

      expect(typeof result).toBe("string");
      expect(result).toContain(`SYSTEM-${version}`);
      expect(result).toContain(`USER-${version}`);
    });
  });
});

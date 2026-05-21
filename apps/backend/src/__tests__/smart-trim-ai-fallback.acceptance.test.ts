/**
 * 验收测试 T5.3：Qwen 异常 → fallback 到 smartTrimWindow（红队）
 *
 * 覆盖契约：
 *   - C4: Qwen 失败回退（4 种异常）
 *   - B3 修复: closing fallback 用 180s 软上限（而非 middle 的 120s）
 *
 * 契约规约：
 *   以下 4 种情况自动回退到 smartTrimWindow，不抛异常：
 *   1. 超时（AbortController 触发）→ fallbackReason="timeout"
 *   2. JSON 解析失败 → fallbackReason="invalid_json"
 *   3. zod schema 验证失败 → fallbackReason="schema_error"
 *   4. range invalid (startSec >= endSec) → fallbackReason="range_invalid"
 *
 *   fallback 时 softMaxSec 按 position 取：
 *   - middle → 120s
 *   - closing → 180s（B3 修复）
 *
 *   B3: closing clip duration=200s + Qwen 超时 → fallback 用 180s，endSec ≥ 175
 *   middle clip duration=200s + Qwen 超时 → fallback 用 120s，endSec - startSec ≤ 120
 *
 * 测试策略：通过注入 fake aiClient（vi.mock 或 manual mock）触发各类失败
 *
 * 红队铁律：未读 smart-trim-ai.ts 实现；仅依据设计文档
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "../cli/vlog/types";

// ---- Fixture 辅助 ----
function makeSeg(start: number, end: number, text = "说话"): TranscriptSegment {
  return { start, end, text, words: [] };
}

// 构建一组 200s 视频的 segments（中等密度说话）
function makeSegments200s(): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  for (let i = 0; i < 20; i++) {
    segs.push(makeSeg(i * 10, i * 10 + 7, `说话段 ${i}`));
  }
  return segs;
}

// ---- pickTrimWithAI 接口定义 ----
interface AITrimEntry {
  sha256: string;
  durationSec: number;
  transcript?: {
    segments: TranscriptSegment[];
  };
  ai?: {
    videoNarrative?: string;
    tags?: string[];
  };
}

interface AITrimResult {
  startSec: number;
  endSec: number;
  reason?: string;
  confidence?: number;
  source?: "qwen" | "qwen_cache" | "fallback" | "passthrough" | "first_skip";
  fallbackReason?: "timeout" | "invalid_json" | "schema_error" | "range_invalid";
}

interface FakeAIClient {
  chat: ReturnType<typeof vi.fn>;
}

type PickTrimWithAIFn = (
  entry: AITrimEntry,
  position: "first" | "middle" | "closing",
  softMaxSec: number,
  promptVersion: string,
  signal: AbortSignal,
  aiClient?: FakeAIClient,
) => Promise<AITrimResult | null>;

async function tryLoadPickTrimWithAI(): Promise<PickTrimWithAIFn | null> {
  try {
    const mod = await import("../cli/vlog/lib/smart-trim-ai");
    const fn = (mod as Record<string, unknown>).pickTrimWithAI;
    if (typeof fn === "function") {
      return fn as PickTrimWithAIFn;
    }
    return null;
  } catch {
    return null;
  }
}

// trimClipAI 是更高层的函数，包含完整的决策树（含 passthrough / first_skip / fallback）
type TrimClipAIFn = (
  entry: AITrimEntry & { fid: string },
  position: "first" | "middle" | "closing",
  opts: {
    maxClipSec?: number;
    promptVersion?: string;
    aiClient?: FakeAIClient;
  },
) => Promise<AITrimResult>;

async function tryLoadTrimClipAI(): Promise<TrimClipAIFn | null> {
  try {
    const mod = await import("../cli/vlog/lib/smart-trim-ai");
    const fn = (mod as Record<string, unknown>).trimClipAI;
    if (typeof fn === "function") {
      return fn as TrimClipAIFn;
    }
    return null;
  } catch {
    return null;
  }
}

describe("C4: Qwen 异常 → fallback（4 种异常）", () => {
  describe("导出契约", () => {
    it("smart-trim-ai 模块必须导出 pickTrimWithAI 或 trimClipAI 函数", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      const hasPick = typeof (mod as Record<string, unknown>).pickTrimWithAI === "function";
      const hasTrim = typeof (mod as Record<string, unknown>).trimClipAI === "function";
      expect(hasPick || hasTrim).toBe(true);
    });
  });

  describe("异常 1：Qwen 超时 → fallbackReason='timeout'", () => {
    it("Qwen 调用超时 → source='fallback', fallbackReason='timeout'（不抛异常）", async () => {
      const pickTrim = await tryLoadPickTrimWithAI();
      if (!pickTrim) {
        console.warn("[跳过] pickTrimWithAI 未导出，此测试需要实现层暴露该函数");
        return;
      }

      // 注入超时的 fake aiClient
      const timeoutClient: FakeAIClient = {
        chat: vi.fn().mockImplementation(async (_opts: unknown, signal: AbortSignal) => {
          // 模拟永远不完成的请求，等待 signal 被 abort
          return new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
            // 如果没有 signal，等待很久
            setTimeout(() => reject(new Error("timeout")), 60000);
          });
        }),
      };

      // 用极短 timeout（1ms）触发超时
      const controller = new AbortController();
      controller.abort(); // 立即 abort

      const entry: AITrimEntry = {
        sha256: "a".repeat(64),
        durationSec: 200,
        transcript: { segments: makeSegments200s() },
      };

      const result = await pickTrim(entry, "middle", 120, "v2", controller.signal, timeoutClient);

      // fallback 应返回非 null（回退到 smartTrimWindow，不中断流水线）
      // 或者 pickTrimWithAI 返回 null（由上层处理 fallback）
      // 两种实现都可接受
      if (result !== null) {
        expect(result.source).toBe("fallback");
        expect(result.fallbackReason).toBe("timeout");
      }
      // 如果返回 null，上层会用 fallback，也是合法的
    });
  });

  describe("trimClipAI 高层 fallback 测试（含 fallbackReason 断言）", () => {
    it("Qwen 超时 → source='fallback', fallbackReason='timeout'", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const abortedClient: FakeAIClient = {
        chat: vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
      };

      const entry = {
        fid: "test_fid_timeout",
        sha256: "a".repeat(64),
        durationSec: 200,
        transcript: { segments: makeSegments200s() },
      };

      const result = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: abortedClient,
      });

      expect(result.source).toBe("fallback");
      expect(result.fallbackReason).toBe("timeout");
    });

    it("Qwen 返回非法 JSON → source='fallback', fallbackReason='invalid_json'", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const badJsonClient: FakeAIClient = {
        chat: vi.fn().mockResolvedValue({
          content: "这不是 JSON {broken json",
        }),
      };

      const entry = {
        fid: "test_fid_invalid_json",
        sha256: "b".repeat(64),
        durationSec: 200,
        transcript: { segments: makeSegments200s() },
      };

      const result = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: badJsonClient,
      });

      expect(result.source).toBe("fallback");
      expect(result.fallbackReason).toBe("invalid_json");
    });

    it("Qwen 返回 schema 不符的 JSON → source='fallback', fallbackReason='schema_error'", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      // 返回格式正确的 JSON，但 schema 不符（缺 endSec）
      const schemaErrorClient: FakeAIClient = {
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify({ startSec: 10 }), // 缺 endSec
        }),
      };

      const entry = {
        fid: "test_fid_schema_error",
        sha256: "c".repeat(64),
        durationSec: 200,
        transcript: { segments: makeSegments200s() },
      };

      const result = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: schemaErrorClient,
      });

      expect(result.source).toBe("fallback");
      expect(result.fallbackReason).toBe("schema_error");
    });

    it("Qwen 返回 range invalid (startSec >= endSec) → fallbackReason='range_invalid'", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      // startSec >= endSec（无效区间）
      const rangeInvalidClient: FakeAIClient = {
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            startSec: 100,
            endSec: 80, // endSec < startSec
            reason: "测试无效区间",
          }),
        }),
      };

      const entry = {
        fid: "test_fid_range_invalid",
        sha256: "d".repeat(64),
        durationSec: 200,
        transcript: { segments: makeSegments200s() },
      };

      const result = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: rangeInvalidClient,
      });

      expect(result.source).toBe("fallback");
      expect(result.fallbackReason).toBe("range_invalid");
    });
  });

  describe("B3 修复：fallback 按 position 用对应软上限", () => {
    it("closing clip duration=200s + Qwen 超时 → fallback 用 180s 软上限，endSec ≥ 175s（不被 middle 的 120s 截断）", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出，跳过 B3 修复验证");
        return;
      }

      // 构建 closing 场景：200s 视频，说话密集分布在 170-198s（告别场景）
      const closingSegments: TranscriptSegment[] = [
        makeSeg(5, 20, "进入场景"),
        makeSeg(25, 50, "中段对白"),
        makeSeg(55, 90, "继续对白"),
        makeSeg(95, 130, "更多内容"),
        makeSeg(135, 165, "过渡段"),
        makeSeg(170, 185, "告别1：要走了"),
        makeSeg(186, 192, "告别2：想去对面啊，好"),
        makeSeg(193, 198, "告别3：走吧"),
      ];

      const abortedClient: FakeAIClient = {
        chat: vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
      };

      const entry = {
        fid: "closing_200s",
        sha256: "e".repeat(64),
        durationSec: 200,
        transcript: { segments: closingSegments },
      };

      const result = await trimClipAI(entry, "closing", {
        maxClipSec: 120, // 全局参数，但 closing fallback 不用此值
        promptVersion: "v2",
        aiClient: abortedClient,
      });

      expect(result.source).toBe("fallback");
      expect(result.fallbackReason).toBe("timeout");
      // 关键：closing fallback 用 180s 软上限，而非 120s
      // 因此 endSec 应 >= 175（不被 120s 截断）
      expect(result.endSec).toBeGreaterThanOrEqual(175);
    });

    it("middle clip duration=200s + Qwen 超时 → fallback 用 120s 软上限，endSec - startSec ≤ 120", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const abortedClient: FakeAIClient = {
        chat: vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
      };

      const entry = {
        fid: "middle_200s",
        sha256: "f".repeat(64),
        durationSec: 200,
        transcript: { segments: makeSegments200s() },
      };

      const result = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: abortedClient,
      });

      expect(result.source).toBe("fallback");
      expect(result.fallbackReason).toBe("timeout");
      // middle fallback 用 120s 上限
      expect(result.endSec - result.startSec).toBeLessThanOrEqual(120 + 0.01);
    });

    it("fallback 不抛异常，始终返回合法结果（不中断流水线）", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const errorClient: FakeAIClient = {
        chat: vi.fn().mockRejectedValue(new Error("Network error")),
      };

      const entry = {
        fid: "pipeline_test",
        sha256: "g".repeat(64),
        durationSec: 150,
        transcript: { segments: makeSegments200s() },
      };

      // 不应抛异常
      await expect(
        trimClipAI(entry, "middle", {
          maxClipSec: 120,
          promptVersion: "v2",
          aiClient: errorClient,
        }),
      ).resolves.toBeDefined();
    });
  });
});

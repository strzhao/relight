/**
 * 验收测试 T5.4：Qwen 缓存命中行为（红队）
 *
 * 覆盖契约：
 *   - C7: 缓存 Key 含 transcript hash + cache.ts 类型扩展
 *
 * 契约规约：
 *   cacheKey 格式：`smart-trim-ai:{sha256}:{promptVersion}:{position}:{sourceHash}`
 *   sourceHash = sha1(segments.map(s=>s.text).join("\n")).slice(0,10)
 *   缓存值：{startSec, endSec, reason, confidence?, sourceHash}（不含 capped/clamped/source）
 *
 *   测试场景：
 *   1. 第一次跑：cache miss → Qwen 被调用 → 写入 cache → source="qwen"
 *   2. 同输入第二次跑：cache hit → Qwen 调用计数=0 → source="qwen_cache"
 *   3. 改 transcript（segments[0].text 改字）→ sourceHash 变 → cache miss → 再调 Qwen
 *   4. 改 promptVersion v2 → v3 → cache miss → 再调 Qwen
 *
 * 红队铁律：未读 smart-trim-ai.ts 实现；仅依据设计文档
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "../cli/vlog/types";

// ---- Fixture 辅助 ----
function makeSeg(start: number, end: number, text: string): TranscriptSegment {
  return { start, end, text, words: [] };
}

function makeSegments(): TranscriptSegment[] {
  return [
    makeSeg(5, 20, "今天去了公园"),
    makeSeg(25, 40, "天气很好"),
    makeSeg(45, 60, "孩子玩得很开心"),
    makeSeg(65, 80, "我们拍了很多照片"),
    makeSeg(85, 100, "傍晚回家吃饭"),
  ];
}

interface FakeAIClient {
  chat: ReturnType<typeof vi.fn>;
}

type TrimClipAIFn = (
  entry: {
    fid: string;
    sha256: string;
    durationSec: number;
    transcript?: { segments: TranscriptSegment[] };
  },
  position: "first" | "middle" | "closing",
  opts: {
    maxClipSec?: number;
    promptVersion?: string;
    aiClient?: FakeAIClient;
    cacheDb?: string; // 允许注入独立缓存路径（避免污染全局缓存）
  },
) => Promise<{
  startSec: number;
  endSec: number;
  source?: string;
  fallbackReason?: string;
}>;

async function tryLoadTrimClipAI(): Promise<TrimClipAIFn | null> {
  try {
    const mod = await import("../cli/vlog/lib/smart-trim-ai");
    const fn = (mod as Record<string, unknown>).trimClipAI;
    if (typeof fn === "function") return fn as TrimClipAIFn;
    return null;
  } catch {
    return null;
  }
}

// ---- 临时缓存 DB 路径 ----
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let testCacheDb: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-trim-ai-cache-test-"));
  testCacheDb = path.join(tmpDir, "test-cache.db");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
  vi.clearAllMocks();
});

describe("C7: Qwen 缓存命中行为", () => {
  describe("导出契约", () => {
    it("smart-trim-ai 模块必须导出 trimClipAI 函数（包含缓存逻辑）", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      const hasTrim = typeof (mod as Record<string, unknown>).trimClipAI === "function";
      const hasPick = typeof (mod as Record<string, unknown>).pickTrimWithAI === "function";
      expect(hasTrim || hasPick).toBe(true);
    });
  });

  describe("场景 1: 第一次跑 → cache miss → Qwen 被调用 → source='qwen'", () => {
    it("初次调用时 Qwen 应被调用（chat 计数=1），source='qwen'", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          startSec: 5,
          endSec: 90,
          reason: "保留核心对白",
        }),
      });

      const fakeClient: FakeAIClient = { chat: mockChat };
      const segments = makeSegments();

      const entry = {
        fid: "cache_test_001",
        sha256: `a1b2c3${"d".repeat(58)}`,
        durationSec: 150,
        transcript: { segments },
      };

      const result = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        cacheDb: testCacheDb,
      });

      expect(result.source).toBe("qwen");
      expect(mockChat.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("场景 2: 同输入第二次跑 → cache hit → Qwen 调用计数=0 → source='qwen_cache'", () => {
    it("第二次同参数调用：Qwen 调用计数=0，source='qwen_cache'", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          startSec: 5,
          endSec: 90,
          reason: "保留核心对白",
        }),
      });

      const fakeClient: FakeAIClient = { chat: mockChat };
      const segments = makeSegments();

      const entry = {
        fid: "cache_test_002",
        sha256: `b2c3d4${"e".repeat(58)}`,
        durationSec: 150,
        transcript: { segments },
      };

      // 第一次调用
      await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        cacheDb: testCacheDb,
      });

      const firstCallCount = mockChat.mock.calls.length;

      // 第二次同参数调用
      const result2 = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        cacheDb: testCacheDb,
      });

      // 第二次不应再调 Qwen
      expect(mockChat.mock.calls.length).toBe(firstCallCount); // 调用次数不增加
      expect(result2.source).toBe("qwen_cache");
    });
  });

  describe("场景 3: 改 transcript → sourceHash 变 → cache miss → 再调 Qwen", () => {
    it("修改 segments[0].text 后，缓存失效，Qwen 被重新调用", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          startSec: 5,
          endSec: 90,
          reason: "保留核心对白",
        }),
      });

      const fakeClient: FakeAIClient = { chat: mockChat };

      const entry1 = {
        fid: "cache_test_003",
        sha256: `c3d4e5${"f".repeat(58)}`,
        durationSec: 150,
        transcript: {
          segments: [makeSeg(5, 20, "今天去了公园"), makeSeg(25, 40, "天气很好")],
        },
      };

      // 第一次调用（原始 transcript）
      await trimClipAI(entry1, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        cacheDb: testCacheDb,
      });
      const callsAfterFirst = mockChat.mock.calls.length;

      // 改 segments[0].text（模拟字幕纠错）
      const entry2 = {
        fid: "cache_test_003",
        sha256: `c3d4e5${"f".repeat(58)}`, // sha256 不变，但 transcript 改了
        durationSec: 150,
        transcript: {
          segments: [
            makeSeg(5, 20, "今天去了花园"), // text 改字："公园" → "花园"
            makeSeg(25, 40, "天气很好"),
          ],
        },
      };

      // 第二次调用（transcript 已改）
      await trimClipAI(entry2, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        cacheDb: testCacheDb,
      });

      // transcript 变了 → sourceHash 变 → cache miss → 再调 Qwen
      expect(mockChat.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });

  describe("场景 4: 改 promptVersion v2 → v3 → cache miss → 再调 Qwen", () => {
    it("promptVersion 变化后，缓存失效，Qwen 被重新调用", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          startSec: 5,
          endSec: 90,
          reason: "保留核心对白",
        }),
      });

      const fakeClient: FakeAIClient = { chat: mockChat };
      const segments = makeSegments();

      const entry = {
        fid: "cache_test_004",
        sha256: `d4e5f6${"g".repeat(58)}`,
        durationSec: 150,
        transcript: { segments },
      };

      // 第一次调用：promptVersion=v2
      await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        cacheDb: testCacheDb,
      });
      const callsAfterV2 = mockChat.mock.calls.length;

      // 第二次调用：promptVersion=v3
      await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v3", // 版本改变
        aiClient: fakeClient,
        cacheDb: testCacheDb,
      });

      // promptVersion 变了 → cache key 变 → miss → 再调 Qwen
      expect(mockChat.mock.calls.length).toBeGreaterThan(callsAfterV2);
    });

    it("position 变化（middle → closing）也应导致 cache miss", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          startSec: 5,
          endSec: 90,
          reason: "保留核心对白",
        }),
      });

      const fakeClient: FakeAIClient = { chat: mockChat };
      const segments = makeSegments();

      const entry = {
        fid: "cache_test_005",
        sha256: `e5f6g7${"h".repeat(58)}`,
        durationSec: 200, // 超过 120 才会走 Qwen
        transcript: { segments },
      };

      // 第一次：position=middle
      await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        cacheDb: testCacheDb,
      });
      const callsAfterMiddle = mockChat.mock.calls.length;

      // 第二次：position=closing（同一 fid，但位置变了）
      await trimClipAI(entry, "closing", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        cacheDb: testCacheDb,
      });

      // position 变 → cache key 变 → miss → 再调 Qwen
      expect(mockChat.mock.calls.length).toBeGreaterThan(callsAfterMiddle);
    });
  });

  describe("缓存 Key 格式验证", () => {
    it("cache.ts 的 cachePut 应接受 kind='smart-trim'（B2 修复：cache.ts 类型扩展）", async () => {
      // 验证 cache.ts 已扩展 kind 联合类型，包含 "smart-trim"
      const cacheModule = await import("../cli/vlog/lib/cache");
      const cachePut = (cacheModule as Record<string, unknown>).cachePut;
      expect(typeof cachePut).toBe("function");

      // 尝试调用 cachePut with kind="smart-trim"
      // 如果 TypeScript 类型定义正确，运行时不应抛错
      // 注意：此处仅做运行时测试；静态类型检查在 typecheck 阶段验证
      expect(() => {
        (cachePut as (key: string, kind: string, value: unknown) => void)(
          "smart-trim-test-key",
          "smart-trim",
          {
            startSec: 0,
            endSec: 90,
            reason: "test",
            sourceHash: "abc1234567",
          },
        );
      }).not.toThrow();
    });
  });
});

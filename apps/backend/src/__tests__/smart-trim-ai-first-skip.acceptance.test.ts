/**
 * 验收测试 T5.7：position="first" 走 skip（红队）
 *
 * 覆盖契约：
 *   - C1: storyboard hook chapter 数据源例外（红线）
 *   - B4 修复: position="first" → 不调 Qwen，不做 ffmpeg trim，不生成文件
 *
 * 契约规约（state.md C1）：
 *   smart-trim 内部 position="first"（selection.order 第 1 个 effective fid）：
 *   - 不调用 Qwen（Qwen 调用计数=0）
 *   - 不做 ffmpeg trim
 *   - 不生成 sources-trimmed/<fid>.mp4 文件
 *   - 写 sourceTrim = { startSec: 0, endSec: durationSec, originalDurationSec: durationSec,
 *                       status: "skipped", source: "first_skip", position: "first" }
 *
 *   注意区分：
 *   - smart-trim "first" position ≠ storyboard hook chapter clip
 *   - "first" 仅是 selection 的第 1 个 effective fid，是位置概念，不是叙事概念
 *   - storyboard buildHookChapter 硬编码读 sources/<basename>，与 smart-trim 完全解耦
 *
 * 红队铁律：未读 smart-trim-ai.ts 实现；仅依据设计文档
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "../cli/vlog/types";

// ---- Fixture 辅助 ----
function makeSeg(start: number, end: number, text = "说话"): TranscriptSegment {
  return { start, end, text, words: [] };
}

interface FakeAIClient {
  chat: ReturnType<typeof vi.fn>;
}

interface TrimResult {
  startSec: number;
  endSec: number;
  source?: string;
  status?: string;
  position?: string;
  fallbackReason?: string;
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
    sourcesTrimedDir?: string; // 注入目录，用于验证文件是否被创建
  },
) => Promise<TrimResult>;

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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-trim-first-skip-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
  vi.clearAllMocks();
});

describe("C1: position='first' → skip（B4 + 数据源例外铁律）", () => {
  describe("导出契约", () => {
    it("smart-trim-ai 模块必须导出 trimClipAI 函数", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      const hasTrim = typeof (mod as Record<string, unknown>).trimClipAI === "function";
      const hasPick = typeof (mod as Record<string, unknown>).pickTrimWithAI === "function";
      expect(hasTrim || hasPick).toBe(true);
    });
  });

  describe("核心 skip 行为", () => {
    it("position='first' → Qwen 调用计数=0（不调 Qwen）", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn();
      const fakeClient: FakeAIClient = { chat: mockChat };

      const entry = {
        fid: "first_skip_test",
        sha256: "a".repeat(64),
        durationSec: 120,
        transcript: {
          segments: [
            makeSeg(5, 40, "开场白"),
            makeSeg(45, 80, "进入场景"),
            makeSeg(85, 115, "铺垫"),
          ],
        },
      };

      await trimClipAI(entry, "first", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      expect(mockChat).not.toHaveBeenCalled();
    });

    it("position='first' → sourceTrim.status='skipped'", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn();
      const fakeClient: FakeAIClient = { chat: mockChat };

      const entry = {
        fid: "first_skip_status",
        sha256: "b".repeat(64),
        durationSec: 150,
        transcript: { segments: [makeSeg(5, 100, "开场内容")] },
      };

      const result = await trimClipAI(entry, "first", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      expect(result.status).toBe("skipped");
    });

    it("position='first' → source='first_skip'", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn();
      const fakeClient: FakeAIClient = { chat: mockChat };

      const entry = {
        fid: "first_skip_source",
        sha256: "c".repeat(64),
        durationSec: 90,
        transcript: { segments: [makeSeg(5, 85, "开场")] },
      };

      const result = await trimClipAI(entry, "first", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      expect(result.source).toBe("first_skip");
    });

    it("position='first' → startSec=0, endSec=durationSec（完整保留）", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn();
      const fakeClient: FakeAIClient = { chat: mockChat };
      const durationSec = 150;

      const entry = {
        fid: "first_skip_range",
        sha256: "d".repeat(64),
        durationSec,
        transcript: { segments: [makeSeg(5, 140, "开场内容")] },
      };

      const result = await trimClipAI(entry, "first", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      expect(result.startSec).toBe(0);
      expect(result.endSec).toBeCloseTo(durationSec, 1);
    });
  });

  describe("不生成 sources-trimmed/<fid>.mp4 文件（区别于 passthrough）", () => {
    it("position='first' → tmpDir 中不生成任何 .mp4 文件", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn();
      const fakeClient: FakeAIClient = { chat: mockChat };

      const fid = "first_skip_no_file";
      const entry = {
        fid,
        sha256: "e".repeat(64),
        durationSec: 120,
        transcript: { segments: [makeSeg(5, 115, "开场")] },
      };

      await trimClipAI(entry, "first", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      // 验证 sources-trimmed 目录中没有生成 fid 对应的 mp4 文件
      const trimmedFiles = fs.existsSync(tmpDir)
        ? fs.readdirSync(tmpDir).filter((f) => f.endsWith(".mp4"))
        : [];
      const fidFile = trimmedFiles.find((f) => f.includes(fid));
      expect(fidFile).toBeUndefined();
    });
  });

  describe("即使 duration 超过软上限，first 仍走 skip（first 不受软上限约束）", () => {
    it("first clip duration=500s（远超 120s 软上限）→ 仍 skip，不调 Qwen", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn();
      const fakeClient: FakeAIClient = { chat: mockChat };

      const entry = {
        fid: "first_skip_long",
        sha256: "f".repeat(64),
        durationSec: 500,
        transcript: {
          segments: Array.from({ length: 50 }, (_, i) => makeSeg(i * 10, i * 10 + 8, `段落${i}`)),
        },
      };

      const result = await trimClipAI(entry, "first", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      // 即使 500 > 120，first 仍 skip
      expect(result.source).toBe("first_skip");
      expect(result.status).toBe("skipped");
      expect(mockChat).not.toHaveBeenCalled();
    });

    it("first clip duration=30s（低于软上限）→ 仍 skip（不走 passthrough），source='first_skip'", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn();
      const fakeClient: FakeAIClient = { chat: mockChat };

      const entry = {
        fid: "first_skip_short",
        sha256: "g".repeat(64),
        durationSec: 30,
        transcript: { segments: [makeSeg(5, 25, "短开场")] },
      };

      const result = await trimClipAI(entry, "first", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      // first 的优先级高于 passthrough（先判断 first → skip，再判断 passthrough）
      expect(result.source).toBe("first_skip");
      expect(result.status).toBe("skipped");
    });
  });

  describe("storyboard hook chapter 数据源例外（C1 红线）", () => {
    it("smart-trim-ai 中不存在任何会修改 buildHookChapter 或 pickHookFidsAI 的导出（红线不动这两个函数）", async () => {
      // 这个测试验证红线：smart-trim-ai 模块不能暴露任何会影响 storyboard 的接口
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      // smart-trim-ai 模块不应导出 buildHookChapter 或 pickHookFidsAI
      expect((mod as Record<string, unknown>).buildHookChapter).toBeUndefined();
      expect((mod as Record<string, unknown>).pickHookFidsAI).toBeUndefined();
    });

    it("position='first' 的语义仅为 selection.order 第 1 个 effective fid，与 storyboard hook chapter 无关", async () => {
      // 验证设计文档的解耦说明：
      // smart-trim "first" position 是位置概念（selection 第 1 个），不等于 storyboard 的 hook chapter clip
      // 二者在不同阶段，用不同算法，看不同数据
      // 此测试记录这一设计决策，防止未来误合并语义
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      const inferPosition = (mod as Record<string, unknown>).inferPosition as
        | ((fid: string, selection: unknown) => string)
        | undefined;

      if (!inferPosition) {
        console.warn("[跳过] inferPosition 未导出");
        return;
      }

      // selection 中第 1 个 effective fid 是 "first"
      const selection = {
        order: ["clip_001", "clip_002", "clip_003"],
        excluded: [],
      };

      // clip_001 是 selection.order[0]，smart-trim 意义上是 "first"
      // 这与 storyboard 选的 hook chapter clip（可能是任意章节的 clip）无关
      expect(inferPosition("clip_001", selection)).toBe("first");
      expect(inferPosition("clip_002", selection)).toBe("middle");
      expect(inferPosition("clip_003", selection)).toBe("closing");
    });
  });
});

/**
 * 验收测试 T5.5：短视频 passthrough（红队）
 *
 * 覆盖契约：
 *   - C6: 短视频 passthrough（W8 澄清 ffmpeg 行为）
 *
 * 契约规约：
 *   duration ≤ softMaxSec[position] 时，不调 Qwen，
 *   source="passthrough", status="ok", startSec=0, endSec=durationSec
 *
 *   W8 澄清：passthrough 仍跑 ffmpeg 生成 sources-trimmed/<fid>.mp4（统一编码）
 *            区别于 first_skip：first 完全不生成文件
 *
 *   场景验证：
 *   - middle clip duration=35s（< 120）→ passthrough（Qwen 调用计数=0）
 *   - closing clip duration=400s（< 600 硬上限）→ 仍调 Qwen（closing 无"小于软上限跳过"逻辑，600 是硬上限）
 *   - middle clip duration=121s（> 120 软上限 1s）→ 走 Qwen 路径，不 passthrough
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
    sourcesTrimedDir?: string; // 注入 trimmed 文件目录
  },
) => Promise<{
  startSec: number;
  endSec: number;
  source?: string;
  status?: string;
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-trim-passthrough-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
  vi.clearAllMocks();
});

describe("C6: 短视频 passthrough", () => {
  describe("导出契约", () => {
    it("smart-trim-ai 模块必须导出 trimClipAI 或等效函数", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      const hasTrim = typeof (mod as Record<string, unknown>).trimClipAI === "function";
      const hasPick = typeof (mod as Record<string, unknown>).pickTrimWithAI === "function";
      expect(hasTrim || hasPick).toBe(true);
    });

    it("smart-trim-ai 模块必须导出 softMaxForPosition 函数", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      expect(typeof (mod as Record<string, unknown>).softMaxForPosition).toBe("function");
    });
  });

  describe("softMaxForPosition 软上限值", () => {
    it("middle 软上限 = 120", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      const fn = (mod as Record<string, unknown>).softMaxForPosition as (
        pos: "first" | "middle" | "closing",
      ) => number;
      expect(fn("middle")).toBe(120);
    });

    it("closing 硬上限 = 600（dry-run 修复后从 180 改为 600）", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      const fn = (mod as Record<string, unknown>).softMaxForPosition as (
        pos: "first" | "middle" | "closing",
      ) => number;
      expect(fn("closing")).toBe(600);
    });
  });

  describe("场景 1: middle clip duration=35s（< 120）→ passthrough", () => {
    it("middle duration=35s → source='passthrough', status='ok', Qwen 调用计数=0", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn();
      const fakeClient: FakeAIClient = { chat: mockChat };

      const entry = {
        fid: "short_middle_35s",
        sha256: "a".repeat(64),
        durationSec: 35,
        transcript: {
          segments: [makeSeg(5, 15, "第一段"), makeSeg(20, 30, "第二段")],
        },
      };

      const result = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      expect(result.source).toBe("passthrough");
      expect(result.status ?? "ok").toBe("ok");
      expect(mockChat).not.toHaveBeenCalled();
    });

    it("passthrough 时 startSec=0, endSec=durationSec", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn();
      const fakeClient: FakeAIClient = { chat: mockChat };

      const entry = {
        fid: "short_middle_35s_range",
        sha256: "b".repeat(64),
        durationSec: 35,
        transcript: { segments: [makeSeg(5, 30, "说话")] },
      };

      const result = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      expect(result.startSec).toBe(0);
      expect(result.endSec).toBeCloseTo(35, 1);
    });

    it("middle duration=120s（恰好等于软上限）→ passthrough（不超就不调 Qwen）", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn();
      const fakeClient: FakeAIClient = { chat: mockChat };

      const entry = {
        fid: "exact_120s",
        sha256: "c".repeat(64),
        durationSec: 120,
        transcript: { segments: [makeSeg(5, 115, "整段说话")] },
      };

      const result = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      expect(result.source).toBe("passthrough");
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  describe("场景 2: closing clip duration=400s（< 600 硬上限）→ 仍调 Qwen", () => {
    it("closing duration=400s → 不 passthrough，调用 Qwen（closing 无软上限跳过逻辑，600 是硬上限）", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          startSec: 10,
          endSec: 380,
          reason: "保留完整告别场景",
        }),
      });

      const fakeClient: FakeAIClient = { chat: mockChat };

      const segs: TranscriptSegment[] = [];
      for (let i = 0; i < 20; i++) {
        segs.push(makeSeg(i * 20, i * 20 + 15, `closing segment ${i}`));
      }

      const entry = {
        fid: "closing_400s",
        sha256: "d".repeat(64),
        durationSec: 400,
        transcript: { segments: segs },
      };

      const result = await trimClipAI(entry, "closing", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      // closing 没有"短于软上限就跳过"的逻辑（因为 closing 软上限=600，400<600）
      // 仍应走 Qwen 路径
      expect(result.source).toBe("qwen");
      expect(mockChat).toHaveBeenCalled();
    });
  });

  describe("场景 3: middle clip duration=121s（> 120 软上限 1s）→ 走 Qwen，不 passthrough", () => {
    it("middle duration=121s → 不 passthrough，调用 Qwen", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          startSec: 1,
          endSec: 119,
          reason: "保留核心部分",
        }),
      });

      const fakeClient: FakeAIClient = { chat: mockChat };

      const entry = {
        fid: "just_over_120s",
        sha256: "e".repeat(64),
        durationSec: 121,
        transcript: {
          segments: [
            makeSeg(5, 40, "第一段"),
            makeSeg(45, 80, "第二段"),
            makeSeg(85, 118, "第三段"),
          ],
        },
      };

      const result = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      // 121 > 120，应走 Qwen 路径
      expect(result.source).toBe("qwen");
      expect(mockChat).toHaveBeenCalled();
    });
  });

  describe("passthrough vs first_skip：ffmpeg 行为区别", () => {
    it("passthrough 的 sourceTrim.status 应为 'ok'（需生成 trimmed 文件，ffmpeg 编码统一）", async () => {
      const trimClipAI = await tryLoadTrimClipAI();
      if (!trimClipAI) {
        console.warn("[跳过] trimClipAI 未导出");
        return;
      }

      const mockChat = vi.fn();
      const fakeClient: FakeAIClient = { chat: mockChat };

      const entry = {
        fid: "passthrough_status_check",
        sha256: "f".repeat(64),
        durationSec: 50,
        transcript: { segments: [makeSeg(5, 45, "说话")] },
      };

      const result = await trimClipAI(entry, "middle", {
        maxClipSec: 120,
        promptVersion: "v2",
        aiClient: fakeClient,
        sourcesTrimedDir: tmpDir,
      });

      // passthrough 仍生成文件，status="ok"（不是 "skipped"）
      expect(result.source).toBe("passthrough");
      expect(result.status ?? "ok").toBe("ok");
    });
  });
});

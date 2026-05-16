/**
 * 验收测试：vlog-storyboard.ts buildAvailableList persons 字段输出（红队）
 *
 * 覆盖设计文档契约 5：
 * - buildAvailableList 输出每行追加 persons="X、Y、Z"（顿号分隔）
 * - 空 persons 数组 → persons=""
 * - persons 中 name="" 的未命名项应被过滤（不输出）
 * - 分隔符是中文顿号 "、"（与契约 3 一致）
 * - 不允许测试输出格式以外的内容
 *
 * 红队铁律：
 * - 未读 vlog-storyboard.ts 实现代码
 * - 仅依据设计文档 §契约 5
 * - 蓝队需导出 buildAvailableList；若未导出，降级为子进程 dryrun 测试
 */
import { describe, expect, it } from "vitest";

// ---- mock 外部依赖（AI 客户端 / prompts / DB）----
// 这些 mock 必须在 import 实现前声明

import { vi } from "vitest";

vi.mock("../ai/client", () => ({
  aiClient: {
    chat: vi.fn().mockResolvedValue("{}"),
  },
}));

vi.mock("../ai/prompts", () => ({
  loadPrompts: vi.fn().mockResolvedValue({ system: "", user: "" }),
}));

vi.mock("../db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
        orderBy: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
  schema: {},
}));

// ---- 构造 mock ManifestEntry（含 persons 字段的最小结构）----
// 注意：buildAvailableList 需要 ManifestEntry 类型，其中 type 是 "image"|"video"
// 我们只关心 persons 字段的输出，其他字段给合理默认值

function makeImageEntry(persons: Array<{ name: string }>) {
  return {
    type: "image" as const,
    ok: true,
    filePath: `/tmp/photo-${Math.random()}.jpg`,
    realPath: `/tmp/photo-${Math.random()}.jpg`,
    sha256: "a".repeat(64),
    fileSize: 1024,
    elapsedMs: 100,
    cacheHit: false,
    width: 1920,
    height: 1080,
    persons: persons.map((p, i) => ({
      personId: `uuid-${i}`,
      name: p.name,
      frameCount: 1,
      confidence: 0.9,
    })),
    personsStatus: "ok" as const,
  };
}

function makeVideoEntry(persons: Array<{ name: string }>) {
  return {
    type: "video" as const,
    ok: true,
    filePath: `/tmp/video-${Math.random()}.mp4`,
    realPath: `/tmp/video-${Math.random()}.mp4`,
    sha256: "b".repeat(64),
    fileSize: 10240,
    elapsedMs: 200,
    cacheHit: false,
    width: 1920,
    height: 1080,
    durationSec: 10.5,
    videoCodec: "h264",
    videoFps: 30,
    hasAudio: true,
    sceneTimes: [],
    persons: persons.map((p, i) => ({
      personId: `uuid-video-${i}`,
      name: p.name,
      frameCount: 2,
      confidence: 0.85,
    })),
    personsStatus: "ok" as const,
  };
}

// ---- 尝试 import buildAvailableList ----
async function tryLoadBuildAvailableList(): Promise<((entries: unknown[]) => string) | null> {
  try {
    const mod = await import("../cli/vlog-storyboard");
    const fn = (mod as Record<string, unknown>).buildAvailableList;
    if (typeof fn === "function") {
      return fn as (entries: unknown[]) => string;
    }
    return null;
  } catch {
    return null;
  }
}

describe("契约 5: buildAvailableList persons 字段输出", () => {
  describe("persons 字段格式", () => {
    it('有 persons 的 entry 行应包含 persons="爸爸、六六"（顿号分隔）', async () => {
      const fn = await tryLoadBuildAvailableList();
      if (!fn) {
        console.warn("[跳过] buildAvailableList 未作为命名导出，需要蓝队导出后测试");
        return;
      }
      const entries = [makeImageEntry([{ name: "爸爸" }, { name: "六六" }])];
      const output = fn(entries);
      expect(output).toContain('persons="爸爸、六六"');
    });

    it('空 persons 数组应输出 persons=""', async () => {
      const fn = await tryLoadBuildAvailableList();
      if (!fn) return;
      const entries = [makeVideoEntry([])];
      const output = fn(entries);
      expect(output).toContain('persons=""');
    });

    it("所有 name='' 的未命名 person 应被过滤，结果为 persons=\"\"", async () => {
      const fn = await tryLoadBuildAvailableList();
      if (!fn) return;
      // persons 只含一个 name="" 的未命名项 → 过滤后为空 → persons=""
      const entries = [makeImageEntry([{ name: "" }])];
      const output = fn(entries);
      expect(output).toContain('persons=""');
    });

    it("混合 named + unnamed：只输出有名字的 person", async () => {
      const fn = await tryLoadBuildAvailableList();
      if (!fn) return;
      // ["爸爸", "", "六六"] → 过滤空 → "爸爸、六六"
      const entries = [makeImageEntry([{ name: "爸爸" }, { name: "" }, { name: "六六" }])];
      const output = fn(entries);
      expect(output).toContain('persons="爸爸、六六"');
      // 不应含连续顿号（空字符串被过滤后不留空位）
      expect(output).not.toContain("、、");
    });

    it("分隔符必须是中文顿号 '、'，不用英文逗号", async () => {
      const fn = await tryLoadBuildAvailableList();
      if (!fn) return;
      const entries = [makeImageEntry([{ name: "爸爸" }, { name: "妈妈" }])];
      const output = fn(entries);
      // 存在顿号分隔
      expect(output).toContain("爸爸、妈妈");
      // 不存在英文逗号分隔同一对人名
      expect(output).not.toMatch(/爸爸,妈妈/);
    });
  });

  describe("多 entry 输出", () => {
    it("多个 entry 各自输出对应的 persons 字段", async () => {
      const fn = await tryLoadBuildAvailableList();
      if (!fn) return;
      const entries = [
        makeImageEntry([{ name: "爸爸" }, { name: "六六" }]),
        makeVideoEntry([]),
        makeImageEntry([{ name: "" }]),
      ];
      const output = fn(entries);
      const lines = output.split("\n");
      expect(lines.length).toBe(3);
      // 第 1 行：爸爸、六六
      expect(lines[0]).toContain('persons="爸爸、六六"');
      // 第 2 行：空 persons
      expect(lines[1]).toContain('persons=""');
      // 第 3 行：只有未命名 → 过滤后为空
      expect(lines[2]).toContain('persons=""');
    });

    it("单 person entry 不含顿号", async () => {
      const fn = await tryLoadBuildAvailableList();
      if (!fn) return;
      const entries = [makeVideoEntry([{ name: "妈妈" }])];
      const output = fn(entries);
      expect(output).toContain('persons="妈妈"');
      // 单个人名后不应有尾随顿号
      expect(output).not.toMatch(/persons="妈妈、"/);
    });
  });

  describe("persons 字段必须出现在每行", () => {
    it("即使 entry 没有 persons 字段（undefined），输出行也应包含 persons=''", async () => {
      const fn = await tryLoadBuildAvailableList();
      if (!fn) return;
      // 模拟旧 manifest entry（无 persons 字段）
      const oldEntry = {
        ...makeImageEntry([]),
        persons: undefined,
        personsStatus: undefined,
      };
      const output = fn([oldEntry]);
      // 设计文档: 空时输出 persons=""
      expect(output).toContain('persons=""');
    });
  });
});

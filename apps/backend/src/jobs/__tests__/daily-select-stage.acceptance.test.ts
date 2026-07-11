/**
 * 红队验收测试：runSelectStage — AI 从候选选 1 张 hero（阶段 1 评选）
 *
 * 设计契约来源（state.md，不读任何蓝队实现）：
 *
 * 契约签名（逐字一致）：
 *   export async function runSelectStage(
 *     candidates: ClusteredCandidate[],
 *     opts: { log: (m: string) => void; enabled: boolean }
 *   ): Promise<{
 *     ordered: ClusteredCandidate[];
 *     selectedIndex: number;
 *     reasoning: string;
 *     source: "ai" | "fallback";
 *   }>
 *
 * 边界（DbC 谓词）：
 *   - ordered.length === candidates.length；ordered 是 candidates 的置换（元素集合相同）
 *   - source === "ai" → ordered[0] === candidates[selectedIndex]，selectedIndex ∈ [0, n-1]
 *   - candidates.length < 2 → source="fallback", ordered 原序, selectedIndex=0, 零 AI 调用
 *   - enabled === false / chat 抛错 / 解析失败 / 越界 → source="fallback" 保序不抛
 *
 * 覆盖验收谓词：
 *   场景1.P2 [det-machine]: AI select 成功时 hero ≠ 纯公式 top1（构造 selectedIndex=非0 反例）
 *   场景2.P1: AI select 抛错/非法 → 回退公式排序，不抛错
 *   场景2.P2: 回退时 hero == 修正公式 top1（ordered 保持原序）
 *   场景2.P3: 日志含 fallback 关键词
 *   场景7.P2: select 输入含 tags/description/takenAt/score（buildSelectUserPrompt 产出含语义信息）
 *
 * 红队铁律：
 * - 不读 runSelectStage / buildSelectUserPrompt 实现体，仅按契约签名 import
 * - mock aiClient.chat（构造 selectedIndex=合法/越界/抛错/解析失败各种返回）
 * - mock loadPrompts 避免磁盘 IO
 * - Mutation-Survival：场景1.P2 断言 ordered[0]===candidates[selectedIndex]（而非 candidates[0]），
 *   kill "重排被跳过、ordered 原序返回" 的 no-op mutation
 */

import { describe, expect, it, vi } from "vitest";

// =====================================================================
// Hoisted mocks — 必须在 import 被测模块前注册
// =====================================================================

const mockChat = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockLoadPrompts = vi.hoisted(() =>
  vi.fn<(version?: string, name?: string) => Promise<{ system: string; user: string }>>(),
);

// daily-selection.ts 顶层 import 重依赖，stub 掉避免模块加载触发 new Database / sharp / storage
vi.mock("../../db", () => ({ db: {}, schema: {} }));
vi.mock("../../ai/client", () => ({
  aiClient: {
    chat: mockChat,
    analyzePhoto: vi.fn(),
  },
  RelightAIClient: class {
    chat = mockChat;
    analyzePhoto = vi.fn();
  },
}));
vi.mock("../../ai/prompts", () => ({
  loadPrompts: mockLoadPrompts,
}));
vi.mock("../../storage", () => ({
  createStorageAdapter: () => ({
    getFileBuffer: vi.fn(),
    getMimeType: vi.fn(() => "image/jpeg"),
    listFiles: vi.fn(async () => []),
    getMetadata: vi.fn(async () => ({})),
    computeFileHash: vi.fn(async () => "hash"),
  }),
}));
vi.mock("../storage-health", () => ({
  probeAllSources: vi.fn(async () => []),
}));
vi.mock("../../lib/raw", () => ({
  RAW_EXTENSIONS: [".dng"],
  extractRawPreview: vi.fn(),
}));

// loadPrompts 默认返回非空 prompt（避免 select 因 prompt 加载失败降级）
mockLoadPrompts.mockResolvedValue({ system: "你是回忆猎人", user: "候选：{列表}" });

// =====================================================================
// 候选构造辅助 — 构造满足 ClusteredCandidate 结构的测试数据
// （按 cluster.ts 的 ClusteredCandidate extends EnrichedCandidate 契约签名构造）
// =====================================================================

import type { ClusteredCandidate } from "../daily-selection/cluster";

function makeCandidate(
  photoId: string,
  opts: {
    aestheticScore?: number;
    yearsAgo?: number;
    weightedScore?: number;
    narrative?: string | null;
    tags?: Array<{ name: string }> | null;
    emotionalAnalysis?: { primary: string; secondary: string } | null;
    takenAt?: string | null;
  } = {},
): ClusteredCandidate {
  const {
    aestheticScore = 8.0,
    yearsAgo = 3,
    weightedScore,
    narrative = `${photoId} 的叙事描述`,
    tags = [{ name: "人像" }, { name: "户外" }],
    emotionalAnalysis = { primary: "温暖", secondary: "宁静" },
    takenAt = "2020-05-09T10:00:00Z",
  } = opts;
  return {
    photoId,
    filePath: `/photos/${photoId}.jpg`,
    takenAt,
    mediaType: "image",
    durationSec: null,
    aestheticScore,
    yearsAgo,
    weightedScore: weightedScore ?? aestheticScore,
    source: "historyToday",
    narrative,
    emotionalAnalysis,
    tags,
    thumbnailPath: `/tmp/thumb-${photoId}.jpg`,
    sourceType: "local",
    latitude: null,
    longitude: null,
    offsetTime: null,
    peopleNicknames: [],
    clusterSiblingIds: [],
  };
}

/**
 * 构造 select 阶段 AI 响应（```json 代码块包裹的 selectedIndex + reasoning）
 */
function makeSelectResponse(selectedIndex: number, reasoning = "年代感强，情感真实"): string {
  return `\`\`\`json\n${JSON.stringify({ selectedIndex, reasoning })}\n\`\`\``;
}

/**
 * 构造无法解析的 AI 响应（非 JSON，触发 parseDailySelectResponse 解析失败分支）
 */
function makeUnparseableResponse(): string {
  return "这不是一个 JSON 格式的响应，抱歉。";
}

// =====================================================================
// 场景 1：AI select 成功选出更有怀念厚度的主图（Happy Path）
// =====================================================================

describe("场景1 — runSelectStage AI 成功重排候选", () => {
  it("场景1.P2 [det-machine]: AI select 返回 selectedIndex=非0 时，ordered[0]===candidates[selectedIndex]（重排生效，非原序）", async () => {
    const { runSelectStage } = await import("../daily-selection");
    // 构造反例：candidates[0] weightedScore 最高（纯公式 top1），
    // 但 AI select 选中 candidates[2]（情感/年代更好）
    const candidates = [
      makeCandidate("formula-top1", { weightedScore: 9.0, aestheticScore: 9.0, yearsAgo: 1 }),
      makeCandidate("second", { weightedScore: 8.5, aestheticScore: 8.5, yearsAgo: 2 }),
      makeCandidate("ai-winner", { weightedScore: 8.0, aestheticScore: 8.0, yearsAgo: 10 }),
    ];

    mockChat.mockResolvedValueOnce(makeSelectResponse(2, "十年前的老合影情感更浓"));

    const log = vi.fn();
    const result = await runSelectStage(candidates, { log, enabled: true });

    // assert: source === "ai"
    expect(result.source).toBe("ai");
    // assert: selectedIndex ∈ [0, n-1]
    expect(result.selectedIndex).toBe(2);
    // 反空操作核心断言：ordered[0] === candidates[selectedIndex]（而非 candidates[0]）
    // kill "重排被跳过、ordered 原序返回 candidates[0]" 的 no-op mutation
    expect(result.ordered[0]!.photoId).toBe("ai-winner");
    expect(result.ordered[0]!.photoId).toBe(candidates[2]!.photoId);
    expect(result.ordered[0]!.photoId).not.toBe(candidates[0]!.photoId);
  });

  it("契约: ordered.length === candidates.length 且 ordered 是 candidates 的置换（元素集合相同）", async () => {
    const { runSelectStage } = await import("../daily-selection");
    const candidates = [
      makeCandidate("a", { weightedScore: 9.0 }),
      makeCandidate("b", { weightedScore: 8.0 }),
      makeCandidate("c", { weightedScore: 7.0 }),
      makeCandidate("d", { weightedScore: 6.0 }),
    ];

    mockChat.mockResolvedValueOnce(makeSelectResponse(1));
    const result = await runSelectStage(candidates, { log: vi.fn(), enabled: true });

    // assert: ordered.length === candidates.length
    expect(result.ordered).toHaveLength(candidates.length);
    // assert: ordered 是 candidates 的置换（photoId 集合相同）
    const orderedIds = result.ordered.map((c) => c.photoId).sort();
    const originalIds = candidates.map((c) => c.photoId).sort();
    expect(orderedIds).toEqual(originalIds);
  });

  it("契约: source==='ai' 时 ordered[0] === candidates[selectedIndex]，selectedIndex 合法", async () => {
    const { runSelectStage } = await import("../daily-selection");
    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeCandidate(`p${i}`, { weightedScore: 9 - i }),
    );

    mockChat.mockResolvedValueOnce(makeSelectResponse(3));
    const result = await runSelectStage(candidates, { log: vi.fn(), enabled: true });

    expect(result.source).toBe("ai");
    expect(result.selectedIndex).toBe(3);
    expect(result.selectedIndex).toBeGreaterThanOrEqual(0);
    expect(result.selectedIndex).toBeLessThanOrEqual(candidates.length - 1);
    // ordered[0] 恰是 candidates[selectedIndex] 同一对象
    expect(result.ordered[0]).toBe(candidates[3]);
  });

  it("契约: reasoning 透传 AI 返回的理由", async () => {
    const { runSelectStage } = await import("../daily-selection");
    const candidates = [makeCandidate("a"), makeCandidate("b")];
    const reasoning = "这张老照片捕捉到了消失的街景";
    mockChat.mockResolvedValueOnce(makeSelectResponse(1, reasoning));

    const result = await runSelectStage(candidates, { log: vi.fn(), enabled: true });
    expect(result.reasoning).toBe(reasoning);
  });

  it("契约: log 记录 select 结果（source/reasoning 可观测）", async () => {
    const { runSelectStage } = await import("../daily-selection");
    const candidates = [makeCandidate("a"), makeCandidate("b")];
    mockChat.mockResolvedValueOnce(makeSelectResponse(1, "理由"));
    const log = vi.fn();

    await runSelectStage(candidates, { log, enabled: true });
    // log 应被调用至少一次（记录 select 决策）
    expect(log).toHaveBeenCalled();
  });
});

// =====================================================================
// 场景 2：AI select 失败时优雅回退到公式排序（Error）
// =====================================================================

describe("场景2 — runSelectStage AI 失败回退保序", () => {
  it("场景2.P1: AI chat 抛错 → source='fallback'，不向上抛错，ordered 存在", async () => {
    const { runSelectStage } = await import("../daily-selection");
    const candidates = [
      makeCandidate("top", { weightedScore: 9.0 }),
      makeCandidate("mid", { weightedScore: 8.0 }),
      makeCandidate("low", { weightedScore: 7.0 }),
    ];

    mockChat.mockReset();
    mockChat.mockRejectedValueOnce(new Error("AI 服务超时"));

    // assert: 不抛错
    const result = await runSelectStage(candidates, { log: vi.fn(), enabled: true });

    // assert: source === "fallback"
    expect(result.source).toBe("fallback");
    // ordered 存在（entries[0] 可写入）
    expect(result.ordered).toHaveLength(candidates.length);
  });

  it("场景2.P2: 回退时 ordered 保持原序（hero == 修正公式 top1）", async () => {
    const { runSelectStage } = await import("../daily-selection");
    // 按加权分降序构造（公式 top1 = candidates[0]）
    const candidates = [
      makeCandidate("formula-top", { weightedScore: 9.5 }),
      makeCandidate("second", { weightedScore: 8.5 }),
      makeCandidate("third", { weightedScore: 7.5 }),
    ];

    mockChat.mockRejectedValueOnce(new Error("网络故障"));
    const result = await runSelectStage(candidates, { log: vi.fn(), enabled: true });

    // assert: source === "fallback"
    expect(result.source).toBe("fallback");
    expect(result.selectedIndex).toBe(0);
    // assert: ordered 保持原序（hero == 公式 top1）
    // 反空操作：kill "回退时随机打乱" 或 "回退时反向排序" mutation
    expect(result.ordered.map((c) => c.photoId)).toEqual(["formula-top", "second", "third"]);
    expect(result.ordered[0]!.photoId).toBe("formula-top");
  });

  it("场景2.P3: 回退时日志含 fallback 关键词", async () => {
    const { runSelectStage } = await import("../daily-selection");
    const candidates = [makeCandidate("a"), makeCandidate("b")];
    mockChat.mockResolvedValueOnce(makeUnparseableResponse());
    const log = vi.fn();

    await runSelectStage(candidates, { log, enabled: true });

    // assert: 日志包含 fallback 关键词（可观测回退痕迹）
    const allLogs = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allLogs.toLowerCase()).toContain("fallback");
  });

  it("契约: enabled===false → source='fallback'，零 AI 调用", async () => {
    const { runSelectStage } = await import("../daily-selection");
    const candidates = [makeCandidate("a"), makeCandidate("b")];

    mockChat.mockReset(); // 清除前序测试的调用记录
    const result = await runSelectStage(candidates, { log: vi.fn(), enabled: false });

    expect(result.source).toBe("fallback");
    expect(result.selectedIndex).toBe(0);
    // 反空操作：enabled=false 时绝不能调 chat（kill "enabled 开关被忽略" mutation）
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("契约: candidates.length < 2 → source='fallback', ordered 原序, selectedIndex=0, 零 AI 调用", async () => {
    const { runSelectStage } = await import("../daily-selection");

    // length = 1
    mockChat.mockClear();
    const single = [makeCandidate("solo")];
    const r1 = await runSelectStage(single, { log: vi.fn(), enabled: true });
    expect(r1.source).toBe("fallback");
    expect(r1.selectedIndex).toBe(0);
    expect(r1.ordered).toEqual(single);
    expect(mockChat).not.toHaveBeenCalled();

    // length = 0
    mockChat.mockClear();
    const r0 = await runSelectStage([], { log: vi.fn(), enabled: true });
    expect(r0.source).toBe("fallback");
    expect(r0.selectedIndex).toBe(0);
    expect(r0.ordered).toEqual([]);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("契约: selectedIndex 越界（≥n 或 <0）→ source='fallback' 保序不抛", async () => {
    const { runSelectStage } = await import("../daily-selection");
    const candidates = [
      makeCandidate("a", { weightedScore: 9.0 }),
      makeCandidate("b", { weightedScore: 8.0 }),
    ];

    // 越界：selectedIndex = 999（≥ n=2）
    mockChat.mockResolvedValueOnce(makeSelectResponse(999));
    const r1 = await runSelectStage(candidates, { log: vi.fn(), enabled: true });
    expect(r1.source).toBe("fallback");
    expect(r1.ordered.map((c) => c.photoId)).toEqual(["a", "b"]); // 保序

    // 越界：selectedIndex = -1
    mockChat.mockResolvedValueOnce(makeSelectResponse(-1));
    const r2 = await runSelectStage(candidates, { log: vi.fn(), enabled: true });
    expect(r2.source).toBe("fallback");
    expect(r2.ordered.map((c) => c.photoId)).toEqual(["a", "b"]);
  });

  it("契约: parseDailySelectResponse 解析失败 → source='fallback' 保序", async () => {
    const { runSelectStage } = await import("../daily-selection");
    const candidates = [
      makeCandidate("a", { weightedScore: 9.0 }),
      makeCandidate("b", { weightedScore: 8.0 }),
    ];

    // 非 JSON 响应，触发解析失败
    mockChat.mockResolvedValueOnce(makeUnparseableResponse());
    const result = await runSelectStage(candidates, { log: vi.fn(), enabled: true });

    expect(result.source).toBe("fallback");
    expect(result.ordered.map((c) => c.photoId)).toEqual(["a", "b"]);
  });
});

// =====================================================================
// 场景 7：select 评选输入含四维度语义信息（怀念意义/时空厚度/真实感/情感浓度）
// =====================================================================

describe("场景7 — runSelectStage 输入含语义化信息供文本模型判断", () => {
  it("场景7.P2: buildSelectUserPrompt 产出的文本含 tags/description/takenAt/score 等字段", async () => {
    const { buildSelectUserPrompt } = await import("../daily-selection");
    const candidates = [
      makeCandidate("c1", {
        aestheticScore: 7.5,
        yearsAgo: 10,
        takenAt: "2014-05-09T10:00:00Z",
        narrative: "老城区消失的街角小店",
        tags: [{ name: "街拍" }, { name: "怀旧" }, { name: "人物" }],
        emotionalAnalysis: { primary: "忧伤", secondary: "温暖" },
      }),
      makeCandidate("c2", {
        aestheticScore: 9.0,
        yearsAgo: 1,
        takenAt: "2023-05-09T10:00:00Z",
        narrative: "精美的风景照",
        tags: [{ name: "风景" }, { name: "自然" }],
        emotionalAnalysis: { primary: "平静", secondary: "宁静" },
      }),
    ];

    // buildSelectUserPrompt 是同步纯函数，第二参数为 user prompt 模板（含 {候选摘要列表} 占位符）
    const template =
      "以下是今天的候选照片分析摘要。\n\n{候选摘要列表}\n\n请从中选出最值得怀念的一张。";
    const promptText = buildSelectUserPrompt(candidates, template);

    // assert: 产出的文本含可语义化信息供文本模型判断
    expect(typeof promptText).toBe("string");
    expect(promptText.length).toBeGreaterThan(0);
    // 占位符已被替换
    expect(promptText).not.toContain("{候选摘要列表}");
    // 含标签（tags）
    expect(promptText).toContain("街拍");
    // 含叙事描述（description/narrative）
    expect(promptText).toContain("老城区");
    // 含拍摄时间（takenAt / 年份）
    expect(promptText).toContain("2014");
    // 含美学评分（score）
    expect(promptText).toContain("7.5");
    // CONTRACT_AMBIGUITY: 契约未明确字段名标签，但 select/user.txt 模板要求
    // "序号 + 来源标签 + 年份 + 美学评分 + 情感分析 + 标签 + 叙事描述"，
    // 这里断言这些信息以字面量形式出现在 prompt 文本中
  });

  it("场景7.P1: select 倾向「高情感/年代感但美学中等」（构造对照实验）", async () => {
    const { runSelectStage } = await import("../daily-selection");
    // 对照：A 美学中等(7.2) 但 10 年前老合影情感强；B 美学高(9.0) 但今年风景无情感
    const candidates = [
      makeCandidate("B-landscape", {
        aestheticScore: 9.0,
        weightedScore: 9.0,
        yearsAgo: 1,
        narrative: "精美的山景",
        tags: [{ name: "风景" }],
        emotionalAnalysis: { primary: "平静", secondary: "安宁" },
      }),
      makeCandidate("A-old-portrait", {
        aestheticScore: 7.2,
        weightedScore: 7.2,
        yearsAgo: 10,
        narrative: "十年前的家庭合影",
        tags: [{ name: "人物" }, { name: "怀旧" }],
        emotionalAnalysis: { primary: "亲情", secondary: "怀念" },
      }),
    ];

    // AI 基于四维度（怀念意义/时空厚度/真实感/情感浓度）选 A（selectedIndex=1）
    mockChat.mockResolvedValueOnce(
      makeSelectResponse(1, "十年前的家庭合影情感浓度更高，更具怀念价值"),
    );

    const result = await runSelectStage(candidates, { log: vi.fn(), enabled: true });

    expect(result.source).toBe("ai");
    // assert: select 倾向情感/年代感照片（selectedIndex=1 = A）
    expect(result.selectedIndex).toBe(1);
    expect(result.ordered[0]!.photoId).toBe("A-old-portrait");
    // 反空操作：A 的美学分(7.2) < B(9.0)，若 select 未生效会选 B（公式 top1）
    expect(result.ordered[0]!.photoId).not.toBe("B-landscape");
  });
});

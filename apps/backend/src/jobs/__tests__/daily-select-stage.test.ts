/**
 * runSelectStage / buildSelectUserPrompt 单元测试
 *
 * 契约（DbC）：
 * - ordered.length === candidates.length（重排不增不减，是 candidates 的置换）
 * - source==="ai" 时 ordered[0] === candidates[selectedIndex]，selectedIndex ∈ [0,n-1]
 * - candidates.length < 2 → source="fallback", ordered 原序, selectedIndex=0, 零 AI 调用
 * - enabled===false / chat 抛错 / 解析失败 / 越界 → fallback 原序
 * - 仅 enabled && length>=2 时多 1 次 aiClient.chat
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 工厂被 hoist 到文件顶部，不能直接引用外部变量。
// 用 vi.hoisted 把 mock 引用一起提升，工厂内通过闭包访问。
const { chatMock, loadPromptsMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  loadPromptsMock: vi.fn(),
}));

// daily-selection.ts 顶层 import "../db"（db/index.ts 立即 new Database()），
// 本测试只验证 runSelectStage / buildSelectUserPrompt 纯逻辑，stub 掉 db 模块。
vi.mock("../../db", () => ({ db: {}, schema: {} }));

// mock aiClient.chat，各用例通过 mockResolvedValue/RejectedValue 精确控制
vi.mock("../../ai/client", () => ({
  aiClient: { chat: chatMock },
  RelightAIClient: vi.fn(),
}));

// mock loadPrompts，返回固定 PromptSet，避免磁盘 IO
vi.mock("../../ai/prompts", () => ({ loadPrompts: loadPromptsMock }));

import { buildSelectUserPrompt, runSelectStage } from "../daily-selection";
import type { ClusteredCandidate } from "../daily-selection/cluster";

// ===== 测试夹具 =====

function makeCandidate(overrides: Partial<ClusteredCandidate>): ClusteredCandidate {
  return {
    photoId: overrides.photoId ?? "p1",
    filePath: overrides.filePath ?? "/photos/p1.jpg",
    takenAt: overrides.takenAt ?? "2020-05-09T10:00:00Z",
    mediaType: overrides.mediaType ?? "image",
    durationSec: null,
    aestheticScore: overrides.aestheticScore ?? 7.5,
    yearsAgo: overrides.yearsAgo ?? 5,
    weightedScore: overrides.weightedScore ?? 7.5,
    source: overrides.source ?? "historyToday",
    narrative: overrides.narrative ?? "海边日落",
    emotionalAnalysis: overrides.emotionalAnalysis ?? {
      primary: "宁静",
      secondary: "怀旧",
      intensity: 0.6,
    },
    tags: overrides.tags ?? [
      { name: "海边", category: "scene", confidence: 0.9 },
      { name: "日落", category: "scene", confidence: 0.85 },
    ],
    thumbnailPath: null,
    sourceType: "local",
    latitude: null,
    longitude: null,
    offsetTime: "+08:00",
    peopleNicknames: [],
    clusterSiblingIds: [],
  };
}

/** 构造一个按 weightedScore desc 排序的 N 候选数组（模拟 buildCandidatePool 输出） */
function makeCandidates(n: number): ClusteredCandidate[] {
  const out: ClusteredCandidate[] = [];
  for (let i = 0; i < n; i++) {
    // i=0 分最高，i=n-1 分最低
    out.push(
      makeCandidate({
        photoId: `p${i}`,
        filePath: `/photos/p${i}.jpg`,
        aestheticScore: 9 - i * 0.1,
        weightedScore: 9 - i * 0.1,
        yearsAgo: i + 1,
        narrative: `候选 ${i} 的描述`,
      }),
    );
  }
  return out;
}

const PROMPT_SET = {
  system: "你是回忆猎人",
  user: "候选如下：\n\n{候选摘要列表}",
};

beforeEach(() => {
  chatMock.mockReset();
  loadPromptsMock.mockReset();
  loadPromptsMock.mockResolvedValue(PROMPT_SET);
});

// ===== buildSelectUserPrompt =====

describe("buildSelectUserPrompt", () => {
  it("替换 {候选摘要列表} 占位符并包含每张候选的序号/来源/年份/评分/情感/标签/描述", () => {
    const candidates = makeCandidates(2);
    const result = buildSelectUserPrompt(candidates, PROMPT_SET.user);

    // 占位符被替换
    expect(result).not.toContain("{候选摘要列表}");
    // 每张候选的关键字段都出现
    expect(result).toContain("[0]");
    expect(result).toContain("[1]");
    expect(result).toContain("历史上的今天");
    expect(result).toContain("候选 0 的描述");
    expect(result).toContain("宁静 / 怀旧");
    expect(result).toContain("海边、日落");
  });

  it("视频候选带 [视频] 标签", () => {
    const base = makeCandidate({ photoId: "vid1" });
    const c: ClusteredCandidate = { ...base, mediaType: "video" };
    const result = buildSelectUserPrompt([c], PROMPT_SET.user);
    expect(result).toContain("[视频]");
  });

  it("emotionalAnalysis/tags 缺失时填默认值不抛错", () => {
    const base = makeCandidate({ photoId: "p-missing" });
    const c: ClusteredCandidate = {
      ...base,
      emotionalAnalysis: null,
      tags: null,
      narrative: null,
    };
    expect(() => buildSelectUserPrompt([c], PROMPT_SET.user)).not.toThrow();
    const result = buildSelectUserPrompt([c], PROMPT_SET.user);
    expect(result).toContain("未知");
    expect(result).toContain("无描述");
  });
});

// ===== runSelectStage =====

describe("runSelectStage", () => {
  it("length < 2 → source=fallback, 原序, selectedIndex=0, 零 AI 调用", async () => {
    const candidates = makeCandidates(1);
    const logs: string[] = [];
    const result = await runSelectStage(candidates, {
      log: (m) => logs.push(m),
      enabled: true,
    });

    expect(result.source).toBe("fallback");
    expect(result.selectedIndex).toBe(0);
    expect(result.ordered).toBe(candidates); // 同一引用
    expect(result.ordered.length).toBe(1);
    expect(chatMock).not.toHaveBeenCalled();
    expect(logs.some((m) => m.includes("< 2"))).toBe(true);
  });

  it("length === 0 → fallback, 零 AI 调用", async () => {
    const result = await runSelectStage([], { log: () => {}, enabled: true });
    expect(result.source).toBe("fallback");
    expect(result.ordered).toEqual([]);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("enabled=false → source=fallback, 原序, 零 AI 调用", async () => {
    const candidates = makeCandidates(3);
    const logs: string[] = [];
    const result = await runSelectStage(candidates, {
      log: (m) => logs.push(m),
      enabled: false,
    });

    expect(result.source).toBe("fallback");
    expect(result.ordered).toBe(candidates);
    expect(chatMock).not.toHaveBeenCalled();
    expect(logs.some((m) => m.includes("禁用"))).toBe(true);
  });

  it("AI 选中 selectedIndex=1 → ordered[0]===candidates[1]，其余按 weightedScore desc", async () => {
    const candidates = makeCandidates(4);
    chatMock.mockResolvedValue('```json\n{ "selectedIndex": 1, "reasoning": "久远感最强" }\n```');

    const result = await runSelectStage(candidates, {
      log: () => {},
      enabled: true,
    });

    expect(result.source).toBe("ai");
    expect(result.selectedIndex).toBe(1);
    expect(result.reasoning).toBe("久远感最强");
    expect(chatMock).toHaveBeenCalledTimes(1);
    // 长度不变
    expect(result.ordered.length).toBe(4);
    // hero 是被选中的那张
    expect(result.ordered[0]?.photoId).toBe("p1");
    // 其余按 weightedScore desc：原 p0(9.0) > p2(8.8) > p3(8.7)
    expect(result.ordered[1]?.photoId).toBe("p0");
    expect(result.ordered[2]?.photoId).toBe("p2");
    expect(result.ordered[3]?.photoId).toBe("p3");
  });

  it("AI 选中 selectedIndex=0 → ordered 与原序一致", async () => {
    const candidates = makeCandidates(3);
    chatMock.mockResolvedValue(
      '```json\n{ "selectedIndex": 0, "reasoning": "第一名本就最佳" }\n```',
    );

    const result = await runSelectStage(candidates, { log: () => {}, enabled: true });

    expect(result.source).toBe("ai");
    expect(result.selectedIndex).toBe(0);
    expect(result.ordered.map((c) => c.photoId)).toEqual(["p0", "p1", "p2"]);
  });

  it("AI 调用抛错 → source=fallback, 原序", async () => {
    const candidates = makeCandidates(3);
    chatMock.mockRejectedValue(new Error("AI service unavailable"));

    const logs: string[] = [];
    const result = await runSelectStage(candidates, {
      log: (m) => logs.push(m),
      enabled: true,
    });

    expect(result.source).toBe("fallback");
    expect(result.ordered).toBe(candidates);
    expect(result.selectedIndex).toBe(0);
    expect(logs.some((m) => m.includes("异常"))).toBe(true);
  });

  it("解析失败（无 JSON）→ source=fallback, 原序", async () => {
    const candidates = makeCandidates(3);
    chatMock.mockResolvedValue("这不是 JSON，模型乱说话了");

    const logs: string[] = [];
    const result = await runSelectStage(candidates, {
      log: (m) => logs.push(m),
      enabled: true,
    });

    expect(result.source).toBe("fallback");
    expect(result.ordered).toBe(candidates);
    expect(logs.some((m) => m.includes("解析失败"))).toBe(true);
  });

  it("selectedIndex 越界 → source=fallback, 原序", async () => {
    const candidates = makeCandidates(3); // 合法范围 [0,2]
    chatMock.mockResolvedValue('```json\n{ "selectedIndex": 5, "reasoning": "超界" }\n```');

    const logs: string[] = [];
    const result = await runSelectStage(candidates, {
      log: (m) => logs.push(m),
      enabled: true,
    });

    expect(result.source).toBe("fallback");
    expect(result.ordered).toBe(candidates);
    expect(logs.some((m) => m.includes("越界"))).toBe(true);
  });

  it("selectedIndex 为负数 → fallback", async () => {
    const candidates = makeCandidates(2);
    chatMock.mockResolvedValue('```json\n{ "selectedIndex": -1, "reasoning": "负" }\n```');

    const result = await runSelectStage(candidates, { log: () => {}, enabled: true });
    expect(result.source).toBe("fallback");
    expect(result.ordered).toBe(candidates);
  });

  it("ordered 是 candidates 的置换（无丢失无重复）", async () => {
    const candidates = makeCandidates(5);
    chatMock.mockResolvedValue('```json\n{ "selectedIndex": 3, "reasoning": "中间这张" }\n```');

    const result = await runSelectStage(candidates, { log: () => {}, enabled: true });

    expect(result.source).toBe("ai");
    expect(result.ordered.length).toBe(5);
    const originalIds = new Set(candidates.map((c) => c.photoId));
    const orderedIds = new Set(result.ordered.map((c) => c.photoId));
    expect(orderedIds).toEqual(originalIds); // 集合相等 = 无丢失
    expect(result.ordered.length).toBe(new Set(result.ordered.map((c) => c.photoId)).size); // 无重复
  });

  it("loadPrompts 以 ('v2','daily/select') 调用", async () => {
    const candidates = makeCandidates(2);
    chatMock.mockResolvedValue('```json\n{ "selectedIndex": 0, "reasoning": "x" }\n```');

    await runSelectStage(candidates, { log: () => {}, enabled: true });
    expect(loadPromptsMock).toHaveBeenCalledWith("v2", "daily/select");
  });

  it("aiClient.chat 接收 system prompt 作为第二参数", async () => {
    const candidates = makeCandidates(2);
    chatMock.mockResolvedValue('```json\n{ "selectedIndex": 0, "reasoning": "x" }\n```');

    await runSelectStage(candidates, { log: () => {}, enabled: true });
    expect(chatMock).toHaveBeenCalledTimes(1);
    const args = chatMock.mock.calls[0]!;
    // chat(prompt, systemPrompt)
    expect(args[1]).toBe(PROMPT_SET.system);
    expect(typeof args[0]).toBe("string");
    expect(args[0]).toContain("[0]");
  });
});

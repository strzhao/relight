/**
 * 测试每日精选 response parser 的解析和容错能力
 */
import { describe, expect, it } from "vitest";
import {
  dailyNarrateResponseSchema,
  dailySelectResponseSchema,
  parseDailyNarrateResponse,
  parseDailySelectResponse,
} from "../response-parser";

// ===== dailySelectResponseSchema =====

describe("dailySelectResponseSchema", () => {
  it("正常解析有效 JSON", () => {
    const input = {
      selectedIndex: 3,
      reasoning: "家庭团聚的温馨感最强",
    };
    const result = dailySelectResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.selectedIndex).toBe(3);
      expect(result.data.reasoning).toBe("家庭团聚的温馨感最强");
    }
  });

  it("selectedIndex 为负数时失败", () => {
    const input = { selectedIndex: -1, reasoning: "test" };
    const result = dailySelectResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("reasoning 为空字符串时失败", () => {
    const input = { selectedIndex: 0, reasoning: "" };
    const result = dailySelectResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ===== dailyNarrateResponseSchema =====

describe("dailyNarrateResponseSchema", () => {
  it("正常解析有效 JSON", () => {
    const input = {
      title: "那年五月",
      narrative: "三年前的今天，夕阳把整条街染成金色。你停下来，拍下了这一刻。",
      score: 8.5,
      reasoning: "黄昏光影自带时光流逝感",
    };
    const result = dailyNarrateResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("那年五月");
      expect(result.data.score).toBe(8.5);
    }
  });

  it("标题超过 8 字时失败（由 max 约束）", () => {
    const input = {
      title: "这是一个超过八字的长标题",
      narrative: "一段足够长的文案内容在这里展示",
      score: 7,
      reasoning: "理由",
    };
    const result = dailyNarrateResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("score 超过 10 时失败", () => {
    const input = {
      title: "标题",
      narrative: "一段足够长的文案内容在这里展示",
      score: 11,
      reasoning: "理由",
    };
    const result = dailyNarrateResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("score 低于 0 时失败", () => {
    const input = {
      title: "标题",
      narrative: "一段足够长的文案内容在这里展示",
      score: -1,
      reasoning: "理由",
    };
    const result = dailyNarrateResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ===== parseDailySelectResponse 容错恢复 =====

describe("parseDailySelectResponse", () => {
  it("从 ```json 代码块中正常提取", () => {
    const raw = [
      "以下是分析结果：",
      "```json",
      '{"selectedIndex": 2, "reasoning": "这张最有温度"}',
      "```",
    ].join("\n");

    const { parsed, error } = parseDailySelectResponse(raw);
    expect(error).toBeNull();
    expect(parsed?.selectedIndex).toBe(2);
    expect(parsed?.reasoning).toBe("这张最有温度");
  });

  it("无效 JSON 时返回 fallback", () => {
    const raw = "这不是有效的 JSON";

    const { parsed, error, fallback } = parseDailySelectResponse(raw);
    expect(parsed).toBeNull();
    expect(error).toBeTruthy();
    expect(fallback.selectedIndex).toBe(0);
  });

  it("字段缺失时容错恢复", () => {
    const raw = '{"selectedIndex": 5}';

    const { parsed, error, fallback } = parseDailySelectResponse(raw);
    // selectedIndex 有效但 reasoning 缺失 → schema 校验失败
    expect(parsed).toBeNull();
    expect(error).toBeTruthy();
    // fallback 应保留 selectedIndex
    expect(fallback.selectedIndex).toBe(5);
    expect(fallback.reasoning).toBe("");
  });
});

// ===== parseDailyNarrateResponse 容错恢复 =====

describe("parseDailyNarrateResponse", () => {
  it("从 ```json 代码块中正常提取", () => {
    const raw = [
      "```json",
      JSON.stringify({
        title: "那年夏天",
        narrative: "阳光穿过梧桐叶洒在老院子的地上，外婆在厨房里忙着做午饭。",
        score: 8.0,
        reasoning: "夏日怀旧氛围浓厚",
      }),
      "```",
    ].join("\n");

    const { parsed, error } = parseDailyNarrateResponse(raw);
    expect(error).toBeNull();
    expect(parsed?.title).toBe("那年夏天");
    expect(parsed?.score).toBe(8.0);
  });

  it("无效 JSON 时返回 fallback", () => {
    const raw = "no json here";

    const { parsed, error, fallback } = parseDailyNarrateResponse(raw);
    expect(parsed).toBeNull();
    expect(error).toBeTruthy();
    expect(fallback.title).toBe("今日拾光");
    expect(fallback.score).toBe(5.0);
  });

  it("部分字段缺失时容错恢复", () => {
    const raw = '{"score": 9.0}';

    const { parsed, error, fallback } = parseDailyNarrateResponse(raw);
    expect(parsed).toBeNull();
    expect(error).toBeTruthy();
    expect(fallback.score).toBe(9.0);
    expect(fallback.title).toBe("今日拾光");
    expect(fallback.narrative).toBe("");
    expect(fallback.reasoning).toBe("");
  });
});

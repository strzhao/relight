/**
 * T12: candidate-pool 单元测试
 * 测试 ageBonus 数值断言 + dedupAndQuotaMerge 去重/quota 正确性
 */

import { describe, expect, it, vi } from "vitest";

// candidate-pool.ts 顶层 import "../../db"，db/index.ts 模块加载时立即 new Database()，
// 如果测试 cwd 下 data/ 目录不存在会抛 "Cannot open database because the directory does not exist"。
// 本测试是纯函数验证，stub 掉 db 模块即可。
vi.mock("../../../db", () => ({ db: {}, schema: {} }));

import { type EnrichedCandidate, ageBonus, dedupAndQuotaMerge } from "../candidate-pool";

// ===== ageBonus 数值断言 =====
// 契约：y < 1 → 0；否则 min(0.3, √y × 0.05)；y ≥ 1 单调递增。

describe("ageBonus", () => {
  it("0 年返回 0", () => {
    expect(ageBonus(0)).toBe(0);
  });

  it("0.5 年（< 1）返回 0", () => {
    expect(ageBonus(0.5)).toBe(0);
  });

  it("1 年约等于 0.05", () => {
    const result = ageBonus(1);
    expect(result).toBeCloseTo(Math.sqrt(1) * 0.05, 4);
  });

  it("5 年约等于 0.1118", () => {
    const result = ageBonus(5);
    expect(result).toBeCloseTo(Math.sqrt(5) * 0.05, 4);
  });

  it("10 年约等于 0.158", () => {
    const result = ageBonus(10);
    expect(result).toBeCloseTo(Math.sqrt(10) * 0.05, 4);
  });

  it("20 年约等于 0.224", () => {
    const result = ageBonus(20);
    expect(result).toBeCloseTo(Math.sqrt(20) * 0.05, 4);
  });

  it("36 年封顶 0.30", () => {
    // sqrt(36) * 0.05 = 0.30，恰好触及 cap
    const result = ageBonus(36);
    expect(result).toBeCloseTo(0.3, 4);
  });

  it("100 年封顶 0.30", () => {
    const result = ageBonus(100);
    expect(result).toBe(0.3);
  });

  it("单调递增（1-36 年）", () => {
    const values = [1, 5, 10, 15, 20, 25, 30, 36].map((y) => ageBonus(y));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });
});

// ===== dedupAndQuotaMerge =====

function makeCandidate(
  photoId: string,
  source: EnrichedCandidate["source"],
  weightedScore: number,
): EnrichedCandidate {
  return {
    photoId,
    filePath: `/photos/${photoId}.jpg`,
    takenAt: "2020-05-09T10:00:00Z",
    mediaType: "image",
    durationSec: null,
    aestheticScore: weightedScore,
    yearsAgo: 5,
    weightedScore,
    source,
    narrative: null,
    emotionalAnalysis: null,
    tags: null,
    thumbnailPath: null,
    sourceType: "local",
    latitude: null,
    longitude: null,
    offsetTime: null,
    peopleNicknames: [],
  };
}

describe("dedupAndQuotaMerge", () => {
  it("去重：相同 photoId 只保留一次", () => {
    const bySource = {
      historyToday: [
        makeCandidate("p1", "historyToday", 9.0),
        makeCandidate("p2", "historyToday", 8.0),
      ],
      sameMonth: [
        makeCandidate("p1", "sameMonth", 7.0), // 重复
        makeCandidate("p3", "sameMonth", 6.0),
      ],
      sameSeason: [],
      agedRandom: [],
    };

    const result = dedupAndQuotaMerge(bySource, 20);
    const ids = result.map((r) => r.photoId);
    expect(ids.filter((id) => id === "p1")).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length); // 所有 id 唯一
  });

  it("per-source quota：每源保底 3 张", () => {
    // historyToday 有 8 张高分，其余源各有 4 张
    const historyHigh = Array.from({ length: 8 }, (_, i) =>
      makeCandidate(`h${i}`, "historyToday", 10 - i * 0.1),
    );
    const monthItems = Array.from({ length: 4 }, (_, i) =>
      makeCandidate(`m${i}`, "sameMonth", 5 - i * 0.1),
    );
    const seasonItems = Array.from({ length: 4 }, (_, i) =>
      makeCandidate(`s${i}`, "sameSeason", 4 - i * 0.1),
    );
    const agedItems = Array.from({ length: 4 }, (_, i) =>
      makeCandidate(`a${i}`, "agedRandom", 3 - i * 0.1),
    );

    const bySource = {
      historyToday: historyHigh,
      sameMonth: monthItems,
      sameSeason: seasonItems,
      agedRandom: agedItems,
    };

    const result = dedupAndQuotaMerge(bySource, 20);

    // 各源至少 3 张（quota 保底）
    const sources = result.map((r) => r.source);
    const countBySource = (src: EnrichedCandidate["source"]) =>
      sources.filter((s) => s === src).length;

    expect(countBySource("historyToday")).toBeGreaterThanOrEqual(3);
    expect(countBySource("sameMonth")).toBeGreaterThanOrEqual(3);
    expect(countBySource("sameSeason")).toBeGreaterThanOrEqual(3);
    expect(countBySource("agedRandom")).toBeGreaterThanOrEqual(3);
  });

  it("总数不超过 maxN", () => {
    const manyItems = Array.from({ length: 20 }, (_, i) =>
      makeCandidate(`p${i}`, "historyToday", 10 - i * 0.1),
    );
    const bySource = {
      historyToday: manyItems,
      sameMonth: [],
      sameSeason: [],
      agedRandom: [],
    };

    const result = dedupAndQuotaMerge(bySource, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("空输入返回空数组", () => {
    const bySource = {
      historyToday: [],
      sameMonth: [],
      sameSeason: [],
      agedRandom: [],
    };

    const result = dedupAndQuotaMerge(bySource, 20);
    expect(result).toHaveLength(0);
  });

  it("结果按 weightedScore 降序排列", () => {
    const bySource = {
      historyToday: [makeCandidate("h1", "historyToday", 8.0)],
      sameMonth: [makeCandidate("m1", "sameMonth", 9.0)],
      sameSeason: [makeCandidate("s1", "sameSeason", 7.0)],
      agedRandom: [makeCandidate("a1", "agedRandom", 6.0)],
    };

    const result = dedupAndQuotaMerge(bySource, 20);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.weightedScore).toBeLessThanOrEqual(result[i - 1]!.weightedScore);
    }
  });
});

/**
 * T12: candidate-pool 单元测试
 * 测试年代平权契约（weightedScore = aestheticScore）+ dedupAndQuotaMerge 去重/quota 正确性
 */

import { describe, expect, it, vi } from "vitest";

// candidate-pool.ts 顶层 import "../../db"，db/index.ts 模块加载时立即 new Database()，
// 如果测试 cwd 下 data/ 目录不存在会抛 "Cannot open database because the directory does not exist"。
// 本测试是纯函数验证，stub 掉 db 模块即可。
vi.mock("../../../db", () => ({ db: {}, schema: {} }));

import { type EnrichedCandidate, dedupAndQuotaMerge } from "../candidate-pool";

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
      randomSample: [],
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
      makeCandidate(`a${i}`, "randomSample", 3 - i * 0.1),
    );

    const bySource = {
      historyToday: historyHigh,
      sameMonth: monthItems,
      sameSeason: seasonItems,
      randomSample: agedItems,
    };

    const result = dedupAndQuotaMerge(bySource, 20);

    // 各源至少 3 张（quota 保底）
    const sources = result.map((r) => r.source);
    const countBySource = (src: EnrichedCandidate["source"]) =>
      sources.filter((s) => s === src).length;

    expect(countBySource("historyToday")).toBeGreaterThanOrEqual(3);
    expect(countBySource("sameMonth")).toBeGreaterThanOrEqual(3);
    expect(countBySource("sameSeason")).toBeGreaterThanOrEqual(3);
    expect(countBySource("randomSample")).toBeGreaterThanOrEqual(3);
  });

  it("总数不超过 maxN", () => {
    const manyItems = Array.from({ length: 20 }, (_, i) =>
      makeCandidate(`p${i}`, "historyToday", 10 - i * 0.1),
    );
    const bySource = {
      historyToday: manyItems,
      sameMonth: [],
      sameSeason: [],
      randomSample: [],
    };

    const result = dedupAndQuotaMerge(bySource, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("空输入返回空数组", () => {
    const bySource = {
      historyToday: [],
      sameMonth: [],
      sameSeason: [],
      randomSample: [],
    };

    const result = dedupAndQuotaMerge(bySource, 20);
    expect(result).toHaveLength(0);
  });

  it("结果按 weightedScore 降序排列", () => {
    const bySource = {
      historyToday: [makeCandidate("h1", "historyToday", 8.0)],
      sameMonth: [makeCandidate("m1", "sameMonth", 9.0)],
      sameSeason: [makeCandidate("s1", "sameSeason", 7.0)],
      randomSample: [makeCandidate("a1", "randomSample", 6.0)],
    };

    const result = dedupAndQuotaMerge(bySource, 20);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.weightedScore).toBeLessThanOrEqual(result[i - 1]!.weightedScore);
    }
  });
});

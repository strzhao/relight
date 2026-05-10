/**
 * cluster.ts 单元测试：dirname + 时间窗主题去重聚类
 */

import { describe, expect, it, vi } from "vitest";

// candidate-pool.ts 顶层 import "../../db"，测试不需要真实 DB；stub 掉。
vi.mock("../../../db", () => ({ db: {}, schema: {} }));

import type { EnrichedCandidate } from "../candidate-pool";
import { clusterByDirnameAndTime } from "../cluster";

function makeCandidate(
  photoId: string,
  filePath: string,
  takenAt: string | null,
  weightedScore: number,
): EnrichedCandidate {
  return {
    photoId,
    filePath,
    takenAt,
    mediaType: "image",
    durationSec: null,
    aestheticScore: weightedScore,
    yearsAgo: 1,
    weightedScore,
    source: "historyToday",
    narrative: null,
    emotionalAnalysis: null,
    tags: null,
    thumbnailPath: null,
    sourceType: "local",
  };
}

describe("clusterByDirnameAndTime", () => {
  it("空数组返回空数组", () => {
    expect(clusterByDirnameAndTime([])).toEqual([]);
  });

  it("单个候选返回单簇且 clusterSiblingIds 为空", () => {
    const cands = [makeCandidate("p1", "/a/b/p1.jpg", "2022-05-09T10:00:00Z", 8.0)];
    const result = clusterByDirnameAndTime(cands);
    expect(result).toHaveLength(1);
    expect(result[0]!.photoId).toBe("p1");
    expect(result[0]!.clusterSiblingIds).toEqual([]);
  });

  it("同 dirname 60 分钟内 3 张归为单簇", () => {
    const cands = [
      makeCandidate("p1", "/a/b/p1.jpg", "2022-05-09T10:00:00Z", 7.0),
      makeCandidate("p2", "/a/b/p2.jpg", "2022-05-09T10:30:00Z", 9.0), // 最高分作代表
      makeCandidate("p3", "/a/b/p3.jpg", "2022-05-09T11:00:00Z", 8.0),
    ];
    const result = clusterByDirnameAndTime(cands);
    expect(result).toHaveLength(1);
    expect(result[0]!.photoId).toBe("p2");
    expect(result[0]!.clusterSiblingIds).toEqual(["p1", "p3"]);
  });

  it("同 dirname Δt = 61 分钟拆为 2 簇", () => {
    const cands = [
      makeCandidate("p1", "/a/b/p1.jpg", "2022-05-09T10:00:00Z", 8.0),
      makeCandidate("p2", "/a/b/p2.jpg", "2022-05-09T11:01:00Z", 7.0),
    ];
    const result = clusterByDirnameAndTime(cands);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.photoId).sort();
    expect(ids).toEqual(["p1", "p2"]);
    for (const r of result) {
      expect(r.clusterSiblingIds).toEqual([]);
    }
  });

  it("同 dirname Δt 恰好 60 分钟仍归同簇（闭区间）", () => {
    const cands = [
      makeCandidate("p1", "/a/b/p1.jpg", "2022-05-09T10:00:00Z", 9.0),
      makeCandidate("p2", "/a/b/p2.jpg", "2022-05-09T11:00:00Z", 7.0),
    ];
    const result = clusterByDirnameAndTime(cands);
    expect(result).toHaveLength(1);
    expect(result[0]!.photoId).toBe("p1");
    expect(result[0]!.clusterSiblingIds).toEqual(["p2"]);
  });

  it("并列 weightedScore 取 takenAt 最早者作代表", () => {
    const cands = [
      makeCandidate("p_late", "/a/b/p_late.jpg", "2022-05-09T10:30:00Z", 8.0),
      makeCandidate("p_early", "/a/b/p_early.jpg", "2022-05-09T10:00:00Z", 8.0),
      makeCandidate("p_mid", "/a/b/p_mid.jpg", "2022-05-09T10:15:00Z", 8.0),
    ];
    const result = clusterByDirnameAndTime(cands);
    expect(result).toHaveLength(1);
    expect(result[0]!.photoId).toBe("p_early");
    // 兄弟按 takenAt 升序
    expect(result[0]!.clusterSiblingIds).toEqual(["p_mid", "p_late"]);
  });

  it("不同 dirname 即便 Δt 仅 1 秒也保持独立", () => {
    const cands = [
      makeCandidate("p1", "/a/b/p1.jpg", "2022-05-09T10:00:00Z", 8.0),
      makeCandidate("p2", "/a/c/p2.jpg", "2022-05-09T10:00:01Z", 7.0),
    ];
    const result = clusterByDirnameAndTime(cands);
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.clusterSiblingIds).toEqual([]);
    }
  });

  it("takenAt 为 null 的候选独立成簇且 clusterSiblingIds 为空", () => {
    const cands = [
      makeCandidate("p1", "/a/b/p1.jpg", null, 6.0),
      makeCandidate("p2", "/a/b/p2.jpg", null, 7.0),
      makeCandidate("p3", "/a/b/p3.jpg", "2022-05-09T10:00:00Z", 8.0),
    ];
    const result = clusterByDirnameAndTime(cands);
    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r.clusterSiblingIds).toEqual([]);
    }
    // 输出按 weightedScore 降序
    expect(result.map((r) => r.photoId)).toEqual(["p3", "p2", "p1"]);
  });

  it("输出按 weightedScore 降序排列（多簇）", () => {
    const cands = [
      // 簇 A：代表分 5
      makeCandidate("a1", "/dir-a/a1.jpg", "2022-05-09T10:00:00Z", 5.0),
      makeCandidate("a2", "/dir-a/a2.jpg", "2022-05-09T10:30:00Z", 4.0),
      // 簇 B：代表分 9
      makeCandidate("b1", "/dir-b/b1.jpg", "2022-05-09T10:00:00Z", 9.0),
      // 簇 C：代表分 7
      makeCandidate("c1", "/dir-c/c1.jpg", "2022-05-09T10:00:00Z", 7.0),
    ];
    const result = clusterByDirnameAndTime(cands);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.photoId)).toEqual(["b1", "c1", "a1"]);
  });

  it("clusterSiblingIds 顺序按 takenAt 升序（与代表本身的时间无关）", () => {
    const cands = [
      makeCandidate("rep", "/a/b/rep.jpg", "2022-05-09T10:30:00Z", 9.0), // 代表，时间居中
      makeCandidate("late", "/a/b/late.jpg", "2022-05-09T11:00:00Z", 7.0),
      makeCandidate("early", "/a/b/early.jpg", "2022-05-09T10:00:00Z", 8.0),
      makeCandidate("mid", "/a/b/mid.jpg", "2022-05-09T10:15:00Z", 6.0),
    ];
    const result = clusterByDirnameAndTime(cands);
    expect(result).toHaveLength(1);
    expect(result[0]!.photoId).toBe("rep");
    // 兄弟严格按 takenAt 升序：early(10:00) < mid(10:15) < late(11:00)
    expect(result[0]!.clusterSiblingIds).toEqual(["early", "mid", "late"]);
  });

  it("自定义 windowMinutes 生效（windowMinutes=10，Δt=15min 拆 2 簇）", () => {
    const cands = [
      makeCandidate("p1", "/a/b/p1.jpg", "2022-05-09T10:00:00Z", 8.0),
      makeCandidate("p2", "/a/b/p2.jpg", "2022-05-09T10:15:00Z", 7.0),
    ];
    const result = clusterByDirnameAndTime(cands, { windowMinutes: 10 });
    expect(result).toHaveLength(2);
  });

  it("链式分簇：Δt 渐进步长 ≤window 但首尾 >window 仍归同簇", () => {
    // 5 张照片间隔 30min，相邻满足，整体跨 2h；按"任意相邻 ≤ window 即同簇"应为 1 簇
    const cands = [
      makeCandidate("p1", "/a/b/p1.jpg", "2022-05-09T10:00:00Z", 5.0),
      makeCandidate("p2", "/a/b/p2.jpg", "2022-05-09T10:30:00Z", 6.0),
      makeCandidate("p3", "/a/b/p3.jpg", "2022-05-09T11:00:00Z", 9.0),
      makeCandidate("p4", "/a/b/p4.jpg", "2022-05-09T11:30:00Z", 7.0),
      makeCandidate("p5", "/a/b/p5.jpg", "2022-05-09T12:00:00Z", 8.0),
    ];
    const result = clusterByDirnameAndTime(cands);
    expect(result).toHaveLength(1);
    expect(result[0]!.photoId).toBe("p3");
    expect(result[0]!.clusterSiblingIds).toEqual(["p1", "p2", "p4", "p5"]);
  });
});

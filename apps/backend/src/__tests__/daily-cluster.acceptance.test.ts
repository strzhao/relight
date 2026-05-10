/**
 * 验收测试：每日精选 top 20 主题去重 — 同 dirname + |Δt| ≤60min 聚类（红队）
 *
 * 覆盖设计契约：
 * - `clusterByDirnameAndTime(candidates, { windowMinutes? }): ClusteredCandidate[]`
 *     · 默认 windowMinutes=60，闭区间（恰好 60min 同簇）
 *     · 同 dirname (path.posix.dirname) 比较
 *     · takenAt=null 单独成簇，clusterSiblingIds=[]
 *     · 簇代表：weightedScore desc + takenAt asc（并列取最早）
 *     · 输出按 weightedScore desc 排序
 *     · clusterSiblingIds 不含代表自身，按 takenAt 升序
 * - buildCandidatePool 返回 Promise<ClusteredCandidate[]>
 *     · 同 dirname + 60min 内的照片只占 1 个候选位（簇代表）
 *     · 同 dirname 但 >60min 不同簇
 *     · 幂等：同数据连续两次返回 photoId 顺序一致
 *     · takenAt=null 不抛异常，独立成簇
 *
 * 红队铁律：本文件仅依据"设计应该让什么发生"，不读蓝队即将创建/修改的实现：
 *   - 未读 cluster.ts
 *   - 未读 candidate-pool.ts（仅依据设计契约调用）
 *   - 未读 related-pool.ts
 *   - 未读 daily-selection.ts
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema";
import { setupTestSchema } from "./helpers/test-schema";

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;

vi.mock("../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

const SOURCE_ID = "source-cluster-001";

beforeEach(() => {
  testSqlite = new Database(":memory:");
  testSqlite.pragma("foreign_keys = ON");
  setupTestSchema(testSqlite);
  testDb = drizzle(testSqlite, { schema });

  testSqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, 'TestSource', 'local', '/test', 1)",
    )
    .run(SOURCE_ID);
});

afterEach(() => {
  testSqlite.close();
  vi.resetModules();
});

// =========================================================================
// 辅助函数 — 与既有 daily-burst-filter.acceptance.test.ts 风格一致
// =========================================================================

function todayMonthDay(): string {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const m = String(shanghai.getMonth() + 1).padStart(2, "0");
  const d = String(shanghai.getDate()).padStart(2, "0");
  return `${m}-${d}`;
}

/**
 * 构造"历史上今天" + 给定时分秒的 takenAt（命中 historyToday 候选源）。
 * @param yearsAgo 多少年前
 * @param hour 0-23
 * @param minute 0-59
 * @param second 0-59
 */
function takenAtForTodayAt(yearsAgo: number, hour: number, minute = 0, second = 0): string {
  const monthDay = todayMonthDay();
  const [m, d] = monthDay.split("-");
  const year = new Date().getFullYear() - yearsAgo;
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  return `${year}-${m}-${d}T${hh}:${mm}:${ss}.000Z`;
}

interface SeedPhotoOpts {
  id: string;
  filePath: string;
  takenAt: string | null;
}

function seedPhoto(opts: SeedPhotoOpts): void {
  testSqlite
    .prepare(
      `INSERT INTO photos
        (id, storage_source_id, file_path, file_hash, file_size,
         taken_at, created_at, burst_id, is_burst_representative)
       VALUES (?, ?, ?, ?, 1000, ?, ?, NULL, 0)`,
    )
    .run(
      opts.id,
      SOURCE_ID,
      opts.filePath,
      `hash-${opts.id}`,
      opts.takenAt,
      new Date().toISOString(),
    );
}

function seedAnalysis(photoId: string, aestheticScore = 9.0): void {
  testSqlite
    .prepare(
      `INSERT INTO photo_analyses
        (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'test-model', ?, '{}', ?)`,
    )
    .run(`analysis-${photoId}`, photoId, aestheticScore, new Date().toISOString());
}

// =========================================================================
// R-cluster 测试套件
// =========================================================================

describe("每日精选主题去重：同 dirname + |Δt| ≤60min 聚类（红队验收）", () => {
  // -----------------------------------------------------------------------
  // R-cluster-1：跨簇隔离 — 同 dirname 但时间窗超过 60min 不同簇
  // -----------------------------------------------------------------------
  describe("R-cluster-1（场景 7 跨簇隔离）", () => {
    it("同 dirname 内分两组（间隔 6h），buildCandidatePool 返回 2 个 ClusteredCandidate", async () => {
      const { buildCandidatePool } = await import("../jobs/daily-selection/candidate-pool");

      // 组 A：3 张同 dirA/，30s 间隔（10:00:00 / 10:00:30 / 10:01:00），都在 60min 内
      const a1 = takenAtForTodayAt(3, 10, 0, 0);
      const a2 = takenAtForTodayAt(3, 10, 0, 30);
      const a3 = takenAtForTodayAt(3, 10, 1, 0);
      seedPhoto({ id: "a1", filePath: "dirA/a1.jpg", takenAt: a1 });
      seedPhoto({ id: "a2", filePath: "dirA/a2.jpg", takenAt: a2 });
      seedPhoto({ id: "a3", filePath: "dirA/a3.jpg", takenAt: a3 });
      seedAnalysis("a1", 9.5);
      seedAnalysis("a2", 9.0);
      seedAnalysis("a3", 8.5);

      // 组 B：2 张同 dirA/，与 A 间隔 6h（16:00:00 / 16:00:30）
      const b1 = takenAtForTodayAt(3, 16, 0, 0);
      const b2 = takenAtForTodayAt(3, 16, 0, 30);
      seedPhoto({ id: "b1", filePath: "dirA/b1.jpg", takenAt: b1 });
      seedPhoto({ id: "b2", filePath: "dirA/b2.jpg", takenAt: b2 });
      seedAnalysis("b1", 8.8);
      seedAnalysis("b2", 8.7);

      const result = await buildCandidatePool({ excludeIds: new Set() });

      // 簇数 = 2（A 簇代表 + B 簇代表）
      expect(result).toHaveLength(2);

      // 每个返回元素都应携带 clusterSiblingIds 字段（设计契约）
      for (const c of result) {
        expect(c).toHaveProperty("clusterSiblingIds");
        expect(Array.isArray((c as { clusterSiblingIds: unknown }).clusterSiblingIds)).toBe(true);
      }

      const aIds = new Set(["a1", "a2", "a3"]);
      const bIds = new Set(["b1", "b2"]);
      const aRep = result.find((c) => aIds.has(c.photoId));
      const bRep = result.find((c) => bIds.has(c.photoId));
      expect(aRep).toBeDefined();
      expect(bRep).toBeDefined();

      const aSiblings = (aRep as unknown as { clusterSiblingIds: string[] }).clusterSiblingIds;
      const bSiblings = (bRep as unknown as { clusterSiblingIds: string[] }).clusterSiblingIds;

      // A 簇代表的 siblingIds 长度=2（两个非代表成员）
      expect(aSiblings).toHaveLength(2);
      // 严格按 takenAt 升序
      const aSiblingTakenAts = aSiblings.map((id) => {
        if (id === "a1") return a1;
        if (id === "a2") return a2;
        if (id === "a3") return a3;
        throw new Error(`unexpected sibling ${id}`);
      });
      const aSorted = [...aSiblingTakenAts].sort();
      expect(aSiblingTakenAts).toEqual(aSorted);

      // B 簇代表的 siblingIds 完全不含 A 组任何 photoId
      for (const sid of bSiblings) {
        expect(aIds.has(sid)).toBe(false);
      }
      // B 簇内部最多 1 个 sibling（共 2 张）
      expect(bSiblings.length).toBeLessThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // R-cluster-2：幂等性 — 同数据两次调用顺序一致
  // -----------------------------------------------------------------------
  describe("R-cluster-2（场景 9 幂等）", () => {
    it("buildCandidatePool 同数据连续两次返回 photoId 序列完全一致", async () => {
      const { buildCandidatePool } = await import("../jobs/daily-selection/candidate-pool");

      // 多 dirname、多时间段，覆盖 4 张独立 + 2 个簇
      const t = (h: number, m = 0, s = 0) => takenAtForTodayAt(2, h, m, s);

      // dirX/ 簇：3 张，30s 间隔
      seedPhoto({ id: "x1", filePath: "dirX/x1.jpg", takenAt: t(8, 0, 0) });
      seedPhoto({ id: "x2", filePath: "dirX/x2.jpg", takenAt: t(8, 0, 30) });
      seedPhoto({ id: "x3", filePath: "dirX/x3.jpg", takenAt: t(8, 1, 0) });
      seedAnalysis("x1", 9.4);
      seedAnalysis("x2", 9.1);
      seedAnalysis("x3", 8.7);

      // dirY/ 簇：2 张
      seedPhoto({ id: "y1", filePath: "dirY/y1.jpg", takenAt: t(12, 0, 0) });
      seedPhoto({ id: "y2", filePath: "dirY/y2.jpg", takenAt: t(12, 0, 45) });
      seedAnalysis("y1", 8.9);
      seedAnalysis("y2", 8.4);

      // 4 张独立照片（dirZ/ 不同时段，远超 60min）
      seedPhoto({ id: "z1", filePath: "dirZ/z1.jpg", takenAt: t(6, 0, 0) });
      seedPhoto({ id: "z2", filePath: "dirZ/z2.jpg", takenAt: t(14, 0, 0) });
      seedPhoto({ id: "z3", filePath: "dirZ/z3.jpg", takenAt: t(18, 0, 0) });
      seedPhoto({ id: "z4", filePath: "dirZ/z4.jpg", takenAt: t(20, 0, 0) });
      seedAnalysis("z1", 7.5);
      seedAnalysis("z2", 7.8);
      seedAnalysis("z3", 7.2);
      seedAnalysis("z4", 7.0);

      const first = await buildCandidatePool({ excludeIds: new Set() });
      const second = await buildCandidatePool({ excludeIds: new Set() });

      const firstIds = first.map((c) => c.photoId);
      const secondIds = second.map((c) => c.photoId);

      // 顺序完全一致（不仅集合一致）
      expect(secondIds).toEqual(firstIds);

      // 簇数应明显小于原始照片数（聚类有效）
      expect(first.length).toBeLessThan(9);
    });
  });

  // -----------------------------------------------------------------------
  // R-cluster-3：takenAt=null 降级
  // -----------------------------------------------------------------------
  describe("R-cluster-3（场景 8 降级）", () => {
    it("1 张 takenAt=null + 5 张同 dir 30s 间隔 → null 独簇 + 5 张聚 1 簇", async () => {
      const { buildCandidatePool } = await import("../jobs/daily-selection/candidate-pool");

      // 5 张正常照片：同 dirN/，30s 间隔（共 2min 跨度，远小于 60min）
      const ts = [
        takenAtForTodayAt(4, 9, 0, 0),
        takenAtForTodayAt(4, 9, 0, 30),
        takenAtForTodayAt(4, 9, 1, 0),
        takenAtForTodayAt(4, 9, 1, 30),
        takenAtForTodayAt(4, 9, 2, 0),
      ];
      ts.forEach((ta, i) => {
        const id = `n${i + 1}`;
        seedPhoto({ id, filePath: `dirN/${id}.jpg`, takenAt: ta });
        seedAnalysis(id, 9.0 - i * 0.05);
      });

      // 1 张 takenAt=null（注意：候选池需能覆盖此源；多数情况 null 会从 sameMonth/agedRandom 等源进入；
      // 即便不进入候选池，至少不应导致聚类崩溃。这里验证不抛 + 若进入则独立成簇）
      seedPhoto({ id: "null-1", filePath: "dirNull/null-1.jpg", takenAt: null });
      seedAnalysis("null-1", 8.5);

      // 不应抛异常
      let result: Awaited<ReturnType<typeof buildCandidatePool>> = [];
      await expect(
        (async () => {
          result = await buildCandidatePool({ excludeIds: new Set() });
        })(),
      ).resolves.toBeUndefined();

      // 5 张聚为 1 簇：返回元素中正好有 1 个的 photoId 属于 n1..n5，且其 clusterSiblingIds.length === 4
      const nIds = new Set(["n1", "n2", "n3", "n4", "n5"]);
      const nReps = result.filter((c) => nIds.has(c.photoId));
      expect(nReps).toHaveLength(1);
      const nSiblings = (nReps[0] as unknown as { clusterSiblingIds: string[] }).clusterSiblingIds;
      expect(nSiblings).toHaveLength(4);
      // 4 个 sibling 全部来自 n1..n5 且不含代表自身
      for (const sid of nSiblings) {
        expect(nIds.has(sid)).toBe(true);
        expect(sid).not.toBe(nReps[0]!.photoId);
      }

      // 若 null 照片进入了候选池（取决于候选源），则它必须独立成簇
      const nullEntry = result.find((c) => c.photoId === "null-1");
      if (nullEntry) {
        expect((nullEntry as unknown as { clusterSiblingIds: string[] }).clusterSiblingIds).toEqual(
          [],
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  // R-cluster-4：簇代表打破并列 — 直接调聚类纯函数
  // -----------------------------------------------------------------------
  describe("R-cluster-4（簇代表打破并列）", () => {
    it("3 张同 dir 30s 间隔且 weightedScore 完全相同 → 代表为 takenAt 最早，sibling 升序", async () => {
      const { clusterByDirnameAndTime } = await import("../jobs/daily-selection/cluster");

      // 直接构造 EnrichedCandidate-like 输入（最小必要字段）
      // 注意：故意打乱输入顺序，验证实现真正按 takenAt 决定代表（不是输入序）
      const input = [
        {
          photoId: "p-mid",
          filePath: "dirT/p-mid.jpg",
          takenAt: takenAtForTodayAt(2, 10, 0, 30),
          weightedScore: 9.0,
        },
        {
          photoId: "p-late",
          filePath: "dirT/p-late.jpg",
          takenAt: takenAtForTodayAt(2, 10, 1, 0),
          weightedScore: 9.0,
        },
        {
          photoId: "p-early",
          filePath: "dirT/p-early.jpg",
          takenAt: takenAtForTodayAt(2, 10, 0, 0),
          weightedScore: 9.0,
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(input as any);

      // 全部 3 张聚为 1 簇
      expect(result).toHaveLength(1);
      const rep = result[0]!;

      // 代表是 takenAt 最早的那张
      expect(rep.photoId).toBe("p-early");

      // siblingIds 按 takenAt 升序：p-mid（10:00:30）→ p-late（10:01:00）
      const siblings = (rep as unknown as { clusterSiblingIds: string[] }).clusterSiblingIds;
      expect(siblings).toEqual(["p-mid", "p-late"]);

      // 代表自身不在 siblingIds 中
      expect(siblings).not.toContain("p-early");
    });

    it("默认 windowMinutes=60 闭区间：恰好 60min 同簇，61min 不同簇", async () => {
      const { clusterByDirnameAndTime } = await import("../jobs/daily-selection/cluster");

      // 同 dirname，分别相隔 60min（应同簇）和 61min（应不同簇）
      const inputBoundary = [
        {
          photoId: "anchor",
          filePath: "dirB/anchor.jpg",
          takenAt: takenAtForTodayAt(2, 10, 0, 0),
          weightedScore: 9.0,
        },
        {
          photoId: "exact-60",
          filePath: "dirB/exact-60.jpg",
          takenAt: takenAtForTodayAt(2, 11, 0, 0), // 恰好 60min
          weightedScore: 8.5,
        },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r60 = clusterByDirnameAndTime(inputBoundary as any);
      // 闭区间：恰好 60min 同簇 → 1 个簇
      expect(r60).toHaveLength(1);
      const r60Siblings = (r60[0] as unknown as { clusterSiblingIds: string[] }).clusterSiblingIds;
      expect(r60Siblings).toHaveLength(1);

      const inputOutside = [
        {
          photoId: "anchor",
          filePath: "dirB/anchor.jpg",
          takenAt: takenAtForTodayAt(2, 10, 0, 0),
          weightedScore: 9.0,
        },
        {
          photoId: "over-60",
          filePath: "dirB/over-60.jpg",
          takenAt: takenAtForTodayAt(2, 11, 1, 0), // 61min
          weightedScore: 8.5,
        },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r61 = clusterByDirnameAndTime(inputOutside as any);
      // 61min 超窗 → 2 簇
      expect(r61).toHaveLength(2);
    });

    it("不同 dirname 即使时间相邻也不同簇", async () => {
      const { clusterByDirnameAndTime } = await import("../jobs/daily-selection/cluster");

      const input = [
        {
          photoId: "p1",
          filePath: "dirA/p1.jpg",
          takenAt: takenAtForTodayAt(2, 10, 0, 0),
          weightedScore: 9.0,
        },
        {
          photoId: "p2",
          filePath: "dirB/p2.jpg",
          takenAt: takenAtForTodayAt(2, 10, 0, 10), // 10s 后但不同 dir
          weightedScore: 8.5,
        },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(input as any);
      expect(result).toHaveLength(2);
      // 输出按 weightedScore desc 排序
      expect(result[0]!.photoId).toBe("p1");
      expect(result[1]!.photoId).toBe("p2");
      for (const c of result) {
        expect((c as unknown as { clusterSiblingIds: string[] }).clusterSiblingIds).toEqual([]);
      }
    });

    it("takenAt=null 单独成簇（clusterSiblingIds=[]）", async () => {
      const { clusterByDirnameAndTime } = await import("../jobs/daily-selection/cluster");

      const input = [
        {
          photoId: "with-time",
          filePath: "dirA/with.jpg",
          takenAt: takenAtForTodayAt(2, 10, 0, 0),
          weightedScore: 9.0,
        },
        {
          photoId: "no-time",
          filePath: "dirA/no.jpg",
          takenAt: null,
          weightedScore: 8.0,
        },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(input as any);
      expect(result).toHaveLength(2);
      const noTime = result.find((c) => c.photoId === "no-time");
      expect(noTime).toBeDefined();
      expect((noTime as unknown as { clusterSiblingIds: string[] }).clusterSiblingIds).toEqual([]);
    });

    it("输出按 weightedScore desc 排序", async () => {
      const { clusterByDirnameAndTime } = await import("../jobs/daily-selection/cluster");

      // 三个独立簇，weightedScore 不同
      const input = [
        {
          photoId: "low",
          filePath: "dirA/low.jpg",
          takenAt: takenAtForTodayAt(2, 8, 0, 0),
          weightedScore: 7.0,
        },
        {
          photoId: "high",
          filePath: "dirB/high.jpg",
          takenAt: takenAtForTodayAt(2, 12, 0, 0),
          weightedScore: 9.5,
        },
        {
          photoId: "mid",
          filePath: "dirC/mid.jpg",
          takenAt: takenAtForTodayAt(2, 16, 0, 0),
          weightedScore: 8.2,
        },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(input as any);
      expect(result.map((c) => c.photoId)).toEqual(["high", "mid", "low"]);
    });
  });
});

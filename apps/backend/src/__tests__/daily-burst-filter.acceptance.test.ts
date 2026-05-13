/**
 * 验收测试：daily-selection 候选池 burst 过滤契约（红队，调用真实 buildCandidatePool）
 *
 * 覆盖设计文档 §关键模块.5（daily-selection 过滤）：
 *   候选池只让连拍代表 + 独立照片进入，非代表成员不应出现。
 *   验收场景（设计文档 §验收场景.7）：
 *     3 张连拍（1 代表 + 2 成员）+ 5 张独立照片，全部今日月-日匹配
 *     → 候选池：1+5=6 张（代表 + 独立）
 *
 * 红队铁律：直接调 buildCandidatePool，不在测试里复刻 SQL。
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

const SOURCE_ID = "source-001";

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
// 辅助函数
// =========================================================================

function todayMonthDay(): string {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const m = String(shanghai.getMonth() + 1).padStart(2, "0");
  const d = String(shanghai.getDate()).padStart(2, "0");
  return `${m}-${d}`;
}

/** 今年比给定 yearsAgo 早的"历史上今天"，命中 historyToday 源 */
function takenAtForToday(yearsAgo: number): string {
  const monthDay = todayMonthDay();
  const [m, d] = monthDay.split("-");
  const year = new Date().getFullYear() - yearsAgo;
  return `${year}-${m}-${d}T12:00:00.000Z`;
}

function seedPhoto(opts: {
  id: string;
  takenAt: string;
  burstId?: string | null;
  isRep?: boolean;
  /** 自定义 dirname，独立照片用不同 dir 避开 cluster.ts 主题去重的 dirname+time 桶 */
  dirname?: string;
}): void {
  const dir = opts.dirname ?? "/photos";
  testSqlite
    .prepare(
      `INSERT INTO photos
        (id, storage_source_id, file_path, file_hash, file_size,
         taken_at, created_at, burst_id, is_burst_representative)
       VALUES (?, ?, ?, ?, 1000, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      SOURCE_ID,
      `${dir}/${opts.id}.jpg`,
      `hash-${opts.id}`,
      opts.takenAt,
      new Date().toISOString(),
      opts.burstId ?? null,
      opts.isRep ? 1 : 0,
    );
}

function seedAnalysis(photoId: string, aestheticScore = 7.5): void {
  testSqlite
    .prepare(
      `INSERT INTO photo_analyses
        (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'test-model', ?, '{}', ?)`,
    )
    .run(`analysis-${photoId}`, photoId, aestheticScore, new Date().toISOString());
}

function seedBurst(id: string, repPhotoId: string, memberCount: number): void {
  testSqlite
    .prepare(
      `INSERT INTO bursts (id, storage_source_id, representative_photo_id, member_count, manual_override, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(id, SOURCE_ID, repPhotoId, memberCount, new Date().toISOString());
}

// =========================================================================
// 测试套件
// =========================================================================

describe("daily-selection 候选池 burst 过滤契约（设计文档 §关键模块.5）", () => {
  describe("核心场景：连拍组只有代表进入候选池", () => {
    it("3 张连拍（1 代表 + 2 成员）+ 5 张独立 → 候选含代表，不含非代表成员", async () => {
      const { buildCandidatePool } = await import("../jobs/daily-selection/candidate-pool");
      const takenAt = takenAtForToday(2);

      seedBurst("burst-1", "p1", 3);
      seedPhoto({ id: "p1", takenAt, burstId: "burst-1", isRep: true });
      seedPhoto({ id: "p2", takenAt, burstId: "burst-1", isRep: false });
      seedPhoto({ id: "p3", takenAt, burstId: "burst-1", isRep: false });
      seedAnalysis("p1", 9.0);
      seedAnalysis("p2", 8.5);
      seedAnalysis("p3", 8.0);

      for (let i = 1; i <= 5; i++) {
        // 各放不同目录，避免 cluster.ts 把同 dirname+同时刻的照片当作"同主题"聚合掉
        seedPhoto({
          id: `solo-${i}`,
          takenAt,
          burstId: null,
          isRep: false,
          dirname: `/photos-solo-${i}`,
        });
        seedAnalysis(`solo-${i}`, 7.0 - i * 0.1);
      }

      const result = await buildCandidatePool({ excludeIds: new Set() });
      const ids = result.map((r) => r.photoId);

      expect(ids).toContain("p1");
      expect(ids).not.toContain("p2");
      expect(ids).not.toContain("p3");
      for (let i = 1; i <= 5; i++) {
        expect(ids).toContain(`solo-${i}`);
      }
    });
  });

  describe("无分析记录的照片不进入候选池（INNER JOIN 语义）", () => {
    it("连拍代表无分析记录时不出现在候选池", async () => {
      const { buildCandidatePool } = await import("../jobs/daily-selection/candidate-pool");
      const takenAt = takenAtForToday(2);

      seedBurst("burst-1", "p1", 2);
      seedPhoto({ id: "p1", takenAt, burstId: "burst-1", isRep: true });
      seedPhoto({ id: "p2", takenAt, burstId: "burst-1", isRep: false });
      // p1 没有 analysis 记录

      const result = await buildCandidatePool({ excludeIds: new Set() });
      expect(result.map((r) => r.photoId)).not.toContain("p1");
    });

    it("独立照片无分析记录时不出现在候选池", async () => {
      const { buildCandidatePool } = await import("../jobs/daily-selection/candidate-pool");
      const takenAt = takenAtForToday(2);

      seedPhoto({ id: "no-analysis", takenAt, burstId: null, isRep: false });

      const result = await buildCandidatePool({ excludeIds: new Set() });
      expect(result.map((r) => r.photoId)).not.toContain("no-analysis");
    });
  });

  describe("多组连拍：每组只有代表进入候选池", () => {
    it("2 个连拍组（各 3 张）+ 2 张独立 → 候选含 a1/b1/s1/s2，不含非代表成员", async () => {
      const { buildCandidatePool } = await import("../jobs/daily-selection/candidate-pool");
      const takenAt = takenAtForToday(3);

      // 4 组照片用不同 dirname 隔开 cluster.ts 的同 dirname+时间桶聚合
      seedBurst("burst-A", "a1", 3);
      seedPhoto({ id: "a1", takenAt, burstId: "burst-A", isRep: true, dirname: "/burst-A" });
      seedPhoto({ id: "a2", takenAt, burstId: "burst-A", isRep: false, dirname: "/burst-A" });
      seedPhoto({ id: "a3", takenAt, burstId: "burst-A", isRep: false, dirname: "/burst-A" });
      seedAnalysis("a1");
      seedAnalysis("a2");
      seedAnalysis("a3");

      seedBurst("burst-B", "b1", 3);
      seedPhoto({ id: "b1", takenAt, burstId: "burst-B", isRep: true, dirname: "/burst-B" });
      seedPhoto({ id: "b2", takenAt, burstId: "burst-B", isRep: false, dirname: "/burst-B" });
      seedPhoto({ id: "b3", takenAt, burstId: "burst-B", isRep: false, dirname: "/burst-B" });
      seedAnalysis("b1");
      seedAnalysis("b2");
      seedAnalysis("b3");

      seedPhoto({ id: "s1", takenAt, burstId: null, isRep: false, dirname: "/solo-1" });
      seedAnalysis("s1");
      seedPhoto({ id: "s2", takenAt, burstId: null, isRep: false, dirname: "/solo-2" });
      seedAnalysis("s2");

      const result = await buildCandidatePool({ excludeIds: new Set() });
      const ids = result.map((r) => r.photoId);

      expect(ids).toContain("a1");
      expect(ids).toContain("b1");
      expect(ids).toContain("s1");
      expect(ids).toContain("s2");
      expect(ids).not.toContain("a2");
      expect(ids).not.toContain("a3");
      expect(ids).not.toContain("b2");
      expect(ids).not.toContain("b3");
    });
  });

  describe("候选为空", () => {
    it("无任何照片 → 候选为空", async () => {
      const { buildCandidatePool } = await import("../jobs/daily-selection/candidate-pool");
      const result = await buildCandidatePool({ excludeIds: new Set() });
      expect(result).toHaveLength(0);
    });

    it("有照片但全为非代表连拍成员 → 候选为空（被 burst 过滤）", async () => {
      const { buildCandidatePool } = await import("../jobs/daily-selection/candidate-pool");
      const takenAt = takenAtForToday(2);

      seedBurst("burst-1", "p1", 3);
      // p1 是代表但无 analysis；p2/p3 有 analysis 但非代表 → 都被过滤掉
      seedPhoto({ id: "p1", takenAt, burstId: "burst-1", isRep: true });
      seedPhoto({ id: "p2", takenAt, burstId: "burst-1", isRep: false });
      seedPhoto({ id: "p3", takenAt, burstId: "burst-1", isRep: false });
      seedAnalysis("p2");
      seedAnalysis("p3");

      const result = await buildCandidatePool({ excludeIds: new Set() });
      expect(result).toHaveLength(0);
    });
  });
});

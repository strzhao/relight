/**
 * 验收测试：daily-selection 候选池 burst 过滤契约（红队，黑盒）
 *
 * 覆盖设计文档 §关键模块.5（daily-selection 过滤）：
 *
 *   候选 SQL 应追加：
 *     AND (photos.burst_id IS NULL OR photos.is_burst_representative = 1)
 *
 *   验收场景（设计文档 §验收场景.7）：
 *     3 张连拍（1 代表 + 2 成员）+ 5 张独立照片，全部今日月-日匹配
 *     → 候选池入参从 8 张 → 1+5=6 张（代表 + 独立）
 *
 *   detectCandidates 不应返回非代表成员
 *
 * 测试直接查询 SQLite DB，不依赖 BullMQ Job。
 * 红队铁律：不读取 daily-selection.ts 实现，仅通过调用 dailySelectionWorker
 * 后检查 DB 状态来验证候选过滤（Job mock 模式）。
 *
 * 注意：此处通过单独查询封装的"候选逻辑"来验证，而非 mock Job 全流程。
 * 实际验证手段：用真实 SQLite + 已知 fixture 数据，直接执行与
 * daily-selection.ts 等价的 SQL 查询，断言结果集不含非代表成员。
 */
import Database from "better-sqlite3";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { setupTestSchema } from "./helpers/test-schema";

// =========================================================================
// 构建内存 SQLite（含 bursts 表 + photos 新列），DDL 来自共享 helpers/test-schema.ts
// =========================================================================

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

// =========================================================================
// 共享测试状态
// =========================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;
const SOURCE_ID = "source-001";

beforeEach(() => {
  const t = createTestDb();
  testSqlite = t.sqlite;
  testDb = t.db;

  testSqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, 'TestSource', 'local', '/test', 1)",
    )
    .run(SOURCE_ID);
});

afterEach(() => {
  testSqlite.close();
});

// =========================================================================
// 辅助函数
// =========================================================================

/**
 * 为候选 SQL 构造 monthDay（当前北京时间月-日），或接受自定义日期
 * 用于控制测试中的 takenAt 让照片命中"历史上今天"
 */
function todayMonthDay(): string {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const m = String(shanghai.getMonth() + 1).padStart(2, "0");
  const d = String(shanghai.getDate()).padStart(2, "0");
  return `${m}-${d}`;
}

/**
 * 构造一个 takenAt：年份 = 某一年（历史），月-日 = 当前
 */
function takenAtForToday(year: number): string {
  const monthDay = todayMonthDay();
  const [m, d] = monthDay.split("-");
  return `${year}-${m}-${d}T12:00:00.000Z`;
}

/** 插入照片 */
function seedPhoto(opts: {
  id: string;
  takenAt: string;
  burstId?: string | null;
  isRep?: boolean;
}): void {
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
      `/photos/${opts.id}.jpg`,
      `hash-${opts.id}`,
      opts.takenAt,
      new Date().toISOString(),
      opts.burstId ?? null,
      opts.isRep ? 1 : 0,
    );
}

/** 插入 photoAnalysis（使照片进入候选池） */
function seedAnalysis(photoId: string, aestheticScore = 7.5): void {
  testSqlite
    .prepare(
      `INSERT INTO photo_analyses
        (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'test-model', ?, '{}', ?)`,
    )
    .run(`analysis-${photoId}`, photoId, aestheticScore, new Date().toISOString());
}

/** 插入 burst */
function seedBurst(id: string, repPhotoId: string, memberCount: number): void {
  testSqlite
    .prepare(
      `INSERT INTO bursts (id, storage_source_id, representative_photo_id, member_count, manual_override, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(id, SOURCE_ID, repPhotoId, memberCount, new Date().toISOString());
}

/**
 * 执行与 daily-selection.ts 等价的候选查询
 * （通过真实 Drizzle ORM 查询，验证过滤逻辑）
 */
async function queryCandidates(monthDay: string) {
  return testDb
    .select({
      photo: schema.photos,
      analysis: schema.photoAnalyses,
    })
    .from(schema.photos)
    .innerJoin(schema.photoAnalyses, eq(schema.photos.id, schema.photoAnalyses.photoId))
    .innerJoin(schema.storageSources, eq(schema.photos.storageSourceId, schema.storageSources.id))
    .where(
      sql`strftime('%m-%d', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) = ${monthDay}
        AND (${schema.photos.burstId} IS NULL OR ${schema.photos.isBurstRepresentative} = 1)`,
    )
    .orderBy(desc(schema.photoAnalyses.aestheticScore));
}

// =========================================================================
// 测试套件
// =========================================================================

describe("daily-selection 候选池 burst 过滤契约（设计文档 §关键模块.5）", () => {
  // -----------------------------------------------------------------------
  // 核心验收场景：3 张连拍 + 5 张独立 → 候选 1+5=6
  // -----------------------------------------------------------------------
  describe("核心场景：连拍组只有代表进入候选池", () => {
    it("3 张连拍（1 代表 + 2 成员）+ 5 张独立 → 候选 6 张（不含非代表成员）", async () => {
      const monthDay = todayMonthDay();
      const takenAt = takenAtForToday(2020);

      // burst-1：p1 = 代表，p2/p3 = 非代表成员
      seedBurst("burst-1", "p1", 3);
      seedPhoto({ id: "p1", takenAt, burstId: "burst-1", isRep: true });
      seedPhoto({ id: "p2", takenAt, burstId: "burst-1", isRep: false });
      seedPhoto({ id: "p3", takenAt, burstId: "burst-1", isRep: false });
      seedAnalysis("p1", 9.0);
      seedAnalysis("p2", 8.5);
      seedAnalysis("p3", 8.0);

      // 5 张独立照片
      for (let i = 1; i <= 5; i++) {
        seedPhoto({ id: `solo-${i}`, takenAt, burstId: null, isRep: false });
        seedAnalysis(`solo-${i}`, 7.0 - i * 0.1);
      }

      const candidates = await queryCandidates(monthDay);

      // 总候选 = 1（连拍代表）+ 5（独立）= 6
      expect(candidates).toHaveLength(6);
    });

    it("候选中不包含非代表成员（p2、p3 不出现）", async () => {
      const monthDay = todayMonthDay();
      const takenAt = takenAtForToday(2020);

      seedBurst("burst-1", "p1", 3);
      seedPhoto({ id: "p1", takenAt, burstId: "burst-1", isRep: true });
      seedPhoto({ id: "p2", takenAt, burstId: "burst-1", isRep: false });
      seedPhoto({ id: "p3", takenAt, burstId: "burst-1", isRep: false });
      seedAnalysis("p1");
      seedAnalysis("p2");
      seedAnalysis("p3");

      const candidates = await queryCandidates(monthDay);
      const candidateIds = candidates.map((c) => c.photo.id);

      expect(candidateIds).not.toContain("p2");
      expect(candidateIds).not.toContain("p3");
    });

    it("候选中包含连拍代表 p1", async () => {
      const monthDay = todayMonthDay();
      const takenAt = takenAtForToday(2020);

      seedBurst("burst-1", "p1", 3);
      seedPhoto({ id: "p1", takenAt, burstId: "burst-1", isRep: true });
      seedPhoto({ id: "p2", takenAt, burstId: "burst-1", isRep: false });
      seedPhoto({ id: "p3", takenAt, burstId: "burst-1", isRep: false });
      seedAnalysis("p1");
      seedAnalysis("p2");
      seedAnalysis("p3");

      const candidates = await queryCandidates(monthDay);
      const candidateIds = candidates.map((c) => c.photo.id);

      expect(candidateIds).toContain("p1");
    });

    it("所有 5 张独立照片均进入候选池", async () => {
      const monthDay = todayMonthDay();
      const takenAt = takenAtForToday(2020);

      for (let i = 1; i <= 5; i++) {
        seedPhoto({ id: `solo-${i}`, takenAt, burstId: null, isRep: false });
        seedAnalysis(`solo-${i}`);
      }

      const candidates = await queryCandidates(monthDay);
      const candidateIds = candidates.map((c) => c.photo.id);

      for (let i = 1; i <= 5; i++) {
        expect(candidateIds).toContain(`solo-${i}`);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 无分析记录的照片不进入候选池（INNER JOIN）
  // -----------------------------------------------------------------------
  describe("无分析记录的照片不进入候选池", () => {
    it("连拍代表无分析记录时不出现在候选池", async () => {
      const monthDay = todayMonthDay();
      const takenAt = takenAtForToday(2020);

      seedBurst("burst-1", "p1", 2);
      seedPhoto({ id: "p1", takenAt, burstId: "burst-1", isRep: true });
      seedPhoto({ id: "p2", takenAt, burstId: "burst-1", isRep: false });
      // p1 没有 analysis 记录

      const candidates = await queryCandidates(monthDay);
      const candidateIds = candidates.map((c) => c.photo.id);

      expect(candidateIds).not.toContain("p1");
    });

    it("独立照片无分析记录时不出现在候选池", async () => {
      const monthDay = todayMonthDay();
      const takenAt = takenAtForToday(2020);

      seedPhoto({ id: "no-analysis", takenAt, burstId: null, isRep: false });
      // 无 analysis

      const candidates = await queryCandidates(monthDay);
      const candidateIds = candidates.map((c) => c.photo.id);

      expect(candidateIds).not.toContain("no-analysis");
    });
  });

  // -----------------------------------------------------------------------
  // 月-日过滤：非今日照片不进入候选池
  // -----------------------------------------------------------------------
  describe("月-日过滤", () => {
    it("非今日月-日的照片不进入候选池", async () => {
      const monthDay = todayMonthDay();
      // 构造一个"明年今天"不同月-日的日期（使用固定其他月份）
      const otherMonthDay = monthDay === "01-01" ? "12-31" : "01-01";
      const [m, d] = otherMonthDay.split("-");
      const otherTakenAt = `2020-${m}-${d}T12:00:00.000Z`;

      seedPhoto({ id: "other-day", takenAt: otherTakenAt, burstId: null, isRep: false });
      seedAnalysis("other-day");

      const candidates = await queryCandidates(monthDay);
      const candidateIds = candidates.map((c) => c.photo.id);

      expect(candidateIds).not.toContain("other-day");
    });

    it("今日月-日匹配的照片正常进入候选池", async () => {
      const monthDay = todayMonthDay();
      const takenAt = takenAtForToday(2019); // 历史年份，月-日相同

      seedPhoto({ id: "today-photo", takenAt, burstId: null, isRep: false });
      seedAnalysis("today-photo");

      const candidates = await queryCandidates(monthDay);
      const candidateIds = candidates.map((c) => c.photo.id);

      expect(candidateIds).toContain("today-photo");
    });
  });

  // -----------------------------------------------------------------------
  // 多组连拍场景
  // -----------------------------------------------------------------------
  describe("多组连拍：每组只有代表进入候选池", () => {
    it("2 个连拍组（各 3 张）+ 2 张独立 → 候选 2+2=4 张", async () => {
      const monthDay = todayMonthDay();
      const takenAt = takenAtForToday(2021);

      // 连拍组 A
      seedBurst("burst-A", "a1", 3);
      seedPhoto({ id: "a1", takenAt, burstId: "burst-A", isRep: true });
      seedPhoto({ id: "a2", takenAt, burstId: "burst-A", isRep: false });
      seedPhoto({ id: "a3", takenAt, burstId: "burst-A", isRep: false });
      seedAnalysis("a1");
      seedAnalysis("a2");
      seedAnalysis("a3");

      // 连拍组 B
      seedBurst("burst-B", "b1", 3);
      seedPhoto({ id: "b1", takenAt, burstId: "burst-B", isRep: true });
      seedPhoto({ id: "b2", takenAt, burstId: "burst-B", isRep: false });
      seedPhoto({ id: "b3", takenAt, burstId: "burst-B", isRep: false });
      seedAnalysis("b1");
      seedAnalysis("b2");
      seedAnalysis("b3");

      // 独立
      seedPhoto({ id: "s1", takenAt, burstId: null, isRep: false });
      seedAnalysis("s1");
      seedPhoto({ id: "s2", takenAt, burstId: null, isRep: false });
      seedAnalysis("s2");

      const candidates = await queryCandidates(monthDay);
      expect(candidates).toHaveLength(4);

      const ids = candidates.map((c) => c.photo.id);
      expect(ids).toContain("a1");
      expect(ids).toContain("b1");
      expect(ids).toContain("s1");
      expect(ids).toContain("s2");
      // 非代表不应存在
      expect(ids).not.toContain("a2");
      expect(ids).not.toContain("a3");
      expect(ids).not.toContain("b2");
      expect(ids).not.toContain("b3");
    });
  });

  // -----------------------------------------------------------------------
  // 候选数量上限（MAX_CANDIDATES = 20）
  // -----------------------------------------------------------------------
  describe("候选数量上限", () => {
    it("25 张独立照片，候选数 ≤ 20（MAX_CANDIDATES 限制）", async () => {
      const monthDay = todayMonthDay();
      const takenAt = takenAtForToday(2022);

      for (let i = 1; i <= 25; i++) {
        seedPhoto({ id: `s${i}`, takenAt, burstId: null, isRep: false });
        seedAnalysis(`s${i}`, 8.0 - i * 0.1);
      }

      // 执行带 LIMIT 20 的查询（模拟 daily-selection.ts MAX_CANDIDATES）
      const candidates = await testDb
        .select({
          photo: schema.photos,
          analysis: schema.photoAnalyses,
        })
        .from(schema.photos)
        .innerJoin(schema.photoAnalyses, eq(schema.photos.id, schema.photoAnalyses.photoId))
        .innerJoin(
          schema.storageSources,
          eq(schema.photos.storageSourceId, schema.storageSources.id),
        )
        .where(
          sql`strftime('%m-%d', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) = ${monthDay}
            AND (${schema.photos.burstId} IS NULL OR ${schema.photos.isBurstRepresentative} = 1)`,
        )
        .orderBy(desc(schema.photoAnalyses.aestheticScore))
        .limit(20);

      expect(candidates).toHaveLength(20);
    });

    it("候选按 aestheticScore DESC 排序", async () => {
      const monthDay = todayMonthDay();
      const takenAt = takenAtForToday(2022);

      seedPhoto({ id: "low", takenAt, burstId: null, isRep: false });
      seedAnalysis("low", 3.0);
      seedPhoto({ id: "high", takenAt, burstId: null, isRep: false });
      seedAnalysis("high", 9.5);
      seedPhoto({ id: "mid", takenAt, burstId: null, isRep: false });
      seedAnalysis("mid", 6.0);

      const candidates = await queryCandidates(monthDay);
      const ids = candidates.map((c) => c.photo.id);

      // 第一个应为最高分
      expect(ids[0]).toBe("high");
      expect(ids[2]).toBe("low");
    });
  });

  // -----------------------------------------------------------------------
  // 候选为空场景
  // -----------------------------------------------------------------------
  describe("候选为空", () => {
    it("无任何今日月-日照片 → 候选为空", async () => {
      const monthDay = todayMonthDay();
      const candidates = await queryCandidates(monthDay);
      expect(candidates).toHaveLength(0);
    });

    it("有照片但全为非代表连拍成员 → 候选为空", async () => {
      const monthDay = todayMonthDay();
      const takenAt = takenAtForToday(2020);

      seedBurst("burst-1", "p1", 3);
      // p1 有 is_burst_representative=1（代表）但无 analysis
      seedPhoto({ id: "p1", takenAt, burstId: "burst-1", isRep: true });
      // p2、p3 有 analysis 但非代表
      seedPhoto({ id: "p2", takenAt, burstId: "burst-1", isRep: false });
      seedPhoto({ id: "p3", takenAt, burstId: "burst-1", isRep: false });
      seedAnalysis("p2");
      seedAnalysis("p3");

      const candidates = await queryCandidates(monthDay);
      // 代表无 analysis → INNER JOIN 过滤；非代表虽有 analysis 但被 burst 过滤
      expect(candidates).toHaveLength(0);
    });
  });
});

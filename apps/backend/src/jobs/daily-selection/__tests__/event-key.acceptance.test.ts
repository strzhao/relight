/**
 * 验收测试：方案 H — 事件键前置去重 + prompt 软约束撤销（红队）
 *
 * 覆盖设计文档「实现方案 H (dirname AND takenAt 同日去重)」全量契约：
 *
 * Part 1: computeEventKey 单元测试（纯函数，无 DB 依赖）
 *   EK-1  正确计算事件键：dirname + "::" + date(takenAt)
 *   EK-2  NULL takenAt → 返回 null
 *   EK-3  不同 dirname、相同 date → 不同事件键（不冲突）
 *   EK-4  相同 dirname、不同 date → 不同事件键（不冲突）
 *   EK-5  POSIX 路径处理
 *   EK-6  带时区的 takenAt 仍正确提取日期
 *
 * Part 2: getRecentPickedEventKeys 集成测试（真实 SQLite :memory:）
 *   EK-7  从 daily_picks 读取 hero photoId + members photoId → excludeIds
 *   EK-8  从 daily_pick_entries 读取 photoId + members → excludeIds
 *   EK-9  JOIN photos 表获取 file_path + taken_at → 计算事件键
 *   EK-10 taken_at 为 NULL 的行不生成事件键（不 crash）
 *   EK-11 返回类型 { eventKeys: Set<string>, excludeIds: Set<string> }
 *
 * Part 3: buildCandidatePool 事件键过滤（真实 SQLite :memory:）
 *   EK-12 同事件键（同 dirname + 同 date）候选被过滤排除
 *   EK-13 不同 dirname、相同 date → 不被事件键过滤（保留）
 *   EK-14 相同 dirname、不同 date → 不被事件键过滤（保留）
 *   EK-15 NULL taken_at 候选不受事件键过滤影响（保留，不 crash）
 *   EK-16 30 天窗口边界：第 30 天排除，第 31 天恢复
 *   EK-17 photoId 30 天去重独立生效（双重过滤：excludeIds + eventKeys 正交）
 *
 * Part 4: Prompt 软约束撤销（文件契约）
 *   EK-18 recent-titles.ts 文件不存在于磁盘
 *   EK-19 narrate/user.txt 不含 {recent_titles} 占位符
 *   EK-20 narrate/system.txt 不含「避免重复标题」规则
 *   EK-21 daily-selection.ts 不含 queryRecentTitles 标识符
 *   EK-22 daily-selection.ts 不含 recentTitles 标识符
 *
 * Part 5: 契约类型验证
 *   EK-23 computeEventKey 签名符合设计文档
 *   EK-24 getRecentPickedEventKeys 可选参数
 *   EK-25 buildCandidatePool 接受 eventKeys 参数
 *   EK-26 excludeIds 兼容原 getRecentPickedPhotoIds 返回类型
 *
 * 红队铁律：
 * - 不读取蓝队新增/修改的函数体，仅基于设计文档契约设计期望
 * - 每个测试用例包含强断言（expect 确认通过/不通过）
 * - 绝不允许 test.skip / try-catch 吞异常 / 条件跳过
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "../../../__tests__/helpers/test-schema";
import * as schema from "../../../db/schema";

// =========================================================================
// 共享 mock：所有 describe 共用一份 db mock（与 candidate-pool.integration.test.ts 模式一致）
// =========================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;

vi.mock("../../../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

// =========================================================================
// Part 1: computeEventKey 单元测试（纯函数）
// =========================================================================

describe("Part 1: computeEventKey 计算正确性", () => {
  it("EK-1: 正确计算事件键 — dirname + '::' + takenAt 前 10 字符", async () => {
    const { computeEventKey } = await import("../candidate-pool");

    // path.posix.dirname("/storage/Vacation/beach.jpg") → "/storage/Vacation"
    const key = computeEventKey("/storage/Vacation/beach.jpg", "2026-01-10T08:00:00Z");
    expect(key).toBe("/storage/Vacation::2026-01-10");
  });

  it("EK-1b: POSIX 路径多层嵌套仍提取最近父目录名", async () => {
    const { computeEventKey } = await import("../candidate-pool");

    const key = computeEventKey(
      "/data/photos/2024/Summer Trip/DSC0001.jpg",
      "2024-07-15T14:30:00Z",
    );
    expect(key).toBe("/data/photos/2024/Summer Trip::2024-07-15");
  });

  it("EK-1c: 根级文件路径（dirname 返回 '/'）", async () => {
    const { computeEventKey } = await import("../candidate-pool");

    // path.posix.dirname("/beach.jpg") 返回 "/"
    const key = computeEventKey("/beach.jpg", "2026-01-10T08:00:00Z");
    expect(key).toBe("/::2026-01-10");
  });

  it("EK-2: takenAt 为 null → 返回 null（不 crash）", async () => {
    const { computeEventKey } = await import("../candidate-pool");

    const key = computeEventKey("/storage/Vacation/beach.jpg", null);
    expect(key).toBeNull();
  });

  it("EK-2b: takenAt 为空字符串 → 返回 null（空串 falsy，不生成事件键）", async () => {
    const { computeEventKey } = await import("../candidate-pool");

    // 设计文档契约: if (!takenAt) return null — 空串属于 falsy
    const key = computeEventKey("/storage/Vacation/beach.jpg", "");
    expect(key).toBeNull();
  });

  it("EK-3: 不同 dirname、相同 date → 不同事件键（相互不冲突）", async () => {
    const { computeEventKey } = await import("../candidate-pool");

    const keyA = computeEventKey("/storage/Vacation/beach.jpg", "2026-01-10T08:00:00Z");
    const keyB = computeEventKey("/storage/Beach/coast.jpg", "2026-01-10T14:00:00Z");

    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("/storage/Vacation::2026-01-10");
    expect(keyB).toBe("/storage/Beach::2026-01-10");
  });

  it("EK-4: 相同 dirname、不同 date → 不同事件键（相互不冲突）", async () => {
    const { computeEventKey } = await import("../candidate-pool");

    const keyA = computeEventKey("/storage/Vacation/beach.jpg", "2026-01-10T08:00:00Z");
    const keyB = computeEventKey("/storage/Vacation/sunset.jpg", "2026-01-11T18:00:00Z");

    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("/storage/Vacation::2026-01-10");
    expect(keyB).toBe("/storage/Vacation::2026-01-11");
  });

  it("EK-5: 使用 path.posix.dirname 提取目录（非 path.dirname）", async () => {
    const { computeEventKey } = await import("../candidate-pool");

    // 验证 Windows 风格反斜杠不会被 path.posix 拆分（反斜杠在 POSIX 中不是分隔符）
    const key = computeEventKey("C:\\Users\\Photos\\beach.jpg", "2026-01-10T08:00:00Z");
    // path.posix.dirname("C:\\Users\\Photos\\beach.jpg") → "C:\\Users\\Photos"
    const posixDir = path.posix.dirname("C:\\Users\\Photos\\beach.jpg");
    expect(key).toBe(`${posixDir}::2026-01-10`);
  });

  it("EK-6: 带时区偏移的 takenAt 仍正确提取日期部分", async () => {
    const { computeEventKey } = await import("../candidate-pool");

    // 带 '+08:00' 时区
    const key = computeEventKey("/storage/Vacation/beach.jpg", "2026-01-10T08:00:00+08:00");
    expect(key).toBe("/storage/Vacation::2026-01-10");

    // 带 'Z' 后缀
    const keyZ = computeEventKey("/storage/Vacation/beach.jpg", "2026-01-10T00:00:00Z");
    expect(keyZ).toBe("/storage/Vacation::2026-01-10");
  });
});

// =========================================================================
// Part 2: getRecentPickedEventKeys 集成测试
// =========================================================================

describe("Part 2: getRecentPickedEventKeys 集成测试", () => {
  beforeEach(() => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  function addSource(id = "src1") {
    testSqlite
      .prepare(
        "INSERT OR IGNORE INTO storage_sources (id, name, type, root_path) VALUES (?, ?, 'local', '/tmp')",
      )
      .run(id, "test");
  }

  function insertPhoto(
    photoId: string,
    filePath: string,
    takenAt: string | null,
    sourceId = "src1",
  ) {
    const now = new Date().toISOString();
    testSqlite
      .prepare(
        `INSERT OR IGNORE INTO photos
          (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at)
         VALUES (?, ?, ?, ?, 100, 100, 1024, ?, ?)`,
      )
      .run(photoId, sourceId, filePath, `hash-${photoId}`, takenAt, now);

    testSqlite
      .prepare(
        `INSERT OR IGNORE INTO photo_analyses
          (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
         VALUES (?, ?, 'test', 8.0, '{}', ?)`,
      )
      .run(`analysis-${photoId}`, photoId, now);
  }

  function addDailyPick(
    pickId: string,
    photoId: string,
    pickDate: string,
    members: { photoId: string; caption: string }[] = [],
  ) {
    testSqlite
      .prepare(
        `INSERT OR IGNORE INTO daily_picks
          (id, photo_id, pick_date, title, narrative, score, members, created_at)
         VALUES (?, ?, ?, 'test', 'test', 8.0, ?, ?)`,
      )
      .run(pickId, photoId, pickDate, JSON.stringify(members), new Date().toISOString());
  }

  function addDailyPickEntry(
    entryId: string,
    dailyPickId: string,
    rank: number,
    photoId: string,
    members: { photoId: string; caption: string }[] = [],
  ) {
    testSqlite
      .prepare(
        `INSERT OR IGNORE INTO daily_pick_entries
          (id, daily_pick_id, rank, photo_id, title, narrative, score, members, created_at)
         VALUES (?, ?, ?, ?, 'test', 'test', 8.0, ?, ?)`,
      )
      .run(entryId, dailyPickId, rank, photoId, JSON.stringify(members), new Date().toISOString());
  }

  it("EK-7: 从 daily_picks 读取 hero photoId + members photoId → excludeIds", async () => {
    const { getRecentPickedEventKeys } = await import("../candidate-pool");
    addSource();

    // 插入 hero 照片和 member 照片
    insertPhoto("hero1", "/Vacation/hero1.jpg", "2025-06-15T10:00:00Z");
    insertPhoto("member1", "/Vacation/member1.jpg", "2025-06-15T10:05:00Z");

    // 5 天前的精选
    const pickDate = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
    addDailyPick("pick-1", "hero1", pickDate, [{ photoId: "member1", caption: "test" }]);

    const { excludeIds } = await getRecentPickedEventKeys(30);

    // hero 和 member 都在 excludeIds 中
    expect(excludeIds.has("hero1")).toBe(true);
    expect(excludeIds.has("member1")).toBe(true);
  });

  it("EK-8: 从 daily_pick_entries 读取 photoId + members → excludeIds", async () => {
    const { getRecentPickedEventKeys } = await import("../candidate-pool");
    addSource();

    insertPhoto("entry_hero", "/Beach/entry_hero.jpg", "2025-06-15T10:00:00Z");
    insertPhoto("entry_member", "/Beach/entry_member.jpg", "2025-06-15T10:05:00Z");

    const pickDate = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);

    // 先插入 daily_picks（FK 必需）
    addDailyPick("pick-2", "entry_hero", pickDate, []);

    // 插入 daily_pick_entries
    addDailyPickEntry("entry-1", "pick-2", 0, "entry_hero", [
      { photoId: "entry_member", caption: "test" },
    ]);

    const { excludeIds } = await getRecentPickedEventKeys(30);

    expect(excludeIds.has("entry_hero")).toBe(true);
    expect(excludeIds.has("entry_member")).toBe(true);
  });

  it("EK-9: JOIN photos 表获取 file_path + taken_at → 计算事件键加入 eventKeys", async () => {
    const { getRecentPickedEventKeys } = await import("../candidate-pool");
    addSource();

    insertPhoto("key_hero", "/Vacation/key_hero.jpg", "2025-06-15T10:00:00Z");

    const pickDate = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
    addDailyPick("pick-3", "key_hero", pickDate, []);

    const { eventKeys, excludeIds } = await getRecentPickedEventKeys(30);

    expect(excludeIds.has("key_hero")).toBe(true);
    // 事件键应包含 "Vacation::2025-06-15"
    expect(eventKeys.has("/Vacation::2025-06-15")).toBe(true);
  });

  it("EK-10: taken_at 为 NULL 的照片不生成事件键（不 crash，excludeIds 仍正常收集）", async () => {
    const { getRecentPickedEventKeys } = await import("../candidate-pool");
    addSource();

    // 照片 taken_at 为 NULL
    insertPhoto("null_time_hero", "/Unknown/null_hero.jpg", null);

    const pickDate = new Date(Date.now() - 4 * 86400_000).toISOString().slice(0, 10);
    addDailyPick("pick-4", "null_time_hero", pickDate, []);

    // 不应 crash
    const { eventKeys, excludeIds } = await getRecentPickedEventKeys(30);

    // excludeIds 包含该 photoId（ID 去重仍生效）
    expect(excludeIds.has("null_time_hero")).toBe(true);

    // 但 eventKeys 不应包含 null-takenAt 照片的事件键
    // （因为 computeEventKey(null) → null，null 不会被加入 Set）
    for (const key of eventKeys) {
      expect(key).not.toBeNull();
    }
  });

  it("EK-11: 返回类型符合 { eventKeys: Set<string>, excludeIds: Set<string> }", async () => {
    const { getRecentPickedEventKeys } = await import("../candidate-pool");
    addSource();

    insertPhoto("type_test", "/Vacation/type_test.jpg", "2025-06-15T10:00:00Z");

    const pickDate = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    addDailyPick("pick-5", "type_test", pickDate, []);

    const result = await getRecentPickedEventKeys(30);

    // 类型契约：eventKeys 是 Set<string>，excludeIds 是 Set<string>
    expect(result).toHaveProperty("eventKeys");
    expect(result).toHaveProperty("excludeIds");
    expect(result.eventKeys instanceof Set).toBe(true);
    expect(result.excludeIds instanceof Set).toBe(true);

    // 非空时有元素
    expect(result.excludeIds.size).toBeGreaterThan(0);
  });
});

// =========================================================================
// Part 3: buildCandidatePool 事件键过滤集成测试
// =========================================================================

describe("Part 3: buildCandidatePool 事件键过滤", () => {
  beforeEach(() => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  function addSource(id = "src1") {
    testSqlite
      .prepare(
        "INSERT OR IGNORE INTO storage_sources (id, name, type, root_path) VALUES (?, ?, 'local', '/tmp')",
      )
      .run(id, "test");
  }

  /** 插入带显式 dirname 的照片（用于精确控制事件键） */
  function sqliteInsertPhoto(
    photoId: string,
    takenAt: string | null,
    dirname: string,
    aestheticScore = 8.0,
    sourceId = "src1",
  ) {
    const createdAt = takenAt ?? new Date().toISOString();
    testSqlite
      .prepare(
        `INSERT OR IGNORE INTO photos
          (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at)
         VALUES (?, ?, ?, ?, 100, 100, 1024, ?, ?)`,
      )
      .run(photoId, sourceId, `${dirname}/${photoId}.jpg`, `hash-${photoId}`, takenAt, createdAt);

    testSqlite
      .prepare(
        `INSERT OR IGNORE INTO photo_analyses
          (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
         VALUES (?, ?, 'test', ?, '{}', ?)`,
      )
      .run(`analysis-${photoId}`, photoId, aestheticScore, new Date().toISOString());
  }

  function addDailyPick(
    pickId: string,
    photoId: string,
    pickDate: string,
    members: { photoId: string; caption: string }[] = [],
  ) {
    testSqlite
      .prepare(
        `INSERT OR IGNORE INTO daily_picks
          (id, photo_id, pick_date, title, narrative, score, members, created_at)
         VALUES (?, ?, ?, 'test', 'test', 8.0, ?, ?)`,
      )
      .run(pickId, photoId, pickDate, JSON.stringify(members), new Date().toISOString());
  }

  /**
   * 构造一个固定的 now（2026-06-15 UTC，北京时间 2026-06-15 中午）。
   * 候选照片的 takenAt 散布在 2025-06-x（同月不同日），命中 sameMonth 源。
   */
  const FIXED_NOW = new Date("2026-06-15T04:00:00Z");

  it("EK-12: 同事件键（同 dirname + 同 date）候选被事件键过滤排除", async () => {
    const { buildCandidatePool, getRecentPickedEventKeys } = await import("../candidate-pool");
    addSource();

    // Step 1: 在 daily_picks 中放入一张 Vacation 目录下 2025-06-20 的照片
    // 其事件键 = "Vacation::2025-06-20"
    const pickDate = new Date(FIXED_NOW.getTime() - 5 * 86400_000).toISOString().slice(0, 10);
    sqliteInsertPhoto("picked_hero", "2025-06-20T10:00:00Z", "/Vacation", 8.0);
    addDailyPick("pick-ek12", "picked_hero", pickDate, []);

    const { eventKeys, excludeIds } = await getRecentPickedEventKeys(30, FIXED_NOW);
    // 确保事件键集合包含 "Vacation::2025-06-20"
    expect(eventKeys.has("/Vacation::2025-06-20")).toBe(true);

    // Step 2: 插入候选照片 A：同 dirname="/Vacation" + 同 date="2025-06-20" → 事件键冲突
    // 照片 A 的 takenAt = 2025-06-20，同月不同日（day=20 != 15），命中 sameMonth 源
    sqliteInsertPhoto("conflict_cand", "2025-06-20T14:00:00Z", "/Vacation", 9.0);

    // Step 3: 插入候选照片 B（不冲突的对照）：不同 dirname，用于确保候选池非空
    sqliteInsertPhoto("safe_cand", "2025-06-21T10:00:00Z", "/Beach", 8.5);

    // Step 4: 调用 buildCandidatePool（传入 eventKeys）
    const result = await buildCandidatePool({
      now: FIXED_NOW,
      excludeIds,
      eventKeys,
      maxN: 5,
    });

    const resultIds = result.map((r) => r.photoId);

    // 冲突候选应被过滤
    expect(resultIds).not.toContain("conflict_cand");
    // 安全候选应保留
    expect(resultIds).toContain("safe_cand");
  });

  it("EK-13: 不同 dirname、相同 date → 不被事件键过滤（事件键不同，保留）", async () => {
    const { buildCandidatePool, getRecentPickedEventKeys } = await import("../candidate-pool");
    addSource();

    // 精选照片：Vacation 目录 2025-06-20 → 事件键 "Vacation::2025-06-20"
    const pickDate = new Date(FIXED_NOW.getTime() - 5 * 86400_000).toISOString().slice(0, 10);
    sqliteInsertPhoto("picked_v", "2025-06-20T10:00:00Z", "/Vacation", 8.0);
    addDailyPick("pick-ek13", "picked_v", pickDate, []);

    const { eventKeys, excludeIds } = await getRecentPickedEventKeys(30, FIXED_NOW);
    expect(eventKeys.has("/Vacation::2025-06-20")).toBe(true);

    // 候选照片 B：Beach 目录 2025-06-20 → 事件键 "Beach::2025-06-20"（不同 dirname）
    // 同样命中 sameMonth 源（month=06, day=20）
    sqliteInsertPhoto("diff_dir_cand", "2025-06-20T14:00:00Z", "/Beach", 9.0);

    const result = await buildCandidatePool({
      now: FIXED_NOW,
      excludeIds,
      eventKeys,
      maxN: 5,
    });

    const resultIds = result.map((r) => r.photoId);

    // 不同 dirname → 不同事件键 → 应保留
    expect(resultIds).toContain("diff_dir_cand");
  });

  it("EK-14: 相同 dirname、不同 date → 不被事件键过滤（事件键不同，保留）", async () => {
    const { buildCandidatePool, getRecentPickedEventKeys } = await import("../candidate-pool");
    addSource();

    // 精选照片：Vacation 目录 2025-06-20 → 事件键 "Vacation::2025-06-20"
    const pickDate = new Date(FIXED_NOW.getTime() - 5 * 86400_000).toISOString().slice(0, 10);
    sqliteInsertPhoto("picked_v2", "2025-06-20T10:00:00Z", "/Vacation", 8.0);
    addDailyPick("pick-ek14", "picked_v2", pickDate, []);

    const { eventKeys, excludeIds } = await getRecentPickedEventKeys(30, FIXED_NOW);
    expect(eventKeys.has("/Vacation::2025-06-20")).toBe(true);

    // 候选照片 C：Vacation 目录 2025-06-21 → 事件键 "Vacation::2025-06-21"（不同 date）
    // 同样命中 sameMonth 源（month=06, day=21 != 15）
    sqliteInsertPhoto("diff_date_cand", "2025-06-21T10:00:00Z", "/Vacation", 9.0);

    const result = await buildCandidatePool({
      now: FIXED_NOW,
      excludeIds,
      eventKeys,
      maxN: 5,
    });

    const resultIds = result.map((r) => r.photoId);

    // 同 dirname + 不同 date → 不同事件键 → 应保留
    expect(resultIds).toContain("diff_date_cand");
  });

  it("EK-15: NULL taken_at 候选不受事件键过滤影响（保留，不 crash）", async () => {
    const { buildCandidatePool, getRecentPickedEventKeys } = await import("../candidate-pool");
    addSource();

    // 精选照片：Vacation 目录 2025-06-20 → 事件键 "Vacation::2025-06-20"
    const pickDate = new Date(FIXED_NOW.getTime() - 5 * 86400_000).toISOString().slice(0, 10);
    sqliteInsertPhoto("picked_v3", "2025-06-20T10:00:00Z", "/Vacation", 8.0);
    addDailyPick("pick-ek15", "picked_v3", pickDate, []);

    const { eventKeys, excludeIds } = await getRecentPickedEventKeys(30, FIXED_NOW);
    expect(eventKeys.has("/Vacation::2025-06-20")).toBe(true);

    // 候选 D：taken_at = NULL，但 createdAt 设为 2025-06-21（命中 sameMonth 源）
    // computeEventKey(filePath, null) → null → 不会被事件键过滤
    const createdAt = "2025-06-21T10:00:00Z";
    testSqlite
      .prepare(
        `INSERT OR IGNORE INTO photos
          (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at)
         VALUES (?, ?, ?, ?, 100, 100, 1024, NULL, ?)`,
      )
      .run(
        "null_taken_cand",
        "src1",
        "/Vacation/null_taken_cand.jpg",
        "hash-null-taken-cand",
        createdAt,
      );

    testSqlite
      .prepare(
        `INSERT OR IGNORE INTO photo_analyses
          (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
         VALUES (?, ?, 'test', 9.0, '{}', ?)`,
      )
      .run("analysis-null-taken-cand", "null_taken_cand", new Date().toISOString());

    // 不应 crash
    const result = await buildCandidatePool({
      now: FIXED_NOW,
      excludeIds,
      eventKeys,
      maxN: 5,
    });

    const resultIds = result.map((r) => r.photoId);

    // NULL takenAt 的候选应保留（不被事件键过滤）
    expect(resultIds).toContain("null_taken_cand");
  });

  it("EK-16: 30 天窗口边界 — 第 30 天排除，第 31 天恢复", async () => {
    const { buildCandidatePool, getRecentPickedEventKeys } = await import("../candidate-pool");
    addSource();

    // 构造 now 和两个精选日期：30 天前（应排除）和 31 天前（不排除）
    const now = new Date("2026-06-15T04:00:00Z");
    const day30 = new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
    const day31 = new Date(now.getTime() - 31 * 86400_000).toISOString().slice(0, 10);

    // 两张精选照片：Vacation/2025-06-20 → Vacation::2025-06-20
    // pick_date = day30（被包含在 30 天窗口内）
    sqliteInsertPhoto("hero_day30", "2025-06-20T10:00:00Z", "/Vacation", 8.0);
    addDailyPick("pick-day30", "hero_day30", day30, []);

    // 另一张精选 pick_date = day31（超出 30 天窗口）
    sqliteInsertPhoto("hero_day31", "2025-06-20T10:00:00Z", "/Park", 8.0);
    addDailyPick("pick-day31", "hero_day31", day31, []);

    const { eventKeys, excludeIds } = await getRecentPickedEventKeys(30, now);

    // day30 的 photoId 和事件键应在集合中
    expect(excludeIds.has("hero_day30")).toBe(true);
    expect(eventKeys.has("/Vacation::2025-06-20")).toBe(true);

    // day31 的 photoId 不应在 excludeIds 中（超出窗口）
    expect(excludeIds.has("hero_day31")).toBe(false);

    // 现在插入候选，使用相同事件键 "Vacation::2025-06-20"
    // 候选应因命中 day30 的事件键被排除
    sqliteInsertPhoto("boundary_cand", "2025-06-20T14:00:00Z", "/Vacation", 9.0);

    // 同时插入对照（不同 dirname，不会被事件键过滤）
    sqliteInsertPhoto("boundary_ctrl", "2025-06-21T10:00:00Z", "/Mountain", 8.5);

    const result = await buildCandidatePool({
      now,
      excludeIds,
      eventKeys,
      maxN: 5,
    });

    const resultIds = result.map((r) => r.photoId);

    // 同事件键候选被排除（由 day30 的精选触发）
    expect(resultIds).not.toContain("boundary_cand");
    // 对照应保留
    expect(resultIds).toContain("boundary_ctrl");
  });

  it("EK-17: photoId 30 天去重独立生效（双重过滤：excludeIds + eventKeys 正交）", async () => {
    const { buildCandidatePool, getRecentPickedEventKeys } = await import("../candidate-pool");
    addSource();

    // 场景：同一张照片的 photoId 在 excludeIds 中（ID 去重），
    // 同时另一张照片的事件键在 eventKeys 中（事件键去重）。
    // 两项过滤独立生效，互不干扰。

    const pickDate = new Date(FIXED_NOW.getTime() - 5 * 86400_000).toISOString().slice(0, 10);

    // 精选1: Mountain 目录 → excludeIds 包含 hero_mt（ID 去重测试用）
    sqliteInsertPhoto("hero_mt", "2025-06-20T10:00:00Z", "/Mountain", 8.0);
    addDailyPick("pick-mt", "hero_mt", pickDate, []);

    // 精选2: Beach 目录 → eventKeys 包含 "Beach::2025-06-20"（事件键去重测试用）
    sqliteInsertPhoto("hero_beach", "2025-06-20T10:00:00Z", "/Beach", 8.0);
    addDailyPick(
      "pick-beach",
      "hero_beach",
      new Date(FIXED_NOW.getTime() - 6 * 86400_000).toISOString().slice(0, 10),
      [],
    );

    const { eventKeys, excludeIds } = await getRecentPickedEventKeys(30, FIXED_NOW);

    // excludeIds 包含 hero_mt
    expect(excludeIds.has("hero_mt")).toBe(true);
    // eventKeys 包含 "Beach::2025-06-20"
    expect(eventKeys.has("/Beach::2025-06-20")).toBe(true);

    // 候选A：与精选2 同事件键（Beach + 2025-06-20）→ 事件键过滤排除
    sqliteInsertPhoto("beach_conflict", "2025-06-20T14:00:00Z", "/Beach", 9.0);

    // 候选B：安全对照（不受任何过滤影响）
    sqliteInsertPhoto("safe_dual", "2025-06-22T10:00:00Z", "/Forest", 8.5);

    const result = await buildCandidatePool({
      now: FIXED_NOW,
      excludeIds,
      eventKeys,
      maxN: 5,
    });

    const resultIds = result.map((r) => r.photoId);

    // ID 去重：hero_mt 应被排除（在 excludeIds 中）
    expect(resultIds).not.toContain("hero_mt");

    // 事件键去重：beach_conflict 应被排除（事件键 = "Beach::2025-06-20" 命中）
    expect(resultIds).not.toContain("beach_conflict");

    // 安全候选应保留
    expect(resultIds).toContain("safe_dual");
  });
});

// =========================================================================
// Part 4: Prompt 软约束撤销（文件契约）
// =========================================================================

describe("Part 4: Prompt 软约束全部撤销（文件契约）", () => {
  // 后端 src 目录（相对于本测试文件）
  const BACKEND_SRC = path.resolve(__dirname, "..", "..", "..");

  it("EK-18: recent-titles.ts 文件不存在于磁盘", () => {
    // 设计文档契约：recent-titles.ts 文件已被删除
    const recentTitlesPath = path.join(BACKEND_SRC, "jobs", "daily-selection", "recent-titles.ts");
    expect(existsSync(recentTitlesPath)).toBe(false);
  });

  it("EK-19: narrate/user.txt 不含 {recent_titles} 占位符", () => {
    const userPromptPath = path.join(
      BACKEND_SRC,
      "ai",
      "prompts",
      "v2",
      "daily",
      "narrate",
      "user.txt",
    );
    const content = readFileSync(userPromptPath, "utf-8");
    expect(content).not.toContain("{recent_titles}");
    expect(content).not.toContain("recent_titles");
  });

  it("EK-19b: narrate-video/user.txt 不含 {recent_titles} 占位符", () => {
    const videoUserPath = path.join(
      BACKEND_SRC,
      "ai",
      "prompts",
      "v2",
      "daily",
      "narrate-video",
      "user.txt",
    );
    const content = readFileSync(videoUserPath, "utf-8");
    expect(content).not.toContain("{recent_titles}");
    expect(content).not.toContain("recent_titles");
  });

  it("EK-20: narrate/system.txt 不含「避免重复标题」规则", () => {
    const systemPromptPath = path.join(
      BACKEND_SRC,
      "ai",
      "prompts",
      "v2",
      "daily",
      "narrate",
      "system.txt",
    );
    const content = readFileSync(systemPromptPath, "utf-8");
    expect(content).not.toContain("避免重复标题");
  });

  it("EK-20b: narrate-video/system.txt 不含「避免重复标题」规则", () => {
    const videoSystemPath = path.join(
      BACKEND_SRC,
      "ai",
      "prompts",
      "v2",
      "daily",
      "narrate-video",
      "system.txt",
    );
    const content = readFileSync(videoSystemPath, "utf-8");
    expect(content).not.toContain("避免重复标题");
  });

  it("EK-21: daily-selection.ts 不含 queryRecentTitles 标识符", () => {
    const dailySelectionPath = path.join(BACKEND_SRC, "jobs", "daily-selection.ts");
    const content = readFileSync(dailySelectionPath, "utf-8");
    expect(content).not.toContain("queryRecentTitles");
  });

  it("EK-22: daily-selection.ts 不含 recentTitles 标识符", () => {
    // 设计文档契约：processSingleEntry 签名删除 recentTitles 参数；
    // .replace("{recent_titles}", recentTitles) 调用删除
    const dailySelectionPath = path.join(BACKEND_SRC, "jobs", "daily-selection.ts");
    const content = readFileSync(dailySelectionPath, "utf-8");
    expect(content).not.toContain("recentTitles");
    expect(content).not.toContain("{recent_titles}");
  });
});

// =========================================================================
// Part 5: 契约类型验证
// =========================================================================

describe("Part 5: 契约类型 + 导出验证", () => {
  beforeEach(() => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  it("EK-23: computeEventKey 签名符合 (filePath: string, takenAt: string | null): string | null", async () => {
    const { computeEventKey } = await import("../candidate-pool");

    // 类型签名验证：调用签名参数顺序和返回类型
    const result1: string | null = computeEventKey("/a/b.jpg", "2026-01-10T00:00:00Z");
    const result2: string | null = computeEventKey("/a/b.jpg", null);

    expect(typeof result1).toBe("string");
    expect(result2).toBeNull();
  });

  it("EK-24: getRecentPickedEventKeys 签名接受 (daysBack?, now?) 可选参数", async () => {
    const { getRecentPickedEventKeys } = await import("../candidate-pool");

    // 无参数调用不抛异常
    const result1 = await getRecentPickedEventKeys();
    expect(result1).toHaveProperty("eventKeys");
    expect(result1).toHaveProperty("excludeIds");

    // 仅 daysBack 参数
    const result2 = await getRecentPickedEventKeys(30);
    expect(result2).toHaveProperty("eventKeys");

    // daysBack + now
    const result3 = await getRecentPickedEventKeys(30, new Date());
    expect(result3).toHaveProperty("eventKeys");
  });

  it("EK-25: buildCandidatePool 接受 eventKeys 参数（BuildCandidatePoolOptions.eventKeys）", async () => {
    // 需要 storage_sources 有一行，否则 JOIN 返回空
    testSqlite
      .prepare(
        "INSERT OR IGNORE INTO storage_sources (id, name, type, root_path) VALUES ('src1', 'test', 'local', '/tmp')",
      )
      .run();

    const { buildCandidatePool } = await import("../candidate-pool");

    // 验证 eventKeys 参数被接受且不抛异常
    const result = await buildCandidatePool({
      excludeIds: new Set<string>(),
      eventKeys: new Set<string>(["test::2026-01-01"]),
      maxN: 3,
    });

    // 返回类型是 ClusteredCandidate[]
    expect(Array.isArray(result)).toBe(true);
  });

  it("EK-26: getRecentPickedEventKeys 返回的 excludeIds 可用于替代原 getRecentPickedPhotoIds", async () => {
    const { getRecentPickedEventKeys } = await import("../candidate-pool");

    const { excludeIds } = await getRecentPickedEventKeys(30, new Date());

    // excludeIds 是 Set<string>，与原 getRecentPickedPhotoIds 返回类型一致
    expect(excludeIds instanceof Set).toBe(true);
    // 可以传给 buildCandidatePool 的 excludeIds 参数（类型兼容）
    expect(typeof excludeIds.has).toBe("function");
  });
});

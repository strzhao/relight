/**
 * 验收测试：photoId 去重集合（getPickedPhotoIds）+ 历史约束撤销契约
 *
 * 前身 event-key.acceptance.test.ts 验收「方案 H — 事件键（dirname::拍摄日）去重」。
 * 2026-11-22 事件键去重撤销（连坐封杀同目录同天全部照片，200 天后把主路径高分池
 * 打穿 → 触发 30 天窗口兜底 → 每日精选每 30 天循环重复，详见 candidate-pool.ts
 * 文件头），本文件只保留仍有契约价值的部分：
 *
 * Part 1: getPickedPhotoIds 集成测试（真实 SQLite :memory:）
 *   PP-1  从 daily_picks 读取 hero photoId + members photoId
 *   PP-2  从 daily_pick_entries 读取 photoId + members（跨表去重）
 *   PP-3  签名接受 (daysBack?, now?) 可选参数
 *
 * Part 2: Prompt 软约束撤销（文件契约，原 EK-18~22 原样保留）
 *   PP-4  recent-titles.ts 文件不存在于磁盘
 *   PP-5  narrate(/narrate-video) 的 user.txt 不含 {recent_titles} 占位符
 *   PP-6  narrate(/narrate-video) 的 system.txt 不含「避免重复标题」规则
 *   PP-7  daily-selection.ts 不含 queryRecentTitles / recentTitles 标识符
 *
 * Part 3: 事件键去重撤销防回归（2026-11-22）
 *   PP-8  candidate-pool.ts 不含 computeEventKey / eventKeys 标识符——
 *         防止事件键连坐被无意恢复（该行为已被生产事故证伪）
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "../../../__tests__/helpers/test-schema";
import * as schema from "../../../db/schema";

// =========================================================================
// 共享 mock：与 candidate-pool.integration.test.ts 模式一致
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
// Part 1: getPickedPhotoIds 集成测试
// =========================================================================

describe("Part 1: getPickedPhotoIds 集成测试", () => {
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

  function insertPhoto(photoId: string, filePath: string, takenAt: string | null) {
    const now = new Date().toISOString();
    testSqlite
      .prepare(
        `INSERT OR IGNORE INTO photos
          (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at)
         VALUES (?, ?, ?, ?, 100, 100, 1024, ?, ?)`,
      )
      .run(photoId, "src1", filePath, `hash-${photoId}`, takenAt, now);

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

  it("PP-1: 从 daily_picks 读取 hero photoId + members photoId", async () => {
    const { getPickedPhotoIds } = await import("../candidate-pool");
    addSource();

    insertPhoto("hero1", "/Vacation/hero1.jpg", "2025-06-15T10:00:00Z");
    insertPhoto("member1", "/Vacation/member1.jpg", "2025-06-15T10:05:00Z");

    const pickDate = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
    addDailyPick("pick-1", "hero1", pickDate, [{ photoId: "member1", caption: "test" }]);

    const excludeIds = await getPickedPhotoIds(30);

    expect(excludeIds.has("hero1")).toBe(true);
    expect(excludeIds.has("member1")).toBe(true);
  });

  it("PP-2: 从 daily_pick_entries 读取 photoId + members（跨表去重）", async () => {
    const { getPickedPhotoIds } = await import("../candidate-pool");
    addSource();

    insertPhoto("entry_hero", "/Beach/entry_hero.jpg", "2025-06-15T10:00:00Z");
    insertPhoto("entry_member", "/Beach/entry_member.jpg", "2025-06-15T10:05:00Z");

    const pickDate = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);

    addDailyPick("pick-2", "entry_hero", pickDate, []);
    addDailyPickEntry("entry-1", "pick-2", 0, "entry_hero", [
      { photoId: "entry_member", caption: "test" },
    ]);

    const excludeIds = await getPickedPhotoIds(30);

    expect(excludeIds.has("entry_hero")).toBe(true);
    expect(excludeIds.has("entry_member")).toBe(true);
  });

  it("PP-3: 签名接受 (daysBack?, now?) 可选参数", async () => {
    const { getPickedPhotoIds } = await import("../candidate-pool");

    await expect(getPickedPhotoIds()).resolves.toBeInstanceOf(Set);
    await expect(getPickedPhotoIds(30)).resolves.toBeInstanceOf(Set);
    await expect(getPickedPhotoIds("all", new Date())).resolves.toBeInstanceOf(Set);
  });
});

// =========================================================================
// Part 2: Prompt 软约束撤销（文件契约，原 EK-18~22）
// =========================================================================

describe("Part 2: Prompt 软约束全部撤销（文件契约）", () => {
  // 后端 src 目录（相对于本测试文件）
  const BACKEND_SRC = path.resolve(__dirname, "..", "..", "..");

  it("PP-4: recent-titles.ts 文件不存在于磁盘", () => {
    const recentTitlesPath = path.join(BACKEND_SRC, "jobs", "daily-selection", "recent-titles.ts");
    expect(existsSync(recentTitlesPath)).toBe(false);
  });

  it("PP-5: narrate(/narrate-video) 的 user.txt 不含 {recent_titles} 占位符", () => {
    for (const dir of ["narrate", "narrate-video"]) {
      const userPromptPath = path.join(
        BACKEND_SRC,
        "ai",
        "prompts",
        "v2",
        "daily",
        dir,
        "user.txt",
      );
      const content = readFileSync(userPromptPath, "utf-8");
      expect(content).not.toContain("{recent_titles}");
      expect(content).not.toContain("recent_titles");
    }
  });

  it("PP-6: narrate(/narrate-video) 的 system.txt 不含「避免重复标题」规则", () => {
    for (const dir of ["narrate", "narrate-video"]) {
      const systemPromptPath = path.join(
        BACKEND_SRC,
        "ai",
        "prompts",
        "v2",
        "daily",
        dir,
        "system.txt",
      );
      const content = readFileSync(systemPromptPath, "utf-8");
      expect(content).not.toContain("避免重复标题");
    }
  });

  it("PP-7: daily-selection.ts 不含 queryRecentTitles / recentTitles 标识符", () => {
    const dailySelectionPath = path.join(BACKEND_SRC, "jobs", "daily-selection.ts");
    const content = readFileSync(dailySelectionPath, "utf-8");
    expect(content).not.toContain("queryRecentTitles");
    expect(content).not.toContain("recentTitles");
    expect(content).not.toContain("{recent_titles}");
  });
});

// =========================================================================
// Part 3: 事件键去重撤销防回归（2026-11-22）
// =========================================================================

describe("Part 3: 事件键去重撤销防回归（文件契约）", () => {
  // 后端 src 目录（相对于本测试文件）
  const BACKEND_SRC = path.resolve(__dirname, "..", "..", "..");

  it("PP-8: candidate-pool.ts 不含事件键标识符（防连坐行为被无意恢复）", () => {
    const poolPath = path.join(BACKEND_SRC, "jobs", "daily-selection", "candidate-pool.ts");
    const content = readFileSync(poolPath, "utf-8");
    // 事件键的实现标识符与参数名全部不应存在
    // （文件头注释中允许出现「事件键」中文叙述，故只查代码标识符）
    expect(content).not.toContain("computeEventKey");
    expect(content).not.toContain("eventKeys");
    expect(content).not.toContain("filterByEventKey");
    expect(content).not.toContain("getRecentPickedEventKeys");
    expect(content).not.toContain("::${");
  });
});

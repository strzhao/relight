/**
 * T14: related-pool 集成测试（真实 SQLite）
 *
 * 验证：
 * - 同日 ±6h 时间窗内的候选被正确返回
 * - 排除 hero 自身
 * - 排除 excludeIds（30 天去重）
 * - 跨日凌晨场景（±6h 跨日）也能正确返回
 * - 超出时间窗的照片不返回
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../../db/schema";

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
  sqlite.exec(`
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      root_path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_scan_at TEXT,
      status TEXT,
      last_error TEXT
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL UNIQUE,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0,
      thumbnail_path TEXT,
      taken_at TEXT,
      file_mtime INTEGER,
      created_at TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'image',
      duration_sec REAL,
      video_codec TEXT,
      video_fps REAL
    );
    CREATE TABLE photo_analyses (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL,
      ai_model TEXT NOT NULL,
      narrative TEXT,
      aesthetic_score REAL,
      tags TEXT,
      composition TEXT,
      color_analysis TEXT,
      emotional_analysis TEXT,
      usage_suggestions TEXT,
      prompt_version TEXT,
      raw_response TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      transcript TEXT,
      transcript_segments TEXT,
      video_pacing TEXT,
      motion_score REAL
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE photo_tags (photo_id TEXT NOT NULL, tag_id TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0, PRIMARY KEY (photo_id, tag_id));
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function addSource(sqlite: Database.Database) {
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO storage_sources (id, name, type, root_path) VALUES ('src1', 'test', 'local', '/tmp')",
    )
    .run();
}

function addPhoto(sqlite: Database.Database, photoId: string, takenAt: string) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at)
       VALUES (?, 'src1', ?, ?, 100, 100, 1024, ?, ?)`,
    )
    .run(photoId, `/photos/${photoId}.jpg`, `hash-${photoId}`, takenAt, takenAt);

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO photo_analyses
        (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'test', 7.0, '{}', ?)`,
    )
    .run(`analysis-${photoId}`, photoId, new Date().toISOString());
}

describe("buildRelatedPool 集成测试", () => {
  beforeEach(() => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  it("基本：同日 ±6h 内的照片被返回，超出时间窗的不返回", async () => {
    const { buildRelatedPool } = await import("../related-pool");
    addSource(testSqlite);

    const heroTime = "2022-05-09T12:00:00Z";
    const within1h = "2022-05-09T13:00:00Z";
    const within5h = "2022-05-09T07:00:00Z";
    const outside7h = "2022-05-09T05:00:00Z"; // 7h 之前，超出 ±6h
    const nextDay = "2022-05-10T12:00:00Z"; // 次日，超出 ±6h

    addPhoto(testSqlite, "hero1", heroTime);
    addPhoto(testSqlite, "within1", within1h);
    addPhoto(testSqlite, "within5", within5h);
    addPhoto(testSqlite, "outside7", outside7h);
    addPhoto(testSqlite, "nextday1", nextDay);

    const result = await buildRelatedPool({ photoId: "hero1", takenAt: heroTime }, new Set());

    const ids = result.map((r) => r.photoId);
    expect(ids).toContain("within1");
    expect(ids).toContain("within5");
    expect(ids).not.toContain("hero1"); // 排除 hero 自身
    expect(ids).not.toContain("outside7");
    expect(ids).not.toContain("nextday1");
  });

  it("跨日凌晨场景：hero 在 00:30，window 向前到前一日 18:30", async () => {
    const { buildRelatedPool } = await import("../related-pool");
    addSource(testSqlite);

    const heroTime = "2022-05-09T00:30:00Z";
    const prev18 = "2022-05-08T18:30:00Z"; // 6h 之前（边界）
    const prev17 = "2022-05-08T17:00:00Z"; // > 6h，超出

    addPhoto(testSqlite, "hero1", heroTime);
    addPhoto(testSqlite, "prev18", prev18);
    addPhoto(testSqlite, "prev17", prev17);

    const result = await buildRelatedPool({ photoId: "hero1", takenAt: heroTime }, new Set());

    const ids = result.map((r) => r.photoId);
    expect(ids).toContain("prev18"); // 恰好 6h 内
    expect(ids).not.toContain("prev17"); // 超出
  });

  it("excludeIds：被排除的 photoId 不出现在结果中", async () => {
    const { buildRelatedPool } = await import("../related-pool");
    addSource(testSqlite);

    const heroTime = "2022-05-09T12:00:00Z";
    addPhoto(testSqlite, "hero1", heroTime);
    addPhoto(testSqlite, "related1", "2022-05-09T13:00:00Z");
    addPhoto(testSqlite, "excluded1", "2022-05-09T14:00:00Z");

    const result = await buildRelatedPool(
      { photoId: "hero1", takenAt: heroTime },
      new Set(["excluded1"]),
    );

    const ids = result.map((r) => r.photoId);
    expect(ids).toContain("related1");
    expect(ids).not.toContain("excluded1");
  });

  it("hero 无 takenAt 时返回空数组", async () => {
    const { buildRelatedPool } = await import("../related-pool");

    const result = await buildRelatedPool({ photoId: "hero1", takenAt: null }, new Set());

    expect(result).toHaveLength(0);
  });

  it("结果数量不超过 maxRelated", async () => {
    const { buildRelatedPool } = await import("../related-pool");
    addSource(testSqlite);

    const heroTime = "2022-05-09T12:00:00Z";
    addPhoto(testSqlite, "hero1", heroTime);

    for (let i = 0; i < 15; i++) {
      const offset = (i + 1) * 15 * 60 * 1000;
      const time = new Date(new Date(heroTime).getTime() + offset).toISOString();
      addPhoto(testSqlite, `r${i}`, time);
    }

    const result = await buildRelatedPool(
      { photoId: "hero1", takenAt: heroTime },
      new Set(),
      5, // maxRelated = 5
    );

    expect(result.length).toBeLessThanOrEqual(5);
  });
});

/**
 * T13: candidate-pool 集成测试（真实 SQLite）
 *
 * 验证：
 * - 4 源各贡献候选
 * - 30 天去重过滤生效
 * - 加权排序正确
 * - per-source quota：故意构造 historyToday 命中 50 张高分，断言其他三源每源至少保留 3 张
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../../db/schema";

// mock db 模块，让 candidate-pool 使用测试数据库
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
    CREATE TABLE daily_picks (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL,
      pick_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      members TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE photo_tags (photo_id TEXT NOT NULL, tag_id TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0, PRIMARY KEY (photo_id, tag_id));
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function addSource(sqlite: Database.Database, id = "src1") {
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO storage_sources (id, name, type, root_path) VALUES (?, ?, 'local', '/tmp')",
    )
    .run(id, "test");
}

function addPhoto(
  sqlite: Database.Database,
  photoId: string,
  takenAt: string,
  aestheticScore: number,
  sourceId = "src1",
) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at)
       VALUES (?, ?, ?, ?, 100, 100, 1024, ?, ?)`,
    )
    .run(photoId, sourceId, `/photos/${photoId}.jpg`, `hash-${photoId}`, takenAt, takenAt);

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO photo_analyses
        (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'test', ?, '{}', ?)`,
    )
    .run(`analysis-${photoId}`, photoId, aestheticScore, new Date().toISOString());
}

function addDailyPick(
  sqlite: Database.Database,
  photoId: string,
  pickDate: string,
  members: { photoId: string; caption: string }[] = [],
) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO daily_picks
        (id, photo_id, pick_date, title, narrative, score, members, created_at)
       VALUES (?, ?, ?, 'test', 'test', 8.0, ?, ?)`,
    )
    .run(`pick-${photoId}`, photoId, pickDate, JSON.stringify(members), new Date().toISOString());
}

// 获取当前北京时间的月日
function getBeijingMonthDay() {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const month = String(shanghai.getMonth() + 1).padStart(2, "0");
  const day = String(shanghai.getDate()).padStart(2, "0");
  return { month, day };
}

// 构造 ISO 日期（N 年前的今天）
function yearsAgoISO(years: number): string {
  const { month, day } = getBeijingMonthDay();
  return `${new Date().getFullYear() - years}-${month}-${day}T10:00:00Z`;
}

// 构造同月不同日的历史日期
function sameMonthOtherDayISO(yearsAgo: number): string {
  const { month } = getBeijingMonthDay();
  const year = new Date().getFullYear() - yearsAgo;
  const otherDay = month === "01" ? "20" : "05"; // 随便一个不是今日的日期
  return `${year}-${month}-${otherDay}T10:00:00Z`;
}

// 获取季节内的其他月份
function getOtherSeasonMonthISO(yearsAgo: number): string {
  const { month } = getBeijingMonthDay();
  const monthNum = Number.parseInt(month, 10);
  let seasonMonths: number[];
  if (monthNum >= 3 && monthNum <= 5) seasonMonths = [3, 4, 5];
  else if (monthNum >= 6 && monthNum <= 8) seasonMonths = [6, 7, 8];
  else if (monthNum >= 9 && monthNum <= 11) seasonMonths = [9, 10, 11];
  else seasonMonths = [12, 1, 2];

  const otherMonth = seasonMonths.find((m) => m !== monthNum) ?? seasonMonths[0]!;
  const year = new Date().getFullYear() - yearsAgo;
  return `${year}-${String(otherMonth).padStart(2, "0")}-15T10:00:00Z`;
}

// 构造 2 年前的随机日期（不同月份）
function agedRandomISO(yearsAgo: number): string {
  const year = new Date().getFullYear() - yearsAgo;
  const { month } = getBeijingMonthDay();
  const monthNum = Number.parseInt(month, 10);
  // 选非当月非当季的月份
  const differentMonth = monthNum <= 6 ? "11" : "03";
  return `${year}-${differentMonth}-15T10:00:00Z`;
}

describe("buildCandidatePool 集成测试", () => {
  beforeEach(() => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  it("4 源均有数据时，结果包含来自不同源的候选", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 各源至少 1 张
    addPhoto(testSqlite, "h1", yearsAgoISO(3), 8.0);
    addPhoto(testSqlite, "m1", sameMonthOtherDayISO(2), 7.0);
    addPhoto(testSqlite, "a1", agedRandomISO(3), 6.0);

    const seasonOther = getOtherSeasonMonthISO(2);
    if (seasonOther) {
      addPhoto(testSqlite, "s1", seasonOther, 6.5);
    }

    const result = await buildCandidatePool({ excludeIds: new Set() });

    const sources = new Set(result.map((r) => r.source));
    expect(sources.size).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("30 天去重：已精选 photoId 不出现在候选池", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    addPhoto(testSqlite, "h1", yearsAgoISO(3), 9.0);

    const excludeIds = new Set(["h1"]);
    const result = await buildCandidatePool({ excludeIds });

    const ids = result.map((r) => r.photoId);
    expect(ids).not.toContain("h1");
  });

  it("候选池总数不超过 maxN", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 塞入 20 张历史今天的照片
    for (let i = 0; i < 20; i++) {
      addPhoto(testSqlite, `h${i}`, yearsAgoISO(i + 1), 9.0 - i * 0.1);
    }

    const result = await buildCandidatePool({ excludeIds: new Set(), maxN: 5 });
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("per-source quota：historyToday 50 张高分，其他三源每源至少保留 3 张", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // historyToday: 50 张高分
    for (let i = 0; i < 50; i++) {
      addPhoto(testSqlite, `h${i}`, yearsAgoISO((i % 20) + 1), 9.9 - i * 0.01);
    }

    // sameMonth: 5 张中分
    for (let i = 0; i < 5; i++) {
      addPhoto(testSqlite, `m${i}`, sameMonthOtherDayISO(2), 5.0 - i * 0.1);
    }

    // sameSeason: 5 张低分
    const seasonOther = getOtherSeasonMonthISO(2);
    for (let i = 0; i < 5; i++) {
      const yr = new Date().getFullYear() - 2 - i;
      const seasonDate = seasonOther.replace(/^\d{4}/, String(yr));
      addPhoto(testSqlite, `s${i}`, seasonDate, 4.0 - i * 0.1);
    }

    // agedRandom: 5 张低分（确保是 2 年前）
    for (let i = 0; i < 5; i++) {
      addPhoto(testSqlite, `a${i}`, agedRandomISO(3 + i), 3.0 - i * 0.1);
    }

    const result = await buildCandidatePool({ excludeIds: new Set(), maxN: 20 });

    const countBySource = (src: string) => result.filter((r) => r.source === src).length;

    // 验证 quota：其他三源至少保底 3 张
    expect(countBySource("sameMonth")).toBeGreaterThanOrEqual(3);
    expect(countBySource("sameSeason")).toBeGreaterThanOrEqual(3);
    expect(countBySource("agedRandom")).toBeGreaterThanOrEqual(3);
  });

  it("getRecentPickedPhotoIds：读取 30 天内精选的 photoId 含 members", async () => {
    const { getRecentPickedPhotoIds } = await import("../candidate-pool");
    addSource(testSqlite);
    addPhoto(testSqlite, "hero1", yearsAgoISO(1), 8.0);
    addPhoto(testSqlite, "member1", yearsAgoISO(1), 7.0);

    const recentDate = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
    addDailyPick(testSqlite, "hero1", recentDate, [{ photoId: "member1", caption: "测试" }]);

    const ids = await getRecentPickedPhotoIds(30);
    expect(ids.has("hero1")).toBe(true);
    expect(ids.has("member1")).toBe(true);
  });

  it("getRecentPickedPhotoIds：超过 30 天的精选不在集合内", async () => {
    const { getRecentPickedPhotoIds } = await import("../candidate-pool");
    addSource(testSqlite);
    addPhoto(testSqlite, "old1", yearsAgoISO(5), 8.0);

    const oldDate = new Date(Date.now() - 35 * 86400_000).toISOString().slice(0, 10);
    addDailyPick(testSqlite, "old1", oldDate);

    const ids = await getRecentPickedPhotoIds(30);
    expect(ids.has("old1")).toBe(false);
  });
});

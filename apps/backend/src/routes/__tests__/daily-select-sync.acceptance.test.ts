/**
 * 验收测试（红队）：手动选择壁纸照片后文案同步
 *
 * 设计文档（Bug 2）：
 *   POST /api/daily/today/select 在更新 dailyPicks.photoId 时，应同步更新
 *   title/narrative/score/members 四个字段为所选 photo 在 dailyPickEntries
 *   中对应 entry 的值。
 *
 * 验收场景 P2.1：
 *   POST /api/daily/today/select { photoId } 后 GET /api/daily/today
 *   响应中 data.title / data.narrative 与该 photoId 在 entries 中的文案一致。
 *   channel: det-machine
 *
 * 关键断言：
 *   1. POST select 后 DB daily_picks.title 等于所选 entry 的 title
 *   2. POST select 后 DB daily_picks.narrative 等于所选 entry 的 narrative
 *   3. POST select 后 DB daily_picks.score 等于所选 entry 的 score
 *   4. POST select 后 DB daily_picks.members 等于所选 entry 的 members
 *   5. POST select 后 GET /api/daily/today 返回的 data.title 与 entry 一致
 *   6. POST select 后 GET /api/daily/today 返回的 data.narrative 与 entry 一致
 *   7. 切换到不同 entry 后，四个字段同步更新为新 entry 的值
 *   8. 幂等：重复选择同一 photoId，字段不变
 *
 * 红队铁律：
 *   - 不读取任何蓝队实现文件（daily.ts 路由实现等）
 *   - 仅通过 HTTP 请求黑盒触发
 *   - 断言侧效（DB 状态 / API 响应）
 *   - 绝对禁止任何宽容跳过（try/catch 空处理、it.skip 等）
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

// =========================================================================
// 构建内存 SQLite（含 daily_picks + photos + daily_pick_entries 表）
// =========================================================================

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
      storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
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
      video_fps REAL,
      burst_id TEXT,
      is_burst_representative INTEGER NOT NULL DEFAULT 0,
      phash TEXT,
      latitude REAL,
      longitude REAL,
      altitude REAL,
      gps_img_direction REAL,
      offset_time TEXT,
      camera_make TEXT,
      camera_model TEXT,
      lens_model TEXT,
      focal_length REAL,
      focal_length_35mm INTEGER,
      iso INTEGER,
      exposure_time REAL,
      f_number REAL,
      software TEXT,
      exif_backfilled_at INTEGER
    );

    CREATE TABLE tags (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE photo_tags (
      photo_id TEXT NOT NULL, tag_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (photo_id, tag_id)
    );
    CREATE TABLE photo_analyses (
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL,
      ai_model TEXT NOT NULL, narrative TEXT,
      aesthetic_score REAL, tags TEXT, composition TEXT,
      color_analysis TEXT, emotional_analysis TEXT,
      usage_suggestions TEXT, prompt_version TEXT,
      raw_response TEXT NOT NULL, processed_at TEXT NOT NULL,
      transcript TEXT, transcript_segments TEXT,
      video_pacing TEXT, motion_score REAL
    );

    CREATE TABLE daily_picks (
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL,
      pick_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      composed_image_path TEXT,
      members TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE daily_pick_entries (
      id TEXT PRIMARY KEY,
      daily_pick_id TEXT NOT NULL REFERENCES daily_picks(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL,
      photo_id TEXT NOT NULL REFERENCES photos(id),
      title TEXT NOT NULL,
      narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      members TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(daily_pick_id, rank)
    );

    CREATE TABLE scan_logs (
      id TEXT PRIMARY KEY, storage_source_id TEXT NOT NULL,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE analyze_batches (
      id TEXT PRIMARY KEY, filter_json TEXT NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE analyze_batch_jobs (
      job_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

// =========================================================================
// 共享状态
// =========================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;
let app: import("hono").Hono;

const SOURCE_ID = "source-001";

// 北京时间今天的日期，格式 YYYY-MM-DD
const todayPickDate = (() => {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  return `${shanghai.getFullYear()}-${String(shanghai.getMonth() + 1).padStart(2, "0")}-${String(shanghai.getDate()).padStart(2, "0")}`;
})();

vi.mock("../../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

vi.mock("../../jobs/queues", () => ({
  scanQueue: { add: vi.fn().mockResolvedValue({ id: "j1" }) },
  analyzeQueue: { add: vi.fn().mockResolvedValue({ id: "j2" }) },
  dailyQueue: { add: vi.fn().mockResolvedValue({ id: "j3" }) },
}));

beforeEach(async () => {
  const t = createTestDb();
  testSqlite = t.sqlite;
  testDb = t.db;

  testSqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, 'TestSource', 'local', '/test', 1)",
    )
    .run(SOURCE_ID);

  vi.resetModules();
  const mod = await import("../../app");
  app = mod.createApp();
});

afterEach(() => {
  testSqlite.close();
});

// =========================================================================
// 辅助函数
// =========================================================================

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; contentType: string | null }> {
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, contentType: res.headers.get("Content-Type") };
}

const now = new Date();

/** 插入照片 */
function seedPhoto(id: string): void {
  testSqlite
    .prepare(
      `INSERT INTO photos
        (id, storage_source_id, file_path, file_hash, file_size, taken_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      SOURCE_ID,
      `/photos/${id}.jpg`,
      `hash-${id}`,
      1000,
      now.toISOString(),
      now.toISOString(),
    );
}

/** 插入 daily_pick 记录 */
function seedDailyPick(opts: {
  id: string;
  photoId: string;
  title?: string;
  narrative?: string;
  score?: number;
  members?: string;
  pickDate?: string;
}): void {
  const pickDate = opts.pickDate ?? todayPickDate;
  testSqlite
    .prepare(
      `INSERT INTO daily_picks
        (id, photo_id, pick_date, title, narrative, score, members, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.photoId,
      pickDate,
      opts.title ?? "旧标题",
      opts.narrative ?? "旧叙事文案",
      opts.score ?? 5.0,
      opts.members ?? "[]",
      now.toISOString(),
    );
}

/** 插入 daily_pick_entry 记录（含完整 title/narrative/score/members） */
function seedDailyPickEntry(opts: {
  id: string;
  dailyPickId: string;
  rank: number;
  photoId: string;
  title: string;
  narrative: string;
  score: number;
  members?: string;
}): void {
  testSqlite
    .prepare(
      `INSERT INTO daily_pick_entries
        (id, daily_pick_id, rank, photo_id, title, narrative, score, members, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.dailyPickId,
      opts.rank,
      opts.photoId,
      opts.title,
      opts.narrative,
      opts.score,
      opts.members ?? "[]",
      now.toISOString(),
    );
}

// =========================================================================
// P2.1: 手动选择后壁纸文案与所选照片匹配
// =========================================================================

describe("POST /api/daily/today/select — 手动选择后文案同步 (P2.1)", () => {
  it("选择 photo-b 后，DB daily_picks.title 应同步为 entry-1 的 title", async () => {
    seedPhoto("photo-a");
    seedPhoto("photo-b");

    // dailyPicks 当前主图为 photo-a，文案为旧值
    seedDailyPick({
      id: "pick-today",
      photoId: "photo-a",
      title: "旧标题",
      narrative: "旧叙事文案",
      score: 5.0,
      members: "[]",
    });

    // entry-0: photo-a 的专属文案
    seedDailyPickEntry({
      id: "entry-0",
      dailyPickId: "pick-today",
      rank: 0,
      photoId: "photo-a",
      title: "阿波罗的光芒",
      narrative: "清晨第一缕阳光穿过厚重的云层，照亮了沉睡的大地。",
      score: 8.5,
      members: '[{"photoId":"photo-m1","caption":"晨曦中的远山"}]',
    });

    // entry-1: photo-b 的专属文案（不同于默认值）
    seedDailyPickEntry({
      id: "entry-1",
      dailyPickId: "pick-today",
      rank: 1,
      photoId: "photo-b",
      title: "月下的静谧",
      narrative: "深夜的湖边，月光如银纱般洒落，水面泛起粼粼波光。",
      score: 9.0,
      members: '[{"photoId":"photo-m2","caption":"湖边的垂柳"}]',
    });

    // 选择 photo-b
    await request("POST", "/api/daily/today/select", { photoId: "photo-b" });

    // 验证 DB 中 daily_picks 的四个字段已同步为 entry-1 的值
    const row = testSqlite
      .prepare("SELECT photo_id, title, narrative, score, members FROM daily_picks WHERE id = ?")
      .get("pick-today") as {
      photo_id: string;
      title: string;
      narrative: string;
      score: number;
      members: string;
    };

    expect(row.photo_id).toBe("photo-b");
    expect(row.title).toBe("月下的静谧");
    expect(row.narrative).toBe("深夜的湖边，月光如银纱般洒落，水面泛起粼粼波光。");
    expect(row.score).toBe(9.0);
    expect(row.members).toBe('[{"photoId":"photo-m2","caption":"湖边的垂柳"}]');
  });

  it("选择 photo-b 后，GET /api/daily/today 返回的 title/narrative 与 entry-1 一致", async () => {
    seedPhoto("photo-a");
    seedPhoto("photo-b");

    seedDailyPick({
      id: "pick-today",
      photoId: "photo-a",
      title: "旧标题",
      narrative: "旧叙事文案",
      score: 5.0,
    });

    seedDailyPickEntry({
      id: "entry-0",
      dailyPickId: "pick-today",
      rank: 0,
      photoId: "photo-a",
      title: "阿波罗的光芒",
      narrative: "清晨第一缕阳光穿过厚重的云层，照亮了沉睡的大地。",
      score: 8.5,
    });

    seedDailyPickEntry({
      id: "entry-1",
      dailyPickId: "pick-today",
      rank: 1,
      photoId: "photo-b",
      title: "月下的静谧",
      narrative: "深夜的湖边，月光如银纱般洒落，水面泛起粼粼波光。",
      score: 9.0,
    });

    // 选择 photo-b
    const selectRes = await request("POST", "/api/daily/today/select", { photoId: "photo-b" });
    expect(selectRes.status).toBe(200);

    // GET today 验证响应
    const getRes = await request("GET", "/api/daily/today");
    expect(getRes.status).toBe(200);

    const b = getRes.body as {
      success: boolean;
      data: {
        photoId: string;
        title: string;
        narrative: string;
        score: number;
        members: unknown[];
      };
    };
    expect(b.success).toBe(true);
    expect(b.data).toBeDefined();

    // 核心断言：API 返回的文案与所选 entry 一致
    expect(b.data.photoId).toBe("photo-b");
    expect(b.data.title).toBe("月下的静谧");
    expect(b.data.narrative).toBe("深夜的湖边，月光如银纱般洒落，水面泛起粼粼波光。");
    expect(b.data.score).toBe(9.0);
  });

  it("切换回 photo-a 后，四个字段同步更新为 entry-0 的值", async () => {
    seedPhoto("photo-a");
    seedPhoto("photo-b");

    seedDailyPick({
      id: "pick-today",
      photoId: "photo-a",
      title: "阿波罗的光芒",
      narrative: "清晨第一缕阳光穿过厚重的云层。",
      score: 8.5,
    });

    seedDailyPickEntry({
      id: "entry-0",
      dailyPickId: "pick-today",
      rank: 0,
      photoId: "photo-a",
      title: "阿波罗的光芒",
      narrative: "清晨第一缕阳光穿过厚重的云层，照亮了沉睡的大地。",
      score: 8.5,
      members: '[{"photoId":"photo-m1","caption":"晨曦中的远山"}]',
    });

    seedDailyPickEntry({
      id: "entry-1",
      dailyPickId: "pick-today",
      rank: 1,
      photoId: "photo-b",
      title: "月下的静谧",
      narrative: "深夜的湖边，月光如银纱般洒落，水面泛起粼粼波光。",
      score: 9.0,
      members: '[{"photoId":"photo-m2","caption":"湖边的垂柳"}]',
    });

    // 先切换到 photo-b
    await request("POST", "/api/daily/today/select", { photoId: "photo-b" });

    // 再切回 photo-a
    const { status } = await request("POST", "/api/daily/today/select", { photoId: "photo-a" });
    expect(status).toBe(200);

    // 验证 DB 已同步为 entry-0 的值
    const row = testSqlite
      .prepare("SELECT photo_id, title, narrative, score, members FROM daily_picks WHERE id = ?")
      .get("pick-today") as {
      photo_id: string;
      title: string;
      narrative: string;
      score: number;
      members: string;
    };

    expect(row.photo_id).toBe("photo-a");
    expect(row.title).toBe("阿波罗的光芒");
    expect(row.narrative).toBe("清晨第一缕阳光穿过厚重的云层，照亮了沉睡的大地。");
    expect(row.score).toBe(8.5);
    expect(row.members).toBe('[{"photoId":"photo-m1","caption":"晨曦中的远山"}]');
  });

  it("幂等：重复选择同一 photoId，title/narrative/score/members 不变", async () => {
    seedPhoto("photo-a");
    seedPhoto("photo-b");

    seedDailyPick({
      id: "pick-today",
      photoId: "photo-a",
      title: "旧标题",
      narrative: "旧叙事文案",
      score: 5.0,
    });

    seedDailyPickEntry({
      id: "entry-0",
      dailyPickId: "pick-today",
      rank: 0,
      photoId: "photo-a",
      title: "阿波罗的光芒",
      narrative: "清晨第一缕阳光穿过厚重的云层。",
      score: 8.5,
    });

    seedDailyPickEntry({
      id: "entry-1",
      dailyPickId: "pick-today",
      rank: 1,
      photoId: "photo-b",
      title: "月下的静谧",
      narrative: "深夜的湖边，月光如银纱般洒落。",
      score: 9.0,
    });

    // 第一次选择 photo-b
    await request("POST", "/api/daily/today/select", { photoId: "photo-b" });

    // 第二次重复选择 photo-b（幂等）
    const { status } = await request("POST", "/api/daily/today/select", { photoId: "photo-b" });
    expect(status).toBe(200);

    const row = testSqlite
      .prepare("SELECT photo_id, title, narrative, score, members FROM daily_picks WHERE id = ?")
      .get("pick-today") as {
      photo_id: string;
      title: string;
      narrative: string;
      score: number;
      members: string;
    };

    // 字段不变
    expect(row.photo_id).toBe("photo-b");
    expect(row.title).toBe("月下的静谧");
    expect(row.narrative).toBe("深夜的湖边，月光如银纱般洒落。");
    expect(row.score).toBe(9.0);
  });

  it("entries 表不变（仅更新 daily_picks 的四个字段，不修改 entries）", async () => {
    seedPhoto("photo-a");
    seedPhoto("photo-b");

    seedDailyPick({
      id: "pick-today",
      photoId: "photo-a",
      title: "旧标题",
      narrative: "旧叙事",
      score: 5.0,
    });

    seedDailyPickEntry({
      id: "entry-0",
      dailyPickId: "pick-today",
      rank: 0,
      photoId: "photo-a",
      title: "阿波罗的光芒",
      narrative: "清晨第一缕阳光穿过厚重的云层。",
      score: 8.5,
      members: '[{"photoId":"photo-m1","caption":"晨曦"}]',
    });

    seedDailyPickEntry({
      id: "entry-1",
      dailyPickId: "pick-today",
      rank: 1,
      photoId: "photo-b",
      title: "月下的静谧",
      narrative: "深夜的湖边，月光如银纱般洒落。",
      score: 9.0,
      members: '[{"photoId":"photo-m2","caption":"垂柳"}]',
    });

    // 选择 photo-b 触发同步
    await request("POST", "/api/daily/today/select", { photoId: "photo-b" });

    // entries 应保持不变
    const entries = testSqlite
      .prepare(
        "SELECT id, photo_id, rank, title, narrative, score, members FROM daily_pick_entries WHERE daily_pick_id = ? ORDER BY rank ASC",
      )
      .all("pick-today") as {
      id: string;
      photo_id: string;
      rank: number;
      title: string;
      narrative: string;
      score: number;
      members: string;
    }[];

    expect(entries).toHaveLength(2);

    // entry-0 不变
    expect(entries[0]?.photo_id).toBe("photo-a");
    expect(entries[0]?.title).toBe("阿波罗的光芒");
    expect(entries[0]?.narrative).toBe("清晨第一缕阳光穿过厚重的云层。");
    expect(entries[0]?.score).toBe(8.5);
    expect(entries[0]?.members).toBe('[{"photoId":"photo-m1","caption":"晨曦"}]');

    // entry-1 不变
    expect(entries[1]?.photo_id).toBe("photo-b");
    expect(entries[1]?.title).toBe("月下的静谧");
    expect(entries[1]?.narrative).toBe("深夜的湖边，月光如银纱般洒落。");
    expect(entries[1]?.score).toBe(9.0);
    expect(entries[1]?.members).toBe('[{"photoId":"photo-m2","caption":"垂柳"}]');

    // daily_picks 的四个字段已同步
    const pick = testSqlite
      .prepare("SELECT photo_id, title, narrative, score, members FROM daily_picks WHERE id = ?")
      .get("pick-today") as {
      photo_id: string;
      title: string;
      narrative: string;
      score: number;
      members: string;
    };
    expect(pick.photo_id).toBe("photo-b");
    expect(pick.title).toBe("月下的静谧");
    expect(pick.narrative).toBe("深夜的湖边，月光如银纱般洒落。");
    expect(pick.score).toBe(9.0);
    expect(pick.members).toBe('[{"photoId":"photo-m2","caption":"垂柳"}]');
  });

  it("连续切换 3 次不同 photoId，每次四个字段均正确同步", async () => {
    seedPhoto("photo-a");
    seedPhoto("photo-b");
    seedPhoto("photo-c");

    seedDailyPick({
      id: "pick-today",
      photoId: "photo-a",
      title: "标题A",
      narrative: "叙事A",
      score: 7.0,
    });

    seedDailyPickEntry({
      id: "entry-0",
      dailyPickId: "pick-today",
      rank: 0,
      photoId: "photo-a",
      title: "标题A",
      narrative: "叙事A - 完整版",
      score: 7.0,
      members: '[{"photoId":"ma","caption":"A的回忆"}]',
    });

    seedDailyPickEntry({
      id: "entry-1",
      dailyPickId: "pick-today",
      rank: 1,
      photoId: "photo-b",
      title: "标题B",
      narrative: "叙事B - 完整版",
      score: 8.0,
      members: '[{"photoId":"mb","caption":"B的记忆"}]',
    });

    seedDailyPickEntry({
      id: "entry-2",
      dailyPickId: "pick-today",
      rank: 2,
      photoId: "photo-c",
      title: "标题C",
      narrative: "叙事C - 完整版",
      score: 9.0,
      members: '[{"photoId":"mc","caption":"C的瞬间"}]',
    });

    // 切换到 B
    await request("POST", "/api/daily/today/select", { photoId: "photo-b" });
    let row = testSqlite
      .prepare("SELECT photo_id, title, narrative, score FROM daily_picks WHERE id = ?")
      .get("pick-today") as { photo_id: string; title: string; narrative: string; score: number };
    expect(row.photo_id).toBe("photo-b");
    expect(row.title).toBe("标题B");
    expect(row.narrative).toBe("叙事B - 完整版");
    expect(row.score).toBe(8.0);

    // 切换到 C
    await request("POST", "/api/daily/today/select", { photoId: "photo-c" });
    row = testSqlite
      .prepare("SELECT photo_id, title, narrative, score FROM daily_picks WHERE id = ?")
      .get("pick-today") as { photo_id: string; title: string; narrative: string; score: number };
    expect(row.photo_id).toBe("photo-c");
    expect(row.title).toBe("标题C");
    expect(row.narrative).toBe("叙事C - 完整版");
    expect(row.score).toBe(9.0);

    // 切回 A
    await request("POST", "/api/daily/today/select", { photoId: "photo-a" });
    row = testSqlite
      .prepare("SELECT photo_id, title, narrative, score FROM daily_picks WHERE id = ?")
      .get("pick-today") as { photo_id: string; title: string; narrative: string; score: number };
    expect(row.photo_id).toBe("photo-a");
    expect(row.title).toBe("标题A");
    expect(row.narrative).toBe("叙事A - 完整版");
    expect(row.score).toBe(7.0);
  });
});

// =========================================================================
// 边界：无今日记录 / photo 不在 entries 中
// =========================================================================

describe("POST /api/daily/today/select — 边界场景", () => {
  it("无今日记录时返回 404，不涉及字段同步", async () => {
    const { status, body } = await request("POST", "/api/daily/today/select", {
      photoId: "photo-any",
    });
    expect(status).toBe(404);
    const b = body as { success: boolean };
    expect(b.success).toBe(false);
  });

  it("photoId 存在但不在任何 entry 中时（无法同步），不修改 daily_picks 文案", async () => {
    seedPhoto("photo-a");
    seedPhoto("photo-b");
    seedPhoto("photo-c"); // photo-c 不在 entries 中

    seedDailyPick({
      id: "pick-today",
      photoId: "photo-a",
      title: "原始标题",
      narrative: "原始叙事",
      score: 6.0,
    });

    seedDailyPickEntry({
      id: "entry-0",
      dailyPickId: "pick-today",
      rank: 0,
      photoId: "photo-a",
      title: "阿波罗的光芒",
      narrative: "清晨第一缕阳光。",
      score: 8.5,
    });

    seedDailyPickEntry({
      id: "entry-1",
      dailyPickId: "pick-today",
      rank: 1,
      photoId: "photo-b",
      title: "月下的静谧",
      narrative: "深夜的湖边。",
      score: 9.0,
    });

    // 选择 photo-c（不在任何 entry 中）
    const { status, body } = await request("POST", "/api/daily/today/select", {
      photoId: "photo-c",
    });

    // photo-c 在 photos 表存在，实现可能接受（200）或拒绝（400/404）
    // 关键断言：daily_picks 的 title/narrative/score/members 不应被破坏
    expect([200, 400, 404]).toContain(status);

    const row = testSqlite
      .prepare("SELECT photo_id, title, narrative, score FROM daily_picks WHERE id = ?")
      .get("pick-today") as {
      photo_id: string;
      title: string;
      narrative: string;
      score: number;
    };

    if (status === 200) {
      // 实现允许选择不在 entries 中的 photo，photo_id 会更新
      // 但 title/narrative 不应变成垃圾值（因为没有 entry 可同步）
      expect(row.photo_id).toBe("photo-c");
      // 文案不应为空或损坏
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.narrative.length).toBeGreaterThan(0);
    } else {
      // 实现拒绝了选择，daily_picks 保持原样
      expect(row.photo_id).toBe("photo-a");
      expect(row.title).toBe("原始标题");
      expect(row.narrative).toBe("原始叙事");
    }
  });
});

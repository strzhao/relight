/**
 * 验收测试：photos 路由视频专属端点（红队 / 风险点 F.2 + F.3）
 *
 * 设计契约：
 *   1. GET /api/photos/:id/raw 无 Range 头 → 200 + Accept-Ranges: bytes
 *   2. GET /api/photos/:id/raw with Range: bytes=0-1023
 *      → 206 + Content-Range: bytes 0-1023/<total> + Content-Length: 1024
 *   3. GET /api/photos/:id/subtitles.vtt 当 transcript_segments 至少一项
 *      → Content-Type 'text/vtt; charset=utf-8'
 *      → body 以 'WEBVTT' 开头
 *      → body 包含 segment 文本
 *   4. GET /api/photos/:id/subtitles.vtt 当 transcript_segments 为 null/空
 *      → 200，body 为空 WEBVTT 头（如 "WEBVTT\n\n"）
 *   5. 找不到 photo → 404
 *
 * 红队铁律：不读取 photos.ts 路由实现。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

// =====================================================================
// 1. fixture：写一个 > 1024 字节的真实视频文件（仅用于 Range 测试）
// =====================================================================

const FIXTURE_DIR = path.resolve(__dirname, "fixtures");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "test-video.mp4");
const FIXTURE_SIZE = 4096;

beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  // 写 4096 字节的填充数据
  const buf = Buffer.alloc(FIXTURE_SIZE);
  for (let i = 0; i < FIXTURE_SIZE; i++) buf[i] = i % 256;
  writeFileSync(FIXTURE_PATH, buf);
});

// =====================================================================
// 2. 共享内存 DB
// =====================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;

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
      video_fps REAL,
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
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL,
      pick_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, narrative TEXT NOT NULL,
      score REAL NOT NULL, ai_model TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE scan_logs (
      id TEXT PRIMARY KEY, storage_source_id TEXT NOT NULL,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE analyze_batches (
      id TEXT PRIMARY KEY, status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE analyze_batch_jobs (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL,
      photo_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

// =====================================================================
// 3. mocks（在 import app 之前 hoist）
// =====================================================================

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

// =====================================================================
// 4. 应用工厂
// =====================================================================

let app: import("hono").Hono;

beforeEach(async () => {
  const t = createTestDb();
  testSqlite = t.sqlite;
  testDb = t.db;

  // 写一个 storage_source，root_path 指向 fixture 目录的父目录
  testSqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, ?, 'local', ?, 1)",
    )
    .run("src-1", "test", FIXTURE_DIR);

  vi.resetModules();
  const mod = await import("../../app");
  app = mod.createApp();
});

afterEach(() => {
  testSqlite.close();
});

// =====================================================================
// 5. 辅助：seed 视频 photo（file_path 相对于 storage_source.root_path）
// =====================================================================

function seedVideoPhoto(
  id: string,
  opts: {
    transcriptSegments?: Array<{ start: number; end: number; text: string }> | null;
  } = {},
): void {
  testSqlite
    .prepare(
      `INSERT INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size,
         thumbnail_path, taken_at, created_at, media_type, duration_sec)
       VALUES (?, 'src-1', 'test-video.mp4', ?, 1920, 1080, ?, NULL, ?, ?, 'video', 30)`,
    )
    .run(id, `hash-${id}`, FIXTURE_SIZE, new Date().toISOString(), new Date().toISOString());

  testSqlite
    .prepare(
      `INSERT INTO photo_analyses
        (id, photo_id, ai_model, raw_response, processed_at, transcript_segments)
       VALUES (?, ?, 'qwen-vl', '{}', ?, ?)`,
    )
    .run(
      `analysis-${id}`,
      id,
      new Date().toISOString(),
      opts.transcriptSegments === undefined
        ? null
        : opts.transcriptSegments === null
          ? null
          : JSON.stringify(opts.transcriptSegments),
    );
}

// =====================================================================
// 6. 测试
// =====================================================================

describe("GET /api/photos/:id/raw — 视频原始流（验收）", () => {
  it("无 Range 头 → 200 + Accept-Ranges: bytes", async () => {
    seedVideoPhoto("v1");
    const res = await app.request("/api/photos/v1/raw");
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")?.toLowerCase()).toBe("bytes");
  });

  it("Range: bytes=0-1023 → 206 + Content-Range + Content-Length=1024", async () => {
    seedVideoPhoto("v2");
    const res = await app.request("/api/photos/v2/raw", {
      headers: { Range: "bytes=0-1023" },
    });
    expect(res.status).toBe(206);
    const cr = res.headers.get("content-range") ?? "";
    expect(cr).toMatch(/^bytes\s+0-1023\/\d+$/);
    // total 应等于 fixture 大小
    expect(cr).toContain(`/${FIXTURE_SIZE}`);
    expect(res.headers.get("content-length")).toBe("1024");
  });

  it("photo 不存在 → 404", async () => {
    const res = await app.request("/api/photos/nonexistent/raw");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/photos/:id/subtitles.vtt — WebVTT 字幕（验收）", () => {
  it("transcriptSegments 至少一项 → text/vtt + 含 WEBVTT 头 + 含 segment 文本", async () => {
    seedVideoPhoto("v3", {
      transcriptSegments: [
        { start: 0, end: 3, text: "山间的清晨" },
        { start: 3, end: 6, text: "鸟鸣声此起彼伏" },
      ],
    });

    const res = await app.request("/api/photos/v3/subtitles.vtt");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("text/vtt");
    expect(ct.toLowerCase()).toContain("charset=utf-8");

    const body = await res.text();
    expect(body.startsWith("WEBVTT")).toBe(true);
    expect(body).toContain("山间的清晨");
    expect(body).toContain("鸟鸣声此起彼伏");
  });

  it("transcriptSegments 为 null → 200 + body 仅 WEBVTT 头部（无 cue）", async () => {
    seedVideoPhoto("v4", { transcriptSegments: null });
    const res = await app.request("/api/photos/v4/subtitles.vtt");
    expect(res.status).toBe(200);
    const body = await res.text();
    // body 必须以 WEBVTT 开头，且无任何 cue（无 -->）
    expect(body.startsWith("WEBVTT")).toBe(true);
    expect(body).not.toContain("-->");
    // 长度应非常小（只有头部 + 可选空行），<= 16 字节足够
    expect(body.length).toBeLessThanOrEqual(16);
  });

  it("photo 不存在 → 404", async () => {
    const res = await app.request("/api/photos/nonexistent/subtitles.vtt");
    expect(res.status).toBe(404);
  });
});

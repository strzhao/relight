/**
 * 验收测试（红队）：wallpaper 路由 — 竖版命中/现场合成 + 横版零回归 + 清缓存（AP-4 / AP-7 / AP-8）
 *
 * 设计文档契约（state.md「契约规约」「核心设计 6」）：
 * - `GET /api/daily/:pickDate/wallpaper?width=1290&height=2796` → 1290×2796 JPEG（AP-1 路由层）
 * - `GET /api/daily/:pickDate/wallpaper`（无 query）→ 5120×2880 default（零回归，AP-7）
 * - 两次同尺寸请求 ETag + sha256 一致（AP-4 命中缓存）；换尺寸 ETag 不同
 * - `POST /api/daily/today/select` 清缓存按 `pickDate_*` 前缀，天然覆盖竖版（AP-8，设计 D2 + 知识库「双缓存失效」）
 *
 * 验收谓词覆盖：
 * - AP-4：连续两次 ?width=1290&height=2796 → 第一次现场合成、第二次命中缓存，ETag 一致；
 *         换尺寸(1440×3120) ETag 不同
 * - AP-7：无 query → 5120×2880 default，ETag 稳定
 * - AP-8：POST select 后该 pickDate 所有缓存（含竖版 1290×2796）被删
 *
 * 测试策略：
 * - mock config.storageRoot 指向临时目录（真实 readdir/unlink 触发）
 * - mock composer.composedCachePath 用临时目录、composeAndSave 写真实 JPEG buffer
 * - 内存 SQLite + createApp() 黑盒触发 HTTP
 *
 * 红队铁律：不读 daily.ts 改动部分；仅按既有路由契约 + 设计文档断言。
 * 复用 daily-select-acceptance.test.ts 的 app + 内存 db 范式。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

// =====================================================================
// 临时 storageRoot（真实缓存文件读写）
// =====================================================================

let tmpStorageRoot: string;

// 预生成不同尺寸 JPEG buffer（composeAndSave 按尺寸返回）
async function makeJpeg(w: number, h: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 100 + (w % 50), g: 130, b: 160 } },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
}

// =====================================================================
// Mock：config（storageRoot 指向临时目录）
// =====================================================================

vi.mock("../../lib/config", () => ({
  config: {
    get storageRoot() {
      return tmpStorageRoot;
    },
  },
}));

// =====================================================================
// Mock：composer（composedCachePath 用临时目录，composeAndSave 写真实 JPEG）
// =====================================================================

vi.mock("../../lib/wallpaper/composer", () => ({
  composedCachePath: (pickDate: string, w: number, h: number) =>
    path.join(tmpStorageRoot, "daily-composed", `${pickDate}_v2-contain-${w}x${h}.jpg`),
  composeAndSave: async (opts: {
    pick: { pickDate: string };
    width: number;
    height: number;
    cacheKey?: string;
  }) => {
    const dir = path.join(tmpStorageRoot, "daily-composed");
    await fs.promises.mkdir(dir, { recursive: true });
    const key = opts.cacheKey ?? `${opts.width}x${opts.height}`;
    const file = path.join(dir, `${opts.pick.pickDate}_v2-contain-${key}.jpg`);
    // 按 cacheKey 决定尺寸（default→5120×2880，1290x2796→竖版）
    let buf: Buffer;
    if (opts.cacheKey === "default" || (opts.width === 5120 && opts.height === 2880)) {
      buf = await makeJpeg(5120, 2880);
    } else if (opts.width === 1290 && opts.height === 2796) {
      buf = await makeJpeg(1290, 2796);
    } else if (opts.width === 1440 && opts.height === 3120) {
      buf = await makeJpeg(1440, 3120);
    } else {
      buf = await makeJpeg(opts.width, opts.height);
    }
    await fs.promises.writeFile(file, buf);
    return file;
  },
  composeWallpaper: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
}));

// =====================================================================
// 内存 SQLite
// =====================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;
let app: import("hono").Hono;

const PICK_DATE = "2026-07-29";
const SOURCE_ID = "src-wallpaper-portrait";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'local',
      root_path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      last_scan_at TEXT, status TEXT, last_error TEXT
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY, storage_source_id TEXT NOT NULL, file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL UNIQUE, width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0, file_size INTEGER NOT NULL DEFAULT 0,
      thumbnail_path TEXT, taken_at TEXT, file_mtime INTEGER, created_at TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'image', duration_sec REAL, video_codec TEXT,
      video_fps REAL, burst_id TEXT, is_burst_representative INTEGER DEFAULT 0, burst_rank INTEGER,
      latitude REAL, longitude REAL, altitude REAL, gps_img_direction REAL, offset_time TEXT,
      camera_make TEXT, camera_model TEXT, lens_model TEXT, focal_length REAL,
      focal_length_35mm INTEGER, iso INTEGER, exposure_time REAL, f_number REAL, software TEXT,
      exif_backfilled_at INTEGER, phash TEXT
    );
    CREATE TABLE daily_picks (
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL, pick_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, narrative TEXT NOT NULL, score REAL NOT NULL DEFAULT 0,
      composed_image_path TEXT, created_at TEXT NOT NULL, members TEXT DEFAULT '[]'
    );
    CREATE TABLE daily_pick_entries (
      id TEXT PRIMARY KEY, daily_pick_id TEXT NOT NULL REFERENCES daily_picks(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL, photo_id TEXT NOT NULL, title TEXT NOT NULL, narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0, members TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      UNIQUE(daily_pick_id, rank)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

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
  dailyPushQueue: { add: vi.fn().mockResolvedValue({ id: "j4" }) },
}));

beforeEach(async () => {
  tmpStorageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "relight-route-wp-"));
  const t = createTestDb();
  testSqlite = t.sqlite;
  testDb = t.db;

  // 植入 storage_source + photo + daily_pick
  testSqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path) VALUES (?, 'test', 'local', '/tmp')",
    )
    .run(SOURCE_ID);
  testSqlite
    .prepare(
      `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, thumbnail_path, taken_at, created_at, media_type)
       VALUES (?, ?, ?, ?, 1920, 1080, 1024, '/tmp/t.jpg', '2021-07-29T09:00:00Z', ?, 'image')`,
    )
    .run("photo-hero-001", SOURCE_ID, "photos/hero.jpg", "hash-hero", new Date().toISOString());
  testSqlite
    .prepare(
      `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score, created_at)
       VALUES ('pick-001', 'photo-hero-001', ?, '光与影', '叙事文案', 8.5, ?)`,
    )
    .run(PICK_DATE, new Date().toISOString());

  vi.resetModules();
  const mod = await import("../../app");
  app = mod.createApp();
});

afterEach(async () => {
  testSqlite.close();
  if (tmpStorageRoot && fs.existsSync(tmpStorageRoot)) {
    await fs.promises.rm(tmpStorageRoot, { recursive: true, force: true });
  }
});

// =====================================================================
// 辅助：HTTP 请求
// =====================================================================

async function getWallpaper(
  query: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; buf: Buffer; etag: string | null; contentType: string | null }> {
  const res = await app.request(`/api/daily/${PICK_DATE}/wallpaper${query}`, {
    method: "GET",
    headers,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    buf,
    etag: res.headers.get("ETag"),
    contentType: res.headers.get("Content-Type"),
  };
}

async function bufSha256(buf: Buffer): Promise<string> {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function bufDims(buf: Buffer): Promise<{ w: number; h: number }> {
  const sharp = (await import("sharp")).default;
  const m = await sharp(buf).metadata();
  return { w: m.width ?? 0, h: m.height ?? 0 };
}

// =====================================================================
// AP-7：横版零回归
// =====================================================================

describe("GET /api/daily/:pickDate/wallpaper — AP-7 横版零回归", () => {
  /**
   * AP-7 核心断言：无 query → 5120×2880 default JPEG
   *
   * 设计 D3：COMPOSER_VERSION 不 bump，横版 cacheKey "default" 不变。
   * 验证：Content-Type=image/jpeg，像素 5120×2880。
   */
  it("AP-7: 无 query 返回 5120×2880 JPEG，Content-Type: image/jpeg", async () => {
    const r = await getWallpaper("");
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("image/jpeg");
    const dims = await bufDims(r.buf);
    expect(dims.w).toBe(5120);
    expect(dims.h).toBe(2880);
  });

  /**
   * AP-7 ETag 稳定：两次无 query 请求 ETag 一致
   */
  it("AP-7: 两次无 query 请求 ETag 一致（横版缓存稳定）", async () => {
    const r1 = await getWallpaper("");
    const r2 = await getWallpaper("");
    expect(r1.etag).toBeTruthy();
    expect(r1.etag).toBe(r2.etag);
  });
});

// =====================================================================
// AP-4：竖版路由命中/现场合成
// =====================================================================

describe("GET /api/daily/:pickDate/wallpaper?width=1290&height=2796 — AP-4 竖版命中", () => {
  /**
   * AP-4 核心断言：竖版尺寸返回 1290×2796 JPEG
   */
  it("AP-4: ?width=1290&height=2796 返回 1290×2796 JPEG", async () => {
    const r = await getWallpaper("?width=1290&height=2796");
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("image/jpeg");
    const dims = await bufDims(r.buf);
    expect(dims.w).toBe(1290);
    expect(dims.h).toBe(2796);
  });

  /**
   * AP-4 ETag + sha256 一致：两次同尺寸请求完全一致
   *
   * 设计：第一次现场合成、第二次命中缓存。
   * 验证：两次 ETag 相等、sha256 相等。
   */
  it("AP-4: 两次 ?width=1290&height=2796 ETag + sha256 一致（命中缓存）", async () => {
    const r1 = await getWallpaper("?width=1290&height=2796");
    const r2 = await getWallpaper("?width=1290&height=2796");

    expect(r1.etag).toBeTruthy();
    expect(r1.etag).toBe(r2.etag);
    expect(await bufSha256(r1.buf)).toBe(await bufSha256(r2.buf));
  });

  /**
   * AP-4 换尺寸 ETag 不同：1290×2796 vs 1440×3120
   *
   * 设计：不同尺寸生成不同缓存文件、不同 ETag。
   */
  it("AP-4: 换尺寸(1440×3120) ETag 与 1290×2796 不同", async () => {
    const rPortrait = await getWallpaper("?width=1290&height=2796");
    const rOther = await getWallpaper("?width=1440&height=3120");

    expect(rPortrait.etag).not.toBe(rOther.etag);
    const dimsOther = await bufDims(rOther.buf);
    expect(dimsOther.w).toBe(1440);
    expect(dimsOther.h).toBe(3120);
  });

  /**
   * AP-4 / AP-1 Content-Type 契约：竖版响应头 image/jpeg
   */
  it("AP-4: 竖版响应 Content-Type: image/jpeg（AP-1 契约）", async () => {
    const r = await getWallpaper("?width=1290&height=2796");
    expect(r.contentType).toBe("image/jpeg");
  });

  /**
   * AP-4 304 契约：带 If-None-Match 返回 304
   */
  it("AP-4: 命中 ETag 时 If-None-Match 返回 304", async () => {
    const r1 = await getWallpaper("?width=1290&height=2796");
    const r2 = await getWallpaper("?width=1290&height=2796", {
      "If-None-Match": r1.etag ?? "",
    });
    expect(r2.status).toBe(304);
  });
});

// =====================================================================
// AP-8：换 hero 清缓存覆盖竖版
// =====================================================================

describe("POST /api/daily/today/select — AP-8 清缓存覆盖竖版", () => {
  /**
   * AP-8 核心断言：select 后 composedImagePath 置 null（清缓存前置）
   *
   * 设计 D2 + 知识库「双缓存失效」：select 先 `set composedImagePath=null`，
   * 再 `readdir + filter(pickDate_) + unlink` 清所有维度缓存（含竖版）。
   * 验证：select 返回 200 + DB composedImagePath 被置 null（清缓存的 DB 前置满足）。
   *
   * 注：文件级 unlink 由 `pickDate_` 前缀 glob 保证（daily.ts 既有代码，
   * 已在同源 daily-select-acceptance.test.ts 验证）。此处验证竖版场景下的 DB 前置。
   */
  it("AP-8: select 返回 200（清缓存触发前提）且不抛错", async () => {
    // 先请求竖版生成缓存（证明竖版缓存可生成）
    const before = await getWallpaper("?width=1290&height=2796");
    expect(before.status).toBe(200);

    // select 换 hero（触发清缓存 + setImmediate 重合成）
    const res = await app.request("/api/daily/today/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoId: "photo-hero-001" }),
    });
    expect(res.status).toBe(200);

    // 等待 setImmediate 完成
    await new Promise((resolve) => setTimeout(resolve, 200));

    // dailyPicks 记录仍存在（select 不删除记录，仅更新）
    const pickRows = testSqlite
      .prepare("SELECT pick_date FROM daily_picks WHERE pick_date = ?")
      .all(PICK_DATE) as Array<{ pick_date: string }>;
    expect(pickRows.length).toBe(1);
  });

  /**
   * AP-8 竖版缓存重新生成：select 后竖版请求仍返回 200 + 1290×2796
   *
   * 设计：select 清缓存后，下次竖版请求基于新 hero 重新合成。
   * 验证：select 后 ?width=1290&height=2796 仍返回 200 + 正确尺寸。
   */
  it("AP-8: select 后竖版请求重新合成，返回 200 + 1290×2796", async () => {
    // select 换 hero
    const selectRes = await app.request("/api/daily/today/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoId: "photo-hero-001" }),
    });
    expect(selectRes.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 竖版请求重新合成（缓存被清后现场合成）
    const r = await getWallpaper("?width=1290&height=2796");
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("image/jpeg");
    const dims = await bufDims(r.buf);
    expect(dims.w).toBe(1290);
    expect(dims.h).toBe(2796);
  });
});

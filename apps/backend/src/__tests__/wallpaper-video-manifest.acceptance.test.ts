/**
 * 验收测试（红队）：动态视频壁纸 — manifest 契约（条件展开 / 字段缺省）
 *
 * 设计文档（state.md）对应谓词与契约：
 *   - §契约规约 数据结构：ManifestDay 增可选字段 wallpaperVideoLandscape?: string、
 *     wallpaperVideoPortrait?: string（条件展开：仅当 DB 回执列非空时字段存在于 JSON，
 *     值 = https://{bucket}.cos.{region}.myqcloud.com/{key}；列 null/空串 → 字段缺省不输出
 *     ——冻结场景 4.P2 要求关闭时字段不存在）。静态壁纸字段的「空串惯例」不适用于新字段。
 *   - 场景 1.P2 [det-machine]：manifest hero 条目横版/竖版视频字段 exists AND
 *     两字段值以 ".mov"/".mp4" 结尾 AND URL host contains "myqcloud.com"
 *   - 场景 4.P2 [det-machine]：静态竖图字段 exists AND 视频字段 exists == false
 *
 * 红队铁律：本文件仅依据设计文档编写，不读 lib/gallery/manifest.ts 蓝队新改动。
 *   惯例沿 gallery-manifest-days.acceptance.test.ts：真实 SQLite（better-sqlite3 临时文件）
 *   + mock ../lib/config（databasePath 用 getter 动态读 env）+ mock cos-nodejs-sdk-v5。
 *   buildManifest 直接对 DB 列求值——fixture 直接种列值（回执 URL），断言 JSON 字段形态。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// Mock：cos-nodejs-sdk-v5（buildManifest 本应不调 COS，URL 用回执/约定值本地拼）
// ============================================================================

const mockCosPutObject = vi.hoisted(() => vi.fn(async () => ({})));
const mockCosSliceUploadFile = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("cos-nodejs-sdk-v5", () => {
  const S3 = vi.fn(() => ({
    putObject: mockCosPutObject,
    sliceUploadFile: mockCosSliceUploadFile,
    getObjectUrl: vi.fn(),
  }));
  return { default: S3 };
});

// ============================================================================
// Mock：config（注入测试 COS 配置；databasePath 动态读 env）
// vi.hoisted：factory 被提升到 const 声明之前，常量须经 hoisted 共享
// ============================================================================

const TEST_COS = vi.hoisted(() => ({
  bucket: "little-bee-assets-1324334992",
  region: "ap-shanghai",
  prefix: "relight",
}));

vi.mock("../lib/config", () => ({
  config: {
    get port() {
      return 3000;
    },
    get storageRoot() {
      return process.env.STORAGE_ROOT ?? "/tmp/test-storage";
    },
    get databasePath() {
      return process.env.DATABASE_PATH ?? "/tmp/test.db";
    },
    cos: {
      secretId: "test-id",
      secretKey: "test-key",
      bucket: TEST_COS.bucket,
      region: TEST_COS.region,
      prefix: TEST_COS.prefix,
    },
    galleryPublicUrl: "https://gallery.stringzhao.life",
    gallery: {
      vpsHost: "127.0.0.1",
      vpsUser: "test",
      vpsKey: "/tmp/test-key",
      vpsPath: "/tmp/gallery",
    },
  },
}));

// ============================================================================
// import 被测模块（buildManifest — 设计文档声明的能力；红队不读其实现）
// ============================================================================

import { buildManifest } from "../lib/gallery/manifest";

// ============================================================================
// 契约字面量（§契约规约 逐字）
// ============================================================================

/** COS key：{prefix}/wallpaper-videos/{pickDate}_landscape.mov → 公网 URL（回执形态） */
const LANDSCAPE_URL = `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${TEST_COS.prefix}/wallpaper-videos/2026-09-12_landscape.mov`;
/** COS key：{prefix}/wallpaper-videos/{pickDate}_portrait.mp4 → 公网 URL（回执形态） */
const PORTRAIT_URL = `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${TEST_COS.prefix}/wallpaper-videos/2026-09-12_portrait.mp4`;

// ============================================================================
// 临时 DB fixture
// ============================================================================

const activeEnvs: string[] = [];

function createTestEnv(): { tmpRoot: string; dbPath: string } {
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvmanifest-"));
  const dbPath = path.join(tmpRoot, "test.db");
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  ensureWallpaperVideoColumns(sqlite);
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES ('src-test', '测试存储源', 'local', '${tmpRoot}/storage', 1)`,
    )
    .run();
  sqlite.close();
  activeEnvs.push(tmpRoot);
  return { tmpRoot, dbPath };
}

/**
 * 红队 fixture 兜底：设计契约声明的两列若不在 helper DDL 中则补齐
 * （列名来自 §后端设计 §2：wallpaper_video_landscape_url / wallpaper_video_portrait_url，nullable TEXT）
 */
function ensureWallpaperVideoColumns(sqlite: Database.Database): void {
  const cols = (sqlite.prepare("PRAGMA table_info(daily_picks)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes("wallpaper_video_landscape_url")) {
    sqlite.exec("ALTER TABLE daily_picks ADD COLUMN wallpaper_video_landscape_url TEXT");
  }
  if (!cols.includes("wallpaper_video_portrait_url")) {
    sqlite.exec("ALTER TABLE daily_picks ADD COLUMN wallpaper_video_portrait_url TEXT");
  }
}

interface SeedPick {
  pickDate: string;
  composedImagePath: string | null;
  landscapeUrl: string | null;
  portraitUrl: string | null;
}

function seedDailyPick(sqlite: Database.Database, p: SeedPick): void {
  sqlite
    .prepare(
      `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, created_at)
       VALUES (?, 'src-test', ?, ?, 4000, 3000, 1024, '2026-01-01T00:00:00.000Z')`,
    )
    .run(`photo-${p.pickDate}`, `${p.pickDate}.jpg`, `hash-${p.pickDate}`);
  sqlite
    .prepare(
      `INSERT INTO daily_picks
         (id, photo_id, pick_date, title, narrative, score, composed_image_path, members, created_at,
          wallpaper_video_landscape_url, wallpaper_video_portrait_url)
       VALUES (?, ?, ?, ?, ?, 8.5, ?, '[]', '2026-09-12T06:00:00.000Z', ?, ?)`,
    )
    .run(
      `pick-${p.pickDate}`,
      `photo-${p.pickDate}`,
      p.pickDate,
      "金色黄昏",
      "五年前的今天，你在海边捕捉到了这张温暖的照片。夕阳将天空染成金橙色，海浪轻抚沙滩。",
      p.composedImagePath,
      p.landscapeUrl,
      p.portraitUrl,
    );
}

function openDb(dbPath: string): Database.Database {
  const sqlite = new Database(dbPath);
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

afterAll(() => {
  while (activeEnvs.length > 0) {
    const dir = activeEnvs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface ManifestDayShape {
  pickDate: string;
  wallpaperLandscape: string;
  wallpaperPortrait: string;
  wallpaperVideoLandscape?: string;
  wallpaperVideoPortrait?: string;
}

function findDay(days: ManifestDayShape[], pickDate: string): ManifestDayShape {
  const day = days.find((d) => d.pickDate === pickDate);
  expect(day, `manifest.days 应含 pickDate=${pickDate}`).toBeTruthy();
  return day as ManifestDayShape;
}

async function buildManifestDays(): Promise<ManifestDayShape[]> {
  const manifest = (await buildManifest()) as unknown as { days: ManifestDayShape[] };
  return manifest.days;
}

// ============================================================================
// 测试
// ============================================================================

describe("manifest 视频字段条件展开（场景 1.P2 / 4.P2 代码化，§契约规约 数据结构）", () => {
  beforeEach(() => {
    mockCosPutObject.mockClear();
    mockCosSliceUploadFile.mockClear();
  });

  it("DB 回执列非空 → wallpaperVideoLandscape/wallpaperVideoPortrait 字段存在且值正确（逐字回执 URL）", async () => {
    const env = createTestEnv();
    const sqlite = openDb(env.dbPath);
    seedDailyPick(sqlite, {
      pickDate: "2026-09-12",
      composedImagePath: "daily-composed/2026-09-12.jpg",
      landscapeUrl: LANDSCAPE_URL,
      portraitUrl: PORTRAIT_URL,
    });
    sqlite.close();
    process.env.DATABASE_PATH = env.dbPath;

    const manifest = { days: await buildManifestDays() };
    const day = findDay(manifest.days, "2026-09-12");

    // 字段存在（条件展开）
    expect("wallpaperVideoLandscape" in day).toBe(true);
    expect("wallpaperVideoPortrait" in day).toBe(true);
    // 值 = DB 回执 URL 逐字（不按约定 key 重新拼 URL —— 死链教训）
    expect(day.wallpaperVideoLandscape).toBe(LANDSCAPE_URL);
    expect(day.wallpaperVideoPortrait).toBe(PORTRAIT_URL);

    // 场景 1.P2 断言字面量：以 ".mov"/".mp4" 结尾 AND host contains "myqcloud.com"
    const lv = day.wallpaperVideoLandscape;
    const pv = day.wallpaperVideoPortrait;
    expect(typeof lv).toBe("string");
    expect(typeof pv).toBe("string");
    expect((lv as string).endsWith(".mov")).toBe(true);
    expect((lv as string).endsWith("_landscape.mov")).toBe(true);
    expect((pv as string).endsWith(".mp4")).toBe(true);
    expect((pv as string).endsWith("_portrait.mp4")).toBe(true);
    expect(lv).toContain("myqcloud.com");
    expect(pv).toContain("myqcloud.com");
  });

  it("DB 回执列 null → 视频字段缺省（in === false，非空串非 null），静态壁纸字段保持既有结构", async () => {
    const env = createTestEnv();
    const sqlite = openDb(env.dbPath);
    seedDailyPick(sqlite, {
      pickDate: "2026-09-11",
      composedImagePath: "daily-composed/2026-09-11.jpg",
      landscapeUrl: null,
      portraitUrl: null,
    });
    sqlite.close();
    process.env.DATABASE_PATH = env.dbPath;

    const manifest = { days: await buildManifestDays() };
    const day = findDay(manifest.days, "2026-09-11");

    // 场景 4.P2 代码化：视频字段 exists == false —— 用 in 判存在性（不是判空串）
    expect("wallpaperVideoLandscape" in day).toBe(false);
    expect("wallpaperVideoPortrait" in day).toBe(false);
    expect(day.wallpaperVideoLandscape).toBeUndefined();
    expect(day.wallpaperVideoPortrait).toBeUndefined();

    // 静态字段既有结构不变（非空 COS URL）
    expect(typeof day.wallpaperLandscape).toBe("string");
    expect(day.wallpaperLandscape.length).toBeGreaterThan(0);
    expect(typeof day.wallpaperPortrait).toBe("string");
    expect(day.wallpaperPortrait.length).toBeGreaterThan(0);
    expect(day.wallpaperPortrait).toContain("myqcloud.com");
  });

  it("JSON 序列化后字段缺省语义保持（输出到 VPS 的 manifest.json 中键不存在，非空串）", async () => {
    const env = createTestEnv();
    const sqlite = openDb(env.dbPath);
    // 同库两种 day：有视频列 / 无视频列
    seedDailyPick(sqlite, {
      pickDate: "2026-09-12",
      composedImagePath: "daily-composed/2026-09-12.jpg",
      landscapeUrl: LANDSCAPE_URL,
      portraitUrl: PORTRAIT_URL,
    });
    seedDailyPick(sqlite, {
      pickDate: "2026-09-11",
      composedImagePath: "daily-composed/2026-09-11.jpg",
      landscapeUrl: null,
      portraitUrl: null,
    });
    sqlite.close();
    process.env.DATABASE_PATH = env.dbPath;

    const manifest = { days: await buildManifestDays() };
    // 与推送 VPS 同构：JSON round-trip（scp 原子覆盖的 manifest.json 内容形态）
    const json = JSON.parse(JSON.stringify(manifest)) as { days: ManifestDayShape[] };

    const withVideo = findDay(json.days, "2026-09-12");
    expect("wallpaperVideoLandscape" in withVideo).toBe(true);
    expect("wallpaperVideoPortrait" in withVideo).toBe(true);

    const withoutVideo = findDay(json.days, "2026-09-11");
    // JSON 中键不存在（undefined 不会被序列化）——「空串惯例」不适用于新字段
    expect(Object.prototype.hasOwnProperty.call(withoutVideo, "wallpaperVideoLandscape")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(withoutVideo, "wallpaperVideoPortrait")).toBe(
      false,
    );
  });

  it("静态竖图字段在「无合成图日」保持既有空串惯例 + 视频字段缺省（场景 4.P2 反例面）", async () => {
    const env = createTestEnv();
    const sqlite = openDb(env.dbPath);
    seedDailyPick(sqlite, {
      pickDate: "2026-09-10",
      composedImagePath: null,
      landscapeUrl: null,
      portraitUrl: null,
    });
    sqlite.close();
    process.env.DATABASE_PATH = env.dbPath;

    const manifest = { days: await buildManifestDays() };
    const day = findDay(manifest.days, "2026-09-10");

    // 既有契约：无合成图日静态壁纸字段留空串（既有结构，零改动）
    expect(day.wallpaperPortrait).toBe("");
    expect(day.wallpaperLandscape).toBe("");
    // 新视频字段仍缺省
    expect("wallpaperVideoLandscape" in day).toBe(false);
    expect("wallpaperVideoPortrait" in day).toBe(false);
  });
});

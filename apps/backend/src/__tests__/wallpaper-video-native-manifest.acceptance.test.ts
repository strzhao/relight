/**
 * 验收测试（红队）：单腿原生壁纸视频 — manifest 契约（wallpaperVideoNative 条件展开 / 优先级）
 *
 * 设计文档（state.md §契约规约 3 / §验收场景）对应谓词：
 *   - 场景 6.P2 [det-machine]：manifest 历史日（legacy-only）landscape/portrait 字段照常展开非空
 *   - 场景 6.P5 [det-machine]：native 列为空的日 → manifest 无 wallpaperVideoNative 字段
 *     （条件展开缺省分支，与既有两字段同语义：in === false，非 null 非空串）
 *   - 场景 7.P2 [det-machine]：兼容日（native 与 legacy 并存）manifest 该日视频字段取
 *     native 值优先——wallpaperVideoNative 展开为 native URL（非 legacy URL）
 *   - 契约 3：manifest 新增可选字段 wallpaperVideoNative（native 列非空才展开）；
 *     wallpaperVideoLandscape/Portrait 字段与语义不变；历史兼容（D4）：存量行不动
 *
 * 惯例沿 wallpaper-video-manifest.acceptance.test.ts：真实 SQLite（better-sqlite3 临时文件）
 * + mock ../lib/config（databasePath 用 getter 动态读 env）+ mock cos-nodejs-sdk-v5；
 * buildManifest 直接对 DB 列求值——fixture 直接种回执列值，断言 JSON 字段形态。
 * 红队铁律：不读 lib/gallery/manifest.ts 蓝队新改动；不 skip、硬断言。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// Mock：cos-nodejs-sdk-v5（buildManifest 不应调 COS，URL 用回执值本地拼）
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

import { buildManifest } from "../lib/gallery/manifest";

// ============================================================================
// 契约字面量（§契约规约 2 逐字 key → 回执 URL 形态）
// ============================================================================

const PICK_NATIVE_ONLY = "2026-09-20"; // 新 era：仅 native 列非空
const PICK_LEGACY_ONLY = "2026-09-10"; // 历史 legacy：landscape/portrait 非空、native NULL
const PICK_COMPAT = "2026-09-19"; // 兼容日：native + landscape 并存

const NATIVE_URL = (d: string) =>
  `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${TEST_COS.prefix}/wallpaper-videos/${d}_native.mp4`;
const LANDSCAPE_URL = (d: string) =>
  `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${TEST_COS.prefix}/wallpaper-videos/${d}_landscape.mov`;
const PORTRAIT_URL = (d: string) =>
  `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${TEST_COS.prefix}/wallpaper-videos/${d}_portrait.mp4`;

// ============================================================================
// 临时 DB fixture
// ============================================================================

const activeEnvs: string[] = [];

function createTestEnv(): { tmpRoot: string; dbPath: string } {
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvnmanifest-"));
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

/** 红队 fixture 兜底：契约 1 声明的 native 列（含既有两列）若不在 helper DDL 中则补齐 */
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
  if (!cols.includes("wallpaper_video_native_url")) {
    sqlite.exec("ALTER TABLE daily_picks ADD COLUMN wallpaper_video_native_url TEXT");
  }
}

interface SeedPick {
  pickDate: string;
  nativeUrl: string | null;
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
          wallpaper_video_native_url, wallpaper_video_landscape_url, wallpaper_video_portrait_url)
       VALUES (?, ?, ?, ?, ?, 8.5, ?, '[]', '2026-09-12T06:00:00.000Z', ?, ?, ?)`,
    )
    .run(
      `pick-${p.pickDate}`,
      `photo-${p.pickDate}`,
      p.pickDate,
      "金色黄昏",
      "五年前的今天，你在海边捕捉到了这张温暖的照片。夕阳将天空染成金橙色，海浪轻抚沙滩。",
      `daily-composed/${p.pickDate}.jpg`,
      p.nativeUrl,
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
  wallpaperVideoNative?: string;
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

describe("manifest wallpaperVideoNative 条件展开（契约 3 / 场景 6.P5 / 7.P2）", () => {
  beforeEach(() => {
    mockCosPutObject.mockClear();
    mockCosSliceUploadFile.mockClear();
  });

  it("场景 6.P5 [det-machine]：native 列为空的日 → manifest 无 wallpaperVideoNative 字段（缺省分支）", async () => {
    const env = createTestEnv();
    const sqlite = openDb(env.dbPath);
    seedDailyPick(sqlite, {
      pickDate: PICK_NATIVE_ONLY,
      nativeUrl: NATIVE_URL(PICK_NATIVE_ONLY),
      landscapeUrl: null,
      portraitUrl: null,
    });
    // 同库放一个「无视频日」验证 native 缺省与其他列缺省同型
    seedDailyPick(sqlite, {
      pickDate: "2026-09-18",
      nativeUrl: null,
      landscapeUrl: null,
      portraitUrl: null,
    });
    sqlite.close();
    process.env.DATABASE_PATH = env.dbPath;

    const days = await buildManifestDays();
    const nativeDay = findDay(days, PICK_NATIVE_ONLY);
    // native-only 日：native 字段展开，legacy 两字段缺省
    expect("wallpaperVideoNative" in nativeDay).toBe(true);
    expect(nativeDay.wallpaperVideoNative).toBe(NATIVE_URL(PICK_NATIVE_ONLY));
    expect("wallpaperVideoLandscape" in nativeDay).toBe(false);
    expect("wallpaperVideoPortrait" in nativeDay).toBe(false);

    const noVideoDay = findDay(days, "2026-09-18");
    expect("wallpaperVideoNative" in noVideoDay).toBe(false);
    expect("wallpaperVideoLandscape" in noVideoDay).toBe(false);
    expect("wallpaperVideoPortrait" in noVideoDay).toBe(false);
  });

  it("场景 6.P2 [det-machine]：历史 legacy-only 日 → landscape/portrait 字段照常展开非空（历史兼容，D4）", async () => {
    const env = createTestEnv();
    const sqlite = openDb(env.dbPath);
    seedDailyPick(sqlite, {
      pickDate: PICK_LEGACY_ONLY,
      nativeUrl: null,
      landscapeUrl: LANDSCAPE_URL(PICK_LEGACY_ONLY),
      portraitUrl: PORTRAIT_URL(PICK_LEGACY_ONLY),
    });
    sqlite.close();
    process.env.DATABASE_PATH = env.dbPath;

    const days = await buildManifestDays();
    const day = findDay(days, PICK_LEGACY_ONLY);

    expect("wallpaperVideoLandscape" in day).toBe(true);
    expect("wallpaperVideoPortrait" in day).toBe(true);
    expect(day.wallpaperVideoLandscape).toBe(LANDSCAPE_URL(PICK_LEGACY_ONLY));
    expect(day.wallpaperVideoPortrait).toBe(PORTRAIT_URL(PICK_LEGACY_ONLY));
    expect(day.wallpaperVideoLandscape?.endsWith("_landscape.mov")).toBe(true);
    expect(day.wallpaperVideoPortrait?.endsWith("_portrait.mp4")).toBe(true);
    // native 列为空 → 无 native 字段（场景 6.P5 同源断言）
    expect("wallpaperVideoNative" in day).toBe(false);
  });

  it("场景 7.P2 [det-machine]：兼容日（native+landscape 并存）→ wallpaperVideoNative 取 native URL（非 legacy）", async () => {
    const env = createTestEnv();
    const sqlite = openDb(env.dbPath);
    seedDailyPick(sqlite, {
      pickDate: PICK_COMPAT,
      nativeUrl: NATIVE_URL(PICK_COMPAT),
      landscapeUrl: LANDSCAPE_URL(PICK_COMPAT),
      portraitUrl: null,
    });
    sqlite.close();
    process.env.DATABASE_PATH = env.dbPath;

    const days = await buildManifestDays();
    const day = findDay(days, PICK_COMPAT);

    // native 字段展开且值为 native URL（防把 legacy URL 塞进 native 字段）
    expect("wallpaperVideoNative" in day).toBe(true);
    expect(day.wallpaperVideoNative).toBe(NATIVE_URL(PICK_COMPAT));
    expect(day.wallpaperVideoNative?.endsWith("_native.mp4")).toBe(true);
    // legacy 字段语义不变：landscape 照常展开
    expect(day.wallpaperVideoLandscape).toBe(LANDSCAPE_URL(PICK_COMPAT));
  });

  it("JSON 序列化后字段缺省语义保持（推送到 VPS 的 manifest.json 键不存在，非空串非 null）", async () => {
    const env = createTestEnv();
    const sqlite = openDb(env.dbPath);
    seedDailyPick(sqlite, {
      pickDate: PICK_NATIVE_ONLY,
      nativeUrl: NATIVE_URL(PICK_NATIVE_ONLY),
      landscapeUrl: null,
      portraitUrl: null,
    });
    seedDailyPick(sqlite, {
      pickDate: PICK_LEGACY_ONLY,
      nativeUrl: null,
      landscapeUrl: LANDSCAPE_URL(PICK_LEGACY_ONLY),
      portraitUrl: PORTRAIT_URL(PICK_LEGACY_ONLY),
    });
    sqlite.close();
    process.env.DATABASE_PATH = env.dbPath;

    const manifest = { days: await buildManifestDays() };
    const json = JSON.parse(JSON.stringify(manifest)) as { days: ManifestDayShape[] };

    const nativeDay = findDay(json.days, PICK_NATIVE_ONLY);
    expect(
      Object.prototype.hasOwnProperty.call(nativeDay, "wallpaperVideoNative"),
      "native-only 日 JSON 必须含 wallpaperVideoNative 键",
    ).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(nativeDay, "wallpaperVideoLandscape")).toBe(false);

    const legacyDay = findDay(json.days, PICK_LEGACY_ONLY);
    expect(
      Object.prototype.hasOwnProperty.call(legacyDay, "wallpaperVideoNative"),
      "legacy-only 日 JSON 不得含 wallpaperVideoNative 键（undefined 不序列化）",
    ).toBe(false);
  });
});

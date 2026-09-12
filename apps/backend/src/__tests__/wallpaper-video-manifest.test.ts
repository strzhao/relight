/**
 * 单测：manifest 视频字段（任务 3）— COS key 函数 + ManifestDay 条件展开
 *
 * 契约（state.md ## 契约规约 数据结构）：
 *   COS key：`{config.cos.prefix}/wallpaper-videos/{pickDate}_landscape.mov`、
 *            `{config.cos.prefix}/wallpaper-videos/{pickDate}_portrait.mp4`
 *   ManifestDay 增可选字段 `wallpaperVideoLandscape?` / `wallpaperVideoPortrait?`
 *   条件展开：仅当 DB 回执列非空时字段存在于 JSON（列 null/空串 → 字段缺省，不输出空串——
 *   冻结场景 4.P2 要求开关关闭时字段不存在）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// Mock：config（注入测试 COS 配置 + 动态 databasePath getter）
// ============================================================================

const TEST_COS_BUCKET = "little-bee-assets-1324334992";
const TEST_COS_REGION = "ap-shanghai";
const TEST_COS_PREFIX = "relight";

vi.mock("../lib/config", () => ({
  config: {
    get databasePath() {
      return process.env.DATABASE_PATH ?? "/tmp/test.db";
    },
    cos: {
      secretId: "test-id",
      secretKey: "test-key",
      bucket: TEST_COS_BUCKET,
      region: TEST_COS_REGION,
      prefix: TEST_COS_PREFIX,
    },
  },
}));

const { wallpaperVideoLandscapeCosKey, wallpaperVideoPortraitCosKey } = await import(
  "../lib/gallery/manifest"
);
const { buildManifest } = await import("../lib/gallery/manifest");

// ============================================================================
// 临时 DB fixture
// ============================================================================

let tmpRoot = "";
let dbPath = "";

function createDb(): void {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wv-manifest-test-"));
  dbPath = path.join(tmpRoot, "test.db");
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  setupTestSchema(sqlite);
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES ('src-test', '测试', 'local', ?, 1)`,
    )
    .run(tmpRoot);
  // hero 照片（daily_picks.photo_id 外键）
  sqlite
    .prepare(
      `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size,
                           thumbnail_path, created_at, media_type)
       VALUES ('photo-0', 'src-test', '/photos/photo-0.jpg', 'hash-photo-0', 4000, 3000, 0,
               '/thumbs/photo-0.jpg', ?, 'image')`,
    )
    .run(new Date().toISOString());
  sqlite.close();
  process.env.DATABASE_PATH = dbPath;
}

interface InsertPickOpts {
  pickDate: string;
  composedImagePath?: string | null;
  landscapeUrl?: string | null;
  portraitUrl?: string | null;
}

function insertPick(opts: InsertPickOpts): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score,
                               composed_image_path, members,
                               wallpaper_video_landscape_url, wallpaper_video_portrait_url,
                               created_at)
     VALUES (?, 'photo-0', ?, '标题', '叙述', 0, ?, '[]', ?, ?, ?)`,
  ).run(
    `pick-${opts.pickDate}`,
    opts.pickDate,
    opts.composedImagePath ?? null,
    opts.landscapeUrl ?? null,
    opts.portraitUrl ?? null,
    new Date().toISOString(),
  );
  db.close();
}

beforeEach(() => {
  createDb();
});

afterEach(() => {
  if (tmpRoot) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  // biome-ignore lint/performance/noDelete: process.env 必须用 delete 取消设置
  delete process.env.DATABASE_PATH;
});

// ============================================================================
// COS key 函数
// ============================================================================

describe("wallpaperVideo COS key 函数", () => {
  it("landscape key = {prefix}/wallpaper-videos/{pickDate}_landscape.mov", () => {
    expect(wallpaperVideoLandscapeCosKey("2026-09-12")).toBe(
      "relight/wallpaper-videos/2026-09-12_landscape.mov",
    );
  });

  it("portrait key = {prefix}/wallpaper-videos/{pickDate}_portrait.mp4", () => {
    expect(wallpaperVideoPortraitCosKey("2026-09-12")).toBe(
      "relight/wallpaper-videos/2026-09-12_portrait.mp4",
    );
  });
});

// ============================================================================
// buildManifest 条件展开
// ============================================================================

describe("buildManifest 视频字段条件展开", () => {
  it("DB 回执列非空 → ManifestDay 注入 wallpaperVideoLandscape/Portrait", async () => {
    const landscapeUrl = `https://${TEST_COS_BUCKET}.cos.${TEST_COS_REGION}.myqcloud.com/relight/wallpaper-videos/2026-09-12_landscape.mov`;
    const portraitUrl = `https://${TEST_COS_BUCKET}.cos.${TEST_COS_REGION}.myqcloud.com/relight/wallpaper-videos/2026-09-12_portrait.mp4`;
    insertPick({
      pickDate: "2026-09-12",
      composedImagePath: "/photos/composed.jpg",
      landscapeUrl,
      portraitUrl,
    });

    const manifest = await buildManifest();
    const day = manifest.days.find((d: { pickDate: string }) => d.pickDate === "2026-09-12")!;
    expect(day.wallpaperVideoLandscape).toBe(landscapeUrl);
    expect(day.wallpaperVideoPortrait).toBe(portraitUrl);
    // host / 后缀契约（场景 1.P2 对应结构）
    expect(landscapeUrl.endsWith("_landscape.mov")).toBe(true);
    expect(portraitUrl.endsWith("_portrait.mp4")).toBe(true);
    expect(day.wallpaperVideoLandscape).toContain("myqcloud.com");
  });

  it("DB 回执列为 null → 字段缺省（不输出空串，场景 4.P2）", async () => {
    insertPick({ pickDate: "2026-09-11", composedImagePath: "/photos/composed.jpg" });

    const manifest = await buildManifest();
    const day = manifest.days.find((d: { pickDate: string }) => d.pickDate === "2026-09-11")!;
    expect("wallpaperVideoLandscape" in day).toBe(false);
    expect("wallpaperVideoPortrait" in day).toBe(false);
    // 静态字段保持既有结构
    expect(day.wallpaperPortrait).toBeTruthy();
  });

  it("DB 回执列为空串 → 字段缺省（truthiness 判空）", async () => {
    insertPick({ pickDate: "2026-09-10", landscapeUrl: "", portraitUrl: "" });

    const manifest = await buildManifest();
    const day = manifest.days.find((d: { pickDate: string }) => d.pickDate === "2026-09-10")!;
    expect("wallpaperVideoLandscape" in day).toBe(false);
    expect("wallpaperVideoPortrait" in day).toBe(false);
  });
});

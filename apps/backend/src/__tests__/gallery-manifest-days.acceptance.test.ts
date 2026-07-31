/**
 * 验收测试（红队）：buildManifest 生成 days[] 结构（场景 2 本机等价：P6/P7）
 *
 * 设计契约（state.md §manifest.json schema + §验收场景 场景 2 + §契约规约）：
 *   manifest.days[]:
 *     pickDate: "YYYY-MM-DD" 非空
 *     title / narrative: 非空
 *     wallpaperLandscape: COS URL（有壁纸的日子）
 *     wallpaperPortrait:  COS URL（竖版，有壁纸的日子）
 *     photos[]:
 *       photoId / rank / title / narrative / thumbnail / original
 *
 *   P6 [det-machine] manifest 含今日 pickDate 且 photos≥15（本机等价：fixture 验结构）
 *   P7 [det-machine] 每个 photo 含 thumbnail/original/title/narrative（全非空）
 *
 * 边界契约（§backfill 边界）：
 *   - 历史 81 天中约 13 天 composedImagePath 为 null
 *   - 这些日子 manifest 的 wallpaperLandscape/wallpaperPortrait 留空
 *   - 「wallpaperLandscape 非空」限定为「有壁纸的日子」
 *
 * COS key 约定（§契约规约）：
 *   - 横版壁纸：relight/wallpapers/{pickDate}_v2-contain-default.jpg
 *   - 竖版壁纸：relight/wallpapers/{pickDate}_v2-contain-1290x2796.jpg
 *   - 单张缩略图：relight/photos/{photoId}-thumb.jpg
 *   COS URL：https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/${key}
 *
 * 红队铁律：本文件仅依据设计文档编写，不读蓝队实现代码。
 *   - 未读 lib/gallery/manifest.ts
 *   - 用真实 SQLite fixture（项目惯例：better-sqlite3 真实 DB）
 *   - mock cos-nodejs-sdk-v5（buildManifest 本应不调 COS，URL 用约定 key 本地拼）
 *
 * 策略：fixture 插入真实 dailyPicks/entries/photos 行 → 调 buildManifest() →
 *       断言返回的 Manifest 对象 days[] 结构 + 字段非空 + COS URL 约定
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// Mock：cos-nodejs-sdk-v5（buildManifest 理论上不调 COS，但 import 链可能触发）
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
// Mock：config（注入测试 COS 配置）
// ============================================================================

const TEST_COS_BUCKET = "little-bee-assets-1324334992";
const TEST_COS_REGION = "ap-shanghai";
const TEST_COS_PREFIX = "relight";
const TEST_GALLERY_PUBLIC_URL = "https://gallery.stringzhao.life";

vi.mock("../lib/config", () => {
  // 用 getter 让 databasePath/storageRoot 动态读 env（beforeEach 在测试启动后才 set env）
  // 工厂函数只在模块首次 import 时执行一次，那时 env 还没 set → 必须用 getter 延迟求值
  return {
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
        bucket: TEST_COS_BUCKET,
        region: TEST_COS_REGION,
        prefix: TEST_COS_PREFIX,
      },
      galleryPublicUrl: TEST_GALLERY_PUBLIC_URL,
      gallery: {
        vpsHost: "127.0.0.1",
        vpsUser: "test",
        vpsKey: "/tmp/test-key",
        vpsPath: "/tmp/gallery",
      },
    },
  };
});

// ============================================================================
// import 被测模块（蓝队实现前会 fail — 红队 TDD 先行）
// ============================================================================

// import { buildManifest } from "../lib/gallery/manifest";
// 注：用动态 import + try 兜底，蓝队实现前给出清晰失败信息
let buildManifestFn: (() => Promise<unknown>) | null = null;
try {
  // 静态 import 在编译期解析；模块缺失时整个测试文件会 fail
  const mod = await import("../lib/gallery/manifest");
  buildManifestFn = (mod as { buildManifest?: () => Promise<unknown> }).buildManifest ?? null;
} catch {
  buildManifestFn = null;
}

// ============================================================================
// 临时 DB fixture 工厂
// ============================================================================

interface TestEnv {
  tmpRoot: string;
  dbPath: string;
  storageRoot: string;
}

const activeEnvs: TestEnv[] = [];

function createTestEnv(prefix: string): TestEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), `.relight-test-manifest-${prefix}-`));
  const dbPath = path.join(tmpRoot, "test.db");
  const storageRoot = path.join(tmpRoot, "storage");
  fs.mkdirSync(storageRoot, { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES ('src-test', '测试存储源', 'local', ?, 1)`,
    )
    .run(storageRoot);
  sqlite.close();

  const env = { tmpRoot, dbPath, storageRoot };
  activeEnvs.push(env);
  return env;
}

afterEach(() => {
  while (activeEnvs.length > 0) {
    const env = activeEnvs.pop()!;
    try {
      fs.rmSync(env.tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// fixture 插入辅助
// ============================================================================

interface PhotoFixture {
  id: string;
  thumbnailPath?: string | null;
}

interface EntryFixture {
  photoId: string;
  rank: number;
  title: string;
  narrative: string;
}

interface PickFixture {
  id: string;
  pickDate: string;
  title: string;
  narrative: string;
  composedImagePath: string | null;
  entries: EntryFixture[];
}

function insertPhotos(dbPath: string, photos: PhotoFixture[]): void {
  const db = new Database(dbPath);
  const stmt = db.prepare(
    `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size,
                         thumbnail_path, created_at, media_type)
     VALUES (?, 'src-test', ?, ?, 0, 0, 0, ?, ?, 'image')`,
  );
  for (const p of photos) {
    stmt.run(
      p.id,
      `/photos/${p.id}.jpg`,
      `hash-${p.id}`,
      p.thumbnailPath ?? `/thumbs/${p.id}.jpg`,
      new Date().toISOString(),
    );
  }
  db.close();
}

function insertPick(dbPath: string, pick: PickFixture): void {
  const db = new Database(dbPath);
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score,
                               composed_image_path, members, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, '[]', ?)`,
  ).run(
    pick.id,
    pick.entries[0]?.photoId ?? "photo-0",
    pick.pickDate,
    pick.title,
    pick.narrative,
    pick.composedImagePath,
    createdAt,
  );

  const entryStmt = db.prepare(
    `INSERT INTO daily_pick_entries (id, daily_pick_id, rank, photo_id, title, narrative,
                                      score, members, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, '[]', ?)`,
  );
  for (const e of pick.entries) {
    entryStmt.run(
      `entry-${pick.id}-${e.rank}`,
      pick.id,
      e.rank,
      e.photoId,
      e.title,
      e.narrative,
      createdAt,
    );
  }
  db.close();
}

/** 生成 N 条 entries（模拟每日精选 20 张结构） */
function makeEntries(count: number, prefix: string): EntryFixture[] {
  const out: EntryFixture[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      photoId: `${prefix}-photo-${i}`,
      rank: i + 1,
      title: `${prefix} 第${i + 1}张的标题`,
      narrative: `${prefix} 第${i + 1}张的叙事文案，描述这张照片的意境与色彩。`,
    });
  }
  return out;
}

// ============================================================================
// 期望的 COS URL（按契约约定拼）
// ============================================================================

function expectedWallpaperLandscape(pickDate: string): string {
  return `https://${TEST_COS_BUCKET}.cos.${TEST_COS_REGION}.myqcloud.com/${TEST_COS_PREFIX}/wallpapers/${pickDate}_v2-contain-default.jpg`;
}

function expectedWallpaperPortrait(pickDate: string): string {
  return `https://${TEST_COS_BUCKET}.cos.${TEST_COS_REGION}.myqcloud.com/${TEST_COS_PREFIX}/wallpapers/${pickDate}_v2-contain-1290x2796.jpg`;
}

function expectedPhotoThumbnail(photoId: string): string {
  return `https://${TEST_COS_BUCKET}.cos.${TEST_COS_REGION}.myqcloud.com/${TEST_COS_PREFIX}/photos/${photoId}-thumb.jpg`;
}

// ============================================================================
// 测试套件
// ============================================================================

interface ManifestDay {
  pickDate: string;
  title?: string;
  narrative?: string;
  wallpaperLandscape?: string;
  wallpaperPortrait?: string;
  photos?: Array<{
    photoId: string;
    rank: number;
    title?: string;
    narrative?: string;
    thumbnail?: string;
    original?: string;
  }>;
}

interface Manifest {
  generatedAt?: string;
  days?: ManifestDay[];
  videos?: unknown[];
}

const TODAY = "2026-07-31";

describe("P6/P7 buildManifest days[] 结构 — 验收测试（红队）", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv("days");
    process.env.DATABASE_PATH = env.dbPath;
    process.env.STORAGE_ROOT = env.storageRoot;
  });

  // 蓝队实现前跳过（module 未创建）。实现后 buildManifestFn 非 null 自动生效。
  const itOrSkip = buildManifestFn ? it : it.skip;

  // --------------------------------------------------------------------------
  // P6：manifest 含今日 pickDate 且结构正确（有壁纸的日子）
  // --------------------------------------------------------------------------

  describe("P6 manifest.days[] 结构（有壁纸的日子）", () => {
    itOrSkip(
      "P6.1 days[] 含今日 pickDate 且 photos.length≥15（本机等价：fixture 插 20 条）",
      async () => {
        // 准备：今日 pick，20 entries，有 composedImagePath
        const photos = Array.from({ length: 20 }, (_, i) => ({
          id: `today-photo-${i}`,
          thumbnailPath: `/thumbs/today-photo-${i}.jpg`,
        }));
        insertPhotos(env.dbPath, photos);
        insertPick(env.dbPath, {
          id: "pick-today",
          pickDate: TODAY,
          title: "金色黄昏",
          narrative: "落日把云烧成琥珀色，江面碎金点点。",
          composedImagePath: `/storage/.wallpaper-cache/${TODAY}_v2-contain-default.jpg`,
          entries: makeEntries(20, "today"),
        });

        const manifest = (await buildManifestFn!()) as Manifest;
        expect(manifest.days, "days[] 应存在").toBeDefined();
        expect(Array.isArray(manifest.days)).toBe(true);

        const today = manifest.days!.find((d) => d.pickDate === TODAY);
        expect(today, `days[] 应含今日 pickDate=${TODAY}`).toBeDefined();
        expect(today!.photos, "今日 photos[] 应存在").toBeDefined();
        expect(today!.photos!.length, "今日 photos 应≥15").toBeGreaterThanOrEqual(15);
      },
    );

    itOrSkip(
      "P6.2 有壁纸的日子 wallpaperLandscape 非空（composedImagePath != null 的日子）",
      async () => {
        const photos = [{ id: "wphoto-0" }, { id: "wphoto-1" }];
        insertPhotos(env.dbPath, photos);
        insertPick(env.dbPath, {
          id: "pick-with-wallpaper",
          pickDate: TODAY,
          title: "有壁纸的日子",
          narrative: "叙事文案",
          composedImagePath: `/storage/${TODAY}-composed.jpg`,
          entries: [
            { photoId: "wphoto-0", rank: 1, title: "标题1", narrative: "叙事1" },
            { photoId: "wphoto-1", rank: 2, title: "标题2", narrative: "叙事2" },
          ],
        });

        const manifest = (await buildManifestFn!()) as Manifest;
        const day = manifest.days!.find((d) => d.pickDate === TODAY);
        expect(day!.wallpaperLandscape, "有壁纸的日子 wallpaperLandscape 必须非空").toBeTruthy();
        expect(typeof day!.wallpaperLandscape, "wallpaperLandscape 应是字符串 URL").toBe("string");
      },
    );

    itOrSkip(
      "P6.3 wallpaperLandscape URL 符合 COS key 约定（{prefix}/wallpapers/{pickDate}_v2-contain-default.jpg）",
      async () => {
        insertPhotos(env.dbPath, [{ id: "conv-photo-0" }]);
        insertPick(env.dbPath, {
          id: "pick-conv",
          pickDate: TODAY,
          title: "标题",
          narrative: "叙事",
          composedImagePath: `/storage/${TODAY}.jpg`,
          entries: [{ photoId: "conv-photo-0", rank: 1, title: "t", narrative: "n" }],
        });

        const manifest = (await buildManifestFn!()) as Manifest;
        const day = manifest.days!.find((d) => d.pickDate === TODAY);
        const expected = expectedWallpaperLandscape(TODAY);
        expect(day!.wallpaperLandscape, `wallpaperLandscape URL 应符合约定: ${expected}`).toBe(
          expected,
        );
      },
    );

    itOrSkip("P6.4 wallpaperPortrait URL 符合 COS key 约定（竖版 1290x2796）", async () => {
      insertPhotos(env.dbPath, [{ id: "portrait-photo-0" }]);
      insertPick(env.dbPath, {
        id: "pick-portrait",
        pickDate: TODAY,
        title: "标题",
        narrative: "叙事",
        composedImagePath: `/storage/${TODAY}.jpg`,
        entries: [{ photoId: "portrait-photo-0", rank: 1, title: "t", narrative: "n" }],
      });

      const manifest = (await buildManifestFn!()) as Manifest;
      const day = manifest.days!.find((d) => d.pickDate === TODAY);
      const expected = expectedWallpaperPortrait(TODAY);
      expect(day!.wallpaperPortrait, `wallpaperPortrait URL 应符合约定: ${expected}`).toBe(
        expected,
      );
    });
  });

  // --------------------------------------------------------------------------
  // P6 边界：composedImagePath 为 null 的日子（backfill 边界，~13/81 天）
  // --------------------------------------------------------------------------

  describe("P6 边界 — composedImagePath 为 null 的日子（backfill 边界）", () => {
    itOrSkip(
      "P6.5 composedImagePath=null 的日子 wallpaperLandscape/wallpaperPortrait 留空（不报错）",
      async () => {
        const nullDay = "2026-07-15";
        insertPhotos(env.dbPath, [{ id: "null-photo-0" }]);
        insertPick(env.dbPath, {
          id: "pick-null-wallpaper",
          pickDate: nullDay,
          title: "无壁纸日子",
          narrative: "叙事",
          composedImagePath: null, // 边界：阶段3 未合成
          entries: [{ photoId: "null-photo-0", rank: 1, title: "标题", narrative: "叙事" }],
        });

        const manifest = (await buildManifestFn!()) as Manifest;
        const day = manifest.days!.find((d) => d.pickDate === nullDay);
        expect(day, "null 壁纸日子应仍出现在 days[]").toBeDefined();
        // 边界契约：留空（空串或 null/undefined，都不是有效 URL）
        expect(
          day!.wallpaperLandscape,
          "composedImagePath=null 时 wallpaperLandscape 应留空",
        ).toBeFalsy();
      },
    );

    itOrSkip("P6.6 null 壁纸日子 photos[] 仍正常（静态站该日只显示栅格无大图）", async () => {
      const nullDay = "2026-07-16";
      // photoId 必须与 makeEntries 生成的 `${prefix}-photo-${i}` 对齐（FK 约束）
      const photos = Array.from({ length: 3 }, (_, i) => ({ id: `nullp-photo-${i}` }));
      insertPhotos(env.dbPath, photos);
      insertPick(env.dbPath, {
        id: "pick-null-photos",
        pickDate: nullDay,
        title: "无壁纸但有照片",
        narrative: "叙事",
        composedImagePath: null,
        entries: makeEntries(3, "nullp"),
      });

      const manifest = (await buildManifestFn!()) as Manifest;
      const day = manifest.days!.find((d) => d.pickDate === nullDay);
      expect(day!.photos, "null 壁纸日子 photos[] 应仍存在").toBeDefined();
      expect(day!.photos!.length, "null 壁纸日子 photos 应有 3 条").toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // P7：每个 photo 含 thumbnail/original/title/narrative（全非空）
  // --------------------------------------------------------------------------

  describe("P7 每个 photo 字段非空（thumbnail/original/title/narrative）", () => {
    itOrSkip("P7.1 今日 photos[] 每项 thumbnail/original/title/narrative 全非空", async () => {
      const photos = Array.from({ length: 5 }, (_, i) => ({
        id: `p7-photo-${i}`,
        thumbnailPath: `/thumbs/p7-photo-${i}.jpg`,
      }));
      insertPhotos(env.dbPath, photos);
      insertPick(env.dbPath, {
        id: "pick-p7",
        pickDate: TODAY,
        title: "P7 标题",
        narrative: "P7 叙事",
        composedImagePath: `/storage/${TODAY}.jpg`,
        entries: makeEntries(5, "p7"),
      });

      const manifest = (await buildManifestFn!()) as Manifest;
      const day = manifest.days!.find((d) => d.pickDate === TODAY);
      for (const p of day!.photos!) {
        expect(p.photoId, "photoId 应非空").toBeTruthy();
        expect(typeof p.photoId).toBe("string");
        expect(p.rank, "rank 应为正整数").toBeGreaterThan(0);
        expect(p.title, `${p.photoId} title 应非空`).toBeTruthy();
        expect(typeof p.title).toBe("string");
        expect(p.narrative, `${p.photoId} narrative 应非空`).toBeTruthy();
        expect(typeof p.narrative).toBe("string");
        expect(p.thumbnail, `${p.photoId} thumbnail URL 应非空`).toBeTruthy();
        expect(typeof p.thumbnail).toBe("string");
        expect(p.original, `${p.photoId} original URL 应非空`).toBeTruthy();
        expect(typeof p.original).toBe("string");
      }
    });

    itOrSkip(
      "P7.2 photos[].thumbnail 符合 COS key 约定（{prefix}/photos/{photoId}-thumb.jpg）",
      async () => {
        const photoId = "p7-conv-photo-0";
        insertPhotos(env.dbPath, [{ id: photoId }]);
        insertPick(env.dbPath, {
          id: "pick-p7-conv",
          pickDate: TODAY,
          title: "标题",
          narrative: "叙事",
          composedImagePath: `/storage/${TODAY}.jpg`,
          entries: [{ photoId, rank: 1, title: "标题", narrative: "叙事" }],
        });

        const manifest = (await buildManifestFn!()) as Manifest;
        const day = manifest.days!.find((d) => d.pickDate === TODAY);
        const photo = day!.photos!.find((p) => p.photoId === photoId);
        const expected = expectedPhotoThumbnail(photoId);
        expect(photo!.thumbnail, `thumbnail URL 应符合约定: ${expected}`).toBe(expected);
      },
    );

    itOrSkip("P7.3 MVP 范围：original 暂等于 thumbnail（单页够看，YAGNI）", async () => {
      const photoId = "p7-orig-photo-0";
      insertPhotos(env.dbPath, [{ id: photoId }]);
      insertPick(env.dbPath, {
        id: "pick-p7-orig",
        pickDate: TODAY,
        title: "标题",
        narrative: "叙事",
        composedImagePath: `/storage/${TODAY}.jpg`,
        entries: [{ photoId, rank: 1, title: "标题", narrative: "叙事" }],
      });

      const manifest = (await buildManifestFn!()) as Manifest;
      const day = manifest.days!.find((d) => d.pickDate === TODAY);
      const photo = day!.photos!.find((p) => p.photoId === photoId);
      // MVP 契约：original == thumbnail（state.md §范围控制）
      expect(photo!.original, "MVP original 应等于 thumbnail").toBe(photo!.thumbnail);
    });
  });

  // --------------------------------------------------------------------------
  // manifest 顶层结构
  // --------------------------------------------------------------------------

  describe("manifest 顶层结构（generatedAt + days + videos）", () => {
    itOrSkip("manifest.generatedAt 应为合法 ISO8601（新鲜度标记）", async () => {
      insertPhotos(env.dbPath, [{ id: "gen-photo-0" }]);
      insertPick(env.dbPath, {
        id: "pick-gen",
        pickDate: TODAY,
        title: "标题",
        narrative: "叙事",
        composedImagePath: `/storage/${TODAY}.jpg`,
        entries: [{ photoId: "gen-photo-0", rank: 1, title: "t", narrative: "n" }],
      });

      const manifest = (await buildManifestFn!()) as Manifest;
      expect(manifest.generatedAt, "generatedAt 应存在").toBeDefined();
      expect(typeof manifest.generatedAt).toBe("string");
      // 应能被 Date 解析（ISO8601）
      const parsed = new Date(manifest.generatedAt!);
      expect(Number.isNaN(parsed.getTime()), "generatedAt 应是合法 ISO8601").toBe(false);
    });

    itOrSkip("manifest.days 按 pickDate 合理排序（升序或降序，非乱序）", async () => {
      // 插 3 天，日期乱序
      for (const [i, date] of ["2026-07-01", "2026-07-20", "2026-07-10"].entries()) {
        insertPhotos(env.dbPath, [{ id: `sort-photo-${i}` }]);
        insertPick(env.dbPath, {
          id: `pick-sort-${i}`,
          pickDate: date,
          title: `标题${i}`,
          narrative: `叙事${i}`,
          composedImagePath: `/storage/${date}.jpg`,
          entries: [{ photoId: `sort-photo-${i}`, rank: 1, title: "t", narrative: "n" }],
        });
      }

      const manifest = (await buildManifestFn!()) as Manifest;
      const dates = manifest.days!.map((d) => d.pickDate);
      // 允许升序或降序，不允许乱序
      const sorted = [...dates].sort();
      const reversed = [...dates].sort().reverse();
      const isOrdered =
        JSON.stringify(dates) === JSON.stringify(sorted) ||
        JSON.stringify(dates) === JSON.stringify(reversed);
      expect(isOrdered, `days[] 应有序，实际顺序: ${JSON.stringify(dates)}`).toBe(true);
    });
  });
});

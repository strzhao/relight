/**
 * 验收测试（红队）：buildManifest 生成 videos[] 字段（补充谓词：P30）
 *
 * 设计契约（state.md §manifest.json schema videos[] + §补充谓词 P30）：
 *   manifest.videos[]:
 *     id: 视频主键
 *     title: 标题
 *     themeKey: 主题指纹
 *     themeKind: 'trip' | 'person'
 *     cover: COS URL（{prefix}/videos/{themeKey}.jpg）
 *     mp4:   COS URL（{prefix}/videos/{themeKey}.mp4）
 *     durationSec: 正整数（>0）
 *     createdAt: ISO8601
 *
 *   P30 [det-machine] manifest videos[] 含 themeKey + durationSec（正整数）
 *
 * themeKey 模式（§组件设计 video-discovery）：
 *   - trip: `<regionSlug>-<year>`（如 `lijiang-2026`）
 *   - person: `<personId>-<toYear>`（如 `person-uuid-2026`）
 *   - 共同点：以 4 位年份结尾
 *
 * 红队铁律：本文件仅依据设计文档编写，不读蓝队实现代码。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// Mock：cos-nodejs-sdk-v5（防 import 链触发真实 COS）
// ============================================================================

vi.mock("cos-nodejs-sdk-v5", () => {
  const S3 = vi.fn(() => ({
    putObject: vi.fn(async () => ({})),
    sliceUploadFile: vi.fn(async () => ({})),
    getObjectUrl: vi.fn(),
  }));
  return { default: S3 };
});

// ============================================================================
// Mock：config
// ============================================================================

const TEST_COS_BUCKET = "little-bee-assets-1324334992";
const TEST_COS_REGION = "ap-shanghai";
const TEST_COS_PREFIX = "relight";

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
      bucket: TEST_COS_BUCKET,
      region: TEST_COS_REGION,
      prefix: TEST_COS_PREFIX,
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
// 动态 import 被测模块（蓝队实现前跳过）
// ============================================================================

let buildManifestFn: (() => Promise<unknown>) | null = null;
try {
  const mod = await import("../lib/gallery/manifest");
  buildManifestFn = (mod as { buildManifest?: () => Promise<unknown> }).buildManifest ?? null;
} catch {
  buildManifestFn = null;
}

// ============================================================================
// fixture 工厂
// ============================================================================

interface TestEnv {
  tmpRoot: string;
  dbPath: string;
}

const activeEnvs: TestEnv[] = [];

function createTestEnv(prefix: string): TestEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), `.relight-test-mvideo-${prefix}-`));
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

  const env = { tmpRoot, dbPath };
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

interface VideoFixture {
  id: string;
  themeKind: "trip" | "person";
  themeKey: string;
  title: string;
  outputPath?: string;
  coverPath?: string;
  durationSec?: number | null;
  status?: "completed" | "failed";
  createdAt?: string;
}

function insertVideos(dbPath: string, videos: VideoFixture[]): void {
  const db = new Database(dbPath);
  const stmt = db.prepare(
    `INSERT INTO videos (id, theme_kind, theme_key, title, output_path, cover_path,
                          duration_sec, photo_ids, status, error_msg, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, NULL, ?)`,
  );
  for (const v of videos) {
    stmt.run(
      v.id,
      v.themeKind,
      v.themeKey,
      v.title,
      v.outputPath ?? `/storage/videos/${v.themeKey}.mp4`,
      v.coverPath ?? `/storage/videos/${v.themeKey}.jpg`,
      v.durationSec ?? null,
      v.status ?? "completed",
      v.createdAt ?? new Date().toISOString(),
    );
  }
  db.close();
}

function expectedVideoCover(themeKey: string): string {
  return `https://${TEST_COS_BUCKET}.cos.${TEST_COS_REGION}.myqcloud.com/${TEST_COS_PREFIX}/videos/${themeKey}.jpg`;
}

function expectedVideoMp4(themeKey: string): string {
  return `https://${TEST_COS_BUCKET}.cos.${TEST_COS_REGION}.myqcloud.com/${TEST_COS_PREFIX}/videos/${themeKey}.mp4`;
}

// ============================================================================
// 测试套件
// ============================================================================

interface ManifestVideo {
  id: string;
  title?: string;
  themeKey?: string;
  themeKind?: string;
  cover?: string;
  mp4?: string;
  durationSec?: number;
  createdAt?: string;
}

interface Manifest {
  generatedAt?: string;
  days?: unknown[];
  videos?: ManifestVideo[];
}

const itOrSkip = buildManifestFn ? it : it.skip;

describe("P30 buildManifest videos[] 字段 — 验收测试（红队）", () => {
  beforeEach(() => {
    const env = createTestEnv("p30");
    process.env.DATABASE_PATH = env.dbPath;
    process.env.STORAGE_ROOT = path.join(env.tmpRoot, "storage");
  });

  // --------------------------------------------------------------------------
  // P30 核心：themeKey 模式 + durationSec 正整数
  // --------------------------------------------------------------------------

  describe("P30 themeKey 模式 + durationSec 正整数", () => {
    itOrSkip(
      "P30.1 trip video：themeKind=trip + themeKey 以年份结尾（regionSlug-year）",
      async () => {
        insertVideos(process.env.DATABASE_PATH!, [
          {
            id: "vid-trip-1",
            themeKind: "trip",
            themeKey: "lijiang-2026",
            title: "丽江之行",
            durationSec: 213,
          },
        ]);

        const manifest = (await buildManifestFn!()) as Manifest;
        expect(manifest.videos, "videos[] 应存在").toBeDefined();
        expect(Array.isArray(manifest.videos)).toBe(true);
        expect(manifest.videos!.length, "应含 1 个 video").toBe(1);

        const v = manifest.videos![0]!;
        expect(v.themeKey, "themeKey 应非空").toBeTruthy();
        expect(v.themeKind, "themeKind 应为 trip").toBe("trip");
        // themeKey 形式：<slug>-<year>（如 lijiang-2026）
        expect(v.themeKey, "themeKey 应匹配 <slug>-<year> 模式").toMatch(/^.+-\d{4}$/);
      },
    );

    itOrSkip("P30.2 person video：themeKind=person + themeKey 以年份结尾", async () => {
      insertVideos(process.env.DATABASE_PATH!, [
        {
          id: "vid-person-1",
          themeKind: "person",
          themeKey: "person-uuid-abc-2026",
          title: "成长线",
          durationSec: 180,
        },
      ]);

      const manifest = (await buildManifestFn!()) as Manifest;
      const v = manifest.videos![0]!;
      expect(v.themeKind, "themeKind 应为 person").toBe("person");
      expect(v.themeKey, "themeKey 应非空").toBeTruthy();
      expect(v.themeKey, "themeKey 应以年份结尾").toMatch(/-\d{4}$/);
    });

    itOrSkip("P30.3 durationSec 为正整数（>0 且为整数）", async () => {
      insertVideos(process.env.DATABASE_PATH!, [
        {
          id: "vid-dur-1",
          themeKind: "trip",
          themeKey: "dali-2026",
          title: "大理",
          durationSec: 213,
        },
        {
          id: "vid-dur-2",
          themeKind: "trip",
          themeKey: "xishuangbanna-2025",
          title: "西双版纳",
          durationSec: 195,
        },
      ]);

      const manifest = (await buildManifestFn!()) as Manifest;
      for (const v of manifest.videos!) {
        expect(v.durationSec, `${v.id} durationSec 应存在`).toBeDefined();
        expect(typeof v.durationSec, `${v.id} durationSec 应是 number`).toBe("number");
        expect(
          Number.isInteger(v.durationSec),
          `${v.id} durationSec 应是整数，实际: ${v.durationSec}`,
        ).toBe(true);
        expect(v.durationSec, `${v.id} durationSec 应为正数（>0）`).toBeGreaterThan(0);
      }
    });

    itOrSkip(
      "P30.4 mutation kill：manifest 中所有 video 的 durationSec 必须是正整数（null/0/负数不允许）",
      async () => {
        // 插入合法 + durationSec=null 的混合
        // 蓝队要么过滤掉 null 的，要么 manifest 里填正整数默认 —— P30 不允许 null/0 出现在 manifest
        insertVideos(process.env.DATABASE_PATH!, [
          {
            id: "vid-ok",
            themeKind: "trip",
            themeKey: "ok-2026",
            title: "正常视频",
            durationSec: 210,
          },
          {
            id: "vid-null-dur",
            themeKind: "trip",
            themeKey: "nulldur-2026",
            title: "无时长",
            durationSec: null,
          },
        ]);

        const manifest = (await buildManifestFn!()) as Manifest;
        // 正常视频必在
        const okVideo = manifest.videos!.find((v) => v.id === "vid-ok");
        expect(okVideo, "正常视频应在 manifest 中").toBeDefined();
        expect(okVideo!.durationSec, "正常视频 durationSec 应 > 0").toBeGreaterThan(0);

        // P30 严格：manifest 里所有出现的 video 的 durationSec 必须是正整数
        for (const v of manifest.videos!) {
          expect(
            v.durationSec != null &&
              typeof v.durationSec === "number" &&
              Number.isInteger(v.durationSec) &&
              v.durationSec > 0,
            `${v.id} durationSec=${v.durationSec} 违反 P30 正整数约束`,
          ).toBe(true);
        }
      },
    );
  });

  // --------------------------------------------------------------------------
  // P30 附加：video cover/mp4 URL 符合 COS key 约定
  // --------------------------------------------------------------------------

  describe("P30 video 资源 URL 约定（cover/mp4 COS key）", () => {
    itOrSkip("P30.5 cover URL 符合 {prefix}/videos/{themeKey}.jpg 约定", async () => {
      const themeKey = "lijiang-2026";
      insertVideos(process.env.DATABASE_PATH!, [
        {
          id: "vid-cover",
          themeKind: "trip",
          themeKey,
          title: "封面测试",
          durationSec: 200,
        },
      ]);

      const manifest = (await buildManifestFn!()) as Manifest;
      const v = manifest.videos![0]!;
      expect(v.cover, `cover URL 应符合约定: ${expectedVideoCover(themeKey)}`).toBe(
        expectedVideoCover(themeKey),
      );
    });

    itOrSkip("P30.6 mp4 URL 符合 {prefix}/videos/{themeKey}.mp4 约定", async () => {
      const themeKey = "dali-2026";
      insertVideos(process.env.DATABASE_PATH!, [
        {
          id: "vid-mp4",
          themeKind: "trip",
          themeKey,
          title: "mp4 测试",
          durationSec: 200,
        },
      ]);

      const manifest = (await buildManifestFn!()) as Manifest;
      const v = manifest.videos![0]!;
      expect(v.mp4, `mp4 URL 应符合约定: ${expectedVideoMp4(themeKey)}`).toBe(
        expectedVideoMp4(themeKey),
      );
    });

    itOrSkip("P30.7 createdAt 应为合法 ISO8601", async () => {
      insertVideos(process.env.DATABASE_PATH!, [
        {
          id: "vid-created",
          themeKind: "trip",
          themeKey: "shangri-la-2026",
          title: "createdAt 测试",
          durationSec: 200,
          createdAt: "2026-07-31T10:00:00.000Z",
        },
      ]);

      const manifest = (await buildManifestFn!()) as Manifest;
      const v = manifest.videos![0]!;
      expect(v.createdAt, "createdAt 应存在").toBeTruthy();
      const parsed = new Date(v.createdAt!);
      expect(Number.isNaN(parsed.getTime()), "createdAt 应是合法 ISO8601").toBe(false);
    });

    itOrSkip("P30.8 id 字段非空（前端 hash 路由 #/video/<id> 依赖）", async () => {
      insertVideos(process.env.DATABASE_PATH!, [
        {
          id: "vid-id-test",
          themeKind: "trip",
          themeKey: "id-test-2026",
          title: "id 测试",
          durationSec: 200,
        },
      ]);

      const manifest = (await buildManifestFn!()) as Manifest;
      const v = manifest.videos![0]!;
      expect(v.id, "video id 应非空").toBeTruthy();
      expect(typeof v.id).toBe("string");
      expect(v.id.length, "video id 应有长度").toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // status 过滤：只收录 completed 视频
  // --------------------------------------------------------------------------

  describe("P30 video status 过滤（只收录 completed）", () => {
    itOrSkip("P30.9 failed 视频不应进入 manifest.videos[]", async () => {
      insertVideos(process.env.DATABASE_PATH!, [
        {
          id: "vid-completed",
          themeKind: "trip",
          themeKey: "completed-2026",
          title: "已完成",
          durationSec: 200,
          status: "completed",
        },
        {
          id: "vid-failed",
          themeKind: "trip",
          themeKey: "failed-2026",
          title: "失败",
          durationSec: 200,
          status: "failed",
        },
      ]);

      const manifest = (await buildManifestFn!()) as Manifest;
      const ids = manifest.videos!.map((v) => v.id);
      expect(ids, "completed 视频应被收录").toContain("vid-completed");
      expect(ids, "failed 视频不应进入 manifest（画廊只展示成功视频）").not.toContain("vid-failed");
    });
  });
});

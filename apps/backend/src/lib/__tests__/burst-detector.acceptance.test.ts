/**
 * 验收测试：burst-detector 连拍检测契约（红队，黑盒）
 *
 * 覆盖设计文档 §关键模块.2 — apps/backend/src/lib/burst-detector.ts
 *
 * 契约规范：
 *   - `detectBursts({ storageSourceId, photoIds }): Promise<{ groupsCreated, photosGrouped }>`
 *   - 5 张 takenAt 间隔 ≤ 3s 且 pHash 相似（汉明距离 ≤ 10） → 1 个 burst（memberCount=5）
 *   - 2 张 takenAt 间隔 5s（>3s 阈值）→ 不分组
 *   - 2 张 takenAt 间隔 1s 但 pHash 汉明距离 = 30（场景不同）→ 不分组
 *   - 单成员组（仅 1 张满足条件）不写入 bursts 表
 *   - 初始代表 = fileSize 最大的成员
 *   - groupsCreated / photosGrouped 计数正确
 *
 * 测试使用真实 SQLite（:memory:），不 mock DB。
 * 红队铁律：不读取 burst-detector.ts 实现。
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

// =========================================================================
// 构建内存 SQLite（包含 bursts + 新增 photos 列）
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
      -- 新增列（连拍功能）
      burst_id TEXT,
      is_burst_representative INTEGER NOT NULL DEFAULT 0,
      phash TEXT
    );

    CREATE TABLE bursts (
      id TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
      representative_photo_id TEXT,
      member_count INTEGER NOT NULL DEFAULT 0,
      manual_override INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
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
      score REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL
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
// pHash 工具函数（用于生成测试用 16 位 hex，代表"相似"或"不同"场景）
// 这里直接构造固定 hex 字符串，绕开真实图像，专门测试 burst-detector 行为逻辑
//
// 设计依据：burst-detector 接收 photos 表中 photos.phash 字段，
//           测试通过手动写入 phash 来控制相似度，避免依赖图像生成。
// =========================================================================

/** 16 位 hex，全 0（代表"相似图"基准） */
const PHASH_A = "0000000000000000";
/** 与 PHASH_A 汉明距离 = 0（完全相同） */
const PHASH_A2 = "0000000000000000";
/** 与 PHASH_A 汉明距离 ≈ 8（相似，模拟连拍） */
const PHASH_SIMILAR = "00000000000000ff"; // 最低字节翻转 8 位
/** 与 PHASH_A 汉明距离 = 32（不同场景） */
const PHASH_DIFF = "0000000000000000".replace(/0{8}$/, "ffffffff"); // 后 32 位全 1

// =========================================================================
// 共享测试状态
// =========================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;
const SOURCE_ID = "source-001";

// mock db 模块，使 detectBursts 使用内存 DB
vi.mock("../../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

// mock queues（burst-detector 本身不依赖队列，但被导入时可能间接加载）
vi.mock("../../jobs/queues", () => ({
  scanQueue: { add: vi.fn().mockResolvedValue({ id: "j1" }) },
  analyzeQueue: { add: vi.fn().mockResolvedValue({ id: "j2" }) },
  dailyQueue: { add: vi.fn().mockResolvedValue({ id: "j3" }) },
}));

beforeEach(() => {
  const t = createTestDb();
  testSqlite = t.sqlite;
  testDb = t.db;

  // 插入存储源
  testSqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, 'TestSource', 'local', '/test', 1)",
    )
    .run(SOURCE_ID);

  vi.resetModules();
});

afterEach(() => {
  testSqlite.close();
});

// =========================================================================
// 辅助函数
// =========================================================================

/** 插入测试照片，返回 photoId */
function seedPhoto(opts: {
  id: string;
  takenAt: string | null;
  phash: string | null;
  fileSize?: number;
}): string {
  testSqlite
    .prepare(
      `INSERT INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size,
         taken_at, created_at, media_type, phash)
       VALUES (?, ?, ?, ?, 100, 100, ?, ?, ?, 'image', ?)`,
    )
    .run(
      opts.id,
      SOURCE_ID,
      `/photos/${opts.id}.jpg`,
      `hash-${opts.id}`,
      opts.fileSize ?? 1000,
      opts.takenAt,
      new Date().toISOString(),
      opts.phash,
    );
  return opts.id;
}

/** 查询 bursts 表全部记录 */
function getBursts() {
  return testSqlite.prepare("SELECT * FROM bursts").all() as Array<{
    id: string;
    storage_source_id: string;
    representative_photo_id: string | null;
    member_count: number;
    manual_override: number;
    created_at: string;
  }>;
}

/** 查询 photos.burst_id 不为 NULL 的记录 */
function getGroupedPhotos() {
  return testSqlite
    .prepare("SELECT id, burst_id, is_burst_representative FROM photos WHERE burst_id IS NOT NULL")
    .all() as Array<{ id: string; burst_id: string; is_burst_representative: number }>;
}

/** 在当前时间戳基础上偏移若干毫秒，返回 ISO 字符串 */
function isoOffset(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

// =========================================================================
// 延迟导入 detectBursts（需在 vi.resetModules 后重新加载）
// =========================================================================

async function importDetectBursts() {
  const mod = await import("../burst-detector");
  // 使用 unknown 中转，避免 TS 类型不兼容报错（红队不读取实现，类型以契约为准）
  return mod.detectBursts as unknown as (opts: {
    storageSourceId: string;
    photoIds: string[];
  }) => Promise<{ groupsCreated: number; photosGrouped: number }>;
}

// =========================================================================
// 测试套件
// =========================================================================

describe("burst-detector 契约 — 验收测试（设计文档 §关键模块.2）", () => {
  // -----------------------------------------------------------------------
  // Happy Path: 5 张连拍 → 1 个 burst
  // -----------------------------------------------------------------------
  describe("聚类正确性：5 张时间 ≤ 3s + pHash 相似", () => {
    it("应创建 1 个 burst，memberCount=5，photosGrouped=5", async () => {
      const now = Date.now();
      const ids = ["p1", "p2", "p3", "p4", "p5"];

      // 5 张照片：每张间隔 1s（≤ 3s），phash 完全相同（汉明距离=0）
      ids.forEach((id, i) => {
        seedPhoto({
          id,
          takenAt: isoOffset(now, i * 1000),
          phash: PHASH_A,
          fileSize: 1000 + i * 100, // 不同 fileSize，最大的应成代表
        });
      });

      const detectBursts = await importDetectBursts();
      const result = await detectBursts({ storageSourceId: SOURCE_ID, photoIds: ids });

      expect(result.groupsCreated).toBe(1);
      expect(result.photosGrouped).toBe(5);
    });

    it("bursts 表应有 1 行，member_count=5", async () => {
      const now = Date.now();
      const ids = ["p1", "p2", "p3", "p4", "p5"];
      ids.forEach((id, i) => {
        seedPhoto({ id, takenAt: isoOffset(now, i * 1000), phash: PHASH_A });
      });

      const detectBursts = await importDetectBursts();
      await detectBursts({ storageSourceId: SOURCE_ID, photoIds: ids });

      const bursts = getBursts();
      expect(bursts).toHaveLength(1);
      expect(bursts[0]!.member_count).toBe(5);
      expect(bursts[0]!.storage_source_id).toBe(SOURCE_ID);
    });

    it("所有 5 张照片的 burst_id 应被写入", async () => {
      const now = Date.now();
      const ids = ["p1", "p2", "p3", "p4", "p5"];
      ids.forEach((id, i) => {
        seedPhoto({ id, takenAt: isoOffset(now, i * 1000), phash: PHASH_A });
      });

      const detectBursts = await importDetectBursts();
      await detectBursts({ storageSourceId: SOURCE_ID, photoIds: ids });

      const grouped = getGroupedPhotos();
      expect(grouped).toHaveLength(5);
      const groupedIds = grouped.map((p) => p.id).sort();
      expect(groupedIds).toEqual([...ids].sort());
    });

    it("所有 5 张照片的 burst_id 应指向同一个 burst", async () => {
      const now = Date.now();
      const ids = ["p1", "p2", "p3", "p4", "p5"];
      ids.forEach((id, i) => {
        seedPhoto({ id, takenAt: isoOffset(now, i * 1000), phash: PHASH_A });
      });

      const detectBursts = await importDetectBursts();
      await detectBursts({ storageSourceId: SOURCE_ID, photoIds: ids });

      const grouped = getGroupedPhotos();
      const burstIds = [...new Set(grouped.map((p) => p.burst_id))];
      expect(burstIds).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // 初始代表选择：fileSize 最大的成员
  // -----------------------------------------------------------------------
  describe("初始代表选择：fileSize 最大", () => {
    it("burst.representative_photo_id 应为 fileSize 最大的成员", async () => {
      const now = Date.now();
      // p3 的 fileSize 最大
      const photos = [
        { id: "p1", fileSize: 1000 },
        { id: "p2", fileSize: 2000 },
        { id: "p3", fileSize: 9999 }, // 最大
        { id: "p4", fileSize: 500 },
        { id: "p5", fileSize: 1500 },
      ];
      photos.forEach((p, i) => {
        seedPhoto({
          id: p.id,
          takenAt: isoOffset(now, i * 1000),
          phash: PHASH_A,
          fileSize: p.fileSize,
        });
      });

      const detectBursts = await importDetectBursts();
      await detectBursts({ storageSourceId: SOURCE_ID, photoIds: photos.map((p) => p.id) });

      const bursts = getBursts();
      expect(bursts).toHaveLength(1);
      expect(bursts[0]!.representative_photo_id).toBe("p3");
    });

    it("代表照片的 is_burst_representative 应为 1，其他应为 0", async () => {
      const now = Date.now();
      const photos = [
        { id: "p1", fileSize: 1000 },
        { id: "p2", fileSize: 9000 }, // 最大
        { id: "p3", fileSize: 800 },
      ];
      photos.forEach((p, i) => {
        seedPhoto({
          id: p.id,
          takenAt: isoOffset(now, i * 500),
          phash: PHASH_A,
          fileSize: p.fileSize,
        });
      });

      const detectBursts = await importDetectBursts();
      await detectBursts({ storageSourceId: SOURCE_ID, photoIds: photos.map((p) => p.id) });

      const grouped = getGroupedPhotos();
      const rep = grouped.find((p) => p.id === "p2");
      expect(rep?.is_burst_representative).toBe(1);

      const nonReps = grouped.filter((p) => p.id !== "p2");
      for (const p of nonReps) {
        expect(p.is_burst_representative).toBe(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 时间阈值：> 3s 不分组
  // -----------------------------------------------------------------------
  describe("时间阈值边界：间隔 > 3s 不分组", () => {
    it("2 张照片间隔 5s，应不创建 burst", async () => {
      const now = Date.now();
      seedPhoto({ id: "pa", takenAt: isoOffset(now, 0), phash: PHASH_A });
      seedPhoto({ id: "pb", takenAt: isoOffset(now, 5000), phash: PHASH_A }); // 5s 间隔

      const detectBursts = await importDetectBursts();
      const result = await detectBursts({ storageSourceId: SOURCE_ID, photoIds: ["pa", "pb"] });

      expect(result.groupsCreated).toBe(0);
      expect(result.photosGrouped).toBe(0);
      expect(getBursts()).toHaveLength(0);
    });

    it("2 张照片恰好 3s 间隔（边界），应分组（≤ 3s）", async () => {
      const now = Date.now();
      seedPhoto({ id: "pa", takenAt: isoOffset(now, 0), phash: PHASH_A });
      seedPhoto({ id: "pb", takenAt: isoOffset(now, 3000), phash: PHASH_A }); // 恰好 3s

      const detectBursts = await importDetectBursts();
      const result = await detectBursts({ storageSourceId: SOURCE_ID, photoIds: ["pa", "pb"] });

      expect(result.groupsCreated).toBe(1);
      expect(result.photosGrouped).toBe(2);
    });

    it("2 张照片间隔 3001ms（刚超阈值），应不分组", async () => {
      const now = Date.now();
      seedPhoto({ id: "pa", takenAt: isoOffset(now, 0), phash: PHASH_A });
      seedPhoto({ id: "pb", takenAt: isoOffset(now, 3001), phash: PHASH_A }); // 3.001s

      const detectBursts = await importDetectBursts();
      const result = await detectBursts({ storageSourceId: SOURCE_ID, photoIds: ["pa", "pb"] });

      expect(result.groupsCreated).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // pHash 阈值：汉明距离 > 10 不分组（场景不同）
  // -----------------------------------------------------------------------
  describe("pHash 阈值边界：汉明距离 > 10 不分组", () => {
    it("2 张照片间隔 1s 但 pHash 汉明距离 = 32（场景不同），应不分组", async () => {
      const now = Date.now();
      // PHASH_A = 0000000000000000, PHASH_DIFF 与之距离 = 32
      seedPhoto({ id: "pa", takenAt: isoOffset(now, 0), phash: PHASH_A });
      seedPhoto({ id: "pb", takenAt: isoOffset(now, 1000), phash: PHASH_DIFF }); // 距离 32

      const detectBursts = await importDetectBursts();
      const result = await detectBursts({ storageSourceId: SOURCE_ID, photoIds: ["pa", "pb"] });

      expect(result.groupsCreated).toBe(0);
      expect(result.photosGrouped).toBe(0);
    });

    it("2 张照片间隔 1s 且 pHash 汉明距离 ≤ 10（相似），应分组", async () => {
      const now = Date.now();
      // PHASH_A 与 PHASH_SIMILAR 差 8 位（≤ 10）
      seedPhoto({ id: "pa", takenAt: isoOffset(now, 0), phash: PHASH_A });
      seedPhoto({ id: "pb", takenAt: isoOffset(now, 1000), phash: PHASH_SIMILAR }); // 距离 8

      const detectBursts = await importDetectBursts();
      const result = await detectBursts({ storageSourceId: SOURCE_ID, photoIds: ["pa", "pb"] });

      expect(result.groupsCreated).toBe(1);
      expect(result.photosGrouped).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // 单成员组丢弃
  // -----------------------------------------------------------------------
  describe("单成员组不写入 bursts 表", () => {
    it("1 张照片 → 不创建 burst，photosGrouped=0", async () => {
      const now = Date.now();
      seedPhoto({ id: "alone", takenAt: isoOffset(now, 0), phash: PHASH_A });

      const detectBursts = await importDetectBursts();
      const result = await detectBursts({ storageSourceId: SOURCE_ID, photoIds: ["alone"] });

      expect(result.groupsCreated).toBe(0);
      expect(result.photosGrouped).toBe(0);
      expect(getBursts()).toHaveLength(0);
    });

    it("2 张时间相近但 pHash 差异大，1 张有邻居但条件不满足 → 不产生 1 成员组", async () => {
      const now = Date.now();
      seedPhoto({ id: "p1", takenAt: isoOffset(now, 0), phash: PHASH_A });
      seedPhoto({ id: "p2", takenAt: isoOffset(now, 1000), phash: PHASH_DIFF }); // 距离 32

      const detectBursts = await importDetectBursts();
      const result = await detectBursts({ storageSourceId: SOURCE_ID, photoIds: ["p1", "p2"] });

      expect(result.groupsCreated).toBe(0);
      // bursts 表无任何行（不应有 1 成员组）
      expect(getBursts()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 无 takenAt 照片跳过（不应崩溃）
  // -----------------------------------------------------------------------
  describe("缺少 takenAt 或 phash 的照片处理", () => {
    it("takenAt 为 NULL 的照片不参与聚类，函数不崩溃", async () => {
      const now = Date.now();
      seedPhoto({ id: "no-taken", takenAt: null, phash: PHASH_A });
      seedPhoto({ id: "has-taken", takenAt: isoOffset(now, 0), phash: PHASH_A });

      const detectBursts = await importDetectBursts();
      // 只有 1 张有 takenAt → 无法形成组
      await expect(
        detectBursts({ storageSourceId: SOURCE_ID, photoIds: ["no-taken", "has-taken"] }),
      ).resolves.not.toThrow();

      expect(getBursts()).toHaveLength(0);
    });

    it("phash 为 NULL 的照片不参与聚类，函数不崩溃", async () => {
      const now = Date.now();
      seedPhoto({ id: "no-phash", takenAt: isoOffset(now, 0), phash: null });
      seedPhoto({ id: "has-phash", takenAt: isoOffset(now, 500), phash: PHASH_A });

      const detectBursts = await importDetectBursts();
      await expect(
        detectBursts({ storageSourceId: SOURCE_ID, photoIds: ["no-phash", "has-phash"] }),
      ).resolves.not.toThrow();

      // 只有 1 张有效照片 → 无组
      expect(getBursts()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 多组分离
  // -----------------------------------------------------------------------
  describe("多组分离：2 个独立 burst", () => {
    it("8 张 = 2 组各 4 张（时间断层）→ 返回 groupsCreated=2", async () => {
      const now = Date.now();
      // 组 A：p1-p4，在 t=0 附近
      for (let i = 0; i < 4; i++) {
        seedPhoto({ id: `a${i}`, takenAt: isoOffset(now, i * 500), phash: PHASH_A });
      }
      // 组 B：p5-p8，在 t=30s 附近（与组 A 断层 >3s）
      for (let i = 0; i < 4; i++) {
        seedPhoto({ id: `b${i}`, takenAt: isoOffset(now, 30000 + i * 500), phash: PHASH_A2 });
      }

      const detectBursts = await importDetectBursts();
      const result = await detectBursts({
        storageSourceId: SOURCE_ID,
        photoIds: ["a0", "a1", "a2", "a3", "b0", "b1", "b2", "b3"],
      });

      expect(result.groupsCreated).toBe(2);
      expect(result.photosGrouped).toBe(8);
      expect(getBursts()).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // 空输入
  // -----------------------------------------------------------------------
  describe("空输入边界", () => {
    it("photoIds 为空数组 → 返回 { groupsCreated: 0, photosGrouped: 0 }", async () => {
      const detectBursts = await importDetectBursts();
      const result = await detectBursts({ storageSourceId: SOURCE_ID, photoIds: [] });

      expect(result.groupsCreated).toBe(0);
      expect(result.photosGrouped).toBe(0);
    });
  });
});

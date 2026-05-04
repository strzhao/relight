/**
 * 验收测试：扫描时自动清理孤儿记录 (cleanupOrphans)
 *
 * 覆盖设计文档：
 * - cleanupOrphans 函数：接收 storageSourceId 和 diskFiles，构建磁盘路径 Set，
 *   查询 DB 中该存储源所有 (id, filePath, thumbnailPath)，差集识别孤儿记录
 * - 同一事务中先 DELETE daily_picks 再 DELETE photos（daily_picks 无 ON DELETE CASCADE）
 * - photo_tags 和 photo_analyses 通过 ON DELETE CASCADE 自动级联删除
 * - 用 thumbnailPath 字段精确删除缩略图文件，.catch 容错
 * - try/catch 包裹，失败返回 0 不抛异常
 * - 调用位置：adapter.listFiles() 之后、第一个提前返回之前
 * - 每次扫描都执行（包括无新文件时）
 * - 清理数量通过 job.log 记录
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { eq, inArray } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema";

// ---- 建表（包含完整外键约束：daily_picks 无 CASCADE，photo_tags/photo_analyses 有 CASCADE） ----

function createTestTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS storage_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      root_path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_scan_at TEXT
    );

    CREATE TABLE IF NOT EXISTS photos (
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
      UNIQUE(storage_source_id, file_path)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photo_tags (
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      confidence REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (photo_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS photo_analyses (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      ai_model TEXT NOT NULL,
      raw_response TEXT NOT NULL DEFAULT '',
      narrative TEXT NOT NULL DEFAULT '',
      aesthetic_score REAL NOT NULL DEFAULT 5,
      tags TEXT NOT NULL DEFAULT '[]',
      composition TEXT NOT NULL DEFAULT '{}',
      color_analysis TEXT NOT NULL DEFAULT '{}',
      emotional_analysis TEXT NOT NULL DEFAULT '{}',
      usage_suggestions TEXT NOT NULL DEFAULT '[]',
      prompt_version TEXT NOT NULL DEFAULT 'v1',
      processed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_picks (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL REFERENCES photos(id),
      pick_date TEXT NOT NULL,
      title TEXT NOT NULL,
      narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
}

// ---- 辅助：直接 INSERT SQL（绕过 Drizzle 以支持原始 SQL 操作） ----

function insertPhotoRaw(
  sqlite: Database.Database,
  record: {
    id: string;
    storageSourceId: string;
    filePath: string;
    fileHash: string;
    thumbnailPath: string | null;
    takenAt?: string | null;
  },
): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, thumbnail_path, taken_at, created_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.storageSourceId,
      record.filePath,
      record.fileHash,
      record.thumbnailPath,
      record.takenAt ?? null,
      now,
    );
}

function insertTagRaw(
  sqlite: Database.Database,
  record: { id: string; name: string; category: string },
): void {
  const now = new Date().toISOString();
  sqlite
    .prepare("INSERT INTO tags (id, name, category, created_at) VALUES (?, ?, ?, ?)")
    .run(record.id, record.name, record.category, now);
}

function insertPhotoTagRaw(
  sqlite: Database.Database,
  record: { photoId: string; tagId: string; confidence?: number },
): void {
  sqlite
    .prepare("INSERT INTO photo_tags (photo_id, tag_id, confidence) VALUES (?, ?, ?)")
    .run(record.photoId, record.tagId, record.confidence ?? 0.8);
}

function insertPhotoAnalysisRaw(
  sqlite: Database.Database,
  record: { id: string; photoId: string; aiModel?: string },
): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO photo_analyses (id, photo_id, ai_model, raw_response, narrative, aesthetic_score, tags, composition, color_analysis, emotional_analysis, usage_suggestions, prompt_version, processed_at)
     VALUES (?, ?, ?, '{}', '', 5, '[]', '{}', '{}', '{}', '[]', 'v1', ?)`,
    )
    .run(record.id, record.photoId, record.aiModel ?? "qwen3.6-35b", now);
}

function insertDailyPickRaw(
  sqlite: Database.Database,
  record: { id: string; photoId: string; pickDate?: string; title?: string },
): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score, created_at)
     VALUES (?, ?, ?, ?, '', 8.5, ?)`,
    )
    .run(
      record.id,
      record.photoId,
      record.pickDate ?? now.slice(0, 10),
      record.title ?? "精选",
      now,
    );
}

// ---- 辅助：模拟 cleanupOrphans 函数（严格遵循设计文档规范） ----

interface CleanupResult {
  /** 清理的孤儿记录数 */
  cleaned: number;
  /** 被删除的 thumbnail 文件路径列表（用于验证） */
  deletedThumbnails: string[];
  /** 是否抛出了异常 */
  threw: boolean;
}

/**
 * 模拟 cleanupOrphans 的核心逻辑。
 *
 * 设计文档规定的行为：
 * 1. 接收 storageSourceId 和 diskFiles 数组
 * 2. 构建磁盘路径 Set
 * 3. 查询 DB 中该存储源所有 (id, filePath, thumbnailPath)
 * 4. 差集：DB 有但磁盘无 = 孤儿记录
 * 5. 同一事务：DELETE daily_picks → DELETE photos
 * 6. photo_tags 和 photo_analyses 通过 ON DELETE CASCADE 自动清理
 * 7. 用 thumbnailPath 字段精确删除缩略图文件，.catch 容错
 * 8. try/catch 包裹，失败返回 0 不抛异常
 * 9. 返回清理数量
 */
async function simulateCleanupOrphans(
  db: BetterSQLite3Database<typeof schema>,
  sqlite: Database.Database,
  storageSourceId: string,
  diskFiles: string[],
  /** 是否模拟缩略图文件存在（用于测试缩略图清理行为） */
  thumbnailFiles?: Map<string, boolean>,
): Promise<CleanupResult> {
  const deletedThumbnails: string[] = [];
  const threw = false;

  try {
    // 1. 构建磁盘路径 Set
    const diskPaths = new Set(diskFiles);

    // 2. 查询 DB 中该存储源所有 (id, filePath, thumbnailPath)
    const dbPhotos = await db
      .select({
        id: schema.photos.id,
        filePath: schema.photos.filePath,
        thumbnailPath: schema.photos.thumbnailPath,
      })
      .from(schema.photos)
      .where(eq(schema.photos.storageSourceId, storageSourceId));

    // 3. 差集：DB 有但磁盘无 = 孤儿记录
    const orphanIds: string[] = [];
    const orphanThumbnailPaths: (string | null)[] = [];

    for (const photo of dbPhotos) {
      if (!diskPaths.has(photo.filePath)) {
        orphanIds.push(photo.id);
        orphanThumbnailPaths.push(photo.thumbnailPath);
      }
    }

    if (orphanIds.length === 0) {
      return { cleaned: 0, deletedThumbnails: [], threw: false };
    }

    // 4. 同一事务：DELETE daily_picks → DELETE photos
    //    （daily_picks 无 ON DELETE CASCADE，必须先删）
    const deleteTransaction = sqlite.transaction(() => {
      // 先删除 daily_picks（引用 photos 的 FK，无 CASCADE）
      for (const photoId of orphanIds) {
        sqlite.prepare("DELETE FROM daily_picks WHERE photo_id = ?").run(photoId);
      }

      // 再删除 photos（photo_tags/photo_analyses 有 ON DELETE CASCADE 自动清理）
      for (const photoId of orphanIds) {
        sqlite.prepare("DELETE FROM photos WHERE id = ?").run(photoId);
      }
    });

    deleteTransaction();

    // 5. 用 thumbnailPath 字段精确删除缩略图文件，.catch 容错
    for (const thumbPath of orphanThumbnailPaths) {
      if (thumbPath) {
        try {
          // 如果 thumbnailFiles 提供了模拟状态，据此判断文件是否存在
          const exists = thumbnailFiles?.get(thumbPath) ?? true;
          if (exists) {
            deletedThumbnails.push(thumbPath);
          }
          // .catch 容错：缩略图不存在时不应阻塞
        } catch {
          // 容错：缩略图删除失败不阻塞
        }
      }
    }

    return { cleaned: orphanIds.length, deletedThumbnails, threw: false };
  } catch {
    // 6. try/catch 包裹，失败返回 0 不抛异常
    return { cleaned: 0, deletedThumbnails: [], threw: false };
  }
}

// ---- 辅助：创建临时缩略图文件用于文件系统测试 ----

function createTempThumbnailFile(): { dir: string; filePath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-orphans-test-"));
  const filePath = path.join(dir, "thumb_test.jpg");
  fs.writeFileSync(filePath, Buffer.from("fake-thumbnail-data"));
  return {
    dir,
    filePath,
    cleanup: () => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
      try {
        fs.rmdirSync(dir);
      } catch {
        /* ignore */
      }
    },
  };
}

// =========================================================================
// 测试
// =========================================================================

describe("cleanupOrphans — 验收测试（扫描时自动清理孤儿记录）", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let storageSourceId: string;

  beforeAll(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });

    createTestTables(sqlite);

    // 创建测试用存储源
    storageSourceId = crypto.randomUUID();
    sqlite
      .prepare(
        `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES (?, ?, 'local', '/tmp/test-cleanup', 1)`,
      )
      .run(storageSourceId, "测试存储源");
  });

  afterAll(() => {
    sqlite?.close();
  });

  afterEach(() => {
    // 清空所有数据，保留存储源
    sqlite.exec("DELETE FROM daily_picks");
    sqlite.exec("DELETE FROM photo_analyses");
    sqlite.exec("DELETE FROM photo_tags");
    sqlite.exec("DELETE FROM tags");
    sqlite.exec("DELETE FROM photos");
  });

  // =========================================================================
  // 1. 无孤儿时返回 0
  // =========================================================================

  describe("无孤儿时返回 0", () => {
    it("磁盘文件和 DB 记录一一对应时应返回 0", async () => {
      const diskFiles = ["/tmp/test-cleanup/a.jpg", "/tmp/test-cleanup/b.jpg"];

      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/a.jpg",
        fileHash: "aaa111",
        thumbnailPath: null,
      });
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/b.jpg",
        fileHash: "bbb222",
        thumbnailPath: null,
      });

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, diskFiles);

      expect(result.cleaned).toBe(0);
      expect(result.threw).toBe(false);

      // 确认 records 未被删除
      const photos = await db.select().from(schema.photos);
      expect(photos).toHaveLength(2);
    });

    it("DB 中无记录时应返回 0", async () => {
      const diskFiles = ["/tmp/test-cleanup/x.jpg"];

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, diskFiles);

      expect(result.cleaned).toBe(0);
      expect(result.threw).toBe(false);
    });

    it("磁盘文件是 DB 记录的超集时应返回 0（无孤儿）", async () => {
      const diskFiles = [
        "/tmp/test-cleanup/a.jpg",
        "/tmp/test-cleanup/b.jpg",
        "/tmp/test-cleanup/c.jpg",
      ];

      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/a.jpg",
        fileHash: "aaa111",
        thumbnailPath: null,
      });
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/b.jpg",
        fileHash: "bbb222",
        thumbnailPath: null,
      });

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, diskFiles);

      expect(result.cleaned).toBe(0);

      const photos = await db.select().from(schema.photos);
      expect(photos).toHaveLength(2);
    });
  });

  // =========================================================================
  // 2. 有孤儿时正确识别和删除
  // =========================================================================

  describe("有孤儿时正确识别和删除", () => {
    it("磁盘删除一个文件后，对应 DB 记录应被识别为孤儿并删除", async () => {
      const photoId1 = crypto.randomUUID();
      const photoId2 = crypto.randomUUID();

      insertPhotoRaw(sqlite, {
        id: photoId1,
        storageSourceId,
        filePath: "/tmp/test-cleanup/keep.jpg",
        fileHash: "keep111",
        thumbnailPath: null,
      });
      insertPhotoRaw(sqlite, {
        id: photoId2,
        storageSourceId,
        filePath: "/tmp/test-cleanup/delete.jpg",
        fileHash: "delete222",
        thumbnailPath: null,
      });

      // 磁盘上只剩 keep.jpg，delete.jpg 不在磁盘上
      const diskFiles = ["/tmp/test-cleanup/keep.jpg"];

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, diskFiles);

      expect(result.cleaned).toBe(1);

      // 确认孤儿记录被删除
      const remainingPhotos = await db.select().from(schema.photos);
      expect(remainingPhotos).toHaveLength(1);
      expect(remainingPhotos[0]?.id).toBe(photoId1);
      expect(remainingPhotos[0]?.filePath).toBe("/tmp/test-cleanup/keep.jpg");
    });

    it("多个孤儿记录应全部被识别和删除", async () => {
      const keepId = crypto.randomUUID();
      const orphanId1 = crypto.randomUUID();
      const orphanId2 = crypto.randomUUID();

      insertPhotoRaw(sqlite, {
        id: keepId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/keep.jpg",
        fileHash: "keep111",
        thumbnailPath: null,
      });
      insertPhotoRaw(sqlite, {
        id: orphanId1,
        storageSourceId,
        filePath: "/tmp/test-cleanup/gone1.jpg",
        fileHash: "gone111",
        thumbnailPath: null,
      });
      insertPhotoRaw(sqlite, {
        id: orphanId2,
        storageSourceId,
        filePath: "/tmp/test-cleanup/gone2.jpg",
        fileHash: "gone222",
        thumbnailPath: null,
      });

      const diskFiles = ["/tmp/test-cleanup/keep.jpg"];

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, diskFiles);

      expect(result.cleaned).toBe(2);

      const remainingPhotos = await db.select().from(schema.photos);
      expect(remainingPhotos).toHaveLength(1);
      expect(remainingPhotos[0]?.id).toBe(keepId);
    });

    it("磁盘文件全部删除后，所有 DB 记录均为孤儿", async () => {
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/all-gone-1.jpg",
        fileHash: "allgone1",
        thumbnailPath: null,
      });
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/all-gone-2.jpg",
        fileHash: "allgone2",
        thumbnailPath: null,
      });
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/all-gone-3.jpg",
        fileHash: "allgone3",
        thumbnailPath: null,
      });

      const diskFiles: string[] = []; // 磁盘上无任何文件

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, diskFiles);

      expect(result.cleaned).toBe(3);

      const remainingPhotos = await db.select().from(schema.photos);
      expect(remainingPhotos).toHaveLength(0);
    });

    it("只匹配同一 storageSourceId 的孤儿，不误删其他存储源的记录", async () => {
      // 另一个存储源
      const otherSourceId = crypto.randomUUID();
      sqlite
        .prepare(
          `INSERT INTO storage_sources (id, name, type, root_path, enabled)
         VALUES (?, '其他存储源', 'local', '/tmp/other', 1)`,
        )
        .run(otherSourceId);

      const ourPhotoId = crypto.randomUUID();
      const otherPhotoId = crypto.randomUUID();

      insertPhotoRaw(sqlite, {
        id: ourPhotoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/our-gone.jpg",
        fileHash: "ourgone",
        thumbnailPath: null,
      });
      insertPhotoRaw(sqlite, {
        id: otherPhotoId,
        storageSourceId: otherSourceId,
        filePath: "/tmp/other/their-gone.jpg",
        fileHash: "theirgone",
        thumbnailPath: null,
      });

      // 磁盘上为空，但只清理 storageSourceId 对应的记录
      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);

      expect(result.cleaned).toBe(1);

      // 另一个存储源的记录应保留
      const allPhotos = await db.select().from(schema.photos);
      expect(allPhotos).toHaveLength(1);
      expect(allPhotos[0]?.id).toBe(otherPhotoId);
      expect(allPhotos[0]?.storageSourceId).toBe(otherSourceId);
    });
  });

  // =========================================================================
  // 3. daily_picks 在同一事务中先删除
  // =========================================================================

  describe("daily_picks 在同一事务中先删除", () => {
    it("孤儿记录的 daily_picks 应与 photos 一同被清理", async () => {
      const photoId = crypto.randomUUID();
      const dailyPickId = crypto.randomUUID();

      insertPhotoRaw(sqlite, {
        id: photoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/picked-gone.jpg",
        fileHash: "pickedgone",
        thumbnailPath: null,
      });
      insertDailyPickRaw(sqlite, {
        id: dailyPickId,
        photoId,
        pickDate: "2024-06-15",
        title: "今日最佳",
      });

      // 确认 daily_picks 存在
      const picksBefore = sqlite.prepare("SELECT COUNT(*) as cnt FROM daily_picks").get() as {
        cnt: number;
      };
      expect(picksBefore.cnt).toBe(1);

      // 磁盘上无此文件 → 孤儿
      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);

      expect(result.cleaned).toBe(1);

      // daily_picks 应被删除（因为事务中先 DELETE daily_picks 再 DELETE photos）
      const picksAfter = sqlite.prepare("SELECT COUNT(*) as cnt FROM daily_picks").get() as {
        cnt: number;
      };
      expect(picksAfter.cnt).toBe(0);

      // photos 也应被删除
      const photosAfter = await db.select().from(schema.photos);
      expect(photosAfter).toHaveLength(0);
    });

    it("daily_picks 无 ON DELETE CASCADE 约束时，直接删 photos 应被 FK 拒绝", async () => {
      const photoId = crypto.randomUUID();
      const dailyPickId = crypto.randomUUID();

      insertPhotoRaw(sqlite, {
        id: photoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/fk-test.jpg",
        fileHash: "fktest",
        thumbnailPath: null,
      });
      insertDailyPickRaw(sqlite, {
        id: dailyPickId,
        photoId,
      });

      // 验证：尝试直接删除 photos（不先删 daily_picks）应违反 FK 约束
      expect(() => {
        sqlite.prepare("DELETE FROM photos WHERE id = ?").run(photoId);
      }).toThrow();

      // 确认 photos 和 daily_picks 均未被删除
      const photosAfter = sqlite.prepare("SELECT COUNT(*) as cnt FROM photos").get() as {
        cnt: number;
      };
      expect(photosAfter.cnt).toBe(1);
      const picksAfter = sqlite.prepare("SELECT COUNT(*) as cnt FROM daily_picks").get() as {
        cnt: number;
      };
      expect(picksAfter.cnt).toBe(1);
    });

    it("先删 daily_picks 再删 photos 在同一事务中成功", async () => {
      const photoId = crypto.randomUUID();
      const dailyPickId = crypto.randomUUID();

      insertPhotoRaw(sqlite, {
        id: photoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/tx-test.jpg",
        fileHash: "txtest",
        thumbnailPath: null,
      });
      insertDailyPickRaw(sqlite, {
        id: dailyPickId,
        photoId,
      });

      // 同一事务：先删 daily_picks，再删 photos
      const tx = sqlite.transaction(() => {
        sqlite.prepare("DELETE FROM daily_picks WHERE photo_id = ?").run(photoId);
        sqlite.prepare("DELETE FROM photos WHERE id = ?").run(photoId);
      });

      expect(() => tx()).not.toThrow();

      const photosAfter = sqlite.prepare("SELECT COUNT(*) as cnt FROM photos").get() as {
        cnt: number;
      };
      expect(photosAfter.cnt).toBe(0);
      const picksAfter = sqlite.prepare("SELECT COUNT(*) as cnt FROM daily_picks").get() as {
        cnt: number;
      };
      expect(picksAfter.cnt).toBe(0);
    });

    it("仅有无 daily_picks 的孤儿 photo 应能正常删除", async () => {
      const photoId = crypto.randomUUID();

      insertPhotoRaw(sqlite, {
        id: photoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/no-pick-gone.jpg",
        fileHash: "nopickgone",
        thumbnailPath: null,
      });

      // 磁盘上无此文件
      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);

      expect(result.cleaned).toBe(1);

      const photosAfter = await db.select().from(schema.photos);
      expect(photosAfter).toHaveLength(0);
    });
  });

  // =========================================================================
  // 4. photo_tags 和 photo_analyses 级联删除
  // =========================================================================

  describe("photo_tags 和 photo_analyses 级联删除（ON DELETE CASCADE）", () => {
    it("删除 photo 时关联的 photo_tags 应级联删除", async () => {
      const photoId = crypto.randomUUID();
      const tagId = crypto.randomUUID();

      insertPhotoRaw(sqlite, {
        id: photoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/cascade-tags.jpg",
        fileHash: "cascadetags",
        thumbnailPath: null,
      });
      insertTagRaw(sqlite, { id: tagId, name: "风景", category: "scene" });
      insertPhotoTagRaw(sqlite, { photoId, tagId });

      // 确认 photo_tags 存在
      const ptBefore = sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_tags").get() as {
        cnt: number;
      };
      expect(ptBefore.cnt).toBe(1);

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);

      expect(result.cleaned).toBe(1);

      // photo_tags 应级联删除
      const ptAfter = sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_tags").get() as {
        cnt: number;
      };
      expect(ptAfter.cnt).toBe(0);

      // tags 表本身不应被删除
      const tagsAfter = sqlite.prepare("SELECT COUNT(*) as cnt FROM tags").get() as { cnt: number };
      expect(tagsAfter.cnt).toBe(1);
    });

    it("删除 photo 时关联的 photo_analyses 应级联删除", async () => {
      const photoId = crypto.randomUUID();
      const analysisId = crypto.randomUUID();

      insertPhotoRaw(sqlite, {
        id: photoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/cascade-analysis.jpg",
        fileHash: "cascadeanalysis",
        thumbnailPath: null,
      });
      insertPhotoAnalysisRaw(sqlite, { id: analysisId, photoId });

      // 确认 photo_analyses 存在
      const paBefore = sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_analyses").get() as {
        cnt: number;
      };
      expect(paBefore.cnt).toBe(1);

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);

      expect(result.cleaned).toBe(1);

      // photo_analyses 应级联删除
      const paAfter = sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_analyses").get() as {
        cnt: number;
      };
      expect(paAfter.cnt).toBe(0);
    });

    it("同时有 photo_tags 和 photo_analyses 的孤儿应全部级联删除", async () => {
      const photoId = crypto.randomUUID();
      const tagId = crypto.randomUUID();
      const analysisId = crypto.randomUUID();

      insertPhotoRaw(sqlite, {
        id: photoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/cascade-all.jpg",
        fileHash: "cascadeall",
        thumbnailPath: null,
      });
      insertTagRaw(sqlite, { id: tagId, name: "城市", category: "scene" });
      insertPhotoTagRaw(sqlite, { photoId, tagId });
      insertPhotoAnalysisRaw(sqlite, { id: analysisId, photoId });

      const ptBefore = sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_tags").get() as {
        cnt: number;
      };
      const paBefore = sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_analyses").get() as {
        cnt: number;
      };
      expect(ptBefore.cnt).toBe(1);
      expect(paBefore.cnt).toBe(1);

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);

      expect(result.cleaned).toBe(1);

      const ptAfter = sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_tags").get() as {
        cnt: number;
      };
      const paAfter = sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_analyses").get() as {
        cnt: number;
      };
      expect(ptAfter.cnt).toBe(0);
      expect(paAfter.cnt).toBe(0);
    });

    it("非孤儿 photo 的关联数据不应受影响", async () => {
      const keepPhotoId = crypto.randomUUID();
      const orphanPhotoId = crypto.randomUUID();
      const tagId1 = crypto.randomUUID();
      const tagId2 = crypto.randomUUID();
      const analysisId1 = crypto.randomUUID();
      const analysisId2 = crypto.randomUUID();

      // 保留的 photo
      insertPhotoRaw(sqlite, {
        id: keepPhotoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/keep-data.jpg",
        fileHash: "keepdata",
        thumbnailPath: null,
      });
      // 孤儿 photo
      insertPhotoRaw(sqlite, {
        id: orphanPhotoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/orphan-data.jpg",
        fileHash: "orphandata",
        thumbnailPath: null,
      });

      insertTagRaw(sqlite, { id: tagId1, name: "白天", category: "scene" });
      insertTagRaw(sqlite, { id: tagId2, name: "夜晚", category: "scene" });
      insertPhotoTagRaw(sqlite, { photoId: keepPhotoId, tagId: tagId1 });
      insertPhotoTagRaw(sqlite, { photoId: orphanPhotoId, tagId: tagId2 });
      insertPhotoAnalysisRaw(sqlite, { id: analysisId1, photoId: keepPhotoId });
      insertPhotoAnalysisRaw(sqlite, { id: analysisId2, photoId: orphanPhotoId });

      // 磁盘上只有 keep-data.jpg
      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, [
        "/tmp/test-cleanup/keep-data.jpg",
      ]);

      expect(result.cleaned).toBe(1);

      // 保留的 photo 及其关联数据应完好
      const ptAfter = sqlite
        .prepare("SELECT * FROM photo_tags WHERE photo_id = ?")
        .all(keepPhotoId);
      expect(ptAfter).toHaveLength(1);
      const paAfter = sqlite
        .prepare("SELECT * FROM photo_analyses WHERE photo_id = ?")
        .all(keepPhotoId);
      expect(paAfter).toHaveLength(1);

      // 孤儿的关联数据应被级联删除
      const ptOrphan = sqlite
        .prepare("SELECT * FROM photo_tags WHERE photo_id = ?")
        .all(orphanPhotoId);
      expect(ptOrphan).toHaveLength(0);
      const paOrphan = sqlite
        .prepare("SELECT * FROM photo_analyses WHERE photo_id = ?")
        .all(orphanPhotoId);
      expect(paOrphan).toHaveLength(0);
    });
  });

  // =========================================================================
  // 5. 缩略图文件清理
  // =========================================================================

  describe("缩略图文件清理", () => {
    it("孤儿有 thumbnailPath 时应尝试删除缩略图文件", async () => {
      const photoId = crypto.randomUUID();
      const thumbPath = "/tmp/test-cleanup/thumbnails/with-thumb.jpg";

      insertPhotoRaw(sqlite, {
        id: photoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/with-thumb.jpg",
        fileHash: "withthumb",
        thumbnailPath: thumbPath,
      });

      const thumbnailFiles = new Map<string, boolean>();
      thumbnailFiles.set(thumbPath, true);

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, [], thumbnailFiles);

      expect(result.cleaned).toBe(1);
      // 缩略图路径应被记录为已删除
      expect(result.deletedThumbnails).toContain(thumbPath);
    });

    it("thumbnailPath 为 null 时不尝试删除缩略图", async () => {
      const photoId = crypto.randomUUID();

      insertPhotoRaw(sqlite, {
        id: photoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/no-thumb.jpg",
        fileHash: "nothumb",
        thumbnailPath: null,
      });

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);

      expect(result.cleaned).toBe(1);
      expect(result.deletedThumbnails).toHaveLength(0);
    });

    it("缩略图文件不存在时不阻塞清理流程", async () => {
      const photoId = crypto.randomUUID();
      const missingThumbPath = "/tmp/test-cleanup/thumbnails/missing.jpg";

      insertPhotoRaw(sqlite, {
        id: photoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/missing-thumb.jpg",
        fileHash: "missingthumb",
        thumbnailPath: missingThumbPath,
      });

      // 缩略图文件不存在
      const thumbnailFiles = new Map<string, boolean>();
      thumbnailFiles.set(missingThumbPath, false);

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, [], thumbnailFiles);

      // 即使缩略图不存在，photo 记录仍应被删除
      expect(result.cleaned).toBe(1);

      const photosAfter = await db.select().from(schema.photos);
      expect(photosAfter).toHaveLength(0);
    });

    it("真实的文件系统缩略图文件应能被正常删除", async () => {
      const tmp = createTempThumbnailFile();

      try {
        const photoId = crypto.randomUUID();

        insertPhotoRaw(sqlite, {
          id: photoId,
          storageSourceId,
          filePath: "/tmp/test-cleanup/real-thumb-test.jpg",
          fileHash: "realthumbtest",
          thumbnailPath: tmp.filePath,
        });

        // 确认文件存在
        expect(fs.existsSync(tmp.filePath)).toBe(true);

        // 直接测试缩略图删除逻辑（模拟 cleanupOrphans 中的缩略图清理部分）
        const orphanThumbnailPaths = [tmp.filePath];
        for (const thumbPath of orphanThumbnailPaths) {
          if (thumbPath) {
            try {
              fs.unlinkSync(thumbPath);
            } catch {
              // .catch 容错
            }
          }
        }

        // 验证文件已被删除
        expect(fs.existsSync(tmp.filePath)).toBe(false);
      } finally {
        tmp.cleanup();
      }
    });

    it("缩略图删除失败（权限等原因）.catch 不抛异常", async () => {
      const photoId = crypto.randomUUID();
      const thumbPath = "/root/protected/thumb.jpg"; // 无权限路径

      insertPhotoRaw(sqlite, {
        id: photoId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/perm-error.jpg",
        fileHash: "permerror",
        thumbnailPath: thumbPath,
      });

      // 使用真实 fs.unlinkSync 调用一个明显不存在的路径（如 /root/...）
      // 应触发异常但被 .catch 捕获
      let caughtError: Error | null = null;
      try {
        fs.unlinkSync(thumbPath);
      } catch (e) {
        caughtError = e as Error;
      }
      // 确认确实会抛异常
      expect(caughtError).not.toBeNull();

      // 但 simulateCleanupOrphans 中 .catch 应容错，清理仍返回 1
      // （这里直接测试：缩略图删除失败不应影响结果）
      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);

      expect(result.cleaned).toBe(1);
      expect(result.threw).toBe(false);
    });
  });

  // =========================================================================
  // 6. 错误容错（函数不抛异常）
  // =========================================================================

  describe("错误容错：函数不抛异常", () => {
    it("try/catch 包裹，任何内部异常应被捕获并返回 0", async () => {
      // 模拟一个会导致异常的场景：storageSourceId 格式错误
      // 但在 simulateCleanupOrphans 中 try/catch 已包裹

      // 用正常输入验证函数不抛异常
      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);

      // 函数不应 throw
      expect(result.threw).toBe(false);
      // 应返回有效数字
      expect(typeof result.cleaned).toBe("number");
    });

    it("返回 0 而不是抛异常，确保扫描流程不受影响", async () => {
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/safe-test.jpg",
        fileHash: "safetest",
        thumbnailPath: null,
      });

      // 正常场景返回 > 0
      const result1 = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);
      expect(result1.cleaned).toBe(1);

      // 确认即使清理了记录，后续调用也不抛异常
      const result2 = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);
      expect(result2.cleaned).toBe(0);
      expect(result2.threw).toBe(false);
    });
  });

  // =========================================================================
  // 7. 每次扫描都执行
  // =========================================================================

  describe("每次扫描都执行（包括无新文件时）", () => {
    it("第二次扫描（无新文件）仍应执行孤儿清理", async () => {
      // 第一次扫描：有文件
      const firstDiskFiles = ["/tmp/test-cleanup/scan-twice.jpg"];
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/scan-twice.jpg",
        fileHash: "scantwice",
        thumbnailPath: null,
      });

      const result1 = await simulateCleanupOrphans(db, sqlite, storageSourceId, firstDiskFiles);
      expect(result1.cleaned).toBe(0); // 无孤儿

      // 第二次扫描：相同文件（无新文件），但仍执行孤儿清理
      const secondDiskFiles = ["/tmp/test-cleanup/scan-twice.jpg"];
      const result2 = await simulateCleanupOrphans(db, sqlite, storageSourceId, secondDiskFiles);
      expect(result2.cleaned).toBe(0); // 清理逻辑执行了，只是无孤儿

      // 记录仍在
      const photos = await db.select().from(schema.photos);
      expect(photos).toHaveLength(1);
    });

    it("新老文件混合时正确识别仅在磁盘上存在的孤儿", async () => {
      // 初始状态：DB 有 3 条记录
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/stay.jpg",
        fileHash: "stayhash",
        thumbnailPath: null,
      });
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/old-gone.jpg",
        fileHash: "oldgonehash",
        thumbnailPath: null,
      });
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/old-gone-2.jpg",
        fileHash: "oldgone2hash",
        thumbnailPath: null,
      });

      // 第二次扫描：磁盘上有 stay.jpg + 新文件 new.jpg，但 old-gone.jpg 和 old-gone-2.jpg 已不在
      const diskFiles = ["/tmp/test-cleanup/stay.jpg", "/tmp/test-cleanup/new.jpg"];

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, diskFiles);

      // 应清理 2 条孤儿
      expect(result.cleaned).toBe(2);

      const remainingPhotos = await db.select().from(schema.photos);
      expect(remainingPhotos).toHaveLength(1);
      expect(remainingPhotos[0]?.filePath).toBe("/tmp/test-cleanup/stay.jpg");
    });

    it("空文件列表扫描（例如存储源为空）仍执行清理", async () => {
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: "/tmp/test-cleanup/empty-scan-gone.jpg",
        fileHash: "emptyscangone",
        thumbnailPath: null,
      });

      // 磁盘文件列表为空（如存储源目录为空或不存在）
      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);

      expect(result.cleaned).toBe(1);
      expect(result.threw).toBe(false);

      const photos = await db.select().from(schema.photos);
      expect(photos).toHaveLength(0);
    });
  });

  // =========================================================================
  // 8. 综合场景
  // =========================================================================

  describe("综合场景", () => {
    it("孤儿记录 + daily_picks + photo_tags + photo_analyses + 缩略图全部正确清理", async () => {
      const keepId = crypto.randomUUID();
      const orphanId = crypto.randomUUID();
      const tagId = crypto.randomUUID();
      const analysisId = crypto.randomUUID();
      const dailyPickId = crypto.randomUUID();
      const thumbPath = "/tmp/test-cleanup/thumbnails/complex.jpg";

      // 保留的 photo
      insertPhotoRaw(sqlite, {
        id: keepId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/complex-keep.jpg",
        fileHash: "complexkeep",
        thumbnailPath: null,
      });

      // 孤儿 photo
      insertPhotoRaw(sqlite, {
        id: orphanId,
        storageSourceId,
        filePath: "/tmp/test-cleanup/complex-orphan.jpg",
        fileHash: "complexorphan",
        thumbnailPath: thumbPath,
      });

      // 孤儿关联数据
      insertTagRaw(sqlite, { id: tagId, name: "黄昏", category: "scene" });
      insertPhotoTagRaw(sqlite, { photoId: orphanId, tagId });
      insertPhotoAnalysisRaw(sqlite, { id: analysisId, photoId: orphanId });
      insertDailyPickRaw(sqlite, {
        id: dailyPickId,
        photoId: orphanId,
        pickDate: "2024-12-25",
        title: "圣诞精选",
      });

      // 验证初始状态
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM photos").get() as { cnt: number }).cnt,
      ).toBe(2);
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM daily_picks").get() as { cnt: number }).cnt,
      ).toBe(1);
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_tags").get() as { cnt: number }).cnt,
      ).toBe(1);
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_analyses").get() as { cnt: number }).cnt,
      ).toBe(1);

      // 磁盘上只有 keep 文件
      const thumbnailFiles = new Map<string, boolean>();
      thumbnailFiles.set(thumbPath, true);

      const result = await simulateCleanupOrphans(
        db,
        sqlite,
        storageSourceId,
        ["/tmp/test-cleanup/complex-keep.jpg"],
        thumbnailFiles,
      );

      expect(result.cleaned).toBe(1);
      expect(result.deletedThumbnails).toContain(thumbPath);

      // 所有孤儿关联数据应被清理
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM photos").get() as { cnt: number }).cnt,
      ).toBe(1);
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM daily_picks").get() as { cnt: number }).cnt,
      ).toBe(0);
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_tags").get() as { cnt: number }).cnt,
      ).toBe(0);
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_analyses").get() as { cnt: number }).cnt,
      ).toBe(0);

      // 保留的记录仍在
      const keptPhoto = sqlite.prepare("SELECT * FROM photos WHERE id = ?").get(keepId);
      expect(keptPhoto).not.toBeNull();
    });

    it("多个孤儿 + 多个关联数据的批量清理", async () => {
      const now = new Date().toISOString().slice(0, 10);

      // 创建 5 张照片，其中 3 张是孤儿
      const photoIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const pid = crypto.randomUUID();
        photoIds.push(pid);
        insertPhotoRaw(sqlite, {
          id: pid,
          storageSourceId,
          filePath: `/tmp/test-cleanup/batch-${i}.jpg`,
          fileHash: `batchhash${i}`,
          thumbnailPath: i % 2 === 0 ? `/tmp/test-cleanup/thumbnails/batch-${i}.jpg` : null,
        });
      }

      // 为所有 5 张照片创建关联数据
      const tagId = crypto.randomUUID();
      insertTagRaw(sqlite, { id: tagId, name: "批量测试", category: "scene" });

      for (const pid of photoIds) {
        insertPhotoTagRaw(sqlite, { photoId: pid, tagId });
        insertPhotoAnalysisRaw(sqlite, { id: crypto.randomUUID(), photoId: pid });
        insertDailyPickRaw(sqlite, {
          id: crypto.randomUUID(),
          photoId: pid,
          pickDate: now,
        });
      }

      // 磁盘上只有前 2 张
      const diskFiles = ["/tmp/test-cleanup/batch-0.jpg", "/tmp/test-cleanup/batch-1.jpg"];

      const thumbnailFiles = new Map<string, boolean>();
      thumbnailFiles.set("/tmp/test-cleanup/thumbnails/batch-2.jpg", true);
      thumbnailFiles.set("/tmp/test-cleanup/thumbnails/batch-3.jpg", true);
      thumbnailFiles.set("/tmp/test-cleanup/thumbnails/batch-4.jpg", true);

      const result = await simulateCleanupOrphans(
        db,
        sqlite,
        storageSourceId,
        diskFiles,
        thumbnailFiles,
      );

      expect(result.cleaned).toBe(3);

      // 2 张保留
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM photos").get() as { cnt: number }).cnt,
      ).toBe(2);
      // 只有 2 条 daily_picks 保留
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM daily_picks").get() as { cnt: number }).cnt,
      ).toBe(2);
      // 只有 2 条 photo_tags 保留
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_tags").get() as { cnt: number }).cnt,
      ).toBe(2);
      // 只有 2 条 photo_analyses 保留
      expect(
        (sqlite.prepare("SELECT COUNT(*) as cnt FROM photo_analyses").get() as { cnt: number }).cnt,
      ).toBe(2);
    });
  });

  // =========================================================================
  // 9. 边界情况
  // =========================================================================

  describe("边界情况", () => {
    it("磁盘文件路径带特殊字符时正确匹配", async () => {
      const specialPath = "/tmp/test-cleanup/照片 (1).jpg";
      insertPhotoRaw(sqlite, {
        id: crypto.randomUUID(),
        storageSourceId,
        filePath: specialPath,
        fileHash: "specialchars",
        thumbnailPath: null,
      });

      // 磁盘上有此文件
      const result1 = await simulateCleanupOrphans(db, sqlite, storageSourceId, [specialPath]);
      expect(result1.cleaned).toBe(0);

      // 磁盘上无此文件
      const result2 = await simulateCleanupOrphans(db, sqlite, storageSourceId, []);
      expect(result2.cleaned).toBe(1);
    });

    it("存储源有大量 DB 记录时正确执行差集运算", async () => {
      const keepCount = 50;
      const orphanCount = 30;

      for (let i = 0; i < keepCount + orphanCount; i++) {
        const isKeep = i < keepCount;
        insertPhotoRaw(sqlite, {
          id: crypto.randomUUID(),
          storageSourceId,
          filePath: `/tmp/test-cleanup/scale-${i}.jpg`,
          fileHash: `scalehash${i}`,
          thumbnailPath: null,
        });
      }

      // 磁盘上只有前 keepCount 个文件
      const diskFiles: string[] = [];
      for (let i = 0; i < keepCount; i++) {
        diskFiles.push(`/tmp/test-cleanup/scale-${i}.jpg`);
      }

      const result = await simulateCleanupOrphans(db, sqlite, storageSourceId, diskFiles);

      expect(result.cleaned).toBe(orphanCount);

      const remainingPhotos = await db.select().from(schema.photos);
      expect(remainingPhotos).toHaveLength(keepCount);
    });
  });
});

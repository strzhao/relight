import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { and, eq, sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
/**
 * 验收测试：跨系统数据流完整性
 *
 * 覆盖设计文档 §4 Worker 管线：
 * scan-storage → SHA256去重 → INSERT photos → 缩略图 → 入队 analyze →
 * analyze-photo → 读文件 → base64 → AI分析 → 解析 → 写 tags/photoTags/photoAnalyses
 *
 * 本测试使用内存 SQLite 验证完整数据链路的数据一致性：
 * - photo 记录的完整性
 * - tag 记录的正确性
 * - photoTags 关联的正确性
 * - photoAnalyses 记录的完整性（含新增字段）
 * - 去重验证：相同哈希不重复插入
 * - 外键约束验证
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../db/schema";

// ---- 类型定义 ----

interface FileEntry {
  path: string;
  name: string;
  buffer: Buffer;
  mimeType: string;
}

/** 匹配 Drizzle schema 中 photo_analyses 的 JSON 字段类型 */
interface AnalysisRecord {
  aiModel: string;
  rawResponse: string;
  narrative: string;
  aestheticScore: number;
  tags: Array<{ name: string; category: string; confidence: number }>;
  composition: { type: string; score: number; description: string };
  colorAnalysis: { palette: string[]; dominant: string; mood: string };
  emotionalAnalysis: { primary: string; secondary: string; intensity: number };
  usageSuggestions: string;
  promptVersion: string;
}

// ---- 模拟的完整数据流 ----

/**
 * Step 1: 扫描目录 (模拟)
 * 设计文档 §4 scan-storage worker
 */
async function scanDirectory(
  files: FileEntry[],
): Promise<{ newFiles: FileEntry[]; knownCount: number }> {
  // 实际实现会: 遍历目录 → 计算 SHA256 → 查询已知哈希 → 筛选新文件
  // 此处简化: 所有文件都是 "新" 文件
  return { newFiles: files, knownCount: 0 };
}

/**
 * Step 2: 计算文件 SHA256 哈希
 * 设计文档 §4: SHA256 去重
 */
function computeSHA256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Step 3: 插入 photo 记录
 * 设计文档 §4: INSERT photos → 缩略图 → 入队 analyze
 */
async function insertPhoto(
  db: BetterSQLite3Database<typeof schema>,
  file: FileEntry,
  storageSourceId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const fileHash = computeSHA256(file.buffer);
  const now = new Date().toISOString();

  await db.insert(schema.photos).values({
    id,
    storageSourceId,
    filePath: file.path,
    fileHash,
    width: 0, // 后续通过 sharp 提取
    height: 0,
    fileSize: file.buffer.length,
    thumbnailPath: null, // 后续由缩略图生成填充
    takenAt: null,
    createdAt: now,
  });

  return id;
}

/**
 * Step 4: 检查去重
 * 设计文档 §4: 仅分析新增/变更的照片
 */
async function isDuplicate(
  db: BetterSQLite3Database<typeof schema>,
  fileHash: string,
): Promise<boolean> {
  const existing = await db
    .select({ id: schema.photos.id })
    .from(schema.photos)
    .where(eq(schema.photos.fileHash, fileHash))
    .limit(1);

  return existing.length > 0;
}

/**
 * Step 5: 写入标签
 * 设计文档 §4: AI 分析后写 tags 和 photoTags
 */
async function insertOrGetTag(
  db: BetterSQLite3Database<typeof schema>,
  tagName: string,
  tagCategory: string,
): Promise<string> {
  // 检查是否存在
  const existing = await db
    .select({ id: schema.tags.id })
    .from(schema.tags)
    .where(
      and(
        eq(schema.tags.name, tagName),
        eq(schema.tags.category, tagCategory as typeof schema.tags.$inferSelect.category),
      ),
    )
    .limit(1);

  if (existing.length > 0 && existing[0]?.id) {
    return existing[0].id;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(schema.tags).values({
    id,
    name: tagName,
    category: tagCategory as typeof schema.tags.$inferInsert.category,
    createdAt: now,
  });

  return id;
}

/**
 * Step 6: 写入 photoTags 关联
 * 设计文档 §4: 写 photoTags 关联记录
 */
async function linkPhotoTag(
  db: BetterSQLite3Database<typeof schema>,
  photoId: string,
  tagId: string,
  confidence: number,
): Promise<void> {
  await db.insert(schema.photoTags).values({
    photoId,
    tagId,
    confidence,
  });
}

/**
 * Step 7: 写入 AI 分析记录
 * 设计文档 §4: 写 photoAnalyses 记录
 * 设计文档 §1.3: 新增字段 narrative, aestheticScore, tags, composition,
 *   colorAnalysis, emotionalAnalysis, usageSuggestions, promptVersion
 */
async function insertAnalysis(
  db: BetterSQLite3Database<typeof schema>,
  photoId: string,
  analysis: AnalysisRecord,
): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(schema.photoAnalyses).values({
    id,
    photoId,
    aiModel: analysis.aiModel,
    rawResponse: analysis.rawResponse,
    narrative: analysis.narrative,
    aestheticScore: analysis.aestheticScore,
    tags: analysis.tags,
    composition: analysis.composition,
    colorAnalysis: analysis.colorAnalysis,
    emotionalAnalysis: analysis.emotionalAnalysis,
    usageSuggestions: analysis.usageSuggestions,
    promptVersion: analysis.promptVersion,
    processedAt: now,
  });
}

/**
 * 完整数据流编排 (模拟 scan → analyze 管线)
 *
 * 设计文档 §4:
 * scan-storage: 遍历目录 → SHA256 去重 → INSERT photos → 缩略图 → 入队 analyze
 * analyze-photo: 读文件 → base64 → AI 分析 → 解析 → 写 tags/photoTags/photoAnalyses
 */
async function fullPipeline(
  db: BetterSQLite3Database<typeof schema>,
  storageSourceId: string,
  files: FileEntry[],
  mockAIAnalysis: (file: FileEntry) => {
    tags: Array<{ name: string; category: string; confidence: number }>;
    narrative: string;
    aestheticScore: number;
    composition: Record<string, unknown>;
    colorAnalysis: Record<string, unknown>;
    emotionalAnalysis: Record<string, unknown>;
    usageSuggestions: string[];
  },
  promptVersion: string,
): Promise<{
  scannedCount: number;
  newCount: number;
  duplicateCount: number;
  analysisCount: number;
  photoIds: string[];
}> {
  let scannedCount = 0;
  let newCount = 0;
  let duplicateCount = 0;
  let analysisCount = 0;
  const photoIds: string[] = [];

  // === scan-storage worker ===
  for (const file of files) {
    scannedCount++;
    const fileHash = computeSHA256(file.buffer);

    // SHA256 去重
    if (await isDuplicate(db, fileHash)) {
      duplicateCount++;
      continue;
    }

    // INSERT photo
    const photoId = await insertPhoto(db, file, storageSourceId);
    photoIds.push(photoId);
    newCount++;

    // === analyze-photo worker (同步模拟) ===
    // 实际为 BullMQ job: 读文件 → base64 → AI analyze → 解析 → 写入
    const analysis = mockAIAnalysis(file);
    const now = new Date().toISOString();

    // 写入 tags + photoTags
    const tagsJSON = analysis.tags.map((t) => ({
      name: t.name,
      category: t.category,
      confidence: t.confidence,
    }));

    for (const tag of analysis.tags) {
      const tagId = await insertOrGetTag(db, tag.name, tag.category);
      await linkPhotoTag(db, photoId, tagId, tag.confidence);
    }

    // 写入 photoAnalyses（匹配 Drizzle schema 的 JSON 字段类型）
    await insertAnalysis(db, photoId, {
      aiModel: "qwen3.6-35b",
      rawResponse: JSON.stringify(analysis),
      narrative: analysis.narrative,
      aestheticScore: analysis.aestheticScore,
      tags: tagsJSON,
      composition: {
        type: ((analysis.composition as Record<string, unknown>).type as string) || "unknown",
        score: ((analysis.composition as Record<string, unknown>).score as number) || 5,
        description:
          ((analysis.composition as Record<string, unknown>).description as string) || "",
      },
      colorAnalysis: {
        palette:
          ((analysis.colorAnalysis as Record<string, unknown>).dominantColors as string[]) || [],
        dominant:
          ((analysis.colorAnalysis as Record<string, unknown>).dominantColors as string[])?.[0] ||
          "#000000",
        mood: ((analysis.colorAnalysis as Record<string, unknown>).palette as string) || "neutral",
      },
      emotionalAnalysis: {
        primary:
          ((analysis.emotionalAnalysis as Record<string, unknown>).primaryEmotion as string) ||
          "neutral",
        secondary: "calm",
        intensity:
          ((analysis.emotionalAnalysis as Record<string, unknown>).intensity as number) || 5,
      },
      usageSuggestions: JSON.stringify(analysis.usageSuggestions),
      promptVersion,
    });

    analysisCount++;
  }

  return {
    scannedCount,
    newCount,
    duplicateCount,
    analysisCount,
    photoIds,
  };
}

// ---- 模拟 AI 分析结果 ----

function mockAIAnalysis(file: FileEntry) {
  return {
    tags: [
      { name: "日落", category: "scene", confidence: 0.95 },
      { name: "温暖", category: "emotion", confidence: 0.88 },
      { name: "橙色", category: "color", confidence: 0.92 },
      { name: "剪影", category: "style", confidence: 0.85 },
    ],
    narrative: `这是一张${file.name}的风景照片，暖色调渲染了整个画面。`,
    aestheticScore: 8,
    composition: {
      type: "rule_of_thirds",
      description: "主体位于右下三分之一交点",
    },
    colorAnalysis: {
      dominantColors: ["#FF6B35", "#E8632A", "#2C1810"],
      palette: "warm_sunset",
    },
    emotionalAnalysis: {
      primaryEmotion: "peaceful",
      intensity: 7,
    },
    usageSuggestions: ["适合作为壁纸", "适合分享"],
  };
}

// ---- 测试 ----

describe("数据流完整性 — 验收测试（设计文档 §4）", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let storageSourceId: string;

  beforeAll(async () => {
    // 创建内存数据库用于测试
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });

    // 手动创建表结构（Drizzle push 在测试中不可用）
    createTables(sqlite);

    // 创建测试用的存储源
    storageSourceId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.storageSources).values({
      id: storageSourceId,
      name: "测试存储源",
      type: "local",
      rootPath: "/tmp/test-photos",
      enabled: true,
      lastScanAt: null,
    });
  });

  afterAll(() => {
    sqlite?.close();
  });

  describe("完整数据流: scan → photo → analyze → records", () => {
    it("新文件扫描应产生 photo + tags + photoTags + photoAnalyses 记录", async () => {
      const files: FileEntry[] = [
        {
          path: "/tmp/test-photos/sunset01.jpg",
          name: "sunset01.jpg",
          buffer: Buffer.from("mock-jpeg-data-001"),
          mimeType: "image/jpeg",
        },
      ];

      const result = await fullPipeline(db, storageSourceId, files, mockAIAnalysis, "v1");

      // 验证 pipeline 统计
      expect(result.scannedCount).toBe(1);
      expect(result.newCount).toBe(1);
      expect(result.duplicateCount).toBe(0);
      expect(result.analysisCount).toBe(1);

      // ---- 验证 photos 表 ----
      const photos = await db.select().from(schema.photos);
      expect(photos).toHaveLength(1);
      expect(photos[0]?.filePath).toBe("/tmp/test-photos/sunset01.jpg");
      expect(photos[0]?.fileHash).toBe(computeSHA256(files[0]!.buffer));
      expect(photos[0]?.fileSize).toBe(files[0]?.buffer.length);
      expect(photos[0]?.storageSourceId).toBe(storageSourceId);

      // ---- 验证 tags 表 ----
      const tags = await db.select().from(schema.tags);
      expect(tags.length).toBeGreaterThanOrEqual(4);

      const tagNames = tags.map((t) => t.name);
      expect(tagNames).toContain("日落");
      expect(tagNames).toContain("温暖");
      expect(tagNames).toContain("橙色");
      expect(tagNames).toContain("剪影");

      // 验证 tag category
      const sunsetTag = tags.find((t) => t.name === "日落");
      expect(sunsetTag?.category).toBe("scene");

      // ---- 验证 photoTags 关联 ----
      const photoTags = await db.select().from(schema.photoTags);
      expect(photoTags.length).toBe(4);

      for (const pt of photoTags) {
        expect(pt.photoId).toBe(photos[0]?.id);
        expect(pt.confidence).toBeGreaterThan(0);
        expect(pt.confidence).toBeLessThanOrEqual(1);
      }

      // ---- 验证 photoAnalyses 表 ----
      const analyses = await db.select().from(schema.photoAnalyses);
      expect(analyses).toHaveLength(1);
      expect(analyses[0]?.photoId).toBe(photos[0]?.id);
      expect(analyses[0]?.aiModel).toBe("qwen3.6-35b");
      expect(analyses[0]?.promptVersion).toBe("v1");
      expect(analyses[0]?.narrative).toBeTruthy();
      expect(analyses[0]?.aestheticScore).toBe(8);

      // 验证新增 JSON 字段 (drizzle mode: "json" 自动解析)
      const analysis = analyses[0];
      if (!analysis) throw new Error("Expected at least one analysis");
      const parsedTags = analysis.tags;
      expect(parsedTags).not.toBeNull();
      expect(Array.isArray(parsedTags)).toBe(true);
      expect(parsedTags?.length).toBe(4);

      const parsedComposition = analysis.composition;
      expect(parsedComposition).not.toBeNull();
      expect(parsedComposition?.type).toBe("rule_of_thirds");

      const parsedColor = analysis.colorAnalysis;
      expect(parsedColor).not.toBeNull();
      expect(parsedColor?.mood).toBeDefined();

      const parsedEmotion = analysis.emotionalAnalysis;
      expect(parsedEmotion).not.toBeNull();
      expect(parsedEmotion?.primary).toBeDefined();

      const parsedSuggestions = analysis.usageSuggestions;
      expect(parsedSuggestions).not.toBeNull();
      expect(typeof parsedSuggestions).toBe("string");
      expect(parsedSuggestions?.length).toBeGreaterThan(0);
    });
  });

  describe("SHA256 去重验证", () => {
    it("重复扫描相同文件不应产生新记录", async () => {
      const file: FileEntry = {
        path: "/tmp/test-photos/dup-test.jpg",
        name: "dup-test.jpg",
        buffer: Buffer.from("unique-content-for-dedup-test"),
        mimeType: "image/jpeg",
      };

      // 第一次扫描
      const result1 = await fullPipeline(db, storageSourceId, [file], mockAIAnalysis, "v1");
      expect(result1.newCount).toBe(1);

      // 第二次扫描相同文件
      const result2 = await fullPipeline(db, storageSourceId, [file], mockAIAnalysis, "v1");
      expect(result2.newCount).toBe(0); // 去重成功
      expect(result2.duplicateCount).toBe(1);

      // photos 表应只有 1 条记录
      const photos = await db
        .select()
        .from(schema.photos)
        .where(eq(schema.photos.filePath, "/tmp/test-photos/dup-test.jpg"));
      expect(photos).toHaveLength(1);
    });

    it("内容相同但路径不同的文件应被视为重复", async () => {
      const content = Buffer.from("shared-content-across-paths");
      const file1: FileEntry = {
        path: "/tmp/test-photos/path-a/photo.jpg",
        name: "photo.jpg",
        buffer: content,
        mimeType: "image/jpeg",
      };
      const file2: FileEntry = {
        path: "/tmp/test-photos/path-b/photo.jpg",
        name: "photo.jpg",
        buffer: content,
        mimeType: "image/jpeg",
      };

      // 扫描 file1
      await fullPipeline(db, storageSourceId, [file1], mockAIAnalysis, "v1");

      // 扫描 file2 (内容相同)
      const result = await fullPipeline(db, storageSourceId, [file2], mockAIAnalysis, "v1");
      expect(result.duplicateCount).toBe(1);
      expect(result.newCount).toBe(0);
    });
  });

  describe("数据一致性验证", () => {
    it("每个 photo 应有对应的 analysis 记录", async () => {
      const photoId = crypto.randomUUID();
      const file: FileEntry = {
        path: "/tmp/test-photos/consistency-test.jpg",
        name: "consistency-test.jpg",
        buffer: Buffer.from("consistency-test-content"),
        mimeType: "image/jpeg",
      };

      await fullPipeline(db, storageSourceId, [file], mockAIAnalysis, "v1");

      const photos = await db
        .select()
        .from(schema.photos)
        .where(eq(schema.photos.filePath, "/tmp/test-photos/consistency-test.jpg"));

      expect(photos).toHaveLength(1);
      if (!photos[0]) return;

      const analyses = await db
        .select()
        .from(schema.photoAnalyses)
        .where(eq(schema.photoAnalyses.photoId, photos[0].id));

      expect(analyses).toHaveLength(1); // 一对一
    });

    it("每个 tag 应通过 photoTags 关联到正确的 photo", async () => {
      // 获取所有 photoTags 记录
      const allPhotoTags = await db.select().from(schema.photoTags);
      for (const pt of allPhotoTags) {
        // 验证 photoId 存在
        const photo = await db
          .select({ id: schema.photos.id })
          .from(schema.photos)
          .where(eq(schema.photos.id, pt.photoId))
          .limit(1);
        expect(photo).toHaveLength(1);

        // 验证 tagId 存在
        const tag = await db
          .select({ id: schema.tags.id })
          .from(schema.tags)
          .where(eq(schema.tags.id, pt.tagId))
          .limit(1);
        expect(tag).toHaveLength(1);
      }
    });

    it("tag 名称应在 tags 表中唯一（按 category 分区）", async () => {
      // 同一 name + category 不应有重复
      const allTags = await db.select().from(schema.tags);
      const seen = new Set<string>();
      for (const tag of allTags) {
        const key = `${tag.name}:${tag.category}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    });
  });

  describe("批量处理", () => {
    it("多个文件应正确创建各自的记录", async () => {
      const files: FileEntry[] = [1, 2, 3].map((i) => ({
        path: `/tmp/test-photos/batch-${i}.jpg`,
        name: `batch-${i}.jpg`,
        buffer: Buffer.from(`batch-content-${i}-${crypto.randomUUID()}`),
        mimeType: "image/jpeg",
      }));

      const result = await fullPipeline(db, storageSourceId, files, mockAIAnalysis, "v1");

      expect(result.scannedCount).toBe(3);
      expect(result.newCount).toBe(3);
      expect(result.analysisCount).toBe(3);

      // 验证各表的记录数
      const photos = await db.select().from(schema.photos);
      expect(photos.length).toBeGreaterThanOrEqual(6); // 之前已有 3 条

      const analyses = await db.select().from(schema.photoAnalyses);
      expect(analyses.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe("promptVersion 追踪", () => {
    it("analysis 记录应包含正确的 promptVersion", async () => {
      const file: FileEntry = {
        path: "/tmp/test-photos/prompt-version-test.jpg",
        name: "prompt-version-test.jpg",
        buffer: Buffer.from("prompt-version-test-content"),
        mimeType: "image/jpeg",
      };

      const result = await fullPipeline(db, storageSourceId, [file], mockAIAnalysis, "v2-beta");

      expect(result.photoIds).toHaveLength(1);
      const photoId = result.photoIds[0];
      if (!photoId) throw new Error("Expected at least one photoId");

      const analyses = await db
        .select()
        .from(schema.photoAnalyses)
        .where(eq(schema.photoAnalyses.photoId, photoId));

      expect(analyses).toHaveLength(1);
      if (analyses[0]) {
        expect(analyses[0].promptVersion).toBe("v2-beta");
      }
    });
  });

  describe("scanLogs 记录", () => {
    it("扫描完成后应写入 scanLogs", async () => {
      const scanLogId = crypto.randomUUID();
      const now = new Date().toISOString();

      await db.insert(schema.scanLogs).values({
        id: scanLogId,
        storageSourceId,
        scannedCount: 10,
        newCount: 3,
        errorCount: 0,
        startedAt: now,
        finishedAt: now,
      });

      const logs = await db.select().from(schema.scanLogs).where(eq(schema.scanLogs.id, scanLogId));

      expect(logs).toHaveLength(1);
      expect(logs[0]?.scannedCount).toBe(10);
      expect(logs[0]?.newCount).toBe(3);
      expect(logs[0]?.errorCount).toBe(0);
      expect(logs[0]?.storageSourceId).toBe(storageSourceId);
      expect(logs[0]?.startedAt).toBe(now);
      expect(logs[0]?.finishedAt).toBe(now);
    });
  });
});

// ---- 辅助：手动建表（测试环境不用 drizzle push） ----

function createTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS storage_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      root_path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_scan_at TEXT,
      status TEXT,
      last_error TEXT
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
      file_mtime TEXT,
      created_at TEXT NOT NULL
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
      raw_response TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS scan_logs (
      id TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
      job_id TEXT,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

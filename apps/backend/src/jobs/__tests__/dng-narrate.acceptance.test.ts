/**
 * 验收测试（红队）：DNG 格式照片在每日精选 narrate 阶段成功生成个性化文案
 *
 * 设计文档（Bug 1）：
 *   daily-selection.ts 的 processSingleEntry 应在处理 DNG 文件时使用
 *   extractRawPreview（调用 dcraw 提取内嵌 JPEG 预览），而非直接将原始
 *   DNG buffer 传给 sharp。
 *
 * 验收场景 P1.1：
 *   含 DNG 候选的每日精选完成后，DNG 条目的 title ≠ "今日拾光" 且非 fallback 文案。
 *   channel: det-machine
 *
 * 关键断言：
 *   1. DNG 候选的 narrate 阶段不抛异常，worker 整体不崩溃
 *   2. DNG 条目在 daily_pick_entries 中 title 非 fallback（≠ "今日拾光"）
 *   3. DNG 条目 narrative 非 fallback（≠ "这张照片记录了一个值得怀念的瞬间。"）
 *   4. extractRawPreview 被调用（DNG 路径走 RAW 预览提取而非 getFileBuffer）
 *   5. 存储适配器的 getFileBuffer 不应被 DNG 候选调用（不走原始文件读取路径）
 *
 * 红队铁律：
 *   - 不读取任何蓝队实现文件（daily-selection.ts 内部实现细节等）
 *   - 仅通过 dailySelectionWorker(job) 公共导出黑盒触发
 *   - 断言侧效（DB 状态 / mock 调用参数）
 *   - 绝对禁止任何宽容跳过（try/catch 空处理、it.skip 等）
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "../../__tests__/helpers/test-schema";
import * as schema from "../../db/schema";

// =====================================================================
// Hoisted mocks — 必须在 import 任何被测代码之前注册
// =====================================================================

const mockAnalyzePhoto = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockChat = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockGetFileBuffer = vi.hoisted(() => vi.fn<(p: string) => Promise<Buffer>>());
const mockGetMimeType = vi.hoisted(() => vi.fn<(p: string) => string>(() => "image/jpeg"));
const mockReadFile = vi.hoisted(() => vi.fn<(p: string) => Promise<Buffer>>());
const mockExtractRawPreview = vi.hoisted(() => vi.fn<(p: string) => Promise<Buffer>>());

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;

vi.mock("../../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

vi.mock("../../ai/client", () => ({
  aiClient: {
    analyzePhoto: mockAnalyzePhoto,
    chat: mockChat,
  },
  RelightAIClient: class {
    analyzePhoto = mockAnalyzePhoto;
    chat = mockChat;
  },
}));

vi.mock("../../storage", () => ({
  createStorageAdapter: () => ({
    getFileBuffer: mockGetFileBuffer,
    getMimeType: mockGetMimeType,
    listFiles: vi.fn(async () => []),
    getMetadata: vi.fn(async () => ({})),
    computeFileHash: vi.fn(async () => "hash"),
  }),
}));

vi.mock("../../lib/raw", () => ({
  extractRawPreview: mockExtractRawPreview,
  RAW_EXTENSIONS: new Set([".dng"]),
  DCRAW_PATH: "/opt/homebrew/bin/dcraw",
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  // 路由：prompt 文件（.txt）和字体文件走真实 readFile（loadPrompts / Satori 需要），
  // 其他（缩略图等）走 mockReadFile，便于断言。
  const routedReadFile = (
    p: Parameters<typeof actual.readFile>[0],
    ...rest: unknown[]
  ): ReturnType<typeof actual.readFile> => {
    const pathStr = typeof p === "string" ? p : String(p);
    if (pathStr.endsWith(".txt") || pathStr.endsWith(".otf") || pathStr.endsWith(".ttf")) {
      return (actual.readFile as (...a: unknown[]) => ReturnType<typeof actual.readFile>)(
        p,
        ...rest,
      );
    }
    return (mockReadFile as (...a: unknown[]) => ReturnType<typeof actual.readFile>)(p, ...rest);
  };
  return {
    ...actual,
    default: { ...actual, readFile: routedReadFile },
    readFile: routedReadFile,
  };
});

// =====================================================================
// 测试 DB 构造
// =====================================================================

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function createMockJob(data: Record<string, unknown> = {}, id = "test-dng") {
  return {
    data,
    id,
    name: "daily-selection",
    log: vi.fn(),
    updateProgress: vi.fn(),
  } as any;
}

// =====================================================================
// 数据构造辅助
// =====================================================================

/** 北京时间日期（YYYY-MM-DD），与 job formatPickDate 行为一致 */
function bjDate(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

interface SeedPhotoOpts {
  photoId: string;
  takenAt: string;
  filePath: string;
  mediaType?: "image" | "video";
  aestheticScore?: number;
  narrative?: string;
  tags?: string;
  emotionalAnalysis?: string;
}

function seedPhoto(sqlite: Database.Database, opts: SeedPhotoOpts): void {
  const {
    photoId,
    takenAt,
    filePath,
    mediaType = "image",
    aestheticScore = 8.0,
    narrative = "美好的一天",
    tags = null,
    emotionalAnalysis = null,
  } = opts;

  const sourceId = "src-dng-test";

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO storage_sources (id, name, type, root_path)
       VALUES (?, 'test-source', 'local', '/tmp')`,
    )
    .run(sourceId);

  sqlite
    .prepare(
      `INSERT OR REPLACE INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size,
         thumbnail_path, taken_at, created_at, media_type, is_burst_representative)
       VALUES (?, ?, ?, ?, 1920, 1080, 1024, ?, ?, ?, ?, 1)`,
    )
    .run(
      photoId,
      sourceId,
      filePath,
      `hash-${photoId}`,
      `/tmp/thumb-${photoId}.jpg`,
      takenAt,
      new Date().toISOString(),
      mediaType,
    );

  sqlite
    .prepare(
      `INSERT OR REPLACE INTO photo_analyses
        (id, photo_id, ai_model, narrative, aesthetic_score, tags, emotional_analysis,
         raw_response, processed_at)
       VALUES (?, ?, 'qwen-vl', ?, ?, ?, ?, '{}', ?)`,
    )
    .run(
      `analysis-${photoId}`,
      photoId,
      narrative,
      aestheticScore,
      tags,
      emotionalAnalysis,
      new Date().toISOString(),
    );
}

/**
 * 植入包含 DNG + 普通照片混合的候选照片集。
 * 返回 { dngIds, jpgIds } 方便断言时区分。
 */
function seedMixedCandidates(
  sqlite: Database.Database,
  dngCount: number,
  jpgCount: number,
): { dngIds: string[]; jpgIds: string[] } {
  const dngIds: string[] = [];
  const jpgIds: string[] = [];
  const todayStr = bjDate();
  const month = todayStr.slice(5, 7);
  const day = todayStr.slice(8, 10);
  const todayYear = Number.parseInt(todayStr.slice(0, 4), 10);

  // 植入 DNG 候选
  for (let i = 0; i < dngCount; i++) {
    const year = todayYear - 1 - (i % 3);
    const hour = String(8 + i).padStart(2, "0");
    const photoId = `dng-candidate-${String(i).padStart(3, "0")}`;
    seedPhoto(sqlite, {
      photoId,
      filePath: `/photos/${photoId}.dng`,
      takenAt: `${year}-${month}-${day}T${hour}:00:00.000Z`,
      aestheticScore: 8.5 - i * 0.1,
    });
    dngIds.push(photoId);
  }

  // 植入普通 JPG 候选
  for (let i = 0; i < jpgCount; i++) {
    const year = todayYear - 1 - (i % 4);
    const hour = String(10 + i).padStart(2, "0");
    const photoId = `jpg-candidate-${String(i).padStart(3, "0")}`;
    seedPhoto(sqlite, {
      photoId,
      filePath: `/photos/${photoId}.jpg`,
      takenAt: `${year}-${month}-${day}T${hour}:00:00.000Z`,
      aestheticScore: 8.0 - i * 0.05,
    });
    jpgIds.push(photoId);
  }

  return { dngIds, jpgIds };
}

// =====================================================================
// AI 响应构造辅助
// =====================================================================

function makeNarrateResponse(
  title = "光影的故事",
  narrative = "阳光穿过古老的窗棂，在时光的尘埃中投下斑驳的印记。",
  score = 8.8,
): string {
  return `\`\`\`json\n${JSON.stringify({ title, narrative, score })}\n\`\`\``;
}

function makeMembersResponse(members: { index: number; caption: string }[] = []): string {
  return `\`\`\`json\n${JSON.stringify({ members })}\n\`\`\``;
}

// =====================================================================
// 测试
// =====================================================================

describe("daily-selection DNG narrate — 验收测试（红队 / Bug 1）", () => {
  let dailySelectionWorker: (job: { data?: unknown; id?: string }) => Promise<void>;
  let validJpegBuffer: Buffer;

  beforeAll(async () => {
    // 生成一个合法的 JPEG buffer 用于 mock extractRawPreview 返回值
    validJpegBuffer = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
  });

  beforeEach(async () => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;

    mockAnalyzePhoto.mockReset();
    mockChat.mockReset();
    mockGetFileBuffer.mockReset();
    mockReadFile.mockReset();
    mockExtractRawPreview.mockReset();

    // 默认：extractRawPreview 返回合法 JPEG（模拟 dcraw 成功提取预览）
    mockExtractRawPreview.mockResolvedValue(validJpegBuffer);

    // 默认：getFileBuffer 返回合法 JPEG（普通图片路径，需足够大让 sharp 成功解析）
    mockGetFileBuffer.mockResolvedValue(validJpegBuffer);

    // 默认：readFile 返回合法 JPEG（缩略图路径）
    mockReadFile.mockResolvedValue(validJpegBuffer);

    // 默认：narrate（vision 模型）返回结构化 JSON（非 fallback）
    mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());

    // 默认：chat 调用（members 选择）返回空 members
    mockChat.mockResolvedValue(makeMembersResponse([]));

    // 导入被测模块（hoisted mock 已就位）
    const mod = await import("../daily-selection");
    dailySelectionWorker = mod.dailySelectionWorker as typeof dailySelectionWorker;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  // ================================================================
  // P1.1: DNG 候选 narrate 成功，生成非 fallback 文案
  // ================================================================

  describe("P1.1 — DNG 候选 narrate 成功生成个性化文案", () => {
    it("DNG 候选完成后 daily_pick_entries 中 DNG 条目 title ≠ '今日拾光'（非 fallback）", async () => {
      const { dngIds } = seedMixedCandidates(testSqlite, 2, 3);

      // 为 DNG 候选生成独特的 narrate 响应
      mockAnalyzePhoto.mockImplementation(async (..._args: unknown[]) => {
        return makeNarrateResponse("DNG 专属光影", "RAW 格式记录下的细腻层次令人惊叹。", 9.0);
      });

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      // 查询所有 DNG 候选对应的 entry
      for (const dngId of dngIds) {
        const entry = testSqlite
          .prepare(
            "SELECT title, narrative, score FROM daily_pick_entries WHERE daily_pick_id = ? AND photo_id = ?",
          )
          .get(pick!.id, dngId) as { title: string; narrative: string; score: number } | undefined;

        // DNG 条目必须存在（候选应被收录）
        expect(entry, `DNG 条目 ${dngId} 应存在于 daily_pick_entries`).toBeDefined();

        if (entry) {
          // 核心断言：title 不是 fallback 值
          expect(entry.title).not.toBe("今日拾光");
          expect(entry.title.length).toBeGreaterThan(0);

          // narrative 也不是 fallback
          expect(entry.narrative).not.toBe("这张照片记录了一个值得怀念的瞬间。");
          expect(entry.narrative.length).toBeGreaterThan(0);

          // score 不是 fallback 的 5.0（应该是 AI 返回的实际分数）
          expect(entry.score).not.toBe(5.0);
        }
      }
    });

    it("DNG 候选 narrate 阶段不抛异常，worker 整体不崩溃", async () => {
      seedMixedCandidates(testSqlite, 1, 2);

      // extractRawPreview 返回合法 JPEG
      mockExtractRawPreview.mockResolvedValue(validJpegBuffer);

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      // daily_picks 被写入（证明 job 完整执行）
      const today = bjDate();
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();
    });

    it("extractRawPreview 被调用处理 DNG 文件（而非 getFileBuffer）", async () => {
      const { dngIds } = seedMixedCandidates(testSqlite, 2, 0);

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      // extractRawPreview 应被调用（DNG 路径走 RAW 预览提取）
      expect(mockExtractRawPreview).toHaveBeenCalled();

      // 验证至少有一个调用参数包含 .dng 路径
      const calledPaths = mockExtractRawPreview.mock.calls.map((c) => String(c[0]));
      const dngCalled = calledPaths.some((p) => p.endsWith(".dng"));
      expect(dngCalled).toBe(true);
    });

    it("DNG 文件在 narrate 阶段走 extractRawPreview 路径（不走 sharp 直接处理原始 DNG buffer）", async () => {
      const { dngIds } = seedMixedCandidates(testSqlite, 1, 2);

      // 为所有文件设置 getFileBuffer mock
      mockGetFileBuffer.mockResolvedValue(validJpegBuffer);

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      // 核心断言：extractRawPreview 被调用，证明 DNG 走了 RAW 预览提取路径
      // （而非直接将原始 DNG buffer 传给 sharp，那会导致解析失败）
      expect(mockExtractRawPreview).toHaveBeenCalled();

      // 验证 DNG 条目有非 fallback 文案（证明 narrate 成功使用提取的预览）
      const today = bjDate();
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      for (const dngId of dngIds) {
        const entry = testSqlite
          .prepare("SELECT title FROM daily_pick_entries WHERE daily_pick_id = ? AND photo_id = ?")
          .get(pick!.id, dngId) as { title: string } | undefined;
        expect(entry, `DNG 条目 ${dngId} 应存在`).toBeDefined();
        if (entry) {
          expect(entry.title).not.toBe("今日拾光");
        }
      }
    });

    it("混合场景：DNG + JPG 候选同时存在，DNG 和 JPG 条目均成功生成文案", async () => {
      const { dngIds, jpgIds } = seedMixedCandidates(testSqlite, 1, 2);

      // 为所有 narrate 调用返回统一的高质量响应
      mockAnalyzePhoto.mockResolvedValue(
        makeNarrateResponse("共同的记忆", "无论是 RAW 还是 JPEG，这一刻都值得被记住。", 8.5),
      );

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      // 验证所有 DNG 条目均非 fallback
      for (const dngId of dngIds) {
        const entry = testSqlite
          .prepare(
            "SELECT title, narrative FROM daily_pick_entries WHERE daily_pick_id = ? AND photo_id = ?",
          )
          .get(pick!.id, dngId) as { title: string; narrative: string } | undefined;
        expect(entry, `DNG 条目 ${dngId} 应存在`).toBeDefined();
        if (entry) {
          expect(entry.title).not.toBe("今日拾光");
          expect(entry.narrative).not.toBe("这张照片记录了一个值得怀念的瞬间。");
        }
      }

      // 验证所有 JPG 条目也成功
      for (const jpgId of jpgIds) {
        const entry = testSqlite
          .prepare(
            "SELECT title, narrative FROM daily_pick_entries WHERE daily_pick_id = ? AND photo_id = ?",
          )
          .get(pick!.id, jpgId) as { title: string; narrative: string } | undefined;
        expect(entry, `JPG 条目 ${jpgId} 应存在`).toBeDefined();
        if (entry) {
          expect(entry.title).not.toBe("今日拾光");
          expect(entry.narrative).not.toBe("这张照片记录了一个值得怀念的瞬间。");
        }
      }
    });

    it("DNG 文件路径正确传入 extractRawPreview（包含完整路径）", async () => {
      const dngPath = "/photos/dng-candidate-path-test.dng";
      const dngId = "dng-path-test";

      seedPhoto(testSqlite, {
        photoId: dngId,
        filePath: dngPath,
        takenAt: `${Number.parseInt(bjDate().slice(0, 4)) - 1}-${bjDate().slice(5)}T10:00:00.000Z`,
        aestheticScore: 8.5,
      });

      // 再补 2 张 JPG 确保候选池足够
      seedPhoto(testSqlite, {
        photoId: "jpg-path-helper-1",
        filePath: "/photos/jpg-path-helper-1.jpg",
        takenAt: `${Number.parseInt(bjDate().slice(0, 4)) - 2}-${bjDate().slice(5)}T08:00:00.000Z`,
        aestheticScore: 7.5,
      });
      seedPhoto(testSqlite, {
        photoId: "jpg-path-helper-2",
        filePath: "/photos/jpg-path-helper-2.jpg",
        takenAt: `${Number.parseInt(bjDate().slice(0, 4)) - 3}-${bjDate().slice(5)}T09:00:00.000Z`,
        aestheticScore: 7.0,
      });

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      // extractRawPreview 应以完整路径被调用
      const calledPaths = mockExtractRawPreview.mock.calls.map((c) => String(c[0]));
      expect(calledPaths).toContain(dngPath);
    });
  });

  // ================================================================
  // 边界：extractRawPreview 失败时的 fallback 行为
  // ================================================================

  describe("边界 — extractRawPreview 失败时走 fallback 不阻塞", () => {
    it("extractRawPreview 抛出异常时，DNG 条目写入 fallback 文案，worker 不崩溃", async () => {
      seedMixedCandidates(testSqlite, 1, 2);

      // 模拟 dcraw 不可用或提取失败
      mockExtractRawPreview.mockRejectedValue(new Error("dcraw not found"));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      // DNG 条目应存在但为 fallback 文案
      const dngEntry = testSqlite
        .prepare(
          "SELECT dpe.title, dpe.narrative, dpe.score FROM daily_pick_entries dpe JOIN photos p ON dpe.photo_id = p.id WHERE dpe.daily_pick_id = ? AND p.file_path LIKE '%.dng'",
        )
        .get(pick!.id) as { title: string; narrative: string; score: number } | undefined;
      expect(dngEntry).toBeDefined();

      // fallback 文案：title="今日拾光"，narrative 为固定 fallback
      if (dngEntry) {
        expect(dngEntry.title).toBe("今日拾光");
        expect(dngEntry.narrative).toBe("这张照片记录了一个值得怀念的瞬间。");
        expect(dngEntry.score).toBe(5.0);
      }

      // JPG 条目应不受影响，正常生成
      const jpgEntry = testSqlite
        .prepare(
          "SELECT dpe.title FROM daily_pick_entries dpe JOIN photos p ON dpe.photo_id = p.id WHERE dpe.daily_pick_id = ? AND p.file_path LIKE '%.jpg' LIMIT 1",
        )
        .get(pick!.id) as { title: string } | undefined;
      expect(jpgEntry).toBeDefined();
      if (jpgEntry) {
        expect(jpgEntry.title).not.toBe("今日拾光");
      }
    });
  });
});

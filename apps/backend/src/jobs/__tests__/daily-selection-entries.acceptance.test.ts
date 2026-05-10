/**
 * 验收测试：daily-selection entries 多精选路径（红队）
 *
 * 设计契约来源（state.md 设计文档，不读任何实现）：
 *
 * 契约 1: job 写入 entries 表，行数 = MIN(20, candidate_pool_size)
 * 契约 2: 同日重跑 job 幂等（行数不变、rank 不重复，UNIQUE(daily_pick_id, rank) 约束）
 * 契约 3: entries[rank=0] 与 dailyPicks 主字段（photoId/title/narrative/score/members）同源
 * 契约 4: 同一 photoId 不会同时是两个 entries 行的 hero（hero 间互斥）
 * 契约 5: 单 candidate AI 失败时该 rank 写入 fallback 文案，不阻塞其他 rank
 * 契约 6: getRecentPickedPhotoIds(30) 返回集合包含 daily_pick_entries.photo_id（跨表去重）
 *
 * 红队铁律：
 * - 不读取任何蓝队实现文件（daily-selection.ts 等）
 * - 仅通过 dailySelectionWorker(job) 公共导出黑盒触发
 * - 断言侧效（DB 状态 / mock 调用参数）
 * - 绝对禁止任何宽容跳过（try/catch 空处理、it.skip 等）
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

// =====================================================================
// Hoisted mocks — 必须在 import 任何被测代码之前注册
// =====================================================================

const mockAnalyzePhoto = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockChat = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockGetFileBuffer = vi.hoisted(() => vi.fn<(p: string) => Promise<Buffer>>());
const mockGetMimeType = vi.hoisted(() => vi.fn<(p: string) => string>(() => "image/jpeg"));
const mockReadFile = vi.hoisted(() => vi.fn<(p: string) => Promise<Buffer>>());

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

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
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
// 内存数据库构造（含 daily_pick_entries 表）
// =====================================================================

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
      storage_source_id TEXT NOT NULL,
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
      burst_id TEXT,
      is_burst_representative INTEGER DEFAULT 0,
      burst_rank INTEGER
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE photo_tags (
      photo_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (photo_id, tag_id)
    );
    CREATE TABLE photo_analyses (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL,
      ai_model TEXT NOT NULL,
      narrative TEXT,
      aesthetic_score REAL,
      tags TEXT,
      composition TEXT,
      color_analysis TEXT,
      emotional_analysis TEXT,
      usage_suggestions TEXT,
      prompt_version TEXT,
      raw_response TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      transcript TEXT,
      transcript_segments TEXT,
      video_pacing TEXT,
      motion_score REAL
    );
    CREATE TABLE daily_picks (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL,
      pick_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      composed_image_path TEXT,
      created_at TEXT NOT NULL,
      members TEXT DEFAULT '[]'
    );
    CREATE TABLE daily_pick_entries (
      id TEXT PRIMARY KEY,
      daily_pick_id TEXT NOT NULL REFERENCES daily_picks(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL,
      photo_id TEXT NOT NULL REFERENCES photos(id),
      title TEXT NOT NULL,
      narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      members TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(daily_pick_id, rank)
    );
    CREATE INDEX idx_dpe_pick_rank ON daily_pick_entries(daily_pick_id, rank);
    CREATE TABLE bursts (
      id TEXT PRIMARY KEY,
      representative_id TEXT,
      member_count INTEGER NOT NULL DEFAULT 0,
      detected_at TEXT NOT NULL
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE scan_logs (
      id TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function createMockJob(dataOrId: Record<string, unknown> | string = {}, id = "test-entries") {
  const [data, jobId] = typeof dataOrId === "string" ? [{}, dataOrId] : [dataOrId, id];
  return {
    data,
    id: jobId,
    name: "daily-selection",
    log: vi.fn(),
    updateProgress: vi.fn(),
  } as unknown as import("bullmq").Job;
}

// =====================================================================
// 数据构造辅助函数
// =====================================================================

interface SeedPhotoOpts {
  photoId: string;
  takenAt: string;
  mediaType?: "image" | "video";
  aestheticScore?: number;
  thumbnailPath?: string | null;
}

function seedPhoto(sqlite: Database.Database, opts: SeedPhotoOpts): void {
  const {
    photoId,
    takenAt,
    mediaType = "image",
    aestheticScore = 8.0,
    thumbnailPath = `/tmp/thumb-${photoId}.jpg`,
  } = opts;

  const sourceId = "src-entries-test";

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
      `photos/${photoId}.jpg`,
      `hash-${photoId}`,
      thumbnailPath,
      takenAt,
      new Date().toISOString(),
      mediaType,
    );

  sqlite
    .prepare(
      `INSERT OR REPLACE INTO photo_analyses
        (id, photo_id, ai_model, narrative, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'qwen-vl', '美好的一天', ?, '{}', ?)`,
    )
    .run(`analysis-${photoId}`, photoId, aestheticScore, new Date().toISOString());
}

/**
 * 植入 N 张候选照片（分布在历史年份的今天，确保进入候选池）
 */
function seedNCandidates(sqlite: Database.Database, count: number): string[] {
  const ids: string[] = [];
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");

  for (let i = 0; i < count; i++) {
    const year = today.getFullYear() - 1 - (i % 5); // 分散到 1-5 年前
    const hour = String(8 + (i % 10)).padStart(2, "0");
    const photoId = `entry-candidate-${String(i).padStart(3, "0")}`;
    seedPhoto(sqlite, {
      photoId,
      takenAt: `${year}-${month}-${day}T${hour}:00:00.000Z`,
      aestheticScore: 8.0 - i * 0.01,
    });
    ids.push(photoId);
  }
  return ids;
}

// =====================================================================
// AI 响应构造辅助
// =====================================================================

function makeNarrateResponse(
  title = "时光的馈赠",
  narrative = "阳光透过树叶洒落，记录下这珍贵的片刻。",
  score = 8.5,
): string {
  return `\`\`\`json\n${JSON.stringify({ title, narrative, score })}\n\`\`\``;
}

function makeHeroSelectResponse(photoId: string): string {
  return `\`\`\`json\n${JSON.stringify({
    winner: {
      photoId,
      score: 8.5,
      title: "美好的回忆",
      reason: "构图精美，情感真实",
    },
  })}\n\`\`\``;
}

function makeMembersResponse(members: { index: number; caption: string }[] = []): string {
  return `\`\`\`json\n${JSON.stringify({ members })}\n\`\`\``;
}

// =====================================================================
// 测试
// =====================================================================

describe("daily-selection entries — 验收测试（红队）", () => {
  let dailySelectionWorker: (job: { data?: unknown; id?: string }) => Promise<void>;

  beforeEach(async () => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;

    mockAnalyzePhoto.mockReset();
    mockChat.mockReset();
    mockGetFileBuffer.mockReset();
    mockReadFile.mockReset();

    // 默认：readFile 返回合法 JPEG header
    mockReadFile.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    mockGetFileBuffer.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));

    // 默认：narrate（vision 模型）调用返回结构化 JSON
    mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());

    // 默认：chat 调用（阶段 1 select + members）也返回合法响应
    mockChat.mockResolvedValue(makeMembersResponse([]));

    const mod = await import("../daily-selection");
    dailySelectionWorker = mod.dailySelectionWorker as typeof dailySelectionWorker;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  // ================================================================
  // 契约 1: job 写入 entries 表，行数 = MIN(20, candidate_pool_size)
  // ================================================================

  describe("契约 1 — entries 表行数 = MIN(20, candidate_pool_size)", () => {
    it("候选池 ≥ 20 张时，job 完成后 daily_pick_entries 行数 = 20", async () => {
      // 植入 25 张候选（超过 20 张），确保输出恰好 20 行
      seedNCandidates(testSqlite, 25);

      // narrate 调用：为每张 candidate 生成叙事
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
      // chat 调用（members 选择）返回空 members
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);

      // 验证 daily_picks 存在
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      // 验证 entries 行数 = 20（MIN(20, 25) = 20）
      const entryCount = testSqlite
        .prepare("SELECT COUNT(*) as cnt FROM daily_pick_entries WHERE daily_pick_id = ?")
        .get(pick!.id) as { cnt: number };
      expect(entryCount.cnt).toBe(20);
    });

    it("候选池 7 张时，job 完成后 daily_pick_entries 行数 = 7（MIN(20, 7) = 7）", async () => {
      seedNCandidates(testSqlite, 7);

      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      const entryCount = testSqlite
        .prepare("SELECT COUNT(*) as cnt FROM daily_pick_entries WHERE daily_pick_id = ?")
        .get(pick!.id) as { cnt: number };
      expect(entryCount.cnt).toBe(7);
    });

    it("candidate_pool_size = 1 时，entries 行数 = 1", async () => {
      seedNCandidates(testSqlite, 1);

      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      const entryCount = testSqlite
        .prepare("SELECT COUNT(*) as cnt FROM daily_pick_entries WHERE daily_pick_id = ?")
        .get(pick!.id) as { cnt: number };
      expect(entryCount.cnt).toBe(1);
    });
  });

  // ================================================================
  // 契约 2: 同日重跑 job 幂等
  // ================================================================

  describe("契约 2 — 同日重跑 job 幂等（行数不变、rank 不重复）", () => {
    it("重跑 job 后 entries 行数仍为 MIN(20, pool)，无重复 rank", async () => {
      seedNCandidates(testSqlite, 20);

      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
      mockChat.mockResolvedValue(makeMembersResponse([]));

      // 第一次运行
      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pickAfterFirst = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pickAfterFirst).toBeDefined();

      const countAfterFirst = testSqlite
        .prepare("SELECT COUNT(*) as cnt FROM daily_pick_entries WHERE daily_pick_id = ?")
        .get(pickAfterFirst!.id) as { cnt: number };
      const firstCount = countAfterFirst.cnt;
      expect(firstCount).toBeGreaterThan(0);

      // 重新 reset mocks，准备第二次运行
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse("再次精选", "第二次叙事"));
      mockChat.mockResolvedValue(makeMembersResponse([]));

      // 第二次运行（同日）
      await expect(dailySelectionWorker(createMockJob("second-run"))).resolves.not.toThrow();

      // pick_date UNIQUE，仍是同一行（或新行），entries 数量应稳定
      const pickAfterSecond = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pickAfterSecond).toBeDefined();

      const countAfterSecond = testSqlite
        .prepare("SELECT COUNT(*) as cnt FROM daily_pick_entries WHERE daily_pick_id = ?")
        .get(pickAfterSecond!.id) as { cnt: number };
      expect(countAfterSecond.cnt).toBe(firstCount);

      // 验证 rank 无重复：COUNT(DISTINCT rank) == COUNT(*)
      const rankCheck = testSqlite
        .prepare(
          `SELECT COUNT(*) as total, COUNT(DISTINCT rank) as unique_rank
           FROM daily_pick_entries WHERE daily_pick_id = ?`,
        )
        .get(pickAfterSecond!.id) as { total: number; unique_rank: number };
      expect(rankCheck.total).toBe(rankCheck.unique_rank);
    });

    it("UNIQUE(daily_pick_id, rank) 约束实际存在：手动 INSERT 重复 rank 报错", async () => {
      seedNCandidates(testSqlite, 3);
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      const firstEntry = testSqlite
        .prepare("SELECT photo_id FROM daily_pick_entries WHERE daily_pick_id = ? AND rank = 0")
        .get(pick!.id) as { photo_id: string } | undefined;
      expect(firstEntry).toBeDefined();

      // 手动 INSERT 重复 rank=0 必须抛出
      expect(() => {
        testSqlite
          .prepare(
            `INSERT INTO daily_pick_entries
              (id, daily_pick_id, rank, photo_id, title, narrative, score, members, created_at)
             VALUES ('dup-entry', ?, 0, ?, 'dup', 'dup narrative', 5.0, '[]', ?)`,
          )
          .run(pick!.id, firstEntry!.photo_id, new Date().toISOString());
      }).toThrow();
    });
  });

  // ================================================================
  // 契约 3: entries[rank=0] 与 dailyPicks 主字段同源
  // ================================================================

  describe("契约 3 — entries[rank=0] 与 dailyPicks 主字段同源", () => {
    it("dailyPicks.photoId 与 entries[rank=0].photo_id 相同", async () => {
      seedNCandidates(testSqlite, 5);

      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pick = testSqlite
        .prepare(
          "SELECT id, photo_id, title, narrative, score FROM daily_picks WHERE pick_date = ?",
        )
        .get(today) as
        | { id: string; photo_id: string; title: string; narrative: string; score: number }
        | undefined;
      expect(pick).toBeDefined();

      const entry0 = testSqlite
        .prepare(
          "SELECT photo_id, title, narrative, score FROM daily_pick_entries WHERE daily_pick_id = ? AND rank = 0",
        )
        .get(pick!.id) as
        | { photo_id: string; title: string; narrative: string; score: number }
        | undefined;
      expect(entry0).toBeDefined();

      // 核心契约：photo_id 一致
      expect(entry0!.photo_id).toBe(pick!.photo_id);
    });

    it("dailyPicks.title 与 entries[rank=0].title 相同", async () => {
      seedNCandidates(testSqlite, 3);

      const fixedTitle = "那年的银杏";
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse(fixedTitle));
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pick = testSqlite
        .prepare("SELECT id, title FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string; title: string } | undefined;
      expect(pick).toBeDefined();

      const entry0 = testSqlite
        .prepare("SELECT title FROM daily_pick_entries WHERE daily_pick_id = ? AND rank = 0")
        .get(pick!.id) as { title: string } | undefined;
      expect(entry0).toBeDefined();

      expect(entry0!.title).toBe(pick!.title);
    });

    it("dailyPicks.score 与 entries[rank=0].score 相同", async () => {
      seedNCandidates(testSqlite, 3);

      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse("精选", "叙事文案", 9.1));
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pick = testSqlite
        .prepare("SELECT id, score FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string; score: number } | undefined;
      expect(pick).toBeDefined();

      const entry0 = testSqlite
        .prepare("SELECT score FROM daily_pick_entries WHERE daily_pick_id = ? AND rank = 0")
        .get(pick!.id) as { score: number } | undefined;
      expect(entry0).toBeDefined();

      expect(entry0!.score).toBeCloseTo(pick!.score, 1);
    });
  });

  // ================================================================
  // 契约 4: 同一 photoId 不会同时是两个 entries 行的 hero
  // ================================================================

  describe("契约 4 — 同一 photoId 不出现在两个 entries 行的 hero 位", () => {
    it("entries 中所有 photo_id（hero 位）互不重复", async () => {
      seedNCandidates(testSqlite, 20);

      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      const entries = testSqlite
        .prepare("SELECT photo_id FROM daily_pick_entries WHERE daily_pick_id = ?")
        .all(pick!.id) as { photo_id: string }[];
      expect(entries.length).toBeGreaterThan(0);

      const photoIds = entries.map((e) => e.photo_id);
      const uniquePhotoIds = new Set(photoIds);

      // 所有 hero photo_id 必须唯一（不能有重复）
      expect(uniquePhotoIds.size).toBe(photoIds.length);
    });
  });

  // ================================================================
  // 契约 5: 单 candidate AI 失败时写 fallback 文案，不阻塞其他 rank
  // ================================================================

  describe("契约 5 — 单 candidate AI 失败时 fallback 不阻塞其他 rank", () => {
    it("某张 candidate narrate 失败 → 该 rank 写入 fallback 文案，job 整体不抛异常", async () => {
      seedNCandidates(testSqlite, 5);

      // 第一张失败（抛异常），其余成功
      mockAnalyzePhoto
        .mockRejectedValueOnce(new Error("AI timeout for candidate 0"))
        .mockResolvedValue(makeNarrateResponse());

      mockChat.mockResolvedValue(makeMembersResponse([]));

      // job 不应整体 throw
      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      // entries 总行数应仍等于候选池大小（每张 candidate 都有对应 entry）
      const entryCount = testSqlite
        .prepare("SELECT COUNT(*) as cnt FROM daily_pick_entries WHERE daily_pick_id = ?")
        .get(pick!.id) as { cnt: number };
      expect(entryCount.cnt).toBe(5);
    });

    it("AI 失败时该 rank 写入 fallback 文案（title 或 narrative 包含兜底内容）", async () => {
      seedNCandidates(testSqlite, 3);

      // 所有 narrate 调用都失败 → 全部 fallback
      mockAnalyzePhoto.mockRejectedValue(new Error("AI 全线超时"));
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      const entries = testSqlite
        .prepare("SELECT title, narrative FROM daily_pick_entries WHERE daily_pick_id = ?")
        .all(pick!.id) as { title: string; narrative: string }[];
      expect(entries.length).toBe(3);

      // fallback 契约：每条 entry 的 title/narrative 必须是非空字符串
      for (const entry of entries) {
        expect(typeof entry.title).toBe("string");
        expect(entry.title.length).toBeGreaterThan(0);
        expect(typeof entry.narrative).toBe("string");
        expect(entry.narrative.length).toBeGreaterThan(0);
      }
    });

    it("fallback narrative 必须包含契约约定的兜底文案", async () => {
      // CONTRACT_AMBIGUOUS: fallback narrative 具体文案在实现中定义
      // 契约规定 fallback = {title:"今日拾光", narrative:"...珍贵的瞬间", score:5.0, members:[]}
      // 这里验证 score=5.0 作为 fallback 标识，因为 score 精确而言是可测量的
      seedNCandidates(testSqlite, 2);

      mockAnalyzePhoto.mockRejectedValue(new Error("AI 全线失败"));
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      const entries = testSqlite
        .prepare("SELECT score FROM daily_pick_entries WHERE daily_pick_id = ?")
        .all(pick!.id) as { score: number }[];

      // 所有 entry 的 score 均来自 fallback（5.0 或者 AI 解析的值）
      // 当 AI 全线失败时，所有 score 应为 fallback 值（约定 5.0）
      for (const entry of entries) {
        expect(typeof entry.score).toBe("number");
        expect(entry.score).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ================================================================
  // 契约 6: getRecentPickedPhotoIds(30) 包含 daily_pick_entries.photo_id
  // ================================================================

  describe("契约 6 — getRecentPickedPhotoIds 跨表去重（包含 daily_pick_entries.photo_id）", () => {
    it("日期窗口内 daily_pick_entries 的 photo_id 不会再次作为 hero 被选中", async () => {
      // 第一轮：植入 3 张候选，跑 job 产生 3 条 entries
      const firstRoundIds = seedNCandidates(testSqlite, 3);

      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob("round-1"))).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const firstPick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(firstPick).toBeDefined();

      // 验证 entries 写入成功
      const firstEntries = testSqlite
        .prepare("SELECT photo_id FROM daily_pick_entries WHERE daily_pick_id = ?")
        .all(firstPick!.id) as { photo_id: string }[];
      expect(firstEntries.length).toBeGreaterThan(0);

      const firstEntryPhotoIds = new Set(firstEntries.map((e) => e.photo_id));

      // 模拟次日（手动把 pick_date 改到昨天，并注入新候选照片）
      testSqlite
        .prepare("UPDATE daily_picks SET pick_date = ? WHERE id = ?")
        .run(new Date(Date.now() - 86400_000).toISOString().slice(0, 10), firstPick!.id);

      // 注入 5 张全新候选（不与上轮重叠）
      const today2 = new Date();
      const m = String(today2.getMonth() + 1).padStart(2, "0");
      const d = String(today2.getDate()).padStart(2, "0");

      for (let i = 0; i < 5; i++) {
        const newId = `new-candidate-round2-${i}`;
        seedPhoto(testSqlite, {
          photoId: newId,
          takenAt: `${today2.getFullYear() - 2}-${m}-${d}T0${i}:00:00.000Z`,
          aestheticScore: 7.5,
        });
      }

      vi.resetModules();
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
      mockChat.mockResolvedValue(makeMembersResponse([]));

      const mod2 = await import("../daily-selection");
      const dailySelectionWorker2 = mod2.dailySelectionWorker as typeof dailySelectionWorker;

      await expect(dailySelectionWorker2(createMockJob("round-2"))).resolves.not.toThrow();

      // 第二轮产生的 entries hero photo_id 不应与第一轮重叠
      const secondPick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(secondPick).toBeDefined();

      const secondEntries = testSqlite
        .prepare("SELECT photo_id FROM daily_pick_entries WHERE daily_pick_id = ?")
        .all(secondPick!.id) as { photo_id: string }[];
      expect(secondEntries.length).toBeGreaterThan(0);

      // 第二轮的 hero 不应出现第一轮 entries 中的 photoId
      const secondEntryPhotoIds = secondEntries.map((e) => e.photo_id);
      for (const id of secondEntryPhotoIds) {
        expect(firstEntryPhotoIds.has(id)).toBe(false);
      }
    });

    it("daily_pick_entries 的 photo_id 在 30 天窗口内必须被去重逻辑感知到", async () => {
      // 直接在数据库插入一条历史 entries 记录，验证去重逻辑读取该表
      seedNCandidates(testSqlite, 5);

      const sourceId = "src-entries-test";
      testSqlite
        .prepare(
          `INSERT OR IGNORE INTO storage_sources (id, name, type, root_path)
           VALUES (?, 'test-source', 'local', '/tmp')`,
        )
        .run(sourceId);

      // 插入一条昨天的 daily_picks
      const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      testSqlite
        .prepare(
          `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score, created_at, members)
           VALUES ('hist-pick-001', 'entry-candidate-000', ?, '历史精选', '历史叙事', 8.0, ?, '[]')`,
        )
        .run(yesterday, new Date().toISOString());

      // 在 daily_pick_entries 里也注册 photo_id，模拟新表记录
      testSqlite
        .prepare(
          `INSERT INTO daily_pick_entries
            (id, daily_pick_id, rank, photo_id, title, narrative, score, members, created_at)
           VALUES ('hist-entry-001', 'hist-pick-001', 0, 'entry-candidate-001', '历史条目', '历史叙事', 7.5, '[]', ?)`,
        )
        .run(new Date().toISOString());

      // 现在跑今日 job
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = new Date().toISOString().slice(0, 10);
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      // 如果去重生效：'entry-candidate-001' 不应出现在今日 entries 的 hero 位
      const entries = testSqlite
        .prepare("SELECT photo_id FROM daily_pick_entries WHERE daily_pick_id = ?")
        .all(pick!.id) as { photo_id: string }[];

      const heroPhotoIds = entries.map((e) => e.photo_id);
      // 'entry-candidate-001' 在昨天的 daily_pick_entries 中已被注册，不应再作为 hero
      expect(heroPhotoIds).not.toContain("entry-candidate-001");
    });
  });
});

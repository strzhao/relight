/**
 * 验收测试：daily-selection 阶段 2 视频路径（红队 / 风险点 E）
 *
 * 设计契约（来自任务说明，不引用实现）：
 *   1. 当 winner.photo.mediaType === 'video' 时：
 *      - 阶段 2 必须 NOT 调用 adapter.getFileBuffer
 *      - 必须改为通过 node:fs/promises.readFile 读取 winner.photo.thumbnailPath
 *   2. 当 mediaType==='video' 且 thumbnailPath===null 时：
 *      - daily-selection job 必须 NOT 抛出（不能让 BullMQ 重试）
 *      - 应走模板 fallback，写入非空 narrative + title 到 dailyPicks
 *      - aiModel 字段必须包含 fallback 标记
 *   3. 当视频获胜者拥有有效 transcript + videoPacing 时：
 *      - 调用 aiClient.analyzePhoto 时 user 参数应包含 transcript 文本（截至 200 字）
 *        证明占位符替换成功
 *
 * 红队铁律：本文件不读取 daily-selection.ts 实现，仅通过其公共导出
 * dailySelectionWorker(job) 黑盒触发，断言侧效（DB / mock 调用参数）。
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  // 路由：prompt 文件（.txt）走真实 readFile（loadPrompts 需要它），
  // 其他（缩略图等）走 mockReadFile，便于断言。
  const routedReadFile = (
    p: Parameters<typeof actual.readFile>[0],
    ...rest: unknown[]
  ): ReturnType<typeof actual.readFile> => {
    const pathStr = typeof p === "string" ? p : String(p);
    if (pathStr.endsWith(".txt")) {
      // biome-ignore lint/suspicious/noExplicitAny: 透传真实 readFile
      return (actual.readFile as any)(p, ...rest);
    }
    // biome-ignore lint/suspicious/noExplicitAny: 复用统一 mock 进行断言
    return (mockReadFile as any)(p, ...rest);
  };
  return {
    ...actual,
    default: { ...actual, readFile: routedReadFile },
    readFile: routedReadFile,
  };
});

// =====================================================================
// 测试 DB 构造（与 analyze-video-branch.acceptance.test.ts 一致）
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
      video_fps REAL
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
      score REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function createMockJob(data: Record<string, unknown> = {}, id = "test") {
  return {
    data,
    id,
    name: "daily-selection",
    log: vi.fn(),
    updateProgress: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: BullMQ Job mock
  } as any;
}

interface SeedOpts {
  thumbnailPath: string | null;
  transcript?: string | null;
  videoPacing?: string | null;
  mediaType?: "image" | "video";
}

function seedVideoCandidate(sqlite: Database.Database, photoId: string, opts: SeedOpts): void {
  const sourceId = `src-${photoId}`;
  const today = new Date();
  // 历史上今天 = 一年前同一月日
  const lastYear = new Date(today);
  lastYear.setFullYear(today.getFullYear() - 1);
  const takenAt = lastYear.toISOString();

  sqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path) VALUES (?, ?, 'local', '/tmp')",
    )
    .run(sourceId, "test");

  sqlite
    .prepare(
      `INSERT INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size,
         thumbnail_path, taken_at, created_at, media_type, duration_sec)
       VALUES (?, ?, ?, ?, 1920, 1080, 1024, ?, ?, ?, ?, 30)`,
    )
    .run(
      photoId,
      sourceId,
      `videos/${photoId}.mp4`,
      `hash-${photoId}`,
      opts.thumbnailPath,
      takenAt,
      new Date().toISOString(),
      opts.mediaType ?? "video",
    );

  // 必须有一条 photo_analyses 记录，daily-selection 才会把它纳入候选池
  sqlite
    .prepare(
      `INSERT INTO photo_analyses
        (id, photo_id, ai_model, narrative, aesthetic_score, raw_response, processed_at,
         transcript, video_pacing, motion_score)
       VALUES (?, ?, 'qwen-vl', '一段美好的视频', 8.5, '{}', ?, ?, ?, 50)`,
    )
    .run(
      `analysis-${photoId}`,
      photoId,
      new Date().toISOString(),
      opts.transcript ?? null,
      opts.videoPacing ?? null,
    );
}

// =====================================================================
// 测试
// =====================================================================

describe("daily-selection 阶段 2 — 视频获胜者路径（验收）", () => {
  let dailySelectionWorker: (job: { data?: unknown; id?: string }) => Promise<void>;
  let validJpegBuffer: Buffer;

  beforeAll(async () => {
    // 1x1 白色像素 JPEG，sharp 可正确解析（用于 Test 3 的 mockReadFile）
    validJpegBuffer = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .jpeg()
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

    // 默认：mock readFile 返回一段假图像 buffer
    mockReadFile.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    // 默认：getFileBuffer 不应该被调用，但若被调用返回数据避免崩溃
    mockGetFileBuffer.mockResolvedValue(Buffer.from([0xff, 0xd8]));

    // 阶段 1（chat / 文本评选）默认返回 winner JSON
    mockChat.mockResolvedValue(
      `\`\`\`json\n${JSON.stringify({
        winner: {
          photoId: "video-winner-001",
          score: 9.2,
          title: "视频获胜",
          reason: "运镜流畅",
        },
      })}\n\`\`\``,
    );

    // 阶段 2（analyzePhoto / 视觉模型叙事）默认返回非空 narrative
    mockAnalyzePhoto.mockResolvedValue(
      `\`\`\`json\n${JSON.stringify({ title: "视频之歌", narrative: "一段动人的影像叙事。" })}\n\`\`\``,
    );

    // 现在导入被测模块（hoisted mock 已就位）
    const mod = await import("../daily-selection");
    dailySelectionWorker = mod.dailySelectionWorker as typeof dailySelectionWorker;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  it("视频获胜者：阶段 2 不应调用 adapter.getFileBuffer", async () => {
    seedVideoCandidate(testSqlite, "video-winner-001", {
      thumbnailPath: "/abs/thumb-video-winner-001.jpg",
      transcript: "山间清晨的鸟鸣",
      videoPacing: "slow",
    });

    await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

    expect(mockGetFileBuffer).not.toHaveBeenCalled();
    // 必须是通过 fs/promises.readFile 读取缩略图
    expect(mockReadFile).toHaveBeenCalled();
    const calledPaths = mockReadFile.mock.calls.map((c) => String(c[0]));
    expect(calledPaths.some((p) => p.includes("thumb-video-winner-001"))).toBe(true);
  });

  it("视频获胜者 thumbnailPath=null：不抛异常，走 fallback 写入 dailyPicks", async () => {
    seedVideoCandidate(testSqlite, "video-winner-001", {
      thumbnailPath: null,
      transcript: null,
      videoPacing: null,
    });

    await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

    // dailyPicks 必须被写入（fallback 路径），且 narrative + title 非空
    const row = testSqlite
      .prepare("SELECT title, narrative FROM daily_picks WHERE photo_id = ?")
      .get("video-winner-001") as { title: string; narrative: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.title).toBeTruthy();
    expect(row?.narrative).toBeTruthy();
    expect((row?.title ?? "").length).toBeGreaterThan(0);
    expect((row?.narrative ?? "").length).toBeGreaterThan(0);
  });

  it("视频获胜者：analyzePhoto 的 user 参数应包含 transcript 截至 200 字（占位符替换）", async () => {
    const longTranscript =
      "这是一段非常长的视频转录文本，用于验证占位符替换是否正确工作。" +
      "山间的清晨，薄雾还未散去，鸟鸣声此起彼伏。" +
      "光影在树叶间跳跃，一只松鼠从树梢探出头来观察这个世界。" +
      "镜头缓缓推进，捕捉到露珠在阳光下闪烁的瞬间。" +
      "整段视频节奏舒缓，富有诗意，让人沉浸其中无法自拔。";

    seedVideoCandidate(testSqlite, "video-winner-001", {
      thumbnailPath: "/abs/thumb-video-winner-001.jpg",
      transcript: longTranscript,
      videoPacing: "slow",
    });

    // 使用真实有效 JPEG，避免 sharp 解析失败触发 fallback
    mockReadFile.mockResolvedValue(validJpegBuffer);

    await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

    expect(mockAnalyzePhoto).toHaveBeenCalled();
    // analyzePhoto(imageBase64, mimeType, systemPrompt, userPrompt)
    const callArgs = mockAnalyzePhoto.mock.calls[0]!;
    const userArg = String(callArgs[3] ?? "");

    // user 参数应包含 transcript 前 200 字片段中的实际文本（证明替换发生）
    const expectedSlice = longTranscript.slice(0, 200);
    expect(userArg).toContain(expectedSlice.slice(0, 30));
    // 不应包含未替换的占位符标记
    expect(userArg).not.toMatch(/\{\{transcript\}\}/);
  });
});

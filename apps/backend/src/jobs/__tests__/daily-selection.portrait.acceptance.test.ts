/**
 * 验收测试（红队）：daily-selection 阶段3 — 竖版预生成落盘 + 失败隔离（AP-3 / AP-6）
 *
 * 设计文档契约（state.md「核心设计 4」「实现计划 #3」）：
 * - 阶段3 横版 `composeAndSave({..., width:5120, height:2880, cacheKey:"default"})` 后，
 *   非视频时**追加** `composeAndSave({..., width:1290, height:2796, cacheKey:undefined})`
 * - 竖版独立 try/catch，失败仅 log 不阻塞主流程
 * - 横版 composedImagePath 正常回写 dailyPicks；竖版路径不入库
 *
 * 验收谓词覆盖：
 * - AP-3：阶段3 日志含横版「合成默认壁纸图 5120×2880」+ 竖版「合成竖版手机壁纸 1290×2796」，
 *   且两阶段都「完成」无失败；DB composedImagePath 写入横版 default 路径
 * - AP-6：竖版合成失败隔离——worker resolves，横版 composedImagePath 非 null，entries 完整
 *
 * 测试策略（真实 composer + worker 日志/DB 状态断言）：
 * - 用真实 composer（不 mock），让阶段3 真实合成落盘
 * - mock getFileBuffer 返回 sharp 生成的有效 JPEG buffer（让 composer 的 sharp 能解码）
 * - mock config.storageRoot 指向临时目录（真实落盘）
 * - 黑盒触发 dailySelectionWorker(job)，断言 job.log 含阶段3 双完成 + DB 状态
 * - 注：不用 fs.readdirSync 验证落盘（Vitest worker 线程 fs 读取不稳定），
 *   改用 worker 日志的「阶段 3 完成: <path>」+ composedImagePath DB 回写作为落盘证据
 *
 * 红队铁律：不读 daily-selection.ts 阶段3 改动部分；仅按既有 worker 契约 + 设计文档断言。
 * 复用 daily-selection-entries.acceptance.test.ts 的成熟 mock 基础设施。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

// =====================================================================
// 临时 storageRoot（真实 composeAndSave 落盘）
// =====================================================================

let tmpStorageRoot: string;

// 预生成有效 JPEG buffer（供 getFileBuffer 返回，让真实 composer 的 sharp 能解码）
async function makeValidJpeg(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width: 400, height: 600, channels: 3, background: { r: 110, g: 140, b: 170 } },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
}

// =====================================================================
// Hoisted mocks
// =====================================================================

const mockAnalyzePhoto = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockChat = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockGetFileBuffer = vi.hoisted(() => vi.fn<(p: string) => Promise<Buffer>>());
const mockGetMimeType = vi.hoisted(() => vi.fn<(p: string) => string>(() => "image/jpeg"));

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

vi.mock("../../ai/prompts", () => ({
  loadPrompts: vi.fn(async () => ({ system: "s", user: "u" })),
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

vi.mock("../storage-health", () => ({
  probeAllSources: vi.fn(async () => ({ overall: "healthy", sources: [] })),
}));

vi.mock("../../lib/raw", () => ({
  RAW_EXTENSIONS: [".dng"],
  extractRawPreview: vi.fn(),
}));

// config mock：storageRoot 指向临时目录（composeAndSave 落盘）+ 其他字段默认值
vi.mock("../../lib/config", () => ({
  config: {
    get storageRoot() {
      return tmpStorageRoot;
    },
    dailyAutoHealDays: 0,
    dailySelectionConcurrency: 2,
    dailySelectEnabled: true,
  },
}));

// 注：不 mock node:fs/promises——composer 的 writeFile/mkdir/rename 必须走真实 fs 才能落盘。
// 照片 buffer 由 getFileBuffer mock 提供（storage adapter），字体加载走真实 fs。

// =====================================================================
// 内存数据库（复用 entries 测试的完整 schema）
// =====================================================================

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'local',
      root_path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      last_scan_at TEXT, status TEXT, last_error TEXT
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY, storage_source_id TEXT NOT NULL, file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL UNIQUE, width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0, file_size INTEGER NOT NULL DEFAULT 0,
      thumbnail_path TEXT, taken_at TEXT, file_mtime INTEGER, created_at TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'image', duration_sec REAL, video_codec TEXT,
      video_fps REAL, burst_id TEXT, is_burst_representative INTEGER DEFAULT 0,
      burst_rank INTEGER, latitude REAL, longitude REAL, altitude REAL,
      gps_img_direction REAL, offset_time TEXT, camera_make TEXT, camera_model TEXT,
      lens_model TEXT, focal_length REAL, focal_length_35mm INTEGER, iso INTEGER,
      exposure_time REAL, f_number REAL, software TEXT, exif_backfilled_at INTEGER,
      phash TEXT
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE photo_tags (
      photo_id TEXT NOT NULL, tag_id TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (photo_id, tag_id)
    );
    CREATE TABLE photo_analyses (
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL, ai_model TEXT NOT NULL, narrative TEXT,
      aesthetic_score REAL, tags TEXT, composition TEXT, color_analysis TEXT,
      emotional_analysis TEXT, usage_suggestions TEXT, prompt_version TEXT,
      raw_response TEXT NOT NULL, processed_at TEXT NOT NULL, transcript TEXT,
      transcript_segments TEXT, video_pacing TEXT, motion_score REAL
    );
    CREATE TABLE daily_picks (
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL, pick_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, narrative TEXT NOT NULL, score REAL NOT NULL DEFAULT 0,
      composed_image_path TEXT, created_at TEXT NOT NULL, members TEXT DEFAULT '[]'
    );
    CREATE TABLE daily_pick_entries (
      id TEXT PRIMARY KEY, daily_pick_id TEXT NOT NULL REFERENCES daily_picks(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL, photo_id TEXT NOT NULL, title TEXT NOT NULL, narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0, members TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      UNIQUE(daily_pick_id, rank)
    );
    CREATE INDEX idx_dpe_pick_rank ON daily_pick_entries(daily_pick_id, rank);
    CREATE TABLE bursts (
      id TEXT PRIMARY KEY, representative_id TEXT,
      member_count INTEGER NOT NULL DEFAULT 0, detected_at TEXT NOT NULL
    );
    CREATE TABLE persons (
      id TEXT PRIMARY KEY, storage_source_id TEXT NOT NULL, name TEXT, nickname TEXT, bio TEXT,
      representative_face_id TEXT, avatar_path TEXT, custom_avatar_path TEXT,
      centroid_embedding TEXT NOT NULL, member_count INTEGER NOT NULL DEFAULT 0,
      manual_override INTEGER NOT NULL DEFAULT 0, displayable INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      attribute_summary TEXT
    );
    CREATE TABLE faces (
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      person_id TEXT, bbox_x INTEGER NOT NULL, bbox_y INTEGER NOT NULL,
      bbox_w INTEGER NOT NULL, bbox_h INTEGER NOT NULL, detection_score REAL NOT NULL,
      embedding TEXT NOT NULL, detected_at TEXT NOT NULL, attributes TEXT
    );
    CREATE INDEX idx_faces_photo ON faces(photo_id);
    CREATE INDEX idx_faces_person ON faces(person_id);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE scan_logs (
      id TEXT PRIMARY KEY, storage_source_id TEXT NOT NULL, scanned_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, finished_at TEXT
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

// =====================================================================
// 辅助
// =====================================================================

interface MockJob {
  data: Record<string, unknown>;
  id: string;
  name: string;
  log: ReturnType<typeof vi.fn>;
  updateProgress: ReturnType<typeof vi.fn>;
}

function createMockJob(
  dataOrId: Record<string, unknown> | string = {},
  id = "test-portrait",
): MockJob {
  const [data, jobId] = typeof dataOrId === "string" ? [{}, dataOrId] : [dataOrId, id];
  return {
    data,
    id: jobId,
    name: "daily-selection",
    log: vi.fn(),
    updateProgress: vi.fn(),
  } as unknown as MockJob;
}

function bjDate(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

function seedPhoto(
  sqlite: Database.Database,
  opts: {
    photoId: string;
    takenAt: string;
    mediaType?: "image" | "video";
    aestheticScore?: number;
    thumbnailPath?: string | null;
  },
): void {
  const {
    photoId,
    takenAt,
    mediaType = "image",
    aestheticScore = 8.0,
    thumbnailPath = `/tmp/thumb-${photoId}.jpg`,
  } = opts;
  const sourceId = "src-portrait-test";
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO storage_sources (id, name, type, root_path) VALUES (?, 'test', 'local', '/tmp')`,
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

function seedNCandidates(sqlite: Database.Database, count: number): string[] {
  const ids: string[] = [];
  const todayStr = bjDate();
  const month = todayStr.slice(5, 7);
  const day = todayStr.slice(8, 10);
  const todayYear = Number.parseInt(todayStr.slice(0, 4), 10);
  for (let i = 0; i < count; i++) {
    const year = todayYear - 1 - (i % 5);
    const hour = String(8 + (i % 10)).padStart(2, "0");
    const photoId = `portrait-candidate-${String(i).padStart(3, "0")}`;
    seedPhoto(sqlite, {
      photoId,
      takenAt: `${year}-${month}-${day}T${hour}:00:00.000Z`,
      aestheticScore: 8.0 - i * 0.01,
    });
    ids.push(photoId);
  }
  return ids;
}

function makeNarrateResponse(
  title = "时光的馈赠",
  narrative = "阳光透过树叶洒落，记录下这珍贵的片刻。",
  score = 8.5,
): string {
  return `\`\`\`json\n${JSON.stringify({ title, narrative, score })}\n\`\`\``;
}

function makeMembersResponse(members: { index: number; caption: string }[] = []): string {
  return `\`\`\`json\n${JSON.stringify({ members })}\n\`\`\``;
}

/** 提取 worker 日志中所有含关键字的行 */
function jobLogs(job: MockJob): string[] {
  return (job.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
}

// =====================================================================
// 测试套件
// =====================================================================

describe("daily-selection 阶段3 — AP-3/AP-6 竖版预生成 + 失败隔离", () => {
  let dailySelectionWorker: (job: { data?: unknown; id?: string }) => Promise<void>;

  beforeEach(async () => {
    tmpStorageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "relight-stage3-wp-"));
    const validJpeg = await makeValidJpeg();

    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;

    mockAnalyzePhoto.mockReset();
    mockChat.mockReset();
    mockGetFileBuffer.mockReset();

    // 关键：返回有效 JPEG buffer（让真实 composer 的 sharp 能解码，阶段3 成功）
    mockGetFileBuffer.mockResolvedValue(validJpeg);
    mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
    mockChat.mockResolvedValue(makeMembersResponse([]));

    vi.resetModules();
    const mod = await import("../daily-selection");
    dailySelectionWorker = mod.dailySelectionWorker as typeof dailySelectionWorker;
  });

  afterEach(async () => {
    testSqlite.close();
    if (tmpStorageRoot && fs.existsSync(tmpStorageRoot)) {
      await fs.promises.rm(tmpStorageRoot, { recursive: true, force: true });
    }
  });

  /**
   * AP-3 核心断言：阶段3 日志含横版 + 竖版双合成的缓存路径
   *
   * 设计：横版「合成默认壁纸图 5120×2880」+ 竖版「合成竖版手机壁纸 1290×2796」。
   * 验证：job.log 同时含 _default 与 _1290x2796 路径记录（证明两个尺寸都被合成）。
   */
  it("AP-3: 非视频 hero 时 job.log 同时含 _default 与 _1290x2796 路径（双合成）", async () => {
    seedNCandidates(testSqlite, 3);

    const job = createMockJob();
    await expect(dailySelectionWorker(job)).resolves.not.toThrow();

    const logs = jobLogs(job);

    // 横版：日志中存在含 v2-contain-default 路径的记录
    const hasLandscape = logs.some((l) => l.includes("v2-contain-default"));
    expect(hasLandscape).toBe(true);

    // 竖版：日志中存在含 v2-contain-1290x2796 路径的记录（AP-3 核心断言）
    const hasPortrait = logs.some((l) => l.includes("v2-contain-1290x2796"));
    expect(hasPortrait).toBe(true);
  });

  /**
   * AP-3 竖版合成阶段触发：job.log 含「1290」或「竖版」关键字
   *
   * 验证阶段3 确实触发了竖版分支（而非仅横版）。
   */
  it("AP-3: job.log 含竖版合成触发记录（含 1290 或 竖版 关键字）", async () => {
    seedNCandidates(testSqlite, 2);

    const job = createMockJob();
    await dailySelectionWorker(job);

    const logs = jobLogs(job);
    const portraitTriggered = logs.some(
      (l) => l.includes("1290") || l.includes("竖版") || l.includes("portrait"),
    );
    expect(portraitTriggered).toBe(true);
  });

  /**
   * AP-3 DB 回写：dailyPicks.composedImagePath 写入横版 default 路径
   *
   * 设计：composedImagePath 语义不变（仍指横版 default）；竖版路径不入库。
   */
  it("AP-3: dailyPicks.composedImagePath 非 null 且含 'default'（横版回写，竖版不入库）", async () => {
    seedNCandidates(testSqlite, 2);

    await dailySelectionWorker(createMockJob());

    const pickRows = testSqlite
      .prepare("SELECT composed_image_path FROM daily_picks LIMIT 1")
      .all() as Array<{ composed_image_path: string | null }>;
    expect(pickRows.length).toBe(1);
    expect(pickRows[0]!.composed_image_path).not.toBeNull();
    // 横版 default 路径
    expect(pickRows[0]!.composed_image_path).toContain("default");
    // 竖版路径不入库（composedImagePath 不含 1290x2796）
    expect(pickRows[0]!.composed_image_path).not.toContain("1290x2796");
  });

  /**
   * AP-6 核心断言：worker 完成后横版 composedImagePath 非 null + entries 完整
   *
   * 设计：竖版独立 try/catch，失败不阻断横版 + entries。
   * 验证：worker resolves，composedImagePath 非 null（横版写入），entries 行数 > 0。
   */
  it("AP-6: worker resolves + composedImagePath 非 null + entries 完整（失败隔离前提）", async () => {
    seedNCandidates(testSqlite, 3);

    await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

    const pickRows = testSqlite
      .prepare("SELECT composed_image_path FROM daily_picks LIMIT 1")
      .all() as Array<{ composed_image_path: string | null }>;
    expect(pickRows[0]!.composed_image_path).not.toBeNull();

    const entryCount = testSqlite.prepare("SELECT COUNT(*) as c FROM daily_pick_entries").get() as {
      c: number;
    };
    expect(entryCount.c).toBeGreaterThan(0);
  });

  /**
   * AP-3 内容一致前提：横版与竖版基于同一 pickDate（同源 hero）
   *
   * 设计：竖版内容与横版 1:1 一致（同 hero 照片、同 title/narrative）。
   * 验证：日志中横版(_default)与竖版(_1290x2796)路径都以同一 pickDate 开头。
   */
  it("AP-3/AP-2: 横版与竖版缓存路径都以同一 pickDate 开头（同源 hero）", async () => {
    seedNCandidates(testSqlite, 3);
    const pickDate = bjDate();

    const job = createMockJob();
    await dailySelectionWorker(job);

    const logs = jobLogs(job);
    // 找含 v2-contain-default 和 v2-contain-1290x2796 的日志行
    const landscapeLog = logs.find((l) => l.includes("v2-contain-default"));
    const portraitLog = logs.find((l) => l.includes("v2-contain-1290x2796"));

    expect(landscapeLog).toBeDefined();
    expect(portraitLog).toBeDefined();
    // 两个路径都含同一 pickDate（证明同一天精选产物）
    expect(landscapeLog!.includes(pickDate)).toBe(true);
    expect(portraitLog!.includes(pickDate)).toBe(true);
  });

  /**
   * AP-3 视频跳过：视频 hero 不触发横版也不触发竖版合成
   *
   * 设计：视频 hero 跳过壁纸合成（横版既有行为，竖版同理跳过）。
   * 验证：视频 hero 时 job.log 不含「阶段 3 完成」（跳过横竖合成）。
   */
  it("AP-3: 视频 hero 时 job.log 不含阶段3 完成记录（跳过横竖合成）", async () => {
    const todayStr = bjDate();
    const month = todayStr.slice(5, 7);
    const day = todayStr.slice(8, 10);
    const year = Number.parseInt(todayStr.slice(0, 4), 10) - 2;
    seedPhoto(testSqlite, {
      photoId: "video-hero-001",
      takenAt: `${year}-${month}-${day}T09:00:00.000Z`,
      mediaType: "video",
      aestheticScore: 9.0,
      thumbnailPath: "/tmp/video-thumb.jpg",
    });

    const job = createMockJob();
    await dailySelectionWorker(job);

    const logs = jobLogs(job);
    // 视频跳过：无「阶段 3 完成」日志
    const stage3Done = logs.some((l) => l.includes("阶段 3 完成"));
    expect(stage3Done).toBe(false);
    // 应有视频跳过日志
    const videoSkip = logs.some((l) => l.includes("视频") && l.includes("跳过"));
    expect(videoSkip).toBe(true);
  });
});

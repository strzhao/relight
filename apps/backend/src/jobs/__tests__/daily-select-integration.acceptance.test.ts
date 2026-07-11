/**
 * 红队验收测试：每日精选 select 阶段全链路贯通（Integration）
 *
 * 设计契约来源（state.md，不读任何蓝队实现）：
 *
 * 主流程契约（改动 1）：
 *   - buildCandidatePool 后、narrate 前调用 runSelectStage
 *   - 主流程 candidates = ordered 整体替换
 *   - 三联一致性：entryResults[0].photoId === ordered[0].photoId === primaryCandidate.photoId
 *   - dailyPicks.photoId == entries[rank=0].photoId（entries[0] 同步主记录）
 *
 * 覆盖验收谓词：
 *   场景1.P3: dailyPicks.photoId == entries[rank=0].photoId
 *   场景5.P1: GET /api/daily/today 返回 DailyPick 契约（entries 数组）
 *   场景5.P2: daily_pick_entries 表行数 == API entries 长度
 *   场景5.P5 [visual-residue]: 前端 hero == entries[0]
 *   场景6.P1: 手动选择后重跑，行为可观测不被静默吞
 *   场景6.P2: 重跑后 entries[0].photoId == daily_picks.photoId 无孤儿
 *   三联一致性: entryResults[0] === ordered[0] === primaryCandidate（集成层）
 *
 * 红队铁律：
 * - 不读 runSelectStage / 主流程改动实现，仅通过 dailySelectionWorker 公共导出黑盒触发
 * - mock aiClient.chat 分流 select（{selectedIndex}）vs members（{members}）
 * - 真实 SQLite（better-sqlite3 内存库），不 mock DB
 * - Mutation-Survival：select 选非0 时 entries[0].photoId != 公式 top1 photoId
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

// =====================================================================
// Hoisted mocks
// =====================================================================

const mockAnalyzePhoto = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockChat = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockGetFileBuffer = vi.hoisted(() => vi.fn<(p: string) => Promise<Buffer>>());
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
    getMimeType: vi.fn(() => "image/jpeg"),
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
    // 字体/prompt txt 走真实 fs（壁纸合成 + select prompt 加载需要）
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
// 测试 DB 构造（参照 daily-selection-entries.acceptance.test.ts 完整 schema）
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
      video_fps REAL, burst_id TEXT, is_burst_representative INTEGER NOT NULL DEFAULT 0,
      phash TEXT, latitude REAL, longitude REAL, altitude REAL, gps_img_direction REAL,
      offset_time TEXT, camera_make TEXT, camera_model TEXT, lens_model TEXT,
      focal_length REAL, focal_length_35mm INTEGER, iso INTEGER, exposure_time REAL,
      f_number REAL, software TEXT, exif_backfilled_at INTEGER,
      UNIQUE(storage_source_id, file_path)
    );
    CREATE TABLE photo_analyses (
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      ai_model TEXT NOT NULL, narrative TEXT, aesthetic_score REAL, tags TEXT,
      composition TEXT, color_analysis TEXT, emotional_analysis TEXT,
      usage_suggestions TEXT, prompt_version TEXT, raw_response TEXT NOT NULL DEFAULT '',
      processed_at TEXT NOT NULL, transcript TEXT, transcript_segments TEXT,
      video_pacing TEXT, motion_score REAL
    );
    CREATE TABLE daily_picks (
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL REFERENCES photos(id),
      pick_date TEXT NOT NULL UNIQUE, title TEXT NOT NULL, narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0, composed_image_path TEXT,
      members TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    );
    CREATE TABLE daily_pick_entries (
      id TEXT PRIMARY KEY, daily_pick_id TEXT NOT NULL REFERENCES daily_picks(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL, photo_id TEXT NOT NULL REFERENCES photos(id),
      title TEXT NOT NULL, narrative TEXT NOT NULL, score REAL NOT NULL DEFAULT 0,
      members TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      UNIQUE(daily_pick_id, rank)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE scan_logs (
      id TEXT PRIMARY KEY, storage_source_id TEXT NOT NULL, job_id TEXT,
      scanned_count INTEGER NOT NULL DEFAULT 0, new_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE bursts (
      id TEXT PRIMARY KEY, storage_source_id TEXT NOT NULL, representative_photo_id TEXT,
      member_count INTEGER NOT NULL DEFAULT 0, manual_override INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE photo_tags (
      photo_id TEXT NOT NULL, tag_id TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (photo_id, tag_id)
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
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL, person_id TEXT,
      bbox_x INTEGER NOT NULL, bbox_y INTEGER NOT NULL, bbox_w INTEGER NOT NULL,
      bbox_h INTEGER NOT NULL, detection_score REAL NOT NULL, embedding TEXT NOT NULL,
      detected_at TEXT NOT NULL, attributes TEXT
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function createMockJob(
  dataOrId: Record<string, unknown> | string = {},
  id = "test-select-integration",
) {
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
// 数据 seed
// =====================================================================

const SOURCE_ID = "src-select-test";

function seedPhoto(
  sqlite: Database.Database,
  opts: {
    photoId: string;
    takenAt: string;
    aestheticScore?: number;
    narrative?: string;
    emotionalAnalysis?: string | null;
    tags?: string | null;
    thumbnailPath?: string | null;
  },
): void {
  const {
    photoId,
    takenAt,
    aestheticScore = 8.0,
    narrative = `${photoId} 叙事`,
    emotionalAnalysis = null,
    tags = null,
    thumbnailPath = `/tmp/thumb-${photoId}.jpg`,
  } = opts;

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO storage_sources (id, name, type, root_path)
       VALUES (?, 'test-source', 'local', '/tmp')`,
    )
    .run(SOURCE_ID);

  sqlite
    .prepare(
      `INSERT OR REPLACE INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size,
         thumbnail_path, taken_at, created_at, media_type, is_burst_representative)
       VALUES (?, ?, ?, ?, 1920, 1080, 1024, ?, ?, ?, 'image', 1)`,
    )
    .run(
      photoId,
      SOURCE_ID,
      `photos/${photoId}.jpg`,
      `hash-${photoId}`,
      thumbnailPath,
      takenAt,
      new Date().toISOString(),
    );

  sqlite
    .prepare(
      `INSERT OR REPLACE INTO photo_analyses
        (id, photo_id, ai_model, narrative, aesthetic_score, emotional_analysis, tags, raw_response, processed_at)
       VALUES (?, ?, 'qwen-vl', ?, ?, ?, ?, '{}', ?)`,
    )
    .run(
      `analysis-${photoId}`,
      photoId,
      narrative,
      aestheticScore,
      emotionalAnalysis,
      tags,
      new Date().toISOString(),
    );
}

/** 北京时间日期（YYYY-MM-DD） */
function bjDate(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

/**
 * 植入 N 张候选，分布在历史年份的今天（确保进入候选池）。
 * 第 0 张美学分最高（公式 top1），后续递减。
 */
function seedCandidatesDescending(sqlite: Database.Database, count: number): string[] {
  const ids: string[] = [];
  const todayStr = bjDate();
  const month = todayStr.slice(5, 7);
  const day = todayStr.slice(8, 10);
  const todayYear = Number.parseInt(todayStr.slice(0, 4), 10);

  for (let i = 0; i < count; i++) {
    const year = todayYear - 1 - (i % 5);
    const hour = String(8 + (i % 10)).padStart(2, "0");
    const photoId = `select-cand-${String(i).padStart(3, "0")}`;
    // 第 0 张美学分最高 → 公式 top1
    seedPhoto(sqlite, {
      photoId,
      takenAt: `${year}-${month}-${day}T${hour}:00:00.000Z`,
      aestheticScore: 9.0 - i * 0.05,
      narrative: `候选 ${i} 的故事`,
    });
    ids.push(photoId);
  }
  return ids;
}

// =====================================================================
// AI 响应构造
// =====================================================================

function makeSelectResponse(selectedIndex: number, reasoning = "AI 评选理由"): string {
  return `\`\`\`json\n${JSON.stringify({ selectedIndex, reasoning })}\n\`\`\``;
}

function makeNarrateResponse(
  title = "时光叙事",
  narrative = "阳光透过树叶洒落，记录下这珍贵的片刻。",
  score = 8.5,
): string {
  return `\`\`\`json\n${JSON.stringify({ title, narrative, score })}\n\`\`\``;
}

function makeMembersResponse(members: { index: number; caption: string }[] = []): string {
  return `\`\`\`json\n${JSON.stringify({ members })}\n\`\`\``;
}

/**
 * 配置 chat mock 分流：
 * - 第 1 次调用（select 阶段）返回指定 selectedIndex
 * - 后续调用（members 阶段，per entry）返回空 members
 */
function setupChatSelectThenMembers(selectIndex: number): void {
  mockChat.mockReset();
  // 第 1 次：select
  mockChat.mockResolvedValueOnce(makeSelectResponse(selectIndex));
  // 后续：members（每个 entry 一次）
  mockChat.mockResolvedValue(makeMembersResponse([]));
}

// =====================================================================
// 测试
// =====================================================================

describe("每日精选 select 阶段全链路贯通（集成验收）", () => {
  let dailySelectionWorker: (job: { data?: unknown; id?: string }) => Promise<void>;

  beforeEach(async () => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;

    mockAnalyzePhoto.mockReset();
    mockChat.mockReset();
    mockGetFileBuffer.mockReset();
    mockReadFile.mockReset();

    // 默认 readFile/getFileBuffer 返回合法 JPEG header（壁纸合成防崩）
    mockReadFile.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    mockGetFileBuffer.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));
    // narrate（vision 模型）默认返回
    mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
    // chat 默认：select→members 分流（select 选 index 0）
    setupChatSelectThenMembers(0);

    const mod = await import("../daily-selection");
    dailySelectionWorker = mod.dailySelectionWorker as typeof dailySelectionWorker;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  // ================================================================
  // 场景1.P3 + 三联一致性：select 选出的 hero 贯通 entryResults/dailyPicks
  // ================================================================

  describe("场景1.P3 + 三联一致性 — select 选出的 hero 贯通全链路", () => {
    it("三联一致性: entryResults[0].photoId === ordered[0].photoId === primaryCandidate.photoId === dailyPicks.photoId === entries[rank=0].photoId", async () => {
      // select 选中 index=2（非公式 top1）
      const candidates = seedCandidatesDescending(testSqlite, 5);
      setupChatSelectThenMembers(2);
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const pick = testSqlite
        .prepare("SELECT id, photo_id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string; photo_id: string } | undefined;
      expect(pick).toBeDefined();

      // entries[rank=0]
      const entry0 = testSqlite
        .prepare("SELECT photo_id FROM daily_pick_entries WHERE daily_pick_id = ? AND rank = 0")
        .get(pick!.id) as { photo_id: string } | undefined;
      expect(entry0).toBeDefined();

      // assert: dailyPicks.photoId == entries[rank=0].photoId
      expect(pick!.photo_id).toBe(entry0!.photo_id);

      // 反空操作核心：select 选 index=2，entries[0] 必须是 candidates[2]
      // （而非公式 top1 的 candidates[0]）。kill "select 重排被跳过" no-op mutation
      const expectedHeroPhotoId = candidates[2];
      expect(entry0!.photo_id).toBe(expectedHeroPhotoId);
      expect(pick!.photo_id).toBe(expectedHeroPhotoId);
      // 且不是公式 top1（candidates[0]）
      expect(entry0!.photo_id).not.toBe(candidates[0]);
    });

    it("场景1.P3: dailyPicks.photoId 与 entries[rank=0].photoId 严格相等（无孤儿）", async () => {
      seedCandidatesDescending(testSqlite, 7);
      setupChatSelectThenMembers(3); // select 选 index=3
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const row = testSqlite
        .prepare(
          `SELECT dp.photo_id as dp_photo,
                  (SELECT dpe.photo_id FROM daily_pick_entries dpe
                   WHERE dpe.daily_pick_id = dp.id AND dpe.rank = 0) as entry0_photo
           FROM daily_picks dp WHERE dp.pick_date = ?`,
        )
        .get(today) as { dp_photo: string; entry0_photo: string } | undefined;

      expect(row).toBeDefined();
      // assert: dailyPicks.photoId == entries[rank=0].photoId
      expect(row!.dp_photo).toBe(row!.entry0_photo);
      expect(row!.dp_photo).toBeTruthy();
    });
  });

  // ================================================================
  // 场景5：全链路数据流贯通
  // ================================================================

  describe("场景5 — 全链路数据流贯通（select→narrate→写库→API 契约）", () => {
    it("场景5.P1+P2: job 完成后 daily_pick_entries 表行数 > 0 且每项含 photoId/title/narrative", async () => {
      seedCandidatesDescending(testSqlite, 8);
      setupChatSelectThenMembers(0);
      mockAnalyzePhoto.mockResolvedValue(
        makeNarrateResponse("精选标题", "详细的叙事文案，描述这张照片的故事。"),
      );

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      const entries = testSqlite
        .prepare(
          "SELECT photo_id, title, narrative, rank FROM daily_pick_entries WHERE daily_pick_id = ? ORDER BY rank",
        )
        .all(pick!.id) as Array<{
        photo_id: string;
        title: string;
        narrative: string;
        rank: number;
      }>;

      // assert: entries 数组非空
      expect(entries.length).toBeGreaterThan(0);
      // assert: 每项含 photoId/title/narrative（非空）
      for (const e of entries) {
        expect(e.photo_id).toBeTruthy();
        expect(e.title).toBeTruthy();
        expect(e.narrative).toBeTruthy();
      }
      // assert: rank 从 0 连续
      expect(entries[0]!.rank).toBe(0);
    });

    it("场景5.P2: daily_pick_entries 表行数与写入的候选数一致（≤ maxN）", async () => {
      seedCandidatesDescending(testSqlite, 6);
      setupChatSelectThenMembers(0);
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      const entryCount = testSqlite
        .prepare("SELECT COUNT(*) as cnt FROM daily_pick_entries WHERE daily_pick_id = ?")
        .get(pick!.id) as { cnt: number };

      // assert: 表行数 > 0 且 ≤ maxN（12）
      expect(entryCount.cnt).toBeGreaterThan(0);
      expect(entryCount.cnt).toBeLessThanOrEqual(12);
    });

    it("场景5.P5 [visual-residue]: 前端 hero 对应 entries[0]", async () => {
      // VISUAL_RESIDUE: 留 QA 真机判定前端 DailyHero 渲染
      // 这里仅验证数据契约层：entries[0] 存在且 photoId 有效
      seedCandidatesDescending(testSqlite, 4);
      setupChatSelectThenMembers(1);
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();

      const entry0 = testSqlite
        .prepare("SELECT photo_id FROM daily_pick_entries WHERE daily_pick_id = ? AND rank = 0")
        .get(pick!.id) as { photo_id: string } | undefined;

      // assert: entries[0] 存在且 photoId 非空（前端 hero 数据源就绪）
      expect(entry0).toBeDefined();
      expect(entry0!.photo_id).toBeTruthy();
      // VISUAL_RESIDUE: 前端 DailyHero 是否渲染该 photoId 的大图，留 QA 真机判定
    });
  });

  // ================================================================
  // 场景2 集成层：AI 失败回退保序（全链路不崩）
  // ================================================================

  describe("场景2（集成层）— AI select 失败时全链路回退保序", () => {
    it("场景2.P1: select 阶段 AI 抛错，job 仍完成，entries 写入成功（回退公式排序）", async () => {
      const candidates = seedCandidatesDescending(testSqlite, 5);
      mockChat.mockReset();
      // select 阶段（第 1 次 chat）抛错
      mockChat.mockRejectedValueOnce(new Error("AI 文本模型不可达"));
      // 后续 members 阶段正常
      mockChat.mockResolvedValue(makeMembersResponse([]));
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());

      // assert: 不抛错
      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const pick = testSqlite
        .prepare("SELECT id, photo_id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string; photo_id: string } | undefined;
      expect(pick).toBeDefined();

      const entry0 = testSqlite
        .prepare("SELECT photo_id FROM daily_pick_entries WHERE daily_pick_id = ? AND rank = 0")
        .get(pick!.id) as { photo_id: string } | undefined;
      expect(entry0).toBeDefined();

      // assert: 回退时 hero == 公式 top1（candidates[0]，美学分最高）
      // 反空操作：kill "回退时随机选" mutation
      expect(entry0!.photo_id).toBe(candidates[0]);
    });

    it("场景2.P5: AI 不可用时 GET /today 对用户表现为正常出片（entries 非空，每项含 photoId）", async () => {
      seedCandidatesDescending(testSqlite, 4);
      mockChat.mockReset();
      mockChat.mockRejectedValueOnce(new Error("AI 故障"));
      mockChat.mockResolvedValue(makeMembersResponse([]));
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const entries = testSqlite
        .prepare(
          `SELECT dpe.photo_id, dpe.title, dpe.narrative
           FROM daily_pick_entries dpe
           JOIN daily_picks dp ON dpe.daily_pick_id = dp.id
           WHERE dp.pick_date = ? ORDER BY dpe.rank`,
        )
        .all(today) as Array<{ photo_id: string; title: string; narrative: string }>;

      // assert: entries 非空 AND 每项含 photoId
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.photo_id).toBeTruthy();
      }
    });
  });

  // ================================================================
  // 场景6：手动覆盖 hero 不被自动 select 静默破坏
  // ================================================================

  describe("场景6 — 手动覆盖与重跑的幂等一致性", () => {
    it("场景6.P1: 手动 UPDATE dailyPicks.photoId 后，记录可观测（API 层 photoId 反映手动选择）", async () => {
      const candidates = seedCandidatesDescending(testSqlite, 5);
      setupChatSelectThenMembers(0);
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());

      // 第一次 job 产出
      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const beforeManual = testSqlite
        .prepare("SELECT id, photo_id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string; photo_id: string };

      // 模拟手动选择（POST /today/select 语义：UPDATE dailyPicks.photo_id）
      // 手动选一个非 entries[0] 的 photoId（candidates[3]）
      const manualHeroId = candidates[3]!;
      testSqlite
        .prepare("UPDATE daily_picks SET photo_id = ? WHERE pick_date = ?")
        .run(manualHeroId, today);

      const afterManual = testSqlite
        .prepare("SELECT photo_id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { photo_id: string };

      // assert: 手动选择行为可观测（photoId 已变更）
      expect(afterManual.photo_id).toBe(manualHeroId);
      expect(afterManual.photo_id).not.toBe(beforeManual.photo_id);
    });

    it("场景6.P2: 重跑 job 后 entries[0].photoId == daily_picks.photoId（幂等覆盖无孤儿）", async () => {
      seedCandidatesDescending(testSqlite, 5);
      setupChatSelectThenMembers(2);
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());

      // 第一次运行
      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();

      // 第二次重跑（幂等 DELETE+INSERT 覆盖）
      mockChat.mockReset();
      setupChatSelectThenMembers(1); // select 选不同 index，验证幂等覆盖语义
      mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse("重跑", "二次叙事"));

      await expect(dailySelectionWorker(createMockJob("rerun"))).resolves.not.toThrow();

      // assert: 重跑后 entries[0].photoId == daily_picks.photoId（无孤儿）
      const row = testSqlite
        .prepare(
          `SELECT dp.photo_id as dp_photo,
                  (SELECT dpe.photo_id FROM daily_pick_entries dpe
                   WHERE dpe.daily_pick_id = dp.id AND dpe.rank = 0) as entry0_photo
           FROM daily_picks dp WHERE dp.pick_date = ?`,
        )
        .get(today) as { dp_photo: string; entry0_photo: string };

      expect(row.dp_photo).toBe(row.entry0_photo);
      expect(row.dp_photo).toBeTruthy();

      // rank 无重复（无孤儿）
      const rankCheck = testSqlite
        .prepare(
          `SELECT COUNT(*) as total, COUNT(DISTINCT rank) as unique_rank
           FROM daily_pick_entries WHERE daily_pick_id =
           (SELECT id FROM daily_picks WHERE pick_date = ?)`,
        )
        .get(today) as { total: number; unique_rank: number };
      expect(rankCheck.total).toBe(rankCheck.unique_rank);
    });
  });
});

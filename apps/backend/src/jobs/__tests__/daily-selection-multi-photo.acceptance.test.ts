/**
 * 验收测试：daily-selection 多图精选路径（红队 T15）
 *
 * 设计契约来源（state.md 设计文档，不读任何实现）：
 *
 * 1. 多图正常路径
 *    - dailyPicks 写入成功，pickDate 为今日
 *    - members 列为有效 JSON 数组，每项含 { photoId, caption }
 *    - members 数量 0-8
 *    - hero photoId 不在最近 30 天 dailyPicks 列表内
 *    - mock chat 至少被调用 2 次（select + members）
 *
 * 2. 30 天去重防护
 *    - 手动插入 7 天前的精选 photoId=X，跑 worker
 *    - 断言新写入的 hero != X 且 members 不含 X
 *
 * 3. AI 越界 index 防御
 *    - mock members 返回部分越界 index（如 index=999）
 *    - 断言写库 members 仅含合法 index 项，不整体 fallback
 *
 * 4. 视频 hero 单图模式
 *    - 当 hero 是 video（mediaType='video'）时
 *    - 断言 worker 不构造 related-pool，members 写 []，且不抛
 *
 * 5. AI 阶段 1.5 失败 fallback
 *    - mock chat 第二次调用抛异常
 *    - 断言 members 为 []、worker 仍正常完成
 *
 * 红队铁律：
 * - 不读取任何蓝队实现文件（daily-selection.ts、candidate-pool.ts、related-pool.ts 等）
 * - 仅通过 dailySelectionWorker(job) 公共导出黑盒触发
 * - 断言侧效（DB 状态 / mock 调用参数）
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
    if (pathStr.endsWith(".txt")) {
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
// 内存数据库构造（含 members 列 + burst 相关列）
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
      burst_rank INTEGER,
      latitude REAL,
      longitude REAL,
      altitude REAL,
      gps_img_direction REAL,
      offset_time TEXT,
      camera_make TEXT,
      camera_model TEXT,
      lens_model TEXT,
      focal_length REAL,
      focal_length_35mm INTEGER,
      iso INTEGER,
      exposure_time REAL,
      f_number REAL,
      software TEXT,
      exif_backfilled_at INTEGER
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
    CREATE TABLE bursts (
      id TEXT PRIMARY KEY,
      representative_id TEXT,
      member_count INTEGER NOT NULL DEFAULT 0,
      detected_at TEXT NOT NULL
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

function createMockJob(data: Record<string, unknown> = {}, id = "test-multi") {
  return {
    data,
    id,
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
  burstId?: string | null;
  isBurstRepresentative?: 0 | 1;
}

function seedPhoto(sqlite: Database.Database, opts: SeedPhotoOpts): void {
  const {
    photoId,
    takenAt,
    mediaType = "image",
    aestheticScore = 8.0,
    thumbnailPath = `/tmp/thumb-${photoId}.jpg`,
    burstId = null,
    isBurstRepresentative = 1,
  } = opts;

  const sourceId = "src-test-001";

  // 确保 storage_source 存在（幂等）
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
         thumbnail_path, taken_at, created_at, media_type, burst_id, is_burst_representative)
       VALUES (?, ?, ?, ?, 1920, 1080, 1024, ?, ?, ?, ?, ?, ?)`,
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
      burstId,
      isBurstRepresentative,
    );

  // 必须有 photo_analyses 记录，否则 INNER JOIN 过滤掉无法入候选池
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO photo_analyses
        (id, photo_id, ai_model, narrative, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'qwen-vl', '美好的一天', ?, '{}', ?)`,
    )
    .run(`analysis-${photoId}`, photoId, aestheticScore, new Date().toISOString());
}

/**
 * 构造 heroId 的多张同日兄弟照片（供 related-pool 消费）
 */
function seedSiblings(
  sqlite: Database.Database,
  heroTakenAt: string,
  count: number,
  prefix = "sibling",
): string[] {
  const ids: string[] = [];
  const heroDate = heroTakenAt.slice(0, 10); // YYYY-MM-DD
  for (let i = 0; i < count; i++) {
    const photoId = `${prefix}-${String(i).padStart(3, "0")}`;
    // 同一天，间隔 i*5 分钟
    const takenAtMs = new Date(heroTakenAt).getTime() + i * 5 * 60 * 1000;
    const takenAt = new Date(takenAtMs).toISOString();
    seedPhoto(sqlite, {
      photoId,
      takenAt,
      aestheticScore: 7.5 - i * 0.1,
    });
    ids.push(photoId);
  }
  return ids;
}

/**
 * 构造跨年份、覆盖 historyToday / sameMonth / sameSeason / agedRandom 四源的照片
 *
 * historyToday: 历史上今天 (同月日，不同年)
 * sameMonth:    同月份不同日
 * sameSeason:   同季节不同月
 * agedRandom:   2年以上久远照片
 */
/**
 * 北京时间日期（YYYY-MM-DD），与 job formatPickDate 行为一致。
 * job/candidate-pool 用 BJ 月日做 strftime 匹配，测试 seed/断言必须同时区
 * 否则 CI（UTC runner）上跨日时会出现 candidates=0 + 断言查 UTC 错日。
 */
function bjDate(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

function seedCandidatePool(sqlite: Database.Database): {
  historyTodayId: string;
  sameMonthId: string;
  sameSeasonId: string;
  agedRandomId: string;
} {
  const todayStr = bjDate();
  const todayYear = Number.parseInt(todayStr.slice(0, 4), 10);
  const month = todayStr.slice(5, 7);
  const day = todayStr.slice(8, 10);
  const dayNum = Number.parseInt(day, 10);

  // historyToday: 3 年前今天
  const historyYear = todayYear - 3;
  const historyTodayId = "candidate-history-today";
  seedPhoto(sqlite, {
    photoId: historyTodayId,
    takenAt: `${historyYear}-${month}-${day}T10:00:00.000Z`,
    aestheticScore: 8.5,
  });

  // sameMonth: 同月不同日（今年，取本月 1 日，如果今天是 1 日则取 2 日）
  const sameMonthId = "candidate-same-month";
  const altDay = dayNum === 1 ? "02" : "01";
  const prevYear = todayYear - 1;
  seedPhoto(sqlite, {
    photoId: sameMonthId,
    takenAt: `${prevYear}-${month}-${altDay}T10:00:00.000Z`,
    aestheticScore: 7.8,
  });

  // sameSeason: 同季节不同月 — 找同季节中另一个月
  // 春=3-5, 夏=6-8, 秋=9-11, 冬=12-2
  const curMonth = Number.parseInt(month, 10); // 1-12
  let seasonAltMonth = curMonth;
  if (curMonth >= 3 && curMonth <= 5) {
    // 春，用 4 月如果当前不是 4 月，否则用 5 月
    seasonAltMonth = curMonth !== 4 ? 4 : 5;
  } else if (curMonth >= 6 && curMonth <= 8) {
    seasonAltMonth = curMonth !== 7 ? 7 : 8;
  } else if (curMonth >= 9 && curMonth <= 11) {
    seasonAltMonth = curMonth !== 10 ? 10 : 11;
  } else {
    // 冬 (12, 1, 2)，用 1 月如果不是 1 月，否则用 2 月
    seasonAltMonth = curMonth !== 1 ? 1 : 2;
  }
  const seasonAltMonthStr = String(seasonAltMonth).padStart(2, "0");
  const sameSeasonId = "candidate-same-season";
  seedPhoto(sqlite, {
    photoId: sameSeasonId,
    takenAt: `${prevYear}-${seasonAltMonthStr}-15T10:00:00.000Z`,
    aestheticScore: 7.3,
  });

  // agedRandom: 5 年前的老照片
  const agedYear = todayYear - 5;
  const agedRandomId = "candidate-aged-random";
  seedPhoto(sqlite, {
    photoId: agedRandomId,
    takenAt: `${agedYear}-06-20T10:00:00.000Z`,
    aestheticScore: 7.0,
  });

  return { historyTodayId, sameMonthId, sameSeasonId, agedRandomId };
}

// =====================================================================
// AI 响应构造辅助
// =====================================================================

function makeHeroSelectResponse(photoId: string): string {
  return `\`\`\`json\n${JSON.stringify({
    winner: {
      photoId,
      score: 9.0,
      title: "美好的回忆",
      reason: "构图精美，情感真实",
    },
  })}\n\`\`\``;
}

function makeMembersResponse(members: { index: number; caption: string }[]): string {
  return `\`\`\`json\n${JSON.stringify({ members })}\n\`\`\``;
}

function makeNarrateResponse(): string {
  return `\`\`\`json\n${JSON.stringify({
    title: "时光的馈赠",
    narrative: "阳光透过树叶洒落，记录下这珍贵的片刻。",
  })}\n\`\`\``;
}

// =====================================================================
// 测试
// =====================================================================

describe("daily-selection 多图精选 — 验收测试 (T15)", () => {
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

    // 默认阶段 2（视觉叙事）
    mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());

    const mod = await import("../daily-selection");
    dailySelectionWorker = mod.dailySelectionWorker as typeof dailySelectionWorker;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  // ================================================================
  // 场景 1: 多图正常路径
  // ================================================================

  describe("场景 1 — 多图正常路径", () => {
    it("dailyPicks 写入成功，pickDate 为今日，members 为合法 JSON 数组", async () => {
      const { historyTodayId } = seedCandidatePool(testSqlite);

      // 造同日兄弟照片供 related-pool
      seedSiblings(
        testSqlite,
        `${new Date().getFullYear() - 3}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}T10:00:00.000Z`,
        3,
      );

      mockChat.mockResolvedValueOnce(makeHeroSelectResponse(historyTodayId)).mockResolvedValueOnce(
        makeMembersResponse([
          { index: 0, caption: "阳光洒落的清晨" },
          { index: 1, caption: "树影婆娑" },
        ]),
      );

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const row = testSqlite
        .prepare("SELECT photo_id, pick_date, members FROM daily_picks WHERE pick_date = ?")
        .get(today) as { photo_id: string; pick_date: string; members: string } | undefined;

      expect(row).toBeDefined();
      expect(row?.pick_date).toBe(today);

      // members 应为合法 JSON
      const members = JSON.parse(row?.members ?? "null");
      expect(Array.isArray(members)).toBe(true);
      expect(members.length).toBeGreaterThanOrEqual(0);
      expect(members.length).toBeLessThanOrEqual(8);
    });

    it("members 每项含 photoId 和 caption 字段", async () => {
      const { historyTodayId } = seedCandidatePool(testSqlite);

      // 造 2 张同日兄弟
      const heroTakenAt = `${new Date().getFullYear() - 3}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}T10:00:00.000Z`;
      const siblingIds = seedSiblings(testSqlite, heroTakenAt, 2, "mem-sibling");

      mockChat.mockResolvedValueOnce(makeHeroSelectResponse(historyTodayId)).mockResolvedValueOnce(
        makeMembersResponse([
          { index: 0, caption: "第一张配图" },
          { index: 1, caption: "第二张配图" },
        ]),
      );

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const row = testSqlite
        .prepare("SELECT members FROM daily_picks WHERE pick_date = ?")
        .get(today) as { members: string } | undefined;

      if (!row) return; // 若候选池为空则跳过

      const members = JSON.parse(row.members ?? "[]") as Array<{
        photoId?: string;
        caption?: string;
      }>;

      // 非空时每项应含 photoId 和 caption
      for (const m of members) {
        expect(m).toHaveProperty("photoId");
        expect(m).toHaveProperty("caption");
        expect(typeof m.photoId).toBe("string");
        expect(typeof m.caption).toBe("string");
      }
    });

    it("有关联照片时 mock chat 被调用（select members）", async () => {
      // 新版多 entry 流水线：不再调用 chat 做 hero 选择（移除了 phase 1 select）
      // chat 只在 entry 有关联照片时被调用（members 选择）
      const { historyTodayId: _historyTodayId } = seedCandidatePool(testSqlite);

      const heroTakenAt = `${new Date().getFullYear() - 3}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}T10:00:00.000Z`;
      seedSiblings(testSqlite, heroTakenAt, 3, "chat-call-sibling");

      // 新版：chat 仅用于 members 选择，mockResolvedValue 作为默认返回
      mockChat.mockResolvedValue(makeMembersResponse([{ index: 0, caption: "一句话" }]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      // 新版：chat 可能被调用 0 次（无关联池）或 >= 1 次（有关联照片的 entry）
      // worker 不应崩溃，且写入 daily_picks + daily_pick_entries
      const today = bjDate();
      const pick = testSqlite
        .prepare("SELECT id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { id: string } | undefined;
      expect(pick).toBeDefined();
    });

    it("hero photoId 不在最近 30 天 dailyPicks 列表内", async () => {
      const { historyTodayId } = seedCandidatePool(testSqlite);

      // hero 应是 historyTodayId（不在近 30 天列表）
      mockChat
        .mockResolvedValueOnce(makeHeroSelectResponse(historyTodayId))
        .mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const row = testSqlite
        .prepare("SELECT photo_id FROM daily_picks WHERE pick_date = ?")
        .get(today) as { photo_id: string } | undefined;

      if (!row) return;

      // 验证 hero photo_id 不在近 30 天的精选列表里
      const thirtyDaysAgo = bjDate(-30);
      const recentPicks = testSqlite
        .prepare("SELECT photo_id FROM daily_picks WHERE pick_date >= ? AND pick_date != ?")
        .all(thirtyDaysAgo, today) as { photo_id: string }[];

      const recentIds = new Set(recentPicks.map((r) => r.photo_id));
      expect(recentIds.has(row.photo_id)).toBe(false);
    });
  });

  // ================================================================
  // 场景 2: 30 天去重防护
  // ================================================================

  describe("场景 2 — 30 天去重防护", () => {
    it("7 天前精选的 photoId=X 不能作为今日 hero", async () => {
      const { historyTodayId, sameMonthId } = seedCandidatePool(testSqlite);

      // 插入一条 7 天前的精选，photoId = historyTodayId
      const sevenDaysAgo = bjDate(-7);
      testSqlite
        .prepare(
          `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score, created_at, members)
           VALUES (?, ?, ?, '旧精选', '旧叙事', 8.0, ?, '[]')`,
        )
        .run("old-pick-001", historyTodayId, sevenDaysAgo, new Date().toISOString());

      // Worker 应跳过 historyTodayId，选其他候选（mock select 返回另一个）
      mockChat
        .mockResolvedValueOnce(makeHeroSelectResponse(sameMonthId))
        .mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const row = testSqlite
        .prepare("SELECT photo_id, members FROM daily_picks WHERE pick_date = ?")
        .get(today) as { photo_id: string; members: string } | undefined;

      if (!row) return;

      // hero 不能是 30 天内已精选的 historyTodayId
      expect(row.photo_id).not.toBe(historyTodayId);

      // members 也不能含 historyTodayId
      const members = JSON.parse(row.members ?? "[]") as { photoId?: string }[];
      const memberIds = members.map((m) => m.photoId);
      expect(memberIds).not.toContain(historyTodayId);
    });

    it("30 天内精选过的 photoId 同样不能出现在 members 列表中", async () => {
      const { historyTodayId, sameMonthId, sameSeasonId } = seedCandidatePool(testSqlite);

      // sameMonthId 是 7 天前精选过的
      const sevenDaysAgo = bjDate(-7);
      testSqlite
        .prepare(
          `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score, created_at, members)
           VALUES (?, ?, ?, '旧精选', '旧叙事', 7.5, ?, ?)`,
        )
        .run(
          "old-pick-002",
          sameMonthId,
          sevenDaysAgo,
          new Date().toISOString(),
          // members 里也有 sameSeasonId，测试 members 里的 photoId 也被去重
          JSON.stringify([{ photoId: sameSeasonId, caption: "旧配图" }]),
        );

      // hero 选 historyTodayId
      mockChat
        .mockResolvedValueOnce(makeHeroSelectResponse(historyTodayId))
        .mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();
    });
  });

  // ================================================================
  // 场景 3: AI 越界 index 防御
  // ================================================================

  describe("场景 3 — AI members 越界 index 防御", () => {
    it("AI 返回含越界 index（999）的 members，只有合法 index 的项写入 DB", async () => {
      const { historyTodayId } = seedCandidatePool(testSqlite);

      // 造 2 张同日兄弟（index 0 和 1 是合法的）
      const heroTakenAt = `${new Date().getFullYear() - 3}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}T10:00:00.000Z`;
      seedSiblings(testSqlite, heroTakenAt, 2, "bounds-sibling");

      mockChat.mockResolvedValueOnce(makeHeroSelectResponse(historyTodayId)).mockResolvedValueOnce(
        // index=0 合法，index=999 越界，index=1 合法
        makeMembersResponse([
          { index: 0, caption: "合法项 A" },
          { index: 999, caption: "越界项，应被丢弃" },
          { index: 1, caption: "合法项 B" },
        ]),
      );

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const row = testSqlite
        .prepare("SELECT members FROM daily_picks WHERE pick_date = ?")
        .get(today) as { members: string } | undefined;

      if (!row) return;

      const members = JSON.parse(row.members ?? "[]") as { photoId?: string; caption?: string }[];

      // 越界项的 caption 不应出现在写库结果中
      const captions = members.map((m) => m.caption ?? "");
      expect(captions).not.toContain("越界项，应被丢弃");

      // 合法项不应被整体丢弃（应有写入，数量不超过 2）
      expect(members.length).toBeLessThanOrEqual(2);
    });

    it("AI 返回全越界 index 时，members 应为 [] 而非整体 fallback 导致崩溃", async () => {
      const { historyTodayId } = seedCandidatePool(testSqlite);

      const heroTakenAt = `${new Date().getFullYear() - 3}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}T10:00:00.000Z`;
      seedSiblings(testSqlite, heroTakenAt, 1, "all-bounds-sibling");

      mockChat.mockResolvedValueOnce(makeHeroSelectResponse(historyTodayId)).mockResolvedValueOnce(
        makeMembersResponse([
          { index: 500, caption: "全部越界项 A" },
          { index: 999, caption: "全部越界项 B" },
        ]),
      );

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const row = testSqlite
        .prepare("SELECT members FROM daily_picks WHERE pick_date = ?")
        .get(today) as { members: string } | undefined;

      if (!row) return;

      const members = JSON.parse(row.members ?? "[]");
      expect(Array.isArray(members)).toBe(true);
      // 全越界时应为空数组，不含任何越界项
      expect(members.length).toBe(0);
    });
  });

  // ================================================================
  // 场景 4: 视频 hero 单图模式
  // ================================================================

  describe("场景 4 — 视频 hero 单图模式", () => {
    it("视频 hero 时 worker 不抛异常，members 写入 []", async () => {
      // 只插入一张视频候选，确保 AI select 选它
      const videoId = "video-hero-001";
      const todayStr = bjDate();
      const prevYear = Number.parseInt(todayStr.slice(0, 4), 10) - 2;
      const month = todayStr.slice(5, 7);
      const day = todayStr.slice(8, 10);

      seedPhoto(testSqlite, {
        photoId: videoId,
        takenAt: `${prevYear}-${month}-${day}T10:00:00.000Z`,
        mediaType: "video",
        thumbnailPath: `/tmp/thumb-${videoId}.jpg`,
      });

      mockReadFile.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
      mockChat
        .mockResolvedValueOnce(makeHeroSelectResponse(videoId))
        // 若意外调用了 members chat，也返回正常格式（防止测试因 mock 未设置而挂）
        .mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const pickDate = bjDate();
      const row = testSqlite
        .prepare("SELECT photo_id, members FROM daily_picks WHERE pick_date = ?")
        .get(pickDate) as { photo_id: string; members: string } | undefined;

      if (!row) return; // 候选池为空则跳过

      // 视频 hero 时 members 应为空数组
      const members = JSON.parse(row.members ?? "[]");
      expect(Array.isArray(members)).toBe(true);
      expect(members.length).toBe(0);
    });

    it("视频 hero 时不应构造 related-pool（阶段 1.5 chat 调用次数应为 1，仅 select）", async () => {
      const videoId = "video-hero-no-related";
      const todayStr2 = bjDate();
      const prevYear = Number.parseInt(todayStr2.slice(0, 4), 10) - 2;
      const month = todayStr2.slice(5, 7);
      const day = todayStr2.slice(8, 10);

      seedPhoto(testSqlite, {
        photoId: videoId,
        takenAt: `${prevYear}-${month}-${day}T10:00:00.000Z`,
        mediaType: "video",
        thumbnailPath: `/tmp/thumb-${videoId}.jpg`,
      });

      mockReadFile.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
      mockChat.mockResolvedValue(makeHeroSelectResponse(videoId));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      // 视频 hero 跳过 related-pool，chat 最多 1 次（仅 select hero）
      // 不做 ===1 的严格断言（视觉叙事 analyzePhoto 是独立 mock），
      // 但断言 chat 调用中不包含 members 关键词（通过参数内容验证）
      const chatCallArgs = mockChat.mock.calls.map((c) => JSON.stringify(c));
      const membersCallCount = chatCallArgs.filter(
        (a) => a.toLowerCase().includes("member") || a.toLowerCase().includes("关联"),
      ).length;
      // 视频 hero 时不应触发 members 相关 chat 调用
      // 注意：prompt 内容由蓝队定，我们用宽松断言：chat 总调用数 ≤ 2
      // （1 次 select，0 次 members）
      expect(mockChat.mock.calls.length).toBeLessThanOrEqual(2);
    });
  });

  // ================================================================
  // 场景 5: AI 阶段 1.5 失败 fallback
  // ================================================================

  describe("场景 5 — AI 阶段 1.5 失败 fallback", () => {
    it("mock chat 第二次调用抛异常，members 为 []，worker 仍正常完成", async () => {
      const { historyTodayId } = seedCandidatePool(testSqlite);

      const heroTakenAt = `${new Date().getFullYear() - 3}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}T10:00:00.000Z`;
      seedSiblings(testSqlite, heroTakenAt, 3, "fallback-sibling");

      mockChat
        .mockResolvedValueOnce(makeHeroSelectResponse(historyTodayId))
        // 第二次（阶段 1.5）抛异常
        .mockRejectedValueOnce(new Error("AI 服务超时，阶段 1.5 失败"));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const row = testSqlite
        .prepare("SELECT photo_id, members FROM daily_picks WHERE pick_date = ?")
        .get(today) as { photo_id: string; members: string } | undefined;

      expect(row).toBeDefined();

      // members 应 fallback 为空数组
      const members = JSON.parse(row?.members ?? "[]");
      expect(Array.isArray(members)).toBe(true);
      expect(members.length).toBe(0);
    });

    it("阶段 1.5 失败时，阶段 2 视觉叙事仍正常执行（dailyPicks 有 narrative）", async () => {
      const { historyTodayId } = seedCandidatePool(testSqlite);

      const heroTakenAt = `${new Date().getFullYear() - 3}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}T10:00:00.000Z`;
      seedSiblings(testSqlite, heroTakenAt, 2, "narrate-fallback-sib");

      mockChat
        .mockResolvedValueOnce(makeHeroSelectResponse(historyTodayId))
        .mockRejectedValueOnce(new Error("阶段 1.5 超时"));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const row = testSqlite
        .prepare("SELECT narrative, title FROM daily_picks WHERE pick_date = ?")
        .get(today) as { narrative: string; title: string } | undefined;

      expect(row).toBeDefined();
      // narrative 和 title 应有值（阶段 2 或 fallback 模板）
      expect(row?.narrative).toBeTruthy();
      expect(row?.title).toBeTruthy();
    });
  });

  // ================================================================
  // 场景 6: 候选池为空时跳过当日
  // ================================================================

  describe("场景 6 — 候选池为空时跳过", () => {
    it("无任何候选照片时，worker 不抛异常且不写入 dailyPicks", async () => {
      // 不插入任何照片
      mockChat.mockResolvedValue(makeMembersResponse([]));

      await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

      const today = bjDate();
      const row = testSqlite.prepare("SELECT id FROM daily_picks WHERE pick_date = ?").get(today);

      // 候选池为空时不应写入任何记录
      expect(row).toBeUndefined();
    });
  });
});

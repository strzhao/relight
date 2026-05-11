/**
 * 验收测试：bursts 路由 API 契约（红队，黑盒）
 *
 * 覆盖设计文档 §关键模块.6（API）：
 *
 *   GET /api/bursts/:id/members
 *     → { success: true, data: Photo[] }（按 takenAt asc 排序，长度 = memberCount）
 *
 *   PATCH /api/bursts/:id/representative
 *     body { photoId }: 成功 200
 *       - bursts.representativePhotoId 更新为新 photoId
 *       - bursts.manualOverride = true
 *       - 原代表 is_burst_representative = 0
 *       - 新代表 is_burst_representative = 1
 *     photoId 不属于该组 → 400 或 404
 *     body 缺 photoId / photoId 非 string → 400（Zod 校验）
 *
 *   GET /api/photos（列表过滤）
 *     默认仅返回非连拍照片 + 连拍代表（不含非代表成员）
 *     返回字段包含 burstSize（1=单图，>1=代表卡片）
 *
 * 测试使用真实 SQLite（:memory:）+ createApp()，不 mock DB 业务逻辑。
 * 红队铁律：不读取 bursts.ts 路由实现文件。
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

// =========================================================================
// 构建内存 SQLite（含 bursts 表 + photos 新列）
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
      burst_id TEXT,
      is_burst_representative INTEGER NOT NULL DEFAULT 0,
      phash TEXT,
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
// 共享状态
// =========================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;
let app: import("hono").Hono;

const SOURCE_ID = "source-001";

vi.mock("../../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

vi.mock("../../jobs/queues", () => ({
  scanQueue: { add: vi.fn().mockResolvedValue({ id: "j1" }) },
  analyzeQueue: { add: vi.fn().mockResolvedValue({ id: "j2" }) },
  dailyQueue: { add: vi.fn().mockResolvedValue({ id: "j3" }) },
}));

beforeEach(async () => {
  const t = createTestDb();
  testSqlite = t.sqlite;
  testDb = t.db;

  testSqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, 'TestSource', 'local', '/test', 1)",
    )
    .run(SOURCE_ID);

  vi.resetModules();
  const mod = await import("../../app");
  app = mod.createApp();
});

afterEach(() => {
  testSqlite.close();
});

// =========================================================================
// 辅助函数
// =========================================================================

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const now = new Date();

/** 插入单张照片 */
function seedPhoto(opts: {
  id: string;
  burstId?: string | null;
  isRep?: boolean;
  takenAt?: string;
  fileSize?: number;
}): void {
  const takenAt = opts.takenAt ?? new Date(now.getTime() + Math.random() * 10000).toISOString();
  testSqlite
    .prepare(
      `INSERT INTO photos
        (id, storage_source_id, file_path, file_hash, file_size,
         taken_at, created_at, burst_id, is_burst_representative)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      SOURCE_ID,
      `/photos/${opts.id}.jpg`,
      `hash-${opts.id}`,
      opts.fileSize ?? 1000,
      takenAt,
      now.toISOString(),
      opts.burstId ?? null,
      opts.isRep ? 1 : 0,
    );
}

/** 插入 burst 记录 */
function seedBurst(opts: {
  id: string;
  repPhotoId: string;
  memberCount: number;
  manualOverride?: boolean;
}): void {
  testSqlite
    .prepare(
      `INSERT INTO bursts
        (id, storage_source_id, representative_photo_id, member_count, manual_override, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      SOURCE_ID,
      opts.repPhotoId,
      opts.memberCount,
      opts.manualOverride ? 1 : 0,
      now.toISOString(),
    );
}

// =========================================================================
// GET /api/bursts/:id/members
// =========================================================================

describe("GET /api/bursts/:id/members", () => {
  it("返回 { success: true, data: Photo[] }（标准 ApiResponse 结构）", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 3 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true, takenAt: "2024-01-01T10:00:01Z" });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false, takenAt: "2024-01-01T10:00:02Z" });
    seedPhoto({ id: "p3", burstId: "burst-1", isRep: false, takenAt: "2024-01-01T10:00:03Z" });

    const { status, body } = await request("GET", "/api/bursts/burst-1/members");
    expect(status).toBe(200);
    const b = body as { success: boolean; data: unknown[] };
    expect(b.success).toBe(true);
    expect(Array.isArray(b.data)).toBe(true);
  });

  it("返回 3 张成员照片（长度 = memberCount）", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 3 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true, takenAt: "2024-01-01T10:00:01Z" });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false, takenAt: "2024-01-01T10:00:02Z" });
    seedPhoto({ id: "p3", burstId: "burst-1", isRep: false, takenAt: "2024-01-01T10:00:03Z" });

    const { status, body } = await request("GET", "/api/bursts/burst-1/members");
    expect(status).toBe(200);
    const b = body as { success: boolean; data: unknown[] };
    expect(b.data).toHaveLength(3);
  });

  it("成员按 takenAt asc 排序", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p3", memberCount: 3 });
    // 故意乱序插入
    seedPhoto({ id: "p3", burstId: "burst-1", isRep: true, takenAt: "2024-01-01T10:00:03Z" });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: false, takenAt: "2024-01-01T10:00:01Z" });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false, takenAt: "2024-01-01T10:00:02Z" });

    const { status, body } = await request("GET", "/api/bursts/burst-1/members");
    expect(status).toBe(200);
    const data = (body as { data: Array<{ id: string; takenAt?: string }> }).data;
    const ids = data.map((p) => p.id);
    expect(ids).toEqual(["p1", "p2", "p3"]);
  });

  it("不存在的 burst id 应返回 404", async () => {
    const { status, body } = await request("GET", "/api/bursts/nonexistent/members");
    expect(status).toBe(404);
    expect((body as { success: boolean }).success).toBe(false);
  });

  it("每张成员应包含 id 字段", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 2 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true, takenAt: "2024-01-01T10:00:01Z" });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false, takenAt: "2024-01-01T10:00:02Z" });

    const { body } = await request("GET", "/api/bursts/burst-1/members");
    const data = (body as { data: Array<{ id: string }> }).data;
    for (const photo of data) {
      expect(typeof photo.id).toBe("string");
    }
  });
});

// =========================================================================
// PATCH /api/bursts/:id/representative
// =========================================================================

describe("PATCH /api/bursts/:id/representative", () => {
  // -----------------------------------------------------------------------
  // Happy Path
  // -----------------------------------------------------------------------
  it("成功切换代表：返回 200 + success: true", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 3 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false });
    seedPhoto({ id: "p3", burstId: "burst-1", isRep: false });

    const { status, body } = await request("PATCH", "/api/bursts/burst-1/representative", {
      photoId: "p2",
    });
    expect(status).toBe(200);
    expect((body as { success: boolean }).success).toBe(true);
  });

  it("切换后 bursts.representative_photo_id 更新为新 photoId", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 3 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false });
    seedPhoto({ id: "p3", burstId: "burst-1", isRep: false });

    await request("PATCH", "/api/bursts/burst-1/representative", { photoId: "p2" });

    const burst = testSqlite
      .prepare("SELECT representative_photo_id FROM bursts WHERE id = ?")
      .get("burst-1") as { representative_photo_id: string };
    expect(burst.representative_photo_id).toBe("p2");
  });

  it("切换后 bursts.manual_override = 1", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 3, manualOverride: false });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false });

    await request("PATCH", "/api/bursts/burst-1/representative", { photoId: "p2" });

    const burst = testSqlite
      .prepare("SELECT manual_override FROM bursts WHERE id = ?")
      .get("burst-1") as { manual_override: number };
    expect(burst.manual_override).toBe(1);
  });

  it("原代表 is_burst_representative 应变为 0", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 3 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false });

    await request("PATCH", "/api/bursts/burst-1/representative", { photoId: "p2" });

    const p1 = testSqlite
      .prepare("SELECT is_burst_representative FROM photos WHERE id = ?")
      .get("p1") as { is_burst_representative: number };
    expect(p1.is_burst_representative).toBe(0);
  });

  it("新代表 is_burst_representative 应变为 1", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 3 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false });

    await request("PATCH", "/api/bursts/burst-1/representative", { photoId: "p2" });

    const p2 = testSqlite
      .prepare("SELECT is_burst_representative FROM photos WHERE id = ?")
      .get("p2") as { is_burst_representative: number };
    expect(p2.is_burst_representative).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 边界：photoId 不属于该组
  // -----------------------------------------------------------------------
  it("photoId 不属于该 burst → 返回 400 或 404", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 2 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false });
    // p-outsider 不属于 burst-1
    seedPhoto({ id: "p-outsider", burstId: null, isRep: false });

    const { status } = await request("PATCH", "/api/bursts/burst-1/representative", {
      photoId: "p-outsider",
    });
    expect([400, 404]).toContain(status);
  });

  it("不存在的 burst id → 返回 404 或 400", async () => {
    const { status } = await request("PATCH", "/api/bursts/nonexistent/representative", {
      photoId: "p1",
    });
    expect([400, 404]).toContain(status);
  });

  // -----------------------------------------------------------------------
  // 输入校验（Zod）
  // -----------------------------------------------------------------------
  it("body 缺少 photoId → 400（Zod 校验失败）", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 2 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });

    const { status, body } = await request("PATCH", "/api/bursts/burst-1/representative", {});
    expect(status).toBe(400);
    expect((body as { success: boolean }).success).toBe(false);
  });

  it("body.photoId 为数字（非 string）→ 400（Zod 校验失败）", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 2 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });

    const { status, body } = await request("PATCH", "/api/bursts/burst-1/representative", {
      photoId: 12345,
    });
    expect(status).toBe(400);
    expect((body as { success: boolean }).success).toBe(false);
  });

  it("body.photoId 为 null → 400（Zod 校验失败）", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 2 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });

    const { status, body } = await request("PATCH", "/api/bursts/burst-1/representative", {
      photoId: null,
    });
    expect(status).toBe(400);
    expect((body as { success: boolean }).success).toBe(false);
  });

  it("body 为空字符串（非 JSON）→ 不应返回 500", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 2 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });

    const res = await app.request("/api/bursts/burst-1/representative", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).not.toBe(500);
  });
});

// =========================================================================
// GET /api/photos — burst 过滤契约
// =========================================================================

describe("GET /api/photos — burst 过滤契约", () => {
  it("默认应过滤掉非代表成员（burst_id 非 NULL 且 is_burst_representative=0）", async () => {
    // burst-1：p1 = 代表，p2/p3 = 非代表成员
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 3 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false });
    seedPhoto({ id: "p3", burstId: "burst-1", isRep: false });

    const { status, body } = await request("GET", "/api/photos?pageSize=50");
    expect(status).toBe(200);
    const b = body as { success: boolean; data: Array<{ id: string }> };
    expect(b.success).toBe(true);

    const ids = b.data.map((p) => p.id);
    // p2、p3 不应出现
    expect(ids).not.toContain("p2");
    expect(ids).not.toContain("p3");
  });

  it("代表照片应出现在列表中", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 3 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false });
    seedPhoto({ id: "p3", burstId: "burst-1", isRep: false });

    const { body } = await request("GET", "/api/photos?pageSize=50");
    const b = body as { data: Array<{ id: string }> };
    const ids = b.data.map((p) => p.id);
    expect(ids).toContain("p1");
  });

  it("非连拍照片（burst_id IS NULL）应出现在列表中", async () => {
    // 5 张独立照片
    for (let i = 1; i <= 5; i++) {
      seedPhoto({ id: `solo-${i}`, burstId: null, isRep: false });
    }

    const { body } = await request("GET", "/api/photos?pageSize=50");
    const b = body as { data: Array<{ id: string }> };
    const ids = b.data.map((p) => p.id);
    for (let i = 1; i <= 5; i++) {
      expect(ids).toContain(`solo-${i}`);
    }
  });

  it("返回字段应包含 burstSize（代表卡片 > 1，单图 = 1）", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 4 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false });
    seedPhoto({ id: "p3", burstId: "burst-1", isRep: false });
    seedPhoto({ id: "p4", burstId: "burst-1", isRep: false });
    seedPhoto({ id: "solo-1", burstId: null, isRep: false });

    const { body } = await request("GET", "/api/photos?pageSize=50");
    const b = body as { data: Array<{ id: string; burstSize?: number }> };

    const rep = b.data.find((p) => p.id === "p1");
    expect(rep).toBeDefined();
    expect(rep?.burstSize).toBeGreaterThan(1);

    const solo = b.data.find((p) => p.id === "solo-1");
    expect(solo).toBeDefined();
    // 单图 burstSize 应为 1 或不存在（允许省略 1 的情况）
    expect(solo?.burstSize === 1 || solo?.burstSize === undefined).toBe(true);
  });

  it("混合场景：3 张连拍 + 5 张独立 → 列表返回 1+5=6 张", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "rep-1", memberCount: 3 });
    seedPhoto({ id: "rep-1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "mem-2", burstId: "burst-1", isRep: false });
    seedPhoto({ id: "mem-3", burstId: "burst-1", isRep: false });
    for (let i = 1; i <= 5; i++) {
      seedPhoto({ id: `solo-${i}`, burstId: null, isRep: false });
    }

    const { body } = await request("GET", "/api/photos?pageSize=50");
    const b = body as { data: Array<{ id: string }> };
    expect(b.data).toHaveLength(6);
  });

  it("total 字段应反映过滤后的计数（不含被过滤的非代表成员）", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 3 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false });
    seedPhoto({ id: "p3", burstId: "burst-1", isRep: false });

    const { body } = await request("GET", "/api/photos?pageSize=50");
    const b = body as { total: number; data: unknown[] };
    // total 应为 1（只有代表），不是 3（所有成员）
    expect(b.total).toBe(1);
    expect(b.data).toHaveLength(1);
  });
});

// =========================================================================
// bursts 路由集成到 app（路由注册验证）
// =========================================================================

describe("bursts 路由注册完整性", () => {
  it("GET /api/bursts/:id/members 路由应存在（非 404）", async () => {
    // 即使 burst 不存在，路由本身必须响应（非"路由未注册"404）
    // 已有 burst 时肯定 200，不存在时应为 404（业务 404），两者都非"路由不存在"
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 1 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });

    const { status } = await request("GET", "/api/bursts/burst-1/members");
    // 路由存在且有数据 → 200
    expect(status).toBe(200);
  });

  it("PATCH /api/bursts/:id/representative 路由应存在（非 404）", async () => {
    seedBurst({ id: "burst-1", repPhotoId: "p1", memberCount: 2 });
    seedPhoto({ id: "p1", burstId: "burst-1", isRep: true });
    seedPhoto({ id: "p2", burstId: "burst-1", isRep: false });

    const { status } = await request("PATCH", "/api/bursts/burst-1/representative", {
      photoId: "p2",
    });
    // 路由存在且参数合法 → 200
    expect(status).toBe(200);
  });
});

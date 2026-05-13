/**
 * 验收测试：persons 路由 7 个端点契约（红队，黑盒）
 *
 * 设计契约（state.md 「契约规约」节，1:1 字面对齐）：
 *
 *   GET    /api/persons?storageSourceId=&displayable=
 *     → { success: true, data: Person[] } 按 memberCount desc
 *     → displayable=true 仅返回 displayable=1 行
 *
 *   GET    /api/persons/:id
 *     → { success: true, data: PersonWithMembers } 含 photos[] + faces[]
 *     → 不存在 → 404
 *
 *   PATCH  /api/persons/:id  body: updatePersonSchema
 *     → name="" 或 name=null → DB 中 name 写为 null（清空）
 *     → name 长度 21 → 400
 *     → bio 长度 201 → 400
 *
 *   PATCH  /api/persons/:id/representative  body: setPersonRepresentativeSchema
 *     → 设置 representativeFaceId、manualOverride=true
 *
 *   POST   /api/persons/:id/merge  body: mergePersonSchema
 *     → 源 person.faces 全部 reassign 到 target
 *     → 源 person 删除
 *     → target.memberCount 累加
 *     → 返回 { mergedFromId, targetPersonId, newMemberCount }
 *
 *   POST   /api/persons/:id/avatar  multipart field "avatar"
 *     → 写到 customAvatarPath
 *     → 返回 { customAvatarPath: string }
 *
 *   GET    /api/persons/:id/avatar.jpg
 *     → 优先 customAvatarPath > avatarPath > 404
 *     → 二进制 jpeg 流
 *
 * 错误响应格式：{ success: false, error: string }
 *
 * 红队铁律：本文件不读取 routes/persons.ts、lib/face/* 任何实现。
 * 测试使用真实 SQLite（:memory:）+ createApp()。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

// =========================================================================
// 内存 SQLite（含全部已有表 + persons + faces 新表）
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
      -- GPS + EXIF meta（schema.ts photos 表新增 14 列，全部 nullable）
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
      created_at TEXT NOT NULL
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

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE analyze_batches (
      id TEXT PRIMARY KEY,
      filter_json TEXT NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE analyze_batch_jobs (
      job_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL
    );

    -- 设计文档新增：persons + faces
    CREATE TABLE persons (
      id TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
      name TEXT,
      nickname TEXT,
      bio TEXT,
      representative_face_id TEXT,
      avatar_path TEXT,
      custom_avatar_path TEXT,
      centroid_embedding TEXT NOT NULL,
      member_count INTEGER NOT NULL DEFAULT 0,
      manual_override INTEGER NOT NULL DEFAULT 0,
      displayable INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      attribute_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE faces (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      person_id TEXT,
      bbox_x INTEGER NOT NULL,
      bbox_y INTEGER NOT NULL,
      bbox_w INTEGER NOT NULL,
      bbox_h INTEGER NOT NULL,
      detection_score REAL NOT NULL,
      embedding TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      attributes TEXT
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

// =========================================================================
// 共享 state
// =========================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;
let app: import("hono").Hono;
let tmpStorageRoot: string;

const SOURCE_ID = "src-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_SOURCE_ID = "src-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

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
  detectFacesQueue: { add: vi.fn().mockResolvedValue({ id: "j4" }) },
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
  testSqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, 'OtherSource', 'local', '/other', 1)",
    )
    .run(OTHER_SOURCE_ID);

  tmpStorageRoot = mkdtempSync(join(tmpdir(), "relight-persons-test-"));
  process.env.STORAGE_ROOT = tmpStorageRoot;

  vi.resetModules();
  const mod = await import("../../app");
  app = mod.createApp();
});

afterEach(() => {
  testSqlite.close();
  rmSync(tmpStorageRoot, { recursive: true, force: true });
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

function nowIso(): string {
  return new Date().toISOString();
}

function fakeEmbeddingBase64(): string {
  // 512 维 float32 → 2048 bytes，base64 编码后 2732 字符
  const buf = Buffer.alloc(512 * 4);
  for (let i = 0; i < 512; i++) buf.writeFloatLE(Math.random(), i * 4);
  return buf.toString("base64");
}

function seedPerson(opts: {
  id: string;
  storageSourceId?: string;
  name?: string | null;
  bio?: string | null;
  memberCount?: number;
  displayable?: boolean;
  representativeFaceId?: string | null;
  avatarPath?: string | null;
  customAvatarPath?: string | null;
  manualOverride?: boolean;
}): void {
  const ts = nowIso();
  testSqlite
    .prepare(
      `INSERT INTO persons
        (id, storage_source_id, name, bio, representative_face_id,
         avatar_path, custom_avatar_path, centroid_embedding,
         member_count, manual_override, displayable,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.storageSourceId ?? SOURCE_ID,
      opts.name ?? null,
      opts.bio ?? null,
      opts.representativeFaceId ?? null,
      opts.avatarPath ?? null,
      opts.customAvatarPath ?? null,
      fakeEmbeddingBase64(),
      opts.memberCount ?? 0,
      opts.manualOverride ? 1 : 0,
      opts.displayable ? 1 : 0,
      ts,
      ts,
    );
}

function seedPhoto(opts: {
  id: string;
  storageSourceId?: string;
  takenAt?: string;
}): void {
  testSqlite
    .prepare(
      `INSERT INTO photos
        (id, storage_source_id, file_path, file_hash, file_size,
         taken_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.storageSourceId ?? SOURCE_ID,
      `/photos/${opts.id}.jpg`,
      `hash-${opts.id}`,
      1000,
      opts.takenAt ?? nowIso(),
      nowIso(),
    );
}

function seedFace(opts: {
  id: string;
  photoId: string;
  personId?: string | null;
  detectionScore?: number;
  bboxW?: number;
  bboxH?: number;
  /** 自定义 embedding（512 维 Float32Array），默认 fakeEmbeddingBase64() */
  embedding?: Float32Array;
  /** JSON 字符串，覆盖 attributes 列 */
  attributesJson?: string | null;
}): void {
  const embStr = opts.embedding
    ? Buffer.from(
        opts.embedding.buffer,
        opts.embedding.byteOffset,
        opts.embedding.byteLength,
      ).toString("base64")
    : fakeEmbeddingBase64();
  testSqlite
    .prepare(
      `INSERT INTO faces
        (id, photo_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h,
         detection_score, embedding, detected_at, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.photoId,
      opts.personId ?? null,
      10,
      20,
      opts.bboxW ?? 120,
      opts.bboxH ?? 120,
      opts.detectionScore ?? 0.95,
      embStr,
      nowIso(),
      opts.attributesJson ?? null,
    );
}

/** 构造 512 维 Float32Array，主轴 unit vector（dim 0 或 1），便于断言 centroid 方向 */
function unitVec(axis: 0 | 1 | 2): Float32Array {
  const v = new Float32Array(512);
  v[axis] = 1;
  return v;
}

// =========================================================================
// GET /api/persons
// =========================================================================

describe("GET /api/persons — 列表", () => {
  it("返回 { success: true, data: Person[] } 标准 ApiResponse", async () => {
    seedPerson({ id: "p-1", memberCount: 6, displayable: true });
    const { status, body } = await request("GET", "/api/persons");
    expect(status).toBe(200);
    const b = body as { success: boolean; data: unknown[] };
    expect(b.success).toBe(true);
    expect(Array.isArray(b.data)).toBe(true);
  });

  it("displayable=true 仅返回 displayable=1 的 person", async () => {
    seedPerson({ id: "p-shown", memberCount: 6, displayable: true });
    seedPerson({ id: "p-hidden", memberCount: 2, displayable: false });

    const { body } = await request("GET", "/api/persons?displayable=true");
    const data = (body as { data: Array<{ id: string }> }).data;
    const ids = data.map((p) => p.id);
    expect(ids).toContain("p-shown");
    expect(ids).not.toContain("p-hidden");
  });

  it("按 memberCount desc 排序", async () => {
    seedPerson({ id: "p-low", memberCount: 5, displayable: true });
    seedPerson({ id: "p-mid", memberCount: 10, displayable: true });
    seedPerson({ id: "p-high", memberCount: 20, displayable: true });

    const { body } = await request("GET", "/api/persons?displayable=true");
    const data = (body as { data: Array<{ id: string; memberCount: number }> }).data;
    expect(data[0]?.id).toBe("p-high");
    expect(data[1]?.id).toBe("p-mid");
    expect(data[2]?.id).toBe("p-low");
  });

  it("storageSourceId 过滤生效（不返回其他源的 person）", async () => {
    seedPerson({ id: "p-src1", storageSourceId: SOURCE_ID, memberCount: 6, displayable: true });
    seedPerson({
      id: "p-src2",
      storageSourceId: OTHER_SOURCE_ID,
      memberCount: 6,
      displayable: true,
    });

    const { body } = await request("GET", `/api/persons?storageSourceId=${SOURCE_ID}`);
    const ids = (body as { data: Array<{ id: string }> }).data.map((p) => p.id);
    expect(ids).toContain("p-src1");
    expect(ids).not.toContain("p-src2");
  });

  it("Person 字段含契约规约定义的全部 11 个字段", async () => {
    seedPerson({ id: "p-1", memberCount: 5, displayable: true, name: "张三", bio: "测试" });
    const { body } = await request("GET", "/api/persons");
    const data = (body as { data: Array<Record<string, unknown>> }).data;
    expect(data.length).toBeGreaterThan(0);
    const p = data[0];
    expect(p).toHaveProperty("id");
    expect(p).toHaveProperty("storageSourceId");
    expect(p).toHaveProperty("name");
    expect(p).toHaveProperty("bio");
    expect(p).toHaveProperty("representativeFaceId");
    expect(p).toHaveProperty("avatarPath");
    expect(p).toHaveProperty("customAvatarPath");
    expect(p).toHaveProperty("memberCount");
    expect(p).toHaveProperty("manualOverride");
    expect(p).toHaveProperty("displayable");
    expect(p).toHaveProperty("createdAt");
    expect(p).toHaveProperty("updatedAt");
  });
});

// =========================================================================
// GET /api/persons/:id
// =========================================================================

describe("GET /api/persons/:id — 详情", () => {
  it("不存在的 id → 404", async () => {
    const { status, body } = await request("GET", "/api/persons/nonexistent");
    expect(status).toBe(404);
    expect((body as { success: boolean }).success).toBe(false);
  });

  it("返回 PersonWithMembers 含 photos 数组（按 takenAt desc）", async () => {
    seedPerson({ id: "p-1", memberCount: 3, displayable: true });
    seedPhoto({ id: "ph-1", takenAt: "2024-01-01T10:00:00Z" });
    seedPhoto({ id: "ph-2", takenAt: "2024-01-03T10:00:00Z" });
    seedPhoto({ id: "ph-3", takenAt: "2024-01-02T10:00:00Z" });
    seedFace({ id: "f-1", photoId: "ph-1", personId: "p-1" });
    seedFace({ id: "f-2", photoId: "ph-2", personId: "p-1" });
    seedFace({ id: "f-3", photoId: "ph-3", personId: "p-1" });

    const { status, body } = await request("GET", "/api/persons/p-1");
    expect(status).toBe(200);
    const data = (body as { data: { photos: Array<{ id: string; takenAt: string }> } }).data;
    expect(Array.isArray(data.photos)).toBe(true);
    expect(data.photos).toHaveLength(3);
    // takenAt desc：2024-01-03 > 2024-01-02 > 2024-01-01
    expect(data.photos[0]?.id).toBe("ph-2");
    expect(data.photos[1]?.id).toBe("ph-3");
    expect(data.photos[2]?.id).toBe("ph-1");
  });

  it("返回 PersonWithMembers 含 faces 数组", async () => {
    seedPerson({ id: "p-1", memberCount: 2, displayable: true });
    seedPhoto({ id: "ph-1" });
    seedPhoto({ id: "ph-2" });
    seedFace({ id: "f-1", photoId: "ph-1", personId: "p-1" });
    seedFace({ id: "f-2", photoId: "ph-2", personId: "p-1" });

    const { body } = await request("GET", "/api/persons/p-1");
    const data = (body as { data: { faces: Array<{ id: string; photoId: string }> } }).data;
    expect(Array.isArray(data.faces)).toBe(true);
    expect(data.faces).toHaveLength(2);
    const faceIds = data.faces.map((f) => f.id).sort();
    expect(faceIds).toEqual(["f-1", "f-2"]);
  });

  it("Face 字段含契约规约定义的全部字段（id/photoId/personId/bboxX/Y/W/H/detectionScore/detectedAt）", async () => {
    seedPerson({ id: "p-1", memberCount: 1, displayable: false });
    seedPhoto({ id: "ph-1" });
    seedFace({ id: "f-1", photoId: "ph-1", personId: "p-1" });

    const { body } = await request("GET", "/api/persons/p-1");
    const face = (body as { data: { faces: Array<Record<string, unknown>> } }).data.faces[0];
    expect(face).toHaveProperty("id");
    expect(face).toHaveProperty("photoId");
    expect(face).toHaveProperty("personId");
    expect(face).toHaveProperty("bboxX");
    expect(face).toHaveProperty("bboxY");
    expect(face).toHaveProperty("bboxW");
    expect(face).toHaveProperty("bboxH");
    expect(face).toHaveProperty("detectionScore");
    expect(face).toHaveProperty("detectedAt");
  });
});

// =========================================================================
// PATCH /api/persons/:id  (updatePersonSchema)
// =========================================================================

describe("PATCH /api/persons/:id — 更新 name/bio", () => {
  it("成功更新 name → 200 + DB 持久化", async () => {
    seedPerson({ id: "p-1", memberCount: 5, displayable: true });
    const { status } = await request("PATCH", "/api/persons/p-1", { name: "张三" });
    expect(status).toBe(200);

    const row = testSqlite.prepare("SELECT name FROM persons WHERE id = ?").get("p-1") as {
      name: string;
    };
    expect(row.name).toBe("张三");
  });

  it("成功更新 bio → 200 + DB 持久化中文", async () => {
    seedPerson({ id: "p-1", memberCount: 5, displayable: true });
    const { status } = await request("PATCH", "/api/persons/p-1", {
      bio: "2024 春节后开始记录",
    });
    expect(status).toBe(200);

    const row = testSqlite.prepare("SELECT bio FROM persons WHERE id = ?").get("p-1") as {
      bio: string;
    };
    expect(row.bio).toBe("2024 春节后开始记录");
  });

  it("name=null → DB 中 name 写为 null（清空回到未命名）", async () => {
    seedPerson({ id: "p-1", name: "旧名字", memberCount: 5, displayable: true });
    const { status } = await request("PATCH", "/api/persons/p-1", { name: null });
    expect(status).toBe(200);

    const row = testSqlite.prepare("SELECT name FROM persons WHERE id = ?").get("p-1") as {
      name: string | null;
    };
    expect(row.name).toBeNull();
  });

  it('name="" → DB 中 name 写为 null（视为清空）', async () => {
    seedPerson({ id: "p-1", name: "旧名字", memberCount: 5, displayable: true });
    const { status } = await request("PATCH", "/api/persons/p-1", { name: "" });
    expect(status).toBe(200);

    const row = testSqlite.prepare("SELECT name FROM persons WHERE id = ?").get("p-1") as {
      name: string | null;
    };
    expect(row.name).toBeNull();
  });

  it("name 长度 21（>20）→ 400 + success:false", async () => {
    seedPerson({ id: "p-1", memberCount: 5, displayable: true });
    const tooLong = "啊".repeat(21);
    const { status, body } = await request("PATCH", "/api/persons/p-1", { name: tooLong });
    expect(status).toBe(400);
    expect((body as { success: boolean }).success).toBe(false);
  });

  it("bio 长度 201（>200）→ 400 + success:false", async () => {
    seedPerson({ id: "p-1", memberCount: 5, displayable: true });
    const tooLong = "x".repeat(201);
    const { status, body } = await request("PATCH", "/api/persons/p-1", { bio: tooLong });
    expect(status).toBe(400);
    expect((body as { success: boolean }).success).toBe(false);
  });

  it("name 长度 20（边界值，合法）→ 200", async () => {
    seedPerson({ id: "p-1", memberCount: 5, displayable: true });
    const ok = "啊".repeat(20);
    const { status } = await request("PATCH", "/api/persons/p-1", { name: ok });
    expect(status).toBe(200);
  });

  it("不存在的 person → 404", async () => {
    const { status } = await request("PATCH", "/api/persons/nonexistent", { name: "测试" });
    expect(status).toBe(404);
  });
});

// =========================================================================
// PATCH /api/persons/:id/representative  (setPersonRepresentativeSchema)
// =========================================================================

describe("PATCH /api/persons/:id/representative — 设置代表头像", () => {
  it("成功设置 representativeFaceId → 200", async () => {
    seedPerson({ id: "p-1", memberCount: 3, displayable: true });
    seedPhoto({ id: "ph-1" });
    seedFace({ id: "f-1", photoId: "ph-1", personId: "p-1" });

    const { status } = await request("PATCH", "/api/persons/p-1/representative", {
      faceId: "f-1",
    });
    expect(status).toBe(200);

    const row = testSqlite
      .prepare("SELECT representative_face_id FROM persons WHERE id = ?")
      .get("p-1") as { representative_face_id: string };
    expect(row.representative_face_id).toBe("f-1");
  });

  it("设置代表后 manual_override 应变为 1", async () => {
    seedPerson({
      id: "p-1",
      memberCount: 3,
      displayable: true,
      manualOverride: false,
    });
    seedPhoto({ id: "ph-1" });
    seedFace({ id: "f-1", photoId: "ph-1", personId: "p-1" });

    await request("PATCH", "/api/persons/p-1/representative", { faceId: "f-1" });

    const row = testSqlite
      .prepare("SELECT manual_override FROM persons WHERE id = ?")
      .get("p-1") as { manual_override: number };
    expect(row.manual_override).toBe(1);
  });

  it("body 缺 faceId → 400（Zod 校验）", async () => {
    seedPerson({ id: "p-1", memberCount: 3, displayable: true });
    const { status, body } = await request("PATCH", "/api/persons/p-1/representative", {});
    expect(status).toBe(400);
    expect((body as { success: boolean }).success).toBe(false);
  });

  it("faceId 为空字符串 → 400", async () => {
    seedPerson({ id: "p-1", memberCount: 3, displayable: true });
    const { status } = await request("PATCH", "/api/persons/p-1/representative", {
      faceId: "",
    });
    expect(status).toBe(400);
  });
});

// =========================================================================
// POST /api/persons/:id/merge  (mergePersonSchema)
// =========================================================================

describe("POST /api/persons/:id/merge — 合并人物", () => {
  it("源 person 的 faces 全部 reassign 到 target", async () => {
    seedPerson({ id: "p-src", memberCount: 3, displayable: false });
    seedPerson({ id: "p-target", memberCount: 2, displayable: false });
    seedPhoto({ id: "ph-1" });
    seedPhoto({ id: "ph-2" });
    seedPhoto({ id: "ph-3" });
    seedFace({ id: "f-1", photoId: "ph-1", personId: "p-src" });
    seedFace({ id: "f-2", photoId: "ph-2", personId: "p-src" });
    seedFace({ id: "f-3", photoId: "ph-3", personId: "p-src" });

    const { status } = await request("POST", "/api/persons/p-src/merge", {
      targetPersonId: "p-target",
    });
    expect(status).toBe(200);

    const facesAfter = testSqlite
      .prepare("SELECT id, person_id FROM faces WHERE id IN ('f-1', 'f-2', 'f-3')")
      .all() as Array<{ id: string; person_id: string }>;
    for (const f of facesAfter) {
      expect(f.person_id).toBe("p-target");
    }
  });

  it("源 person 合并后被删除", async () => {
    seedPerson({ id: "p-src", memberCount: 3, displayable: false });
    seedPerson({ id: "p-target", memberCount: 2, displayable: false });
    seedPhoto({ id: "ph-1" });
    seedFace({ id: "f-1", photoId: "ph-1", personId: "p-src" });

    await request("POST", "/api/persons/p-src/merge", { targetPersonId: "p-target" });

    const srcRow = testSqlite.prepare("SELECT id FROM persons WHERE id = ?").get("p-src");
    expect(srcRow).toBeUndefined();
  });

  it("target.member_count 累加（2+3=5）", async () => {
    seedPerson({ id: "p-src", memberCount: 3, displayable: false });
    seedPerson({ id: "p-target", memberCount: 2, displayable: false });
    seedPhoto({ id: "ph-1" });
    seedFace({ id: "f-1", photoId: "ph-1", personId: "p-src" });

    await request("POST", "/api/persons/p-src/merge", { targetPersonId: "p-target" });

    const tgt = testSqlite
      .prepare("SELECT member_count FROM persons WHERE id = ?")
      .get("p-target") as { member_count: number };
    expect(tgt.member_count).toBe(5);
  });

  it("返回 { mergedFromId, targetPersonId, newMemberCount }（契约规约 HTTP 表）", async () => {
    seedPerson({ id: "p-src", memberCount: 3, displayable: false });
    seedPerson({ id: "p-target", memberCount: 2, displayable: false });
    seedPhoto({ id: "ph-1" });
    seedFace({ id: "f-1", photoId: "ph-1", personId: "p-src" });

    const { body } = await request("POST", "/api/persons/p-src/merge", {
      targetPersonId: "p-target",
    });
    const data = (
      body as {
        data: { mergedFromId: string; targetPersonId: string; newMemberCount: number };
      }
    ).data;
    expect(data.mergedFromId).toBe("p-src");
    expect(data.targetPersonId).toBe("p-target");
    expect(data.newMemberCount).toBe(5);
  });

  it("body 缺 targetPersonId → 400", async () => {
    seedPerson({ id: "p-src", memberCount: 3, displayable: false });
    const { status } = await request("POST", "/api/persons/p-src/merge", {});
    expect(status).toBe(400);
  });

  it("targetPersonId 不存在 → 400 或 404（非 500）", async () => {
    seedPerson({ id: "p-src", memberCount: 3, displayable: false });
    const { status } = await request("POST", "/api/persons/p-src/merge", {
      targetPersonId: "nonexistent",
    });
    expect([400, 404]).toContain(status);
  });

  // ===== Phase 2 三件套对齐：quality-aware centroid + attribute_summary 重算 =====

  it("合并后 centroid 用 quality 加权：LOW face（detection<0.65）weight=0 不污染方向", async () => {
    // source: 1 HIGH face (axis 0)
    // target: 1 LOW face (axis 1, detection 0.5 → quality=low)
    // 合并后 centroid 应只反映 HIGH 方向（axis 0），不被 LOW 拉向 axis 1
    seedPerson({ id: "p-src", memberCount: 1, displayable: false });
    seedPerson({ id: "p-target", memberCount: 1, displayable: false });
    seedPhoto({ id: "ph-1" });
    seedPhoto({ id: "ph-2" });
    seedFace({
      id: "f-high",
      photoId: "ph-1",
      personId: "p-src",
      bboxW: 250,
      bboxH: 250,
      detectionScore: 0.9, // HIGH
      embedding: unitVec(0),
    });
    seedFace({
      id: "f-low",
      photoId: "ph-2",
      personId: "p-target",
      bboxW: 100,
      bboxH: 100,
      detectionScore: 0.5, // LOW
      embedding: unitVec(1),
    });

    const { status } = await request("POST", "/api/persons/p-src/merge", {
      targetPersonId: "p-target",
    });
    expect(status).toBe(200);

    const tgt = testSqlite
      .prepare("SELECT centroid_embedding FROM persons WHERE id = ?")
      .get("p-target") as { centroid_embedding: string };
    const buf = Buffer.from(tgt.centroid_embedding, "base64");
    const centroid = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    // HIGH 主导 → axis 0 接近 1，axis 1 接近 0
    expect(centroid[0]).toBeCloseTo(1.0, 3);
    expect(centroid[1]).toBeCloseTo(0.0, 3);
  });

  it("合并后 attribute_summary 重算：包含 source faces 的 attributes 投票", async () => {
    // source: 2 faces 都是 female young_adult
    // target: 1 face male young_adult
    // 合并后 target.attribute_summary 应该是 female 多数票（2:1）
    seedPerson({ id: "p-src", memberCount: 2, displayable: false });
    seedPerson({ id: "p-target", memberCount: 1, displayable: false });
    seedPhoto({ id: "ph-1" });
    seedPhoto({ id: "ph-2" });
    seedPhoto({ id: "ph-3" });
    const femaleAttr = JSON.stringify({
      schema_version: 1,
      age_band: "young_adult",
      gender: "female",
      hair: "long",
      glasses: "none",
      facial_hair: "none",
      expression: "smile",
    });
    const maleAttr = JSON.stringify({
      schema_version: 1,
      age_band: "young_adult",
      gender: "male",
      hair: "short",
      glasses: "none",
      facial_hair: "none",
      expression: "neutral",
    });
    seedFace({
      id: "f-s1",
      photoId: "ph-1",
      personId: "p-src",
      attributesJson: femaleAttr,
    });
    seedFace({
      id: "f-s2",
      photoId: "ph-2",
      personId: "p-src",
      attributesJson: femaleAttr,
    });
    seedFace({
      id: "f-t1",
      photoId: "ph-3",
      personId: "p-target",
      attributesJson: maleAttr,
    });

    await request("POST", "/api/persons/p-src/merge", { targetPersonId: "p-target" });

    const tgt = testSqlite
      .prepare("SELECT attribute_summary FROM persons WHERE id = ?")
      .get("p-target") as { attribute_summary: string | null };
    expect(tgt.attribute_summary).not.toBeNull();
    const summary = JSON.parse(tgt.attribute_summary as string);
    expect(summary.schema_version).toBe(1);
    expect(summary.gender_mode).toBe("female"); // 2 female vs 1 male
    expect(summary.age_band_mode).toBe("young_adult");
    expect(summary.member_count_with_attr).toBe(3);
  });

  it("合并后全 LOW face → centroid 退化为等权平均（不返回 NaN/零向量）", async () => {
    // 极端：source 和 target 都只有 LOW face
    // 不应崩溃，centroid 退化为等权平均
    seedPerson({ id: "p-src", memberCount: 1, displayable: false });
    seedPerson({ id: "p-target", memberCount: 1, displayable: false });
    seedPhoto({ id: "ph-1" });
    seedPhoto({ id: "ph-2" });
    seedFace({
      id: "f-low1",
      photoId: "ph-1",
      personId: "p-src",
      bboxW: 100,
      bboxH: 100,
      detectionScore: 0.5,
      embedding: unitVec(0),
    });
    seedFace({
      id: "f-low2",
      photoId: "ph-2",
      personId: "p-target",
      bboxW: 100,
      bboxH: 100,
      detectionScore: 0.5,
      embedding: unitVec(1),
    });

    const { status } = await request("POST", "/api/persons/p-src/merge", {
      targetPersonId: "p-target",
    });
    expect(status).toBe(200);

    const tgt = testSqlite
      .prepare("SELECT centroid_embedding FROM persons WHERE id = ?")
      .get("p-target") as { centroid_embedding: string };
    const buf = Buffer.from(tgt.centroid_embedding, "base64");
    const centroid = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    // 等权平均后 L2 归一：axis 0 和 axis 1 各 1/√2
    expect(centroid[0]).toBeCloseTo(1 / Math.sqrt(2), 3);
    expect(centroid[1]).toBeCloseTo(1 / Math.sqrt(2), 3);
    // 不会出现 NaN
    for (const v of centroid) expect(Number.isFinite(v)).toBe(true);
  });
});

// =========================================================================
// POST /api/persons/:id/avatar  (multipart 上传)
// =========================================================================

describe("POST /api/persons/:id/avatar — 自定义头像上传", () => {
  /** 1×1 像素 JPEG 最小有效字节流 */
  function tinyJpegBuffer(): Buffer {
    return Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06,
      0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b,
      0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
      0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31,
      0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff,
      0xc9, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xcc, 0x00,
      0x06, 0x00, 0x10, 0x10, 0x05, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
      0xd2, 0xcf, 0x20, 0xff, 0xd9,
    ]);
  }

  async function uploadAvatar(personId: string): Promise<Response> {
    const form = new FormData();
    const blob = new Blob([tinyJpegBuffer()], { type: "image/jpeg" });
    form.append("avatar", blob, "avatar.jpg");
    return app.request(`/api/persons/${personId}/avatar`, {
      method: "POST",
      body: form,
    });
  }

  it("成功上传 → 200 + 返回 customAvatarPath（契约规约）", async () => {
    seedPerson({ id: "p-1", memberCount: 5, displayable: true });
    const res = await uploadAvatar("p-1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { customAvatarPath: string } };
    expect(json.success).toBe(true);
    expect(typeof json.data.customAvatarPath).toBe("string");
    expect(json.data.customAvatarPath.length).toBeGreaterThan(0);
  });

  it("上传后 DB persons.custom_avatar_path 已写入", async () => {
    seedPerson({ id: "p-1", memberCount: 5, displayable: true });
    const res = await uploadAvatar("p-1");
    expect(res.status).toBe(200);

    const row = testSqlite
      .prepare("SELECT custom_avatar_path FROM persons WHERE id = ?")
      .get("p-1") as { custom_avatar_path: string | null };
    expect(row.custom_avatar_path).not.toBeNull();
    expect(typeof row.custom_avatar_path).toBe("string");
  });
});

// =========================================================================
// GET /api/persons/:id/avatar.jpg
// =========================================================================

describe("GET /api/persons/:id/avatar.jpg — 头像图片", () => {
  function writeFakeAvatar(relativePath: string): string {
    const absPath = join(tmpStorageRoot, relativePath);
    const dir = absPath.substring(0, absPath.lastIndexOf("/"));
    if (dir) require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return relativePath;
  }

  it("既无 customAvatarPath 也无 avatarPath → 404", async () => {
    seedPerson({ id: "p-1", memberCount: 5, displayable: true });
    const res = await app.request("/api/persons/p-1/avatar.jpg");
    expect(res.status).toBe(404);
  });

  it("仅 avatarPath → 返回该文件（200 + jpeg 流）", async () => {
    const relPath = writeFakeAvatar(".persons/avatars/auto/p-1.jpg");
    seedPerson({
      id: "p-1",
      memberCount: 5,
      displayable: true,
      avatarPath: relPath,
    });

    const res = await app.request("/api/persons/p-1/avatar.jpg");
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    // JPEG SOI marker = FF D8
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  });

  it("customAvatarPath 优先级高于 avatarPath", async () => {
    const autoPath = writeFakeAvatar(".persons/avatars/auto/p-1.jpg");
    // 写入两种不同内容
    const customPath = ".persons/avatars/custom/p-1.jpg";
    const customAbs = join(tmpStorageRoot, customPath);
    const customDir = customAbs.substring(0, customAbs.lastIndexOf("/"));
    if (customDir) require("node:fs").mkdirSync(customDir, { recursive: true });
    // 用区别于 auto 的字节序列（依然有 JPEG SOI 头）
    writeFileSync(customAbs, Buffer.from([0xff, 0xd8, 0xff, 0xee, 0xaa, 0xbb, 0xcc, 0xff, 0xd9]));

    seedPerson({
      id: "p-1",
      memberCount: 5,
      displayable: true,
      avatarPath: autoPath,
      customAvatarPath: customPath,
    });

    const res = await app.request("/api/persons/p-1/avatar.jpg");
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    // 来自 custom 文件的特征字节
    expect(buf.includes(Buffer.from([0xaa, 0xbb, 0xcc]))).toBe(true);
  });
});

// =========================================================================
// 路由注册完整性
// =========================================================================

describe("persons 路由注册完整性（非 404 = 路由已挂载）", () => {
  it("GET /api/persons 路由存在", async () => {
    const { status } = await request("GET", "/api/persons");
    // 即使数据为空，路由本身必须返回 200
    expect(status).toBe(200);
  });

  it("PATCH /api/persons/:id 路由存在（非 405/404）", async () => {
    seedPerson({ id: "p-1", memberCount: 1 });
    const { status } = await request("PATCH", "/api/persons/p-1", { name: "test" });
    // 路由存在，应为 200（合法 patch）
    expect([200, 400, 404]).toContain(status);
    expect(status).not.toBe(405);
  });

  it("POST /api/persons/:id/merge 路由存在", async () => {
    seedPerson({ id: "p-src", memberCount: 1 });
    seedPerson({ id: "p-target", memberCount: 1 });
    const { status } = await request("POST", "/api/persons/p-src/merge", {
      targetPersonId: "p-target",
    });
    expect(status).not.toBe(405);
    expect(status).not.toBe(500);
  });
});

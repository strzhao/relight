/**
 * persons API 契约测试。
 *
 * 用真实 SQLite + 测试 schema，验证：
 * - GET /api/persons 列表 + filter
 * - GET /api/persons/:id 详情（含 photos / faces）
 * - PATCH /api/persons/:id 更新 name/bio
 * - PATCH /api/persons/:id/representative
 * - POST /api/persons/:id/merge
 * - 4xx happy/sad path
 *
 * 不验证 detect-faces worker（那需要 ONNX 模型）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema";
import { encodeEmbedding } from "../lib/face/embedding-codec";
import { setupTestSchema } from "./helpers/test-schema";

let tmpDir: string;
let dbFile: string;
let sqlite: Database.Database;

function mkEmbedding(seed: number): string {
  const arr = new Float32Array(8);
  for (let i = 0; i < 8; i++) arr[i] = Math.sin(seed * (i + 1));
  // L2 normalize
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += (arr[i] ?? 0) ** 2;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < 8; i++) arr[i] = (arr[i] ?? 0) / norm;
  return encodeEmbedding(arr);
}

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "relight-persons-"));
  dbFile = path.join(tmpDir, "test.db");
  sqlite = new Database(dbFile);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);

  // mock db & queues 模块（用本测试 sqlite + 防止 BullMQ 连 Redis）
  const testDb = drizzle(sqlite, { schema });
  vi.doMock("../db", () => ({ db: testDb, schema }));
  vi.doMock("../jobs/queues", () => ({
    scanQueue: { add: vi.fn().mockResolvedValue({ id: "mock" }) },
    analyzeQueue: { add: vi.fn().mockResolvedValue({ id: "mock" }) },
    dailyQueue: { add: vi.fn().mockResolvedValue({ id: "mock" }) },
    detectFacesQueue: { add: vi.fn().mockResolvedValue({ id: "mock" }) },
  }));

  // 准备：1 storageSource、2 photos、2 persons、2 faces
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES ('s1', 'src', 'local', '/tmp', 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at, media_type)
       VALUES (?, 's1', ?, ?, 800, 600, 100, ?, ?, 'image')`,
    )
    .run("ph1", "/tmp/a.jpg", "h1", "2024-01-01T00:00:00Z", now);
  sqlite
    .prepare(
      `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at, media_type)
       VALUES (?, 's1', ?, ?, 800, 600, 100, ?, ?, 'image')`,
    )
    .run("ph2", "/tmp/b.jpg", "h2", "2024-02-01T00:00:00Z", now);
  // persons：person1 displayable=true memberCount=6, person2 displayable=false memberCount=3
  sqlite
    .prepare(
      `INSERT INTO persons (id, storage_source_id, name, bio, representative_face_id, avatar_path,
                            custom_avatar_path, centroid_embedding, member_count, manual_override,
                            displayable, created_at, updated_at)
       VALUES (?, 's1', '张三', NULL, 'f1', NULL, NULL, ?, 6, 0, 1, ?, ?)`,
    )
    .run("person1", mkEmbedding(1), now, now);
  sqlite
    .prepare(
      `INSERT INTO persons (id, storage_source_id, name, bio, representative_face_id, avatar_path,
                            custom_avatar_path, centroid_embedding, member_count, manual_override,
                            displayable, created_at, updated_at)
       VALUES (?, 's1', NULL, NULL, NULL, NULL, NULL, ?, 3, 0, 0, ?, ?)`,
    )
    .run("person2", mkEmbedding(2), now, now);
  // faces
  sqlite
    .prepare(
      `INSERT INTO faces (id, photo_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h, detection_score, embedding, detected_at)
       VALUES ('f1', 'ph1', 'person1', 100, 100, 200, 200, 0.95, ?, ?)`,
    )
    .run(mkEmbedding(1), now);
  sqlite
    .prepare(
      `INSERT INTO faces (id, photo_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h, detection_score, embedding, detected_at)
       VALUES ('f2', 'ph2', 'person1', 50, 50, 150, 150, 0.88, ?, ?)`,
    )
    .run(mkEmbedding(1), now);
});

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  sqlite.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function getApp() {
  const { createApp } = await import("../app");
  return createApp();
}

describe("GET /api/persons", () => {
  it("默认只返回 displayable=true 的，按 memberCount desc", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string }[] };
    expect(body.success).toBe(true);
    expect(body.data.map((p) => p.id)).toEqual(["person1"]);
  });

  it("?displayable=false → 只返回未达阈值的", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons?displayable=false");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((p) => p.id)).toEqual(["person2"]);
  });

  it("?storageSourceId 过滤", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons?storageSourceId=s2");
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });
});

describe("GET /api/persons/:id", () => {
  it("返回 person + photos + faces", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons/person1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id: string;
        name: string;
        photos: { id: string }[];
        faces: { id: string }[];
      };
    };
    expect(body.data.id).toBe("person1");
    expect(body.data.name).toBe("张三");
    expect(body.data.photos.map((p) => p.id).sort()).toEqual(["ph1", "ph2"]);
    expect(body.data.faces.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
  });

  it("不存在返回 404", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons/nope");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/persons/:id", () => {
  it("成功更新 name/bio（中文）", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons/person2", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "奶奶", bio: "二零二四年春节后开始记录" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string; bio: string } };
    expect(body.data.name).toBe("奶奶");
    expect(body.data.bio).toBe("二零二四年春节后开始记录");
  });

  it('name="" 视为清空 → null', async () => {
    const app = await getApp();
    const res = await app.request("/api/persons/person1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string | null } };
    expect(body.data.name).toBeNull();
  });

  it("name>20 字符 → 400", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons/person1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a".repeat(21) }),
    });
    expect(res.status).toBe(400);
  });

  it("不存在 → 404", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons/nope", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hi" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/persons/:id/representative", () => {
  it("face 不属于该 person → 400", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons/person2/representative", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ faceId: "f1" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/persons/:id/merge", () => {
  it("成功合并：源被删除，目标 memberCount 累加 + displayable 触发", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons/person1/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPersonId: "person2" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { mergedFromId: string; targetPersonId: string; newMemberCount: number };
    };
    expect(body.data.mergedFromId).toBe("person1");
    expect(body.data.targetPersonId).toBe("person2");
    expect(body.data.newMemberCount).toBe(9);

    // person1 已删，person2 displayable=true
    const remain = sqlite.prepare("SELECT * FROM persons").all() as {
      id: string;
      displayable: number;
      member_count: number;
    }[];
    expect(remain.map((p) => p.id)).toEqual(["person2"]);
    expect(remain[0]?.displayable).toBe(1);
    expect(remain[0]?.member_count).toBe(9);
    // faces 已搬迁
    const faces = sqlite.prepare("SELECT person_id FROM faces ORDER BY id").all() as {
      person_id: string;
    }[];
    expect(faces.every((f) => f.person_id === "person2")).toBe(true);
  });

  it("合并到自己 → 400", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons/person1/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPersonId: "person1" }),
    });
    expect(res.status).toBe(400);
  });

  it("目标不存在 → 404", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons/person1/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPersonId: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/persons/:id/avatar.jpg", () => {
  it("无 customAvatarPath 也无 avatarPath → 404", async () => {
    const app = await getApp();
    const res = await app.request("/api/persons/person1/avatar.jpg");
    expect(res.status).toBe(404);
  });
});

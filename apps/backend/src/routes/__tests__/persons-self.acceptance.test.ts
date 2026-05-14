/**
 * 验收测试：persons "self" 标记 API 4 端点契约（红队，黑盒）
 *
 * 设计契约来源（state.md §契约规约 §API 契约 / §验证方案 §红队验收测试方向 7-11）：
 *
 *   PUT /api/persons/:id/self
 *     - body 空 / {} 均接受
 *     - 200 → { success: true, data: { personId: <id>, isSelf: true } }
 *     - 404 → person 不存在
 *     - 副作用：覆盖 settings.selfPersonId 为 :id（settings 表 key='selfPersonId' 行覆盖、唯一）
 *
 *   DELETE /api/persons/:id/self  （幂等设计）
 *     - 200 → { success: true, data: { cleared: boolean } }
 *       cleared:true  → 之前 settings.selfPersonId === :id，本次删行
 *       cleared:false → 之前 selfPersonId !== :id 或未设置，无副作用
 *     - 404 → 仅当 person :id 本身不存在
 *
 *   GET /api/persons / GET /api/persons/:id
 *     - 响应 Person 对象**必填**新字段：isSelf: boolean
 *     - 派生 isSelf = (person.id === settings.selfPersonId)
 *     - settings 表无 selfPersonId → 所有 person isSelf=false
 *     - 已设置 → 仅匹配的 person isSelf=true，其它 false（互斥）
 *
 *   错误响应格式：{ success: false, error: string }
 *
 * 红队铁律：
 * - 不读取 routes/persons.ts 实现源码，不读 lib/settings 实现源码
 * - 通过 createApp() + app.request() 黑盒触发
 * - 用真实 SQLite（:memory:）+ schema 完整 DDL（含 settings/persons/faces）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "../../__tests__/helpers/test-schema";
import * as schema from "../../db/schema";

// =====================================================================
// 内存 SQLite + db mock + 队列 mock
// =====================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;
let app: import("hono").Hono;
let tmpStorageRoot: string;

const SOURCE_ID = "src-self-test-aaaaaaaaaaaaaaaaaaaa";

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

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function nowIso(): string {
  return new Date().toISOString();
}

function fakeEmbeddingBase64(): string {
  // 512 维 Float32Array → 2048 bytes → base64 ~2732 chars
  const buf = Buffer.alloc(512 * 4);
  for (let i = 0; i < 512; i++) buf.writeFloatLE(0.001 * i, i * 4);
  return buf.toString("base64");
}

function seedPerson(opts: {
  id: string;
  storageSourceId?: string;
  nickname?: string | null;
  name?: string | null;
  hidden?: boolean;
  displayable?: boolean;
  memberCount?: number;
}): void {
  const ts = nowIso();
  testSqlite
    .prepare(
      `INSERT INTO persons
        (id, storage_source_id, name, nickname, bio, representative_face_id,
         avatar_path, custom_avatar_path, centroid_embedding,
         member_count, manual_override, displayable, hidden,
         created_at, updated_at, attribute_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.storageSourceId ?? SOURCE_ID,
      opts.name ?? null,
      opts.nickname ?? null,
      null,
      null,
      null,
      null,
      fakeEmbeddingBase64(),
      opts.memberCount ?? 0,
      0,
      opts.displayable ? 1 : 0,
      opts.hidden ? 1 : 0,
      ts,
      ts,
      null,
    );
}

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

beforeEach(async () => {
  const t = createTestDb();
  testSqlite = t.sqlite;
  testDb = t.db;

  testSqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, 'TestSource', 'local', '/test', 1)",
    )
    .run(SOURCE_ID);

  tmpStorageRoot = mkdtempSync(join(tmpdir(), "relight-persons-self-test-"));
  process.env.STORAGE_ROOT = tmpStorageRoot;

  vi.resetModules();
  const mod = await import("../../app");
  app = mod.createApp();
});

afterEach(() => {
  testSqlite.close();
  rmSync(tmpStorageRoot, { recursive: true, force: true });
});

// =====================================================================
// 测试
// =====================================================================

describe("PUT /api/persons/:id/self — 设置 self", () => {
  it("契约 §API.PUT.r1 成功响应 { success:true, data:{ personId, isSelf:true } }", async () => {
    seedPerson({ id: "p-self-1", nickname: "爸爸", memberCount: 100, displayable: true });

    const { status, body } = await request("PUT", "/api/persons/p-self-1/self");

    expect(status).toBe(200);
    const b = body as {
      success: boolean;
      data: { personId: string; isSelf: boolean };
    };
    expect(b.success).toBe(true);
    expect(b.data.personId).toBe("p-self-1");
    expect(b.data.isSelf).toBe(true);

    // 副作用：settings 表 selfPersonId = p-self-1
    const row = testSqlite.prepare("SELECT value FROM settings WHERE key = 'selfPersonId'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("p-self-1");
  });

  it("契约 §API.PUT.r2 person 不存在 → 404 + { success:false }", async () => {
    const { status, body } = await request("PUT", "/api/persons/nonexistent/self");
    expect(status).toBe(404);
    const b = body as { success: boolean };
    expect(b.success).toBe(false);
  });

  it("契约 §API.PUT.f7 同 id 调两次仍只一个 self（settings.selfPersonId 唯一行）", async () => {
    seedPerson({ id: "p-idem", nickname: "爸爸", memberCount: 100, displayable: true });

    await request("PUT", "/api/persons/p-idem/self");
    await request("PUT", "/api/persons/p-idem/self");

    // settings 表 key 是主键，调两次仍只 1 行
    const rows = testSqlite
      .prepare("SELECT value FROM settings WHERE key = 'selfPersonId'")
      .all() as { value: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("p-idem");
  });

  it("契约 §API.PUT.f8 PUT 新 id 时旧 selfPersonId 被覆盖（不并存两个 self）", async () => {
    seedPerson({ id: "p-old", nickname: "妈妈", memberCount: 50, displayable: true });
    seedPerson({ id: "p-new", nickname: "爸爸", memberCount: 80, displayable: true });

    await request("PUT", "/api/persons/p-old/self");
    await request("PUT", "/api/persons/p-new/self");

    // settings.selfPersonId 应是新值
    const rows = testSqlite
      .prepare("SELECT value FROM settings WHERE key = 'selfPersonId'")
      .all() as { value: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("p-new");

    // GET 验证：p-old isSelf=false，p-new isSelf=true
    const { body: oldBody } = await request("GET", "/api/persons/p-old");
    const { body: newBody } = await request("GET", "/api/persons/p-new");

    const oldPerson = (oldBody as { data: { isSelf: boolean } }).data;
    const newPerson = (newBody as { data: { isSelf: boolean } }).data;
    expect(oldPerson.isSelf).toBe(false);
    expect(newPerson.isSelf).toBe(true);
  });

  it("契约 §API.PUT.body PUT body 为空 / {} 都接受", async () => {
    seedPerson({ id: "p-empty-body", nickname: "六六", memberCount: 30, displayable: true });

    // 完全无 body
    const res1 = await app.request("/api/persons/p-empty-body/self", { method: "PUT" });
    expect(res1.status).toBe(200);

    // 空对象 body
    const { status: s2 } = await request("PUT", "/api/persons/p-empty-body/self", {});
    expect(s2).toBe(200);
  });
});

describe("DELETE /api/persons/:id/self — 清除 self（幂等）", () => {
  it("契约 §API.DELETE.r1 selfPersonId === :id → 200 + cleared:true + settings 行被删除", async () => {
    seedPerson({ id: "p-del-1", nickname: "爸爸", memberCount: 100, displayable: true });
    await request("PUT", "/api/persons/p-del-1/self");

    const { status, body } = await request("DELETE", "/api/persons/p-del-1/self");
    expect(status).toBe(200);
    const b = body as { success: boolean; data: { cleared: boolean } };
    expect(b.success).toBe(true);
    expect(b.data.cleared).toBe(true);

    // settings 行被删除
    const row = testSqlite.prepare("SELECT value FROM settings WHERE key = 'selfPersonId'").get();
    expect(row).toBeUndefined();
  });

  it("契约 §API.DELETE.r2 selfPersonId !== :id → 200 + cleared:false（幂等，不是 404）", async () => {
    seedPerson({ id: "p-other", nickname: "妈妈", memberCount: 50, displayable: true });
    seedPerson({ id: "p-target", nickname: "六六", memberCount: 30, displayable: true });
    await request("PUT", "/api/persons/p-other/self");

    const { status, body } = await request("DELETE", "/api/persons/p-target/self");
    expect(status).toBe(200);
    const b = body as { success: boolean; data: { cleared: boolean } };
    expect(b.success).toBe(true);
    expect(b.data.cleared).toBe(false);

    // p-other 仍是 self
    const row = testSqlite
      .prepare("SELECT value FROM settings WHERE key = 'selfPersonId'")
      .get() as { value: string };
    expect(row?.value).toBe("p-other");
  });

  it("契约 §API.DELETE.r3 settings 未设置 selfPersonId → 200 + cleared:false（幂等）", async () => {
    seedPerson({ id: "p-never-set", nickname: "爸爸", memberCount: 100, displayable: true });

    const { status, body } = await request("DELETE", "/api/persons/p-never-set/self");
    expect(status).toBe(200);
    const b = body as { success: boolean; data: { cleared: boolean } };
    expect(b.success).toBe(true);
    expect(b.data.cleared).toBe(false);
  });

  it("契约 §API.DELETE.r4 person 不存在 → 404 + { success:false }", async () => {
    const { status, body } = await request("DELETE", "/api/persons/nonexistent/self");
    expect(status).toBe(404);
    const b = body as { success: boolean };
    expect(b.success).toBe(false);
  });

  it("契约 §API.DELETE.idem DELETE 后再次 DELETE → 200 + cleared:false（二次幂等）", async () => {
    seedPerson({ id: "p-double-del", nickname: "爸爸", memberCount: 100, displayable: true });
    await request("PUT", "/api/persons/p-double-del/self");

    const r1 = await request("DELETE", "/api/persons/p-double-del/self");
    expect(r1.status).toBe(200);
    expect((r1.body as { data: { cleared: boolean } }).data.cleared).toBe(true);

    // 二次 DELETE，仍 200 但 cleared=false
    const r2 = await request("DELETE", "/api/persons/p-double-del/self");
    expect(r2.status).toBe(200);
    expect((r2.body as { data: { cleared: boolean } }).data.cleared).toBe(false);
  });
});

describe("GET /api/persons / :id 响应附 isSelf 字段", () => {
  it("契约 §API.GET.r9 列表响应每个 person 都有 isSelf:boolean（必填，不 undefined）", async () => {
    seedPerson({ id: "p-1", nickname: "爸爸", memberCount: 100, displayable: true });
    seedPerson({ id: "p-2", nickname: "妈妈", memberCount: 50, displayable: true });
    seedPerson({ id: "p-3", nickname: "六六", memberCount: 30, displayable: true });

    const { body } = await request("GET", "/api/persons?displayable=true");
    const data = (body as { data: Array<Record<string, unknown>> }).data;
    expect(data.length).toBeGreaterThan(0);
    for (const p of data) {
      expect(p).toHaveProperty("isSelf");
      expect(typeof p.isSelf).toBe("boolean");
    }
  });

  it("契约 §API.GET.r9 详情响应 person.isSelf 字段存在且为 boolean", async () => {
    seedPerson({ id: "p-detail-1", nickname: "六六", memberCount: 30, displayable: true });

    const { body } = await request("GET", "/api/persons/p-detail-1");
    const data = (body as { data: Record<string, unknown> }).data;
    expect(data).toHaveProperty("isSelf");
    expect(typeof data.isSelf).toBe("boolean");
  });

  it("契约 §API.GET.r10 settings 表无 selfPersonId 时，所有 person 的 isSelf=false", async () => {
    seedPerson({ id: "no-self-1", nickname: "爸爸", memberCount: 5, displayable: true });
    seedPerson({ id: "no-self-2", nickname: "妈妈", memberCount: 5, displayable: true });
    seedPerson({ id: "no-self-3", nickname: "六六", memberCount: 5, displayable: true });

    const { body } = await request("GET", "/api/persons?displayable=true");
    const data = (body as { data: Array<{ id: string; isSelf: boolean }> }).data;
    for (const p of data) {
      expect(p.isSelf).toBe(false);
    }
  });

  it("契约 §API.GET.r11 settings.selfPersonId='X' 时，仅 X.isSelf=true，其他全 false（列表）", async () => {
    seedPerson({ id: "self-X", nickname: "爸爸", memberCount: 100, displayable: true });
    seedPerson({ id: "other-A", nickname: "妈妈", memberCount: 50, displayable: true });
    seedPerson({ id: "other-B", nickname: "六六", memberCount: 30, displayable: true });

    await request("PUT", "/api/persons/self-X/self");

    const { body } = await request("GET", "/api/persons?displayable=true");
    const data = (body as { data: Array<{ id: string; isSelf: boolean }> }).data;

    const selfPersons = data.filter((p) => p.isSelf);
    expect(selfPersons).toHaveLength(1);
    expect(selfPersons[0]!.id).toBe("self-X");

    // 其他 person 的 isSelf 必须严格 === false
    const otherPersons = data.filter((p) => p.id !== "self-X");
    for (const p of otherPersons) {
      expect(p.isSelf).toBe(false);
    }
  });

  it("契约 §API.GET.r11 详情接口 isSelf 派生正确（已设/未匹配 → false）", async () => {
    seedPerson({ id: "self-Y", nickname: "爸爸", memberCount: 100, displayable: true });
    seedPerson({ id: "non-self", nickname: "妈妈", memberCount: 50, displayable: true });

    await request("PUT", "/api/persons/self-Y/self");

    // self 详情 → isSelf=true
    const r1 = await request("GET", "/api/persons/self-Y");
    expect((r1.body as { data: { isSelf: boolean } }).data.isSelf).toBe(true);

    // non-self 详情 → isSelf=false
    const r2 = await request("GET", "/api/persons/non-self");
    expect((r2.body as { data: { isSelf: boolean } }).data.isSelf).toBe(false);
  });
});

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
/**
 * 验收测试 R-INCREMENTAL: updatePrototypesIncremental 行为验证
 *
 * 设计契约（state.md「增量原型更新」+「函数签名」节）：
 *
 * updatePrototypesIncremental(personId, newEmbedding, quality, config):
 *   - LOW quality face → 直接 return（不更新 person_prototypes）
 *   - HIGH/MED + 最近 prototype cosine ≥ prototypeTightMerge(0.88) → UPDATE 该 prototype
 *     (running weighted avg + L2-norm；weight_sum += weight，member_count += 1)
 *   - 距离不够近 + 当前 < prototypeMaxPerPerson → INSERT 新行（总数 +1）
 *   - 已满（= prototypeMaxPerPerson） → 合并最相似两个 prototype + INSERT 新原型（总数 = K_MAX）
 *   - person 不存在 → 抛错或静默跳过
 *
 * 策略：用真实 better-sqlite3（:memory:）+ drizzle ORM，与生产一致的 db 对象。
 */
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// 类型声明
// ---------------------------------------------------------------------------

type FaceQuality = "high" | "medium" | "low";

type UpdatePrototypesIncrementalConfig = {
  prototypeTightMerge: number;
  prototypeMaxPerPerson: number;
  medQualityCentroidWeight: number;
};

type UpdatePrototypesIncremental = (
  personId: string,
  newEmbedding: Float32Array,
  quality: FaceQuality,
  config: UpdatePrototypesIncrementalConfig,
) => Promise<void>;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function l2Normalize(arr: Float32Array): Float32Array {
  let sum = 0;
  for (const v of arr) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return new Float32Array(arr.length);
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = (arr[i] ?? 0) / norm;
  return out;
}

function encodeEmb(arr: Float32Array): string {
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  return buf.toString("base64");
}

function decodeEmb(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/** 构造方向确定的 L2-normalized 单位向量 */
function makeDirectedEmb(xWeight: number, yWeight: number, dim = 512): Float32Array {
  const arr = new Float32Array(dim);
  arr[0] = xWeight;
  arr[1] = yWeight;
  return l2Normalize(arr);
}

// ---------------------------------------------------------------------------
// 测试数据库 setup：用 drizzle ORM 实例（与生产一致）
// ---------------------------------------------------------------------------

// 内联 DDL — 与 schema.ts 契约一致（不依赖蓝队 drizzle migration）
const SETUP_DDL = `
  CREATE TABLE IF NOT EXISTS storage_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'local',
    root_path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_scan_at TEXT,
    status TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS persons (
    id TEXT PRIMARY KEY,
    storage_source_id TEXT NOT NULL,
    centroid_embedding TEXT NOT NULL,
    name TEXT,
    nickname TEXT,
    bio TEXT,
    representative_face_id TEXT,
    avatar_path TEXT,
    custom_avatar_path TEXT,
    member_count INTEGER NOT NULL DEFAULT 0,
    manual_override INTEGER NOT NULL DEFAULT 0,
    displayable INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    attribute_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (storage_source_id) REFERENCES storage_sources(id)
  );

  CREATE TABLE IF NOT EXISTS person_prototypes (
    id           TEXT PRIMARY KEY,
    person_id    TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    embedding    TEXT NOT NULL,
    weight_sum   REAL NOT NULL DEFAULT 0,
    member_count INTEGER NOT NULL DEFAULT 0,
    label        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_person_prototypes_person ON person_prototypes(person_id);
`;

// 导入 schema（仅用于 drizzle 实例构造）
import * as schema from "../../../db/schema";

type DrizzleDb = ReturnType<typeof drizzle>;

async function createTestDb(): Promise<{
  sqlite: Database.Database;
  db: DrizzleDb;
  dbPath: string;
}> {
  const dbPath = path.join(tmpdir(), `relight-test-${randomUUID()}.db`);
  const sqlite = new Database(dbPath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(SETUP_DDL);

  const db = drizzle(sqlite, { schema });
  return { sqlite, db, dbPath };
}

function cleanup(sqlite: Database.Database, dbPath: string): void {
  try {
    sqlite.close();
  } catch {
    // ignore
  }
  try {
    unlinkSync(dbPath);
  } catch {
    // ignore
  }
}

function ensureStorageSource(sqlite: Database.Database): void {
  const existing = sqlite.prepare(`SELECT id FROM storage_sources WHERE id='ss-test'`).get();
  if (!existing) {
    sqlite
      .prepare(
        `INSERT INTO storage_sources (id, name, type, root_path, enabled)
         VALUES ('ss-test', 'test-source', 'local', '/tmp/test', 1)`,
      )
      .run();
  }
}

function insertPerson(sqlite: Database.Database, id: string): void {
  ensureStorageSource(sqlite);
  const centroid = encodeEmb(l2Normalize(new Float32Array(512).fill(0.01)));
  sqlite
    .prepare(
      `INSERT INTO persons (id, storage_source_id, centroid_embedding, created_at, updated_at)
       VALUES (?, 'ss-test', ?, datetime('now'), datetime('now'))`,
    )
    .run(id, centroid);
}

function insertPrototype(
  sqlite: Database.Database,
  opts: {
    id: string;
    personId: string;
    embedding: Float32Array;
    weightSum?: number;
    memberCount?: number;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO person_prototypes
         (id, person_id, embedding, weight_sum, member_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(
      opts.id,
      opts.personId,
      encodeEmb(opts.embedding),
      opts.weightSum ?? 1.0,
      opts.memberCount ?? 1,
    );
}

function countPrototypes(sqlite: Database.Database, personId: string): number {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS cnt FROM person_prototypes WHERE person_id=?")
    .get(personId) as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// 测试基础配置
// ---------------------------------------------------------------------------

const BASE_CONFIG: UpdatePrototypesIncrementalConfig = {
  prototypeTightMerge: 0.88,
  prototypeMaxPerPerson: 3, // 小 K_MAX 方便构造边界
  medQualityCentroidWeight: 0.5,
};

// ---------------------------------------------------------------------------
// R-INCREMENTAL-A: LOW quality face → 不更新
// ---------------------------------------------------------------------------

describe("R-INCREMENTAL-A: LOW quality face → 不更新 person_prototypes", () => {
  it("A-1: quality=low，调用前后 person_prototypes 行数不变", async () => {
    const { sqlite, db: testDb, dbPath } = await createTestDb();

    try {
      const personId = "person-a1";
      insertPerson(sqlite, personId);

      const existingProtoEmb = makeDirectedEmb(1.0, 0.0);
      insertPrototype(sqlite, {
        id: "proto-a1",
        personId,
        embedding: existingProtoEmb,
        weightSum: 1.0,
        memberCount: 1,
      });

      expect(countPrototypes(sqlite, personId)).toBe(1);

      vi.resetModules();
      vi.doMock("../../../db/index", () => ({ db: testDb, schema }));

      const { updatePrototypesIncremental } = (await import("../prototypes")) as {
        updatePrototypesIncremental: UpdatePrototypesIncremental;
      };

      // LOW quality：即使 embedding 很近也不更新
      const newEmb = makeDirectedEmb(1.0, 0.001);
      await updatePrototypesIncremental(personId, newEmb, "low", BASE_CONFIG);

      // 行数不变
      expect(countPrototypes(sqlite, personId)).toBe(1);
    } finally {
      cleanup(sqlite, dbPath);
      vi.resetModules();
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// R-INCREMENTAL-B: HIGH quality + cosine ≥ prototypeTightMerge → UPDATE
// ---------------------------------------------------------------------------

describe("R-INCREMENTAL-B: HIGH quality + 最近 prototype cosine ≥ prototypeTightMerge → UPDATE", () => {
  it("B-1: cosine=0.92 ≥ 0.88 → UPDATE 该 prototype（weight_sum, member_count 各增）", async () => {
    const { sqlite, db: testDb, dbPath } = await createTestDb();

    try {
      const personId = "person-b1";
      insertPerson(sqlite, personId);

      // prototype 方向：x 轴正方向
      const protoEmb = makeDirectedEmb(1.0, 0.0);
      const initialWeightSum = 2.0;
      const initialMemberCount = 2;
      insertPrototype(sqlite, {
        id: "proto-b1",
        personId,
        embedding: protoEmb,
        weightSum: initialWeightSum,
        memberCount: initialMemberCount,
      });

      // 构造 newEmb 使得 cosine(newEmb, protoEmb) = 0.92 ≥ 0.88
      // protoEmb = [1, 0, 0, ...], newEmb = [0.92, sin(θ), 0, ...] 已归一化
      const cosTarget = 0.92;
      const sinTheta = Math.sqrt(1 - cosTarget * cosTarget);
      const newEmb = new Float32Array(512);
      newEmb[0] = cosTarget;
      newEmb[1] = sinTheta;
      // 注意：newEmb 已经是单位向量（||newEmb||² = 0.92² + sinθ² = 1）

      const actualCos = cosineSim(newEmb, protoEmb);
      expect(actualCos).toBeCloseTo(cosTarget, 4);
      expect(actualCos).toBeGreaterThanOrEqual(0.88);

      vi.resetModules();
      vi.doMock("../../../db/index", () => ({ db: testDb, schema }));

      const { updatePrototypesIncremental } = (await import("../prototypes")) as {
        updatePrototypesIncremental: UpdatePrototypesIncremental;
      };

      await updatePrototypesIncremental(personId, newEmb, "high", BASE_CONFIG);

      // 查询更新后状态
      const updated = sqlite
        .prepare(`SELECT weight_sum, member_count FROM person_prototypes WHERE id='proto-b1'`)
        .get() as { weight_sum: number; member_count: number } | undefined;

      expect(updated).toBeDefined();
      // HIGH weight = 1.0，weight_sum 增加 1.0
      expect(updated!.weight_sum).toBeCloseTo(initialWeightSum + 1.0, 3);
      // member_count +1
      expect(updated!.member_count).toBe(initialMemberCount + 1);

      // 行数不变（UPDATE 不增行）
      expect(countPrototypes(sqlite, personId)).toBe(1);
    } finally {
      cleanup(sqlite, dbPath);
      vi.resetModules();
      vi.restoreAllMocks();
    }
  });

  it("B-2: MED quality + cosine ≥ 0.88 → UPDATE，weight_sum += medQualityCentroidWeight（0.5）", async () => {
    const { sqlite, db: testDb, dbPath } = await createTestDb();

    try {
      const personId = "person-b2";
      insertPerson(sqlite, personId);

      const protoEmb = makeDirectedEmb(1.0, 0.0);
      const initialWeightSum = 3.0;
      const initialMemberCount = 3;
      insertPrototype(sqlite, {
        id: "proto-b2",
        personId,
        embedding: protoEmb,
        weightSum: initialWeightSum,
        memberCount: initialMemberCount,
      });

      const cosTarget = 0.92;
      const sinTheta = Math.sqrt(1 - cosTarget * cosTarget);
      const newEmb = new Float32Array(512);
      newEmb[0] = cosTarget;
      newEmb[1] = sinTheta;

      vi.resetModules();
      vi.doMock("../../../db/index", () => ({ db: testDb, schema }));

      const { updatePrototypesIncremental } = (await import("../prototypes")) as {
        updatePrototypesIncremental: UpdatePrototypesIncremental;
      };

      await updatePrototypesIncremental(personId, newEmb, "medium", BASE_CONFIG);

      const updated = sqlite
        .prepare(`SELECT weight_sum, member_count FROM person_prototypes WHERE id='proto-b2'`)
        .get() as { weight_sum: number; member_count: number } | undefined;

      expect(updated).toBeDefined();
      // MED weight = medQualityCentroidWeight = 0.5
      expect(updated!.weight_sum).toBeCloseTo(initialWeightSum + 0.5, 3);
      expect(updated!.member_count).toBe(initialMemberCount + 1);
    } finally {
      cleanup(sqlite, dbPath);
      vi.resetModules();
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// R-INCREMENTAL-C: HIGH quality + cosine < tightMerge + 当前 < K_MAX → INSERT
// ---------------------------------------------------------------------------

describe("R-INCREMENTAL-C: HIGH quality + cosine < tightMerge + 当前 < K_MAX → INSERT", () => {
  it("C-1: 当前 1 个 prototype，cosine=0.70 < 0.88，K_MAX=3 → INSERT 新行（总数 2）", async () => {
    const { sqlite, db: testDb, dbPath } = await createTestDb();

    try {
      const personId = "person-c1";
      insertPerson(sqlite, personId);

      // 已有 1 个 prototype（方向 x 轴）
      const protoEmb = makeDirectedEmb(1.0, 0.0);
      insertPrototype(sqlite, { id: "proto-c1", personId, embedding: protoEmb });

      // 构造 newEmb cosine ≈ 0.70 < 0.88
      const cosTarget = 0.7;
      const sinTheta = Math.sqrt(1 - cosTarget * cosTarget);
      const newEmb = new Float32Array(512);
      newEmb[0] = cosTarget;
      newEmb[1] = sinTheta;

      expect(cosineSim(newEmb, protoEmb)).toBeCloseTo(cosTarget, 4);
      expect(cosineSim(newEmb, protoEmb)).toBeLessThan(0.88);

      vi.resetModules();
      vi.doMock("../../../db/index", () => ({ db: testDb, schema }));

      const { updatePrototypesIncremental } = (await import("../prototypes")) as {
        updatePrototypesIncremental: UpdatePrototypesIncremental;
      };

      await updatePrototypesIncremental(personId, newEmb, "high", BASE_CONFIG);

      // INSERT 新行：1 → 2
      expect(countPrototypes(sqlite, personId)).toBe(2);
    } finally {
      cleanup(sqlite, dbPath);
      vi.resetModules();
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// R-INCREMENTAL-D: HIGH quality + 已满 K_MAX → 合并 + INSERT（总数 = K_MAX）
// ---------------------------------------------------------------------------

describe("R-INCREMENTAL-D: HIGH quality + 已满 K_MAX → 合并 + INSERT（总数 = K_MAX）", () => {
  it("D-1: K_MAX=3，当前 3 个 prototype，新 embedding 不近任何一个 → 总数仍 = 3", async () => {
    const { sqlite, db: testDb, dbPath } = await createTestDb();

    try {
      const personId = "person-d1";
      insertPerson(sqlite, personId);

      // 3 个不同方向的 prototype（K_MAX=3，已满）
      const proto1Emb = makeDirectedEmb(1.0, 0.0); // 方向 0°
      const proto2Emb = makeDirectedEmb(0.0, 1.0); // 方向 90°
      const proto3Emb = makeDirectedEmb(-1.0, 0.0); // 方向 180°

      for (const [idx, emb] of [proto1Emb, proto2Emb, proto3Emb].entries()) {
        insertPrototype(sqlite, {
          id: `proto-d1-${idx + 1}`,
          personId,
          embedding: emb,
          weightSum: 1.0,
          memberCount: 1,
        });
      }

      expect(countPrototypes(sqlite, personId)).toBe(3); // 确认已满

      // 新 embedding：方向 -90°（与所有现有 prototype 相距甚远）
      const newEmb = makeDirectedEmb(0.0, -1.0);

      // 确认 newEmb 与所有 prototype 的 cosine < 0.88
      for (const protoEmb of [proto1Emb, proto2Emb, proto3Emb]) {
        expect(cosineSim(newEmb, protoEmb)).toBeLessThan(0.88);
      }

      vi.resetModules();
      vi.doMock("../../../db/index", () => ({ db: testDb, schema }));

      const { updatePrototypesIncremental } = (await import("../prototypes")) as {
        updatePrototypesIncremental: UpdatePrototypesIncremental;
      };

      await updatePrototypesIncremental(personId, newEmb, "high", BASE_CONFIG);

      // 合并最相似两个 + INSERT 新的 → 总数仍 = K_MAX = 3
      expect(countPrototypes(sqlite, personId)).toBe(3);
    } finally {
      cleanup(sqlite, dbPath);
      vi.resetModules();
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// R-INCREMENTAL-E: person 不存在 → 抛错或静默跳过
// ---------------------------------------------------------------------------

describe("R-INCREMENTAL-E: person 不存在的错误处理", () => {
  it("E-1: person 不存在 → 函数不崩溃，且数据库中不产生孤立 prototype 行", async () => {
    const { sqlite, db: testDb, dbPath } = await createTestDb();

    try {
      vi.resetModules();
      vi.doMock("../../../db/index", () => ({ db: testDb, schema }));

      const { updatePrototypesIncremental } = (await import("../prototypes")) as {
        updatePrototypesIncremental: UpdatePrototypesIncremental;
      };

      const nonexistentPersonId = "person-does-not-exist-xyz";
      const newEmb = makeDirectedEmb(1.0, 0.0);

      // 无论抛错还是静默跳过，都是合法行为
      try {
        await updatePrototypesIncremental(nonexistentPersonId, newEmb, "high", BASE_CONFIG);
      } catch {
        // 抛错是合法行为，继续验证 DB 状态
      }

      // 无论何种行为，不应产生孤立 prototype 行
      const cnt = countPrototypes(sqlite, nonexistentPersonId);
      expect(cnt).toBe(0);
    } finally {
      cleanup(sqlite, dbPath);
      vi.resetModules();
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// R-INCREMENTAL-F: UPDATE 后 embedding 仍然 L2-normalized
// ---------------------------------------------------------------------------

describe("R-INCREMENTAL-F: UPDATE 后 prototype embedding 仍然 L2-normalized", () => {
  it("F-1: HIGH quality + cosine ≥ 0.88 UPDATE 后，存储的 embedding L2 norm ∈ [0.95, 1.05]", async () => {
    const { sqlite, db: testDb, dbPath } = await createTestDb();

    try {
      const personId = "person-f1";
      insertPerson(sqlite, personId);

      const protoEmb = makeDirectedEmb(1.0, 0.0);
      insertPrototype(sqlite, {
        id: "proto-f1",
        personId,
        embedding: protoEmb,
        weightSum: 5.0,
        memberCount: 5,
      });

      // cosine = 0.92 ≥ 0.88 → UPDATE
      const cosTarget = 0.92;
      const sinTheta = Math.sqrt(1 - cosTarget * cosTarget);
      const newEmb = new Float32Array(512);
      newEmb[0] = cosTarget;
      newEmb[1] = sinTheta;

      vi.resetModules();
      vi.doMock("../../../db/index", () => ({ db: testDb, schema }));

      const { updatePrototypesIncremental } = (await import("../prototypes")) as {
        updatePrototypesIncremental: UpdatePrototypesIncremental;
      };

      await updatePrototypesIncremental(personId, newEmb, "high", BASE_CONFIG);

      const row = sqlite
        .prepare(`SELECT embedding FROM person_prototypes WHERE id='proto-f1'`)
        .get() as { embedding: string } | undefined;

      expect(row).toBeDefined();
      const updatedEmb = decodeEmb(row!.embedding);

      // 计算 L2 norm
      let sum = 0;
      for (const v of updatedEmb) sum += v * v;
      const norm = Math.sqrt(sum);

      expect(norm, `更新后 embedding L2 norm 应在 [0.95, 1.05]，实际 ${norm}`).toBeGreaterThan(
        0.95,
      );
      expect(norm).toBeLessThan(1.05);
    } finally {
      cleanup(sqlite, dbPath);
      vi.resetModules();
      vi.restoreAllMocks();
    }
  });
});

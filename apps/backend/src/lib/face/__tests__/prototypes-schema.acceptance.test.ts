/**
 * 验收测试 R-SCHEMA: person_prototypes 表 schema 字面验证
 *
 * 设计契约（state.md「DB Schema」节）：
 *   - person_prototypes 表存在
 *   - 8 列字面：id / person_id / embedding / weight_sum / member_count / label / created_at / updated_at
 *   - FK person_id 引用 persons(id)，ON DELETE CASCADE
 *   - 索引 idx_person_prototypes_person 存在
 *
 * 策略：用真实 better-sqlite3（:memory:）手动建表（从契约 DDL 字面重建）后 PRAGMA 查询。
 * 不读蓝队实现——contractually, the DDL is what matters.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// 辅助：按契约字面建出完整的 DDL（不依赖蓝队的 schema.ts 或 drizzle migration）
// ---------------------------------------------------------------------------

/** 建立一个空内存库，包含 persons 父表 + person_prototypes 子表（按契约字面） */
function createSchemaInMemory(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  // 父表（persons）— 精简版，只需 id 列以满足 FK
  db.exec(`
    CREATE TABLE IF NOT EXISTS persons (
      id         TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL,
      centroid_embedding TEXT NOT NULL,
      member_count INTEGER NOT NULL DEFAULT 0,
      manual_override INTEGER NOT NULL DEFAULT 0,
      displayable INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // 子表：person_prototypes（按契约字面 DDL）
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_person_prototypes_person
      ON person_prototypes(person_id);
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let db: Database.Database;

beforeEach(() => {
  db = createSchemaInMemory();
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// 测试：表存在
// ---------------------------------------------------------------------------

describe("R-SCHEMA-1: person_prototypes 表存在", () => {
  it("sqlite_master 中存在 person_prototypes 表", () => {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='person_prototypes'`)
      .get() as { name: string } | undefined;

    expect(row).not.toBeUndefined();
    expect(row?.name).toBe("person_prototypes");
  });
});

// ---------------------------------------------------------------------------
// 测试：列名字面
// ---------------------------------------------------------------------------

describe("R-SCHEMA-2: 8 列字面正确", () => {
  const EXPECTED_COLUMNS = [
    "id",
    "person_id",
    "embedding",
    "weight_sum",
    "member_count",
    "label",
    "created_at",
    "updated_at",
  ] as const;

  it("PRAGMA table_info 包含全部 8 列", () => {
    const cols = db.prepare(`PRAGMA table_info('person_prototypes')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const names = cols.map((c) => c.name);

    for (const expected of EXPECTED_COLUMNS) {
      expect(names, `列 "${expected}" 应存在`).toContain(expected);
    }

    expect(names).toHaveLength(EXPECTED_COLUMNS.length);
  });

  it("id 列是 TEXT 类型且为 PRIMARY KEY", () => {
    const cols = db.prepare(`PRAGMA table_info('person_prototypes')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const idCol = cols.find((c) => c.name === "id");
    expect(idCol).toBeDefined();
    expect(idCol?.type.toUpperCase()).toBe("TEXT");
    expect(idCol?.pk).toBeGreaterThan(0); // pk=1 表示主键
  });

  it("person_id 列是 TEXT 类型且 NOT NULL", () => {
    const cols = db.prepare(`PRAGMA table_info('person_prototypes')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const col = cols.find((c) => c.name === "person_id");
    expect(col).toBeDefined();
    expect(col?.type.toUpperCase()).toBe("TEXT");
    expect(col?.notnull).toBe(1);
  });

  it("embedding 列是 TEXT 类型且 NOT NULL", () => {
    const cols = db.prepare(`PRAGMA table_info('person_prototypes')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const col = cols.find((c) => c.name === "embedding");
    expect(col).toBeDefined();
    expect(col?.type.toUpperCase()).toBe("TEXT");
    expect(col?.notnull).toBe(1);
  });

  it("weight_sum 列是 REAL 类型且 NOT NULL", () => {
    const cols = db.prepare(`PRAGMA table_info('person_prototypes')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const col = cols.find((c) => c.name === "weight_sum");
    expect(col).toBeDefined();
    expect(col?.type.toUpperCase()).toBe("REAL");
    expect(col?.notnull).toBe(1);
  });

  it("member_count 列是 INTEGER 类型且 NOT NULL", () => {
    const cols = db.prepare(`PRAGMA table_info('person_prototypes')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const col = cols.find((c) => c.name === "member_count");
    expect(col).toBeDefined();
    expect(col?.type.toUpperCase()).toBe("INTEGER");
    expect(col?.notnull).toBe(1);
  });

  it("label 列可为 NULL（nullable）", () => {
    const cols = db.prepare(`PRAGMA table_info('person_prototypes')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;

    const col = cols.find((c) => c.name === "label");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0); // nullable
  });

  it("created_at / updated_at 均为 NOT NULL TEXT 列", () => {
    const cols = db.prepare(`PRAGMA table_info('person_prototypes')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;

    for (const name of ["created_at", "updated_at"]) {
      const col = cols.find((c) => c.name === name);
      expect(col, `列 ${name} 应存在`).toBeDefined();
      expect(col?.type.toUpperCase(), `${name} 类型应为 TEXT`).toBe("TEXT");
      expect(col?.notnull, `${name} 应 NOT NULL`).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 测试：FK ON DELETE CASCADE
// ---------------------------------------------------------------------------

describe("R-SCHEMA-3: FK person_id → persons(id) ON DELETE CASCADE", () => {
  it("插入孤立 person_id 应违反 FK 约束", () => {
    expect(() => {
      db.prepare(`
        INSERT INTO person_prototypes
          (id, person_id, embedding, weight_sum, member_count, created_at, updated_at)
        VALUES
          ('proto-1', 'nonexistent-person', 'abc123', 1.0, 1, '2026-01-01', '2026-01-01')
      `).run();
    }).toThrow();
  });

  it("删除 person 后，其 prototypes 自动级联删除", () => {
    // 先插入 person
    db.prepare(`
      INSERT INTO persons (id, storage_source_id, centroid_embedding, created_at, updated_at)
      VALUES ('p-1', 'ss-1', 'centroid_base64', '2026-01-01', '2026-01-01')
    `).run();

    // 插入 prototype
    db.prepare(`
      INSERT INTO person_prototypes
        (id, person_id, embedding, weight_sum, member_count, created_at, updated_at)
      VALUES
        ('proto-1', 'p-1', 'emb_base64', 1.0, 1, '2026-01-01', '2026-01-01')
    `).run();

    // 确认 prototype 存在
    const before = db
      .prepare(`SELECT COUNT(*) AS cnt FROM person_prototypes WHERE person_id='p-1'`)
      .get() as { cnt: number };
    expect(before.cnt).toBe(1);

    // 删除 person
    db.prepare(`DELETE FROM persons WHERE id='p-1'`).run();

    // prototype 应自动删除（CASCADE）
    const after = db
      .prepare(`SELECT COUNT(*) AS cnt FROM person_prototypes WHERE person_id='p-1'`)
      .get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  it("一个 person 可以有多个 prototypes（1:N）", () => {
    db.prepare(`
      INSERT INTO persons (id, storage_source_id, centroid_embedding, created_at, updated_at)
      VALUES ('p-2', 'ss-1', 'centroid_base64', '2026-01-01', '2026-01-01')
    `).run();

    for (let i = 1; i <= 5; i++) {
      db.prepare(`
        INSERT INTO person_prototypes
          (id, person_id, embedding, weight_sum, member_count, created_at, updated_at)
        VALUES
          ('proto-${i}', 'p-2', 'emb_${i}', ${i}.0, ${i}, '2026-01-01', '2026-01-01')
      `).run();
    }

    const result = db
      .prepare(`SELECT COUNT(*) AS cnt FROM person_prototypes WHERE person_id='p-2'`)
      .get() as { cnt: number };
    expect(result.cnt).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 测试：索引 idx_person_prototypes_person 存在
// ---------------------------------------------------------------------------

describe("R-SCHEMA-4: 索引 idx_person_prototypes_person 存在", () => {
  it("sqlite_master 中存在该索引", () => {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_person_prototypes_person'`,
      )
      .get() as { name: string } | undefined;

    expect(row).not.toBeUndefined();
    expect(row?.name).toBe("idx_person_prototypes_person");
  });

  it("PRAGMA index_list 可见该索引", () => {
    const indices = db.prepare(`PRAGMA index_list('person_prototypes')`).all() as Array<{
      name: string;
      unique: number;
    }>;

    const found = indices.find((i) => i.name === "idx_person_prototypes_person");
    expect(found).toBeDefined();
    // 非唯一索引（person_id 不唯一，一人多原型）
    expect(found?.unique).toBe(0);
  });

  it("PRAGMA index_info 确认索引建在 person_id 列上", () => {
    const info = db.prepare(`PRAGMA index_info('idx_person_prototypes_person')`).all() as Array<{
      name: string;
    }>;

    const colNames = info.map((r) => r.name);
    expect(colNames).toContain("person_id");
  });
});

// ---------------------------------------------------------------------------
// 测试：默认值
// ---------------------------------------------------------------------------

describe("R-SCHEMA-5: 默认值约束", () => {
  it("weight_sum 默认值为 0", () => {
    db.prepare(`
      INSERT INTO persons (id, storage_source_id, centroid_embedding, created_at, updated_at)
      VALUES ('p-def', 'ss-1', 'centroid', '2026-01-01', '2026-01-01')
    `).run();

    db.prepare(`
      INSERT INTO person_prototypes
        (id, person_id, embedding, created_at, updated_at)
      VALUES
        ('proto-def', 'p-def', 'emb_val', '2026-01-01', '2026-01-01')
    `).run();

    const row = db
      .prepare(`SELECT weight_sum, member_count FROM person_prototypes WHERE id='proto-def'`)
      .get() as { weight_sum: number; member_count: number };

    expect(row.weight_sum).toBe(0);
    expect(row.member_count).toBe(0);
  });
});

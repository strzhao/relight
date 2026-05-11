/**
 * 验收测试：persons + faces Schema 契约（红队）
 *
 * 设计契约（state.md 「契约规约 → Database Schema 契约」+ 「数据库 Schema 新增」）：
 *
 * persons 表字段（严格命名，不允许改名）：
 *   id, storageSourceId, name, bio, representativeFaceId,
 *   avatarPath, customAvatarPath, centroidEmbedding,
 *   memberCount, manualOverride, displayable,
 *   createdAt, updatedAt
 *
 * persons 表索引（约定）：
 *   idx_persons_source              ON (storage_source_id)
 *   idx_persons_displayable         ON (storage_source_id, displayable, member_count)
 *
 * faces 表字段：
 *   id, photoId, personId, bboxX, bboxY, bboxW, bboxH,
 *   detectionScore, embedding, detectedAt
 *
 * 外键：
 *   persons.storage_source_id → storage_sources.id
 *   faces.photo_id → photos.id ON DELETE CASCADE
 *
 * 红队铁律：
 * - 不读取任何蓝队实现文件
 * - 仅校验 Drizzle schema 导出的字段名 + DDL 行为（通过真实 SQLite 建表后 PRAGMA 反查）
 */
import Database from "better-sqlite3";
import { type SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import { beforeAll, describe, expect, it } from "vitest";

let schema: Record<string, unknown>;

beforeAll(async () => {
  schema = (await import("../schema")) as unknown as Record<string, unknown>;
});

// ---- 辅助：列名集合（drizzle 列对象的 .name 字段 = 实际 SQL 列名）----

function getSqlColumnNames(table: SQLiteTable): Set<string> {
  const names = new Set<string>();
  const obj = table as unknown as Record<string, unknown>;
  for (const value of Object.values(obj)) {
    if (
      typeof value === "object" &&
      value !== null &&
      "name" in (value as Record<string, unknown>) &&
      typeof (value as { name: unknown }).name === "string"
    ) {
      names.add((value as { name: string }).name);
    }
  }
  return names;
}

function getJsColumnKeys(table: SQLiteTable): Set<string> {
  const keys = new Set<string>();
  for (const k of Object.keys(table as object)) {
    if (k.startsWith("$") || k.startsWith("_")) continue;
    keys.add(k);
  }
  return keys;
}

// =========================================================================
// persons 表存在性 + 字段
// =========================================================================

describe("persons 表 — Schema 契约", () => {
  it("应在 schema 中导出 persons 表", () => {
    expect(schema.persons).toBeDefined();
    expect(typeof schema.persons).toBe("object");
  });

  it("表名应为 'persons'（复数，下划线小写）", () => {
    const cfg = getTableConfig(schema.persons as SQLiteTable);
    expect(cfg.name).toBe("persons");
  });

  it("应包含全部 13 个契约字段（JS 驼峰命名）", () => {
    const t = schema.persons as SQLiteTable;
    const keys = getJsColumnKeys(t);

    const required = [
      "id",
      "storageSourceId",
      "name",
      "bio",
      "representativeFaceId",
      "avatarPath",
      "customAvatarPath",
      "centroidEmbedding",
      "memberCount",
      "manualOverride",
      "displayable",
      "createdAt",
      "updatedAt",
    ];
    for (const field of required) {
      expect(keys.has(field), `persons 表缺字段 ${field}`).toBe(true);
    }
  });

  it("SQL 列名应为下划线 snake_case（如 storage_source_id, member_count, displayable）", () => {
    const t = schema.persons as SQLiteTable;
    const sqlNames = getSqlColumnNames(t);

    const requiredSqlNames = [
      "id",
      "storage_source_id",
      "name",
      "bio",
      "representative_face_id",
      "avatar_path",
      "custom_avatar_path",
      "centroid_embedding",
      "member_count",
      "manual_override",
      "displayable",
      "created_at",
      "updated_at",
    ];
    for (const sqlName of requiredSqlNames) {
      expect(sqlNames.has(sqlName), `persons SQL 列缺 ${sqlName}`).toBe(true);
    }
  });

  it("禁止把 displayable 写成 visible / is_displayable", () => {
    const t = schema.persons as SQLiteTable;
    const sqlNames = getSqlColumnNames(t);
    expect(sqlNames.has("visible")).toBe(false);
    expect(sqlNames.has("is_displayable")).toBe(false);
  });

  it("禁止把 centroidEmbedding 写成 centroid 或 embedding", () => {
    const t = schema.persons as SQLiteTable;
    const sqlNames = getSqlColumnNames(t);
    expect(sqlNames.has("centroid")).toBe(false);
    // persons 表不应有 'embedding' 列（embedding 在 faces 表）
    expect(sqlNames.has("embedding")).toBe(false);
  });
});

// =========================================================================
// faces 表存在性 + 字段
// =========================================================================

describe("faces 表 — Schema 契约", () => {
  it("应在 schema 中导出 faces 表", () => {
    expect(schema.faces).toBeDefined();
    expect(typeof schema.faces).toBe("object");
  });

  it("表名应为 'faces'（复数）", () => {
    const cfg = getTableConfig(schema.faces as SQLiteTable);
    expect(cfg.name).toBe("faces");
  });

  it("应包含全部 10 个契约字段", () => {
    const t = schema.faces as SQLiteTable;
    const keys = getJsColumnKeys(t);

    const required = [
      "id",
      "photoId",
      "personId",
      "bboxX",
      "bboxY",
      "bboxW",
      "bboxH",
      "detectionScore",
      "embedding",
      "detectedAt",
    ];
    for (const field of required) {
      expect(keys.has(field), `faces 表缺字段 ${field}`).toBe(true);
    }
  });

  it("SQL 列名为 snake_case（bbox_x/y/w/h, detection_score, person_id, photo_id）", () => {
    const t = schema.faces as SQLiteTable;
    const sqlNames = getSqlColumnNames(t);
    const requiredSqlNames = [
      "id",
      "photo_id",
      "person_id",
      "bbox_x",
      "bbox_y",
      "bbox_w",
      "bbox_h",
      "detection_score",
      "embedding",
      "detected_at",
    ];
    for (const sqlName of requiredSqlNames) {
      expect(sqlNames.has(sqlName), `faces SQL 列缺 ${sqlName}`).toBe(true);
    }
  });

  it("禁止用单 JSON 列替代 bboxX/Y/W/H 4 列（契约规约明示）", () => {
    const t = schema.faces as SQLiteTable;
    const sqlNames = getSqlColumnNames(t);
    expect(sqlNames.has("bbox")).toBe(false);
    expect(sqlNames.has("bbox_json")).toBe(false);
  });
});

// =========================================================================
// 外键 + 索引（通过真实 SQLite 建表 + PRAGMA 反查）
// =========================================================================

describe("Schema DDL 行为（真实 SQLite PRAGMA）", () => {
  // 蓝队实现 schema 后，drizzle-kit push / 应用层应能在真实 SQLite 上建表。
  // 这里手工用契约 DDL 建表，验证 FK + 索引行为；这是行为契约，不是实现契约。

  function setupTablesFromContract(): Database.Database {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE storage_sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'local', root_path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE photos (
        id TEXT PRIMARY KEY,
        storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
        file_path TEXT NOT NULL, file_hash TEXT NOT NULL UNIQUE,
        file_size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE persons (
        id TEXT PRIMARY KEY,
        storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
        name TEXT, bio TEXT,
        representative_face_id TEXT,
        avatar_path TEXT, custom_avatar_path TEXT,
        centroid_embedding TEXT NOT NULL,
        member_count INTEGER NOT NULL DEFAULT 0,
        manual_override INTEGER NOT NULL DEFAULT 0,
        displayable INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE faces (
        id TEXT PRIMARY KEY,
        photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
        person_id TEXT,
        bbox_x INTEGER NOT NULL, bbox_y INTEGER NOT NULL,
        bbox_w INTEGER NOT NULL, bbox_h INTEGER NOT NULL,
        detection_score REAL NOT NULL,
        embedding TEXT NOT NULL,
        detected_at TEXT NOT NULL
      );
      CREATE INDEX idx_persons_source
        ON persons(storage_source_id);
      CREATE INDEX idx_persons_displayable
        ON persons(storage_source_id, displayable, member_count);
    `);
    return sqlite;
  }

  it("persons.storage_source_id 必填且引用 storage_sources(id)", () => {
    const sqlite = setupTablesFromContract();
    // 构造无效 storage_source_id 应失败（FK violation）
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO persons (id, storage_source_id, centroid_embedding, created_at, updated_at)
           VALUES ('p-1', 'nonexistent-source', 'fake-embedding', '2026-01-01', '2026-01-01')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    sqlite.close();
  });

  it("faces.photo_id ON DELETE CASCADE：删除 photo 后对应 face 也删除", () => {
    const sqlite = setupTablesFromContract();
    sqlite
      .prepare("INSERT INTO storage_sources (id, name, root_path) VALUES ('s1', 'S', '/x')")
      .run();
    sqlite
      .prepare(
        "INSERT INTO photos (id, storage_source_id, file_path, file_hash, created_at) VALUES ('ph1', 's1', '/p.jpg', 'h1', '2026-01-01')",
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO faces
         (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, detection_score, embedding, detected_at)
         VALUES ('f1', 'ph1', 0, 0, 100, 100, 0.9, 'fake-emb', '2026-01-01')`,
      )
      .run();

    sqlite.prepare("DELETE FROM photos WHERE id = 'ph1'").run();
    const remaining = sqlite.prepare("SELECT id FROM faces WHERE id = 'f1'").get();
    expect(remaining).toBeUndefined();
    sqlite.close();
  });

  it("persons 索引 idx_persons_source 存在", () => {
    const sqlite = setupTablesFromContract();
    const idx = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
      .get("idx_persons_source") as { name: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx?.name).toBe("idx_persons_source");
    sqlite.close();
  });

  it("persons 复合索引 idx_persons_displayable 存在", () => {
    const sqlite = setupTablesFromContract();
    const idx = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
      .get("idx_persons_displayable") as { name: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx?.name).toBe("idx_persons_displayable");
    sqlite.close();
  });

  it("idx_persons_displayable 索引覆盖 (storage_source_id, displayable, member_count)", () => {
    const sqlite = setupTablesFromContract();
    const cols = sqlite.prepare("PRAGMA index_info(idx_persons_displayable)").all() as Array<{
      name: string;
      seqno: number;
    }>;
    const orderedNames = cols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
    expect(orderedNames).toEqual(["storage_source_id", "displayable", "member_count"]);
    sqlite.close();
  });
});

// =========================================================================
// drizzle 默认值（id $defaultFn）
// =========================================================================

describe("Schema $defaultFn 契约", () => {
  it("persons.id 应有 $defaultFn 默认值（与其他表一致：crypto.randomUUID）", () => {
    const t = schema.persons as SQLiteTable;
    const idCol = (t as unknown as Record<string, unknown>).id as { defaultFn?: () => unknown };
    // drizzle 列对象的 $defaultFn 暴露为 defaultFn 属性
    expect(typeof idCol.defaultFn).toBe("function");
    if (idCol.defaultFn) {
      const v = idCol.defaultFn();
      expect(typeof v).toBe("string");
    }
  });

  it("faces.id 应有 $defaultFn 默认值", () => {
    const t = schema.faces as SQLiteTable;
    const idCol = (t as unknown as Record<string, unknown>).id as { defaultFn?: () => unknown };
    expect(typeof idCol.defaultFn).toBe("function");
  });
});

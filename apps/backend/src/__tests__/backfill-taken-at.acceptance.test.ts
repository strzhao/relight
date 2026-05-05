/**
 * 验收测试（红队）：backfill-taken-at CLI — takenAt 回填逻辑
 *
 * 设计意图：
 *   CLI 命令 `pnpm --filter @relight/backend backfill:taken-at`
 *   将 photos 表中 taken_at IS NULL AND file_mtime IS NOT NULL 的记录
 *   的 taken_at 字段刷成 datetime(file_mtime, 'unixepoch') 的计算值。
 *
 * 接口约定（TDD — 蓝队需适配此接口）：
 *   import { backfillTakenAt } from "../cli/backfill-taken-at"
 *   backfillTakenAt(db: BetterSqlite3.Database): { changedCount: number }
 *
 * 验收标准：
 *   1. 基础回填：taken_at IS NULL + file_mtime 有值 → 刷成 SQLite datetime 字符串
 *   2. 保留已有值：taken_at 已有值 → 不覆盖
 *   3. 幂等性：第二次调用影响行数 = 0
 *   4. 边界：file_mtime IS NULL → taken_at 保持 NULL
 *   5. 边界：0 行待修复 → 成功返回，changedCount = 0，不抛错
 *
 * 注意（蓝队必读）：
 *   必须从 src/cli/backfill-taken-at.ts 中 export 函数：
 *     export function backfillTakenAt(db: Database): { changedCount: number }
 *   如果逻辑只在 main IIFE 里，此测试无法 import。
 *   main() 入口保持原样，但核心逻辑必须通过上述函数导出。
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Mock 全局 db — 防止 src/db/index.ts 在 import 时尝试打开真实数据库文件
// 测试通过参数注入传入 in-memory db，不使用全局 db 实例
// ============================================================================
vi.mock("../db", () => ({
  db: null, // 占位，真实测试通过参数注入
  schema: {},
}));

// ============================================================================
// 接口约定 import（蓝队必须 export 此函数）
// ============================================================================
import { backfillTakenAt } from "../cli/backfill-taken-at";

// ============================================================================
// 测试数据库工厂 — 每个 test 创建独立的 in-memory SQLite
// ============================================================================

/**
 * 创建最小化的 photos 表（仅包含 backfill 所需列）和一个 storage_sources 表作为 FK 来源。
 *
 * 不引入 Drizzle schema，直接用 DDL SQL，避免依赖 DB 文件。
 * 外键：SQLite 默认关闭外键，测试中开启以保证数据完整性。
 */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE storage_sources (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      root_path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE photos (
      id                TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
      file_path         TEXT NOT NULL,
      file_hash         TEXT NOT NULL UNIQUE,
      width             INTEGER NOT NULL DEFAULT 0,
      height            INTEGER NOT NULL DEFAULT 0,
      file_size         INTEGER NOT NULL DEFAULT 0,
      thumbnail_path    TEXT,
      taken_at          TEXT,
      file_mtime        INTEGER,
      created_at        TEXT NOT NULL,
      UNIQUE(storage_source_id, file_path)
    );
  `);

  // 插入一个默认存储源供所有测试使用
  db.prepare(`
    INSERT INTO storage_sources (id, name, type, root_path)
    VALUES ('src-test', '测试存储源', 'local', '/test')
  `).run();

  return db;
}

// ============================================================================
// 辅助函数：插入测试照片
// ============================================================================

let _photoCounter = 0;

function insertPhoto(
  db: Database.Database,
  opts: {
    id?: string;
    takenAt?: string | null;
    fileMtime?: number | null;
    filePath?: string;
  },
): string {
  _photoCounter++;
  const id = opts.id ?? `photo-${_photoCounter}`;
  const filePath = opts.filePath ?? `/photos/test-${_photoCounter}.jpg`;
  const fileHash = `hash-${_photoCounter}-${Math.random().toString(36).slice(2)}`;

  db.prepare(`
    INSERT INTO photos (id, storage_source_id, file_path, file_hash, created_at, taken_at, file_mtime)
    VALUES (?, 'src-test', ?, ?, '2024-01-01T00:00:00.000Z', ?, ?)
  `).run(id, filePath, fileHash, opts.takenAt ?? null, opts.fileMtime ?? null);

  return id;
}

/**
 * 从 DB 读取单张照片的 taken_at 字段
 */
function getTakenAt(db: Database.Database, id: string): string | null {
  const row = db.prepare("SELECT taken_at FROM photos WHERE id = ?").get(id) as
    | { taken_at: string | null }
    | undefined;
  return row?.taken_at ?? null;
}

// ============================================================================
// 测试套件
// ============================================================================

describe("backfillTakenAt — 验收测试（红队，设计意图驱动）", () => {
  let db: Database.Database;

  beforeEach(() => {
    _photoCounter = 0;
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // --------------------------------------------------------------------------
  // 用例 1：基础回填
  // --------------------------------------------------------------------------
  describe("用例 1：基础回填 — taken_at IS NULL + file_mtime IS NOT NULL", () => {
    it("应将 taken_at IS NULL 且 file_mtime 有值的记录刷成 datetime(file_mtime,'unixepoch') 格式", () => {
      const id1 = insertPhoto(db, { takenAt: null, fileMtime: 1700000000 });
      const id2 = insertPhoto(db, { takenAt: null, fileMtime: 1800000000 });
      const id3 = insertPhoto(db, { takenAt: null, fileMtime: null }); // 无 mtime，不应回填

      const result = backfillTakenAt(db);

      // id1 和 id2 应被回填
      expect(result.changedCount).toBe(2);

      // 验证 id1 的值：datetime(1700000000,'unixepoch') = '2023-11-14 22:13:20'
      const takenAt1 = getTakenAt(db, id1);
      expect(takenAt1).not.toBeNull();
      // SQLite datetime() 返回格式 'YYYY-MM-DD HH:MM:SS'
      expect(takenAt1).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      // 验证具体值：unix timestamp 1700000000 → 2023-11-14 22:13:20 UTC
      expect(takenAt1).toBe("2023-11-14 22:13:20");

      // 验证 id2 的值：datetime(1800000000,'unixepoch') = '2027-01-15 08:00:00'
      const takenAt2 = getTakenAt(db, id2);
      expect(takenAt2).not.toBeNull();
      expect(takenAt2).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(takenAt2).toBe("2027-01-15 08:00:00");

      // id3 无 mtime，taken_at 应保持 NULL
      expect(getTakenAt(db, id3)).toBeNull();
    });

    it("3 张照片：2 张有 mtime、1 张无 mtime — changedCount 应为 2", () => {
      const id1 = insertPhoto(db, { takenAt: null, fileMtime: 1700000000 });
      const id2 = insertPhoto(db, { takenAt: null, fileMtime: 1800000000 });
      const id3 = insertPhoto(db, { takenAt: null, fileMtime: null });

      const { changedCount } = backfillTakenAt(db);

      expect(changedCount).toBe(2);
      expect(getTakenAt(db, id1)).not.toBeNull();
      expect(getTakenAt(db, id2)).not.toBeNull();
      expect(getTakenAt(db, id3)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 用例 2：保留已有值
  // --------------------------------------------------------------------------
  describe("用例 2：保留已有值 — taken_at 已有值不应被覆盖", () => {
    it("已有 taken_at 值的照片，即使 file_mtime 不同，taken_at 应保持原值", () => {
      const existingTakenAt = "2024-01-15T10:00:00.000Z";
      const id = insertPhoto(db, {
        takenAt: existingTakenAt,
        fileMtime: 1700000000, // 对应 2023-11-14，与 takenAt 不一致
      });

      backfillTakenAt(db);

      // taken_at 应保持原来的值，不被 file_mtime 覆盖
      expect(getTakenAt(db, id)).toBe(existingTakenAt);
    });

    it("已有 taken_at 的记录不计入 changedCount", () => {
      insertPhoto(db, { takenAt: "2024-06-01 12:00:00", fileMtime: 1700000000 });
      insertPhoto(db, { takenAt: "2024-07-01 08:00:00", fileMtime: 1800000000 });

      const { changedCount } = backfillTakenAt(db);

      expect(changedCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 用例 3：幂等性
  // --------------------------------------------------------------------------
  describe("用例 3：幂等性 — 第二次调用影响行数应为 0", () => {
    it("第一次调用回填成功后，第二次调用 changedCount 应为 0", () => {
      insertPhoto(db, { takenAt: null, fileMtime: 1700000000 });
      insertPhoto(db, { takenAt: null, fileMtime: 1800000000 });

      // 第一次调用
      const first = backfillTakenAt(db);
      expect(first.changedCount).toBe(2);

      // 第二次调用
      const second = backfillTakenAt(db);
      expect(second.changedCount).toBe(0);
    });

    it("多次调用后 DB 数据不应发生变化（结果稳定）", () => {
      const id1 = insertPhoto(db, { takenAt: null, fileMtime: 1700000000 });

      backfillTakenAt(db);
      const takenAtAfterFirst = getTakenAt(db, id1);

      backfillTakenAt(db);
      const takenAtAfterSecond = getTakenAt(db, id1);

      backfillTakenAt(db);
      const takenAtAfterThird = getTakenAt(db, id1);

      expect(takenAtAfterFirst).not.toBeNull();
      expect(takenAtAfterSecond).toBe(takenAtAfterFirst);
      expect(takenAtAfterThird).toBe(takenAtAfterFirst);
    });
  });

  // --------------------------------------------------------------------------
  // 用例 4：边界 — file_mtime IS NULL
  // --------------------------------------------------------------------------
  describe("用例 4：边界 — file_mtime IS NULL 时 taken_at 保持 NULL", () => {
    it("taken_at IS NULL 且 file_mtime IS NULL 的记录 taken_at 应保持 NULL", () => {
      const id = insertPhoto(db, { takenAt: null, fileMtime: null });

      backfillTakenAt(db);

      expect(getTakenAt(db, id)).toBeNull();
    });

    it("file_mtime IS NULL 的记录不计入 changedCount", () => {
      // 所有记录都没有 file_mtime
      insertPhoto(db, { takenAt: null, fileMtime: null });
      insertPhoto(db, { takenAt: null, fileMtime: null });
      insertPhoto(db, { takenAt: null, fileMtime: null });

      const { changedCount } = backfillTakenAt(db);

      expect(changedCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 用例 5：边界 — 0 行待修复
  // --------------------------------------------------------------------------
  describe("用例 5：边界 — 0 行待修复时应成功返回，不抛错", () => {
    it("空表（无任何照片）应成功返回 changedCount = 0", () => {
      // db 是空的（只有 storage_sources 一条记录）
      expect(() => backfillTakenAt(db)).not.toThrow();

      const { changedCount } = backfillTakenAt(db);
      expect(changedCount).toBe(0);
    });

    it("所有照片 taken_at 均已有值（无需回填）应返回 changedCount = 0", () => {
      insertPhoto(db, { takenAt: "2024-01-01 00:00:00", fileMtime: 1700000000 });
      insertPhoto(db, { takenAt: "2024-06-15 12:30:00", fileMtime: 1800000000 });

      const { changedCount } = backfillTakenAt(db);
      expect(changedCount).toBe(0);
    });

    it("所有照片均无 file_mtime 时（无法回填）应返回 changedCount = 0，不抛错", () => {
      insertPhoto(db, { takenAt: null, fileMtime: null });
      insertPhoto(db, { takenAt: null, fileMtime: null });

      expect(() => backfillTakenAt(db)).not.toThrow();
      const { changedCount } = backfillTakenAt(db);
      expect(changedCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 用例 6：混合场景
  // --------------------------------------------------------------------------
  describe("用例 6：混合场景 — 各种状态照片同时存在", () => {
    it("4 种状态混合：正确回填 2 张，保留 1 张，跳过 1 张 NULL mtime", () => {
      // 待回填（应被回填）
      const idNeedsFill1 = insertPhoto(db, { takenAt: null, fileMtime: 1700000000 });
      const idNeedsFill2 = insertPhoto(db, { takenAt: null, fileMtime: 1750000000 });
      // 已有值（不应覆盖）
      const idHasValue = insertPhoto(db, {
        takenAt: "2024-03-20 08:00:00",
        fileMtime: 1700000000,
      });
      // 无 mtime（保持 NULL）
      const idNoMtime = insertPhoto(db, { takenAt: null, fileMtime: null });

      const { changedCount } = backfillTakenAt(db);

      expect(changedCount).toBe(2);

      // 两张已回填
      expect(getTakenAt(db, idNeedsFill1)).toBe("2023-11-14 22:13:20");
      expect(getTakenAt(db, idNeedsFill2)).not.toBeNull();

      // 原有值不变
      expect(getTakenAt(db, idHasValue)).toBe("2024-03-20 08:00:00");

      // 无 mtime 保持 NULL
      expect(getTakenAt(db, idNoMtime)).toBeNull();
    });

    it("大批量：100 张待回填照片应全部正确处理", () => {
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        ids.push(insertPhoto(db, { takenAt: null, fileMtime: 1700000000 + i * 1000 }));
      }

      const { changedCount } = backfillTakenAt(db);

      expect(changedCount).toBe(100);

      // 所有照片的 taken_at 均不为 NULL
      for (const id of ids) {
        expect(getTakenAt(db, id)).not.toBeNull();
        expect(getTakenAt(db, id)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 用例 7：返回值契约
  // --------------------------------------------------------------------------
  describe("用例 7：返回值契约 — backfillTakenAt 返回对象结构", () => {
    it("返回值应是包含 changedCount 数字属性的对象", () => {
      const result = backfillTakenAt(db);

      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
      expect(typeof result.changedCount).toBe("number");
      expect(result.changedCount).toBeGreaterThanOrEqual(0);
    });

    it("changedCount 应为非负整数", () => {
      insertPhoto(db, { takenAt: null, fileMtime: 1700000000 });

      const { changedCount } = backfillTakenAt(db);

      expect(Number.isInteger(changedCount)).toBe(true);
      expect(changedCount).toBeGreaterThanOrEqual(0);
    });
  });
});

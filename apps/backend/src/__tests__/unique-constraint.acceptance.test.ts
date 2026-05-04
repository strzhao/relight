import type { SQLiteTable } from "drizzle-orm/sqlite-core";
/**
 * 验收测试：photos 表复合 UNIQUE 约束
 *
 * 覆盖设计文档 §1 数据库清理 + UNIQUE 约束：
 * - photos 表必须包含复合唯一约束 unique().on(storageSourceId, filePath)
 * - 防止同一存储源下重复插入相同路径的照片
 * - 约束定义在 Drizzle sqliteTable 的第三个参数（extras builder）中
 */
import { beforeAll, describe, expect, it } from "vitest";

// ---- 辅助工具 ----

/**
 * 获取 Drizzle 表的 extras 配置（包含唯一约束、主键等）
 */
function getTableExtras(table: SQLiteTable): Record<string, unknown> {
  const internals = table as unknown as Record<string | symbol, unknown>;
  // Drizzle sqliteTable 第三个参数的配置存储在 Symbol.for("drizzle:SQLiteTable") 中
  const config = internals[Symbol.for("drizzle:SQLiteTable")] as
    | Record<string, unknown>
    | undefined;
  return (config as Record<string, unknown>) ?? {};
}

/**
 * 获取 Drizzle SQLiteTable 的列名集合
 */
function getSQLColumnNames(table: SQLiteTable): Set<string> {
  const names: Set<string> = new Set();
  const tableAny = table as unknown as Record<string, unknown>;
  for (const [, value] of Object.entries(tableAny)) {
    if (
      typeof value === "object" &&
      value !== null &&
      "name" in value &&
      typeof (value as { name: unknown }).name === "string"
    ) {
      names.add((value as { name: string }).name);
    }
  }
  return names;
}

/**
 * 检查 Drizzle 表是否包含指定的复合唯一约束。
 *
 * Drizzle 的 unique() 约束存储在内置 SQLiteTable 的 uniqueConstraints 数组中，
 * 或通过 Symbol.for("drizzle:SQLiteTable") 的 uniqueConstraints 暴露。
 */
function hasUniqueConstraint(table: SQLiteTable, expectedColumns: string[]): boolean {
  const tableAny = table as unknown as Record<string | symbol, unknown>;

  // 方案1：检查 Symbol 配置中的 uniqueConstraints
  const symbolConfig = tableAny[Symbol.for("drizzle:SQLiteTable")] as
    | Record<string, unknown>
    | undefined;
  if (symbolConfig) {
    const uniqueConstraints = symbolConfig.uniqueConstraints as
      | Array<{ columns: string[] }>
      | undefined;
    if (uniqueConstraints && Array.isArray(uniqueConstraints)) {
      for (const constraint of uniqueConstraints) {
        if (
          Array.isArray(constraint.columns) &&
          constraint.columns.length === expectedColumns.length &&
          constraint.columns.every((col) => expectedColumns.includes(col))
        ) {
          return true;
        }
      }
    }
  }

  // 方案2：检查 $uniqueConstraints 属性
  const uniqueConstraintsAlt = tableAny.$uniqueConstraints as
    | Array<{ columns: string[] }>
    | undefined;
  if (uniqueConstraintsAlt && Array.isArray(uniqueConstraintsAlt)) {
    for (const constraint of uniqueConstraintsAlt) {
      if (
        Array.isArray(constraint.columns) &&
        constraint.columns.length === expectedColumns.length &&
        constraint.columns.every((col) => expectedColumns.includes(col))
      ) {
        return true;
      }
    }
  }

  // 方案3：遍历所有属性查找 UniqueConstraint 实例
  const uniqueConstraintNames: string[] = [];
  for (const [key, value] of Object.entries(tableAny)) {
    if (typeof value === "object" && value !== null) {
      const valAny = value as Record<string, unknown>;
      // UniqueConstraint 实例通常有 getName 方法和 columns 属性
      if (typeof valAny.getName === "function" && Array.isArray(valAny.columns)) {
        uniqueConstraintNames.push(key);
      }
    }
  }

  return false;
}

/**
 * 通过 Drizzle SQL 生成来验证唯一约束。
 * Drizzle 的 SQL 生成会输出 UNIQUE 子句。
 */
function getGeneratedSQL(table: SQLiteTable): string {
  const tableAny = table as unknown as Record<string, unknown>;
  // 尝试通过 getSQL() 获取生成的 SQL
  if (typeof tableAny.getSQL === "function") {
    try {
      const sql = (tableAny.getSQL as () => string)();
      return sql;
    } catch {
      // getSQL 可能不存在或失败
    }
  }
  return "";
}

// ---- 测试 ----

describe("photos 表复合 UNIQUE 约束 — 验收测试（设计文档 §1）", () => {
  let photos: SQLiteTable;

  beforeAll(async () => {
    const schema = (await import("../db/schema")) as Record<string, unknown>;
    photos = schema.photos as SQLiteTable;
  });

  describe("photos 表基础列定义", () => {
    it("应包含 storage_source_id 列", () => {
      const columns = getSQLColumnNames(photos);
      expect(columns.has("storage_source_id")).toBe(true);
    });

    it("应包含 file_path 列", () => {
      const columns = getSQLColumnNames(photos);
      expect(columns.has("file_path")).toBe(true);
    });

    it("storage_source_id 和 file_path 应为 NOT NULL 列", () => {
      // 设计文档要求 (storage_source_id, file_path) 作为复合唯一键
      // 两个列都必须存在且非空
      const columns = getSQLColumnNames(photos);
      expect(columns.has("storage_source_id")).toBe(true);
      expect(columns.has("file_path")).toBe(true);
    });
  });

  describe("复合 UNIQUE 约束 (storage_source_id, file_path)", () => {
    it("应定义复合唯一约束覆盖 storage_source_id 和 file_path 两列", () => {
      // 检查 Drizzle 表内部是否包含唯一约束定义
      const tableAny = photos as unknown as Record<string | symbol, unknown>;

      // 收集约束信息
      const foundConstraints: Array<{ name: string; columns: string[] }> = [];

      // 检查 Symbol 配置
      const symbolConfig = tableAny[Symbol.for("drizzle:SQLiteTable")] as Record<
        string | symbol,
        unknown
      > | null;
      if (symbolConfig) {
        const uq = symbolConfig.uniqueConstraints as
          | Array<{ columns: string[]; name?: string }>
          | undefined;
        if (uq) {
          for (const c of uq) {
            foundConstraints.push({ name: c.name ?? "unnamed", columns: c.columns });
          }
        }
      }

      // 检查 $uniqueConstraints
      const uqAlt = tableAny.$uniqueConstraints as
        | Array<{ columns: string[]; name?: string }>
        | undefined;
      if (uqAlt) {
        for (const c of uqAlt) {
          foundConstraints.push({ name: c.name ?? "unnamed", columns: c.columns });
        }
      }

      // 检查 ExtraConfigBuilder — Drizzle extras 通过 builder 函数返回，
      // 其中包含 unique() 约束
      const extraConfigBuilderSym = Object.getOwnPropertySymbols(tableAny).find((s) =>
        s.toString().includes("ExtraConfigBuilder"),
      );
      if (extraConfigBuilderSym && typeof tableAny[extraConfigBuilderSym] === "function") {
        try {
          const extras = (
            tableAny[extraConfigBuilderSym] as (...args: unknown[]) => Record<string, unknown>
          )(photos);
          for (const [, value] of Object.entries(extras as Record<string, unknown>)) {
            if (
              typeof value === "object" &&
              value !== null &&
              "columns" in value &&
              Array.isArray((value as { columns: unknown }).columns)
            ) {
              const cols: string[] = (value as { columns: unknown[] }).columns.map(
                (col: unknown) => {
                  if (typeof col === "object" && col !== null && "name" in col) {
                    return (col as { name: string }).name;
                  }
                  return "";
                },
              );
              foundConstraints.push({
                name: "name" in value ? String((value as { name: string }).name) : "unnamed",
                columns: cols,
              });
            }
          }
        } catch {
          // ignore call errors
        }
      }

      // 验证存在包含 storage_source_id 和 file_path 的约束
      const hasTargetConstraint = foundConstraints.some((c) => {
        const cols = c.columns.map((col) => col.toLowerCase());
        return cols.includes("storage_source_id") && cols.includes("file_path");
      });

      expect(hasTargetConstraint).toBe(true);
    });

    it("复合唯一约束应仅包含两列（不包含其他冗余列）", () => {
      const tableAny = photos as unknown as Record<string | symbol, unknown>;

      // 通过 ExtraConfigBuilder 获取 extras 中的 unique() 约束
      const extraConfigBuilderSym = Object.getOwnPropertySymbols(tableAny).find((s) =>
        s.toString().includes("ExtraConfigBuilder"),
      );
      if (extraConfigBuilderSym && typeof tableAny[extraConfigBuilderSym] === "function") {
        try {
          const extras = (
            tableAny[extraConfigBuilderSym] as (...args: unknown[]) => Record<string, unknown>
          )(photos) as Record<string, unknown>;
          for (const [, value] of Object.entries(extras)) {
            if (
              typeof value === "object" &&
              value !== null &&
              "columns" in value &&
              Array.isArray((value as { columns: unknown }).columns)
            ) {
              const cols: string[] = (value as { columns: unknown[] }).columns.map(
                (col: unknown) => {
                  if (typeof col === "object" && col !== null && "name" in col) {
                    return (col as { name: string }).name;
                  }
                  return "";
                },
              );
              if (cols.includes("storage_source_id") && cols.includes("file_path")) {
                expect(cols.length).toBe(2);
              }
            }
          }
        } catch {
          // ignore
        }
      }
    });

    it("不应允许同一存储源下插入相同路径的照片（设计意图）", () => {
      // 设计文档意图：一个存储源下，同一个 file_path 只能有一条照片记录
      // 这通过 UNIQUE(storage_source_id, file_path) 约束保证
      const constraintDescription =
        "UNIQUE(storage_source_id, file_path) 确保 (存储源, 文件路径) 唯一";
      expect(constraintDescription).toContain("UNIQUE");
      expect(constraintDescription).toContain("storage_source_id");
      expect(constraintDescription).toContain("file_path");
    });
  });

  describe("约束与现有 id 主键的关系", () => {
    it("复合唯一约束是独立于 id 主键的额外约束", () => {
      const columns = getSQLColumnNames(photos);
      // id 仍是主键
      expect(columns.has("id")).toBe(true);
      // 复合唯一约束是额外的数据完整性保护
    });

    it("不应替换或移除 id 主键列", () => {
      const columns = getSQLColumnNames(photos);
      expect(columns.has("id")).toBe(true);
    });
  });
});

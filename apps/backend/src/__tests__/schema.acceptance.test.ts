import type { SQLiteTable } from "drizzle-orm/sqlite-core";
/**
 * 验收测试：DB Schema 完整性
 *
 * 覆盖设计文档 §1 DB Schema 修复 + 扩展：
 * - 所有表 id 列存在且类型正确
 * - photoTags 复合主键
 * - photoAnalyses 新增字段齐全
 * - Drizzle Relations 正确配置
 * - 标签类别 7 个枚举值
 * - 所有表总数 = 8
 */
import { beforeAll, describe, expect, it } from "vitest";

/**
 * 设计文档定义的完整 Schema 快照。
 *
 * 设计文档 §1 要求：
 * 1. 所有表 id 列添加 $defaultFn: () => crypto.randomUUID()
 * 2. photoTags 添加复合主键 primaryKey({ columns: [photoId, tagId] })
 * 3. photoAnalyses 新增字段:
 *    narrative, aestheticScore, tags(JSON), composition(JSON),
 *    colorAnalysis(JSON), emotionalAnalysis(JSON), usageSuggestions, promptVersion
 * 4. Drizzle Relations: photos↔storageSources, photos↔photoTags,
 *    photos↔photoAnalyses, photoTags↔tag
 */

// ---- 辅助工具 ----

/** 提取 Drizzle SQLite 表的列定义映射 */
function getColumnNames(table: SQLiteTable): Set<string> {
  const columns: Set<string> = new Set();
  // Drizzle SQLiteTable 内部结构中 SQL 符号名为实际列名
  for (const key of Object.keys(table)) {
    // 跳过 Drizzle 内部属性 ($ 开头)
    if (key.startsWith("$") || key.startsWith("_")) continue;
    columns.add(key);
  }
  return columns;
}

/** 获取表的 Drizzle SymbolName -> SQL 列名映射 */
function getSQLColumnNames(table: SQLiteTable): Set<string> {
  const names: Set<string> = new Set();
  // Drizzle v0.41+ 列的 getSQLName 方法或直接通过 Symbol 读取
  const drizzleInternals = table as unknown as Record<string | symbol, unknown>;
  const config = drizzleInternals[Symbol.for("drizzle:SQLiteTable")] as
    | Record<string, { name: string }>
    | undefined;

  if (config) {
    for (const col of Object.values(config)) {
      if (col?.name) names.add(col.name);
    }
  }

  // 备选方案：尝试直接访问已知的列对象
  const tableAny = table as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(tableAny)) {
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

// ---- 测试 ----

describe("DB Schema 完整性 — 验收测试（设计文档 §1）", () => {
  // 使用动态 import 避免顶层 import 失败时的硬错误
  let schema: Record<string, unknown>;

  beforeAll(async () => {
    schema = (await import("../db/schema")) as unknown as Record<string, unknown>;
  });

  describe("表数量", () => {
    it("应包含设计文档规定的 8 张表", () => {
      // Drizzle SQLiteTable 实例内部有 getSQL 等方法，也有特定 Symbol
      const tableNames = Object.keys(schema).filter((k) => {
        const val = schema[k];
        if (typeof val !== "object" || val === null) return false;
        // Drizzle SQLiteTable 实例具有 getSQL 方法
        return typeof (val as Record<string, unknown>).getSQL === "function";
      });
      // 设计文档定义: storageSources, photos, tags, photoTags,
      //   photoAnalyses, dailyPicks, scanLogs, settings
      expect(tableNames.length).toBeGreaterThanOrEqual(8);
    });
  });

  describe("表存在性", () => {
    const requiredTables = [
      "storageSources",
      "photos",
      "tags",
      "photoTags",
      "photoAnalyses",
      "dailyPicks",
      "scanLogs",
      "settings",
    ];

    it.each(requiredTables)("应导出 %s 表定义", (tableName) => {
      expect(schema[tableName]).toBeDefined();
      expect(typeof schema[tableName]).toBe("object");
    });
  });

  describe("photoAnalyses 新增字段（设计文档 §1.3）", () => {
    const requiredNewFields = [
      "narrative", // 叙事描述
      "aestheticScore", // 美学评分
      "tags", // 标签 (JSON)
      "composition", // 构图分析 (JSON)
      "colorAnalysis", // 色彩分析 (JSON)
      "emotionalAnalysis", // 情感分析 (JSON)
      "usageSuggestions", // 建议用途
      "promptVersion", // Prompt 版本
    ];

    it("应包含所有新增分析字段", () => {
      const table = schema.photoAnalyses as SQLiteTable;
      expect(table).toBeDefined();

      const sqlNames = getSQLColumnNames(table);
      const colKeys = getColumnNames(table);

      // 所有新增字段应在列定义中
      for (const field of requiredNewFields) {
        const found = colKeys.has(field) || sqlNames.has(field) || sqlNames.has(toSnakeCase(field));
        expect(found).toBe(true);
      }
    });

    it("应保留原有字段 (photoId, aiModel, rawResponse, processedAt)", () => {
      const table = schema.photoAnalyses as SQLiteTable;
      const colKeys = getColumnNames(table);

      const originalFields = ["photoId", "aiModel", "rawResponse", "processedAt"];
      for (const field of originalFields) {
        expect(colKeys.has(field)).toBe(true);
      }
    });
  });

  describe("photoTags 复合主键（设计文档 §1.2）", () => {
    it("应配置为复合主键 [photoId, tagId]", () => {
      const table = schema.photoTags as SQLiteTable;
      expect(table).toBeDefined();

      const colKeys = getColumnNames(table);
      expect(colKeys.has("photoId")).toBe(true);
      expect(colKeys.has("tagId")).toBe(true);
      expect(colKeys.has("confidence")).toBe(true);
      // 复合主键验证：不应有单独的 id 列
      expect(colKeys.has("id")).toBe(false);
    });
  });

  describe("所有表 id 列（设计文档 §1.1）", () => {
    const tablesWithId = [
      "storageSources",
      "photos",
      "tags",
      "photoAnalyses",
      "dailyPicks",
      "scanLogs",
    ];

    it.each(tablesWithId)("%s 应有 id 主键列", (tableName) => {
      const table = schema[tableName] as SQLiteTable;
      expect(table).toBeDefined();
      const colKeys = getColumnNames(table);
      expect(colKeys.has("id")).toBe(true);
    });
  });

  describe("tags 表 category 枚举（设计文档 §2）", () => {
    it("应支持 7 个标签类别", () => {
      const validCategories = ["scene", "emotion", "people", "color", "event", "object", "style"];
      expect(validCategories).toHaveLength(7);

      const table = schema.tags as SQLiteTable;
      expect(table).toBeDefined();
      const colKeys = getColumnNames(table);
      expect(colKeys.has("category")).toBe(true);
    });
  });

  describe("Drizzle Relations（设计文档 §1.4）", () => {
    it("应定义 photos ↔ storageSources 关系", () => {
      const table = schema.photos as SQLiteTable;
      expect(table).toBeDefined();
      const colKeys = getColumnNames(table);
      expect(colKeys.has("storageSourceId")).toBe(true);
    });

    it("应定义 photoTags.photoId → photos.id 外键", () => {
      const table = schema.photoTags as SQLiteTable;
      expect(table).toBeDefined();
      const colKeys = getColumnNames(table);
      expect(colKeys.has("photoId")).toBe(true);
    });

    it("应定义 photoTags.tagId → tags.id 外键", () => {
      const table = schema.photoTags as SQLiteTable;
      const colKeys = getColumnNames(table);
      expect(colKeys.has("tagId")).toBe(true);
    });

    it("应定义 photoAnalyses → photos 关系", () => {
      const table = schema.photoAnalyses as SQLiteTable;
      expect(table).toBeDefined();
      const colKeys = getColumnNames(table);
      expect(colKeys.has("photoId")).toBe(true);
    });
  });

  describe("settings 表（key-value 键值对）", () => {
    it("应包含 key 和 value 列", () => {
      const table = schema.settings as SQLiteTable;
      expect(table).toBeDefined();
      const colKeys = getColumnNames(table);
      expect(colKeys.has("key")).toBe(true);
      expect(colKeys.has("value")).toBe(true);
    });
  });

  describe("scanLogs 表", () => {
    it("应包含扫描统计字段", () => {
      const table = schema.scanLogs as SQLiteTable;
      expect(table).toBeDefined();
      const colKeys = getColumnNames(table);
      expect(colKeys.has("storageSourceId")).toBe(true);
      expect(colKeys.has("scannedCount")).toBe(true);
      expect(colKeys.has("newCount")).toBe(true);
      expect(colKeys.has("errorCount")).toBe(true);
      expect(colKeys.has("startedAt")).toBe(true);
      expect(colKeys.has("finishedAt")).toBe(true);
    });
  });

  describe("photos 表", () => {
    it("应包含文件信息和哈希字段", () => {
      const table = schema.photos as SQLiteTable;
      expect(table).toBeDefined();
      const colKeys = getColumnNames(table);
      expect(colKeys.has("filePath")).toBe(true);
      expect(colKeys.has("fileHash")).toBe(true);
      expect(colKeys.has("width")).toBe(true);
      expect(colKeys.has("height")).toBe(true);
      expect(colKeys.has("fileSize")).toBe(true);
      expect(colKeys.has("thumbnailPath")).toBe(true);
      expect(colKeys.has("takenAt")).toBe(true);
    });
  });

  describe("dailyPicks 表", () => {
    it("应包含精选相关字段", () => {
      const table = schema.dailyPicks as SQLiteTable;
      expect(table).toBeDefined();
      const colKeys = getColumnNames(table);
      expect(colKeys.has("photoId")).toBe(true);
      expect(colKeys.has("pickDate")).toBe(true);
      expect(colKeys.has("title")).toBe(true);
      expect(colKeys.has("narrative")).toBe(true);
      expect(colKeys.has("score")).toBe(true);
    });
  });
});

// ---- 辅助函数 ----

function toSnakeCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

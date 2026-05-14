/**
 * 验收测试：settings helper 基础 CRUD（红队）
 *
 * 设计契约来源（state.md §设计文档 / §实现步骤详解 Step 1）：
 *
 *   apps/backend/src/lib/settings/index.ts 必须导出：
 *     - getSettingValue(key: string): Promise<string | null>
 *     - setSettingValue(key: string, value: string): Promise<void>   // upsert 语义
 *     - deleteSetting(key: string): Promise<void>                    // 幂等
 *
 *   "无内存缓存，每次 SELECT，避免热更新失效语义"
 *
 * 验证点（一对一对应实现步骤详解的 helper 行为）：
 *   1. getSettingValue 不存在的 key → 返回 null（非 undefined / 非抛异常）
 *   2. setSettingValue 后 getSettingValue 同 key → 返回相同 value
 *   3. setSettingValue 同 key 二次（不同 value） → 第二次值覆盖（settings 行数仍 = 1）
 *   4. deleteSetting 后 getSettingValue → 再次返回 null
 *   5. deleteSetting 不存在的 key → 不抛异常（幂等）
 *
 * 红队铁律：
 * - 不读取 lib/settings/index.ts 实现源码
 * - 仅通过公共导出 API 黑盒触发
 * - 用真实 SQLite（:memory:）+ schema settings 表（key/value）
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "../../../__tests__/helpers/test-schema";
import * as schema from "../../../db/schema";

// =====================================================================
// 内存 SQLite + db 模块 mock（含 settings 表）
// =====================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;

vi.mock("../../../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

// =====================================================================
// 测试
// =====================================================================

describe("lib/settings helper — 验收测试（红队）", () => {
  let getSettingValue: (key: string) => Promise<string | null>;
  let setSettingValue: (key: string, value: string) => Promise<void>;
  let deleteSetting: (key: string) => Promise<void>;

  beforeEach(async () => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;

    vi.resetModules();
    const mod = await import("../index");
    getSettingValue = mod.getSettingValue as typeof getSettingValue;
    setSettingValue = mod.setSettingValue as typeof setSettingValue;
    deleteSetting = mod.deleteSetting as typeof deleteSetting;
  });

  afterEach(() => {
    testSqlite.close();
  });

  it("契约 §helper.1 getSettingValue 不存在的 key 返回 null（非 undefined / 非抛异常）", async () => {
    const v = await getSettingValue("no-such-key");
    expect(v).toBeNull();
  });

  it("契约 §helper.2 setSettingValue 后 getSettingValue 同 key 返回写入的 value", async () => {
    await setSettingValue("selfPersonId", "person-abc");

    const v = await getSettingValue("selfPersonId");
    expect(v).toBe("person-abc");
  });

  it("契约 §helper.3 setSettingValue 同 key 二次覆盖（不重复行，行数恒 = 1）", async () => {
    await setSettingValue("selfPersonId", "person-old");
    await setSettingValue("selfPersonId", "person-new");

    // 读取应是覆盖后的新值
    const v = await getSettingValue("selfPersonId");
    expect(v).toBe("person-new");

    // settings 表 key 是主键，不能出现两行同 key（直接查表防御实现走 INSERT 不带 UPSERT 的退路）
    const rows = testSqlite
      .prepare("SELECT key, value FROM settings WHERE key = ?")
      .all("selfPersonId") as { key: string; value: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("person-new");
  });

  it("契约 §helper.4 deleteSetting 后 getSettingValue 再次返回 null", async () => {
    await setSettingValue("selfPersonId", "person-to-delete");
    expect(await getSettingValue("selfPersonId")).toBe("person-to-delete");

    await deleteSetting("selfPersonId");

    const v = await getSettingValue("selfPersonId");
    expect(v).toBeNull();

    // 表中也实际无该行
    const row = testSqlite.prepare("SELECT key FROM settings WHERE key = ?").get("selfPersonId");
    expect(row).toBeUndefined();
  });

  it("契约 §helper.5 deleteSetting 不存在的 key 不抛异常（幂等）", async () => {
    await expect(deleteSetting("never-existed-key")).resolves.not.toThrow();

    // 二次 delete 同样不抛
    await expect(deleteSetting("never-existed-key")).resolves.not.toThrow();
  });

  it("契约 §helper.6 setSettingValue 写入后的值，独立第二次 getSettingValue 仍返回相同值（无内存缓存失效问题）", async () => {
    await setSettingValue("k", "v1");
    // 直接绕过 helper 写库，模拟外部进程改值
    testSqlite.prepare("UPDATE settings SET value = ? WHERE key = ?").run("v2-external", "k");

    // helper 不应有内存缓存，必须每次 SELECT
    const v = await getSettingValue("k");
    expect(v).toBe("v2-external");
  });
});

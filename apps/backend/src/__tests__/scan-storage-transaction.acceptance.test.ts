/**
 * 验收测试（红队）：scan-storage transaction async bug 修复契约
 *
 * 设计文档契约（逐字一致）：
 *   - drizzle better-sqlite3 禁止 `db.transaction(async (tx) => {...})`，
 *     必须同步回调；async 回调会抛 "Transaction function cannot return a promise"
 *   - 多语句写操作保留 transaction 保原子性（同步回调）
 *   - 单语句可省略 transaction 包裹（SQLite 单语句天然原子）
 *
 * 覆盖验收点 6：transaction 契约（行为级 / 静态断言）
 *
 * 红队铁律说明：
 *   设计文档明确授权："读源码做 grep 式断言是允许的，因为断言的是
 *   '不应出现的反模式'而非实现细节"。本测试断言的是"代码不应包含
 *   `db.transaction(async` 这一已知会导致 Transaction function cannot
 *   return a promise 的反模式字符串"，属于契约级黑盒断言。
 *
 *   依据铁律，本测试不验证 transaction 的具体业务逻辑（那是蓝队实现细节），
 *   只验证"反模式字符串已从源码中消失"这一可观测契约。
 *
 * Context（bug 复盘）：
 *   历史上 scan-storage.ts 两处 `await db.transaction(async (tx) => {...})`
 *   违反 drizzle better-sqlite3 同步事务约束，导致 295 张新照片缩略图生成
 *   步骤从未执行、thumbnail_path 全 NULL。本测试守护此 bug 不再回归。
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ============================================================================
// 被测源码文件路径
// ============================================================================

const SCAN_STORAGE_PATH = path.resolve(__dirname, "../jobs/scan-storage.ts");

/** 读取 scan-storage.ts 源码全文（缓存，避免重复 IO） */
function readScanStorageSource(): string {
  return fs.readFileSync(SCAN_STORAGE_PATH, "utf-8");
}

/**
 * 剥离 JS/TS 注释后再做反模式检测。
 *
 * 背景：源码中可能保留反模式字符串作为"反面教材注释"
 * （如 `// 不能用 db.transaction(async)`），字面 grep 会误伤。
 * 契约的本意是"实际可执行代码不含反模式"，故先去注释再断言。
 *
 * 处理：移除单行 `//...` 和多行 `/* ... *​/` 注释，保留字符串字面量
 * （简单实现：按行处理单行注释；多行注释用状态机跨行剥离）。
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString: '"' | "'" | "`" | null = null;
  let inBlockComment = false;
  let inLineComment = false;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // 字符串字面量内：原样输出直到闭合引号（处理转义）
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }

    // 块注释内：跳过直到 */
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // 行注释内：跳过直到换行
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += "\n";
      }
      i += 1;
      continue;
    }

    // 检测注释起点
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    // 检测字符串起点
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** 读取 scan-storage.ts 源码并剥离注释（用于反模式检测） */
function readScanStorageCodeOnly(): string {
  return stripComments(readScanStorageSource());
}

// ============================================================================
// 反模式契约：db.transaction(async ... 必须从源码消失
// ============================================================================

describe("验收点 6：scan-storage transaction async 反模式契约", () => {
  describe("反模式字符串断言（grep 式黑盒契约）", () => {
    it("scan-storage.ts 不含 `db.transaction(async`（async 回调反模式）", () => {
      // 注：剥离注释后再检测——源码可能保留反模式字符串作为"反面教材注释"
      // （如 `// 不能用 db.transaction(async)`），字面 grep 会误伤。
      const code = readScanStorageCodeOnly();

      // 反模式：db.transaction(async (tx) => {...})
      // drizzle better-sqlite3 会在运行时抛
      // "Transaction function cannot return a promise"
      expect(
        code,
        "scan-storage.ts 实际代码不应包含 `db.transaction(async` 反模式（drizzle better-sqlite3 禁止 async 回调）",
      ).not.toContain("db.transaction(async");
    });

    it("scan-storage.ts 不含 `.transaction(async`（含 tx 前缀变体）", () => {
      const code = readScanStorageCodeOnly();

      // 覆盖 `db.transaction(async` 之外的链式变体，
      // 例如某些代码风格写 `.transaction(async`
      expect(code, "scan-storage.ts 实际代码不应包含 `.transaction(async` 反模式").not.toContain(
        ".transaction(async",
      );
    });

    it("scan-storage.ts 不含 `await db.transaction(` 搭配 async 回调的 bug 形态", () => {
      const code = readScanStorageCodeOnly();

      // 历史 bug 的精确形态：await 包裹一个返回 promise 的 transaction 调用。
      // 正确形态：要么不 await（同步 transaction）、要么不 transaction（单语句）。
      // 这里只断言 "await db.transaction" 这一子串不应出现——
      // 因为 drizzle better-sqlite3 的 transaction() 是同步的，await 它没有意义，
      // 而历史上正是 `await db.transaction(async ...)` 触发了 bug。
      //
      // 注意：合法的同步用法 `db.transaction((tx) => {...})`（不 await、不 async）
      // 不在禁列——它不会触发 "cannot return a promise" 错误。
      expect(
        code,
        "scan-storage.ts 实际代码不应包含 `await db.transaction(`（同步 transaction 不应被 await）",
      ).not.toContain("await db.transaction(");
    });
  });

  describe("合法 transaction 用法存在性（多语句原子性契约）", () => {
    it("scan-storage.ts 中保留的多语句 transaction 用同步回调 `db.transaction((tx) =>`", () => {
      const src = readScanStorageSource();

      // cleanupOrphans 删 daily_picks + photos 两张表必须用事务保原子性。
      // 契约：保留 db.transaction((tx) => {...})（同步回调，不 async，不 await）。
      // 这里用宽松断言：源码中应至少存在一处同步 transaction 用法，
      // 形如 `db.transaction((tx) =>`（无 async 关键字紧随）。
      const hasSyncTransaction = /db\.transaction\(\s*\(tx\)\s*=>/.test(src);

      expect(
        hasSyncTransaction,
        "scan-storage.ts 多语句删除应保留同步 transaction `db.transaction((tx) => {...})` 保原子性",
      ).toBe(true);
    });
  });

  describe("批量 INSERT 不再被 transaction 包裹（单语句原子性契约）", () => {
    it("scan-storage.ts 批量 INSERT 照片记录为单语句（SQLite 单语句天然原子）", () => {
      const src = readScanStorageSource();

      // 设计决策 1：单语句 INSERT 去掉 transaction 包裹。
      // 断言：存在 `db.insert(schema.photos).values(` 形式的 bulk INSERT。
      // （不验证是否被 transaction 包裹——上面已断言无 async transaction 反模式；
      //  这里只验证"单语句 bulk INSERT 这条路径存在"）
      const hasBulkInsert = /db\.insert\(\s*schema\.photos\s*\)\s*\.values\(/.test(src);

      expect(
        hasBulkInsert,
        "scan-storage.ts 应保留 `db.insert(schema.photos).values(...)` 单语句 bulk INSERT",
      ).toBe(true);
    });
  });
});

// ============================================================================
// 行为级验证（可选增强）：drizzle better-sqlite3 transaction 同步约束运行时确认
// ============================================================================

describe("验收点 6（行为级）：drizzle better-sqlite3 transaction 同步约束", () => {
  it("真实 better-sqlite3 transaction 传入 async 回调时抛 'cannot return a promise' 类错误", async () => {
    // 这是"反模式确实会失败"的行为级佐证——用真实的 drizzle + better-sqlite3
    // 验证 async 回调 transaction 确实会抛错。
    // 如果 drizzle 未来版本放宽此约束，此测试会失败，届时需重新评估契约。
    const Database = (await import("better-sqlite3")).default;
    const { drizzle } = await import("drizzle-orm/better-sqlite3");

    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);

    let caught: unknown = null;
    try {
      // 反模式：async 回调（模拟 bug 原始形态）。
      // drizzle 类型在某些版本接受 unknown 回调（类型层不报错），
      // 但运行时会抛 "Transaction function cannot return a promise"。
      // 这里验证的是运行时行为，用 any 绕过静态类型检查。
      const dbAny = db as unknown as { transaction: (cb: (tx: unknown) => unknown) => unknown };
      dbAny.transaction(async (tx: unknown) => {
        // 故意空函数体——drizzle 在调用前就检测返回 promise
        void tx;
      });
    } catch (e) {
      caught = e;
    }

    sqlite.close();

    // drizzle better-sqlite3 应抛出包含 "promise" 关键字的错误
    expect(caught, "async 回调 transaction 应抛错").not.toBeNull();
    const errMsg = caught instanceof Error ? caught.message : String(caught);
    expect(/promise/i.test(errMsg), `错误信息应提及 promise，实际：${errMsg}`).toBe(true);
  });
});

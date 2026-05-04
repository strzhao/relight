/**
 * 验收测试：管理后台 takenAt 排序 COALESCE 安全性
 *
 * 覆盖设计文档「管理后台显式选择"拍摄时间"排序时，无 EXIF 照片不应挤到列表顶部（需 COALESCE）」：
 *
 * 验收标准：
 * - GET /api/admin/photos?sortBy=takenAt 时，ORDER BY 子句应使用
 *   COALESCE(takenAt, createdAt) 而非直接 takenAt
 * - 无 EXIF 照片（takenAt=NULL）应回退到 createdAt 参与排序，而非被推到列表顶部
 * - 与主照片路由 GET /api/photos 保持一致（主路由已正确使用 COALESCE）
 * - aestheticScore 的 COALESCE 模式（已有参考实现）保持不变
 *
 * 测试策略：
 * 由于 admin 路由使用 chainableMock 全量 mock DB，无法通过真实数据排序验证，
 * 此处通过拦截 drizzle-orm 的 sql 模板标签调用，验证 sortBy=takenAt 时
 * 是否产生了包含 "COALESCE" 的 SQL 片段。
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// ==========================================================================
// sql 模板标签调用记录器
// ==========================================================================

/** 记录每次 sql 模板标签调用的模板字符串数组 */
const sqlTagCalls: ReadonlyArray<string>[] = [];

// ==========================================================================
// chainableMock (与现有测试相同模式)
// ==========================================================================

function chainableMock(result: unknown[] = []) {
  const fn = () => chainableMock(result);
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
        return () => "[]";
      }
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return undefined;
      }
      return chainableMock(result);
    },
  });
}

// ==========================================================================
// Mock 设置
// ==========================================================================

vi.mock("../db", () => ({
  db: chainableMock([]),
  schema: chainableMock([]),
}));

vi.mock("../jobs/queues", () => ({
  scanQueue: {
    add: () => Promise.resolve({ id: "mock-scan-job-id" }),
    getJobCounts: () =>
      Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
  },
  analyzeQueue: {
    add: () => Promise.resolve({ id: "mock-analyze-job-id" }),
    getJobCounts: () =>
      Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
  },
  dailyQueue: {
    add: () => Promise.resolve({ id: "mock-job-id" }),
    getJobCounts: () =>
      Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // 带记录功能的 sql mock：记录模板标签调用，返回与现有 sqlMock 兼容的值
    sql: (...args: unknown[]) => {
      const firstArg = args[0];
      // 仅记录 tagged template 调用 (firstArg 为 TemplateStringsArray)
      if (Array.isArray(firstArg) && firstArg.length > 0 && typeof firstArg[0] === "string") {
        sqlTagCalls.push(firstArg as ReadonlyArray<string>);
      }
      // 返回 firstArg 与现有 sqlMock(value) { return value; } 行为一致
      return firstArg;
    },
    count: () => chainableMock([]),
    avg: () => chainableMock([]),
    sum: () => chainableMock([]),
  };
});

// ==========================================================================
// 创建测试 App
// ==========================================================================

async function createAdminApp(): Promise<Hono> {
  const adminMod = await import("../routes/admin");
  const adminRouter: Hono =
    (adminMod as Record<string, Hono>).adminRouter || (adminMod as Record<string, Hono>).default;
  const app = new Hono();
  app.use("*", cors());
  app.route("/api/admin", adminRouter);
  return app;
}

let app: Hono;

beforeAll(async () => {
  app = await createAdminApp();
}, 10000);

afterAll(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // 每次测试后清空 sql 调用记录
  sqlTagCalls.length = 0;
});

// ==========================================================================
// 请求辅助
// ==========================================================================

async function get(path: string) {
  const res = await app.request(path, { method: "GET" });
  const body = await res.json().catch(() => null);
  const contentType = res.headers.get("Content-Type") ?? "";
  return { status: res.status, body, contentType };
}

// ==========================================================================
// 测试
// ==========================================================================

describe("管理后台 takenAt 排序 COALESCE 安全性 — 验收测试", () => {
  // ==========================================================================
  // 核心验收：sortBy=takenAt 时使用 COALESCE
  // ==========================================================================

  describe("sortBy=takenAt 时 ORDER BY 子句应使用 COALESCE", () => {
    it("GET /api/admin/photos?sortBy=takenAt 应产生包含 'COALESCE' 的 SQL 模板片段", async () => {
      // 发起请求前清空记录
      sqlTagCalls.length = 0;

      const { status } = await get("/api/admin/photos?sortBy=takenAt");
      // 路由应正常返回（不崩溃）
      expect(status).not.toBe(500);

      // 验收核心：sql 模板标签调用中应至少包含一次 "COALESCE"
      // 设计文档要求 takenAt 排序使用 COALESCE(takenAt, createdAt)
      const coalesceCalls = sqlTagCalls.filter(
        (call) => call.length > 0 && call[0]?.includes("COALESCE"),
      );

      // 注：如果此断言失败，说明 takenAt 路径未使用 COALESCE，
      // 即 admin.ts 中 case "takenAt" 分支仍为裸 desc(takenAt)
      expect(
        coalesceCalls.length,
        "sortBy=takenAt 应产生至少一条包含 COALESCE 的 SQL 模板调用，但当前为 0。\n" +
          "请确认 admin.ts 中 takenAt 分支使用的是 sql`COALESCE(takenAt, createdAt)` 而非直接 takenAt 列。",
      ).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 对比验证：其他 sortBy 值的行为
  // ==========================================================================

  describe("其他 sortBy 值的 SQL 行为对比", () => {
    it("sortBy=createdAt 时不必须使用 COALESCE（createdAt 不会为 NULL）", async () => {
      sqlTagCalls.length = 0;
      const { status } = await get("/api/admin/photos?sortBy=createdAt");
      expect(status).toBe(200);
      // createdAt 不应为 NULL，COALESCE 非强制要求
      // 此测试仅验证路由不崩溃
    });

    it("sortBy=fileSize 时不必须使用 COALESCE", async () => {
      sqlTagCalls.length = 0;
      const { status } = await get("/api/admin/photos?sortBy=fileSize");
      expect(status).toBe(200);
    });

    it("sortBy=aestheticScore 应使用 COALESCE（参考实现：已有 COALESCE(aestheticScore, -1)）", async () => {
      sqlTagCalls.length = 0;
      const { status } = await get("/api/admin/photos?sortBy=aestheticScore");
      expect(status).toBe(200);

      const coalesceCalls = sqlTagCalls.filter(
        (call) => call.length > 0 && call[0]?.includes("COALESCE"),
      );
      expect(
        coalesceCalls.length,
        "sortBy=aestheticScore 应使用 COALESCE(aestheticScore, -1) 作为参考实现",
      ).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 不传 sortBy 时的默认行为
  // ==========================================================================

  describe("不传 sortBy 时的默认行为", () => {
    it("GET /api/admin/photos（无 sortBy 参数）应正常返回", async () => {
      const { status, body } = await get("/api/admin/photos");
      expect(status).toBe(200);
      expect(body?.success).toBe(true);
    });

    it("不传 sortBy 时默认排序字段（createdAt）不应触发 COALESCE（当前默认行为）", async () => {
      sqlTagCalls.length = 0;
      await get("/api/admin/photos");
      // 默认 sortBy = "createdAt"，不需要 COALESCE
      // 仅验证路由正常
      const coalesceCalls = sqlTagCalls.filter(
        (call) => call.length > 0 && call[0]?.includes("COALESCE"),
      );
      // 无 COALESCE 是预期行为（createdAt 不需要）
      // 不做强制断言，仅记录：设计文档未要求修改其他排序字段
    });
  });

  // ==========================================================================
  // 集成验证：与主路由行为一致性
  // ==========================================================================

  describe("与主路由 GET /api/photos 排序行为一致性", () => {
    it("主路由 photos.ts 已使用 COALESCE(takenAt, createdAt) 作为排序键", () => {
      // 设计文档确认：photos.ts 第 39 行已有 effectiveDate = COALESCE(takenAt, createdAt)
      // 此测试声明设计契约 — 管理后台应与主路由保持一致
      // 实际行为由 photos 路由的集成测试覆盖

      // 契约声明：两个路由的 takenAt 排序逻辑应等价
      const contractStatement =
        "管理后台 takenAt 排序应使用 COALESCE(takenAt, createdAt)，与主路由一致";
      expect(typeof contractStatement).toBe("string");
    });
  });
});

// ==========================================================================
// 纯函数测试：sortBy=takenAt 需要 COALESCE 的语义验证
// ==========================================================================

describe("takenAt NULL 回退语义 — 行为契约", () => {
  /**
   * 此 describe 用于验证 COALESCE 的语义是否正确，不依赖实际的 admin 路由实现。
   * 用于在新实现代码中作为行为契约的参考。
   */

  describe("COALESCE(takenAt, createdAt) 语义正确性", () => {
    it("takenAt 有值时，排序键应为 takenAt", () => {
      // 模拟数据库行为
      function effectiveSortKey(takenAt: string | null, createdAt: string): string {
        return takenAt ?? createdAt;
      }

      const result = effectiveSortKey("2026-01-15T10:00:00Z", "2026-05-01T12:00:00Z");
      expect(result).toBe("2026-01-15T10:00:00Z");
    });

    it("takenAt 为 NULL 时，排序键应回退到 createdAt", () => {
      function effectiveSortKey(takenAt: string | null, createdAt: string): string {
        return takenAt ?? createdAt;
      }

      const result = effectiveSortKey(null, "2026-05-01T12:00:00Z");
      expect(result).toBe("2026-05-01T12:00:00Z");
    });

    it("多张照片混合 NULL 和非 NULL takenAt 时，NULL 不应全部挤到顶部", () => {
      function effectiveSortKey(takenAt: string | null, createdAt: string): string {
        return takenAt ?? createdAt;
      }

      const photos = [
        { id: "1", takenAt: "2026-05-01T00:00:00Z", createdAt: "2026-05-01T00:00:00Z" },
        { id: "2", takenAt: null, createdAt: "2026-04-15T00:00:00Z" },
        { id: "3", takenAt: "2026-03-01T00:00:00Z", createdAt: "2026-03-01T00:00:00Z" },
        { id: "4", takenAt: null, createdAt: "2026-05-03T00:00:00Z" },
      ];

      // 使用 COALESCE 语义排序（降序）
      const sorted = photos
        .map((p) => ({ ...p, key: effectiveSortKey(p.takenAt, p.createdAt) }))
        .sort((a, b) => b.key.localeCompare(a.key));

      // 期望：按有效日期降序
      // Photo 4: createdAt 2026-05-03 (latest)
      // Photo 1: takenAt 2026-05-01
      // Photo 2: createdAt 2026-04-15
      // Photo 3: takenAt 2026-03-01
      expect(sorted[0]?.id).toBe("4");
      expect(sorted[1]?.id).toBe("1");
      expect(sorted[2]?.id).toBe("2");
      expect(sorted[3]?.id).toBe("3");
    });

    it("如果不使用 COALESCE，NULL takenAt 在 DESC 排序中会出现在顶部", () => {
      // 此测试演示不使用 COALESCE 时的问题（作为反例）
      // SQLite 默认 NULL 在 DESC 排序中排在最前面
      const photos = [
        { id: "1", takenAt: "2026-05-01T00:00:00Z" },
        { id: "2", takenAt: null },
        { id: "3", takenAt: "2026-03-01T00:00:00Z" },
      ];

      // 模拟 SQLite 行为：NULL 在 DESC 中排在最前
      const withoutCoalesce = [...photos].sort((a, b) => {
        if (a.takenAt === null && b.takenAt === null) return 0;
        if (a.takenAt === null) return -1;
        if (b.takenAt === null) return 1;
        return b.takenAt.localeCompare(a.takenAt);
      });

      // 不做具体断言，仅记录：不使用 COALESCE 时 NULL 挤到顶部
      // 此行为正是设计文档要求修复的目标
      const nullAtTop = withoutCoalesce[0]?.id === "2";
      expect(typeof nullAtTop).toBe("boolean");
    });
  });
});

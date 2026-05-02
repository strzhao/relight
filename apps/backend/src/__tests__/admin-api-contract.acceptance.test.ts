/**
 * 验收测试：Admin API 契约
 *
 * 覆盖设计文档「管理后台」新增 API：
 * - GET /api/admin/stats    → 综合统计  { success, data: { totalPhotos, analyzedCount, averageScore, passRate8Plus, storageSources, recentAnalyses } }
 * - GET /api/admin/queues   → 队列状态  { success, data: { scan, analyze, daily } } 每个含 waiting/active/completed/failed/delayed
 * - GET /api/admin/health   → 健康检查  { success, data: { api, db, redis, ai } } 每个含 status: "ok"|"error"|"degraded"
 * - GET /api/admin/photos   → 分页列表  PaginatedResponse<PhotoAnalysisItem>，支持 sortBy: "aestheticScore"|"processedAt"
 *
 * 响应格式遵循 @relight/shared 中定义的 ApiResponse<T> 和 PaginatedResponse<T>
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---- 辅助：链式 Mock ----

/**
 * 创建可链式调用的 Mock 对象。
 * 支持 db.select().from().where().orderBy().limit().offset().leftJoin() 等链式调用，
 * 以及 schema.table.column 等属性访问。
 * 数组索引 [0], [1] 返回 undefined（模拟空查询结果）。
 */
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
      // 数字字符串属性 -> 模拟数组索引，返回 undefined
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return undefined;
      }
      return chainableMock(result);
    },
  });
}

/** 创建支持具名方法的 Mock 函数（用于 count、sum、avg 等聚合函数 mock） */
function sqlMock(value: unknown) {
  return value;
}

// 防止 db/index.ts 尝试打开真实数据库文件
vi.mock("../db", () => ({
  db: chainableMock([]),
  schema: chainableMock([]),
}));

// Mock drizzle-orm 的 sql 辅助函数
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sql: sqlMock,
    count: () => sqlMock(0),
    avg: () => sqlMock(0),
    sum: () => sqlMock(0),
  };
});

// 防止 queues.ts 尝试连接 Redis
// 模拟 BullMQ Queue 对象的所有常用方法
const defaultQueueState = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };

function createQueueMock() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
          return () => "BullMQ Mock";
        }
        // 所有方法调用返回 queue state
        return () => Promise.resolve({ ...defaultQueueState });
      },
    },
  );
}

vi.mock("../jobs/queues", () => ({
  scanQueue: createQueueMock(),
  analyzeQueue: createQueueMock(),
  dailyQueue: createQueueMock(),
}));

// ---- 类型定义（设计文档声明） ----

/** stats 端点返回的 data 字段 */
interface AdminStatsData {
  totalPhotos: number;
  analyzedCount: number;
  averageScore: number;
  passRate8Plus: number;
  storageSources: Array<{
    id?: string;
    name: string;
    type: string;
    photoCount: number;
    enabled?: boolean;
    lastScanAt?: string | null;
  }>;
  recentAnalyses: Array<{
    filePath: string;
    aestheticScore: number;
    processedAt: string;
  }>;
}

/** queues 端点返回的 data 字段 */
interface QueueStatus {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

interface AdminQueuesData {
  scan: QueueStatus;
  analyze: QueueStatus;
  daily: QueueStatus;
}

/** health 端点返回的 data 字段 */
type ComponentStatus = "ok" | "error" | "degraded";

interface ComponentHealth {
  status: ComponentStatus;
}

interface AdminHealthData {
  api: ComponentHealth;
  db: ComponentHealth;
  redis: ComponentHealth;
  ai: ComponentHealth;
}

/** photos 端点返回的单条照片分析项 */
interface PhotoAnalysisItem {
  id: string;
  filePath: string;
  aestheticScore: number;
  processedAt: string;
  narrative?: string | null;
  aiModel?: string;
}

// ---- 辅助：创建测试 App ----

/**
 * 创建一个挂载了 adminRouter 的测试用 Hono app。
 * 动态导入 admin router 以享受 vi.mock 的自动提升效果。
 */
async function createAdminApp(): Promise<Hono> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const adminMod = await import("../routes/admin");
  // 兼容不同的导出方式
  const adminRouter: Hono =
    (adminMod as Record<string, Hono>).adminRouter ||
    (adminMod as Record<string, Hono>).default;
  const app = new Hono();
  app.use("*", cors());
  app.route("/api/admin", adminRouter);
  return app;
}

// ---- 全局测试状态 ----

let app: Hono;

beforeAll(async () => {
  app = await createAdminApp();
});

afterAll(() => {
  vi.clearAllMocks();
});

// ---- 请求辅助函数 ----

async function get(path: string) {
  const res = await app.request(path, { method: "GET" });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---- 测试 ----

describe("Admin API 契约 — 验收测试（管理后台设计文档）", () => {
  describe("路由结构完整性", () => {
    const adminRoutes = [
      "/api/admin/stats",
      "/api/admin/queues",
      "/api/admin/health",
      "/api/admin/photos",
    ];

    it.each(adminRoutes)("GET %s 应返回非 404 且非 500", async (route) => {
      const { status } = await get(route);
      expect(status).not.toBe(404);
      expect(status).not.toBe(500);
    });
  });

  // ============================================================
  // GET /api/admin/stats
  // ============================================================
  describe("GET /api/admin/stats — 综合统计", () => {
    const statsFields = [
      "totalPhotos",
      "analyzedCount",
      "averageScore",
      "passRate8Plus",
      "storageSources",
      "recentAnalyses",
    ] as const;

    let body: { success: boolean; data: AdminStatsData; error?: string };

    beforeAll(async () => {
      const res = await get("/api/admin/stats");
      body = res.body as { success: boolean; data: AdminStatsData; error?: string };
    });

    it("应返回 HTTP 200", async () => {
      const { status } = await get("/api/admin/stats");
      expect(status).toBe(200);
    });

    it("应返回 ApiResponse 格式 { success, data }", async () => {
      const { body: b } = await get("/api/admin/stats");
      const parsed = b as { success: boolean; data: unknown; error?: string };
      expect(parsed.success).toBe(true);
      expect(parsed.data).toBeDefined();
      expect(typeof parsed.data).toBe("object");
    });

    it.each(statsFields)("data 应包含字段 %s", (field) => {
      expect(body.data).toHaveProperty(field);
      expect(body.data[field]).toBeDefined();
    });

    it("totalPhotos 应为 number 类型", () => {
      expect(typeof body.data.totalPhotos).toBe("number");
    });

    it("analyzedCount 应为 number 类型", () => {
      expect(typeof body.data.analyzedCount).toBe("number");
    });

    it("averageScore 应为 number 类型", () => {
      expect(typeof body.data.averageScore).toBe("number");
    });

    it("passRate8Plus 应为 number 类型", () => {
      expect(typeof body.data.passRate8Plus).toBe("number");
    });

    it("storageSources 应为数组类型", () => {
      expect(Array.isArray(body.data.storageSources)).toBe(true);
    });

    it("recentAnalyses 应为数组类型，且不超过 10 条", () => {
      expect(Array.isArray(body.data.recentAnalyses)).toBe(true);
      expect(body.data.recentAnalyses.length).toBeLessThanOrEqual(10);
    });

    describe("storageSources 数组元素字段", () => {
      it("每个存储源应包含 name (string)", () => {
        for (const source of body.data.storageSources) {
          expect(typeof source.name).toBe("string");
        }
      });

      it("每个存储源应包含 type (string)", () => {
        for (const source of body.data.storageSources) {
          expect(typeof source.type).toBe("string");
        }
      });

      it("每个存储源应包含 photoCount (number)", () => {
        for (const source of body.data.storageSources) {
          expect(typeof source.photoCount).toBe("number");
        }
      });
    });

    describe("recentAnalyses 数组元素字段", () => {
      it("每条分析记录应包含 filePath (string)", () => {
        for (const item of body.data.recentAnalyses) {
          expect(typeof item.filePath).toBe("string");
        }
      });

      it("每条分析记录应包含 aestheticScore (number)", () => {
        for (const item of body.data.recentAnalyses) {
          expect(typeof item.aestheticScore).toBe("number");
        }
      });

      it("每条分析记录应包含 processedAt (string)", () => {
        for (const item of body.data.recentAnalyses) {
          expect(typeof item.processedAt).toBe("string");
        }
      });
    });

    describe("字段名与设计文档声明一致性", () => {
      it("stats 端点返回的顶层字段名应与设计文档一致", () => {
        const actualFields = Object.keys(body.data).sort();
        const expectedFields = [...statsFields].sort();
        // 实际返回的字段集合应包含设计文档声明的所有字段
        for (const field of expectedFields) {
          expect(actualFields).toContain(field);
        }
      });

      it("storageSources 元素不应将 photoCount 命名为 count 或 other", () => {
        for (const source of body.data.storageSources) {
          expect(source).toHaveProperty("photoCount");
        }
      });

      it("recentAnalyses 元素不应将 aestheticScore 命名为 score 或 rating", () => {
        for (const item of body.data.recentAnalyses) {
          expect(item).toHaveProperty("aestheticScore");
        }
      });
    });
  });

  // ============================================================
  // GET /api/admin/queues
  // ============================================================
  describe("GET /api/admin/queues — 队列监控", () => {
    const queueNames = ["scan", "analyze", "daily"] as const;
    const queueFields = ["waiting", "active", "completed", "failed", "delayed"] as const;

    let body: { success: boolean; data: AdminQueuesData; error?: string };

    beforeAll(async () => {
      const res = await get("/api/admin/queues");
      body = res.body as { success: boolean; data: AdminQueuesData; error?: string };
    });

    it("应返回 HTTP 200", async () => {
      const { status } = await get("/api/admin/queues");
      expect(status).toBe(200);
    });

    it("应返回 ApiResponse 格式 { success, data }", () => {
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
    });

    it.each(queueNames)("data 应包含 %s 队列", (queueName) => {
      expect(body.data).toHaveProperty(queueName);
    });

    describe.each(queueNames)("%s 队列状态", (queueName) => {
      it.each(queueFields)("应包含字段 %s (number)", (field) => {
        const queue = body.data[queueName];
        expect(queue).toHaveProperty(field);
        expect(typeof queue[field]).toBe("number");
      });

      it("所有计数字段应为非负整数", () => {
        const queue = body.data[queueName];
        for (const field of queueFields) {
          expect(queue[field]).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(queue[field])).toBe(true);
        }
      });
    });

    it("三个队列状态结构应一致", () => {
      const scanKeys = Object.keys(body.data.scan).sort();
      const analyzeKeys = Object.keys(body.data.analyze).sort();
      const dailyKeys = Object.keys(body.data.daily).sort();
      expect(scanKeys).toEqual(analyzeKeys);
      expect(analyzeKeys).toEqual(dailyKeys);
    });
  });

  // ============================================================
  // GET /api/admin/health
  // ============================================================
  describe("GET /api/admin/health — 系统健康", () => {
    const components = ["api", "db", "redis", "ai"] as const;

    let body: { success: boolean; data: AdminHealthData; error?: string };

    beforeAll(async () => {
      const res = await get("/api/admin/health");
      body = res.body as { success: boolean; data: AdminHealthData; error?: string };
    });

    it("应返回 HTTP 200", async () => {
      const { status } = await get("/api/admin/health");
      expect(status).toBe(200);
    });

    it("应返回 ApiResponse 格式 { success, data }", () => {
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
    });

    it.each(components)("data 应包含 %s 组件", (component) => {
      expect(body.data).toHaveProperty(component);
    });

    it.each(components)("%s 组件应有 status 字段", (component) => {
      const comp = body.data[component];
      expect(comp).toHaveProperty("status");
      expect(typeof comp.status).toBe("string");
    });

    it.each(components)("%s 组件的 status 应为合法枚举值", (component) => {
      const comp = body.data[component];
      expect(["ok", "error", "degraded"]).toContain(comp.status);
    });

    it("AI 组件的 status 应支持 'degraded'（3s 超时降级）", () => {
      // 验证 AI 组件 status 类型包含 "degraded"
      const validStatuses: ComponentStatus[] = ["ok", "error", "degraded"];
      expect(validStatuses).toContain(body.data.ai.status);
    });

    it("API 组件在测试环境应返回 'ok'", () => {
      // API 自身应始终可用
      expect(body.data.api.status).toBe("ok");
    });
  });

  // ============================================================
  // GET /api/admin/photos
  // ============================================================
  describe("GET /api/admin/photos — 分页分析列表", () => {
    let body: { success: boolean; data: PhotoAnalysisItem[]; total: number; page: number; pageSize: number; error?: string };

    beforeAll(async () => {
      const res = await get("/api/admin/photos");
      body = res.body as typeof body;
    });

    it("应返回 HTTP 200", async () => {
      const { status } = await get("/api/admin/photos");
      expect(status).toBe(200);
    });

    it("应返回 PaginatedResponse 格式 { success, data[], total, page, pageSize }", () => {
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.total).toBe("number");
      expect(typeof body.page).toBe("number");
      expect(typeof body.pageSize).toBe("number");
    });

    it("total 和 page 应为非负整数", () => {
      expect(body.total).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(body.total)).toBe(true);
      expect(body.page).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(body.page)).toBe(true);
    });

    it("pageSize 应 > 0", () => {
      expect(body.pageSize).toBeGreaterThan(0);
    });

    describe("支持 sortBy 查询参数", () => {
      it("sortBy=aestheticScore 应返回 200", async () => {
        const { status } = await get("/api/admin/photos?sortBy=aestheticScore");
        expect(status).toBe(200);
      });

      it("sortBy=processedAt 应返回 200", async () => {
        const { status } = await get("/api/admin/photos?sortBy=processedAt");
        expect(status).toBe(200);
      });
    });

    describe("支持分页参数", () => {
      it("page=1&pageSize=10 应返回 200", async () => {
        const { status, body: b } = await get("/api/admin/photos?page=1&pageSize=10");
        expect(status).toBe(200);
        const parsed = b as { page: number; pageSize: number };
        expect(parsed.page).toBe(1);
        expect(parsed.pageSize).toBe(10);
      });

      it("page=2&pageSize=20 应返回 200", async () => {
        const { status, body: b } = await get("/api/admin/photos?page=2&pageSize=20");
        expect(status).toBe(200);
        const parsed = b as { page: number; pageSize: number };
        expect(parsed.page).toBe(2);
        expect(parsed.pageSize).toBe(20);
      });
    });

    describe("PhotoAnalysisItem 字段结构", () => {
      it("每条记录应包含 id (string)", () => {
        for (const item of body.data) {
          expect(typeof item.id).toBe("string");
        }
      });

      it("每条记录应包含 filePath (string)", () => {
        for (const item of body.data) {
          expect(typeof item.filePath).toBe("string");
        }
      });

      it("每条记录应包含 aestheticScore (number)", () => {
        for (const item of body.data) {
          expect(typeof item.aestheticScore).toBe("number");
        }
      });

      it("每条记录应包含 processedAt (string)", () => {
        for (const item of body.data) {
          expect(typeof item.processedAt).toBe("string");
        }
      });
    });
  });

  describe("响应格式一致性", () => {
    const allAdminPaths = [
      "/api/admin/stats",
      "/api/admin/queues",
      "/api/admin/health",
      "/api/admin/photos",
    ];

    it.each(allAdminPaths)("GET %s 应返回 JSON Content-Type", async (path) => {
      const res = await app.request(path, { method: "GET" });
      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).toContain("application/json");
    });

    it("所有 admin 端点顶层应有 success 字段", async () => {
      for (const path of allAdminPaths) {
        const { body } = await get(path);
        expect(body).toHaveProperty("success");
      }
    });
  });
});

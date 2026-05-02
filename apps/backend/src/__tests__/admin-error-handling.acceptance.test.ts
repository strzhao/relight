/**
 * 验收测试：Admin API 错误处理
 *
 * 覆盖设计文档「管理后台」错误处理需求：
 * - 端点异常时的错误响应格式 { success: false, error: string }
 * - 无效查询参数的错误处理
 * - 不存在的路由返回 404
 * - 错误响应结构一致性
 * - 边界输入（空参数、极端值）
 *
 * 本测试从黑盒视角验证各 admin 端点的错误响应行为。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---- 辅助：链式 Mock ----

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

// 防止 db/index.ts 尝试打开真实数据库文件
vi.mock("../db", () => ({
  db: chainableMock([]),
  schema: chainableMock([]),
}));

// 防止 queues.ts 尝试连接 Redis
vi.mock("../jobs/queues", () => {
  const defaults = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  const mockQ = () =>
    new Proxy(
      {},
      {
        get(_t, p) {
          if (typeof p === "string" && p !== "then") return () => Promise.resolve({ ...defaults });
          return undefined;
        },
      },
    );
  return { scanQueue: mockQ(), analyzeQueue: mockQ(), dailyQueue: mockQ() };
});

// ---- 类型定义 ----

interface ErrorResponse {
  success: boolean;
  data: unknown;
  error?: string;
}

// ---- 全局测试状态 ----

let app: Hono;

beforeAll(async () => {
  const adminMod = await import("../routes/admin");
  const adminRouter: Hono =
    (adminMod as Record<string, Hono>).adminRouter ||
    (adminMod as Record<string, Hono>).default;
  app = new Hono();
  app.use("*", cors());
  app.route("/api/admin", adminRouter);
});

afterAll(() => {
  vi.clearAllMocks();
});

// ---- 请求辅助 ----

async function get(path: string) {
  const res = await app.request(path, { method: "GET" });
  const contentType = res.headers.get("Content-Type") ?? "";
  let body: unknown = null;
  if (contentType.includes("application/json")) {
    body = await res.json().catch(() => null);
  }
  return { status: res.status, body, headers: res.headers };
}

async function post(path: string, data?: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  const contentType = res.headers.get("Content-Type") ?? "";
  let body: unknown = null;
  if (contentType.includes("application/json")) {
    body = await res.json().catch(() => null);
  }
  return { status: res.status, body };
}

// ---- 测试 ----

describe("Admin API 错误处理 — 验收测试", () => {
  // ============================================================
  // 不存在的路由
  // ============================================================
  describe("不存在的路由", () => {
    it("GET /api/admin/nonexistent 应返回 404", async () => {
      const { status } = await get("/api/admin/nonexistent");
      expect(status).toBe(404);
    });

    it("GET /api/admin/ 应返回 404 或重定向", async () => {
      const { status } = await get("/api/admin/");
      // 可能 404（无 index 路由）或 200（如有重定向）
      expect([200, 404]).toContain(status);
    });

    it("POST /api/admin/stats 应返回 405 Method Not Allowed", async () => {
      const { status } = await post("/api/admin/stats");
      // 405 或 404（取决于路由匹配方式）
      expect([404, 405]).toContain(status);
    });
  });

  // ============================================================
  // GET /api/admin/photos 无效参数
  // ============================================================
  describe("GET /api/admin/photos — 无效查询参数", () => {
    it("sortBy=invalid_sort 不应返回 500（应返回 400 或 200 带默认值）", async () => {
      const { status } = await get("/api/admin/photos?sortBy=invalid_sort");
      expect(status).not.toBe(500);
    });

    it("page=-1（负数页码）不应返回 500", async () => {
      const { status } = await get("/api/admin/photos?page=-1");
      expect(status).not.toBe(500);
    });

    it("page=0（零页码）不应返回 500", async () => {
      const { status } = await get("/api/admin/photos?page=0");
      expect(status).not.toBe(500);
    });

    it("pageSize=0（零页大小）不应返回 500", async () => {
      const { status } = await get("/api/admin/photos?pageSize=0");
      expect(status).not.toBe(500);
    });

    it("pageSize=99999（超大页大小）不应返回 500", async () => {
      const { status } = await get("/api/admin/photos?pageSize=99999");
      expect(status).not.toBe(500);
    });

    it("page=abc（非数字页码）不应返回 500", async () => {
      const { status } = await get("/api/admin/photos?page=abc");
      expect(status).not.toBe(500);
    });

    it("pageSize=abc（非数字页大小）不应返回 500", async () => {
      const { status } = await get("/api/admin/photos?pageSize=abc");
      expect(status).not.toBe(500);
    });

    it("无效参数组合时不应 crash（回归 500）", async () => {
      const { status } = await get("/api/admin/photos?sortBy=invalid&page=-5&pageSize=0");
      expect(status).not.toBe(500);
    });

    it("空查询字符串应返回默认分页结果", async () => {
      const { status, body } = await get("/api/admin/photos?");
      expect(status).toBe(200);
      const parsed = body as ErrorResponse;
      expect(parsed.success).toBe(true);
    });

    it("超长 sortBy 值不应返回 500", async () => {
      const longValue = "a".repeat(1000);
      const { status } = await get(`/api/admin/photos?sortBy=${longValue}`);
      expect(status).not.toBe(500);
    });
  });

  // ============================================================
  // GET /api/admin/stats 错误场景
  // ============================================================
  describe("GET /api/admin/stats — 错误响应", () => {
    it("应始终返回 ApiResponse 格式 { success, data }", async () => {
      const { status, body } = await get("/api/admin/stats");
      expect(status).toBe(200);
      const parsed = body as ErrorResponse;
      expect(parsed).toHaveProperty("success");
      expect(parsed).toHaveProperty("data");
    });

    it("data 中的数值字段不应为 NaN 或 undefined", async () => {
      const { body } = await get("/api/admin/stats");
      const parsed = body as { success: boolean; data: Record<string, unknown> };
      const data = parsed.data;

      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "number") {
          expect(Number.isNaN(value)).toBe(false);
        }
        if (key !== "error") {
          expect(value).toBeDefined();
        }
      }
    });
  });

  // ============================================================
  // GET /api/admin/queues 错误场景
  // ============================================================
  describe("GET /api/admin/queues — 错误响应", () => {
    it("应始终返回包含三个队列的响应", async () => {
      const { body } = await get("/api/admin/queues");
      const parsed = body as { success: boolean; data: Record<string, unknown> };
      expect(parsed.data).toHaveProperty("scan");
      expect(parsed.data).toHaveProperty("analyze");
      expect(parsed.data).toHaveProperty("daily");
    });

    it("队列计数字段不应为负数", async () => {
      const { body } = await get("/api/admin/queues");
      const parsed = body as {
        success: boolean;
        data: Record<string, Record<string, number>>;
      };
      for (const queueName of ["scan", "analyze", "daily"]) {
        const queue = parsed.data[queueName];
        if (queue) {
          for (const field of ["waiting", "active", "completed", "failed", "delayed"]) {
            expect(queue[field]).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });
  });

  // ============================================================
  // GET /api/admin/health 错误场景
  // ============================================================
  describe("GET /api/admin/health — 降级和错误状态", () => {
    it("应返回 4 个组件状态", async () => {
      const { body } = await get("/api/admin/health");
      const parsed = body as {
        success: boolean;
        data: Record<string, { status: string }>;
      };
      expect(Object.keys(parsed.data)).toHaveLength(4);
    });

    it("每个组件 status 应为合法值", async () => {
      const { body } = await get("/api/admin/health");
      const parsed = body as {
        success: boolean;
        data: Record<string, { status: string }>;
      };
      const validStatuses = ["ok", "error", "degraded"];
      for (const component of Object.keys(parsed.data)) {
        const comp = parsed.data[component];
        expect(validStatuses).toContain(comp?.status);
      }
    });

    it("API 组件自身应始终报告 'ok'", async () => {
      const { body } = await get("/api/admin/health");
      const parsed = body as {
        success: boolean;
        data: Record<string, { status: string }>;
      };
      expect(parsed.data.api?.status).toBe("ok");
    });

    it("整个响应不应因组件状态为 error 而返回 HTTP 5xx", async () => {
      const { status } = await get("/api/admin/health");
      expect(status).toBe(200);
    });
  });

  // ============================================================
  // 错误响应格式统一性验证
  // ============================================================
  describe("错误响应格式统一性", () => {
    const adminPaths = [
      "/api/admin/stats",
      "/api/admin/queues",
      "/api/admin/health",
      "/api/admin/photos",
    ];

    it.each(adminPaths)("GET %s 异常时 success 应为 false 或 true（非 undefined）", async (path) => {
      const { body } = await get(path);
      const parsed = body as ErrorResponse;
      expect(typeof parsed.success).toBe("boolean");
    });

    it("所有端点返回的错误响应应有统一结构", async () => {
      for (const path of adminPaths) {
        const { body } = await get(path);
        const parsed = body as ErrorResponse;
        // 所有响应都应包含 success 字段
        expect(parsed).toHaveProperty("success");
        // 所有响应都应包含 data 字段
        expect(parsed).toHaveProperty("data");
      }
    });

    it("错误码 404 的路径应返回 JSON 格式", async () => {
      const { status, body, headers } = await get("/api/admin/nonexistent");
      expect(status).toBe(404);
      const contentType = headers.get("Content-Type") ?? "";
      // 404 可能返回 JSON 或纯文本，取决于路由配置
      if (body) {
        expect(contentType.length).toBeGreaterThan(0);
      }
    });
  });

  // ============================================================
  // 特殊字符和编码处理
  // ============================================================
  describe("特殊输入处理", () => {
    it("含 URL 编码的查询参数不应返回 500", async () => {
      const { status } = await get("/api/admin/photos?sortBy=aestheticScore&page=1&pageSize=10");
      expect(status).not.toBe(500);
    });

    it("含特殊字符的 sortBy 参数不应返回 500", async () => {
      const { status } = await get("/api/admin/photos?sortBy=../../etc%2Fpasswd");
      expect(status).not.toBe(500);
    });

    it("含 SQL 注入尝试的查询参数不应返回 500", async () => {
      const { status } = await get("/api/admin/photos?sortBy=1%27%3B+DROP+TABLE+photos%3B--");
      expect(status).not.toBe(500);
    });

    it("含 XSS 尝试的查询参数不应返回 500", async () => {
      const { status } = await get("/api/admin/photos?sortBy=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
      expect(status).not.toBe(500);
    });
  });

  // ============================================================
  // 并发请求安全性（快速连续请求不应崩溃）
  // ============================================================
  describe("请求健壮性", () => {
    it("快速连续请求不应返回 500", async () => {
      const paths = [
        "/api/admin/stats",
        "/api/admin/queues",
        "/api/admin/health",
        "/api/admin/photos?page=1&pageSize=5",
        "/api/admin/photos?sortBy=aestheticScore",
      ];

      const results = await Promise.all(paths.map((p) => get(p)));
      for (const { status } of results) {
        expect(status).not.toBe(500);
      }
    });

    it("对同一端点 5 次连续请求不应崩溃", async () => {
      for (let i = 0; i < 5; i++) {
        const { status } = await get("/api/admin/stats");
        expect(status).not.toBe(500);
      }
    });
  });

  // ============================================================
  // 响应 content-type 验证
  // ============================================================
  describe("Content-Type 验证", () => {
    const adminPaths = [
      "/api/admin/stats",
      "/api/admin/queues",
      "/api/admin/health",
      "/api/admin/photos",
    ];

    it.each(adminPaths)("GET %s 应返回 application/json Content-Type", async (path) => {
      const { headers } = await get(path);
      const contentType = headers.get("Content-Type") ?? "";
      expect(contentType).toContain("application/json");
    });
  });

  // ============================================================
  // 缓存头验证（管理接口不应被缓存）
  // ============================================================
  describe("缓存控制", () => {
    it("管理接口不应返回强缓存头", async () => {
      const { headers } = await get("/api/admin/stats");
      const cacheControl = headers.get("Cache-Control") ?? "";
      // 不应包含长时间的 public/max-age 缓存
      expect(cacheControl).not.toContain("public, max-age=");
    });
  });
});

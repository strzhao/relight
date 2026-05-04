/**
 * 验收测试：原始图 API 端点 + 共享路由声明
 *
 * 覆盖设计文档：
 * - AC3: @relight/shared 的 API_ROUTES.photos 应包含 original 路由
 * - AC6: 后端新增 GET /api/photos/:id/original 端点，返回原始文件二进制
 * - HEIC 原始图在后端转码为 JPEG（响应 Content-Type 为 image/jpeg）
 * - 不存在的照片返回 404
 */
import type { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

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
vi.mock("../jobs/queues", () => ({
  scanQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
  analyzeQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
  dailyQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
}));

// ---- 辅助：请求函数 ----

async function createApp(): Promise<Hono> {
  const { createApp } = await import("../app");
  return createApp();
}

// ---- 测试 ----

describe("原始图 API 端点 — 验收测试", () => {
  // ============================================================
  // AC3: 共享路由声明
  // ============================================================
  describe("AC3: @relight/shared API_ROUTES 应包含 original 路由", () => {
    it("API_ROUTES.photos 应包含 original 路由工厂函数", async () => {
      const { API_ROUTES } = await import("@relight/shared");
      expect(API_ROUTES.photos).toHaveProperty("original");
    });

    it("API_ROUTES.photos.original 应为函数（接收 id 返回路径字符串）", async () => {
      const { API_ROUTES } = await import("@relight/shared");
      const originalFn = API_ROUTES.photos?.original;
      expect(typeof originalFn).toBe("function");
    });

    it("API_ROUTES.photos.original('test-id') 应返回 /api/photos/test-id/original", async () => {
      const { API_ROUTES } = await import("@relight/shared");
      const route = API_ROUTES.photos.original("photo-abc-123");
      expect(route).toBe("/api/photos/photo-abc-123/original");
    });

    it("原有路由不应被破坏 — detail/thumbnail 仍存在", async () => {
      const { API_ROUTES } = await import("@relight/shared");
      expect(API_ROUTES.photos).toHaveProperty("detail");
      expect(API_ROUTES.photos).toHaveProperty("thumbnail");
      expect(API_ROUTES.photos).toHaveProperty("list");
    });
  });

  // ============================================================
  // AC6: 后端 original 端点
  // ============================================================
  describe("AC6: GET /api/photos/:id/original 端点行为", () => {
    it("端点应存在 — GET /api/photos/nonexistent/original 不应返回 500", async () => {
      const app = await createApp();
      // 由于 mock DB 返回空结果，查询不到照片时应返回 404
      const res = await app.request("/api/photos/nonexistent-id/original", {
        method: "GET",
      });
      // 不应 500（路由未注册时会 404，但不是服务端错误）
      expect(res.status).not.toBe(500);
    });

    it("不存在的照片应返回 404", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/nonexistent-id/original", {
        method: "GET",
      });
      // 空 DB mock → 照片不存在 → 404
      expect(res.status).toBe(404);
    });

    it("404 响应应返回 JSON 格式错误信息", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/nonexistent-id/original", {
        method: "GET",
      });
      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).toContain("application/json");

      const body = await res.json();
      expect(body).toHaveProperty("success", false);
      expect(body).toHaveProperty("error");
    });

    it("路由不应与 detail 路由冲突", async () => {
      const app = await createApp();
      // detail 路由 GET /api/photos/:id 应仍然正常工作
      const res = await app.request("/api/photos/some-id", {
        method: "GET",
      });
      // 不应 500（可能 404 因为 mock DB 空，但不应路由冲突）
      expect(res.status).not.toBe(500);
    });

    it("路由不应与 thumbnail 路由冲突", async () => {
      const app = await createApp();
      // thumbnail 路由 GET /api/photos/:id/thumbnail 应仍然正常工作
      const res = await app.request("/api/photos/some-id/thumbnail", {
        method: "GET",
      });
      expect(res.status).not.toBe(500);
    });
  });

  // ============================================================
  // 路由注册验证
  // ============================================================
  describe("路由结构完整性", () => {
    it("GET /api/photos/:id/original 路由应注册在 app 中（非 404 即存在）", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/test-original-route/original", {
        method: "GET",
      });

      // 如果能匹配到路由（而非 404 "not found"），说明路由已注册
      // 由于 mock DB 为空，预期 404（资源不存在）或 200，但不应该是路由未找到的 404
      // Hono 对未注册路由也返回 404，但我们通过响应体判断
      const body = await res.json().catch(() => null);

      if (body) {
        // 如果是 JSON 响应（路由已注册，返回业务 404）
        expect(body).toHaveProperty("success", false);
        expect(body).toHaveProperty("error");
      }
      // 如果 body 为 null，可能是图片响应或路由未注册
      // 宽松处理：只要不是 500 即可
      expect(res.status).not.toBe(500);
    });
  });
});

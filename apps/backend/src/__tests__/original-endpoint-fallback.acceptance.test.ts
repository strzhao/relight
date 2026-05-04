/**
 * 验收测试：original 端点错误兜底
 *
 * 覆盖设计文档「问题 3：Lightbox 原图加载失败」的修复点：
 * - /original 端点出错时返回 SVG 占位图（Content-Type: image/svg+xml）而非 JSON 错误
 * - 照片不存在时返回 200 + SVG 占位图（而非 c.json({...}, 404)）
 * - 文件不存在时返回 200 + SVG 占位图（而非 c.json({...}, 404)）
 * - 文件读取失败时返回 200 + SVG 占位图（而非 c.json({...}, 500)）
 *
 * 【信息隔离铁律】
 * 本文件**仅**基于设计文档编写，代表设计意图的验收标准。
 * 不引用蓝队新写的实现代码。
 */
import type { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

// ---- 辅助：链式 Mock ----
// 防止 db/index.ts 尝试打开真实数据库文件

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

describe("original 端点错误兜底 — 验收测试", () => {
  // ============================================================
  // AC4: /original 端点返回 SVG 占位图
  // ============================================================
  describe("AC4: GET /api/photos/:id/original — 错误兜底为 SVG 占位图", () => {
    /**
     * 设计文档 §问题3 修复点2：
     * /original 端点出错时返回 SVG 占位图（Content-Type: image/svg+xml）
     * 而非 c.json({...}, 404/500) JSON 错误。
     *
     * 意图：lightbox 使用 <img src="/api/photos/:id/original"> 加载图片，
     * 如果返回 JSON 错误，浏览器无法解析为图片 → onError 触发「加载失败」。
     * 返回 SVG 占位图（如灰色方块 + "无原图" 文案）则 <img> 正常显示兜底图。
     */

    it("请求不存在的照片 ID 时应返回 Content-Type: image/svg+xml", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/nonexistent-id/original", {
        method: "GET",
      });

      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).toContain("image/svg+xml");
    });

    it("请求不存在的照片 ID 时应返回状态码 200（而非 404）", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/nonexistent-id/original", {
        method: "GET",
      });

      expect(res.status).toBe(200);
    });

    it("请求不存在的照片 ID 时不应返回 JSON 格式响应", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/nonexistent-id/original", {
        method: "GET",
      });

      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).not.toContain("application/json");
    });

    it("响应体应为有效的 SVG 字符串（非 JSON）", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/nonexistent-id/original", {
        method: "GET",
      });

      const body = await res.text();
      // SVG 响应应以 <svg 标签开头
      expect(body.trim()).toMatch(/^<svg/);
      // 不应是 JSON 格式
      expect(() => JSON.parse(body)).toThrow();
    });

    it("SVG 占位图应有合理的尺寸和内容", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/nonexistent-id/original", {
        method: "GET",
      });

      const body = await res.text();
      // SVG 应包含 xmlns 属性
      expect(body).toContain("xmlns");
      // SVG 应有宽度和高度属性
      expect(body).toContain("width");
      expect(body).toContain("height");
      // 应包含中文提示文案
      expect(body).toMatch(/无|不存在|缺失|失败/);
    });

    it("响应应设置 Cache-Control 头（避免 CDN 缓存错误响应）", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/nonexistent-id/original", {
        method: "GET",
      });

      const cacheControl = res.headers.get("Cache-Control") ?? "";
      expect(cacheControl).toBeTruthy();
      // 错误占位图应有较短的缓存时间（max-age 不宜过大）
      expect(cacheControl).toMatch(/max-age=/);
    });
  });

  // ============================================================
  // 边界情况：不同 ID 均返回 SVG 兜底
  // ============================================================

  describe("不同照片 ID 的兜底一致性", () => {
    it("多个不存在的照片 ID 均返回 SVG 占位图", async () => {
      const app = await createApp();
      const ids = ["nonexistent-aaa", "nonexistent-bbb", "550e8400-e29b-41d4-a716-446655440000"];

      for (const id of ids) {
        const res = await app.request(`/api/photos/${id}/original`, {
          method: "GET",
        });

        const contentType = res.headers.get("Content-Type") ?? "";
        expect(contentType).toContain("image/svg+xml");
        expect(res.status).toBe(200);

        const body = await res.text();
        expect(body.trim()).toMatch(/^<svg/);
      }
    });

    it("路由不应返回 500 内部错误", async () => {
      // 设计意图：即使内部出错（DB 连接失败、文件系统异常等），
      // 也应降级为 SVG 占位图，而非 500 错误导致 <img> 完全无法渲染
      const app = await createApp();
      const res = await app.request("/api/photos/any-id/original", {
        method: "GET",
      });

      expect(res.status).not.toBe(500);
    });
  });

  // ============================================================
  // 对比：原有 thumbnail 端点未受影响
  // ============================================================

  describe("thumbnail 端点不应受影响", () => {
    it("GET /api/photos/:id/thumbnail 仍正常工作（mock DB 空时返回 SVG 兜底）", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/some-id/thumbnail", {
        method: "GET",
      });

      // thumbnail 端点原本就有 SVG 兜底逻辑，不应受影响
      // 即使 mock DB 空，也应能正常返回非 500
      expect(res.status).not.toBe(500);
    });
  });

  // ============================================================
  // 路由结构完整性
  // ============================================================

  describe("original 端点路由注册", () => {
    it("GET /api/photos/:id/original 路由应已注册在 app 中", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/test-route-check/original", {
        method: "GET",
      });

      // 如果能匹配到路由（返回业务响应而非 Hono 默认 404），说明路由已注册
      // 注：设计文档要求错误兜底，所以即使 DB 查询为空也返回 200 + SVG
      const contentType = res.headers.get("Content-Type") ?? "";
      // 路由已注册 → 返回 SVG 占位图（设计文档要求）
      // 路由未注册 → Hono 返回 text/plain 的 "Not Found"
      expect(contentType).toContain("image/svg+xml");
    });
  });
});

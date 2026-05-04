/**
 * 验收测试：original 端点路径解析修复
 *
 * 覆盖 bug fix — path.join → path.resolve：
 * - path.join(rootPath, filePath) 当 filePath 为绝对路径时，会错误拼接两者
 *   例如 path.join("/a", "/a/b/c") → "/a/a/b/c"（路径重复）
 * - path.resolve(rootPath, filePath) 从右向左处理，遇到绝对路径即停止
 *   例如 path.resolve("/a", "/a/b/c") → "/a/b/c"（正确）
 *
 * 【信息隔离铁律】
 * 本文件代表设计意图的验收标准，不引用蓝队实现代码。
 */
import path from "node:path";
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

vi.mock("../db", () => ({
  db: chainableMock([]),
  schema: chainableMock([]),
}));

vi.mock("../jobs/queues", () => ({
  scanQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
  analyzeQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
  dailyQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
}));

async function createApp(): Promise<Hono> {
  const { createApp } = await import("../app");
  return createApp();
}

// ---- 测试 ----

describe("original 端点路径解析修复 — 验收测试", () => {
  // ============================================================
  // AC1: path.resolve vs path.join 行为差异
  // ============================================================
  describe("AC1: path.resolve 正确处理绝对/相对 filePath", () => {
    it("filePath 为绝对路径时，path.resolve 应直接返回 filePath（忽略 rootPath）", () => {
      const rootPath = "/Users/me/photos";
      const filePath = "/Users/me/photos/DCIM/IMG_001.JPG";

      const resolved = path.resolve(rootPath, filePath);
      // path.resolve 从右向左处理，遇到绝对路径 filePath 即停止
      expect(resolved).toBe(filePath);
    });

    it("filePath 为绝对路径时，path.join 会错误拼接导致路径重复", () => {
      const rootPath = "/Users/me/photos";
      const filePath = "/Users/me/photos/DCIM/IMG_001.JPG";

      const joined = path.join(rootPath, filePath);
      // path.join 简单拼接所有参数再 normalize，产生错误路径
      expect(joined).toBe("/Users/me/photos/Users/me/photos/DCIM/IMG_001.JPG");
      expect(joined).not.toBe(filePath);
    });

    it("filePath 为相对路径时，path.resolve 应正确拼接 rootPath", () => {
      const rootPath = "/Users/me/photos";
      const filePath = "DCIM/IMG_001.JPG";

      const resolved = path.resolve(rootPath, filePath);
      expect(resolved).toBe("/Users/me/photos/DCIM/IMG_001.JPG");
    });

    it("filePath 为相对路径时，path.join 应正确拼接 rootPath", () => {
      const rootPath = "/Users/me/photos";
      const filePath = "DCIM/IMG_001.JPG";

      const joined = path.join(rootPath, filePath);
      expect(joined).toBe("/Users/me/photos/DCIM/IMG_001.JPG");
    });

    it("相对路径场景下 path.resolve 和 path.join 结果应一致", () => {
      const rootPath = "/Users/me/photos";
      const filePath = "DCIM/IMG_001.JPG";

      expect(path.resolve(rootPath, filePath)).toBe(path.join(rootPath, filePath));
    });

    it("绝对路径场景下 path.resolve 和 path.join 结果应不同", () => {
      const rootPath = "/Users/me/photos";
      const filePath = "/Users/me/photos/DCIM/IMG_001.JPG";

      expect(path.resolve(rootPath, filePath)).not.toBe(path.join(rootPath, filePath));
    });
  });

  // ============================================================
  // AC2: 实际数据场景 — 回归测试
  // ============================================================
  describe("AC2: 实际存储路径场景（回归测试）", () => {
    it("NAS 照片绝对路径不应被 rootPath 重复拼接", () => {
      const rootPath = "/Users/stringzhao/nas-photos";
      const filePath =
        "/Users/stringzhao/nas-photos/来自 iPhone 12 Pro Max 的备份/DCIM/131APPLE/IMG_1801.PNG";

      const resolved = path.resolve(rootPath, filePath);
      const joined = path.join(rootPath, filePath);

      // path.resolve 应返回正确的文件路径（filePath 本身）
      expect(resolved).toBe(filePath);
      // path.join 会产生错误路径（根因 bug）
      expect(joined).toContain("/nas-photos/Users/");
    });

    it("含中文和空格的路径应正确处理", () => {
      const rootPath = "/Volumes/外置硬盘/照片备份";
      const filePath = "/Volumes/外置硬盘/照片备份/2024年/春节 旅行/DSC0001.JPG";

      const resolved = path.resolve(rootPath, filePath);
      expect(resolved).toBe(filePath);
    });

    it("filePath 仅包含文件名（相对路径极端情况）", () => {
      const rootPath = "/data/photos";
      const filePath = "IMG_0001.HEIC";

      const resolved = path.resolve(rootPath, filePath);
      expect(resolved).toBe("/data/photos/IMG_0001.HEIC");
    });

    it("rootPath 和 filePath 相同时不应产生错误路径", () => {
      const rootPath = "/photos";
      const filePath = "/photos";

      const resolved = path.resolve(rootPath, filePath);
      expect(resolved).toBe("/photos");
    });

    it("filePath 包含 ../ 时 path.resolve 会规范化", () => {
      const rootPath = "/data/photos";
      const filePath = "/data/photos/DCIM/../IMG_001.JPG";

      const resolved = path.resolve(rootPath, filePath);
      expect(resolved).toBe("/data/photos/IMG_001.JPG");
      // 不包含 .. 片段
      expect(resolved).not.toContain("..");
    });
  });

  // ============================================================
  // AC3: 端点路由注册 — original 端点存在且可用
  // ============================================================
  describe("AC3: GET /api/photos/:id/original 端点可用性", () => {
    it("端点应存在 — 不存在的照片 ID 不应返回 500", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/nonexistent/original", {
        method: "GET",
      });
      expect(res.status).not.toBe(500);
    });

    it("路由不应与 detail 路由冲突（GET /api/photos/:id）", async () => {
      const app = await createApp();
      const detailRes = await app.request("/api/photos/test-id", { method: "GET" });
      expect(detailRes.status).not.toBe(500);
    });

    it("路由不应与 thumbnail 路由冲突（GET /api/photos/:id/thumbnail）", async () => {
      const app = await createApp();
      const thumbRes = await app.request("/api/photos/test-id/thumbnail", { method: "GET" });
      expect(thumbRes.status).not.toBe(500);
    });

    it("不存在的照片 ID 应返回内容（SVG 占位图或 JSON 错误，非空响应）", async () => {
      const app = await createApp();
      const res = await app.request("/api/photos/550e8400-e29b-41d4-a716-446655440000/original", {
        method: "GET",
      });
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // AC4: 不同文件扩展名的路径解析
  // ============================================================
  describe("AC4: 多格式文件路径解析", () => {
    const rootPath = "/photos";

    it.each([
      { ext: ".JPG", desc: "JPEG 图片" },
      { ext: ".PNG", desc: "PNG 图片" },
      { ext: ".HEIC", desc: "HEIC 图片" },
      { ext: ".WEBP", desc: "WebP 图片" },
      { ext: ".JPEG", desc: "JPEG 扩展名" },
      { ext: ".GIF", desc: "GIF 图片" },
    ])("$desc ($ext) 绝对路径应正确解析", ({ ext }) => {
      const filePath = `/photos/DCIM/photo${ext}`;
      const resolved = path.resolve(rootPath, filePath);
      expect(resolved).toBe(filePath);
    });
  });
});

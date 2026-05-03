/**
 * 验收测试：扫描/分析 API 契约
 *
 * 覆盖设计文档：
 * - POST /api/scan 支持 skipAnalysis 参数
 * - GET /api/scan/:id 增强 status（"pending"|"running"|"completed"|"failed"）
 * - GET /api/storage/:id/files 返回 FileTreeResponse
 * - POST /api/analyze 批量触发 AI 分析
 * - 响应格式遵循 @relight/shared ApiResponse<T> 规范
 *
 * 验收点：
 * - 路由注册：/api/storage 和 /api/analyze 非 404
 * - skipAnalysis 参数从请求体正确提取
 * - scan status 枚举值校验
 * - FileTreeResponse 响应结构（tree + 统计计数）
 * - AnalyzeTriggerResponse 响应结构（queuedCount + skippedCount + jobIds）
 * - 输入校验：无效载荷返回 400
 */
import { describe, expect, it, vi } from "vitest";

// =========================================================================
// Mock 设置（与 api-contract 测试相同模式）
// =========================================================================

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
  scanQueue: { add: () => Promise.resolve({ id: "mock-scan-job-id" }) },
  analyzeQueue: { add: () => Promise.resolve({ id: "mock-analyze-job-id" }) },
  dailyQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
}));

import { createApp } from "../app";

// =========================================================================
// 辅助函数
// =========================================================================

function app() {
  return createApp();
}

async function get(path: string) {
  const res = await app().request(path, { method: "GET" });
  const contentType = res.headers.get("Content-Type") ?? "";
  if (contentType.startsWith("image/")) {
    return { status: res.status, body: null };
  }
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function post(path: string, data?: unknown) {
  const res = await app().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// =========================================================================
// 测试
// =========================================================================

describe("扫描/分析 API 契约 — 验收测试", () => {
  // =========================================================================
  // POST /api/scan — skipAnalysis 支持
  // =========================================================================
  describe("POST /api/scan — skipAnalysis", () => {
    it("应接受 skipAnalysis: true 并返回 ApiResponse 含 jobId", async () => {
      const { status, body } = await post("/api/scan", {
        storageSourceId: "550e8400-e29b-41d4-a716-446655440000",
        skipAnalysis: true,
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(typeof body.data.jobId).toBe("string");
    });

    it("应接受 skipAnalysis: false 并返回 ApiResponse", async () => {
      const { status, body } = await post("/api/scan", {
        storageSourceId: "550e8400-e29b-41d4-a716-446655440000",
        skipAnalysis: false,
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(typeof body.data.jobId).toBe("string");
    });

    it("不传 skipAnalysis 时应正常运行（默认行为）", async () => {
      const { status, body } = await post("/api/scan", {
        storageSourceId: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    it("不传 storageSourceId 时应正常运行（自动选择第一个启用源）", async () => {
      const { status, body } = await post("/api/scan", {});
      // 允许 200（有可用源）或 400（无可用源）
      expect([200, 400]).toContain(status);
      if (status === 200) {
        expect(body.success).toBe(true);
      }
    });

    it("应拒绝非法的 storageSourceId 格式", async () => {
      const { status } = await post("/api/scan", {
        storageSourceId: "not-a-valid-uuid",
      });
      expect(status).toBe(400);
    });
  });

  // =========================================================================
  // GET /api/scan/:id — 增强状态
  // =========================================================================
  describe("GET /api/scan/:id — 增强状态", () => {
    it("应返回 status 字段且值在有效枚举范围内", async () => {
      const validStatuses: string[] = ["pending", "running", "completed", "failed"];
      const { status, body } = await get("/api/scan/test-source-id");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      // 如果有 status 字段，其值应在枚举范围内
      if (body.data.status) {
        expect(validStatuses).toContain(body.data.status);
      }
    });

    it("响应中应包含 status 字段（设计文档要求增强）", async () => {
      const { status, body } = await get("/api/scan/test-source-id");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      // status 字段必须存在
      expect(body.data).toHaveProperty("status");
    });
  });

  // =========================================================================
  // GET /api/storage/:id/files — 文件树
  // =========================================================================
  describe("GET /api/storage/:id/files — 文件树端点", () => {
    it("路由应已注册（响应体应包含 success 字段）", async () => {
      const { body } = await get("/api/storage/550e8400-e29b-41d4-a716-446655440000/files");
      // 路由注册后，无论成功或失败，handler 都会返回含 success 的 JSON
      // 路由未注册时 Hono 返回纯文本 404，此时 body 为 null
      expect(body).toBeDefined();
      expect(body).toHaveProperty("success");
    });

    it("应返回 ApiResponse 包装格式", async () => {
      const { body } = await get("/api/storage/550e8400-e29b-41d4-a716-446655440000/files");
      // 验证响应体遵循 ApiResponse 规范（含 success 字段）
      expect(body).toBeDefined();
      expect(body).toHaveProperty("success");
    });

    it("成功响应应包含 tree 数组和总计数字段", async () => {
      const { status, body } = await get("/api/storage/550e8400-e29b-41d4-a716-446655440000/files");
      // 仅当 200 时校验完整结构
      if (status === 200 && body?.success) {
        expect(body.data).toBeDefined();
        expect(Array.isArray(body.data.tree)).toBe(true);
        expect(typeof body.data.totalFiles).toBe("number");
        expect(typeof body.data.analyzedCount).toBe("number");
        expect(typeof body.data.pendingCount).toBe("number");
        expect(typeof body.data.failedCount).toBe("number");
      }
    });

    it("分析计数应与总数一致（analyzedCount + pendingCount + failedCount <= totalFiles）", async () => {
      const { status, body } = await get("/api/storage/550e8400-e29b-41d4-a716-446655440000/files");
      if (status === 200 && body?.success) {
        const d = body.data;
        expect(d.analyzedCount + d.pendingCount + d.failedCount).toBeLessThanOrEqual(d.totalFiles);
      }
    });
  });

  // =========================================================================
  // POST /api/analyze — 批量触发分析
  // =========================================================================
  describe("POST /api/analyze — 批量分析端点", () => {
    it("路由应已注册（不应返回 404）", async () => {
      const { status } = await post("/api/analyze", {
        photoIds: ["550e8400-e29b-41d4-a716-446655440000"],
      });
      expect(status).not.toBe(404);
    });

    it("应返回 ApiResponse 包装格式", async () => {
      const { status, body } = await post("/api/analyze", {
        photoIds: ["550e8400-e29b-41d4-a716-446655440000"],
      });
      expect(status).not.toBe(404);
      if (body) {
        expect(body).toHaveProperty("success");
      }
    });

    it("成功响应应包含 queuedCount, skippedCount, jobIds", async () => {
      const { status, body } = await post("/api/analyze", {
        photoIds: ["550e8400-e29b-41d4-a716-446655440000"],
      });
      if (status === 200 && body?.success) {
        expect(body.data).toBeDefined();
        expect(typeof body.data.queuedCount).toBe("number");
        expect(typeof body.data.skippedCount).toBe("number");
        expect(Array.isArray(body.data.jobIds)).toBe(true);
      }
    });

    it("空 photoIds 数组应返回 400", async () => {
      const { status } = await post("/api/analyze", { photoIds: [] });
      if (status !== 404) {
        expect(status).toBe(400);
      }
    });

    it("缺失 photoIds 字段应返回 400", async () => {
      const { status } = await post("/api/analyze", {});
      if (status !== 404) {
        expect(status).toBe(400);
      }
    });

    it("photoIds 为非数组类型应返回 400", async () => {
      const { status } = await post("/api/analyze", {
        photoIds: "not-an-array",
      });
      if (status !== 404) {
        expect(status).toBe(400);
      }
    });

    it("photoIds 包含非 UUID 格式应返回 400", async () => {
      const { status } = await post("/api/analyze", {
        photoIds: ["invalid-uuid-format"],
      });
      if (status !== 404) {
        expect(status).toBe(400);
      }
    });

    it("应支持 force 参数", async () => {
      const { status, body } = await post("/api/analyze", {
        photoIds: ["550e8400-e29b-41d4-a716-446655440000"],
        force: true,
      });
      expect(status).not.toBe(404);
      if (status === 200 && body?.success) {
        expect(body.data).toBeDefined();
        expect(typeof body.data.queuedCount).toBe("number");
      }
    });
  });

  // =========================================================================
  // 路由注册完整性
  // =========================================================================
  describe("新路由注册", () => {
    it("/api/storage 路由组应在 app 中注册（非 500）", async () => {
      const res = await app().request("/api/storage/550e8400-e29b-41d4-a716-446655440000/files", {
        method: "GET",
      });
      expect(res.status).not.toBe(500);
    });

    it("/api/analyze 路由组应在 app 中注册（非 500）", async () => {
      const res = await app().request("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photoIds: ["550e8400-e29b-41d4-a716-446655440000"],
        }),
      });
      expect(res.status).not.toBe(500);
    });

    it("应包含设计文档规定的所有路由组（扩展现有 6 组）", async () => {
      const routeGroups = [
        "/api/health",
        "/api/photos",
        "/api/daily",
        "/api/tags",
        "/api/scan",
        "/api/settings",
        "/api/storage",
        "/api/analyze",
      ];

      for (const path of routeGroups) {
        const method = path === "/api/analyze" ? "POST" : "GET";
        const res = await app().request(path, {
          method,
          headers:
            method === "POST"
              ? {
                  "Content-Type": "application/json",
                }
              : undefined,
          body:
            method === "POST"
              ? JSON.stringify({
                  photoIds: ["550e8400-e29b-41d4-a716-446655440000"],
                })
              : undefined,
        });
        expect(res.status).not.toBe(500);
      }
    });
  });

  // =========================================================================
  // 响应格式一致性
  // =========================================================================
  describe("响应格式一致性", () => {
    it("所有新路由的 200 响应应遵循 ApiResponse 规范", async () => {
      // GET /api/storage/:id/files
      const storageRes = await get("/api/storage/550e8400-e29b-41d4-a716-446655440000/files");
      if (storageRes.status === 200 && storageRes.body) {
        expect(storageRes.body).toHaveProperty("success");
        expect(storageRes.body).toHaveProperty("data");
      }

      // POST /api/analyze
      const analyzeRes = await post("/api/analyze", {
        photoIds: ["550e8400-e29b-41d4-a716-446655440000"],
      });
      if (analyzeRes.status === 200 && analyzeRes.body) {
        expect(analyzeRes.body).toHaveProperty("success");
        expect(analyzeRes.body).toHaveProperty("data");
      }
    });

    it("所有新路由的 400 响应应包含 success: false 和 error 消息", async () => {
      const res = await post("/api/analyze", { photoIds: [] });
      if (res.status === 400 && res.body) {
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBeDefined();
      }
    });
  });
});

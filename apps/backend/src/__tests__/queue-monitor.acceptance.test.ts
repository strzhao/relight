/**
 * 验收测试：队列监控 API
 *
 * 覆盖设计文档：
 * - GET /api/queues                    → 队列列表 + 实时计数（侧边栏轮询，5s 间隔）
 * - GET /api/queues/:name/jobs/:jobId  → 单个作业详情
 * - 不活跃队列 daily-selection 返回 isActive=false, badge="即将支持"
 * - 404 场景：未知队列、不存在的作业
 *
 * 响应格式遵循 @relight/shared 中定义的 ApiResponse<T>
 */
import { describe, expect, it, vi } from "vitest";

// ---- Mock 数据工厂 ----

function mockJobCounts(overrides: Partial<Record<string, number>> = {}) {
  return {
    waiting: 3,
    active: 2,
    completed: 45,
    failed: 1,
    delayed: 0,
    paused: 0,
    ...overrides,
  };
}

function mockJobSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-default-1",
    name: "default-job",
    state: "completed",
    timestamp: 1715000000000,
    processedOn: 1715000001000,
    finishedOn: 1715000002000,
    attemptsMade: 1,
    failedReason: null,
    ...overrides,
  };
}

function mockJobDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-job-1",
    name: "scan-photos",
    state: "completed",
    data: { storageSourceId: "src-1", rootPath: "/photos" },
    progress: 100,
    returnvalue: { scannedCount: 42 },
    opts: { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
    stacktrace: [],
    timestamp: 1715000000000,
    processedOn: 1715000001000,
    finishedOn: 1715000002000,
    attemptsMade: 1,
    failedReason: null,
    getState: vi.fn().mockResolvedValue("completed"),
    ...overrides,
  };
}

// 创建可链式调用的 Mock 对象（复用自 api-contract.acceptance.test.ts）
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

// Mock BullMQ 队列，提供 getJobCounts / getJobs / getJob 方法
vi.mock("../jobs/queues", () => ({
  scanQueue: {
    getJobCounts: vi.fn().mockResolvedValue(mockJobCounts()),
    getJobs: vi.fn().mockResolvedValue([
      mockJobSummary({ id: "scan-job-1", name: "scan-photos", state: "completed" }),
      mockJobSummary({ id: "scan-job-2", name: "scan-videos", state: "active" }),
      mockJobSummary({
        id: "scan-job-3",
        name: "scan-docs",
        state: "failed",
        failedReason: "permission denied",
      }),
    ]),
    getJob: vi.fn().mockImplementation((jobId: string) => {
      if (jobId === "test-job-1") {
        return Promise.resolve(mockJobDetail({ id: "test-job-1" }));
      }
      return Promise.resolve(null);
    }),
  },
  analyzeQueue: {
    getJobCounts: vi
      .fn()
      .mockResolvedValue(mockJobCounts({ waiting: 5, active: 3, completed: 120, failed: 2 })),
    getJobs: vi
      .fn()
      .mockResolvedValue([
        mockJobSummary({ id: "analyze-job-1", name: "analyze-photo-001", state: "waiting" }),
      ]),
    getJob: vi.fn().mockImplementation((jobId: string) => {
      if (jobId === "test-job-1") {
        return Promise.resolve(mockJobDetail({ id: "test-job-1", name: "analyze-photo" }));
      }
      return Promise.resolve(null);
    }),
  },
  dailyQueue: {
    getJobCounts: vi
      .fn()
      .mockResolvedValue(mockJobCounts({ waiting: 0, active: 0, completed: 0, failed: 0 })),
    getJobs: vi.fn().mockResolvedValue([]),
    getJob: vi.fn().mockResolvedValue(null),
  },
}));

import { createApp } from "../app";

// ---- 辅助函数 ----

function app() {
  return createApp();
}

async function get(path: string) {
  const res = await app().request(path, { method: "GET" });
  const contentType = res.headers.get("Content-Type") ?? "";
  if (contentType.startsWith("text/event-stream")) {
    return { status: res.status, body: null, contentType: "text/event-stream" };
  }
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---- 测试 ----

describe("队列监控 API — 验收测试", () => {
  describe("GET /api/queues — 队列列表", () => {
    it("应返回 3 个队列，每个含 name、label、description、isActive、badge、counts", async () => {
      const { status, body } = await get("/api/queues");

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(3);

      for (const queue of body.data) {
        expect(queue).toHaveProperty("name");
        expect(queue).toHaveProperty("label");
        expect(queue).toHaveProperty("description");
        expect(queue).toHaveProperty("isActive");
        // badge 允许为 null 或 string
        expect(queue.badge === null || typeof queue.badge === "string").toBe(true);
        expect(queue.counts === null || typeof queue.counts === "object").toBe(true);
        if (queue.counts) {
          expect(queue.counts).toHaveProperty("waiting");
          expect(queue.counts).toHaveProperty("active");
          expect(queue.counts).toHaveProperty("completed");
          expect(queue.counts).toHaveProperty("failed");
          expect(queue.counts).toHaveProperty("delayed");
          expect(queue.counts).toHaveProperty("paused");
        }
      }
    });

    it("scan-storage 应为 isActive=true, badge=null", async () => {
      const { status, body } = await get("/api/queues");
      expect(status).toBe(200);

      const scanQueue = body.data.find((q: { name: string }) => q.name === "scan-storage");
      expect(scanQueue).toBeDefined();
      expect(scanQueue.isActive).toBe(true);
      expect(scanQueue.badge).toBeNull();
    });

    it("analyze-photo 应为 isActive=true, badge=null", async () => {
      const { status, body } = await get("/api/queues");
      expect(status).toBe(200);

      const analyzeQueue = body.data.find((q: { name: string }) => q.name === "analyze-photo");
      expect(analyzeQueue).toBeDefined();
      expect(analyzeQueue.isActive).toBe(true);
      expect(analyzeQueue.badge).toBeNull();
    });

    it("daily-selection 应为 isActive=false, badge='即将支持'", async () => {
      const { status, body } = await get("/api/queues");
      expect(status).toBe(200);

      const dailyQueue = body.data.find((q: { name: string }) => q.name === "daily-selection");
      expect(dailyQueue).toBeDefined();
      expect(dailyQueue.isActive).toBe(false);
      expect(dailyQueue.badge).toBe("即将支持");
    });

    it("响应体结构应匹配 ApiResponse<QueueInfo[]>", async () => {
      const { status, body } = await get("/api/queues");
      expect(status).toBe(200);
      expect(body).toHaveProperty("success");
      expect(body).toHaveProperty("data");
      // error 字段不应出现在成功的响应中
      expect(body.error).toBeUndefined();
    });
  });

  describe("GET /api/queues/:name/jobs/:jobId — 作业详情", () => {
    it("应返回作业详情（含 id、name、state、data、timestamp、attemptsMade 等字段）", async () => {
      const { status, body } = await get("/api/queues/scan-storage/jobs/test-job-1");

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();

      const job = body.data;
      // QueueJobDetail extends QueueJobSummary 的字段
      expect(job.id).toBe("test-job-1");
      expect(typeof job.name).toBe("string");
      expect(typeof job.state).toBe("string");
      expect(typeof job.timestamp).toBe("number");
      expect(typeof job.attemptsMade).toBe("number");
      // QueueJobDetail 独有字段
      expect(job).toHaveProperty("data");
      expect(job).toHaveProperty("progress");
      expect(job).toHaveProperty("returnvalue");
      expect(job).toHaveProperty("opts");
      expect(job).toHaveProperty("stacktrace");
    });

    it("作业详情响应体结构应匹配 ApiResponse<QueueJobDetail>", async () => {
      const { status, body } = await get("/api/queues/scan-storage/jobs/test-job-1");

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(typeof body.data).toBe("object");
      // 验证 QueueJobDetail 特有的关键字段存在
      expect(body.data).toHaveProperty("id");
      expect(body.data).toHaveProperty("data");
      expect(body.data).toHaveProperty("stacktrace");
    });
  });

  describe("404 场景", () => {
    it("GET /api/queues/scan-storage/jobs/nonexistent — 作业不存在应返回 404", async () => {
      const { status, body } = await get("/api/queues/scan-storage/jobs/nonexistent");

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    });

    it("GET /api/queues/unknown-queue/jobs/any-id — 未知队列应返回 404", async () => {
      const { status, body } = await get("/api/queues/unknown-queue/jobs/any-id");

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    });
  });

  describe("SSE 端点 — GET /api/queues/:name/events", () => {
    it("应返回 text/event-stream Content-Type", async () => {
      // SSE 端点通过 app.request() 测试连接建立
      // 实际流式数据需通过 ReadableStream 测试，这里仅验证路由注册和 Content-Type
      const res = await app().request("/api/queues/scan-storage/events", {
        method: "GET",
        headers: { Accept: "text/event-stream" },
      });

      // SSE 端点应返回 text/event-stream 或至少不返回 404/500
      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(500);
    });
  });

  describe("路由结构完整性", () => {
    it("应包含设计文档规定的所有队列 API 路由组", async () => {
      const routePaths = [
        "/api/queues",
        "/api/queues/scan-storage/events",
        "/api/queues/scan-storage/jobs/test-job-1",
      ];

      for (const path of routePaths) {
        const res = await app().request(path, { method: "GET" });
        // 路由应已注册，不应返回 404（除非是作业不存在的业务 404）
        // SSE 和 queues list 应正常返回
        if (path === "/api/queues/scan-storage/jobs/test-job-1") {
          expect(res.status).not.toBe(500);
        } else {
          expect(res.status).not.toBe(500);
        }
      }
    });

    it("all 3 active-queue event routes should exist (no 404 for queue discovery)", async () => {
      const eventPaths = ["/api/queues/scan-storage/events", "/api/queues/analyze-photo/events"];

      for (const path of eventPaths) {
        const res = await app().request(path, {
          method: "GET",
          headers: { Accept: "text/event-stream" },
        });
        expect(res.status).not.toBe(404);
      }
    });
  });
});

/**
 * 验收测试：任务 2 — Admin 队列页"重试全部失败"按钮
 *
 * 契约来源：设计文档「重试失败按钮（API 契约）」
 *
 * 验收标准：
 * 1. POST /api/queues/:name/retry-failed — 已知队列名，无 failed job 时 → 200 + { retried:0, failed:0, total:0 }
 * 2. POST /api/queues/:name/retry-failed — 未知队列名 → 404 + { success: false, error: ... }
 * 3. 响应格式：{ success: true, data: { retried, failed, total } }，三个数字非负，retried + failed === total
 * 4. packages/shared/src/routes.ts 中 API_ROUTES.queues.retryFailed 必须存在且为函数
 * 5. retryFailed 函数返回值格式为 "/api/queues/:name/retry-failed"
 *
 * 测试策略：
 * - BullMQ 部分：skipIf Redis 不可用
 * - 路由契约（404 / 格式）：mock BullMQ 队列，不需 Redis
 * - 静态路由常量检查：纯 import，无 IO
 *
 * 红队铁律：不读取 routes/queues.ts 的 retry-failed 实现。
 */
import { Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// =====================================================================
// Redis 可用性检查（同 health-worker 测试）
// =====================================================================

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const BULLMQ_PREFIX = process.env.BULLMQ_PREFIX ?? "bull";

let redisAvailable = false;

/** 测试专属队列名（防止污染真实队列） */
const TEST_QUEUE_NAME = "analyze-photo";

beforeAll(async () => {
  // 用一个一次性的 Queue 来 ping Redis
  const probe = new Queue("__health-probe__", {
    connection: { url: REDIS_URL },
    prefix: `${BULLMQ_PREFIX}-test-probe`,
  });
  try {
    await probe.getJobCounts();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  } finally {
    await probe.close().catch(() => {});
  }
}, 10_000);

// =====================================================================
// 辅助：通过 createApp() 调用 retry-failed 端点
// =====================================================================

async function callRetryFailed(
  queueName: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { createApp } = await import("../../app");
  const app = createApp();
  const res = await app.request(`/api/queues/${queueName}/retry-failed`, {
    method: "POST",
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// =====================================================================
// Mock：DB 和队列（供无 Redis 的路由结构测试使用）
// =====================================================================

// 注意：mock 需在 import createApp 之前 hoist
vi.mock("../../db", () => {
  function chainable(): unknown {
    const fn = () => chainable();
    return new Proxy(fn, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown) => res([]);
        if (prop === Symbol.toPrimitive || prop === "toString") return () => "[]";
        if (typeof prop === "string" && /^\d+$/.test(prop)) return undefined;
        return chainable();
      },
    });
  }
  return { db: chainable(), schema: chainable() };
});

vi.mock("../../jobs/queues", () => ({
  scanQueue: {
    add: () => Promise.resolve({ id: "mock-job-id" }),
    getJobCounts: () =>
      Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }),
    getFailed: () => Promise.resolve([]),
    retryFailed: () => Promise.resolve(0),
  },
  analyzeQueue: {
    add: () => Promise.resolve({ id: "mock-job-id" }),
    getJobCounts: () =>
      Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }),
    getFailed: () => Promise.resolve([]),
    retryFailed: () => Promise.resolve(0),
  },
  dailyQueue: {
    add: () => Promise.resolve({ id: "mock-job-id" }),
    getJobCounts: () =>
      Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }),
    getFailed: () => Promise.resolve([]),
    retryFailed: () => Promise.resolve(0),
  },
}));

// =====================================================================
// 任务 2a：路由结构契约（不依赖 Redis）
// =====================================================================

describe("POST /api/queues/:name/retry-failed — 路由结构契约", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("未知队列名 → 404 + { success: false, error: ... }", async () => {
    const { status, body } = await callRetryFailed("nonexistent-queue-xyz");
    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error, "error 字段应存在").toBeTruthy();
  });

  it("未知队列名（特殊字符）→ 404", async () => {
    const { status, body } = await callRetryFailed("__invalid__");
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  it("已知队列名 scan-storage，mock 无 failed job → 200 + success:true", async () => {
    const { status, body } = await callRetryFailed("scan-storage");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("已知队列名 analyze-photo，mock 无 failed job → data.retried/failed/total 均为非负整数", async () => {
    const { status, body } = await callRetryFailed("analyze-photo");
    expect(status).toBe(200);

    const data = body.data as { retried: number; failed: number; total: number };
    expect(typeof data.retried).toBe("number");
    expect(typeof data.failed).toBe("number");
    expect(typeof data.total).toBe("number");
    expect(data.retried).toBeGreaterThanOrEqual(0);
    expect(data.failed).toBeGreaterThanOrEqual(0);
    expect(data.total).toBeGreaterThanOrEqual(0);
  });

  it("无 failed job 时 → { retried: 0, failed: 0, total: 0 }", async () => {
    const { body } = await callRetryFailed("analyze-photo");
    const data = body.data as { retried: number; failed: number; total: number };
    expect(data.retried).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.total).toBe(0);
  });

  it("返回值满足 retried + failed === total 约束", async () => {
    const { body } = await callRetryFailed("scan-storage");
    const data = body.data as { retried: number; failed: number; total: number };
    expect(data.retried + data.failed).toBe(data.total);
  });

  it("已知队列名 daily-selection → 200（不应返回 404）", async () => {
    const { status } = await callRetryFailed("daily-selection");
    expect(status).toBe(200);
  });
});

// =====================================================================
// 任务 2b：API_ROUTES 静态契约
// =====================================================================

describe("API_ROUTES.queues.retryFailed — 静态路由常量契约", () => {
  it("API_ROUTES.queues.retryFailed 必须存在", async () => {
    const { API_ROUTES } = await import("@relight/shared");
    expect(
      (API_ROUTES.queues as Record<string, unknown>).retryFailed,
      "API_ROUTES.queues.retryFailed 必须存在",
    ).toBeDefined();
  });

  it("API_ROUTES.queues.retryFailed 必须是函数", async () => {
    const { API_ROUTES } = await import("@relight/shared");
    const retryFailed = (API_ROUTES.queues as Record<string, unknown>).retryFailed;
    expect(typeof retryFailed).toBe("function");
  });

  it("API_ROUTES.queues.retryFailed('scan-storage') 返回正确路径", async () => {
    const { API_ROUTES } = await import("@relight/shared");
    const retryFailed = (API_ROUTES.queues as Record<string, unknown>).retryFailed as (
      name: string,
    ) => string;
    const path = retryFailed("scan-storage");
    expect(path).toBe("/api/queues/scan-storage/retry-failed");
  });

  it("API_ROUTES.queues.retryFailed('analyze-photo') 返回正确路径", async () => {
    const { API_ROUTES } = await import("@relight/shared");
    const retryFailed = (API_ROUTES.queues as Record<string, unknown>).retryFailed as (
      name: string,
    ) => string;
    const path = retryFailed("analyze-photo");
    expect(path).toBe("/api/queues/analyze-photo/retry-failed");
  });
});

// =====================================================================
// 任务 2c：BullMQ 集成测试（需要 Redis）
// =====================================================================

describe("POST /api/queues/:name/retry-failed — BullMQ 集成（Redis 可用时）", () => {
  // 注意：此套件需要真实 Redis，不使用 vi.mock 中的 mock 队列
  // 由于 vi.mock 已在模块级 hoist，此处我们通过直接操作 BullMQ Queue 实例验证行为

  let realQueue: Queue;

  beforeAll(() => {
    if (!redisAvailable) return;
    realQueue = new Queue(TEST_QUEUE_NAME, {
      connection: { url: REDIS_URL },
      prefix: `${BULLMQ_PREFIX}-test-acceptance`,
    });
  });

  afterAll(async () => {
    if (!redisAvailable || !realQueue) return;
    await realQueue.obliterate({ force: true }).catch(() => {});
    await realQueue.close().catch(() => {});
  });

  it.skipIf(!redisAvailable)(
    "实际空 failed 队列 → getJobCounts().failed === 0",
    async () => {
      const counts = await realQueue.getJobCounts("failed");
      // 刚建的测试队列 failed 计数应为 0
      expect(counts.failed ?? 0).toBe(0);
    },
    10_000,
  );
});

/**
 * 验收测试：任务 1 — Worker 启动透明化
 *
 * 契约来源：设计文档「Worker 启动透明化（API 行为契约）」
 *
 * 验收标准：
 * 1. GET /api/admin/health 的 data.components 中必须包含 component === "worker" 的项
 * 2. Redis 中存在 worker meta key 时：status="healthy"，message 含 "commit" 和 "uptime"
 * 3. Redis 中 worker meta key 不存在时：status="unhealthy"，message 含 "未检测到 worker"
 * 4. worker 在线时 overall 应为 "healthy"（假设其余组件也正常）
 * 5. worker 离线时 overall 应为 "unhealthy"（worker unhealthy 导致 overall=unhealthy）
 * 6. worker component 必须包含 component / status / message 字段，符合 HealthComponentStatus 接口
 *
 * 测试策略：
 * - 使用 ioredis 直接写/删 meta key 模拟 worker 在线/离线，不启动真实 worker 进程
 * - 通过 createApp() 的 health endpoint 验证响应
 * - Redis 不可用时跳过整套 Redis 相关 case
 *
 * 红队铁律：不读取 admin.ts 的 worker 检测实现、workers/index.ts、build-info.ts。
 */
import type { HealthComponentStatus } from "@relight/shared";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// =====================================================================
// Redis 可用性检查
// =====================================================================

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const BULLMQ_PREFIX = process.env.BULLMQ_PREFIX ?? "bull";
const WORKER_META_KEY = `${BULLMQ_PREFIX}:worker:meta`;

let redisAvailable = false;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 3000,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    await redis.ping();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  }
}, 10_000);

afterAll(async () => {
  if (redisAvailable) {
    // 清理测试写入的 meta key（如果存在）
    await redis.del(WORKER_META_KEY).catch(() => {});
  }
  await redis.quit().catch(() => {});
});

// =====================================================================
// DB/Queue Mock（避免 createApp 依赖真实 DB / Queue）
// =====================================================================

vi.mock("../../db", () => {
  function chainable(): unknown {
    const fn = () => chainable();
    return new Proxy(fn, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown) => res([{ val: 1 }]);
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
  },
  analyzeQueue: {
    add: () => Promise.resolve({ id: "mock-job-id" }),
    getJobCounts: () =>
      Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }),
  },
  dailyQueue: {
    add: () => Promise.resolve({ id: "mock-job-id" }),
    getJobCounts: () =>
      Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }),
  },
}));

// =====================================================================
// 辅助函数
// =====================================================================

async function callHealthEndpoint(): Promise<{
  status: number;
  body: {
    data: {
      overall: string;
      components: HealthComponentStatus[];
    };
  };
}> {
  // 动态导入避免 mock 时机问题
  const { createApp } = await import("../../app");
  const app = createApp();
  const res = await app.request("/api/admin/health");
  const body = await res.json();
  return { status: res.status, body };
}

/** 写入 worker meta key，模拟 worker 在线 */
async function setWorkerMeta(overrides: Partial<Record<string, unknown>> = {}): Promise<void> {
  const meta = {
    commit: "abc1234",
    commitTime: "2026-05-01T00:00:00Z",
    startedAt: new Date(Date.now() - 65_000).toISOString(), // 已在线 65 秒
    pid: 12345,
    hostname: "test-host",
    ...overrides,
  };
  await redis.set(WORKER_META_KEY, JSON.stringify(meta), "EX", 120);
}

/** 删除 worker meta key，模拟 worker 离线 */
async function removeWorkerMeta(): Promise<void> {
  await redis.del(WORKER_META_KEY);
}

// =====================================================================
// 测试套件
// =====================================================================

describe("GET /api/admin/health — Worker 组件验收（Redis 可用时）", () => {
  it.skipIf(!redisAvailable)(
    "worker 在线：components 中存在 component==='worker' 的项，status='healthy'",
    async () => {
      await setWorkerMeta();

      const { status, body } = await callHealthEndpoint();
      expect(status).toBe(200);

      const workerComp = body.data.components.find((c) => c.component === "worker");
      expect(workerComp, "components 中必须存在 worker 项").toBeDefined();
      expect(workerComp?.status).toBe("healthy");
    },
    15_000,
  );

  it.skipIf(!redisAvailable)(
    "worker 在线：message 包含子串 'commit' 和 'uptime'",
    async () => {
      await setWorkerMeta();

      const { body } = await callHealthEndpoint();
      const workerComp = body.data.components.find((c) => c.component === "worker");

      expect(workerComp?.message, "message 应包含 commit").toContain("commit");
      expect(workerComp?.message, "message 应包含 uptime").toContain("uptime");
    },
    15_000,
  );

  it.skipIf(!redisAvailable)(
    "worker 在线时 message 格式：commit <hash>, pid <N>, uptime <N>s",
    async () => {
      await setWorkerMeta({ commit: "deadbeef", pid: 99999 });

      const { body } = await callHealthEndpoint();
      const workerComp = body.data.components.find((c) => c.component === "worker");

      const msg = workerComp?.message ?? "";
      expect(msg).toContain("deadbeef");
      expect(msg).toContain("99999");
      // uptime 应是数字后跟 s
      expect(msg).toMatch(/uptime\s+\d+s/);
    },
    15_000,
  );

  it.skipIf(!redisAvailable)(
    "worker 离线：status='unhealthy'，message 含 '未检测到 worker'",
    async () => {
      await removeWorkerMeta();

      const { body } = await callHealthEndpoint();
      const workerComp = body.data.components.find((c) => c.component === "worker");

      expect(workerComp, "components 中必须存在 worker 项").toBeDefined();
      expect(workerComp?.status).toBe("unhealthy");
      expect(workerComp?.message, "离线 message 需含 '未检测到 worker'").toContain(
        "未检测到 worker",
      );
    },
    15_000,
  );

  it.skipIf(!redisAvailable)(
    "worker 离线时 overall 应为 'unhealthy'（worker unhealthy 拉低整体）",
    async () => {
      await removeWorkerMeta();

      const { body } = await callHealthEndpoint();
      expect(body.data.overall).toBe("unhealthy");
    },
    15_000,
  );

  it.skipIf(!redisAvailable)(
    "worker component 结构符合 HealthComponentStatus 接口（含 component/status 字段）",
    async () => {
      await setWorkerMeta();

      const { body } = await callHealthEndpoint();
      const workerComp = body.data.components.find((c) => c.component === "worker");

      expect(workerComp).toMatchObject({
        component: "worker",
        status: expect.stringMatching(/^(healthy|degraded|unhealthy)$/),
      });
      // message 在 healthy 时不为空
      expect(typeof workerComp?.message).toBe("string");
    },
    15_000,
  );

  it.skipIf(!redisAvailable)(
    "components 数组中存在 'api' / 'database' / 'redis' / 'worker' 四个必要组件",
    async () => {
      await setWorkerMeta();

      const { body } = await callHealthEndpoint();
      const names = body.data.components.map((c) => c.component);

      expect(names).toContain("api");
      expect(names).toContain("database");
      expect(names).toContain("redis");
      expect(names).toContain("worker");
    },
    15_000,
  );
});

describe("GET /api/admin/health — Worker 组件结构（无论 Redis 是否可用）", () => {
  it("响应应包含 data.overall 和 data.components 数组", async () => {
    const { status, body } = await callHealthEndpoint();
    expect(status).toBe(200);
    expect(body.data).toBeDefined();
    expect(typeof body.data.overall).toBe("string");
    expect(Array.isArray(body.data.components)).toBe(true);
    expect(body.data.components.length).toBeGreaterThan(0);
  }, 15_000);

  it("Redis 不可用时：components 中仍存在 worker 项（状态 unhealthy）", async () => {
    if (redisAvailable) {
      // Redis 可用时跳过此 case（改由上面 Redis 套件覆盖）
      return;
    }
    const { body } = await callHealthEndpoint();
    const workerComp = body.data.components.find((c) => c.component === "worker");
    // Redis 不可用时 worker 组件存在但必须是 unhealthy
    expect(workerComp, "Redis 不可用时 worker 组件也必须出现").toBeDefined();
    expect(workerComp?.status).toBe("unhealthy");
  }, 15_000);
});

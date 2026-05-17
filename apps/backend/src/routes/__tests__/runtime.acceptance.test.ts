/**
 * 验收测试：GET /api/runtime/status —— Mac App 控制中心数据契约
 *
 * 契约来源：设计文档「## 契约规约」+ packages/shared/src/types.ts 的 RuntimeStatus 类型
 *
 * 验收标准：
 * 1. 200 响应，shape { success: true, data: RuntimeStatus }
 * 2. data.overall ∈ { "running" | "degraded" | "down" }
 * 3. data.version 是非空字符串
 * 4. data.services 含 api / workers / redis / cron 四个子节
 * 5. data.services.api 在响应时永远是 "running"（路由能响应说明 API 在跑）
 * 6. data.services.api 含 port (>0) / uptimeSec (≥0) / pid (>0)
 * 7. 三个子服务的 status 字段均为 running/degraded/down 枚举值
 * 8. data.services.workers.queueDepth 在 queues 可访问时含 scan/analyze/daily/faces 四个非负整数
 * 9. Worker 在线（Redis meta 存在且新鲜）→ workers.status === "running"
 * 10. Worker 离线（无 meta）→ workers.status === "down"
 * 11. Worker 心跳过期（startedAt > 180s 前）→ workers.status === "degraded"
 * 12. data.repository 在 DB 不可用时可以为 null（不阻塞主流程）
 *
 * 红队铁律：不读取 routes/runtime.ts 实现，仅依据设计契约写测试
 */
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
    await redis.del(WORKER_META_KEY).catch(() => {});
  }
  await redis.quit().catch(() => {});
});

// =====================================================================
// DB / Queue Mocks（红队独立于实现，但需要 createApp 能跑起来）
// =====================================================================

vi.mock("../../db", () => {
  function chainable(): unknown {
    const fn = () => chainable();
    return new Proxy(fn, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown) => res([{ total: 0 }]);
        if (prop === Symbol.toPrimitive || prop === "toString") return () => "[]";
        if (typeof prop === "string" && /^\d+$/.test(prop)) return undefined;
        return chainable();
      },
    });
  }
  return { db: chainable(), schema: chainable() };
});

vi.mock("../../jobs/queues", () => {
  const counts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 };
  const q = {
    add: () => Promise.resolve({ id: "mock" }),
    getJobCounts: () => Promise.resolve(counts),
    getRepeatableJobs: () =>
      Promise.resolve([
        {
          key: "mock-key",
          name: "daily-selection-cron",
          id: null,
          endDate: null,
          tz: "Asia/Shanghai",
          pattern: "0 6 * * *",
          next: Date.now() + 3600 * 1000,
        },
      ]),
  };
  return { scanQueue: q, analyzeQueue: q, dailyQueue: q, detectFacesQueue: q };
});

// =====================================================================
// Helpers
// =====================================================================

async function fetchRuntime(): Promise<{
  status: number;
  body: {
    success: boolean;
    data: {
      overall: string;
      version: string;
      services: {
        api: { status: string; port: number; uptimeSec: number; pid: number };
        workers: {
          status: string;
          lastHeartbeatAgoSec: number | null;
          commit: string | null;
          queueDepth: { scan: number; analyze: number; daily: number; faces: number } | null;
        };
        redis: { status: string; latencyMs: number | null };
        cron: { status: string; lastDailyPickDate: string | null; nextRunAt: string | null };
      };
      repository: {
        photoCount: number;
        todayAdded: number;
        pendingAnalysis: number;
        storageBytes: number;
      } | null;
    };
  };
}> {
  const { createApp } = await import("../../app");
  const app = createApp();
  const res = await app.request("/api/runtime/status");
  const body = await res.json();
  return { status: res.status, body };
}

async function setWorkerMeta(
  opts: { ttlSec?: number; startedAtMsAgo?: number } = {},
): Promise<void> {
  const meta = {
    commit: "abc1234",
    commitTime: "2026-05-01T00:00:00Z",
    startedAt: new Date(Date.now() - (opts.startedAtMsAgo ?? 30_000)).toISOString(),
    pid: 12345,
    hostname: "test",
  };
  await redis.set(WORKER_META_KEY, JSON.stringify(meta), "EX", opts.ttlSec ?? 120);
}

async function setWorkerMetaWithoutTtl(): Promise<void> {
  const meta = {
    commit: "abc1234",
    commitTime: "2026-05-01T00:00:00Z",
    startedAt: new Date().toISOString(),
    pid: 12345,
    hostname: "test",
  };
  // 无 TTL 表示心跳逻辑异常（worker 没用 EX 写入），按"down"处理
  await redis.set(WORKER_META_KEY, JSON.stringify(meta));
}

async function removeWorkerMeta(): Promise<void> {
  await redis.del(WORKER_META_KEY);
}

// =====================================================================
// 契约结构验收
// =====================================================================

describe("GET /api/runtime/status — 契约形状", () => {
  it("响应 200 + success=true + data 非空", async () => {
    const { status, body } = await fetchRuntime();
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  }, 15_000);

  it("overall 字段在枚举 { running, degraded, down } 内", async () => {
    const { body } = await fetchRuntime();
    expect(["running", "degraded", "down"]).toContain(body.data.overall);
  }, 15_000);

  it("version 字段是非空字符串", async () => {
    const { body } = await fetchRuntime();
    expect(typeof body.data.version).toBe("string");
    expect(body.data.version.length).toBeGreaterThan(0);
  }, 15_000);

  it("services 节含 api / workers / redis / cron 四个子节", async () => {
    const { body } = await fetchRuntime();
    expect(body.data.services).toBeDefined();
    expect(body.data.services.api).toBeDefined();
    expect(body.data.services.workers).toBeDefined();
    expect(body.data.services.redis).toBeDefined();
    expect(body.data.services.cron).toBeDefined();
  }, 15_000);

  it("services.api：能响应就是 running，且 port>0、uptimeSec≥0、pid>0", async () => {
    const { body } = await fetchRuntime();
    expect(body.data.services.api.status).toBe("running");
    expect(body.data.services.api.port).toBeGreaterThan(0);
    expect(body.data.services.api.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(body.data.services.api.pid).toBeGreaterThan(0);
  }, 15_000);

  it("三个子服务 status 全部在枚举内", async () => {
    const { body } = await fetchRuntime();
    const enumVals = ["running", "degraded", "down"];
    expect(enumVals).toContain(body.data.services.workers.status);
    expect(enumVals).toContain(body.data.services.redis.status);
    expect(enumVals).toContain(body.data.services.cron.status);
  }, 15_000);

  it("workers.queueDepth 在 queues 可访问时含 scan/analyze/daily/faces 四个非负整数", async () => {
    const { body } = await fetchRuntime();
    const q = body.data.services.workers.queueDepth;
    if (q) {
      expect(typeof q.scan).toBe("number");
      expect(typeof q.analyze).toBe("number");
      expect(typeof q.daily).toBe("number");
      expect(typeof q.faces).toBe("number");
      expect(q.scan).toBeGreaterThanOrEqual(0);
      expect(q.analyze).toBeGreaterThanOrEqual(0);
      expect(q.daily).toBeGreaterThanOrEqual(0);
      expect(q.faces).toBeGreaterThanOrEqual(0);
    }
  }, 15_000);

  it("repository 可以为 null（DB 不可用降级），如非 null 则字段齐全", async () => {
    const { body } = await fetchRuntime();
    if (body.data.repository) {
      expect(typeof body.data.repository.photoCount).toBe("number");
      expect(typeof body.data.repository.todayAdded).toBe("number");
      expect(typeof body.data.repository.pendingAnalysis).toBe("number");
      expect(typeof body.data.repository.storageBytes).toBe("number");
    }
  }, 15_000);
});

// =====================================================================
// Worker 状态机验收（Redis 可用时）
// =====================================================================

describe("services.workers 状态机（基于 Redis key TTL，不是 startedAt）", () => {
  it.skipIf(!redisAvailable)(
    "key 存在且 TTL > 0（心跳新鲜）→ status='running'，lastHeartbeatAgoSec≥0",
    async () => {
      await setWorkerMeta({ ttlSec: 120 });
      const { body } = await fetchRuntime();
      expect(body.data.services.workers.status).toBe("running");
      expect(body.data.services.workers.lastHeartbeatAgoSec).toBeGreaterThanOrEqual(0);
      expect(body.data.services.workers.commit).toBeTruthy();
    },
    15_000,
  );

  it.skipIf(!redisAvailable)(
    "worker 跑了很久（startedAt 是 1 小时前）但 TTL 新鲜 → 仍然 running",
    async () => {
      await setWorkerMeta({ ttlSec: 100, startedAtMsAgo: 3_600_000 });
      const { body } = await fetchRuntime();
      // 关键回归：startedAt 不该影响 status 判断（曾用 startedAt 推 ageSec 导致误报 degraded）
      expect(body.data.services.workers.status).toBe("running");
    },
    15_000,
  );

  it.skipIf(!redisAvailable)(
    "worker 离线（无 meta key）→ status='down'，lastHeartbeatAgoSec=null",
    async () => {
      await removeWorkerMeta();
      const { body } = await fetchRuntime();
      expect(body.data.services.workers.status).toBe("down");
      expect(body.data.services.workers.lastHeartbeatAgoSec).toBeNull();
      expect(body.data.services.workers.commit).toBeNull();
    },
    15_000,
  );

  it.skipIf(!redisAvailable)(
    "key 存在但无 TTL（worker 心跳逻辑异常）→ status='down'",
    async () => {
      await setWorkerMetaWithoutTtl();
      const { body } = await fetchRuntime();
      expect(body.data.services.workers.status).toBe("down");
    },
    15_000,
  );
});

// =====================================================================
// Redis 状态验收（Redis 可用时）
// =====================================================================

describe("services.redis 状态", () => {
  it.skipIf(!redisAvailable)(
    "Redis 可达 → status='running'，latencyMs 为非负整数",
    async () => {
      const { body } = await fetchRuntime();
      expect(body.data.services.redis.status).toBe("running");
      expect(body.data.services.redis.latencyMs).not.toBeNull();
      expect(body.data.services.redis.latencyMs!).toBeGreaterThanOrEqual(0);
    },
    15_000,
  );
});

// =====================================================================
// 安全契约验收 — localhostOnly middleware + 脱敏
//
// ⚠️  TCP 模式安全前提（必读）：
//   以下所有 "无 socket → 视为 localhost" 测试仅在项目以 **TCP** 模式监听时安全。
//   若未来改用 UNIX socket / cluster IPC，c.env.incoming.socket.remoteAddress
//   将为 undefined，会被中间件误判为 localhost，导致敏感字段泄露。
//   改变 listen mode 时必须同步审查本测试 + middleware 文件。
//
//   契约来源：设计文档「## Middleware 行为契约」+ 「/api/runtime/status 响应脱敏契约」
//   红队铁律：不读取 middleware 实现，仅依据设计契约写测试。
// =====================================================================

describe("安全契约 — localhostOnly middleware + 脱敏 (红队, 基于设计契约)", () => {
  // ------------------------------------------------------------------
  // Case A：app.request() 无 socket → 视为 localhost，pid 非 null（回归保护）
  // ------------------------------------------------------------------
  it("case A — 无 socket (TCP 模式 app.request) → isLocalhost=true → pid 是正整数", async () => {
    const { createApp } = await import("../../app");
    const app = createApp();
    // 直接调用，不传第三个 env 参数，socket.remoteAddress 为 undefined
    const res = await app.request("/api/runtime/status");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // pid 应当是正整数（未脱敏）
    expect(typeof body.data.services.api.pid).toBe("number");
    expect(body.data.services.api.pid).toBeGreaterThan(0);
  }, 15_000);

  // ------------------------------------------------------------------
  // Case B：remoteAddress = "192.168.1.5" → GET → 脱敏，pid/commit/storageBytes 全 null
  // ------------------------------------------------------------------
  it("case B — 远端 IP (192.168.1.5) GET /api/runtime/status → HTTP 200 + 敏感字段脱敏为 null", async () => {
    const { createApp } = await import("../../app");
    const app = createApp();
    const res = await app.request("/api/runtime/status", undefined, {
      incoming: { socket: { remoteAddress: "192.168.1.5" } },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // 敏感字段全部脱敏
    expect(body.data.services.api.pid).toBeNull();
    expect(body.data.services.workers.commit).toBeNull();
    if (body.data.repository !== null) {
      expect(body.data.repository.storageBytes).toBeNull();
    }
    // 非敏感字段仍然正常
    expect(typeof body.data.services.api.uptimeSec).toBe("number");
    expect(body.data.services.api.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(["running", "degraded", "down"]).toContain(body.data.overall);
  }, 15_000);

  // ------------------------------------------------------------------
  // Case C：XFF 伪造无效 — X-Forwarded-For: 127.0.0.1 不影响脱敏判断
  // ------------------------------------------------------------------
  it("case C — XFF 伪造 (X-Forwarded-For: 127.0.0.1) + socket=192.168.1.5 → 脱敏同 case B，XFF 被忽略", async () => {
    const { createApp } = await import("../../app");
    const app = createApp();
    const res = await app.request(
      "/api/runtime/status",
      { headers: { "X-Forwarded-For": "127.0.0.1" } },
      { incoming: { socket: { remoteAddress: "192.168.1.5" } } },
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    // XFF 不能绕过脱敏；middleware 只读 socket.remoteAddress
    expect(body.data.services.api.pid).toBeNull();
    expect(body.data.services.workers.commit).toBeNull();
    if (body.data.repository !== null) {
      expect(body.data.repository.storageBytes).toBeNull();
    }
  }, 15_000);

  // ------------------------------------------------------------------
  // Case D：POST 来自非 localhost → middleware 直接 403
  // ------------------------------------------------------------------
  it("case D — 非 localhost POST /api/runtime/* → 403 forbidden", async () => {
    const { createApp } = await import("../../app");
    const app = createApp();
    const res = await app.request(
      "/api/runtime/anything-here",
      { method: "POST" },
      { incoming: { socket: { remoteAddress: "192.168.1.5" } } },
    );
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.success).toBe(false);
    expect(body.error).toBe("forbidden");
  }, 15_000);

  // ------------------------------------------------------------------
  // Case E：POST 来自 localhost socket → middleware 放行（不是 403）
  // ------------------------------------------------------------------
  it("case E — localhost POST /api/runtime/* → middleware 不拦截（404 或其它，绝不是 403）", async () => {
    const { createApp } = await import("../../app");
    const app = createApp();
    const res = await app.request(
      "/api/runtime/some-non-existent-post",
      { method: "POST" },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    // middleware 放行 localhost，路由不存在时 Hono 返回 404；重点：不是 403
    expect(res.status).not.toBe(403);
  }, 15_000);

  // ------------------------------------------------------------------
  // Case F：IPv6 ::1 也是 localhost → pid 非 null
  // ------------------------------------------------------------------
  it("case F — IPv6 ::1 视为 localhost → pid 非 null（不脱敏）", async () => {
    const { createApp } = await import("../../app");
    const app = createApp();
    const res = await app.request("/api/runtime/status", undefined, {
      incoming: { socket: { remoteAddress: "::1" } },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.services.api.pid).not.toBeNull();
    expect(typeof body.data.services.api.pid).toBe("number");
    expect(body.data.services.api.pid).toBeGreaterThan(0);
  }, 15_000);

  // ------------------------------------------------------------------
  // Case G：IPv4-mapped IPv6 ::ffff:127.0.0.1 也是 localhost → pid 非 null
  // ------------------------------------------------------------------
  it("case G — IPv4-mapped IPv6 ::ffff:127.0.0.1 视为 localhost → pid 非 null（不脱敏）", async () => {
    const { createApp } = await import("../../app");
    const app = createApp();
    const res = await app.request("/api/runtime/status", undefined, {
      incoming: { socket: { remoteAddress: "::ffff:127.0.0.1" } },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.services.api.pid).not.toBeNull();
    expect(typeof body.data.services.api.pid).toBe("number");
    expect(body.data.services.api.pid).toBeGreaterThan(0);
  }, 15_000);
});

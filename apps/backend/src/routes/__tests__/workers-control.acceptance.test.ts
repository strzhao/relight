import type { ChildProcess } from "node:child_process";
/**
 * 验收测试：POST /api/runtime/workers/{start,stop,reload}
 *
 * ⚠️ 安全前提：本测试假设项目以 TCP 模式监听。若未来改 UNIX socket / cluster IPC，
 *   c.env.incoming.socket.remoteAddress 为 undefined 会被误判为 localhost。
 *   改 listen mode 必须同步审查 002 middleware + 本测试。
 *
 * 红队铁律：不读取 routes/workers-control.ts 实现，仅依据设计契约写测试
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =====================================================================
// spawn mock — 必须在所有 import 之前 hoist（vi.mock 自动 hoist）
// =====================================================================

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...(args as Parameters<typeof spawnMock>)),
  execFile: vi.fn((..._args: unknown[]) => {
    const last = _args[_args.length - 1];
    if (typeof last === "function") (last as (e: unknown, ...r: unknown[]) => void)(null, "", "");
  }),
  exec: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawnSync: vi.fn(),
  fork: vi.fn(),
}));

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
// 辅助：构建 spawn mock implementation
//
// ⚠️ Timing 修复（2026-05-17）：emit 必须在 spawn 真实被调用 + 蓝队 handler
// 同步注册 listener **之后** 才触发。原 queueMicrotask/setImmediate 在
// makeMockChild 同步调用时就入 task queue，导致测试体首个 await 时这些任务
// 抢先在 spawn handler 注册 listener 之前 fire → handler 永远等不到 close →
// timeout（patterns.md [2026-05-15] 类 fixture bug）。
//
// 修正：直接给 spawnMock 设 mockImplementation —— 只在 spawn 真实调用瞬间
// 创建 child + schedule emit。蓝队 handler 同步注册 listener 后，setImmediate
// 才在下一个 tick fire emit，listener 已就位。
// =====================================================================

function setupSpawnMock(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errorEvent?: { code: string; message: string };
}): void {
  const { stdout = "", stderr = "", exitCode = 0, errorEvent } = opts;
  spawnMock.mockImplementation(() => {
    const child = new MockChild();
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      if (errorEvent) {
        const err = Object.assign(new Error(errorEvent.message), {
          code: errorEvent.code,
        });
        child.emit("error", err);
      } else {
        child.emit("close", exitCode);
      }
    });
    return child as unknown as ChildProcess;
  });
}

// =====================================================================
// 辅助：获取 app 实例（每次重新 import 避免模块缓存问题）
// =====================================================================

async function getApp() {
  const { createApp } = await import("../../app");
  return createApp();
}

// =====================================================================
// Case A — POST /start spawn 成功（exitCode=0）
// =====================================================================

describe("case A — POST /api/runtime/workers/start spawn 成功", () => {
  beforeEach(() => {
    setupSpawnMock({ stdout: "ok", exitCode: 0 });
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  it("HTTP 200 + body { success:true, stdout:'ok', stderr:'', exitCode:0 }", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/start", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toBe("ok");
    expect(body.stderr).toBe("");
  }, 10_000);

  it("spawn 第 1 参为 'pnpm'，第 2 参[0] 为 'workers:start'", async () => {
    const app = await getApp();
    await app.request("/api/runtime/workers/start", { method: "POST" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("pnpm");
    expect(Array.isArray(args)).toBe(true);
    expect(args[0]).toBe("workers:start");
  }, 10_000);

  it("spawn 第 3 参 cwd 为非空绝对路径", async () => {
    const app = await getApp();
    await app.request("/api/runtime/workers/start", { method: "POST" });
    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { cwd?: string }];
    expect(opts).toBeDefined();
    expect(typeof opts.cwd).toBe("string");
    expect((opts.cwd as string).length).toBeGreaterThan(0);
    // 绝对路径以 / 开头（POSIX）
    expect(opts.cwd).toMatch(/^\//);
  }, 10_000);
});

// =====================================================================
// Case B — POST /stop spawn 成功
// =====================================================================

describe("case B — POST /api/runtime/workers/stop spawn 成功", () => {
  beforeEach(() => {
    setupSpawnMock({ stdout: "stopped", exitCode: 0 });
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  it("HTTP 200 + body { success:true, exitCode:0 }", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/stop", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.exitCode).toBe(0);
  }, 10_000);

  it("spawn 第 2 参[0] 为 'workers:stop'", async () => {
    const app = await getApp();
    await app.request("/api/runtime/workers/stop", { method: "POST" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("pnpm");
    expect(args[0]).toBe("workers:stop");
  }, 10_000);
});

// =====================================================================
// Case C — POST /reload spawn 成功
// =====================================================================

describe("case C — POST /api/runtime/workers/reload spawn 成功", () => {
  beforeEach(() => {
    setupSpawnMock({ stdout: "reloaded", exitCode: 0 });
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  it("HTTP 200 + body { success:true, exitCode:0 }", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/reload", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.exitCode).toBe(0);
  }, 10_000);

  it("spawn 第 2 参[0] 为 'workers:reload'", async () => {
    const app = await getApp();
    await app.request("/api/runtime/workers/reload", { method: "POST" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe("pnpm");
    expect(args[0]).toBe("workers:reload");
  }, 10_000);
});

// =====================================================================
// Case D — spawn 失败（exitCode=1）
// =====================================================================

describe("case D — spawn 失败（exitCode=1）", () => {
  beforeEach(() => {
    setupSpawnMock({ stderr: "boom", exitCode: 1 });
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  it("HTTP 500 + body { success:false, exitCode:1, stderr:'boom' }", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/start", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.exitCode).toBe(1);
    expect(body.stderr).toBe("boom");
  }, 10_000);
});

// =====================================================================
// Case E — spawn error event (ENOENT)
// =====================================================================

describe("case E — spawn error event (ENOENT)", () => {
  beforeEach(() => {
    setupSpawnMock({
      errorEvent: { code: "ENOENT", message: "pnpm not found" },
    });
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  it("HTTP 500 + body { success:false, exitCode:-1 }，stderr 含 'pnpm not found' 或 ENOENT 关键字", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/start", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.exitCode).toBe(-1);
    // stderr 应包含错误信息关键字
    const stderrText: string = body.stderr ?? "";
    const hasKeyword =
      stderrText.includes("pnpm not found") ||
      stderrText.includes("ENOENT") ||
      stderrText.includes("not found");
    expect(hasKeyword).toBe(true);
  }, 10_000);
});

// =====================================================================
// Case F — 非 localhost POST /start → 403（继承 002 middleware）
// =====================================================================

describe("case F — 非 localhost POST /start → 403", () => {
  beforeEach(() => {
    // spawn 不应被调用；即使设置了也不会触发
    setupSpawnMock({ stdout: "should-not-run", exitCode: 0 });
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  it("HTTP 403 + body { success:false, error:'forbidden', message:'仅本机访问' }", async () => {
    const app = await getApp();
    const res = await app.request(
      "/api/runtime/workers/start",
      { method: "POST" },
      { incoming: { socket: { remoteAddress: "192.168.1.5" } } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("forbidden");
    expect(body.message).toBe("仅本机访问");
  }, 10_000);

  it("middleware 在前，spawn 绝对不被调用", async () => {
    const app = await getApp();
    await app.request(
      "/api/runtime/workers/start",
      { method: "POST" },
      { incoming: { socket: { remoteAddress: "192.168.1.5" } } },
    );
    expect(spawnMock).not.toHaveBeenCalled();
  }, 10_000);
});

// =====================================================================
// Case G — XFF 伪造 + 非 localhost POST → 仍 403
// =====================================================================

describe("case G — XFF 伪造 (X-Forwarded-For: 127.0.0.1) + 非 localhost → 仍 403", () => {
  beforeEach(() => {
    setupSpawnMock({ stdout: "should-not-run", exitCode: 0 });
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  it("即使带 XFF: 127.0.0.1，非 localhost socket 仍返回 403", async () => {
    const app = await getApp();
    const res = await app.request(
      "/api/runtime/workers/start",
      {
        method: "POST",
        headers: { "X-Forwarded-For": "127.0.0.1" },
      },
      { incoming: { socket: { remoteAddress: "192.168.1.5" } } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("forbidden");
  }, 10_000);

  it("XFF 伪造场景下，spawn 绝对不被调用", async () => {
    const app = await getApp();
    await app.request(
      "/api/runtime/workers/start",
      {
        method: "POST",
        headers: { "X-Forwarded-For": "127.0.0.1" },
      },
      { incoming: { socket: { remoteAddress: "192.168.1.5" } } },
    );
    expect(spawnMock).not.toHaveBeenCalled();
  }, 10_000);
});

// =====================================================================
// Case H — 来自 localhost socket POST → middleware 放行
// =====================================================================

describe("case H — localhost socket POST → middleware 放行，spawn 被调用", () => {
  beforeEach(() => {
    setupSpawnMock({ stdout: "ok", exitCode: 0 });
  });

  afterEach(() => {
    spawnMock.mockReset();
  });

  it("remoteAddress=127.0.0.1 → HTTP 200（middleware 不拦截）", async () => {
    const app = await getApp();
    const res = await app.request(
      "/api/runtime/workers/start",
      { method: "POST" },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    expect(res.status).toBe(200);
  }, 10_000);

  it("localhost 场景下 spawn 被调用一次", async () => {
    const app = await getApp();
    await app.request(
      "/api/runtime/workers/start",
      { method: "POST" },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  }, 10_000);
});

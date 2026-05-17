/**
 * 验收测试：GET /api/runtime/workers/logs —— PM2 日志读取契约
 *
 * ⚠️ 安全前提（TCP 模式）：本测试假设项目以 TCP 模式监听。若未来改用 UNIX socket
 *   / cluster IPC，c.env.incoming.socket.remoteAddress 为 undefined 会被
 *   中间件误判为 localhost，导致日志内容对外泄露。改变 listen mode 时必须同步
 *   审查 002 middleware + 本测试。
 *
 * 契约来源：任务 004 设计文档「Backend HTTP API」+「workers-logs 行为」
 *
 * 验收标准：
 * A. 默认 200 lines — lines=200 时返回 stdout/stderr 末 200 行
 * B. lines 参数 clamp ≤1000 — ?lines=5000 → 末 1000 行
 * C. lines 参数 clamp ≥1   — ?lines=0 → 末 1 行（非空文件时返回内容）
 * D. 文件不存在 ENOENT fallback — 返回空数组，不报 500
 * E. 非 localhost GET 仍 200 + 完整 body（GET 端点不脱敏，保留可观测性）
 *
 * 红队铁律：不读取 routes/workers-logs.ts 实现，仅依据设计契约写测试
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =====================================================================
// readline + fs mock（必须在所有 import 之前 hoist，vi.mock 自动 hoist）
//
// 模式：只 mock readline.createInterface（不依赖 fs.createReadStream 内容），
// fs.createReadStream 返回带 _mockPath 标记的哑对象供 readline mock 识别路径。
// readline.createInterface 根据路径从模块级变量 mockOutLines/mockErrLines 取行。
//
// 这要求蓝队代码形如：
//   createInterface({ input: createReadStream(filePath), ... })
// 符合设计 §1 约定。
// =====================================================================

let mockOutLines: string[] | null = [];
let mockErrLines: string[] | null = [];

vi.mock("node:readline", () => ({
  createInterface: (opts: { input: { _mockPath?: string } }) => {
    const filePath = opts?.input?._mockPath ?? "";
    let lines: string[] | null = null;
    if (filePath.includes("out.log")) {
      lines = mockOutLines;
    } else if (filePath.includes("error.log")) {
      lines = mockErrLines;
    }

    if (lines === null) {
      // 模拟 ENOENT：返回 async iterable，在第一次迭代时 throw
      const err = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.reject(err);
            },
          };
        },
      };
    }

    const captured = lines; // 避免闭包读到后续变更
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const line of captured) {
          yield line;
        }
      },
    };
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  // 保留 node:fs 所有原始导出（readFileSync 等被其他路由使用），
  // 仅 override createReadStream 以注入 _mockPath 标记
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    createReadStream: (filePath: string) => {
      // 不实际读文件；只把路径注入为 _mockPath，让 readline mock 识别
      return { _mockPath: filePath } as unknown as NodeJS.ReadableStream;
    },
  };
});

// =====================================================================
// DB / Queue Mocks（需要 createApp 能跑起来）
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
// 辅助
// =====================================================================

/** 生成 N 行有序字符串数组 */
function makeLines(n: number, prefix = "line"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);
}

async function getApp() {
  const { createApp } = await import("../../app");
  return createApp();
}

// =====================================================================
// Case A — 默认 200 lines，两文件 stdout/stderr 各 clamp 到 200
// =====================================================================

describe("case A — 默认 lines=200：末 200 行", () => {
  beforeEach(() => {
    // stdout 1500 行，stderr 500 行；lines=200 clamp → 各取末 200
    mockOutLines = makeLines(1500, "out");
    mockErrLines = makeLines(500, "err");
  });

  afterEach(() => {
    mockOutLines = [];
    mockErrLines = [];
  });

  it("HTTP 200 + success=true + data.stdout/stderr 各为 200 行", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data.stdout)).toBe(true);
    expect(Array.isArray(body.data.stderr)).toBe(true);
    expect(body.data.stdout).toHaveLength(200);
    expect(body.data.stderr).toHaveLength(200);
  }, 10_000);

  it("stdout 末行是原始 1500 行的最后一行", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs");
    const body = await res.json();
    const lastStdout = body.data.stdout[body.data.stdout.length - 1];
    expect(lastStdout).toBe("out-1500");
  }, 10_000);

  it("stdout 首行是原始 1500 行的第 1301 行（末 200 行的起点）", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs");
    const body = await res.json();
    expect(body.data.stdout[0]).toBe("out-1301");
  }, 10_000);
});

// =====================================================================
// Case B — lines=5000 clamp 到 1000
// =====================================================================

describe("case B — ?lines=5000 clamp 到上限 1000", () => {
  beforeEach(() => {
    // 2000 行 stdout，期望只取末 1000
    mockOutLines = makeLines(2000, "out");
    mockErrLines = makeLines(2000, "err");
  });

  afterEach(() => {
    mockOutLines = [];
    mockErrLines = [];
  });

  it("HTTP 200 + stdout/stderr 各不超过 1000 行", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs?lines=5000");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.stdout.length).toBeLessThanOrEqual(1000);
    expect(body.data.stderr.length).toBeLessThanOrEqual(1000);
  }, 10_000);

  it("lines=5000 clamp 后 stdout 末行是 out-2000", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs?lines=5000");
    const body = await res.json();
    const last = body.data.stdout[body.data.stdout.length - 1];
    expect(last).toBe("out-2000");
  }, 10_000);

  it("lines=1000 精确 → stdout 刚好 1000 行", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs?lines=1000");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.stdout).toHaveLength(1000);
  }, 10_000);
});

// =====================================================================
// Case C — lines=0 / 负数 clamp 到下限 1
// =====================================================================

describe("case C — ?lines=0 / 负数 clamp 到下限 1", () => {
  beforeEach(() => {
    mockOutLines = makeLines(50, "out");
    mockErrLines = makeLines(50, "err");
  });

  afterEach(() => {
    mockOutLines = [];
    mockErrLines = [];
  });

  it("?lines=0 → HTTP 200 + stdout/stderr 各 1 行（末 1 行）", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs?lines=0");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // clamp 到 1 → 末 1 行
    expect(body.data.stdout).toHaveLength(1);
    expect(body.data.stdout[0]).toBe("out-50");
  }, 10_000);

  it("?lines=-100 → HTTP 200 + stdout 1 行", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs?lines=-100");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.stdout).toHaveLength(1);
  }, 10_000);
});

// =====================================================================
// Case D — 文件不存在（ENOENT）fallback → 空数组，不 500
// =====================================================================

describe("case D — 文件不存在 ENOENT fallback → 空数组", () => {
  beforeEach(() => {
    // null 表示模拟 ENOENT
    mockOutLines = null;
    mockErrLines = null;
  });

  afterEach(() => {
    mockOutLines = [];
    mockErrLines = [];
  });

  it("HTTP 200 + success=true + stdout=[] + stderr=[]", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.stdout).toEqual([]);
    expect(body.data.stderr).toEqual([]);
  }, 10_000);

  it("ENOENT 时不返回 500", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs");
    expect(res.status).not.toBe(500);
  }, 10_000);
});

// =====================================================================
// Case E — 非 localhost GET → 仍 200 + 完整 body（logs 不脱敏）
//
// 设计契约：GET /api/runtime/workers/logs 保留可观测性，
// isLocalhost=false 时不脱敏字段，仍返回完整 stdout/stderr。
// =====================================================================

describe("case E — 非 localhost GET /api/runtime/workers/logs → 200 + 完整 body", () => {
  beforeEach(() => {
    mockOutLines = ["hello from stdout"];
    mockErrLines = ["hello from stderr"];
  });

  afterEach(() => {
    mockOutLines = [];
    mockErrLines = [];
  });

  it("socket=192.168.1.5 → HTTP 200（不被 localhostOnly 拦截）", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs", undefined, {
      incoming: { socket: { remoteAddress: "192.168.1.5" } },
    });
    expect(res.status).toBe(200);
  }, 10_000);

  it("非 localhost GET → success=true + stdout/stderr 非空（不脱敏）", async () => {
    const app = await getApp();
    const res = await app.request("/api/runtime/workers/logs", undefined, {
      incoming: { socket: { remoteAddress: "192.168.1.5" } },
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data.stdout)).toBe(true);
    expect(Array.isArray(body.data.stderr)).toBe(true);
    // 完整 body：stdout 包含内容（未脱敏）
    expect(body.data.stdout).toContain("hello from stdout");
    expect(body.data.stderr).toContain("hello from stderr");
  }, 10_000);

  it("XFF 伪造 + 非 localhost → 仍 200（GET 端点中间件不拦截）", async () => {
    const app = await getApp();
    const res = await app.request(
      "/api/runtime/workers/logs",
      { headers: { "X-Forwarded-For": "127.0.0.1" } },
      { incoming: { socket: { remoteAddress: "10.0.0.5" } } },
    );
    expect(res.status).toBe(200);
  }, 10_000);
});

/**
 * 验收测试：GET /api/runtime/config —— 运行时配置读取契约
 *
 * ⚠️ 安全前提（TCP 模式）：本测试假设项目以 TCP 模式监听。若未来改用 UNIX socket
 *   / cluster IPC，c.env.incoming.socket.remoteAddress 为 undefined 会被
 *   中间件误判为 localhost，导致 aiApiKey 等敏感配置泄露。改变 listen mode 时
 *   必须同步审查 002 middleware + 本测试。
 *
 * 契约来源：任务 004 设计文档「Backend HTTP API」+「runtime-config 行为」+「aiApiKey 掩码契约」
 *
 * 验收标准：
 * F. 完整 7 字段 + aiApiKey 掩码（长 key → prefix****suffix）
 * G. 短 key（≤8 chars）掩码 → "****"
 * H. 空 key 掩码 → ""
 * I. 字段路径扁平化：嵌套 config.ai.* 输出为扁平 aiBaseUrl/aiModel/aiVisionModel
 * J. 非 localhost GET 仍 200 + 完整 7 字段（GET 端点不脱敏，保留可观测性）
 *
 * aiApiKey 掩码规则（精确）：
 *   ""                  → ""
 *   len ≤ 8             → "****"
 *   len > 8             → key.slice(0,3) + "****" + key.slice(-4)
 *
 * 红队铁律：不读取 routes/runtime-config.ts 实现，仅依据设计契约写测试
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =====================================================================
// config mock（必须在 createApp 之前 hoist）
//
// 使用可变对象，各 case 在 beforeEach 中覆写字段。
// =====================================================================

const mockConfig = {
  port: 3000,
  databasePath: "/mock/db/relight.db",
  redisUrl: "redis://localhost:6379",
  storageRoot: "/mock/photos",
  bullmqPrefix: "bull",
  ai: {
    baseUrl: "http://127.0.0.1:8001/v1",
    apiKey: "default-mock-key-1234",
    model: "qwen3.6-35b",
    visionModel: "qwen3.6-35b",
    promptVersion: "v2",
  },
  // 其余字段省略，蓝队只读 7 个目标字段
  repoRoot: "/mock/repo",
  dailySelectionConcurrency: 2,
  video: {
    enabled: true,
    frameCount: 6,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
  },
  whisper: {
    enabled: false,
    python: "/usr/bin/python3",
    script: "/mock/transcribe.py",
    engine: "mlx",
    model: "large-v3-turbo",
    language: "auto",
  },
  face: {
    displayThreshold: 5,
    clusteringThreshold: 0.55,
    clusteringMergeThreshold: 0.85,
    clusteringMinThreshold: 0.55,
    midZoneAttrFilter: true,
    medQualityCentroidWeight: 0.5,
    qualityHighBboxSize: 200,
    qualityHighDetectionScore: 0.8,
    qualityLowDetectionScore: 0.65,
    attributeAnalysisEnabled: true,
    attributeRetries: 1,
    detectionThreshold: 0.5,
    minFaceSize: 80,
    prototypeTightMerge: 0.88,
    prototypeCoarseFilter: 0.55,
    prototypeMaxPerPerson: 5,
    prototypeKmeansMaxIters: 20,
  },
} as {
  port: number;
  databasePath: string;
  redisUrl: string;
  storageRoot: string;
  bullmqPrefix: string;
  ai: {
    baseUrl: string;
    apiKey: string;
    model: string;
    visionModel: string;
    promptVersion: string;
  };
  repoRoot: string;
  dailySelectionConcurrency: number;
  video: object;
  whisper: object;
  face: object;
};

vi.mock("../../lib/config", () => ({
  get config() {
    return mockConfig;
  },
}));

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

async function getApp() {
  const { createApp } = await import("../../app");
  return createApp();
}

async function fetchConfig(opts?: {
  socket?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = await getApp();
  const init = opts?.headers ? { headers: opts.headers } : undefined;
  const env = opts?.socket ? { incoming: { socket: { remoteAddress: opts.socket } } } : undefined;
  const res = await app.request("/api/runtime/config", init, env);
  const body = await res.json();
  return { status: res.status, body };
}

// =====================================================================
// Case F — 完整 7 字段 + aiApiKey 掩码（长 key）
//
// 7 个预期字段（扁平化）：
//   port, databasePath, redisUrl, storageRoot, aiBaseUrl, aiModel, aiVisionModel
//   + aiApiKey（掩码后）
// 实际上设计契约说"7 个字段"，aiApiKey 是其中一个（掩码输出），共 7 个字段。
// =====================================================================

describe("case F — 完整 7 字段 + 长 key（>8 chars）掩码", () => {
  beforeEach(() => {
    mockConfig.port = 3000;
    mockConfig.databasePath = "/data/relight.db";
    mockConfig.redisUrl = "redis://localhost:6379";
    mockConfig.storageRoot = "/my/photos";
    mockConfig.ai = {
      baseUrl: "http://ai.local:8001/v1",
      apiKey: "sk-1234567890abcdef",
      model: "qwen3-35b",
      visionModel: "qwen3-vl",
      promptVersion: "v2",
    };
  });

  it("HTTP 200 + success=true", async () => {
    const { status, body } = await fetchConfig();
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  }, 10_000);

  it("aiApiKey 掩码为 sk-****cdef（契约精确值）", async () => {
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    // "sk-1234567890abcdef" (19 chars) → slice(0,3)="sk-", slice(-4)="cdef"
    expect(data.aiApiKey).toBe("sk-****cdef");
  }, 10_000);

  it("aiBaseUrl 字段扁平化且值正确", async () => {
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    expect(data.aiBaseUrl).toBe("http://ai.local:8001/v1");
  }, 10_000);

  it("aiModel / aiVisionModel 字段扁平化且值正确", async () => {
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    expect(data.aiModel).toBe("qwen3-35b");
    expect(data.aiVisionModel).toBe("qwen3-vl");
  }, 10_000);

  it("databasePath / redisUrl / storageRoot 字段原值返回", async () => {
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    // 设计契约核心 3 个路径字段必须原值返回
    expect(data.databasePath).toBe("/data/relight.db");
    expect(data.redisUrl).toBe("redis://localhost:6379");
    expect(data.storageRoot).toBe("/my/photos");
    // port 若输出则应为正整数（设计文档未强制要求此字段）
    if (data.port !== undefined) {
      expect(typeof data.port).toBe("number");
      expect(data.port as number).toBeGreaterThan(0);
    }
  }, 10_000);
});

// =====================================================================
// Case G — 短 key（≤8 chars）掩码 → "****"
// =====================================================================

describe("case G — 短 key（≤8 chars）掩码 → '****'", () => {
  afterEach(() => {
    // 恢复默认
    mockConfig.ai.apiKey = "default-mock-key-1234";
  });

  it("'sk-abc'（7 chars）→ '****'", async () => {
    mockConfig.ai.apiKey = "sk-abc";
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    expect(data.aiApiKey).toBe("****");
  }, 10_000);

  it("恰好 8 chars key → '****'（边界：len=8 仍走短路径）", async () => {
    mockConfig.ai.apiKey = "sk-12345"; // 8 chars
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    expect(data.aiApiKey).toBe("****");
  }, 10_000);

  it("9 chars key → 走长路径（prefix****suffix 形式，非 '****'）", async () => {
    mockConfig.ai.apiKey = "sk-123456"; // 9 chars → len>8 → 长路径
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    // slice(0,3)="sk-", slice(-4)="3456" → "sk-****3456"
    expect(data.aiApiKey).toBe("sk-****3456");
    expect(data.aiApiKey).not.toBe("****");
  }, 10_000);
});

// =====================================================================
// Case H — 空 key 掩码 → ""
// =====================================================================

describe("case H — 空 key 掩码 → ''", () => {
  afterEach(() => {
    mockConfig.ai.apiKey = "default-mock-key-1234";
  });

  it("apiKey='' → aiApiKey=''", async () => {
    mockConfig.ai.apiKey = "";
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    expect(data.aiApiKey).toBe("");
  }, 10_000);
});

// =====================================================================
// Case I — 字段路径正确（嵌套 config.ai.* 扁平化输出）
// =====================================================================

describe("case I — config.ai 嵌套字段扁平化到响应顶层", () => {
  beforeEach(() => {
    mockConfig.ai = {
      baseUrl: "http://test-server:9000/v1",
      apiKey: "test-key-1234567890",
      model: "test-model",
      visionModel: "test-vl-model",
      promptVersion: "v1",
    };
  });

  afterEach(() => {
    mockConfig.ai = {
      baseUrl: "http://127.0.0.1:8001/v1",
      apiKey: "default-mock-key-1234",
      model: "qwen3.6-35b",
      visionModel: "qwen3.6-35b",
      promptVersion: "v2",
    };
  });

  it("aiBaseUrl === 'http://test-server:9000/v1'（源自 config.ai.baseUrl）", async () => {
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    expect(data.aiBaseUrl).toBe("http://test-server:9000/v1");
  }, 10_000);

  it("aiModel === 'test-model'（源自 config.ai.model）", async () => {
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    expect(data.aiModel).toBe("test-model");
  }, 10_000);

  it("aiVisionModel === 'test-vl-model'（源自 config.ai.visionModel）", async () => {
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    expect(data.aiVisionModel).toBe("test-vl-model");
  }, 10_000);

  it("响应 data 中不含嵌套 ai 对象（已扁平化）", async () => {
    const { body } = await fetchConfig();
    const data = body.data as Record<string, unknown>;
    // 蓝队应输出扁平字段，不应有 data.ai.* 嵌套
    // 允许 data.ai 不存在，或若存在则不是带 baseUrl/model 等字段的对象
    if (data.ai !== undefined) {
      const ai = data.ai as Record<string, unknown>;
      // 如果蓝队错误地保留了嵌套结构，此断言会捕获
      expect(ai.baseUrl).toBeUndefined();
    }
  }, 10_000);
});

// =====================================================================
// Case J — 非 localhost GET → 仍 200 + 完整 7 字段（不脱敏 storageRoot 等）
//
// 设计契约：GET /api/runtime/config 保留可观测性，
// isLocalhost=false 时不额外脱敏（aiApiKey 本身已掩码，storageRoot 等原值）。
// =====================================================================

describe("case J — 非 localhost GET /api/runtime/config → 200 + 完整 body", () => {
  beforeEach(() => {
    mockConfig.storageRoot = "/sensitive/photo/path";
    mockConfig.ai.apiKey = "sk-abcdefgh1234";
  });

  afterEach(() => {
    mockConfig.storageRoot = "/mock/photos";
    mockConfig.ai.apiKey = "default-mock-key-1234";
  });

  it("socket=192.168.1.5 → HTTP 200（GET 端点中间件不拦截）", async () => {
    const { status } = await fetchConfig({ socket: "192.168.1.5" });
    expect(status).toBe(200);
  }, 10_000);

  it("非 localhost → success=true + data 非空", async () => {
    const { body } = await fetchConfig({ socket: "192.168.1.5" });
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  }, 10_000);

  it("非 localhost → storageRoot 原值返回（不额外脱敏）", async () => {
    const { body } = await fetchConfig({ socket: "192.168.1.5" });
    const data = body.data as Record<string, unknown>;
    expect(data.storageRoot).toBe("/sensitive/photo/path");
  }, 10_000);

  it("非 localhost → aiApiKey 掩码规则仍生效（已掩码，不是原始 key）", async () => {
    const { body } = await fetchConfig({ socket: "192.168.1.5" });
    const data = body.data as Record<string, unknown>;
    // "sk-abcdefgh1234" (14 chars) → "sk-****1234"
    expect(data.aiApiKey).toBe("sk-****1234");
    expect(data.aiApiKey).not.toBe("sk-abcdefgh1234");
  }, 10_000);

  it("XFF 伪造 + 非 localhost socket → 仍 200（GET 端点中间件不拦截）", async () => {
    const { status } = await fetchConfig({
      socket: "10.0.0.5",
      headers: { "X-Forwarded-For": "127.0.0.1" },
    });
    expect(status).toBe(200);
  }, 10_000);
});

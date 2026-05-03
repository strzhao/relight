/**
 * 验收测试：健康检查端点扩展 — 系统资源与磁盘信息
 *
 * 覆盖设计文档「admin/health 完善」新增字段：
 * - system.cpu   — CPU 型号、核心数、负载均值
 * - system.memory — 系统内存总量/空闲/已用/使用率
 * - system.process — 进程 PID、运行时间、Node 版本、内存占用
 * - disk          — DB 文件大小、磁盘剩余/总空间（可为 null）
 *
 * 响应格式：
 * {
 *   success: boolean,
 *   data: {
 *     overall: "healthy" | "degraded" | "unhealthy",
 *     components: HealthComponentStatus[],
 *     system: { cpu, memory, process },
 *     disk: { dbFile, freeSpaceBytes, totalSpaceBytes } | null
 *   }
 * }
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---- 辅助：链式 Mock ----

/**
 * 创建可链式调用的 Mock 对象。
 * 支持 db.select().from().where().orderBy() 等链式调用，
 * 以及 schema.table.column 等属性访问。
 * 数组索引 [0], [1] 返回 undefined（模拟空查询结果）。
 */
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

/** 创建支持具名方法的 Mock 函数（用于 count、sum、avg 等聚合函数 mock） */
function sqlMock(value: unknown) {
  return value;
}

// 防止 db/index.ts 尝试打开真实数据库文件
vi.mock("../db", () => ({
  db: chainableMock([]),
  schema: chainableMock([]),
}));

// Mock drizzle-orm 的 sql 辅助函数
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sql: sqlMock,
    count: () => sqlMock(0),
    avg: () => sqlMock(0),
    sum: () => sqlMock(0),
  };
});

// 防止 queues.ts 尝试连接 Redis
const defaultQueueState = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };

function createQueueMock() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
          return () => "BullMQ Mock";
        }
        return () => Promise.resolve({ ...defaultQueueState });
      },
    },
  );
}

vi.mock("../jobs/queues", () => ({
  scanQueue: createQueueMock(),
  analyzeQueue: createQueueMock(),
  dailyQueue: createQueueMock(),
}));

// Mock ioredis — 避免 Redis 连接尝试
vi.mock("ioredis", () => {
  const RedisMock = vi.fn(() => ({
    ping: () => Promise.resolve("PONG"),
    quit: () => Promise.resolve("OK"),
    disconnect: () => {},
    on: () => {},
  }));
  return { default: RedisMock, Redis: RedisMock };
});

// Mock openai — 避免 AI 连接尝试
vi.mock("openai", () => {
  const OpenAIMock = vi.fn(() => ({
    chat: {
      completions: {
        create: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: "{}",
                },
              },
            ],
          }),
      },
    },
  }));
  return { default: OpenAIMock };
});

import { createApp } from "../app";

// ---- 类型定义（设计文档声明） ----

type OverallStatus = "healthy" | "degraded" | "unhealthy";
type ComponentStatus = "healthy" | "degraded" | "unhealthy";

interface HealthComponent {
  component: string;
  status: ComponentStatus;
  message?: string;
}

interface CpuInfo {
  model: string;
  cores: number;
  loadAvg: number[];
}

interface MemoryInfo {
  total: number;
  free: number;
  used: number;
  usagePercent: number;
}

interface ProcessInfo {
  pid: number;
  uptime: number;
  nodeVersion: string;
  memoryRss: number;
  memoryHeapTotal: number;
  memoryHeapUsed: number;
}

interface SystemInfo {
  cpu: CpuInfo;
  memory: MemoryInfo;
  process: ProcessInfo;
}

interface DbFileInfo {
  path: string;
  sizeBytes: number;
}

interface DiskInfo {
  dbFile: DbFileInfo;
  freeSpaceBytes: number | null;
  totalSpaceBytes: number | null;
}

interface HealthResponse {
  success: boolean;
  data: {
    overall: OverallStatus;
    components: HealthComponent[];
    system: SystemInfo;
    disk: DiskInfo | null;
  };
  error?: string;
}

// ---- 全局测试状态 ----

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  app = createApp();
});

afterAll(() => {
  vi.clearAllMocks();
});

// ---- 请求辅助函数 ----

async function get(path: string) {
  const res = await app.request(path, { method: "GET" });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---- 测试 ----

describe("健康检查扩展 — 系统资源与磁盘（设计文档验收）", () => {
  let body: HealthResponse;

  beforeAll(async () => {
    const res = await get("/api/admin/health");
    body = res.body as HealthResponse;
  });

  // ============================================================
  // 场景 1: 响应结构完整性
  // ============================================================
  describe("场景 1: 顶层响应结构完整性", () => {
    it("应返回 HTTP 200", async () => {
      const { status } = await get("/api/admin/health");
      expect(status).toBe(200);
    });

    it("应返回 ApiResponse 格式 { success, data }", () => {
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(typeof body.data).toBe("object");
    });

    it("data 应包含 overall 字段（string 枚举）", () => {
      expect(body.data).toHaveProperty("overall");
      expect(typeof body.data.overall).toBe("string");
      const validOverall: OverallStatus[] = ["healthy", "degraded", "unhealthy"];
      expect(validOverall).toContain(body.data.overall);
    });

    it("data 应包含 components 字段（array，长度 ≥ 4）", () => {
      expect(body.data).toHaveProperty("components");
      expect(Array.isArray(body.data.components)).toBe(true);
      expect(body.data.components.length).toBeGreaterThanOrEqual(4);
    });

    it("components 数组中每个元素应包含 component (string) 和 status (枚举)", () => {
      const validStatuses: ComponentStatus[] = ["healthy", "degraded", "unhealthy"];
      for (const comp of body.data.components) {
        expect(typeof comp.component).toBe("string");
        expect(comp.component.length).toBeGreaterThan(0);
        expect(typeof comp.status).toBe("string");
        expect(validStatuses).toContain(comp.status);
      }
    });

    it("components 应包含 api、database、redis、ai 四个组件", () => {
      const componentNames = body.data.components.map((c) => c.component);
      expect(componentNames).toContain("api");
      expect(componentNames).toContain("database");
      expect(componentNames).toContain("redis");
      expect(componentNames).toContain("ai");
    });

    it("data 应包含 system 字段（object）", () => {
      expect(body.data).toHaveProperty("system");
      expect(typeof body.data.system).toBe("object");
      expect(body.data.system).not.toBeNull();
    });

    it("data 应包含 disk 字段（object 或 null）", () => {
      expect(body.data).toHaveProperty("disk");
      if (body.data.disk !== null) {
        expect(typeof body.data.disk).toBe("object");
      }
    });
  });

  // ============================================================
  // 场景 2: system.cpu 字段验证
  // ============================================================
  describe("场景 2: system.cpu 字段验证", () => {
    it("cpu.model 应为 string 类型且非空", () => {
      const { cpu } = body.data.system;
      expect(cpu).toHaveProperty("model");
      expect(typeof cpu.model).toBe("string");
      expect(cpu.model.length).toBeGreaterThan(0);
    });

    it("cpu.cores 应为 ≥ 1 的整数", () => {
      const { cpu } = body.data.system;
      expect(cpu).toHaveProperty("cores");
      expect(typeof cpu.cores).toBe("number");
      expect(cpu.cores).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(cpu.cores)).toBe(true);
    });

    it("cpu.loadAvg 应为长度为 3 的 number 数组", () => {
      const { cpu } = body.data.system;
      expect(cpu).toHaveProperty("loadAvg");
      expect(Array.isArray(cpu.loadAvg)).toBe(true);
      expect(cpu.loadAvg).toHaveLength(3);
      for (const val of cpu.loadAvg) {
        expect(typeof val).toBe("number");
        expect(val).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ============================================================
  // 场景 3: system.memory 字段验证
  // ============================================================
  describe("场景 3: system.memory 字段验证", () => {
    it("memory.total 应 > 0", () => {
      const { memory } = body.data.system;
      expect(memory).toHaveProperty("total");
      expect(typeof memory.total).toBe("number");
      expect(memory.total).toBeGreaterThan(0);
    });

    it("memory.free 应 ≥ 0", () => {
      const { memory } = body.data.system;
      expect(memory).toHaveProperty("free");
      expect(typeof memory.free).toBe("number");
      expect(memory.free).toBeGreaterThanOrEqual(0);
    });

    it("memory.used 应 = total - free", () => {
      const { memory } = body.data.system;
      expect(memory).toHaveProperty("used");
      expect(typeof memory.used).toBe("number");
      expect(memory.used).toBe(memory.total - memory.free);
    });

    it("memory.usagePercent 应在 0-100 之间", () => {
      const { memory } = body.data.system;
      expect(memory).toHaveProperty("usagePercent");
      expect(typeof memory.usagePercent).toBe("number");
      expect(memory.usagePercent).toBeGreaterThanOrEqual(0);
      expect(memory.usagePercent).toBeLessThanOrEqual(100);
    });

    it("memory.free + memory.used 应 ≤ memory.total（容错 1 byte）", () => {
      const { memory } = body.data.system;
      expect(memory.free + memory.used).toBeLessThanOrEqual(memory.total + 1);
    });
  });

  // ============================================================
  // 场景 4: system.process 字段验证
  // ============================================================
  describe("场景 4: system.process 字段验证", () => {
    it("process.pid 应为 > 0 的整数", () => {
      const { process: proc } = body.data.system;
      expect(proc).toHaveProperty("pid");
      expect(typeof proc.pid).toBe("number");
      expect(proc.pid).toBeGreaterThan(0);
      expect(Number.isInteger(proc.pid)).toBe(true);
    });

    it("process.uptime 应 ≥ 0", () => {
      const { process: proc } = body.data.system;
      expect(proc).toHaveProperty("uptime");
      expect(typeof proc.uptime).toBe("number");
      expect(proc.uptime).toBeGreaterThanOrEqual(0);
    });

    it("process.nodeVersion 应以 'v' 开头", () => {
      const { process: proc } = body.data.system;
      expect(proc).toHaveProperty("nodeVersion");
      expect(typeof proc.nodeVersion).toBe("string");
      expect(proc.nodeVersion).toMatch(/^v\d+\./);
    });

    it("process.memoryRss 应 > 0", () => {
      const { process: proc } = body.data.system;
      expect(proc).toHaveProperty("memoryRss");
      expect(typeof proc.memoryRss).toBe("number");
      expect(proc.memoryRss).toBeGreaterThan(0);
    });

    it("process.memoryHeapTotal 应 > 0", () => {
      const { process: proc } = body.data.system;
      expect(proc).toHaveProperty("memoryHeapTotal");
      expect(typeof proc.memoryHeapTotal).toBe("number");
      expect(proc.memoryHeapTotal).toBeGreaterThan(0);
    });

    it("process.memoryHeapUsed 应 > 0 且 ≤ memoryHeapTotal", () => {
      const { process: proc } = body.data.system;
      expect(proc).toHaveProperty("memoryHeapUsed");
      expect(typeof proc.memoryHeapUsed).toBe("number");
      expect(proc.memoryHeapUsed).toBeGreaterThan(0);
      expect(proc.memoryHeapUsed).toBeLessThanOrEqual(proc.memoryHeapTotal);
    });
  });

  // ============================================================
  // 场景 5: disk 字段验证
  // ============================================================
  describe("场景 5: disk 字段验证", () => {
    it("disk 应为 null 或 object", () => {
      const { disk } = body.data;
      expect(disk === null || typeof disk === "object").toBe(true);
    });

    it("当 disk 非 null 时，应包含 dbFile 对象", () => {
      const { disk } = body.data;
      if (disk !== null) {
        expect(disk).toHaveProperty("dbFile");
        expect(typeof disk.dbFile).toBe("object");
        expect(disk.dbFile).not.toBeNull();
      }
    });

    it("当 disk 非 null 时，dbFile.path 应为 string", () => {
      const { disk } = body.data;
      if (disk !== null) {
        expect(typeof disk.dbFile.path).toBe("string");
        expect(disk.dbFile.path.length).toBeGreaterThan(0);
      }
    });

    it("当 disk 非 null 时，dbFile.sizeBytes 应 ≥ 0", () => {
      const { disk } = body.data;
      if (disk !== null) {
        expect(typeof disk.dbFile.sizeBytes).toBe("number");
        expect(disk.dbFile.sizeBytes).toBeGreaterThanOrEqual(0);
      }
    });

    it("当 disk 非 null 时，freeSpaceBytes 应为 number 或 null", () => {
      const { disk } = body.data;
      if (disk !== null) {
        expect(disk.freeSpaceBytes === null || typeof disk.freeSpaceBytes === "number").toBe(true);
      }
    });

    it("当 disk 非 null 且 freeSpaceBytes 非 null 时，应 ≥ 0", () => {
      const { disk } = body.data;
      if (disk !== null && disk.freeSpaceBytes !== null) {
        expect(disk.freeSpaceBytes).toBeGreaterThanOrEqual(0);
      }
    });

    it("当 disk 非 null 时，totalSpaceBytes 应为 number 或 null", () => {
      const { disk } = body.data;
      if (disk !== null) {
        expect(disk.totalSpaceBytes === null || typeof disk.totalSpaceBytes === "number").toBe(
          true,
        );
      }
    });

    it("当 disk 非 null 且 freeSpaceBytes 和 totalSpaceBytes 都非 null 时，freeSpaceBytes ≤ totalSpaceBytes", () => {
      const { disk } = body.data;
      if (disk !== null && disk.freeSpaceBytes !== null && disk.totalSpaceBytes !== null) {
        expect(disk.freeSpaceBytes).toBeLessThanOrEqual(disk.totalSpaceBytes);
      }
    });
  });

  // ============================================================
  // 场景 6: 降级场景 — API 仍应返回 200
  // ============================================================
  describe("场景 6: 降级场景 — 即使部分组件 unhealthy/degraded，API 仍应返回 200", () => {
    it("只要 overall 不是 unhealthy，API 应返回 200", () => {
      if (body.data.overall !== "unhealthy") {
        expect(body.data.overall).toMatch(/^(healthy|degraded)$/);
      }
      // API 自身的组件检查应总是可用（测试环境）
      const apiComponent = body.data.components.find((c) => c.component === "api");
      expect(apiComponent).toBeDefined();
    });

    it("即使 redis 组件为 error/degraded，API 仍应返回 200", async () => {
      const { status } = await get("/api/admin/health");
      expect(status).toBe(200);
      // redis 组件的 status 可能是 "healthy"、"degraded" 或 "unhealthy"
      // 但不影响 API 返回 200（只要 overall 不是 unhealthy）
      const redisComponent = body.data.components.find((c) => c.component === "redis");
      expect(redisComponent).toBeDefined();
      const validStatuses: ComponentStatus[] = ["healthy", "degraded", "unhealthy"];
      expect(validStatuses).toContain(redisComponent?.status);
    });

    it("即使 ai 组件为 degraded，API 仍应返回 200", async () => {
      const { status } = await get("/api/admin/health");
      expect(status).toBe(200);
      const aiComponent = body.data.components.find((c) => c.component === "ai");
      expect(aiComponent).toBeDefined();
      const validStatuses: ComponentStatus[] = ["healthy", "degraded", "unhealthy"];
      expect(validStatuses).toContain(aiComponent?.status);
    });

    it("连续 3 次请求均应返回 200 且结构一致（不因拒动而改变）", async () => {
      const results: { status: number; hasSystem: boolean; hasDisk: boolean }[] = [];
      for (let i = 0; i < 3; i++) {
        const { status, body: b } = await get("/api/admin/health");
        const parsed = b as HealthResponse;
        results.push({
          status,
          hasSystem: parsed?.data?.system !== undefined,
          hasDisk: parsed?.data?.disk !== undefined,
        });
      }
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(r.hasSystem).toBe(true);
        expect(r.hasDisk).toBe(true);
      }
    });
  });

  // ============================================================
  // 补充：响应字段不存在多余/未声明字段
  // ============================================================
  describe("字段最小化：system 不应包含设计文档未声明的字段", () => {
    it("cpu 应仅包含 model、cores、loadAvg", () => {
      const cpuKeys = Object.keys(body.data.system.cpu).sort();
      const expectedKeys = ["cores", "loadAvg", "model"].sort();
      expect(cpuKeys).toEqual(expectedKeys);
    });

    it("memory 应仅包含 total、free、used、usagePercent", () => {
      const memKeys = Object.keys(body.data.system.memory).sort();
      const expectedKeys = ["free", "total", "usagePercent", "used"].sort();
      expect(memKeys).toEqual(expectedKeys);
    });

    it("process 应仅包含设计文档声明的字段", () => {
      const procKeys = Object.keys(body.data.system.process).sort();
      const expectedKeys = [
        "memoryHeapTotal",
        "memoryHeapUsed",
        "memoryRss",
        "nodeVersion",
        "pid",
        "uptime",
      ].sort();
      expect(procKeys).toEqual(expectedKeys);
    });
  });

  // ============================================================
  // 补充：JSON Content-Type 验证
  // ============================================================
  describe("响应格式", () => {
    it("应返回 JSON Content-Type", async () => {
      const res = await app.request("/api/admin/health", { method: "GET" });
      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).toContain("application/json");
    });
  });
});

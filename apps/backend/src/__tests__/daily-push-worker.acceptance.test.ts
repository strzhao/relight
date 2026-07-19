import type { Job } from "bullmq";
/**
 * 验收测试：daily-push Worker 行为契约（黑盒）
 *
 * 覆盖验收场景（信息隔离，仅基于设计文档 + 契约规约）：
 * - 场景1.P3：errcode=0 时 console.log 含 `[daily-push] success` AND `errcode=0`
 * - 场景4.P1：开关关 → 不发送（sendWallpaperToWeCom 调用计数 == 0）
 * - 场景5.P1：当天无精选 → 不发送（sendWallpaperToWeCom 调用计数 == 0）
 * - 场景5.P2：当天无精选 → console.log 含 `[daily-push] skipped` AND `no_pick`
 * - 场景6.P1：errcode≠0 → console.log 含 `[daily-push] failed` AND `errcode`
 * - 场景1.P1（worker 层）：happy path 发送时 sendWallpaperToWeCom 被调用 1 次
 * - 场景8.P1（worker 层）：发送时传入 compressForWeCom 输出的 buffer
 *
 * 实现约定（设计文档 §Step 4）：
 * - dailyPushWorker 用 console.log 输出 `[daily-push] success|skipped|failed ...`
 * - 发送链路 import { sendWallpaperToWeCom } from "../lib/push/wechat"
 *   → 红队 vi.mock("../lib/push/wechat") 注入计数 mock（等价 sendFn 注入）
 *
 * 测试参照 createMockJob 模式（daily-worker.acceptance.test.ts:265）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock drizzle-orm 操作符（链式查询构建器）----
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ __op: "eq", left: a, right: b }),
  and: (...conds: unknown[]) => ({ __op: "and", conditions: conds }),
  desc: (col: unknown) => ({ __op: "desc", column: col }),
}));

// ---- chainable mock for drizzle ORM 链式 ----
function chainableMock(result: unknown[] = []) {
  const fn = () => chainableMock(result);
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return result[Number(prop)];
      }
      return chainableMock(result);
    },
  });
}

// ---- Mock db ----
const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));

const mockSchema = vi.hoisted(() => ({
  dailyPicks: {
    id: "dailyPicks.id",
    pickDate: "dailyPicks.pick_date",
    composedImagePath: "dailyPicks.composed_image_path",
  },
  settings: { key: "settings.key", value: "settings.value" },
}));

vi.mock("../db", () => ({ db: mockDb, schema: mockSchema }));

// ---- Mock push lib（核心：注入 sendWallpaperToWeCom + compressForWeCom + settings）----

const mockSendWallpaperToWeCom = vi.hoisted(() => vi.fn());
const mockCompressForWeCom = vi.hoisted(() => vi.fn((buf: Buffer) => Promise.resolve(buf)));
const mockGetDailyPushSettings = vi.hoisted(() =>
  vi.fn(async () => ({ webhook: "", enabled: false })),
);

vi.mock("../lib/push/wechat", async (importOriginal) => {
  // 保留实际模块的非 mock 导出(含 WECOM_WEBHOOK_REGEX 等 worker 依赖的公开常量),
  // 仅覆盖需注入的 3 个函数。等价于 sendFn 注入但走模块公开 API。
  const actual = await importOriginal<typeof import("../lib/push/wechat")>();
  return {
    ...actual,
    sendWallpaperToWeCom: mockSendWallpaperToWeCom,
    compressForWeCom: mockCompressForWeCom,
    getDailyPushSettings: mockGetDailyPushSettings,
  };
});

// ---- Mock wallpaper composer（worker 触发合成的路径）----
vi.mock("../lib/wallpaper/composer", () => ({
  composeAndSave: vi.fn(async () => "/tmp/fake-composed.jpg"),
}));

// ---- Mock fs/promises（读取合成图）----
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from("fake-jpeg-bytes")),
  default: { readFile: vi.fn(async () => Buffer.from("fake-jpeg-bytes")) },
}));

// ---- Mock sharp（防 worker 内合成链触发）----
vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    resize: function () {
      return this;
    },
    jpeg: function () {
      return this;
    },
    toBuffer: () => Promise.resolve(Buffer.alloc(1024)),
  })),
}));

// ---- Mock ai client / prompts / storage / config（防 worker 引入副作用）----
vi.mock("../ai/client", () => ({ aiClient: { chat: vi.fn(), analyzePhoto: vi.fn() } }));
vi.mock("../ai/prompts", () => ({ loadPrompts: vi.fn() }));
vi.mock("../storage", () => ({ createStorageAdapter: vi.fn() }));
vi.mock("../lib/config", () => ({
  config: {
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "relight",
    ai: { baseUrl: "", apiKey: "", visionModel: "", model: "", promptVersion: "" },
    daily: { cronTime: "0 6 * * *", maxCandidates: 20, timezone: "Asia/Shanghai" },
  },
}));

// ---- Mock probeAllSources / candidate-pool（worker 可能 import）----
vi.mock("../jobs/storage-health", () => ({
  probeAllSources: vi.fn(async () => ({ overall: "healthy", sources: [] })),
}));

// ---- Import after mocks ----
import { dailyPushWorker } from "../jobs/daily-push";

// ---- 测试辅助 ----

interface DailyPushJobData {
  pickDate?: string;
}

function createMockJob(overrides: Partial<DailyPushJobData> = {}): Job<DailyPushJobData> {
  return {
    data: { ...overrides },
    id: "job-daily-push-001",
    name: "daily-push-cron",
    log: vi.fn(),
    updateProgress: vi.fn(),
  } as unknown as Job<DailyPushJobData>;
}

/** 任意当天 pickDate（北京日期） */
const TODAY = "2026-07-19";
const VALID_WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-token-001";

/** 捕获 console.log 调用 */
function spyConsoleLog() {
  const calls: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    calls.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  return {
    spy,
    calls,
    text: () => calls.join("\n"),
    reset: () => {
      calls.length = 0;
    },
  };
}

/** 设置当天有精选（composedImagePath 已就绪） */
function setupDailyPickExists(pickOverrides: Record<string, unknown> = {}) {
  mockDb.select.mockReset();
  mockDb.select.mockReturnValue(
    chainableMock([
      {
        id: "pick-today",
        photoId: "photo-001",
        pickDate: TODAY,
        title: "金色黄昏",
        composedImagePath: "/tmp/composed-today.jpg",
        ...pickOverrides,
      },
    ]),
  );
}

/** 设置当天无精选（查询返回空数组） */
function setupDailyPickMissing() {
  mockDb.select.mockReset();
  mockDb.select.mockReturnValue(chainableMock([]));
}

// ---- 测试 ----

describe("daily-push Worker — 验收测试（场景1.P3 / 4.P1 / 5.P1 / 5.P2 / 6.P1 / 8.P1）", () => {
  let consoleSpy: ReturnType<typeof spyConsoleLog>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = spyConsoleLog();

    // 默认 compress 透传
    mockCompressForWeCom.mockImplementation((buf: Buffer) => Promise.resolve(buf));
    // 默认 send 成功
    mockSendWallpaperToWeCom.mockResolvedValue({ errcode: 0, errmsg: "ok" });
    // 默认 settings 开启 + 配置好 webhook
    mockGetDailyPushSettings.mockResolvedValue({ webhook: VALID_WEBHOOK, enabled: true });
    // 默认当天有精选
    setupDailyPickExists();
  });

  afterEach(() => {
    consoleSpy.spy.mockRestore();
  });

  // =========================================================================
  // 场景1.P1（worker 层）+ 1.P3 + 1.P4：happy path 发送 + 状态行
  // =========================================================================

  describe("场景1.P1 / 1.P3 / 1.P4 — happy path：发送 + 状态行 + 计数", () => {
    it("开关开 + 有精选 + webhook 有效：sendWallpaperToWeCom 被调用 1 次", async () => {
      const job = createMockJob();
      await dailyPushWorker(job);

      // 场景1.P1/1.P4：调用计数严格 == 1
      expect(mockSendWallpaperToWeCom).toHaveBeenCalledTimes(1);

      // 传入的 webhookUrl 是 settings.webhook
      const callArgs = mockSendWallpaperToWeCom.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe(VALID_WEBHOOK);
    });

    it("场景1.P1：传入 sendWallpaperToWeCom 的第二参是 buffer（压缩输出）", async () => {
      const job = createMockJob();
      await dailyPushWorker(job);

      const callArgs = mockSendWallpaperToWeCom.mock.calls[0] as unknown[];
      expect(Buffer.isBuffer(callArgs[1])).toBe(true);
    });

    it("场景1.P3：errcode=0 时 console.log 含 `[daily-push] success` AND `errcode=0`", async () => {
      const job = createMockJob();
      await dailyPushWorker(job);

      const logText = consoleSpy.text();
      // 谓词场景1.P3 断言：contains `[daily-push] success` AND `errcode=0`
      expect(logText).toContain("[daily-push] success");
      expect(logText).toContain("errcode=0");
    });

    it("调用链顺序：compress 先于 send（压缩结果流入请求体）", async () => {
      const job = createMockJob();
      await dailyPushWorker(job);

      expect(mockCompressForWeCom).toHaveBeenCalledTimes(1);
      expect(mockSendWallpaperToWeCom).toHaveBeenCalledTimes(1);

      const compressOrder = mockCompressForWeCom.mock.invocationCallOrder[0]!;
      const sendOrder = mockSendWallpaperToWeCom.mock.invocationCallOrder[0]!;
      expect(compressOrder).toBeLessThan(sendOrder);
    });
  });

  // =========================================================================
  // 场景4.P1：开关关 → 不发送（反向谓词）
  // =========================================================================

  describe("场景4.P1 — 开关关：不发出站请求（反向）", () => {
    it("enabled=false 时 sendWallpaperToWeCom 调用计数 == 0", async () => {
      mockGetDailyPushSettings.mockResolvedValue({ webhook: VALID_WEBHOOK, enabled: false });

      const job = createMockJob();
      await dailyPushWorker(job);

      // 反向谓词：count == 0
      expect(mockSendWallpaperToWeCom).not.toHaveBeenCalled();
      expect(mockSendWallpaperToWeCom.mock.calls.length).toBe(0);
    });

    it("enabled=false 也不应调 compress（前置短路）", async () => {
      mockGetDailyPushSettings.mockResolvedValue({ webhook: VALID_WEBHOOK, enabled: false });

      const job = createMockJob();
      await dailyPushWorker(job);

      expect(mockCompressForWeCom).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 场景5.P1 + 5.P2：当天无精选 → 不发送 + skipped 状态行
  // =========================================================================

  describe("场景5.P1 / 5.P2 — 当天无精选：不发送 + skipped 状态行（反向）", () => {
    it("场景5.P1：当天无精选时 sendWallpaperToWeCom 调用计数 == 0", async () => {
      setupDailyPickMissing();

      const job = createMockJob();
      await dailyPushWorker(job);

      // 反向谓词：count == 0
      expect(mockSendWallpaperToWeCom).not.toHaveBeenCalled();
      expect(mockSendWallpaperToWeCom.mock.calls.length).toBe(0);
    });

    it("场景5.P2：当天无精选时 console.log 含 `[daily-push] skipped` AND `no_pick`", async () => {
      setupDailyPickMissing();

      const job = createMockJob();
      await dailyPushWorker(job);

      const logText = consoleSpy.text();
      // 谓词场景5.P2 断言：contains `[daily-push] skipped` AND contains `no_pick`
      expect(logText).toContain("[daily-push] skipped");
      expect(logText).toContain("no_pick");
    });

    it("场景5.P1：无精选时也不应调 compress（前置短路）", async () => {
      setupDailyPickMissing();

      const job = createMockJob();
      await dailyPushWorker(job);

      expect(mockCompressForWeCom).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 场景6.P1：errcode≠0 → failed 状态行 + 保留 errcode
  // =========================================================================

  describe("场景6.P1 — 企业微信 errcode≠0：failed 状态行", () => {
    it("errcode=93000 时 console.log 含 `[daily-push] failed` AND `errcode` AND `93000`", async () => {
      mockSendWallpaperToWeCom.mockRejectedValueOnce(
        Object.assign(new Error("WECOM_REJECTED"), {
          errcode: 93000,
          errmsg: "invalid webhook url",
        }),
      );

      const job = createMockJob();
      // worker throw 后 BullMQ 会重试，单测直接捕获 throw 即可（不影响状态行已输出）
      // 但若 worker try/catch 包裹失败路径并输出 failed 行（设计文档 §Step 4 描述），则不 throw
      try {
        await dailyPushWorker(job);
      } catch {
        // 即使 throw，前面的 console.log 应已产出 failed 行（worker 应先 log 再 throw 或在 catch 中 log）
      }

      const logText = consoleSpy.text();
      // 谓词场景6.P1 断言：contains `[daily-push] failed` AND `errcode` exists
      expect(logText).toContain("[daily-push] failed");
      expect(logText).toContain("errcode");
      // errcode 数字 93000 也应在日志中（mutation kill：替换成其他数字会失败）
      expect(logText).toContain("93000");
    });

    it("errcode=45009（频控）同样应输出 failed 行 + errcode=45009", async () => {
      mockSendWallpaperToWeCom.mockRejectedValueOnce(
        Object.assign(new Error("WECOM_REJECTED"), { errcode: 45009, errmsg: "freq limit" }),
      );

      const job = createMockJob();
      try {
        await dailyPushWorker(job);
      } catch {
        // 预期
      }

      const logText = consoleSpy.text();
      expect(logText).toContain("[daily-push] failed");
      expect(logText).toContain("45009");
    });
  });

  // =========================================================================
  // 场景8.P1（worker 层）：发送内容是当天精选合成图（compress 后字节流入）
  // =========================================================================

  describe("场景8.P1 — 发送的图片即当天精选合成图", () => {
    it("compressForWeCom 的输入应源自当天 composedImagePath（间接：send 收到的是 compress 输出）", async () => {
      const fakeCompressed = Buffer.from("compressed-bytes-from-today-pick");
      mockCompressForWeCom.mockResolvedValueOnce(fakeCompressed);

      const job = createMockJob();
      await dailyPushWorker(job);

      // sendWallpaperToWeCom 收到的应严格等于 compressForWeCom 的输出
      const sendArgs = mockSendWallpaperToWeCom.mock.calls[0] as unknown[];
      expect(sendArgs[1]).toEqual(fakeCompressed);
    });

    it("Mutation kill：compressForWeCom 必须被调用（不允许 worker 直接透传原图）", async () => {
      const job = createMockJob();
      await dailyPushWorker(job);

      // 若蓝队 No-op mutation 跳过 compress 直接读原图发送，此断言 kill
      expect(mockCompressForWeCom).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 状态行前缀契约（fs-grep 兼容性）
  // =========================================================================

  describe("状态行前缀契约（fs-grep 兼容）", () => {
    it("所有 worker 输出以 `[daily-push]` 开头的日志，前缀严格匹配", async () => {
      const job = createMockJob();
      await dailyPushWorker(job);

      const dailyPushLines = consoleSpy.calls.filter((line) => line.includes("[daily-push]"));
      // 至少 1 行（happy path 会有 success 行）
      expect(dailyPushLines.length).toBeGreaterThan(0);
      // 每行前缀严格以 `[daily-push]` + 状态(success|skipped|failed)开头
      for (const line of dailyPushLines) {
        expect(line).toMatch(/\[daily-push\] (success|skipped|failed)/);
      }
    });
  });

  // =========================================================================
  // job.log 也可被调用（与 daily-worker 风格一致；不强求但允许）
  // =========================================================================

  describe("job.log 兼容性（可选辅助日志）", () => {
    it("worker 应至少产生某种日志输出（console.log 或 job.log）", async () => {
      const job = createMockJob();
      await dailyPushWorker(job);

      const jobLogCalls = (job.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
      const totalLog = `${consoleSpy.text()}\n${jobLogCalls.join("\n")}`;
      expect(totalLog.length).toBeGreaterThan(0);
    });
  });
});

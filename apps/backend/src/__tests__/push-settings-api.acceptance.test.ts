/**
 * 验收测试：/api/push/* 后端 API 契约（黑盒）
 *
 * 覆盖验收场景（信息隔离，仅基于设计文档 + 契约规约）：
 * - 场景2.P1：PUT /api/push/settings {webhook} → GET /api/push/settings 读回一致（持久化往返）
 * - 场景2.P2：PUT 仅传 {enabled:true} → webhook 保持原值（部分更新）
 * - 场景3.P1：POST /api/push/test（webhook 有效且有 pick）→ 发一次 image 请求
 * - 场景3.P2 / 7.P2：webhook 非法时返回 INVALID_WEBHOOK（明确配置错误）
 * - 错误码枚举：INVALID_WEBHOOK / NO_PICK / WECOM_REJECTED / SEND_FAILED
 *
 * 测试策略：
 * - 用 Hono createApp().request() 起内存路由（参照项目现有 API 测试模式）
 * - vi.mock("../db") + chainableMock 模拟 settings 表读写
 * - vi.mock("../lib/push/wechat") 注入 mock sendWallpaperToWeCom + compressForWeCom
 *   → 断言调用计数、被传入的 webhook URL、image 请求体契约
 * - 全程不触达真实企业微信
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- chainable mock for drizzle ORM 链式调用 ----

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

// ---- in-memory settings store（模拟 settings 表 key/value）----

const settingsStore = new Map<string, string>();

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../db", () => ({
  db: mockDb,
  schema: chainableMock([]),
}));

// POST /api/push/test 读合成壁纸的依赖(composer 兜底 + fs 读 jpg),避免触达真实文件系统
vi.mock("../lib/wallpaper/composer", () => ({
  composedCachePath: vi.fn(() => "/tmp/fake-composed.jpg"),
  composeAndSave: vi.fn(async () => "/tmp/fake-composed.jpg"),
}));
vi.mock("node:fs/promises", () => ({
  default: { readFile: vi.fn(async () => Buffer.from("fake-jpg")) },
  readFile: vi.fn(async () => Buffer.from("fake-jpg")),
}));

// daily_pick 查询 fixture(POST /api/push/test 取最近精选);settings 读写走 mock 的
// getDailyPushSettings/setDailyPushSettings(settingsStore),不经 db.select
mockDb.select.mockImplementation(() =>
  chainableMock([{ pickDate: "2026-07-19", composedImagePath: "/tmp/fake-composed.jpg" }]),
);

mockDb.insert.mockImplementation(() => {
  const chain = {
    values: (row: { key: string; value: string }) => ({
      onConflictDoUpdate: () => {
        settingsStore.set(row.key, row.value);
        return Promise.resolve([]);
      },
      returning: () => Promise.resolve([row]),
    }),
  };
  return chain;
});

mockDb.update.mockImplementation(() => chainableMock([]));

// ---- Mock push lib（注入 sendWallpaperToWeCom / compressForWeCom 计数与请求体捕获）----

interface CapturedSend {
  webhookUrl: string;
  imageBuffer: Buffer;
}

const mockSendWallpaperToWeCom = vi.hoisted(() => vi.fn());
const mockCompressForWeCom = vi.hoisted(() => vi.fn((buf: Buffer) => Promise.resolve(buf)));
const mockGetDailyPushSettings = vi.hoisted(() =>
  vi.fn(async () => ({
    webhook: settingsStore.get("push.wechat.webhook") ?? "",
    enabled: settingsStore.get("push.wechat.enabled") === "true",
  })),
);
const mockSetDailyPushSettings = vi.hoisted(() =>
  vi.fn(async (patch: { webhook?: string; enabled?: boolean }) => {
    if (patch.webhook !== undefined) settingsStore.set("push.wechat.webhook", patch.webhook);
    if (patch.enabled !== undefined)
      settingsStore.set("push.wechat.enabled", patch.enabled ? "true" : "false");
  }),
);

vi.mock("../lib/push/wechat", async (importOriginal) => {
  // 保留实际模块的非 mock 导出(含 WECOM_WEBHOOK_REGEX / WeComRejectedError 等路由依赖的公开成员),
  // 仅覆盖需注入的 4 个函数。
  const actual = await importOriginal<typeof import("../lib/push/wechat")>();
  return {
    ...actual,
    sendWallpaperToWeCom: mockSendWallpaperToWeCom,
    compressForWeCom: mockCompressForWeCom,
    getDailyPushSettings: mockGetDailyPushSettings,
    setDailyPushSettings: mockSetDailyPushSettings,
  };
});

// ---- Mock queues（防止 app.ts 模块加载触发 Redis 连接）----
vi.mock("../jobs/queues", () => ({
  scanQueue: { add: () => Promise.resolve({ id: "mock" }) },
  analyzeQueue: { add: () => Promise.resolve({ id: "mock" }) },
  dailyQueue: { add: () => Promise.resolve({ id: "mock" }) },
}));

// ---- Import after mocks ----
import { createApp } from "../app";

// ---- 测试辅助 ----

function app() {
  return createApp();
}

async function get(path: string) {
  const res = await app().request(path, { method: "GET" });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function put(path: string, data?: unknown) {
  const res = await app().request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : "{}",
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function post(path: string, data?: unknown) {
  const res = await app().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : "{}",
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const VALID_WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-XYZ-123";
const INVALID_WEBHOOK = "https://evil.example.com/webhook?key=bad";

// ---- 测试 ----

describe("场景2/3/7 — /api/push 后端 API 契约", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsStore.clear();
    // 默认 compressForWeCom 透传 buffer（不改变长度）
    mockCompressForWeCom.mockImplementation((buf: Buffer) => Promise.resolve(buf));
    // 默认 sendWallpaperToWeCom 返回成功
    mockSendWallpaperToWeCom.mockResolvedValue({ errcode: 0, errmsg: "ok" });
  });

  // =========================================================================
  // GET /api/push/settings
  // =========================================================================

  describe("GET /api/push/settings", () => {
    it("未配置时应返回 {success:true, data:{webhook:'', enabled:false}}", async () => {
      const { status, body } = await get("/api/push/settings");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(typeof body.data.webhook).toBe("string");
      expect(typeof body.data.enabled).toBe("boolean");
      // 默认值（设计文档：webhook 默认 ""，enabled 默认 false）
      expect(body.data.webhook).toBe("");
      expect(body.data.enabled).toBe(false);
    });

    it("已配置时 webhook 明文返回（本地访问，契约规约声明）", async () => {
      settingsStore.set("push.wechat.webhook", VALID_WEBHOOK);
      settingsStore.set("push.wechat.enabled", "true");

      const { status, body } = await get("/api/push/settings");
      expect(status).toBe(200);
      expect(body.data.webhook).toBe(VALID_WEBHOOK);
      expect(body.data.enabled).toBe(true);
    });
  });

  // =========================================================================
  // 场景2.P1：PUT → GET 持久化往返
  // =========================================================================

  describe("场景2.P1 — PUT /api/push/settings {webhook} 持久化往返", () => {
    it("PUT 合法 webhook 后 GET 读回一致", async () => {
      // PUT
      const putRes = await put("/api/push/settings", { webhook: VALID_WEBHOOK });
      expect(putRes.status).toBe(200);
      expect(putRes.body.success).toBe(true);
      expect(putRes.body.data.webhook).toBe(VALID_WEBHOOK);

      // GET 验证持久化
      const { status, body } = await get("/api/push/settings");
      expect(status).toBe(200);
      expect(body.data.webhook).toBe(VALID_WEBHOOK);
    });

    it("PUT {enabled:true} 后 GET enabled === true", async () => {
      const putRes = await put("/api/push/settings", { enabled: true });
      expect(putRes.status).toBe(200);
      expect(putRes.body.data.enabled).toBe(true);

      const { body } = await get("/api/push/settings");
      expect(body.data.enabled).toBe(true);
    });

    it("PUT {enabled:false} 后 GET enabled === false（boolean 序列化为字符串还原）", async () => {
      await put("/api/push/settings", { enabled: true });
      await put("/api/push/settings", { enabled: false });

      const { body } = await get("/api/push/settings");
      expect(body.data.enabled).toBe(false);
    });
  });

  // =========================================================================
  // 场景2.P2：部分更新（只传 enabled，webhook 保持原值）
  // =========================================================================

  describe("场景2.P2 — PUT 仅传 {enabled} 时 webhook 保持不变（部分更新）", () => {
    it("先 PUT webhook，再 PUT 仅 enabled:true，webhook 应保持", async () => {
      // 1. 先写入 webhook
      await put("/api/push/settings", { webhook: VALID_WEBHOOK });
      // 2. 再仅 PUT enabled
      const putRes = await put("/api/push/settings", { enabled: true });
      expect(putRes.status).toBe(200);

      // 3. GET 验证 webhook 未被清空（部分更新契约）
      const { body } = await get("/api/push/settings");
      expect(body.data.webhook).toBe(VALID_WEBHOOK);
      expect(body.data.enabled).toBe(true);
    });

    it("先 PUT enabled，再 PUT 仅 webhook，enabled 应保持", async () => {
      await put("/api/push/settings", { enabled: true });
      await put("/api/push/settings", { webhook: VALID_WEBHOOK });

      const { body } = await get("/api/push/settings");
      expect(body.data.enabled).toBe(true);
      expect(body.data.webhook).toBe(VALID_WEBHOOK);
    });
  });

  // =========================================================================
  // webhook 正则校验（INVALID_WEBHOOK）
  // =========================================================================

  describe("webhook 正则校验（场景3.P2 / 7.P2）— INVALID_WEBHOOK", () => {
    it("PUT 非法 webhook（域名不符）应返回 400 + INVALID_WEBHOOK", async () => {
      const { status, body } = await put("/api/push/settings", { webhook: INVALID_WEBHOOK });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBe("INVALID_WEBHOOK");
    });

    it("PUT 非法 webhook（缺 key 参数）应返回 400 + INVALID_WEBHOOK", async () => {
      const noKey = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send";
      const { status, body } = await put("/api/push/settings", { webhook: noKey });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBe("INVALID_WEBHOOK");
    });

    it("PUT 空 webhook 字符串应被接受（表示「清空配置」，非 INVALID_WEBHOOK）", async () => {
      // 设计文档：webhook 非空时才校验正则；空字符串视为清空配置
      // 契约规约：webhook 非空时须匹配正则（暗示空可接受）
      const { status, body } = await put("/api/push/settings", { webhook: "" });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.webhook).toBe("");
    });

    it("PUT 合法 webhook（key 含中划线）应被接受", async () => {
      const dashed = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=aa-bb-cc-1122-xyz";
      const { status, body } = await put("/api/push/settings", { webhook: dashed });
      expect(status).toBe(200);
      expect(body.data.webhook).toBe(dashed);
    });
  });

  // =========================================================================
  // 场景3.P1 / 3.P2：POST /api/push/test
  // =========================================================================

  describe("场景3.P1 — POST /api/push/test（webhook 有效 + 有 pick）", () => {
    it("webhook 有效且有 pick 时，应调用 sendWallpaperToWeCom 1 次", async () => {
      // 配置有效 webhook
      await put("/api/push/settings", { webhook: VALID_WEBHOOK });

      const { status, body } = await post("/api/push/test");
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      // sendWallpaperToWeCom 被调用恰好 1 次
      expect(mockSendWallpaperToWeCom).toHaveBeenCalledTimes(1);

      // 传入的 webhookUrl 应等于当前 settings 的 webhook
      const callArgs = mockSendWallpaperToWeCom.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe(VALID_WEBHOOK);
      // 第二参应为 buffer
      expect(Buffer.isBuffer(callArgs[1])).toBe(true);
    });

    it("调用 sendWallpaperToWeCom 前应先调 compressForWeCom（≤2MB 流入）", async () => {
      await put("/api/push/settings", { webhook: VALID_WEBHOOK });

      await post("/api/push/test");

      expect(mockCompressForWeCom).toHaveBeenCalledTimes(1);
      expect(mockSendWallpaperToWeCom).toHaveBeenCalledTimes(1);
      // 顺序：compress 先于 send
      const compressOrder = mockCompressForWeCom.mock.invocationCallOrder[0]!;
      const sendOrder = mockSendWallpaperToWeCom.mock.invocationCallOrder[0]!;
      expect(compressOrder).toBeLessThan(sendOrder);
    });

    it("企业微信返回 errcode=0 时，响应 data.errcode === 0", async () => {
      await put("/api/push/settings", { webhook: VALID_WEBHOOK });
      mockSendWallpaperToWeCom.mockResolvedValueOnce({ errcode: 0, errmsg: "ok" });

      const { status, body } = await post("/api/push/test");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.errcode).toBe(0);
    });

    it("企业微信返回 errcode≠0 时，响应 error === WECOM_REJECTED 且含 errcode", async () => {
      await put("/api/push/settings", { webhook: VALID_WEBHOOK });
      mockSendWallpaperToWeCom.mockRejectedValueOnce(
        Object.assign(new Error("wecom rejected"), { errcode: 93000, errmsg: "invalid url" }),
      );

      const { status, body } = await post("/api/push/test");
      expect(status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.error).toBe("WECOM_REJECTED");
    });

    it("网络异常（sendWallpaperToWeCom throw 非 WECOM_REJECTED）时，响应 error === SEND_FAILED", async () => {
      await put("/api/push/settings", { webhook: VALID_WEBHOOK });
      mockSendWallpaperToWeCom.mockRejectedValueOnce(new Error("network timeout"));

      const { status, body } = await post("/api/push/test");
      expect(status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe("SEND_FAILED");
    });
  });

  describe("场景3.P2 — POST /api/push/test webhook 非法时返回配置错误", () => {
    it("webhook 为空时 POST /api/push/test 应返回明确配置错误", async () => {
      // 未配置 webhook
      const { status, body } = await post("/api/push/test");
      // 契约规约：webhook 未配置或非法 → 不发出站请求
      // 应返回错误（INVALID_WEBHOOK 或 NO_PICK，但不应是 success:true）
      expect(body.success).toBe(false);
      // 不应调 sendWallpaperToWeCom
      expect(mockSendWallpaperToWeCom).not.toHaveBeenCalled();
      // 错误码应在 INVALID_WEBHOOK / NO_PICK 枚举内（具体由实现选择）
      expect(["INVALID_WEBHOOK", "NO_PICK", "SEND_FAILED"]).toContain(body.error);
    });

    it("webhook 非法时 POST /api/push/test 应返回 INVALID_WEBHOOK 且不发请求", async () => {
      // 直接塞一个非法 webhook（绕过 PUT 校验）
      settingsStore.set("push.wechat.webhook", INVALID_WEBHOOK);

      const { status, body } = await post("/api/push/test");
      expect(body.success).toBe(false);
      expect(body.error).toBe("INVALID_WEBHOOK");
      expect(mockSendWallpaperToWeCom).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 路由存在性 / localhostOnly（契约：/api/push/* 经 localhostOnly）
  // =========================================================================

  describe("路由存在性", () => {
    it("/api/push/settings GET 不应 404", async () => {
      const { status } = await get("/api/push/settings");
      expect(status).not.toBe(404);
      expect(status).not.toBe(500);
    });

    it("/api/push/settings PUT 不应 404", async () => {
      const { status } = await put("/api/push/settings", {});
      expect(status).not.toBe(404);
    });

    it("/api/push/test POST 不应 404", async () => {
      const { status } = await post("/api/push/test");
      expect(status).not.toBe(404);
    });
  });

  // =========================================================================
  // 错误码枚举（设计文档 §错误码枚举）
  // =========================================================================

  describe("错误码枚举与契约一致性", () => {
    it("INVALID_WEBHOOK 错误码字面量与设计文档一致", async () => {
      const { body } = await put("/api/push/settings", { webhook: "not-a-url" });
      expect(body.error).toBe("INVALID_WEBHOOK");
    });

    it("所有错误响应 success === false（与成功响应区分）", async () => {
      const { body: errBody } = await put("/api/push/settings", { webhook: "bad" });
      expect(errBody.success).toBe(false);

      const { body: okBody } = await put("/api/push/settings", { webhook: VALID_WEBHOOK });
      expect(okBody.success).toBe(true);
    });
  });
});

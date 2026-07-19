import { Hono } from "hono";
/**
 * 单元测试：src/routes/push.ts
 *
 * 覆盖（基于「## 契约规约」与「## 验收场景 场景2/3/7」）：
 * - GET /api/push/settings：默认值 + 已持久化读回
 * - PUT /api/push/settings：webhook 正则校验（空 / 合法 / 非法 INVALID_WEBHOOK）+ 持久化往返 + 部分更新
 * - POST /api/push/test：契约错误码枚举 NO_PICK / INVALID_WEBHOOK / WECOM_REJECTED / SEND_FAILED / 成功
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WeComRejectedError,
  compressForWeCom,
  getDailyPushSettings,
  sendWallpaperToWeCom,
  setDailyPushSettings,
} from "../lib/push/wechat";

// ---- Mock push lib ----
const mockGetSettings = vi.hoisted(() => vi.fn());
const mockSetSettings = vi.hoisted(() => vi.fn());
const mockCompress = vi.hoisted(() => vi.fn());
const mockSend = vi.hoisted(() => vi.fn());

vi.mock("../lib/push/wechat", () => ({
  WECOM_IMAGE_MAX_BYTES: 2 * 1024 * 1024,
  WECOM_WEBHOOK_REGEX:
    /^https?:\/\/(qyapi\.weixin\.qq\.com|localhost)(?::\d+)?\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9-]+$/,
  SETTINGS_KEY_WEBHOOK: "push.wechat.webhook",
  SETTINGS_KEY_ENABLED: "push.wechat.enabled",
  getDailyPushSettings: mockGetSettings,
  setDailyPushSettings: mockSetSettings,
  compressForWeCom: mockCompress,
  sendWallpaperToWeCom: mockSend,
  WeComRejectedError: class WeComRejectedError extends Error {
    readonly errcode: number;
    readonly errmsg: string;
    constructor(errcode: number, errmsg: string) {
      super(`WECOM_REJECTED: errcode=${errcode} errmsg=${errmsg}`);
      this.name = "WeComRejectedError";
      this.errcode = errcode;
      this.errmsg = errmsg;
    }
  },
}));

// ---- Mock db (daily_picks 查询) ----
const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
}));
const mockSchema = vi.hoisted(() => ({
  dailyPicks: {
    pickDate: "dailyPicks.pick_date",
    composedImagePath: "dailyPicks.composed_image_path",
  },
  photos: {
    id: "photos.id",
  },
}));

vi.mock("../db", () => ({
  db: mockDb,
  schema: mockSchema,
}));

vi.mock("../lib/wallpaper/composer", () => ({
  composedCachePath: vi.fn(() => "/tmp/fake-composed.jpg"),
  composeAndSave: vi.fn(async () => "/tmp/fake-composed.jpg"),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async () => Buffer.from("fake-jpg")),
  },
  readFile: vi.fn(async () => Buffer.from("fake-jpg")),
}));

// 必须在 mock 之后 import
import { pushRouter } from "../routes/push";

// Hono app.request() 测试模式（localhostOnly middleware 会因无 socket 视为 localhost）
function makeApp() {
  return new Hono().route("/api/push", pushRouter);
}

function chainableMock(result: unknown[] = []) {
  const fn = (..._args: unknown[]) => chainableMock(result);
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      return chainableMock(result);
    },
  });
}

describe("GET /api/push/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({ webhook: "", enabled: false });
  });

  it("未配置时返回默认 {webhook:'',enabled:false} + success:true", async () => {
    const app = makeApp();
    const res = await app.request("/api/push/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { webhook: string; enabled: boolean };
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ webhook: "", enabled: false });
  });

  it("已配置时回显明文 webhook 与 enabled", async () => {
    mockGetSettings.mockResolvedValue({
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123",
      enabled: true,
    });
    const app = makeApp();
    const res = await app.request("/api/push/settings");
    const body = (await res.json()) as { data: { webhook: string; enabled: boolean } };
    expect(body.data.webhook).toBe("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123");
    expect(body.data.enabled).toBe(true);
  });
});

describe("PUT /api/push/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // setDailyPushSettings 之后 getDailyPushSettings 回显最新值
    mockSetSettings.mockResolvedValue(undefined);
  });

  const VALID = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123";

  it("webhook 合法时应持久化并返回 200 + 更新后值", async () => {
    mockGetSettings.mockResolvedValue({ webhook: VALID, enabled: false });
    const app = makeApp();
    const res = await app.request("/api/push/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webhook: VALID }),
    });
    expect(res.status).toBe(200);
    expect(mockSetSettings).toHaveBeenCalledWith({ webhook: VALID });
    const body = (await res.json()) as { success: boolean; data: { webhook: string } };
    expect(body.success).toBe(true);
    expect(body.data.webhook).toBe(VALID);
  });

  it("webhook 非法时应返回 400 INVALID_WEBHOOK", async () => {
    const app = makeApp();
    const res = await app.request("/api/push/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webhook: "https://evil.com/x?key=abc" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("INVALID_WEBHOOK");
    expect(mockSetSettings).not.toHaveBeenCalled();
  });

  it("webhook=空字符串(显式清空)应被接受", async () => {
    mockGetSettings.mockResolvedValue({ webhook: "", enabled: false });
    const app = makeApp();
    const res = await app.request("/api/push/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webhook: "" }),
    });
    expect(res.status).toBe(200);
    expect(mockSetSettings).toHaveBeenCalledWith({ webhook: "" });
  });

  it("部分更新：仅传 enabled 时 webhook 保持不变", async () => {
    mockGetSettings.mockResolvedValue({ webhook: VALID, enabled: true });
    const app = makeApp();
    const res = await app.request("/api/push/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    expect(mockSetSettings).toHaveBeenCalledWith({ enabled: true });
    expect(mockSetSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ webhook: expect.anything() }),
    );
    const body = (await res.json()) as { data: { webhook: string; enabled: boolean } };
    expect(body.data.enabled).toBe(true);
  });

  it("enabled 序列化为 boolean 类型(非字符串)", async () => {
    const app = makeApp();
    await app.request("/api/push/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(mockSetSettings).toHaveBeenCalledWith({ enabled: false });
  });
});

describe("POST /api/push/test", () => {
  const VALID = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123";

  beforeEach(() => {
    vi.clearAllMocks();
    mockCompress.mockResolvedValue(Buffer.from("compressed"));
    mockSend.mockResolvedValue({ errcode: 0, errmsg: "ok" });
  });

  it("webhook 非法时返回 INVALID_WEBHOOK（200 success:false）", async () => {
    mockGetSettings.mockResolvedValue({ webhook: "https://evil.com", enabled: true });
    const app = makeApp();
    const res = await app.request("/api/push/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("INVALID_WEBHOOK");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("无 daily_pick 时返回 NO_PICK", async () => {
    mockGetSettings.mockResolvedValue({ webhook: VALID, enabled: true });
    mockDb.select.mockReturnValue(chainableMock([]));
    const app = makeApp();
    const res = await app.request("/api/push/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("NO_PICK");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("发送成功（errcode=0）返回 200 success:true + data:{errcode:0,errmsg:'ok'}", async () => {
    mockGetSettings.mockResolvedValue({ webhook: VALID, enabled: true });
    mockDb.select.mockReturnValue(
      chainableMock([
        {
          pickDate: "2026-07-19",
          composedImagePath: "/tmp/pick.jpg",
        },
      ]),
    );
    const app = makeApp();
    const res = await app.request("/api/push/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as {
      success: boolean;
      data: { errcode: number; errmsg: string };
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ errcode: 0, errmsg: "ok" });
    expect(mockCompress).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalled();
  });

  it("企业微信 errcode≠0 时返回 WECOM_REJECTED + data:{errcode,errmsg}", async () => {
    mockGetSettings.mockResolvedValue({ webhook: VALID, enabled: true });
    mockDb.select.mockReturnValue(
      chainableMock([{ pickDate: "2026-07-19", composedImagePath: "/tmp/pick.jpg" }]),
    );
    mockSend.mockRejectedValue(new WeComRejectedError(93000, "invalid"));
    const app = makeApp();
    const res = await app.request("/api/push/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as {
      success: boolean;
      error: string;
      data: { errcode: number; errmsg: string };
    };
    expect(body.success).toBe(false);
    expect(body.error).toBe("WECOM_REJECTED");
    expect(body.data.errcode).toBe(93000);
  });

  it("网络/未知异常时返回 SEND_FAILED + 500", async () => {
    mockGetSettings.mockResolvedValue({ webhook: VALID, enabled: true });
    mockDb.select.mockReturnValue(
      chainableMock([{ pickDate: "2026-07-19", composedImagePath: "/tmp/pick.jpg" }]),
    );
    mockSend.mockRejectedValue(new Error("ECONNRESET"));
    const app = makeApp();
    const res = await app.request("/api/push/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("SEND_FAILED");
  });
});

import crypto from "node:crypto";
/**
 * 验收测试：企业微信 push lib 契约（黑盒）
 *
 * 覆盖验收场景（信息隔离，仅基于设计文档 + 契约规约）：
 * - 场景1.P1：出站请求体 {"msgtype":"image","image":{"base64","md5"}}（base64 非空、md5 = ^[a-f0-9]{32}$）
 * - 场景1.P2：源图 > 2MB 时压缩到 ≤ 2*1024*1024
 * - 场景1.P4：happy path 仅一次出站调用（sendFn 调用计数 == 1）
 * - 场景6.P1：errcode≠0 throw WECOM_REJECTED（保留 errcode/errmsg）
 * - 场景8.P1：推送的图片字节内容 >0 且 ≤2MB
 *
 * 设计要点（实现隔离，仅断言 public 契约）：
 * - sendWallpaperToWeCom 第三参 sendFn 可注入（设计文档声明）→ 红队注入 mock fetch，
 *   断言「请求体 JSON 结构」+「调用计数」+「URL 透传」+「method=POST」
 * - compressForWeCom(buffer) → buffer.length <= 2*1024*1024（硬约束，含等号边界）
 * - errcode===0 不 throw；errcode≠0 throw 且 error.message 含 WECOM_REJECTED
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock sharp（compressForWeCom 实现依赖；注入可控输出 buffer）----

const TWO_MB = 2 * 1024 * 1024;

/** 构造指定字节大小的 Buffer（用 0xAB 填充以便长度可观测） */
function makeBuffer(size: number): Buffer {
  const buf = Buffer.alloc(size, 0xab);
  return buf;
}

/** 通过 mock sharp 链式 jpeg/resize/toBuffer 控制输出大小 */
function setupSharpOutput(outputSize: number) {
  const chainObj = {
    resize: vi.fn(() => chainObj),
    jpeg: vi.fn(() => chainObj),
    toBuffer: vi.fn(() => Promise.resolve(makeBuffer(outputSize))),
  };
  mockSharp.mockReturnValue(chainObj);
  return chainObj;
}

const mockSharp = vi.hoisted(() =>
  vi.fn(() => ({
    resize: vi.fn(() => ({})),
    jpeg: vi.fn(() => ({})),
    toBuffer: vi.fn(() => Promise.resolve(Buffer.alloc(0))),
  })),
);

vi.mock("sharp", () => ({ default: mockSharp }));

// ---- Mock settings 层（getDailyPushSettings / setDailyPushSettings 不在本测试范围）----
// 但 wechat.ts 若 import 了 settings 层，需防止其触达 DB
vi.mock("../lib/settings", () => ({
  getSettingValue: vi.fn(),
  setSettingValue: vi.fn(),
  deleteSetting: vi.fn(),
}));

// ---- Mock db（防止 push lib 模块加载时触发 db 模块副作用）----
const mockDb = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock("../db", () => ({ db: mockDb, schema: {} }));

// ---- Import after mocks ----
import { compressForWeCom, sendWallpaperToWeCom } from "../lib/push/wechat";

// =========================================================================
// 辅助：构造 sendFn mock，捕获请求体 + 计数
// =========================================================================

interface CapturedCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function makeCountingSendFn(response: { errcode: number; errmsg?: string }) {
  const calls: CapturedCall[] = [];
  // sendFn 类型对齐 typeof fetch(sendWallpaperToWeCom 第三参签名),避免 string vs URL|RequestInfo 逆变不兼容
  const sendFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({
      url,
      init: {
        method: init?.method,
        headers: init?.headers as unknown as Record<string, string> | undefined,
        body: init?.body as unknown as string | undefined,
      },
    });
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(JSON.stringify(response)),
    } as unknown as Response;
  });
  return { sendFn, calls };
}

// =========================================================================
// 场景1.P1 / 场景1.P4：企业微信 image 请求体契约 + 调用计数
// =========================================================================

describe("场景1.P1 / 1.P4 — sendWallpaperToWeCom 出站请求体契约", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("场景1.P1：请求体 JSON 结构 == {msgtype:'image', image:{base64, md5}}", async () => {
    const imageBuffer = makeBuffer(1024); // 1KB 小图，足以验证契约
    const { sendFn, calls } = makeCountingSendFn({ errcode: 0, errmsg: "ok" });

    await sendWallpaperToWeCom(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123",
      imageBuffer,
      sendFn,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    const [captured] = calls;
    expect(captured).toBeDefined();

    // 解析请求体 JSON（设计文档：body { msgtype, image: { base64, md5 } }）
    const bodyJson = JSON.parse(captured!.init.body ?? "{}") as Record<string, unknown>;
    expect(bodyJson.msgtype).toBe("image");

    const image = bodyJson.image as Record<string, unknown> | undefined;
    expect(image).toBeDefined();
    expect(typeof image!.base64).toBe("string");
    expect((image!.base64 as string).length).toBeGreaterThan(0);
    expect(typeof image!.md5).toBe("string");
    // md5 32 位小写十六进制（契约规约）
    expect(image!.md5).toMatch(/^[a-f0-9]{32}$/);
  });

  it("场景1.P1：base64 字段 == buffer.toString('base64')（与原 buffer 严格对应）", async () => {
    const imageBuffer = makeBuffer(64);
    const expectedBase64 = imageBuffer.toString("base64");
    const expectedMd5 = crypto.createHash("md5").update(imageBuffer).digest("hex");
    const { sendFn, calls } = makeCountingSendFn({ errcode: 0 });

    await sendWallpaperToWeCom(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
      imageBuffer,
      sendFn,
    );

    const bodyJson = JSON.parse(calls[0]!.init.body ?? "{}") as {
      image: { base64: string; md5: string };
    };
    // base64 解码后字节严格等于原 buffer（mutation kill：替换成任意其他 base64 会失败）
    expect(Buffer.from(bodyJson.image.base64, "base64")).toEqual(imageBuffer);
    expect(bodyJson.image.md5).toBe(expectedMd5);
  });

  it("场景1.P1：HTTP method == POST（不得用 GET/PUT）", async () => {
    const { sendFn, calls } = makeCountingSendFn({ errcode: 0 });
    await sendWallpaperToWeCom(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
      makeBuffer(32),
      sendFn,
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("场景1.P1：请求 URL 透传（webhookUrl 原样传入 sendFn 第一参）", async () => {
    const targetUrl = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=token-xyz-001";
    const { sendFn, calls } = makeCountingSendFn({ errcode: 0 });
    await sendWallpaperToWeCom(targetUrl, makeBuffer(16), sendFn);
    expect(calls[0]!.url).toBe(targetUrl);
  });

  it("场景1.P1：请求 Content-Type 为 application/json", async () => {
    const { sendFn, calls } = makeCountingSendFn({ errcode: 0 });
    await sendWallpaperToWeCom(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=t",
      makeBuffer(8),
      sendFn,
    );
    const ct = calls[0]!.init.headers?.["Content-Type"] ?? calls[0]!.init.headers?.["content-type"];
    expect(ct).toContain("application/json");
  });

  it("场景1.P4：happy path（errcode=0）sendFn 仅被调用 1 次，不重试", async () => {
    const { sendFn } = makeCountingSendFn({ errcode: 0, errmsg: "ok" });
    await sendWallpaperToWeCom(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=no-retry",
      makeBuffer(128),
      sendFn,
    );
    // 调用计数严格 == 1（sendWallpaperToWeCom 本身不重试；重试由 BullMQ 上层负责）
    expect(sendFn).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// 场景6.P1：errcode 分支（errcode≠0 throw WECOM_REJECTED；errcode=0 不 throw）
// =========================================================================

describe("场景6.P1 — errcode 分支（WECOM_REJECTED）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("errcode=0（成功）：函数不 throw，正常返回", async () => {
    const sendFn = makeCountingSendFn({ errcode: 0, errmsg: "ok" }).sendFn;
    // 不应 throw（resolves 断言）
    await expect(
      sendWallpaperToWeCom(
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ok",
        makeBuffer(8),
        sendFn,
      ),
    ).resolves.toBeDefined();
  });

  it("errcode=93000（URL 无效）：throw 且错误名/message 含 WECOM_REJECTED", async () => {
    const sendFn = makeCountingSendFn({ errcode: 93000, errmsg: "invalid webhook url" }).sendFn;
    // 应 throw（rejects 断言）
    await expect(
      sendWallpaperToWeCom(
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=invalid",
        makeBuffer(8),
        sendFn,
      ),
    ).rejects.toThrow(/WECOM_REJECTED/);
  });

  it("errcode=45009（频控）：throw 且错误名/message 含 WECOM_REJECTED", async () => {
    const sendFn = makeCountingSendFn({ errcode: 45009, errmsg: "reach max freq limit" }).sendFn;
    await expect(
      sendWallpaperToWeCom(
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=freq",
        makeBuffer(8),
        sendFn,
      ),
    ).rejects.toThrow(/WECOM_REJECTED/);
  });

  it("errcode≠0 throw 时，error 信息应保留 errcode（可观测）", async () => {
    const sendFn = makeCountingSendFn({ errcode: 93000, errmsg: "invalid url" }).sendFn;
    try {
      await sendWallpaperToWeCom(
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=observe",
        makeBuffer(8),
        sendFn,
      );
      // 若没 throw，测试必须挂（强制 fail，杜绝 warn 跳过）
      expect.fail("errcode=93000 应 throw WECOM_REJECTED，但未 throw");
    } catch (err) {
      // errcode 必须出现在 error 的 message 或附加字段（worker 才能打日志）
      const errStr =
        err instanceof Error
          ? `${err.message} ${JSON.stringify((err as unknown as Record<string, unknown>) ?? {})}`
          : String(err);
      expect(errStr).toContain("93000");
    }
  });

  it("网络异常（sendFn reject）：throw（不吞错）", async () => {
    const sendFn = vi.fn(() => Promise.reject(new Error("network timeout")));
    await expect(
      sendWallpaperToWeCom(
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=neterr",
        makeBuffer(8),
        sendFn,
      ),
    ).rejects.toThrow();
  });
});

// =========================================================================
// 场景1.P2 / 场景8.P1：compressForWeCom 硬约束（输出 ≤ 2MB）
// =========================================================================

describe("场景1.P2 / 8.P1 — compressForWeCom 输出 buffer.length <= 2*1024*1024", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("场景1.P2：输入 6MB（源图）→ 输出 ≤ 2MB（压缩生效）", async () => {
    // 设计文档 example:5120x2880 quality85 ~6MB jpg → 输出 ≤2MB
    // 用 mock sharp 模拟压缩后输出 1.5MB（落在约束内）
    setupSharpOutput(Math.floor(1.5 * 1024 * 1024));

    const input = makeBuffer(6 * 1024 * 1024); // 6MB
    const out = await compressForWeCom(input);

    // 硬约束：输出 buffer.length <= 2*1024*1024
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(TWO_MB);
  });

  it("场景1.P2 边界：输出正好等于 2*1024*1024 字节（含等号边界）应被接受", async () => {
    // 契约规约：buffer.length <= 2*1024*1024（含等号）
    setupSharpOutput(TWO_MB);

    const out = await compressForWeCom(makeBuffer(5 * 1024 * 1024));
    expect(out.length).toBeLessThanOrEqual(TWO_MB);
    expect(out.length).toBe(TWO_MB);
  });

  it("场景1.P2 边界：输出 2*1024*1024 + 1 字节应被进一步压缩（绝不超）", async () => {
    // 第一次 sharp 返回 2MB+1（超过），第二次（quality 降级后）返回 2MB-100（达标）
    const overChain = {
      resize: vi.fn(() => overChain),
      jpeg: vi.fn(() => overChain),
      toBuffer: vi.fn(() => Promise.resolve(makeBuffer(TWO_MB + 1))),
    };
    const underChain = {
      resize: vi.fn(() => underChain),
      jpeg: vi.fn(() => underChain),
      toBuffer: vi.fn(() => Promise.resolve(makeBuffer(TWO_MB - 100))),
    };
    // 交替返回：第 1, 2, 3... 次超；最后一次达标
    mockSharp.mockImplementation(() => overChain);
    let callCount = 0;
    overChain.toBuffer = vi.fn(() => {
      callCount++;
      if (callCount >= 3) return Promise.resolve(makeBuffer(TWO_MB - 100)); // 第 3 次达标
      return Promise.resolve(makeBuffer(TWO_MB + 1));
    });

    const out = await compressForWeCom(makeBuffer(6 * 1024 * 1024));
    expect(out.length).toBeLessThanOrEqual(TWO_MB);
  });

  it("场景8.P1：输出 buffer 字节 > 0（非空，推送内容有效）", async () => {
    setupSharpOutput(100 * 1024); // 100KB
    const out = await compressForWeCom(makeBuffer(2 * 1024 * 1024));
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(TWO_MB);
  });

  it("场景1.P2 输入小图（< 2MB）：输出仍 ≤ 2MB（不放大）", async () => {
    // 小图原样或压缩后应仍 ≤ 2MB
    setupSharpOutput(50 * 1024);
    const out = await compressForWeCom(makeBuffer(50 * 1024));
    expect(out.length).toBeLessThanOrEqual(TWO_MB);
  });

  it("Mutation kill：compressForWeCom 不得返回原 buffer（即使是小图，必须经 Sharp 处理后输出 JPEG）", async () => {
    // 若蓝队 No-op mutation 直接返回输入 buffer，且我们传入 >2MB 输入，会触发失败
    setupSharpOutput(1 * 1024 * 1024);
    const input = makeBuffer(4 * 1024 * 1024); // 4MB 输入
    const out = await compressForWeCom(input);
    expect(out.length).toBeLessThanOrEqual(TWO_MB);
    // 输出长度应不同于原输入（证明经过了处理，No-op mutation 会被 kill）
    expect(out.length).not.toBe(input.length);
  });
});

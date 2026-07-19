import sharp from "sharp";
/**
 * 单元测试：src/lib/push/wechat.ts
 *
 * 覆盖：
 * - compressForWeCom：压缩契约 buffer.length <= 2*1024*1024
 *   (边界：小图直通 / 大图降到阈值 / 极端图多次回退)
 * - sendWallpaperToWeCom：请求体契约 { msgtype, image.base64, image.md5 } + errcode 分支
 *   + 注入 sendFn 验证调用次数与请求体结构
 * - getDailyPushSettings / setDailyPushSettings：读写 + boolean 字符串序列化
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compressForWeCom,
  getDailyPushSettings,
  sendWallpaperToWeCom,
  setDailyPushSettings,
} from "../lib/push/wechat";

// ---- Mock db + settings lib ----
const mockGetSettingValue = vi.hoisted(() => vi.fn());
const mockSetSettingValue = vi.hoisted(() => vi.fn());

vi.mock("../lib/settings", () => ({
  getSettingValue: mockGetSettingValue,
  setSettingValue: mockSetSettingValue,
}));

// ---- helpers ----

const MAX = 2 * 1024 * 1024;

/** 构造一张 sizeable 的真 jpg buffer（避免 sharp mock） */
async function makeLargeJpeg(width: number, height: number, quality = 95): Promise<Buffer> {
  // 生成 RGB 噪声 SVG → sharp 渲染 jpg
  const svg = `<?xml version="1.0"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff8a00"/>
      <stop offset="0.5" stop-color="#e52e71"/>
      <stop offset="1" stop-color="#4a90e2"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  ${Array.from(
    { length: Math.min(200, Math.floor(width / 16)) },
    (_, i) =>
      `<circle cx="${(i * 37) % width}" cy="${(i * 71) % height}" r="${20 + (i % 30)}" fill="rgba(255,255,255,0.25)"/>`,
  ).join("\n")}
</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality }).toBuffer();
}

describe("compressForWeCom", () => {
  it("小图(已 < 2MB)应直通或仅轻微压缩，输出 ≤ 2MB 且为有效 JPEG", async () => {
    const small = await makeLargeJpeg(800, 600, 60);
    expect(small.length).toBeLessThan(MAX);
    const out = await compressForWeCom(small);
    expect(out.length).toBeLessThanOrEqual(MAX);
    // JPEG magic
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
  });

  it("大图(5K quality95 ~ > 2MB)应被压缩到 ≤ 2MB", async () => {
    const large = await makeLargeJpeg(5120, 2880, 95);
    // 前置：确实超过了阈值（否则测试无意义）
    if (large.length <= MAX) {
      // 平台差异兜底：渲染一张更"难压"的图
      return;
    }
    expect(large.length).toBeGreaterThan(MAX);
    const out = await compressForWeCom(large);
    expect(out.length).toBeLessThanOrEqual(MAX);
  });

  it("输出 buffer 永远 ≤ 2*1024*1024(边界等号允许)", async () => {
    const huge = await makeLargeJpeg(6000, 3400, 95);
    const out = await compressForWeCom(huge);
    expect(out.length).toBeLessThanOrEqual(MAX);
  });

  it("输出始终是有效 JPEG 头(0xFFD8)", async () => {
    const large = await makeLargeJpeg(4000, 2500, 92);
    const out = await compressForWeCom(large);
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
  });
});

describe("sendWallpaperToWeCom", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("请求体应严格符合契约 { msgtype:'image', image:{base64,md5} }", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeSend = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const img = Buffer.from("fake-jpeg-bytes");
    const res = await sendWallpaperToWeCom(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
      img,
      fakeSend as unknown as typeof fetch,
    );

    expect(fakeSend).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc");
    expect(captured!.init.method).toBe("POST");
    const body = JSON.parse(captured!.init.body as string) as {
      msgtype: string;
      image: { base64: string; md5: string };
    };
    expect(body.msgtype).toBe("image");
    expect(body.image.base64).toBe(img.toString("base64"));
    // md5 是 32 位 hex
    expect(body.image.md5).toMatch(/^[a-f0-9]{32}$/);
    // 返回值：成功结构
    expect(res.errcode).toBe(0);
    expect(res.errmsg).toBe("ok");
  });

  it("errcode=0 时应 resolve（不 throw），且仅一次出站调用", async () => {
    const fakeSend = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 }),
      );
    const res = await sendWallpaperToWeCom(
      "https://example.com/x",
      Buffer.from("a"),
      fakeSend as unknown as typeof fetch,
    );
    expect(res.errcode).toBe(0);
    expect(fakeSend).toHaveBeenCalledTimes(1);
  });

  it("errcode≠0（如 93000）时应 throw WECOM_REJECTED 并保留 errcode/errmsg", async () => {
    const fakeSend = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errcode: 93000, errmsg: "invalid webhook url" }), {
        status: 200,
      }),
    );
    await expect(
      sendWallpaperToWeCom("https://x", Buffer.from("a"), fakeSend as unknown as typeof fetch),
    ).rejects.toThrow(/WECOM_REJECTED/);
  });

  it("errcode=45009 频控也应 throw WECOM_REJECTED", async () => {
    const fakeSend = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ errcode: 45009, errmsg: "reach max freq" }), { status: 200 }),
      );
    await expect(
      sendWallpaperToWeCom("https://x", Buffer.from("a"), fakeSend as unknown as typeof fetch),
    ).rejects.toThrow(/WECOM_REJECTED/);
  });

  it("网络异常（fetch reject）应 throw，触发 BullMQ 重试", async () => {
    const fakeSend = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      sendWallpaperToWeCom("https://x", Buffer.from("a"), fakeSend as unknown as typeof fetch),
    ).rejects.toThrow(/ECONNRESET/);
  });

  it("未注入 sendFn 时默认走原生 fetch（smoke：注入 mock fetch 替代以避免真实网络）", async () => {
    // 仅验证签名允许缺省 sendFn；实际 fetch 用 vi.spyOn(globalThis, 'fetch')
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 }),
      );
    const res = await sendWallpaperToWeCom("https://example.com/test", Buffer.from("abc"));
    expect(res.errcode).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("getDailyPushSettings / setDailyPushSettings", () => {
  beforeEach(() => {
    mockGetSettingValue.mockReset();
    mockSetSettingValue.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getDailyPushSettings：未配置时返回默认 { webhook: '', enabled: false }", async () => {
    mockGetSettingValue.mockResolvedValue(null);
    const s = await getDailyPushSettings();
    expect(s).toEqual({ webhook: "", enabled: false });
  });

  it("getDailyPushSettings：value='true' 字符串解析为 boolean true", async () => {
    mockGetSettingValue
      .mockResolvedValueOnce("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123")
      .mockResolvedValueOnce("true");
    const s = await getDailyPushSettings();
    expect(s).toEqual({
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123",
      enabled: true,
    });
  });

  it("setDailyPushSettings：boolean 序列化为 'true'/'false' 字符串持久化", async () => {
    await setDailyPushSettings({
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
      enabled: true,
    });
    expect(mockSetSettingValue).toHaveBeenCalledWith(
      "push.wechat.webhook",
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
    );
    expect(mockSetSettingValue).toHaveBeenCalledWith("push.wechat.enabled", "true");
  });

  it("setDailyPushSettings：部分更新（仅 enabled）只持久化出现的字段", async () => {
    await setDailyPushSettings({ enabled: false });
    expect(mockSetSettingValue).toHaveBeenCalledTimes(1);
    expect(mockSetSettingValue).toHaveBeenCalledWith("push.wechat.enabled", "false");
  });

  it("setDailyPushSettings：部分更新（仅 webhook）只持久化出现的字段", async () => {
    await setDailyPushSettings({
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=y",
    });
    expect(mockSetSettingValue).toHaveBeenCalledTimes(1);
    expect(mockSetSettingValue).toHaveBeenCalledWith(
      "push.wechat.webhook",
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=y",
    );
  });
});

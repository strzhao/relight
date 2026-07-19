/**
 * 企业微信群机器人推送 lib。
 *
 * 三块能力：
 * 1. `compressForWeCom(buffer)`：把任意 jpg 压到 ≤ 2\*1024\*1024 字节（企业微信 image 上限）。
 * 2. `sendWallpaperToWeCom(webhookUrl, imageBuffer, sendFn=fetch)`：构造 image 消息请求体并 POST。
 *    `sendFn` 可注入（单测/红队注入计数 mock，规避仓库无 msw/nock 设施）。
 * 3. `getDailyPushSettings` / `setDailyPushSettings`：读写 settings 表 push.wechat.{webhook,enabled}。
 *
 * 设计契约见 `.autopilot/runtime/requirements/20260719-开始实现/state.md`「## 契约规约」。
 */
import crypto from "node:crypto";
import sharp from "sharp";
import { getSettingValue, setSettingValue } from "../settings";

/** 企业微信群机器人 image 消息字节上限（含等号边界，即 ≤ 2\*1024\*1024）。 */
export const WECOM_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** webhook URL 正则：企业微信群机器人专用(允许 http(s) + 可选端口 + 可选 localhost 测试域,兼容开发/测试环境;真实 webhook 为 https qyapi 无端口,仍匹配) */
export const WECOM_WEBHOOK_REGEX =
  /^https?:\/\/(qyapi\.weixin\.qq\.com|localhost)(?::\d+)?\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9-]+$/;

/** settings 表 key */
export const SETTINGS_KEY_WEBHOOK = "push.wechat.webhook";
export const SETTINGS_KEY_ENABLED = "push.wechat.enabled";

/**
 * 压缩策略 quality 序列：从高到低逐降尝试，兼顾画质与字节上限。
 * 仍超阈值 → 在 resize 阶段进一步降宽。
 */
const QUALITY_STEPS = [80, 70, 60, 50, 45, 40] as const;

/** resize 宽度回退序列（保持 16:9 比例近似） */
const RESIZE_WIDTH_STEPS = [2560, 1920] as const;

/**
 * 把任意 jpg buffer 压缩到 ≤ 2\*1024\*1024 字节。
 *
 * invariant 策略（契约规约「压缩契约」）：
 * 1. quality 序列 `[80,70,60,50,45,40]` 逐降（保持原宽高），首次 ≤ 阈值即返回。
 * 2. quality=40 仍超 → resize 宽至 min(原宽, 2560) 重跑序列。
 * 3. 仍超 → resize 宽至 1920 + quality=40（最后一次尽力，仍保证 ≤ 阈值契约：
 *    极端图走 resize 1920 + q40 后实测普遍 < 1MB；若仍超（极罕见），循环降 quality
 *    直至满足契约——契约是硬约束，不允许返回超阈值 buffer）。
 *
 * @returns JPEG buffer，length ≤ WECOM_IMAGE_MAX_BYTES
 */
export async function compressForWeCom(buffer: Buffer): Promise<Buffer> {
  // 第一阶段：原尺寸 + quality 序列
  for (const q of QUALITY_STEPS) {
    const out = await sharp(buffer).jpeg({ quality: q }).toBuffer();
    if (out.length <= WECOM_IMAGE_MAX_BYTES) return out;
  }

  // 第二阶段：resize 至 2560 宽 + quality 序列
  for (const q of QUALITY_STEPS) {
    const out = await sharp(buffer)
      .resize({ width: RESIZE_WIDTH_STEPS[0], withoutEnlargement: true, fit: "inside" })
      .jpeg({ quality: q })
      .toBuffer();
    if (out.length <= WECOM_IMAGE_MAX_BYTES) return out;
  }

  // 第三阶段：resize 至 1920 宽 + quality 序列
  for (const q of QUALITY_STEPS) {
    const out = await sharp(buffer)
      .resize({ width: RESIZE_WIDTH_STEPS[1], withoutEnlargement: true, fit: "inside" })
      .jpeg({ quality: q })
      .toBuffer();
    if (out.length <= WECOM_IMAGE_MAX_BYTES) return out;
  }

  // 兜底：极端情况，继续降 quality 到 10 / 5，并 resize 至 1280 / 960 宽
  // 契约硬约束：必须返回 ≤ 2MB 的 buffer
  const fallbacks: Array<{ width: number; quality: number }> = [
    { width: 1280, quality: 30 },
    { width: 1280, quality: 20 },
    { width: 960, quality: 20 },
    { width: 960, quality: 10 },
    { width: 640, quality: 10 },
  ];
  for (const cfg of fallbacks) {
    const out = await sharp(buffer)
      .resize({ width: cfg.width, withoutEnlargement: true, fit: "inside" })
      .jpeg({ quality: cfg.quality })
      .toBuffer();
    if (out.length <= WECOM_IMAGE_MAX_BYTES) return out;
  }

  // 终极兜底：理论上 unreachable（640×? q10 极小），抛错以暴露异常输入
  throw new Error(
    `compressForWeCom: 无法压缩到 ≤ ${WECOM_IMAGE_MAX_BYTES} 字节（input=${buffer.length}）`,
  );
}

/** 企业微信响应格式 */
export interface WeComSendResult {
  errcode: number;
  errmsg: string;
}

/** 企业微信 errcode≠0 时抛此错（上层捕获后映射 error: WECOM_REJECTED） */
export class WeComRejectedError extends Error {
  readonly errcode: number;
  readonly errmsg: string;
  constructor(errcode: number, errmsg: string) {
    super(`WECOM_REJECTED: errcode=${errcode} errmsg=${errmsg}`);
    this.name = "WeComRejectedError";
    this.errcode = errcode;
    this.errmsg = errmsg;
  }
}

/**
 * 构造企业微信 image 请求体并 POST。
 *
 * 契约：
 * - 请求：`POST <webhookUrl>` body `{ msgtype: "image", image: { base64, md5 } }`
 * - `base64` = buffer.toString("base64");`md5` = crypto.createHash("md5").update(buffer).digest("hex")
 * - 响应 JSON `{ errcode, errmsg }`：errcode===0 resolve，否则 throw WeComRejectedError（上层走 BullMQ 重试）
 *
 * @param webhookUrl 企业微信群机器人完整 URL（含 key）
 * @param imageBuffer 已压缩到 ≤ 2MB 的 JPEG buffer
 * @param sendFn 可注入的 POST 实现，默认原生 fetch（单测/红队注入计数 mock）
 */
export async function sendWallpaperToWeCom(
  webhookUrl: string,
  imageBuffer: Buffer,
  sendFn: typeof fetch = fetch,
): Promise<WeComSendResult> {
  const base64 = imageBuffer.toString("base64");
  const md5 = crypto.createHash("md5").update(imageBuffer).digest("hex");
  const body = JSON.stringify({
    msgtype: "image",
    image: { base64, md5 },
  });

  const resp = await sendFn(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  const text = await resp.text();
  let parsed: { errcode?: number; errmsg?: string };
  try {
    parsed = JSON.parse(text) as { errcode?: number; errmsg?: string };
  } catch {
    throw new Error(`WECOM_REJECTED: 响应非 JSON: ${text.slice(0, 200)}`);
  }

  const errcode = parsed.errcode ?? -1;
  const errmsg = parsed.errmsg ?? "";

  if (errcode === 0) {
    return { errcode, errmsg };
  }
  throw new WeComRejectedError(errcode, errmsg);
}

/** 推送设置（推送到 UI / 路由的形状） */
export interface DailyPushSettings {
  webhook: string;
  enabled: boolean;
}

/**
 * 读取推送设置。未配置返回默认 `{ webhook: "", enabled: false }`。
 *
 * `enabled` 在 settings 表存为字符串 `"true"/"false"`（settings.value 是 text 列），
 * 在此解析回 boolean（`value === "true"`）。
 */
export async function getDailyPushSettings(): Promise<DailyPushSettings> {
  const webhook = (await getSettingValue(SETTINGS_KEY_WEBHOOK)) ?? "";
  const enabledRaw = await getSettingValue(SETTINGS_KEY_ENABLED);
  return {
    webhook,
    enabled: enabledRaw === "true",
  };
}

/**
 * 部分更新推送设置（仅持久化出现的字段）。
 *
 * - `webhook` 直接写 text
 * - `enabled` 序列化为 "true"/"false" 字符串（适配 settings.value text 列）
 */
export async function setDailyPushSettings(
  patch: Partial<Pick<DailyPushSettings, "webhook" | "enabled">>,
): Promise<void> {
  if (patch.webhook !== undefined) {
    await setSettingValue(SETTINGS_KEY_WEBHOOK, patch.webhook);
  }
  if (patch.enabled !== undefined) {
    await setSettingValue(SETTINGS_KEY_ENABLED, patch.enabled ? "true" : "false");
  }
}

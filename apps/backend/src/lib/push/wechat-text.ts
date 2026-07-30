/**
 * 企业微信群机器人 text 消息推送（封面+链接场景用）。
 *
 * 与 sendWallpaperToWeCom 解耦：image 消息走 wechat.ts，text 消息走这里。
 * 复用同一 webhook + 同一 errcode 语义。
 */
import { WeComRejectedError, type WeComSendResult } from "./wechat";

/**
 * 构造企业微信 text 请求体并 POST。
 *
 * 契约：`POST <webhookUrl>` body `{ msgtype: "text", text: { content } }`。
 * errcode≠0 抛 WeComRejectedError（与 image 消息一致，上层捕获映射）。
 *
 * @param webhookUrl 企业微信群机器人完整 URL（含 key）
 * @param content 文本内容
 * @param sendFn 可注入的 POST 实现（单测 mock）
 */
export async function sendWeComText(
  webhookUrl: string,
  content: string,
  sendFn: typeof fetch = fetch,
): Promise<WeComSendResult> {
  const body = JSON.stringify({ msgtype: "text", text: { content } });

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

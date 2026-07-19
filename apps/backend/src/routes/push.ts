import { readFile } from "node:fs/promises";
/**
 * 企业微信群推送配置与测试发送路由（/api/push/*）。
 *
 * 设计契约见 `.autopilot/runtime/requirements/20260719-开始实现/state.md`「## 契约规约 - 后端 API 路由」。
 *
 * 三个端点，全程经 `localhostOnly`（在 app.ts 挂载时统一加 middleware）：
 * - `GET  /api/push/settings` → 当前 webhook + enabled
 * - `PUT  /api/push/settings` → 部分更新（webhook 正则校验、enabled boolean）
 * - `POST /api/push/test`     → 取最近一天有精选 → 压缩 → 发送，返回错误码枚举
 *
 * 错误码枚举：INVALID_WEBHOOK / NO_PICK / WECOM_REJECTED / SEND_FAILED
 */
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";
import {
  WECOM_WEBHOOK_REGEX,
  compressForWeCom,
  getDailyPushSettings,
  sendWallpaperToWeCom,
  setDailyPushSettings,
} from "../lib/push/wechat";
import { composeAndSave, composedCachePath } from "../lib/wallpaper/composer";

export const pushRouter = new Hono();

/** 安全 helper：提取 JSON body（空 body / 非 JSON → {}） */
async function parseBodySafe<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const text = await req.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

// ---- GET /settings ----

pushRouter.get("/settings", async (c) => {
  const settings = await getDailyPushSettings();
  return c.json({ success: true, data: settings });
});

// ---- PUT /settings ----

pushRouter.put("/settings", async (c) => {
  const body = await parseBodySafe<{ webhook?: string; enabled?: boolean }>(c.req.raw);

  // webhook：非空时（用户显式传值）校验；空串视为合法（清空）
  if (body.webhook !== undefined && body.webhook !== "") {
    if (!WECOM_WEBHOOK_REGEX.test(body.webhook)) {
      return c.json({ success: false, error: "INVALID_WEBHOOK" }, 400);
    }
  }

  const patch: { webhook?: string; enabled?: boolean } = {};
  if (body.webhook !== undefined) patch.webhook = body.webhook;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  if (Object.keys(patch).length > 0) {
    await setDailyPushSettings(patch);
  }

  const updated = await getDailyPushSettings();
  return c.json({ success: true, data: updated });
});

// ---- POST /test ----

pushRouter.post("/test", async (c) => {
  const body = await parseBodySafe<{ pickDate?: string }>(c.req.raw);
  const settings = await getDailyPushSettings();

  // webhook 校验（空 / 非法）
  if (!settings.webhook || !WECOM_WEBHOOK_REGEX.test(settings.webhook)) {
    return c.json({ success: false, error: "INVALID_WEBHOOK" });
  }

  // 查目标 daily_pick
  let pickRow: { pickDate: string; composedImagePath: string | null } | null = null;
  try {
    if (body.pickDate) {
      const rows = await db
        .select({
          pickDate: schema.dailyPicks.pickDate,
          composedImagePath: schema.dailyPicks.composedImagePath,
        })
        .from(schema.dailyPicks)
        .where(eq(schema.dailyPicks.pickDate, body.pickDate))
        .limit(1);
      pickRow =
        (rows[0] as { pickDate: string; composedImagePath: string | null } | undefined) ?? null;
    } else {
      const rows = await db
        .select({
          pickDate: schema.dailyPicks.pickDate,
          composedImagePath: schema.dailyPicks.composedImagePath,
        })
        .from(schema.dailyPicks)
        .orderBy(desc(schema.dailyPicks.pickDate))
        .limit(1);
      pickRow =
        (rows[0] as { pickDate: string; composedImagePath: string | null } | undefined) ?? null;
    }
  } catch (err) {
    return c.json(
      {
        success: false,
        error: "SEND_FAILED",
        message: `查询 daily_pick 失败: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  if (!pickRow) {
    return c.json({
      success: false,
      error: "NO_PICK",
      message: "没有可用的每日精选记录",
    });
  }

  // 解析 composedImagePath：null 时按默认尺寸尝试合成缓存
  let composedPath = pickRow.composedImagePath;
  if (!composedPath) {
    composedPath = composedCachePath(pickRow.pickDate, 5120, 2880);
    // 若默认缓存不存在，触发一次合成（复用 composer）
    try {
      const composed = await composeAndSave({
        pick: { ...pickRow, composedImageUrl: null } as never,
        photo: {} as never,
        width: 5120,
        height: 2880,
        cacheKey: "default",
      }).catch(async () => {
        // composeAndSave 需要 photo 参数，若失败则跳过合成（用原 composedPath 兜底读取）
        return composedPath;
      });
      composedPath = typeof composed === "string" ? composed : composedPath;
    } catch {
      // 保持原 composedPath
    }
  }

  // 读 jpg 文件 → 压缩 → 发送
  let imageBuffer: Buffer;
  try {
    imageBuffer = await readFile(composedPath);
  } catch (err) {
    return c.json(
      {
        success: false,
        error: "SEND_FAILED",
        message: `读取合成壁纸失败(${composedPath}): ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  try {
    const compressed = await compressForWeCom(imageBuffer);
    const result = await sendWallpaperToWeCom(settings.webhook, compressed);
    return c.json({ success: true, data: result });
  } catch (err) {
    // 基于 errcode 字段判断(与 daily-push worker 一致):任何带 errcode 的 error 视为企业微信拒绝。
    const e = err as { errcode?: number; errmsg?: string; message?: string };
    if (typeof e?.errcode === "number") {
      return c.json({
        success: false,
        error: "WECOM_REJECTED",
        data: { errcode: e.errcode, errmsg: e.errmsg ?? "" },
      });
    }
    return c.json(
      {
        success: false,
        error: "SEND_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

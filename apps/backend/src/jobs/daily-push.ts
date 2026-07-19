import { readFile } from "node:fs/promises";
/**
 * daily-push Worker：每天北京时间 10:00 把当日精选合成壁纸推送到企业微信群。
 *
 * 流程（设计文档 4 改动面 - 后端定时任务）：
 * 1. 读 settings.push.wechat.{webhook,enabled}：
 *    - enabled=false → skip + log（场景 4）
 *    - webhook 空 → skip + log reason=no_webhook（场景 7）
 * 2. 取当天 daily_pick（beijingDateOf）：无 → skip + log reason=no_pick（场景 5）
 * 3. 解析 composedImagePath；缺失则尝试 composedCachePath 兜底读取
 * 4. compressForWeCom → sendWallpaperToWeCom
 *    - errcode=0 → log `[daily-push] success ...`（场景 1.P3）
 *    - errcode≠0 → log `[daily-push] failed ...` + throw（场景 6.P1，触发 BullMQ 重试）
 *    - 网络异常 → log `[daily-push] failed ...` + throw（同上）
 *
 * 结构化状态行约定：`[daily-push] <state> key=value ...`
 *   state ∈ { success, skipped, failed }
 *   skipped reason ∈ { disabled, no_webhook, no_pick }
 *
 * QA 时 worker 进程 stdout 重定向到 /tmp/autopilot-artifacts/worker-stdout.log 供 fs-grep。
 */
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { beijingDateOf } from "../lib/datetime";
import {
  WECOM_WEBHOOK_REGEX,
  compressForWeCom,
  getDailyPushSettings,
  sendWallpaperToWeCom,
} from "../lib/push/wechat";
import { composedCachePath } from "../lib/wallpaper/composer";

/** 默认合成尺寸（与 daily-selection 阶段 3 一致：5K 壁纸） */
const DEFAULT_WALLPAPER_WIDTH = 5120;
const DEFAULT_WALLPAPER_HEIGHT = 2880;

/**
 * daily-push Worker。
 *
 * @param job BullMQ Job。job.data.pickDate 可覆盖（手动 / 回填用）；默认今天（北京时间）。
 */
export async function dailyPushWorker(job: Job): Promise<void> {
  const overrideDate = (job.data as { pickDate?: string } | undefined)?.pickDate;
  const pickDate = overrideDate ?? beijingDateOf(new Date());
  job.log(`[daily-push] start pickDate=${pickDate}${overrideDate ? " (override)" : ""}`);

  // 1. 读开关与 webhook
  const settings = await getDailyPushSettings();
  if (!settings.enabled) {
    console.log(`[daily-push] skipped reason=disabled pickDate=${pickDate}`);
    job.log("[daily-push] skipped reason=disabled");
    return;
  }
  if (!settings.webhook || !WECOM_WEBHOOK_REGEX.test(settings.webhook)) {
    console.log(`[daily-push] skipped reason=no_webhook pickDate=${pickDate}`);
    job.log("[daily-push] skipped reason=no_webhook");
    return;
  }

  // 2. 查当天 daily_pick
  let pickRow: { pickDate: string; composedImagePath: string | null } | null = null;
  try {
    const rows = await db
      .select({
        pickDate: schema.dailyPicks.pickDate,
        composedImagePath: schema.dailyPicks.composedImagePath,
      })
      .from(schema.dailyPicks)
      .where(eq(schema.dailyPicks.pickDate, pickDate))
      .limit(1);
    pickRow =
      (rows[0] as { pickDate: string; composedImagePath: string | null } | undefined) ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[daily-push] failed reason=db_error pickDate=${pickDate} err=${msg}`);
    job.log(`[daily-push] failed reason=db_error: ${msg}`);
    throw err;
  }

  if (!pickRow) {
    console.log(`[daily-push] skipped reason=no_pick pickDate=${pickDate}`);
    job.log("[daily-push] skipped reason=no_pick");
    return;
  }

  // 3. 解析合成壁纸路径：DB 存的优先，否则尝试默认缓存路径
  let composedPath = pickRow.composedImagePath;
  if (!composedPath) {
    composedPath = composedCachePath(pickDate, DEFAULT_WALLPAPER_WIDTH, DEFAULT_WALLPAPER_HEIGHT);
    job.log(`[daily-push] composedImagePath 缺失，尝试默认缓存: ${composedPath}`);
  }

  // 4. 读 jpg → 压缩 → 发送
  let imageBuffer: Buffer;
  try {
    imageBuffer = await readFile(composedPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `[daily-push] failed reason=read_failed pickDate=${pickDate} path=${composedPath} err=${msg}`,
    );
    job.log(`[daily-push] failed reason=read_failed: ${msg}`);
    throw err;
  }

  try {
    const compressed = await compressForWeCom(imageBuffer);
    const result = await sendWallpaperToWeCom(settings.webhook, compressed);
    console.log(
      `[daily-push] success pickDate=${pickDate} errcode=${result.errcode} errmsg=${result.errmsg}`,
    );
    job.log(`[daily-push] success errcode=${result.errcode}`);
    return;
  } catch (err) {
    // 基于 errcode 字段判断(而非错误类):任何带 errcode 的 error(含 WeComRejectedError 与
    // Object.assign(new Error(), {errcode}) 形态)都视为企业微信拒绝,输出 errcode/errmsg 供 QA 观测。
    const e = err as { errcode?: number; errmsg?: string; message?: string };
    if (typeof e?.errcode === "number") {
      console.log(
        `[daily-push] failed pickDate=${pickDate} errcode=${e.errcode} errmsg=${e.errmsg ?? ""}`,
      );
      job.log(`[daily-push] failed errcode=${e.errcode} errmsg=${e.errmsg}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[daily-push] failed pickDate=${pickDate} reason=send_error err=${msg}`);
      job.log(`[daily-push] failed reason=send_error: ${msg}`);
    }
    throw err;
  }
}

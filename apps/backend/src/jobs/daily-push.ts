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
 * 4. 横版壁纸：compressForWeCom → sendWallpaperToWeCom
 *    - errcode=0 → log `[daily-push] success ...`（场景 1.P3）
 *    - errcode≠0 → log `[daily-push] failed ...` + throw（场景 6.P1，触发 BullMQ 重试）
 *    - 网络异常 → log `[daily-push] failed ...` + throw（同上）
 * 5. 竖版手机壁纸（1290×2796）：横版成功后追加，best-effort（失败只 log 不阻断/不重试）。
 *    缓存优先，缺失现场 composeAndSave 兜底。
 * 6. 文字导读消息：横版+竖版发完后追加，best-effort。今日精选数量 + hero 标题
 *    + 叙事摘要 + 画廊当天深链（galleryPublicUrl/#/?date=），给读者点击的理由。
 *
 * 结构化状态行约定：`[daily-push] <state> [key=value ...] [variant=portrait|summary]`
 *   state ∈ { success, skipped, failed }
 *   skipped reason ∈ { disabled, no_webhook, no_pick }
 *   variant 标记竖版/文字导读（best-effort，不阻断横版）
 *
 * QA 时 worker 进程 stdout 重定向到 /tmp/autopilot-artifacts/worker-stdout.log 供 fs-grep。
 */
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
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

/** 竖版手机壁纸尺寸（与 daily-selection 阶段 3 竖版预生成一致） */
const PORTRAIT_WALLPAPER_WIDTH = 1290;
const PORTRAIT_WALLPAPER_HEIGHT = 2796;

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

    // 竖版手机壁纸推送（1290×2796）——横版成功后追加，独立 try/catch。
    // 竖版失败仅 log，不阻断横版（已 success）、不触发重试（AP-5）。
    // 优先读预生成缓存（与 daily-selection 阶段3 / 路由同 cacheKey），缺失则现场合成兜底。
    // 日志前缀遵循 `[daily-push] (success|skipped|failed)` 契约（竖版用 variant=portrait 区分）。
    await pushPortraitWallpaper(job, settings.webhook, pickDate, pickRow).catch((portraitErr) => {
      const msg = portraitErr instanceof Error ? portraitErr.message : String(portraitErr);
      job.log(`[daily-push] failed variant=portrait non_blocking err=${msg}`);
      console.log(`[daily-push] failed pickDate=${pickDate} variant=portrait err=${msg}`);
    });

    // 文字导读消息（横版+竖版发完后追加）：今日精选数量 + hero 标题 + 叙事摘要 + 画廊当天深链，
    // 给读者点击进入画廊的理由（纯发两张图没上下文）。
    // best-effort（同竖版契约）：失败只 log，不阻断横版（已 success）、不触发重试。
    await pushDailySummaryText(job, settings.webhook, pickDate).catch((summaryErr) => {
      const msg = summaryErr instanceof Error ? summaryErr.message : String(summaryErr);
      job.log(`[daily-push] failed variant=summary non_blocking err=${msg}`);
      console.log(`[daily-push] failed pickDate=${pickDate} variant=summary err=${msg}`);
    });

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

/**
 * 竖版手机壁纸推送（1290×2796）。
 *
 * 流程：读缓存 `composedCachePath(pickDate,1290,2796)` → 缺失则现场 `composeAndSave` 兜底
 *      → compressForWeCom → sendWallpaperToWeCom（第二条 image 消息）。
 *
 * 独立 try/catch：任何失败只抛出到调用方 `.catch` 记 log，不阻断横版（已 success）。
 * 现场兜底需查 dailyPicks 完整行 + hero photo 组装 composer 入参。
 */
async function pushPortraitWallpaper(
  job: Job,
  webhook: string,
  pickDate: string,
  pickRow: { pickDate: string; composedImagePath: string | null },
): Promise<void> {
  const portraitCachePath = composedCachePath(
    pickDate,
    PORTRAIT_WALLPAPER_WIDTH,
    PORTRAIT_WALLPAPER_HEIGHT,
  );

  let portraitBuffer: Buffer;
  try {
    portraitBuffer = await readFile(portraitCachePath);
    job.log(`[daily-push] portrait cache hit: ${portraitCachePath}`);
  } catch {
    // 缓存缺失，现场合成兜底
    job.log(`[daily-push] portrait cache miss, fallback compose: ${portraitCachePath}`);

    // 查 dailyPicks 完整行 + hero photo（composer 需要 pick.title/narrative/members + photo）
    const fullPickRows = await db
      .select()
      .from(schema.dailyPicks)
      .where(eq(schema.dailyPicks.pickDate, pickDate))
      .limit(1);
    const fullPick = fullPickRows[0];
    if (!fullPick) {
      throw new Error(`portrait fallback: dailyPicks ${pickDate} 未找到（无法现场合成）`);
    }

    const photoRows = await db
      .select()
      .from(schema.photos)
      .where(eq(schema.photos.id, fullPick.photoId))
      .limit(1);
    const heroPhoto = photoRows[0];
    if (!heroPhoto) {
      throw new Error(`portrait fallback: hero photo ${fullPick.photoId} 未找到`);
    }

    const { composeAndSave } = await import("../lib/wallpaper/composer");
    await composeAndSave({
      pick: { ...fullPick, composedImageUrl: null },
      photo: heroPhoto,
      width: PORTRAIT_WALLPAPER_WIDTH,
      height: PORTRAIT_WALLPAPER_HEIGHT,
    });
    portraitBuffer = await readFile(portraitCachePath);
    job.log("[daily-push] portrait fallback composed ok");
  }

  const portraitCompressed = await compressForWeCom(portraitBuffer);
  const portraitResult = await sendWallpaperToWeCom(webhook, portraitCompressed);
  console.log(
    `[daily-push] success pickDate=${pickDate} variant=portrait errcode=${portraitResult.errcode}`,
  );
  job.log(`[daily-push] success variant=portrait errcode=${portraitResult.errcode}`);
}

/**
 * 文字导读消息（横版+竖版发完后追加）：今日精选数量 + hero 标题 + 叙事摘要 + 画廊当天深链。
 *
 * 流程：查 dailyPicks hero（title/narrative）+ dailyPickEntries 数量 → 拼文案 → sendWeComText。
 * 独立 try/catch（调用方 .catch）：失败只 log，不阻断横版（已 success）。
 * 数量用 `select photoId → rows.length`（复用 backfill-gallery.ts 范式，mock 友好且真实场景正确）。
 */
async function pushDailySummaryText(job: Job, webhook: string, pickDate: string): Promise<void> {
  const pickRows = await db
    .select({
      id: schema.dailyPicks.id,
      title: schema.dailyPicks.title,
      narrative: schema.dailyPicks.narrative,
    })
    .from(schema.dailyPicks)
    .where(eq(schema.dailyPicks.pickDate, pickDate))
    .limit(1);
  const pick = pickRows[0] as
    | { id: string; title: string | null; narrative: string | null }
    | undefined;
  if (!pick) {
    job.log("[daily-push] skipped variant=summary reason=no_pick");
    return;
  }

  const entryRows = await db
    .select({ photoId: schema.dailyPickEntries.photoId })
    .from(schema.dailyPickEntries)
    .where(eq(schema.dailyPickEntries.dailyPickId, pick.id));
  const n = entryRows.length;
  if (n === 0) {
    job.log("[daily-push] skipped variant=summary reason=no_entries");
    return;
  }

  const url = `${config.galleryPublicUrl}/#/?date=${pickDate}`;
  const narrative = (pick.narrative ?? "").slice(0, 80);
  const content = `🖼️ 今日精选 ${n} 张\n\n「${pick.title ?? ""}」\n${narrative}\n\n查看 → ${url}`;

  const { sendWeComText } = await import("../lib/push/wechat-text");
  await sendWeComText(webhook, content);
  console.log(`[daily-push] success pickDate=${pickDate} variant=summary`);
  job.log("[daily-push] success variant=summary");
}

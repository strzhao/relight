import { mkdir } from "node:fs/promises";
import path from "node:path";
/**
 * daily-video Worker：每天北京时间 03:00 自动生成「照片→叙事短片」视频。
 *
 * 流程（设计文档架构）：
 * 1. discoverVideoCandidates() 主题发现（旅行 + 人物成长线）
 *    - 无候选 → 空完成（不推送，场景 THEME-DISCOVERY-NO-CANDIDATE-SKIP）
 * 2. 选 1 个候选（新鲜度最高）→ runVideoGeneration（spawn claude -p）
 *    - 失败 → 写 failed 行 → 不推送（场景 NO-PUSH-ON-NO-VIDEO / FAILURE-NO-DEGRADE）
 * 3. 成功 → 事务写 videos（completed）+ videoUsages（去重行）
 * 4. 推送企业微信（标题 + 视频链接，场景 WECOM-PUSH-ON-NEW-VIDEO；封面不再推群——首帧文字卡不好看）
 *
 * 时序：daily-selection 0:00 / scan 2:00 之后，push 10:00 之前，避开 CPU/GPU 竞争。
 */
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { WECOM_WEBHOOK_REGEX, getDailyPushSettings } from "../lib/push/wechat";
import {
  type VideoGenResult,
  type VideoTheme,
  runVideoGeneration,
} from "../lib/video/claude-runner";
import { discoverVideoCandidates } from "./video-discovery";

/** 视频缓存目录：<STORAGE_ROOT>/.video-cache/ */
function videoCacheDir(): string {
  return path.join(config.storageRoot, ".video-cache");
}

/** 视频输出路径：<cache>/<themeKind>-<themeKey>.mp4 */
function videoOutputPath(themeKind: string, themeKey: string): string {
  return path.join(videoCacheDir(), `${themeKind}-${themeKey}.mp4`);
}

/** 元数据路径：<cache>/<themeKey>.json */
function videoMetaPath(themeKey: string): string {
  return path.join(videoCacheDir(), `${themeKey}.json`);
}

/** 封面路径：<cache>/<themeKind>-<themeKey>.jpg（skill 生成 mp4 时同目录出封面） */
function videoCoverPath(themeKind: string, themeKey: string): string {
  return path.join(videoCacheDir(), `${themeKind}-${themeKey}.jpg`);
}

/**
 * daily-video Worker。
 *
 * @param job BullMQ Job。job.data 可含 { skipPush?: boolean }（测试用）。
 */
export async function dailyVideoWorker(job: Job): Promise<void> {
  const skipPush = (job.data as { skipPush?: boolean } | undefined)?.skipPush === true;
  job.log("[daily-video] start");

  // 1. 主题发现
  const candidates = await discoverVideoCandidates();
  if (candidates.length === 0) {
    console.log("[daily-video] skipped reason=no_candidate");
    job.log("[daily-video] skipped reason=no_candidate");
    return;
  }
  // 选新鲜度最高的 1 个（已降序排序）
  const candidate = candidates[0];
  if (!candidate) {
    console.log("[daily-video] skipped reason=no_candidate_after_sort");
    job.log("[daily-video] skipped reason=no_candidate_after_sort");
    return;
  }
  job.log(
    `[daily-video] picked theme=${candidate.themeKind}/${candidate.themeKey} (${candidate.titleHint}) photos=${candidate.photoIds.length}`,
  );

  // 2. 准备产物路径 + 确保目录存在
  await mkdir(videoCacheDir(), { recursive: true });
  const outputPath = videoOutputPath(candidate.themeKind, candidate.themeKey);
  const metaPath = videoMetaPath(candidate.themeKey);
  const coverPath = videoCoverPath(candidate.themeKind, candidate.themeKey);

  // 3. spawn claude -p 生成视频
  const theme: VideoTheme = {
    themeKind: candidate.themeKind,
    themeKey: candidate.themeKey,
    titleHint: candidate.titleHint,
    photoIds: candidate.photoIds,
    personId: candidate.personId,
    toYear: candidate.toYear,
  };
  const result = await runVideoGeneration(theme, outputPath, metaPath);

  // 4. 事务写库（成功 completed / 失败 failed，均落 videos 行）
  let videoId: string | null = null;
  let pushed = false;
  const now = new Date().toISOString();

  if (result.ok) {
    const durationSec = await probeDurationSafe(outputPath, result.meta?.durationSec ?? 0);
    const photoIds = result.meta?.photoIds ?? candidate.photoIds;
    // 封面生成：mp4 成功后用 ffmpeg 抽首帧（skill 不产封面，worker 自给）
    await ensureCoverFromVideo(outputPath, coverPath, job);
    videoId = await writeCompletedVideo(
      {
        themeKind: candidate.themeKind,
        themeKey: candidate.themeKey,
        title: result.meta?.title ?? candidate.titleHint,
        outputPath,
        coverPath,
        durationSec,
        photoIds,
      },
      now,
    );
    console.log(
      `[daily-video] success theme=${candidate.themeKey} videoId=${videoId} duration=${durationSec}s`,
    );
    job.log(`[daily-video] success videoId=${videoId}`);

    // 4.5 画廊同步（上传 mp4 + 封面 + 刷 manifest 推 VPS）——独立 try/catch 旁路，
    // 失败不阻塞视频推送（画廊是旁路，容错契约 §契约规约）。
    try {
      const { syncVideoToGallery } = await import("../lib/gallery/sync");
      await syncVideoToGallery(
        {
          themeKey: candidate.themeKey,
          mp4Path: outputPath,
          coverPath,
        },
        (m: string) => job.log(m),
      );
    } catch (galleryErr) {
      job.log(
        `[gallery] 视频画廊同步失败（不阻塞推送）: ${
          galleryErr instanceof Error ? galleryErr.message : String(galleryErr)
        }`,
      );
    }

    // 5. 推送（除非 skipPush）
    if (!skipPush) {
      pushed = await pushVideoNotification(
        videoId,
        candidate.themeKey,
        candidate.titleHint,
        coverPath,
        job,
      );
    }
  } else {
    // 失败：写 failed 行（不降级、不重试渲染）
    videoId = await writeFailedVideo(
      {
        themeKind: candidate.themeKind,
        themeKey: candidate.themeKey,
        title: candidate.titleHint,
        outputPath,
        coverPath,
        errorMsg: result.err ?? "unknown",
      },
      now,
    );
    console.log(
      `[daily-video] failed theme=${candidate.themeKey} videoId=${videoId} err=${result.err}`,
    );
    job.log(`[daily-video] failed reason=spawn_error err=${result.err}`);
    // 失败不推送（场景 NO-PUSH-ON-NO-VIDEO）
  }

  job.log(`[daily-video] done pushed=${pushed}`);
}

interface CompletedVideoInput {
  themeKind: "trip" | "person";
  themeKey: string;
  title: string;
  outputPath: string;
  coverPath: string;
  durationSec: number;
  photoIds: string[];
}

/**
 * 写 completed videos 行 + videoUsages 去重行（事务）。
 *
 * 幂等语义：同 (themeKind, themeKey) 已有行时改为 UPDATE 接管为 completed——
 * failed 冷却（7 天）过期后重试成功是正常路径，裸 INSERT 会撞
 * UNIQUE(theme_kind, theme_key)（20260829 vietnam-2026：渲染成功却落库崩，
 * BullMQ 重试整段重渲染，日级死循环）。setWhere status='failed' 保留
 * 「已有 completed 行不覆盖」语义（与 writeFailedVideo 对称）。
 */
async function writeCompletedVideo(input: CompletedVideoInput, now: string): Promise<string> {
  const videoId = crypto.randomUUID();
  const db2 = (await import("../db")).db;

  db2.transaction((tx) => {
    tx.insert(schema.videos)
      .values({
        id: videoId,
        themeKind: input.themeKind,
        themeKey: input.themeKey,
        title: input.title,
        outputPath: input.outputPath,
        coverPath: input.coverPath,
        durationSec: input.durationSec,
        photoIds: input.photoIds,
        status: "completed",
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.videos.themeKind, schema.videos.themeKey],
        set: {
          title: input.title,
          outputPath: input.outputPath,
          coverPath: input.coverPath,
          durationSec: input.durationSec,
          photoIds: input.photoIds,
          status: "completed",
          errorMsg: null,
          createdAt: now,
        },
        setWhere: eq(schema.videos.status, "failed"),
      })
      .run();

    // videoUsages 去重行（每张 photoId 一行；person 主题的 photoIds 是选片结果）
    for (const photoId of input.photoIds) {
      tx.insert(schema.videoUsages)
        .values({
          themeKind: input.themeKind,
          themeKey: input.themeKey,
          photoId,
          consumedAt: now,
        })
        .run();
    }
  });
  return videoId;
}

interface FailedVideoInput {
  themeKind: "trip" | "person";
  themeKey: string;
  title: string;
  outputPath: string;
  coverPath: string;
  errorMsg: string;
}

/**
 * 写 failed videos 行（诊断用，不影响后续生成）。
 *
 * 幂等语义：同 (themeKind, themeKey) 已有行时改为 UPDATE 刷新 errorMsg/createdAt
 * （最后一次失败即 7 天冷却的起点，与 discovery 的 failed 冷却联动自洽；
 * 原 onConflictDoNothing 会把后续失败全部吞掉，errorMsg/createdAt 永不更新）。
 * setWhere status='failed' 保留原「同 themeKey 已有 completed 行时不覆盖」语义——
 * 冲突行已是 completed 时 WHERE 不命中，DO UPDATE 落空。
 */
async function writeFailedVideo(input: FailedVideoInput, now: string): Promise<string> {
  const videoId = crypto.randomUUID();
  const db2 = (await import("../db")).db;

  db2.transaction((tx) => {
    tx.insert(schema.videos)
      .values({
        id: videoId,
        themeKind: input.themeKind,
        themeKey: input.themeKey,
        title: input.title,
        outputPath: input.outputPath,
        coverPath: input.coverPath,
        status: "failed",
        errorMsg: input.errorMsg,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.videos.themeKind, schema.videos.themeKey],
        set: { errorMsg: input.errorMsg, createdAt: now },
        setWhere: eq(schema.videos.status, "failed"),
      })
      .run();
  });
  return videoId;
}

/** ffprobe 探测视频时长（失败用 fallback） */
async function probeDurationSafe(videoPath: string, fallback: number): Promise<number> {
  if (fallback > 0) return fallback;
  try {
    const { execFile } = await import("node:child_process");
    const dur = await new Promise<number>((resolve, reject) => {
      execFile(
        config.video.ffprobePath,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          videoPath,
        ],
        { encoding: "utf8" },
        (err, stdout) => {
          if (err) reject(err);
          else {
            const n = Number.parseFloat(stdout.trim());
            resolve(Number.isFinite(n) ? n : 0);
          }
        },
      );
    });
    return dur;
  } catch {
    return 0;
  }
}

/**
 * 从 mp4 抽首帧生成封面 jpg（skill 不产封面，worker 自给）。
 * ffmpeg -ss 0 -i mp4 -frames:v 1 -q:v 3 cover.jpg
 * 失败仅 log（推送时封面缺失会自动降级为只发文字消息）。
 */
async function ensureCoverFromVideo(videoPath: string, coverPath: string, job: Job): Promise<void> {
  try {
    const { access } = await import("node:fs/promises");
    try {
      await access(coverPath);
      return; // 封面已存在（skill 产出或历史生成）
    } catch {
      // 不存在，继续生成
    }
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      execFile(
        config.video.ffmpegPath,
        ["-y", "-ss", "0", "-i", videoPath, "-frames:v", "1", "-q:v", "3", coverPath],
        { encoding: "utf8" },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
    job.log(`[daily-video] cover generated: ${coverPath}`);
  } catch (e) {
    job.log(
      `[daily-video] cover 生成失败（推送将降级为纯文字）: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** 推送企业微信：标题 + 视频链接（封面不再推群，保留生成给画廊）*/
async function pushVideoNotification(
  videoId: string,
  themeKey: string,
  titleHint: string,
  coverPath: string,
  job: Job,
): Promise<boolean> {
  const settings = await getDailyPushSettings();
  if (!settings.enabled) {
    job.log("[daily-video] push skipped reason=disabled");
    return false;
  }
  if (!settings.webhook || !WECOM_WEBHOOK_REGEX.test(settings.webhook)) {
    job.log("[daily-video] push skipped reason=no_webhook");
    return false;
  }

  // 封面不再推送到群（视频首帧多为文字卡，作封面不好看）；coverPath 仍持久化给画廊卡片，参数此处不用
  void coverPath;

  // 画廊公网 URL（修 localhost bug，state.md §契约规约 公网 URL 契约）：
  //   `config.galleryPublicUrl + /#/video/<themeKey>`（hash 路由，静态站渲染）
  //   <id> 段必须用 themeKey（前端 data-video-id = manifest.videos[].themeKey，
  //   用 videos.id（UUID）拼链接前端 querySelector 永远 miss → 深链 100% 失效）；
  //   videoId 仅用于日志排查。
  const videoUrl = `${config.galleryPublicUrl}/#/video/${themeKey}`;
  const textMsg = `🎬 新视频：${titleHint}\n观看：${videoUrl}`;

  // 发文字消息
  try {
    const { sendWeComText } = await import("../lib/push/wechat-text");
    await sendWeComText(settings.webhook, textMsg);
    job.log("[daily-video] push text sent");
  } catch (e) {
    job.log(`[daily-video] push text failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log(`[daily-video] pushed videoId=${videoId} title=${titleHint}`);
  return true;
}

/** 仅用于类型断言：避免 VideoGenResult 未使用告警 */
export type { VideoGenResult };

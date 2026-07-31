/**
 * 画廊回填 CLI（state.md §组件设计 6 / §实现计划 P5）
 *
 * 扫历史 dailyPicks + videos → 上传所有资源到 COS + 首次全量生成 manifest 推 VPS。
 *
 * 复用模式：
 *   - parseArgs 风格参考 backfill-daily-picks.ts（args.includes + val(flag)）
 *   - 不复用 StubJob/dailySelectionWorker（画廊回填不重新精选，只上传已有产物）
 *   - 复用 lib/gallery/sync.ts 的 syncDayToGallery / syncVideoToGallery（含容错）
 *
 * 边界（§backfill 边界）：
 *   - 历史 ~13 天 composedImagePath 为 null → 跳过壁纸上传，manifest 该日壁纸字段留空
 *   - 缩略图 thumbnailPath 为 null → 跳过该 photo 上传
 *
 * 用法：
 *   pnpm --filter @relight/backend backfill:gallery -- --dry-run
 *   pnpm --filter @relight/backend backfill:gallery -- --yes
 *   pnpm --filter @relight/backend backfill:gallery -- --limit 10 --yes
 *
 * 退出码：
 *   0 = dry-run 或全部成功（含部分文件跳过）
 *   1 = 无可处理资源
 *   2 = manifest 推送失败（资源已上传但 VPS 未更新）
 */
import { asc, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import {
  buildManifest,
  photoThumbCosKey,
  videoCoverCosKey,
  videoMp4CosKey,
  wallpaperLandscapeCosKey,
  wallpaperPortraitCosKey,
} from "../lib/gallery/manifest";
import { pushManifest, uploadDayAssets, uploadVideoAssets } from "../lib/gallery/sync";

// ===== 参数解析 =====

interface ParsedArgs {
  dryRun: boolean;
  yes: boolean;
  limit: number | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0 && argv[i + 1]) return argv[i + 1];
    return undefined;
  };
  const limitStr = val("--limit");
  let limit: number | undefined;
  if (limitStr !== undefined) {
    limit = Number(limitStr);
    if (Number.isNaN(limit) || limit <= 0) {
      console.error("--limit 必须是正整数");
      process.exit(2);
    }
  }
  return {
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes"),
    limit,
    help: argv.includes("--help"),
  };
}

const HELP = `
画廊回填 CLI — 把历史 dailyPicks/videos 资源全量推到 COS + VPS manifest

用法:
  pnpm --filter @relight/backend backfill:gallery -- [options]

参数:
  --dry-run    只打印将上传的文件清单，不实际上传
  --yes        真正执行（未带此项且未带 --dry-run 时只打印计划退出 0）
  --limit N    限制处理的 dailyPicks 天数（videos 不受限）
  --help       显示本帮助

退出码:
  0 = dry-run，或全部成功（含部分文件跳过）
  1 = 无可处理资源
  2 = manifest 推送失败（资源已上传但 VPS 未更新）

边界:
  - composedImagePath 为 null 的日子跳过壁纸上传（manifest 该日壁纸字段留空）
  - 缩略图 thumbnailPath 为 null 的 photo 跳过上传
`;

// ===== 资源清单收集（dry-run 用）=====

interface DayAssets {
  pickDate: string;
  composedImagePath: string | null;
  photoIds: string[];
}

async function collectAssets(limit: number | undefined) {
  // dailyPicks 升序
  const picks = await db
    .select({
      id: schema.dailyPicks.id,
      pickDate: schema.dailyPicks.pickDate,
      composedImagePath: schema.dailyPicks.composedImagePath,
    })
    .from(schema.dailyPicks)
    .orderBy(asc(schema.dailyPicks.pickDate));

  // 查每个 pick 的 entries photoIds
  const dayAssets: DayAssets[] = [];
  for (const p of picks) {
    const entries = await db
      .select({ photoId: schema.dailyPickEntries.photoId })
      .from(schema.dailyPickEntries)
      .where(eq(schema.dailyPickEntries.dailyPickId, p.id))
      .orderBy(asc(schema.dailyPickEntries.rank));
    dayAssets.push({
      pickDate: p.pickDate,
      composedImagePath: p.composedImagePath,
      photoIds: entries.map((e) => e.photoId),
    });
  }

  // apply --limit（只限天数，不影响 videos）
  const limitedDays = limit && limit > 0 ? dayAssets.slice(0, limit) : dayAssets;

  // videos completed
  const videos = await db
    .select({
      themeKey: schema.videos.themeKey,
      outputPath: schema.videos.outputPath,
      coverPath: schema.videos.coverPath,
    })
    .from(schema.videos)
    .where(eq(schema.videos.status, "completed"))
    .orderBy(asc(schema.videos.createdAt));

  return { dayAssets: limitedDays, videos, totalDays: dayAssets.length };
}

// ===== main =====

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  console.log("=".repeat(72));
  console.log("  画廊回填 (backfill-gallery)");
  console.log("=".repeat(72));

  const { dayAssets, videos, totalDays } = await collectAssets(args.limit);

  const daysWithWallpaper = dayAssets.filter((d) => d.composedImagePath).length;
  const daysNullWallpaper = dayAssets.length - daysWithWallpaper;
  const totalPhotos = dayAssets.reduce((sum, d) => sum + d.photoIds.length, 0);

  console.log(
    `  天数: ${dayAssets.length} 天${args.limit ? `（--limit ${args.limit}，总 ${totalDays}）` : ""}`,
  );
  console.log(
    `    有壁纸: ${daysWithWallpaper} 天 | composedImagePath=null（跳壁纸）: ${daysNullWallpaper} 天`,
  );
  console.log(`    当日 entries 缩略图总计: ${totalPhotos} 张`);
  console.log(`  视频: ${videos.length} 条（completed）`);
  console.log(`  COS: ${config.cos.bucket} / ${config.cos.region} / prefix=${config.cos.prefix}`);
  console.log(
    `  VPS: ${config.gallery.vpsUser}@${config.gallery.vpsHost}:${config.gallery.vpsPath}`,
  );

  if (args.dryRun) {
    console.log("\n[dry-run] 将上传文件清单:");
    for (const d of dayAssets) {
      if (d.composedImagePath) {
        console.log(`  [壁纸] ${d.pickDate} landscape → ${wallpaperLandscapeCosKey(d.pickDate)}`);
        console.log(`  [壁纸] ${d.pickDate} portrait  → ${wallpaperPortraitCosKey(d.pickDate)}`);
      } else {
        console.log(`  [壁纸] ${d.pickDate} composedImagePath=null → 跳过`);
      }
      for (const pid of d.photoIds) {
        console.log(`  [缩略图] ${d.pickDate} photo=${pid} → ${photoThumbCosKey(pid)}`);
      }
    }
    for (const v of videos) {
      console.log(`  [视频] ${v.themeKey} mp4   → ${videoMp4CosKey(v.themeKey)}`);
      console.log(`  [视频] ${v.themeKey} cover → ${videoCoverCosKey(v.themeKey)}`);
    }
    console.log("\n[dry-run] 仅打印计划，未执行。加 --yes 真正执行。");
    process.exit(0);
  }

  if (!args.yes) {
    console.log("\n[plan-only] 已打印回填计划。加 --yes 真正执行，或加 --dry-run 做演练。");
    process.exit(0);
  }

  // ---- 执行 ----
  console.log(`\n开始回填 ${dayAssets.length} 天 + ${videos.length} 视频...\n`);

  let daysOk = 0;
  let daysFail = 0;
  for (let i = 0; i < dayAssets.length; i++) {
    const d = dayAssets[i];
    if (!d) continue;
    const t = Date.now();
    try {
      // 只上传当日资源（壁纸 + 缩略图），不刷 manifest（回填多天最后统一刷一次省 ssh）
      // composedImagePath 为 null 的日子 uploadDayAssets 自动跳过壁纸
      await uploadDayAssets(d.pickDate, d.composedImagePath, null, d.photoIds, (m: string) =>
        console.log(`  [${i + 1}/${dayAssets.length}] ${m}`),
      );
      daysOk++;
      console.log(
        `  [${i + 1}/${dayAssets.length}] ${d.pickDate} ✅ (${((Date.now() - t) / 1000).toFixed(1)}s)`,
      );
    } catch (err) {
      daysFail++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [${i + 1}/${dayAssets.length}] ${d.pickDate} ❌ ${msg}`);
    }
  }

  let videosOk = 0;
  let videosFail = 0;
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (!v) continue;
    try {
      await uploadVideoAssets(
        { themeKey: v.themeKey, mp4Path: v.outputPath, coverPath: v.coverPath },
        (m: string) => console.log(`  [video ${i + 1}/${videos.length}] ${m}`),
      );
      videosOk++;
      console.log(`  [video ${i + 1}/${videos.length}] ${v.themeKey} ✅`);
    } catch (err) {
      videosFail++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [video ${i + 1}/${videos.length}] ${v.themeKey} ❌ ${msg}`);
    }
  }

  // ---- 最后统一刷一次 manifest（全量） ----
  console.log("\n生成 manifest 并推送 VPS...");
  const manifest = await buildManifest();
  // pushManifest 返回 void（容错契约：失败 console.warn 不 throw）；推送结果见上方 [gallery/sync] 日志
  await pushManifest(manifest);

  console.log(`\n${"=".repeat(72)}`);
  console.log("  回填汇总 (backfill-gallery)");
  console.log("=".repeat(72));
  console.log(
    `  天数: ${dayAssets.length} | 成功 ${daysOk} | 失败 ${daysFail} | 视频: ${videos.length} | 成功 ${videosOk} | 失败 ${videosFail}`,
  );
  console.log("  manifest: 已尝试推送 VPS（失败见上方 [gallery/sync] warn，下次 job 会重推）");
  console.log("=".repeat(72));

  // 资源上传失败（daysFail/videosFail）才 exit 2；manifest 推送失败仅 warn（不致命，下次 job 重推）
  if (daysFail > 0 || videosFail > 0) process.exit(2);
  process.exit(0);
}

export default main;

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("backfill-gallery.ts") ||
    process.argv[1].endsWith("backfill-gallery.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("[backfill-gallery] 严重错误:", err);
    process.exit(2);
  });
}

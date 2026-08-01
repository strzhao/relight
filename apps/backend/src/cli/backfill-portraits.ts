/**
 * 历史竖版壁纸补生成 CLI
 *
 * 过去 N 天（默认 30）的 dailyPicks，对每天重新合成 1290×2796 竖版手机壁纸：
 *   1. 取 entries[0]（rank=0）的 hero 照片 + members
 *   2. composeAndSave 合成竖版本地（覆盖已有，"重新回跑"语义）
 *   3. 上传 COS（wallpaperPortraitCosKey）
 * 最后全量刷 manifest 推 VPS。
 *
 * 与 backfill:gallery 区别：gallery 是"上传已有产物"，本 CLI 是"重新合成 + 上传"（调 composer）。
 * 复用 daily-selection 阶段3 竖版合成的 pick/photo 组装（src/jobs/daily-selection.ts:706）。
 *
 * 用法：
 *   pnpm --filter @relight/backend backfill:portraits -- --dry-run
 *   pnpm --filter @relight/backend backfill:portraits -- --yes
 *   pnpm --filter @relight/backend backfill:portraits -- --days 30 --yes
 *
 * 退出码：
 *   0 = dry-run 或全部成功
 *   1 = 无可处理日期
 *   2 = 有合成/上传失败
 */
import { access } from "node:fs/promises";
import { asc, desc, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { uploadFile } from "../lib/cos/upload";
import { buildManifest, wallpaperPortraitCosKey } from "../lib/gallery/manifest";
import { pushManifest } from "../lib/gallery/sync";
import { composeAndSave, composedCachePath } from "../lib/wallpaper/composer";

// ===== 参数解析 =====

interface ParsedArgs {
  days: number;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0 && argv[i + 1]) return argv[i + 1];
    return undefined;
  };
  const daysStr = val("--days");
  let days = 30;
  if (daysStr !== undefined) {
    days = Number(daysStr);
    if (Number.isNaN(days) || days <= 0) {
      console.error("--days 必须是正整数");
      process.exit(2);
    }
  }
  return {
    days,
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes"),
    help: argv.includes("--help"),
  };
}

const HELP = `
历史竖版壁纸补生成 — 重新合成过去 N 天的 1290×2796 竖版手机壁纸

用法:
  pnpm --filter @relight/backend backfill:portraits -- [options]

参数:
  --days N    补最近 N 个有壁纸的精选日（默认 30）
  --dry-run   只打印清单（含本地是否已有竖版），不执行
  --yes       真正执行（重新合成 + 上传 + 刷 manifest）
  --help      显示本帮助

退出码:
  0 = dry-run 或全部成功
  1 = 无可处理日期
  2 = 有合成/上传失败
`;

// ===== 任务收集 =====

type PickRow = typeof schema.dailyPicks.$inferSelect;
type EntryRow = typeof schema.dailyPickEntries.$inferSelect;
type PhotoRow = typeof schema.photos.$inferSelect;

interface DayTask {
  pickDate: string;
  pick: PickRow;
  entry: EntryRow;
  photo: PhotoRow;
  hasLocalPortrait: boolean;
}

async function collectTasks(days: number): Promise<DayTask[]> {
  // 最近 N 个有横版壁纸的精选日（desc pickDate）
  const picks = await db
    .select()
    .from(schema.dailyPicks)
    .where(isNotNull(schema.dailyPicks.composedImagePath))
    .orderBy(desc(schema.dailyPicks.pickDate))
    .limit(days);

  const tasks: DayTask[] = [];
  for (const pick of picks) {
    const entry = await db
      .select()
      .from(schema.dailyPickEntries)
      .where(eq(schema.dailyPickEntries.dailyPickId, pick.id))
      .orderBy(asc(schema.dailyPickEntries.rank))
      .limit(1);
    const heroEntry = entry[0];
    if (!heroEntry) {
      console.warn(`  [跳过] ${pick.pickDate} 无 entries`);
      continue;
    }
    const photoRows = await db
      .select()
      .from(schema.photos)
      .where(eq(schema.photos.id, heroEntry.photoId))
      .limit(1);
    const heroPhoto = photoRows[0];
    if (!heroPhoto) {
      console.warn(`  [跳过] ${pick.pickDate} hero photoId=${heroEntry.photoId} 未找到`);
      continue;
    }
    // 本地竖版是否已存在（信息展示，执行时一律重新覆盖）
    let hasLocal = false;
    try {
      await access(composedCachePath(pick.pickDate, 1290, 2796));
      hasLocal = true;
    } catch {
      hasLocal = false;
    }
    tasks.push({
      pickDate: pick.pickDate,
      pick,
      entry: heroEntry,
      photo: heroPhoto,
      hasLocalPortrait: hasLocal,
    });
  }
  return tasks;
}

// ===== main =====

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  console.log("=".repeat(72));
  console.log("  竖版壁纸补生成 (backfill-portraits)");
  console.log("=".repeat(72));

  const tasks = await collectTasks(args.days);

  console.log(`  范围: 最近 ${args.days} 个有壁纸的精选日，实际命中 ${tasks.length} 天`);
  console.log(`  COS: ${config.cos.bucket} / ${config.cos.region} / prefix=${config.cos.prefix}`);

  if (tasks.length === 0) {
    console.log("\n无可处理日期，退出。");
    process.exit(1);
  }

  if (args.dryRun) {
    console.log("\n[dry-run] 将重新合成 + 上传竖版：");
    for (const t of tasks) {
      console.log(
        `  ${t.pickDate}  hero=${t.photo.id.slice(0, 8)}  本地竖版${t.hasLocalPortrait ? "已存在(将覆盖)" : "缺失(新生成)"}  → ${wallpaperPortraitCosKey(t.pickDate)}`,
      );
    }
    console.log("\n[dry-run] 仅打印计划，未执行。加 --yes 真正执行。");
    process.exit(0);
  }

  if (!args.yes) {
    console.log("\n[plan-only] 已打印计划。加 --yes 真正执行，或加 --dry-run 做演练。");
    process.exit(0);
  }

  console.log(`\n开始重新合成 ${tasks.length} 天竖版...\n`);

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t) continue;
    const start = Date.now();
    try {
      // 1. 重新合成（覆盖；pick/photo 组装与 daily-selection 阶段3 竖版一致）
      const portraitPath = await composeAndSave({
        pick: {
          ...t.pick,
          composedImageUrl: null,
          members: t.entry.members,
        },
        photo: t.photo,
        width: 1290,
        height: 2796,
      });
      // 2. 上传 COS
      await uploadFile(portraitPath, wallpaperPortraitCosKey(t.pickDate), "image/jpeg");
      ok++;
      console.log(
        `  [${i + 1}/${tasks.length}] ${t.pickDate} ✅ 合成+上传 (${((Date.now() - start) / 1000).toFixed(1)}s)`,
      );
    } catch (err) {
      fail++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [${i + 1}/${tasks.length}] ${t.pickDate} ❌ ${msg}`);
    }
  }

  // 3. 全量刷 manifest 推 VPS
  console.log("\n生成 manifest 并推送 VPS...");
  const manifest = await buildManifest();
  await pushManifest(manifest);

  console.log(`\n${"=".repeat(72)}`);
  console.log(`  汇总: 共 ${tasks.length} 天 | 成功 ${ok} | 失败 ${fail}`);
  console.log("=".repeat(72));

  if (fail > 0) process.exit(2);
  process.exit(0);
}

export default main;

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("backfill-portraits.ts") ||
    process.argv[1].endsWith("backfill-portraits.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("[backfill-portraits] 严重错误:", err);
    process.exit(2);
  });
}

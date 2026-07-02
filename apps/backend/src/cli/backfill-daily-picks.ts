/**
 * 每日精选回填 CLI
 *
 * 在指定日期范围内找出 dailyPicks 表中缺失的日期，逐日回填。
 *
 * 背景：每日精选由定时任务每天北京 00:00 触发，只跑「今天」。
 * 若某天因服务宕机 / 未开机 / 首次安装历史数据未回追等原因错过，
 * 该日的 dailyPicks 永久缺失——本 CLI 把这些缺口补回来。
 *
 * 底层复用：
 * - worker 支持 job.data.pickDate 覆盖（jobs/daily-selection.ts:284-289）
 * - 幂等写库：onConflictDoUpdate({ target: pickDate })
 * - 30 天去重窗对称 ±30d（乱序回填安全）
 *
 * 用法：
 *   pnpm --filter @relight/backend backfill:daily-picks -- --dry-run
 *   pnpm --filter @relight/backend backfill:daily-picks -- --from 2026-01-01 --to 2026-03-31 --dry-run
 *   pnpm --filter @relight/backend backfill:daily-picks -- --from 2026-01-01 --to 2026-03-31 --yes
 *   pnpm --filter @relight/backend backfill:daily-picks -- --from 2026-01-01 --to 2026-03-31 --enqueue --yes
 *   pnpm --filter @relight/backend backfill:daily-picks -- --force --yes           # 覆盖重跑整段
 *
 * 退出码：
 *   0 = dry-run，或有目标日期且全部成功（含「无候选」跳过）
 *   1 = 无可处理目标（范围空 / 无照片 / 全部已存在且未 --force）
 *   2 = 部分日期失败
 *
 * 已知限制：
 *   - 回填耗时 ∝ 缺失天数（进程内 ≈ 10min/日）；超大范围建议 --enqueue + worker
 *   - 空候选日期（多为早于最早照片的日期）会被 worker 跳过——默认 --from 已规避
 *   - 30 天去重边界在回填过程中为近似，按升序回填使边界效应最小
 */
import type { Job } from "bullmq";
import { and, asc, gte, isNotNull, lte } from "drizzle-orm";
import { db, schema } from "../db";
import { dailySelectionWorker } from "../jobs/daily-selection";
import { StubJob } from "./run-daily-selection";

// ===== 纯函数（导出供红队测试）=====

/**
 * ISO takenAt → Asia/Shanghai YYYY-MM-DD（用 en-US + timeZone 法，与 formatPickDate 同源）
 *
 * 与 jobs/daily-selection.ts:formatPickDate / cli/backfill-exif.ts:todayBeijing 同源写法。
 */
export function beijingDateOf(iso: string): string {
  const d = new Date(iso);
  const shanghai = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const y = shanghai.getFullYear();
  const m = String(shanghai.getMonth() + 1).padStart(2, "0");
  const day = String(shanghai.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 纯函数：[from..to] 逐日（含端点），过滤掉 existing 中已有的，升序返回。
 *
 * 用日期算术（构造 Date UTC 中午推进）避免月份溢出——
 * 朴素 "month+1/day=31" 写法会溢出到 02-31 之类的非法日期。
 *
 * 边界：from > to 返回 []。
 */
export function enumerateMissingDates(from: string, to: string, existing: Set<string>): string[] {
  const out: string[] = [];
  // 用 UTC 中午 12:00 推进，规避夏令时/时区切换导致的天漂移
  const start = new Date(`${from}T12:00:00Z`).getTime();
  const end = new Date(`${to}T12:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return [];
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (let t = start; t <= end; t += DAY_MS) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const s = `${y}-${m}-${day}`;
    if (!existing.has(s)) out.push(s);
  }
  return out;
}

// ===== 参数解析（复用 backfill-thumbnails 的 args.includes 风格）=====

interface ParsedArgs {
  from: string | undefined;
  to: string | undefined;
  limit: number | undefined;
  dryRun: boolean;
  force: boolean;
  enqueue: boolean;
  yes: boolean;
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
    from: val("--from"),
    to: val("--to"),
    limit,
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    enqueue: argv.includes("--enqueue"),
    yes: argv.includes("--yes"),
    help: argv.includes("--help"),
  };
}

const HELP = `
每日精选回填 CLI — 在指定范围内补回缺失的 dailyPicks 记录

用法:
  pnpm --filter @relight/backend backfill:daily-picks -- [options]

参数:
  --from YYYY-MM-DD   回填起始日期（含）
                      默认：最早照片 takenAt 的北京日期
  --to   YYYY-MM-DD   回填结束日期（含）
                      默认：今日北京日期
  --limit N           限制处理的缺失天数
  --dry-run           只打印计划，不执行（也用作安全演练）
  --force             不跳过已存在日期（覆盖重跑整段）
  --enqueue           改为入队 BullMQ 给 worker（而非进程内同步执行）
  --yes               真正执行（未带此项且未带 --dry-run 时只打印计划退出 0）
  --help              显示本帮助

退出码:
  0 = dry-run，或有目标日期且全部成功（含「无候选」跳过）
  1 = 无可处理目标（范围空 / 无照片 / 全部已存在且未 --force）
  2 = 部分日期失败

已知限制:
  - 回填耗时 ∝ 缺失天数（进程内 ≈ 10min/日）；超大范围建议 --enqueue + worker
  - 空候选日期（多为早于最早照片的日期）会被 worker 跳过——默认 --from 已规避
  - 30 天去重边界在回填过程中为近似，按升序回填使边界效应最小
`;

function todayBeijing(): string {
  return beijingDateOf(new Date().toISOString());
}

const ONE_DAY_MIN = 10; // 单日进程内预估耗时 ≈ 10min
const ONE_DAY_AI_CALLS = 80; // 单日预估 AI 调用次数 ≈ 80

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  console.log("=".repeat(72));
  console.log("  每日精选回填 (backfill-daily-picks)");
  console.log("=".repeat(72));

  // ---- 算 from / to ----
  // to = 今日北京日期（始终可算）；from = 显式 --from 优先，否则取最早照片 takenAt 的北京日期。
  // 显式 --from 时跳过照片查询——允许「有范围但无照片」：worker 对每日候选空 → skip → exit 0
  // （设计决策 6）。仅当 --from 缺失需算默认值时，无照片才 exit 1（设计 S3：无法确定默认范围）。
  const to = args.to ?? todayBeijing();
  let from: string;
  if (args.from) {
    from = args.from;
  } else {
    const minRow = await db
      .select({ takenAt: schema.photos.takenAt })
      .from(schema.photos)
      .where(isNotNull(schema.photos.takenAt))
      .orderBy(asc(schema.photos.takenAt))
      .limit(1);

    if (minRow.length === 0) {
      console.error("[!] 数据库中无照片（或所有照片 takenAt 为空），无法确定 --from 默认值");
      console.error("    请先用 scan-storage 扫描照片，或显式传 --from / --to");
      process.exit(1);
    }

    const earliest = minRow[0]?.takenAt;
    if (!earliest) {
      console.error("[!] 最早照片 takenAt 为空，无法确定 --from 默认值");
      console.error("    请显式传 --from / --to");
      process.exit(1);
    }
    from = beijingDateOf(earliest);
  }

  // 基本校验（预处理范围错误 = 无可处理目标 → exit 1；非「处理中部分失败」exit 2）
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    console.error("[!] --from / --to 必须是 YYYY-MM-DD 格式");
    process.exit(1);
  }
  // 用 UTC 中午构造以校验 from <= to
  const fromT = new Date(`${from}T12:00:00Z`).getTime();
  const toT = new Date(`${to}T12:00:00Z`).getTime();
  if (Number.isNaN(fromT) || Number.isNaN(toT)) {
    console.error("[!] --from / --to 不是合法日期");
    process.exit(1);
  }
  if (fromT > toT) {
    console.error(`[!] --from (${from}) 晚于 --to (${to})：范围空`);
    process.exit(1);
  }

  // ---- 查 dailyPicks.pickDate ∈ [from,to] 构造 existing ----
  const existingRows = await db
    .select({ pickDate: schema.dailyPicks.pickDate })
    .from(schema.dailyPicks)
    .where(and(gte(schema.dailyPicks.pickDate, from), lte(schema.dailyPicks.pickDate, to)));
  const existing = new Set(existingRows.map((r) => r.pickDate));

  // ---- 构造 targetDates ----
  let targetDates: string[];
  let mode: string;
  if (args.force) {
    targetDates = enumerateMissingDates(from, to, new Set()); // 整段全部日期
    mode = "force（覆盖重跑整段）";
  } else {
    targetDates = enumerateMissingDates(from, to, existing);
    mode = "skip-existing（仅补缺失）";
  }

  const totalDaysInRange = enumerateMissingDates(from, to, new Set()).length;
  const missingTotal = args.force ? totalDaysInRange : targetDates.length;

  // apply --limit
  const limited = args.limit && args.limit > 0 ? targetDates.slice(0, args.limit) : targetDates;
  const skippedByLimit = targetDates.length - limited.length;

  // ---- 打印计划 ----
  const estMin = limited.length * ONE_DAY_MIN;
  const estAi = limited.length * ONE_DAY_AI_CALLS;
  console.log(`  范围: ${from} → ${to}（共 ${totalDaysInRange} 天）`);
  console.log(`  模式: ${mode}`);
  console.log(
    `  目标日期: ${targetDates.length} 天${args.force ? "（含已存在，--force）" : "（缺失）"}`,
  );
  // 设计 S4：stdout 标注范围内「已存在跳过」的日期（默认 skip 模式下）
  if (!args.force && existing.size > 0) {
    const existingSorted = [...existing].sort();
    const preview = existingSorted.slice(0, 10).join(", ");
    const more = existingSorted.length > 10 ? ` ... (+${existingSorted.length - 10})` : "";
    console.log(`  已存在跳过: ${existing.size} 天（${preview}${more}）`);
  }
  if (skippedByLimit > 0) {
    console.log(
      `  --limit ${args.limit}: 实际处理 ${limited.length} 天，跳过 ${skippedByLimit} 天`,
    );
  } else {
    console.log(`  将处理: ${limited.length} 天`);
  }
  console.log(`  执行方式: ${args.enqueue ? "入队 BullMQ (--enqueue)" : "进程内顺序同步"}`);
  console.log(`  预估: ≈ ${estMin} min（进程内 ≈ ${ONE_DAY_MIN}min/日），AI 调用 ≈ ${estAi} 次`);
  if (limited.length > 0) {
    const preview = limited.slice(0, 10).join(", ");
    const more = limited.length > 10 ? ` ... (+${limited.length - 10})` : "";
    console.log(`  示例日期: ${preview}${more}`);
  }
  console.log("=".repeat(72));

  // ---- 闸门 ----
  if (limited.length === 0) {
    console.log("[ok] 无可处理的缺失日期（范围可能全已存在，或范围空）");
    process.exit(1);
  }

  if (args.dryRun) {
    console.log("[dry-run] 仅打印计划，未执行。加 --yes 真正执行。");
    process.exit(0);
  }

  if (!args.yes) {
    console.log("[plan-only] 已打印回填计划。加 --yes 真正执行，或加 --dry-run 做演练。");
    process.exit(0);
  }

  // ---- 执行 ----
  console.log(`\n开始回填 ${limited.length} 天（升序）...\n`);
  let success = 0;
  const noCandidate = 0;
  let failed = 0;
  const failures: { date: string; err: string }[] = [];
  const t0 = Date.now();

  // 动态 import 队列（仅 --enqueue 用，避免进程内模式强依赖 redis）
  let dailyQueue: {
    add: (name: string, data: Record<string, unknown>) => Promise<unknown>;
  } | null = null;
  if (args.enqueue) {
    const mod = await import("../jobs/queues");
    dailyQueue = mod.dailyQueue;
  }

  for (let i = 0; i < limited.length; i++) {
    const date = limited[i];
    if (!date) continue; // noUncheckedIndexedAccess 守卫；按构造 i < length 必为真
    const dt = Date.now();
    try {
      if (args.enqueue && dailyQueue) {
        await dailyQueue.add("backfill-daily", { pickDate: date });
        success++;
        const sec = ((Date.now() - dt) / 1000).toFixed(2);
        console.log(`  [${i + 1}/${limited.length}] ${date} ✅ enqueued (${sec}s)`);
      } else {
        const stub = new StubJob({ pickDate: date }) as unknown as Job;
        await dailySelectionWorker(stub);
        success++;
        const sec = ((Date.now() - dt) / 1000).toFixed(1);
        console.log(`  [${i + 1}/${limited.length}] ${date} ✅ done (${sec}s)`);
      }
    } catch (err) {
      // 单日失败不中断，记录后继续
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      // 简易「无候选」检测：worker 在候选池空时 return，正常不会 throw；
      // 这里把 throw 一律计为失败，红队验收以是否写库为准
      failures.push({ date, err: msg });
      const sec = ((Date.now() - dt) / 1000).toFixed(1);
      console.warn(`  [${i + 1}/${limited.length}] ${date} ❌ failed (${sec}s): ${msg}`);
    }
  }

  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);

  // ---- summary ----
  console.log(`\n${"=".repeat(72)}`);
  console.log("  回填汇总 (backfill-daily-picks)");
  console.log("=".repeat(72));
  console.log(
    `  范围: ${from} → ${to} | 处理: ${limited.length} 天 | 成功: ${success} | 无候选: ${noCandidate} | 失败: ${failed}`,
  );
  console.log(`  总耗时: ${elapsedMin} min`);
  if (failures.length > 0) {
    console.log("  失败日期（前 10）:");
    for (const f of failures.slice(0, 10)) {
      console.log(`    - ${f.date}: ${f.err}`);
    }
  }
  console.log("=".repeat(72));
  console.log(
    "  已知限制：回填耗时 ∝ 缺失天数（进程内 ≈ 10min/日）；空候选日期会被 worker 跳过；30 天去重边界为近似。",
  );

  // 退出码：0 全成功；2 部分失败
  if (failed > 0) process.exit(2);
  process.exit(0);
}

export default main;

// 仅在直接运行时执行 main()，import 时不触发（防止测试/复用纯函数时误执行）
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("backfill-daily-picks.ts") ||
    process.argv[1].endsWith("backfill-daily-picks.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("[backfill-daily-picks] 严重错误:", err);
    process.exit(2);
  });
}

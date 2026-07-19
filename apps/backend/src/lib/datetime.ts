/**
 * 共享日期工具：北京时间相关纯函数。
 *
 * 历史背景：原 `jobs/daily-selection.ts` 与 `cli/backfill-daily-picks.ts`
 * 各自有同名 `beijingDateOf` 实现。新 `jobs/daily-push.ts` 也需要同样的
 * 北京日期计算（决定取哪一天的 daily_pick），为避免循环依赖与多处复制，
 * 在此抽为共享模块。
 *
 * 行为契约：相同 Date 输入 → 与历史 daily-selection 实现返回完全相同的
 * YYYY-MM-DD 字符串。`daily-worker.acceptance.test.ts` 守护既有行为。
 */

/**
 * 任意 Date → 北京时间（Asia/Shanghai）YYYY-MM-DD 字符串。
 *
 * 实现：`date.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })`
 * 让 V8 完成 tz 偏移，再把得到的"看起来像本地时间"的字符串重新解析成 Date，
 * 最后取其 getFullYear/getMonth/getDate（这些 getter 走本地 tz，但前一步已
 * 把时间"挪到"了北京时区对应的瞬时值，所以取出的是北京日期分量）。
 *
 * 与原 `daily-selection.ts:25-31` 写法逐字等价（迁出而非重写）。
 */
export function beijingDateOf(date: Date): string {
  const shanghai = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const y = shanghai.getFullYear();
  const m = String(shanghai.getMonth() + 1).padStart(2, "0");
  const d = String(shanghai.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 当前瞬时的北京日期字符串（YYYY-MM-DD）。`beijingDateOf(new Date())` 语义糖。
 */
export function formatTodayBeijingDate(): string {
  return beijingDateOf(new Date());
}

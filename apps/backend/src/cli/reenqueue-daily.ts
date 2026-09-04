/** 一次性 CLI：按 pickDate 覆盖重跑 daily-selection（修复 qwen 宕机期间落库的默认文案） */
import { dailyQueue } from "../jobs/queues";

const dates = process.argv.slice(2);
if (dates.length === 0) {
  console.error("用法: tsx src/cli/reenqueue-daily.ts <YYYY-MM-DD> [更多日期...]");
  process.exit(1);
}

for (const pickDate of dates) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickDate)) {
    console.error(`非法日期: ${pickDate}`);
    process.exit(1);
  }
  await dailyQueue.add("backfill-daily", { pickDate });
  console.log(`enqueued daily-selection pickDate=${pickDate}`);
}
await dailyQueue.close();
process.exit(0);

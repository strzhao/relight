import type { Job } from "bullmq";
import { dailySelectionWorker } from "../jobs/daily-selection";

class StubJob {
  data: Record<string, unknown> = {};
  constructor(data: Record<string, unknown> = {}) {
    this.data = data;
  }
  log(line: string): Promise<void> {
    console.log(`[job] ${line}`);
    return Promise.resolve();
  }
  updateProgress(): Promise<void> {
    return Promise.resolve();
  }
}

function parseDateArg(): string | undefined {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === "--date");
  if (i >= 0 && args[i + 1]) return args[i + 1];
  for (const a of args) {
    if (a.startsWith("--date=")) return a.slice("--date=".length);
  }
  return undefined;
}

async function main(): Promise<void> {
  const pickDate = parseDateArg();
  console.log("=".repeat(72));
  console.log(`  手动触发每日精选${pickDate ? ` (date=${pickDate})` : "（与定时任务等价）"}`);
  console.log("=".repeat(72));

  const stub = new StubJob(pickDate ? { pickDate } : {}) as unknown as Job;
  const t0 = Date.now();
  await dailySelectionWorker(stub);
  console.log(`\n总耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("失败:", err);
    process.exit(1);
  });

import type { Job } from "bullmq";
import { dailySelectionWorker } from "../jobs/daily-selection";

class StubJob {
  data: Record<string, unknown> = {};
  log(line: string): Promise<void> {
    console.log(`[job] ${line}`);
    return Promise.resolve();
  }
  updateProgress(): Promise<void> {
    return Promise.resolve();
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("  手动触发每日精选（与定时任务等价）");
  console.log("=".repeat(72));

  const stub = new StubJob() as unknown as Job;
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

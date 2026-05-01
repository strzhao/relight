import type { Job } from "bullmq";

export async function dailySelectionWorker(job: Job): Promise<void> {
  job.log("开始每日精选");
  // TODO: 实现每日精选逻辑 — 从近期的照片中评分、选择最佳、生成文案、写入 daily_picks
  job.log("每日精选完成");
}

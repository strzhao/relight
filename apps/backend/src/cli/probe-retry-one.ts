import { analyzeQueue } from "../jobs/queues";

async function main() {
  const jobId = process.argv[2] ?? "3129";
  const job = await analyzeQueue.getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const stateBefore = await job.getState();
  console.log(`before: state=${stateBefore} attemptsMade=${job.attemptsMade}`);

  await job.retry();

  // 轮询 30 秒等结果
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const fresh = await analyzeQueue.getJob(jobId);
    if (!fresh) break;
    const s = await fresh.getState();
    if (s === "completed" || s === "failed") {
      console.log(`after: state=${s} attemptsMade=${fresh.attemptsMade}`);
      if (fresh.failedReason) console.log(`failedReason: ${fresh.failedReason.slice(0, 300)}`);
      process.exit(0);
    }
  }
  console.log("超过 30s 仍未完成，可能 worker 没有 pick up");
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

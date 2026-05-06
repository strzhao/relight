import { analyzeQueue } from "../jobs/queues";

async function main() {
  const failed = await analyzeQueue.getJobs(["failed"], 0, 10000);
  console.log(`重试 ${failed.length} 个失败 job...`);
  let ok = 0;
  let err = 0;
  for (const job of failed) {
    try {
      await job.retry();
      ok++;
    } catch (e) {
      err++;
      console.log(`retry job ${job.id} 失败: ${(e as Error).message}`);
    }
  }
  console.log(`已入队: ${ok} 成功, ${err} 失败`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

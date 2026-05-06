import { inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { analyzeQueue } from "../jobs/queues";

async function main() {
  const jobs = await analyzeQueue.getJobs(["failed"], 0, 1000);
  console.log(`# total failed: ${jobs.length}`);

  const photoIds = jobs
    .map((j) => (j.data as { photoId?: string }).photoId)
    .filter((id): id is string => typeof id === "string");
  const photoRows = photoIds.length
    ? await db
        .select({ id: schema.photos.id, filePath: schema.photos.filePath })
        .from(schema.photos)
        .where(inArray(schema.photos.id, photoIds))
    : [];
  const photoMap = new Map(photoRows.map((p) => [p.id, p.filePath]));

  // 取最近一次失败（按 finishedOn 排序）
  jobs.sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0));
  const top = jobs.slice(0, 3);
  for (const job of top) {
    const data = job.data as { photoId?: string };
    console.log("---");
    console.log(`jobId: ${job.id}`);
    console.log(`finishedOn: ${job.finishedOn ? new Date(job.finishedOn).toISOString() : "?"}`);
    console.log(`photoId: ${data.photoId}`);
    console.log(`filePath: ${data.photoId ? photoMap.get(data.photoId) : "?"}`);
    console.log(`attemptsMade: ${job.attemptsMade}`);
    console.log(`failedReason: ${job.failedReason ?? ""}`);
    const trace = Array.isArray(job.stacktrace)
      ? job.stacktrace.join("\n---trace---\n")
      : String(job.stacktrace ?? "");
    console.log(`stack:\n${trace}`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

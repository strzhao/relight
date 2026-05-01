import type { Job } from "bullmq";

interface ScanJobData {
  storageSourceId: string;
}

export async function scanStorageWorker(job: Job<ScanJobData>): Promise<void> {
  const { storageSourceId } = job.data;
  job.log(`开始扫描存储源: ${storageSourceId}`);
  // TODO: 实现扫描逻辑 — 遍历文件、计算 hash、写入 photos 表
  job.log("扫描完成");
}

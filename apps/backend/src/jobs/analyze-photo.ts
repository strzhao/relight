import type { Job } from "bullmq";

interface AnalyzeJobData {
  photoId: string;
}

export async function analyzePhotoWorker(job: Job<AnalyzeJobData>): Promise<void> {
  const { photoId } = job.data;
  job.log(`开始 AI 分析照片: ${photoId}`);
  // TODO: 实现 AI 分析逻辑 — 读文件、base64 编码、调用 aiClient.analyzePhoto、解析结果、写入 tags 和 photo_analyses
  job.log("AI 分析完成");
}

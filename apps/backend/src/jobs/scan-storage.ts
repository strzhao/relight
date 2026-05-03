import { createHash } from "node:crypto";
import path from "node:path";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { generateThumbnail } from "../lib/thumbnail";
import { createStorageAdapter } from "../storage";
import { analyzeQueue } from "./queues";

interface ScanJobData {
  storageSourceId: string;
  skipAnalysis?: boolean;
}

/**
 * scan-storage Worker
 *
 * 流程：
 * 1. 查找存储源
 * 2. 遍历目录获取所有图片文件
 * 3. SHA256 去重
 * 4. INSERT 新照片记录
 * 5. 生成缩略图
 * 6. 入队 analyze-photo 任务（skipAnalysis 时跳过）
 */
export async function scanStorageWorker(job: Job<ScanJobData>): Promise<void> {
  const { storageSourceId } = job.data;
  job.log(`开始扫描存储源: ${storageSourceId}`);

  const scanStartedAt = new Date().toISOString();
  let scannedCount = 0;
  let newCount = 0;
  let errorCount = 0;

  try {
    // 1. 查找存储源
    const sources = await db
      .select()
      .from(schema.storageSources)
      .where(eq(schema.storageSources.id, storageSourceId));

    const source = sources[0];
    if (!source) {
      throw new Error(`存储源不存在: ${storageSourceId}`);
    }

    job.log(`存储源: ${source.name} (${source.rootPath})`);

    // 2. 遍历目录获取图片文件
    const adapter = createStorageAdapter(source.type);
    const files = await adapter.listFiles(source.rootPath);
    scannedCount = files.length;
    job.log(`找到 ${scannedCount} 个图片文件`);

    // 收集所有 hash，批量查询已存在的
    const fileHashMap = new Map<string, (typeof files)[number]>();

    for (const file of files) {
      const buffer = await adapter.getFileBuffer(file.path);
      const hash = createHash("sha256").update(buffer).digest("hex");
      fileHashMap.set(hash, file);
    }

    // 查询已有照片的 hash
    const existingPhotos = await db
      .select({ fileHash: schema.photos.fileHash })
      .from(schema.photos)
      .where(eq(schema.photos.storageSourceId, storageSourceId));

    const existingHashes = new Set(existingPhotos.map((p) => p.fileHash));

    // 3. 去重：过滤新文件
    const newFileEntries = [...fileHashMap.entries()].filter(([hash]) => !existingHashes.has(hash));

    job.log(`新文件: ${newFileEntries.length}, 已存在: ${scannedCount - newFileEntries.length}`);

    // 4. 处理每个新文件
    const thumbnailDir = path.join(config.storageRoot, "thumbnails");

    for (const [hash, file] of newFileEntries) {
      try {
        const photoId = crypto.randomUUID();

        // 获取元信息
        const metadata = await adapter.getMetadata(file.path);

        const now = new Date().toISOString();

        // 生成缩略图
        let thumbnailPath: string | null = null;
        try {
          thumbnailPath = await generateThumbnail(file.path, thumbnailDir, photoId);
        } catch (thumbErr) {
          job.log(
            `缩略图生成失败 (${file.name}): ${thumbErr instanceof Error ? thumbErr.message : String(thumbErr)}`,
          );
        }

        // INSERT 照片记录
        await db.insert(schema.photos).values({
          id: photoId,
          storageSourceId,
          filePath: file.path,
          fileHash: hash,
          width: metadata.width ?? 0,
          height: metadata.height ?? 0,
          fileSize: file.size,
          thumbnailPath,
          takenAt: metadata.takenAt?.toISOString() ?? null,
          createdAt: now,
        });

        // 入队 analyze-photo 任务（skipAnalysis 时跳过）
        if (!job.data.skipAnalysis) {
          await analyzeQueue.add(`analyze:${photoId}`, { photoId });
        }

        newCount++;
      } catch (err) {
        errorCount++;
        job.log(`处理文件失败 (${file.name}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 5. 写入扫描日志
    await db.insert(schema.scanLogs).values({
      id: crypto.randomUUID(),
      storageSourceId,
      scannedCount,
      newCount,
      errorCount,
      startedAt: scanStartedAt,
      finishedAt: new Date().toISOString(),
    });

    // 6. 更新存储源最后扫描时间
    await db
      .update(schema.storageSources)
      .set({ lastScanAt: new Date().toISOString() })
      .where(eq(schema.storageSources.id, storageSourceId));

    job.log(`扫描完成: 扫描 ${scannedCount}, 新增 ${newCount}, 错误 ${errorCount}`);
  } catch (err) {
    // 即使失败也写入日志
    try {
      await db.insert(schema.scanLogs).values({
        id: crypto.randomUUID(),
        storageSourceId,
        scannedCount,
        newCount,
        errorCount: errorCount + 1,
        startedAt: scanStartedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch {
      // 日志写入失败，忽略
    }

    throw err;
  }
}

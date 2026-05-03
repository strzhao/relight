import { createHash } from "node:crypto";
import path from "node:path";
import type { ScanProgress } from "@relight/shared";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { generateThumbnail } from "../lib/thumbnail";
import { createStorageAdapter } from "../storage";
import { analyzeQueue } from "./queues";

interface ScanJobData {
  storageSourceId: string;
}

/** 每 N 个文件批量 updateProgress */
const PROGRESS_BATCH_SIZE = 10;

/**
 * scan-storage Worker
 *
 * 流程：
 * 1. 查找存储源
 * 2. 遍历目录获取所有图片文件
 * 3. SHA256 去重
 * 4. INSERT 新照片记录
 * 5. 生成缩略图
 * 6. 入队 analyze-photo 任务
 */
export async function scanStorageWorker(job: Job<ScanJobData>): Promise<void> {
  const { storageSourceId } = job.data;
  job.log(`开始扫描存储源: ${storageSourceId}`);

  const scanStartedAt = new Date().toISOString();
  let scannedCount = 0;
  let newCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  const pushProgress = async (phase: ScanProgress["phase"], extra?: Partial<ScanProgress>) => {
    const progress: ScanProgress = {
      phase,
      totalFiles: scannedCount,
      processed: skippedCount + newCount + errorCount,
      newCount,
      updatedCount: 0,
      skippedCount,
      errorCount,
      regeneratedCount: 0,
      ...extra,
    };
    try {
      await job.updateProgress(progress as unknown as number | object);
    } catch {
      // updateProgress 失败不影响扫描流程
    }
  };

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
    await pushProgress("listing", { totalFiles: 1, processed: 0 });

    const adapter = createStorageAdapter(source.type);
    const files = await adapter.listFiles(source.rootPath);
    scannedCount = files.length;
    job.log(`找到 ${scannedCount} 个图片文件`);

    // 收集所有 hash，批量查询已存在的
    const fileHashMap = new Map<string, (typeof files)[number]>();

    await pushProgress("hashing");

    let hashingProcessed = 0;
    for (const file of files) {
      const buffer = await adapter.getFileBuffer(file.path);
      const hash = createHash("sha256").update(buffer).digest("hex");
      fileHashMap.set(hash, file);

      hashingProcessed++;
      if (hashingProcessed % PROGRESS_BATCH_SIZE === 0) {
        await pushProgress("hashing");
      }
    }

    // 查询已有照片的 hash
    const existingPhotos = await db
      .select({ fileHash: schema.photos.fileHash })
      .from(schema.photos)
      .where(eq(schema.photos.storageSourceId, storageSourceId));

    const existingHashes = new Set(existingPhotos.map((p) => p.fileHash));

    // 3. 去重：过滤新文件
    const newFileEntries = [...fileHashMap.entries()].filter(([hash]) => !existingHashes.has(hash));
    skippedCount = scannedCount - newFileEntries.length;

    job.log(`新文件: ${newFileEntries.length}, 已存在: ${skippedCount}`);

    // 4. 处理每个新文件
    const thumbnailDir = path.join(config.storageRoot, "thumbnails");

    await pushProgress("processing");

    let processingCount = 0;
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

        // 入队 analyze-photo 任务
        await analyzeQueue.add(`analyze:${photoId}`, { photoId });

        newCount++;
      } catch (err) {
        errorCount++;
        job.log(`处理文件失败 (${file.name}): ${err instanceof Error ? err.message : String(err)}`);
      }

      processingCount++;
      if (processingCount % PROGRESS_BATCH_SIZE === 0) {
        await pushProgress("processing", { currentFile: file.name });
      }
    }

    // 5. 最终进度推送
    await pushProgress("completed", {
      totalFiles: scannedCount,
      processed: skippedCount + newCount + errorCount,
    });

    // 6. 写入扫描日志
    await db.insert(schema.scanLogs).values({
      id: crypto.randomUUID(),
      storageSourceId,
      scannedCount,
      newCount,
      errorCount,
      startedAt: scanStartedAt,
      finishedAt: new Date().toISOString(),
    });

    // 7. 更新存储源最后扫描时间
    await db
      .update(schema.storageSources)
      .set({ lastScanAt: new Date().toISOString() })
      .where(eq(schema.storageSources.id, storageSourceId));

    job.log(
      `扫描完成: 扫描 ${scannedCount}, 新增 ${newCount}, 跳过 ${skippedCount}, 错误 ${errorCount}`,
    );
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

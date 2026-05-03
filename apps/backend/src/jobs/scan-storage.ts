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
  scanLogId?: string;
  skipAnalysis?: boolean;
}

interface ExistingPhotoCache {
  id: string;
  filePath: string;
  fileHash: string;
  fileMtime: number | null;
  fileSize: number;
}

/** 每 N 个文件批量 updateProgress */
const PROGRESS_BATCH_SIZE = 10;

/**
 * scan-storage Worker
 *
 * 增量扫描流程：
 * 1. 查找存储源
 * 2. 查询所有已有照片（filePath + mtime + size）构建缓存
 * 3. 遍历目录，mtime+size 命中则跳过 SHA256（增量优化）
 * 4. 仅对新文件/修改文件执行 SHA256 + 缩略图生成
 * 5. INSERT 新记录 + UPDATE 变更记录
 * 6. 入队 analyze-photo 任务（skipAnalysis 时跳过）
 * 7. UPDATE scan_log（而非 INSERT）
 */
export async function scanStorageWorker(job: Job<ScanJobData>): Promise<void> {
  const { storageSourceId, scanLogId } = job.data;
  job.log(`开始扫描存储源: ${storageSourceId}`);

  const scanStartedAt = new Date().toISOString();
  let scannedCount = 0;
  let newCount = 0;
  let skippedCount = 0;
  let updatedCount = 0;
  let errorCount = 0;

  // 辅助函数：推送进度到 BullMQ + 更新 scan_log
  const pushProgress = async (phase: ScanProgress["phase"], extra?: Partial<ScanProgress>) => {
    const progress: ScanProgress = {
      phase,
      totalFiles: scannedCount,
      processed: skippedCount + newCount + updatedCount + errorCount,
      newCount,
      updatedCount,
      skippedCount,
      errorCount,
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

    // 2. 查询已有照片，构建 filePath → ExistingPhoto 缓存
    const existingPhotos = await db
      .select({
        id: schema.photos.id,
        filePath: schema.photos.filePath,
        fileHash: schema.photos.fileHash,
        fileMtime: schema.photos.fileMtime,
        fileSize: schema.photos.fileSize,
      })
      .from(schema.photos)
      .where(eq(schema.photos.storageSourceId, storageSourceId));

    const existingMap = new Map<string, ExistingPhotoCache>();
    for (const p of existingPhotos) {
      existingMap.set(p.filePath, p);
    }

    job.log(`已缓存 ${existingMap.size} 条已有记录`);

    // 3. 遍历目录获取媒体文件
    // 先用已有照片数作为 totalFiles 下界估计，避免 listing 阶段显示 0/0
    await pushProgress("listing", {
      totalFiles: Math.max(existingMap.size, 1),
      processed: 0,
    });

    const adapter = createStorageAdapter(source.type);
    const files = await adapter.listFiles(source.rootPath, (foundCount) => {
      void pushProgress("listing", {
        totalFiles: Math.max(foundCount, existingMap.size),
        processed: foundCount,
      });
    });
    scannedCount = files.length;
    job.log(`找到 ${scannedCount} 个媒体文件`);
    await pushProgress("hashing");

    // 4. 处理每个文件：mtime+size 快速路径 vs 完整 hash
    const newFiles: Array<{ hash: string; file: (typeof files)[number] }> = [];
    const updatedFiles: Array<{
      id: string;
      hash: string;
      file: (typeof files)[number];
    }> = [];

    let hashingProcessed = 0;
    for (const file of files) {
      const existing = existingMap.get(file.path);
      const fileMtime = Math.floor(file.modifiedAt.getTime() / 1000);

      if (existing && existing.fileMtime === fileMtime && existing.fileSize === file.size) {
        skippedCount++;
        hashingProcessed++;
        continue;
      }

      try {
        const buffer = await adapter.getFileBuffer(file.path);
        const hash = createHash("sha256").update(buffer).digest("hex");

        if (existing) {
          updatedFiles.push({ id: existing.id, hash, file });
        } else {
          newFiles.push({ hash, file });
        }
      } catch (err) {
        errorCount++;
        job.log(`读取文件失败 (${file.name}): ${err instanceof Error ? err.message : String(err)}`);
      }

      hashingProcessed++;

      // 每 N 个文件推送一次进度
      if (hashingProcessed % PROGRESS_BATCH_SIZE === 0) {
        await pushProgress("hashing");
      }
    }

    job.log(
      `跳过 ${skippedCount} (未变更), 新增 ${newFiles.length}, 更新 ${updatedFiles.length}, 错误 ${errorCount}`,
    );

    const thumbnailDir = path.join(config.storageRoot, "thumbnails");
    const now = new Date().toISOString();

    await pushProgress("processing");

    // 5a. 处理新文件
    let processingCount = 0;
    const totalProcessing = newFiles.length + updatedFiles.length;

    for (const { hash, file } of newFiles) {
      try {
        const photoId = crypto.randomUUID();
        const metadata = await adapter.getMetadata(file.path);
        const fileMtime = Math.floor(file.modifiedAt.getTime() / 1000);

        let thumbnailPath: string | null = null;
        try {
          thumbnailPath = await generateThumbnail(file.path, thumbnailDir, photoId);
        } catch (thumbErr) {
          job.log(
            `缩略图生成失败 (${file.name}): ${thumbErr instanceof Error ? thumbErr.message : String(thumbErr)}`,
          );
        }

        await db.insert(schema.photos).values({
          id: photoId,
          storageSourceId,
          filePath: file.path,
          fileHash: hash,
          width: metadata.width ?? 0,
          height: metadata.height ?? 0,
          fileSize: file.size,
          fileMtime,
          thumbnailPath,
          takenAt: metadata.takenAt?.toISOString() ?? null,
          createdAt: now,
        });

        if (!job.data.skipAnalysis) {
          await analyzeQueue.add(`analyze:${photoId}`, { photoId });
        }

        newCount++;
      } catch (err) {
        errorCount++;
        job.log(
          `处理新文件失败 (${file.name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      processingCount++;
      if (processingCount % PROGRESS_BATCH_SIZE === 0) {
        await pushProgress("processing");
      }
    }

    // 5b. 处理变更文件
    for (const { id, hash, file } of updatedFiles) {
      try {
        const fileMtime = Math.floor(file.modifiedAt.getTime() / 1000);

        await db
          .update(schema.photos)
          .set({
            fileHash: hash,
            fileSize: file.size,
            fileMtime,
          })
          .where(eq(schema.photos.id, id));

        updatedCount++;
      } catch (err) {
        errorCount++;
        job.log(`更新文件失败 (${file.name}): ${err instanceof Error ? err.message : String(err)}`);
      }

      processingCount++;
      if (processingCount % PROGRESS_BATCH_SIZE === 0) {
        await pushProgress("processing");
      }
    }

    // 6. 最终进度推送
    await pushProgress("completed", {
      totalFiles: scannedCount,
      processed: skippedCount + newCount + updatedCount + errorCount,
    });

    // 7. UPDATE scan_log（向后兼容：仅当 scanLogId 存在时更新）
    if (scanLogId) {
      await db
        .update(schema.scanLogs)
        .set({
          scannedCount,
          newCount,
          errorCount,
          finishedAt: new Date().toISOString(),
        })
        .where(eq(schema.scanLogs.id, scanLogId));
    }

    // 8. 更新存储源最后扫描时间
    await db
      .update(schema.storageSources)
      .set({ lastScanAt: new Date().toISOString() })
      .where(eq(schema.storageSources.id, storageSourceId));

    job.log(
      `扫描完成: 扫描 ${scannedCount}, 跳过 ${skippedCount}, 新增 ${newCount}, 更新 ${updatedCount}, 错误 ${errorCount}`,
    );
  } catch (err) {
    // 失败时也更新 scan_log
    if (scanLogId) {
      try {
        await db
          .update(schema.scanLogs)
          .set({
            scannedCount,
            newCount,
            errorCount: errorCount + 1,
            finishedAt: new Date().toISOString(),
          })
          .where(eq(schema.scanLogs.id, scanLogId));
      } catch {
        // 日志更新失败，忽略
      }
    }

    throw err;
  }
}

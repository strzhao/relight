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
}

interface ExistingPhotoCache {
  id: string;
  filePath: string;
  fileHash: string;
  fileMtime: number | null;
  fileSize: number;
}

/**
 * scan-storage Worker
 *
 * 增量扫描流程：
 * 1. 查找存储源
 * 2. 查询所有已有照片（filePath + mtime + size）构建缓存
 * 3. 遍历目录，mtime+size 命中则跳过 SHA256（增量优化）
 * 4. 仅对新文件/修改文件执行 SHA256 + 缩略图生成
 * 5. INSERT 新记录 + UPDATE 变更记录
 * 6. 入队 analyze-photo 任务
 */
export async function scanStorageWorker(job: Job<ScanJobData>): Promise<void> {
  const { storageSourceId } = job.data;
  job.log(`开始扫描存储源: ${storageSourceId}`);

  const scanStartedAt = new Date().toISOString();
  let scannedCount = 0;
  let newCount = 0;
  let skippedCount = 0;
  let updatedCount = 0;
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
      // 同一 filePath 可能因历史原因有多条记录，保留最新的
      existingMap.set(p.filePath, p);
    }

    job.log(`已缓存 ${existingMap.size} 条已有记录`);

    // 3. 遍历目录获取媒体文件
    const adapter = createStorageAdapter(source.type);
    const files = await adapter.listFiles(source.rootPath);
    scannedCount = files.length;
    job.log(`找到 ${scannedCount} 个媒体文件`);

    // 4. 处理每个文件：mtime+size 快速路径 vs 完整 hash
    const newFiles: Array<{ hash: string; file: (typeof files)[number] }> = [];
    const updatedFiles: Array<{
      id: string;
      hash: string;
      file: (typeof files)[number];
    }> = [];

    for (const file of files) {
      const existing = existingMap.get(file.path);
      const fileMtime = Math.floor(file.modifiedAt.getTime() / 1000);

      // 快速路径：同一文件路径 + mtime + size 匹配 → 跳过 SHA256
      if (
        existing &&
        existing.fileMtime === fileMtime &&
        existing.fileSize === file.size
      ) {
        skippedCount++;
        continue;
      }

      // 完整路径：读取文件内容，计算 SHA256
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
        job.log(
          `读取文件失败 (${file.name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    job.log(
      `跳过 ${skippedCount} (未变更), 新增 ${newFiles.length}, 更新 ${updatedFiles.length}, 错误 ${errorCount}`,
    );

    const thumbnailDir = path.join(config.storageRoot, "thumbnails");
    const now = new Date().toISOString();

    // 5a. 处理新文件
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

        await analyzeQueue.add(`analyze:${photoId}`, { photoId });
        newCount++;
      } catch (err) {
        errorCount++;
        job.log(
          `处理新文件失败 (${file.name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 5b. 处理变更文件（更新 hash + mtime + size，可选重新生成缩略图）
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
        job.log(
          `更新文件失败 (${file.name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

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
      `扫描完成: 扫描 ${scannedCount}, 跳过 ${skippedCount}, 新增 ${newCount}, 更新 ${updatedCount}, 错误 ${errorCount}`,
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

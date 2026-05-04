import path from "node:path";
import type { Job } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { generateThumbnail } from "../lib/thumbnail";
import { createStorageAdapter } from "../storage";
import { checkPathAccessibility } from "../storage/check-path";
import { analyzeQueue } from "./queues";

interface ScanJobData {
  storageSourceId: string;
}

/** 缩略图并发生成批大小 */
const THUMBNAIL_CONCURRENCY = 4;

/**
 * scan-storage Worker
 *
 * 流程：
 * 1. 查找存储源
 * 2. 遍历目录获取所有图片文件
 * 3. 流式 SHA256 去重（适配器 computeFileHash）
 * 4. 收集元信息 → 批量 INSERT（db.transaction 包裹）
 * 5. 并发生成缩略图（每批 4 个 Promise.all，失败不阻塞）
 * 6. 查询已有分析 → 跳过已分析 photo → addBulk 入队
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

    let files: Awaited<ReturnType<typeof adapter.listFiles>>;
    try {
      files = await adapter.listFiles(source.rootPath);
    } catch (listErr) {
      // 更新存储源可达性状态
      const checkResult = await checkPathAccessibility(source.rootPath);
      await db
        .update(schema.storageSources)
        .set({
          status: checkResult.status,
          lastError:
            checkResult.lastError ?? (listErr instanceof Error ? listErr.message : String(listErr)),
        })
        .where(eq(schema.storageSources.id, storageSourceId));

      job.log(
        `无法访问存储源 (${checkResult.status}): ${checkResult.lastError ?? (listErr instanceof Error ? listErr.message : String(listErr))}`,
      );
      throw listErr;
    }

    scannedCount = files.length;
    job.log(`找到 ${scannedCount} 个图片文件`);

    // 3. 流式计算每个文件的 SHA256 hash，构建 hash→file 映射
    const fileHashMap = new Map<string, (typeof files)[number]>();

    for (const file of files) {
      const hash = await adapter.computeFileHash(file.path);
      fileHashMap.set(hash, file);
    }

    // 查询已有照片的 hash
    const existingPhotos = await db
      .select({ fileHash: schema.photos.fileHash })
      .from(schema.photos)
      .where(eq(schema.photos.storageSourceId, storageSourceId));

    const existingHashes = new Set(existingPhotos.map((p) => p.fileHash));

    // 去重：过滤新文件
    const newEntries = [...fileHashMap.entries()].filter(([hash]) => !existingHashes.has(hash));

    job.log(`新文件: ${newEntries.length}, 已存在: ${scannedCount - newEntries.length}`);

    if (newEntries.length === 0) {
      job.log("没有新文件，扫描完成");
      await writeScanLog(storageSourceId, scannedCount, 0, 0, scanStartedAt);
      await updateLastScanAt(storageSourceId);
      return;
    }

    // 4. 收集新文件的元信息 + 构建 photoRecords 数组
    const thumbnailDir = path.join(config.storageRoot, "thumbnails");
    const now = new Date().toISOString();

    interface NewPhotoRecord {
      id: string;
      storageSourceId: string;
      filePath: string;
      fileHash: string;
      width: number;
      height: number;
      fileSize: number;
      thumbnailPath: string | null;
      takenAt: string | null;
      createdAt: string;
    }
    const photoRecords: NewPhotoRecord[] = [];

    for (const [hash, file] of newEntries) {
      try {
        const photoId = crypto.randomUUID();
        const metadata = await adapter.getMetadata(file.path);

        photoRecords.push({
          id: photoId,
          storageSourceId,
          filePath: file.path,
          fileHash: hash,
          width: metadata.width ?? 0,
          height: metadata.height ?? 0,
          fileSize: file.size,
          thumbnailPath: null,
          takenAt: metadata.takenAt?.toISOString() ?? null,
          createdAt: now,
        });
      } catch (err) {
        errorCount++;
        job.log(
          `获取元信息失败 (${file.name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (photoRecords.length === 0) {
      job.log("所有新文件元信息获取失败，扫描完成");
      await writeScanLog(storageSourceId, scannedCount, 0, errorCount, scanStartedAt);
      await updateLastScanAt(storageSourceId);
      return;
    }

    // 5. 批量 INSERT 照片记录（事务包裹，单条 SQL 多值）
    await db.transaction(async (tx) => {
      await tx.insert(schema.photos).values(photoRecords);
    });

    job.log(`批量插入 ${photoRecords.length} 张照片记录`);

    // 6. 并发生成缩略图（分批 4 并发，失败不阻塞）
    let thumbnailSuccessCount = 0;

    for (let i = 0; i < photoRecords.length; i += THUMBNAIL_CONCURRENCY) {
      const batch = photoRecords.slice(i, i + THUMBNAIL_CONCURRENCY);

      const results = await Promise.all(
        batch.map(async (record) => {
          try {
            const thumbnailPath = await generateThumbnail(record.filePath, thumbnailDir, record.id);
            return { photoId: record.id, thumbnailPath };
          } catch (thumbErr) {
            job.log(
              `缩略图生成失败 (${record.filePath}): ${thumbErr instanceof Error ? thumbErr.message : String(thumbErr)}`,
            );
            return { photoId: record.id, thumbnailPath: null as string | null };
          }
        }),
      );

      // 更新缩略图路径到数据库
      for (const result of results) {
        if (result.thumbnailPath) {
          await db
            .update(schema.photos)
            .set({ thumbnailPath: result.thumbnailPath })
            .where(eq(schema.photos.id, result.photoId));
          thumbnailSuccessCount++;
        }
      }
    }

    newCount = photoRecords.length;

    // 7. 查询已有分析记录，跳过已分析的 photo
    const newPhotoIds = photoRecords.map((p) => p.id);

    const existingAnalyses = await db
      .select({ photoId: schema.photoAnalyses.photoId })
      .from(schema.photoAnalyses)
      .where(inArray(schema.photoAnalyses.photoId, newPhotoIds));

    const analyzedPhotoIds = new Set(existingAnalyses.map((a) => a.photoId));

    const jobsToEnqueue = photoRecords.filter((p) => !analyzedPhotoIds.has(p.id));

    if (jobsToEnqueue.length > 0) {
      await analyzeQueue.addBulk(
        jobsToEnqueue.map((p) => ({
          name: `analyze:${p.id}`,
          data: { photoId: p.id },
        })),
      );
      job.log(`入队分析任务: ${jobsToEnqueue.length} 个 (跳过已分析 ${analyzedPhotoIds.size} 个)`);
    } else {
      job.log("所有新照片已有分析记录，跳过入队");
    }

    // 8. 写入扫描日志 + 更新最后扫描时间
    await writeScanLog(storageSourceId, scannedCount, newCount, errorCount, scanStartedAt);
    await updateLastScanAt(storageSourceId);

    job.log(
      `扫描完成: 扫描 ${scannedCount}, 新增 ${newCount}, 缩略图成功 ${thumbnailSuccessCount}/${newCount}, 错误 ${errorCount}`,
    );
  } catch (err) {
    // 即使失败也尝试写入日志
    await writeScanLog(
      storageSourceId,
      scannedCount,
      newCount,
      errorCount + 1,
      scanStartedAt,
    ).catch(() => {
      // 日志写入失败，忽略
    });

    throw err;
  }
}

/** 写入扫描日志 */
async function writeScanLog(
  storageSourceId: string,
  scannedCount: number,
  newCount: number,
  errorCount: number,
  startedAt: string,
): Promise<void> {
  await db.insert(schema.scanLogs).values({
    id: crypto.randomUUID(),
    storageSourceId,
    scannedCount,
    newCount,
    errorCount,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

/** 更新存储源最后扫描时间，并将状态设为 healthy */
async function updateLastScanAt(storageSourceId: string): Promise<void> {
  await db
    .update(schema.storageSources)
    .set({
      lastScanAt: new Date().toISOString(),
      status: "healthy",
      lastError: null,
    })
    .where(eq(schema.storageSources.id, storageSourceId));
}

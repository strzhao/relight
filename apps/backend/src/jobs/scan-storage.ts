import fs from "node:fs/promises";
import path from "node:path";
import type { Job } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { detectBursts } from "../lib/burst-detector";
import { config } from "../lib/config";
import { dHash } from "../lib/phash";
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
 * 清理孤儿记录 — 删除 DB 中存有但磁盘上已不存在的照片
 * @returns 清理的孤儿记录数（失败返回 0，不抛出）
 */
async function cleanupOrphans(
  storageSourceId: string,
  diskFiles: { path: string }[],
): Promise<number> {
  try {
    // 1. 构建磁盘路径集合
    const diskPaths = new Set(diskFiles.map((f) => f.path));

    // 2. 查询该存储源所有 DB 照片 (id, filePath, thumbnailPath)
    const dbPhotos = await db
      .select({
        id: schema.photos.id,
        filePath: schema.photos.filePath,
        thumbnailPath: schema.photos.thumbnailPath,
      })
      .from(schema.photos)
      .where(eq(schema.photos.storageSourceId, storageSourceId));

    // 3. 差集: DB有但磁盘无
    const orphans = dbPhotos.filter((p) => !diskPaths.has(p.filePath));
    if (orphans.length === 0) return 0;

    // 安全阀：孤儿比例 > 80% 且绝对数 > 50 时，判定为存储源不可用（如 NAS 断连），
    // 跳过清理避免误删全部记录
    if (orphans.length > 50) {
      const orphanRatio = orphans.length / dbPhotos.length;
      if (orphanRatio > 0.8) {
        console.error(
          `[cleanupOrphans] 已跳过清理: ${orphans.length}/${dbPhotos.length} 条记录被识别为孤儿 ` +
            `(比例 ${(orphanRatio * 100).toFixed(0)}%)，可能是存储源不可用`,
        );
        return 0;
      }
    }

    const orphanIds = orphans.map((p) => p.id);

    // 4. 同一事务: 先删 daily_picks 引用 + 再删 photos
    // drizzle better-sqlite3 的 transaction() 严格同步，禁止 async 回调
    // （async 回调会使 drizzle 抛 Transaction function cannot return a promise）
    db.transaction((tx) => {
      tx.delete(schema.dailyPicks).where(inArray(schema.dailyPicks.photoId, orphanIds)).run();
      tx.delete(schema.photos).where(inArray(schema.photos.id, orphanIds)).run();
    });
    // photo_tags 和 photo_analyses 通过 ON DELETE CASCADE 自动清理

    // 5. 清理缩略图文件 (用 thumbnailPath 精确删除)
    for (const orphan of orphans) {
      if (orphan.thumbnailPath) {
        fs.unlink(orphan.thumbnailPath).catch(() => {});
      }
    }

    return orphans.length;
  } catch (err) {
    console.error("孤儿记录清理失败:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}

/**
 * scan-storage Worker
 *
 * 流程：
 * 1. 查找存储源
 * 2. 遍历目录获取所有图片文件
 * 3. 流式 SHA256 去重（适配器 computeFileHash）
 * 4. 收集元信息 → 批量 INSERT（单条 bulk INSERT，SQLite 天然原子，无需事务包裹）
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
    job.log(`找到 ${scannedCount} 个文件`);

    // 输出格式分布，方便了解各格式数量
    const formatCounts = new Map<string, number>();
    for (const file of files) {
      const ext = path.extname(file.name).toLowerCase() || "(无扩展名)";
      formatCounts.set(ext, (formatCounts.get(ext) ?? 0) + 1);
    }
    const formatSummary = [...formatCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `${ext}: ${count}`)
      .join(", ");
    job.log(`格式分布: ${formatSummary}`);

    // ★ 孤儿记录清理（始终执行，早于提前返回）
    const cleaned = await cleanupOrphans(storageSourceId, files);
    if (cleaned > 0) {
      job.log(`清理 ${cleaned} 条孤儿记录（源文件已不存在）`);
    }

    // 3. 增量扫描：size+mtime 匹配的复用 DB hash 跳过昂贵的 SHA256（仅变更/新文件读全文件 hash）
    const existingPhotos = await db
      .select({
        filePath: schema.photos.filePath,
        fileHash: schema.photos.fileHash,
        fileSize: schema.photos.fileSize,
        fileMtime: schema.photos.fileMtime,
      })
      .from(schema.photos)
      .where(eq(schema.photos.storageSourceId, storageSourceId));
    const existingByPath = new Map(existingPhotos.map((p) => [p.filePath, p]));
    const existingHashes = new Set(existingPhotos.map((p) => p.fileHash));

    const fileHashMap = new Map<string, (typeof files)[number]>();
    let skippedUnchanged = 0;
    for (const file of files) {
      const existing = existingByPath.get(file.path);
      const fileMtime = file.modifiedAt ? Math.floor(file.modifiedAt.getTime() / 1000) : null;
      // size 匹配且（mtime 匹配 或 DB mtime 未记录）→ 内容未变更，复用 DB hash 跳过 SHA256
      if (
        existing &&
        existing.fileSize === file.size &&
        (existing.fileMtime === null || existing.fileMtime === fileMtime)
      ) {
        fileHashMap.set(existing.fileHash, file);
        skippedUnchanged++;
        continue;
      }
      const hash = await adapter.computeFileHash(file.path);
      fileHashMap.set(hash, file);
    }
    job.log(
      `增量扫描: 跳过 ${skippedUnchanged} 个未变更（size+mtime 匹配），计算 ${files.length - skippedUnchanged} 个文件 SHA256`,
    );

    // 去重：过滤新文件（hash 不在 DB）
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
      fileMtime: number | null;
      thumbnailPath: string | null;
      takenAt: string | null;
      createdAt: string;
      mediaType: "image" | "video";
      durationSec: number | null;
      videoCodec: string | null;
      videoFps: number | null;
      // GPS + 完整 EXIF meta（14 列，全部 nullable）
      latitude: number | null;
      longitude: number | null;
      altitude: number | null;
      gpsImgDirection: number | null;
      offsetTime: string | null;
      cameraMake: string | null;
      cameraModel: string | null;
      lensModel: string | null;
      focalLength: number | null;
      focalLength35mm: number | null;
      iso: number | null;
      exposureTime: number | null;
      fNumber: number | null;
      software: string | null;
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
          fileMtime: file.modifiedAt ? Math.floor(file.modifiedAt.getTime() / 1000) : null,
          thumbnailPath: null,
          takenAt: metadata.takenAt?.toISOString() ?? null,
          createdAt: now,
          mediaType: metadata.mediaType ?? "image",
          durationSec: metadata.durationSec ?? null,
          videoCodec: metadata.videoCodec ?? null,
          videoFps: metadata.videoFps ?? null,
          // GPS + 完整 EXIF meta（14 列）
          latitude: metadata.latitude ?? null,
          longitude: metadata.longitude ?? null,
          altitude: metadata.altitude ?? null,
          gpsImgDirection: metadata.gpsImgDirection ?? null,
          offsetTime: metadata.offsetTime ?? null,
          cameraMake: metadata.cameraMake ?? null,
          cameraModel: metadata.cameraModel ?? null,
          lensModel: metadata.lensModel ?? null,
          focalLength: metadata.focalLength ?? null,
          focalLength35mm: metadata.focalLength35mm ?? null,
          iso: metadata.iso ?? null,
          exposureTime: metadata.exposureTime ?? null,
          fNumber: metadata.fNumber ?? null,
          software: metadata.software ?? null,
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

    // 5. 批量 INSERT 照片记录
    // 单条 bulk INSERT 天然原子（better-sqlite3 单条 prepare+run 在隐式事务中）。
    // 不能用 db.transaction(async) — drizzle better-sqlite3 禁止 async 回调。
    await db.insert(schema.photos).values(photoRecords);

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

    // 6.5 计算新照片的 phash（从已生成缩略图读取），并检测连拍
    const newPhotoIdsWithThumbnail: string[] = [];
    for (const record of photoRecords) {
      if (record.thumbnailPath && record.mediaType !== "video") {
        try {
          const thumbBuf = await fs.readFile(record.thumbnailPath);
          const hash = await dHash(thumbBuf);
          await db
            .update(schema.photos)
            .set({ phash: hash })
            .where(eq(schema.photos.id, record.id));
          newPhotoIdsWithThumbnail.push(record.id);
        } catch (phashErr) {
          job.log(
            `phash 计算失败 (${record.filePath}): ${phashErr instanceof Error ? phashErr.message : String(phashErr)}`,
          );
        }
      }
    }

    // 连拍检测（失败不阻塞扫描主流程）
    if (newPhotoIdsWithThumbnail.length >= 2) {
      try {
        const burstResult = await detectBursts({
          storageSourceId,
          photoIds: newPhotoIdsWithThumbnail,
        });
        job.log(
          `连拍检测完成: 处理 ${burstResult.groupsCreated} 个连拍组，` +
            `${burstResult.photosGrouped} 张照片归入连拍组`,
        );
      } catch (burstErr) {
        job.log(
          `连拍检测失败（已忽略）: ${burstErr instanceof Error ? burstErr.message : String(burstErr)}`,
        );
      }
    }

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

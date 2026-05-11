/**
 * 一次性 EXIF 回填脚本
 *
 * 扫描所有 media_type = 'image' 且 exif_backfilled_at IS NULL 的照片，
 * 用 exifr 提取完整 EXIF 字段（14 列）并写入数据库，最后入队今日精选重跑。
 *
 * 用法：
 *   pnpm --filter @relight/backend tsx src/cli/backfill-exif.ts
 *
 * 幂等设计：
 *   - exif_backfilled_at IS NULL 作为 WHERE 条件，重跑不会重复处理
 *   - 即使 EXIF 全 null 的照片也会写入 exif_backfilled_at 标记（避免重跑误判）
 *
 * 退出码：
 *   0 = 全部成功（或部分失败但已记录）
 *   1 = 严重错误（无法连接数据库等）
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull, sql } from "drizzle-orm";
import pLimit from "p-limit";
import { db, schema } from "../db";
import { parseExifMeta } from "../lib/exif";

// CLI 入口：确保相对路径（如数据库）能正确解析
const backendRoot = (() => {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath && path.isAbsolute(dbPath)) {
    return path.resolve(dbPath, "../../");
  }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "../../");
})();
process.chdir(backendRoot);

/**
 * 生成北京时间 YYYY-MM-DD 格式的日期字符串（用于入队今日精选）
 */
function todayBeijing(): string {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const y = shanghai.getFullYear();
  const m = String(shanghai.getMonth() + 1).padStart(2, "0");
  const d = String(shanghai.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function main() {
  console.log("[backfill-exif] 开始 EXIF 回填...");

  // 查询需要回填的照片（图片 + 尚未回填）
  const photos = await db
    .select({
      id: schema.photos.id,
      filePath: schema.photos.filePath,
    })
    .from(schema.photos)
    .where(and(eq(schema.photos.mediaType, "image"), isNull(schema.photos.exifBackfilledAt)));

  console.log(`[backfill-exif] 待回填: ${photos.length} 张照片`);
  if (photos.length === 0) {
    console.log("[backfill-exif] 无待回填照片，退出");
    process.exit(0);
  }

  // pLimit(8) 并发处理
  const limit = pLimit(8);
  let successCount = 0;
  let failCount = 0;
  let gpsCount = 0;
  const now = Date.now();

  await Promise.all(
    photos.map((photo, idx) =>
      limit(async () => {
        try {
          const meta = await parseExifMeta(photo.filePath);

          await db
            .update(schema.photos)
            .set({
              latitude: meta.latitude,
              longitude: meta.longitude,
              altitude: meta.altitude,
              gpsImgDirection: meta.gpsImgDirection,
              offsetTime: meta.offsetTime,
              cameraMake: meta.cameraMake,
              cameraModel: meta.cameraModel,
              lensModel: meta.lensModel,
              focalLength: meta.focalLength,
              focalLength35mm: meta.focalLength35mm,
              iso: meta.iso,
              exposureTime: meta.exposureTime,
              fNumber: meta.fNumber,
              software: meta.software,
              exifBackfilledAt: now,
            })
            .where(eq(schema.photos.id, photo.id));

          successCount++;
          if (meta.latitude !== null && meta.longitude !== null) {
            gpsCount++;
          }

          // 每 100 张打印一次进度
          if ((idx + 1) % 100 === 0) {
            console.log(
              `[backfill-exif] 进度: ${idx + 1}/${photos.length} | 成功: ${successCount} | GPS 命中: ${gpsCount} | 失败: ${failCount}`,
            );
          }
        } catch (err) {
          failCount++;
          console.warn(
            `[backfill-exif] 处理失败 (${photo.id}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    ),
  );

  const elapsed = ((Date.now() - now) / 1000).toFixed(1);
  console.log("\n[backfill-exif] ====== 回填完成 ======");
  console.log(`回填: ${photos.length} 张, GPS 命中: ${gpsCount} 张, 失败: ${failCount} 张`);
  console.log(`耗时: ${elapsed}s`);

  // 入队今日精选重跑
  try {
    const { dailyQueue } = await import("../jobs/queues");
    const date = todayBeijing();
    await dailyQueue.add("manual-rerun-after-backfill", { date });
    console.log(`✅ 已入队今日精选重跑 (date=${date})`);
  } catch (err) {
    console.error(
      `[backfill-exif] 入队失败（请手动触发精选重跑）: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill-exif] 严重错误:", err);
  process.exit(1);
});

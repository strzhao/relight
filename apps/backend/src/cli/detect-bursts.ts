/**
 * 全库连拍回填脚本
 *
 * 遍历每个 storageSource → 查所有有 takenAt 的照片 →
 * 全量计算 phash（写库）→ 调用 detectBursts 聚类
 *
 * 用法：
 *   pnpm --filter @relight/backend tsx src/cli/detect-bursts.ts
 *   pnpm --filter @relight/backend tsx src/cli/detect-bursts.ts --force
 *
 * 幂等设计：
 *   - 默认跳过已有 burst_id 的照片（仅处理未归组的）
 *   - --force 时清空所有 burst 数据重新全量计算
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { detectBursts } from "../lib/burst-detector";
import { dHash } from "../lib/phash";

// CLI 入口：确保相对路径（如缩略图）能正确解析
// DATABASE_PATH 形如 /abs/path/to/apps/backend/data/relight.db
// → backendRoot = /abs/path/to/apps/backend/
const backendRoot = (() => {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath && path.isAbsolute(dbPath)) {
    return path.resolve(dbPath, "../../"); // data/relight.db → ../ → data → ../ → backend/
  }
  // 回退：相对于当前文件的 ../../（src/cli/detect-bursts.ts → src/cli → src → backend）
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "../../");
})();
process.chdir(backendRoot);
console.log(`[detect-bursts] 工作目录: ${backendRoot}`);

const isForce = process.argv.includes("--force");

async function main() {
  console.log("[detect-bursts] 开始全库连拍回填...");
  if (isForce) {
    console.log("[detect-bursts] --force 模式：清空现有 burst 数据后重算");
    // 清空 burst 引用
    await db.update(schema.photos).set({ burstId: null, isBurstRepresentative: false });
    await db.delete(schema.bursts);
    console.log("[detect-bursts] 已清空 burst 数据");
  }

  // 获取所有 storageSource
  const sources = await db.select().from(schema.storageSources);
  console.log(`[detect-bursts] 发现 ${sources.length} 个存储源`);

  let totalGroupsProcessed = 0;
  let totalPhotosGrouped = 0;
  let totalPhashComputed = 0;

  for (const source of sources) {
    console.log(`\n[detect-bursts] 处理存储源: ${source.name} (${source.id})`);

    // 查询有 takenAt 的照片
    const allPhotos = await db
      .select({
        id: schema.photos.id,
        takenAt: schema.photos.takenAt,
        thumbnailPath: schema.photos.thumbnailPath,
        phash: schema.photos.phash,
        burstId: schema.photos.burstId,
        mediaType: schema.photos.mediaType,
      })
      .from(schema.photos)
      .where(
        sql`${schema.photos.storageSourceId} = ${source.id} AND ${schema.photos.takenAt} IS NOT NULL`,
      );

    console.log(`[detect-bursts]   共 ${allPhotos.length} 张有拍摄时间的照片`);

    // 非 --force 模式下，跳过已有 burst_id 的照片
    const photosToProcess = isForce ? allPhotos : allPhotos.filter((p) => !p.burstId);

    console.log(
      `[detect-bursts]   需处理: ${photosToProcess.length} 张（${isForce ? "全量" : "仅未归组"}）`,
    );

    // 计算缺失的 phash（跳过视频）
    const needHash = photosToProcess.filter(
      (p) => !p.phash && p.thumbnailPath && p.mediaType !== "video",
    );
    console.log(`[detect-bursts]   需计算 phash: ${needHash.length} 张`);

    let batchHashCount = 0;
    for (const photo of needHash) {
      try {
        const buf = await fs.readFile(photo.thumbnailPath ?? "");
        const hash = await dHash(buf);
        await db.update(schema.photos).set({ phash: hash }).where(eq(schema.photos.id, photo.id));
        photo.phash = hash;
        batchHashCount++;
        if (batchHashCount % 100 === 0) {
          console.log(`[detect-bursts]   phash 进度: ${batchHashCount}/${needHash.length}`);
        }
      } catch (err) {
        console.warn(
          `[detect-bursts]   phash 计算失败 (${photo.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (batchHashCount > 0) {
      console.log(`[detect-bursts]   phash 计算完成: ${batchHashCount} 张`);
      totalPhashComputed += batchHashCount;
    }

    // 调用 detectBursts 聚类
    const photoIds = photosToProcess
      .filter((p) => p.phash && p.mediaType !== "video") // 跳过视频和无 phash 的
      .map((p) => p.id);

    if (photoIds.length < 2) {
      console.log("[detect-bursts]   有效照片不足 2 张，跳过聚类");
      continue;
    }

    const result = await detectBursts({ storageSourceId: source.id, photoIds });
    console.log(
      `[detect-bursts]   聚类结果: 处理 ${result.groupsCreated} 组，` +
        `归入 ${result.photosGrouped} 张`,
    );

    totalGroupsProcessed += result.groupsCreated;
    totalPhotosGrouped += result.photosGrouped;
  }

  // 汇总
  const burstCount = await db.select({ count: sql<number>`count(*)` }).from(schema.bursts);
  const assignedCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.photos)
    .where(sql`${schema.photos.burstId} IS NOT NULL`);

  console.log("\n[detect-bursts] ====== 回填完成 ======");
  console.log(`处理 ${sources.length} 个存储源`);
  console.log(`计算 phash: ${totalPhashComputed} 张`);
  console.log(`识别到 ${totalGroupsProcessed} 个连拍组，含 ${totalPhotosGrouped} 张照片`);
  console.log(
    `数据库当前: bursts 表 ${burstCount[0]?.count ?? 0} 行，` +
      `${assignedCount[0]?.count ?? 0} 张照片有 burst_id`,
  );
}

main().catch((err) => {
  console.error("[detect-bursts] 失败:", err);
  process.exit(1);
});

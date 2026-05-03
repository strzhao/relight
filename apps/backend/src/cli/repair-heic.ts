import path from "node:path";
import { sql } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { generateThumbnail } from "../lib/thumbnail";

/**
 * 修复已扫描但缩略图缺失的 HEIC 照片
 *
 * 用法: npx tsx src/cli/repair-heic.ts
 */
async function main(): Promise<void> {
  console.log("=".repeat(50));
  console.log("  HEIC 照片缩略图修复工具");
  console.log("=".repeat(50));

  // 查询所有 thumbnail_path 为 null 的 HEIC/HEIF 照片
  const photos = await db
    .select({
      id: schema.photos.id,
      filePath: schema.photos.filePath,
    })
    .from(schema.photos)
    .where(
      sql`(${schema.photos.filePath} LIKE '%.heic' OR ${schema.photos.filePath} LIKE '%.heif' OR ${schema.photos.filePath} LIKE '%.HEIC' OR ${schema.photos.filePath} LIKE '%.HEIF') AND ${schema.photos.thumbnailPath} IS NULL`,
    );

  if (photos.length === 0) {
    console.log("\n没有需要修复的 HEIC 照片。");
    return;
  }

  console.log(`\n找到 ${photos.length} 张待修复的 HEIC 照片\n`);

  const thumbnailDir = path.join(config.storageRoot, "thumbnails");
  let repaired = 0;
  let failed = 0;

  for (const photo of photos) {
    try {
      const thumbnailPath = await generateThumbnail(photo.filePath, thumbnailDir, photo.id);
      await db
        .update(schema.photos)
        .set({ thumbnailPath })
        .where(sql`${schema.photos.id} = ${photo.id}`);
      console.log(`  ✅ ${path.basename(photo.filePath)}`);
      repaired++;
    } catch (err) {
      console.log(
        `  ❌ ${path.basename(photo.filePath)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  修复完成: ${repaired} 成功, ${failed} 失败`);
  console.log("=".repeat(50));
}

main().catch((err) => {
  console.error("修复失败:", err);
  process.exit(1);
});

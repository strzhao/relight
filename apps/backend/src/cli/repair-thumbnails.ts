import fs from "node:fs/promises";
import path from "node:path";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { generateThumbnail } from "../lib/thumbnail";

/**
 * 重建所有照片缩略图（尺寸升级后使用）
 *
 * 用法: npx tsx src/cli/repair-thumbnails.ts [--limit N]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1] ?? "0", 10) : 0;

  console.log("=".repeat(50));
  console.log("  缩略图重建工具");
  console.log("=".repeat(50));

  const query = db
    .select({
      id: schema.photos.id,
      filePath: schema.photos.filePath,
      thumbnailPath: schema.photos.thumbnailPath,
    })
    .from(schema.photos);

  const photos = limit > 0 ? await query.limit(limit) : await query.all();

  if (photos.length === 0) {
    console.log("\n没有照片需要重建。");
    return;
  }

  console.log(`\n共 ${photos.length} 张照片，开始重建...\n`);

  const thumbnailDir = path.join(config.storageRoot, "thumbnails");
  let rebuilt = 0;
  let failed = 0;
  let skipped = 0;

  for (const photo of photos) {
    try {
      // 删除旧缩略图
      if (photo.thumbnailPath) {
        await fs.unlink(photo.thumbnailPath).catch(() => {});
      }

      const thumbnailPath = await generateThumbnail(photo.filePath, thumbnailDir, photo.id);
      await db
        .update(schema.photos)
        .set({ thumbnailPath })
        .where(schema.photos.id.equals(photo.id));

      const stat = await fs.stat(thumbnailPath);
      console.log(`  ✅ ${path.basename(photo.filePath)} (${(stat.size / 1024).toFixed(0)}KB)`);
      rebuilt++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (reason.includes("no such file") || reason.includes("ENOENT")) {
        console.log(`  ⏭️ ${path.basename(photo.filePath)} (文件不存在，跳过)`);
        skipped++;
      } else {
        console.log(`  ❌ ${path.basename(photo.filePath)}: ${reason}`);
        failed++;
      }
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  完成: ${rebuilt} 成功, ${skipped} 跳过, ${failed} 失败`);
  console.log("=".repeat(50));
}

main().catch((err) => {
  console.error("重建失败:", err);
  process.exit(1);
});

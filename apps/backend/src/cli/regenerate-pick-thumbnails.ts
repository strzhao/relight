import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { dailyPicks, photos } from "../db/schema";
import { config } from "../lib/config";
import { generateThumbnail } from "../lib/thumbnail";

async function main() {
  // 只查询出现在每日精选中的照片 ID
  const pickRows = db.select({ photoId: dailyPicks.photoId }).from(dailyPicks).all();
  const pickPhotoIds = [...new Set(pickRows.map((r) => r.photoId))];

  if (pickPhotoIds.length === 0) {
    console.log("没有每日精选记录");
    return;
  }

  console.log(`每日精选涉及 ${pickPhotoIds.length} 张照片`);

  // 批量加载这些照片的完整信息
  const targetPhotos = db.select().from(photos).where(inArray(photos.id, pickPhotoIds)).all();
  console.log(`找到 ${targetPhotos.length} 张照片，开始重新生成缩略图...`);

  const thumbnailDir = path.join(config.storageRoot, "thumbnails");
  let count = 0;

  for (const photo of targetPhotos) {
    try {
      const outputPath = await generateThumbnail(photo.filePath, thumbnailDir, photo.id);
      db.update(photos).set({ thumbnailPath: outputPath }).where(eq(photos.id, photo.id)).run();
      count++;
      console.log(`[${count}/${targetPhotos.length}] ${photo.id.slice(0, 12)}...`);
    } catch (err) {
      console.error(
        `[${count}/${targetPhotos.length}] 失败: ${photo.id} — ${(err as Error).message}`,
      );
    }
  }

  console.log(`完成! 共处理 ${count}/${targetPhotos.length} 张精选照片`);
}

main();

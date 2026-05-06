/**
 * 一次性回填脚本：将视频扩展名的 photos.media_type 更新为 'video'。
 *
 * 用法：pnpm --filter @relight/backend tsx src/cli/backfill-media-type.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../db";

const VIDEO_GLOB_CONDITIONS = [
  "LOWER(file_path) GLOB '*.mp4'",
  "LOWER(file_path) GLOB '*.mov'",
  "LOWER(file_path) GLOB '*.avi'",
  "LOWER(file_path) GLOB '*.mkv'",
  "LOWER(file_path) GLOB '*.webm'",
  "LOWER(file_path) GLOB '*.m4v'",
].join(" OR ");

async function main() {
  console.log("[backfill-media-type] 开始回填视频 media_type...");

  const result = await db.run(
    sql.raw(`UPDATE photos SET media_type = 'video' WHERE ${VIDEO_GLOB_CONDITIONS}`),
  );

  console.log(`[backfill-media-type] 完成，更新行数: ${result.changes}`);
}

main().catch((err) => {
  console.error("[backfill-media-type] 失败:", err);
  process.exit(1);
});

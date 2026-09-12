import path from "node:path";
/**
 * 一次性恢复脚本（2026-09-13 QA 现场实证）：renderTextOverlay 相对路径基准 bug 导致
 * 两腿 overlay 产物写进 workspace 而被误判缺失。代码已修（绝对化）；本脚本把当时已
 * 渲染完成的两个 overlay 成品直接走「双轨转码 → COS 上传 → 写列 → manifest」收尾，
 * 免去重新生成（~1.5h GPU）。恢复后请删除本文件。
 */
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { config } from "../src/lib/config.ts";
import { uploadFile } from "../src/lib/cos/upload.ts";
import { syncDayToGallery } from "../src/lib/gallery/sync.ts";
import { transcodeForAerial, transcodeForGallery } from "../src/lib/wallpaper/video.ts";

const DATE = "2026-09-12";
const WS = config.videoWorkspacePath;

const overlay = (kind: "landscape" | "portrait") =>
  path.join(
    WS,
    "wallpaper-overlay",
    "photos",
    "wallpaper-videos",
    `${DATE}-${kind}-raw-loop-overlay.mp4`,
  );

const localDir = path.join(config.storageRoot, "wallpaper-videos");
const local = (kind: "landscape" | "portrait") =>
  path.join(localDir, `${DATE}-${kind}${kind === "landscape" ? ".mov" : ".mp4"}`);

console.log("landscape overlay:", overlay("landscape"));
console.log("portrait overlay:", overlay("portrait"));

const aerialKey = `relight/wallpaper-videos/${DATE}_landscape.mov`;
const galleryKey = `relight/wallpaper-videos/${DATE}_portrait.mp4`;

// landscape：Remotion 成品 → HEVC hvc1 1920×1080 无音轨 .mov
const aerialLocal = local("landscape");
await transcodeForAerial(overlay("landscape"), aerialLocal);
const aerialUrl = await uploadFile(aerialLocal, aerialKey, "video/quicktime");
console.log("landscape 上传:", aerialUrl ? "ok" : "空串");

// portrait：Remotion 成品 → H.264 + aac mp4
const galleryLocal = local("portrait");
await transcodeForGallery(overlay("portrait"), galleryLocal);
const galleryUrl = await uploadFile(galleryLocal, galleryKey, "video/mp4");
console.log("portrait 上传:", galleryUrl ? "ok" : "空串");

if (aerialUrl && galleryUrl) {
  await db
    .update(schema.dailyPicks)
    .set({
      wallpaperVideoLandscapeUrl: aerialUrl,
      wallpaperVideoPortraitUrl: galleryUrl,
    })
    .where(eq(schema.dailyPicks.pickDate, DATE));
  console.log("DB 两列已写入");
  const pickRow = (
    await db.select().from(schema.dailyPicks).where(eq(schema.dailyPicks.pickDate, DATE)).limit(1)
  )[0];
  const entryRows = await db
    .select()
    .from(schema.dailyPickEntries)
    .where(eq(schema.dailyPickEntries.dailyPickId, pickRow.id));
  // 静态壁纸本地上传源缺失时传 undefined（uploadDayAssets 内 access 校验自动跳过）
  const composedLocal = (suffix: string) => {
    const p = path.join(config.storageRoot, `${pickRow.composedImagePath ?? ""}`);
    return p.replace(/-default\.jpg$/, suffix);
  };
  await syncDayToGallery(
    DATE,
    {
      landscape: composedLocal("-default.jpg"),
      portrait: composedLocal("-1290x2796.jpg"),
    },
    entryRows.map((e) => e.photoId),
  );
  console.log("syncDayToGallery 完成（manifest 已重建推送）");
} else {
  console.log("上传失败，未写 DB（当日回退静态语义）");
}
process.exit(0);

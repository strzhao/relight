/**
 * 一次性恢复脚本（2026-09-12 QA 事故）：测试进程带真实 COS 凭据把当日横竖壁纸覆盖为
 * 256×256 fixture 图。本脚本按 recompose-wallpapers.ts 同参数对 2026-09-12 强制重合成
 * 并重传（无 404 门控）。恢复后请删除本文件。
 */
import { asc, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { uploadFile } from "../src/lib/cos/upload.ts";
import { wallpaperLandscapeCosKey, wallpaperPortraitCosKey } from "../src/lib/gallery/manifest.ts";
import { composeAndSave } from "../src/lib/wallpaper/composer.ts";

const DATE = "2026-09-12";

async function restoreOne(kind: "portrait" | "landscape"): Promise<string> {
  const pickRows = await db
    .select()
    .from(schema.dailyPicks)
    .where(eq(schema.dailyPicks.pickDate, DATE))
    .limit(1);
  const pickRow = pickRows[0];
  if (!pickRow) return "dailyPicks 不存在";
  const entryRows = await db
    .select()
    .from(schema.dailyPickEntries)
    .where(eq(schema.dailyPickEntries.dailyPickId, pickRow.id))
    .orderBy(asc(schema.dailyPickEntries.rank))
    .limit(1);
  const heroPhotoId = entryRows[0]?.photoId ?? pickRow.photoId;
  const members = entryRows[0]?.members ?? pickRow.members ?? [];
  const heroPhoto = (
    await db.select().from(schema.photos).where(eq(schema.photos.id, heroPhotoId)).limit(1)
  )[0];
  if (!heroPhoto) return "hero photo 不存在";

  const pick = { ...pickRow, composedImageUrl: null, members };
  const localPath =
    kind === "portrait"
      ? await composeAndSave({ pick, photo: heroPhoto, width: 1290, height: 2796 })
      : await composeAndSave({
          pick,
          photo: heroPhoto,
          width: 5120,
          height: 2880,
          cacheKey: "default",
        });

  const cosKey =
    kind === "portrait" ? wallpaperPortraitCosKey(DATE) : wallpaperLandscapeCosKey(DATE);
  const uploaded = await uploadFile(localPath, cosKey, "image/jpeg");
  return uploaded ? `ok ${uploaded.slice(0, 60)}...` : "uploadFile 返回空串";
}

for (const kind of ["portrait", "landscape"] as const) {
  const start = Date.now();
  const status = await restoreOne(kind).catch((e) => `throw: ${e?.message ?? e}`);
  console.log(`${kind}: ${status} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
}

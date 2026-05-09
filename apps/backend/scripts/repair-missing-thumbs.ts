import path from "node:path";
import { eq, isNull } from "drizzle-orm";
import { db, schema } from "../src/db";
import { config } from "../src/lib/config";
import { generateThumbnail } from "../src/lib/thumbnail";

const missing = await db
  .select({
    id: schema.photos.id,
    filePath: schema.photos.filePath,
    fileSize: schema.photos.fileSize,
  })
  .from(schema.photos)
  .where(isNull(schema.photos.thumbnailPath));

console.log(`photos with NULL thumbnail_path: ${missing.length}`);

const thumbnailDir = path.join(config.storageRoot, "thumbnails");

let okCount = 0;
let zeroSize = 0;
let errCount = 0;

for (const p of missing) {
  if ((p.fileSize ?? 0) === 0) {
    console.log(`[skip:size=0] ${p.id} ${p.filePath}`);
    zeroSize++;
    continue;
  }
  try {
    const tp = await generateThumbnail(p.filePath, thumbnailDir, p.id);
    await db.update(schema.photos).set({ thumbnailPath: tp }).where(eq(schema.photos.id, p.id));
    okCount++;
    console.log(`[ok] ${p.id} -> ${tp}`);
  } catch (e) {
    errCount++;
    console.error(`[err] ${p.id} ${p.filePath}: ${(e as Error).message}`);
  }
}

console.log(`\nrepaired=${okCount} zeroSizeSkipped=${zeroSize} errors=${errCount}`);
process.exit(0);

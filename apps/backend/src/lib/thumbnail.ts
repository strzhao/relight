import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_HEIGHT = 400;

export async function generateThumbnail(
  sourcePath: string,
  outputDir: string,
  photoId: string,
): Promise<string> {
  const ext = path.extname(sourcePath).toLowerCase();
  const outputName = `${photoId}${ext}`;
  const outputPath = path.join(outputDir, outputName);

  await fs.mkdir(outputDir, { recursive: true });
  await sharp(sourcePath)
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(outputPath);

  return outputPath;
}

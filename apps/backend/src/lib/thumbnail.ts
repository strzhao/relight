import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { heicFileToJpeg } from "./heic";

const THUMBNAIL_WIDTH = 800;
const THUMBNAIL_HEIGHT = 800;

export async function generateThumbnail(
  sourcePath: string,
  outputDir: string,
  photoId: string,
): Promise<string> {
  const outputName = `${photoId}.jpg`;
  const outputPath = path.join(outputDir, outputName);

  await fs.mkdir(outputDir, { recursive: true });

  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === ".heic" || ext === ".heif") {
    const jpegBuffer = await heicFileToJpeg(sourcePath, {
      maxWidth: THUMBNAIL_WIDTH,
      maxHeight: THUMBNAIL_HEIGHT,
      quality: 85,
    });
    await fs.writeFile(outputPath, jpegBuffer);
  } else {
    await sharp(sourcePath)
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toFile(outputPath);
  }

  return outputPath;
}

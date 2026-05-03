import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createHeicDecoder } from "./heic-decoder";

const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_HEIGHT = 400;

const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);

function isHeic(filePath: string): boolean {
  return HEIC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function generateThumbnail(
  sourcePath: string,
  outputDir: string,
  photoId: string,
): Promise<string> {
  const ext = path.extname(sourcePath).toLowerCase();
  await fs.mkdir(outputDir, { recursive: true });

  // For HEIC files, use two-step conversion: heif-convert → sharp
  if (isHeic(sourcePath)) {
    return generateHeicThumbnail(sourcePath, outputDir, photoId);
  }

  // Native sharp path for JPEG, PNG, WebP, etc.
  const outputName = `${photoId}${ext}`;
  const outputPath = path.join(outputDir, outputName);

  await sharp(sourcePath)
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(outputPath);

  return outputPath;
}

/**
 * Two-step HEIC thumbnail generation:
 * 1. heif-convert: HEIC → temporary JPEG
 * 2. sharp: resize + JPEG encode to output
 */
async function generateHeicThumbnail(
  sourcePath: string,
  outputDir: string,
  photoId: string,
): Promise<string> {
  const decoder = createHeicDecoder();

  // Create temp dir for intermediate file
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const tempDir = path.join(os.tmpdir(), `relight-thumb-${ts}-${rand}`);
  await fs.mkdir(tempDir, { recursive: true });

  const intermediateJpeg = path.join(tempDir, `${photoId}-intermediate.jpg`);

  try {
    // Step 1: HEIC → temporary JPEG via heif-convert
    await decoder.convertToJpeg(sourcePath, intermediateJpeg);

    // Step 2: sharp resize + JPEG encode
    // HEIC always outputs .jpg regardless of source extension
    const outputPath = path.join(outputDir, `${photoId}.jpg`);

    await sharp(intermediateJpeg)
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(outputPath);

    return outputPath;
  } finally {
    // Clean up intermediate temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

import { readFile } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { convertHeicToJpeg, isHeicBuffer } from "./heic";
import { extractFrames } from "./video/ffmpeg";

const THUMBNAIL_WIDTH = 800;
const THUMBNAIL_HEIGHT = 800;

/** 视频扩展名（与 storage adapter 一致） */
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"]);

/**
 * 生成缩略图。
 * 视频：调 ffmpeg 抽首场景帧 → sharp resize → 写 .jpg。
 * 图片：现有 sharp 路径 → 写 .jpg（统一后缀，避免视频缩略图变 .mp4 的 bug）。
 */
export async function generateThumbnail(
  sourcePath: string,
  outputDir: string,
  photoId: string,
): Promise<string> {
  const ext = path.extname(sourcePath).toLowerCase();
  // 强制 .jpg 后缀（不能用源 ext，否则视频缩略图会变 .mp4 导致前端 404）
  const outputName = `${photoId}.jpg`;
  const outputPath = path.join(outputDir, outputName);

  await fs.mkdir(outputDir, { recursive: true });

  let imageBuffer: Buffer;
  if (VIDEO_EXTENSIONS.has(ext)) {
    // 视频：抽首场景帧（extractFrames 内部用 sharp resize 到 768，这里再 resize 到 400）
    const frames = await extractFrames(sourcePath, 1, { sceneFirst: true });
    if (frames.length === 0 || !frames[0]) {
      throw new Error(`视频抽帧失败: ${sourcePath}`);
    }
    imageBuffer = frames[0];
  } else {
    imageBuffer = await readFile(sourcePath);
    // HEIC 走专用解码路径（sharp 预编译 libvips 不含 HEIC 解码）
    if (isHeicBuffer(imageBuffer)) {
      const jpegBuffer = await convertHeicToJpeg(imageBuffer, {
        maxWidth: THUMBNAIL_WIDTH,
        maxHeight: THUMBNAIL_HEIGHT,
        quality: 85,
      });
      await fs.writeFile(outputPath, jpegBuffer);
      return outputPath;
    }
  }

  await sharp(imageBuffer)
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(outputPath);

  return outputPath;
}

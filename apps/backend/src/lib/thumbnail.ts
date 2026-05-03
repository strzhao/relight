import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { VIDEO_EXTENSIONS } from "../storage/local";
import { createHeicDecoder } from "./heic-decoder";

const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_HEIGHT = 400;

const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);

function isHeic(filePath: string): boolean {
  return HEIC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function generateVideoThumbnail(
  sourcePath: string,
  outputDir: string,
  photoId: string,
): Promise<string> {
  const outputPath = path.join(outputDir, `${photoId}.jpeg`);
  await fs.mkdir(outputDir, { recursive: true });

  // 尝试 -ss 00:00:01，失败降级为 -ss 00:00:00
  const tryExtract = async (seekTime: string): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(
        "ffmpeg",
        [
          "-i",
          sourcePath,
          "-ss",
          seekTime,
          "-vframes",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ],
        { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] },
      );

      const chunks: Buffer[] = [];
      ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      // 消费 stderr 防止缓冲区满
      ffmpeg.stderr.resume();
      ffmpeg.on("close", (code) => {
        if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
      ffmpeg.on("error", reject);
    });
  };

  let frameBuffer: Buffer;
  try {
    frameBuffer = await tryExtract("00:00:01");
  } catch {
    frameBuffer = await tryExtract("00:00:00");
  }

  await sharp(frameBuffer)
    .rotate()
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toFile(outputPath);

  return outputPath;
}

export async function generateThumbnail(
  sourcePath: string,
  outputDir: string,
  photoId: string,
): Promise<string> {
  const ext = path.extname(sourcePath).toLowerCase();

  // 视频委托给 generateVideoThumbnail，返回 .jpeg 缩略图
  if (VIDEO_EXTENSIONS.has(ext)) {
    return generateVideoThumbnail(sourcePath, outputDir, photoId);
  }

  // HEIC 两步转换：heif-convert → 临时 JPEG → sharp resize
  if (isHeic(sourcePath)) {
    return generateHeicThumbnail(sourcePath, outputDir, photoId);
  }

  const outputName = `${photoId}${ext}`;
  const outputPath = path.join(outputDir, outputName);

  await fs.mkdir(outputDir, { recursive: true });
  await sharp(sourcePath)
    .rotate()
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toFile(outputPath);

  return outputPath;
}

async function generateHeicThumbnail(
  sourcePath: string,
  outputDir: string,
  photoId: string,
): Promise<string> {
  const decoder = createHeicDecoder();

  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const tempDir = path.join(os.tmpdir(), `relight-thumb-${ts}-${rand}`);
  await fs.mkdir(tempDir, { recursive: true });

  const intermediateJpeg = path.join(tempDir, `${photoId}-intermediate.jpg`);

  try {
    await decoder.convertToJpeg(sourcePath, intermediateJpeg);

    const outputPath = path.join(outputDir, `${photoId}.jpg`);

    await sharp(intermediateJpeg)
      .rotate()
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toFile(outputPath);

    return outputPath;
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

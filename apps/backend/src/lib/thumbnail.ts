import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { VIDEO_EXTENSIONS } from "../storage/local";
import { heicFileToJpeg } from "./heic";

const THUMBNAIL_WIDTH = 800;
const THUMBNAIL_HEIGHT = 800;

export async function generateVideoThumbnail(
  sourcePath: string,
  outputDir: string,
  photoId: string,
): Promise<string> {
  const outputPath = path.join(outputDir, `${photoId}.jpeg`);
  await fs.mkdir(outputDir, { recursive: true });

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
    .jpeg({ quality: 85 })
    .toFile(outputPath);

  return outputPath;
}

export async function generateThumbnail(
  sourcePath: string,
  outputDir: string,
  photoId: string,
): Promise<string> {
  const ext = path.extname(sourcePath).toLowerCase();

  if (VIDEO_EXTENSIONS.has(ext)) {
    return generateVideoThumbnail(sourcePath, outputDir, photoId);
  }

  const outputName = `${photoId}.jpg`;
  const outputPath = path.join(outputDir, outputName);

  await fs.mkdir(outputDir, { recursive: true });

  if (ext === ".heic" || ext === ".heif") {
    const jpegBuffer = await heicFileToJpeg(sourcePath, {
      maxWidth: THUMBNAIL_WIDTH,
      maxHeight: THUMBNAIL_HEIGHT,
      quality: 85,
    });
    await fs.writeFile(outputPath, jpegBuffer);
  } else {
    await sharp(sourcePath)
      .rotate()
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toFile(outputPath);
  }

  return outputPath;
}

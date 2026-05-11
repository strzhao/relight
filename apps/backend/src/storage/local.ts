import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { parseExifMeta } from "../lib/exif";
import { probeVideo } from "../lib/video/ffmpeg";
import type { FileInfo, FileMetadata, IStorageAdapter } from "./interface";

/** 视频扩展名（与扫描白名单中的视频部分一致） */
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"]);

/** 扫描时收录的所有文件格式（含暂不支持 AI 分析的视频格式，入库备用） */
const SCAN_EXTENSIONS = new Set([
  // 图片格式
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".bmp",
  ".tiff",
  // RAW 格式（通过 dcraw 提取预览后支持 AI 分析）
  ".dng",
  // 视频格式（扫描入库，暂不支持 AI 分析，后续扩展）
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
]);

export class LocalFilesystemAdapter implements IStorageAdapter {
  async listFiles(rootPath: string): Promise<FileInfo[]> {
    const files: FileInfo[] = [];
    await this.walk(rootPath, rootPath, files);
    return files;
  }

  private async walk(rootPath: string, currentPath: string, files: FileInfo[]): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await this.walk(rootPath, fullPath, files);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SCAN_EXTENSIONS.has(ext)) {
          const stat = await fs.stat(fullPath);
          files.push({
            path: fullPath,
            name: entry.name,
            size: stat.size,
            modifiedAt: stat.mtime,
          });
        }
      }
    }
  }

  async getFileBuffer(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
  }

  getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".heic": "image/heic",
      ".heif": "image/heif",
      ".bmp": "image/bmp",
      ".tiff": "image/tiff",
      ".dng": "image/x-adobe-dng",
    };
    return mimeMap[ext] ?? "application/octet-stream";
  }

  /**
   * 获取文件元信息。
   * 视频走 ffprobe 路径（提取 width/height/duration/codec/fps + creation_time → takenAt）。
   * 图片走 sharp 路径（提取 width/height + EXIF DateTimeOriginal → takenAt）。
   * 都失败时 fallback 到 fs.stat mtime。
   */
  async getMetadata(filePath: string): Promise<FileMetadata> {
    const ext = path.extname(filePath).toLowerCase();

    // 视频路径：用 ffprobe
    if (VIDEO_EXTENSIONS.has(ext)) {
      try {
        const probe = await probeVideo(filePath);
        let takenAt = probe.takenAt;
        if (!takenAt) {
          const stat = await fs.stat(filePath);
          takenAt = stat.mtime;
        }
        return {
          width: probe.width,
          height: probe.height,
          takenAt,
          mediaType: "video",
          durationSec: probe.durationSec,
          videoCodec: probe.videoCodec,
          videoFps: probe.videoFps,
        };
      } catch {
        // ffprobe 失败（损坏视频或缺 ffmpeg）→ 仍标记 mediaType: 'video' 但其他字段为 undefined
        try {
          const stat = await fs.stat(filePath);
          return { takenAt: stat.mtime, mediaType: "video" };
        } catch {
          return { mediaType: "video" };
        }
      }
    }

    // 图片路径：exifr 提取完整 EXIF + sharp 提取尺寸
    try {
      // 并行获取尺寸 + 完整 EXIF（exifr 内部容错，失败返回全 null）
      const [metadata, exifMeta] = await Promise.all([
        sharp(filePath)
          .metadata()
          .catch(() => ({ width: undefined, height: undefined })),
        parseExifMeta(filePath),
      ]);

      const width = metadata.width;
      const height = metadata.height;
      let takenAt: Date | undefined;

      // takenAt：优先 exifr 提取的字符串（"YYYY:MM:DD HH:MM:SS"）
      if (exifMeta.takenAt) {
        const dateTimeStr = exifMeta.takenAt;
        const parsed = new Date(dateTimeStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"));
        if (!Number.isNaN(parsed.getTime())) {
          takenAt = parsed;
        }
      }

      // Fallback to file modification time
      if (!takenAt) {
        const stat = await fs.stat(filePath);
        takenAt = stat.mtime;
      }

      return {
        width,
        height,
        takenAt,
        latitude: exifMeta.latitude,
        longitude: exifMeta.longitude,
        altitude: exifMeta.altitude,
        gpsImgDirection: exifMeta.gpsImgDirection,
        offsetTime: exifMeta.offsetTime,
        cameraMake: exifMeta.cameraMake,
        cameraModel: exifMeta.cameraModel,
        lensModel: exifMeta.lensModel,
        focalLength: exifMeta.focalLength,
        focalLength35mm: exifMeta.focalLength35mm,
        iso: exifMeta.iso,
        exposureTime: exifMeta.exposureTime,
        fNumber: exifMeta.fNumber,
        software: exifMeta.software,
      };
    } catch {
      // 容错：整体失败时 fallback 到 fs.stat mtime
      try {
        const stat = await fs.stat(filePath);
        return { takenAt: stat.mtime };
      } catch {
        return {};
      }
    }
  }

  /**
   * 流式计算文件 SHA256 哈希。
   * 使用 64KB chunk 流式读取，内存占用恒定，
   * 不会将大文件完全加载到内存。
   */
  async computeFileHash(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    const readStream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
    await pipeline(readStream, hash);
    return hash.digest("hex");
  }
}

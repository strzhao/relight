import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
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

/** EXIF DateTimeOriginal tag */
const TAG_DATE_TIME_ORIGINAL = 0x9003;

/**
 * 在 EXIF Buffer 中定位 TIFF 头起始位置。
 * 兼容 "Exif\0\0" APP1 前缀（offset 6）和直接在 offset 0 的纯 TIFF 格式。
 */
function findTiffStart(buf: Buffer): number {
  if (buf.length < 4) return -1;
  const b0 = buf[0] ?? -1;
  const b1 = buf[1] ?? -1;
  // Byte order markers: II (little-endian) or MM (big-endian)
  if ((b0 === 0x49 && b1 === 0x49) || (b0 === 0x4d && b1 === 0x4d)) return 0;
  // Try after "Exif\0\0" APP1 prefix
  if (buf.length >= 10) {
    const b6 = buf[6] ?? -1;
    const b7 = buf[7] ?? -1;
    if ((b6 === 0x49 && b7 === 0x49) || (b6 === 0x4d && b7 === 0x4d)) return 6;
  }
  return -1;
}

/**
 * 轻量 EXIF TIFF 解析器，提取 DateTimeOriginal (0x9003)。
 * 不依赖第三方 EXIF 库，零额外依赖。
 *
 * @param exifBuffer sharp metadata() 返回的 .exif Buffer
 * @returns "YYYY:MM:DD HH:MM:SS" 格式的日期时间字符串，解析失败返回 null
 */
function parseExifDateTimeOriginal(exifBuffer: Buffer): string | null {
  try {
    const tiffStart = findTiffStart(exifBuffer);
    if (tiffStart < 0) return null;

    const buf = exifBuffer;
    const base = tiffStart;

    // Byte order: 0x49 = "II" (Intel, little-endian), 0x4D = "MM" (Motorola, big-endian)
    const isLE = buf[base] === 0x49;

    const read16 = (offset: number): number =>
      isLE ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);

    const read32 = (offset: number): number =>
      isLE ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);

    // TIFF magic number must be 0x002A
    if (read16(base + 2) !== 0x002a) return null;

    // IFD0 offset (relative to TIFF start)
    const ifdStart = read32(base + 4) + base;
    const entryCount = read16(ifdStart);

    let entryOffset = ifdStart + 2;
    for (let i = 0; i < entryCount; i++) {
      const tag = read16(entryOffset);
      if (tag === TAG_DATE_TIME_ORIGINAL) {
        const type = read16(entryOffset + 2);
        const count = read32(entryOffset + 4);

        // ASCII string: type=2, count includes null terminator
        if (type !== 2) return null;

        // Values <= 4 bytes are stored inline at entryOffset + 8;
        // longer values store a 4-byte offset (relative to TIFF start) at entryOffset + 8
        const valueStart = count <= 4 ? entryOffset + 8 : read32(entryOffset + 8) + base;
        // Trim the null terminator
        return buf.toString("utf8", valueStart, valueStart + count - 1);
      }
      entryOffset += 12; // Each IFD entry is exactly 12 bytes
    }
  } catch {
    // Silently ignore parse errors for robustness
  }
  return null;
}

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

    // 图片路径：现有 sharp 逻辑
    try {
      const metadata = await sharp(filePath).metadata();
      const width = metadata.width;
      const height = metadata.height;
      let takenAt: Date | undefined;

      if (metadata.exif) {
        const dateTimeStr = parseExifDateTimeOriginal(metadata.exif);
        if (dateTimeStr) {
          // EXIF DateTimeOriginal format: "YYYY:MM:DD HH:MM:SS"
          takenAt = new Date(dateTimeStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"));
        }
      }

      // Fallback to file modification time
      if (!takenAt) {
        const stat = await fs.stat(filePath);
        takenAt = stat.mtime;
      }

      return { width, height, takenAt };
    } catch {
      // 容错：sharp 解析失败时 fallback 到 fs.stat mtime
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

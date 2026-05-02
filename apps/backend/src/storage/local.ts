import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { FileInfo, IStorageAdapter } from "./interface";

/**
 * 从 sharp 返回的原始 EXIF Buffer 中提取 DateTimeOriginal 标签 (0x9003)
 * 返回 Date 对象或 null
 */
function extractExifDate(exifBuf: Buffer): Date | null {
  if (exifBuf.length < 14) return null;

  // 判断字节序：0x4949 = little-endian (Intel), 0x4D4D = big-endian (Motorola)
  const le = exifBuf[0] === 0x49 && exifBuf[1] === 0x49;

  function read16(offset: number): number {
    return le ? exifBuf.readUInt16LE(offset) : exifBuf.readUInt16BE(offset);
  }

  function read32(offset: number): number {
    return le ? exifBuf.readUInt32LE(offset) : exifBuf.readUInt32BE(offset);
  }

  // TIFF 头：字节 4-7 = 第一个 IFD 的偏移（从 TIFF 头起始即字节 0 算起）
  // 实际 TIFF 头从 EXIF buffer 的某个偏移开始
  // 简化：遍历常见起始偏移查找 TIFF 魔数 0x002A
  let tiffStart = -1;
  for (let i = 0; i < Math.min(exifBuf.length - 8, 256); i++) {
    const tag = read16(i);
    if (tag === 0x002a) {
      tiffStart = i - 2; // 字节序标记在此前 2 字节
      break;
    }
  }
  if (tiffStart < 0) return null;

  // 第一个 IFD 偏移在 tiffStart + 4
  let ifdOffset = tiffStart + read32(tiffStart + 4);

  while (ifdOffset > 0 && ifdOffset < exifBuf.length - 2) {
    const entryCount = read16(ifdOffset);
    ifdOffset += 2;

    for (let i = 0; i < entryCount && ifdOffset + 12 <= exifBuf.length; i++) {
      const tag = read16(ifdOffset);
      if (tag === 0x9003) {
        // DateTimeOriginal — 值是 ASCII 字符串的偏移
        const valueOffset = tiffStart + read32(ifdOffset + 8);
        // 读取 19 个字符
        let str = "";
        for (let j = 0; j < 19 && valueOffset + j < exifBuf.length; j++) {
          const ch = exifBuf[valueOffset + j];
          if (ch === 0 || ch == null) break;
          str += String.fromCharCode(ch);
        }
        // 格式: "YYYY:MM:DD HH:MM:SS"
        const match = str.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
        if (match) {
          return new Date(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3]),
            Number(match[4]),
            Number(match[5]),
            Number(match[6]),
          );
        }
        return null;
      }
      ifdOffset += 12;
    }

    // 下一个 IFD 偏移
    const nextOffset = read32(ifdOffset);
    ifdOffset = nextOffset > 0 ? tiffStart + nextOffset : -1;
  }

  return null;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".bmp",
  ".tiff",
  ".dng",
  ".mov",
  ".mp4",
  ".avi",
  ".mkv",
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
        if (SUPPORTED_EXTENSIONS.has(ext)) {
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
      ".dng": "image/dng",
      ".mov": "video/quicktime",
      ".mp4": "video/mp4",
      ".avi": "video/x-msvideo",
      ".mkv": "video/x-matroska",
    };
    return mimeMap[ext] ?? "application/octet-stream";
  }

  async getMetadata(
    filePath: string,
  ): Promise<{ width?: number; height?: number; takenAt?: Date }> {
    const ext = path.extname(filePath).toLowerCase();
    // 视频格式无 sharp 元数据
    if ([".mov", ".mp4", ".avi", ".mkv"].includes(ext)) {
      return {};
    }

    try {
      const metadata = await sharp(filePath).metadata();
      const result: { width?: number; height?: number; takenAt?: Date } = {};
      if (metadata.width) result.width = metadata.width;
      if (metadata.height) result.height = metadata.height;
      if (metadata.exif) {
        try {
          const dateTimeOriginal = extractExifDate(metadata.exif);
          if (dateTimeOriginal) {
            result.takenAt = dateTimeOriginal;
          }
        } catch {
          // EXIF 解析失败，忽略
        }
      }
      return result;
    } catch {
      return {};
    }
  }
}

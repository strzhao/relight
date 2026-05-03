import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createHeicDecoder } from "../lib/heic-decoder";
import type { FileInfo, IStorageAdapter } from "./interface";

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".bmp",
  ".tiff",
]);

const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);

function isHeic(filePath: string): boolean {
  return HEIC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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
        if (IMAGE_EXTENSIONS.has(ext)) {
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
    };
    return mimeMap[ext] ?? "application/octet-stream";
  }

  async getMetadata(
    filePath: string,
  ): Promise<{ width?: number; height?: number; takenAt?: Date }> {
    try {
      // For HEIC, convert to temporary JPEG first, then extract metadata via sharp
      if (isHeic(filePath)) {
        return this.getHeicMetadata(filePath);
      }

      const meta = await sharp(filePath).metadata();
      return {
        width: meta.width,
        height: meta.height,
      };
    } catch {
      // Sharp may fail on unsupported formats — return empty metadata gracefully
      return {};
    }
  }

  private async getHeicMetadata(
    filePath: string,
  ): Promise<{ width?: number; height?: number; takenAt?: Date }> {
    const decoder = createHeicDecoder();

    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const tempDir = path.join(os.tmpdir(), `relight-meta-${ts}-${rand}`);
    await fs.mkdir(tempDir, { recursive: true });
    const intermediateJpeg = path.join(tempDir, `meta-intermediate-${ts}.jpg`);

    try {
      // Step 1: HEIC → temporary JPEG via heif-convert
      await decoder.convertToJpeg(filePath, intermediateJpeg);

      // Step 2: sharp metadata on intermediate JPEG
      const meta = await sharp(intermediateJpeg).metadata();
      return {
        width: meta.width,
        height: meta.height,
      };
    } catch {
      return {};
    } finally {
      // Clean up temp directory
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

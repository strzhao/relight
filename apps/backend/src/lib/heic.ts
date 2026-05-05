import { readFile } from "node:fs/promises";
import path from "node:path";
import decode from "heic-decode";
import sharp from "sharp";

const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);

export function isHeicFile(filePath: string): boolean {
  return HEIC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ISO base media format: bytes 4..8 = "ftyp", 8..12 = brand.
// iOS 备份偶尔把 HEIC 内容存成 .JPEG 扩展名，仅看后缀会漏判。
const HEIC_BRANDS = new Set(["heic", "heix", "heif", "mif1", "msf1", "hevc", "hevx"]);

export function isHeicBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString("ascii", 4, 8) !== "ftyp") return false;
  return HEIC_BRANDS.has(buf.toString("ascii", 8, 12).toLowerCase());
}

interface ConvertOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

/**
 * HEIC buffer → JPEG buffer
 *
 * 管线：heic-decode (RGBA pixels) → sharp (resize + JPEG encode)
 */
export async function convertHeicToJpeg(
  buffer: Buffer,
  options: ConvertOptions = {},
): Promise<Buffer> {
  const { maxWidth, maxHeight, quality = 80 } = options;

  let width: number;
  let height: number;
  let data: ArrayBuffer;

  try {
    const decoded = await decode({ buffer });
    width = decoded.width;
    height = decoded.height;
    data = decoded.data;
  } catch (heicError) {
    try {
      const { data: rawData, info } = await sharp(buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      width = info.width;
      height = info.height;
      data = rawData.buffer;
    } catch (sharpError) {
      throw new Error(
        `HEIC 转换失败：heic-decode 和 sharp 均无法处理该文件。heic-decode: ${(heicError as Error).message}；sharp: ${(sharpError as Error).message}`,
      );
    }
  }

  let pipeline = sharp(Buffer.from(data), {
    raw: { width, height, channels: 4 },
  });

  if (maxWidth || maxHeight) {
    pipeline = pipeline.resize(maxWidth, maxHeight, {
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  return pipeline.jpeg({ quality }).toBuffer();
}

/**
 * HEIC 文件路径 → JPEG buffer（读取文件 + 转换）
 */
export async function heicFileToJpeg(filePath: string, options?: ConvertOptions): Promise<Buffer> {
  const buffer = await readFile(filePath);
  return convertHeicToJpeg(buffer, options);
}

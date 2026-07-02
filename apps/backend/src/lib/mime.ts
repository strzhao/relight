/**
 * magic byte 优先的图片 content-type 探测
 *
 * 设计哲学对齐 isHeicBuffer（按字节判定，不信任扩展名）。
 * 解决 iPhone 同步 bug：实际是 JPEG 字节（FF D8 FF）的文件被命名为 .HEIC，
 * 导致 getMimeType 按扩展名给出错误的 image/heic，浏览器渲染裂图。
 *
 * 纯函数、零依赖、只读 buffer 头部（最多前 16 字节）。
 * 所有 buffer 读取均 bounds-check，短 buffer 安全降级到 fallback。
 */

const HEIC_BRANDS = new Set(["heic", "heix", "heif", "mif1", "msf1", "hevc", "hevx"]);

/**
 * 读取 buffer 的 ASCII 子串（bounds-check）。
 * 区间越界时返回空串，调用方自然走 fallback 分支。
 */
function ascii(buf: Buffer, start: number, end: number): string {
  if (buf.length < end || start < 0 || start >= end) return "";
  return buf.toString("ascii", start, end);
}

/**
 * 按 magic byte 判定图片 content-type。
 *
 * @param buffer 文件字节（至少前 16 字节有意义；可传完整 buffer）
 * @param fallback 未命中时的兜底值（通常是 adapter.getMimeType 按扩展名的结果）
 * @returns image/* MIME 或 fallback（默认 application/octet-stream）
 */
export function sniffImageContentType(
  buffer: Buffer,
  fallback = "application/octet-stream",
): string {
  if (!buffer || buffer.length < 3) return fallback;

  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF: 47 49 46 38 ("GIF8")
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "image/gif";
  }

  // BMP: 42 4D ("BM")
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "image/bmp";
  }

  // TIFF: 49 49 2A 00 (little-endian) | 4D 4D 00 2A (big-endian)
  if (buffer.length >= 4) {
    if (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) {
      return "image/tiff";
    }
    if (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a) {
      return "image/tiff";
    }
  }

  // RIFF…WEBP: offset 0-4 "RIFF" + offset 8-12 "WEBP"
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  // HEIC 家族（ISO base media format）: bytes 4..8 = "ftyp", 8..12 = brand
  if (buffer.length >= 12 && ascii(buffer, 4, 8) === "ftyp") {
    const brand = ascii(buffer, 8, 12).toLowerCase();
    if (HEIC_BRANDS.has(brand)) {
      return "image/heic";
    }
  }

  return fallback;
}

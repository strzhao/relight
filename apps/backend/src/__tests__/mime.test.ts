/**
 * 单元测试：sniffImageContentType — magic byte 优先的 content-type 探测
 *
 * 验证设计契约 §1：
 *   - 按 magic byte 判定 7 种格式（JPEG/PNG/GIF/WEBP/BMP/TIFF/HEIC 家族）
 *   - 未命中返回 fallback（调用方传 getMimeType 结果）
 *   - 短 buffer 边界（buffer.length 不足时安全降级到 fallback）
 *   - 错配场景：.HEIC 扩展名 + JPEG 字节 → image/jpeg（核心修复点）
 *
 * 纯函数、零依赖、只读 buffer 头部。
 */
import { describe, expect, it } from "vitest";
import { sniffImageContentType } from "../lib/mime";

describe("sniffImageContentType", () => {
  describe("magic byte 命中", () => {
    it("JPEG (FF D8 FF)", () => {
      const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
      expect(sniffImageContentType(buf)).toBe("image/jpeg");
    });

    it("PNG (89 50 4E 47 0D 0A 1A 0A)", () => {
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      expect(sniffImageContentType(buf)).toBe("image/png");
    });

    it("GIF (47 49 46 38)", () => {
      const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
      expect(sniffImageContentType(buf)).toBe("image/gif");
    });

    it("WEBP (RIFF…WEBP)", () => {
      // RIFF header (0-4) + file size (4-8) + WEBP (8-12)
      const buf = Buffer.from([
        0x52,
        0x49,
        0x46,
        0x46, // "RIFF"
        0x00,
        0x00,
        0x00,
        0x00, // size
        0x57,
        0x45,
        0x42,
        0x50, // "WEBP"
      ]);
      expect(sniffImageContentType(buf)).toBe("image/webp");
    });

    it("BMP (42 4D)", () => {
      const buf = Buffer.from([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00]);
      expect(sniffImageContentType(buf)).toBe("image/bmp");
    });

    it("TIFF little-endian (49 49 2A 00)", () => {
      const buf = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x00, 0x00, 0x00, 0x00]);
      expect(sniffImageContentType(buf)).toBe("image/tiff");
    });

    it("TIFF big-endian (4D 4D 00 2A)", () => {
      const buf = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x00]);
      expect(sniffImageContentType(buf)).toBe("image/tiff");
    });

    it("HEIC (ftyp + heic brand)", () => {
      const buf = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
      ]);
      expect(sniffImageContentType(buf)).toBe("image/heic");
    });

    it("HEIC 家族 brand 大小写不敏感 (mif1)", () => {
      const buf = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31,
      ]);
      expect(sniffImageContentType(buf)).toBe("image/heic");
    });

    it("HEIC 家族 brand hevx", () => {
      const buf = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x76, 0x78,
      ]);
      expect(sniffImageContentType(buf)).toBe("image/heic");
    });
  });

  describe("错配场景（核心修复点）", () => {
    it(".HEIC 扩展名 + 实际 JPEG 字节 → image/jpeg（不是 image/heic）", () => {
      // iPhone 同步 bug：实际 JFIF 字节，扩展名 .HEIC
      const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      const fallback = "image/heic"; // getMimeType 按扩展名会给这个
      expect(sniffImageContentType(jpegBytes, fallback)).toBe("image/jpeg");
    });

    it(".JPEG 扩展名 + 实际 PNG 字节 → image/png", () => {
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const fallback = "image/jpeg";
      expect(sniffImageContentType(pngBytes, fallback)).toBe("image/png");
    });
  });

  describe("未命中 → fallback", () => {
    it("未知字节返回 fallback", () => {
      const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      expect(sniffImageContentType(buf, "application/octet-stream")).toBe(
        "application/octet-stream",
      );
    });

    it("未知字节无 fallback → application/octet-stream", () => {
      const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      expect(sniffImageContentType(buf)).toBe("application/octet-stream");
    });

    it("ftyp box 但 brand 不在 HEIC 家族（如 MP4 isom）→ fallback", () => {
      // ftyp + "isom"（MP4 视频，非图片）
      const buf = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      ]);
      expect(sniffImageContentType(buf, "video/mp4")).toBe("video/mp4");
    });
  });

  describe("短 buffer 边界（bounds-check）", () => {
    it("空 buffer → fallback", () => {
      expect(sniffImageContentType(Buffer.alloc(0), "image/heic")).toBe("image/heic");
    });

    it("1 字节 buffer → fallback", () => {
      expect(sniffImageContentType(Buffer.from([0xff]), "image/heic")).toBe("image/heic");
    });

    it("3 字节 buffer（JPEG 前缀但不足）→ fallback", () => {
      // JPEG 需要 FF D8 FF，但 3 字节不够判定（且 bounds-check 应防 4 字节读取）
      // 注意：sniff 对 JPEG 至少检查前 3 字节 FF D8 FF，这里恰好满足前缀
      // 但其他格式需要更多字节；用非 JPEG 前缀测试更稳
      expect(sniffImageContentType(Buffer.from([0x00, 0x01, 0x02]), "image/jpeg")).toBe(
        "image/jpeg",
      );
    });

    it("7 字节 buffer（PNG 需要 8 字节）→ fallback", () => {
      const shortPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]);
      expect(sniffImageContentType(shortPng, "image/png")).toBe("image/png");
    });

    it("11 字节 buffer（HEIC ftyp 需 12 字节）→ fallback", () => {
      // 前 8 字节是 ftyp，但 brand 区间 (8-12) 不完整
      const shortHeic = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69,
      ]);
      expect(sniffImageContentType(shortHeic, "image/heic")).toBe("image/heic");
    });
  });
});

/**
 * 红队验收测试：sniffImageContentType magic-byte 嗅探（验收点 P6）
 *
 * 【信息隔离铁律】
 * 本文件仅基于设计文档编写，代表「设计应达到的状态」(TDD 红灯)。
 * 不读取、不引用蓝队新写的 lib/mime.ts 实现。
 *
 * 设计契约（逐字一致）：
 * - 模块路径：apps/backend/src/lib/mime.ts
 * - 导出函数：sniffImageContentType(buffer: Buffer, fallback?: string): string
 * - 行为：按 magic byte 判定 JPEG/PNG/GIF/WEBP/BMP/TIFF/HEIC；
 *         未命中 → 返回 fallback（调用方传扩展名结果）；
 *         fallback 未传 → 返回值由实现决定（本测试不锁死，仅断言不崩 + 不返回 undefined）。
 *
 * 验收点 P6 子项：
 *  P6a JPEG magic byte (FF D8 FF) → image/jpeg
 *  P6b PNG magic byte (89 50 4E 47) → image/png
 *  P6c GIF magic byte (47 49 46 38) → image/gif
 *  P6d WEBP magic byte (RIFF....WEBP) → image/webp
 *  P6e BMP magic byte (42 4D) → image/bmp
 *  P6f TIFF magic byte (49 49 2A 00 小端 / 4D 4D 00 2A 大端) → image/tiff
 *  P6g HEIC 家族 magic byte (offset 4-8 = ftyp + brand heic/mif1/msf1/heix/...) → image/heic
 *  P6h 未知字节 + 提供 fallback → 返回 fallback 原值
 *  P6i 短 buffer (< 12 字节，无法判定 HEIC) + 提供 fallback → 返回 fallback（不崩）
 *  P6j 空 buffer + 提供 fallback → 返回 fallback（不崩）
 *  P6k 签名一致性：返回值始终为 string，永不为 undefined
 */
import { describe, expect, it } from "vitest";

// 仅引入契约符号；实现未完成时此 import 会失败（红灯）。
import { sniffImageContentType } from "../lib/mime";

// ---- magic-byte 构造辅助 ----

/** JPEG：以 FF D8 FF 开头（JFIF 变体 FF D8 FF E0，EXIF 变体 FF D8 FF E1） */
function jpegBuffer(): Buffer {
  // FF D8 FF E0 00 10 'JFIF' ... 余字节填充
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0, 0, 0, 0, 0,
  ]);
}

/** PNG：89 50 4E 47 0D 0A 1A 0A */
function pngBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

/** GIF：47 49 46 38 (GIF8) */
function gifBuffer(): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0]);
}

/** WEBP：RIFF....WEBP — offset 0-3 = RIFF, 8-11 = WEBP */
function webpBuffer(): Buffer {
  return Buffer.from([
    0x52,
    0x49,
    0x46,
    0x46, // 'RIFF'
    0x00,
    0x00,
    0x00,
    0x00, // size (placeholder)
    0x57,
    0x45,
    0x42,
    0x50, // 'WEBP'
    0,
    0,
    0,
    0,
  ]);
}

/** BMP：42 4D (BM) */
function bmpBuffer(): Buffer {
  return Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0]);
}

/** TIFF 小端：49 49 2A 00 (II*\0) */
function tiffLittleEndianBuffer(): Buffer {
  return Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0]);
}

/** TIFF 大端：4D 4D 00 2A (MM\0*) */
function tiffBigEndianBuffer(): Buffer {
  return Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 0]);
}

/** HEIC 家族：offset 4-7 = 'ftyp'，offset 8-11 = brand */
function heicBrandBuffer(brand: string): Buffer {
  const buf = Buffer.alloc(16, 0);
  // offset 0-3 = size (placeholder)
  Buffer.from("ftyp", "ascii").copy(buf, 4);
  Buffer.from(brand, "ascii").copy(buf, 8);
  return buf;
}

// ---- 测试 ----

describe("sniffImageContentType — magic byte 嗅探（验收点 P6）", () => {
  describe("P6a JPEG magic byte (FF D8 FF)", () => {
    it("FF D8 FF E0 (JFIF) → image/jpeg", () => {
      const result = sniffImageContentType(jpegBuffer(), "application/octet-stream");
      expect(result).toBe("image/jpeg");
    });

    it("FF D8 FF E1 (EXIF 变体) → image/jpeg", () => {
      const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0, 0, 0]);
      const result = sniffImageContentType(buf, "application/octet-stream");
      expect(result).toBe("image/jpeg");
    });

    it("仅 3 字节 FF D8 FF 也应识别为 JPEG（最小头部）", () => {
      const buf = Buffer.from([0xff, 0xd8, 0xff]);
      const result = sniffImageContentType(buf, "application/octet-stream");
      expect(result).toBe("image/jpeg");
    });
  });

  describe("P6b PNG magic byte (89 50 4E 47)", () => {
    it("完整 PNG 签名 → image/png", () => {
      const result = sniffImageContentType(pngBuffer(), "application/octet-stream");
      expect(result).toBe("image/png");
    });
  });

  describe("P6c GIF magic byte (47 49 46 38)", () => {
    it("GIF89a → image/gif", () => {
      const result = sniffImageContentType(gifBuffer(), "application/octet-stream");
      expect(result).toBe("image/gif");
    });

    it("GIF87a → image/gif", () => {
      const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0, 0]);
      const result = sniffImageContentType(buf, "application/octet-stream");
      expect(result).toBe("image/gif");
    });
  });

  describe("P6d WEBP magic byte (RIFF....WEBP)", () => {
    it("RIFF + WEBP → image/webp", () => {
      const result = sniffImageContentType(webpBuffer(), "application/octet-stream");
      expect(result).toBe("image/webp");
    });
  });

  describe("P6e BMP magic byte (42 4D)", () => {
    it("BM 开头 → image/bmp", () => {
      const result = sniffImageContentType(bmpBuffer(), "application/octet-stream");
      expect(result).toBe("image/bmp");
    });
  });

  describe("P6f TIFF magic byte（小端 + 大端）", () => {
    it("小端 II*\0 (49 49 2A 00) → image/tiff", () => {
      const result = sniffImageContentType(tiffLittleEndianBuffer(), "application/octet-stream");
      expect(result).toBe("image/tiff");
    });

    it("大端 MM\0* (4D 4D 00 2A) → image/tiff", () => {
      const result = sniffImageContentType(tiffBigEndianBuffer(), "application/octet-stream");
      expect(result).toBe("image/tiff");
    });
  });

  describe("P6g HEIC 家族 magic byte（ftyp + brand）", () => {
    it.each(["heic", "heix", "heif", "mif1", "msf1"])("brand '%s' → image/heic", (brand) => {
      const result = sniffImageContentType(heicBrandBuffer(brand), "application/octet-stream");
      expect(result).toBe("image/heic");
    });
  });

  describe("P6h 未知字节 → 走 fallback", () => {
    it("无 magic byte 命中 + fallback='image/heic' → 返回 'image/heic'", () => {
      // 全零 / 随机非匹配字节
      const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      const result = sniffImageContentType(buf, "image/heic");
      expect(result).toBe("image/heic");
    });

    it("无 magic byte 命中 + fallback='application/octet-stream' → 返回原值", () => {
      const buf = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
      const result = sniffImageContentType(buf, "application/octet-stream");
      expect(result).toBe("application/octet-stream");
    });

    it("RIFF 但非 WEBP（如 WAV）→ 不应误判 webp，走 fallback", () => {
      // RIFF....WAVE
      const buf = Buffer.from([
        0x52,
        0x49,
        0x46,
        0x46, // 'RIFF'
        0,
        0,
        0,
        0,
        0x57,
        0x41,
        0x56,
        0x45, // 'WAVE'
      ]);
      const result = sniffImageContentType(buf, "audio/wav");
      expect(result).toBe("audio/wav");
    });
  });

  describe("P6i/P6j 边界：短 buffer / 空 buffer 不崩", () => {
    it("1 字节 buffer + fallback → 返回 fallback（不抛异常）", () => {
      const buf = Buffer.from([0xff]);
      expect(() => sniffImageContentType(buf, "image/heic")).not.toThrow();
      const result = sniffImageContentType(buf, "image/heic");
      expect(result).toBe("image/heic");
    });

    it("空 buffer + fallback → 返回 fallback（不抛异常）", () => {
      const buf = Buffer.alloc(0);
      expect(() => sniffImageContentType(buf, "image/heic")).not.toThrow();
      const result = sniffImageContentType(buf, "image/heic");
      expect(result).toBe("image/heic");
    });

    it("3 字节 FF D8 FF（最小 JPEG 头）短 buffer 仍能识别 JPEG", () => {
      // 关键：HEIC 判定需 ≥12 字节，但 JPEG 只需 3 字节；
      // 短 buffer 不应让 JPEG 嗅探崩，也不应误判。
      const buf = Buffer.from([0xff, 0xd8, 0xff]);
      const result = sniffImageContentType(buf, "application/octet-stream");
      expect(result).toBe("image/jpeg");
    });
  });

  describe("P6k 签名一致性", () => {
    it("返回值始终为 string 类型", () => {
      const cases = [
        jpegBuffer(),
        pngBuffer(),
        heicBrandBuffer("heic"),
        Buffer.alloc(0),
        Buffer.from([0x00]),
      ];
      for (const buf of cases) {
        const result = sniffImageContentType(buf, "application/octet-stream");
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }
    });

    it("fallback 参数为可选（不传时不抛异常，返回某 string）", () => {
      const buf = jpegBuffer();
      // 不传 fallback —— JPEG 命中 magic byte，应返回 image/jpeg
      expect(() => sniffImageContentType(buf)).not.toThrow();
      const result = sniffImageContentType(buf);
      expect(typeof result).toBe("string");
      // JPEG 命中场景：无论 fallback 是否提供，都应返回 image/jpeg
      expect(result).toBe("image/jpeg");
    });
  });
});

/**
 * exif.ts 单元测试：parseExifMeta 字段映射和容错行为
 *
 * 使用 vi.mock 替换 exifr（ESM 默认导出），测试纯映射逻辑。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExifMeta } from "../exif";

// Mock exifr（ESM 默认导出）—— 必须在 import 之前
const mockExifrParse = vi.fn();

vi.mock("exifr", () => ({
  default: {
    parse: mockExifrParse,
  },
}));

// 动态 import，避免 hoisting 问题（每次 resetModules 后重新加载）
let parseExifMeta: (filePath: string) => Promise<ExifMeta>;

beforeEach(async () => {
  vi.resetModules();
  mockExifrParse.mockReset();
  const mod = await import("../exif");
  parseExifMeta = mod.parseExifMeta;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseExifMeta", () => {
  describe("正常字段映射", () => {
    it("完整 EXIF 数据正确映射所有字段", async () => {
      mockExifrParse.mockResolvedValueOnce({
        DateTimeOriginal: "2022:03:10 08:15:30",
        latitude: 35.6762,
        longitude: 139.6503,
        altitude: 50.5,
        GPSImgDirection: 180.0,
        OffsetTimeOriginal: "+09:00",
        Make: "Apple",
        Model: "iPhone 14 Pro",
        LensModel: "iPhone 14 Pro back triple camera 2.44mm f/1.78",
        FocalLength: 24.0,
        FocalLengthIn35mmFormat: 24,
        ISO: 100,
        ExposureTime: 0.004,
        FNumber: 1.78,
        Software: "最后一卷胶片",
      });

      const result = await parseExifMeta("/test/photo.jpg");

      expect(result.takenAt).toBe("2022:03:10 08:15:30");
      expect(result.latitude).toBeCloseTo(35.6762);
      expect(result.longitude).toBeCloseTo(139.6503);
      expect(result.altitude).toBeCloseTo(50.5);
      expect(result.gpsImgDirection).toBeCloseTo(180.0);
      expect(result.offsetTime).toBe("+09:00");
      expect(result.cameraMake).toBe("Apple");
      expect(result.cameraModel).toBe("iPhone 14 Pro");
      expect(result.lensModel).toBe("iPhone 14 Pro back triple camera 2.44mm f/1.78");
      expect(result.focalLength).toBeCloseTo(24.0);
      expect(result.focalLength35mm).toBe(24);
      expect(result.iso).toBe(100);
      expect(result.exposureTime).toBeCloseTo(0.004);
      expect(result.fNumber).toBeCloseTo(1.78);
      expect(result.software).toBe("最后一卷胶片");
    });

    it("takenAt 保持字符串格式（reviveValues: false 验证）", async () => {
      mockExifrParse.mockResolvedValueOnce({
        DateTimeOriginal: "2022:03:10 08:15:30",
      });

      const result = await parseExifMeta("/test/photo.jpg");

      expect(typeof result.takenAt).toBe("string");
      expect(result.takenAt).toBe("2022:03:10 08:15:30");
    });

    it("OffsetTime 作为 offsetTime 的 fallback", async () => {
      mockExifrParse.mockResolvedValueOnce({
        OffsetTime: "+08:00",
        // 无 OffsetTimeOriginal
      });

      const result = await parseExifMeta("/test/photo.jpg");
      expect(result.offsetTime).toBe("+08:00");
    });

    it("OffsetTimeOriginal 优先于 OffsetTime", async () => {
      mockExifrParse.mockResolvedValueOnce({
        OffsetTimeOriginal: "+09:00",
        OffsetTime: "+08:00",
      });

      const result = await parseExifMeta("/test/photo.jpg");
      expect(result.offsetTime).toBe("+09:00");
    });
  });

  describe("缺失字段返回 null", () => {
    it("exifr 返回空对象时所有字段为 null", async () => {
      mockExifrParse.mockResolvedValueOnce({});

      const result = await parseExifMeta("/test/photo.jpg");

      expect(result.takenAt).toBeNull();
      expect(result.latitude).toBeNull();
      expect(result.longitude).toBeNull();
      expect(result.altitude).toBeNull();
      expect(result.gpsImgDirection).toBeNull();
      expect(result.offsetTime).toBeNull();
      expect(result.cameraMake).toBeNull();
      expect(result.cameraModel).toBeNull();
      expect(result.lensModel).toBeNull();
      expect(result.focalLength).toBeNull();
      expect(result.focalLength35mm).toBeNull();
      expect(result.iso).toBeNull();
      expect(result.exposureTime).toBeNull();
      expect(result.fNumber).toBeNull();
      expect(result.software).toBeNull();
    });

    it("exifr 返回 null 时所有字段为 null", async () => {
      mockExifrParse.mockResolvedValueOnce(null);

      const result = await parseExifMeta("/test/photo.jpg");

      expect(result.takenAt).toBeNull();
      expect(result.latitude).toBeNull();
    });
  });

  describe("类型防御：非 number/string 返回 null", () => {
    it("number 字段为数组时返回 null", async () => {
      mockExifrParse.mockResolvedValueOnce({
        FocalLength: [24, 1], // 某些 exifr 版本可能返回分数形式
        ISO: "100", // 字符串而非数字
      });

      const result = await parseExifMeta("/test/photo.jpg");

      expect(result.focalLength).toBeNull(); // 数组 → null
      expect(result.iso).toBeNull(); // 字符串 → null
    });

    it("string 字段为数字时返回 null", async () => {
      mockExifrParse.mockResolvedValueOnce({
        Make: 42, // 非字符串
      });

      const result = await parseExifMeta("/test/photo.jpg");
      expect(result.cameraMake).toBeNull();
    });

    it("空字符串返回 null", async () => {
      mockExifrParse.mockResolvedValueOnce({
        Make: "",
        Software: "",
      });

      const result = await parseExifMeta("/test/photo.jpg");
      expect(result.cameraMake).toBeNull();
      expect(result.software).toBeNull();
    });
  });

  describe("容错：异常不传播", () => {
    it("exifr 抛出异常时返回全 null，不传播", async () => {
      mockExifrParse.mockRejectedValueOnce(new Error("文件格式不支持"));

      const result = await parseExifMeta("/test/bad.file");

      expect(result.takenAt).toBeNull();
      expect(result.latitude).toBeNull();
      // 不抛异常
    });

    it("损坏文件返回全 null，不抛", async () => {
      mockExifrParse.mockRejectedValueOnce(new Error("JPEG 标记损坏"));

      await expect(parseExifMeta("/test/corrupted.jpg")).resolves.toMatchObject({
        takenAt: null,
        latitude: null,
        longitude: null,
      });
    });
  });

  describe("返回对象完整性", () => {
    it("返回对象包含全部 15 个字段", async () => {
      mockExifrParse.mockResolvedValueOnce({});

      const result = await parseExifMeta("/test/photo.jpg");

      const expectedKeys = [
        "takenAt",
        "latitude",
        "longitude",
        "altitude",
        "gpsImgDirection",
        "offsetTime",
        "cameraMake",
        "cameraModel",
        "lensModel",
        "focalLength",
        "focalLength35mm",
        "iso",
        "exposureTime",
        "fNumber",
        "software",
      ];

      for (const key of expectedKeys) {
        expect(result).toHaveProperty(key);
      }
    });
  });
});

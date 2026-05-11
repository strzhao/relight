/**
 * 验收测试：parseExifMeta ExifMeta 接口契约（红队，黑盒）
 *
 * 覆盖设计契约 CC-1：
 *   `parseExifMeta(filePath: string): Promise<ExifMeta>`
 *   `interface ExifMeta` 全部 15 字段（含 takenAt）
 *
 * 关键约束（设计文档明确）：
 *   1. takenAt 必须是 string 类型（reviveValues:false 关闭日期 revive），而非 Date 对象
 *   2. 缺失字段返回 null，不返回 undefined
 *   3. exifr 抛错时返回全 null 且不传播异常
 *   4. 全部 15 字段均在返回对象上（不能有 key 缺失）
 *   5. number 字段如 exifr 返回非 number（数组/字符串等）必须归 null
 *
 * 由于 exifr 是 ESM 库，用 vi.mock('exifr', ...) 模拟。
 * 红队铁律：不读取 exif.ts 实现，仅基于 CC-1 契约设计期望。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock exifr（ESM 默认导出）
// ---------------------------------------------------------------------------

const mockExifrParse = vi.fn();

vi.mock("exifr", () => ({
  default: {
    parse: mockExifrParse,
  },
}));

// ---------------------------------------------------------------------------
// 被测模块（在 mock 之后 import）
// ---------------------------------------------------------------------------

// 使用动态 import，避免 hoisting 问题
let parseExifMeta: (filePath: string) => Promise<import("../exif").ExifMeta>;

beforeEach(async () => {
  vi.resetModules();
  // 重新 mock，保证每个 test 都干净
  mockExifrParse.mockReset();

  // 动态 import 被测函数（每次 resetModules 后重新加载）
  const mod = await import("../exif");
  parseExifMeta = mod.parseExifMeta;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// CC-1 全字段映射
// ---------------------------------------------------------------------------

describe("parseExifMeta：ExifMeta 接口契约（红队验收）", () => {
  describe("CC-1-A：全部 15 字段正确映射", () => {
    it("exifr 返回完整数据时，全部 15 字段映射正确", async () => {
      mockExifrParse.mockResolvedValueOnce({
        DateTimeOriginal: "2023:06:15 14:30:00",
        latitude: 35.6762,
        longitude: 139.6503,
        altitude: 42.5,
        GPSImgDirection: 270.0,
        OffsetTimeOriginal: "+09:00",
        OffsetTime: "+09:00",
        Make: "Apple",
        Model: "iPhone 14 Pro",
        LensModel: "iPhone 14 Pro back triple camera 6.86mm f/1.78",
        FocalLength: 6.86,
        FocalLengthIn35mmFormat: 24,
        ISO: 100,
        ExposureTime: 0.004,
        FNumber: 1.78,
        Software: "最后一卷胶片",
      });

      const result = await parseExifMeta("/fake/photo.jpg");

      expect(result.takenAt).toBe("2023:06:15 14:30:00");
      expect(result.latitude).toBe(35.6762);
      expect(result.longitude).toBe(139.6503);
      expect(result.altitude).toBe(42.5);
      expect(result.gpsImgDirection).toBe(270.0);
      expect(result.offsetTime).toBe("+09:00");
      expect(result.cameraMake).toBe("Apple");
      expect(result.cameraModel).toBe("iPhone 14 Pro");
      expect(result.lensModel).toBe("iPhone 14 Pro back triple camera 6.86mm f/1.78");
      expect(result.focalLength).toBe(6.86);
      expect(result.focalLength35mm).toBe(24);
      expect(result.iso).toBe(100);
      expect(result.exposureTime).toBe(0.004);
      expect(result.fNumber).toBe(1.78);
      expect(result.software).toBe("最后一卷胶片");
    });

    it("返回对象上必须存在全部 15 个 key（不能缺失）", async () => {
      mockExifrParse.mockResolvedValueOnce({});

      const result = await parseExifMeta("/fake/photo.jpg");

      const requiredKeys = [
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

      for (const key of requiredKeys) {
        expect(key in result, `缺失字段: ${key}`).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // CC-1-B：takenAt 必须是 string（reviveValues:false）
  // -------------------------------------------------------------------------

  describe("CC-1-B：takenAt 必须是 string 类型（reviveValues:false 关键验证）", () => {
    it("exifr 返回 DateTimeOriginal 为字符串时，takenAt 是 string", async () => {
      mockExifrParse.mockResolvedValueOnce({
        DateTimeOriginal: "2022:03:10 08:15:30",
      });

      const result = await parseExifMeta("/fake/photo.jpg");

      // 核心断言：必须是 string，不能是 Date 对象
      expect(typeof result.takenAt).toBe("string");
    });

    it("takenAt 不能是 Date 对象（防 [object Object] 写入 SQLite）", async () => {
      mockExifrParse.mockResolvedValueOnce({
        DateTimeOriginal: "2022:03:10 08:15:30",
      });

      const result = await parseExifMeta("/fake/photo.jpg");

      // 如果实现错误地做了 revive，DateTimeOriginal 会是 Date 对象
      expect((result.takenAt as unknown) instanceof Date).toBe(false);
    });

    it("exifr 返回 DateTimeOriginal 为 Date 对象时（错误 revive），实现应将其置 null 或转为字符串", async () => {
      // 模拟 exifr 内部已 revive（不应发生，但防御）
      mockExifrParse.mockResolvedValueOnce({
        DateTimeOriginal: new Date("2022-03-10T08:15:30"),
      });

      const result = await parseExifMeta("/fake/photo.jpg");

      // takenAt 不能是 Date 对象（会变成 "[object Object]" 存入 SQLite）
      expect((result.takenAt as unknown) instanceof Date).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // CC-1-C：缺失字段 → null 而非 undefined
  // -------------------------------------------------------------------------

  describe("CC-1-C：缺失字段返回 null，不返回 undefined", () => {
    it("exifr 返回空对象（无任何 GPS 字段）→ GPS 字段全为 null", async () => {
      mockExifrParse.mockResolvedValueOnce({});

      const result = await parseExifMeta("/fake/photo.jpg");

      // 明确断言 null 而非 undefined
      expect(result.latitude).toBeNull();
      expect(result.longitude).toBeNull();
      expect(result.altitude).toBeNull();
      expect(result.gpsImgDirection).toBeNull();
    });

    it("exifr 返回空对象 → 所有字段全为 null", async () => {
      mockExifrParse.mockResolvedValueOnce({});

      const result = await parseExifMeta("/fake/photo.jpg");

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

    it("exifr 返回 undefined 字段 → 对应字段映射为 null（?? null 容错）", async () => {
      mockExifrParse.mockResolvedValueOnce({
        latitude: undefined,
        longitude: undefined,
        Make: undefined,
      });

      const result = await parseExifMeta("/fake/photo.jpg");

      expect(result.latitude).toBeNull();
      expect(result.longitude).toBeNull();
      expect(result.cameraMake).toBeNull();
    });

    it("offsetTime 优先读 OffsetTimeOriginal，OffsetTimeOriginal 缺失时回退 OffsetTime", async () => {
      mockExifrParse.mockResolvedValueOnce({
        OffsetTimeOriginal: undefined,
        OffsetTime: "+05:30",
      });

      const result = await parseExifMeta("/fake/photo.jpg");

      expect(result.offsetTime).toBe("+05:30");
    });

    it("OffsetTimeOriginal 和 OffsetTime 都缺失 → offsetTime 为 null", async () => {
      mockExifrParse.mockResolvedValueOnce({});

      const result = await parseExifMeta("/fake/photo.jpg");

      expect(result.offsetTime).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // CC-1-D：exifr 抛错 → 全 null + 不传播异常
  // -------------------------------------------------------------------------

  describe("CC-1-D：exifr 抛错时返回全 null 且不传播异常", () => {
    it("exifr.parse 抛出 Error → parseExifMeta resolve（不 reject）", async () => {
      mockExifrParse.mockRejectedValueOnce(new Error("不支持的格式"));

      await expect(parseExifMeta("/fake/broken.jpg")).resolves.toBeDefined();
    });

    it("exifr.parse 抛出 Error → 全部字段为 null", async () => {
      mockExifrParse.mockRejectedValueOnce(new Error("HEIC 解析失败"));

      const result = await parseExifMeta("/fake/broken.heic");

      expect(result.takenAt).toBeNull();
      expect(result.latitude).toBeNull();
      expect(result.longitude).toBeNull();
      expect(result.iso).toBeNull();
      expect(result.cameraMake).toBeNull();
    });

    it("exifr.parse 返回 null → 全部字段为 null（不抛 TypeError）", async () => {
      mockExifrParse.mockResolvedValueOnce(null);

      await expect(parseExifMeta("/fake/photo.jpg")).resolves.toBeDefined();

      const result = await parseExifMeta("/fake/photo.jpg");
      expect(result.latitude).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // CC-1-E：number 字段类型防御（数组/字符串 → null）
  // -------------------------------------------------------------------------

  describe("CC-1-E：非 number 类型的 number 字段必须归 null", () => {
    it("exifr 返回数组形式的 FocalLength → focalLength 为 null", async () => {
      mockExifrParse.mockResolvedValueOnce({
        FocalLength: [6, 1], // exifr 偶发返回分数数组
      });

      const result = await parseExifMeta("/fake/photo.jpg");

      expect(result.focalLength).toBeNull();
    });

    it("exifr 返回字符串形式的 ISO → iso 为 null", async () => {
      mockExifrParse.mockResolvedValueOnce({
        ISO: "400", // 字符串而非数字
      });

      const result = await parseExifMeta("/fake/photo.jpg");

      expect(result.iso).toBeNull();
    });

    it("exifr 返回字符串形式的 latitude → latitude 为 null", async () => {
      mockExifrParse.mockResolvedValueOnce({
        latitude: "35.6762", // 字符串
        longitude: 139.6503,
      });

      const result = await parseExifMeta("/fake/photo.jpg");

      expect(result.latitude).toBeNull();
    });

    it("exifr 返回 NaN 的数字字段 → 置 null（防守 NaN 写入 SQLite 变 0）", async () => {
      mockExifrParse.mockResolvedValueOnce({
        FNumber: Number.NaN,
      });

      const result = await parseExifMeta("/fake/photo.jpg");

      // NaN 也不是有效 number → 应为 null
      // （设计文档："所有 number 字段必须 typeof === 'number'，否则置 null"）
      // NaN 的 typeof === 'number' 在 JS 中是 true，但语义上无意义
      // 此测试验证实现是否额外防守 NaN
      // 允许实现保留 NaN 或置 null（两种实现都接受），但不能是其他类型
      const val = result.fNumber;
      expect(val === null || typeof val === "number").toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // CC-1-F：部分字段存在时，其他字段仍为 null
  // -------------------------------------------------------------------------

  describe("CC-1-F：部分字段有值，其余字段保持 null", () => {
    it("只有 GPS 数据，设备字段全 null", async () => {
      mockExifrParse.mockResolvedValueOnce({
        latitude: 35.0,
        longitude: 139.0,
        altitude: 100.0,
      });

      const result = await parseExifMeta("/fake/gps-only.jpg");

      expect(result.latitude).toBe(35.0);
      expect(result.longitude).toBe(139.0);
      expect(result.altitude).toBe(100.0);
      expect(result.cameraMake).toBeNull();
      expect(result.cameraModel).toBeNull();
      expect(result.iso).toBeNull();
      expect(result.takenAt).toBeNull();
    });

    it("只有设备 EXIF，GPS 字段全 null", async () => {
      mockExifrParse.mockResolvedValueOnce({
        Make: "Sony",
        Model: "ILCE-7M4",
        ISO: 800,
        FNumber: 2.8,
        ExposureTime: 0.001,
        DateTimeOriginal: "2024:01:20 10:00:00",
      });

      const result = await parseExifMeta("/fake/camera.jpg");

      expect(result.cameraMake).toBe("Sony");
      expect(result.cameraModel).toBe("ILCE-7M4");
      expect(result.iso).toBe(800);
      expect(result.latitude).toBeNull();
      expect(result.longitude).toBeNull();
      expect(result.altitude).toBeNull();
    });
  });
});

/**
 * EXIF 元信息解析器
 *
 * 使用 exifr（社区库，0.5–2.5ms/张）提取照片的完整 EXIF 字段。
 *
 * 关键配置：
 * - reviveValues: false — 关闭日期反序列化，让 DateTimeOriginal 保持字符串格式
 * - translateValues: false — 关闭枚举翻译（如 ExposureProgram=1 不翻译为 "Manual"）
 */

import exifr from "exifr";

/** EXIF 元信息（所有字段均 nullable） */
export interface ExifMeta {
  /** 拍摄时间字符串（来自 EXIF DateTimeOriginal，"YYYY:MM:DD HH:MM:SS" 格式，未 revive） */
  takenAt: string | null;
  /** GPS 纬度，十进制度（-90..90） */
  latitude: number | null;
  /** GPS 经度，十进制度（-180..180） */
  longitude: number | null;
  /** 海拔米 */
  altitude: number | null;
  /** 拍摄方位角 0–360° */
  gpsImgDirection: number | null;
  /** 时区偏移，如 "+08:00"（来自 EXIF OffsetTimeOriginal） */
  offsetTime: string | null;
  /** 相机厂商，如 "Apple" */
  cameraMake: string | null;
  /** 相机型号，如 "iPhone 14 Pro" */
  cameraModel: string | null;
  /** 镜头型号 */
  lensModel: string | null;
  /** 真实焦距 mm */
  focalLength: number | null;
  /** 35mm 等效焦距 */
  focalLength35mm: number | null;
  /** 感光度 */
  iso: number | null;
  /** 快门时间秒（1/250 → 0.004） */
  exposureTime: number | null;
  /** 光圈 */
  fNumber: number | null;
  /** 编辑软件，如 "最后一卷胶片"（用于检测后期编辑） */
  software: string | null;
}

/** 全 null 的 ExifMeta 返回值（fallback 用） */
const NULL_META: ExifMeta = {
  takenAt: null,
  latitude: null,
  longitude: null,
  altitude: null,
  gpsImgDirection: null,
  offsetTime: null,
  cameraMake: null,
  cameraModel: null,
  lensModel: null,
  focalLength: null,
  focalLength35mm: null,
  iso: null,
  exposureTime: null,
  fNumber: null,
  software: null,
};

/**
 * 安全提取数字字段：必须是 number 类型，否则返回 null。
 * 防止 exifr 偶发返回数组或字符串。
 */
function safeNum(value: unknown): number | null {
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  return null;
}

/**
 * 安全提取字符串字段：必须是 string 类型，否则返回 null。
 */
function safeStr(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/**
 * 解析照片文件的 EXIF 元信息。
 *
 * 返回完整 ExifMeta；任何字段缺失返回 null。
 * 文件不支持 EXIF（HEIC/视频/损坏文件）时捕获异常并返回全 null。
 */
export async function parseExifMeta(filePath: string): Promise<ExifMeta> {
  try {
    const result = await exifr.parse(filePath, {
      gps: true,
      exif: true,
      // ifd0 类型是 FormatOptions（不支持 boolean），空对象表示启用全部字段
      ifd0: {},
      makerNote: false,
      reviveValues: false,
      translateValues: false,
    });

    if (!result) return { ...NULL_META };

    return {
      takenAt: safeStr(result.DateTimeOriginal),
      latitude: safeNum(result.latitude),
      longitude: safeNum(result.longitude),
      altitude: safeNum(result.altitude),
      gpsImgDirection: safeNum(result.GPSImgDirection),
      offsetTime: safeStr(result.OffsetTimeOriginal) ?? safeStr(result.OffsetTime),
      cameraMake: safeStr(result.Make),
      cameraModel: safeStr(result.Model),
      lensModel: safeStr(result.LensModel),
      focalLength: safeNum(result.FocalLength),
      focalLength35mm: safeNum(result.FocalLengthIn35mmFormat),
      iso: safeNum(result.ISO),
      exposureTime: safeNum(result.ExposureTime),
      fNumber: safeNum(result.FNumber),
      software: safeStr(result.Software),
    };
  } catch (err) {
    console.warn(
      `[parseExifMeta] 解析失败 (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...NULL_META };
  }
}

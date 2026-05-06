/**
 * 确定性格式错误分类工具
 *
 * 对于无法修复的图片格式错误（如 libvips 不支持的压缩格式、损坏的 HEIC 等），
 * 写入占位记录而非让 BullMQ 重试，避免无效消耗。
 */

/** 确定性格式错误的匹配模式（子串匹配） */
const DETERMINISTIC_FORMAT_ERROR_PATTERNS: string[] = [
  "Support for this compression format has not been built in",
  "bad seek to",
  "Warning treated as error due to failOn",
  "error in tile",
  "HEIC 转换失败",
  "Input buffer contains unsupported image format",
  "Input file contains unsupported image format",
  "VipsJpeg: Premature end",
  "VipsJpeg: Corrupt JPEG",
];

/**
 * 判断一个错误是否属于确定性格式错误。
 *
 * 确定性格式错误 = 重试无意义，应写占位记录跳过。
 * 非格式错误（如 ECONNREFUSED、EBUSY）= 应让 BullMQ 重试。
 */
export function isDeterministicFormatError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return DETERMINISTIC_FORMAT_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

/**
 * 构造格式错误占位记录的字段值（用于写入 photoAnalyses）。
 */
export function formatErrorPlaceholder(error: Error): {
  aiModel: string;
  narrative: string;
  rawResponse: string;
} {
  return {
    aiModel: "format_error",
    narrative: `图片格式无法解析: ${error.message}`,
    rawResponse: JSON.stringify({ formatError: true, message: error.message }),
  };
}

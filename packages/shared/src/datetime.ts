/**
 * 拍摄时刻格式化（纯函数，零副作用）
 *
 * 三端一致约束（浏览器 / Node / Satori）：不调用 Date.now()，不依赖任何外部状态。
 * 时区约定：takenAt 存储为 ISO（含 Z 后缀），显示侧用 new Date(iso) 的本地时区取回
 * Y/M/D/H/M——仅当扫描机 == 显示机时区一致时正确往返（本应用单 Mac 自部署成立）。
 */

/**
 * 将照片拍摄时刻 ISO 字符串格式化为中文展示串。
 *
 * @param takenAt ISO 字符串（含时分秒），或 null/无效
 * @returns `"YYYY年MM月DD日 HH:MM"`（月日时分零填充 2 位，年 4 位）；null/无效 → null
 *
 * @example
 * formatPhotoCaptureTime("2021-06-15T06:30:00.000Z") // +08:00 机 → "2021年06月15日 14:30"
 * formatPhotoCaptureTime(null) // null
 * formatPhotoCaptureTime("not-a-date") // null
 */
export function formatPhotoCaptureTime(takenAt: string | null): string | null {
  if (!takenAt) return null;
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return null;

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");

  return `${year}年${month}月${day}日 ${hours}:${minutes}`;
}

/**
 * hero 拍摄时刻 dateline（壁纸视频字幕层 footer 用；原 template.tsx calcYearsAgo 提取复用）。
 *
 * 「拍摄于 …」文案与 web/静态壁纸同源：时刻文本 = shared `formatPhotoCaptureTime`
 * （三端一致约束见 packages/shared/src/datetime.ts），年份差「 · N 年前」在此补充拼接
 * （shared 为冻结契约层——cli-blackbox 验收点 8 守护其零改动，故年份差辅助留在 backend）。
 */
import { formatPhotoCaptureTime } from "@relight/shared";

/**
 * 计算 takenAt 与今日的年份差（与 web 端 calcYearsAgo 约定一致）。
 * 返回正整数；< 1 年或无效输入返回 null。
 */
export function calcYearsAgo(takenAt: string | null): number | null {
  if (!takenAt) return null;
  const taken = new Date(takenAt);
  if (Number.isNaN(taken.getTime())) return null;
  const yearDiff = new Date().getFullYear() - taken.getFullYear();
  return yearDiff >= 1 ? yearDiff : null;
}

/**
 * footer 拍摄时刻 dateline（与 web CaptureDateline / 静态壁纸 template.tsx 同源）：
 * `formatPhotoCaptureTime(takenAt)` + 可选「 · N 年前」（calcYearsAgo）。
 * takenAt null/无效 → null（模板 footer 不渲染，与静态壁纸 footer 留白约定一致）。
 */
export function buildCaptureDateline(takenAt?: string | null): string | null {
  const text = formatPhotoCaptureTime(takenAt ?? null);
  if (!text) return null;
  const years = calcYearsAgo(takenAt ?? null);
  return years !== null ? `${text} · ${years} 年前` : text;
}

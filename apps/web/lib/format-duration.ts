/**
 * 把秒数格式化为人类可读时长。
 * - 小于 1 小时：M:SS（如 0:42、3:05）
 * - 大于等于 1 小时：H:MM:SS（如 1:23:45）
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 3600) return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

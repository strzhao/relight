/**
 * 壁纸视频手动重跑 CLI（动态视频壁纸，state.md ## 契约规约 CLI（rerun）契约）
 *
 * 用途：当日视频生成失败/超时后手动重跑，或对历史日期补生成（不自动回填）。
 *
 * 用法：
 *   npm run wallpaper-video:rerun -- --pickDate=YYYY-MM-DD
 *   pnpm --filter @relight/backend wallpaper-video:rerun -- --pickDate 2026-09-12
 *
 * 契约：
 *   - 参数 --pickDate 必填，isValidYmd 校验（YYYY-MM-DD 格式 + 实际日期合法性）
 *   - 退出码：0 成功/跳过，1 失败（参数错误 / 主流程 throw）
 *   - stdout 逐行进度 + 末行 JSON {pickDate, landscape: <url|"">, portrait: <url|"">}
 */
import { runWallpaperVideo } from "../jobs/wallpaper-video";

/** YYYY-MM-DD 的格式 + 实际日期合法性双重校验（与 routes/daily.ts isValidYmd 同源实现） */
export function isValidYmd(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [, yStr, moStr, dStr] = m;
  const y = Number(yStr);
  const mo = Number(moStr);
  const d = Number(dStr);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** 解析 --pickDate=VALUE 与 --pickDate VALUE 两种形式 */
export function parsePickDateArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--pickDate=")) return a.slice("--pickDate=".length);
    if (a === "--pickDate") return argv[i + 1];
  }
  return undefined;
}

/** 末行 JSON（契约：{pickDate, landscape, portrait}） */
export function formatResultLine(pickDate: string, landscape: string, portrait: string): string {
  return JSON.stringify({ pickDate, landscape, portrait });
}

async function main(): Promise<void> {
  const pickDate = parsePickDateArg(process.argv.slice(2));

  if (!pickDate) {
    console.error(
      "[!] --pickDate 必填（YYYY-MM-DD）。用法: npm run wallpaper-video:rerun -- --pickDate=2026-09-12",
    );
    process.exit(1);
  }
  if (!isValidYmd(pickDate)) {
    console.error(`[!] --pickDate 不是合法日期: ${pickDate}`);
    process.exit(1);
  }

  console.log(`[wallpaper-video:rerun] 开始 pickDate=${pickDate}`);
  const { landscape, portrait } = await runWallpaperVideo(pickDate, console.log);
  // 末行机读 JSON（红队/QA 解析用）
  console.log(formatResultLine(pickDate, landscape, portrait));
  process.exit(0);
}

export default main;

// 仅在直接运行时执行 main()，import 时不触发（防止测试/复用纯函数时误执行）
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("wallpaper-video.ts") ||
    process.argv[1].endsWith("wallpaper-video.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("[wallpaper-video:rerun] 失败:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

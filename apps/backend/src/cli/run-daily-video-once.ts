/**
 * 手动跑**一个**每日视频主题（走生产同一条 `runVideoGeneration` 链路，不写 DB）。
 *
 * 用途：验证 memory-video skill 的改动、复盘某个主题为什么不出片、补跑单个主题。
 * 真正的每日出片由 daily-video job 驱动，这个 CLI 只是把同一套 spawn 契约单独调出来跑。
 *
 * 用法（在 apps/backend 下）：
 *   pnpm tsx src/cli/run-daily-video-once.ts --person=<personId> [--to-year=YYYY] [--title=...]
 *   pnpm tsx src/cli/run-daily-video-once.ts --theme-key=<key> --kind=<person|trip> [--person=...] [--to-year=...]
 *
 * 产物落到 <STORAGE_ROOT>/.video-cache/（与 daily-video 同一位置）。
 * 不写 videos / video_usages 表——要不要把成片登记进库，由人决定。
 */
import path from "node:path";
import { config } from "../lib/config";
import { type VideoTheme, runVideoGeneration } from "../lib/video/claude-runner";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main() {
  const kind = (arg("kind") ?? "person") as "person" | "trip";
  const personId = arg("person");
  const toYear = Number.parseInt(arg("to-year") ?? String(new Date().getFullYear()), 10);
  const themeKey = arg("theme-key") ?? (personId ? `${personId}-${toYear}` : undefined);
  if (!themeKey) {
    console.error("需要 --theme-key=<key>，或 --person=<personId>（自动拼 <personId>-<toYear>）");
    process.exit(2);
  }

  const cache = path.join(config.storageRoot, ".video-cache");
  const outputPath = path.join(cache, `${kind}-${themeKey}.mp4`);
  const metaPath = path.join(cache, `${themeKey}.json`);

  const theme: VideoTheme = {
    themeKind: kind,
    themeKey,
    titleHint: arg("title") ?? (kind === "person" ? "人物 · 成长线" : "旅行"),
    photoIds: personId ? [personId] : [],
    personId,
    toYear,
  };

  console.log(`[run-once] theme=${kind}/${themeKey} titleHint=${theme.titleHint}`);
  console.log(`[run-once] 产物 → ${outputPath}`);
  console.log(`[run-once] cwd  = ${config.videoWorkspacePath}`);
  console.log("[run-once] spawn claude -p（可能 10~45 分钟，取决于素材量与渲染）…");

  const startedAt = Date.now();
  const result = await runVideoGeneration(theme, outputPath, metaPath);
  const mins = ((Date.now() - startedAt) / 60_000).toFixed(1);

  if (result.ok) {
    console.log(`\n[run-once] 成功（${mins} min）`);
    console.log(`  title     : ${result.meta?.title}`);
    console.log(`  duration  : ${result.meta?.durationSec}s`);
    console.log(`  photoIds  : ${result.meta?.photoIds?.length ?? 0} 张`);
    console.log(`  mp4       : ${outputPath}`);
    process.exit(0);
  }

  console.log(`\n[run-once] 失败（${mins} min）`);
  console.log(result.err);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

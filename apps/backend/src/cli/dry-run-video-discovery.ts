/**
 * 演练：打印 video-discovery 的候选主题排名（新鲜度降序），不 spawn 任何东西。
 *
 * 用途：诊断「为什么今天选中了 X 而不是 Y」——daily-video 每天只取 freshness 最高的 1 个候选。
 *
 * 用法（在 apps/backend 下）：
 *   pnpm tsx src/cli/dry-run-video-discovery.ts [--top=20] [--all]
 */
import { discoverVideoCandidates } from "../jobs/video-discovery";

function fmtTs(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "(无)";
  return new Date(ts).toISOString().slice(0, 10);
}

async function main() {
  const args = process.argv.slice(2);
  const topArg = args.find((a) => a.startsWith("--top="));
  const top = topArg ? Number.parseInt(topArg.split("=")[1] ?? "20", 10) : 20;
  const showAll = args.includes("--all");

  const candidates = await discoverVideoCandidates();
  console.log(`候选主题总数: ${candidates.length}\n`);
  console.log("rank  新鲜度(最新素材日)  类型    张数  themeKey");
  console.log("----  ------------------  ------  ----  --------");

  const rows = showAll ? candidates : candidates.slice(0, top);
  rows.forEach((c, i) => {
    const rank = String(i + 1).padStart(3, " ");
    console.log(
      `${rank}   ${fmtTs(c.freshness)}           ${c.themeKind.padEnd(6)}  ${String(c.photoIds.length).padStart(4)}  ${c.themeKey}`,
    );
  });

  if (!showAll && candidates.length > top) {
    console.log(`\n... 另有 ${candidates.length - top} 个候选（--all 全看）`);
  }

  const pick = candidates[0];
  if (pick) {
    console.log(
      `\n今天的 daily-video 会 spawn: ${pick.themeKind}/${pick.themeKey} (${pick.titleHint})`,
    );
  } else {
    console.log("\n无候选 → 今天不出片（静默跳过）");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

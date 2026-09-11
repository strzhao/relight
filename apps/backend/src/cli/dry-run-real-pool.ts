/**
 * Dry run（真实代码路径）：直接调用线上 buildCandidatePool + getRecentPickedEventKeys，
 * 对「近期拍摄第 5 源」开关做 A/B 对比。只读不写库、不调 AI。
 *
 * 与复刻版 dry-run-candidate-pool.ts 的区别：本脚本跑的是生产实现本身，
 * 验证真实 SQL / quota / 聚类 / fillUp 链路下开关的效果。
 *
 * 注意：getRecentPickedEventKeys(30, pickNow) 的窗口是对称的 [D-30, D+30]，
 * 对历史日期模拟时会额外排除"当时尚不存在"的未来真实精选。该偏差对开关
 * 两个方向等价施加，不影响 A/B 结论。
 *
 * 用法：pnpm tsx src/cli/dry-run-real-pool.ts [startDate] [endDate] [rounds] [includeRecent 0|1] [showDetail 0|1]
 */
import "dotenv/config";
import {
  buildCandidatePool,
  getRecentPickedEventKeys,
} from "../jobs/daily-selection/candidate-pool";
import { type ClusteredCandidate, parseTakenAtMs } from "../jobs/daily-selection/cluster";

const DAY_MS = 86_400_000;

function pickNowFor(dateStr: string): Date {
  return new Date(`${dateStr}T02:00:00+08:00`);
}

interface Stat {
  poolSize: number;
  y2026: number;
  y2025: number;
  y2024: number;
  older: number;
  last30d: number;
  top4_2026: number;
  top4_last30d: number;
  recentSource: number;
}

function statPool(pool: ClusteredCandidate[], pickDate: string): Stat {
  const nowMs = pickNowFor(pickDate).getTime();
  const year = (c: ClusteredCandidate) => (c.takenAt ?? "").slice(0, 4);
  const isRecent = (c: ClusteredCandidate) => {
    const ms = parseTakenAtMs(c.takenAt);
    return ms !== null && nowMs - ms <= 30 * DAY_MS;
  };
  const top4 = [...pool].sort((a, b) => b.weightedScore - a.weightedScore).slice(0, 4);
  return {
    poolSize: pool.length,
    y2026: pool.filter((c) => year(c) === "2026").length,
    y2025: pool.filter((c) => year(c) === "2025").length,
    y2024: pool.filter((c) => year(c) === "2024").length,
    older: pool.filter((c) => year(c) !== "" && year(c) <= "2023").length,
    last30d: pool.filter(isRecent).length,
    top4_2026: top4.filter((c) => year(c) === "2026").length,
    top4_last30d: top4.filter(isRecent).length,
    recentSource: pool.filter((c) => c.source === "recent").length,
  };
}

function avg(list: number[]): number {
  if (list.length === 0) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

async function main() {
  const [
    startDate = "2026-09-05",
    endDate = "2026-09-12",
    roundsArg = "5",
    includeArg = "1",
    detailArg = "1",
  ] = process.argv.slice(2);
  const rounds = Number.parseInt(roundsArg, 10);
  const includeRecent = includeArg === "1";
  const showDetail = detailArg === "1";

  const dates: string[] = [];
  for (let t = pickNowFor(startDate).getTime(); t <= pickNowFor(endDate).getTime(); t += DAY_MS) {
    dates.push(new Date(t + 8 * 3600_000).toISOString().slice(0, 10));
  }

  console.log(
    `# includeRecentSource=${includeRecent} | 日期 ${startDate}..${endDate}（${dates.length} 天）× ${rounds} 轮`,
  );

  const stats: Stat[] = [];
  const detail: { pickDate: string; pool: ClusteredCandidate[] }[] = [];

  for (let round = 0; round < rounds; round++) {
    for (const pickDate of dates) {
      // 排除集每日期只算一次（确定性的表读），轮间复用
      const { eventKeys, excludeIds } = (cacheExclusions.get(pickDate) ??
        (await getRecentPickedEventKeys(30, pickNowFor(pickDate)))) as {
        eventKeys: Set<string>;
        excludeIds: Set<string>;
      };
      cacheExclusions.set(pickDate, { eventKeys, excludeIds });

      const pool = await buildCandidatePool({
        now: pickNowFor(pickDate),
        excludeIds,
        eventKeys,
        maxN: 12,
        includeRecentSource: includeRecent,
      });
      stats.push(statPool(pool, pickDate));
      if (round === 0) detail.push({ pickDate, pool });
    }
    process.stderr.write(`round ${round + 1}/${rounds} done\n`);
  }

  const col = (f: (s: Stat) => number) => avg(stats.map(f)).toFixed(2);
  console.log(
    [
      "池大小",
      "2026年",
      "2025年",
      "2024年",
      "≤2023",
      "近30天",
      "Top4中2026",
      "Top4近30天",
      "recent源标记",
    ].join(" | "),
  );
  console.log(
    [
      col((s) => s.poolSize),
      col((s) => s.y2026),
      col((s) => s.y2025),
      col((s) => s.y2024),
      col((s) => s.older),
      col((s) => s.last30d),
      col((s) => s.top4_2026),
      col((s) => s.top4_last30d),
      col((s) => s.recentSource),
    ].join(" | "),
  );

  if (showDetail) {
    for (const { pickDate, pool } of detail) {
      console.log(`\n-- ${pickDate}（首轮，${pool.length} 席）`);
      for (const c of [...pool].sort((a, b) => b.weightedScore - a.weightedScore)) {
        const ms = parseTakenAtMs(c.takenAt);
        const recent =
          ms !== null && pickNowFor(pickDate).getTime() - ms <= 30 * DAY_MS ? "★近30天" : "";
        console.log(
          `  ${c.photoId.slice(-6)} | ${(c.takenAt ?? "????-??-??").slice(0, 10)} | aes=${c.aestheticScore?.toFixed(1) ?? "-"} | w=${c.weightedScore.toFixed(2)} | ${c.source} ${recent}`,
        );
      }
    }
  }
}

const cacheExclusions = new Map<string, Awaited<ReturnType<typeof getRecentPickedEventKeys>>>();

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

/**
 * Dry run：每日精选候选池变体模拟（只读，不写库、不调 AI）。
 *
 * 用途：2026-09 平权改版后新照片几乎出局（8 天 32 席仅 1 张近 30 天照片），
 * 本脚本在真实生产库上复刻 buildCandidatePool 全流程（4 源 + per-source quota
 * + 聚类 + fillUp + 冲突检查），对若干候选方案做前瞻对比。
 *
 * 与线上实现的差异：
 * - 复刻 getBeijingDateInfo / 4 源 SQL / fillUp（这些是 buildCandidatePool 私有实现），
 *   dedupAndQuotaMerge / clusterByDirnameAndTime / computeEventKey / parseTakenAtMs
 *   直接 import 线上导出，保证聚类与配额语义一致。
 * - 跳过 peopleNicknames 注入（不影响年代分布统计）。
 * - randomSample / fillUp 的 ABS(RANDOM()%3) 抖动使单次结果有随机性，
 *   默认跑 5 轮取均值。
 *
 * 用法：pnpm --filter @relight/backend tsx src/cli/dry-run-candidate-pool.ts [startDate] [endDate] [rounds]
 *   默认 startDate=2026-09-05 endDate=2026-09-12 rounds=5
 */
import "dotenv/config";
import path from "node:path";
import { and, desc, gte, lte, ne, sql } from "drizzle-orm";
import { db, schema } from "../db";
import {
  type CandidateSource,
  type EnrichedCandidate,
  type PrimaryCandidateSource,
  computeEventKey,
  dedupAndQuotaMerge,
} from "../jobs/daily-selection/candidate-pool";
import { clusterByDirnameAndTime, parseTakenAtMs } from "../jobs/daily-selection/cluster";
import { config } from "../lib/config";
import { haversineMeters } from "../lib/geo";

// ---------------------------------------------------------------------------
// 变体定义
// ---------------------------------------------------------------------------

interface Variant {
  name: string;
  description: string;
  /** 源4（randomSample）拍摄时间下限（距模拟日的天数），undefined = 不限 */
  randomSampleFloorDays?: number;
  /** weightedScore 加成（输入 = 拍摄时间距模拟日的 ms，null 表示未知） */
  bonus?: (ageMs: number | null) => number;
  /** 新增"近期拍摄"第 5 源：近 N 天拍摄，保底 seats 席 */
  recentDays?: number;
  recentSeats?: number;
}

const DAY_MS = 86_400_000;

const VARIANTS: Variant[] = [
  { name: "baseline", description: "现状平权（9/4 改版后）" },
  { name: "random-2y", description: "源4恢复2年线（9/4 前行为）", randomSampleFloorDays: 730 },
  { name: "random-1y", description: "源4收紧到1年线", randomSampleFloorDays: 365 },
  {
    name: "bonus-30d",
    description: "源不变；≤30天照片 +0.3",
    bonus: (age) => (age !== null && age <= 30 * DAY_MS ? 0.3 : 0),
  },
  {
    name: "bonus-graded",
    description: "源不变；≤30天 +0.3，≤1年 +0.15",
    bonus: (age) => {
      if (age === null) return 0;
      if (age <= 30 * DAY_MS) return 0.3;
      if (age <= 365 * DAY_MS) return 0.15;
      return 0;
    },
  },
  {
    name: "recent-30d-q1",
    description: "新增第5源:近30天拍摄,保底1席",
    recentDays: 30,
    recentSeats: 1,
  },
  {
    name: "recent-30d-q2",
    description: "新增第5源:近30天拍摄,保底2席",
    recentDays: 30,
    recentSeats: 2,
  },
  {
    name: "recent-30d-q3",
    description: "新增第5源:近30天拍摄,保底3席",
    recentDays: 30,
    recentSeats: 3,
  },
  {
    name: "recent-45d-q2",
    description: "新增第5源:近45天拍摄,保底2席",
    recentDays: 45,
    recentSeats: 2,
  },
];

// ---------------------------------------------------------------------------
// 复刻的日期工具
// ---------------------------------------------------------------------------

function getBeijingDateInfo(now: Date) {
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const year = shanghai.getFullYear();
  const month = String(shanghai.getMonth() + 1).padStart(2, "0");
  const day = String(shanghai.getDate()).padStart(2, "0");
  const monthNum = shanghai.getMonth() + 1;
  let seasonMonths: string[];
  if (monthNum >= 3 && monthNum <= 5) seasonMonths = ["03", "04", "05"];
  else if (monthNum >= 6 && monthNum <= 8) seasonMonths = ["06", "07", "08"];
  else if (monthNum >= 9 && monthNum <= 11) seasonMonths = ["09", "10", "11"];
  else seasonMonths = ["12", "01", "02"];
  return { year, month, day, monthDay: `${month}-${day}`, seasonMonths };
}

/** 模拟日 D 的 pickNow：当天北京时间 02:00（对齐凌晨调度） */
function pickNowFor(dateStr: string): Date {
  return new Date(`${dateStr}T02:00:00+08:00`);
}

// ---------------------------------------------------------------------------
// 排除集：pick_date < D 的真实历史（30 天窗口），复刻 getRecentPickedEventKeys
// 但只向前看——真实当日凌晨跑批时未来记录尚不存在
// ---------------------------------------------------------------------------

async function getPastExclusions(pickDate: string) {
  const nowMs = pickNowFor(pickDate).getTime();
  const cutoffBefore = new Date(nowMs - 30 * DAY_MS + 8 * 3600_000).toISOString().slice(0, 10);

  const excludeIds = new Set<string>();
  const pickRows = await db
    .select({ photoId: schema.dailyPicks.photoId, members: schema.dailyPicks.members })
    .from(schema.dailyPicks)
    .where(
      and(
        gte(schema.dailyPicks.pickDate, cutoffBefore),
        lte(schema.dailyPicks.pickDate, pickDate),
        ne(schema.dailyPicks.pickDate, pickDate),
      ),
    );
  for (const r of pickRows) {
    excludeIds.add(r.photoId);
    for (const m of (r.members as { photoId: string }[] | null) ?? []) excludeIds.add(m.photoId);
  }
  const entryRows = await db
    .select({ photoId: schema.dailyPickEntries.photoId, members: schema.dailyPickEntries.members })
    .from(schema.dailyPickEntries)
    .innerJoin(
      schema.dailyPicks,
      sql`${schema.dailyPicks.id} = ${schema.dailyPickEntries.dailyPickId}`,
    )
    .where(
      and(
        gte(schema.dailyPicks.pickDate, cutoffBefore),
        lte(schema.dailyPicks.pickDate, pickDate),
        ne(schema.dailyPicks.pickDate, pickDate),
      ),
    );
  for (const r of entryRows) {
    excludeIds.add(r.photoId);
    for (const m of (r.members as { photoId: string }[] | null) ?? []) excludeIds.add(m.photoId);
  }

  const eventKeys = new Set<string>();
  if (excludeIds.size > 0) {
    const photoRows = await db
      .select({
        photoId: schema.photos.id,
        filePath: schema.photos.filePath,
        takenAt: schema.photos.takenAt,
      })
      .from(schema.photos)
      .where(
        sql`${schema.photos.id} IN (${sql.join(
          [...excludeIds].map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    for (const r of photoRows) {
      const key = computeEventKey(r.filePath, r.takenAt);
      if (key) eventKeys.add(key);
    }
  }
  return { excludeIds, eventKeys };
}

// ---------------------------------------------------------------------------
// 候选池复刻（带变体钩子）
// ---------------------------------------------------------------------------

interface PoolRow {
  photoId: string;
  filePath: string;
  takenAt: string | null;
  mediaType: "image" | "video";
  aestheticScore: number | null;
  latitude: number | null;
  longitude: number | null;
}

const baseColumns = {
  photoId: schema.photos.id,
  filePath: schema.photos.filePath,
  takenAt: schema.photos.takenAt,
  mediaType: schema.photos.mediaType,
  aestheticScore: schema.photoAnalyses.aestheticScore,
  latitude: schema.photos.latitude,
  longitude: schema.photos.longitude,
};

const burstRepOnly = sql`(${schema.photos.burstId} IS NULL OR ${schema.photos.isBurstRepresentative} = 1)`;

async function fetchSource(
  where: ReturnType<typeof and>,
  limit: number,
  jitter: boolean,
): Promise<PoolRow[]> {
  return db
    .select(baseColumns)
    .from(schema.photos)
    .innerJoin(schema.photoAnalyses, sql`${schema.photoAnalyses.photoId} = ${schema.photos.id}`)
    .innerJoin(
      schema.storageSources,
      sql`${schema.storageSources.id} = ${schema.photos.storageSourceId}`,
    )
    .where(where)
    .orderBy(
      jitter
        ? desc(
            sql`(COALESCE(${schema.photoAnalyses.aestheticScore}, 5.0) + ABS(RANDOM() % 3)) / 1.0`,
          )
        : desc(schema.photoAnalyses.aestheticScore),
    )
    .limit(limit);
}

async function buildPool(variant: Variant, pickDate: string, maxN = 12) {
  const pickNow = pickNowFor(pickDate);
  const pickNowMs = pickNow.getTime();
  const { excludeIds, eventKeys } = await getPastExclusions(pickDate);
  const { month, day, monthDay, seasonMonths } = getBeijingDateInfo(pickNow);
  const K_PER_SOURCE = Math.ceil(maxN * 1.5);
  const floorMs =
    variant.randomSampleFloorDays !== undefined
      ? pickNowMs - variant.randomSampleFloorDays * DAY_MS
      : null;

  const scoreFloor = sql`${schema.photoAnalyses.aestheticScore} >= ${config.minAestheticScorePrimary}`;

  const [historyTodayRows, sameMonthRows, sameSeasonRows, randomSampleRows] = await Promise.all([
    // 源1: 历史上的今天（月日匹配，不限年份）
    fetchSource(
      and(
        sql`strftime('%m-%d', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) = ${monthDay}`,
        scoreFloor,
        burstRepOnly,
      ),
      K_PER_SOURCE,
      false,
    ),
    // 源2: 同月份不同日
    fetchSource(
      and(
        sql`strftime('%m', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) = ${month}`,
        sql`strftime('%d', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) != ${day}`,
        scoreFloor,
        burstRepOnly,
      ),
      K_PER_SOURCE,
      false,
    ),
    // 源3: 同季节不同月
    fetchSource(
      and(
        sql`strftime('%m', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) IN (${sql.raw(
          seasonMonths
            .filter((m) => m !== month)
            .map((m) => `'${m}'`)
            .join(", "),
        )})`,
        scoreFloor,
        burstRepOnly,
      ),
      K_PER_SOURCE,
      false,
    ),
    // 源4: 随机抽样（变体可加时间下限）
    fetchSource(
      floorMs !== null
        ? and(
            sql`substr(COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt}), 1, 10) >= ${new Date(floorMs).toISOString().slice(0, 10)}`,
            scoreFloor,
            burstRepOnly,
          )
        : and(scoreFloor, burstRepOnly),
      K_PER_SOURCE,
      true,
    ),
  ]);

  const toEnriched = (rows: PoolRow[], source: CandidateSource): EnrichedCandidate[] =>
    rows
      .filter((r) => !excludeIds.has(r.photoId))
      .map((r) => {
        const ageMs = r.takenAt ? pickNowMs - (parseTakenAtMs(r.takenAt) ?? pickNowMs) : null;
        const aes = r.aestheticScore ?? 5.0;
        return {
          photoId: r.photoId,
          filePath: r.filePath,
          takenAt: r.takenAt,
          mediaType: r.mediaType,
          durationSec: null,
          aestheticScore: r.aestheticScore,
          yearsAgo: 0,
          weightedScore: aes + (variant.bonus?.(ageMs) ?? 0),
          source,
          narrative: null,
          emotionalAnalysis: null,
          tags: null,
          thumbnailPath: null,
          sourceType: "local" as const,
          latitude: r.latitude ?? null,
          longitude: r.longitude ?? null,
          offsetTime: null,
          peopleNicknames: [],
        };
      });

  const filterByEventKey = (cands: EnrichedCandidate[]): EnrichedCandidate[] => {
    if (eventKeys.size === 0) return cands;
    return cands.filter((c) => {
      const key = computeEventKey(c.filePath, c.takenAt);
      return !key || !eventKeys.has(key);
    });
  };

  const bySource = {
    historyToday: filterByEventKey(toEnriched(historyTodayRows, "historyToday")),
    sameMonth: filterByEventKey(toEnriched(sameMonthRows, "sameMonth")),
    sameSeason: filterByEventKey(toEnriched(sameSeasonRows, "sameSeason")),
    randomSample: filterByEventKey(toEnriched(randomSampleRows, "randomSample")),
  };

  // 变体：第 5 源"近期拍摄"（近 N 天，达同样门槛，源内按 aes 竞争）
  let recent: EnrichedCandidate[] = [];
  if (variant.recentDays) {
    const cutoff = new Date(pickNowMs - variant.recentDays * DAY_MS).toISOString().slice(0, 10);
    const recentRows = await fetchSource(
      and(
        sql`substr(COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt}), 1, 10) >= ${cutoff}`,
        scoreFloor,
        burstRepOnly,
      ),
      K_PER_SOURCE,
      false,
    );
    recent = filterByEventKey(toEnriched(recentRows, "recent" as CandidateSource));
  }

  /** 5 源 quota 合并：每源保底 seats + 剩余槽按 weightedScore 抢占（照 dedupAndQuotaMerge 语义扩展） */
  function quotaMerge(
    entries: { items: EnrichedCandidate[]; seats: number }[],
    cap: number,
  ): EnrichedCandidate[] {
    for (const e of entries) e.items.sort((a, b) => b.weightedScore - a.weightedScore);
    const quotaItems: EnrichedCandidate[] = [];
    const quotaIds = new Set<string>();
    for (const e of entries) {
      for (const item of e.items.slice(0, e.seats)) {
        if (!quotaIds.has(item.photoId)) {
          quotaIds.add(item.photoId);
          quotaItems.push(item);
        }
      }
    }
    const contestSlots = Math.max(0, cap - quotaItems.length);
    const contestPool = entries
      .flatMap((e) => e.items.slice(e.seats))
      .filter((i) => !quotaIds.has(i.photoId));
    contestPool.sort((a, b) => b.weightedScore - a.weightedScore);
    const winners: EnrichedCandidate[] = [];
    const wIds = new Set<string>(quotaIds);
    for (const item of contestPool) {
      if (winners.length >= contestSlots) break;
      if (!wIds.has(item.photoId)) {
        wIds.add(item.photoId);
        winners.push(item);
      }
    }
    const mergedAll: EnrichedCandidate[] = [];
    const seen = new Set<string>();
    for (const item of [...quotaItems, ...winners]) {
      if (!seen.has(item.photoId)) {
        seen.add(item.photoId);
        mergedAll.push(item);
      }
    }
    mergedAll.sort((a, b) => b.weightedScore - a.weightedScore);
    return mergedAll.slice(0, cap);
  }

  const merged = variant.recentDays
    ? quotaMerge(
        [
          { items: bySource.historyToday, seats: 3 },
          { items: bySource.sameMonth, seats: 3 },
          { items: bySource.sameSeason, seats: 3 },
          { items: bySource.randomSample, seats: 3 },
          { items: recent, seats: variant.recentSeats ?? 2 },
        ],
        maxN * 4,
      )
    : dedupAndQuotaMerge(bySource, maxN * 4);

  if (process.env.DRYRUN_DEBUG) {
    const is2026 = (c: { takenAt: string | null }) => (c.takenAt ?? "").startsWith("2026");
    const recentC = (c: { takenAt: string | null }) => {
      const ms = parseTakenAtMs(c.takenAt);
      return ms !== null && pickNowMs - ms <= 30 * DAY_MS;
    };
    console.log(`\n[debug ${pickDate} variant=${variant.name}]`);
    console.log(`  excludeIds=${excludeIds.size} eventKeys=${eventKeys.size}`);
    for (const [src, rows] of [
      ["historyToday", historyTodayRows],
      ["sameMonth", sameMonthRows],
      ["sameSeason", sameSeasonRows],
      ["randomSample", randomSampleRows],
    ] as const) {
      const r = rows as PoolRow[];
      const y26 = r.filter((x) => is2026(x)).length;
      const rec = r.filter((x) => recentC(x)).length;
      console.log(`  源 ${src}: raw=${r.length} (2026=${y26}, 近30天=${rec})`);
    }
    for (const [src, cands] of [
      ...Object.entries(bySource),
      ...(variant.recentDays ? [["recent", recent] as const] : []),
    ] as [string, EnrichedCandidate[]][]) {
      console.log(
        `  源 ${src}: 去重/事件键后=${cands.length} (2026=${cands.filter(is2026).length}, 近30天=${cands.filter(recentC).length})`,
      );
    }
  }

  const clustered = clusterByDirnameAndTime(merged);
  const pool1 = clustered.slice(0, maxN);

  if (process.env.DRYRUN_DEBUG) {
    const is2026 = (c: { takenAt: string | null }) => (c.takenAt ?? "").startsWith("2026");
    const recentC = (c: { takenAt: string | null }) => {
      const ms = parseTakenAtMs(c.takenAt);
      return ms !== null && pickNowMs - ms <= 30 * DAY_MS;
    };
    console.log(
      `  quota合并后=${merged.length}, 聚类后簇=${clustered.length}, pool1=${pool1.length} (2026=${pool1.filter(is2026).length}, 近30天=${pool1.filter(recentC).length})`,
    );
  }

  if (pool1.length >= maxN) return pool1;

  // ---- fillUp 复刻 ----
  const needCount = maxN - pool1.length;
  const FILLUP_OVERFETCH_RATIO = 3;
  const excludeAfterPrimary = new Set<string>(excludeIds);
  for (const c of pool1) {
    excludeAfterPrimary.add(c.photoId);
    for (const sibId of c.clusterSiblingIds) excludeAfterPrimary.add(sibId);
  }
  const excludeList = [...excludeAfterPrimary];
  const fillUpLimit = needCount * FILLUP_OVERFETCH_RATIO;
  const fillUpFloor = sql`${schema.photoAnalyses.aestheticScore} >= 7.5`;
  const fillUpWhere = excludeList.length
    ? and(
        fillUpFloor,
        burstRepOnly,
        sql`${schema.photos.id} NOT IN (${sql.join(
          excludeList.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
    : and(fillUpFloor, burstRepOnly);
  const fillUpRawRows = await fetchSource(fillUpWhere, fillUpLimit, true);
  const fillUpClusters = clusterByDirnameAndTime(
    filterByEventKey(toEnriched(fillUpRawRows, "fillUp")),
  );

  const CONFLICT_DIRNAME_MS = 60 * 60 * 1000;
  const CONFLICT_GPS_M = 500;
  const CONFLICT_GPS_MS = 24 * 3600 * 1000;
  const nonConflictFillUp: typeof pool1 = [];
  for (const fp of fillUpClusters) {
    const fpDir = path.posix.dirname(fp.filePath);
    const fpMs = parseTakenAtMs(fp.takenAt);
    let hasConflict = false;
    for (const p1 of pool1) {
      if (fpDir === path.posix.dirname(p1.filePath)) {
        const p1Ms = parseTakenAtMs(p1.takenAt);
        if (fpMs !== null && p1Ms !== null && Math.abs(fpMs - p1Ms) <= CONFLICT_DIRNAME_MS) {
          hasConflict = true;
          break;
        }
      }
      if (
        fp.latitude !== null &&
        fp.longitude !== null &&
        p1.latitude !== null &&
        p1.longitude !== null
      ) {
        const p1Ms = parseTakenAtMs(p1.takenAt);
        if (fpMs !== null && p1Ms !== null && Math.abs(fpMs - p1Ms) <= CONFLICT_GPS_MS) {
          if (
            haversineMeters(fp.latitude, fp.longitude, p1.latitude, p1.longitude) <= CONFLICT_GPS_M
          ) {
            hasConflict = true;
            break;
          }
        }
      }
    }
    if (!hasConflict) nonConflictFillUp.push(fp);
  }

  const combined = [...pool1, ...nonConflictFillUp];
  combined.sort((a, b) => b.weightedScore - a.weightedScore);
  return combined.slice(0, maxN);
}

// ---------------------------------------------------------------------------
// 统计与输出
// ---------------------------------------------------------------------------

interface RoundStat {
  poolSize: number;
  y2026: number;
  y2025: number;
  y2024: number;
  older: number;
  last30d: number;
  top4_2026: number;
  top4_last30d: number;
}

function statPool(pool: EnrichedCandidate[], pickDate: string): RoundStat {
  const nowMs = pickNowFor(pickDate).getTime();
  const byYear = (c: EnrichedCandidate) => (c.takenAt ?? "").slice(0, 4);
  const isRecent = (c: EnrichedCandidate) => {
    const ms = parseTakenAtMs(c.takenAt);
    return ms !== null && nowMs - ms <= 30 * DAY_MS;
  };
  const top4 = [...pool].sort((a, b) => b.weightedScore - a.weightedScore).slice(0, 4);
  return {
    poolSize: pool.length,
    y2026: pool.filter((c) => byYear(c) === "2026").length,
    y2025: pool.filter((c) => byYear(c) === "2025").length,
    y2024: pool.filter((c) => byYear(c) === "2024").length,
    older: pool.filter((c) => byYear(c) !== "" && byYear(c) <= "2023").length,
    last30d: pool.filter(isRecent).length,
    top4_2026: top4.filter((c) => byYear(c) === "2026").length,
    top4_last30d: top4.filter(isRecent).length,
  };
}

function avg(list: number[]): number {
  if (list.length === 0) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

async function main() {
  const [startDate = "2026-09-05", endDate = "2026-09-12", roundsArg = "5"] = process.argv.slice(2);
  const rounds = Number.parseInt(roundsArg, 10);

  // 枚举日期
  const dates: string[] = [];
  for (let t = pickNowFor(startDate).getTime(); t <= pickNowFor(endDate).getTime(); t += DAY_MS) {
    dates.push(new Date(t + 8 * 3600_000).toISOString().slice(0, 10));
  }

  console.log(
    `Dry run 日期 ${startDate}..${endDate}（${dates.length} 天）× ${rounds} 轮 × ${VARIANTS.length} 变体`,
  );
  console.log(`门槛 minAestheticScorePrimary = ${config.minAestheticScorePrimary}\n`);

  const acc = new Map<string, RoundStat[]>();
  for (const v of VARIANTS) acc.set(v.name, []);

  const sampleDay = dates[dates.length - 1] ?? startDate;
  const samplePools = new Map<string, EnrichedCandidate[]>();

  for (let round = 0; round < rounds; round++) {
    for (const pickDate of dates) {
      for (const v of VARIANTS) {
        const pool = await buildPool(v, pickDate);
        acc.get(v.name)?.push(statPool(pool, pickDate));
        if (round === 0 && pickDate === sampleDay) samplePools.set(v.name, pool);
      }
    }
    process.stderr.write(`round ${round + 1}/${rounds} done\n`);
  }

  // ---- 聚合表 ----
  console.log(`## 各变体日均指标（${dates.length} 天 × ${rounds} 轮均值，池上限 12 席）`);
  console.log(
    [
      "变体",
      "说明",
      "池大小",
      "2026年",
      "2025年",
      "2024年",
      "≤2023",
      "近30天",
      "Top4中2026",
      "Top4近30天",
    ].join(" | "),
  );
  for (const v of VARIANTS) {
    const stats = acc.get(v.name) ?? [];
    const col = (f: (s: RoundStat) => number) => avg(stats.map(f)).toFixed(2);
    console.log(
      [
        v.name,
        v.description,
        col((s) => s.poolSize),
        col((s) => s.y2026),
        col((s) => s.y2025),
        col((s) => s.y2024),
        col((s) => s.older),
        col((s) => s.last30d),
        col((s) => s.top4_2026),
        col((s) => s.top4_last30d),
      ].join(" | "),
    );
  }

  // ---- 最近一天样本明细 ----
  console.log(
    `\n## 样本日 ${sampleDay}（首轮）各变体 12 席明细（photoId 尾 6 位 | 年份 | aes | 加权 | 源）`,
  );
  for (const v of VARIANTS) {
    const pool = samplePools.get(v.name) ?? [];
    console.log(`\n-- ${v.name}（${v.description}）`);
    for (const c of [...pool].sort((a, b) => b.weightedScore - a.weightedScore)) {
      const ms = parseTakenAtMs(c.takenAt);
      const recent =
        ms !== null && pickNowFor(sampleDay).getTime() - ms <= 30 * DAY_MS ? "★近30天" : "";
      console.log(
        `  ${c.photoId.slice(-6)} | ${(c.takenAt ?? "????-??-??").slice(0, 10)} | aes=${c.aestheticScore?.toFixed(1) ?? "-"} | w=${c.weightedScore.toFixed(2)} | ${c.source} ${recent ?? ""}`,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

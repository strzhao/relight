/**
 * 候选池构造：4 源平等加权混采 + 久远度加权 + 30 天去重
 *
 * 架构：
 * - 4 个独立子查询（historyToday / sameMonth / sameSeason / agedRandom），每源取 K=maxN 张
 * - per-source quota：每源保底 3 张 + 剩余 8 槽按 weightedScore 抢占
 * - 合并去重后截前 20 张
 *
 * 注：K_PER_SOURCE 设为 maxN（而非固定 8），确保当候选只集中在 1-2 个源时
 * 仍能获取足够多的唯一候选，避免跨源重叠导致最终候选池不足 maxN 张。
 */

import path from "node:path";
import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "../../db";
import { haversineMeters } from "../../lib/geo";
import { getSettingValue } from "../../lib/settings";
import { type ClusteredCandidate, clusterByDirnameAndTime, parseTakenAtMs } from "./cluster";

/** 全局最大候选数（质量优化：从 20 降到 12，避免低分照片摊薄整体质感 + 减 40% AI narrate 调用）*/
const MAX_N = 12;
/** 每源保底席位 */
const QUOTA_PER_SOURCE = 3;
/** 事件键过滤的 overfetch 倍率：各源 SQL LIMIT 放大 1.5 倍，补偿事件键冲突丢弃的候选 */
const EVENT_KEY_OVERFETCH_RATIO = 1.5;

/** 4 个主路径候选源标识（不含 fillUp） */
export type PrimaryCandidateSource = "historyToday" | "sameMonth" | "sameSeason" | "agedRandom";

/** 全部候选源标识（含第 5 源 fillUp） */
export type CandidateSource = PrimaryCandidateSource | "fillUp";

/** 候选照片（带加权分和元数据） */
export interface EnrichedCandidate {
  photoId: string;
  filePath: string;
  takenAt: string | null;
  mediaType: "image" | "video";
  durationSec: number | null;
  aestheticScore: number | null;
  yearsAgo: number;
  weightedScore: number;
  source: CandidateSource;
  /** AI 分析摘要（用于构建 select prompt） */
  narrative: string | null;
  emotionalAnalysis: unknown | null;
  tags: unknown | null;
  thumbnailPath: string | null;
  /** 存储源类型（用于阶段 2 读文件） */
  sourceType: "local" | "smb" | "webdav";
  /** GPS 纬度（用于 cluster GPS 谓词） */
  latitude: number | null;
  /** GPS 经度（用于 cluster GPS 谓词） */
  longitude: number | null;
  /** 时区偏移，如 "+08:00"（用于 narrate 注入） */
  offsetTime: string | null;
  /**
   * 画面中命名人物的称呼数组（按 bbox 面积 DESC，去重 by person.id）。
   * 视频候选恒为 []。规则：nickname 非空、hidden=0、不等于 selfPersonId。
   */
  peopleNicknames: string[];
}

/**
 * 久远度加权函数：开根号曲线，封顶 1.6
 * - 0 年: 1.0x
 * - 1 年: 1.10x
 * - 5 年: ~1.22x
 * - 10 年: ~1.32x
 * - 20 年: ~1.45x
 * - >36 年: 1.60x (cap)
 */
export function ageWeightMultiplier(yearsAgo: number): number {
  if (yearsAgo < 1) return 1.0;
  return 1.0 + Math.min(0.6, Math.sqrt(yearsAgo) * 0.1);
}

/**
 * 计算事件键：`dirname::takenAt_date`。
 *
 * 一对 (dirname, date(takenAt)) 定义为"事件键"。30 天内每个事件键最多入选 1 次，
 * 避免同一拍摄事件的照片反复出现在精选池中。
 *
 * @param filePath - 照片文件路径（POSIX 风格）
 * @param takenAt - ISO 时间字符串或 null
 * @returns 事件键字符串，或 null（takenAt 为 null 时）
 */
export function computeEventKey(filePath: string, takenAt: string | null): string | null {
  if (!takenAt) return null;
  const dirname = path.posix.dirname(filePath);
  const date = takenAt.slice(0, 10); // "YYYY-MM-DD"
  return `${dirname}::${date}`;
}

/**
 * 获取最近 daysBack 天精选照片的事件键集合 + photoId 去重集合。
 *
 * 同时扫描两个表：
 * 1. daily_picks（旧格式：hero photoId + members JSON 列）
 * 2. daily_pick_entries（新格式：每行一个 entry 的 photo_id + members JSON 列）
 *
 * 每条结果 JOIN photos 表获取 file_path、taken_at，然后计算事件键。
 * taken_at 为 NULL 的行不生成事件键。
 *
 * @returns { eventKeys: Set<string>, excludeIds: Set<string> }
 */
export async function getRecentPickedEventKeys(
  daysBack = 30,
  now: Date = new Date(),
): Promise<{ eventKeys: Set<string>; excludeIds: Set<string> }> {
  const cutoff = new Date(now.getTime() - daysBack * 86400_000).toISOString().slice(0, 10);
  const nowDate = now.toISOString().slice(0, 10);

  // 扫描 daily_picks（旧格式）— 仅 cutoff <= pick_date < nowDate（不含未来）
  const pickRows = await db
    .select({
      photoId: schema.dailyPicks.photoId,
      members: schema.dailyPicks.members,
    })
    .from(schema.dailyPicks)
    .where(and(gte(schema.dailyPicks.pickDate, cutoff), lt(schema.dailyPicks.pickDate, nowDate)));

  const excludeIds = new Set<string>();
  for (const r of pickRows) {
    excludeIds.add(r.photoId);
    const memberList = (r.members as { photoId: string }[] | null) ?? [];
    for (const m of memberList) {
      excludeIds.add(m.photoId);
    }
  }

  // 扫描 daily_pick_entries（新格式），通过 JOIN daily_picks 过滤日期
  const entryRows = await db
    .select({
      photoId: schema.dailyPickEntries.photoId,
      members: schema.dailyPickEntries.members,
    })
    .from(schema.dailyPickEntries)
    .innerJoin(
      schema.dailyPicks,
      sql`${schema.dailyPicks.id} = ${schema.dailyPickEntries.dailyPickId}`,
    )
    .where(and(gte(schema.dailyPicks.pickDate, cutoff), lt(schema.dailyPicks.pickDate, nowDate)));

  for (const r of entryRows) {
    excludeIds.add(r.photoId);
    const memberList = (r.members as { photoId: string }[] | null) ?? [];
    for (const m of memberList) {
      excludeIds.add(m.photoId);
    }
  }

  // JOIN photos 表获取 file_path + taken_at，计算事件键
  const eventKeys = new Set<string>();
  if (excludeIds.size > 0) {
    const excludeList = [...excludeIds];
    const photoRows = await db
      .select({
        photoId: schema.photos.id,
        filePath: schema.photos.filePath,
        takenAt: schema.photos.takenAt,
      })
      .from(schema.photos)
      .where(
        sql`${schema.photos.id} IN (${sql.join(
          excludeList.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    for (const r of photoRows) {
      const key = computeEventKey(r.filePath, r.takenAt);
      if (key) eventKeys.add(key);
    }
  }

  return { eventKeys, excludeIds };
}

/**
 * @deprecated 使用 getRecentPickedEventKeys().excludeIds 替代
 */
export async function getRecentPickedPhotoIds(
  daysBack = 30,
  now: Date = new Date(),
): Promise<Set<string>> {
  const { excludeIds } = await getRecentPickedEventKeys(daysBack, now);
  return excludeIds;
}

/** 构建候选池参数 */
export interface BuildCandidatePoolOptions {
  now?: Date;
  excludeIds?: Set<string>;
  /** 事件键集合：30 天内已选照片的事件键，候选照片若命中则跳过 */
  eventKeys?: Set<string>;
  maxN?: number;
}

/**
 * 当前日期信息（基于北京时间）
 */
function getBeijingDateInfo(now: Date) {
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const year = shanghai.getFullYear();
  const month = String(shanghai.getMonth() + 1).padStart(2, "0");
  const day = String(shanghai.getDate()).padStart(2, "0");
  const monthNum = shanghai.getMonth() + 1;

  // 季节月份列表（北半球）
  let seasonMonths: string[];
  if (monthNum >= 3 && monthNum <= 5) {
    seasonMonths = ["03", "04", "05"]; // 春
  } else if (monthNum >= 6 && monthNum <= 8) {
    seasonMonths = ["06", "07", "08"]; // 夏
  } else if (monthNum >= 9 && monthNum <= 11) {
    seasonMonths = ["09", "10", "11"]; // 秋
  } else {
    seasonMonths = ["12", "01", "02"]; // 冬
  }

  return { year, month, day, monthDay: `${month}-${day}`, seasonMonths };
}

/**
 * 计算年份差（向下取整）
 */
function calcYearsAgo(takenAt: string | null, currentYear: number): number {
  if (!takenAt) return 0;
  try {
    const takenYear = new Date(takenAt).getFullYear();
    return Math.max(0, currentYear - takenYear);
  } catch {
    return 0;
  }
}

/**
 * 构造候选池（4 源平等混采 + per-source quota + 主题去重聚类）
 *
 * 流程：
 *   1. 4 源各取 K=maxN 张
 *   2. dedupAndQuotaMerge 做去重 + per-source quota（不截断 maxN）
 *   3. clusterByDirnameAndTime 做主题去重，每簇只保留代表
 *   4. 截前 maxN（聚类后簇数 < maxN 时直接接受 N<20，不做 K 回退）
 */
export async function buildCandidatePool(
  options: BuildCandidatePoolOptions = {},
): Promise<ClusteredCandidate[]> {
  const {
    now = new Date(),
    excludeIds = new Set<string>(),
    eventKeys = new Set<string>(),
    maxN = MAX_N,
  } = options;
  // 每源取回数 = maxN * overfetch 倍率，补偿事件键冲突丢弃的候选
  const K_PER_SOURCE = Math.ceil(maxN * EVENT_KEY_OVERFETCH_RATIO);
  const { year, month, day, monthDay, seasonMonths } = getBeijingDateInfo(now);
  const currentYear = year;
  const twoYearsAgo = new Date(now.getTime() - 2 * 365.25 * 86400_000).toISOString();

  // 连拍去重：同一组连拍只让代表进入候选池，避免 K=8 被一组连拍占满。
  // 与 routes/photos.ts:39 的列表过滤保持一致。
  const burstRepOnly = sql`(${schema.photos.burstId} IS NULL OR ${schema.photos.isBurstRepresentative} = 1)`;

  // ---- 4 个独立子查询 ----

  // 源1: 历史上的今天（月日匹配，年份 < 当前年）
  const historyTodayRows = await db
    .select({
      photoId: schema.photos.id,
      filePath: schema.photos.filePath,
      takenAt: schema.photos.takenAt,
      mediaType: schema.photos.mediaType,
      durationSec: schema.photos.durationSec,
      aestheticScore: schema.photoAnalyses.aestheticScore,
      narrative: schema.photoAnalyses.narrative,
      emotionalAnalysis: schema.photoAnalyses.emotionalAnalysis,
      tags: schema.photoAnalyses.tags,
      thumbnailPath: schema.photos.thumbnailPath,
      sourceType: schema.storageSources.type,
      latitude: schema.photos.latitude,
      longitude: schema.photos.longitude,
      offsetTime: schema.photos.offsetTime,
    })
    .from(schema.photos)
    .innerJoin(schema.photoAnalyses, sql`${schema.photoAnalyses.photoId} = ${schema.photos.id}`)
    .innerJoin(
      schema.storageSources,
      sql`${schema.storageSources.id} = ${schema.photos.storageSourceId}`,
    )
    .where(
      and(
        sql`strftime('%m-%d', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) = ${monthDay}`,
        sql`strftime('%Y', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) < ${String(currentYear)}`,
        burstRepOnly,
      ),
    )
    .orderBy(desc(schema.photoAnalyses.aestheticScore))
    .limit(K_PER_SOURCE);

  // 源2: 同月份不同日（月份匹配，日 != 今日）
  const sameMonthRows = await db
    .select({
      photoId: schema.photos.id,
      filePath: schema.photos.filePath,
      takenAt: schema.photos.takenAt,
      mediaType: schema.photos.mediaType,
      durationSec: schema.photos.durationSec,
      aestheticScore: schema.photoAnalyses.aestheticScore,
      narrative: schema.photoAnalyses.narrative,
      emotionalAnalysis: schema.photoAnalyses.emotionalAnalysis,
      tags: schema.photoAnalyses.tags,
      thumbnailPath: schema.photos.thumbnailPath,
      sourceType: schema.storageSources.type,
      latitude: schema.photos.latitude,
      longitude: schema.photos.longitude,
      offsetTime: schema.photos.offsetTime,
    })
    .from(schema.photos)
    .innerJoin(schema.photoAnalyses, sql`${schema.photoAnalyses.photoId} = ${schema.photos.id}`)
    .innerJoin(
      schema.storageSources,
      sql`${schema.storageSources.id} = ${schema.photos.storageSourceId}`,
    )
    .where(
      and(
        sql`strftime('%m', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) = ${month}`,
        sql`strftime('%d', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) != ${day}`,
        sql`strftime('%Y', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) < ${String(currentYear)}`,
        burstRepOnly,
      ),
    )
    .orderBy(desc(schema.photoAnalyses.aestheticScore))
    .limit(K_PER_SOURCE);

  // 源3: 同季节不同月（月份在季节内，但 != 今月）
  const otherSeasonMonths = seasonMonths.filter((m) => m !== month);
  let sameSeasonRows: typeof historyTodayRows = [];
  if (otherSeasonMonths.length > 0) {
    // SQLite IN 子句：需要手动拼
    const monthsInClause = otherSeasonMonths.map((m) => `'${m}'`).join(", ");
    sameSeasonRows = await db
      .select({
        photoId: schema.photos.id,
        filePath: schema.photos.filePath,
        takenAt: schema.photos.takenAt,
        mediaType: schema.photos.mediaType,
        durationSec: schema.photos.durationSec,
        aestheticScore: schema.photoAnalyses.aestheticScore,
        narrative: schema.photoAnalyses.narrative,
        emotionalAnalysis: schema.photoAnalyses.emotionalAnalysis,
        tags: schema.photoAnalyses.tags,
        thumbnailPath: schema.photos.thumbnailPath,
        sourceType: schema.storageSources.type,
        latitude: schema.photos.latitude,
        longitude: schema.photos.longitude,
        offsetTime: schema.photos.offsetTime,
      })
      .from(schema.photos)
      .innerJoin(schema.photoAnalyses, sql`${schema.photoAnalyses.photoId} = ${schema.photos.id}`)
      .innerJoin(
        schema.storageSources,
        sql`${schema.storageSources.id} = ${schema.photos.storageSourceId}`,
      )
      .where(
        and(
          sql`strftime('%m', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) IN (${sql.raw(monthsInClause)})`,
          sql`strftime('%Y', COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) < ${String(currentYear)}`,
          burstRepOnly,
        ),
      )
      .orderBy(desc(schema.photoAnalyses.aestheticScore))
      .limit(K_PER_SOURCE);
  }

  // 源4: 久远随机老照片（2 年前，按加权分+随机抖动）
  const agedRandomRows = await db
    .select({
      photoId: schema.photos.id,
      filePath: schema.photos.filePath,
      takenAt: schema.photos.takenAt,
      mediaType: schema.photos.mediaType,
      durationSec: schema.photos.durationSec,
      aestheticScore: schema.photoAnalyses.aestheticScore,
      narrative: schema.photoAnalyses.narrative,
      emotionalAnalysis: schema.photoAnalyses.emotionalAnalysis,
      tags: schema.photoAnalyses.tags,
      thumbnailPath: schema.photos.thumbnailPath,
      sourceType: schema.storageSources.type,
      latitude: schema.photos.latitude,
      longitude: schema.photos.longitude,
      offsetTime: schema.photos.offsetTime,
    })
    .from(schema.photos)
    .innerJoin(schema.photoAnalyses, sql`${schema.photoAnalyses.photoId} = ${schema.photos.id}`)
    .innerJoin(
      schema.storageSources,
      sql`${schema.storageSources.id} = ${schema.photos.storageSourceId}`,
    )
    .where(
      and(
        lt(
          sql`COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})`,
          sql`${twoYearsAgo}`,
        ),
        burstRepOnly,
      ),
    )
    .orderBy(
      desc(sql`(COALESCE(${schema.photoAnalyses.aestheticScore}, 5.0) + ABS(RANDOM() % 3)) / 1.0`),
    )
    .limit(K_PER_SOURCE);

  // ---- 转换为 EnrichedCandidate ----
  function toEnriched(rows: typeof historyTodayRows, source: CandidateSource): EnrichedCandidate[] {
    return rows
      .filter((r) => !excludeIds.has(r.photoId))
      .map((r) => {
        const yearsAgo = calcYearsAgo(r.takenAt, currentYear);
        const score = r.aestheticScore ?? 5.0;
        return {
          photoId: r.photoId,
          filePath: r.filePath,
          takenAt: r.takenAt,
          mediaType: r.mediaType,
          durationSec: r.durationSec,
          aestheticScore: r.aestheticScore,
          yearsAgo,
          weightedScore: score * ageWeightMultiplier(yearsAgo),
          source,
          narrative: r.narrative,
          emotionalAnalysis: r.emotionalAnalysis,
          tags: r.tags,
          thumbnailPath: r.thumbnailPath,
          sourceType: r.sourceType,
          latitude: r.latitude ?? null,
          longitude: r.longitude ?? null,
          offsetTime: r.offsetTime ?? null,
          peopleNicknames: [],
        };
      });
  }

  /** 事件键过滤器：候选命中已知事件键则跳过（takenAt 为 null 时不过滤） */
  function filterByEventKey(candidates: EnrichedCandidate[]): EnrichedCandidate[] {
    if (eventKeys.size === 0) return candidates;
    return candidates.filter((c) => {
      const key = computeEventKey(c.filePath, c.takenAt);
      return !key || !eventKeys.has(key);
    });
  }

  const historyToday = filterByEventKey(toEnriched(historyTodayRows, "historyToday"));
  const sameMonth = filterByEventKey(toEnriched(sameMonthRows, "sameMonth"));
  const sameSeason = filterByEventKey(toEnriched(sameSeasonRows, "sameSeason"));
  const agedRandom = filterByEventKey(toEnriched(agedRandomRows, "agedRandom"));

  // ---- per-source quota 合并（不截断）----
  // 按设计文档要求："merged.slice(0, maxN) 这一截断需要在聚类之后做，
  // 因为聚类前 80 张可能聚成 < 20 簇"。这里把 dedupAndQuotaMerge 的
  // maxN 放大到 4*maxN（即 4 源池总上限），让 quota 合并保留全部
  // 去重后的候选；最终截断推迟到聚类后做。
  //
  // 副作用：聚类后按 weightedScore desc 全局取前 maxN，不再保证
  // "每源在最终结果里保底 3 张"——quota 仅作为聚类前中间池的相对
  // 顺序锚点存在。这是文档"接受 N<20、不做 K 回退"的直接推论。
  const expandedMax = maxN * 4;
  const merged = dedupAndQuotaMerge(
    { historyToday, sameMonth, sameSeason, agedRandom },
    expandedMax,
  );

  // ---- 主题去重聚类（dirname + 时间窗）----
  // 簇数 < maxN 时直接接受 N<maxN（保护 4 源等比混采契约，不做 K 回退）
  const clustered = clusterByDirnameAndTime(merged);
  const pool1 = clustered.slice(0, maxN);

  // ---- 候选池触底回填（fillUp）----
  // 主路径足量时直接返回，零额外路径
  if (pool1.length >= maxN) {
    await enrichWithPeopleNicknames(pool1);
    return pool1;
  }

  // 主路径不足，启动 fillUp 第 5 源
  const needCount = maxN - pool1.length;
  console.info(`[fillUp] 主路径仅 ${pool1.length} 簇，启动回填，目标补足 ${needCount} 张`);

  // overfetch 倍率：fillUp 候选可能被聚类合并 + 主题冲突过滤各砍一波
  const FILLUP_OVERFETCH_RATIO = 3;

  // 排除集 = 传入的 excludeIds ∪ pool1 所有 photoId ∪ pool1 所有 clusterSiblingIds
  const excludeAfterPrimary = new Set<string>(excludeIds);
  for (const c of pool1) {
    excludeAfterPrimary.add(c.photoId);
    for (const sibId of c.clusterSiblingIds) {
      excludeAfterPrimary.add(sibId);
    }
  }

  // 把排除集转为 SQL IN 子句（drizzle 无原生 notInArray for large sets，用 raw sql）
  const excludeList = [...excludeAfterPrimary];
  const fillUpLimit = needCount * FILLUP_OVERFETCH_RATIO;

  let fillUpRawRows: typeof historyTodayRows = [];
  if (excludeList.length === 0) {
    fillUpRawRows = await db
      .select({
        photoId: schema.photos.id,
        filePath: schema.photos.filePath,
        takenAt: schema.photos.takenAt,
        mediaType: schema.photos.mediaType,
        durationSec: schema.photos.durationSec,
        aestheticScore: schema.photoAnalyses.aestheticScore,
        narrative: schema.photoAnalyses.narrative,
        emotionalAnalysis: schema.photoAnalyses.emotionalAnalysis,
        tags: schema.photoAnalyses.tags,
        thumbnailPath: schema.photos.thumbnailPath,
        sourceType: schema.storageSources.type,
        latitude: schema.photos.latitude,
        longitude: schema.photos.longitude,
        offsetTime: schema.photos.offsetTime,
      })
      .from(schema.photos)
      .innerJoin(schema.photoAnalyses, sql`${schema.photoAnalyses.photoId} = ${schema.photos.id}`)
      .innerJoin(
        schema.storageSources,
        sql`${schema.storageSources.id} = ${schema.photos.storageSourceId}`,
      )
      .where(and(gte(schema.photoAnalyses.aestheticScore, 7.5), burstRepOnly))
      .orderBy(
        desc(
          sql`(COALESCE(${schema.photoAnalyses.aestheticScore}, 5.0) + ABS(RANDOM() % 3)) / 1.0`,
        ),
      )
      .limit(fillUpLimit);
  } else {
    // 排除集非空：拼 NOT IN 子句
    const excludePlaceholders = excludeList.map((id) => sql`${id}`);
    fillUpRawRows = await db
      .select({
        photoId: schema.photos.id,
        filePath: schema.photos.filePath,
        takenAt: schema.photos.takenAt,
        mediaType: schema.photos.mediaType,
        durationSec: schema.photos.durationSec,
        aestheticScore: schema.photoAnalyses.aestheticScore,
        narrative: schema.photoAnalyses.narrative,
        emotionalAnalysis: schema.photoAnalyses.emotionalAnalysis,
        tags: schema.photoAnalyses.tags,
        thumbnailPath: schema.photos.thumbnailPath,
        sourceType: schema.storageSources.type,
        latitude: schema.photos.latitude,
        longitude: schema.photos.longitude,
        offsetTime: schema.photos.offsetTime,
      })
      .from(schema.photos)
      .innerJoin(schema.photoAnalyses, sql`${schema.photoAnalyses.photoId} = ${schema.photos.id}`)
      .innerJoin(
        schema.storageSources,
        sql`${schema.storageSources.id} = ${schema.photos.storageSourceId}`,
      )
      .where(
        and(
          gte(schema.photoAnalyses.aestheticScore, 7.5),
          burstRepOnly,
          sql`${schema.photos.id} NOT IN (${sql.join(excludePlaceholders, sql`, `)})`,
        ),
      )
      .orderBy(
        desc(
          sql`(COALESCE(${schema.photoAnalyses.aestheticScore}, 5.0) + ABS(RANDOM() % 3)) / 1.0`,
        ),
      )
      .limit(fillUpLimit);
  }

  // 转换 fillUp 原始行为 EnrichedCandidate，source 标 "fillUp"
  const fillUpCandidates = filterByEventKey(toEnriched(fillUpRawRows, "fillUp"));

  // fillUp 候选单独跑聚类
  const fillUpClusters = clusterByDirnameAndTime(fillUpCandidates);

  // ---- 主题冲突过滤 ----
  // 对每个 fillUp 簇代表 P，与 pool1 中每个簇代表做冲突检查：
  //   dirname 谓词：同 dirname 且 |Δt| ≤ 60min → 冲突
  //   GPS 谓词：haversineMeters ≤ 500m 且 |Δt| ≤ 24h → 冲突
  //
  // 简化说明：冲突判定仅对 pool1 簇代表做，不遍历 sibling。
  // 簇代表与 sibling 时间/位置相近，dirname 通常相同，已能覆盖绝大多数冲突。
  const CONFLICT_DIRNAME_MS = 60 * 60 * 1000; // 60 分钟
  const CONFLICT_GPS_M = 500; // 500 米
  const CONFLICT_GPS_MS = 24 * 3600 * 1000; // 24 小时

  const nonConflictFillUp: ClusteredCandidate[] = [];

  for (const fp of fillUpClusters) {
    const fpDir = path.posix.dirname(fp.filePath);
    const fpMs = parseTakenAtMs(fp.takenAt);

    let hasConflict = false;
    for (const p1 of pool1) {
      // dirname + 时间窗 谓词
      const p1Dir = path.posix.dirname(p1.filePath);
      if (fpDir === p1Dir) {
        const p1Ms = parseTakenAtMs(p1.takenAt);
        if (fpMs !== null && p1Ms !== null && Math.abs(fpMs - p1Ms) <= CONFLICT_DIRNAME_MS) {
          hasConflict = true;
          break;
        }
      }

      // GPS 谓词
      if (
        fp.latitude !== null &&
        fp.longitude !== null &&
        p1.latitude !== null &&
        p1.longitude !== null
      ) {
        const p1Ms = parseTakenAtMs(p1.takenAt);
        if (fpMs !== null && p1Ms !== null && Math.abs(fpMs - p1Ms) <= CONFLICT_GPS_MS) {
          const dist = haversineMeters(fp.latitude, fp.longitude, p1.latitude, p1.longitude);
          if (dist <= CONFLICT_GPS_M) {
            hasConflict = true;
            break;
          }
        }
      }
    }

    if (!hasConflict) {
      nonConflictFillUp.push(fp);
    }
  }

  // ---- 最终池 = pool1 + 非冲突 fillUp，按 weightedScore desc 全局排序截前 maxN ----
  const combined = [...pool1, ...nonConflictFillUp];
  combined.sort((a, b) => b.weightedScore - a.weightedScore);
  const finalPool = combined.slice(0, maxN);

  // ---- 在最终池形成后注入 peopleNicknames（仅图片候选）----
  await enrichWithPeopleNicknames(finalPool);
  return finalPool;
}

/**
 * 为最终候选池注入 peopleNicknames（in-place 修改）。
 *
 * 规则（契约规约 §数据契约）：
 * - 仅查图片候选；视频候选直接保持 []（detect-faces 跳过 video，无 face 数据）
 * - 一次批量 JOIN faces+persons：nickname 非空、hidden=0、person.id != selfPersonId
 * - 按 bbox 面积 DESC、去重 by person.id 后输出 nickname 数组
 */
async function enrichWithPeopleNicknames(candidates: ClusteredCandidate[]): Promise<void> {
  if (candidates.length === 0) return;

  const imageCandidates = candidates.filter((c) => c.mediaType !== "video");
  if (imageCandidates.length === 0) return;

  const selfPersonId = await getSettingValue("selfPersonId");

  const photoIds = imageCandidates.map((c) => c.photoId);
  // 用 '' 作为 sentinel，确保 selfPersonId 未设置时 p.id != '' 恒真
  const selfSentinel = selfPersonId ?? "";

  const rows = await db
    .select({
      photoId: schema.faces.photoId,
      personId: schema.persons.id,
      nickname: schema.persons.nickname,
      area: sql<number>`${schema.faces.bboxW} * ${schema.faces.bboxH}`,
    })
    .from(schema.faces)
    .innerJoin(schema.persons, sql`${schema.persons.id} = ${schema.faces.personId}`)
    .where(
      and(
        sql`${schema.faces.photoId} IN (${sql.join(
          photoIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
        sql`TRIM(COALESCE(${schema.persons.nickname}, '')) != ''`,
        eq(schema.persons.hidden, false),
        ne(schema.persons.id, selfSentinel),
      ),
    );

  // 分组 by photoId → 按 area DESC 排序 → 去重 by personId → 取 nickname
  const byPhoto = new Map<string, { personId: string; nickname: string; area: number }[]>();
  for (const r of rows) {
    const nick = r.nickname;
    if (!nick) continue;
    const bucket = byPhoto.get(r.photoId);
    const entry = { personId: r.personId, nickname: nick, area: Number(r.area) };
    if (bucket) bucket.push(entry);
    else byPhoto.set(r.photoId, [entry]);
  }

  for (const candidate of imageCandidates) {
    const bucket = byPhoto.get(candidate.photoId);
    if (!bucket || bucket.length === 0) continue;
    bucket.sort((a, b) => b.area - a.area);
    const seen = new Set<string>();
    const nicknames: string[] = [];
    for (const e of bucket) {
      if (seen.has(e.personId)) continue;
      seen.add(e.personId);
      nicknames.push(e.nickname);
    }
    candidate.peopleNicknames = nicknames;
  }
}

/**
 * per-source quota 合并：
 * - 每源保底 QUOTA_PER_SOURCE 张（按 weightedScore 取前 3）
 * - 剩余槽按 weightedScore 全局抢占（来自所有源的非保底候选），上限 = maxN
 * - 合并 → 同 photoId 去重（保留先出现者）→ 截前 maxN
 *
 * 注：抢占池上限设为 maxN（而非固定 8），确保活跃源少时仍能填满 maxN 个唯一候选。
 * 注：fillUp 不参与 quota 合并，由 buildCandidatePool 单独处理。
 */
export function dedupAndQuotaMerge(
  bySource: Record<PrimaryCandidateSource, EnrichedCandidate[]>,
  maxN = MAX_N,
): EnrichedCandidate[] {
  const sources: PrimaryCandidateSource[] = [
    "historyToday",
    "sameMonth",
    "sameSeason",
    "agedRandom",
  ];

  // 各源按 weightedScore 降序
  for (const src of sources) {
    bySource[src].sort((a, b) => b.weightedScore - a.weightedScore);
  }

  // 保底席位：每源前 QUOTA_PER_SOURCE 张
  const quotaItems: EnrichedCandidate[] = [];
  const quotaIds = new Set<string>();
  for (const src of sources) {
    for (const item of bySource[src].slice(0, QUOTA_PER_SOURCE)) {
      if (!quotaIds.has(item.photoId)) {
        quotaIds.add(item.photoId);
        quotaItems.push(item);
      }
    }
  }

  // 抢占池：所有源中未进入保底的候选
  // 抢占席位 = maxN - 已有保底席位数，确保 quota + contest = maxN（保底不浪费）
  const contestSlots = Math.max(0, maxN - quotaItems.length);
  const contestPool: EnrichedCandidate[] = [];
  for (const src of sources) {
    for (const item of bySource[src].slice(QUOTA_PER_SOURCE)) {
      if (!quotaIds.has(item.photoId)) {
        contestPool.push(item);
      }
    }
  }
  contestPool.sort((a, b) => b.weightedScore - a.weightedScore);
  const contestWinners: EnrichedCandidate[] = [];
  const contestIds = new Set<string>(quotaIds);
  for (const item of contestPool) {
    if (contestWinners.length >= contestSlots) break;
    if (!contestIds.has(item.photoId)) {
      contestIds.add(item.photoId);
      contestWinners.push(item);
    }
  }

  // 合并，再次去重（保底 + 抢占可能来自相同 photoId）
  const merged: EnrichedCandidate[] = [];
  const seenIds = new Set<string>();
  for (const item of [...quotaItems, ...contestWinners]) {
    if (!seenIds.has(item.photoId)) {
      seenIds.add(item.photoId);
      merged.push(item);
    }
  }

  // 按 weightedScore 全局排序后截前 maxN
  merged.sort((a, b) => b.weightedScore - a.weightedScore);
  return merged.slice(0, maxN);
}

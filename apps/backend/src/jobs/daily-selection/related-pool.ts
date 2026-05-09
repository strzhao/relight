/**
 * 关联候选池：hero 照片同日 ±6h 时间窗内的兄弟照片
 */

import { sql } from "drizzle-orm";
import { db, schema } from "../../db";
import type { EnrichedCandidate } from "./candidate-pool";

/** 关联候选 */
export interface RelatedCandidate {
  photoId: string;
  filePath: string;
  takenAt: string | null;
  mediaType: "image" | "video";
  durationSec: number | null;
  aestheticScore: number | null;
  narrative: string | null;
  emotionalAnalysis: unknown | null;
  tags: unknown | null;
  thumbnailPath: string | null;
  sourceType: "local" | "smb" | "webdav";
}

/**
 * 构造 hero 关联候选池
 *
 * 策略：
 * - 同一日（date(takenAt) = date(hero.takenAt)）的照片
 * - ±6 小时窗（|takenAt - hero.takenAt| < 6h）
 * - 排除 hero 自身、排除 excludeIds（30 天去重列表）
 * - 必须已分析（INNER JOIN photoAnalyses）
 * - 按 takenAt ASC（故事按时间顺序）
 * - 上限 20 张
 */
export async function buildRelatedPool(
  hero: Pick<EnrichedCandidate, "photoId" | "takenAt">,
  excludeIds: Set<string>,
  maxRelated = 20,
): Promise<RelatedCandidate[]> {
  if (!hero.takenAt) {
    // hero 无拍摄时间，无法确定时间窗
    return [];
  }

  // EXIF 写入的 takenAt 多为 'YYYY-MM-DD HH:MM:SS' 字面值（无时区）。
  // 直接 new Date() 会按本地时区解析，再 toISOString() 会平移时区偏移；
  // 而 SQLite 把 DB 里同样无时区的字符串视为 naive UTC——两侧语义错位。
  // 这里强制按 UTC 解析：缺少时区标记时补 'Z'，让 JS 与 SQL 比较口径一致。
  const isoLike = /[Zz]|[+-]\d{2}:?\d{2}$/.test(hero.takenAt)
    ? hero.takenAt
    : `${hero.takenAt.replace(" ", "T")}Z`;
  const heroTime = new Date(isoLike).getTime();
  if (Number.isNaN(heroTime)) return [];

  const sixHoursMs = 6 * 3600 * 1000;
  const windowStart = new Date(heroTime - sixHoursMs).toISOString();
  const windowEnd = new Date(heroTime + sixHoursMs).toISOString();

  const rows = await db
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
    })
    .from(schema.photos)
    .innerJoin(schema.photoAnalyses, sql`${schema.photoAnalyses.photoId} = ${schema.photos.id}`)
    .innerJoin(
      schema.storageSources,
      sql`${schema.storageSources.id} = ${schema.photos.storageSourceId}`,
    )
    .where(
      // 必须用 datetime() 包裹两侧再比较：
      // photos.taken_at 是 'YYYY-MM-DD HH:MM:SS'（空格分隔），windowStart 是 ISO（T 分隔 + Z）。
      // 直接字符串 >= 会按字典序比较，空格 < 'T'，所有 taken_at 都被错误地判为小于窗口起点。
      sql`${schema.photos.id} != ${hero.photoId}
          AND datetime(COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) >= datetime(${windowStart})
          AND datetime(COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) <= datetime(${windowEnd})`,
    )
    .orderBy(sql`datetime(COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})) ASC`)
    .limit(maxRelated + excludeIds.size); // 多取一些，后续过滤

  const filtered = rows.filter((r) => !excludeIds.has(r.photoId)).slice(0, maxRelated);

  return filtered;
}

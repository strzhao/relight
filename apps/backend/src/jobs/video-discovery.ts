/**
 * 主题发现（video-discovery）。
 *
 * 移植 recall-trips（GPS region + 同地≤5天=单次旅行）+ recall-growth（cos≥0.5 + 按年），
 * 叠加 video_usages 去重逻辑：
 * - 旅行：仅按 themeKey（regionSlug+年）去重。复访同地不同年 = 不同 themeKey，应能出片。不按 photoId 去重。
 * - 人物：按 personId 最大 toYear；该 person 最新照片年 > max toYear 才候选；按 photoId 排除已 consumed。
 *
 * 算法源自 `.autopilot/.../video-dryrun/recall-trips.cjs` + `recall-growth.cjs`（dry-run 验证过）。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { cosineSim } from "../lib/face/clustering";
import { getSettingValue } from "../lib/settings";

/** videos 表 themeKey 去重集合（loadVideoDedup 返回） */
interface VideoDedup {
  /** 已成功出片的 themeKey——永久去重 */
  completedKeys: Set<string>;
  /** 失败但在冷却期内的 themeKey（failed 且 createdAt >= now-7d） */
  coolingKeys: Set<string>;
}

/**
 * 加载某 themeKind 的 videos 表去重键。
 *
 * completed 永久去重；failed 7 天内冷却去重——杜绝确定性失败死循环
 * （曾因 finalize 脚本拷错目录，japan-2018 每天失败每天重选，锁死出片名额 5 天；
 * person 线 aa17477e 因去重盲区连挂 16 天，见 20260827 修复每日视频自动化死循环诊断）；
 * 7 天后放开，给偶发失败（LLM 超时、临时渲染崩）一次重试机会。
 *
 * trip / person 两分支共用；videoUsages 表只在成功路径写、失败主题对它不可见，
 * 因此失败可见性必须查 videos 表本表。
 */
async function loadVideoDedup(themeKind: "trip" | "person"): Promise<VideoDedup> {
  const cooldownIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const rows = await db
    .select({
      themeKey: schema.videos.themeKey,
      status: schema.videos.status,
      createdAt: schema.videos.createdAt,
    })
    .from(schema.videos)
    .where(eq(schema.videos.themeKind, themeKind));

  const completedKeys = new Set<string>();
  const coolingKeys = new Set<string>();
  for (const r of rows) {
    if (r.status === "completed") {
      completedKeys.add(r.themeKey);
    } else if (r.status === "failed" && r.createdAt >= cooldownIso) {
      coolingKeys.add(r.themeKey);
    }
  }
  return { completedKeys, coolingKeys };
}

/** region 中文 → 英文 slug 映射（themeKey 用 `<regionSlug>-<year>`） */
const REGION_SLUG: Record<string, string> = {
  东北: "dongbei",
  日本: "japan",
  韩国: "korea",
  越南: "vietnam",
  海南: "hainan",
  福建·粤东: "fujian-guangdong",
  重庆·川南: "chongqing",
  贵州·云贵: "guizhou-yungui",
  北京·长城: "beijing",
  山东: "shandong",
  华中: "central-china",
};

/**
 * region 判定（仅覆盖中国及周边，recall-trips 硬编码区间，国外后续扩展）。
 * 返回中文名或 null（边界模糊不参与）。
 */
function region(lat: number, lng: number): string | null {
  if (lat >= 41 && lat <= 47 && lng >= 118 && lng <= 135) return "东北"; // 先于日本
  if (lat >= 31 && lat <= 46 && lng >= 130 && lng <= 146) return "日本";
  if (lat >= 33 && lat <= 38.5 && lng >= 125.5 && lng <= 130) return "韩国";
  if (lat >= 10 && lat <= 23 && lng >= 102 && lng <= 110) return "越南";
  // 海南岛先于越南收回：岛体（18-20.5N, 108.5-111.3E）整个落在越南围栏内——
  // 20260829 vietnam-2026 实为三亚海棠湾/蜈支洲岛之行被误标越南。
  // 围栏只含海南岛+北部湾海面，不含越南陆地（越南 18N+ 的国土在 108.5E 以西）。
  if (lat >= 18 && lat <= 20.5 && lng >= 108.5 && lng <= 111.3) return "海南";
  if (lat >= 22 && lat <= 27.5 && lng >= 115 && lng <= 121) return "福建·粤东";
  if (lat >= 28.5 && lat <= 31 && lng >= 105 && lng <= 108.5) return "重庆·川南"; // 先于贵州
  if (lat >= 24 && lat <= 28.5 && lng >= 102 && lng <= 108.5) return "贵州·云贵";
  if (lat >= 38.5 && lat <= 41.5 && lng >= 114 && lng <= 120) return "北京·长城";
  if (lat >= 34 && lat <= 38.5 && lng >= 115 && lng <= 123) return "山东";
  if (lat >= 27 && lat <= 34 && lng >= 108 && lng <= 116) return "华中";
  return null;
}

/** 旅行主题最小照片数（<15 张不成片，契约「质量优先」） */
const TRIP_MIN_PHOTOS = 20; // 旅行照片 <20 不候选（不够做完整 vlog，没意义）
/** 同 region 时间窗口（间隔≤5天归为同一次旅行，recall-trips.cjs:41） */
const TRIP_GAP_DAYS = 5;
/** 人物成长线 cos 阈值（recall-growth.cjs:41 筛 >=0.5） */
const PERSON_COS_THRESHOLD = 0.5;

/** 候选主题统一形状 */
export interface VideoCandidate {
  themeKind: "trip" | "person";
  /** trip: `<regionSlug>-<year>` / person: `<personId>-<toYear>` */
  themeKey: string;
  /** 旅行：选片 photoId 列表（按美学降序 top）；人物：personId（素材由 skill 内部选） */
  photoIds: string[];
  /** person 专属：personId（旅行为空） */
  personId?: string;
  /** 覆盖到的最新照片年 */
  toYear: number;
  /** 新鲜度评分（desc 排序用：越大越优先） */
  freshness: number;
  /** 展示标题候选（供 job 选用） */
  titleHint: string;
}

/** 将 base64 编码的 Float32Array embedding 解码 */
function decodeEmbedding(raw: string): Float32Array {
  const buf = Buffer.from(raw, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * 发现视频候选主题（旅行 + 人物成长线），新鲜度降序。
 *
 * 去重语义：
 * - 旅行：仅按 themeKey（已生成过的 region+年 跳过）；不按 photoId。
 * - 人物：personId 的最大 consumed toYear；该 person 最新照片年 > max toYear 才候选；
 *        选片时按 photoId 排除已 consumed（防亲子照跨主题陷阱）。
 *
 * @returns 候选数组，新鲜度 desc；空数组 = 当天不出片
 */
export async function discoverVideoCandidates(): Promise<VideoCandidate[]> {
  const candidates: VideoCandidate[] = [];

  // === 旅行主题 ===
  const tripCandidates = await discoverTrips();
  candidates.push(...tripCandidates);

  // === 人物成长线主题 ===
  const personCandidates = await discoverPersonGrowth();
  candidates.push(...personCandidates);

  // 新鲜度降序
  candidates.sort((a, b) => b.freshness - a.freshness);
  return candidates;
}

/** 旅行主题发现（移植 recall-trips + themeKey 去重） */
async function discoverTrips(): Promise<VideoCandidate[]> {
  // 取所有有 GPS、有缩略图的图片（排除 GPS=0,0 + 排除本地 27.5-31.5N/118-122.5E 仿 recall-trips 过滤）
  const rows = await db
    .select({
      id: schema.photos.id,
      lat: schema.photos.latitude,
      lng: schema.photos.longitude,
      takenAt: schema.photos.takenAt,
    })
    .from(schema.photos)
    .where(
      and(
        sql`${schema.photos.latitude} IS NOT NULL`,
        sql`(${schema.photos.latitude} <> 0 OR ${schema.photos.longitude} <> 0)`,
        sql`NOT (${schema.photos.latitude} BETWEEN 27.5 AND 31.5 AND ${schema.photos.longitude} BETWEEN 118 AND 122.5)`,
        sql`${schema.photos.thumbnailPath} LIKE '%.jpg'`,
        eq(schema.photos.mediaType, "image"),
      ),
    );

  // 打 region + 解析时间戳
  const tagged: Array<{ id: string; region: string; ts: number; takenAt: string; year: number }> =
    [];
  for (const r of rows) {
    if (r.lat == null || r.lng == null || !r.takenAt) continue;
    const reg = region(r.lat, r.lng);
    if (!reg) continue;
    const ts = Date.parse(r.takenAt);
    if (!Number.isFinite(ts)) continue;
    tagged.push({
      id: r.id,
      region: reg,
      ts,
      takenAt: r.takenAt,
      year: Number.parseInt(r.takenAt.slice(0, 4), 10),
    });
  }

  // 按 region 分组
  const byRegion = new Map<string, typeof tagged>();
  for (const r of tagged) {
    const arr = byRegion.get(r.region) ?? [];
    arr.push(r);
    byRegion.set(r.region, arr);
  }

  // 同 region 内按时间排序 + ≤5天窗口聚类成单次旅行
  interface Trip {
    region: string;
    photos: typeof tagged;
    year: number;
    startTs: number;
    endTs: number;
  }
  const trips: Trip[] = [];
  for (const [reg, arr] of byRegion) {
    arr.sort((a, b) => a.ts - b.ts);
    let cur: typeof tagged = [];
    for (const r of arr) {
      if (cur.length === 0) {
        cur = [r];
        continue;
      }
      const last = cur[cur.length - 1];
      if (!last) continue;
      const gap = (r.ts - last.ts) / 86_400_000;
      if (gap <= TRIP_GAP_DAYS) {
        cur.push(r);
      } else {
        const first = cur[0];
        if (!first) {
          cur = [r];
          continue;
        }
        trips.push({
          region: reg,
          photos: cur,
          year: first.year,
          startTs: first.ts,
          endTs: last.ts,
        });
        cur = [r];
      }
    }
    if (cur.length) {
      const first = cur[0];
      const last = cur[cur.length - 1];
      if (first && last) {
        trips.push({
          region: reg,
          photos: cur,
          year: first.year,
          startTs: first.ts,
          endTs: last.ts,
        });
      }
    }
  }

  // 取已生成过的 trip themeKey（仅按 themeKey 去重，不按 photoId）。
  // completed 永久去重；failed 7 天内冷却（语义见 loadVideoDedup 注释）
  const { completedKeys, coolingKeys } = await loadVideoDedup("trip");

  const candidates: VideoCandidate[] = [];
  for (const t of trips) {
    if (t.photos.length < TRIP_MIN_PHOTOS) continue;
    const slug = REGION_SLUG[t.region];
    if (!slug) continue; // 未知 region 不出片
    const themeKey = `${slug}-${t.year}`;
    if (completedKeys.has(themeKey)) continue; // 已生成过跳过
    if (coolingKeys.has(themeKey)) continue; // failed 冷却期内跳过

    // 选片：给该旅行全部可用照片（按美学降序，不限上限）——让 AI(claude-p) 按旅行丰富度自主决定最终片数（≥20，素材多就做完整 vlog，不限制发挥）
    const photoIds = t.photos.map((p) => p.id);
    const top = await pickTopAesthetic(photoIds, photoIds.length);
    candidates.push({
      themeKind: "trip",
      themeKey,
      photoIds: top,
      toYear: t.year,
      // 新鲜度：距今越近越优先（天数的负数 → 越大越新）
      freshness: t.endTs,
      titleHint: `${t.region} · ${t.year}`,
    });
  }
  return candidates;
}

/** 从 photoId 列表按美学评分降序取 top N */
async function pickTopAesthetic(photoIds: string[], n: number): Promise<string[]> {
  if (photoIds.length === 0) return [];
  const rows = await db
    .select({
      photoId: schema.photoAnalyses.photoId,
      score: schema.photoAnalyses.aestheticScore,
    })
    .from(schema.photoAnalyses)
    .where(inArray(schema.photoAnalyses.photoId, photoIds));
  // photoId → 最高分（一张可能多次分析）
  const best = new Map<string, number>();
  for (const r of rows) {
    const prev = best.get(r.photoId) ?? -1;
    if ((r.score ?? 0) > prev) best.set(r.photoId, r.score ?? 0);
  }
  // 未分析的也保留（score=0），但排在已分析之后
  const merged = photoIds.map((id) => ({ id, score: best.get(id) ?? 0 }));
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, n).map((m) => m.id);
}

/** 人物成长线主题发现（移植 recall-growth + personId toYear 去重 + photoId 排除） */
async function discoverPersonGrowth(): Promise<VideoCandidate[]> {
  // 脏聚类跳过名单（settings key video.skipPersonIds，逗号分隔 personId 标量字符串）。
  // 命中者连候选都不进——比 themeKey 去重更早。用于聚类污染且 cos 分不开的必败主题
  // （如外婆/女儿混淆聚类，每天选它每天失败锁死出片名额）；缺失/空 = 无跳过。
  const skipRaw = await getSettingValue("video.skipPersonIds");
  const skipPersonIds = new Set(
    (skipRaw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

  // 取所有 displayable 的人物（displayThreshold 已在聚类阶段设置）
  const persons = await db
    .select({
      id: schema.persons.id,
      name: schema.persons.name,
      nickname: schema.persons.nickname,
      centroidEmbedding: schema.persons.centroidEmbedding,
      memberCount: schema.persons.memberCount,
    })
    .from(schema.persons)
    .where(eq(schema.persons.displayable, true));

  // videos 表去重与 trip 分支对称（completed 永久 / failed 7 天冷却）。
  // videoUsages 只在成功时写、失败主题对它不可见——去重盲区曾是死循环根因。
  const { completedKeys, coolingKeys } = await loadVideoDedup("person");

  const candidates: VideoCandidate[] = [];

  // 全局已 consumed photoId（跨主题排除亲子照陷阱，预取一次复用，避免循环内 N 次 O(M) 查询）
  const allConsumedRows = await db
    .select({ photoId: schema.videoUsages.photoId })
    .from(schema.videoUsages);
  const consumedPhotoIds = new Set(allConsumedRows.map((r) => r.photoId));

  for (const person of persons) {
    if (skipPersonIds.has(person.id)) continue; // 脏聚类跳过名单
    // 人物主题无最低照片门槛（旅行才需 ≥15 张；人物按年选片，样本天然较少）

    // 取该 person 所有 face + 关联 photo 的年份
    const faceRows = await db
      .select({
        photoId: schema.faces.photoId,
        embedding: schema.faces.embedding,
        takenAt: schema.photos.takenAt,
      })
      .from(schema.faces)
      .innerJoin(schema.photos, eq(schema.photos.id, schema.faces.photoId))
      .where(
        and(
          eq(schema.faces.personId, person.id),
          sql`${schema.photos.thumbnailPath} LIKE '%.jpg'`,
          eq(schema.photos.mediaType, "image"),
        ),
      );
    if (faceRows.length === 0) continue;

    const centroid = decodeEmbedding(person.centroidEmbedding);

    // 按 photoId 聚合：取 cos 最高的 face（recall-growth.cjs:28-32）
    const byPhoto = new Map<string, { cos: number; year: number; takenAt: string }>();
    for (const f of faceRows) {
      if (!f.takenAt) continue;
      const emb = decodeEmbedding(f.embedding);
      const cos = cosineSim(emb, centroid);
      const year = Number.parseInt(f.takenAt.slice(0, 4), 10);
      const prev = byPhoto.get(f.photoId);
      if (!prev || cos > prev.cos) {
        byPhoto.set(f.photoId, { cos, year, takenAt: f.takenAt });
      }
    }

    // 按年分组 + cos>=0.5 过滤（recall-growth.cjs:41）
    const byYear = new Map<number, Array<{ photoId: string; cos: number }>>();
    let maxYear = 0;
    for (const [photoId, v] of byPhoto) {
      if (v.cos < PERSON_COS_THRESHOLD) continue;
      if (v.year > maxYear) maxYear = v.year;
      const arr = byYear.get(v.year) ?? [];
      arr.push({ photoId, cos: v.cos });
      byYear.set(v.year, arr);
    }
    if (maxYear === 0) continue;

    // 查该 person 已 consumed 的最大 toYear（themeKey 尾部年份，用于 person 阶段去重）
    const consumedSamePerson = await db
      .select({ themeKey: schema.videoUsages.themeKey })
      .from(schema.videoUsages)
      .where(
        and(
          eq(schema.videoUsages.themeKind, "person"),
          sql`${schema.videoUsages.themeKey} LIKE ${`${person.id}-%`}`,
        ),
      );

    let maxConsumedYear = 0;
    for (const c of consumedSamePerson) {
      // themeKey = `<personId>-<toYear>`，解析尾部年份
      const m = c.themeKey.match(/-(\d{4})$/);
      const y = m?.[1] ? Number.parseInt(m[1], 10) : 0;
      if (y > maxConsumedYear) maxConsumedYear = y;
    }

    // 该 person 最新照片年 > max consumed toYear 才候选（有新阶段）
    if (maxYear <= maxConsumedYear) continue;

    const toYear = maxYear;
    const themeKey = `${person.id}-${toYear}`;

    // 与 trip 分支对称的 videos 表去重：completed 永久 / failed 7 天冷却
    if (completedKeys.has(themeKey)) continue;
    if (coolingKeys.has(themeKey)) continue;

    // 选片：每年取 top（早期少取近期多取，仿 recall-growth.cjs:51-57），排除已 consumed photoId
    const picks: string[] = [];
    const years = [...byYear.keys()].sort((a, b) => a - b);
    for (const y of years) {
      const arr = byYear.get(y);
      if (!arr) continue;
      arr.sort((a, b) => b.cos - a.cos);
      const n = y <= 2022 ? 2 : 5; // 婴儿期 2 张 / 近期 5 张
      for (const x of arr.slice(0, n)) {
        if (!consumedPhotoIds.has(x.photoId)) {
          picks.push(x.photoId);
        }
      }
    }
    if (picks.length === 0) continue;

    const displayName = person.nickname || person.name || "人物";
    candidates.push({
      themeKind: "person",
      themeKey,
      photoIds: picks,
      personId: person.id,
      toYear,
      // 新鲜度：toYear 越大越优先 + 样本量加权
      freshness: toYear * 1000 + picks.length,
      titleHint: `${displayName} · 成长线`,
    });
  }

  return candidates;
}

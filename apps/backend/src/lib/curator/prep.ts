/**
 * AI 策展人备料（lib/curator/prep.ts）——把库的结构化摘要压成一份 ≤~40KB 的 JSON。
 *
 * 职责边界（守「后端零业务逻辑」架构决策）：后端只负责「把数据摊开」，不替 AI
 * 做任何策展判断——什么主题值得做、选哪些照片，全部由 curator prompt 侧的
 * claude 决定。本模块只保证：数字真实、id 真实存在、体积可控。
 *
 * 候选 id 池（placeClusters / recurringDates 各带 ≤40 张 aesthetic 降序样本）是
 * v1 关键设计：curator 直接在池内选片输出完整 photo_ids 名单，daily-video 才能
 * 用现有 trip 形态素材通道 spawn（免改 memory-video skill）。
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";

export interface CuratorPrep {
  generatedAt: string;
  library: {
    totalPhotos: number;
    byYear: Array<{ y: string; c: number }>;
    recent24m: Array<{ m: string; c: number }>;
  };
  completedVideos: Array<{ themeKey: string; title: string; date: string }>;
  personLines: Array<{
    personId: string;
    label: string;
    members: number;
    span: string;
  }>;
  placeClusters: Array<{
    days: number;
    photos: number;
    span: string;
    candidates: Array<{ id: string; d: string; aes: number }>;
  }>;
  recurringDates: Array<{
    md: string;
    photos: number;
    years: number;
    candidates: Array<{ id: string; d: string; aes: number }>;
  }>;
  tagDistribution: Array<{ name: string; c: number; samples: string[] }>;
  topAestheticPhotos: Array<{ id: string; d: string; aes: number }>;
}

interface RawRow {
  [k: string]: unknown;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const str = (v: unknown): string => String(v ?? "");

/** db.all 的轻包装（drizzle better-sqlite3 同步驱动 → 统一 await 形态） */
async function rows(query: ReturnType<typeof sql>): Promise<RawRow[]> {
  return Promise.resolve(db.all(query) as RawRow[]);
}

export async function buildCuratorPrep(): Promise<CuratorPrep> {
  // 1. 库概览
  const totalPhotos = num((await rows(sql`SELECT COUNT(*) AS c FROM photos`))[0]?.c);
  const byYear = (
    await rows(
      sql`SELECT substr(taken_at,1,4) AS y, COUNT(*) AS c FROM photos
          WHERE taken_at IS NOT NULL GROUP BY y ORDER BY y`,
    )
  ).map((r) => ({ y: str(r.y), c: num(r.c) }));
  const recent24m = (
    await rows(
      sql`SELECT substr(taken_at,1,7) AS m, COUNT(*) AS c FROM photos
          WHERE taken_at >= date('now','-24 months') GROUP BY m ORDER BY m`,
    )
  ).map((r) => ({ m: str(r.m), c: num(r.c) }));

  // 2. 已完成视频（去重清单：同主题不再提名）
  const completedVideos = (
    await rows(
      sql`SELECT theme_key, title, substr(created_at,1,10) AS d FROM videos
          WHERE status = 'completed' ORDER BY created_at DESC`,
    )
  ).map((r) => ({ themeKey: str(r.theme_key), title: str(r.title), date: str(r.d) }));

  // 3. 人物线（中性统计：让策展人知道哪些人已覆盖，避免重复提名；出片仍走 discovery person 分支）
  const personLines = (
    await rows(
      sql`SELECT p.id, COALESCE(NULLIF(p.nickname,''), p.name, '未命名') AS label,
                 p.member_count AS members,
                 MIN(substr(ph.taken_at,1,10)) AS mn, MAX(substr(ph.taken_at,1,10)) AS mx
          FROM persons p
          LEFT JOIN faces f ON f.person_id = p.id
          LEFT JOIN photos ph ON ph.id = f.photo_id
          WHERE p.displayable = 1
          GROUP BY p.id ORDER BY p.member_count DESC LIMIT 20`,
    )
  ).map((r) => ({
    personId: str(r.id),
    label: str(r.label),
    members: num(r.members),
    span: `${str(r.mn)}→${str(r.mx)}`,
  }));

  // 4. 地点簇（GPS 0.1°≈11km 粒度聚合，≥15 张 ≥2 天）+ 每簇 ≤40 张美学候选池
  const placeRows = (
    await rows(
      sql`SELECT ROUND(latitude,1) AS la, ROUND(longitude,1) AS lo,
                 COUNT(*) AS c, COUNT(DISTINCT substr(taken_at,1,10)) AS days,
                 MIN(substr(taken_at,1,10)) AS mn, MAX(substr(taken_at,1,10)) AS mx
          FROM photos WHERE latitude IS NOT NULL AND taken_at IS NOT NULL
          GROUP BY la, lo HAVING c >= 15 AND days >= 2
          ORDER BY MAX(taken_at) DESC LIMIT 8`,
    )
  ).map((r) => ({
    la: num(r.la),
    lo: num(r.lo),
    photos: num(r.c),
    days: num(r.days),
    mn: str(r.mn),
    mx: str(r.mx),
  }));
  const placeClusters = [];
  for (const p of placeRows) {
    const candidates = (
      await rows(
        sql`SELECT ph.id AS id, substr(ph.taken_at,1,10) AS d,
                   COALESCE(pa.aesthetic_score,0) AS aes
            FROM photos ph LEFT JOIN photo_analyses pa ON pa.photo_id = ph.id
            WHERE ROUND(ph.latitude,1) = ${p.la} AND ROUND(ph.longitude,1) = ${p.lo}
              AND ph.media_type = 'image'
            ORDER BY aes DESC LIMIT 40`,
      )
    ).map((r) => ({ id: str(r.id), d: str(r.d), aes: num(r.aes) }));
    placeClusters.push({ days: p.days, photos: p.photos, span: `${p.mn}→${p.mx}`, candidates });
  }

  // 5. 年度重复事件（生日的信号：同月日 ≥12 张跨 ≥3 年）+ ±2 天窗口候选池
  const recurringRows = (
    await rows(
      sql`SELECT substr(taken_at,6,5) AS md, COUNT(*) AS c,
                 COUNT(DISTINCT substr(taken_at,1,4)) AS yrs
          FROM photos WHERE taken_at IS NOT NULL
          GROUP BY md HAVING c >= 12 AND yrs >= 3 ORDER BY c DESC LIMIT 4`,
    )
  ).map((r) => ({ md: str(r.md), photos: num(r.c), years: num(r.yrs) }));
  const recurringDates = [];
  for (const r of recurringRows) {
    // ±2 个月窗口（生日期 md="06-22" → 4~8 月），月份数字比较避免跨年字符串序问题
    const month = Number.parseInt(r.md.slice(0, 2), 10);
    const candidates = (
      await rows(
        sql`SELECT ph.id AS id, substr(ph.taken_at,1,10) AS d,
                   COALESCE(pa.aesthetic_score,0) AS aes
            FROM photos ph LEFT JOIN photo_analyses pa ON pa.photo_id = ph.id
            WHERE ph.taken_at IS NOT NULL AND ph.media_type = 'image'
              AND CAST(substr(ph.taken_at,6,2) AS INTEGER) BETWEEN ${month - 2} AND ${month + 2}
            ORDER BY aes DESC LIMIT 40`,
      )
    ).map((x) => ({ id: str(x.id), d: str(x.d), aes: num(x.aes) }));
    recurringDates.push({ md: r.md, photos: r.photos, years: r.years, candidates });
  }

  // 6. 标签分布 + 每标签 3 张高美学样本
  const tagRows = (
    await rows(
      sql`SELECT t.name AS name, COUNT(*) AS c FROM photo_tags pt
          JOIN tags t ON t.id = pt.tag_id
          GROUP BY t.name HAVING c >= 100 ORDER BY c DESC LIMIT 30`,
    )
  ).map((r) => ({ name: str(r.name), c: num(r.c) }));
  const tagDistribution = [];
  for (const t of tagRows) {
    const samples = await rows(
      sql`SELECT pt.photo_id AS id FROM photo_tags pt
          JOIN photo_analyses pa ON pa.photo_id = pt.photo_id
          WHERE pt.tag_id = (SELECT id FROM tags WHERE name = ${t.name})
            AND pa.aesthetic_score IS NOT NULL
          ORDER BY pa.aesthetic_score DESC LIMIT 3`,
    );
    tagDistribution.push({ name: t.name, c: t.c, samples: samples.map((s) => str(s.id)) });
  }

  // 7. 美学 top 单张
  const topAestheticPhotos = (
    await rows(
      sql`SELECT ph.id AS id, substr(ph.taken_at,1,10) AS d,
                 pa.aesthetic_score AS aes
          FROM photos ph JOIN photo_analyses pa ON pa.photo_id = ph.id
          WHERE pa.aesthetic_score IS NOT NULL AND ph.taken_at IS NOT NULL
          ORDER BY aes DESC LIMIT 25`,
    )
  ).map((r) => ({ id: str(r.id), d: str(r.d), aes: num(r.aes) }));

  return {
    generatedAt: new Date().toISOString().slice(0, 10),
    library: { totalPhotos, byYear, recent24m },
    completedVideos,
    personLines,
    placeClusters,
    recurringDates,
    tagDistribution,
    topAestheticPhotos,
  };
}

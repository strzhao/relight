import { writeFile } from "node:fs/promises";
/**
 * Dry-run v2：对比过去 7 天「旧算法 hero」vs「新算法 hero」
 * 新算法完整链路：buildCandidatePool（新 ageBonus + 美学下限 ≥7.0）→ runSelectStage（select AI 评选）
 * 用新算法重新构建候选池（而非 DB 既有 entries），让美学下限真实生效。
 * 不写库，只读 DB + 调真实 AI select。
 *
 * 运行：pnpm --filter @relight/backend exec tsx scripts/dry-run-select-compare.ts
 */
import Database from "better-sqlite3";
import { runSelectStage } from "../src/jobs/daily-selection";
import {
  buildCandidatePool,
  getRecentPickedEventKeys,
} from "../src/jobs/daily-selection/candidate-pool";
import type { ClusteredCandidate } from "../src/jobs/daily-selection/cluster";

const DB_PATH = "./data/relight.db";
const API_BASE = "http://localhost:3000";
const OUT_HTML =
  "/Users/stringzhao/workspace/relight/.autopilot/runtime/requirements/20260711-开始实现/select-compare.html";
const PICK_DATES = [
  "2026-07-05",
  "2026-07-06",
  "2026-07-07",
  "2026-07-08",
  "2026-07-09",
  "2026-07-10",
  "2026-07-11",
];

const ageBonusNew = (y: number): number => (y < 1 ? 0 : Math.min(0.3, Math.sqrt(y) * 0.05));
const ageMultOld = (y: number): number => (y < 1 ? 1.0 : 1.0 + Math.min(0.6, Math.sqrt(y) * 0.1));

interface Cand {
  photoId: string;
  aestheticScore: number | null;
  takenAt: string | null;
  yearsAgo: number;
  source: string;
  weightedNew: number;
}

interface DayResult {
  pickDate: string;
  oldHeroDb: { photoId: string; title: string; aestheticScore: number | null } | null;
  oldHeroBlocked: boolean; // 旧 hero 是否被新美学下限挡（不在新候选池）
  oldFormulaRank0FromPool: { photoId: string; weightedScore: number } | null; // 新候选池里按旧公式算的 rank0
  newSelectHero: { photoId: string; reasoning: string; source: string } | null;
  candidates: Cand[]; // 新候选池
}

async function main() {
  const sqlite = new Database(DB_PATH, { readonly: true });
  const results: DayResult[] = [];
  const selectedIds = new Set<string>(); // 累积新选 hero，跨天去重（模拟真实 cron 顺序）

  for (const pickDate of PICK_DATES) {
    const pick = sqlite
      .prepare("SELECT photo_id, title FROM daily_picks WHERE pick_date = ?")
      .get(pickDate) as { photo_id: string; title: string } | undefined;
    // 旧 hero 的美学分（用于判断是否被新下限挡）
    const oldHeroAes = pick
      ? ((
          sqlite
            .prepare("SELECT aesthetic_score FROM photo_analyses WHERE photo_id = ?")
            .get(pick.photo_id) as { aesthetic_score: number | null } | undefined
        )?.aesthetic_score ?? null)
      : null;

    // 新算法构建候选池（新 ageBonus + 美学下限 ≥7.0；只用累积新选跨天去重——
    // 不用 DB 30 天去重池，因为那是旧算法的 entries，会把新候选池掏空）
    const pickNow = new Date(`${pickDate}T04:00:00Z`);
    const pool: ClusteredCandidate[] = await buildCandidatePool({
      now: pickNow,
      excludeIds: new Set(selectedIds),
      eventKeys: new Set(),
      maxN: 12,
    });

    // 旧 hero 是否在新候选池（被美学下限挡？）
    const oldInNewPool = pick ? pool.some((c) => c.photoId === pick.photo_id) : false;
    const oldHeroBlocked = !!pick && !oldInNewPool;

    // 新候选池里按旧乘法公式算 rank0（对比"旧公式会选谁"）
    const withOldFormula = [...pool]
      .map((c) => ({ c, w: (c.aestheticScore ?? 5) * ageMultOld(c.yearsAgo) }))
      .sort((a, b) => b.w - a.w);
    const oldFormulaRank0FromPool = withOldFormula[0]
      ? { photoId: withOldFormula[0].c.photoId, weightedScore: withOldFormula[0].w }
      : null;

    // 新 select（AI）选 hero
    let newSelectHero: DayResult["newSelectHero"] = null;
    const logs: string[] = [];
    if (pool.length >= 2) {
      const res = await runSelectStage(pool, { log: (m) => logs.push(m), enabled: true });
      newSelectHero = {
        photoId: res.ordered[0].photoId,
        reasoning: res.reasoning,
        source: res.source,
      };
    }

    if (newSelectHero) selectedIds.add(newSelectHero.photoId);
    const tag = (id: string | undefined) => (id ? id.slice(0, 8) : "—");
    console.log(
      `[${pickDate}] 候选池=${pool.length} 旧线上=${tag(pick?.photo_id)}(aes=${oldHeroAes ?? "—"}${oldHeroBlocked ? ",被挡" : ""}) 新select=${tag(newSelectHero?.photoId)}(${newSelectHero?.source}) ${logs.join("; ")}`,
    );

    results.push({
      pickDate,
      oldHeroDb: pick
        ? { photoId: pick.photo_id, title: pick.title, aestheticScore: oldHeroAes }
        : null,
      oldHeroBlocked,
      oldFormulaRank0FromPool,
      newSelectHero,
      candidates: pool.map((c) => ({
        photoId: c.photoId,
        aestheticScore: c.aestheticScore,
        takenAt: c.takenAt,
        yearsAgo: c.yearsAgo,
        source: c.source,
        weightedNew: (c.aestheticScore ?? 5) + ageBonusNew(c.yearsAgo),
      })),
    });
  }

  sqlite.close();
  await writeFile(OUT_HTML, renderHtml(results), "utf-8");
  console.log(`\n✅ HTML 已生成: ${OUT_HTML}`);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const thumb = (photoId: string): string => `${API_BASE}/api/photos/${photoId}/thumbnail`;

function heroCard(
  label: string,
  photoId: string | null,
  aes: number | null,
  takenAt: string | null,
  accent: string,
  badge?: string,
  title?: string,
): string {
  const yearsAgo = takenAt ? Math.max(0, 2026 - +takenAt.slice(0, 4)) : null;
  const dateStr = takenAt ? takenAt.slice(0, 10) : "—";
  return `
    <div class="hero" style="border-color:${accent}">
      <div class="hero-label" style="color:${accent}">${esc(label)}${badge ? ` <span class="badge">${esc(badge)}</span>` : ""}</div>
      ${photoId ? `<img class="hero-img" src="${thumb(photoId)}" loading="lazy" onerror="this.style.opacity=.2">` : `<div class="hero-img placeholder">${aes != null && aes < 7.0 ? `美学 ${aes} &lt; 7.0<br>被下限挡` : "未进新候选池<br>(重排/去重)"}</div>`}
      <div class="hero-title">${esc(title ?? "—")}</div>
      <div class="hero-meta">美学 ${aes ?? "—"} · ${esc(dateStr)}${yearsAgo ? ` · ${yearsAgo}年前` : ""}</div>
    </div>`;
}

function renderHtml(results: DayResult[]): string {
  const changedDays = results.filter(
    (r) => r.newSelectHero && r.oldHeroDb && r.newSelectHero.photoId !== r.oldHeroDb.photoId,
  ).length;
  const blockedDays = results.filter((r) => r.oldHeroBlocked).length;
  const totalSelect = results.filter((r) => r.newSelectHero).length;

  const cards = results
    .map((r) => {
      const findC = (id: string | null | undefined) =>
        r.candidates.find((c) => c.photoId === id) ?? null;
      const oldDb = r.oldHeroDb;
      const sel = r.newSelectHero;
      const selC = sel ? findC(sel.photoId) : null;
      const sameWithDb = oldDb && sel && sel.photoId === oldDb.photoId;

      const grid = r.candidates
        .map((c) => {
          const isOldDb = oldDb && c.photoId === oldDb.photoId;
          const isSel = sel && c.photoId === sel.photoId;
          const cls = ["cell"];
          if (isSel) cls.push("cell-new");
          return `<div class="${cls.join(" ")}" title="${esc(c.takenAt?.slice(0, 10) ?? "—")} | 美学${c.aestheticScore ?? "—"} | ${c.source} | 新加权${c.weightedNew.toFixed(2)}">
            <img src="${thumb(c.photoId)}" loading="lazy" onerror="this.style.opacity=.15">
          </div>`;
        })
        .join("");

      return `
      <section class="day ${sameWithDb ? "same" : "changed"}">
        <header class="day-head">
          <h2>${r.pickDate}</h2>
          <div class="day-tags">
            ${sameWithDb ? '<span class="tag tag-same">新旧一致</span>' : '<span class="tag tag-changed">新算法改变选择</span>'}
            ${r.oldHeroBlocked ? '<span class="tag tag-block">🚫 旧 hero 被新美学下限挡</span>' : ""}
            <span class="tag tag-count">新候选池 ${r.candidates.length}</span>
          </div>
        </header>
        <div class="compare">
          ${heroCard("旧线上 hero（旧算法）", oldDb && !r.oldHeroBlocked ? oldDb.photoId : null, oldDb?.aestheticScore ?? null, findC(oldDb?.photoId)?.takenAt ?? null, "var(--vermillion)", oldDb?.title, r.oldHeroBlocked ? "被下限挡" : undefined)}
          <div class="arrow">→</div>
          ${heroCard("新算法 hero（新候选池 + select AI）", sel?.photoId ?? null, selC?.aestheticScore ?? null, selC?.takenAt ?? null, "var(--sage)", sel?.source === "fallback" ? "fallback" : "AI")}
        </div>
        ${sel?.reasoning ? `<div class="reasoning"><span class="r-label">AI 评选理由（新 prompt：情感&gt;年代）：</span>${esc(sel.reasoning)}</div>` : '<div class="reasoning muted">（候选 &lt; 2，select 跳过）</div>'}
        <details class="candidates"><summary>新候选池（buildCandidatePool：美学≥7.0 + ageBonus 加法；绿框=新select选中的）</summary><div class="grid">${grid}</div></details>
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>每日精选 · 新旧算法对比 v2（新候选池 + 调 prompt）</title>
<style>
:root{
  --paper:oklch(0.975 0.010 95); --ink:oklch(0.155 0.006 95); --mist:oklch(0.935 0.002 95);
  --smoke:oklch(0.520 0.005 95); --sage:oklch(0.488 0.088 158); --vermillion:oklch(0.550 0.190 30);
  --amber:oklch(0.660 0.165 85);
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,"PingFang SC","Noto Serif SC",serif;line-height:1.6}
.wrap{max-width:1100px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:28px;margin:0 0 6px;letter-spacing:.5px}
.sub{color:var(--smoke);font-size:14px;margin-bottom:24px}
.summary{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:32px}
.stat{background:var(--mist);border-radius:12px;padding:16px 20px;min-width:160px}
.stat .n{font-size:28px;font-weight:600;color:var(--sage)}
.stat .l{font-size:12px;color:var(--smoke);margin-top:2px}
section.day{background:#fff;border:1px solid var(--mist);border-radius:16px;padding:24px;margin-bottom:20px}
section.day.changed{border-left:4px solid var(--sage)}
section.day.same{border-left:4px solid var(--mist)}
.day-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;flex-wrap:wrap;gap:8px}
.day-head h2{margin:0;font-size:20px}
.day-tags{display:flex;gap:6px;flex-wrap:wrap}
.tag{font-size:11px;padding:3px 10px;border-radius:999px;background:var(--mist);color:var(--smoke)}
.tag-changed{background:oklch(0.95 0.03 158);color:var(--sage)}
.tag-block{background:oklch(0.95 0.04 30);color:var(--vermillion)}
.tag-same{background:var(--mist);color:var(--smoke)}
.compare{display:grid;grid-template-columns:1fr 40px 1fr;gap:12px;align-items:start}
@media(max-width:640px){.compare{grid-template-columns:1fr}.arrow{transform:rotate(90deg)}}
.hero{border:2px solid;border-radius:12px;padding:12px;background:var(--paper)}
.hero-label{font-size:12px;font-weight:600;margin-bottom:8px}
.badge{background:var(--sage);color:#fff;padding:1px 7px;border-radius:6px;font-size:10px}
.hero-img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;background:var(--mist)}
.hero-img.placeholder{display:flex;align-items:center;justify-content:center;color:var(--vermillion);font-size:12px;text-align:center;font-weight:600}
.hero-title{font-size:15px;margin-top:8px;font-weight:500}
.hero-meta{font-size:12px;color:var(--smoke);margin-top:2px}
.arrow{display:flex;align-items:center;justify-content:center;font-size:24px;color:var(--smoke);height:100%;min-height:120px}
.reasoning{margin-top:14px;padding:12px 14px;background:oklch(0.97 0.01 158);border-radius:8px;font-size:13px}
.reasoning.muted{background:var(--mist);color:var(--smoke)}
.r-label{font-weight:600;color:var(--sage)}
.candidates{margin-top:14px}
.candidates summary{cursor:pointer;font-size:13px;color:var(--smoke)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:6px;margin-top:10px}
.cell{position:relative;border-radius:6px;overflow:hidden;border:2px solid transparent;aspect-ratio:1}
.cell img{width:100%;height:100%;object-fit:cover;display:block}
.cell-new{border-color:var(--sage);box-shadow:0 0 0 2px oklch(0.95 0.03 158)}
</style></head>
<body><div class="wrap">
<h1>每日精选 · 新旧算法对比 v2</h1>
<div class="sub">过去 7 天 · 新算法完整链路：buildCandidatePool（新 ageBonus 加法 + 美学下限 ≥7.0）→ select AI 评选（prompt 已调：情感&gt;年代）· 候选池用新算法重新构建（非 DB 既有 entries）· dry-run 不写库</div>
<div class="summary">
  <div class="stat"><div class="n">${changedDays}/${totalSelect}</div><div class="l">新算法改变选择的天数</div></div>
  <div class="stat"><div class="n">${blockedDays}</div><div class="l">旧 hero 被新美学下限挡</div></div>
  <div class="stat"><div class="n">${results.reduce((s, r) => s + r.candidates.length, 0)}</div><div class="l">新候选池总数</div></div>
</div>
${cards}
<div class="sub" style="margin-top:32px">说明：新候选池由 buildCandidatePool 重新构建（美学≥7.0 已生效）。红框=旧线上 hero（若显示「已被挡」= 该照美学&lt;7.0 未进新候选池），绿框=新 select 选中的。缩略图加载自本地 API（localhost:3000）。</div>
</div></body></html>`;
}

main().catch((err) => {
  console.error("dry-run 失败:", err);
  process.exit(1);
});

/**
 * 拿用户的 verdict JSON，分析 准/不准 的 detection_score + cosine(face, person_centroid) 分布。
 * 帮助判断：调高阈值能否过滤误聚，还是模型本身的边界问题。
 *
 * Usage: node scripts/face-verdict-analyze.mjs <verdict.json>
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const inPath = process.argv[2];
if (!inPath) {
  console.error("Usage: node face-verdict-analyze.mjs <verdict.json>");
  process.exit(1);
}
const { personId, total, verdicts } = JSON.parse(readFileSync(inPath, "utf8"));
const db = new Database(process.env.DATABASE_PATH ?? "./data/relight.db", { readonly: true });

const person = db.prepare(`SELECT * FROM persons WHERE id = ?`).get(personId);
if (!person) {
  console.error(`person ${personId} not found`);
  process.exit(1);
}
const centroid = decodeEmbedding(person.centroid_embedding);

const faces = db
  .prepare(`SELECT id, photo_id, embedding, detection_score, bbox_w, bbox_h FROM faces WHERE person_id = ? ORDER BY detection_score DESC`)
  .all(personId);

function decodeEmbedding(b64) {
  const buf = Buffer.from(b64, "base64");
  const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return new Float32Array(arr); // copy
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const rows = faces.map((f) => {
  const v = verdicts[f.id] ?? "unmarked";
  const emb = decodeEmbedding(f.embedding);
  const sim = cosine(emb, centroid);
  return { id: f.id.slice(0, 8), v, score: f.detection_score, sim, size: Math.round((f.bbox_w + f.bbox_h) / 2) };
});

function stat(name, arr) {
  if (arr.length === 0) return;
  const sims = arr.map((r) => r.sim).sort((a, b) => a - b);
  const scores = arr.map((r) => r.score).sort((a, b) => a - b);
  const sizes = arr.map((r) => r.size).sort((a, b) => a - b);
  const q = (a, p) => a[Math.floor(a.length * p)];
  console.log(`\n=== ${name} (n=${arr.length}) ===`);
  console.log(`cosine sim: min=${sims[0].toFixed(3)} p25=${q(sims, 0.25).toFixed(3)} median=${q(sims, 0.5).toFixed(3)} p75=${q(sims, 0.75).toFixed(3)} max=${sims[sims.length - 1].toFixed(3)}`);
  console.log(`det score:  min=${scores[0].toFixed(3)} median=${q(scores, 0.5).toFixed(3)} max=${scores[scores.length - 1].toFixed(3)}`);
  console.log(`bbox size:  min=${sizes[0]} median=${q(sizes, 0.5)} max=${sizes[sizes.length - 1]}`);
}

const right = rows.filter((r) => r.v === "right");
const wrong = rows.filter((r) => r.v === "wrong");
const unmarked = rows.filter((r) => r.v === "unmarked");

console.log(`person ${personId.slice(0, 8)} (${person.name}/${person.nickname}) — 总 face ${total}, member_count=${person.member_count}`);
console.log(`标记: right=${right.length} wrong=${wrong.length} unmarked=${unmarked.length}`);

stat("准 (right)", right);
stat("不准 (wrong)", wrong);
if (unmarked.length > 0) stat("未标 (unmarked)", unmarked);

console.log("\n=== 不准的逐条 (按 sim 降序) ===");
[...wrong, ...unmarked]
  .sort((a, b) => b.sim - a.sim)
  .forEach((r) => {
    console.log(`  ${r.id} sim=${r.sim.toFixed(3)} score=${r.score.toFixed(2)} size=${r.size}px verdict=${r.v}`);
  });

console.log("\n=== 准的低 sim 边缘 (前 5 最低) ===");
[...right]
  .sort((a, b) => a.sim - b.sim)
  .slice(0, 5)
  .forEach((r) => {
    console.log(`  ${r.id} sim=${r.sim.toFixed(3)} score=${r.score.toFixed(2)} size=${r.size}px`);
  });

// 算"如果阈值升到 X，能过滤掉多少 wrong/同时损失多少 right"
console.log("\n=== 阈值假设分析 ===");
for (const t of [0.55, 0.6, 0.65, 0.7]) {
  const filteredWrong = wrong.filter((r) => r.sim < t).length;
  const lostRight = right.filter((r) => r.sim < t).length;
  console.log(`  threshold=${t}: 过滤 wrong ${filteredWrong}/${wrong.length}, 误伤 right ${lostRight}/${right.length}`);
}

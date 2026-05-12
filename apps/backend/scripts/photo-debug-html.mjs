/**
 * 生成 photo 调试页面：原图大图 + 所有 face bbox 框 + 序号标签 + 每个 face 当前归属信息。
 *
 * Usage: node scripts/photo-debug-html.mjs <photo_id> [out.html]
 */
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";

const photoId = process.argv[2];
if (!photoId) {
  console.error("Usage: node photo-debug-html.mjs <photo_id> [out.html]");
  process.exit(1);
}
const outPath = process.argv[3] ?? `./photos/.debug/photo-${photoId.slice(0, 8)}.html`;
const dbPath = process.env.DATABASE_PATH ?? "./data/relight.db";
const apiBase = process.env.API_BASE ?? "http://localhost:3000";

const db = new Database(dbPath, { readonly: true });
const photo = db.prepare(`SELECT * FROM photos WHERE id = ?`).get(photoId);
if (!photo) {
  console.error(`photo ${photoId} not found`);
  process.exit(1);
}

const faces = db
  .prepare(`SELECT id, person_id, bbox_x, bbox_y, bbox_w, bbox_h, detection_score, embedding, attributes FROM faces WHERE photo_id = ? ORDER BY bbox_x ASC, bbox_y ASC`)
  .all(photoId);

// 属性 emoji 映射（与 face-debug-html.mjs 保持一致）
function renderAttrBadge(attr) {
  if (!attr) return "";
  const ageBandEmoji = {
    infant: "👶", child: "🧒", teen: "🧑", young_adult: "🙂",
    middle_aged: "👨", senior: "👴", unknown: "❓",
  };
  const genderEmoji = { male: "♂️", female: "♀️", unknown: "" };
  const glassesEmoji = { none: "", normal: "👓", sunglasses: "🕶️", unknown: "" };
  const facialHairEmoji = { none: "", stubble: "🧔", beard: "🧔", moustache: "🧔", unknown: "" };
  const expressionEmoji = {
    neutral: "😐", smile: "🙂", laugh: "😄", sad: "😢", surprised: "😲", unknown: "",
  };
  const ageBandLabel = {
    infant: "婴儿", child: "儿童", teen: "青少年", young_adult: "青年",
    middle_aged: "中年", senior: "老年", unknown: "?",
  };

  const parts = [];
  parts.push(`${ageBandEmoji[attr.age_band] ?? "❓"}${ageBandLabel[attr.age_band] ?? attr.age_band}`);
  if (attr.gender && attr.gender !== "unknown") parts.push(genderEmoji[attr.gender] ?? "");
  if (attr.glasses && attr.glasses !== "none" && attr.glasses !== "unknown") parts.push(glassesEmoji[attr.glasses] ?? "");
  if (attr.facial_hair && attr.facial_hair !== "none" && attr.facial_hair !== "unknown") parts.push(facialHairEmoji[attr.facial_hair] ?? "");
  if (attr.expression && attr.expression !== "unknown") parts.push(expressionEmoji[attr.expression] ?? "");
  return parts.filter(Boolean).join(" ");
}

function decodeEmbedding(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

// 拉所有 person centroid，算每个 face 对 top-3 person 的 sim
const persons = db
  .prepare(`SELECT id, name, nickname, member_count, centroid_embedding FROM persons WHERE storage_source_id = ?`)
  .all(photo.storage_source_id);

const facesEnriched = faces.map((f, i) => {
  const emb = decodeEmbedding(f.embedding);
  const sims = persons.map((p) => ({
    id: p.id,
    name: p.name ?? p.nickname ?? `#${p.id.slice(0, 4)}`,
    mc: p.member_count,
    sim: cosine(emb, decodeEmbedding(p.centroid_embedding)),
  }));
  sims.sort((a, b) => b.sim - a.sim);
  let parsedAttr = null;
  if (f.attributes) {
    try { parsedAttr = JSON.parse(f.attributes); } catch { parsedAttr = null; }
  }
  return { ...f, idx: i + 1, top: sims.slice(0, 3), parsedAttr };
});

// ⚠️ photos.width/height 是 EXIF 标记的「拍摄方向」，sharp 实际读图后的像素方向
// 可能因为 EXIF orientation 旋转而不同（iPhone 横拍 EXIF 竖向常见）。
// detector 写的 bbox 是基于 sharp 读出的真实像素方向，所以 HTML 必须用同一基准。
let w = photo.width;
let h = photo.height;
try {
  const isHeic = /\.(heic|heif)$/i.test(photo.file_path);
  if (isHeic) {
    const buf = await readFile(photo.file_path);
    const { default: decodeHeic } = await import("heic-decode");
    const decoded = await decodeHeic({ buffer: buf });
    w = decoded.width;
    h = decoded.height;
  } else {
    const buf = await readFile(photo.file_path);
    const meta = await sharp(buf).metadata();
    w = meta.width ?? w;
    h = meta.height ?? h;
  }
} catch (err) {
  console.warn(`[warn] sharp/heic metadata 失败，回退到 photos.width/height: ${err.message}`);
}
console.log(`原图像素方向: ${w}×${h} (photos.width/height=${photo.width}×${photo.height})`);

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>photo ${photoId.slice(0, 8)} — ${faces.length} faces</title>
<style>
  body { font-family: -apple-system, sans-serif; margin: 0; padding: 0; background: #1a1a1a; color: #f0f0f0; }
  .layout { display: grid; grid-template-columns: 1fr 360px; gap: 0; height: 100vh; }
  .image-wrap { position: relative; overflow: auto; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .image-wrap > .inner { position: relative; max-width: 100%; max-height: 100%; }
  .image-wrap img { display: block; max-width: 100%; max-height: 90vh; width: auto; height: auto; }
  .bbox { position: absolute; border: 3px solid #ef4444; box-shadow: 0 0 0 2px rgba(0,0,0,0.6); pointer-events: none; }
  .bbox .label { position: absolute; left: -3px; top: -28px; background: #ef4444; color: #fff; font-size: 16px; font-weight: 700; padding: 2px 8px; border-radius: 4px; min-width: 24px; text-align: center; }
  aside { background: #2a2a2a; padding: 16px; overflow-y: auto; font-size: 12px; }
  aside h1 { font-size: 14px; margin: 0 0 12px; }
  aside .photo-meta { color: #aaa; font-family: 'SF Mono', monospace; margin-bottom: 16px; font-size: 11px; }
  .face-card { background: #1a1a1a; padding: 10px; border-radius: 6px; margin-bottom: 10px; border-left: 3px solid #ef4444; }
  .face-card h2 { margin: 0 0 6px; font-size: 13px; display: flex; gap: 6px; align-items: center; }
  .face-card h2 .num { background: #ef4444; color: #fff; width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; }
  .face-card .meta { color: #888; font-family: 'SF Mono', monospace; font-size: 10px; margin-bottom: 6px; }
  .face-card .top { margin-top: 6px; }
  .face-card .top div { padding: 3px 0; border-top: 1px solid #333; }
  .face-card .top div.current { background: #1f3a1f; padding-left: 4px; }
  .face-card .top .name { font-weight: 600; color: #f0f0f0; }
  .face-card .top .sim { color: #4ade80; font-family: monospace; }
  .face-card .attr-bar { font-size: 12px; margin-bottom: 4px; color: #ccc; }
</style>
</head>
<body>
<div class="layout">
  <div class="image-wrap">
    <div class="inner">
      <img src="${apiBase}/api/photos/${photoId}/thumbnail" alt="${photoId}" id="bgimg" />
      ${facesEnriched
        .map((f) => {
          const left = (f.bbox_x / w) * 100;
          const top = (f.bbox_y / h) * 100;
          const bw = (f.bbox_w / w) * 100;
          const bh = (f.bbox_h / h) * 100;
          return `<div class="bbox" style="left:${left}%;top:${top}%;width:${bw}%;height:${bh}%"><span class="label">${f.idx}</span></div>`;
        })
        .join("")}
    </div>
  </div>
  <aside>
    <h1>photo ${photoId.slice(0, 8)} — ${faces.length} faces</h1>
    <div class="photo-meta">${photo.file_path.split("/").slice(-2).join("/")}<br>${w} × ${h} px</div>
    ${facesEnriched
      .map((f) => `<div class="face-card">
      <h2><span class="num">${f.idx}</span> face ${f.id.slice(0, 8)}</h2>
      <div class="attr-bar">${renderAttrBadge(f.parsedAttr) || '<span style="color:#555">无属性</span>'}</div>
      <div class="meta">score=${f.detection_score.toFixed(2)} bbox=${Math.round(f.bbox_w)}×${Math.round(f.bbox_h)}px</div>
      <div class="meta">归属: ${f.person_id ? `<span style="color:#4ade80">${f.person_id.slice(0, 8)}</span>` : '<span style="color:#888">unassigned</span>'}</div>
      <div class="top">
        <strong style="font-size:11px;color:#888">top-3 相似 person:</strong>
        ${f.top.map((p) => `<div class="${p.id === f.person_id ? "current" : ""}"><span class="name">${p.name}</span> <span class="sim">${p.sim.toFixed(3)}</span> <span style="color:#666">(${p.mc} 张)</span></div>`).join("")}
      </div>
    </div>`)
      .join("")}
  </aside>
</div>
</body>
</html>`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, "utf8");
console.log(`生成: ${outPath}`);
console.log(`photo: ${photo.file_path}`);
console.log(`总 face: ${faces.length}`);
console.log(`浏览器打开: file://${join(process.cwd(), outPath)}`);

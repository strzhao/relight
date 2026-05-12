import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
/**
 * 生成 person 调试页面：列出该 person 所有 face 缩略图 + bbox 红框 + 准/不准按钮。
 *
 * Usage: node scripts/face-debug-html.mjs <person_id> [out.html]
 * Default out: ./photos/.debug/person-<id8>.html
 */
import Database from "better-sqlite3";
import sharp from "sharp";

const personId = process.argv[2];
if (!personId) {
  console.error("Usage: node face-debug-html.mjs <person_id> [out.html]");
  process.exit(1);
}

const outPath = process.argv[3] ?? `./photos/.debug/person-${personId.slice(0, 8)}.html`;
const dbPath = process.env.DATABASE_PATH ?? "./data/relight.db";
const apiBase = process.env.API_BASE ?? "http://localhost:3000";

const db = new Database(dbPath, { readonly: true });
const person = db.prepare("SELECT * FROM persons WHERE id = ?").get(personId);
if (!person) {
  console.error(`person ${personId} not found`);
  process.exit(1);
}
const avatarUrl = `${apiBase}/api/persons/${personId}/avatar.jpg`;

const faces = db
  .prepare(`
  SELECT f.id, f.photo_id, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h, f.detection_score,
         f.attributes,
         p.width, p.height, p.file_path
  FROM faces f
  JOIN photos p ON p.id = f.photo_id
  WHERE f.person_id = ?
  ORDER BY f.detection_score DESC
`)
  .all(personId);

// ⚠️ photos.width/height 是 EXIF 标记方向，detect-faces 现在 .rotate() 应用 EXIF 后才检测，
// 所以 bbox 基于 sharp rotate 后的真实像素方向。debug HTML 必须用同一基准否则红框偏。
// 去重批量读真实尺寸，每张 photo 只读一次。
const uniquePhotos = new Map();
for (const f of faces) uniquePhotos.set(f.photo_id, f.file_path);
const realDims = new Map();
for (const [pid, fp] of uniquePhotos.entries()) {
  try {
    const isHeic = /\.(heic|heif)$/i.test(fp);
    if (isHeic) {
      const buf = await readFile(fp);
      const { default: decodeHeic } = await import("heic-decode");
      const d = await decodeHeic({ buffer: buf });
      realDims.set(pid, { w: d.width, h: d.height });
    } else {
      const buf = await readFile(fp);
      const rotated = await sharp(buf, { failOn: "none" }).rotate().toBuffer();
      const m = await sharp(rotated).metadata();
      realDims.set(pid, { w: m.width, h: m.height });
    }
  } catch {
    // fallback：用 DB 值
    const f = faces.find((x) => x.photo_id === pid);
    realDims.set(pid, { w: f.width, h: f.height });
  }
}

// 属性 emoji 映射表
function renderAttrBadge(attr) {
  if (!attr) return "";
  const ageBandEmoji = {
    infant: "👶",
    child: "🧒",
    teen: "🧑",
    young_adult: "🙂",
    middle_aged: "👨",
    senior: "👴",
    unknown: "❓",
  };
  const genderEmoji = { male: "♂️", female: "♀️", unknown: "❓" };
  const glassesEmoji = { none: "", normal: "👓", sunglasses: "🕶️", unknown: "❓" };
  const facialHairEmoji = { none: "", stubble: "🧔", beard: "🧔", moustache: "🧔", unknown: "" };
  const expressionEmoji = {
    neutral: "😐",
    smile: "🙂",
    laugh: "😄",
    sad: "😢",
    surprised: "😲",
    unknown: "❓",
  };
  const ageBandLabel = {
    infant: "婴儿",
    child: "儿童",
    teen: "青少年",
    young_adult: "青年",
    middle_aged: "中年",
    senior: "老年",
    unknown: "?年龄",
  };

  const parts = [];
  parts.push(
    `${ageBandEmoji[attr.age_band] ?? "❓"}${ageBandLabel[attr.age_band] ?? attr.age_band}`,
  );
  if (attr.gender !== "unknown") parts.push(genderEmoji[attr.gender] ?? "");
  if (attr.glasses !== "none" && attr.glasses !== "unknown")
    parts.push(glassesEmoji[attr.glasses] ?? "");
  if (attr.facial_hair !== "none" && attr.facial_hair !== "unknown")
    parts.push(facialHairEmoji[attr.facial_hair] ?? "");
  if (attr.expression !== "unknown") parts.push(expressionEmoji[attr.expression] ?? "");
  return parts.filter(Boolean).join(" ");
}

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>调试 person ${personId.slice(0, 8)} — ${faces.length} faces</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 0; background: #f4f3ef; color: #1a1a1a; }
  header { position: sticky; top: 0; z-index: 10; background: #fff; padding: 12px 16px; border-bottom: 1px solid #ddd; display: flex; gap: 16px; align-items: center; }
  header .ref-avatar { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; border: 2px solid #ef4444; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #ef4444; }
  header .ref-label { display: flex; flex-direction: column; gap: 2px; }
  header .ref-label .tag { font-size: 10px; color: #ef4444; font-weight: 600; letter-spacing: 0.5px; }
  header h1 { margin: 0; font-size: 14px; font-weight: 600; }
  header .stat { font-size: 12px; color: #666; }
  header button { padding: 6px 12px; border: 1px solid #ccc; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; }
  header button:hover { background: #f0f0f0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; padding: 16px; }
  .card { background: #fff; border-radius: 6px; overflow: hidden; border: 2px solid transparent; transition: border 0.15s; }
  .card.right { border-color: #4ade80; }
  .card.wrong { border-color: #f87171; }
  .thumb-wrap { position: relative; background: #eee; }
  .thumb-wrap img { width: 100%; height: auto; display: block; }
  .bbox { position: absolute; border: 2px solid #ef4444; box-shadow: 0 0 0 1px rgba(0,0,0,0.4); pointer-events: none; }
  .meta { padding: 6px 8px; font-size: 10px; color: #555; font-family: 'SF Mono', Menlo, monospace; }
  .meta .row { display: flex; justify-content: space-between; }
  .actions { display: flex; gap: 4px; padding: 6px 8px; }
  .actions button { flex: 1; padding: 6px; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-size: 12px; background: #fff; }
  .actions button.right-btn:hover { background: #4ade80; color: #fff; }
  .actions button.wrong-btn:hover { background: #f87171; color: #fff; }
  .card.right .right-btn { background: #4ade80; color: #fff; }
  .card.wrong .wrong-btn { background: #f87171; color: #fff; }
  .filter { display: flex; gap: 6px; margin-left: auto; }
  .filter button { padding: 4px 10px; font-size: 12px; }
  .filter button.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .attr-bar { padding: 3px 8px 0; font-size: 11px; color: #444; min-height: 16px; }
</style>
</head>
<body>
<header>
  <img class="ref-avatar" src="${avatarUrl}" alt="代表头像" />
  <div class="ref-label">
    <span class="tag">代表头像</span>
    <h1>person ${personId.slice(0, 8)} — ${faces.length} faces</h1>
  </div>
  <span class="stat" id="stat">未标记 ${faces.length} / 准 0 / 不准 0</span>
  <div class="filter">
    <button data-filter="all" class="active">全部</button>
    <button data-filter="none">未标</button>
    <button data-filter="right">准</button>
    <button data-filter="wrong">不准</button>
  </div>
  <button onclick="exportJson()">导出 JSON</button>
  <button onclick="resetAll()">清空标记</button>
</header>
<div class="grid" id="grid">
${faces
  .map((f) => {
    const dim = realDims.get(f.photo_id) ?? { w: f.width || 1, h: f.height || 1 };
    const w = dim.w || 1;
    const h = dim.h || 1;
    const left = ((f.bbox_x / w) * 100).toFixed(1);
    const top = ((f.bbox_y / h) * 100).toFixed(1);
    const bw = ((f.bbox_w / w) * 100).toFixed(1);
    const bh = ((f.bbox_h / h) * 100).toFixed(1);
    const thumbUrl = `${apiBase}/api/photos/${f.photo_id}/thumbnail`;
    let parsedAttr = null;
    if (f.attributes) {
      try {
        parsedAttr = JSON.parse(f.attributes);
      } catch {
        parsedAttr = null;
      }
    }
    const attrBadge = renderAttrBadge(parsedAttr);
    return `<div class="card" data-fid="${f.id}">
    <div class="thumb-wrap">
      <img loading="lazy" src="${thumbUrl}" alt="${f.photo_id.slice(0, 8)}" />
      <div class="bbox" style="left:${left}%;top:${top}%;width:${bw}%;height:${bh}%"></div>
    </div>
    <div class="attr-bar">${attrBadge || '<span style="color:#bbb">无属性</span>'}</div>
    <div class="meta">
      <div class="row"><span>${f.id.slice(0, 8)}</span><span>${f.detection_score.toFixed(2)}</span></div>
      <div class="row"><span>${f.photo_id.slice(0, 8)}</span></div>
    </div>
    <div class="actions">
      <button class="right-btn" onclick="mark('${f.id}', 'right')">✓ 准</button>
      <button class="wrong-btn" onclick="mark('${f.id}', 'wrong')">✗ 不准</button>
    </div>
  </div>`;
  })
  .join("\n")}
</div>
<script>
const KEY = 'face-verdict:${personId}';
const verdicts = JSON.parse(localStorage.getItem(KEY) || '{}');
function applyVerdict(fid) {
  const card = document.querySelector(\`.card[data-fid="\${fid}"]\`);
  if (!card) return;
  card.classList.remove('right', 'wrong');
  if (verdicts[fid]) card.classList.add(verdicts[fid]);
}
function mark(fid, v) {
  if (verdicts[fid] === v) {
    delete verdicts[fid];
  } else {
    verdicts[fid] = v;
  }
  localStorage.setItem(KEY, JSON.stringify(verdicts));
  applyVerdict(fid);
  updateStat();
  applyFilter();
}
function updateStat() {
  const total = ${faces.length};
  let r = 0, w = 0;
  for (const v of Object.values(verdicts)) {
    if (v === 'right') r++;
    else if (v === 'wrong') w++;
  }
  document.getElementById('stat').textContent = \`未标记 \${total - r - w} / 准 \${r} / 不准 \${w}\`;
}
function exportJson() {
  const out = { personId: '${personId}', total: ${faces.length}, verdicts };
  const txt = JSON.stringify(out, null, 2);
  navigator.clipboard.writeText(txt).then(() => alert('已复制到剪贴板'));
  console.log(txt);
}
function resetAll() {
  if (!confirm('清空所有标记？')) return;
  for (const k of Object.keys(verdicts)) delete verdicts[k];
  localStorage.setItem(KEY, '{}');
  document.querySelectorAll('.card').forEach(c => c.classList.remove('right', 'wrong'));
  updateStat();
  applyFilter();
}
let currentFilter = 'all';
function applyFilter() {
  document.querySelectorAll('.card').forEach(c => {
    const fid = c.dataset.fid;
    const v = verdicts[fid];
    const show =
      currentFilter === 'all' ||
      (currentFilter === 'none' && !v) ||
      (currentFilter === 'right' && v === 'right') ||
      (currentFilter === 'wrong' && v === 'wrong');
    c.style.display = show ? '' : 'none';
  });
}
document.querySelectorAll('.filter button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.filter button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    currentFilter = b.dataset.filter;
    applyFilter();
  });
});
// 初始化
document.querySelectorAll('.card').forEach(c => applyVerdict(c.dataset.fid));
updateStat();
</script>
</body>
</html>`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, "utf8");
console.log(`生成: ${outPath}`);
console.log(`总 face: ${faces.length}`);
console.log(`浏览器打开: file://${join(process.cwd(), outPath)}`);

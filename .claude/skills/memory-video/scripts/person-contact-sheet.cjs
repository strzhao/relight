#!/usr/bin/env node
/**
 * 人物簇核验素材包 —— 一条命令把「判断这一簇该不该出片」所需的东西全部摊到眼前。
 *
 * 用法：
 *   node scripts/person-contact-sheet.cjs <personId> [--out <dir>] [--per-year 4] [--list]
 *
 * 产出（写进 --out，默认 <repo>/.autopilot/runtime/requirements/20260725-每日视频生成/verify/<id8>）：
 *   contact.jpg   整图网格，按年分层抽样，带 #序号 + 日期 → 看「是不是同一个人」「有没有跨年弧线」
 *   faces.jpg     人脸特写网格（bbox 裁剪）→ 脸对脸细看
 *   vs-named.jpg  本簇代表照 vs 每个命名人物代表照，按相似度排序 → 看「是不是谁的拆分簇」
 *   stdout        数据摘要
 *
 * 设计立场（AI First）：脚本只负责「把素材摊开 + 给出注意力索引」，**不做任何裁决**。
 * 它不打印「混合簇」「非单一身份」这类结论——那是看图之后的事，属于模型的判断。
 *
 * 两个必须照抄的实现细节（此前 26 个一次性脚本反复踩的坑）：
 *   1. bbox 是 EXIF 旋转后的坐标系（detect-faces.ts 先 rotate() 再检测），
 *      所以裁剪也必须 sips → sharp.rotate() → 按旋转后尺寸映射，否则人脸框整体错位。
 *   2. faces.embedding / persons.centroid_embedding 是 base64（512 维 float32），
 *      直接当裸 float32 解析会全成噪声。
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const BACKEND = process.env.RELIGHT_BACKEND ?? path.join(REPO_ROOT, "apps/backend");
const DB_PATH = process.env.RELIGHT_DB ?? path.join(BACKEND, "data/relight.db");
const STORAGE_ROOT = process.env.STORAGE_ROOT ?? path.join(BACKEND, "photos");
const DEFAULT_OUT = path.join(
  REPO_ROOT,
  ".autopilot/runtime/requirements/20260725-每日视频生成/verify",
);

const Database = require(path.join(BACKEND, "node_modules/better-sqlite3"));
const sharp = require(path.join(BACKEND, "node_modules/sharp"));

// ---------------------------------------------------------------- 参数解析

const argv = process.argv.slice(2);
const personId = argv.find((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OUT_DIR = path.resolve(flag("out", path.join(DEFAULT_OUT, (personId ?? "unknown").slice(0, 8))));
const PER_YEAR = Number.parseInt(flag("per-year", "4"), 10);
const LIST_ONLY = argv.includes("--list");

if (!personId) {
  console.error("用法: node scripts/person-contact-sheet.cjs <personId> [--out <dir>] [--per-year 4] [--list]");
  process.exit(2);
}

// ---------------------------------------------------------------- 数据读取

const db = new Database(DB_PATH, { readonly: true });

function toVec(buf) {
  if (!buf) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const raw = Buffer.from(b.toString("utf8"), "base64");
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}
function cos(a, b) {
  let na = 0, nb = 0, dot = 0;
  for (let i = 0; i < a.length; i++) { na += a[i] * a[i]; nb += b[i] * b[i]; dot += a[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const person = db
  .prepare("SELECT id, name, nickname, member_count m, centroid_embedding e FROM persons WHERE id = ?")
  .get(personId);
if (!person) {
  console.error(`找不到 person: ${personId}`);
  process.exit(3);
}
const centroid = toVec(person.e);

const faces = db
  .prepare(
    `SELECT f.id fid, f.photo_id p, f.embedding e, f.bbox_x bx, f.bbox_y by, f.bbox_w bw, f.bbox_h bh,
            ph.taken_at t, ph.file_path fp, ph.thumbnail_path tp, ph.width w, ph.height h,
            pa.aesthetic_score aes
     FROM faces f
     LEFT JOIN photos ph ON ph.id = f.photo_id
     LEFT JOIN photo_analyses pa ON pa.photo_id = f.photo_id
     WHERE f.person_id = ?`,
  )
  .all(personId);

if (faces.length === 0) {
  console.error(`person ${personId} 没有任何 face 记录`);
  process.exit(3);
}

// 每张照片只留一张脸（同照片多脸属同一 person 时取 cos 最高的）
const byPhoto = new Map();
for (const f of faces) {
  const v = toVec(f.e);
  const c = v && centroid ? cos(v, centroid) : 0;
  const prev = byPhoto.get(f.p);
  if (!prev || c > prev.cos) byPhoto.set(f.p, { ...f, cos: c });
}
const photos = [...byPhoto.values()].filter((r) => r.t).sort((a, b) => a.t.localeCompare(b.t));
if (photos.length === 0) {
  console.error(`person ${personId} 的照片都缺 taken_at，无法按时间摊开`);
  process.exit(3);
}

// ---------------------------------------------------------------- 按年分层抽样
// 逐年抽样而不是全量：一个 1300 张的簇摊出来也没人看，而成长线的关键是**每个年代都看到脸**。
//
// 年内怎么取很讲究：只按美学取会系统性漏掉混进来的「别人」——不属于这个人的脸
// 恰恰是簇内 cos 最低的那几张（判别分低所以画面往往也不好看）。所以每年取两拨：
// 美学高的（看清楚本人长什么样）+ cos 最低的（看有没有混进别人）。

const byYear = new Map();
for (const r of photos) {
  const y = r.t.slice(0, 4);
  if (!byYear.has(y)) byYear.set(y, []);
  byYear.get(y).push(r);
}
const sample = [];
for (const [, arr] of [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const byAes = [...arr].sort((a, b) => (b.aes ?? 0) - (a.aes ?? 0));
  const byCos = [...arr].sort((a, b) => a.cos - b.cos);
  const picked = new Map();
  // cos 最低的 1/3 先占位（最可能有外来脸），其余名额给美学高的
  const nCos = Math.max(1, Math.floor(PER_YEAR / 3));
  for (const r of byCos.slice(0, nCos)) picked.set(r.p, r);
  for (const r of byAes) {
    if (picked.size >= Math.max(PER_YEAR, nCos)) break;
    picked.set(r.p, r);
  }
  // 年内回到时间序，读起来才是一条弧线
  sample.push(...[...picked.values()].sort((a, b) => a.t.localeCompare(b.t)));
}

// ---------------------------------------------------------------- 原图解码
// 优先用 800px 缩略图（已是 JPEG，快且稳）；缺了才回落到原图 sips 转码。

const tmpDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "mvs-"));
let tmpSeq = 0;

// thumbnail_path 形如 "photos/thumbnails/<uuid>.jpg"，基准是后端进程 cwd（apps/backend），
// 不是 STORAGE_ROOT —— 拼错会静默全落空、回落到 sips 慢路径。逐个候选试，找不到才算缺。
function resolveThumb(tp) {
  if (!tp) return null;
  for (const c of [path.join(BACKEND, tp), path.join(STORAGE_ROOT, tp), path.join(STORAGE_ROOT, path.basename(tp))]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function decodeToJpeg(row, maxEdge) {
  const thumbAbs = resolveThumb(row.tp);
  if (thumbAbs) {
    try {
      return { buf: fs.readFileSync(thumbAbs), from: thumbAbs };
    } catch {
      /* 读不出来就继续试原图 */
    }
  }
  if (row.fp && fs.existsSync(row.fp)) {
    const out = path.join(tmpDir, `o${tmpSeq++}.jpg`);
    try {
      execFileSync("sips", ["-s", "format", "jpeg", "-Z", String(maxEdge), row.fp, "--out", out], {
        stdio: "pipe",
      });
      return { buf: fs.readFileSync(out), from: row.fp };
    } catch {
      return null; // 单张解不出来不该毁掉整张核验表
    }
  }
  return null;
}

const missingOriginals = photos.filter((r) => !(r.fp && fs.existsSync(r.fp))).length;

// ---------------------------------------------------------------- 网格工具

// 所有进 SVG 的文本都必须过这一道：库里真实存在带控制字符的脏数据
// （persons.fff1a89c 的 name 是 "\u0010赵狄苏"，终端里显示成 "^P"），
// 而 librsvg 遇到 XML 非法字符会直接抛「Input buffer has corrupt header」——
// 报错信息完全指不到真正的元凶，能查很久。
function xmlSafe(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const LABEL_BG = (text, w) =>
  Buffer.from(
    `<svg width="${w}" height="30"><rect width="100%" height="100%" fill="black" opacity="0.72"/>` +
      `<text x="6" y="21" font-size="17" fill="#ffe066" font-family="Helvetica">${xmlSafe(text)}</text></svg>`,
  );

async function grid(cells, cols, cw, ch, outPath) {
  if (cells.length === 0) return false;
  const rows = Math.ceil(cells.length / cols);
  await sharp({
    create: { width: cols * cw, height: rows * ch, channels: 3, background: "#1a1a1a" },
  })
    .composite(cells.map((c, i) => ({ input: c, left: (i % cols) * cw, top: Math.floor(i / cols) * ch })))
    .jpeg({ quality: 88 })
    .toFile(outPath);
  return true;
}

// ---------------------------------------------------------------- contact.jpg

async function buildContactSheet() {
  const CW = 560, CH = 420;
  const cells = [];
  for (let i = 0; i < sample.length; i++) {
    const r = sample[i];
    const dec = decodeToJpeg(r, 1400);
    if (!dec) {
      cells.push(
        await sharp({ create: { width: CW, height: CH, channels: 3, background: "#7a2020" } })
          .composite([{ input: LABEL_BG(`#${i + 1} 原图缺失 ${r.p.slice(0, 6)}`, CW), top: 0, left: 0 }])
          .jpeg().toBuffer(),
      );
      continue;
    }
    const img = await sharp(dec.buf, { failOn: "none" })
      .rotate()
      .resize(CW, CH, { fit: "cover" })
      .toBuffer();
    cells.push(
      await sharp(img)
        .composite([
          {
            // cos 写进标签：低分的那几张正是「外来脸可能藏身之处」，提醒细看
            input: LABEL_BG(`#${i + 1} ${r.t.slice(0, 10)} cos=${r.cos.toFixed(2)}`, CW),
            top: 0,
            left: 0,
          },
        ])
        .toBuffer(),
    );
  }
  const ok = await grid(cells, 3, CW, CH, path.join(OUT_DIR, "contact.jpg"));
  return ok ? cells.length : 0;
}

// ---------------------------------------------------------------- faces.jpg
// bbox 裁剪的正确配方：先 sips→jpeg，再 sharp.rotate()，用**旋转后**的尺寸映射 bbox。

async function buildFacesSheet() {
  const CW = 260, CH = 260;
  const cells = [];
  for (let i = 0; i < sample.length; i++) {
    const r = sample[i];
    const dec = decodeToJpeg(r, 2000);
    if (!dec) continue;
    try {
      const rotated = await sharp(dec.buf, { failOn: "none" }).rotate().toBuffer();
      const meta = await sharp(rotated).metadata();
      if (!meta.width || !meta.height || !r.bw || !r.bh) continue;
      // 缩略图是等比缩放过的，bbox 在原图坐标系 —— 按当前图/原图的比例映射
      const sx = r.w ? meta.width / r.w : 1;
      const sy = r.h ? meta.height / r.h : 1;
      const pad = 0.35; // 留出下巴与发型，纯 bbox 会把脸切得太紧
      const left = Math.max(0, Math.round((r.bx - r.bw * pad) * sx));
      const top = Math.max(0, Math.round((r.by - r.bh * pad) * sy));
      const width = Math.min(meta.width - left, Math.round(r.bw * (1 + 2 * pad) * sx));
      const height = Math.min(meta.height - top, Math.round(r.bh * (1 + 2 * pad) * sy));
      if (width <= 0 || height <= 0) continue;
      const face = await sharp(rotated).extract({ left, top, width, height }).resize(CW, CH, { fit: "cover" }).toBuffer();
      cells.push(
        await sharp(face)
          .composite([{ input: LABEL_BG(`#${i + 1}`, CW), top: 0, left: 0 }])
          .toBuffer(),
      );
    } catch {
      // 单张裁剪失败不该毁掉整张核验表 —— 跳过，摘要里会体现样本数
    }
  }
  const ok = await grid(cells, 6, CW, CH, path.join(OUT_DIR, "faces.jpg"));
  return ok ? cells.length : 0;
}

// ---------------------------------------------------------------- vs-named.jpg

function runVsNamed() {
  const named = db
    .prepare(
      `SELECT id, name, nickname, centroid_embedding e, member_count m FROM persons
       WHERE id != ? AND ((name IS NOT NULL AND name != '') OR (nickname IS NOT NULL AND nickname != ''))`,
    )
    .all(personId);

  const ranked = named
    .map((n) => ({ ...n, sim: centroid && n.e ? cos(centroid, toVec(n.e)) : 0 }))
    .sort((a, b) => b.sim - a.sim);

  return ranked;
}

async function topPhotosOf(pid, n) {
  const rows = db
    .prepare(
      `SELECT f.photo_id p, f.embedding e, ph.thumbnail_path tp, ph.file_path fp, ph.taken_at t
       FROM faces f JOIN photos ph ON ph.id = f.photo_id WHERE f.person_id = ?`,
    )
    .all(pid);
  const c = toVec(db.prepare("SELECT centroid_embedding e FROM persons WHERE id = ?").get(pid)?.e);
  return rows
    .map((r) => ({ ...r, cos: c ? cos(toVec(r.e), c) : 0 }))
    .sort((a, b) => b.cos - a.cos)
    .slice(0, n);
}

async function buildVsNamed(ranked) {
  const TW = 240, TH = 240, LW = 220, COLS = 6;
  const cells = [];
  const put = (buf, col, row) => cells.push({ input: buf, left: LW + col * TW, top: row * TH });

  // 第 0 行 = 本簇代表照（cos 最高的 6 张）
  const mine = [...photos].sort((a, b) => b.cos - a.cos).slice(0, COLS);
  for (let c = 0; c < mine.length; c++) {
    const dec = decodeToJpeg(mine[c], 900);
    if (!dec) continue;
    put(await sharp(dec.buf, { failOn: "none" }).rotate().resize(TW, TH, { fit: "cover" }).toBuffer(), c, 0);
  }

  const shown = Math.min(5, ranked.length);
  for (let i = 0; i < shown; i++) {
    const n = ranked[i];
    const pics = await topPhotosOf(n.id, COLS);
    for (let c = 0; c < pics.length; c++) {
      const dec = decodeToJpeg({ tp: pics[c].tp, fp: pics[c].fp }, 900);
      if (!dec) continue;
      put(await sharp(dec.buf, { failOn: "none" }).rotate().resize(TW, TH, { fit: "cover" }).toBuffer(), c, i + 1);
    }
  }

  const width = LW + COLS * TW, height = (1 + shown) * TH;
  const labels = [];
  const rowLabel = (text, row) =>
    labels.push({
      input: Buffer.from(
        `<svg width="${LW}" height="${TH}"><rect width="100%" height="100%" fill="#111"/>` +
          `<text x="12" y="${TH / 2}" font-size="20" fill="#ffffff" font-family="Helvetica">${xmlSafe(text)}</text></svg>`,
      ),
      left: 0,
      top: row * TH,
    });
  rowLabel(`本簇 ${personId.slice(0, 8)}`, 0);
  for (let i = 0; i < shown; i++) {
    rowLabel(`${ranked[i].name || ranked[i].nickname || "?"}`, i + 1);
  }

  await sharp({ create: { width, height, channels: 3, background: "#111" } })
    .composite([...labels, ...cells])
    .jpeg({ quality: 88 })
    .toFile(path.join(OUT_DIR, "vs-named.jpg"));
  return shown;
}

// ---------------------------------------------------------------- 摘要（索引，不是裁决）

function printSummary(sheets) {
  const years = [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const days = new Set(photos.map((r) => r.t.slice(0, 10)));

  console.log(`== person ${personId}`);
  console.log(`   name=${person.name || "(未命名)"} nickname=${person.nickname || "-"} members=${person.m}`);
  console.log(`   照片 ${photos.length} 张 / 独立拍摄日 ${days.size} / 跨度 ${photos[0].t.slice(0, 10)} → ${photos.at(-1).t.slice(0, 10)}`);
  console.log(`   年份分布: ${years.map(([y, a]) => `${y}:${a.length}`).join(" ")}`);
  console.log(`   素材可用性: 原图缺失 ${missingOriginals}/${photos.length}`);
  console.log(`   本次摊开: ${sample.length} 张（逐年抽样，--per-year 可调）`);

  // 同框信号：这张照片里还挂着别的 person —— 合影是这个库里混合簇的最大来源
  const multi = [];
  for (let i = 0; i < sample.length; i++) {
    const r = sample[i];
    const others = db
      .prepare("SELECT DISTINCT person_id FROM faces WHERE photo_id = ? AND person_id IS NOT NULL AND person_id != ?")
      .all(r.p, personId);
    if (others.length > 0) {
      const names = others.map((o) => {
        const pp = db.prepare("SELECT name, nickname FROM persons WHERE id = ?").get(o.person_id);
        return pp?.name || pp?.nickname || o.person_id.slice(0, 8);
      });
      multi.push(`   #${i + 1} ${r.t.slice(0, 10)} ${r.p.slice(0, 6)} → 同框: ${names.join(", ")}`);
    }
  }
  if (multi.length) {
    console.log(`\n   同框信号（这张照片同时挂着别的 person，${multi.length}/${sample.length}）:`);
    console.log(multi.join("\n"));
  }

  console.log("\n   跨视频占用: 见 video_usages 表（本脚本不查，skill 选片阶段自会排除）");
  console.log(`\n   素材包 → ${OUT_DIR}`);
  if (sheets.contact) console.log(`     contact.jpg   整图按年摊开（${sheets.contact} 格）——看是不是同一个人、有没有跨年弧线`);
  if (sheets.faces) console.log(`     faces.jpg     人脸特写（${sheets.faces} 格）——脸对脸细看`);
  if (sheets.vsNamed !== undefined) console.log(`     vs-named.jpg  与命名人物对照（${sheets.vsNamed} 行）——看是不是谁的拆分簇`);
}

// ---------------------------------------------------------------- main

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const ranked = runVsNamed();
  console.log(`\n   质心相似度（**注意力索引，不是判据**——数字只决定先看 vs-named.jpg 的哪一行，`);
  console.log(`   结论必须来自图像本身；这个库里母女/姐妹的相似脸本来就落在 0.5-0.7，单看数字必错）:`);
  for (const n of ranked) {
    console.log(`     ${(n.name || n.nickname || "?").padEnd(10)} ${n.sim.toFixed(3)}  members=${n.m}`);
  }
  console.log("");

  if (LIST_ONLY) {
    printSummary({});
    process.exit(0);
  }

  const sheets = {};
  sheets.contact = await buildContactSheet();
  sheets.faces = await buildFacesSheet();
  sheets.vsNamed = await buildVsNamed(ranked);

  printSummary(sheets);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => {
  console.error("核验素材包生成失败:", err?.message ?? err);
  process.exit(1);
});

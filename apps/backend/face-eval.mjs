/**
 * 身份漂移评估（20261014 h3.c 人物一致性实验）：
 *   node --import tsx face-eval.mjs <video> [anchorPhoto]
 *
 * 1. ffmpeg 抽样帧（0/25/50/75/100%）
 * 2. frame0 用 SCRFD 检测人脸（取面积最大 3 张）
 * 3. 各抽样帧按同 bbox 裁剪 → 112×112 → ArcFace 嵌入 → 与 frame0 同脸 cos
 *    （相对漂移：cos 越低崩得越狠）
 * 4. 给 anchorPhoto 时：锚图人脸 vs 视频 frame0 的 cos（起始保真）
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
import { detectFaces } from "./src/lib/face/detector.ts";
import { embedFace } from "./src/lib/face/embedder.ts";

const MODEL = path.join(process.cwd(), "assets/models/arcface_mbf.onnx");
const [, , videoPath, anchorPhoto] = process.argv;
if (!videoPath || !fs.existsSync(videoPath)) {
  console.error("usage: face-eval.mjs <video> [anchorPhoto]");
  process.exit(1);
}

const tmp = fs.mkdtempSync("/tmp/face-eval-");
const dur = Number(
  execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath],
    { encoding: "utf8" },
  ).trim(),
);
const stamps = [0, 0.25, 0.5, 0.75, 0.99].map((f) => Math.min(dur - 0.05, Math.max(0.03, dur * f)));
const frames = [];
for (const [i, t] of stamps.entries()) {
  const p = path.join(tmp, `f${i}.png`);
  let tt = t;
  for (let retry = 0; retry < 3 && !fs.existsSync(p); retry++) {
    spawnSync(
      "ffmpeg",
      ["-y", "-v", "error", "-ss", String(tt), "-i", videoPath, "-frames:v", "1", p],
      { timeout: 30000 },
    );
    tt = Math.max(0.03, tt - 0.2);
  }
  frames.push(fs.readFileSync(p));
}

async function embedCrop(buf, x, y, w, h) {
  const meta = await sharp(buf, { failOn: "none" }).metadata();
  const left = Math.max(0, Math.min(Math.round(x), meta.width - 8));
  const top = Math.max(0, Math.min(Math.round(y), meta.height - 8));
  const width = Math.max(8, Math.min(Math.round(w), meta.width - left));
  const height = Math.max(8, Math.min(Math.round(h), meta.height - top));
  const aligned = await sharp(buf, { failOn: "none" })
    .extract({ left, top, width, height })
    .resize(112, 112, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
  const data = new Float32Array(3 * 112 * 112);
  for (let i = 0; i < 112 * 112; i++) {
    for (let c = 0; c < 3; c++) data[c * 112 * 112 + i] = (aligned[i * 3 + c] - 127.5) / 127.5;
  }
  return embedFace(data);
}

function cos(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

// frame0 检测（video 帧）
const f0 = await sharp(frames[0], { failOn: "none" })
  .rotate()
  .raw()
  .toBuffer({ resolveWithObject: true });
const f0Meta = await sharp(frames[0], { failOn: "none" }).rotate().metadata();
const f0Png = await sharp(f0.data, {
  raw: { width: f0Meta.width, height: f0Meta.height, channels: f0Meta.channels },
})
  .png()
  .toBuffer();
const faces = (await detectFaces(f0Png, f0Meta.width, f0Meta.height, { minSize: 28 }))
  .sort((a, b) => b.w * b.h - a.w * a.h)
  .slice(0, 3);
console.error(
  `frame0 检出 ${faces.length} 脸: ${faces.map((f) => `${f.w}x${f.h}@(${f.x},${f.y})`).join(" ")}`,
);
if (faces.length === 0) process.exit(2);

const pads = faces.map((f) => ({
  x: f.x - f.w * 0.15,
  y: f.y - f.h * 0.2,
  w: f.w * 1.3,
  h: f.h * 1.4,
}));
const baseEmbeds = [];
for (let i = 0; i < faces.length; i++) {
  baseEmbeds.push(await embedCrop(frames[0], pads[i].x, pads[i].y, pads[i].w, pads[i].h));
}

// 起始保真：锚图 vs frame0
if (anchorPhoto && fs.existsSync(anchorPhoto)) {
  const photoBuf = fs.readFileSync(anchorPhoto);
  const photoMeta = await sharp(photoBuf, { failOn: "none" }).rotate().metadata();
  const photoRot = await sharp(photoBuf, { failOn: "none" }).rotate().png().toBuffer();
  const photoFaces = (
    await detectFaces(photoRot, photoMeta.width, photoMeta.height, { minSize: 60 })
  )
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, 3);
  console.error(`锚图检出 ${photoFaces.length} 脸`);
  for (let i = 0; i < Math.min(faces.length, photoFaces.length); i++) {
    const e = await embedCrop(
      photoBuf,
      photoFaces[i].x - photoFaces[i].w * 0.15,
      photoFaces[i].y - photoFaces[i].h * 0.2,
      photoFaces[i].w * 1.3,
      photoFaces[i].h * 1.4,
    );
    console.log(`锚图→frame0 脸${i + 1} cos=${cos(e, baseEmbeds[i]).toFixed(4)}`);
  }
}

// 跨帧漂移：逐帧重检测 + 按 frame0 中心最近匹配（大动作下固定 bbox 跟不住头部移动）
const lines = [`frame%  ${faces.map((_, i) => `脸${i + 1}`.padStart(8)).join(" ")}  检出`];
for (const [i] of stamps.entries()) {
  const meta = await sharp(frames[i], { failOn: "none" }).rotate().metadata();
  const png = await sharp(frames[i], { failOn: "none" }).rotate().png().toBuffer();
  const found = (await detectFaces(png, meta.width, meta.height, { minSize: 28 }))
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, 5);
  const row = [String(Math.round(stamps[i] * 100)).padStart(5)];
  for (let f = 0; f < faces.length; f++) {
    const c0 = { x: faces[f].x + faces[f].w / 2, y: faces[f].y + faces[f].h / 2 };
    let best = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const g of found) {
      const d = Math.hypot(g.x + g.w / 2 - c0.x, g.y + g.h / 2 - c0.y);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    if (best && bestD < Math.max(faces[f].w, faces[f].h)) {
      const e = await embedCrop(
        frames[i],
        best.x - best.w * 0.15,
        best.y - best.h * 0.2,
        best.w * 1.3,
        best.h * 1.4,
      );
      row.push(cos(e, baseEmbeds[f]).toFixed(4).padStart(8));
    } else {
      row.push("   miss ".padStart(8));
    }
  }
  row.push(String(found.length).padStart(4));
  lines.push(row.join("  "));
}
console.log(lines.join("\n"));
fs.rmSync(tmp, { recursive: true, force: true });

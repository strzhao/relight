/**
 * 一次性回填：对所有 manualOverride=false 的 person，按 cosine sim 最高重选代表 face，
 * 并重新生成头像 JPG（覆盖现有文件）。
 *
 * 使用场景：detect-faces.ts 把代表选择从 detection_score 改成 cosine sim 后，
 * 让现存 person 的代表头像也按新规则刷一遍，无需全量重跑。
 */
import Database from "better-sqlite3";
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const dbPath = process.env.DATABASE_PATH ?? "./data/relight.db";
const storageRoot = process.env.STORAGE_ROOT ?? "./photos";
const db = new Database(dbPath);

function decodeEmbedding(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

const persons = db.prepare(`SELECT * FROM persons WHERE manual_override = 0`).all();
console.log(`处理 ${persons.length} 个 person (manualOverride=false)`);

const { generateAutoAvatar } = await import("../src/lib/face/avatar.ts");

let updated = 0, skipped = 0, failed = 0;
for (const p of persons) {
  const faces = db.prepare(`SELECT * FROM faces WHERE person_id = ?`).all(p.id);
  if (faces.length === 0) { skipped++; continue; }
  const centroid = decodeEmbedding(p.centroid_embedding);
  let best = faces[0];
  let bestSim = -Infinity;
  for (const f of faces) {
    const emb = decodeEmbedding(f.embedding);
    const sim = cosine(emb, centroid);
    if (sim > bestSim) { bestSim = sim; best = f; }
  }
  if (best.id === p.representative_face_id) {
    skipped++; continue;
  }
  try {
    const photo = db.prepare(`SELECT file_path FROM photos WHERE id = ?`).get(best.photo_id);
    if (!photo) { failed++; continue; }
    let buf = await readFile(photo.file_path);
    const isHeic = /\.(heic|heif)$/i.test(photo.file_path);
    if (isHeic) {
      const { default: decodeHeic } = await import("heic-decode");
      const d = await decodeHeic({ buffer: buf });
      buf = await sharp(Buffer.from(d.data), { raw: { width: d.width, height: d.height, channels: 4 } }).jpeg({ quality: 90 }).toBuffer();
    }
    buf = await sharp(buf, { failOn: "none" }).rotate().toBuffer();
    const meta = await sharp(buf).metadata();
    const avatarAbs = await generateAutoAvatar(buf, { x: best.bbox_x, y: best.bbox_y, w: best.bbox_w, h: best.bbox_h }, meta.width, meta.height, p.id);
    const path = await import("node:path");
    const avatarRel = path.relative(storageRoot, avatarAbs);
    db.prepare(`UPDATE persons SET representative_face_id=?, avatar_path=?, updated_at=? WHERE id=?`)
      .run(best.id, avatarRel, new Date().toISOString(), p.id);
    updated++;
    if (updated % 10 === 0) console.log(`  progress: updated=${updated}`);
  } catch (err) {
    console.error(`  failed person=${p.id.slice(0, 8)}: ${err.message}`);
    failed++;
  }
}
console.log(`\n完成: updated=${updated} skipped=${skipped} failed=${failed}`);
db.close();
process.exit(0);

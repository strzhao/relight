/**
 * recluster-quality.mjs — Phase 1 离线 quality-aware 重聚类
 *
 * 不动 faces.attributes（已有）/不调 qwen，纯算法升级：
 *  - quality 三级（bbox_w + detection_score 反推）
 *  - HIGH：可新建 person + 全权拉动 centroid
 *  - MED：可加入或新建，centroid 权重 0.5
 *  - LOW：只能加入现有 person，不影响 centroid，宽松阈值 0.5
 *  - 严格 shouldMerge 沿用：mergeThreshold=0.7 / minThreshold=0.55 +
 *    临界区 gender/age 硬过滤
 *
 * 跑顺序：HIGH→MED→LOW，每组内按 photo.taken_at ASC（先种好"种子"再吸 LOW）
 *
 * 写回：清空 persons 表 → 重置 faces.person_id=NULL → 重新写
 *
 * 用法：
 *   cd apps/backend && node scripts/recluster-quality.mjs [--dry-run]
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = process.env.DATABASE_PATH ?? "./data/relight.db";
const db = new Database(dbPath);

// === 配置 ===
const MERGE_THRESHOLD = 0.85; // 极相似才跳过属性硬过滤（之前 0.7 太宽松）
const MIN_THRESHOLD = 0.55;
const LOW_MERGE_THRESHOLD = 0.85;
const LOW_MIN_THRESHOLD = 0.65;
const MED_CENTROID_WEIGHT = 0.5; // MED 拉动 centroid 的权重
const AGE_ORDER = ["infant", "child", "teen", "young_adult", "middle_aged", "senior"];

// === 工具 ===
function decodeEmbedding(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
function encodeEmbedding(emb) {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength).toString("base64");
}
function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // 都是 L2-normalized
}
function l2Normalize(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
  const n = Math.sqrt(s);
  if (n === 0) return arr;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / n;
  return out;
}

function qualityOf(face) {
  if (face.detection_score < 0.65) return "low";
  if (face.bbox_w >= 200 && face.detection_score >= 0.8) return "high";
  return "medium";
}

function parseAttr(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// 6 维属性 + member_count_with_attr → PersonAttributeSummary
function summarize(facesAttrs) {
  const gCount = {};
  const aCount = {};
  let withAttr = 0;
  for (const a of facesAttrs) {
    if (!a) continue;
    withAttr++;
    if (a.gender && a.gender !== "unknown") gCount[a.gender] = (gCount[a.gender] || 0) + 1;
    if (a.age_band && a.age_band !== "unknown")
      aCount[a.age_band] = (aCount[a.age_band] || 0) + 1;
  }
  const mode = (counts) => {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return entries.length > 0 ? entries[0][0] : "unknown";
  };
  return {
    schema_version: 1,
    gender_mode: mode(gCount),
    age_band_mode: mode(aCount),
    member_count_with_attr: withAttr,
  };
}

function shouldMerge(faceAttr, personSummary, sim, mergeT, minT) {
  if (sim < minT) return false;
  if (sim >= mergeT) return true;
  // 临界区
  if (!faceAttr || !personSummary) return true;
  if (personSummary.member_count_with_attr < 2) return true;
  // gender 不同（任一 unknown 不算冲突）
  if (
    faceAttr.gender !== "unknown" &&
    personSummary.gender_mode !== "unknown" &&
    faceAttr.gender !== personSummary.gender_mode
  )
    return false;
  // age 跨 2 档以上
  const i1 = AGE_ORDER.indexOf(faceAttr.age_band);
  const i2 = AGE_ORDER.indexOf(personSummary.age_band_mode);
  if (i1 >= 0 && i2 >= 0 && Math.abs(i1 - i2) >= 2) return false;
  return true;
}

// === 1. 读 faces ===
console.log("[recluster] 读取 faces ...");
const facesRaw = db
  .prepare(`
    SELECT f.id, f.photo_id, f.bbox_w, f.bbox_h, f.detection_score, f.embedding, f.attributes,
           p.taken_at
    FROM faces f
    LEFT JOIN photos p ON p.id = f.photo_id
  `)
  .all();

const faces = facesRaw.map((f) => ({
  id: f.id,
  photo_id: f.photo_id,
  bbox_w: f.bbox_w,
  bbox_h: f.bbox_h,
  detection_score: f.detection_score,
  embedding: decodeEmbedding(f.embedding),
  attributes: parseAttr(f.attributes),
  taken_at: f.taken_at ?? "",
}));

console.log(`[recluster] 共 ${faces.length} 张 face`);

// === 2. quality 标记 + 排序 ===
for (const f of faces) f.quality = qualityOf(f);
const qDist = { high: 0, medium: 0, low: 0 };
for (const f of faces) qDist[f.quality]++;
console.log(`[recluster] quality 分布:`, qDist);

// HIGH > MED > LOW，组内 taken_at ASC
const qRank = { high: 0, medium: 1, low: 2 };
faces.sort((a, b) => qRank[a.quality] - qRank[b.quality] || a.taken_at.localeCompare(b.taken_at));

// === 3. 重新聚类 ===
console.log("[recluster] 开始聚类 ...");

/** person: { id, centroid, faceIds, faceAttrs, weightSum } */
const persons = [];

function newPerson(face) {
  const p = {
    id: randomUUID(),
    centroid: face.embedding,
    faceIds: [face.id],
    faceAttrs: [face.attributes],
    weightSum: 1.0,
  };
  persons.push(p);
  face.person_id = p.id;
  return p;
}

function assignToPerson(face, p, centroidWeight) {
  face.person_id = p.id;
  p.faceIds.push(face.id);
  p.faceAttrs.push(face.attributes);
  if (centroidWeight > 0) {
    const w = p.weightSum;
    const out = new Float32Array(p.centroid.length);
    for (let i = 0; i < p.centroid.length; i++) {
      out[i] = (p.centroid[i] * w + face.embedding[i] * centroidWeight) / (w + centroidWeight);
    }
    p.centroid = l2Normalize(out);
    p.weightSum = w + centroidWeight;
  }
}

let processed = 0;
const tBucket = { high: 0, medium: 0, low: 0 };
const aBucket = { high: 0, medium: 0, low: 0 }; // assigned to existing
const nBucket = { high: 0, medium: 0, low: 0 }; // new person
const skipBucket = 0;

for (const face of faces) {
  processed++;
  if (processed % 500 === 0) console.log(`  ${processed}/${faces.length}`);
  tBucket[face.quality]++;

  // 找最相似 person
  let bestSim = -Infinity;
  let bestP = null;
  for (const p of persons) {
    const sim = cosine(face.embedding, p.centroid);
    if (sim > bestSim) {
      bestSim = sim;
      bestP = p;
    }
  }

  if (face.quality === "high") {
    // 严格 shouldMerge，可新建
    const summary = bestP ? summarize(bestP.faceAttrs) : null;
    const merge =
      bestP && shouldMerge(face.attributes, summary, bestSim, MERGE_THRESHOLD, MIN_THRESHOLD);
    if (merge) {
      assignToPerson(face, bestP, 1.0);
      aBucket.high++;
    } else {
      newPerson(face);
      nBucket.high++;
    }
  } else if (face.quality === "medium") {
    // 同 high 逻辑但 centroid 权重 0.5
    const summary = bestP ? summarize(bestP.faceAttrs) : null;
    const merge =
      bestP && shouldMerge(face.attributes, summary, bestSim, MERGE_THRESHOLD, MIN_THRESHOLD);
    if (merge) {
      assignToPerson(face, bestP, MED_CENTROID_WEIGHT);
      aBucket.medium++;
    } else {
      newPerson(face);
      nBucket.medium++;
    }
  } else {
    // low：严格阈值，宁可成孤儿也不污染大 cluster
    // 只有 sim 极高（>= LOW_MERGE_THRESHOLD 0.75，比 HIGH 还严）才合并，且不拉 centroid
    if (bestP && bestSim >= LOW_MERGE_THRESHOLD) {
      const summary = summarize(bestP.faceAttrs);
      if (shouldMerge(face.attributes, summary, bestSim, LOW_MERGE_THRESHOLD, LOW_MIN_THRESHOLD)) {
        assignToPerson(face, bestP, 0); // 0 = 不拉 centroid
        aBucket.low++;
        continue;
      }
    }
    // 找不到高匹配 → 孤儿 person（保留 face 数据但不污染主 cluster）
    newPerson(face);
    nBucket.low++;
  }
}

console.log(
  `\n[recluster] 处理完成: total=${processed}, persons=${persons.length}\n` +
    `  HIGH: ${tBucket.high} → 加入${aBucket.high} 新建${nBucket.high}\n` +
    `  MED:  ${tBucket.medium} → 加入${aBucket.medium} 新建${nBucket.medium}\n` +
    `  LOW:  ${tBucket.low} → 加入${aBucket.low} 新建${nBucket.low}`,
);

// member_count 统计
const sizeDist = {};
for (const p of persons) {
  const mc = p.faceIds.length;
  const bucket = mc >= 100 ? "100+" : mc >= 50 ? "50-99" : mc >= 20 ? "20-49" : mc >= 10 ? "10-19" : mc >= 5 ? "5-9" : mc >= 2 ? "2-4" : "1";
  sizeDist[bucket] = (sizeDist[bucket] || 0) + 1;
}
console.log("\n[recluster] member_count 分布:", sizeDist);

// === 4. 写回 DB ===
if (dryRun) {
  console.log("[recluster] --dry-run, 不写 DB");
  db.close();
  process.exit(0);
}

console.log("[recluster] 写回 DB ...");
const now = new Date().toISOString();

// 拿 storage_source_id（用第一张 photo 的）
const storageSourceId = db
  .prepare(`SELECT storage_source_id FROM photos LIMIT 1`)
  .get()?.storage_source_id;
if (!storageSourceId) {
  console.error("[recluster] 无法获取 storage_source_id");
  process.exit(1);
}

const tx = db.transaction(() => {
  db.prepare(`DELETE FROM persons`).run();
  db.prepare(`UPDATE faces SET person_id = NULL`).run();

  const insertPerson = db.prepare(`
    INSERT INTO persons (id, storage_source_id, centroid_embedding, member_count,
                         manual_override, displayable, hidden, created_at, updated_at,
                         attribute_summary)
    VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?, ?)
  `);
  const updateFace = db.prepare(`UPDATE faces SET person_id = ? WHERE id = ?`);

  for (const p of persons) {
    const summary = summarize(p.faceAttrs);
    const displayable = p.faceIds.length >= 5 ? 1 : 0;
    insertPerson.run(
      p.id,
      storageSourceId,
      encodeEmbedding(p.centroid),
      p.faceIds.length,
      displayable,
      now,
      now,
      JSON.stringify(summary),
    );
    for (const fid of p.faceIds) updateFace.run(p.id, fid);
  }
});

tx();
console.log(`[recluster] ✅ 完成 persons=${persons.length}`);
db.close();
process.exit(0);

/**
 * 多原型 vs 单 centroid 量化对比脚本（只读，不改 DB）
 *
 * 验收用：对每张已分配 face，模拟"如果它是一张新脸"：
 *   - 旧方法 A：argmax over persons of cosine(face.emb, person.centroid_embedding)
 *   - 新方法 B：matchByPrototypes（粗筛 + max(cosine to any prototype)）
 *
 * 统计：
 *   - self_consistent_old: 旧方法把 face 归回原 person 的张数
 *   - self_consistent_new: 新方法把 face 归回原 person 的张数
 *   - new_wins: 旧错新对（新方案的真实增益）
 *   - new_loses: 旧对新错（理论上罕见 — 新粗筛+attribute 严了导致漏召回）
 *   - both_correct / both_wrong
 *
 * 用法：pnpm exec tsx src/cli/verify-prototypes-vs-centroid.ts [--limit N]
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { cosineSim } from "../lib/face/clustering";
import { decodeEmbedding } from "../lib/face/embedding-codec";
import { type Prototype, matchByPrototypes } from "../lib/face/prototypes";

const backendRoot = (() => {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath && path.isAbsolute(dbPath)) return path.resolve(dbPath, "../../");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "../../");
})();
process.chdir(backendRoot);

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 0;

async function main() {
  console.log("[verify] 加载全量 person + prototypes ...");
  const persons = await db.select().from(schema.persons);
  const allProtos = await db.select().from(schema.personPrototypes);
  const protosByPerson = new Map<string, Prototype[]>();
  for (const p of allProtos) {
    const arr = protosByPerson.get(p.personId) ?? [];
    arr.push({
      id: p.id,
      personId: p.personId,
      embedding: decodeEmbedding(p.embedding),
      weightSum: p.weightSum,
      memberCount: p.memberCount,
    });
    protosByPerson.set(p.personId, arr);
  }
  console.log(`[verify] ${persons.length} person，${allProtos.length} prototype`);

  // 候选池：每个 person 一个条目（按 storage_source 分组）
  const candidatesBySource = new Map<
    string,
    Array<{
      person: { id: string; centroidEmbedding: string; attributeSummary: string | null };
      prototypes: Prototype[];
    }>
  >();
  for (const p of persons) {
    const arr = candidatesBySource.get(p.storageSourceId) ?? [];
    arr.push({
      person: {
        id: p.id,
        centroidEmbedding: p.centroidEmbedding,
        attributeSummary: p.attributeSummary,
      },
      prototypes: protosByPerson.get(p.id) ?? [],
    });
    candidatesBySource.set(p.storageSourceId, arr);
  }

  // 拉 face：仅含已分配 person_id 的，必要时含 attributes 和质量
  const rawFaces = await db.select().from(schema.faces);
  const faces = rawFaces.filter((f) => f.personId !== null);
  console.log(`[verify] 已分配 face: ${faces.length} 张`);

  // 需要 person 的 storage_source 查询：用 photo.storage_source_id
  const photoSourceMap = new Map<string, string>();
  const allPhotos = await db
    .select({ id: schema.photos.id, ssid: schema.photos.storageSourceId })
    .from(schema.photos);
  for (const ph of allPhotos) photoSourceMap.set(ph.id, ph.ssid);

  const cfg = {
    mergeThreshold: config.face.clusteringMergeThreshold,
    minThreshold: config.face.clusteringMinThreshold,
    midZoneFilter: config.face.midZoneAttrFilter,
    medQualityCentroidWeight: config.face.medQualityCentroidWeight,
    prototypeCoarseFilter: process.env.OVERRIDE_COARSE
      ? Number(process.env.OVERRIDE_COARSE)
      : config.face.prototypeCoarseFilter,
  };
  console.log(`[verify] prototypeCoarseFilter = ${cfg.prototypeCoarseFilter}`);

  let processed = 0;
  let skippedNoSsid = 0;
  let skippedNoCands = 0;
  let entered = 0;
  let bothCorrect = 0;
  let bothWrong = 0;
  let newWinsCount = 0; // 旧错新对
  let newLosesCount = 0; // 旧对新错
  const newWinsExamples: Array<{
    faceId: string;
    origPersonId: string;
    oldGuess: string | null;
    newGuess: string | null;
    oldScore: number;
    newScore: number;
  }> = [];
  const newLosesExamples: typeof newWinsExamples = [];

  const targetLimit = LIMIT > 0 ? Math.min(LIMIT, faces.length) : faces.length;

  for (const face of faces) {
    if (processed >= targetLimit) break;
    processed++;
    if (face.personId === null) continue;

    const ssid = photoSourceMap.get(face.photoId);
    if (!ssid) {
      skippedNoSsid++;
      continue;
    }
    const cands = candidatesBySource.get(ssid);
    if (!cands || cands.length === 0) {
      skippedNoCands++;
      continue;
    }
    entered++;

    const faceEmb = decodeEmbedding(face.embedding);
    const faceAttrs = face.attributes ? JSON.parse(face.attributes) : null;

    // --- 旧方法 A: cosine(face.emb, person.centroid) ---
    let oldBestId: string | null = null;
    let oldBestScore = Number.NEGATIVE_INFINITY;
    for (const c of cands) {
      const cEmb = decodeEmbedding(c.person.centroidEmbedding);
      const s = cosineSim(faceEmb, cEmb);
      if (s > oldBestScore) {
        oldBestScore = s;
        oldBestId = c.person.id;
      }
    }
    // 旧方法本来还有 mergeThreshold 门槛，但这里我们直接看 argmax 行为
    const oldHit = oldBestId === face.personId;

    // --- 新方法 B: matchByPrototypes ---
    const newRes = matchByPrototypes(faceEmb, cands, faceAttrs, cfg);
    const newHit = newRes.matchedPersonId === face.personId;

    if (oldHit && newHit) bothCorrect++;
    else if (!oldHit && !newHit) bothWrong++;
    else if (newHit && !oldHit) {
      newWinsCount++;
      if (newWinsExamples.length < 5) {
        newWinsExamples.push({
          faceId: face.id,
          origPersonId: face.personId,
          oldGuess: oldBestId,
          newGuess: newRes.matchedPersonId,
          oldScore: oldBestScore,
          newScore: newRes.score,
        });
      }
    } else if (oldHit && !newHit) {
      newLosesCount++;
      if (newLosesExamples.length < 5) {
        newLosesExamples.push({
          faceId: face.id,
          origPersonId: face.personId,
          oldGuess: oldBestId,
          newGuess: newRes.matchedPersonId,
          oldScore: oldBestScore,
          newScore: newRes.score,
        });
      }
    }

    if (processed % 500 === 0) {
      console.log(
        `[verify] 进度 ${processed}/${targetLimit} | both_correct=${bothCorrect} new_wins=${newWinsCount} new_loses=${newLosesCount} both_wrong=${bothWrong}`,
      );
    }
  }

  console.log("\n[verify] ====== 量化对比报告 ======");
  console.log(`总计已分配 face: ${faces.length}，实测: ${processed}`);
  console.log(`  - 进入比对: ${entered}`);
  console.log(`  - 跳过无 ssid: ${skippedNoSsid}`);
  console.log(`  - 跳过无 candidates: ${skippedNoCands}`);
  console.log(`两者都把 face 归回原 person  : ${bothCorrect} (${pct(bothCorrect, processed)})`);
  console.log(`新对旧错（新方案真实增益）  : ${newWinsCount} (${pct(newWinsCount, processed)})`);
  console.log(`新错旧对（新方案漏召回）    : ${newLosesCount} (${pct(newLosesCount, processed)})`);
  console.log(`两者都归错                  : ${bothWrong} (${pct(bothWrong, processed)})`);
  console.log(`\n净增益 (new_wins - new_loses): ${newWinsCount - newLosesCount}`);
  console.log(
    `\n新方案 self-consistency: ${bothCorrect + newWinsCount} / ${processed} = ${pct(bothCorrect + newWinsCount, processed)}`,
  );
  console.log(
    `旧方案 self-consistency: ${bothCorrect + newLosesCount} / ${processed} = ${pct(bothCorrect + newLosesCount, processed)}`,
  );

  if (newWinsExamples.length > 0) {
    console.log("\n--- 新增益样例（旧 argmax 错、新 max 对）---");
    for (const e of newWinsExamples) {
      console.log(
        `  face ${e.faceId.slice(0, 8)} | 原 person ${e.origPersonId.slice(0, 8)} | 旧错指 ${e.oldGuess?.slice(0, 8)} (cos=${e.oldScore.toFixed(3)}) | 新对 ${e.newGuess?.slice(0, 8)} (cos=${e.newScore.toFixed(3)})`,
      );
    }
  }
  if (newLosesExamples.length > 0) {
    console.log("\n--- 新方案回退样例（少见，关注是否是粗筛阈值过严） ---");
    for (const e of newLosesExamples) {
      console.log(
        `  face ${e.faceId.slice(0, 8)} | 原 person ${e.origPersonId.slice(0, 8)} | 旧对 (cos=${e.oldScore.toFixed(3)}) | 新指 ${e.newGuess?.slice(0, 8) ?? "null"} (cos=${e.newScore.toFixed(3)})`,
      );
    }
  }
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[verify] 失败:", err);
    process.exit(1);
  });

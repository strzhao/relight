/**
 * 多原型人脸聚类（Phase 3 升级）。
 *
 * 每个 person 维护最多 prototypeMaxPerPerson 个原型（representative embeddings），
 * 用于替代单 centroid 的匹配，解决 centroid 雪球问题。
 *
 * 核心函数：
 * - matchByPrototypes    多原型匹配（粗筛 centroid + 精筛 prototype）
 * - miniBatchKmeansCosine mini-batch k-means（cosine 距离）
 * - updatePrototypesIncremental 增量更新原型（tight merge / insert / 满时蒸馏）
 */

import { eq } from "drizzle-orm";
import { db, schema } from "../../db";
import type { FaceAttributes } from "./attributes";
import type { ClusterConfig, FaceQuality, PersonAttributeSummary } from "./clustering";
import { centroidWeightFor, cosineSim, shouldMerge } from "./clustering";
import { decodeEmbedding, encodeEmbedding } from "./embedding-codec";

export interface Prototype {
  id: string;
  personId: string;
  embedding: Float32Array;
  weightSum: number;
  memberCount: number;
}

/**
 * L2-normalize a Float32Array in-place, returning the same array.
 */
function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += (v[i] ?? 0) * (v[i] ?? 0);
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

/**
 * 多原型匹配。
 *
 * 对每个 candidate person：
 * 1. 粗筛：cosine(new, person.centroid) < prototypeCoarseFilter → 跳过
 * 2. 精筛：在该 person 的 prototypes 中取 max cosine
 * 3. 属性过滤：调 shouldMerge（沿用 clustering.ts）
 * 全部候选评分后取 argmax。
 */
export function matchByPrototypes(
  newEmbedding: Float32Array,
  candidates: Array<{
    person: { id: string; centroidEmbedding: string; attributeSummary: string | null };
    prototypes: Prototype[];
  }>,
  newAttributes: FaceAttributes | null,
  config: ClusterConfig & { prototypeCoarseFilter: number },
): { matchedPersonId: string | null; score: number } {
  let bestId: string | null = null;
  let bestScore = -1;

  for (const { person, prototypes } of candidates) {
    // 1. 粗筛（centroid cosine 快速排除）
    let centroid: Float32Array;
    try {
      centroid = decodeEmbedding(person.centroidEmbedding);
    } catch {
      continue;
    }
    const coarseSim = cosineSim(newEmbedding, centroid);
    if (coarseSim < config.prototypeCoarseFilter) continue;

    // 2. 精筛：在 prototypes 中取最高 cosine
    let maxProtoSim = -1;
    for (const proto of prototypes) {
      const s = cosineSim(newEmbedding, proto.embedding);
      if (s > maxProtoSim) maxProtoSim = s;
    }

    // 如果没有原型，退化为用 centroid sim
    const effectiveSim = prototypes.length > 0 ? maxProtoSim : coarseSim;

    // 3. 属性过滤
    let parsedSummary: PersonAttributeSummary | null = null;
    if (person.attributeSummary) {
      try {
        parsedSummary = JSON.parse(person.attributeSummary) as PersonAttributeSummary;
      } catch {
        parsedSummary = null;
      }
    }

    const merge = shouldMerge(newAttributes, parsedSummary, effectiveSim, config);
    if (!merge) continue;

    if (effectiveSim > bestScore) {
      bestScore = effectiveSim;
      bestId = person.id;
    }
  }

  return { matchedPersonId: bestId, score: bestScore > 0 ? bestScore : 0 };
}

/**
 * Mini-batch k-means（cosine 距离）。
 *
 * 随机选 k 个 embedding 作初始 centroid（weight > 0 的），
 * 每轮 assign + update，退出条件：iter >= maxIters 或 inertia 变化 < 1e-4。
 */
export function miniBatchKmeansCosine(
  embeddings: Float32Array[],
  weights: number[],
  k: number,
  maxIters: number,
): Array<{ centroid: Float32Array; weightSum: number; memberCount: number }> {
  if (embeddings.length === 0) return [];
  const actualK = Math.min(k, embeddings.length);

  // 取有权重的 embedding 作初始 centroid（简单随机取前 k 个）
  const nonZeroIdx: number[] = [];
  for (let i = 0; i < weights.length; i++) {
    if ((weights[i] ?? 0) > 0) nonZeroIdx.push(i);
  }

  // 若全是 zero weight，用全部
  const initPool = nonZeroIdx.length >= actualK ? nonZeroIdx : embeddings.map((_, i) => i);

  // Fisher-Yates shuffle 取 actualK 个
  const shuffled = [...initPool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j] ?? 0;
    shuffled[j] = tmp ?? 0;
  }

  const dim = embeddings[0]?.length ?? 512;
  let centroids: Float32Array[] = shuffled.slice(0, actualK).map((idx) => {
    const e = embeddings[idx];
    if (!e) return new Float32Array(dim);
    return new Float32Array(e);
  });

  let prevInertia = Number.POSITIVE_INFINITY;

  for (let iter = 0; iter < maxIters; iter++) {
    // Assign
    const clusterWeightSum = new Array<number>(actualK).fill(0);
    const clusterMemberCount = new Array<number>(actualK).fill(0);
    const clusterSums: Float32Array[] = Array.from(
      { length: actualK },
      () => new Float32Array(dim),
    );

    let inertia = 0;

    for (let ei = 0; ei < embeddings.length; ei++) {
      const emb = embeddings[ei];
      const w = weights[ei] ?? 0;
      if (!emb) continue;

      let bestCluster = 0;
      let bestSim = -1;
      for (let ci = 0; ci < actualK; ci++) {
        const c = centroids[ci];
        if (!c) continue;
        const s = cosineSim(emb, c);
        if (s > bestSim) {
          bestSim = s;
          bestCluster = ci;
        }
      }
      inertia += 1 - bestSim; // 越小越好

      const cs = clusterSums[bestCluster];
      if (cs) {
        for (let d = 0; d < dim; d++) cs[d] = (cs[d] ?? 0) + (emb[d] ?? 0) * w;
        clusterWeightSum[bestCluster] = (clusterWeightSum[bestCluster] ?? 0) + w;
        clusterMemberCount[bestCluster] = (clusterMemberCount[bestCluster] ?? 0) + 1;
      }
    }

    // Update centroids
    const newCentroids: Float32Array[] = [];
    for (let ci = 0; ci < actualK; ci++) {
      const cs = clusterSums[ci];
      const ws = clusterWeightSum[ci] ?? 0;
      if (!cs) {
        newCentroids.push(centroids[ci] ?? new Float32Array(dim));
        continue;
      }
      if (ws === 0) {
        // empty cluster: keep old centroid
        newCentroids.push(centroids[ci] ?? new Float32Array(dim));
        continue;
      }
      const nc = new Float32Array(dim);
      for (let d = 0; d < dim; d++) nc[d] = (cs[d] ?? 0) / ws;
      l2Normalize(nc);
      newCentroids.push(nc);
    }
    centroids = newCentroids;

    // Check convergence
    if (Math.abs(prevInertia - inertia) < 1e-4) break;
    prevInertia = inertia;
  }

  // Build result
  // Re-assign to get final stats
  const clusterWeightSum = new Array<number>(actualK).fill(0);
  const clusterMemberCount = new Array<number>(actualK).fill(0);

  for (let ei = 0; ei < embeddings.length; ei++) {
    const emb = embeddings[ei];
    const w = weights[ei] ?? 0;
    if (!emb) continue;

    let bestCluster = 0;
    let bestSim = -1;
    for (let ci = 0; ci < actualK; ci++) {
      const c = centroids[ci];
      if (!c) continue;
      const s = cosineSim(emb, c);
      if (s > bestSim) {
        bestSim = s;
        bestCluster = ci;
      }
    }
    clusterWeightSum[bestCluster] = (clusterWeightSum[bestCluster] ?? 0) + w;
    clusterMemberCount[bestCluster] = (clusterMemberCount[bestCluster] ?? 0) + 1;
  }

  return centroids.map((centroid, ci) => ({
    centroid,
    weightSum: clusterWeightSum[ci] ?? 0,
    memberCount: clusterMemberCount[ci] ?? 0,
  }));
}

/**
 * 增量更新原型（async，内部 sync tx 包多步写入）。
 *
 * - LOW quality（weight=0）→ return 不更新
 * - 拉当前 prototypes，找最近者：
 *   - cosine >= prototypeTightMerge → UPDATE 该原型（weighted average）
 *   - 否则 + length < max → INSERT 新原型
 *   - 已满 → tx 内合并最相似两个 + INSERT 新原型
 */
export async function updatePrototypesIncremental(
  personId: string,
  newEmbedding: Float32Array,
  quality: FaceQuality,
  config: {
    prototypeTightMerge: number;
    prototypeMaxPerPerson: number;
    medQualityCentroidWeight: number;
  },
): Promise<void> {
  const w = centroidWeightFor(quality, config.medQualityCentroidWeight);
  if (w === 0) return; // LOW quality，不更新

  const now = new Date().toISOString();

  // 拉当前 person 的 prototypes（tx 外 await）
  const rows = await db
    .select()
    .from(schema.personPrototypes)
    .where(eq(schema.personPrototypes.personId, personId));

  const prototypes: Array<{
    id: string;
    embedding: Float32Array;
    weightSum: number;
    memberCount: number;
  }> = rows.map((r) => ({
    id: r.id,
    embedding: decodeEmbedding(r.embedding),
    weightSum: r.weightSum,
    memberCount: r.memberCount,
  }));

  // 找最近原型
  let bestIdx = -1;
  let bestSim = -1;
  for (let i = 0; i < prototypes.length; i++) {
    const p = prototypes[i];
    if (!p) continue;
    const s = cosineSim(newEmbedding, p.embedding);
    if (s > bestSim) {
      bestSim = s;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0 && bestSim >= config.prototypeTightMerge) {
    // Tight merge：UPDATE 最近原型（无需 tx，单条写）
    const best = prototypes[bestIdx];
    if (!best) return;
    const oldWS = best.weightSum;
    const newWS = oldWS + w;
    // weighted average embedding
    const dim = newEmbedding.length;
    const merged = new Float32Array(dim);
    for (let d = 0; d < dim; d++) {
      merged[d] = ((best.embedding[d] ?? 0) * oldWS + (newEmbedding[d] ?? 0) * w) / newWS;
    }
    l2Normalize(merged);

    await db
      .update(schema.personPrototypes)
      .set({
        embedding: encodeEmbedding(merged),
        weightSum: newWS,
        memberCount: best.memberCount + 1,
        updatedAt: now,
      })
      .where(eq(schema.personPrototypes.id, best.id));
    return;
  }

  if (prototypes.length < config.prototypeMaxPerPerson) {
    // INSERT 新原型（单条，无需 tx）
    await db.insert(schema.personPrototypes).values({
      id: crypto.randomUUID(),
      personId,
      embedding: encodeEmbedding(newEmbedding),
      weightSum: w,
      memberCount: 1,
      label: null,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  // 已满（>= prototypeMaxPerPerson）：合并最相似两个 + INSERT 新原型
  // 找两个最相似的 prototypes（pairwise）
  let mergeA = 0;
  let mergeB = 1;
  let mergeSim = -1;
  for (let i = 0; i < prototypes.length; i++) {
    for (let j = i + 1; j < prototypes.length; j++) {
      const pi = prototypes[i];
      const pj = prototypes[j];
      if (!pi || !pj) continue;
      const s = cosineSim(pi.embedding, pj.embedding);
      if (s > mergeSim) {
        mergeSim = s;
        mergeA = i;
        mergeB = j;
      }
    }
  }

  const pa = prototypes[mergeA];
  const pb = prototypes[mergeB];
  if (!pa || !pb) return;

  const totalWS = pa.weightSum + pb.weightSum;
  const dim = pa.embedding.length;
  const mergedEmb = new Float32Array(dim);
  for (let d = 0; d < dim; d++) {
    mergedEmb[d] =
      totalWS > 0
        ? ((pa.embedding[d] ?? 0) * pa.weightSum + (pb.embedding[d] ?? 0) * pb.weightSum) / totalWS
        : ((pa.embedding[d] ?? 0) + (pb.embedding[d] ?? 0)) / 2;
  }
  l2Normalize(mergedEmb);

  const newProtoId = crypto.randomUUID();

  // sync tx：UPDATE pa（合并结果）+ DELETE pb + INSERT 新原型
  db.transaction((tx) => {
    tx.update(schema.personPrototypes)
      .set({
        embedding: encodeEmbedding(mergedEmb),
        weightSum: totalWS,
        memberCount: pa.memberCount + pb.memberCount,
        updatedAt: now,
      })
      .where(eq(schema.personPrototypes.id, pa.id))
      .run();
    tx.delete(schema.personPrototypes).where(eq(schema.personPrototypes.id, pb.id)).run();
    tx.insert(schema.personPrototypes)
      .values({
        id: newProtoId,
        personId,
        embedding: encodeEmbedding(newEmbedding),
        weightSum: w,
        memberCount: 1,
        label: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
}

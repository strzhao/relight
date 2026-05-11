/**
 * 增量人脸聚类。
 *
 * 不同于 bursts 的 union-find（一次性批量），每张新脸只与现有 person centroids 做一次 cosine 比较：
 *   - 找到 max(cos) 的 person，若 >= threshold，归并；否则新建 person
 *   - 归并后 centroid 用增量平均更新（避免每次重算 N×512 浮点累加）
 *
 * 假设 input embedding 都已 L2-normalized，cosine 退化为 dot product。
 */

export interface PersonCentroid {
  /** person id */
  id: string;
  /** centroid embedding（L2-normalized 512 维） */
  centroid: Float32Array;
  /**
   * 当前已归并的人脸数（用于增量平均）。
   * 调用方未提供时假定 1（仅做 cosine 比对、不更新 centroid 时可省略）。
   */
  memberCount?: number;
}

/** cosine similarity（假设两向量都已 L2-normalized） */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSim: 向量长度不一致 ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

export interface AssignResult {
  /** 命中的 person id；null 表示需要新建 */
  matchedPersonId: string | null;
  /** max cosine（用于日志/诊断） */
  bestSim: number;
}

/**
 * 把一张新脸分配到现有 persons 之一。
 *
 * @param faceEmbedding L2-normalized embedding
 * @param candidates 同 storageSource 内的现有 persons centroid 列表
 * @param threshold cosine 阈值（默认 0.5，ArcFace 业界经验值）
 */
export function assignToPerson(
  faceEmbedding: Float32Array,
  candidates: PersonCentroid[],
  threshold = 0.5,
): AssignResult {
  let bestId: string | null = null;
  let bestSim = -1;
  for (const c of candidates) {
    const s = cosineSim(faceEmbedding, c.centroid);
    if (s > bestSim) {
      bestSim = s;
      bestId = c.id;
    }
  }
  return {
    matchedPersonId: bestSim >= threshold ? bestId : null,
    bestSim,
  };
}

/**
 * 增量更新 centroid：newCentroid = (oldCentroid * n + newEmbed) / (n+1)，
 * 然后 L2-normalize（保持单位向量便于后续 cosine = dot）。
 *
 * @param oldCentroid 旧 centroid（已归一）
 * @param oldCount 旧成员数
 * @param newEmbedding 新加入的 embedding（已归一）
 */
export function updateCentroid(
  oldCentroid: Float32Array,
  oldCount: number,
  newEmbedding: Float32Array,
): Float32Array {
  if (oldCentroid.length !== newEmbedding.length) {
    throw new Error(`updateCentroid: 维度不一致 ${oldCentroid.length} vs ${newEmbedding.length}`);
  }
  const n = oldCount;
  const out = new Float32Array(oldCentroid.length);
  let sum = 0;
  for (let i = 0; i < oldCentroid.length; i++) {
    const v = ((oldCentroid[i] ?? 0) * n + (newEmbedding[i] ?? 0)) / (n + 1);
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) return out;
  for (let i = 0; i < out.length; i++) {
    out[i] = (out[i] ?? 0) / norm;
  }
  return out;
}

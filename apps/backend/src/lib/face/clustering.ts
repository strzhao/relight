/**
 * 增量人脸聚类（方案 C 升级版）。
 *
 * 不同于 bursts 的 union-find（一次性批量），每张新脸只与现有 person centroids 做一次 cosine 比较：
 *   - 找到 max(cos) 的 person，若 >= mergeThreshold，归并；否则新建 person
 *   - 在 [minThreshold, mergeThreshold) 中间区间启用属性硬过滤
 *   - 归并后 centroid 用增量平均更新（避免每次重算 N×512 浮点累加）
 *
 * 假设 input embedding 都已 L2-normalized，cosine 退化为 dot product。
 */

import type { FaceAttributes } from "./attributes";

export type AgeBand = FaceAttributes["age_band"];
export type Gender = FaceAttributes["gender"];

/** Person 内所有 face attributes 的多数票聚合 */
export type PersonAttributeSummary = {
  schema_version: 1;
  gender_mode: Gender;
  age_band_mode: AgeBand;
  /** 统计 attributes IS NOT NULL 的脸数（非 memberCount） */
  member_count_with_attr: number;
};

/** 候选 person（用于 assignToPersonWithAttrFilter） */
export type PersonCandidate = {
  id: string;
  centroid: Float32Array;
  /** 必填字段，无属性数据时明确设为 null */
  attribute_summary: PersonAttributeSummary | null;
};

/** 聚类配置 */
export type ClusterConfig = {
  /** cosine >= 此值直接合并 */
  mergeThreshold: number;
  /** cosine < 此值直接不合并 */
  minThreshold: number;
  /** 中间区间是否启用属性硬过滤 */
  midZoneFilter: boolean;
};

/** age_band 索引顺序（用于跨档判断） */
const AGE_ORDER: AgeBand[] = ["infant", "child", "teen", "young_adult", "middle_aged", "senior"];

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

/**
 * 判断是否应合并（方案 C 硬过滤算法）。
 *
 * 严格按设计文档伪代码实现：
 * - sim < minThreshold → false
 * - sim >= mergeThreshold → true
 * - 中间区间：midZoneFilter=false 或属性缺失或 person 样本 < 2 → true
 * - gender 双方都非 unknown 且不同 → false
 * - age_band 双方都已知且 |index1 - index2| >= 2 → false
 * - 否则 → true
 */
export function shouldMerge(
  faceAttr: FaceAttributes | null,
  personSummary: PersonAttributeSummary | null,
  sim: number,
  config: ClusterConfig,
): boolean {
  if (sim < config.minThreshold) return false;
  if (sim >= config.mergeThreshold) return true;

  if (!config.midZoneFilter) return true;
  if (!faceAttr || !personSummary) return true;
  if (personSummary.member_count_with_attr < 2) return true;

  if (
    faceAttr.gender !== "unknown" &&
    personSummary.gender_mode !== "unknown" &&
    faceAttr.gender !== personSummary.gender_mode
  ) {
    return false;
  }

  const i1 = AGE_ORDER.indexOf(faceAttr.age_band);
  const i2 = AGE_ORDER.indexOf(personSummary.age_band_mode);
  if (i1 >= 0 && i2 >= 0 && Math.abs(i1 - i2) >= 2) {
    return false;
  }

  return true;
}

export interface AssignResult {
  /** 命中的 person id；null 表示需要新建 */
  matchedPersonId: string | null;
  /** max cosine（用于日志/诊断） */
  bestSim: number;
  /** cosine 命中但被属性硬过滤拒绝 */
  rejectedByAttr: boolean;
}

/**
 * 把一张新脸分配到现有 persons 之一（方案 C 新签名，带属性过滤）。
 *
 * @param embedding L2-normalized embedding
 * @param attributes 该人脸的语义属性，null 时退化为纯 cosine
 * @param candidates 同 storageSource 内的现有 persons（含 attribute_summary）
 * @param config 聚类配置（双阈值 + 过滤开关）
 */
export function assignToPersonWithAttrFilter(
  embedding: Float32Array,
  attributes: FaceAttributes | null,
  candidates: PersonCandidate[],
  config: ClusterConfig,
): AssignResult {
  let bestId: string | null = null;
  let bestSim = -1;
  let bestCandidate: PersonCandidate | null = null;

  for (const c of candidates) {
    const s = cosineSim(embedding, c.centroid);
    if (s > bestSim) {
      bestSim = s;
      bestId = c.id;
      bestCandidate = c;
    }
  }

  if (bestId === null || bestCandidate === null) {
    return { matchedPersonId: null, bestSim, rejectedByAttr: false };
  }

  const merge = shouldMerge(attributes, bestCandidate.attribute_summary, bestSim, config);

  if (!merge) {
    const wasAboveMin = bestSim >= config.minThreshold;
    return {
      matchedPersonId: null,
      bestSim,
      rejectedByAttr: wasAboveMin,
    };
  }

  return {
    matchedPersonId: merge ? bestId : null,
    bestSim,
    rejectedByAttr: false,
  };
}

/**
 * 计算 person 内所有 face attributes 的多数票聚合。
 *
 * unknown 不计票；平票按字母序取靠前者。
 * 若无任何 face 有 attributes，返回 null。
 */
export function updatePersonAttributeSummary(
  existingFaces: Array<{ attributes: FaceAttributes | null }>,
): PersonAttributeSummary | null {
  const genderCount: Record<string, number> = {};
  const ageBandCount: Record<string, number> = {};
  let memberCountWithAttr = 0;

  for (const face of existingFaces) {
    if (!face.attributes) continue;
    memberCountWithAttr++;

    const g = face.attributes.gender;
    if (g !== "unknown") {
      genderCount[g] = (genderCount[g] ?? 0) + 1;
    }

    const a = face.attributes.age_band;
    if (a !== "unknown") {
      ageBandCount[a] = (ageBandCount[a] ?? 0) + 1;
    }
  }

  if (memberCountWithAttr === 0) return null;

  const genderMode = pickMode(genderCount, "unknown") as Gender;
  const ageBandMode = pickMode(ageBandCount, "unknown") as AgeBand;

  return {
    schema_version: 1,
    gender_mode: genderMode,
    age_band_mode: ageBandMode,
    member_count_with_attr: memberCountWithAttr,
  };
}

/** 从计数 map 取多数票，平票按字母序取靠前，无计票返回 fallback */
function pickMode(counts: Record<string, number>, fallback: string): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return fallback;

  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  return entries[0]?.[0] ?? fallback;
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

// ===== Quality-aware 聚类（Phase 2）=====
// 解决 patterns.md「centroid 雪球 + 垃圾桶 cluster」问题：
// - HIGH face：正常拉动 centroid（权重 1.0）
// - MED face：权重折半（默认 0.5）
// - LOW face：不拉动 centroid，且阈值更严（避免污染大 cluster）

export type FaceQuality = "high" | "medium" | "low";

export interface QualityConfig {
  /** HIGH 需要的最小 bbox 边长（默认 200） */
  highBboxSize: number;
  /** HIGH 需要的最小 detection_score（默认 0.8） */
  highDetectionScore: number;
  /** detection_score 低于此值直接判 LOW（默认 0.65） */
  lowDetectionScore: number;
}

/** 用 bbox 边长 + detection_score 反推 face quality，不依赖 qwen */
export function qualityOf(
  detectionScore: number,
  bboxW: number,
  bboxH: number,
  config: QualityConfig,
): FaceQuality {
  if (detectionScore < config.lowDetectionScore) return "low";
  if (
    bboxW >= config.highBboxSize &&
    bboxH >= config.highBboxSize &&
    detectionScore >= config.highDetectionScore
  ) {
    return "high";
  }
  return "medium";
}

/** centroid 权重：HIGH 全权重，MED 部分，LOW 不参与 */
export function centroidWeightFor(quality: FaceQuality, medWeight: number): number {
  if (quality === "high") return 1.0;
  if (quality === "medium") return medWeight;
  return 0; // low：不污染 centroid
}

/**
 * 带权重的 centroid 更新（替代 updateCentroid 的 quality-aware 版本）。
 *
 * 增量加权平均：centroid_new = (centroid_old × weightSum + emb × w) / (weightSum + w)
 * 然后 L2-normalize。
 *
 * @param oldCentroid 旧 centroid（已归一）
 * @param oldWeightSum 旧权重和（不是 memberCount，是累计 weight）
 * @param newEmbedding 新 embedding（已归一）
 * @param weight 本次贡献的权重（0~1，LOW=0 时调用方应跳过本函数）
 */
export function updateCentroidWeighted(
  oldCentroid: Float32Array,
  oldWeightSum: number,
  newEmbedding: Float32Array,
  weight: number,
): Float32Array {
  if (weight <= 0) return oldCentroid;
  if (oldCentroid.length !== newEmbedding.length) {
    throw new Error("updateCentroidWeighted: 维度不一致");
  }
  const out = new Float32Array(oldCentroid.length);
  let sum = 0;
  for (let i = 0; i < oldCentroid.length; i++) {
    const v =
      ((oldCentroid[i] ?? 0) * oldWeightSum + (newEmbedding[i] ?? 0) * weight) /
      (oldWeightSum + weight);
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) return out;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

/**
 * Quality-aware 配置生成：根据 face quality 调整阈值。
 * - HIGH/MED：用基础 ClusterConfig
 * - LOW：mergeThreshold 强制提到 0.85+ 防止杂质污染
 */
export function clusterConfigForQuality(base: ClusterConfig, quality: FaceQuality): ClusterConfig {
  if (quality === "low") {
    return {
      ...base,
      // LOW 用更严的下阈值（默认 0.65），避免低质量 face 进入边界 cluster
      minThreshold: Math.max(base.minThreshold, 0.65),
      // mergeThreshold 已经在 0.85，不再加严
    };
  }
  return base;
}

// ===== 向后兼容 export（旧签名，不删除以免破坏现有测试） =====

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

/**
 * @deprecated 语义升级为双阈值方案 C，请改用 assignToPersonWithAttrFilter。
 * 此函数保留以避免破坏现有测试，内部退化为纯 cosine（不做属性过滤）。
 */
export function assignToPerson(
  faceEmbedding: Float32Array,
  candidates: PersonCentroid[],
  threshold = 0.5,
): { matchedPersonId: string | null; bestSim: number } {
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

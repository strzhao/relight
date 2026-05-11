/**
 * 主题去重聚类：两步算法
 *
 * Step 1（保留）：对每个 dirname 桶按 takenAt 升序做链式扫描
 *   → 与现有 clusterByDirnameAndTime 完全一致，不动
 *
 * Step 2（新增）：基于 Step 1 输出做 GPS union-find
 *   → 簇粒度，N=clusters.length（极轻量）
 *   → 若 Ci, Cj 中存在任意一对照片满足: haversineMeters ≤ 500m AND |Δt| ≤ 24h
 *     → union(Ci, Cj)
 *   → 合并后每个连通分量重选代表
 *
 * 单簇情况退化与原算法一致（无跨 dir GPS 配对时 Step 2 无操作）。
 *
 * 触发条件（Step 1，仅当两者同时满足才同簇）：
 *   - dirname(file_path) 相同
 *   - |Δt| ≤ windowMinutes（默认 60 分钟，闭区间）
 *
 * OUT-OF-SCOPE：跨年份/跨 dirname/Δt > 60min 不触发同簇（除非 GPS 谓词命中）。
 *
 * 不足策略：聚类后簇数 < maxN 直接接受 N<20，由调用方继续走原有
 * 截断逻辑（不做 K 回退，保护 4 源等比混采契约）。
 */

import path from "node:path";
import { haversineMeters } from "../../lib/geo";
import type { EnrichedCandidate } from "./candidate-pool";

/** 聚类后的代表候选，附带同簇其他成员 photoId（按 takenAt 升序） */
export interface ClusteredCandidate extends EnrichedCandidate {
  /** 同簇其他照片的 photoId（不含自己），按 takenAt 升序 */
  clusterSiblingIds: string[];
}

/** 聚类参数 */
export interface ClusterOptions {
  /** 时间窗（分钟，闭区间），默认 60 */
  windowMinutes?: number;
  /** GPS 合并距离（米），默认 500 */
  gpsRadiusMeters?: number;
  /** GPS 合并时间窗（小时），默认 24 */
  gpsWindowHours?: number;
}

/**
 * 解析 takenAt → epoch ms。无法解析返回 null。
 *
 * 与 related-pool.ts 保持一致：EXIF 写入的 takenAt 多为
 * 'YYYY-MM-DD HH:MM:SS'（无时区）字面值，按 UTC 处理避免本地时区平移。
 */
function parseTakenAtMs(takenAt: string | null): number | null {
  if (!takenAt) return null;
  const isoLike = /[Zz]|[+-]\d{2}:?\d{2}$/.test(takenAt)
    ? takenAt
    : `${takenAt.replace(" ", "T")}Z`;
  const ms = new Date(isoLike).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** 簇代表选择：weightedScore desc，并列时 takenAt asc */
function pickRepresentative(members: EnrichedCandidate[]): EnrichedCandidate {
  // members 至少 1 个；外部已保证。
  const first = members[0];
  if (!first) {
    throw new Error("pickRepresentative: empty cluster");
  }
  let rep = first;
  let repTime = parseTakenAtMs(rep.takenAt) ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i < members.length; i++) {
    const cand = members[i];
    if (!cand) continue;
    if (cand.weightedScore > rep.weightedScore) {
      rep = cand;
      repTime = parseTakenAtMs(cand.takenAt) ?? Number.POSITIVE_INFINITY;
      continue;
    }
    if (cand.weightedScore === rep.weightedScore) {
      const candTime = parseTakenAtMs(cand.takenAt) ?? Number.POSITIVE_INFINITY;
      if (candTime < repTime) {
        rep = cand;
        repTime = candTime;
      }
    }
  }
  return rep;
}

// ---- 简单 Union-Find（簇粒度）----

function makeUnionFind(n: number): {
  parent: number[];
  find: (i: number) => number;
  union: (i: number, j: number) => void;
} {
  const parent = Array.from({ length: n }, (_, idx) => idx);
  function find(i: number): number {
    let cur = i;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur] as number] as number; // path compression
      cur = parent[cur] as number;
    }
    return cur;
  }
  function union(i: number, j: number): void {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }
  return { parent, find, union };
}

/**
 * 主题去重聚类（两步：dirname 时间窗 + GPS union-find）。
 *
 * 算法（Step 1）：
 *   1. takenAt 为 null 的候选直接独立成簇（无法判定时间相邻）。
 *   2. 其余候选按 dirname 分组；每个 dirname 桶内按 takenAt 升序，
 *      沿时间轴用"链式"扫描分簇——只要相邻两张 |Δt| ≤ windowMinutes
 *      就归入当前簇，否则开新簇。
 *   3. 每簇选代表（weightedScore desc，takenAt asc 打破并列），
 *      其余成员 photoId 按 takenAt 升序写入 clusterSiblingIds。
 *   4. 输出仅含每簇代表，按 weightedScore desc 排序。
 *
 * 算法（Step 2）：在 Step 1 输出的 clusters 上做 GPS pairwise union：
 *   - 对 Ci, Cj 中任意照片对 (Pa, Pb)，若 haversine ≤ gpsRadiusMeters AND |Δt| ≤ gpsWindowHours
 *     → union(Ci, Cj)
 *   - 合并后每个连通分量重选代表（weightedScore desc）
 *
 * 注：链式扫描语义为"任意相邻两张 ≤ window 即同簇"，所以一个簇
 * 的首尾时间差可以超过 window；这与"相邻照片同主题"的直觉一致。
 */
export function clusterByDirnameAndTime(
  candidates: EnrichedCandidate[],
  options: ClusterOptions = {},
): ClusteredCandidate[] {
  const windowMs = (options.windowMinutes ?? 60) * 60 * 1000;
  const gpsRadiusMeters = options.gpsRadiusMeters ?? 500;
  const gpsWindowMs = (options.gpsWindowHours ?? 24) * 3600 * 1000;

  if (candidates.length === 0) return [];

  // ---- Step 1: 按 dirname + 时间窗链式扫描 ----
  const byDir = new Map<string, EnrichedCandidate[]>();
  const nullTimeSingletons: EnrichedCandidate[] = [];

  for (const c of candidates) {
    if (parseTakenAtMs(c.takenAt) === null) {
      nullTimeSingletons.push(c);
      continue;
    }
    const dir = path.posix.dirname(c.filePath);
    const bucket = byDir.get(dir);
    if (bucket) {
      bucket.push(c);
    } else {
      byDir.set(dir, [c]);
    }
  }

  // Step 1 输出：每个簇（所有成员）
  const step1Clusters: EnrichedCandidate[][] = [];

  // takenAt 为 null 的候选：每张独立成簇
  for (const solo of nullTimeSingletons) {
    step1Clusters.push([solo]);
  }

  // 每个 dirname 桶内按时间链式分簇
  for (const bucket of byDir.values()) {
    bucket.sort((a, b) => {
      const ta = parseTakenAtMs(a.takenAt) ?? 0;
      const tb = parseTakenAtMs(b.takenAt) ?? 0;
      return ta - tb;
    });

    let cluster: EnrichedCandidate[] = [];
    let prevMs = 0;

    const flush = () => {
      if (cluster.length === 0) return;
      step1Clusters.push([...cluster]);
      cluster = [];
    };

    for (const item of bucket) {
      const ms = parseTakenAtMs(item.takenAt);
      if (ms === null) {
        flush();
        step1Clusters.push([item]);
        continue;
      }
      if (cluster.length === 0) {
        cluster.push(item);
        prevMs = ms;
        continue;
      }
      if (ms - prevMs <= windowMs) {
        cluster.push(item);
        prevMs = ms;
      } else {
        flush();
        cluster.push(item);
        prevMs = ms;
      }
    }
    flush();
  }

  // ---- Step 2: GPS pairwise union-find（簇粒度）----
  const n = step1Clusters.length;
  const uf = makeUnionFind(n);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (uf.find(i) === uf.find(j)) continue; // 已在同一连通分量，跳过

      const clusterI = step1Clusters[i];
      const clusterJ = step1Clusters[j];
      if (!clusterI || !clusterJ) continue;

      // 检查 Ci, Cj 中任意一对照片是否满足 GPS 谓词
      let shouldMerge = false;
      outer: for (const pa of clusterI) {
        if (pa.latitude === null || pa.longitude === null) continue;
        const tA = parseTakenAtMs(pa.takenAt);
        if (tA === null) continue;

        for (const pb of clusterJ) {
          if (pb.latitude === null || pb.longitude === null) continue;
          const tB = parseTakenAtMs(pb.takenAt);
          if (tB === null) continue;

          const dist = haversineMeters(pa.latitude, pa.longitude, pb.latitude, pb.longitude);
          const timeDiff = Math.abs(tA - tB);

          if (dist <= gpsRadiusMeters && timeDiff <= gpsWindowMs) {
            shouldMerge = true;
            break outer;
          }
        }
      }

      if (shouldMerge) {
        uf.union(i, j);
      }
    }
  }

  // ---- 按 union-find 结果合并 clusters ----
  const componentMap = new Map<number, EnrichedCandidate[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const existing = componentMap.get(root);
    const cluster = step1Clusters[i];
    if (!cluster) continue;
    if (existing) {
      for (const m of cluster) existing.push(m);
    } else {
      componentMap.set(root, [...cluster]);
    }
  }

  // ---- 每个连通分量重选代表，输出 ClusteredCandidate ----
  const result: ClusteredCandidate[] = [];
  for (const members of componentMap.values()) {
    const rep = pickRepresentative(members);
    // 同簇成员（不含代表）按 takenAt 升序
    const siblingIds = members
      .filter((m) => m.photoId !== rep.photoId)
      .sort((a, b) => (parseTakenAtMs(a.takenAt) ?? 0) - (parseTakenAtMs(b.takenAt) ?? 0))
      .map((m) => m.photoId);
    result.push({ ...rep, clusterSiblingIds: siblingIds });
  }

  // 输出按 weightedScore desc
  result.sort((a, b) => b.weightedScore - a.weightedScore);
  return result;
}

/**
 * 主题去重聚类：把候选池里"同一目录 + 拍摄时间相邻"的照片归为一簇，
 * 每簇只保留一个代表，避免每日精选 top 20 被同一组场景占据多个名额。
 *
 * 假设：filePath 已规范化为 POSIX 形式（local storage adapter 当前唯一，
 * 输出始终为 POSIX）。内部一律使用 path.posix.dirname 切割，
 * 不处理 Windows 反斜杠。
 *
 * 触发条件（仅当两者同时满足才同簇）：
 *   - dirname(file_path) 相同
 *   - |Δt| ≤ windowMinutes（默认 60 分钟，闭区间）
 *
 * OUT-OF-SCOPE：跨年份/跨 dirname/Δt > 60min 不触发同簇。
 *
 * 不足策略：聚类后簇数 < maxN 直接接受 N<20，由调用方继续走原有
 * 截断逻辑（不做 K 回退，保护 4 源等比混采契约）。
 */

import path from "node:path";
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

/**
 * 主题去重聚类（dirname + 时间窗）。
 *
 * 算法：
 *   1. takenAt 为 null 的候选直接独立成簇（无法判定时间相邻）。
 *   2. 其余候选按 dirname 分组；每个 dirname 桶内按 takenAt 升序，
 *      沿时间轴用"链式"扫描分簇——只要相邻两张 |Δt| ≤ windowMinutes
 *      就归入当前簇，否则开新簇。
 *   3. 每簇选代表（weightedScore desc，takenAt asc 打破并列），
 *      其余成员 photoId 按 takenAt 升序写入 clusterSiblingIds。
 *   4. 输出仅含每簇代表，按 weightedScore desc 排序。
 *
 * 注：链式扫描语义为"任意相邻两张 ≤ window 即同簇"，所以一个簇
 * 的首尾时间差可以超过 window；这与"相邻照片同主题"的直觉一致。
 */
export function clusterByDirnameAndTime(
  candidates: EnrichedCandidate[],
  options: ClusterOptions = {},
): ClusteredCandidate[] {
  const windowMs = (options.windowMinutes ?? 60) * 60 * 1000;
  if (candidates.length === 0) return [];

  // 按 dirname 分桶；takenAt 为 null 的单独标记
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

  const result: ClusteredCandidate[] = [];

  // takenAt 为 null 的候选：每张独立成簇，clusterSiblingIds = []
  for (const solo of nullTimeSingletons) {
    result.push({ ...solo, clusterSiblingIds: [] });
  }

  // 每个 dirname 桶内按时间链式分簇
  for (const bucket of byDir.values()) {
    // 升序排序（takenAt 已确保非 null 且可解析）
    bucket.sort((a, b) => {
      const ta = parseTakenAtMs(a.takenAt) ?? 0;
      const tb = parseTakenAtMs(b.takenAt) ?? 0;
      return ta - tb;
    });

    let cluster: EnrichedCandidate[] = [];
    let prevMs = 0;

    const flush = () => {
      if (cluster.length === 0) return;
      const rep = pickRepresentative(cluster);
      const siblingIds = cluster.filter((m) => m.photoId !== rep.photoId).map((m) => m.photoId);
      result.push({ ...rep, clusterSiblingIds: siblingIds });
      cluster = [];
    };

    for (const item of bucket) {
      const ms = parseTakenAtMs(item.takenAt);
      if (ms === null) {
        // 理论上不会进到这里（前面已剔除），但保底处理
        flush();
        result.push({ ...item, clusterSiblingIds: [] });
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

  // 输出按 weightedScore desc
  result.sort((a, b) => b.weightedScore - a.weightedScore);
  return result;
}

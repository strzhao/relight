/**
 * 验收测试：Phase 2 quality-aware 聚类辅助函数
 *
 * 设计契约：patterns.md「centroid 雪球 + 垃圾桶 cluster」三件套修复
 * - qualityOf: bbox + detection_score 反推 quality
 * - centroidWeightFor: HIGH=1.0 / MED=配置 / LOW=0
 * - updateCentroidWeighted: 加权 centroid 更新，weight=0 时不变
 * - clusterConfigForQuality: LOW face 用更严 minThreshold
 */
import { describe, expect, it } from "vitest";
import {
  type ClusterConfig,
  type QualityConfig,
  centroidWeightFor,
  clusterConfigForQuality,
  qualityOf,
  updateCentroidWeighted,
} from "../clustering";

const Q: QualityConfig = {
  highBboxSize: 200,
  highDetectionScore: 0.8,
  lowDetectionScore: 0.65,
};

const BASE_CFG: ClusterConfig = {
  mergeThreshold: 0.85,
  minThreshold: 0.55,
  midZoneFilter: true,
};

describe("qualityOf — bbox+detection 反推三级", () => {
  it("detection < 0.65 → low（不论 bbox 多大）", () => {
    expect(qualityOf(0.5, 400, 400, Q)).toBe("low");
    expect(qualityOf(0.64, 100, 100, Q)).toBe("low");
  });
  it("bbox >= 200 + detection >= 0.8 → high", () => {
    expect(qualityOf(0.85, 250, 250, Q)).toBe("high");
    expect(qualityOf(0.95, 200, 200, Q)).toBe("high");
  });
  it("中间 → medium", () => {
    expect(qualityOf(0.75, 150, 150, Q)).toBe("medium");
    expect(qualityOf(0.7, 300, 300, Q)).toBe("medium"); // bbox 大但 detection 中等
    expect(qualityOf(0.9, 150, 150, Q)).toBe("medium"); // detection 高但 bbox 小
  });
  it("边界值：detection 等于阈值", () => {
    expect(qualityOf(0.65, 100, 100, Q)).toBe("medium"); // 0.65 不算 low
    expect(qualityOf(0.8, 200, 200, Q)).toBe("high"); // 0.8 算 high
  });
  it("正方形要求：单边小于 highBboxSize → medium 不升 high", () => {
    expect(qualityOf(0.85, 200, 150, Q)).toBe("medium"); // h<200
    expect(qualityOf(0.85, 150, 200, Q)).toBe("medium"); // w<200
  });
});

describe("centroidWeightFor", () => {
  it("HIGH → 1.0", () => {
    expect(centroidWeightFor("high", 0.5)).toBe(1.0);
  });
  it("MED → 配置值", () => {
    expect(centroidWeightFor("medium", 0.5)).toBe(0.5);
    expect(centroidWeightFor("medium", 0.3)).toBe(0.3);
    expect(centroidWeightFor("medium", 0)).toBe(0);
  });
  it("LOW → 0（不论 MED 权重配置）", () => {
    expect(centroidWeightFor("low", 0.5)).toBe(0);
    expect(centroidWeightFor("low", 1.0)).toBe(0);
  });
});

describe("updateCentroidWeighted", () => {
  function vec(values: number[]): Float32Array {
    const arr = new Float32Array(values);
    let s = 0;
    for (const v of arr) s += v * v;
    const n = Math.sqrt(s);
    if (n === 0) return arr;
    for (let i = 0; i < arr.length; i++) arr[i] = (arr[i] ?? 0) / n;
    return arr;
  }

  it("weight=0 → 返回原 centroid（LOW face 不污染）", () => {
    const old = vec([1, 0, 0]);
    const newE = vec([0, 1, 0]);
    const out = updateCentroidWeighted(old, 5, newE, 0);
    expect(Array.from(out)).toEqual(Array.from(old));
  });

  it("weight=1.0 + oldCount=1 → 等价于简单平均后归一化", () => {
    const old = vec([1, 0, 0]);
    const newE = vec([0, 1, 0]);
    const out = updateCentroidWeighted(old, 1, newE, 1.0);
    // (1,0,0) + (0,1,0) /2 = (0.5, 0.5, 0) → 归一 = (1/√2, 1/√2, 0)
    expect(out[0]).toBeCloseTo(1 / Math.sqrt(2), 4);
    expect(out[1]).toBeCloseTo(1 / Math.sqrt(2), 4);
    expect(out[2]).toBeCloseTo(0, 4);
  });

  it("weight=0.5 比 weight=1.0 更接近 oldCentroid（MED 弱于 HIGH）", () => {
    const old = vec([1, 0, 0]);
    const newE = vec([0, 1, 0]);
    const outHigh = updateCentroidWeighted(old, 10, newE, 1.0);
    const outMed = updateCentroidWeighted(old, 10, newE, 0.5);
    // outMed 应该更接近 old (1,0,0)
    expect(outMed[0]!).toBeGreaterThan(outHigh[0]!);
    expect(outMed[1]!).toBeLessThan(outHigh[1]!);
  });

  it("大 oldCount → 新 embedding 影响小（centroid 稳定）", () => {
    const old = vec([1, 0, 0]);
    const newE = vec([0, 1, 0]);
    const outSmall = updateCentroidWeighted(old, 1, newE, 1.0);
    const outLarge = updateCentroidWeighted(old, 100, newE, 1.0);
    expect(outLarge[0]!).toBeGreaterThan(outSmall[0]!);
    expect(outLarge[1]!).toBeLessThan(outSmall[1]!);
  });

  it("输出始终 L2-normalized", () => {
    const old = vec([1, 0, 0]);
    const newE = vec([0, 1, 0]);
    const out = updateCentroidWeighted(old, 5, newE, 0.5);
    let s = 0;
    for (const v of out) s += v * v;
    expect(Math.sqrt(s)).toBeCloseTo(1.0, 4);
  });
});

describe("clusterConfigForQuality", () => {
  it("HIGH 用 base 配置不变", () => {
    expect(clusterConfigForQuality(BASE_CFG, "high")).toEqual(BASE_CFG);
  });
  it("MED 用 base 配置不变", () => {
    expect(clusterConfigForQuality(BASE_CFG, "medium")).toEqual(BASE_CFG);
  });
  it("LOW minThreshold 提升到 ≥ 0.65（不污染大 cluster）", () => {
    const out = clusterConfigForQuality(BASE_CFG, "low");
    expect(out.minThreshold).toBeGreaterThanOrEqual(0.65);
    expect(out.mergeThreshold).toBe(BASE_CFG.mergeThreshold);
    expect(out.midZoneFilter).toBe(BASE_CFG.midZoneFilter);
  });
  it("LOW 不降低已经更严的 minThreshold", () => {
    const strict = { ...BASE_CFG, minThreshold: 0.8 };
    const out = clusterConfigForQuality(strict, "low");
    expect(out.minThreshold).toBe(0.8); // 不被 0.65 拉低
  });
});

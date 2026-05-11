import { describe, expect, it } from "vitest";
import { type PersonCentroid, assignToPerson, cosineSim, updateCentroid } from "../clustering";

function unitVec(seed: number, dim = 8): Float32Array {
  // 简单确定性单位向量：以 seed 起步，再 L2 normalize
  const arr = new Float32Array(dim);
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    const v = Math.sin(seed * (i + 1));
    arr[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  for (let i = 0; i < dim; i++) arr[i] = (arr[i] ?? 0) / norm;
  return arr;
}

describe("cosineSim", () => {
  it("两单位向量 cosine = dot", () => {
    const a = unitVec(1);
    const b = unitVec(1);
    expect(cosineSim(a, b)).toBeCloseTo(1, 5);
  });

  it("正交向量 cosine = 0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSim(a, b)).toBeCloseTo(0, 6);
  });

  it("反向单位向量 cosine = -1", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSim(a, b)).toBe(-1);
  });

  it("长度不一致抛错", () => {
    expect(() => cosineSim(new Float32Array([1]), new Float32Array([1, 0]))).toThrow();
  });
});

describe("assignToPerson", () => {
  const candidates: PersonCentroid[] = [
    { id: "p1", centroid: new Float32Array([1, 0, 0]), memberCount: 5 },
    { id: "p2", centroid: new Float32Array([0, 1, 0]), memberCount: 3 },
  ];

  it("空 candidates 返回 null + bestSim=-1", () => {
    const r = assignToPerson(unitVec(1), [], 0.5);
    expect(r.matchedPersonId).toBeNull();
    expect(r.bestSim).toBe(-1);
  });

  it("命中阈值之上 → 归并", () => {
    // 与 p1 完全一致，cosine=1
    const r = assignToPerson(new Float32Array([1, 0, 0]), candidates, 0.5);
    expect(r.matchedPersonId).toBe("p1");
    expect(r.bestSim).toBeCloseTo(1, 5);
  });

  it("阈值边界 0.49 → 不归并；0.51 → 归并", () => {
    const cand: PersonCentroid[] = [
      { id: "p1", centroid: new Float32Array([1, 0, 0]), memberCount: 1 },
    ];
    // 构造 cosine = 0.49 的向量
    const v049 = new Float32Array([0.49, Math.sqrt(1 - 0.49 * 0.49), 0]);
    const r1 = assignToPerson(v049, cand, 0.5);
    expect(r1.matchedPersonId).toBeNull();
    expect(r1.bestSim).toBeCloseTo(0.49, 4);

    const v051 = new Float32Array([0.51, Math.sqrt(1 - 0.51 * 0.51), 0]);
    const r2 = assignToPerson(v051, cand, 0.5);
    expect(r2.matchedPersonId).toBe("p1");
    expect(r2.bestSim).toBeCloseTo(0.51, 4);
  });
});

describe("updateCentroid", () => {
  it("n=1 + new embedding，centroid 在两者之间，且 L2 normalized", () => {
    const old = new Float32Array([1, 0, 0]);
    const fresh = new Float32Array([0, 1, 0]);
    const out = updateCentroid(old, 1, fresh);
    // 平均 (0.5, 0.5, 0) → normalize → (0.707, 0.707, 0)
    expect(out[0] ?? 0).toBeCloseTo(Math.SQRT1_2, 3);
    expect(out[1] ?? 0).toBeCloseTo(Math.SQRT1_2, 3);
    expect(out[2] ?? 0).toBeCloseTo(0, 3);
    let sum = 0;
    for (const v of out) sum += v * v;
    expect(Math.sqrt(sum)).toBeCloseTo(1, 5);
  });

  it("n 增大时新 embedding 对 centroid 影响减小", () => {
    const old = new Float32Array([1, 0, 0]);
    const fresh = new Float32Array([0, 1, 0]);
    const c1 = updateCentroid(old, 1, fresh);
    const c10 = updateCentroid(old, 10, fresh);
    // 加入第 11 个点时，centroid 应该比加入第 2 个点更接近 old
    expect(c10[0] ?? 0).toBeGreaterThan(c1[0] ?? 0);
  });

  it("两个完全一致的向量更新后 centroid 不变", () => {
    const v = new Float32Array([Math.SQRT1_2, Math.SQRT1_2, 0]);
    const out = updateCentroid(v, 5, v);
    expect(out[0] ?? 0).toBeCloseTo(v[0] ?? 0, 5);
    expect(out[1] ?? 0).toBeCloseTo(v[1] ?? 0, 5);
  });

  it("维度不一致抛错", () => {
    expect(() => updateCentroid(new Float32Array([1]), 1, new Float32Array([1, 0]))).toThrow();
  });
});

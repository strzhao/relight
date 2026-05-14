/**
 * 验收测试 R-KMEANS: miniBatchKmeansCosine 数学性质验证
 *
 * 设计契约（state.md「函数签名」+「mini-batch k-means」节）：
 *
 * miniBatchKmeansCosine(embeddings, weights, k, maxIters):
 *   - 输出长度 = k
 *   - 输出 centroid 均 L2-normalized（norm ∈ [0.95, 1.05]）
 *   - 总 memberCount = 输入数（每个 embedding 归入且仅归入一个 cluster）
 *   - 两个明显分簇时，收敛后各 centroid 接近对应 cluster mean
 *   - k=1 → 单 centroid 接近全部 embeddings 加权平均
 *
 * 策略：纯算法函数，无需 mock 外部依赖。
 */
import { describe, expect, it } from "vitest";
import type { Prototype } from "../prototypes";

// ---------------------------------------------------------------------------
// 类型声明
// ---------------------------------------------------------------------------

type MiniBatchKmeansCosineResult = Array<{
  centroid: Float32Array;
  weightSum: number;
  memberCount: number;
}>;

type MiniBatchKmeansCosine = (
  embeddings: Float32Array[],
  weights: number[],
  k: number,
  maxIters: number,
) => MiniBatchKmeansCosineResult;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * L2 归一化 Float32Array
 */
function l2Normalize(arr: Float32Array): Float32Array {
  let sum = 0;
  for (const v of arr) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return new Float32Array(arr.length);
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = (arr[i] ?? 0) / norm;
  return out;
}

/**
 * 计算 L2 范数
 */
function l2Norm(arr: Float32Array): number {
  let sum = 0;
  for (const v of arr) sum += v * v;
  return Math.sqrt(sum);
}

/**
 * cosine similarity（两向量均 L2-normalized 时等于 dot product）
 */
function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/**
 * 构造方向确定的单位向量（基于旋转角度）。
 * dim=512，主轴 i=0,1 的分量由 angle 决定，其余分量为 0 后再归一化。
 */
function makeDirectedEmb(angle: number, dim = 512): Float32Array {
  const arr = new Float32Array(dim);
  // 用 cos/sin 把方向放在前两维，然后归一化
  arr[0] = Math.cos(angle);
  arr[1] = Math.sin(angle);
  return l2Normalize(arr);
}

/**
 * 在给定方向附近加细微扰动（cluster 内部成员）
 */
function makeClusterMember(centerAngle: number, noiseScale = 0.02, dim = 512): Float32Array {
  const arr = new Float32Array(dim);
  arr[0] = Math.cos(centerAngle) + (Math.random() - 0.5) * noiseScale;
  arr[1] = Math.sin(centerAngle) + (Math.random() - 0.5) * noiseScale;
  return l2Normalize(arr);
}

type _ProtoUnused = Prototype;

// ---------------------------------------------------------------------------
// R-KMEANS-A: 两个明显分簇收敛
// ---------------------------------------------------------------------------

describe("R-KMEANS-A: k=2 + 两个明显分簇，收敛后 centroids 接近各 cluster mean", () => {
  it("A-1: cluster 内 cosine ≈ 0.99，cluster 间 cosine ≈ 0.3 → 2 个 centroid 分别接近两 cluster mean", async () => {
    const { miniBatchKmeansCosine } = (await import("../prototypes")) as {
      miniBatchKmeansCosine: MiniBatchKmeansCosine;
    };

    // Cluster A: 方向 angle=0（沿 x 轴正方向）
    const clusterAAngle = 0;
    // Cluster B: 方向 angle=π/2（沿 y 轴正方向，cosine(A,B)=cos(90°)=0）
    const clusterBAngle = Math.PI / 2;

    // 确认两 cluster 方向的 cosine 确实很小（≈ 0）
    const centerA = makeDirectedEmb(clusterAAngle);
    const centerB = makeDirectedEmb(clusterBAngle);
    expect(cosineSim(centerA, centerB)).toBeCloseTo(0, 2);

    // 每个 cluster 各 6 个成员（cluster 内 cosine 极高）
    const embeddingsA = Array.from({ length: 6 }, () => makeClusterMember(clusterAAngle, 0.005));
    const embeddingsB = Array.from({ length: 6 }, () => makeClusterMember(clusterBAngle, 0.005));

    // 确认 cluster 内 cosine ≈ 0.999
    for (const emb of embeddingsA) {
      expect(cosineSim(emb, centerA)).toBeGreaterThan(0.97);
    }

    const allEmbeddings = [...embeddingsA, ...embeddingsB];
    const weights = new Array(allEmbeddings.length).fill(1.0) as number[];

    const result = miniBatchKmeansCosine(allEmbeddings, weights, 2, 30);

    expect(result).toHaveLength(2);

    // 对 2 个 centroid 做分配：哪个更接近 centerA，哪个更接近 centerB
    const [c0, c1] = result;
    const c0Emb = c0!.centroid;
    const c1Emb = c1!.centroid;

    const c0cosA = cosineSim(c0Emb, centerA);
    const c0cosB = cosineSim(c0Emb, centerB);
    const c1cosA = cosineSim(c1Emb, centerA);
    const c1cosB = cosineSim(c1Emb, centerB);

    // 两个 centroid 分别对应两个 cluster
    const c0IsA = c0cosA > c0cosB;
    const c1IsB = c1cosB > c1cosA;

    if (c0IsA) {
      // c0 对应 cluster A，c1 对应 cluster B
      expect(c0cosA).toBeGreaterThan(0.9);
      expect(c1cosB).toBeGreaterThan(0.9);
    } else {
      // c0 对应 cluster B，c1 对应 cluster A
      expect(c0cosB).toBeGreaterThan(0.9);
      expect(c1cosA).toBeGreaterThan(0.9);
    }

    // 两个 centroid 之间的 cosine 应该很小（≈ 0）
    expect(cosineSim(c0Emb, c1Emb)).toBeCloseTo(0, 1);
  });
});

// ---------------------------------------------------------------------------
// R-KMEANS-B: 输出 centroid L2-normalized
// ---------------------------------------------------------------------------

describe("R-KMEANS-B: 输出 centroid 均 L2-normalized", () => {
  it("B-1: k=3，所有输出 centroid 的 L2 norm ∈ [0.95, 1.05]", async () => {
    const { miniBatchKmeansCosine } = (await import("../prototypes")) as {
      miniBatchKmeansCosine: MiniBatchKmeansCosine;
    };

    const k = 3;
    const angles = [0, Math.PI / 3, (2 * Math.PI) / 3];
    const embeddings: Float32Array[] = [];

    for (const angle of angles) {
      for (let i = 0; i < 4; i++) {
        embeddings.push(makeClusterMember(angle, 0.01));
      }
    }

    const weights = new Array(embeddings.length).fill(1.0) as number[];
    const result = miniBatchKmeansCosine(embeddings, weights, k, 20);

    expect(result).toHaveLength(k);

    for (const cluster of result) {
      const norm = l2Norm(cluster.centroid);
      expect(norm, `centroid norm 应在 [0.95, 1.05]，实际 ${norm}`).toBeGreaterThan(0.95);
      expect(norm, `centroid norm 应在 [0.95, 1.05]，实际 ${norm}`).toBeLessThan(1.05);
    }
  });

  it("B-2: k=1，单 centroid 也是 L2-normalized", async () => {
    const { miniBatchKmeansCosine } = (await import("../prototypes")) as {
      miniBatchKmeansCosine: MiniBatchKmeansCosine;
    };

    const embeddings = Array.from({ length: 5 }, (_, i) => makeClusterMember(i * 0.1, 0.1));
    const weights = [1.0, 0.5, 1.0, 0.5, 1.0];

    const result = miniBatchKmeansCosine(embeddings, weights, 1, 20);

    expect(result).toHaveLength(1);
    const norm = l2Norm(result[0]!.centroid);
    expect(norm).toBeGreaterThan(0.95);
    expect(norm).toBeLessThan(1.05);
  });
});

// ---------------------------------------------------------------------------
// R-KMEANS-C: 输出结构正确性
// ---------------------------------------------------------------------------

describe("R-KMEANS-C: 输出长度 = k，memberCount 和 weightSum 合理", () => {
  it("C-1: 输出数组长度恰好 = k", async () => {
    const { miniBatchKmeansCosine } = (await import("../prototypes")) as {
      miniBatchKmeansCosine: MiniBatchKmeansCosine;
    };

    for (const k of [1, 2, 3, 5]) {
      const embeddings = Array.from({ length: k * 4 }, (_, i) =>
        makeClusterMember(i * (Math.PI / (k * 4)), 0.02),
      );
      const weights = new Array(embeddings.length).fill(1.0) as number[];
      const result = miniBatchKmeansCosine(embeddings, weights, k, 20);
      expect(result, `k=${k} 时输出长度应为 ${k}`).toHaveLength(k);
    }
  });

  it("C-2: 每个 cluster 的 memberCount > 0 且 weightSum > 0", async () => {
    const { miniBatchKmeansCosine } = (await import("../prototypes")) as {
      miniBatchKmeansCosine: MiniBatchKmeansCosine;
    };

    const k = 2;
    // 每个 cluster 至少 k 个成员，保证每个 centroid 至少有 1 个成员
    const embeddings = [
      makeDirectedEmb(0), // cluster A 方向
      makeDirectedEmb(0.01), // cluster A 附近
      makeDirectedEmb(Math.PI / 2), // cluster B 方向
      makeDirectedEmb(Math.PI / 2 + 0.01), // cluster B 附近
    ];
    const weights = [1.0, 1.0, 1.0, 1.0];

    const result = miniBatchKmeansCosine(embeddings, weights, k, 20);

    for (const cluster of result) {
      expect(cluster.memberCount).toBeGreaterThan(0);
      expect(cluster.weightSum).toBeGreaterThan(0);
    }
  });

  it("C-3: 所有 cluster 的 memberCount 之和 = 输入 embedding 数", async () => {
    const { miniBatchKmeansCosine } = (await import("../prototypes")) as {
      miniBatchKmeansCosine: MiniBatchKmeansCosine;
    };

    const n = 12;
    const k = 3;
    const embeddings = Array.from({ length: n }, (_, i) =>
      makeClusterMember(i * (Math.PI / n) * 2, 0.02),
    );
    const weights = new Array(n).fill(1.0) as number[];

    const result = miniBatchKmeansCosine(embeddings, weights, k, 20);

    const totalMemberCount = result.reduce((acc, c) => acc + c.memberCount, 0);
    expect(totalMemberCount).toBe(n);
  });

  it("C-4: 所有 cluster 的 weightSum 之和 = 输入 weights 总和", async () => {
    const { miniBatchKmeansCosine } = (await import("../prototypes")) as {
      miniBatchKmeansCosine: MiniBatchKmeansCosine;
    };

    const embeddings = [
      makeDirectedEmb(0),
      makeDirectedEmb(0.05),
      makeDirectedEmb(Math.PI / 2),
      makeDirectedEmb(Math.PI / 2 + 0.05),
    ];
    const weights = [1.0, 0.5, 1.0, 0.5];
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    const result = miniBatchKmeansCosine(embeddings, weights, 2, 20);

    const totalResultWeightSum = result.reduce((acc, c) => acc + c.weightSum, 0);
    expect(totalResultWeightSum).toBeCloseTo(totalWeight, 4);
  });
});

// ---------------------------------------------------------------------------
// R-KMEANS-D: 极端 k=1
// ---------------------------------------------------------------------------

describe("R-KMEANS-D: 极端 k=1 — 单 centroid 接近全部 embeddings 加权均值", () => {
  it("D-1: k=1 + 多个 embeddings → 单 centroid 方向与加权平均后归一化方向接近", async () => {
    const { miniBatchKmeansCosine } = (await import("../prototypes")) as {
      miniBatchKmeansCosine: MiniBatchKmeansCosine;
    };

    // 用 2D 空间精确控制（前两维有值，其余为 0）
    const DIM = 512;
    const angles = [0, Math.PI / 6, Math.PI / 4, Math.PI / 3]; // 同侧（第一象限）
    const embeddings = angles.map((a) => makeDirectedEmb(a, DIM));
    const weights = [1.0, 1.0, 1.0, 1.0];

    const result = miniBatchKmeansCosine(embeddings, weights, 1, 20);

    expect(result).toHaveLength(1);
    const centroid = result[0]!.centroid;

    // 计算加权平均后归一化（手动）
    const weightedSum = new Float32Array(DIM);
    for (let i = 0; i < embeddings.length; i++) {
      const w = weights[i] ?? 1.0;
      for (let d = 0; d < DIM; d++) {
        weightedSum[d] = (weightedSum[d] ?? 0) + (embeddings[i]?.[d] ?? 0) * w;
      }
    }
    const expectedCentroid = l2Normalize(weightedSum);

    // centroid 应与期望方向接近（cosine > 0.95）
    const cos = cosineSim(centroid, expectedCentroid);
    expect(
      cos,
      `k=1 centroid 与加权均值归一化方向的 cosine 应 > 0.95，实际 ${cos}`,
    ).toBeGreaterThan(0.95);
  });

  it("D-2: k=1，memberCount=输入 embedding 数，weightSum=输入 weights 总和", async () => {
    const { miniBatchKmeansCosine } = (await import("../prototypes")) as {
      miniBatchKmeansCosine: MiniBatchKmeansCosine;
    };

    const n = 7;
    const embeddings = Array.from({ length: n }, (_, i) => makeClusterMember(i * 0.2, 0.05));
    const weights = Array.from({ length: n }, (_, i) => 0.5 + i * 0.1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    const result = miniBatchKmeansCosine(embeddings, weights, 1, 20);

    expect(result[0]!.memberCount).toBe(n);
    expect(result[0]!.weightSum).toBeCloseTo(totalWeight, 4);
  });
});

// ---------------------------------------------------------------------------
// R-KMEANS-E: maxIters 限制
// ---------------------------------------------------------------------------

describe("R-KMEANS-E: maxIters 参数确实限制迭代次数", () => {
  it("E-1: maxIters=1 不崩溃，返回合法输出", async () => {
    const { miniBatchKmeansCosine } = (await import("../prototypes")) as {
      miniBatchKmeansCosine: MiniBatchKmeansCosine;
    };

    const embeddings = Array.from({ length: 4 }, (_, i) =>
      makeClusterMember(i * Math.PI * 0.3, 0.1),
    );
    const weights = [1.0, 1.0, 1.0, 1.0];

    const result = miniBatchKmeansCosine(embeddings, weights, 2, 1);
    expect(result).toHaveLength(2);

    for (const cluster of result) {
      const norm = l2Norm(cluster.centroid);
      expect(norm).toBeGreaterThan(0.5); // 不要求收敛，但 centroid 不能为零向量
    }
  });
});

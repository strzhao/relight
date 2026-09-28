/**
 * 单测：lib/wallpaper/native-canvas.ts — computeNativeCanvas（20260928 单腿原生比例 T1）
 *
 * 契约（state.md ## 设计文档 D1 / ## 契约规约 实现绑定表）：
 *   computeNativeCanvas(origW, origH) → {width, height}
 *     - R = clamp(max/min, 1.0, 2.40)（竖图横图统一处理，朝向由原图决定与 R 解耦）
 *     - BUDGET = 1177600（= 736×1600 注意力 token 等价预算）；MIN_SHORT = 704
 *     - 主循环 L 从 1600 按 32 递减：s = round32(L/R)，L*s ≤ BUDGET 且 s ≥ MIN_SHORT 即返回
 *     - 兜底（极端比例）：L = round32(min(704R, BUDGET/704))，s = 704，保证像素 ≤ BUDGET
 *     - 尺寸恒为 32 倍数；参考输出（design 逐字）：
 *       1:1→1056×1056；3:2→1312×864；16:9→1440×800；9:16→800×1440；
 *       4:3→1248×928；3:4→928×1248；2.35:1→1664×704
 *   场景 2.P1-P4 谓词（SSOT）：
 *     - P1 样本集（1:1、4:3、3:2、16:9、9:16、21:9、20000×10000）∀ w%32==0 && h%32==0
 *     - P2 ∀ w*h ≤ 1177600 && ≥ 1177600/2
 *     - P3 16:9 输入输出比例偏差 ≤2%
 *     - P4 9:16 输入输出仍竖版（h>w）且比例偏差 ≤2%（kill 固定横版画布 No-op）
 *   设计注：≤2% 偏差性质断言仅适用于未触 R clamp 边界的样本（触边界样本由精确 fixture 断言锁定）。
 */
import { describe, expect, it } from "vitest";
import { computeNativeCanvas } from "../lib/wallpaper/native-canvas";

const BUDGET = 1_177_600;
const BUDGET_HALF = BUDGET / 2;

describe("computeNativeCanvas 精确 fixture 表（design D1 参考输出逐字）", () => {
  const exactCases: Array<{
    name: string;
    origW: number;
    origH: number;
    width: number;
    height: number;
  }> = [
    { name: "1:1 正方形", origW: 3000, origH: 3000, width: 1056, height: 1056 },
    { name: "3:2 横图", origW: 3000, origH: 2000, width: 1312, height: 864 },
    { name: "16:9 横图", origW: 1920, origH: 1080, width: 1440, height: 800 },
    { name: "9:16 竖图（朝向保持竖版）", origW: 1080, origH: 1920, width: 800, height: 1440 },
    { name: "4:3 横图", origW: 4000, origH: 3000, width: 1248, height: 928 },
    { name: "3:4 竖图", origW: 3000, origH: 4000, width: 928, height: 1248 },
    { name: "2.35:1 超宽（兜底分支）", origW: 2350, origH: 1000, width: 1664, height: 704 },
    { name: "R clamp 下边界 2.40", origW: 2400, origH: 1000, width: 1664, height: 704 },
    {
      name: "R clamp 竖版边界（原比例 0.40 → R 钳 2.40，朝向仍竖版）",
      origW: 1000,
      origH: 2500,
      width: 704,
      height: 1664,
    },
    { name: "21:9 超宽（场景 2.P1 样本）", origW: 2520, origH: 1080, width: 1632, height: 704 },
    {
      name: "20000×10000 大图（场景 2.P1 样本，R=2.0；752/32=23.5 四舍五入入 24 档）",
      origW: 20000,
      origH: 10000,
      width: 1504,
      height: 768,
    },
  ];

  for (const c of exactCases) {
    it(`${c.name}: ${c.origW}×${c.origH} → ${c.width}×${c.height}`, () => {
      expect(computeNativeCanvas(c.origW, c.origH)).toEqual({
        width: c.width,
        height: c.height,
      });
    });
  }
});

describe("场景 2.P1-P4 谓词（SSOT 逐字）", () => {
  /** 场景 2.P1 样本集（谓词 SSOT 逐字：1:1、4:3、3:2、16:9、9:16、21:9、20000×10000） */
  const samples: Array<[number, number]> = [
    [1000, 1000],
    [4000, 3000],
    [3000, 2000],
    [1920, 1080],
    [1080, 1920],
    [2520, 1080],
    [20000, 10000],
  ];

  it("场景2.P1: ∀ 样本 w%32==0 && h%32==0", () => {
    for (const [w, h] of samples) {
      const { width, height } = computeNativeCanvas(w, h);
      expect(width % 32, `样本 ${w}×${h} → ${width}×${height}，宽非 32 倍数`).toBe(0);
      expect(height % 32, `样本 ${w}×${h} → ${width}×${height}，高非 32 倍数`).toBe(0);
    }
  });

  it("场景2.P2: ∀ w*h ≤ 1177600 && ≥ 1177600/2", () => {
    for (const [w, h] of samples) {
      const { width, height } = computeNativeCanvas(w, h);
      const pixels = width * height;
      expect(
        pixels,
        `样本 ${w}×${h} → ${width}×${height} 像素 ${pixels} 超预算`,
      ).toBeLessThanOrEqual(BUDGET);
      expect(
        pixels,
        `样本 ${w}×${h} → ${width}×${height} 像素 ${pixels} 低于下限`,
      ).toBeGreaterThanOrEqual(BUDGET_HALF);
    }
  });

  it("场景2.P3: 16:9 输入输出比例偏差 ≤2%", () => {
    const { width, height } = computeNativeCanvas(1920, 1080);
    const deviation = Math.abs(width / height - 16 / 9) / (16 / 9);
    expect(deviation).toBeLessThanOrEqual(0.02);
  });

  it("场景2.P4: 9:16 输入输出仍竖版（h>w）且比例偏差 ≤2%（kill 固定横版画布 No-op）", () => {
    const { width, height } = computeNativeCanvas(1080, 1920);
    expect(height).toBeGreaterThan(width);
    const deviation = Math.abs(width / height - 9 / 16) / (9 / 16);
    expect(deviation).toBeLessThanOrEqual(0.02);
  });
});

describe("computeNativeCanvas 性质与边界", () => {
  it("多比例性质扫描（未触 clamp 边界）：32 倍数 + 像素预算 + 比例偏差 ≤2% + 朝向保持", () => {
    const ratios: Array<[number, number]> = [
      [1, 1],
      [5, 4],
      [4, 3],
      [3, 2],
      [16, 10],
      [16, 9],
      [9, 16],
      [10, 16],
      [3, 4],
      [2, 3],
      [9, 21],
      [7, 5],
      [1.85, 1],
      [1.5, 1],
      [1.9, 1],
    ];
    for (const [w, h] of ratios) {
      const { width, height } = computeNativeCanvas(w, h);
      expect(width % 32).toBe(0);
      expect(height % 32).toBe(0);
      expect(width * height).toBeLessThanOrEqual(BUDGET);
      expect(width * height).toBeGreaterThanOrEqual(BUDGET_HALF);
      // 朝向保持：横图出横画布、竖图出竖画布、正方出正方
      if (w > h) expect(width).toBeGreaterThan(height);
      if (w < h) expect(height).toBeGreaterThan(width);
      if (w === h) expect(width).toBe(height);
      // 未触 R clamp 边界的样本：比例偏差 ≤2%（design 注）
      const r = Math.max(w, h) / Math.min(w, h);
      if (r >= 1.0 && r <= 2.4) {
        const outR = Math.max(width, height) / Math.min(width, height);
        expect(
          Math.abs(outR - r) / r,
          `${w}:${h} → ${width}×${height} 偏差超 2%`,
        ).toBeLessThanOrEqual(0.02);
      }
    }
  });

  it("MIN_SHORT 纪律：短轴恒 ≥704（R≤2.4 全域）", () => {
    for (let rNum = 10; rNum <= 24; rNum++) {
      const { width, height } = computeNativeCanvas(rNum * 100, 1000);
      expect(Math.min(width, height)).toBeGreaterThanOrEqual(704);
    }
  });

  it("极端比例（R>2.4 clamp）像素 ≤ BUDGET（兜底分支预算保证）", () => {
    for (const [w, h] of [
      [1000, 4000],
      [1000, 10000],
      [5000, 1000],
    ] as Array<[number, number]>) {
      const { width, height } = computeNativeCanvas(w, h);
      expect(width * height).toBeLessThanOrEqual(BUDGET);
      expect(width % 32).toBe(0);
      expect(height % 32).toBe(0);
    }
  });
});

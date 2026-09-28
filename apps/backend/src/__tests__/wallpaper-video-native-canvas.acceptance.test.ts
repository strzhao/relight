/**
 * 验收测试（红队）：单腿原生壁纸视频 — 画布计算纯函数 computeNativeCanvas
 *
 * 设计文档（state.md §设计文档 D1 / §验收场景）对应谓词：
 *   - 场景 2.P1 [det-machine]：样本集（1:1、4:3、3:2、16:9、9:16、21:9、20000×10000）
 *     ∀ w%32==0 && h%32==0
 *     assert: 每个样本输出的 width 与 height 都是 32 的倍数
 *   - 场景 2.P2 [det-machine]：∀ width*height ≤ 1177600 && ≥ 1177600/2（= 588800）
 *   - 场景 2.P3 [det-machine]：16:9 输入 → 输出比例偏差 ≤2%
 *   - 场景 2.P4 [det-machine]：9:16 输入 → 输出仍竖版（h>w）且比例偏差 ≤2%
 *     （kill 固定横版画布 No-op）
 *
 * 追加设计锁定（D1 逐字推导，非红队自由发挥）：
 *   - D1 参考输出精确 fixture：1:1→1056×1056；3:2→1312×864；16:9→1440×800；
 *     9:16→800×1440；4:3→1248×928；3:4→928×1248；2.35:1→1664×704
 *     （「触 R clamp 边界的样本由精确 fixture 断言锁定」——本文件的精确 fixture 均为
 *      D1 参考输出逐字，未触 R clamp）
 *   - 朝向由原图决定（D1：landscape = origW >= origH，与 R 解耦）：2:3 → 864×1312
 *   - 极端比例（R 触 2.40 上限，如 10000×3000）走 D1 兜底分支：
 *     L = round32(min(MIN_SHORT*R, BUDGET/MIN_SHORT))、s = MIN_SHORT=704
 *     → 横 1664×704 / 竖 704×1664（兜底公式确定性推导，短边恒 704）
 *   - 质量纪律下限：任意样本输出短边 ≥ 704（主循环 s ≥ MIN_SHORT 门 + 兜底 s = MIN_SHORT）
 *
 * 绑定表（§验收场景 实现绑定表）：尺寸计算入口 = native-canvas.ts 导出的
 * computeNativeCanvas(origW, origH)；像素预算 pixel_budget = 1177600。
 *
 * 红队铁律：不读蓝队实现代码（native-canvas.ts 按契约导出名黑盒 import）；纯函数直调，
 * 无环境依赖——不 skip、硬断言，import 失败即红（TDD 红灯）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeNativeCanvas } from "../lib/wallpaper/native-canvas";

const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

function writeArtifact(id: string, content: string): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

// 契约字面量（§设计文档 D1 逐字）
const BUDGET = 1_177_600;
const BUDGET_HALF = BUDGET / 2; // 588800（绑定表：下限语义 ≥ budget/2）
const MIN_SHORT = 704;

/** D1 参考输出精确 fixture（逐字）：[origW, origH, expectW, expectH] */
const REFERENCE_FIXTURES: Array<[number, number, number, number]> = [
  [2000, 2000, 1056, 1056], // 1:1 → 1056×1056
  [3000, 2000, 1312, 864], // 3:2 → 1312×864
  [2000, 3000, 864, 1312], // 2:3（3:2 竖拍镜像，朝向由原图决定）
  [1920, 1080, 1440, 800], // 16:9 → 1440×800
  [1080, 1920, 800, 1440], // 9:16 → 800×1440
  [4000, 3000, 1248, 928], // 4:3 → 1248×928
  [3000, 4000, 928, 1248], // 3:4 → 928×1248
  [2350, 1000, 1664, 704], // 2.35:1 → 1664×704（D1 参考输出逐字）
];

/** 场景 2.P1 样本集（谓词逐字）：1:1、4:3、3:2、16:9、9:16、21:9、20000×10000 */
const SAMPLE_SET: Array<[number, number]> = [
  [2000, 2000], // 1:1
  [4000, 3000], // 4:3
  [3000, 2000], // 3:2
  [1920, 1080], // 16:9
  [1080, 1920], // 9:16
  [2100, 900], // 21:9
  [20000, 10000], // 2:1 超大图
];

/** 比例偏差（相对原比例），供 P3/P4 的 ≤2% 判定 */
function ratioDeviation(origW: number, origH: number, outW: number, outH: number): number {
  const src = origW / origH;
  const out = outW / outH;
  return Math.abs(out - src) / src;
}

describe("场景 2：computeNativeCanvas 画布尺寸纯逻辑（kill No-op 核心）", () => {
  it("场景 2.P1 [det-machine]：样本集 ∀ 输出 w%32==0 && h%32==0，且短边 ≥ 704（质量纪律）", () => {
    const results = SAMPLE_SET.map(([w, h]) => {
      const out = computeNativeCanvas(w, h);
      return { input: [w, h], ...out };
    });
    writeArtifact("s2p1", JSON.stringify(results, null, 2));

    for (const r of results) {
      expect(r.width % 32, `${r.input} → width ${r.width} 必须是 32 的倍数`).toBe(0);
      expect(r.height % 32, `${r.input} → height ${r.height} 必须是 32 的倍数`).toBe(0);
      expect(
        Math.min(r.width, r.height),
        `${r.input} → 短边 ${Math.min(r.width, r.height)} 必须 ≥ MIN_SHORT(704)`,
      ).toBeGreaterThanOrEqual(MIN_SHORT);
    }
  });

  it("场景 2.P2 [det-machine]：样本集 ∀ width*height ≤ 1177600 && ≥ 1177600/2", () => {
    const results = SAMPLE_SET.map(([w, h]) => {
      const out = computeNativeCanvas(w, h);
      return { input: [w, h], ...out, pixels: out.width * out.height };
    });
    writeArtifact("s2p2", JSON.stringify(results, null, 2));

    for (const r of results) {
      expect(
        r.pixels,
        `${r.input} → ${r.width}x${r.height} = ${r.pixels}px 必须 ≤ BUDGET(1177600)`,
      ).toBeLessThanOrEqual(BUDGET);
      expect(
        r.pixels,
        `${r.input} → ${r.width}x${r.height} = ${r.pixels}px 必须 ≥ BUDGET/2(588800)`,
      ).toBeGreaterThanOrEqual(BUDGET_HALF);
    }
  });

  it("场景 2.P3 [det-machine]：16:9 输入 → 输出比例偏差 ≤2%", () => {
    const out = computeNativeCanvas(1920, 1080);
    const dev = ratioDeviation(1920, 1080, out.width, out.height);
    writeArtifact("s2p3", JSON.stringify({ input: [1920, 1080], ...out, deviation: dev }));
    expect(
      dev,
      `16:9 → ${out.width}x${out.height} 比例偏差 ${(dev * 100).toFixed(2)}%`,
    ).toBeLessThanOrEqual(0.02);
  });

  it("场景 2.P4 [det-machine]：9:16 输入 → 仍竖版（h>w）且比例偏差 ≤2%（kill 固定横版 No-op）", () => {
    const out = computeNativeCanvas(1080, 1920);
    const dev = ratioDeviation(1080, 1920, out.width, out.height);
    writeArtifact("s2p4", JSON.stringify({ input: [1080, 1920], ...out, deviation: dev }));
    expect(out.height, `9:16 → ${out.width}x${out.height} 必须保持竖版（h>w）`).toBeGreaterThan(
      out.width,
    );
    expect(
      dev,
      `9:16 → ${out.width}x${out.height} 比例偏差 ${(dev * 100).toFixed(2)}%`,
    ).toBeLessThanOrEqual(0.02);
  });

  it("D1 参考输出精确 fixture：7 组比例逐字锁定（含朝向镜像 2:3）", () => {
    const results = REFERENCE_FIXTURES.map(([w, h, ew, eh]) => {
      const out = computeNativeCanvas(w, h);
      return { input: [w, h], expected: [ew, eh], actual: [out.width, out.height] };
    });
    writeArtifact("s2-fixtures", JSON.stringify(results, null, 2));

    for (const [w, h, ew, eh] of REFERENCE_FIXTURES) {
      const out = computeNativeCanvas(w, h);
      expect(
        `${out.width}x${out.height}`,
        `computeNativeCanvas(${w}, ${h}) 必须等于 D1 参考输出 ${ew}x${eh}`,
      ).toBe(`${ew}x${eh}`);
    }
  });

  it("D1 兜底分支：极端比例（R 触 2.40 clamp）→ 短边 = 704、像素 ≤ BUDGET、朝向保持", () => {
    // 10000×3000：R = 3.333 → clamp 2.40；兜底 L = round32(min(704*R, BUDGET/704)) = 1664
    const landscape = computeNativeCanvas(10000, 3000);
    expect(
      `${landscape.width}x${landscape.height}`,
      "极端横图兜底必须为 1664×704（D1 兜底公式确定性产物）",
    ).toBe("1664x704");

    // 3000×10000：同 R，朝向镜像 → 704×1664
    const portrait = computeNativeCanvas(3000, 10000);
    expect(`${portrait.width}x${portrait.height}`, "极端竖图兜底必须按朝向定向为 704×1664").toBe(
      "704x1664",
    );

    // 兜底产物同样满足像素预算与短边纪律
    expect(landscape.width * landscape.height).toBeLessThanOrEqual(BUDGET);
    expect(portrait.width * portrait.height).toBeLessThanOrEqual(BUDGET);
    expect(Math.min(landscape.width, landscape.height)).toBe(MIN_SHORT);
    expect(Math.min(portrait.width, portrait.height)).toBe(MIN_SHORT);
  });
});

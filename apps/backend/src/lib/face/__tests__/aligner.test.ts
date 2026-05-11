import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { alignFace, expandBBox } from "../aligner";

describe("expandBBox", () => {
  it("正常情况下按 expand 倍率以中心展开", () => {
    const out = expandBBox({ x: 100, y: 100, w: 100, h: 100 }, 1000, 1000, 1.3);
    expect(out.w).toBe(130);
    expect(out.h).toBe(130);
    // 中心 (150, 150)，新 bbox 中心保持不变
    expect(out.x + out.w / 2).toBeCloseTo(150, 0);
    expect(out.y + out.h / 2).toBeCloseTo(150, 0);
  });

  it("超出左/上边界时 clamp 到 0 并保留可见区域", () => {
    // 中心 (50,50) 外扩 1.3 → (-15,-15,130,130)，clamp 后应该 (0,0,115,115)
    const out = expandBBox({ x: 0, y: 0, w: 100, h: 100 }, 1000, 1000, 1.3);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.w).toBe(115);
    expect(out.h).toBe(115);
  });

  it("超出右/下边界时收缩 w/h", () => {
    const out = expandBBox({ x: 900, y: 900, w: 100, h: 100 }, 1000, 1000, 1.3);
    expect(out.x + out.w).toBeLessThanOrEqual(1000);
    expect(out.y + out.h).toBeLessThanOrEqual(1000);
  });

  it("expand=1 = identity", () => {
    const bbox = { x: 200, y: 300, w: 50, h: 60 };
    const out = expandBBox(bbox, 1000, 1000, 1);
    expect(out).toEqual(bbox);
  });
});

describe("alignFace（实跑 sharp）", () => {
  it("产出形状 = 3 * 112 * 112，值在 [-1, 1] 范围", async () => {
    // 造一张 200x200 纯灰 PNG
    const img = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .png()
      .toBuffer();

    const out = await alignFace(img, { x: 50, y: 50, w: 100, h: 100 }, 200, 200);
    expect(out.length).toBe(3 * 112 * 112);

    // 灰色 (128) → (128/255 - 0.5)/0.5 ≈ 0.0039
    const expected = (128 / 255 - 0.5) / 0.5;
    for (let i = 0; i < out.length; i++) {
      expect(out[i] ?? 0).toBeCloseTo(expected, 3);
    }
  });

  it("自定义 size=64 时输出正确长度", async () => {
    const img = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const out = await alignFace(img, { x: 0, y: 0, w: 100, h: 100 }, 100, 100, { size: 64 });
    expect(out.length).toBe(3 * 64 * 64);
  });
});

/**
 * 验收测试 R3：cropFaceToJpeg（红队，黑盒）
 *
 * 设计契约（state.md 「设计文档 → crop.ts API 契约」）：
 *
 * `cropFaceToJpeg(imageBuffer, bbox, imageWidth, imageHeight): Promise<Buffer>`
 *  - 入参：sharp 可读的图（已 EXIF rotate）；bbox = { x, y, w, h }（整数像素）
 *  - 外扩 1.5× 后 sharp.extract，clamp 到 [0, imageWidth/imageHeight]
 *  - 最长边压到 224px
 *  - 输出：JPEG buffer（quality 85）
 *
 * 测试用图：用 sharp create API 生成，不读文件系统
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";

// =========================================================================
// 辅助：生成测试用图
// =========================================================================

/**
 * 生成 widthxheight 的纯色 JPEG buffer（RGB 128,128,128）
 */
async function makeTestImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .jpeg()
    .toBuffer();
}

// =========================================================================
// 辅助：检查 JPEG header
// =========================================================================

function isJpegBuffer(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

// =========================================================================
// R3-1: 正常 bbox
// =========================================================================

describe("R3-1: 正常 bbox → 返回 JPEG buffer", () => {
  it("1000x1000 测试图 + bbox=(400,400,100,100) → 返回 JPEG buffer（前 3 字节 FF D8 FF）", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(1000, 1000);
    const bbox = { x: 400, y: 400, w: 100, h: 100 };

    const result = await cropFaceToJpeg(img, bbox, 1000, 1000);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(isJpegBuffer(result)).toBe(true);
  });

  it("正常 bbox → 输出图片最长边 <= 224px", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(1000, 1000);
    const bbox = { x: 400, y: 400, w: 100, h: 100 };

    const result = await cropFaceToJpeg(img, bbox, 1000, 1000);
    const meta = await sharp(result).metadata();

    const maxSide = Math.max(meta.width ?? 0, meta.height ?? 0);
    expect(maxSide).toBeLessThanOrEqual(224);
  });

  it("正常 bbox → 输出格式为 jpeg", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(1000, 1000);
    const bbox = { x: 400, y: 400, w: 100, h: 100 };

    const result = await cropFaceToJpeg(img, bbox, 1000, 1000);
    const meta = await sharp(result).metadata();

    expect(meta.format).toBe("jpeg");
  });

  it("正方形 bbox（w=h=80） → 最长边 <= 224", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(800, 800);
    const bbox = { x: 300, y: 300, w: 80, h: 80 };

    const result = await cropFaceToJpeg(img, bbox, 800, 800);
    const meta = await sharp(result).metadata();

    expect(meta.format).toBe("jpeg");
    const maxSide = Math.max(meta.width ?? 0, meta.height ?? 0);
    expect(maxSide).toBeLessThanOrEqual(224);
  });
});

// =========================================================================
// R3-2: 贴左上角 bbox → 外扩越界 clamp，不抛错
// =========================================================================

describe("R3-2: 贴左上角 bbox → 越界 clamp，不抛错", () => {
  it("bbox=(0,0,100,100) 外扩 1.5× 会产生负坐标 → 应被 clamp 到 [0, ...]，返回 JPEG buffer", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(1000, 1000);
    const bbox = { x: 0, y: 0, w: 100, h: 100 };

    // 不应抛错
    const result = await cropFaceToJpeg(img, bbox, 1000, 1000);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(isJpegBuffer(result)).toBe(true);
  });

  it("贴左上角 → 输出格式为 jpeg，最长边 <= 224", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(1000, 1000);
    const bbox = { x: 0, y: 0, w: 100, h: 100 };

    const result = await cropFaceToJpeg(img, bbox, 1000, 1000);
    const meta = await sharp(result).metadata();

    expect(meta.format).toBe("jpeg");
    const maxSide = Math.max(meta.width ?? 0, meta.height ?? 0);
    expect(maxSide).toBeLessThanOrEqual(224);
  });

  it("bbox=(5,5,50,50) 微小左上偏移 → 外扩后左/上 clamp 到 0，不抛错", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(500, 500);
    // 外扩 1.5x：padding ≈ 0.25*50=12.5，origin = 5-12 = -7 → clamp 到 0
    const bbox = { x: 5, y: 5, w: 50, h: 50 };

    const result = await cropFaceToJpeg(img, bbox, 500, 500);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(isJpegBuffer(result)).toBe(true);
  });
});

// =========================================================================
// R3-3: 贴右下角 bbox → 外扩越界 clamp，不抛错
// =========================================================================

describe("R3-3: 贴右下角 bbox → 越界 clamp，不抛错", () => {
  it("bbox=(900,900,100,100) 外扩后超出 imageWidth/imageHeight → clamp，不抛错", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(1000, 1000);
    const bbox = { x: 900, y: 900, w: 100, h: 100 };

    // 不应抛错
    const result = await cropFaceToJpeg(img, bbox, 1000, 1000);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(isJpegBuffer(result)).toBe(true);
  });

  it("贴右下角 → 输出格式为 jpeg，最长边 <= 224", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(1000, 1000);
    const bbox = { x: 900, y: 900, w: 100, h: 100 };

    const result = await cropFaceToJpeg(img, bbox, 1000, 1000);
    const meta = await sharp(result).metadata();

    expect(meta.format).toBe("jpeg");
    const maxSide = Math.max(meta.width ?? 0, meta.height ?? 0);
    expect(maxSide).toBeLessThanOrEqual(224);
  });

  it("bbox=(950,950,50,50) 极端右下角 → 外扩后 clamp，不抛错", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(1000, 1000);
    // 外扩后 right = 950+50+12 = 1012 > 1000，需 clamp
    const bbox = { x: 950, y: 950, w: 50, h: 50 };

    const result = await cropFaceToJpeg(img, bbox, 1000, 1000);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(isJpegBuffer(result)).toBe(true);
  });
});

// =========================================================================
// R3-4: 最长边 <= 224px
// =========================================================================

describe("R3-4: 最长边 <= 224px 压缩", () => {
  it("大尺寸图（2000x2000）+ 大 bbox → 输出最长边 <= 224", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(2000, 2000);
    const bbox = { x: 500, y: 500, w: 400, h: 400 };

    const result = await cropFaceToJpeg(img, bbox, 2000, 2000);
    const meta = await sharp(result).metadata();

    const maxSide = Math.max(meta.width ?? 0, meta.height ?? 0);
    expect(maxSide).toBeLessThanOrEqual(224);
  });

  it("小尺寸 bbox（w=50,h=50） → 外扩后约 75x75，压缩后 <= 224（本身已小于）", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(500, 500);
    const bbox = { x: 200, y: 200, w: 50, h: 50 };

    const result = await cropFaceToJpeg(img, bbox, 500, 500);
    const meta = await sharp(result).metadata();

    // 外扩后约 75x75，压缩到 <= 224（本身已在 224 以下，不需缩放）
    const maxSide = Math.max(meta.width ?? 0, meta.height ?? 0);
    expect(maxSide).toBeLessThanOrEqual(224);
  });

  it("宽扁 bbox（w=300,h=100） → 最长边（300 * 1.5 = 450）压缩到 <= 224", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(1000, 500);
    const bbox = { x: 200, y: 100, w: 300, h: 100 };

    const result = await cropFaceToJpeg(img, bbox, 1000, 500);
    const meta = await sharp(result).metadata();

    const maxSide = Math.max(meta.width ?? 0, meta.height ?? 0);
    expect(maxSide).toBeLessThanOrEqual(224);
  });
});

// =========================================================================
// R3-5: JPEG 而非 PNG
// =========================================================================

describe("R3-5: 输出格式必须是 JPEG", () => {
  it("sharp.metadata().format === 'jpeg'", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(1000, 1000);
    const bbox = { x: 400, y: 400, w: 100, h: 100 };

    const result = await cropFaceToJpeg(img, bbox, 1000, 1000);
    const meta = await sharp(result).metadata();

    expect(meta.format).toBe("jpeg");
  });

  it("输出 buffer 前 3 字节必须是 FF D8 FF（JPEG magic bytes）", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    const img = await makeTestImage(1000, 1000);
    const bbox = { x: 300, y: 300, w: 150, h: 150 };

    const result = await cropFaceToJpeg(img, bbox, 1000, 1000);

    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xd8);
    expect(result[2]).toBe(0xff);
  });

  it("输入 PNG 格式图片 → 输出仍然是 JPEG", async () => {
    const { cropFaceToJpeg } = await import("../crop");
    // 用 PNG 格式生成测试图
    const pngBuffer = await sharp({
      create: {
        width: 500,
        height: 500,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
    })
      .png()
      .toBuffer();

    const bbox = { x: 100, y: 100, w: 100, h: 100 };

    const result = await cropFaceToJpeg(pngBuffer, bbox, 500, 500);
    const meta = await sharp(result).metadata();

    expect(meta.format).toBe("jpeg");
  });
});

// =========================================================================
// R3-综合：1000x1000 标准图全面验证
// =========================================================================

describe("R3-综合：1000x1000 标准测试图完整验证", () => {
  it("标准 1000x1000 + 中心 bbox → JPEG + 最长边<=224 + 不抛错", async () => {
    const { cropFaceToJpeg } = await import("../crop");

    // 按任务说明：用 sharp create 生成测试图
    const img = await sharp({
      create: {
        width: 1000,
        height: 1000,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .jpeg()
      .toBuffer();

    const bbox = { x: 400, y: 400, w: 100, h: 100 };

    const result = await cropFaceToJpeg(img, bbox, 1000, 1000);
    const meta = await sharp(result).metadata();

    // JPEG header
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xd8);
    expect(result[2]).toBe(0xff);

    // 格式
    expect(meta.format).toBe("jpeg");

    // 最长边约束
    const maxSide = Math.max(meta.width ?? 0, meta.height ?? 0);
    expect(maxSide).toBeLessThanOrEqual(224);

    // 有实质内容
    expect(result.length).toBeGreaterThan(100);
  });
});

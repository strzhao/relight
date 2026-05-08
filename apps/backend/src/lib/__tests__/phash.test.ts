/**
 * dHash 工具单元测试
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { dHash, hammingDistance } from "../phash";

/** 生成测试用的灰色纯色图片（width × height，灰度值 gray） */
async function makeSolidImage(width: number, height: number, gray: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3 as const,
      background: { r: gray, g: gray, b: gray },
    },
  })
    .grayscale()
    .jpeg()
    .toBuffer();
}

/** 生成测试用渐变图片（左到右亮度递增） */
async function makeGradientImage(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = Math.floor((x / (width - 1)) * 255);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .jpeg()
    .toBuffer();
}

describe("dHash", () => {
  it("相同图片的 hash 相同", async () => {
    const buf = await makeSolidImage(100, 100, 128);
    const h1 = await dHash(buf);
    const h2 = await dHash(buf);
    expect(h1).toBe(h2);
  });

  it("返回 16 位十六进制字符串", async () => {
    const buf = await makeSolidImage(100, 100, 200);
    const h = await dHash(buf);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("纯色图片 hash 固定（全0或全1）", async () => {
    // 纯色图片相邻像素相同，left < right 为 false，所有位均为 0
    const buf = await makeSolidImage(200, 200, 100);
    const h = await dHash(buf);
    expect(h).toBe("0000000000000000");
  });

  it("渐变图片 hash 不全为0", async () => {
    const buf = await makeGradientImage(200, 100);
    const h = await dHash(buf);
    // 渐变图左 < 右，大量位为 1
    expect(h).not.toBe("0000000000000000");
  });

  it("轻微缩放后 hash 变化极小（≤4）", async () => {
    const buf1 = await makeGradientImage(200, 100);
    const buf2 = await makeGradientImage(201, 101);
    const h1 = await dHash(buf1);
    const h2 = await dHash(buf2);
    const dist = hammingDistance(h1, h2);
    expect(dist).toBeLessThanOrEqual(4);
  });
});

describe("hammingDistance", () => {
  it("相同 hash 距离为 0", () => {
    const h = "abcdef1234567890";
    expect(hammingDistance(h, h)).toBe(0);
  });

  it("全0 与全f 距离为 64（所有位不同）", () => {
    const a = "0000000000000000";
    const b = "ffffffffffffffff";
    expect(hammingDistance(a, b)).toBe(64);
  });

  it("对称性：hammingDistance(a, b) === hammingDistance(b, a)", () => {
    const a = "abc1230000000000";
    const b = "0000000000cba321";
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  it("只差 1 位时距离为 1", () => {
    const a = "0000000000000000";
    const b = "0000000000000001"; // 最低位不同
    expect(hammingDistance(a, b)).toBe(1);
  });

  it("距离范围在 0-64 之间", () => {
    const a = "fedcba9876543210";
    const b = "0123456789abcdef";
    const dist = hammingDistance(a, b);
    expect(dist).toBeGreaterThanOrEqual(0);
    expect(dist).toBeLessThanOrEqual(64);
  });
});

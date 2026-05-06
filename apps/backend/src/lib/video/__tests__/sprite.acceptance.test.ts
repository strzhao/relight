/**
 * 验收测试：雪碧图生成 (sprite.ts)
 *
 * 覆盖风险点 E：1/4/6 帧边界情况都要支持
 *
 * 设计意图：
 * - composeSprite(frameBuffers): Buffer 接受 1~6 个帧 buffer
 * - 输出为有效 JPEG buffer（3×2 网格，N=6 时）
 * - 帧数 < 6 时应填充占位色块（不抛错）
 * - 帧数 0 时抛出明确错误
 */
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

// 被测模块（蓝队实现后才能通过）
import { composeSprite } from "../sprite";

/** 生成指定像素的单色 JPEG buffer */
async function makeFrameBuffer(
  width: number,
  height: number,
  r = 128,
  g = 128,
  b = 128,
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
  })
    .jpeg({ quality: 70 })
    .toBuffer();
}

let frame1: Buffer;
let frame4: Buffer[];
let frame6: Buffer[];

beforeAll(async () => {
  frame1 = await makeFrameBuffer(320, 240, 200, 100, 50);
  frame4 = await Promise.all([
    makeFrameBuffer(320, 240, 255, 0, 0),
    makeFrameBuffer(320, 240, 0, 255, 0),
    makeFrameBuffer(320, 240, 0, 0, 255),
    makeFrameBuffer(320, 240, 128, 128, 0),
  ]);
  frame6 = await Promise.all([
    makeFrameBuffer(320, 240, 200, 50, 50),
    makeFrameBuffer(320, 240, 50, 200, 50),
    makeFrameBuffer(320, 240, 50, 50, 200),
    makeFrameBuffer(320, 240, 200, 200, 50),
    makeFrameBuffer(320, 240, 200, 50, 200),
    makeFrameBuffer(320, 240, 50, 200, 200),
  ]);
}, 30_000);

describe("composeSprite — 雪碧图生成 (风险点 E)", () => {
  it("1 帧时：返回有效 JPEG buffer，不抛错", async () => {
    const result = await composeSprite([frame1]);

    // 必须是 Buffer
    expect(Buffer.isBuffer(result)).toBe(true);
    // 必须是非空 JPEG（JPEG 魔数 FF D8 FF）
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xd8);
    expect(result[2]).toBe(0xff);
    expect(result.length).toBeGreaterThan(1000);
  });

  it("4 帧时：返回有效 JPEG buffer，不抛错", async () => {
    const result = await composeSprite(frame4);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xd8);
    expect(result.length).toBeGreaterThan(1000);
  });

  it("6 帧时（标准 3×2 网格）：返回有效 JPEG buffer", async () => {
    const result = await composeSprite(frame6);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xd8);
    expect(result.length).toBeGreaterThan(5000); // 6 帧合并后文件更大
  });

  it("6 帧雪碧图的宽度应大于单帧（3 列拼接）", async () => {
    const result = await composeSprite(frame6);
    const meta = await sharp(result).metadata();

    // 3 列 × 320 = 960（或等比缩小后仍大于单帧宽）
    expect(meta.width).toBeGreaterThan(300);
    // 2 行 × 240 = 480（或等比缩小后仍大于单帧高）
    expect(meta.height).toBeGreaterThan(200);
  });

  it("帧数不足 6 时（如 4 帧）：应填充或不报错，而非抛出异常", async () => {
    // 设计意图：帧数不够时用占位填充，不抛异常
    await expect(composeSprite(frame4)).resolves.toBeDefined();
  });

  it("帧数为 0 时：抛出明确错误", async () => {
    await expect(composeSprite([])).rejects.toThrow();
  });

  it("不同帧数输出的 JPEG 都可被 sharp 解析（格式健壮性）", async () => {
    const results = await Promise.all([
      composeSprite([frame1]),
      composeSprite(frame4),
      composeSprite(frame6),
    ]);

    for (const result of results) {
      const meta = await sharp(result).metadata();
      expect(meta.format).toBe("jpeg");
    }
  });
});

/**
 * 验收测试：dHash 工具契约（红队，黑盒）
 *
 * 覆盖设计文档 §关键模块.1 — apps/backend/src/lib/phash.ts
 *
 * 契约规范：
 *   - `dHash(buffer: Buffer): Promise<string>` — 返回 16 位 hex（64 位哈希）
 *   - `hammingDistance(a: string, b: string): number` — 返回 0-64
 *   - 同一图像两次调用返回相同 hash
 *   - 不同图像（如纯黑 vs 纯白）距离应 ≥ 30
 *   - 距离对称性：hammingDistance(A, B) === hammingDistance(B, A)
 *
 * 红队铁律：不读取 phash.ts 实现，测试为纯黑盒契约。
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";

// =========================================================================
// 辅助：生成测试用图像 Buffer
// =========================================================================

/**
 * 生成纯色 JPEG Buffer（16×16 像素）
 * sharp 输出 JPEG 后可用作 dHash 输入（dHash 内部会 resize 到 9×8）
 */
async function makeSolidColorBuffer(
  r: number,
  g: number,
  b: number,
  width = 16,
  height = 16,
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
  })
    .jpeg()
    .toBuffer();
}

/**
 * 生成带随机噪点的图像（模拟完全不同的照片）
 */
async function makeNoiseBuffer(seed: number, width = 16, height = 16): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) {
    // 确定性"随机"噪声（基于 seed + 位置）
    pixels[i] = (((seed * 31 + i * 17 + i) % 256) + 256) % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg()
    .toBuffer();
}

// =========================================================================
// 延迟导入（实现文件需在测试框架初始化后加载）
// =========================================================================

async function importPhash() {
  // 蓝队目标路径
  const mod = await import("../phash");
  return mod as {
    dHash: (buf: Buffer) => Promise<string>;
    hammingDistance: (a: string, b: string) => number;
  };
}

// =========================================================================
// 测试套件
// =========================================================================

describe("dHash 工具契约 — 验收测试（设计文档 §关键模块.1）", () => {
  // -----------------------------------------------------------------------
  // dHash 输出格式契约
  // -----------------------------------------------------------------------
  describe("dHash 输出格式", () => {
    it("应返回 16 位十六进制字符串（64 位哈希）", async () => {
      const { dHash } = await importPhash();
      const buf = await makeSolidColorBuffer(128, 128, 128);
      const hash = await dHash(buf);
      expect(typeof hash).toBe("string");
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/i);
    });

    it("纯黑图像应产生合法 16 位 hex", async () => {
      const { dHash } = await importPhash();
      const buf = await makeSolidColorBuffer(0, 0, 0);
      const hash = await dHash(buf);
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/i);
    });

    it("纯白图像应产生合法 16 位 hex", async () => {
      const { dHash } = await importPhash();
      const buf = await makeSolidColorBuffer(255, 255, 255);
      const hash = await dHash(buf);
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/i);
    });
  });

  // -----------------------------------------------------------------------
  // 同图等价性（幂等）
  // -----------------------------------------------------------------------
  describe("同图幂等性", () => {
    it("同一 Buffer 两次调用返回相同 hash", async () => {
      const { dHash } = await importPhash();
      const buf = await makeSolidColorBuffer(100, 150, 200);
      const hash1 = await dHash(buf);
      const hash2 = await dHash(buf);
      expect(hash1).toBe(hash2);
    });

    it("内容相同但不同 Buffer 实例，返回相同 hash", async () => {
      const { dHash } = await importPhash();
      const buf1 = await makeSolidColorBuffer(80, 80, 80);
      const buf2 = await makeSolidColorBuffer(80, 80, 80);
      const hash1 = await dHash(buf1);
      const hash2 = await dHash(buf2);
      expect(hash1).toBe(hash2);
    });

    it("大尺寸与小尺寸同色图像，dHash 相同（resize 到 9×8 后等价）", async () => {
      const { dHash } = await importPhash();
      const small = await makeSolidColorBuffer(60, 120, 180, 16, 16);
      const large = await makeSolidColorBuffer(60, 120, 180, 800, 600);
      const hashSmall = await dHash(small);
      const hashLarge = await dHash(large);
      // 纯色图 resize 后灰度一致，dHash 应相同
      expect(hashSmall).toBe(hashLarge);
    });
  });

  // -----------------------------------------------------------------------
  // hammingDistance 输出范围契约
  // -----------------------------------------------------------------------
  describe("hammingDistance 输出范围", () => {
    it("相同 hash 的汉明距离应为 0", async () => {
      const { dHash, hammingDistance } = await importPhash();
      const buf = await makeSolidColorBuffer(200, 100, 50);
      const hash = await dHash(buf);
      expect(hammingDistance(hash, hash)).toBe(0);
    });

    it("汉明距离应在 0-64 之间（不超过 64 位）", async () => {
      const { dHash, hammingDistance } = await importPhash();
      const buf1 = await makeNoiseBuffer(1);
      const buf2 = await makeNoiseBuffer(99);
      const h1 = await dHash(buf1);
      const h2 = await dHash(buf2);
      const dist = hammingDistance(h1, h2);
      expect(dist).toBeGreaterThanOrEqual(0);
      expect(dist).toBeLessThanOrEqual(64);
    });

    it("汉明距离应返回整数", async () => {
      const { dHash, hammingDistance } = await importPhash();
      const buf1 = await makeSolidColorBuffer(0, 0, 0);
      const buf2 = await makeSolidColorBuffer(255, 255, 255);
      const h1 = await dHash(buf1);
      const h2 = await dHash(buf2);
      const dist = hammingDistance(h1, h2);
      expect(Number.isInteger(dist)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 距离对称性
  // -----------------------------------------------------------------------
  describe("距离对称性", () => {
    it("hammingDistance(A, B) === hammingDistance(B, A)", async () => {
      const { dHash, hammingDistance } = await importPhash();
      const buf1 = await makeSolidColorBuffer(30, 30, 30);
      const buf2 = await makeSolidColorBuffer(200, 200, 200);
      const h1 = await dHash(buf1);
      const h2 = await dHash(buf2);
      expect(hammingDistance(h1, h2)).toBe(hammingDistance(h2, h1));
    });

    it("三组不同图像的对称性", async () => {
      const { dHash, hammingDistance } = await importPhash();
      const bufs = await Promise.all([
        makeNoiseBuffer(7),
        makeNoiseBuffer(42),
        makeNoiseBuffer(88),
      ]);
      const hashes = await Promise.all(bufs.map((b) => dHash(b)));
      const [h0, h1, h2] = hashes as [string, string, string];
      expect(hammingDistance(h0, h1)).toBe(hammingDistance(h1, h0));
      expect(hammingDistance(h1, h2)).toBe(hammingDistance(h2, h1));
      expect(hammingDistance(h0, h2)).toBe(hammingDistance(h2, h0));
    });
  });

  // -----------------------------------------------------------------------
  // 相似图差距阈值（连拍判断核心）
  // -----------------------------------------------------------------------
  describe("相似/差异图像距离阈值", () => {
    it("完全不同场景（噪声图 vs 逆噪声图）：汉明距离应 ≥ 30", async () => {
      const { dHash, hammingDistance } = await importPhash();

      // 使用渐变图像：左白右黑 vs 左黑右白，dHash 基于相邻列比较
      // 水平镜像后每个比较位都翻转 → 汉明距离接近 64
      const leftToRight = await sharp({
        create: {
          width: 16,
          height: 16,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      })
        .composite([
          {
            input: await sharp({
              create: {
                width: 8,
                height: 16,
                channels: 3,
                background: { r: 255, g: 255, b: 255 },
              },
            })
              .jpeg()
              .toBuffer(),
            left: 0,
            top: 0,
          },
        ])
        .jpeg()
        .toBuffer();

      const rightToLeft = await sharp({
        create: {
          width: 16,
          height: 16,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([
          {
            input: await sharp({
              create: {
                width: 8,
                height: 16,
                channels: 3,
                background: { r: 0, g: 0, b: 0 },
              },
            })
              .jpeg()
              .toBuffer(),
            left: 0,
            top: 0,
          },
        ])
        .jpeg()
        .toBuffer();

      const h1 = await dHash(leftToRight);
      const h2 = await dHash(rightToLeft);
      const dist = hammingDistance(h1, h2);
      // 两幅图像是水平镜像，dHash 左→右比较结果完全相反，距离应接近 64
      // 设计文档约束：不同场景距离应 ≥ 30
      expect(dist).toBeGreaterThanOrEqual(30);
    });

    it("同色系微调图像（连拍模拟）：汉明距离应 ≤ 10", async () => {
      const { dHash, hammingDistance } = await importPhash();
      // 模拟同一张照片的两个极为相似的副本（同色，仅亮度微调）
      const orig = await makeSolidColorBuffer(120, 100, 80);
      const similar = await makeSolidColorBuffer(122, 102, 82); // +2 微调
      const h1 = await dHash(orig);
      const h2 = await dHash(similar);
      const dist = hammingDistance(h1, h2);
      // 纯色 dHash 差距应 ≤ 10
      expect(dist).toBeLessThanOrEqual(10);
    });
  });
});

/**
 * generateMidBuffer 单测（state.md §契约规约 计算契约 mid 图生成）
 *
 * DbC 谓词（不变量）：
 *   - 输出 JPEG 宽 <= 1600 且高 <= 1600（含边界）
 *   - 输出体积 <= 800KB（quality 85 + 1600px 经验上界）
 *   - HEIC 须 isHeicFile 前置检测（禁先 sharp）
 *   - RAW/DNG 走 extractRawPreview
 *   - 文件不存在 → 返回 null，不 throw（旁路契约）
 *   - sharp 解码失败 → 返回 null
 *
 * 测试策略：用 sharp 现造各种比例的源图到 tmp，跑 generateMidBuffer 断言输出尺寸/体积。
 * HEIC/RAW 路径用 mock 验证 dispatch（不实际造 HEIC——需 WASM 且慢；RAW 需 dcraw）。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMidBuffer } from "../mid-image";

// mock heic 模块（避免实际 WASM 解码，验证 dispatch 顺序）
vi.mock("../../heic", () => ({
  isHeicFile: (fp: string) => fp.toLowerCase().endsWith(".heic"),
  heicFileToJpeg: vi.fn(async () => {
    throw new Error("mock heic not configured for this test");
  }),
}));

// mock raw 模块（避免依赖 dcraw 二进制）
vi.mock("../../raw", () => ({
  RAW_EXTENSIONS: new Set([".dng"]),
  extractRawPreview: vi.fn(async () => {
    throw new Error("mock raw not configured for this test");
  }),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "relight-mid-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** 造一张指定尺寸的 JPEG 测试源图 */
async function makeJpeg(width: number, height: number, name = "src.jpg"): Promise<string> {
  const fp = path.join(tmpDir, name);
  // 渐变色图（非纯色，压缩后体积真实）
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  await writeFile(fp, buf);
  return fp;
}

describe("generateMidBuffer", () => {
  it("横图（4032×3024）→ 输出 <=1600px 且保持比例", async () => {
    const src = await makeJpeg(4032, 3024);
    const out = await generateMidBuffer(src);
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta.width).toBeLessThanOrEqual(1600);
    expect(meta.height).toBeLessThanOrEqual(1600);
    // 横图比例 4:3 → 1600×1200
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(1200);
  });

  it("竖图（3024×4032）→ 输出 <=1600px 且保持比例（最长边=1600）", async () => {
    const src = await makeJpeg(3024, 4032, "portrait.jpg");
    const out = await generateMidBuffer(src);
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta.width).toBeLessThanOrEqual(1600);
    expect(meta.height).toBeLessThanOrEqual(1600);
    // 竖图最长边=1600（height），另一边按比例（sharp resize 浮点取整容差 ±1）
    expect(meta.height).toBe(1600);
    expect(meta.width).toBeGreaterThanOrEqual(1199);
    expect(meta.width).toBeLessThanOrEqual(1201);
  });

  it("方图（2000×2000）→ 输出 1600×1600", async () => {
    const src = await makeJpeg(2000, 2000, "square.jpg");
    const out = await generateMidBuffer(src);
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(1600);
  });

  it("小图（800×600）→ withoutEnlargement 不放大，保持 800×600", async () => {
    const src = await makeJpeg(800, 600, "small.jpg");
    const out = await generateMidBuffer(src);
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
  });

  it("输出体积 <= 800KB", async () => {
    const src = await makeJpeg(4000, 3000, "big.jpg");
    const out = await generateMidBuffer(src);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(800 * 1024);
  });

  it("输出是有效 JPEG（magic bytes FF D8 FF）", async () => {
    const src = await makeJpeg(2000, 1500);
    const out = await generateMidBuffer(src);
    expect(out).not.toBeNull();
    expect(out![0]).toBe(0xff);
    expect(out![1]).toBe(0xd8);
    expect(out![2]).toBe(0xff);
  });

  it("文件不存在 → 返回 null 不 throw", async () => {
    const bogus = path.join(tmpDir, "does-not-exist.jpg");
    await expect(generateMidBuffer(bogus)).resolves.toBeNull();
  });

  it("损坏文件（非图片）→ 返回 null 不 throw", async () => {
    const bogus = path.join(tmpDir, "corrupt.jpg");
    await writeFile(bogus, Buffer.from("not an image at all"));
    await expect(generateMidBuffer(bogus)).resolves.toBeNull();
  });

  it("HEIC 文件 → isHeicFile 前置检测，走 heicFileToJpeg 分支（不先 sharp）", async () => {
    const { heicFileToJpeg } = await import("../../heic");
    const mocked = vi.mocked(heicFileToJpeg);
    // 让 heic mock 返回一个有效的 1600×1067 JPEG
    const fakeHeicOut = await sharp({
      create: { width: 1600, height: 1067, channels: 3, background: { r: 50, g: 100, b: 150 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    mocked.mockResolvedValueOnce(fakeHeicOut);

    // 造一个假的 .heic 文件（内容无所谓，因为 mock 接管）
    const heicPath = path.join(tmpDir, "fake.heic");
    await writeFile(heicPath, Buffer.from("fake-heic-bytes"));

    const out = await generateMidBuffer(heicPath);
    expect(out).not.toBeNull();
    expect(mocked).toHaveBeenCalledOnce();
    // 验证 options 传了 maxWidth/maxHeight/quality
    const opts = mocked.mock.calls[0]?.[1];
    expect(opts).toMatchObject({ maxWidth: 1600, maxHeight: 1600, quality: 85 });
  });

  it("HEIC 解码失败 → 返回 null 不 throw", async () => {
    const { heicFileToJpeg } = await import("../../heic");
    vi.mocked(heicFileToJpeg).mockRejectedValueOnce(new Error("heic decode failed"));
    const heicPath = path.join(tmpDir, "broken.heic");
    await writeFile(heicPath, Buffer.from("fake"));
    await expect(generateMidBuffer(heicPath)).resolves.toBeNull();
  });

  it("DNG/RAW 文件 → 走 extractRawPreview 分支", async () => {
    const { extractRawPreview } = await import("../../raw");
    // raw 提取出的嵌入 JPEG 通常 ~1600px，再经 sharp resize
    const rawEmbedded = await sharp({
      create: { width: 1920, height: 1080, channels: 3, background: { r: 200, g: 180, b: 120 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    vi.mocked(extractRawPreview).mockResolvedValueOnce(rawEmbedded);
    const dngPath = path.join(tmpDir, "fake.dng");
    await writeFile(dngPath, Buffer.from("fake-dng"));

    const out = await generateMidBuffer(dngPath);
    expect(out).not.toBeNull();
    expect(extractRawPreview).toHaveBeenCalledOnce();
    const meta = await sharp(out!).metadata();
    expect(meta.width).toBeLessThanOrEqual(1600);
    expect(meta.height).toBeLessThanOrEqual(1600);
  });

  it("RAW 提取失败 → 返回 null 不 throw", async () => {
    const { extractRawPreview } = await import("../../raw");
    vi.mocked(extractRawPreview).mockRejectedValueOnce(new Error("dcraw failed"));
    const dngPath = path.join(tmpDir, "broken.dng");
    await writeFile(dngPath, Buffer.from("fake"));
    await expect(generateMidBuffer(dngPath)).resolves.toBeNull();
  });

  it("PNG 源图也支持（sharp 原生解码）", async () => {
    const pngPath = path.join(tmpDir, "src.png");
    const buf = await sharp({
      create: {
        width: 3000,
        height: 2000,
        channels: 4,
        background: { r: 0, g: 128, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    await writeFile(pngPath, buf);
    const out = await generateMidBuffer(pngPath);
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta.width).toBe(1600);
    expect(meta.height).toBeLessThanOrEqual(1600);
    // 输出 JPEG magic
    expect(out![0]).toBe(0xff);
    expect(out![1]).toBe(0xd8);
  });
});

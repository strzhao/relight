/**
 * 验收测试（红队）：composer portrait 分支 — 竖版尺寸输出 + 抛错传播（AP-1 / AP-6）
 *
 * 设计文档契约（state.md「核心设计 3」「契约规约」）：
 * - `composeWallpaper(pick, photo, width, height)`：`if (width < height)` 走 portrait 分支
 *   ① 照片 `sharp.resize(width, height, {fit:'cover', position:'center'})` 精确裁切（非 ×1.2）
 *   ② 调 portraitHeroJSX
 *   ③ 渲染链路 Satori→resvg→sharp jpeg 不变
 * - 输出：JPEG buffer，sharp metadata width=1290 / height=2796（竖版目标尺寸）
 *
 * 验收谓词覆盖：
 * - AP-1：width<height 输入 → 输出 JPEG 像素 1290×2796，长宽比 ≈2.167（9:19.5）
 * - AP-6（composer 层）：portrait 分支抛错时 propagate（上层 selection 的 try/catch 兜底，
 *   composer 本身不吞错——此处在 composer 层验证「错误不被静默」）
 *
 * 测试策略：
 * - mock storage adapter（createStorageAdapter）返回预生成的竖版照片 buffer，避免读真实文件
 * - 真实 Satori + resvg + sharp 渲染链路（验证端到端像素输出）
 * - 几何断言：sharp().metadata() 读输出 JPEG 的 width/height/format
 *
 * 红队铁律：不读 composeWallpaper 实现改动部分；仅按既有契约 import。
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Hoisted mock：storage adapter 返回预生成照片 buffer
// ============================================================================

// 预生成一张竖版测试照片（由 sharp 动态生成，避免大文件入库）
const photoBuffer = await (async () => {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: {
      width: 1290,
      height: 2796,
      channels: 3,
      background: { r: 90, g: 130, b: 170 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
})();

// 测试文件位于 src/lib/wallpaper/__tests__/，storage 模块在 src/storage/
// 相对路径：__tests__ → wallpaper → lib → src，再进 storage = ../../../storage
vi.mock("../../../storage", () => ({
  createStorageAdapter: () => ({
    getFileBuffer: async () => photoBuffer,
    getMimeType: () => "image/jpeg",
    listFiles: async () => [],
    getMetadata: async () => ({}),
    computeFileHash: async () => "test-hash",
  }),
}));

// ============================================================================
// 字体资产存在性检查（composer 内部 loadFonts 依赖）
// ============================================================================

const fontsDir = path.resolve(__dirname, "../../../../assets/fonts");
beforeEach(() => {
  // 确保字体资产存在（composer.loadFonts 在 dev 模式从 src 相对路径读）
  if (!fs.existsSync(path.join(fontsDir, "Fraunces-VariableFont.ttf"))) {
    throw new Error("字体资产缺失，composer 测试无法运行");
  }
});

// ============================================================================
// 被测契约
// ============================================================================

import { composeWallpaper, composedCachePath } from "../composer";

// ============================================================================
// fixture（与 template 测试一致的最小 pick/photo）
// ============================================================================

function makePick(): any {
  return {
    id: "pick-composer-portrait",
    photoId: "photo-composer-portrait",
    pickDate: "2026-07-29",
    title: "测试竖版·光",
    narrative: "阳光在叶间游走，这一刻被永久封存。",
    score: 8.5,
    composedImagePath: null,
    members: [],
    createdAt: "2026-07-29T02:00:00.000Z",
  };
}

function makePhoto(): any {
  return {
    id: "photo-composer-portrait",
    storageSourceId: "source-001",
    filePath: "/photos/portrait.jpg",
    fileHash: "hash-composer-portrait",
    width: 1290,
    height: 2796,
    fileSize: 1024000,
    thumbnailPath: "/thumbnails/portrait.jpg",
    takenAt: "2021-07-29T09:30:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    mediaType: "image",
    durationSec: null,
    videoCodec: null,
    videoFps: null,
    fileMtime: null,
  };
}

// ============================================================================
// 测试套件
// ============================================================================

describe("composeWallpaper portrait 分支 — AP-1 竖版尺寸输出", () => {
  /**
   * CP-P1（AP-1 核心断言）：width=1290 height=2796 → 输出 JPEG 像素 1290×2796
   *
   * 设计：portrait 输入（width < height）走竖版分支，输出 1290×2796 JPEG。
   * 验证：sharp(buffer).metadata() → width=1290, height=2796, format=jpeg。
   */
  it("CP-P1: composeWallpaper(pick, photo, 1290, 2796) 输出 1290×2796 JPEG（AP-1）", async () => {
    const sharp = (await import("sharp")).default;
    const pick = makePick();
    const photo = makePhoto();

    const buf = await composeWallpaper(pick, photo, 1290, 2796);
    const meta = await sharp(buf).metadata();

    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1290);
    expect(meta.height).toBe(2796);

    // 长宽比 ≈ 2.167（9:19.5，容差 ±0.02）
    const ratio = meta.height! / meta.width!;
    expect(ratio).toBeGreaterThanOrEqual(2.16);
    expect(ratio).toBeLessThanOrEqual(2.18);
  });

  /**
   * CP-P2（AP-1 尺寸泛化）：其他竖版尺寸（如 1440×3120）也产出正确比例
   *
   * 验证 portrait 分支不硬编码 1290×2796，而是按输入 width/height 缩放。
   */
  it("CP-P2: composeWallpaper(pick, photo, 1440, 3120) 输出 1440×3120 JPEG（portrait 泛化）", async () => {
    const sharp = (await import("sharp")).default;
    const pick = makePick();
    const photo = makePhoto();

    const buf = await composeWallpaper(pick, photo, 1440, 3120);
    const meta = await sharp(buf).metadata();

    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1440);
    expect(meta.height).toBe(3120);
  });

  /**
   * CP-P3（AP-6 composer 层）：portrait 分支抛错时 propagate（不被 composer 静默）
   *
   * 设计：composer 本身不吞错；AP-6 的「失败兜底」发生在上层 daily-selection 的 try/catch。
   * 此处验证 composer 契约：当底层（storage 读取失败）抛错时，composeWallpaper 透传错误。
   *
   * 策略：mock getFileBuffer 抛错 → composeWallpaper 应 reject。
   */
  it("CP-P3: portrait 分支底层抛错时 composeWallpaper propagate（AP-6 前置：composer 不吞错）", async () => {
    // 临时覆盖 mock：getFileBuffer 抛错
    const { createStorageAdapter } = await import("../../../storage");
    const original = (
      createStorageAdapter as unknown as () => { getFileBuffer: () => Promise<Buffer> }
    )();
    const originalFn = original.getFileBuffer;

    const storageMod = await import("../../../storage");
    const mockAdapter = {
      getFileBuffer: async () => {
        throw new Error("模拟照片读取失败");
      },
      getMimeType: () => "image/jpeg",
      listFiles: async () => [],
      getMetadata: async () => ({}),
      computeFileHash: async () => "h",
    };
    (storageMod as any).createStorageAdapter = () => mockAdapter;

    const pick = makePick();
    const photo = makePhoto();

    await expect(composeWallpaper(pick, photo, 1290, 2796)).rejects.toThrow();

    // 还原（后续测试不受影响）
    (storageMod as any).createStorageAdapter = () => original;
  });
});

describe("composedCachePath — 竖版 cacheKey 契约（AP-3 路由命中前提）", () => {
  /**
   * CP-P4（D2 cacheKey 闭合）：composedCachePath(pickDate, 1290, 2796) 含 "1290x2796.jpg"
   *
   * 设计 D2：竖版预生成与路由必须共用 cacheKey `1290x2796`。
   * 路由 `composedCachePath(pickDate, 1290, 2796)` → 文件名 `..._1290x2796.jpg`；
   * 预生成 `cacheKey: undefined` → 回退 `${width}x${height}` = `1290x2796`。
   * 两者必须命中同一文件名。
   */
  it("CP-P4: composedCachePath('2026-07-29', 1290, 2796) 含 '_v2-contain-1290x2796.jpg'（D2 闭合）", () => {
    const p = composedCachePath("2026-07-29", 1290, 2796);
    expect(p).toContain("_v2-contain-1290x2796.jpg");
    expect(p).toContain("2026-07-29");
  });

  /**
   * CP-P5（AP-7 零回归前提）：横版 default cacheKey 不变
   *
   * 设计 D3：COMPOSER_VERSION 保持 v2-contain，横版 cacheKey "default" 不变。
   */
  it("CP-P5: composedCachePath 横版尺寸仍含 '_v2-contain-5120x2880.jpg'（零回归）", () => {
    const p = composedCachePath("2026-07-29", 5120, 2880);
    expect(p).toContain("_v2-contain-5120x2880.jpg");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

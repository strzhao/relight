/**
 * 验收测试（红队）：壁纸模板 — Satori SVG 渲染 contain（不裁剪）契约
 *
 * 设计文档契约：
 * - template.tsx 中 <img> 的 objectFit 改为 "contain"（修复前为 "cover"）
 * - photoArea div 加 backgroundColor: COLOR_BACKGROUND (#F9F5EC)
 *
 * Satori 渲染机制说明（经过调试验证，见 _satori-debug3.test.ts）：
 *   Satori 不在 SVG 中输出 CSS `object-fit` 属性，而是通过计算 <image> 的
 *   x/y/width/height 来实现 contain/cover：
 *   - objectFit:"contain" → <image x="≥0" y="≥0" width≤containerW height≤containerH>
 *                           （图片缩放到容器内，不超出边界，letterbox 效果）
 *   - objectFit:"cover"  → <image x="≤0 或 y≤0" width≥containerW height≥containerH>
 *                           （图片放大裁剪，x/y 可为负数）
 *
 * 验证方法：
 * 1. 用 portrait 原图（100px wide × 200px tall）填充 landscape 容器（400×200）
 * 2. contain 行为：图片在 SVG 中宽度为 100（≤ 容器宽 400），高度为 200（= 容器高）
 * 3. cover 行为：图片放大，宽≥400 或高 > 200，且 y < 0
 *
 * 本测试不读取 template.tsx 实现（红队铁律）。
 * CONTRACT_AMBIGUOUS: dailyHeroJSX 参数 shape 推断自 design doc 和 composer.ts 调用签名
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import satori from "satori";
import { describe, expect, it } from "vitest";

// ============================================================================
// 字体加载
// ============================================================================

// __dirname = apps/backend/src/lib/wallpaper/__tests__
// 向上 4 级 = apps/backend/，再进 assets/fonts/
async function loadFont(): Promise<
  { name: string; data: ArrayBuffer; weight: 400; style: "normal" }[]
> {
  const candidates = [
    path.resolve(__dirname, "../../../../assets/fonts/NotoSerifSC-Regular.otf"),
    path.resolve(__dirname, "../../../../assets/fonts/Fraunces-VariableFont.ttf"),
  ];

  for (const fontPath of candidates) {
    if (fs.existsSync(fontPath)) {
      const data = fs.readFileSync(fontPath).buffer as ArrayBuffer;
      return [{ name: "TestFont", data, weight: 400 as const, style: "normal" as const }];
    }
  }

  throw new Error(
    `字体资产文件不存在，请确认 apps/backend/assets/fonts/ 下有字体文件。尝试：${candidates.join(", ")}`,
  );
}

// ============================================================================
// 图片 fixture 工厂
// ============================================================================

/**
 * 生成 portrait 图片 data URL（100×200，蓝色）
 * 在 landscape 容器（photoArea 16:9）中使用，contain/cover 行为差异最明显
 */
async function makePortraitDataUrl(): Promise<string> {
  const buf = await sharp({
    create: { width: 100, height: 200, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// ============================================================================
// 最小 pick / photo fixture
// ============================================================================

// biome-ignore lint/suspicious/noExplicitAny: test fixture
function makeMockPick(): any {
  return {
    id: "test-pick-001",
    photoId: "test-photo-001",
    pickDate: "2026-05-13",
    title: "测试精选·春",
    narrative:
      "阳光斜落在旧墙上，一只猫慵懒地蜷缩在午后的光斑里。时间在这一刻静止，只余下快门声轻轻响起。",
    score: 8.5,
    composedImagePath: null,
    members: [],
    createdAt: "2026-05-13T06:00:00.000Z",
  };
}

/**
 * portrait photo（100×200）— 在 landscape photoArea 里会触发 contain/cover 差异
 * CONTRACT_AMBIGUOUS: photo shape 推断自 wallpaper-composer.acceptance.test.ts
 */
// biome-ignore lint/suspicious/noExplicitAny: test fixture
function makeMockPhotoPortrait(): any {
  return {
    id: "test-photo-001",
    storageSourceId: "source-001",
    filePath: "/photos/test.jpg",
    fileHash: "test-hash-001",
    width: 100,
    height: 200,
    fileSize: 10240,
    thumbnailPath: "/thumbnails/test.jpg",
    takenAt: "2021-05-13T10:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    mediaType: "image",
    durationSec: null,
    videoCodec: null,
    videoFps: null,
    fileMtime: null,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test fixture
function makeMockPhotoLandscape(): any {
  return { ...makeMockPhotoPortrait(), width: 1920, height: 1080 };
}

// ============================================================================
// 核心辅助：渲染 dailyHeroJSX 并提取 SVG 中 <image> 的几何属性
// ============================================================================

/**
 * 解析 SVG 中所有 <image> 元素的 x/y/width/height 属性。
 * Satori 通过这些属性实现 contain/cover（不是通过 object-fit CSS）。
 */
function extractImageRects(svg: string): Array<{ x: number; y: number; w: number; h: number }> {
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  // Match <image ...> tags (excluding mask rect elements)
  const imageTagRe = /<image\b([^>]+)>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: loop pattern
  while ((m = imageTagRe.exec(svg)) !== null) {
    const attrs = m[1] ?? "";
    // Only include tags with href (actual images, not mask patterns)
    if (!attrs.includes("href")) continue;
    const x = Number(attrs.match(/\bx="([^"]+)"/)?.[1] ?? "0");
    const y = Number(attrs.match(/\by="([^"]+)"/)?.[1] ?? "0");
    const w = Number(attrs.match(/\bwidth="([^"]+)"/)?.[1] ?? "0");
    const h = Number(attrs.match(/\bheight="([^"]+)"/)?.[1] ?? "0");
    rects.push({ x, y, w, h });
  }
  return rects;
}

// CONTRACT: dailyHeroJSX 必须从 template 导出
// 参数 shape: { pick, photo, photoDataUrl, width, height }
import { dailyHeroJSX } from "../template";

// ============================================================================
// 测试套件
// ============================================================================

describe("dailyHeroJSX — Satori SVG 渲染 contain（不裁剪）契约", () => {
  /**
   * TM-1: portrait 照片 in landscape 容器，Satori <image> 不超出 photoArea 边界
   *
   * 修复前（cover）：<image x≤0 y≤0 width≥containerW>，图片被裁剪
   * 修复后（contain）：<image x≥0 y≥0 width≤containerW height≤containerH>，图片完整显示
   *
   * 验证：至少有一个 <image>（实际照片）的 x ≥ 0 且 y ≥ 0（不超出边界）
   * 且 width/height 不超过总渲染尺寸（不是 cover 放大裁剪）
   */
  it("TM-1: portrait 照片 SVG 中 <image> 不超出容器边界（contain 行为，非 cover 裁剪）", async () => {
    const fonts = await loadFont();
    const pick = makeMockPick();
    const photo = makeMockPhotoPortrait();
    const photoDataUrl = await makePortraitDataUrl();

    // 渲染 1920×1080 壁纸（landscape 容器）
    const WIDTH = 1920;
    const HEIGHT = 1080;

    const jsx = dailyHeroJSX({
      pick,
      photo,
      photoDataUrl,
      width: WIDTH,
      height: HEIGHT,
    });

    const svg = await satori(jsx, {
      width: WIDTH,
      height: HEIGHT,
      fonts,
    });

    const imageRects = extractImageRects(svg);

    // 必须有至少一个 <image>（照片渲染）
    expect(imageRects.length).toBeGreaterThan(0);

    // 关键断言：含有 photoDataUrl 的 <image> 的几何属性
    // contain 行为：图片 x ≥ 0，y ≥ 0（不裁剪到边界外）
    // 同时 width/height 不超过容器宽高（不放大溢出）
    // 注：Satori 对 contain 的实现是将图片缩放至适配框内，宽高 ≤ 容器
    const containBehaviorFound = imageRects.some(
      (r) =>
        r.x >= -1 && // x 不应为大负值（cover 时 x 会是大负数）
        r.y >= -1 && // y 不应为大负值（cover 时 y 会是大负数）
        r.w <= WIDTH + 1 && // width 不超容器
        r.h <= HEIGHT + 1, // height 不超容器
    );

    expect(containBehaviorFound).toBe(true);

    // 防回归：不应有表现为 cover 的 <image>（x 或 y 为大负值，且 w 或 h 超过容器）
    const coverBehaviorFound = imageRects.some(
      (r) =>
        (r.x < -10 || r.y < -10) && // cover 时 x 或 y 为大负值
        (r.w > WIDTH || r.h > HEIGHT), // 且 width 或 height 超出容器
    );

    expect(coverBehaviorFound).toBe(false);
  });

  /**
   * TM-2: landscape 照片同样满足 contain 契约
   */
  it("TM-2: landscape 照片 SVG 中 <image> 不超出容器边界（contain 行为）", async () => {
    const fonts = await loadFont();
    const pick = makeMockPick();
    const photo = makeMockPhotoLandscape();

    // landscape 照片 1920×1080 作 data URL（用 portrait 蓝色图替代，重要的是 photo.width/height）
    const photoDataUrl = await makePortraitDataUrl(); // 数据 URL 内容不影响 Satori 几何计算

    const WIDTH = 1920;
    const HEIGHT = 1080;

    const jsx = dailyHeroJSX({
      pick,
      photo,
      photoDataUrl,
      width: WIDTH,
      height: HEIGHT,
    });

    const svg = await satori(jsx, {
      width: WIDTH,
      height: HEIGHT,
      fonts,
    });

    const imageRects = extractImageRects(svg);
    expect(imageRects.length).toBeGreaterThan(0);

    // contain：x/y ≥ 0，width/height ≤ 容器
    const containOk = imageRects.some(
      (r) => r.x >= -1 && r.y >= -1 && r.w <= WIDTH + 1 && r.h <= HEIGHT + 1,
    );
    expect(containOk).toBe(true);

    // 防回归：无 cover 裁剪行为
    const coverFound = imageRects.some((r) => (r.x < -10 || r.y < -10) && (r.w > WIDTH || r.h > HEIGHT));
    expect(coverFound).toBe(false);
  });

  /**
   * TM-3: photoArea 背景色含 COLOR_BACKGROUND (#F9F5EC)
   *
   * 设计文档：photoArea div 加 backgroundColor: COLOR_BACKGROUND
   * Satori 渲染 SVG 时背景色会出现在 fill 属性或 style 中
   */
  it("TM-3: SVG 包含 COLOR_BACKGROUND 色值 #F9F5EC（photoArea 背景）", async () => {
    const fonts = await loadFont();
    const pick = makeMockPick();
    const photo = makeMockPhotoPortrait();
    const photoDataUrl = await makePortraitDataUrl();

    const jsx = dailyHeroJSX({
      pick,
      photo,
      photoDataUrl,
      width: 1920,
      height: 1080,
    });

    const svg = await satori(jsx, {
      width: 1920,
      height: 1080,
      fonts,
    });

    // COLOR_BACKGROUND = "#F9F5EC"（来自 colors.ts）
    // Satori 可能输出 #F9F5EC 或 rgb(249, 245, 236) 形式
    const hasBgHex = /f9f5ec/i.test(svg);
    const hasBgRgb = /rgb\(\s*249\s*,\s*245\s*,\s*236\s*\)/.test(svg);

    expect(hasBgHex || hasBgRgb).toBe(true);
  });
});

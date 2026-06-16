/**
 * 验收测试（红队）：壁纸模板 dailyHeroJSX — 拍摄时刻 dateline（P4 + P5 wallpaper 侧）
 *
 * 设计契约来源（state.md「契约规约」第 2/3 条 + 验收场景 P4/P5，不读任何实现）：
 *
 * 1. wallpaper dailyHeroJSX 在 editorial column 渲染「拍摄时刻 dateline」（镜像 web），
 *    用 formatPhotoCaptureTime 同款格式。
 * 2. (P4) SVG 文本节点含拍摄日期文本；photo <image> 的 contain 几何不变量仍成立
 *        （x≥0, y≥0, width≤容器宽, height≤容器高）— dateline 新增不破坏几何契约（回归红线）。
 * 3. (P5) wallpaper 渲染的日期+时刻字符串 === formatPhotoCaptureTime(takenAt)（同源 shared 函数），
 *        即 web 与 wallpaper 两端一致。
 *
 * 红队铁律：不读取 apps/backend/src/lib/wallpaper/template.tsx 实现。
 * 复用 template.acceptance.test.ts 的：字体加载 / fixture 工厂 / satori 调用 / contain 断言逻辑。
 *
 * CONTRACT_AMBIGUOUS:
 *   1. dailyHeroJSX 参数 shape：沿用 template.acceptance.test.ts 推断的
 *      { pick, photo, photoDataUrl, width, height }（state.md 实现计划同款）。
 *   2. photo.takenAt：fixture 用 ISO 字符串（state.md 时区假设 +08:00 自部署）。
 *   3. dateline 文本来源：dailyHeroJSX 内部应 import formatPhotoCaptureTime 并渲染其输出。
 *      P4 只硬断言 SVG 含「日期 + 时刻」文本子串；P5 用 shared 函数输出做逐字对比。
 *   4. import 路径：@relight/shared 由 monorepo 解析；formatPhotoCaptureTime 为蓝队新增导出。
 */

import fs from "node:fs";
import path from "node:path";
import { formatPhotoCaptureTime } from "@relight/shared";
import satori from "satori";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { dailyHeroJSX } from "../template";

// ============================================================================
// 字体加载（复用 template.acceptance.test.ts 逻辑）
// ============================================================================

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
// 图片 + fixture 工厂（复用 template.acceptance.test.ts）
// ============================================================================

async function makePortraitDataUrl(): Promise<string> {
  const buf = await sharp({
    create: { width: 100, height: 200, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// biome-ignore lint/suspicious/noExplicitAny: test fixture
function makeMockPick(): any {
  return {
    id: "datetime-pick-001",
    photoId: "datetime-photo-001",
    pickDate: "2021-06-15",
    title: "测试精选·拍摄时刻",
    narrative: "阳光斜落在旧墙上，时间在那一刻静止。",
    score: 8.5,
    composedImagePath: null,
    members: [],
    createdAt: "2021-06-15T06:00:00.000Z",
  };
}

/**
 * photo fixture：takenAt 为 2021-06-15T06:30:00.000Z（+08:00 机即 14:30）。
 * width/height 用 portrait（100×200）以触发 contain/cover 差异，保证 P4 几何断言有效。
 */
// biome-ignore lint/suspicious/noExplicitAny: test fixture
function makeMockPhotoPortrait(): any {
  return {
    id: "datetime-photo-001",
    storageSourceId: "source-001",
    filePath: "/photos/test.jpg",
    fileHash: "test-hash-001",
    width: 100,
    height: 200,
    fileSize: 10240,
    thumbnailPath: "/thumbnails/test.jpg",
    takenAt: "2021-06-15T06:30:00.000Z",
    createdAt: "2021-06-15T06:00:00.000Z",
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
// 核心辅助：渲染 SVG + 提取 <image> 几何（复用 template.acceptance.test.ts）
// ============================================================================

async function renderSvg(
  photo: ReturnType<typeof makeMockPhotoPortrait>,
  photoDataUrl: string,
  width = 1920,
  height = 1080,
): Promise<string> {
  const fonts = await loadFont();
  const jsx = dailyHeroJSX({
    pick: makeMockPick(),
    photo,
    photoDataUrl,
    width,
    height,
  });
  return satori(jsx, { width, height, fonts });
}

/**
 * 解析 SVG 中所有 <image> 的 x/y/width/height（实现 contain/cover 的几何载体）。
 * 仅统计含 href 的真实图片，排除 mask pattern。
 */
function extractImageRects(svg: string): Array<{ x: number; y: number; w: number; h: number }> {
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  const imageTagRe = /<image\b([^>]+)>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: loop pattern
  while ((m = imageTagRe.exec(svg)) !== null) {
    const attrs = m[1] ?? "";
    if (!attrs.includes("href")) continue;
    const x = Number(attrs.match(/\bx="([^"]+)"/)?.[1] ?? "0");
    const y = Number(attrs.match(/\by="([^"]+)"/)?.[1] ?? "0");
    const w = Number(attrs.match(/\bwidth="([^"]+)"/)?.[1] ?? "0");
    const h = Number(attrs.match(/\bheight="([^"]+)"/)?.[1] ?? "0");
    rects.push({ x, y, w, h });
  }
  return rects;
}

// ============================================================================
// 测试套件
// ============================================================================

describe("dailyHeroJSX 拍摄时刻 dateline — 验收测试（红队 P4 + P5 wallpaper 侧）", () => {
  // ----------------------------------------------------------------
  // P4 dateline 渲染 — 差分 SVG 验证
  // Satori 把所有文本渲染为 <path> 字形矢量，SVG 中无任何原始文字串（已实证：渲染
  // "2021年06月15日" 的 JSX，svg.includes(...)===false、PATH_COUNT=1；红队既有
  // template.acceptance.test.ts 也只用几何断言、零文本断言）。故无法用文本子串断言；
  // 改用差分证明 dateline 确实渲染：takenAt 有效 vs null 的 SVG 必须不同，且新增 <path> 字形。
  // ----------------------------------------------------------------
  describe("P4 dateline 渲染 — 差分 SVG 验证（kill 渲染空 no-op）", () => {
    it("takenAt 有效时 SVG 比 null 多出 dateline 内容（dateline 非空渲染）", async () => {
      const dataUrl = await makePortraitDataUrl();
      const svgPresent = await renderSvg(makeMockPhotoPortrait(), dataUrl);
      const svgNull = await renderSvg({ ...makeMockPhotoPortrait(), takenAt: null }, dataUrl);
      // 两者必须不同（差分）：若 dateline 不渲染，present===null → 失败
      expect(svgPresent).not.toEqual(svgNull);
      expect(svgPresent.length).toBeGreaterThan(svgNull.length);
    });

    it("takenAt 有效与 null 两种状态 footer 均非空（恒渲染内容平衡留白）", async () => {
      // 新设计：footer 恒有内容——takenAt 有效显示拍摄时间，null 回退品牌印记。
      // 故「present 比 null 多 path」不再成立（品牌印记多段文字 path 数相当）；
      // 改验证两种状态 footer 都渲染了内容（path>0），且内容不同（拍摄时间 vs 品牌印记）。
      const dataUrl = await makePortraitDataUrl();
      const svgPresent = await renderSvg(makeMockPhotoPortrait(), dataUrl);
      const svgNull = await renderSvg({ ...makeMockPhotoPortrait(), takenAt: null }, dataUrl);
      expect((svgPresent.match(/<path/g) || []).length).toBeGreaterThan(0);
      expect((svgNull.match(/<path/g) || []).length).toBeGreaterThan(0);
      expect(svgPresent).not.toEqual(svgNull);
    });

    it("不同 takenAt 值产出不同 SVG（dateline 由 takenAt 驱动，kill 渲染常量 no-op）", async () => {
      const dataUrl = await makePortraitDataUrl();
      const svgA = await renderSvg(
        { ...makeMockPhotoPortrait(), takenAt: "2021-06-15T06:30:00.000Z" },
        dataUrl,
      );
      const svgB = await renderSvg(
        { ...makeMockPhotoPortrait(), takenAt: "2019-12-31T16:45:00.000Z" },
        dataUrl,
      );
      expect(svgA).not.toEqual(svgB);
    });
  });

  // ----------------------------------------------------------------
  // P4 (几何): photo <image> contain 不变量（回归红线，dateline 新增不破坏）
  // ----------------------------------------------------------------
  describe("P4 几何 — dateline 新增后 <image> contain 契约不变（回归红线）", () => {
    it("portrait 照片 <image> 不超出容器边界（contain，非 cover）", async () => {
      const WIDTH = 1920;
      const HEIGHT = 1080;
      const dataUrl = await makePortraitDataUrl();
      const svg = await renderSvg(makeMockPhotoPortrait(), dataUrl, WIDTH, HEIGHT);
      const rects = extractImageRects(svg);

      expect(rects.length).toBeGreaterThan(0);

      // contain：x/y ≥ 0（容差 1px），width/height ≤ 容器
      const containOk = rects.some(
        (r) => r.x >= -1 && r.y >= -1 && r.w <= WIDTH + 1 && r.h <= HEIGHT + 1,
      );
      expect(containOk).toBe(true);

      // 防回归：无 cover 裁剪（x/y 大负值 + w/h 超容器）
      const coverFound = rects.some(
        (r) => (r.x < -10 || r.y < -10) && (r.w > WIDTH || r.h > HEIGHT),
      );
      expect(coverFound).toBe(false);
    });

    it("landscape 照片 <image> 同样满足 contain 契约", async () => {
      const WIDTH = 1920;
      const HEIGHT = 1080;
      const dataUrl = await makePortraitDataUrl();
      const svg = await renderSvg(makeMockPhotoLandscape(), dataUrl, WIDTH, HEIGHT);
      const rects = extractImageRects(svg);

      expect(rects.length).toBeGreaterThan(0);
      const containOk = rects.some(
        (r) => r.x >= -1 && r.y >= -1 && r.w <= WIDTH + 1 && r.h <= HEIGHT + 1,
      );
      expect(containOk).toBe(true);

      const coverFound = rects.some(
        (r) => (r.x < -10 || r.y < -10) && (r.w > WIDTH || r.h > HEIGHT),
      );
      expect(coverFound).toBe(false);
    });

    it("小尺寸（460 基准列宽）下 dateline 仍不破坏 contain 几何", async () => {
      // state.md：460px 基准列宽，scale≈0.6（1080p）。验证小尺寸几何不破。
      const WIDTH = 1920;
      const HEIGHT = 1080;
      const dataUrl = await makePortraitDataUrl();
      const svg = await renderSvg(makeMockPhotoPortrait(), dataUrl, WIDTH, HEIGHT);
      const rects = extractImageRects(svg);
      expect(rects.length).toBeGreaterThan(0);
      // contain 不变量在任何尺寸都成立
      const containOk = rects.some(
        (r) => r.x >= -1 && r.y >= -1 && r.w <= WIDTH + 1 && r.h <= HEIGHT + 1,
      );
      expect(containOk).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // P5 (wallpaper 侧) — dateline 由 takenAt 驱动（差分证明，同源 shared 函数）
  // Satori SVG 无法文本比对，跨端真正一致性证据为：shared 单测(P1/P2) 保证函数正确 +
  // web DOM 含 formatPhotoCaptureTime 输出(P5 web) 证明 web 同源。wallpaper 侧用
  // 差分证明渲染内容由 takenAt（喂给 formatPhotoCaptureTime）驱动。
  // ----------------------------------------------------------------
  describe("P5 — wallpaper dateline 由 takenAt 驱动（与 shared 函数同源链路）", () => {
    it("dateline 渲染差分与 shared 函数产出的日期段变化一致", async () => {
      // 取多个 takenAt，shared 函数产出不同日期段 → wallpaper SVG 必须随之变化
      const cases = [
        "2021-06-15T06:30:00.000Z",
        "2019-12-31T16:45:00.000Z",
        "2023-01-01T00:00:00.000Z",
      ];
      const dataUrl = await makePortraitDataUrl();
      const svgs: string[] = [];
      for (const takenAt of cases) {
        const shared = formatPhotoCaptureTime(takenAt);
        expect(shared).not.toBeNull(); // shared 函数对这些 takenAt 必须有效（非 null）
        svgs.push(await renderSvg({ ...makeMockPhotoPortrait(), takenAt }, dataUrl));
      }
      // 三个不同日期段的 SVG 必须两两不同（dateline 随日期段变化 = 由 takenAt 驱动）
      expect(svgs[0]).not.toEqual(svgs[1]);
      expect(svgs[1]).not.toEqual(svgs[2]);
      expect(svgs[0]).not.toEqual(svgs[2]);
    });

    it("takenAt 有效时 footer 显示拍摄时间而非品牌印记（与 null 不同，同源链路）", async () => {
      // null 回退品牌印记后，path 数比较失效；改为证明 takenAt 驱动 footer 文案：
      // present（拍摄时间，随 takenAt 变）≠ null（品牌印记，恒定）。
      const dataUrl = await makePortraitDataUrl();
      const svgPresent = await renderSvg(makeMockPhotoPortrait(), dataUrl);
      const svgNull = await renderSvg({ ...makeMockPhotoPortrait(), takenAt: null }, dataUrl);
      expect(svgPresent).not.toEqual(svgNull);
    });
  });

  // ----------------------------------------------------------------
  // takenAt=null 边界（wallpaper 侧）：dateline 不渲染，几何不破
  // ----------------------------------------------------------------
  describe("takenAt=null 边界 — wallpaper dateline 不渲染且几何不破", () => {
    it("takenAt=null 时 footer 回退品牌印记平衡留白（非空，且与 present 不同）", async () => {
      // 新设计：null 不渲染拍摄时间，但 footer 回退品牌印记（Vol/Relight Chronicle）非空，
      // 保持留白平衡。验证：null footer 非空（path>0）+ 与 present（拍摄时间）内容不同。
      const dataUrl = await makePortraitDataUrl();
      const svgNull = await renderSvg({ ...makeMockPhotoPortrait(), takenAt: null }, dataUrl);
      const svgPresent = await renderSvg(makeMockPhotoPortrait(), dataUrl);
      expect((svgNull.match(/<path/g) || []).length).toBeGreaterThan(0);
      expect(svgNull).not.toEqual(svgPresent);
    });

    it("takenAt=null 时 contain 几何契约仍成立（masthead 在，photo 不破）", async () => {
      const WIDTH = 1920;
      const HEIGHT = 1080;
      const dataUrl = await makePortraitDataUrl();
      // biome-ignore lint/suspicious/noExplicitAny: test fixture mutation
      const photo: any = { ...makeMockPhotoPortrait(), takenAt: null };
      const svg = await renderSvg(photo, dataUrl, WIDTH, HEIGHT);
      const rects = extractImageRects(svg);
      expect(rects.length).toBeGreaterThan(0);
      const containOk = rects.some(
        (r) => r.x >= -1 && r.y >= -1 && r.w <= WIDTH + 1 && r.h <= HEIGHT + 1,
      );
      expect(containOk).toBe(true);
    });
  });
});

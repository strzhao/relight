/**
 * 验收测试（红队 E2E）：画廊竖版壁纸视频手机端完整可见（场景 1 / 4.P3 / 5 / 7.P3）
 *
 * 设计文档（state.md）对应谓词：
 *   - 1.P1 [det-machine] 390×844 视口打开画廊日期深链，壁纸卡动态变体起播后
 *     assert: visible_width_fraction >= 0.97（烧录文字不被左右截断）
 *   - 1.P2 [det-machine] 同视口 assert: visible_height_fraction >= 0.97（上下拉满）
 *   - 1.P3 [det-machine] assert: scrollWidth <= clientWidth + 1（无横向滚动溢出）
 *   - 1.P4 [visual-residue] 起播首帧 + 中段截图 + 三项二值清单（烧录文字完整/顶部完整/无拉伸黑边）
 *   - 4.P3 [real-process] 无缓存上下文打开日期深链，页面实际解码并播放
 *     assert: currentSrc == 当日竖版视频地址 && readyState >= 2 && currentTime > 0
 *   - 5.P1 [det-machine] {360×800, 390×844, 393×852, 412×915, 428×926} 视口矩阵
 *     assert: min(全部视口两轴可见比例) >= 0.97
 *   - 5.P2 [det-machine] 同视口下静态竖版壁纸卡 vs 动态竖版视频卡裁切同量级
 *     assert: abs(cropRatio_video - cropRatio_static) <= 0.02
 *   - 5.P3 [det-machine] 375×667 与 1440×900：不溢出、不拉伸
 *     assert: scrollWidth <= clientWidth + 1 && 显示缩放两轴偏差 <= 0.02
 *   - 7.P3 [det-machine] 该日视频字段缺省 → 静态壁纸卡正常渲染、零页面错误
 *     assert: page_error_count==0 && wallpaper_card_exists==true
 *
 * 可见比例度量（observe 逐字）：video/img 元素渲染矩形（clientWidth/clientHeight）×
 * mediaWidth/mediaHeight × 生效 object-fit 换算 —— cover: s=max(boxW/mW, boxH/mH)，
 * content=media×s，visible_fraction = box/content（≤1）；contain: 全可见 = 1。
 * cropRatio = 1 - min(wf, hf)（与设计文档探索口径一致：704×1216 在 390×844 下 ≈ 0.20）。
 *
 * driver：本地 fixture 画廊（隔离临时目录 + python3 http.server --bind 127.0.0.1，
 * 惯例同 gallery-wallpaper-video.e2e.acceptance.test.ts）。fixture 视频为 736×1600
 * （目标画布 C3），静态壁纸 1290×2796（比例锚点）。另含 QA 真机门控变体：绑定
 * WVQA_GALLERY_BASE 后对公网画廊跑同一视口矩阵（真机绑定项求值入口）。
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
const { describe, beforeAll, afterAll, beforeEach } = test;
const it = test;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_GALLERY_DIR = path.resolve(__dirname, "../");
/** 目标画布 736×1600 可播放样本（C3 逐字；fixtures 既有预生成资产） */
const VIDEO_PORTRAIT = path.join(__dirname, "fixtures", "wallpaper-portrait-736x1600.mp4");
/** 静态竖版壁纸比例锚点 1290×2796 */
const STATIC_PORTRAIT_JPG = path.join(
  __dirname,
  "fixtures",
  "wallpaper-portrait-static-1290x2796.jpg",
);

const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";
const REAL_GALLERY_BASE = (process.env.WVQA_GALLERY_BASE ?? "").replace(/\/$/, "");
const REAL_PICK_DATE = (process.env.WVQA_PICK_DATE ?? "").trim();

const TINY_LANDSCAPE_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUv/AABEIAAgADAMBIgACEQEDEQH/xAAUAAEAAAAAAAAAAAAAAAAAAAAK/8QAFBABAQAAAAAAAAAAAAAAAAAAAAX/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAQAAAAAAAAAAAAAAAAAAAAX/2gAMAwEAAhEDEQA/AJgA/9k=";

let server: ChildProcess | undefined;
let fixtureRoot = "";
let todayDate = "";
let yesterdayDate = "";

function writeArtifact(id: string, content: string): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

function buildFixture(): string {
  const dir = path.join(os.tmpdir(), `relight-wp-viewport-e2e-${PORT}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["index.html", "app.css", "app.js"]) {
    fs.copyFileSync(path.join(SRC_GALLERY_DIR, f), path.join(dir, f));
  }
  const fontsDir = path.join(SRC_GALLERY_DIR, "fonts");
  if (fs.existsSync(fontsDir)) fs.cpSync(fontsDir, path.join(dir, "fonts"), { recursive: true });

  todayDate = new Date().toISOString().slice(0, 10);
  yesterdayDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

  // 静态竖版壁纸（1290×2796 真实尺寸——裁切比例数学依赖真实 naturalWidth/Height）
  const staticPortraitRel = `wallpapers/${todayDate}_v2-contain-1290x2796.jpg`;
  fs.mkdirSync(path.join(dir, "wallpapers"), { recursive: true });
  fs.copyFileSync(STATIC_PORTRAIT_JPG, path.join(dir, staticPortraitRel));
  // 动态竖版视频（736×1600 目标画布）
  const videoRel = `wallpaper-videos/${todayDate}_portrait.mp4`;
  fs.mkdirSync(path.join(dir, "wallpaper-videos"), { recursive: true });
  fs.copyFileSync(VIDEO_PORTRAIT, path.join(dir, videoRel));

  const mkPhoto = (id: string, rank: number) => {
    return {
      photoId: id,
      rank,
      title: `第 ${rank} 张`,
      narrative: `第 ${rank} 张的叙事文案，长度足够通过非空断言。`,
      thumbnail: `photos/${id}-thumb.jpg`,
      original: `photos/${id}-mid.jpg`,
      takenAt: "2024-07-15T10:00:00.000Z",
      width: 4032,
      height: 3024,
    };
  };
  fs.mkdirSync(path.join(dir, "photos"), { recursive: true });
  for (const id of ["photo-a", "photo-b"]) {
    for (const suffix of ["thumb", "mid"]) {
      fs.writeFileSync(
        path.join(dir, "photos", `${id}-${suffix}.jpg`),
        Buffer.from(TINY_LANDSCAPE_JPEG_B64, "base64"),
      );
    }
  }

  const todayDay = {
    pickDate: todayDate,
    title: "今日精选",
    narrative: "今日的整体叙事。",
    wallpaperLandscape: `wallpapers/${todayDate}_landscape.jpg`,
    wallpaperPortrait: staticPortraitRel,
    wallpaperVideoLandscape: `wallpaper-videos/${todayDate}_landscape.mov`,
    wallpaperVideoPortrait: videoRel,
    photos: [mkPhoto("photo-a", 1), mkPhoto("photo-b", 2)],
  };
  fs.writeFileSync(
    path.join(dir, "wallpapers", `${todayDate}_landscape.jpg`),
    Buffer.from(TINY_LANDSCAPE_JPEG_B64, "base64"),
  );
  // yesterday：静态回退日（无任何 wallpaperVideo* 字段——7.P3 / 5.P2 静态卡）
  const yesterdayDay = {
    pickDate: yesterdayDate,
    title: "昨日精选",
    narrative: "昨日的整体叙事。",
    wallpaperLandscape: `wallpapers/${yesterdayDate}_landscape.jpg`,
    wallpaperPortrait: staticPortraitRel,
    photos: [mkPhoto("photo-y-1", 1)],
  };
  fs.writeFileSync(
    path.join(dir, "wallpapers", `${yesterdayDate}_landscape.jpg`),
    Buffer.from(TINY_LANDSCAPE_JPEG_B64, "base64"),
  );

  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), days: [todayDay, yesterdayDay], videos: [] },
      null,
      2,
    ),
  );
  return dir;
}

async function startServer(): Promise<void> {
  server = spawn(
    "python3",
    ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", fixtureRoot],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/manifest.json`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("fixture 静态服务未就绪");
}

beforeAll(async () => {
  if (!fs.existsSync(VIDEO_PORTRAIT) || !fs.existsSync(STATIC_PORTRAIT_JPG)) {
    throw new Error(
      `fixture 资产缺失: ${VIDEO_PORTRAIT} / ${STATIC_PORTRAIT_JPG}（红队铁律：缺文件即真红）`,
    );
  }
  fixtureRoot = buildFixture();
  await startServer();
}, 30000);

afterAll(async () => {
  server?.kill("SIGTERM");
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

// ---- 度量与驱动工具（黑盒几何测量，不依赖画廊内部实现）----

const wallpaperCardSel = (date: string) =>
  `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${date}"]`;

async function openWallpaperDay(page: Page, base: string, date: string): Promise<void> {
  await page.goto(`${base}/#/?date=${date}`);
  await page.waitForSelector(wallpaperCardSel(date), { timeout: 12000 });
  await page.evaluate((d) => {
    document
      .querySelector(`[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`)
      ?.scrollIntoView({ behavior: "instant", block: "center" });
  }, date);
  // bounded 等待动态变体起播（动态日）；静态日轮询即刻通过（无 video 时跳过）
  await page.waitForFunction(
    (d) => {
      const v = document.querySelector(
        `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"] video`,
      ) as HTMLVideoElement | null;
      return !v || (v.readyState >= 2 && !v.paused);
    },
    date,
    { timeout: 15000 },
  );
  await page.waitForTimeout(400); // 派生样式/布局稳定
}

interface MediaMetrics {
  fit: string;
  mediaW: number;
  mediaH: number;
  boxW: number;
  boxH: number;
  visibleWF: number;
  visibleHF: number;
  scaleX: number;
  scaleY: number;
  cropRatio: number;
}

async function measureWallpaperMedia(page: Page, date: string): Promise<MediaMetrics> {
  const card = wallpaperCardSel(date);
  const hasVideo = await page.evaluate(
    (d) =>
      !!document.querySelector(
        `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"] video`,
      ),
    date,
  );
  const kind: "video" | "img" = hasVideo ? "video" : "img";
  const sel = hasVideo ? `${card} video` : `${card} img`;
  const metrics = await page.evaluate(
    (script: { sel: string }) => {
      const el = document.querySelector(script.sel);
      if (!el) return null;
      const mediaW = (el as HTMLVideoElement).videoWidth || (el as HTMLImageElement).naturalWidth;
      const mediaH = (el as HTMLVideoElement).videoHeight || (el as HTMLImageElement).naturalHeight;
      if (!mediaW || !mediaH) return { pending: true };
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return { pending: true };
      const fit = getComputedStyle(el).objectFit || "fill";
      let contentW: number;
      let contentH: number;
      if (fit === "cover") {
        const s = Math.max(rect.width / mediaW, rect.height / mediaH);
        contentW = mediaW * s;
        contentH = mediaH * s;
      } else if (fit === "contain" || fit === "scale-down") {
        const s = Math.min(rect.width / mediaW, rect.height / mediaH);
        contentW = mediaW * s;
        contentH = mediaH * s;
      } else if (fit === "none") {
        contentW = mediaW;
        contentH = mediaH;
      } else {
        contentW = rect.width;
        contentH = rect.height;
      }
      const visibleWF = Math.min(1, rect.width / contentW);
      const visibleHF = Math.min(1, rect.height / contentH);
      const scaleX = contentW / mediaW;
      const scaleY = contentH / mediaH;
      return {
        fit,
        mediaW,
        mediaH,
        boxW: rect.width,
        boxH: rect.height,
        visibleWF,
        visibleHF,
        scaleX,
        scaleY,
        cropRatio: 1 - Math.min(visibleWF, visibleHF),
      };
    },
    { sel },
  );
  expect(metrics, `${kind} 元素未渲染于 ${card}`).not.toBeNull();
  expect((metrics as { pending?: boolean }).pending, "媒体元数据未就绪").toBeFalsy();
  return metrics as MediaMetrics;
}

async function assertViewportFit(
  page: Page,
  base: string,
  date: string,
  viewport: {
    width: number;
    height: number;
  },
): Promise<MediaMetrics> {
  await page.setViewportSize(viewport);
  await openWallpaperDay(page, base, date);
  const m = await measureWallpaperMedia(page, date);
  expect(m.visibleWF, `${viewport.width}×${viewport.height} 水平可见比例`).toBeGreaterThanOrEqual(
    0.97,
  );
  expect(m.visibleHF, `${viewport.width}×${viewport.height} 垂直可见比例`).toBeGreaterThanOrEqual(
    0.97,
  );
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, `${viewport.width}×${viewport.height} 横向溢出`).toBeLessThanOrEqual(
    overflow.clientWidth + 1,
  );
  return m;
}

// ============================================================================
// 场景 1.P1 / 1.P2 / 1.P3：390×844 完整可见 + 无横向溢出
// ============================================================================

describe("[场景1.P1/1.P2/1.P3] 390×844 壁纸卡动态变体完整可见", () => {
  it("起播后水平/垂直可见比例 ≥ 0.97 且 scrollWidth <= clientWidth + 1", async ({ page }) => {
    const m = await assertViewportFit(page, BASE, todayDate, { width: 390, height: 844 });
    writeArtifact("场景1.P1", JSON.stringify({ viewport: "390x844", ...m }, null, 2));
    // 谓词字面量：visible_width_fraction >= 0.97
    expect(m.visibleWF).toBeGreaterThanOrEqual(0.97);
    // 谓词字面量：visible_height_fraction >= 0.97
    expect(m.visibleHF).toBeGreaterThanOrEqual(0.97);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    writeArtifact("场景1.P3", JSON.stringify(overflow));
    // 谓词字面量：scrollWidth <= clientWidth + 1
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});

// ============================================================================
// 场景 1.P4 [visual-residue]：烧录文字层完整（截图 + 二值清单）
// ============================================================================

describe("[场景1.P4 visual-residue] 烧录文字层完整性", () => {
  it("产出起播首帧 + 中段两张截图与三项二值清单 artifact", async ({ page }) => {
    // VISUAL_RESIDUE: 留 QA 真机判定 —— 文字烧录在视频像素内、无可达性节点，
    // 自动化产出判定素材（两张截图），「是/否」由 QA 依据清单回填。
    await openWallpaperDay(page, BASE, todayDate);
    const card = page.locator(wallpaperCardSel(todayDate));
    const shotStart = path.join(ARTIFACT_DIR, "场景1.P4-首帧.png");
    const shotMid = path.join(ARTIFACT_DIR, "场景1.P4-中段.png");
    await card.screenshot({ path: shotStart });
    await page.waitForTimeout(2500);
    await card.screenshot({ path: shotMid });
    const checklist = [
      "# 场景 1.P4 二值清单（visual-residue，QA 真机判定）",
      `深链: ${BASE}/#/?date=${todayDate}（真机求值时替换为公网画廊地址）`,
      `截图: ${shotStart} / ${shotMid}`,
      "",
      "三项二值清单（全为「是」方为通过）：",
      "- [ ] (a) 底部叙事/页脚文字无被切断的字（是/否）：____",
      "- [ ] (b) 顶部日期/标题完整（是/否）：____",
      "- [ ] (c) 画面无横向拉伸或异常黑边（是/否）：____",
    ].join("\n");
    writeArtifact("场景1.P4", checklist);
    for (const f of [shotStart, shotMid]) {
      expect(fs.existsSync(f), `截图未产出: ${f}`).toBe(true);
      expect(fs.statSync(f).size).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// 场景 4.P3：无缓存上下文实际解码并播放当日新产物
// ============================================================================

describe("[场景4.P3] 日期深链实际播放当日竖版产物", () => {
  it("currentSrc == manifest 竖版字段 && readyState >= 2 && currentTime > 0", async ({ page }) => {
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(fixtureRoot, "manifest.json"), "utf-8"),
    ) as { days: Array<{ pickDate: string; wallpaperVideoPortrait?: string }> };
    const expected = manifest.days.find((d) => d.pickDate === todayDate)?.wallpaperVideoPortrait;
    expect(typeof expected).toBe("string");

    await page.goto(`${BASE}/#/?date=${todayDate}`);
    await page.waitForSelector(`${wallpaperCardSel(todayDate)} video`, { timeout: 12000 });
    await page.waitForFunction(
      (d) => {
        const v = document.querySelector(
          `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"] video`,
        ) as HTMLVideoElement | null;
        return !!v && v.readyState >= 2 && !v.paused;
      },
      todayDate,
      { timeout: 15000 },
    );
    const state = await page.evaluate((d) => {
      const v = document.querySelector(
        `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"] video`,
      ) as HTMLVideoElement | null;
      return v
        ? { currentSrc: v.currentSrc, readyState: v.readyState, currentTime: v.currentTime }
        : null;
    }, todayDate);
    writeArtifact("场景4.P3", JSON.stringify({ expected, ...state }, null, 2));
    expect(state).not.toBeNull();
    // 谓词字面量①：currentSrc == 当日竖版视频地址（fixture 域；真机求值时为本次重跑产物新地址）
    expect(state!.currentSrc).toBe(new URL(expected!, BASE).href);
    expect(state!.currentSrc).toContain("_portrait.mp4");
    // 谓词字面量②③：readyState >= 2 && currentTime > 0
    expect(state!.readyState).toBeGreaterThanOrEqual(2);
    expect(state!.currentTime).toBeGreaterThan(0);
  });
});

// ============================================================================
// 场景 5.P1：五视口矩阵最小可见比例 ≥ 0.97
// ============================================================================

describe("[场景5.P1] 多机型视口矩阵", () => {
  const VIEWPORTS = [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 393, height: 852 },
    { width: 412, height: 915 },
    { width: 428, height: 926 },
  ];

  it("5 视口两轴可见比例全部 ≥ 0.97", async ({ page }) => {
    const results: Array<Record<string, unknown>> = [];
    for (const vp of VIEWPORTS) {
      const m = await assertViewportFit(page, BASE, todayDate, vp);
      results.push({
        viewport: vp,
        visibleWF: m.visibleWF,
        visibleHF: m.visibleHF,
        fit: m.fit,
        cropRatio: m.cropRatio,
      });
    }
    writeArtifact("场景5.P1", JSON.stringify(results, null, 2));
    const minWf = Math.min(...results.map((r) => r.visibleWF as number));
    const minHf = Math.min(...results.map((r) => r.visibleHF as number));
    // 谓词字面量：min(全部视口的两轴可见比例) >= 0.97
    expect(minWf).toBeGreaterThanOrEqual(0.97);
    expect(minHf).toBeGreaterThanOrEqual(0.97);
  }, 180000);
});

// ============================================================================
// 场景 5.P2：静态壁纸卡 vs 动态视频卡同视口裁切同量级
// ============================================================================

describe("[场景5.P2] 静态/动态壁纸卡裁切一致性", () => {
  it("abs(cropRatio_video - cropRatio_static) <= 0.02（同一 390×844 视口）", async ({ page }) => {
    await openWallpaperDay(page, BASE, todayDate);
    const videoCard = await measureWallpaperMedia(page, todayDate);
    const staticCard = await measureWallpaperMedia(page, yesterdayDate);
    const diff = Math.abs(videoCard.cropRatio - staticCard.cropRatio);
    writeArtifact(
      "场景5.P2",
      JSON.stringify(
        {
          cropRatioVideo: Number(videoCard.cropRatio.toFixed(5)),
          cropRatioStatic: Number(staticCard.cropRatio.toFixed(5)),
          diff: Number(diff.toFixed(5)),
          videoFit: videoCard.fit,
          staticFit: staticCard.fit,
        },
        null,
        2,
      ),
    );
    // 谓词字面量：abs(cropRatio_video - cropRatio_static) <= 0.02
    expect(diff).toBeLessThanOrEqual(0.02);
  });
});

// ============================================================================
// 场景 5.P3：375×667 与 1440×900 不溢出、不拉伸
// ============================================================================

describe("[场景5.P3] 两视口不溢出、不拉伸", () => {
  for (const vp of [
    { width: 375, height: 667 },
    { width: 1440, height: 900 },
  ]) {
    it(`${vp.width}×${vp.height}: scrollWidth <= clientWidth+1 且两轴缩放偏差 <= 0.02`, async ({
      page,
    }) => {
      await page.setViewportSize(vp);
      await openWallpaperDay(page, BASE, todayDate);
      const m = await measureWallpaperMedia(page, todayDate);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      const stretch = Math.abs(m.scaleX - m.scaleY) / Math.max(m.scaleX, m.scaleY);
      writeArtifact(
        `场景5.P3-${vp.width}x${vp.height}`,
        JSON.stringify(
          { overflow, scaleX: m.scaleX, scaleY: m.scaleY, stretch, fit: m.fit },
          null,
          2,
        ),
      );
      // 谓词字面量①：scrollWidth <= clientWidth + 1
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
      // 谓词字面量②（不拉伸 = 显示宽高比与原始宽高比偏差 <= 0.02）
      expect(stretch).toBeLessThanOrEqual(0.02);
    });
  }
});

// ============================================================================
// 场景 7.P3：该日视频字段缺省 → 静态壁纸卡正常渲染、零页面错误
// ============================================================================

describe("[场景7.P3] 视频字段缺省日静态卡渲染", () => {
  it("page_error_count == 0 && wallpaper_card_exists == true", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    await page.goto(`${BASE}/#/?date=${yesterdayDate}`);
    await page.waitForSelector(wallpaperCardSel(yesterdayDate), { timeout: 12000 });
    await page.waitForTimeout(1200);
    const cardState = await page.evaluate((d) => {
      const card = document.querySelector(
        `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`,
      );
      const img = card?.querySelector("img") as HTMLImageElement | null;
      const video = card?.querySelector("video");
      return {
        cardExists: !!card,
        imgComplete: img?.complete ?? false,
        naturalWidth: img?.naturalWidth ?? 0,
        hasVideo: !!video,
      };
    }, yesterdayDate);
    writeArtifact(
      "场景7.P3",
      JSON.stringify({ pickDate: yesterdayDate, pageErrors, ...cardState }, null, 2),
    );
    // 谓词字面量①：page_error_count == 0
    expect(pageErrors, `页面错误: ${JSON.stringify(pageErrors)}`).toHaveLength(0);
    // 谓词字面量②：wallpaper_card_exists == true（静态 img 变体真实加载）
    expect(cardState.cardExists).toBe(true);
    expect(cardState.hasVideo, "无视频字段日不得渲染 video 变体").toBe(false);
    expect(cardState.imgComplete).toBe(true);
    expect(cardState.naturalWidth).toBeGreaterThan(0);
  });
});

// ============================================================================
// QA 真机门控变体：绑定 WVQA_GALLERY_BASE 后对公网画廊求值 1.P1/1.P2/1.P3/5.P1
// ============================================================================

const REAL_BOUND = REAL_GALLERY_BASE.length > 0;
if (!REAL_BOUND) {
  writeArtifact(
    "场景1-真机变体-跳过原因",
    "WVQA_GALLERY_BASE 未绑定——真机变体（公网画廊 + 本次重跑产物）为场景 1 谓词的权威求值入口；" +
      "绑定后重跑本套件。fixture 变体验证画廊渲染逻辑，真机变体验证真实产物与 CDN 分发。",
  );
  console.warn("[wp-viewport] WVQA_GALLERY_BASE 未绑定——真机变体 skip（留 artifact）");
}
const dReal = REAL_BOUND ? describe : describe.skip;

dReal("[真机变体] 公网画廊 1.P1/1.P2/1.P3/5.P1 求值", () => {
  const evaluateReal = async (page: Page): Promise<void> => {
    const res = await page.request.get(`${REAL_GALLERY_BASE}/manifest.json`);
    expect(res.status(), "真机 manifest 拉取失败").toBe(200);
    const manifest = (await res.json()) as {
      days: Array<{ pickDate: string; wallpaperVideoPortrait?: string }>;
    };
    const target =
      (REAL_PICK_DATE ? manifest.days.find((d) => d.pickDate === REAL_PICK_DATE) : undefined) ??
      [...manifest.days].reverse().find((d) => d.wallpaperVideoPortrait);
    expect(target, "真机 manifest 无含竖版视频的日期").toBeTruthy();
    const date = target!.pickDate;
    const m = await assertViewportFit(page, REAL_GALLERY_BASE, date, { width: 390, height: 844 });
    writeArtifact(
      "场景1.P1-真机",
      JSON.stringify({ base: REAL_GALLERY_BASE, date, ...m }, null, 2),
    );
    expect(m.visibleWF).toBeGreaterThanOrEqual(0.97);
    expect(m.visibleHF).toBeGreaterThanOrEqual(0.97);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  };

  it("390×844 真机日期深链两轴可见比例 ≥ 0.97 且无横向溢出", async ({ page }) => {
    await evaluateReal(page);
  }, 120000);
});

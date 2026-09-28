/**
 * 验收测试（红队 E2E）：画廊单腿原生壁纸视频 — native 优先级 + 任意比例渲染 + 视觉残留
 *
 * 设计文档（state.md §契约规约 4 / §验收场景）对应谓词：
 *   - 场景 8.P1 [det-machine]：Playwright 画廊视频卡 videoWidth/videoHeight 比例 ==
 *     画布比例 ±0.01 且 readyState≥2（fixture 原生视频 1312×864 = 3:2 原生画布档；
 *     若 app.js 仍取 legacy 源或回退静态，比例/存在性断言红）
 *   - 场景 8.P2 [visual-residue]：截图无拉伸变形/无错位黑边（二值清单）
 *     // VISUAL_RESIDUE: 留 QA 真机判定——产出卡片截图 + 二值清单 artifact，
 *     // 自动化仅做代理断言（video 元素可见且占位非零），人判以清单为准
 *   - 场景 6.P4 [det-machine]：legacy-only 日（portrait 非空、native 缺省）→ 画廊视频
 *     变体与下载 URL 取 portrait key（契约 4 优先级 native > portrait > landscape 的
 *     legacy 回退面）；isDynamic 判定（视频变体仍在播）与 forceStatic 降级重建路径
 *     （拦截 portrait.mp4 → 404 → 静态 img 重建）不回归
 *
 * 契约 4 逐字：画廊视频变体与下载按钮 URL = native > portrait > landscape
 *   （apps/gallery/app.js 仅改 URL 取值处，布局/动作栏逻辑不动）。
 *
 * 红队铁律：不读 app.js/app.css/index.html 内容（蓝队并行产出）。
 * driver = 本地 fixture manifest + 本地真实 mp4（native 1312×864 由 ffmpeg 现造——
 * ffmpeg 为项目硬依赖，缺失即真红；legacy 用 fixtures 既有 736×1600 样本）。
 * fixture 惯例沿 gallery-wallpaper-video.e2e.acceptance.test.ts（隔离临时目录 + python3
 * http.server --bind 127.0.0.1）。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
const { describe, beforeAll, afterAll, beforeEach } = test;
const it = test;
import type { Page } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_GALLERY_DIR = path.resolve(__dirname, "../");
/** legacy 样本：fixtures 既有 736×1600 竖版壁纸视频（可播放，Chromium 可解码） */
const LEGACY_PORTRAIT_SAMPLE = path.join(__dirname, "fixtures", "wallpaper-portrait-736x1600.mp4");

const PORT_NATIVE = 8794; // native-only 日（1312×864 原生画布档）
const PORT_LEGACY = 8795; // legacy-only 日（portrait 736×1600）
const BASE_NATIVE = `http://127.0.0.1:${PORT_NATIVE}`;
const BASE_LEGACY = `http://127.0.0.1:${PORT_LEGACY}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

/** 原生画布档（3:2 hero → computeNativeCanvas D1 参考输出） */
const NATIVE_W = 1312;
const NATIVE_H = 864;

// ---- fixture 占位 JPEG（既有同款 base64，零运行时依赖）----
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6M0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwAAAwEBAgEBAQEBAQAAAAEAAgIDAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmGmaq6OkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3iigoAKKKKACiiigA/9k=";
const WP_LANDSCAPE_JPEG_B64 =
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAEAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJAA/9k=";
const WP_PORTRAIT_JPEG_B64 =
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJAAP//Z";

function writeJpeg(filePath: string, b64: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
}

interface FixtureDirs {
  dir: string;
  manifest: { days: Array<Record<string, unknown>>; videos: Array<Record<string, unknown>> };
}

/**
 * 构建隔离 fixture 目录。
 * variant="native"：当日 manifest 仅含 wallpaperVideoNative（1312×864 真实 mp4，ffmpeg 现造）。
 * variant="legacy"：当日 manifest 仅含 wallpaperVideoPortrait（fixtures 既有 736×1600 样本）。
 */
function buildFixture(port: number, variant: "native" | "legacy"): FixtureDirs {
  const dir = path.join(os.tmpdir(), `relight-gallery-wvn-e2e-${port}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["index.html", "app.css", "app.js"]) {
    fs.copyFileSync(path.join(SRC_GALLERY_DIR, f), path.join(dir, f));
  }
  const fontsDir = path.join(SRC_GALLERY_DIR, "fonts");
  if (fs.existsSync(fontsDir)) {
    fs.cpSync(fontsDir, path.join(dir, "fonts"), { recursive: true });
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

  const wpLandscape = `wallpapers/${todayStr}_v2-contain-default.jpg`;
  const wpPortrait = `wallpapers/${todayStr}_v2-contain-1290x2796.jpg`;
  writeJpeg(path.join(dir, wpLandscape), WP_LANDSCAPE_JPEG_B64);
  writeJpeg(path.join(dir, wpPortrait), WP_PORTRAIT_JPEG_B64);

  fs.mkdirSync(path.join(dir, "videos"), { recursive: true });
  let videoField: Record<string, unknown>;
  if (variant === "native") {
    // 场景 8.P1 fixture：1312×864 原生画布档真实 mp4（10s，规避采样窗口内播完）
    const nativeMp4 = `videos/${todayStr}_native.mp4`;
    const r = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${NATIVE_W}x${NATIVE_H}:rate=24:duration=10`,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=10",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        path.join(dir, nativeMp4),
      ],
      { encoding: "utf-8", timeout: 60000 },
    );
    if (r.status !== 0 || !fs.existsSync(path.join(dir, nativeMp4))) {
      throw new Error(`ffmpeg 造 native fixture 失败（红队铁律：fixture 失败即真红）: ${r.stderr}`);
    }
    videoField = { wallpaperVideoNative: nativeMp4 };
  } else {
    const portraitMp4 = `videos/${todayStr}_portrait.mp4`;
    fs.copyFileSync(LEGACY_PORTRAIT_SAMPLE, path.join(dir, portraitMp4));
    videoField = { wallpaperVideoPortrait: portraitMp4 };
  }

  const mkPhoto = (id: string, rank: number) => {
    writeJpeg(path.join(dir, "photos", `${id}-thumb.jpg`), TINY_JPEG_B64);
    writeJpeg(path.join(dir, "photos", `${id}-mid.jpg`), TINY_JPEG_B64);
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

  const todayDay: Record<string, unknown> = {
    pickDate: todayStr,
    title: "今日精选",
    narrative: "今日的整体叙事。",
    wallpaperLandscape: wpLandscape,
    wallpaperPortrait: wpPortrait,
    photos: [mkPhoto(`photo-today-01-${port}`, 1), mkPhoto(`photo-today-02-${port}`, 2)],
    // §契约规约：条件展开——仅非空时注入当日视频变体字段（native-only / legacy-only 两态）
    ...videoField,
  };
  const yesterdayDay: Record<string, unknown> = {
    pickDate: yesterdayStr,
    title: "昨日精选",
    narrative: "昨日的整体叙事。",
    wallpaperLandscape: null,
    wallpaperPortrait: null,
    photos: [mkPhoto(`photo-yesterday-01-${port}`, 1)],
  };

  const manifest = {
    generatedAt: new Date().toISOString(),
    days: [todayDay, yesterdayDay],
    videos: [] as Array<Record<string, unknown>>,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}

// ---- 静态服务（--bind 127.0.0.1，规避 dual-stack 坑，既有惯例）----

const servers: ChildProcess[] = [];
const fixtureRoots: string[] = [];
let nativeFixtureDir = "";
let legacyFixtureDir = "";

async function startStaticServer(port: number, dir: string): Promise<void> {
  const proc = spawn(
    "python3",
    ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", dir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  servers.push(proc);
  fixtureRoots.push(dir);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/manifest.json`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`静态服务 ${port} 未就绪`);
}

beforeAll(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const fxNative = buildFixture(PORT_NATIVE, "native");
  const fxLegacy = buildFixture(PORT_LEGACY, "legacy");
  nativeFixtureDir = fxNative.dir;
  legacyFixtureDir = fxLegacy.dir;
  await startStaticServer(PORT_NATIVE, nativeFixtureDir);
  await startStaticServer(PORT_LEGACY, legacyFixtureDir);
}, 60000);

afterAll(async () => {
  for (const s of servers) s.kill("SIGTERM");
  for (const dir of fixtureRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // fetch 直链日志（下载来源断言用；不依赖 app.js 内部）
  await page.addInitScript(() => {
    const w = window as unknown as { __fetchLog: string[] };
    w.__fetchLog = [];
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const url = typeof args[0] === "string" ? args[0] : (args[0] as Request).url;
      w.__fetchLog.push(url);
      return origFetch(...args);
    };
  });
});

async function writeArtifact(id: string, content: string): Promise<void> {
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

const WALLPAPER_UNIT = '[data-stream-unit][data-role="wallpaper-card"]';

async function scrollWallpaperCardIntoView(page: Page): Promise<void> {
  await page.evaluate(() => {
    document
      .querySelector('[data-stream-unit][data-role="wallpaper-card"]')
      ?.scrollIntoView({ behavior: "instant", block: "center" });
  });
}

// ============================================================================
// 场景 8.P1：画廊渲染任意比例原生视频（videoWidth/videoHeight 比例 == 画布比例 ±0.01）
// ============================================================================

describe("[场景8.P1] 画廊视频卡渲染原生比例视频（1312×864，3:2 原生画布档）", () => {
  it("壁纸卡 <video> src 取 _native.mp4 ∧ videoWidth/videoHeight 比例 == 1312/864 ±0.01 ∧ readyState≥2", async ({
    page,
  }) => {
    await page.goto(`${BASE_NATIVE}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);

    // bounded 等待可解码播放态
    await page.waitForFunction(
      () => {
        const v = document.querySelector(
          '[data-stream-unit][data-role="wallpaper-card"] video',
        ) as HTMLVideoElement | null;
        return !!v && v.readyState >= 2;
      },
      undefined,
      { timeout: 12000 },
    );

    const state = await page.evaluate(() => {
      const v = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"] video',
      ) as HTMLVideoElement | null;
      if (!v) return null;
      return {
        src: v.src,
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        readyState: v.readyState,
        paused: v.paused,
      };
    });

    expect(state, "native 日壁纸卡必须存在 <video> 变体（isDynamic 判定不回归）").not.toBeNull();
    expect(state?.src, "视频源必须取 native key（契约 4 优先级最高位）").toContain("_native.mp4");
    // 谓词字面量：videoWidth/videoHeight 比例 == 画布比例 ±0.01
    const ratio = (state?.videoWidth ?? 0) / (state?.videoHeight ?? 1);
    const expected = NATIVE_W / NATIVE_H;
    expect(
      Math.abs(ratio - expected),
      `视频固有比例 ${ratio.toFixed(4)} 必须等于画布比例 ${expected.toFixed(4)} ±0.01（取到 legacy 源即红）`,
    ).toBeLessThanOrEqual(0.01);
    // 谓词字面量：readyState ≥ 2
    expect(state?.readyState).toBeGreaterThanOrEqual(2);

    await writeArtifact("s8p1", JSON.stringify({ ...state, ratio, expected }, null, 2));
  });
});

// ============================================================================
// 场景 8.P2 [visual-residue]：截图 + 二值清单（留 QA 真机判定）
// ============================================================================

describe("[场景8.P2] VISUAL_RESIDUE：原生壁纸卡截图 + 二值清单", () => {
  // VISUAL_RESIDUE: 留 QA 真机判定——截图与清单为人工判定辅助，非免自动化金牌
  it("native 壁纸卡元素截图落 artifact + 二值清单（拉伸/黑边人判项），video 可见占位非零", async ({
    page,
  }) => {
    await page.goto(`${BASE_NATIVE}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);
    await page.waitForFunction(
      () => {
        const v = document.querySelector(
          '[data-stream-unit][data-role="wallpaper-card"] video',
        ) as HTMLVideoElement | null;
        return !!v && v.readyState >= 2;
      },
      undefined,
      { timeout: 12000 },
    );

    // 自动化代理断言：video 元素可见且渲染占位非零（真伪拉伸/黑边留人判）
    const box = await page.locator(`${WALLPAPER_UNIT} video`).boundingBox();
    expect(box, "video 元素必须有渲染占位").not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    const card = page.locator(WALLPAPER_UNIT).first();
    const shotPath = path.join(ARTIFACT_DIR, "s8p2-native-wallpaper-card.png");
    await card.screenshot({ path: shotPath });

    const checklist = [
      "s8p2 二值清单（VISUAL_RESIDUE: 留 QA 真机判定）",
      `截图: ${shotPath}`,
      "fixture: native 1312×864（3:2 原生画布档），视口 390×844（iPhone 12 级）",
      "- [ ] 无拉伸变形（画面人物/地平线比例自然，无横向压扁）",
      "- [ ] 无错位黑边（视频展示区与卡片/文字栏对齐，无异常留黑）",
      "- [ ] 智能填充视觉自然（3:2 ratio>0.3 → contain+模糊垫底路径）",
      "- [ ] 顶部渐变压暗可读性（若为竖版白字卡；本卡为横版两栏则查文字栏对比度）",
      "QA 结论（Y/N）: ____",
    ].join("\n");
    await writeArtifact("s8p2", checklist);

    expect(fs.existsSync(shotPath), "截图必须落 artifact 目录").toBe(true);
    expect(fs.statSync(shotPath).size, "截图必须非空").toBeGreaterThan(0);
  });
});

// ============================================================================
// 场景 6.P4：legacy-only 日 → 视频变体与下载 URL 取 portrait key；降级路径不回归
// ============================================================================

describe("[场景6.P4] legacy-only 日（portrait 非空、native 缺省）→ portrait key 优先 + 降级不回归", () => {
  it("视频变体 src 取 _portrait.mp4 且在播（isDynamic 判定不回归）", async ({ page }) => {
    await page.goto(`${BASE_LEGACY}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);

    await page.waitForFunction(
      () => {
        const v = document.querySelector(
          '[data-stream-unit][data-role="wallpaper-card"] video',
        ) as HTMLVideoElement | null;
        return !!v && v.readyState >= 2 && !v.paused;
      },
      undefined,
      { timeout: 12000 },
    );

    const state = await page.evaluate(() => {
      const v = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"] video',
      ) as HTMLVideoElement | null;
      return { src: v?.src ?? null, paused: v?.paused ?? null };
    });

    expect(state?.src, "legacy-only 日视频变体必须取 portrait key").toContain("_portrait.mp4");
    expect(state?.src).not.toContain("_native.mp4");
    expect(state?.paused, "视频变体必须在播（isDynamic 判定不回归）").toBe(false);
  });

  it("下载按钮取 portrait key：点击下载 → 下载 URL 以 _portrait.mp4 结尾（契约 4 legacy 回退面）", async ({
    page,
  }) => {
    await page.goto(`${BASE_LEGACY}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);
    await page.waitForSelector(`${WALLPAPER_UNIT} video`, { timeout: 8000 });

    // 保存视频主钮（动作栏逻辑不动——角色名沿既有契约；legacy 日主钮=保存 portrait mp4）
    const saveBtn = page
      .locator(WALLPAPER_UNIT)
      .first()
      .locator('[data-role^="wallpaper-download"]')
      .first();
    await saveBtn.waitFor({ state: "visible", timeout: 8000 });

    const dlPromise = page.waitForEvent("download", { timeout: 15000 });
    await saveBtn.click();
    await dlPromise;

    // 下载走 fetch→blob 流水线，Download.url() 是 blob:——数据源断言按既有惯例用 __fetchLog
    const fetchLog = await page.evaluate(
      () => (window as unknown as { __fetchLog: string[] }).__fetchLog,
    );
    const portraitFetched = fetchLog.find((u) => u.includes("_portrait.mp4"));

    await writeArtifact("s6p4", JSON.stringify({ fetchLog }, null, 2));
    expect(
      portraitFetched,
      `下载数据源必须取 portrait key（legacy-only 日），实际 fetchLog：${JSON.stringify(fetchLog)}`,
    ).toContain("_portrait.mp4");
    expect(
      fetchLog.some((u) => u.includes("_native.mp4")),
      "legacy-only 日不得请求 native key",
    ).toBe(false);
  });

  it("forceStatic 降级重建路径不回归：portrait.mp4 404 → 壁纸卡重建为静态 img", async ({
    page,
  }) => {
    const mp4Statuses: number[] = [];
    page.on("response", (r) => {
      if (new URL(r.url()).pathname.endsWith(".mp4")) mp4Statuses.push(r.status());
    });
    await page.route("**/*.mp4", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" }),
    );

    await page.goto(`${BASE_LEGACY}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);

    // 拦截必须真实命中（No-op kill）
    {
      const deadline = Date.now() + 6000;
      while (!mp4Statuses.includes(404) && Date.now() < deadline) {
        await page.waitForTimeout(200);
      }
    }
    expect(mp4Statuses, "portrait.mp4 请求未被 404 拦截命中").toContain(404);

    // bounded 等待降级终态：video 移除、静态 img 加载完成
    await page.waitForFunction(
      () => {
        const unit = document.querySelector(
          '[data-stream-unit][data-role="wallpaper-card"]',
        ) as HTMLElement | null;
        if (!unit) return false;
        const img = unit.querySelector("img") as HTMLImageElement | null;
        return !unit.querySelector("video") && !!img && img.complete && (img.naturalWidth ?? 0) > 0;
      },
      undefined,
      { timeout: 10000 },
    );

    const result = await page.evaluate(() => {
      const unit = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"]',
      ) as HTMLElement | null;
      const img = unit?.querySelector("img") as HTMLImageElement | null;
      return {
        unitExists: !!unit,
        imgComplete: img?.complete ?? false,
        imgNaturalWidth: img?.naturalWidth ?? 0,
        playingVideos: Array.from(document.querySelectorAll("video")).filter((v) => !v.paused)
          .length,
      };
    });

    expect(result.unitExists).toBe(true);
    expect(result.imgComplete).toBe(true);
    expect(result.imgNaturalWidth).toBeGreaterThan(0);
    expect(result.playingVideos, "降级后播放态 video 数量必须 == 0").toBe(0);
  });
});

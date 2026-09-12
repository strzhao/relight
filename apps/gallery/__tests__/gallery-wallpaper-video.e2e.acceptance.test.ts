/**
 * 验收测试（红队 E2E）：画廊壁纸卡视频变体 + 视频不可用回退静态竖图
 *【v2 增量】点击开声/再击关声（复用 renderVideoCard 声音按钮交互）+ 回退语义不破坏
 *
 * 设计文档（state.md）对应谓词：
 *   - 场景 3.P1 [real-process]：壁纸卡进入视口 → <video> 自动播放当日壁纸视频且静音循环
 *     assert: video exists AND muted == true AND loop == true AND readyState >= 2 AND paused == false
 *   - 场景 3.P2 [det-machine]：壁纸卡视频源 == manifest 中当日竖版视频字段值
 *     assert: video.src == manifest 竖版视频 URL
 *   - 场景 3.P3 [det-machine]：播放进度单调前进（跨 loop 回绕除外）
 *     assert: (t2 > t1) OR (t1 > t2 AND t2 < 1)
 *   - 场景 7.P1 [real-process]：视频不可达或 manifest 无视频字段 → 回退展示静态竖版 JPEG
 *     assert: fallback img exists AND img.complete == true AND img.naturalWidth > 0
 *             AND 播放态 video 数量 == 0
 *   - 场景 7.P2 [det-machine]：视频字段缺失或加载失败 → 零 video 相关 JS 错误且卡片容器完整渲染
 *     assert: video 相关 console.error 数量 == 0 AND 卡片容器 exists
 *
 * 设计契约（§画廊设计 / §契约规约 前端 UI）：
 *   - day.wallpaperVideoPortrait 非空 → video 变体：容器 .wallpaper-stage（模糊封面 img 垫底
 *     = wallpaperPortrait）+ <video src=wallpaperVideoPortrait poster=wallpaperPortrait
 *     muted loop playsinline preload="metadata">
 *   - 【v2】点击切静音（复用 renderVideoCard 的声音按钮交互：默认静音自动播放，单击开声/
 *     再击关闭）——声音按钮既有约定 data-role="video-sound"（见 gallery-video-fullscreen
 *     e2e 的既有契约），机读态 data-sound-state="muted|unmuted"
 *   - video error 事件 → 整单元重渲为现有静态 img 变体（吞错，零 console.error，回退语义）
 *   - 回退不变式：字段缺省或 video error → DOM 结果 `<img src=day.wallpaperPortrait>`
 *     （【v2】现状无声音按钮——回退 DOM 不得残留点击开声控件）
 *   - dataset：unitType=wallpaper（+ hasVideo="1"）
 *
 * 红队铁律：不读 app.js/app.css/index.html 内容（蓝队并行产出）。
 *   driver = 路由拦截（page.route 制造视频 404）+ 本地 fixture manifest + 本地可播放视频。
 *   fixture 惯例沿 gallery-video-errors.e2e.acceptance.test.ts（隔离临时目录 + python3
 *   http.server --bind 127.0.0.1，规避 dual-stack/getfqdn 挂死坑）。
 */
import { type ChildProcess, spawn } from "node:child_process";
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
/** 预生成可播放 mp4 样本（10 秒 / baseline H.264，Chromium 可解码 autoplay；fixtures 既有资产） */
const VIDEO_SAMPLE = path.join(__dirname, "fixtures", "video-sample.mp4");

const PORT_VIDEO = 8792; // manifest 含当日竖版视频字段
const PORT_STATIC = 8793; // manifest 无任何视频字段（回退分支）
const BASE_VIDEO = `http://127.0.0.1:${PORT_VIDEO}`;
const BASE_STATIC = `http://127.0.0.1:${PORT_STATIC}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

// ---- fixture 占位 JPEG（零运行时依赖；横 8×4 / 竖 4×8 / 1×1，与 gen-manifest.mjs 同源）----
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomIygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmGmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3iigoAKKKKACiiigA/9k=";
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
  manifest: {
    days: Array<Record<string, unknown>>;
    videos: Array<Record<string, unknown>>;
  };
}

/**
 * 构建隔离 fixture 目录：三件套 + fonts + manifest.json + 壁纸占位图 + 竖版视频。
 * withVideo=false 时 manifest 不含任何 wallpaperVideo* 字段（回退分支 fixture）。
 */
function buildFixture(port: number, withVideo: boolean): FixtureDirs {
  const dir = path.join(os.tmpdir(), `relight-gallery-wv-e2e-${port}`);
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

  const wpTodayLandscape = `wallpapers/${todayStr}_v2-contain-default.jpg`;
  const wpTodayPortrait = `wallpapers/${todayStr}_v2-contain-1290x2796.jpg`;
  const wpYesterdayLandscape = `wallpapers/${yesterdayStr}_v2-contain-default.jpg`;
  const wpYesterdayPortrait = `wallpapers/${yesterdayStr}_v2-contain-1290x2796.jpg`;
  writeJpeg(path.join(dir, wpTodayLandscape), WP_LANDSCAPE_JPEG_B64);
  writeJpeg(path.join(dir, wpTodayPortrait), WP_PORTRAIT_JPEG_B64);
  writeJpeg(path.join(dir, wpYesterdayLandscape), WP_LANDSCAPE_JPEG_B64);
  writeJpeg(path.join(dir, wpYesterdayPortrait), WP_PORTRAIT_JPEG_B64);

  // 当日竖版视频（本地可播放；10s 样本规避 s3p3 采样窗口内自然回绕）
  const wallpaperVideoPortrait = `videos/${todayStr}_portrait.mp4`;
  const wallpaperVideoLandscape = `videos/${todayStr}_landscape.mov`;
  fs.mkdirSync(path.join(dir, "videos"), { recursive: true });
  if (withVideo) {
    fs.copyFileSync(VIDEO_SAMPLE, path.join(dir, wallpaperVideoPortrait));
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
    wallpaperLandscape: wpTodayLandscape,
    wallpaperPortrait: wpTodayPortrait,
    photos: [
      mkPhoto(`photo-today-${rank2(1)}`, 1),
      mkPhoto(`photo-today-${rank2(2)}`, 2),
      mkPhoto(`photo-today-${rank2(3)}`, 3),
    ],
  };
  if (withVideo) {
    // §契约规约：条件展开——仅非空时注入字段（fixture 模拟「回执非空」态）
    todayDay.wallpaperVideoLandscape = wallpaperVideoLandscape;
    todayDay.wallpaperVideoPortrait = wallpaperVideoPortrait;
  }

  const yesterdayDay: Record<string, unknown> = {
    pickDate: yesterdayStr,
    title: "昨日精选",
    narrative: "昨日的整体叙事。",
    wallpaperLandscape: wpYesterdayLandscape,
    wallpaperPortrait: wpYesterdayPortrait,
    photos: [mkPhoto("photo-yesterday-01", 1)],
  };

  const manifest = {
    generatedAt: new Date().toISOString(),
    days: [todayDay, yesterdayDay],
    videos: [] as Array<Record<string, unknown>>,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}

function rank2(n: number): string {
  return String(n).padStart(2, "0");
}

// ---- 静态服务（--bind 127.0.0.1，规避 dual-stack/getfqdn 半死态坑）----

const servers: ChildProcess[] = [];
const fixtureRoots: string[] = [];
let videoFixtureDir = "";
let staticFixtureDir = "";

async function startStaticServer(port: number, dir: string): Promise<void> {
  const proc = spawn(
    "python3",
    ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", dir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  servers.push(proc);
  fixtureRoots.push(dir);
  // 轮询就绪（比固定 sleep 更稳）
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
  const fxVideo = buildFixture(PORT_VIDEO, true);
  const fxStatic = buildFixture(PORT_STATIC, false);
  videoFixtureDir = fxVideo.dir;
  staticFixtureDir = fxStatic.dir;
  await startStaticServer(PORT_VIDEO, videoFixtureDir);
  await startStaticServer(PORT_STATIC, staticFixtureDir);
}, 30000);

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
});

async function writeArtifact(id: string, content: string): Promise<void> {
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

const WALLPAPER_UNIT = '[data-stream-unit][data-role="wallpaper-card"]';

/** 滚动首个壁纸卡进入视口（今日卡在 DOM 中最先出现：今日序列在昨日之前） */
async function scrollWallpaperCardIntoView(page: Page): Promise<void> {
  await page.evaluate(() => {
    document
      .querySelector('[data-stream-unit][data-role="wallpaper-card"]')
      ?.scrollIntoView({ behavior: "instant", block: "center" });
  });
}

// ============================================================================
// 场景 3.P1 / 3.P2：壁纸卡视频自动播放（静音循环）+ src == manifest 竖版视频字段
// ============================================================================

describe("[场景3.P1/3.P2] 壁纸卡 <video> 自动播放当日竖版壁纸视频", () => {
  it("进视口后 video 存在且 muted==true ∧ loop==true ∧ readyState>=2 ∧ paused==false", async ({
    page,
  }) => {
    await page.goto(`${BASE_VIDEO}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);

    // bounded 等待进入播放态（readyState>=2 且已起播），不立即 evaluate（事件驱动派生状态竞态）
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
      const unit = document.querySelector('[data-stream-unit][data-role="wallpaper-card"]');
      const v = unit?.querySelector("video") as HTMLVideoElement | null;
      if (!v) return null;
      return {
        exists: true,
        muted: v.muted,
        loop: v.loop,
        playsinline: v.hasAttribute("playsinline"),
        preload: v.preload,
        readyState: v.readyState,
        paused: v.paused,
      };
    });

    await writeArtifact("s3p1", JSON.stringify(state));
    expect(state, "壁纸卡内必须存在 <video> 元素").not.toBeNull();
    expect(state?.muted).toBe(true);
    expect(state?.loop).toBe(true);
    // §契约规约 video 变体 props：playsinline + preload="metadata"
    expect(state?.playsinline).toBe(true);
    expect(state?.preload).toBe("metadata");
    // 谓词字面量：readyState >= 2 AND paused == false
    expect(state?.readyState).toBeGreaterThanOrEqual(2);
    expect(state?.paused).toBe(false);
  });

  it("[场景3.P2] video.src == manifest 当日竖版视频字段值（逐字）", async ({ page }) => {
    await page.goto(`${BASE_VIDEO}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);
    await page.waitForSelector(`${WALLPAPER_UNIT} video`, { timeout: 8000 });

    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(videoFixtureDir, "manifest.json"), "utf8"),
    ) as { days: Array<{ pickDate: string; wallpaperVideoPortrait?: string }> };
    const expectedRelative = manifest.days[0]?.wallpaperVideoPortrait;
    expect(typeof expectedRelative).toBe("string");

    const actualSrc = await page.evaluate(() => {
      const v = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"] video',
      ) as HTMLVideoElement | null;
      return v?.src ?? null;
    });

    await writeArtifact("s3p2", JSON.stringify({ expectedRelative, actualSrc }));
    const expectedAbsolute = new URL(expectedRelative ?? "", `${BASE_VIDEO}/`).href;
    expect(actualSrc).toBe(expectedAbsolute);
    // 契约字面量：源指向当日竖版 mp4
    expect(actualSrc).toContain("_portrait.mp4");
  });
});

// ============================================================================
// 场景 3.P3：播放进度单调前进（跨 loop 回绕除外）
// ============================================================================

describe("[场景3.P3] 视频在视口内播放进度单调前进", () => {
  it("间隔采样两次 currentTime：(t2 > t1) OR (t1 > t2 AND t2 < 1)", async ({ page }) => {
    await page.goto(`${BASE_VIDEO}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);

    // 先等进入播放态，采样才有意义（paused 采样是 No-op kill：暂停时 t2==t1 必红）
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

    const t1 = await page.evaluate(() => {
      const v = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"] video',
      ) as HTMLVideoElement | null;
      return v?.currentTime ?? -1;
    });
    await page.waitForTimeout(700);
    const t2 = await page.evaluate(() => {
      const v = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"] video',
      ) as HTMLVideoElement | null;
      return v?.currentTime ?? -1;
    });

    await writeArtifact("s3p3", JSON.stringify({ t1, t2 }));
    // 谓词字面量（跨 loop 回绕除外）
    const monotonic = t2 > t1 || (t1 > t2 && t2 < 1);
    expect(monotonic, `播放进度未单调前进: t1=${t1}, t2=${t2}`).toBe(true);
  });
});

// ============================================================================
// 场景 7.P1 / 7.P2：视频 404 → 回退静态竖图 + 零 video 相关 JS 错误
// ============================================================================

describe("[场景7.P1/7.P2] 壁纸视频资源 404 → 回退静态竖版 JPEG", () => {
  it("拦截视频 404 → 单元重渲 img.complete==true ∧ naturalWidth>0 ∧ 播放态 video 数==0", async ({
    page,
  }) => {
    const mp4Statuses: number[] = [];
    page.on("response", (r) => {
      if (new URL(r.url()).pathname.endsWith(".mp4")) mp4Statuses.push(r.status());
    });
    await page.route("**/*.mp4", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" }),
    );

    await page.goto(`${BASE_VIDEO}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);

    // 拦截必须真实命中视频请求（No-op kill：拦截失效时后续回退断言全失去意义）
    {
      const deadline = Date.now() + 6000;
      while (!mp4Statuses.includes(404) && Date.now() < deadline) {
        await page.waitForTimeout(200);
      }
    }
    expect(mp4Statuses, "视频请求未被 404 拦截命中").toContain(404);

    // bounded 等待回退终态：壁纸单元内 video 移除、img 加载完成
    await page.waitForFunction(
      () => {
        const unit = document.querySelector(
          '[data-stream-unit][data-role="wallpaper-card"]',
        ) as HTMLElement | null;
        if (!unit) return false;
        const hasVideo = !!unit.querySelector("video");
        const img = unit.querySelector("img") as HTMLImageElement | null;
        return !hasVideo && !!img && img.complete && (img.naturalWidth ?? 0) > 0;
      },
      undefined,
      { timeout: 10000 },
    );

    const result = await page.evaluate(() => {
      const unit = document.querySelector('[data-stream-unit][data-role="wallpaper-card"]');
      const img = unit?.querySelector("img") as HTMLImageElement | null;
      const playingVideos = Array.from(document.querySelectorAll("video")).filter(
        (v) => !v.paused,
      ).length;
      const soundBtnCount = unit ? unit.querySelectorAll('[data-role="video-sound"]').length : -1;
      return {
        unitExists: !!unit,
        imgExists: !!img,
        imgComplete: img?.complete ?? false,
        imgNaturalWidth: img?.naturalWidth ?? 0,
        imgSrc: img?.getAttribute("src") ?? "",
        playingVideos,
        soundBtnCount,
      };
    });

    await writeArtifact("s7p1", JSON.stringify({ mp4Statuses, ...result }));
    // 谓词字面量：fallback img exists AND img.complete == true AND img.naturalWidth > 0
    expect(result.imgExists).toBe(true);
    expect(result.imgComplete).toBe(true);
    expect(result.imgNaturalWidth).toBeGreaterThan(0);
    // 谓词字面量：播放态 video 数量 == 0
    expect(result.playingVideos).toBe(0);
    // 回退不变式（§契约规约）：DOM 结果 <img src=day.wallpaperPortrait>
    expect(result.imgSrc).toContain("_v2-contain-1290x2796.jpg");
    // 【v2】回退语义不破坏（§契约规约 回退不变式：DOM 结果与现状逐字一致——现状无声音按钮，
    // 视频变体特有的点击开声控件不得残留在静态回退 DOM 中）
    expect(result.soundBtnCount).toBe(0);
  });

  it("[场景7.P2] 视频 404 期间零 video 相关 JS console.error 且卡片容器完整渲染", async ({
    page,
  }) => {
    /** app 层 JS 错误（排除 Chromium 网络资源日志「Failed to load resource」——
     *  那是浏览器网络层对 404 的固有输出，非 app console.error；谓词约束的是 JS 错误为零） */
    const jsErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (text.startsWith("Failed to load resource")) return;
      jsErrors.push(text);
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.route("**/*.mp4", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" }),
    );

    await page.goto(`${BASE_VIDEO}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);
    // 等 404 → video error → 整单元重渲完成
    await page.waitForTimeout(2500);

    const containerExists = await page.evaluate(
      () => !!document.querySelector('[data-stream-unit][data-role="wallpaper-card"]'),
    );
    const videoRelated = jsErrors.filter((t) => /video|\.mp4|media/i.test(t));

    await writeArtifact("s7p2", JSON.stringify({ jsErrors, pageErrors, containerExists }));
    // 谓词字面量：video 相关 console.error 数量 == 0 AND 卡片容器 exists
    expect(videoRelated, `video 相关 JS 错误: ${JSON.stringify(videoRelated)}`).toHaveLength(0);
    expect(pageErrors, `未捕获异常: ${JSON.stringify(pageErrors)}`).toHaveLength(0);
    expect(containerExists).toBe(true);
  });
});

// ============================================================================
// 场景 7.P1（分支二）：manifest 无视频字段 → 直接静态竖图（零 video）
// ============================================================================

describe("[场景7.P1 分支] manifest 无视频字段 → 壁纸卡直接静态 img", () => {
  it("无 wallpaperVideo* 字段的 manifest：壁纸单元零 video ∧ img.complete ∧ naturalWidth>0", async ({
    page,
  }) => {
    await page.goto(`${BASE_STATIC}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);
    await page.waitForTimeout(1000);

    const result = await page.evaluate(() => {
      const units = Array.from(
        document.querySelectorAll('[data-stream-unit][data-role="wallpaper-card"]'),
      );
      const first = units[0] as HTMLElement | undefined;
      const img = first?.querySelector("img") as HTMLImageElement | null;
      return {
        unitCount: units.length,
        videoCountInUnits: units.reduce((acc, u) => acc + u.querySelectorAll("video").length, 0),
        imgExists: !!img,
        imgComplete: img?.complete ?? false,
        imgNaturalWidth: img?.naturalWidth ?? 0,
        imgSrc: img?.getAttribute("src") ?? "",
      };
    });

    await writeArtifact("s7p1-static-manifest", JSON.stringify(result));
    expect(result.unitCount).toBeGreaterThan(0);
    // 回退不变式：字段缺省 → 静态 img，无任何 video 变体
    expect(result.videoCountInUnits).toBe(0);
    expect(result.imgExists).toBe(true);
    expect(result.imgComplete).toBe(true);
    expect(result.imgNaturalWidth).toBeGreaterThan(0);
    expect(result.imgSrc).toContain("_v2-contain-1290x2796.jpg");
  });
});

// ============================================================================
// 【v2】点击开声：默认 muted==true 自动播放 → 点击声音按钮 → muted==false → 再击 → muted==true
// （§契约规约 前端 UI【v2】：复用 renderVideoCard 的声音按钮交互——既有约定
//   data-role="video-sound"，见 gallery-video-fullscreen e2e）
// ============================================================================

const WALLPAPER_SOUND_BTN = `${WALLPAPER_UNIT} [data-role="video-sound"]`;

describe("[场景3.P1 v2 增量] 壁纸卡视频点击开声/再击关声", () => {
  it("默认静音自动播放 → 单击开声（muted==false）→ 再击关闭（muted==true）", async ({ page }) => {
    await page.goto(`${BASE_VIDEO}/#/`);
    await page.waitForSelector(WALLPAPER_UNIT, { timeout: 10000 });
    await scrollWallpaperCardIntoView(page);

    // 前置态：默认静音自动播放（§契约规约：默认静音自动播放）
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
    const initial = await page.evaluate(() => {
      const v = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"] video',
      ) as HTMLVideoElement | null;
      return { muted: v?.muted ?? null, paused: v?.paused ?? null };
    });
    expect(initial.muted, "壁纸卡视频默认必须 muted==true").toBe(true);
    expect(initial.paused, "前置态必须已自动播放").toBe(false);

    // 声音按钮存在（复用 renderVideoCard 交互 → 既有 data-role="video-sound" 标记）
    const soundBtn = page.locator(WALLPAPER_SOUND_BTN);
    try {
      await soundBtn.waitFor({ state: "visible", timeout: 5000 });
    } catch {
      throw new Error(
        "壁纸卡内未找到声音按钮 [data-role=video-sound]（§契约规约【v2】点击切静音要求复用 renderVideoCard 声音按钮交互）",
      );
    }

    // 第一次点击 → 开声（muted == false）
    await soundBtn.click();
    await page.waitForFunction(
      () => {
        const v = document.querySelector(
          '[data-stream-unit][data-role="wallpaper-card"] video',
        ) as HTMLVideoElement | null;
        return !!v && v.muted === false;
      },
      undefined,
      { timeout: 5000 },
    );
    const unmuted = await page.evaluate(() => {
      const v = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"] video',
      ) as HTMLVideoElement | null;
      const btn = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"] [data-role="video-sound"]',
      );
      return {
        muted: v?.muted ?? null,
        soundState: btn?.getAttribute("data-sound-state") ?? null,
      };
    });
    expect(unmuted.muted, "单击声音按钮后必须开声（muted==false）").toBe(false);
    // 机读态一致性：若按钮暴露 data-sound-state（renderVideoCard 既有机制），开声态必须为 unmuted
    if (unmuted.soundState != null) {
      expect(unmuted.soundState, "data-sound-state 必须忠实反映开声态").toBe("unmuted");
    }

    // 第二次点击 → 再击关闭（muted == true）
    await soundBtn.click();
    await page.waitForFunction(
      () => {
        const v = document.querySelector(
          '[data-stream-unit][data-role="wallpaper-card"] video',
        ) as HTMLVideoElement | null;
        return !!v && v.muted === true;
      },
      undefined,
      { timeout: 5000 },
    );
    const remuted = await page.evaluate(() => {
      const v = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"] video',
      ) as HTMLVideoElement | null;
      const btn = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"] [data-role="video-sound"]',
      );
      return {
        muted: v?.muted ?? null,
        soundState: btn?.getAttribute("data-sound-state") ?? null,
      };
    });
    expect(remuted.muted, "再击声音按钮后必须回到静音（muted==true）").toBe(true);
    if (remuted.soundState != null) {
      expect(remuted.soundState, "data-sound-state 必须忠实反映静音态").toBe("muted");
    }

    await writeArtifact("s3p1-v2-unmute", JSON.stringify({ initial, unmuted, remuted }));
  });
});

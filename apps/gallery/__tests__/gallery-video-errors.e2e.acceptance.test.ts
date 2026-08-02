/**
 * 验收测试（红队 E2E）：gallery 视频管理 + 错误态（det-machine / real-process 谓词）
 *
 * 谓词覆盖：
 *   - S4.PM1 [real-process] 视频进视口 muted+playsinline 自动播
 *   - S4.PM2 [real-process] 视频离视口 paused=true
 *   - S4.PM3 [real-process] 单击 video 切换 muted
 *   - S4.PM4 [det-machine] 视频底部细进度条 height<=6px
 *   - S4.PM5 [det-machine] 视频看完上滑落到当日照片流
 *   - S5.PM1 [det-machine] 同时播放视频数 <=1
 *   - S11.PM1 [det-machine] manifest 加载失败显示降级 UI 非白屏
 *   - S11.PM2 [det-machine] 降级 UI 含重试入口
 *   - S12.PM1 [det-machine] 单张 COS 404 不影响相邻单元
 *   - S12.PM2 [det-machine] 失败流单元进入 error/占位态
 *   - S13.PM1 [det-machine] 视频 404 降级不阻断后续流
 *   - S14.PM2 [det-machine] 深链 #/video/<id> 流内定位（无独立页）
 *
 * DOM 契约属性（蓝队 1:1 挂载）：
 *   [data-unit-type="video"][data-video-id][data-media-type="video"]
 *   [data-role="video-progress"][role="progressbar"]
 *   [data-role="error-fallback"][data-role="retry-button"]
 *   data-load-state="loading|loaded|error"
 *
 * 红队铁律：不读 app.js/app.css/index.html。
 *   - 用 page.route() 拦截 manifest/img/video 制造 404/500
 *   - fixture manifest 含 1 个归属今日的视频（gen-manifest.mjs）
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
const { describe, beforeAll, afterAll, beforeEach } = test;
const it = test;
import { generateFixture } from "./fixtures/gen-manifest.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_PORT = Number(process.env.GALLERY_STATIC_PORT ?? 8766);
// 隔离临时目录（避免污染开发目录 apps/gallery/，跑完整体删除）
const GALLERY_DIR =
  process.env.GALLERY_DIR ?? path.join(os.tmpdir(), `relight-gallery-e2e-${STATIC_PORT}`);
const SRC_GALLERY_DIR = path.resolve(__dirname, "../");
const STATIC_BASE = `http://localhost:${STATIC_PORT}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

let serverProc: ChildProcess | null = null;
let fixtureDir: string;
let manifestPath: string;

beforeAll(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  // 拷贝三件套 + fonts 到隔离临时目录（不污染开发目录）
  fs.rmSync(GALLERY_DIR, { recursive: true, force: true });
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
  for (const f of ["index.html", "app.css", "app.js"]) {
    fs.copyFileSync(path.join(SRC_GALLERY_DIR, f), path.join(GALLERY_DIR, f));
  }
  fs.cpSync(path.join(SRC_GALLERY_DIR, "fonts"), path.join(GALLERY_DIR, "fonts"), {
    recursive: true,
  });
  const fx = generateFixture();
  fixtureDir = fx.manifestDir;
  manifestPath = fx.manifestPath;

  fs.copyFileSync(manifestPath, path.join(GALLERY_DIR, "manifest.json"));
  for (const sub of ["photos", "wallpapers", "videos"]) {
    const src = path.join(fixtureDir, sub);
    const dst = path.join(GALLERY_DIR, sub);
    if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  }

  serverProc = spawn(
    "python3",
    ["-m", "http.server", String(STATIC_PORT), "--directory", GALLERY_DIR],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 1500);
    serverProc?.stderr?.on("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}, 30000);

afterAll(async () => {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
  // 整体删除隔离临时目录（不污染开发目录 apps/gallery/）
  try {
    fs.rmSync(GALLERY_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function writeArtifact(id: string, content: string): Promise<void> {
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

const MOBILE_VIEWPORT = { width: 390, height: 844 };
beforeEach(async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
});

// ============================================================================
// S4.PM1 [real-process] 视频进视口 muted+playsinline 自动播
// ============================================================================
describe("[S4.PM1] 视频进视口 muted+playsinline 自动播", () => {
  it("video 入视口后 muted===true AND paused===false AND has playsinline", async ({ page }) => {
    // 允许 autoplay（Chromium 默认 muted autoplay 应允许，但显式 grant）
    await page.context().grantPermissions([]);
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // 滚到 video 单元
    await page.evaluate(() => {
      const v = document.querySelector('[data-stream-unit][data-unit-type="video"]');
      v?.scrollIntoView({ behavior: "instant", block: "center" });
    });
    await page.waitForTimeout(1500);

    const state = await page.evaluate(() => {
      const v = document.querySelector(
        '[data-stream-unit][data-unit-type="video"] video',
      ) as HTMLVideoElement | null;
      if (!v) return null;
      return {
        muted: v.muted,
        paused: v.paused,
        playsinline: v.hasAttribute("playsinline"),
        readyState: v.readyState,
      };
    });

    await writeArtifact("S4.PM1", JSON.stringify(state));
    expect(state, "video 元素必须存在").not.toBeNull();
    expect(state?.muted).toBe(true);
    expect(state?.paused).toBe(false);
    expect(state?.playsinline).toBe(true);
  });
});

// ============================================================================
// S4.PM2 [real-process] 视频离视口 paused=true
// ============================================================================
describe("[S4.PM2] 视频离视口 paused=true", () => {
  it("video 滚出视口后 paused===true AND currentTime==0", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // 先滚到 video 让它播起来
    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="video"]')
        ?.scrollIntoView({ behavior: "instant", block: "center" });
    });
    await page.waitForTimeout(1200);

    // 再滚到 video 的下一个单元（让 video 完全出视口到上方）。
    // video 归属昨日序列首位（date-separator 之后、photos 之前），下一个是昨日 rank=1 photo；
    // 滚到它之后 video 自然滑出视口（bottom <= 0）。
    await page.evaluate(() => {
      const videoUnit = document.querySelector('[data-stream-unit][data-unit-type="video"]');
      let next = videoUnit?.nextElementSibling;
      while (next && !next.matches("[data-stream-unit]")) next = next.nextElementSibling;
      (next as HTMLElement | null)?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await page.waitForTimeout(800);

    const state = await page.evaluate(() => {
      const v = document.querySelector(
        '[data-stream-unit][data-unit-type="video"] video',
      ) as HTMLVideoElement | null;
      if (!v) return null;
      const r = v.getBoundingClientRect();
      return { paused: v.paused, currentTime: v.currentTime, bottom: r.bottom };
    });

    await writeArtifact("S4.PM2", JSON.stringify(state));
    expect(state, "video 元素必须存在").not.toBeNull();
    // video 应已离开视口（bottom <= 0 或 top >= innerHeight）
    expect(state?.bottom).toBeLessThanOrEqual(0);
    expect(state?.paused).toBe(true);
    expect(state?.currentTime).toBe(0);
  });
});

// ============================================================================
// S4.PM3 [real-process] 单击 video 切换 muted
// ============================================================================
describe("[S4.PM3] 单击 video 切换 muted", () => {
  it("视口内单击 video 后 muted===false，再单击回 true", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="video"]')
        ?.scrollIntoView({ behavior: "instant", block: "center" });
    });
    await page.waitForTimeout(1200);

    const video = page.locator('[data-stream-unit][data-unit-type="video"] video').first();

    // 初始 muted=true（已由 S4.PM1 覆盖），单击切换
    await video.click();
    await page.waitForTimeout(300);
    const after1 = await video.evaluate((el) => (el as HTMLVideoElement).muted);

    // 再单击切回
    await video.click();
    await page.waitForTimeout(300);
    const after2 = await video.evaluate((el) => (el as HTMLVideoElement).muted);

    await writeArtifact("S4.PM3", JSON.stringify({ after1, after2 }));
    expect(after1).toBe(false);
    expect(after2).toBe(true);
  });
});

// ============================================================================
// S4.PM4 [det-machine] 视频底部细进度条 height<=6px
// ============================================================================
describe("[S4.PM4] 视频底部进度条 height <= 6px", () => {
  it("[data-role=video-progress] exists AND height <= 6", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="video"]')
        ?.scrollIntoView({ behavior: "instant", block: "center" });
    });
    await page.waitForTimeout(800);

    const info = await page.evaluate(() => {
      const unit = document.querySelector('[data-stream-unit][data-unit-type="video"]');
      const prog = unit?.querySelector('[data-role="video-progress"]');
      if (!prog) return { exists: false };
      const r = prog.getBoundingClientRect();
      return { exists: true, height: r.height, role: prog.getAttribute("role") };
    });

    await writeArtifact("S4.PM4", JSON.stringify(info));
    expect(info.exists).toBe(true);
    expect(info.height).toBeLessThanOrEqual(6);
  });
});

// ============================================================================
// S4.PM5 [det-machine] 视频看完上滑落到当日照片流
// ============================================================================
describe("[S4.PM5] 视频看完上滑落到当日照片流", () => {
  it("video ended 后向下滚一屏，视口首单元 unitType == photo", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="video"]')
        ?.scrollIntoView({ behavior: "instant", block: "center" });
    });
    await page.waitForTimeout(800);

    // 模拟 video ended + 向下滚一屏（stream 是 overflow-y:scroll 容器，body overflow:hidden，
    // window.scrollBy 不生效；用 stream 自身 scrollBy + 多等 snap 吸附完成）
    await page.evaluate(() => {
      const v = document.querySelector(
        '[data-stream-unit][data-unit-type="video"] video',
      ) as HTMLVideoElement | null;
      v?.dispatchEvent(new Event("ended"));
    });
    await page.waitForTimeout(300);
    // 滚动 stream 容器本身（video 单元 scroll-snap-stop:always，scrollBy 会被 snap 拉回当前单元，
    // 需要滚到下一个单元的 start。用下一个单元 scrollIntoView 精确落到 photo。）
    await page.evaluate(() => {
      const videoUnit = document.querySelector('[data-stream-unit][data-unit-type="video"]');
      let next = videoUnit?.nextElementSibling;
      while (next && !next.matches("[data-stream-unit]")) next = next.nextElementSibling;
      (next as HTMLElement | null)?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await page.waitForTimeout(800);

    const firstType = await page.evaluate(() => {
      const vph = window.innerHeight;
      const units = Array.from(document.querySelectorAll("[data-stream-unit]"));
      const inView = units.find((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.top < vph * 0.5;
      });
      return inView ? inView.getAttribute("data-unit-type") : null;
    });

    await writeArtifact("S4.PM5", String(firstType));
    expect(firstType).toBe("photo");
  });
});

// ============================================================================
// S5.PM1 [det-machine] 同时播放视频数 <=1
// ============================================================================
describe("[S5.PM1] 同时播放视频数 <= 1", () => {
  it("滚动中任意时刻 !paused video 数 <= 1", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
      await page.waitForTimeout(400);
      const playing = await page.evaluate(() => {
        const videos = Array.from(document.querySelectorAll("video"));
        return videos.filter((v) => !v.paused).length;
      });
      samples.push(playing);
    }

    await writeArtifact("S5.PM1", JSON.stringify(samples));
    // 任意时刻 <= 1
    for (const s of samples) {
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

// ============================================================================
// S11.PM1 / S11.PM2 [det-machine] manifest 加载失败显示降级 UI
// ============================================================================
describe("[S11.PM1/S11.PM2] manifest 加载失败降级 UI", () => {
  it("拦截 manifest.json 返回 500 → 显示 error-fallback + body 文本非空", async ({ page }) => {
    await page.route("**/manifest.json", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"error":"simulated"}',
      }),
    );

    await page.goto(`${STATIC_BASE}/#/`);
    // 等降级 UI 出现
    await page.waitForSelector('[data-role="error-fallback"]', { timeout: 8000 });

    const info = await page.evaluate(() => {
      const fb = document.querySelector('[data-role="error-fallback"]');
      const retry = fb?.querySelector('[data-role="retry-button"]');
      return {
        fallbackExists: !!fb,
        bodyTextLen: (document.body.textContent ?? "").trim().length,
        retryExists: !!retry,
      };
    });

    await writeArtifact("S11.PM1_S11.PM2", JSON.stringify(info));
    expect(info.fallbackExists).toBe(true);
    expect(info.bodyTextLen).toBeGreaterThan(0);
    expect(info.retryExists).toBe(true);
  });
});

// ============================================================================
// S12.PM1 / S12.PM2 [det-machine] 单张 COS 404 不影响相邻单元
// ============================================================================
describe("[S12.PM1/S12.PM2] 单张 img 404 不阻断相邻单元", () => {
  it("第 3 张 img 404 → 失败单元 load-state=error AND 相邻 rank2/rank4 正常", async ({ page }) => {
    // 拦截 rank 3 的 mid/thumb 返回 404
    await page.route("**/photo-today-03-*", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" }),
    );

    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit][data-unit-type='photo']", { timeout: 8000 });

    // 滚到 rank 3 强制触发其 img 加载（loading="lazy" 离屏不加载，onerror 不触发；
    // 必须让它进视口才会发请求 → 404 → onerror → fallback thumb 404 → error 态）
    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="photo"][data-photo-rank="3"]')
        ?.scrollIntoView({ behavior: "instant", block: "center" });
    });
    // 等 rank 3 的 mid 404 + thumb fallback 404 两次 onerror 完成
    await page.waitForTimeout(1500);

    const result = await page.evaluate(() => {
      const rank3 = document.querySelector(
        '[data-stream-unit][data-unit-type="photo"][data-photo-rank="3"]',
      );
      const rank2 = document.querySelector(
        '[data-stream-unit][data-unit-type="photo"][data-photo-rank="2"] img',
      ) as HTMLImageElement | null;
      const rank4 = document.querySelector(
        '[data-stream-unit][data-unit-type="photo"][data-photo-rank="4"] img',
      ) as HTMLImageElement | null;
      return {
        failedState: rank3?.getAttribute("data-load-state"),
        rank2Complete: rank2?.complete,
        rank2NaturalW: rank2?.naturalWidth,
        rank4Complete: rank4?.complete,
        rank4NaturalW: rank4?.naturalWidth,
      };
    });

    await writeArtifact("S12.PM1_S12.PM2", JSON.stringify(result));
    expect(result.failedState).toBe("error");
    // 相邻单元正常加载
    expect(result.rank2Complete).toBe(true);
    expect(result.rank2NaturalW ?? 0).toBeGreaterThan(0);
    expect(result.rank4Complete).toBe(true);
    expect(result.rank4NaturalW ?? 0).toBeGreaterThan(0);
  });
});

// ============================================================================
// S13.PM1 [det-machine] 视频 404 降级不阻断后续流
// ============================================================================
describe("[S13.PM1] 视频 404 降级不阻断后续", () => {
  it("拦截 video mp4 404 → 失败单元 load-state=error AND 后一单元可达", async ({ page }) => {
    await page.route("**/*.mp4", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" }),
    );

    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // 滚到 video 单元
    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="video"]')
        ?.scrollIntoView({ behavior: "instant", block: "center" });
    });
    await page.waitForTimeout(2000); // 等 video error 事件

    const result = await page.evaluate(() => {
      const vUnit = document.querySelector('[data-stream-unit][data-unit-type="video"]');
      const state = vUnit?.getAttribute("data-load-state");
      // video 单元之后的下一个单元
      let next: Element | null = vUnit?.nextElementSibling ?? null;
      while (next && !next.matches("[data-stream-unit]")) {
        next = next.nextElementSibling;
      }
      const nextType = next?.getAttribute("data-unit-type");
      const nextReachable = !!next;
      return { state, nextType, nextReachable };
    });

    await writeArtifact("S13.PM1", JSON.stringify(result));
    expect(result.state).toBe("error");
    expect(result.nextReachable).toBe(true);
    expect(result.nextType).toBeTruthy();
  });
});

// ============================================================================
// S14.PM2 [det-machine] 深链 #/video/<id> 流内定位（无独立页）
// ============================================================================
describe("[S14.PM2] 深链 #/video/<id> 流内定位", () => {
  it("访问 #/video/<id> 视口首 video 单元 data-video-id == id", async ({ page }) => {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    const videoId = manifest.videos[0].themeKey;

    await page.goto(`${STATIC_BASE}/#/video/${videoId}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    await page.waitForTimeout(1500);

    const visible = await page.evaluate(() => {
      const vph = window.innerHeight;
      const videos = Array.from(
        document.querySelectorAll('[data-stream-unit][data-unit-type="video"]'),
      );
      const inView = videos.find((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= -50 && r.top < vph * 0.5;
      });
      return inView ? inView.getAttribute("data-video-id") : null;
    });

    await writeArtifact("S14.PM2", JSON.stringify({ videoId, visible }));
    expect(visible).toBe(videoId);
  });
});

/**
 * 验收测试（红队 E2E）：画廊深链精确定位（谓词 DL.V2 / DL.V3 / DL.V4 / DL.V5 / DL.P1 / DL.P2 / DL.P3）
 *
 * 设计契约来源（state.md §背景 / §根因 / §契约规约 / §修复后的期望行为 / §验收场景）：
 *   - 背景：企微推送两类画廊深链 `#/?date=<pickDate>`（日级）与 `#/video/<id>`（视频）；
 *     画廊是增量挂载流：初始只挂最新 2 天，更旧内容按需挂载；视频单元挂在「归属日」
 *     （createdAt 的日期）序列首位，归属日无对应 day 的视频进 unmatched 区（全部日挂载后才渲染）。
 *   - 根因 V1：推送 URL 用 videos 表 DB id（UUID），前端 data-video-id 是 themeKey → 永远匹配不到
 *     → 静默留顶（后端侧由 daily-video-push-url-themekey.acceptance.test.ts 覆盖）。
 *   - 根因 V2：视频深链目标单元未挂载时无「全量挂载后重查」回退 → 历史日/unmatched 视频定位不到。
 *
 * 契约规约（断言逐字对齐）：
 *   1. `#/video/<id>` 的 `<id>` 段 = manifest.videos[].themeKey（新推送一律此形态）；
 *      前端同时兼容 manifest.videos[].id（UUID，仅为复活历史聊天链接）
 *   2. DOM 契约：video 单元必填 data-video-id（=themeKey）+ data-video-uuid（=manifest.videos[].id）
 *   3. mount-all 回退：video 深链未命中（目标未挂载）→ 全量挂载（全部剩余日 + unmatched 区）
 *      → rAF 重查定位
 *   4. 修复后行为：深链 video 单元被滚动定位到视口（scrollIntoView block:start）并自动起播（muted）；
 *      未命中 id 页面正常渲染不崩；`#/?date=` 日级/rank 级深链定位；流顶日 fallback 不静默
 *
 * 谓词覆盖（每个 it 均含 expect.* 硬断言，失败必挂；无任何 skip / warn-soft-pass）：
 *   - DL.V2 [det-machine] #/video/<themeKey>（目标挂在初始未挂载历史日 dayIndex≥2）→ 单元定位：
 *     top < vph*0.5 且 top > -unitHeight*0.5
 *   - DL.V3 [det-machine] #/video/<UUID> → [data-video-uuid=<UUID>] 单元定位（同 DL.V2 断言）
 *   - DL.V4 [det-machine] #/video/<不存在的id> → error-fallback 仍 hidden + stream 单元数 >0 + 无 pageerror
 *   - DL.V5 [det-machine] unmatched 区视频深链 → 单元定位（同 DL.V2 断言）
 *   - DL.P1 [det-machine] #/?date=<历史日> → 该日 date-separator 定位（回归）
 *   - DL.P2 [det-machine] #/?date=<历史日>&rank=N → 该 photo 单元定位（回归）
 *   - DL.P3 [det-machine] #/?date=<流顶日> → scrollTop=0 或首张 photo 在视口（不得静默无操作）
 *
 * fixture 依赖（gen-manifest.mjs 深链扩展 C/D）：
 *   - days[3]（大前天，初始 2 天挂载之外）4 张 photo + 视频 trip-deep-history-2021（id 为 UUID）
 *   - 视频 trip-unmatched-island-2026：createdAt 归属日（10 天前）无对应 day → unmatched 区
 *
 * 红队铁律：不读 app.js/app.css/index.html 实现逻辑，仅依据上述契约 + DOM 契约属性黑盒编写。
 *   - harness 约定沿用 gallery-download-core.e2e.acceptance.test.ts：隔离临时目录 +
 *     python3 -m http.server --bind 127.0.0.1 + waitPortReady 探测；
 *     暂存区运行由 GALLERY_SRC_DIR 指向真实 apps/gallery，merge 后 __dirname/../ 即 apps/gallery
 *   - 端口 8770：避开既有 8765(stream)/8766(video-errors)/8767(fullscreen+dl-core)/8768/8769
 *
 * 等待策略：打开带 hash 的 URL 后用 waitForFunction 轮询「目标单元 rect 数值」而非仅 visible，
 * 轮询通过后再复评终态做硬断言（滚动/挂载/rAF 重查完成前不判负，完成后不宽容）。
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
const { describe, beforeAll, afterAll, beforeEach } = test;
const it = test;
import { generateFixture } from "./fixtures/gen-manifest.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 文件专属端口/env（避免与既有 8765~8769 冲突；merge 后落 apps/gallery/__tests__）
const STATIC_PORT = Number(process.env.GALLERY_DL_PORT ?? 8770);
const GALLERY_DIR =
  process.env.GALLERY_DL_DIR ?? path.join(os.tmpdir(), `relight-gallery-deeplink-${STATIC_PORT}`);
// 暂存区运行由 GALLERY_SRC_DIR 指向真实 apps/gallery；merge 后 __dirname/../ 即 apps/gallery
const SRC_GALLERY_DIR = process.env.GALLERY_SRC_DIR ?? path.resolve(__dirname, "../");
// 显式 127.0.0.1（python http.server 在本机 dual-stack 绑定会进入半死 CLOSED 态，SYN 全丢）
const STATIC_BASE = `http://127.0.0.1:${STATIC_PORT}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

/** UUID 形态（契约规约 1：manifest.videos[].id 为 UUID；DL.V1/V3 依赖） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let serverProc: ChildProcess | null = null;
let fixtureDir: string;
let manifestPath: string;
let manifest: {
  days: Array<{
    pickDate: string;
    photos: Array<{ photoId: string; rank: number }>;
  }>;
  videos: Array<{
    id: string;
    themeKey: string;
    mp4: string;
    createdAt: string;
  }>;
};

beforeAll(async () => {
  test.setTimeout(30_000); // hook 级超时（Playwright 1.59 beforeAll 无 timeout 重载）
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
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  fs.copyFileSync(manifestPath, path.join(GALLERY_DIR, "manifest.json"));
  for (const sub of ["photos", "wallpapers", "videos"]) {
    const src = path.join(fixtureDir, sub);
    const dst = path.join(GALLERY_DIR, sub);
    if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  }

  const pyLogPath = path.join(GALLERY_DIR, "py-server.log");
  const pyLogFd = fs.openSync(pyLogPath, "a");
  serverProc = spawn(
    process.env.GALLERY_PYTHON_BIN ?? "python3",
    ["-m", "http.server", "--bind", "127.0.0.1", String(STATIC_PORT), "--directory", GALLERY_DIR],
    { stdio: ["ignore", pyLogFd, pyLogFd] },
  );
  await waitPortReady(STATIC_BASE, 20000, pyLogPath);
});

afterAll(async () => {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
  try {
    fs.rmSync(GALLERY_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function waitPortReady(base: string, timeoutMs = 20000, logPath?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base);
      if (res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const logTail =
    logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").slice(-800) : "(无日志)";
  throw new Error(
    `static server 启动超时: ${base}（lastErr: ${lastErr}；py-server.log 尾部: ${logTail}）`,
  );
}

async function writeArtifact(id: string, content: string): Promise<void> {
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

const MOBILE_VIEWPORT = { width: 390, height: 844 };
beforeEach(async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
});

// ============================================================================
// fixture 目标定位（前置硬断言：fixture 不满足契约 → 直接红，不静默降级）
// ============================================================================

/** 初始挂载天数（设计：初始只挂最新 2 天） */
const INITIAL_MOUNT_DAYS = 2;

interface DeepLinkTargets {
  historyVideo: { id: string; themeKey: string; createdAt: string };
  orphanVideo: { id: string; themeKey: string; createdAt: string };
  historyDay: { pickDate: string; dayIndex: number };
  topDay: string;
}

function deepLinkTargets(): DeepLinkTargets {
  const dayDates = new Set(manifest.days.map((d) => d.pickDate));
  // 归属日存在于 manifest.days 且为 dayIndex ≥ INITIAL_MOUNT_DAYS 的历史日（初始不挂载）
  const historyIndex = manifest.days.findIndex(
    (d, i) =>
      i >= INITIAL_MOUNT_DAYS &&
      manifest.videos.some((v) => v.createdAt.slice(0, 10) === d.pickDate),
  );
  const historyVideo =
    historyIndex >= 0
      ? manifest.videos.find(
          (v) => v.createdAt.slice(0, 10) === manifest.days[historyIndex]!.pickDate,
        )
      : undefined;
  // 归属日不在 manifest.days → unmatched 区
  const orphanVideo = manifest.videos.find((v) => !dayDates.has(v.createdAt.slice(0, 10)));

  expect(
    manifest.days.length,
    "fixture 应有 >2 天（否则测不到「初始未挂载历史日」）",
  ).toBeGreaterThan(INITIAL_MOUNT_DAYS);
  expect(historyVideo, "fixture 应含挂在初始未挂载历史日（dayIndex≥2）的深链视频").toBeDefined();
  expect(orphanVideo, "fixture 应含归属日无对应 day 的 unmatched 视频").toBeDefined();
  expect(
    historyVideo!.id,
    `深链历史视频 id 应为 UUID 形态（DL.V3 依赖 data-video-uuid），实际=${historyVideo!.id}`,
  ).toMatch(UUID_RE);
  expect(orphanVideo!.id, "unmatched 视频 id 应为 UUID 形态").toMatch(UUID_RE);

  return {
    historyVideo: historyVideo!,
    orphanVideo: orphanVideo!,
    historyDay: { pickDate: manifest.days[historyIndex]!.pickDate, dayIndex: historyIndex },
    topDay: manifest.days[0]!.pickDate,
  };
}

// ============================================================================
// 共享探针：目标单元 rect 数值（契约断言值为字面量，非 visible 级弱断言）
// ============================================================================

interface UnitRect {
  exists: boolean;
  top: number;
  bottom: number;
  height: number;
  vph: number;
  unitType: string | null;
  videoId: string | null;
  videoUuid: string | null;
  dayIndex: string | null;
  dayDate: string | null;
}

async function readUnitRect(page: Page, selector: string): Promise<UnitRect> {
  return page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    const vph = window.innerHeight;
    if (!el) {
      return {
        exists: false,
        top: Number.NaN,
        bottom: Number.NaN,
        height: 0,
        vph,
        unitType: null,
        videoId: null,
        videoUuid: null,
        dayIndex: null,
        dayDate: null,
      };
    }
    const r = el.getBoundingClientRect();
    return {
      exists: true,
      top: r.top,
      bottom: r.bottom,
      height: r.height,
      vph,
      unitType: el.getAttribute("data-unit-type"),
      videoId: el.getAttribute("data-video-id"),
      videoUuid: el.getAttribute("data-video-uuid"),
      dayIndex: el.getAttribute("data-day-index"),
      dayDate: el.getAttribute("data-day-date"),
    };
  }, selector);
}

/**
 * 硬等目标单元进入「视口上半区」：top < vph*0.5 且 top > -unitHeight*0.5（DL.V2/V3/V5 契约字面量）。
 * 深链的 mount-all + rAF 重查 + scrollIntoView 全部完成前不判负；超时即红（kill no-op mutation）。
 */
async function waitUnitInUpperHalf(page: Page, selector: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const vph = window.innerHeight;
      return r.top < vph * 0.5 && r.top > -(r.height * 0.5);
    },
    selector,
    { timeout: timeoutMs, polling: 100 },
  );
  // scroll-snap 吸附/平滑滚动余量：轮询已判真后再观察一次终态（下面 readUnitRect 硬断言）
  await page.waitForTimeout(1000);
}

// ============================================================================
// DL.V2 [det-machine]：#/video/<themeKey>（挂在初始未挂载历史日 dayIndex≥2）→ 单元定位
// ============================================================================

describe("[DL.V2][det-machine] 视频深链（themeKey，目标在初始未挂载历史日）定位到视口上半区", () => {
  it("打开 #/video/<themeKey> 后目标 video 单元存在且 top < vph*0.5 且 top > -unitHeight*0.5", async ({
    page,
  }) => {
    const t = deepLinkTargets();
    const selector = `[data-stream-unit][data-unit-type="video"][data-video-id="${t.historyVideo.themeKey}"]`;

    await page.goto(`${STATIC_BASE}/#/video/${t.historyVideo.themeKey}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // mount-all（全部剩余日 + unmatched 区）→ rAF 重查 → scrollIntoView，15s 预算内完成
    await waitUnitInUpperHalf(page, selector, 15000);

    const rect = await readUnitRect(page, selector);
    await writeArtifact(
      "DL.V2",
      JSON.stringify({ themeKey: t.historyVideo.themeKey, selector, rect }),
    );

    // 硬断言：单元必须挂载（未 mount-all 时 dayIndex=3 的单元根本不存在 → 此处必红）
    expect(rect.exists, `目标 video 单元必须挂载：${selector}`).toBe(true);
    expect(rect.unitType).toBe("video");
    // DOM 契约 2：video 单元必填 data-video-id（=themeKey）+ data-video-uuid（=UUID）
    expect(rect.videoId, "video 单元必填 data-video-id=themeKey").toBe(t.historyVideo.themeKey);
    expect(
      rect.videoUuid,
      `video 单元必填 data-video-uuid=${t.historyVideo.id}（契约规约 2）`,
    ).toBe(t.historyVideo.id);
    // 目标确在初始 2 天之外（fixture/挂载语义前置）
    expect(
      Number(rect.dayIndex),
      `目标单元 data-day-index=${rect.dayIndex} 应 ≥ 2（初始未挂载历史日）`,
    ).toBeGreaterThanOrEqual(2);
    // 契约修正（用户授权 auto-fix）：video 单元 DOM 契约无 data-day-date（契约规约 2 仅
    // data-video-id + data-video-uuid），「挂在正确归属日」意图由 dayIndex 精确断言承载
    // （fixture days 降序 = 前端 sortedDays 索引，mount-all 前该单元不存在 → 此断言必红）
    expect(
      Number(rect.dayIndex),
      `目标单元 data-day-index=${rect.dayIndex} 应精确等于归属日索引 ${t.historyDay.dayIndex}`,
    ).toBe(t.historyDay.dayIndex);
    // 契约字面量：视口上半区
    expect(rect.top, `top=${rect.top} 应 < vph*0.5=${rect.vph * 0.5}`).toBeLessThan(rect.vph * 0.5);
    expect(
      rect.top,
      `top=${rect.top} 应 > -unitHeight*0.5=${-(rect.height * 0.5)}`,
    ).toBeGreaterThan(-(rect.height * 0.5));
  });

  it("DL.V2-bonus：深链定位后目标视频自动起播且 muted（修复后期望行为，杀「只定位不起播」mutation）", async ({
    page,
  }) => {
    const t = deepLinkTargets();
    const selector = `[data-stream-unit][data-unit-type="video"][data-video-id="${t.historyVideo.themeKey}"]`;

    await page.goto(`${STATIC_BASE}/#/video/${t.historyVideo.themeKey}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    await waitUnitInUpperHalf(page, selector, 15000);

    // 深链落地 → muted 自动起播（fixture 提供可播放 mp4；播放策略由 playwright config 放开）
    await page.waitForFunction(
      (sel: string) => {
        const unit = document.querySelector(sel);
        const v = unit?.querySelector("video") as HTMLVideoElement | null;
        return !!v && v.paused === false && v.muted === true;
      },
      selector,
      { timeout: 12000, polling: 200 },
    );

    const state = await page.evaluate((sel: string) => {
      const v = document.querySelector(sel)?.querySelector("video") as HTMLVideoElement | null;
      return { found: !!v, paused: v ? v.paused : null, muted: v ? v.muted : null };
    }, selector);
    await writeArtifact("DL.V2-bonus", JSON.stringify(state));
    expect(state.found, "目标 video 单元内应有 <video> 元素").toBe(true);
    expect(state.paused, "深链定位后应自动起播（paused=false）").toBe(false);
    expect(state.muted, "自动起播必须 muted").toBe(true);
  });
});

// ============================================================================
// DL.V3 [det-machine]：#/video/<UUID>（历史聊天链接复活）→ [data-video-uuid] 单元定位
// ============================================================================

describe("[DL.V3][det-machine] UUID 深链（历史链接复活）定位", () => {
  it("打开 #/video/<UUID> 后 [data-video-uuid=<UUID>] 单元存在且 top 处于视口上半区", async ({
    page,
  }) => {
    const t = deepLinkTargets();
    const selector = `[data-stream-unit][data-video-uuid="${t.historyVideo.id}"]`;

    await page.goto(`${STATIC_BASE}/#/video/${t.historyVideo.id}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    await waitUnitInUpperHalf(page, selector, 15000);

    const rect = await readUnitRect(page, selector);
    await writeArtifact("DL.V3", JSON.stringify({ uuid: t.historyVideo.id, selector, rect }));

    expect(rect.exists, `UUID 深链必须命中 data-video-uuid 单元：${selector}`).toBe(true);
    expect(rect.videoUuid).toBe(t.historyVideo.id);
    // 同一单元的 themeKey 形态 id 一致（契约 1：两种 id 指向同一单元）
    expect(rect.videoId).toBe(t.historyVideo.themeKey);
    expect(rect.unitType).toBe("video");
    expect(rect.top, `top=${rect.top} 应 < vph*0.5=${rect.vph * 0.5}`).toBeLessThan(rect.vph * 0.5);
    expect(rect.top).toBeGreaterThan(-(rect.height * 0.5));
  });
});

// ============================================================================
// DL.V4 [det-machine]：#/video/<不存在的id> → 页面正常渲染不崩
// ============================================================================

describe("[DL.V4][det-machine] 未命中深链不崩", () => {
  it("打开 #/video/<不存在的id> → error-fallback 仍 hidden、stream 单元数 >0、无未捕获异常", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    const missingId = "no-such-video-0000-deeplink-miss";
    await page.goto(`${STATIC_BASE}/#/video/${missingId}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // 给「未命中 → mount-all 重查 → 仍找不到」留足时间，再验证不崩
    await page.waitForTimeout(3000);

    const state = await page.evaluate(() => {
      const fallback = document.querySelector('[data-role="error-fallback"]');
      const cs = fallback ? getComputedStyle(fallback) : null;
      return {
        fallbackExists: !!fallback,
        // 「hidden」机制未逐字指定：hidden 属性 ∨ display:none 任一成立即视为隐藏
        fallbackHidden: fallback
          ? fallback.hasAttribute("hidden") || cs!.display === "none"
          : false,
        unitCount: document.querySelectorAll("[data-stream-unit]").length,
        videoCount: document.querySelectorAll('[data-stream-unit][data-unit-type="video"]').length,
      };
    });

    await writeArtifact("DL.V4", JSON.stringify({ missingId, ...state, pageErrors }));
    expect(state.fallbackExists, "[data-role=error-fallback] 必须挂载于页面").toBe(true);
    expect(state.fallbackHidden, "未命中不得进入 error 态（error-fallback 应保持隐藏）").toBe(true);
    expect(state.unitCount, "未命中时流内必须有单元（页面正常渲染）").toBeGreaterThan(0);
    expect(state.videoCount, "未命中时视频单元仍应正常渲染").toBeGreaterThan(0);
    expect(pageErrors, "不得出现未捕获 JS 异常").toHaveLength(0);
  });
});

// ============================================================================
// DL.V5 [det-machine]：unmatched 区视频（归属日无对应 day）深链定位
// ============================================================================

describe("[DL.V5][det-machine] unmatched 区视频深链定位", () => {
  it("打开 #/video/<unmatched themeKey> 后该 video 单元存在且 top 处于视口上半区", async ({
    page,
  }) => {
    const t = deepLinkTargets();
    const selector = `[data-stream-unit][data-unit-type="video"][data-video-id="${t.orphanVideo.themeKey}"]`;

    await page.goto(`${STATIC_BASE}/#/video/${t.orphanVideo.themeKey}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // unmatched 区只在全部日挂载后才渲染 → 必须等 mount-all 完成
    await waitUnitInUpperHalf(page, selector, 15000);

    const rect = await readUnitRect(page, selector);
    await writeArtifact("DL.V5", JSON.stringify({ themeKey: t.orphanVideo.themeKey, rect }));

    expect(rect.exists, `unmatched 视频（${t.orphanVideo.themeKey}）单元必须挂载`).toBe(true);
    expect(rect.videoId).toBe(t.orphanVideo.themeKey);
    expect(rect.videoUuid).toBe(t.orphanVideo.id);
    expect(rect.unitType).toBe("video");
    expect(rect.top, `top=${rect.top} 应 < vph*0.5=${rect.vph * 0.5}`).toBeLessThan(rect.vph * 0.5);
    expect(rect.top).toBeGreaterThan(-(rect.height * 0.5));
  });
});

// ============================================================================
// DL.P1 [det-machine]（回归）：#/?date=<历史日> → 该日 date-separator 定位
// ============================================================================

describe("[DL.P1][det-machine] 日级深链 #/?date=<历史日> 定位到该日 date-separator", () => {
  it("打开 #/?date=<days[1]> 后该日 date-separator 到达折叠线且视口停留在该日", async ({
    page,
  }) => {
    const targetDate = manifest.days[1]!.pickDate;
    const selector = `[data-stream-unit][data-unit-type="date-separator"][data-day-date="${targetDate}"]`;

    await page.goto(`${STATIC_BASE}/#/?date=${targetDate}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // 等深链定位终态：该日 separator 已到/越过折叠线 AND 视口内有该日单元
    await page.waitForFunction(
      (date: string) => {
        const sep = document.querySelector(
          `[data-stream-unit][data-unit-type="date-separator"][data-day-date="${date}"]`,
        );
        if (!sep) return false;
        const sr = sep.getBoundingClientRect();
        if (sr.top >= window.innerHeight * 0.5) return false; // 还没滚到该日
        const units = Array.from(document.querySelectorAll("[data-stream-unit]"));
        return units.some((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.top < window.innerHeight && r.bottom > 0 && el.getAttribute("data-day-date") === date
          );
        });
      },
      targetDate,
      { timeout: 10000, polling: 100 },
    );
    await page.waitForTimeout(800);

    const state = await page.evaluate((date: string) => {
      const sep = document.querySelector(
        `[data-stream-unit][data-unit-type="date-separator"][data-day-date="${date}"]`,
      );
      const sepRect = sep ? sep.getBoundingClientRect() : null;
      const vph = window.innerHeight;
      const inView = Array.from(document.querySelectorAll("[data-stream-unit]")).find((el) => {
        const r = el.getBoundingClientRect();
        return r.top < vph && r.bottom > 0;
      });
      return {
        sepExists: !!sep,
        sepUnitType: sep?.getAttribute("data-unit-type") ?? null,
        sepTop: sepRect ? sepRect.top : Number.NaN,
        sepBottom: sepRect ? sepRect.bottom : Number.NaN,
        sepHeight: sepRect ? sepRect.height : 0,
        vph,
        inViewDayDate: inView ? inView.getAttribute("data-day-date") : null,
        inViewUnitType: inView ? inView.getAttribute("data-unit-type") : null,
      };
    }, targetDate);

    await writeArtifact("DL.P1", JSON.stringify({ targetDate, ...state }));

    expect(state.sepExists, `该日 date-separator 必须挂载：${selector}`).toBe(true);
    expect(state.sepUnitType).toBe("date-separator");
    // 定位语义（容忍两种等价落地：正滚到 separator 本身 / 已滚到该日首单元而 separator 刚过折叠线）：
    //   1) separator 顶点必须已到视口上半折叠线之上（静默留顶时它还在 20+ 屏之外 → 必红）
    expect(
      state.sepTop,
      `separator top=${state.sepTop} 应 < vph*0.5=${state.vph * 0.5}`,
    ).toBeLessThan(state.vph * 0.5);
    //   2) 视口内当前停留单元必须属于目标日（滚过头到别日 → 必红）
    expect(
      state.inViewDayDate,
      `视口停留单元 dayDate=${state.inViewDayDate} 应 == 目标日 ${targetDate}`,
    ).toBe(targetDate);
  });
});

// ============================================================================
// DL.P2 [det-machine]（回归）：#/?date=<历史日>&rank=N → 该 photo 单元定位
// ============================================================================

describe("[DL.P2][det-machine] 照片 rank 深链 #/?date=<历史日>&rank=N 定位到该 photo 单元", () => {
  it("打开 #/?date=<days[1]>&rank=3 后该 photo 单元 top 处于视口上半区", async ({ page }) => {
    const day = manifest.days[1]!;
    const targetPhoto = day.photos.find((p) => p.rank === 3);
    expect(targetPhoto, "fixture days[1] 应含 rank=3 照片").toBeDefined();
    const selector = `[data-stream-unit][data-photo-id="${targetPhoto!.photoId}"]`;

    await page.goto(`${STATIC_BASE}/#/?date=${day.pickDate}&rank=3`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    await waitUnitInUpperHalf(page, selector, 10000);

    const rect = await readUnitRect(page, selector);
    await writeArtifact("DL.P2", JSON.stringify({ day: day.pickDate, rank: 3, rect }));

    expect(rect.exists, `目标 photo 单元必须挂载：${selector}`).toBe(true);
    expect(rect.unitType).toBe("photo");
    expect(rect.dayDate, `目标单元 dayDate 应为 ${day.pickDate}`).toBe(day.pickDate);
    expect(rect.top, `top=${rect.top} 应 < vph*0.5=${rect.vph * 0.5}`).toBeLessThan(rect.vph * 0.5);
    expect(rect.top).toBeGreaterThan(-(rect.height * 0.5));
  });
});

// ============================================================================
// DL.P3 [det-machine]：#/?date=<流顶日>（dayIndex=0，无 date-separator）→ 不得静默无操作
// ============================================================================

describe("[DL.P3][det-machine] 流顶日深链 fallback（回顶或首张 photo 定位）", () => {
  it("打开 #/?date=<days[0]> 后 scrollTop=0 或首张 photo 单元在视口（不得静默无操作）", async ({
    page,
  }) => {
    const topDay = manifest.days[0]!.pickDate;
    await page.goto(`${STATIC_BASE}/#/?date=${topDay}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // 给深链处理（含可能的 fallback scrollIntoView）留足时间
    await page.waitForTimeout(2500);

    const state = await page.evaluate(() => {
      const stream = document.querySelector('[data-role="stream"]') as HTMLElement | null;
      const firstPhoto = document.querySelector(
        '[data-stream-unit][data-unit-type="photo"][data-day-index="0"][data-photo-rank="1"]',
      );
      const r = firstPhoto ? firstPhoto.getBoundingClientRect() : null;
      const vph = window.innerHeight;
      return {
        streamFound: !!stream,
        scrollTop: stream ? stream.scrollTop : Number.NaN,
        unitCount: document.querySelectorAll("[data-stream-unit]").length,
        firstPhotoFound: !!firstPhoto,
        firstPhotoTop: r ? r.top : Number.NaN,
        firstPhotoHeight: r ? r.height : 0,
        vph,
      };
    });

    await writeArtifact("DL.P3", JSON.stringify({ topDay, ...state }));

    expect(state.streamFound, "滚动容器 [data-role=stream] 必须存在").toBe(true);
    expect(state.unitCount, "流内必须有单元（页面正常渲染）").toBeGreaterThan(0);
    expect(state.firstPhotoFound, "流顶日（dayIndex=0）首张 photo 单元必须挂载").toBe(true);

    // 契约字面量二选一：scrollTop === 0 ∨ 首张 photo top 在视口内
    const atTop = state.scrollTop === 0;
    const firstPhotoInViewport =
      state.firstPhotoTop < state.vph * 0.5 &&
      state.firstPhotoTop > -(state.firstPhotoHeight * 0.5);
    expect(
      atTop || firstPhotoInViewport,
      `流顶日深链不得静默无操作：scrollTop=${state.scrollTop}，首张 photo top=${state.firstPhotoTop}（vph=${state.vph}）`,
    ).toBe(true);
  });
});

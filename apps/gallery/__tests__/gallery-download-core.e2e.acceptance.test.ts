/**
 * 验收测试（红队 E2E）：gallery 下载功能 — Happy Path 核心（det-machine 谓词）
 *
 * 设计契约来源（design-for-red-team.md §验收场景 场景1/2/3/5/6 + §契约规约 DOM 契约）：
 *   - 场景1 iOS 照片卡下载 → 恰一次 navigator.share 携带图片 File（P1-P5）
 *   - 场景2 桌面照片卡下载 → 一次浏览器下载、文件名带图片扩展名、落盘非空（P1-P4）
 *   - 场景3 iOS 视频卡下载 → 分享携带 video/mp4，loading 态 aria-valuenow 0-100 流转（P1-P4）
 *   - 场景5 壁纸横/竖版分别下载、来源互异、方向正确（P1-P4）
 *   - 场景6 深链 #/video/<id> 落地视图内直接可下载（P1-P3）
 *
 * DOM 契约属性（蓝队 1:1 挂载，红队仅据此定位，禁读 app.js/app.css/index.html）：
 *   [data-role="photo-download" | "video-download" | "wallpaper-download-portrait" | "wallpaper-download-landscape"]
 *   data-download-state ∈ {"idle","loading","error"}；视频 loading 态 aria-valuenow(0-100) + 文本含百分比
 *   [data-role="wechat-guide"] / [data-role="download-toast"] / [data-role="wechat-guide-close"]
 *   流单元（既有冻结契约）：[data-stream-unit][data-unit-type][data-photo-rank][data-video-id] / [data-role="wallpaper-card"]
 *
 * iOS 模拟：移动 UA + hasTouch + addInitScript stub navigator.share/canShare（记录调用计数/入参，
 * 按 mode resolve 或 AbortError reject）；桌面模拟：defineProperty 将 share/canShare 置 undefined。
 * fetch 调用经 init script 包装记录到 window.__fetchLog（比网络层事件可靠：同 URL 可能被 img 内存缓存命中）。
 *
 * 求值产物：/tmp/autopilot-artifacts/<谓词id>.out（如 场景1.P1.out）。
 *
 * 强断言铁律：每个 it 含 expect.* 硬断言，失败必挂；无任何 skip / warn-soft-pass。
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Browser,
  type BrowserContext,
  type Download,
  type Page,
  expect,
  test,
} from "@playwright/test";
const { describe, beforeAll, afterAll } = test;
const it = test;
import { generateFixture } from "./fixtures/gen-manifest.mjs";

declare global {
  interface Window {
    __shareCalls: Array<Array<{ name: string; type: string; size: number }>>;
    __openCalls: string[];
    __fetchLog: string[];
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 文件专属端口/env（避免与既有 8765/8766 及其他红队文件冲突；merge 后落 apps/gallery/__tests__）
const STATIC_PORT = Number(process.env.GALLERY_DL_CORE_PORT ?? 8767);
const GALLERY_DIR =
  process.env.GALLERY_DL_CORE_DIR ??
  path.join(os.tmpdir(), `relight-gallery-dl-core-${STATIC_PORT}`);
// 暂存区运行由 GALLERY_SRC_DIR 指向真实 apps/gallery；merge 后 __dirname/../ 即 apps/gallery
const SRC_GALLERY_DIR = process.env.GALLERY_SRC_DIR ?? path.resolve(__dirname, "../");
// 显式 127.0.0.1（python http.server 在本机 dual-stack 绑定会进入半死 CLOSED 态，SYN 全丢）
const STATIC_BASE = `http://127.0.0.1:${STATIC_PORT}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let serverProc: ChildProcess | null = null;
let fixtureDir: string;
let manifestPath: string;
let manifest: {
  days: Array<{
    pickDate: string;
    wallpaperLandscape: string | null;
    wallpaperPortrait: string | null;
    photos: Array<{ photoId: string; rank: number; original: string; thumbnail: string }>;
  }>;
  videos: Array<{ themeKey: string; title: string; mp4: string }>;
};
let auxSlow: { server: http.Server; port: number; close(): Promise<void> } | null = null;

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

  // python stdout/stderr 落盘（冷启动诊断；正常输出 Serving HTTP 一行）
  const pyLogPath = path.join(GALLERY_DIR, "py-server.log");
  const pyLogFd = fs.openSync(pyLogPath, "a");
  serverProc = spawn(
    process.env.GALLERY_PYTHON_BIN ?? "python3",
    ["-m", "http.server", "--bind", "127.0.0.1", String(STATIC_PORT), "--directory", GALLERY_DIR],
    { stdio: ["ignore", pyLogFd, pyLogFd] },
  );
  serverProc.on("error", (err) => {
    try {
      if (fs.existsSync(pyLogPath)) fs.appendFileSync(pyLogPath, `SPAWN ERROR: ${err.message}\n`);
    } catch {
      // ignore
    }
  });
  serverProc.on("exit", (code, signal) => {
    try {
      if (fs.existsSync(pyLogPath))
        fs.appendFileSync(pyLogPath, `PY EXIT: code=${code} signal=${signal}\n`);
    } catch {
      // afterAll 已清理目录，忽略
    }
  });
  await waitPortReady(STATIC_BASE, 20000, pyLogPath);

  // 辅助慢速服务器（场景3.P4：让视频下载传输持续 ~1.4s，可观察 loading 态 + aria-valuenow 流转）。
  // body = video-sample.mp4 原子重复到 ~400KB（真实 mp4 头在前，Chromium 可解码），分块限速写出。
  const sample = fs.readFileSync(
    path.join(SRC_GALLERY_DIR, "__tests__", "fixtures", "video-sample.mp4"),
  );
  auxSlow = await startSlowServer(sample);
});

afterAll(async () => {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
  if (auxSlow) {
    await auxSlow.close();
    auxSlow = null;
  }
  try {
    fs.rmSync(GALLERY_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function waitPortReady(base: string, timeoutMs = 20000, logPath?: string): Promise<void> {
  const probeUrl = base;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(probeUrl);
      if (res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const logTail =
    logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").slice(-800) : "(无日志)";
  throw new Error(
    `static server 启动超时: ${probeUrl}（lastErr: ${lastErr}；py-server.log 尾部: ${logTail}）`,
  );
}

/** 慢速静态服务器：CORS 全开 + Content-Length 精确 + 分块限速（32KB/120ms ≈ 1.4s / 400KB） */
function startSlowServer(
  sample: Buffer,
): Promise<{ server: http.Server; port: number; close(): Promise<void> }> {
  const CHUNK = 32 * 1024;
  const INTERVAL_MS = 120;
  const TARGET = 400 * 1024;
  const total = Math.ceil(TARGET / sample.length) * sample.length;
  const body = Buffer.alloc(total);
  for (let off = 0; off < total; off += sample.length) sample.copy(body, off);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(total),
        "Access-Control-Allow-Origin": "*",
      });
      let off = 0;
      const tick = (): void => {
        if (res.destroyed) return;
        const end = Math.min(off + CHUNK, total);
        res.write(body.subarray(off, end));
        off = end;
        if (off < total) setTimeout(tick, INTERVAL_MS);
        else res.end();
      };
      tick();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function writeArtifact(id: string, content: string): Promise<void> {
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

// ---------------------------------------------------------------------------
// DOM / 交互探针
// ---------------------------------------------------------------------------

/** init script：share/canShare stub + window.open / fetch 调用日志（先于 app.js 执行） */
function buildProbeScript(mode: "resolve" | "abort" | "noshare"): string {
  const shareStub =
    mode === "noshare"
      ? `Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
  Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true });`
      : `Object.defineProperty(navigator, "canShare", { value: function (d) { return !!(d && d.files && d.files.length > 0); }, configurable: true });
  Object.defineProperty(navigator, "share", { value: function (data) {
    var files = (data && data.files) ? Array.prototype.map.call(data.files, function (f) {
      return { name: f.name, type: f.type, size: f.size };
    }) : [];
    window.__shareCalls.push(files);
    if ("${mode}" === "abort") { return Promise.reject(new DOMException("user cancelled share panel", "AbortError")); }
    return Promise.resolve();
  }, configurable: true });`;
  return `(function () {
  window.__shareCalls = [];
  window.__openCalls = [];
  window.__fetchLog = [];
  window.open = function (url) {
    window.__openCalls.push(String(url == null ? "" : url));
    return { closed: false, focus: function () {}, close: function () {}, postMessage: function () {}, location: { href: String(url == null ? "" : url) } };
  };
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var u = "";
    try { u = typeof input === "string" ? input : (input && input.url) ? input.url : String(input); } catch (e) { u = String(input); }
    window.__fetchLog.push(u);
    return origFetch.call(window, input, init);
  };
  ${shareStub}
})();`;
}

type ProbeHandles = {
  ctx: BrowserContext;
  page: Page;
  downloads: Download[];
  pageErrors: string[];
  close(): Promise<void>;
};

/** 按设备形态 + 分享能力模式开新 context/page（不依赖全局 test.use，单 beforeAll 复用） */
async function openProbePage(
  browser: Browser,
  opts: { share: "resolve" | "abort" | "noshare"; mobile: boolean },
): Promise<ProbeHandles> {
  const ctx = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    hasTouch: opts.mobile,
    isMobile: opts.mobile,
    userAgent: opts.mobile ? IOS_SAFARI_UA : DESKTOP_CHROME_UA,
  });
  const page = await ctx.newPage();
  await page.addInitScript(buildProbeScript(opts.share));
  const downloads: Download[] = [];
  page.on("download", (d) => downloads.push(d));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  return { ctx, page, downloads, pageErrors, close: () => ctx.close() };
}

function isVisibleInDom(el: Element | null): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = window.getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0;
}

type UiState = {
  btnExists: boolean;
  btnVisible: boolean;
  btnDisabled: boolean | null;
  btnState: string | null;
  btnAriaLabel: string | null;
  btnValuenow: string | null;
  btnText: string;
  toastVisible: boolean;
  toastText: string;
  guideVisible: boolean;
  loadingCount: number;
  unitCount: number;
};

/** 读取下载控件/遮罩/toast 的可观察状态（选择器由调用方给定） */
async function readUiState(page: Page, btnSelector: string): Promise<UiState> {
  return page.evaluate((sel) => {
    const isVisible = (el: Element | null): boolean => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0;
    };
    const btn = document.querySelector(sel);
    const toast = document.querySelector('[data-role="download-toast"]');
    const guide = document.querySelector('[data-role="wechat-guide"]');
    const loadingBtns = Array.from(
      document.querySelectorAll(
        '[data-role="photo-download"],[data-role="video-download"],[data-role="wallpaper-download-portrait"],[data-role="wallpaper-download-landscape"]',
      ),
    ).filter((b) => b.getAttribute("data-download-state") === "loading");
    return {
      btnExists: !!btn,
      btnVisible: isVisible(btn),
      btnDisabled: btn
        ? btn.hasAttribute("disabled") ||
          (btn instanceof HTMLButtonElement && btn.disabled) ||
          btn.getAttribute("aria-disabled") === "true"
        : null,
      btnState: btn ? btn.getAttribute("data-download-state") : null,
      btnAriaLabel: btn ? btn.getAttribute("aria-label") : null,
      btnValuenow: btn ? btn.getAttribute("aria-valuenow") : null,
      btnText: btn ? (btn.textContent ?? "").trim() : "",
      toastVisible: isVisible(toast),
      toastText: toast ? (toast.textContent ?? "").trim() : "",
      guideVisible: isVisible(guide),
      loadingCount: loadingBtns.length,
      unitCount: document.querySelectorAll("[data-stream-unit]").length,
    };
  }, btnSelector);
}

const rank1Photo = (): { photoId: string; original: string } => {
  const p = manifest.days[0].photos.find((x) => x.rank === 1);
  if (!p) throw new Error("fixture 缺 rank=1 照片");
  return { photoId: p.photoId, original: p.original };
};
const photoUnitSel = (rank: number): string =>
  `[data-stream-unit][data-unit-type="photo"][data-day-index="0"][data-photo-rank="${rank}"]`;
const photoBtnSel = (rank: number): string => `${photoUnitSel(rank)} [data-role="photo-download"]`;
const videoUnitSel = (themeKey: string): string =>
  `[data-stream-unit][data-unit-type="video"][data-video-id="${themeKey}"]`;
const videoBtnSel = (themeKey: string): string =>
  `${videoUnitSel(themeKey)} [data-role="video-download"]`;
const wallpaperCardSel = '[data-stream-unit][data-role="wallpaper-card"]';

// ============================================================================
// 场景 1：iPhone 上点照片「下载」唤起系统分享面板（可存相册/文件）
// ============================================================================
describe("[场景1] iOS 照片卡下载 → Web Share 分享面板", () => {
  it("P1-P5：恰一次 share 携带图片 File / 来源为 manifest mid 直链 / 控件恢复 / 无错误提示 / 无微信遮罩", async ({
    browser,
  }) => {
    const { ctx, page, close } = await openProbePage(browser, { share: "resolve", mobile: true });
    try {
      await page.goto(`${STATIC_BASE}/#/`);
      const btn = page.locator(photoBtnSel(1));
      await btn.waitFor({ state: "visible", timeout: 10000 });
      const relOriginal = rank1Photo().original;

      // DOM 契约（§数据结构）：按钮有 aria-label 且初始 data-download-state="idle"
      const uiBefore = await readUiState(page, photoBtnSel(1));
      expect(uiBefore.btnAriaLabel, "下载按钮必须有 aria-label").toBeTruthy();
      expect(uiBefore.btnState).toBe("idle");

      await btn.click();
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 15000,
      });
      await page.waitForTimeout(300);
      const uiAfter = await readUiState(page, photoBtnSel(1));
      const shareCalls = await page.evaluate(() => window.__shareCalls);
      const fetchLog = await page.evaluate(() => window.__fetchLog);

      // 场景1.P1 [det-machine] shareCalls == 1 && files.length >= 1
      await writeArtifact("场景1.P1", JSON.stringify({ shareCalls: shareCalls.length }));
      expect(shareCalls, "must 恰调用一次 navigator.share").toHaveLength(1);
      expect(shareCalls[0]!.length, "必须携带至少一个 File").toBeGreaterThanOrEqual(1);

      // 场景1.P2 [det-machine] type contains "image/" && name matches /\.(jpe?g|png|webp)$/i
      const f0 = shareCalls[0]![0]!;
      await writeArtifact("场景1.P2", JSON.stringify(f0));
      expect(f0.type).toContain("image/");
      expect(f0.name).toMatch(/\.(jpe?g|png|webp)$/i);

      // 场景1.P3 [det-machine] disabled == false && errorVisible == false
      await writeArtifact(
        "场景1.P3",
        JSON.stringify({ disabled: uiAfter.btnDisabled, toastVisible: uiAfter.toastVisible }),
      );
      expect(uiAfter.btnDisabled, "分享 resolve 后控件必须恢复可点").toBe(false);
      expect(uiAfter.toastVisible, "成功路径不得出现错误提示 toast").toBe(false);

      // 场景1.P4 [det-machine] fetchedUrls contains manifest-original-url
      await writeArtifact("场景1.P4", JSON.stringify({ relOriginal, fetchLog }));
      expect(
        fetchLog.some((u) => u.includes(relOriginal)),
        `下载必须以 manifest 的 mid 直链为数据源: ${relOriginal}`,
      ).toBe(true);

      // 场景1.P5 [det-machine, negate] 非微信环境点击后 wechat-guide 不出现
      await writeArtifact("场景1.P5", JSON.stringify({ guideVisible: uiAfter.guideVisible }));
      expect(uiAfter.guideVisible, "非微信环境不得弹出微信引导遮罩").toBe(false);
    } finally {
      await close();
    }
  });
});

// ============================================================================
// 场景 2：桌面浏览器点照片「下载」文件直接落盘
// ============================================================================
describe("[场景2] 桌面照片卡下载 → 浏览器下载事件", () => {
  it("P1-P4：一次下载 / 文件名带图片扩展名 / 落盘非空 / 来源 manifest mid 直链", async ({
    browser,
  }) => {
    const { ctx, page, downloads, close } = await openProbePage(browser, {
      share: "noshare",
      mobile: false,
    });
    try {
      await page.goto(`${STATIC_BASE}/#/`);
      const btn = page.locator(photoBtnSel(1));
      await btn.waitFor({ state: "visible", timeout: 10000 });
      const relOriginal = rank1Photo().original;

      const dlPromise = page.waitForEvent("download", { timeout: 15000 });
      await btn.click();
      const dl = await dlPromise;
      const savePath = path.join(os.tmpdir(), `relight-dl-s2-${Date.now()}.jpg`);
      await dl.saveAs(savePath);
      const stat = fs.statSync(savePath);
      await page.waitForTimeout(500);
      const fetchLog = await page.evaluate(() => window.__fetchLog);

      // 场景2.P1 [det-machine] downloadEvents == 1
      await writeArtifact("场景2.P1", JSON.stringify({ downloadEvents: downloads.length }));
      expect(downloads, "must 恰触发一次浏览器下载").toHaveLength(1);

      // 场景2.P2 [det-machine] filename matches /\.(jpe?g|png|webp)$/i
      const filename = dl.suggestedFilename();
      await writeArtifact("场景2.P2", JSON.stringify({ filename }));
      expect(filename).toMatch(/\.(jpe?g|png|webp)$/i);

      // 场景2.P3 [det-machine] 落盘文件 size > 0
      await writeArtifact("场景2.P3", JSON.stringify({ size: stat.size, savePath }));
      expect(stat.size, "落盘文件必须非空").toBeGreaterThan(0);

      // 场景2.P4 [det-machine] fetchedUrls contains manifest-original-url
      await writeArtifact("场景2.P4", JSON.stringify({ relOriginal, fetchLog }));
      expect(fetchLog.some((u) => u.includes(relOriginal))).toBe(true);

      fs.rmSync(savePath, { force: true });
    } finally {
      await close();
    }
  });
});

// ============================================================================
// 场景 3：iPhone 上点视频「下载」分享面板携带 mp4（含 loading 态 + aria-valuenow 流转）
// ============================================================================
describe("[场景3] iOS 视频卡下载 → 分享携带 video/mp4 + 进度流转", () => {
  it("P1-P4：恰一次 share / type==video/mp4 且 .mp4 / 无错误且控件恢复 / loading 态 aria-valuenow 0-100", async ({
    browser,
  }) => {
    const { ctx, page, close } = await openProbePage(browser, { share: "resolve", mobile: true });
    try {
      // manifest 拦截：视频 mp4 改指辅助慢速服务器（~1.4s 传输，Content-Length 精确）
      const themeKey = manifest.videos[0]!.themeKey;
      const slowUrl = `http://127.0.0.1:${auxSlow!.port}/slow/video.mp4`;
      const rewritten = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
      rewritten.videos[0]!.mp4 = slowUrl;
      await page.route("**/manifest.json", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(rewritten),
        }),
      );

      await page.goto(`${STATIC_BASE}/#/`);
      await page.waitForSelector(videoUnitSel(themeKey), { timeout: 10000 });
      await page.evaluate((sel) => {
        document.querySelector(sel)?.scrollIntoView({ behavior: "instant", block: "center" });
      }, videoUnitSel(themeKey));
      await page.waitForTimeout(600);

      const btn = page.locator(videoBtnSel(themeKey));
      await btn.waitFor({ state: "visible", timeout: 10000 });
      await btn.click();

      // 传输期间轮询按钮状态（15ms 粒度，~1.4s 传输窗口足够采样）
      const samples: Array<{ state: string | null; valuenow: string | null; text: string }> = [];
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const ui = await readUiState(page, videoBtnSel(themeKey));
        samples.push({ state: ui.btnState, valuenow: ui.btnValuenow, text: ui.btnText });
        const shareCalls = await page.evaluate(() => window.__shareCalls.length);
        if (shareCalls >= 1 && ui.btnState !== "loading") break;
        await page.waitForTimeout(15);
      }

      const uiFinal = await readUiState(page, videoBtnSel(themeKey));
      const shareCalls = await page.evaluate(() => window.__shareCalls);

      // 场景3.P1 [det-machine] shareCalls == 1
      await writeArtifact("场景3.P1", JSON.stringify({ shareCalls: shareCalls.length }));
      expect(shareCalls, "must 恰调用一次 navigator.share").toHaveLength(1);

      // 场景3.P2 [det-machine] type == "video/mp4" && name matches /\.mp4$/i
      const f0 = shareCalls[0]![0] ?? null;
      await writeArtifact("场景3.P2", JSON.stringify(f0));
      expect(f0, "分享必须携带一个 File").toBeTruthy();
      expect(f0!.type).toBe("video/mp4");
      expect(f0!.name).toMatch(/\.mp4$/i);

      // 场景3.P3 [det-machine] errorVisible == false && disabled == false
      await writeArtifact(
        "场景3.P3",
        JSON.stringify({ toastVisible: uiFinal.toastVisible, disabled: uiFinal.btnDisabled }),
      );
      expect(uiFinal.toastVisible, "成功路径不得出现错误提示").toBe(false);
      expect(uiFinal.btnDisabled, "分享 resolve 后控件必须恢复可点").toBe(false);

      // 场景3.P4 [det-machine] state == "loading" && 0 <= ariaValuenow <= 100
      const loadingSamples = samples.filter((s) => s.state === "loading");
      const valuenowSamples = samples.map((s) => s.valuenow).filter((v): v is string => v !== null);
      await writeArtifact(
        "场景3.P4",
        JSON.stringify({
          loadingSamples: loadingSamples.length,
          valuenowSamples: valuenowSamples,
          stateSamples: samples.map((s) => s.state),
        }),
      );
      expect(
        loadingSamples.length,
        "视频下载进行中必须观察到 data-download-state=loading",
      ).toBeGreaterThanOrEqual(1);
      expect(
        valuenowSamples.length,
        "视频下载进行中必须观察到 aria-valuenow 流转（Content-Length 存在时 onProgress 必须驱动进度）",
      ).toBeGreaterThanOrEqual(1);
      for (const v of valuenowSamples) {
        const n = Number.parseInt(v, 10);
        expect(Number.isInteger(n), `aria-valuenow 必须是整数，实际 ${v}`).toBe(true);
        expect(n, `aria-valuenow 必须 >= 0，实际 ${v}`).toBeGreaterThanOrEqual(0);
        expect(n, `aria-valuenow 必须 <= 100，实际 ${v}`).toBeLessThanOrEqual(100);
      }
      expect(
        loadingSamples.some((s) => /\d+\s*%/.test(s.text)),
        "loading 态按钮文本必须含百分比（DOM 契约：按钮文本含百分比且 aria-valuenow 同步）",
      ).toBe(true);
    } finally {
      await close();
    }
  });
});

// ============================================================================
// 场景 5：壁纸卡横版/竖版分别可下载且方向正确
// ============================================================================
describe("[场景5] 壁纸横/竖版下载（方向 + 来源互异）", () => {
  it("P1-P3：桌面两次下载 / 来源=manifest 横竖直链且互异 / 落盘横宽>高、竖高>宽", async ({
    browser,
  }) => {
    const { ctx, page, downloads, close } = await openProbePage(browser, {
      share: "noshare",
      mobile: false,
    });
    try {
      const today = manifest.days[0]!;
      const relLandscape = today.wallpaperLandscape!;
      const relPortrait = today.wallpaperPortrait!;

      await page.goto(`${STATIC_BASE}/#/`);
      await page.waitForSelector(wallpaperCardSel, { timeout: 10000 });
      const portraitBtn = page
        .locator(wallpaperCardSel)
        .first()
        .locator('[data-role="wallpaper-download-portrait"]');
      const landscapeBtn = page
        .locator(wallpaperCardSel)
        .first()
        .locator('[data-role="wallpaper-download-landscape"]');
      // 改版 [2026-09-14]：静态日主钮 = 竖版下载（动作栏直点）；横版按钮移入「更多」菜单
      // （popover 常驻 DOM 初始 hidden）——点击前必须先展开菜单。
      // 竖版主钮在菜单外，点击它会把已展开的弹层收起 → 先点竖版、再开菜单点横版。
      await portraitBtn.waitFor({ state: "visible", timeout: 10000 });

      // DOM 契约：两按钮均带 aria-label 与 data-download-state（属性读取与弹层开合无关）
      const uiPortrait = await readUiState(
        page,
        `${wallpaperCardSel} [data-role="wallpaper-download-portrait"]`,
      );
      const uiLandscape = await readUiState(
        page,
        `${wallpaperCardSel} [data-role="wallpaper-download-landscape"]`,
      );
      expect(uiPortrait.btnAriaLabel, "竖版按钮必须有 aria-label").toBeTruthy();
      expect(uiPortrait.btnState).toBe("idle");
      expect(uiLandscape.btnAriaLabel, "横版按钮必须有 aria-label").toBeTruthy();
      expect(uiLandscape.btnState).toBe("idle");

      const dlPortraitPromise = page.waitForEvent("download", { timeout: 15000 });
      await portraitBtn.click();
      const dlPortrait = await dlPortraitPromise;
      const portraitPath = path.join(os.tmpdir(), `relight-dl-s5p-${Date.now()}.jpg`);
      await dlPortrait.saveAs(portraitPath);

      // 先开更多菜单，再点菜单项（横版）
      const moreBtn = page.locator(wallpaperCardSel).first().locator('[data-role="more-menu"]');
      await moreBtn.waitFor({ state: "visible", timeout: 10000 });
      await moreBtn.click();
      await landscapeBtn.waitFor({ state: "visible", timeout: 10000 });

      const dlLandscapePromise = page.waitForEvent("download", { timeout: 15000 });
      await landscapeBtn.click();
      const dlLandscape = await dlLandscapePromise;
      const landscapePath = path.join(os.tmpdir(), `relight-dl-s5l-${Date.now()}.jpg`);
      await dlLandscape.saveAs(landscapePath);

      await page.waitForTimeout(500);
      const fetchLog = await page.evaluate(() => window.__fetchLog);

      // 场景5.P1 [det-machine] downloadEvents == 2 && horizontalUrl != verticalUrl
      const landscapeUrls = fetchLog.filter((u) => u.includes(relLandscape));
      const portraitUrls = fetchLog.filter((u) => u.includes(relPortrait));
      await writeArtifact(
        "场景5.P1",
        JSON.stringify({
          downloadEvents: downloads.length,
          landscapeUrl: landscapeUrls[0] ?? null,
          portraitUrl: portraitUrls[0] ?? null,
        }),
      );
      expect(downloads, "横竖版各触发一次下载").toHaveLength(2);
      expect(landscapeUrls[0], "必须发起横版直链请求").toBeTruthy();
      expect(portraitUrls[0], "必须发起竖版直链请求").toBeTruthy();
      expect(landscapeUrls[0], "横竖版来源 URL 必须互异").not.toBe(portraitUrls[0]);

      // 场景5.P2 [det-machine] fetchedUrls contains 横版url && 竖版url
      await writeArtifact("场景5.P2", JSON.stringify({ relLandscape, relPortrait, fetchLog }));
      expect(fetchLog.some((u) => u.includes(relLandscape))).toBe(true);
      expect(fetchLog.some((u) => u.includes(relPortrait))).toBe(true);

      // 场景5.P3 [det-machine] 横版宽>高、竖版高>宽、size > 0（文件头解析）
      const lBuf = fs.readFileSync(landscapePath);
      const pBuf = fs.readFileSync(portraitPath);
      const lDim = parseImageDimensions(lBuf);
      const pDim = parseImageDimensions(pBuf);
      await writeArtifact(
        "场景5.P3",
        JSON.stringify({
          landscape: { ...lDim, size: lBuf.length },
          portrait: { ...pDim, size: pBuf.length },
        }),
      );
      expect(lBuf.length, "横版落盘文件非空").toBeGreaterThan(0);
      expect(pBuf.length, "竖版落盘文件非空").toBeGreaterThan(0);
      expect(
        lDim.width,
        `横版宽必须 > 横版高（实际 ${lDim.width}x${lDim.height}）`,
      ).toBeGreaterThan(lDim.height);
      expect(
        pDim.height,
        `竖版高必须 > 竖版宽（实际 ${pDim.width}x${pDim.height}）`,
      ).toBeGreaterThan(pDim.width);

      fs.rmSync(portraitPath, { force: true });
      fs.rmSync(landscapePath, { force: true });
    } finally {
      await close();
    }
  });

  it("P4：iOS 形态点壁纸下载 → navigator.share 携带 image/* 文件", async ({ browser }) => {
    const { ctx, page, close } = await openProbePage(browser, { share: "resolve", mobile: true });
    try {
      await page.goto(`${STATIC_BASE}/#/`);
      await page.waitForSelector(wallpaperCardSel, { timeout: 10000 });
      const btn = page
        .locator(wallpaperCardSel)
        .first()
        .locator('[data-role="wallpaper-download-portrait"]');
      await btn.waitFor({ state: "visible", timeout: 10000 });

      await btn.click();
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 15000,
      });
      const shareCalls = await page.evaluate(() => window.__shareCalls);

      // 场景5.P4 [det-machine] shareCalls == 1 && files[0].type contains "image/"
      const payload = { shareCalls: shareCalls.length, files0: shareCalls[0]?.[0] ?? null };
      await writeArtifact("场景5.P4", JSON.stringify(payload));
      expect(shareCalls).toHaveLength(1);
      expect(shareCalls[0]!.length).toBeGreaterThanOrEqual(1);
      expect(shareCalls[0]![0]!.type).toContain("image/");
    } finally {
      await close();
    }
  });
});

// ============================================================================
// 场景 6：企业微信推送落地视图（#/video/<id> 深链）内直接可下载
// ============================================================================
describe("[场景6] 深链 #/video/<id> 落地视图内直接可下载", () => {
  it("P1-P3：下载控件可见可点 / 恰一次 share type==video/mp4 / 无错误无未捕获异常", async ({
    browser,
  }) => {
    const { ctx, page, pageErrors, close } = await openProbePage(browser, {
      share: "resolve",
      mobile: true,
    });
    try {
      const video = manifest.videos[0]!;
      const relMp4 = video.mp4;
      // 显式 Content-Type: video/mp4（对齐 COS 生产行为，屏蔽 python http.server mimetypes 差异）
      await page.route(`**/${relMp4}`, (route) =>
        route.fulfill({
          path: path.join(fixtureDir, relMp4),
          contentType: "video/mp4",
        }),
      );

      await page.goto(`${STATIC_BASE}/#/video/${video.themeKey}`);
      await page.waitForSelector(videoUnitSel(video.themeKey), { timeout: 10000 });
      await page.waitForTimeout(800);
      const btnSel = videoBtnSel(video.themeKey);

      // 场景6.P1 [det-machine] downloadControlVisible == true && disabled == false
      const uiBefore = await readUiState(page, btnSel);
      await writeArtifact("场景6.P1", JSON.stringify(uiBefore));
      expect(uiBefore.btnExists, "深链落地视频视图必须渲染下载控件").toBe(true);
      expect(uiBefore.btnVisible, "下载控件必须可见").toBe(true);
      expect(uiBefore.btnDisabled, "下载控件必须可点").toBe(false);

      await page.locator(btnSel).click();
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 15000,
      });
      await page.waitForTimeout(300);

      // 场景6.P2 [det-machine] shareCalls == 1 && files[0].type == "video/mp4"
      const shareCalls = await page.evaluate(() => window.__shareCalls);
      await writeArtifact(
        "场景6.P2",
        JSON.stringify({ shareCalls: shareCalls.length, files0: shareCalls[0]?.[0] ?? null }),
      );
      expect(shareCalls).toHaveLength(1);
      expect(shareCalls[0]![0]!.type).toBe("video/mp4");

      // 场景6.P3 [det-machine] errorVisible == false && pageErrors == 0
      const uiAfter = await readUiState(page, btnSel);
      await writeArtifact(
        "场景6.P3",
        JSON.stringify({ toastVisible: uiAfter.toastVisible, pageErrors }),
      );
      expect(uiAfter.toastVisible, "成功路径不得出现错误提示").toBe(false);
      expect(pageErrors, "不得出现未捕获 JS 异常").toHaveLength(0);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// 图片尺寸解析（场景5.P3 落盘文件头断言用；支持 PNG IHDR / JPEG SOF0-SOF15）
// ---------------------------------------------------------------------------
function parseImageDimensions(buf: Buffer): { width: number; height: number; format: string } {
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR（width@16, height@20, big-endian）
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    if (buf.toString("ascii", 12, 16) === "IHDR") {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
    }
  }
  // JPEG: FFD8 起始，扫 SOF0-CF（除 C4/C8/CC）取 height@+5 / width@+7
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1]!;
      if (
        marker === 0xd8 ||
        (marker >= 0xd0 && marker <= 0xd9) ||
        marker === 0x01 ||
        marker === 0xff
      ) {
        off += 2;
        continue;
      }
      const len = buf.readUInt16BE(off + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: buf.readUInt16BE(off + 5),
          width: buf.readUInt16BE(off + 7),
          format: "jpeg",
        };
      }
      off += 2 + len;
    }
  }
  throw new Error(`无法解析图片尺寸（非 PNG/JPEG 头）: ${buf.subarray(0, 4).toString("hex")}`);
}

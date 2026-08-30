/**
 * 验收测试（红队 E2E）：gallery 下载功能 — 错误态 / 降级 / 取消 / 防重（det-machine 谓词）
 *
 * 设计契约来源（design-for-red-team.md §验收场景 场景4/7/8/9/10 + §错误契约 枚举）：
 *   - 场景4 桌面视频下载 mp4 原样、字节数与直链一致（P1/P3 内联；P2 real-process 见文件尾 QA 块）
 *   - 场景7 iOS 用户取消分享面板（AbortError）不视为失败（P1-P3，negate）
 *   - 场景8 环境不支持 Web Share 时降级仍可获取文件（P1-P3）
 *   - 场景9 COS 资源不可达时错误可感知且可重试（P1-P4）
 *   - 场景10 下载进行中防重复触发（P1-P2）
 *
 * 错误契约（蓝红 1:1）：
 *   FETCH_FAILED：fetch 抛错或 !res.ok → window.open(url) 兜底 + toast「已打开原文件…」+ 按钮回 idle
 *   SHARE_ABORTED：navigator.share AbortError → 静默（非错误），按钮回 idle
 *   STATE_INVARIANT：下载进行中按钮 disabled，重复点击无副作用
 *
 * DOM 契约属性：同 gallery-download-core 文件头声明（禁读 app.js/app.css/index.html）。
 * 求值产物：/tmp/autopilot-artifacts/<谓词id>.out。
 *
 * 强断言铁律：每个 it 含 expect.* 硬断言，失败必挂；无任何 skip / warn-soft-pass。
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
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
const STATIC_PORT = Number(process.env.GALLERY_DL_STATES_PORT ?? 8768);
const GALLERY_DIR =
  process.env.GALLERY_DL_STATES_DIR ??
  path.join(os.tmpdir(), `relight-gallery-dl-states-${STATIC_PORT}`);
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
    photos: Array<{ photoId: string; rank: number; original: string }>;
  }>;
  videos: Array<{ themeKey: string; title: string; mp4: string }>;
};

beforeAll(async () => {
  test.setTimeout(30_000); // hook 级超时（Playwright 1.59 beforeAll 无 timeout 重载）
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
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
  const pyLogFd = fs.openSync(path.join(GALLERY_DIR, "py-server.log"), "a");
  serverProc = spawn(
    "python3",
    ["-m", "http.server", "--bind", "127.0.0.1", String(STATIC_PORT), "--directory", GALLERY_DIR],
    { stdio: ["ignore", pyLogFd, pyLogFd] },
  );
  await waitPortReady(STATIC_BASE, 20000, path.join(GALLERY_DIR, "py-server.log"));
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

async function writeArtifact(id: string, content: string): Promise<void> {
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

// ---------------------------------------------------------------------------
// DOM / 交互探针（与 gallery-download-core 同构）
// ---------------------------------------------------------------------------

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
};

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
    };
  }, btnSelector);
}

const rank1Original = (): string => {
  const p = manifest.days[0]!.photos.find((x) => x.rank === 1);
  if (!p) throw new Error("fixture 缺 rank=1 照片");
  return p.original;
};
const photoBtnSel = (rank: number): string =>
  `[data-stream-unit][data-unit-type="photo"][data-day-index="0"][data-photo-rank="${rank}"] [data-role="photo-download"]`;
const videoUnitSel = (themeKey: string): string =>
  `[data-stream-unit][data-unit-type="video"][data-video-id="${themeKey}"]`;
const videoBtnSel = (themeKey: string): string =>
  `${videoUnitSel(themeKey)} [data-role="video-download"]`;

// ============================================================================
// 场景 4：桌面下载视频 mp4 原样、字节数与直链一致
// ============================================================================
describe("[场景4] 桌面视频下载 mp4 原样", () => {
  it("P1/P3：一次 .mp4 浏览器下载；落盘字节数 == 直链资源大小（node-script 内联比对）", async ({
    browser,
  }) => {
    const { ctx, page, downloads, close } = await openProbePage(browser, {
      share: "noshare",
      mobile: false,
    });
    try {
      const video = manifest.videos[0]!;
      const relMp4 = video.mp4;
      // 显式 Content-Type: video/mp4（对齐 COS 生产行为）
      await page.route(`**/${relMp4}`, (route) =>
        route.fulfill({ path: path.join(fixtureDir, relMp4), contentType: "video/mp4" }),
      );

      await page.goto(`${STATIC_BASE}/#/`);
      await page.waitForSelector(videoUnitSel(video.themeKey), { timeout: 10000 });
      await page.evaluate((sel) => {
        document.querySelector(sel)?.scrollIntoView({ behavior: "instant", block: "center" });
      }, videoUnitSel(video.themeKey));
      await page.waitForTimeout(800);

      const btn = page.locator(videoBtnSel(video.themeKey));
      await btn.waitFor({ state: "visible", timeout: 10000 });
      const dlPromise = page.waitForEvent("download", { timeout: 20000 });
      await btn.click();
      const dl = await dlPromise;
      const savePath = path.join(os.tmpdir(), `relight-dl-s4-${Date.now()}.mp4`);
      await dl.saveAs(savePath);
      await page.waitForTimeout(500);

      // 场景4.P1 [det-machine] downloadEvents == 1 && filename matches /\.mp4$/i
      const filename = dl.suggestedFilename();
      await writeArtifact(
        "场景4.P1",
        JSON.stringify({ downloadEvents: downloads.length, filename }),
      );
      expect(downloads, "must 恰触发一次浏览器下载").toHaveLength(1);
      expect(filename, "下载文件名必须以 .mp4 结尾").toMatch(/\.mp4$/i);

      // 场景4.P3 [det-machine / node-script:compare-download-size] fileSize == contentLength
      // 直链即本地静态服务的 fixture mp4 文件，stat 大小等价直链 Content-Length（同字节源）。
      const sourceSize = fs.statSync(path.join(fixtureDir, relMp4)).size;
      const savedSize = fs.statSync(savePath).size;
      await writeArtifact("场景4.P3", JSON.stringify({ savedSize, sourceSize, relMp4, savePath }));
      expect(savedSize, "落盘文件必须非空").toBeGreaterThan(0);
      expect(savedSize, `落盘字节数必须等于直链资源大小（${savedSize} != ${sourceSize}）`).toBe(
        sourceSize,
      );

      fs.rmSync(savePath, { force: true });
    } finally {
      await close();
    }
  });

  // PREDICATE-DEFERRED-QA: 场景4.P2 [real-process] driver: curl:manifest-video-direct-url
  //   前置：拉取线上 manifest（https://gallery.stringzhao.life/manifest.json），取任一 videos[].mp4 COS 直链
  //   $ curl -sI <COS 视频直链>
  //   assert: HTTP 状态 == 200 && content-type contains "video/mp4" && content-length > 0
  //   artifact: /tmp/autopilot-artifacts/场景4.P2.out
  //   说明：需对真实 COS 桶发起请求，不属 Playwright 可测范围，交 QA Tier 1.5 真实求值。
});

// ============================================================================
// 场景 7：iPhone 上用户取消分享面板不视为失败（SHARE_ABORTED → 静默）
// ============================================================================
describe("[场景7] iOS 取消分享面板不视为失败", () => {
  it("P1-P3：无错误提示 / 不降级下载不新开直链 / 控件恢复可点", async ({ browser }) => {
    const { ctx, page, downloads, close } = await openProbePage(browser, {
      share: "abort",
      mobile: true,
    });
    try {
      await page.goto(`${STATIC_BASE}/#/`);
      const btn = page.locator(photoBtnSel(1));
      await btn.waitFor({ state: "visible", timeout: 10000 });

      await btn.click();
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 15000,
      });
      // 用户取消后给错误 UI（如误 toast）留出现窗口
      await page.waitForTimeout(800);
      const ui = await readUiState(page, photoBtnSel(1));
      const shareCalls = await page.evaluate(() => window.__shareCalls);
      const openCalls = await page.evaluate(() => window.__openCalls);

      expect(shareCalls, "stub share 必须已被调用一次").toHaveLength(1);

      // 场景7.P1 [det-machine, negate] errorVisible == false
      await writeArtifact(
        "场景7.P1",
        JSON.stringify({ toastVisible: ui.toastVisible, toastText: ui.toastText }),
      );
      expect(ui.toastVisible, "取消分享面板不得展示错误/失败提示").toBe(false);

      // 场景7.P2 [det-machine, negate] downloadEvents == 0 && openCalls == 0
      await writeArtifact(
        "场景7.P2",
        JSON.stringify({ downloadEvents: downloads.length, openCalls }),
      );
      expect(downloads, "取消后不得触发降级下载").toHaveLength(0);
      expect(openCalls, "取消后不得新开直链").toHaveLength(0);

      // 场景7.P3 [det-machine] disabled == false（可重试）
      await writeArtifact(
        "场景7.P3",
        JSON.stringify({ disabled: ui.btnDisabled, state: ui.btnState }),
      );
      expect(ui.btnDisabled, "取消后控件必须恢复可点可重试").toBe(false);
      expect(ui.btnState, "SHARE_ABORTED 属静默非错误，按钮须回 idle").toBe("idle");
    } finally {
      await close();
    }
  });
});

// ============================================================================
// 场景 8：环境不支持 Web Share 时降级仍可获取文件
// ============================================================================
describe("[场景8] 无 Web Share 环境降级可获取文件", () => {
  it("P1-P3：降级产出下载 / 无未捕获 JS 错误 / 无点击无反应死状态", async ({ browser }) => {
    const { ctx, page, downloads, pageErrors, close } = await openProbePage(browser, {
      share: "noshare",
      mobile: true, // 受限移动浏览器形态（旧 iOS/受限 webview）
    });
    try {
      await page.goto(`${STATIC_BASE}/#/`);
      const btn = page.locator(photoBtnSel(1));
      await btn.waitFor({ state: "visible", timeout: 10000 });
      const relOriginal = rank1Original();

      const dlPromise = page.waitForEvent("download", { timeout: 15000 });
      await btn.click();
      await dlPromise;
      const dl = downloads[0]!;
      const savePath = path.join(os.tmpdir(), `relight-dl-s8-${Date.now()}.jpg`);
      await dl.saveAs(savePath);
      const savedSize = fs.statSync(savePath).size;
      await page.waitForTimeout(500);
      const fetchLog = await page.evaluate(() => window.__fetchLog);
      const shareCalls = await page.evaluate(() => window.__shareCalls);
      const openCalls = await page.evaluate(() => window.__openCalls);

      // 场景8.P1 [det-machine] (downloadEvents == 1 || openedUrl contains "cos") && fetched contains manifest-url
      await writeArtifact(
        "场景8.P1",
        JSON.stringify({ downloadEvents: downloads.length, fetchLog, relOriginal }),
      );
      expect(downloads, "无 share 环境必须经降级路径产出一次浏览器下载").toHaveLength(1);
      expect(
        fetchLog.some((u) => u.includes(relOriginal)),
        "降级下载数据源必须是 manifest 直链",
      ).toBe(true);

      // 场景8.P2 [det-machine] pageErrors == 0
      await writeArtifact("场景8.P2", JSON.stringify({ pageErrors }));
      expect(pageErrors, "降级路径不得产生未捕获 JS 异常").toHaveLength(0);

      // 场景8.P3 [det-machine] (shareCalls + downloadEvents + openCalls) >= 1
      const total = shareCalls.length + downloads.length + openCalls.length;
      await writeArtifact(
        "场景8.P3",
        JSON.stringify({
          shareCalls: shareCalls.length,
          downloadEvents: downloads.length,
          openCalls: openCalls.length,
          total,
          savedSize,
        }),
      );
      expect(total, "不得出现点击后无任何反应的死状态").toBeGreaterThanOrEqual(1);
      expect(savedSize, "降级落盘文件必须非空（可保存）").toBeGreaterThan(0);

      fs.rmSync(savePath, { force: true });
    } finally {
      await close();
    }
  });
});

// ============================================================================
// 场景 9：COS 资源不可达时错误可感知且可重试
// ============================================================================
describe("[场景9] COS 资源不可达 → 错误可感知可重试", () => {
  it("P1-P4：错误提示出现且 loading 结束 / 不调用 share / 控件恢复 / 解除拦截后重试成功", async ({
    browser,
  }) => {
    const { ctx, page, downloads, close } = await openProbePage(browser, {
      share: "resolve",
      mobile: true,
    });
    try {
      await page.goto(`${STATIC_BASE}/#/`);
      const btn = page.locator(photoBtnSel(1));
      await btn.waitFor({ state: "visible", timeout: 10000 });
      const relOriginal = rank1Original();
      // 等 img 完成加载（同一 URL），再注入拦截——只影响点击后的下载 fetch
      await page.waitForTimeout(1500);
      await page.route(`**/${relOriginal}`, (route) => route.abort("failed"));

      await btn.click();
      // FETCH_FAILED 契约：window.open(url) 兜底必发生（stub 记录不导航）
      await page.waitForFunction(() => window.__openCalls.length >= 1, undefined, {
        timeout: 15000,
      });
      // 错误 toast 出现（元素常驻有尺寸，隐藏靠 visibility/opacity 过渡；
      // 必须等「真正可见」而非 rect>0，2.5s 自动消失前完成读取）
      await page
        .waitForFunction(
          () => {
            const t = document.querySelector('[data-role="download-toast"]');
            if (!t) return false;
            const r = t.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const s = window.getComputedStyle(t);
            return s.display !== "none" && s.visibility === "visible" && Number(s.opacity) > 0;
          },
          undefined,
          { timeout: 4000 },
        )
        .catch(() => {
          // 由下方硬断言判失败，这里只避免未处理 rejection
        });
      const uiFail = await readUiState(page, photoBtnSel(1));
      const shareCallsFail = await page.evaluate(() => window.__shareCalls);
      const openCalls = await page.evaluate(() => window.__openCalls);

      // 场景9.P1 [det-machine] errorVisible == true && loadingVisible == false
      await writeArtifact(
        "场景9.P1",
        JSON.stringify({
          toastVisible: uiFail.toastVisible,
          toastText: uiFail.toastText,
          loadingCount: uiFail.loadingCount,
          btnState: uiFail.btnState,
        }),
      );
      expect(uiFail.toastVisible, "COS 请求失败必须展示错误/兜底提示").toBe(true);
      expect(uiFail.toastText, "错误提示文本必须非空").toBeTruthy();
      expect(uiFail.loadingCount, "失败后不得残留任何 loading 态控件").toBe(0);
      expect(uiFail.btnState, "FETCH_FAILED 契约：按钮回 idle").toBe("idle");

      // 场景9.P2 [det-machine, negate] shareCalls == 0
      await writeArtifact("场景9.P2", JSON.stringify({ shareCalls: shareCallsFail.length }));
      expect(shareCallsFail, "fetch 失败不得进入分享路径").toHaveLength(0);

      // 场景9.P3 [det-machine] disabled == false（可重试）
      await writeArtifact("场景9.P3", JSON.stringify({ disabled: uiFail.btnDisabled }));
      expect(uiFail.btnDisabled, "失败后控件必须恢复可点").toBe(false);

      // FETCH_FAILED 契约补强：兜底必须打开直链一次
      expect(openCalls, "fetch 失败必须 window.open 直链兜底一次").toHaveLength(1);
      expect(openCalls[0], "兜底打开的必须是该直链").toContain(relOriginal);

      // 场景9.P4 [det-machine] 拦截解除后重试 → (shareCalls + downloadEvents) >= 1
      await page.unroute(`**/${relOriginal}`);
      await btn.click();
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 15000,
      });
      const shareCallsRetry = await page.evaluate(() => window.__shareCalls);
      await writeArtifact(
        "场景9.P4",
        JSON.stringify({
          shareCalls: shareCallsRetry.length,
          downloadEvents: downloads.length,
        }),
      );
      expect(
        shareCallsRetry.length + downloads.length,
        "解除拦截重试后必须成功触发分享（或下载）",
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await close();
    }
  });
});

// ============================================================================
// 场景 10：下载进行中防重复触发（STATE_INVARIANT）
// ============================================================================
describe("[场景10] 下载进行中防重复触发", () => {
  it("P1/P2：loading 中重复点击 → share 恰一次、资源请求恰一次；结束后控件恢复", async ({
    browser,
  }) => {
    const { ctx, page, close } = await openProbePage(browser, { share: "resolve", mobile: true });
    try {
      await page.goto(`${STATIC_BASE}/#/`);
      const btn = page.locator(photoBtnSel(1));
      await btn.waitFor({ state: "visible", timeout: 10000 });
      const relOriginal = rank1Original();
      await page.waitForTimeout(1500); // img 先行加载同 URL

      // 直链响应加 ~2s 延迟，制造可观察的进行中窗口
      await page.route(`**/${relOriginal}`, async (route) => {
        await new Promise((r) => setTimeout(r, 2000));
        await route.continue();
      });

      await btn.click();
      await page.waitForFunction(
        () => {
          const b = document.querySelector(
            '[data-stream-unit][data-unit-type="photo"][data-day-index="0"][data-photo-rank="1"] [data-role="photo-download"]',
          );
          return b?.getAttribute("data-download-state") === "loading";
        },
        undefined,
        { timeout: 5000 },
      );

      // 进行中二次点击：绕过 Playwright actionability，直接 DOM click——
      // 若实现正确 disabled，浏览器对 disabled 按钮的 .click() 是无操作；
      // 若漏 disabled/guard，这里会发起第二次 fetch（被 __fetchLog 计数捕获）。
      await page.evaluate((sel) => {
        (document.querySelector(sel) as HTMLElement | null)?.click();
      }, photoBtnSel(1));
      await page.waitForTimeout(200);

      // 等首次（也是唯一一次）下载完成
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 20000,
      });
      await page.waitForTimeout(500);
      const shareCalls = await page.evaluate(() => window.__shareCalls);
      const fetchCount = await page.evaluate(
        (rel) => window.__fetchLog.filter((u) => u.includes(rel)).length,
        relOriginal,
      );

      // 场景10.P1 [det-machine, negate] shareCalls == 1 && fetchCount == 1
      await writeArtifact(
        "场景10.P1",
        JSON.stringify({ shareCalls: shareCalls.length, fetchCount }),
      );
      expect(shareCalls, "重复点击不得发起第二次分享").toHaveLength(1);
      expect(fetchCount, "重复点击不得发起第二次资源请求").toBe(1);

      // 场景10.P2 [det-machine] disabled == false（结束后控件恢复可点）
      const uiAfter = await readUiState(page, photoBtnSel(1));
      await writeArtifact(
        "场景10.P2",
        JSON.stringify({ disabled: uiAfter.btnDisabled, state: uiAfter.btnState }),
      );
      expect(uiAfter.btnDisabled, "下载流程结束后控件必须恢复可点").toBe(false);
    } finally {
      await close();
    }
  });
});

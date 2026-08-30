/**
 * 验收测试（红队 E2E）：gallery 下载功能 — 缺直链边界 / 微信引导 / COS CORS CLI（det-machine 谓词）
 *
 * 设计契约来源（design-for-red-team.md §验收场景 场景11/W1/W2/C2/C3/C4 + §manifest 消费契约）：
 *   - 场景11 manifest 条目缺资源直链时不渲染死链下载控件（视频 mp4 空串 / 壁纸横版空串 / 照片 original 空串）
 *   - 场景W1 微信内置浏览器（UA 含 MicroMessenger）点击下载 → 引导遮罩且零下载/分享副作用
 *   - 场景W2 引导遮罩可关闭，关闭后页面可继续浏览
 *   - 场景C3 cos:cors 无参默认 dry-run：打印完整规则 JSON 且退出 0（离线可测，内联）
 *   - 场景C4 cos:cors 退出码契约：凭据缺失→1，伪造无效凭据→2（内联）
 *   - real-process 谓词（场景12.P1-P4 / C1 / C2）见文件尾 PREDICATE-DEFERRED-QA 块，交 QA Tier 1.5
 *
 * manifest 消费契约（只读不变更）：
 *   wallpaperPortrait 空 → 卡不渲染；wallpaperLandscape 空串 → 横版按钮不渲染
 *   video.mp4 空串 → 视频卡不渲染下载按钮；photo.original 空串 → 照片卡不渲染下载按钮
 *
 * fixture：generateFixture({ missingLinks: true })（gen-manifest.mjs 下载验收扩展变体，
 * manifest 直接落盘由静态服务返回——与「route 拦截 manifest 返回 fixture」机制等价且更确定）。
 *
 * 求值产物：/tmp/autopilot-artifacts/<谓词id>.out。
 * 强断言铁律：每个 it 含 expect.* 硬断言，失败必挂；无任何 skip / warn-soft-pass。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
const STATIC_PORT = Number(process.env.GALLERY_DL_EDGE_PORT ?? 8769);
const GALLERY_DIR =
  process.env.GALLERY_DL_EDGE_DIR ??
  path.join(os.tmpdir(), `relight-gallery-dl-edge-${STATIC_PORT}`);
const SRC_GALLERY_DIR = process.env.GALLERY_SRC_DIR ?? path.resolve(__dirname, "../");
// 显式 127.0.0.1（python http.server 在本机 dual-stack 绑定会进入半死 CLOSED 态，SYN 全丢）
const STATIC_BASE = `http://127.0.0.1:${STATIC_PORT}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";
// backend 根（cos:cors CLI 所在工程；merge 后 SRC_GALLERY_DIR=apps/gallery → ../backend）
const REPO_BACKEND_DIR = path.resolve(SRC_GALLERY_DIR, "..", "backend");
const COS_CORS_CLI = path.join(REPO_BACKEND_DIR, "src", "cli", "setup-cos-cors.ts");
// 惯例（knowledge/testing.md 2026-06-17）：spawnSync 跑 .ts CLI 走 node + tsx 模块入口，不依赖 .bin/tsx shell wrapper。
// 此处用 tsx dist/cli.mjs 绝对路径（等价 `node --import tsx`，且允许 cwd 指向空目录以屏蔽 backend/.env 的 dotenv 注入）。
const TSX_CLI = path.join(REPO_BACKEND_DIR, "node_modules", "tsx", "dist", "cli.mjs");

const WECHAT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003133) NetType/WIFI Language/zh_CN";
const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1";

let serverProc: ChildProcess | null = null;
let manifestPath: string;
let manifest: {
  days: Array<{
    pickDate: string;
    wallpaperLandscape: string | null;
    wallpaperPortrait: string | null;
    photos: Array<{ photoId: string; rank: number; original: string }>;
  }>;
  videos: Array<{ themeKey: string; mp4: string }>;
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
  // 缺直链变体（场景11 前置）：独立目录，默认 fixture 不受影响
  const fx = generateFixture({ missingLinks: true });
  manifestPath = fx.manifestPath;
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  fs.copyFileSync(manifestPath, path.join(GALLERY_DIR, "manifest.json"));
  for (const sub of ["photos", "wallpapers", "videos"]) {
    const src = path.join(fx.manifestDir, sub);
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
// DOM / 交互探针（与前两个红队文件同构）
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
  opts: { share: "resolve" | "abort" | "noshare"; mobile: boolean; ua: string },
): Promise<ProbeHandles> {
  const ctx = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    hasTouch: opts.mobile,
    isMobile: opts.mobile,
    userAgent: opts.ua,
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
  toastVisible: boolean;
  guideVisible: boolean;
  unitCount: number;
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
    return {
      btnExists: !!btn,
      btnVisible: isVisible(btn),
      btnDisabled: btn
        ? btn.hasAttribute("disabled") ||
          (btn instanceof HTMLButtonElement && btn.disabled) ||
          btn.getAttribute("aria-disabled") === "true"
        : null,
      btnState: btn ? btn.getAttribute("data-download-state") : null,
      toastVisible: isVisible(toast),
      guideVisible: isVisible(guide),
      unitCount: document.querySelectorAll("[data-stream-unit]").length,
    };
  }, btnSelector);
}

async function countInPage(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
}

// ============================================================================
// 场景 11：manifest 条目缺资源直链时不渲染死链下载控件
// ============================================================================
describe("[场景11] 缺直链条目不渲染死链下载控件", () => {
  it("P1-P4：缺 mp4 视频 / 缺横版壁纸 / original 空串照片均无下载控件，正常条目不受影响", async ({
    browser,
  }) => {
    const { ctx, page, pageErrors, close } = await openProbePage(browser, {
      share: "resolve",
      mobile: true,
      ua: IOS_SAFARI_UA,
    });
    try {
      const emptyVideo = manifest.videos.find((v) => v.mp4 === "");
      expect(emptyVideo, "fixture 必含 mp4 空串视频").toBeTruthy();
      const rank1 = manifest.days[0]!.photos.find((p) => p.rank === 1)!;
      const rank20 = manifest.days[0]!.photos.find((p) => p.rank === 20)!;
      expect(rank20.original, "fixture rank20 必为 original 空串变体").toBe("");

      await page.goto(`${STATIC_BASE}/#/`);
      await page.waitForSelector(
        `[data-stream-unit][data-unit-type="photo"][data-day-index="0"][data-photo-rank="1"]`,
        { timeout: 10000 },
      );
      // 等流挂载稳定（视频/壁纸单元增量挂载）
      await page.waitForTimeout(1500);

      // 场景11.P1 [det-machine, negate] 缺 mp4 视频卡不渲染可点下载控件
      const emptyVideoBtnCount = await countInPage(
        page,
        `[data-stream-unit][data-unit-type="video"][data-video-id="${emptyVideo!.themeKey}"] [data-role="video-download"]`,
      );
      await writeArtifact(
        "场景11.P1",
        JSON.stringify({ themeKey: emptyVideo!.themeKey, emptyVideoBtnCount }),
      );
      expect(emptyVideoBtnCount, "mp4 空串的视频卡不得渲染下载控件").toBe(0);

      // 场景11.P2 [det-machine] 缺横版直链 → 横版入口不存在或禁用（visible == false || disabled == true）
      // 只看今日（day-index=0）的壁纸卡；昨日壁纸直链齐全，不得计入
      const cardSel = '[data-stream-unit][data-role="wallpaper-card"][data-day-index="0"]';
      const portraitCount = await countInPage(
        page,
        `${cardSel} [data-role="wallpaper-download-portrait"]`,
      );
      const landscapeCount = await countInPage(
        page,
        `${cardSel} [data-role="wallpaper-download-landscape"]`,
      );
      let landscapeDisabled = false;
      if (landscapeCount > 0) {
        const ui = await page.evaluate(() => {
          const b = document.querySelector(
            '[data-stream-unit][data-role="wallpaper-card"][data-day-index="0"] [data-role="wallpaper-download-landscape"]',
          );
          return b
            ? b.hasAttribute("disabled") ||
                (b instanceof HTMLButtonElement && b.disabled) ||
                b.getAttribute("aria-disabled") === "true"
            : false;
        });
        landscapeDisabled = ui;
      }
      await writeArtifact(
        "场景11.P2",
        JSON.stringify({ portraitCount, landscapeCount, landscapeDisabled }),
      );
      expect(portraitCount, "竖版直链非空 → 竖版下载入口必须存在").toBeGreaterThanOrEqual(1);
      expect(
        landscapeCount === 0 || landscapeDisabled,
        "横版直链空串 → 横版入口必须不存在或为禁用态",
      ).toBe(true);

      // 场景11.P3 [det-machine] 正常条目下载控件可用 + 无未捕获 JS 错误
      const uiRank1 = await readUiState(
        page,
        `[data-stream-unit][data-unit-type="photo"][data-day-index="0"][data-photo-rank="1"] [data-role="photo-download"]`,
      );
      await writeArtifact(
        "场景11.P3",
        JSON.stringify({ rank1Disabled: uiRank1.btnDisabled, pageErrors }),
      );
      expect(uiRank1.btnExists, "正常照片卡必须渲染下载控件").toBe(true);
      expect(uiRank1.btnDisabled, "正常条目下载控件必须可用").toBe(false);
      expect(pageErrors, "缺直链 fixture 渲染不得产生未捕获 JS 异常").toHaveLength(0);

      // 场景11.P4 [det-machine, negate] original 空串照片卡无下载控件；正常照片卡有
      const emptyCardBtnCount = await countInPage(
        page,
        `[data-stream-unit][data-unit-type="photo"][data-photo-id="${rank20.photoId}"] [data-role="photo-download"]`,
      );
      const normalCardBtnCount = await countInPage(
        page,
        `[data-stream-unit][data-unit-type="photo"][data-photo-id="${rank1.photoId}"] [data-role="photo-download"]`,
      );
      await writeArtifact(
        "场景11.P4",
        JSON.stringify({ rank20Id: rank20.photoId, emptyCardBtnCount, normalCardBtnCount }),
      );
      expect(emptyCardBtnCount, "original 空串的照片卡不得渲染下载控件").toBe(0);
      expect(normalCardBtnCount, "正常照片卡不受影响，必须有下载控件").toBe(1);
    } finally {
      await close();
    }
  });
});

// ============================================================================
// 场景 W1 / W2：微信内置浏览器引导遮罩
// ============================================================================
describe("[场景W1/W2] 微信内置浏览器引导遮罩", () => {
  it("W1+W2：微信 UA 点下载 → 弹遮罩且零副作用；关闭后遮罩隐藏可继续浏览", async ({ browser }) => {
    // share stub 保持可用（resolve 态）：验证 isWeChat 门控优先于分享能力探测
    const { ctx, page, downloads, close } = await openProbePage(browser, {
      share: "resolve",
      mobile: true,
      ua: WECHAT_UA,
    });
    try {
      await page.goto(`${STATIC_BASE}/#/`);
      const btn = page.locator(
        '[data-stream-unit][data-unit-type="photo"][data-day-index="0"][data-photo-rank="1"] [data-role="photo-download"]',
      );
      await btn.waitFor({ state: "visible", timeout: 10000 });

      await btn.click();
      // 遮罩可能带淡入过渡（隐藏靠 visibility/opacity），必须等「真正可见」
      await page.waitForFunction(
        () => {
          const g = document.querySelector('[data-role="wechat-guide"]');
          if (!g) return false;
          const r = g.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const s = window.getComputedStyle(g);
          return s.display !== "none" && s.visibility === "visible" && Number(s.opacity) > 0;
        },
        undefined,
        { timeout: 5000 },
      );

      const ui = await readUiState(
        page,
        '[data-stream-unit][data-unit-type="photo"][data-day-index="0"][data-photo-rank="1"] [data-role="photo-download"]',
      );
      const shareCalls = await page.evaluate(() => window.__shareCalls);
      const openCalls = await page.evaluate(() => window.__openCalls);

      // 场景W1 [det-machine] guideVisible == true && (share + download + open) == 0
      const payload = {
        guideVisible: ui.guideVisible,
        shareCalls: shareCalls.length,
        downloadEvents: downloads.length,
        openCalls: openCalls.length,
      };
      await writeArtifact("场景W1", JSON.stringify(payload));
      expect(ui.guideVisible, "微信环境点下载必须弹出引导遮罩").toBe(true);
      expect(
        shareCalls.length + downloads.length + openCalls.length,
        "微信环境点下载不得触发任何下载/分享/新开直链",
      ).toBe(0);

      // ---- W2 同一会话内继续：点关闭 → 遮罩隐藏 + 页面可继续浏览 ----
      const closeBtn = page.locator('[data-role="wechat-guide-close"]');
      await closeBtn.waitFor({ state: "visible", timeout: 5000 });
      await closeBtn.click();
      await page.waitForFunction(
        () => {
          const g = document.querySelector('[data-role="wechat-guide"]');
          if (!g) return true;
          const r = g.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return true;
          const s = window.getComputedStyle(g);
          return s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0;
        },
        undefined,
        { timeout: 5000 },
      );

      const uiAfter = await readUiState(
        page,
        '[data-stream-unit][data-unit-type="photo"][data-day-index="0"][data-photo-rank="1"] [data-role="photo-download"]',
      );
      // 场景W2 [det-machine] guideVisible == false && pageErrors == 0（页面可继续浏览）
      await writeArtifact(
        "场景W2",
        JSON.stringify({ guideVisible: uiAfter.guideVisible, unitCount: uiAfter.unitCount }),
      );
      expect(uiAfter.guideVisible, "点关闭后遮罩必须隐藏").toBe(false);
      expect(uiAfter.unitCount, "关闭遮罩后流单元仍在，页面可继续浏览").toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});

// ============================================================================
// 场景 C3 / C4：cos:cors CLI 契约（node-script 内联，spawnSync + tsx）
// ============================================================================

/** 全部 COS 凭据相关 env 置空（凭据缺失模拟；TENCENTCLOUD_* 与 COS_* 双命名空间） */
function envWithoutCredentials(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TENCENTCLOUD_SECRET_ID: "",
    TENCENTCLOUD_SECRET_KEY: "",
    TENCENTCLOUD_APPID: "",
    TENCENTCLOUD_REGION: "",
    COS_SECRET_ID: "",
    COS_SECRET_KEY: "",
    COS_BUCKET: "",
    COS_REGION: "",
  };
}

describe("[场景C3/C4] cos:cors CLI 契约", () => {
  it("C3：无参默认 dry-run——打印完整规则 JSON 且退出 0", () => {
    test.setTimeout(120_000);
    expect(
      fs.existsSync(COS_CORS_CLI),
      `CLI 必须存在: ${COS_CORS_CLI}（蓝队任务6：apps/backend/src/cli/setup-cos-cors.ts + script cos:cors）`,
    ).toBe(true);
    expect(fs.existsSync(TSX_CLI), `tsx 入口必须存在: ${TSX_CLI}`).toBe(true);

    // dry-run 不触网：注入占位凭据保证「凭据在位」前提成立（dotenv 不覆盖已有 env）
    const res = spawnSync(process.execPath, [TSX_CLI, COS_CORS_CLI], {
      cwd: REPO_BACKEND_DIR,
      env: {
        ...process.env,
        TENCENTCLOUD_SECRET_ID: "redteam-dryrun-dummy-id",
        TENCENTCLOUD_SECRET_KEY: "redteam-dryrun-dummy-key",
        TENCENTCLOUD_APPID: "1111111111",
        TENCENTCLOUD_REGION: "ap-shanghai",
      },
      encoding: "utf8",
      timeout: 100_000,
    });

    // 场景C3 [det-machine] exit == 0 && stdout contains gallery.stringzhao.life && MaxAgeSeconds
    const payload = {
      exit: res.status,
      stdout: res.stdout ?? "",
      stderr: (res.stderr ?? "").slice(0, 2000),
    };
    expect(res.status, `dry-run 必须退出 0（stderr: ${payload.stderr}）`).toBe(0);
    expect(res.stdout, "dry-run stdout 必须含目标 origin").toContain("gallery.stringzhao.life");
    expect(res.stdout, "dry-run stdout 必须含 MaxAgeSeconds").toContain("MaxAgeSeconds");
    expect(res.stdout, "dry-run stdout 必须声明 GET 方法").toContain('"GET"');
    expect(res.stdout, "dry-run stdout 必须声明 HEAD 方法").toContain('"HEAD"');

    // stdout 打印「将写入的完整规则 JSON 数组」——可解析且含目标规则。
    // stdout 可能含 [dry-run] 等前缀行，且规则内含嵌套数组：从最后一个 "[" 向前逐位置
    // 尝试 JSON.parse（尾随内容会使嵌套数组解析失败，从而定位到最外层规则数组）。
    let rules: Array<Record<string, unknown>> | null = null;
    // stdout 前后有 [dry-run] 等说明行（含方括号），且规则内含嵌套数组：
    // 对每个 "[" 起点尝试截至各个 "]" 终点的子串解析，取第一个成功的 JSON 数组
    const starts: number[] = [];
    let si = res.stdout.lastIndexOf("[");
    while (si >= 0) {
      starts.push(si);
      si = res.stdout.lastIndexOf("[", si - 1);
    }
    const ends: number[] = [];
    let ei = res.stdout.lastIndexOf("]");
    while (ei >= 0) {
      ends.push(ei);
      ei = res.stdout.lastIndexOf("]", ei - 1);
    }
    expect(starts.length, "stdout 必须含 JSON 规则数组").toBeGreaterThanOrEqual(1);
    expect(ends.length, "stdout 必须含 JSON 规则数组").toBeGreaterThanOrEqual(1);
    outer: for (const start of starts) {
      for (const end of ends) {
        if (end <= start) continue;
        try {
          const parsed = JSON.parse(res.stdout.slice(start, end + 1)) as unknown;
          // 只接受「对象数组」（规则表）；内层字符串数组如 ["*"] 必须拒绝
          if (
            Array.isArray(parsed) &&
            parsed.length > 0 &&
            typeof parsed[0] === "object" &&
            parsed[0] !== null
          ) {
            rules = parsed as Array<Record<string, unknown>>;
            break outer;
          }
        } catch {
          // 尝试下一候选
        }
      }
    }
    expect(rules, "stdout 必须含可解析的 JSON 规则数组").toBeTruthy();
    const mine = rules!.find((r) =>
      JSON.stringify(r.AllowedOrigin ?? []).includes("gallery.stringzhao.life"),
    );
    expect(mine, "规则表中必须含 gallery origin 规则").toBeTruthy();
    expect(mine!.AllowedMethod).toEqual(["GET", "HEAD"]);
    expect(mine!.AllowedHeader).toEqual(["*"]);
    expect(mine!.MaxAgeSeconds).toBe(600);
    void writeArtifact("场景C3", JSON.stringify(payload));
  });

  it("C4：退出码契约——凭据缺失→1；伪造无效凭据→2", () => {
    test.setTimeout(300_000);
    expect(fs.existsSync(COS_CORS_CLI), `CLI 必须存在: ${COS_CORS_CLI}`).toBe(true);
    expect(fs.existsSync(TSX_CLI), `tsx 入口必须存在: ${TSX_CLI}`).toBe(true);

    // (a) 凭据缺失 → exit 1。
    // cwd 指向空临时目录：dotenv（import "dotenv/config"）按 cwd 解析 .env，
    // 空 cwd 无 .env → backend/.env 的真实凭据不会注入 → config.cos 保持默认空值。
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "cos-cors-nocred-"));
    const resMissing = spawnSync(process.execPath, [TSX_CLI, COS_CORS_CLI], {
      cwd: emptyDir,
      env: envWithoutCredentials(),
      encoding: "utf8",
      timeout: 120_000,
    });

    // (b) 伪造无效凭据 → exit 2（--yes 才走 COS API 路径；无效签名必被 COS 拒绝，无写副作用）。
    const resInvalid = spawnSync(process.execPath, [TSX_CLI, COS_CORS_CLI, "--yes"], {
      cwd: REPO_BACKEND_DIR,
      env: {
        ...process.env,
        TENCENTCLOUD_SECRET_ID: "REDTEAM-INVALID-SECRET-ID",
        TENCENTCLOUD_SECRET_KEY: "REDTEAM-INVALID-SECRET-KEY",
        TENCENTCLOUD_APPID: "1234567890",
        TENCENTCLOUD_REGION: "ap-shanghai",
      },
      encoding: "utf8",
      timeout: 280_000,
    });

    const payload = {
      missingExit: resMissing.status,
      missingStderr: (resMissing.stderr ?? "").slice(0, 1000),
      invalidExit: resInvalid.status,
      invalidStderr: (resInvalid.stderr ?? "").slice(0, 1000),
    };
    // 场景C4 [det-machine] exit == 1（凭据缺失）&& exit == 2（无效凭据）
    expect(
      resMissing.status,
      `凭据缺失必须退出 1（实际 ${resMissing.status}，stderr: ${payload.missingStderr}）`,
    ).toBe(1);
    expect(
      resInvalid.status,
      `伪造无效凭据必须退出 2（实际 ${resInvalid.status}，stderr: ${payload.invalidStderr}）`,
    ).toBe(2);

    void writeArtifact("场景C4", JSON.stringify(payload));
  });
});

// ============================================================================
// PREDICATE-DEFERRED-QA：real-process 谓词（真实 COS 桶 / 线上 manifest，QA Tier 1.5 求值）
// ============================================================================

// PREDICATE-DEFERRED-QA: 场景C1 [real-process] driver: curl:cos-direct-url
//   前置：QA 真实执行一次 `pnpm --filter @relight/backend cos:cors --yes`（外部副作用：修改 COS 桶 CORS，可逆低风险）
//   $ curl -sI -H "Origin: https://gallery.stringzhao.life" <任一 COS 直链，如 manifest 中 photo.original 的绝对 URL>
//   assert: 响应头含 access-control-allow-origin: https://gallery.stringzhao.life
//   artifact: /tmp/autopilot-artifacts/场景C1.out

// PREDICATE-DEFERRED-QA: 场景C2 [det-machine→real] driver: node-script:cos-cors-idempotent
//   前置：C1 的 --yes 已真实执行过一次（桶内已存在目标 origin 规则）
//   $ pnpm --filter @relight/backend cos:cors --yes   （第二次幂等重跑）
//   assert: exit == 0 && stdout contains "skip"（[skip] origin exists: https://gallery.stringzhao.life）
//           且 getBucketCors 回读规则数不增加（无重复规则）
//   artifact: /tmp/autopilot-artifacts/场景C2.out
//   说明：依赖真实 COS 桶状态 + 真实凭据，本地/CI 无凭据环境无法硬断言，交 QA Tier 1.5。

// PREDICATE-DEFERRED-QA: 场景12.P1 [real-process] driver: curl:manifest-photo-urls
//   $ MANIFEST=$(curl -s https://gallery.stringzhao.life/manifest.json)；取任一 days[].photos[].original COS 绝对直链
//   $ curl -sI <photo 直链>
//   assert: status == 200 && content-type contains "image/" && content-length > 0
//   artifact: /tmp/autopilot-artifacts/场景12.P1.out

// PREDICATE-DEFERRED-QA: 场景12.P2 [real-process] driver: curl:manifest-wallpaper-urls
//   $ 取任一 days[].wallpaperPortrait / wallpaperLandscape COS 直链
//   $ curl -sI <wallpaper 直链>
//   assert: status == 200 && content-type contains "image/" && content-length > 0
//   artifact: /tmp/autopilot-artifacts/场景12.P2.out

// PREDICATE-DEFERRED-QA: 场景12.P3 [real-process] driver: curl:manifest-video-urls
//   $ 取任一 videos[].mp4 COS 直链
//   $ curl -sI <video 直链>
//   assert: status == 200 && content-type contains "video/mp4" && content-length > 0
//   artifact: /tmp/autopilot-artifacts/场景12.P3.out

// PREDICATE-DEFERRED-QA: 场景12.P4 [real-process] driver: curl:manifest-url
//   $ curl -s -o /tmp/manifest-live.json -w "%{http_code}" https://gallery.stringzhao.life/manifest.json
//   assert: status == 200 && 解析 JSON 后 photoCount >= 1 && videoCount >= 1 && wallpaperCount >= 1
//           （photoCount = days[].photos 非空条目；videoCount = videos 非空 mp4 条目；wallpaperCount = days 含非空 wallpaperPortrait 条目）
//   artifact: /tmp/autopilot-artifacts/场景12.P4.out
//   说明：场景4.P2（线上视频直链 HEAD）同属 QA Tier 1.5，见 gallery-download-states 文件尾 QA 块。

/**
 * 验收测试（红队 E2E）：公共画廊 h5 横竖屏切换「朝向翻转重锚」（契约 OR-C1 ~ OR-C4 / 谓词 OR.PM1 ~ OR.PM5）
 *
 * 需求真相源：state.md《公共画廊 h5 页面，横竖屏切换后当前展示的页面变掉了》
 *   §Context 根因：.stream { height:100dvh; scroll-snap-type:y mandatory; scroll-behavior:smooth }
 *   + [data-stream-unit] { height:100dvh } 旋转时单元高度突变（844px↔390px），滚动容器 scrollTop
 *   按绝对像素保留 + mandatory re-snap 吸附到错误单元；随后 hudIO 把错误单元当 best、
 *   scheduleUrlSync（300ms debounce）把错误深链固化进 URL。
 *   §方案：跟踪用户当前阅读单元（activeUnit）→ window resize 检测朝向翻转（innerHeight>=innerWidth
 *   状态翻转才触发，同朝向小幅 resize 不触发）→ 布局稳定后瞬时（非 smooth）滚回同一单元 →
 *   翻转窗口内 programmatic 闸门（约 900ms）阻止 URL 被过渡态改写 → 视频全屏期间
 *   （document.fullscreenElement 非空）不重锚 → 用户手势进行中不重锚。
 *
 * 行为契约（逐字，断言依据）：
 *   - OR-C1 朝向翻转（portrait↔landscape）settle（≥800ms）后，视口中心命中的 [data-stream-unit]
 *     与翻转前为同一单元
 *   - OR-C2 重锚 settle 后 URL hash 与翻转前一致（不被过渡态改写）
 *   - OR-C3 非朝向翻转的 resize（同朝向高度 ±10% 内）不触发单元级滚动跳变
 *   - OR-C4 视频全屏期间（document.fullscreenElement 非空）翻转不执行重锚
 *
 * 谓词覆盖（本文件覆盖 OR.PM1 ~ OR.PM5）：
 *   - OR.PM1 竖→横翻转保持当前单元      → kill：重锚 no-op（scrollTop 绝对像素保留 + re-snap 漂移到邻单元）
 *   - OR.PM2 横→竖转回仍保持           → kill：只做单向/一次性重锚、回翻 no-op
 *   - OR.PM3 翻转后 URL 不被过渡态改写  → kill：programmatic 闸门缺失、重锚后 URL 仍写过渡态深链
 *   - OR.PM4 同朝向小幅 resize 不重锚   → kill：任意 resize 一律滚动的误触发、滚动位置被重置到顶
 *   - OR.PM5 全量零回归               → 由 QA 阶段全量执行：本文件与既有六套（gallery-stream /
 *     gallery-download-core / gallery-download-edge-wechat / gallery-download-states /
 *     gallery-video-errors / gallery-video-fullscreen）共存于同一 playwright run —— 本文件用
 *     独立端口（8771）+ 独立临时目录，零全局副作用（不写 apps/gallery/、不改三件套），
 *     playwright.config.ts workers=1 + fullyParallel=false 串行下与既有套件互不干扰。
 *   - 附加：OR-C4 视频全屏期间翻转不执行重锚（契约清单内、预注册谓词清单外的补充覆盖）
 *   - 附加：OR.S1 守卫链稳健性（2026-08-31 qa-reviewer 谓词充分性缺口 #2/#4/#5 闭合：
 *     错误态翻转零未捕获异常 + retry 重入防重复注册 + 重挂载后翻转仍工作）
 *
 * 驱动方式：page.setViewportSize 翻转宽高比（Chromium 自然翻转 orientation MQ 并派发 window resize，
 * 与真机旋转驱动同一条 JS 代码路径）。视口中心命中统一用
 * document.elementFromPoint(innerWidth/2, innerHeight/2).closest('[data-stream-unit]')；
 * OR-C4 因顶层全屏元素会遮蔽 hit-test，改用等价的几何中心判定（非全屏时两种判定一致性有硬断言背书）。
 * 断言全几何化（dataset 指纹 / hash / innerWidth·innerHeight），不用像素截图。
 *
 * 红队铁律：本文件仅依据设计文档 + DOM 契约属性 + 既有验收套件约定编写，不读蓝队 app.js。
 * 强断言铁律：每个 it 含 expect.* 硬断言，失败必挂；无 skip / warn-soft-pass / try-catch-skip。
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
// 文件专属端口/env（避开既有 8765/8766/8767/8768/8769；merge 后落 apps/gallery/__tests__）
const STATIC_PORT = Number(process.env.GALLERY_ORIENTATION_PORT ?? 8771);
// 隔离临时目录（不污染开发目录 apps/gallery/，跑完整体删除）
const GALLERY_DIR =
  process.env.GALLERY_ORIENTATION_DIR ??
  path.join(os.tmpdir(), `relight-gallery-orientation-${STATIC_PORT}`);
// 暂存区运行由 GALLERY_SRC_DIR 指向真实 apps/gallery；merge 后 __dirname/../ 即 apps/gallery
const SRC_GALLERY_DIR = process.env.GALLERY_SRC_DIR ?? path.resolve(__dirname, "../");
// 显式 127.0.0.1（python http.server 本机 dual-stack 绑定会进入半死 CLOSED 态，SYN 全丢）
const STATIC_BASE = `http://127.0.0.1:${STATIC_PORT}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

// 朝向翻转 settle 预算（谓词字面「等 800ms」即 ≥800ms；取 1000ms 只放宽等待给 100dvh 重排 +
// 瞬时重锚留余量，所有断言值不弱化）
const FLIP_SETTLE_MS = 1000;
// URL 观察预算 = 翻转 settle 800ms + programmatic 闸门 ~900ms + 滚动静止 debounce 300ms + 余量
// CONTRACT_AMBIGUOUS: OR.PM3 只说「翻转 settle 后」，未定观察时刻；若恰在 800ms（闸门 900ms 窗口内）
// 断言，闸门缺失的缺陷会被窗口本身掩盖成假绿 —— 故把观察点推到闸门 + debounce 全部越界之后，
// 使「过渡态被固化进 URL」真正可被观测（断言值不弱化：仍是「settle 后 hash 与翻转前逐字一致」）。
const URL_GATE_SETTLE_MS = FLIP_SETTLE_MS + 1200;
// scrollIntoView 后 scroll-snap 吸附 settle（沿用既有套件 700ms 惯例）
const SNAP_SETTLE_MS = 700;
// 滚动静止 → URL 同步 debounce（既有契约 300ms）+ 余量
const URL_DEBOUNCE_MS = 500;

// 竖屏 / 横屏（iPhone 12 竖屏 390×844 ↔ 横屏 844×390，设计 Context 给出的尺寸对）
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const MOBILE_VIEWPORT = PORTRAIT;

/**
 * 流单元指纹：unitType + dayDate + photoRank/videoId 组合（谓词 OR.PM1 observe 契约原文）。
 * photoId 不参与指纹比对字符串（指纹组合以谓词原文为准），仅作 OR.PM4「同一单元节点」的强证据。
 */
type UnitFingerprint = {
  unitType: string | null;
  dayDate: string | null;
  photoRank: string | null;
  videoId: string | null;
  photoId: string | null;
};

let serverProc: ChildProcess | null = null;
let manifestPath: string;
let todayDate = "";
let videoThemeKey = "";

// ============================================================================
// harness：隔离目录 + fixture manifest + python3 静态 server（沿用既有红队套件约定）
// ============================================================================
beforeAll(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  // 拷贝三件套 + fonts 到隔离临时目录（只读开发目录，不污染）
  fs.rmSync(GALLERY_DIR, { recursive: true, force: true });
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
  for (const f of ["index.html", "app.css", "app.js"]) {
    fs.copyFileSync(path.join(SRC_GALLERY_DIR, f), path.join(GALLERY_DIR, f));
  }
  fs.cpSync(path.join(SRC_GALLERY_DIR, "fonts"), path.join(GALLERY_DIR, "fonts"), {
    recursive: true,
  });

  // fixture：2 天以上 + 1 视频 + 今日 20 张（今日无 date-separator 置顶，首单元 = 今日 rank=1 photo）
  const fx = generateFixture();
  manifestPath = fx.manifestPath;
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  todayDate = manifest.days[0].pickDate;
  videoThemeKey = manifest.videos[0].themeKey;
  expect(todayDate, "fixture 契约：days[0] 应是今日").toBeTruthy();
  expect(videoThemeKey, "fixture 契约：应至少有 1 条视频").toBeTruthy();

  fs.copyFileSync(manifestPath, path.join(GALLERY_DIR, "manifest.json"));
  for (const sub of ["photos", "wallpapers", "videos"]) {
    const src = path.join(fx.manifestDir, sub);
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
    serverProc?.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Serving HTTP")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  // 注：@playwright/test 1.59.1 的 beforeAll 类型已无 (fn, timeout) 重载，hook 超时走 config timeout
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

beforeEach(async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
});

// ============================================================================
// 共享步骤 / 页面侧谓词
// ============================================================================
async function writeArtifact(id: string, content: string): Promise<void> {
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

/** 指纹规范形（含 "null" 哨兵，防止两侧同为空导致的假绿） */
function fingerprintOf(u: UnitFingerprint | null): string {
  if (!u) return "<no-unit>";
  return [u.unitType, u.dayDate, u.photoRank, u.videoId].map((v) => v ?? "∅").join("|");
}

/** 载入流，硬等流单元挂载（今日流第 3 个单元必须已存在，后续 scrollIntoView 才有意义） */
async function gotoStream(page: Page): Promise<void> {
  await page.goto(`${STATIC_BASE}/#/`);
  await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
  await page.waitForFunction(
    () => document.querySelectorAll("[data-stream-unit]").length >= 3,
    undefined,
    { timeout: 8000, polling: 100 },
  );
}

/** 读取流内第 index 个（0-based）[data-stream-unit] 的指纹 + 几何信息 */
async function getUnitAt(page: Page, index: number): Promise<UnitFingerprint | null> {
  return page.evaluate((i: number) => {
    const el = document.querySelectorAll("[data-stream-unit]")[i];
    if (!el) return null;
    return {
      unitType: el.getAttribute("data-unit-type"),
      dayDate: el.getAttribute("data-day-date"),
      photoRank: el.getAttribute("data-photo-rank"),
      videoId: el.getAttribute("data-video-id"),
      photoId: el.getAttribute("data-photo-id"),
    };
  }, index);
}

/** 视口中心命中单元（谓词 observe 原文：elementFromPoint(innerWidth/2, innerHeight/2).closest） */
async function observeCenterUnit(page: Page): Promise<{
  innerW: number;
  innerH: number;
  unit: UnitFingerprint | null;
  unitTop: number | null;
  unitHeight: number | null;
}> {
  return page.evaluate(() => {
    const pointEl = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const unitEl = pointEl ? pointEl.closest("[data-stream-unit]") : null;
    const rect = unitEl ? unitEl.getBoundingClientRect() : null;
    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      unit: unitEl
        ? {
            unitType: unitEl.getAttribute("data-unit-type"),
            dayDate: unitEl.getAttribute("data-day-date"),
            photoRank: unitEl.getAttribute("data-photo-rank"),
            videoId: unitEl.getAttribute("data-video-id"),
            photoId: unitEl.getAttribute("data-photo-id"),
          }
        : null,
      unitTop: rect ? rect.top : null,
      unitHeight: rect ? rect.height : null,
    };
  });
}

/**
 * 几何中心命中单元：滚动口垂直中点落在哪个单元的盒子内。
 * 与 elementFromPoint 等价（单元铺满视口时两者命中同一单元），但不受顶层全屏元素遮蔽 hit-test
 * 的影响 —— OR-C4 全屏期专用；非全屏下两者一致性由 OR-C4 用例内硬断言背书。
 */
async function observeGeometricCenterUnit(page: Page): Promise<{
  innerW: number;
  innerH: number;
  scrollTop: number | null;
  scrollPortH: number | null;
  index: number;
  unit: UnitFingerprint | null;
}> {
  return page.evaluate(() => {
    const stream = document.getElementById("stream");
    const units = Array.from(document.querySelectorAll("[data-stream-unit]"));
    const empty = {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      scrollTop: null as number | null,
      scrollPortH: null as number | null,
      index: -1,
      unit: null as UnitFingerprint | null,
    };
    if (!stream || units.length === 0) return empty;
    const srect = stream.getBoundingClientRect();
    const centerY = srect.top + stream.clientHeight / 2;
    const idx = units.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return centerY >= r.top && centerY < r.bottom;
    });
    const hit = idx >= 0 ? units[idx] : null;
    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      scrollTop: stream.scrollTop,
      scrollPortH: stream.clientHeight,
      index: idx,
      unit: hit
        ? {
            unitType: hit.getAttribute("data-unit-type"),
            dayDate: hit.getAttribute("data-day-date"),
            photoRank: hit.getAttribute("data-photo-rank"),
            videoId: hit.getAttribute("data-video-id"),
            photoId: hit.getAttribute("data-photo-id"),
          }
        : null,
    };
  });
}

/** scrollIntoView 定位到流内第 index 个单元（block:start，命中 scroll-snap-align:start） */
async function scrollUnitIntoView(page: Page, index: number): Promise<void> {
  await page.evaluate((i: number) => {
    const el = document.querySelectorAll("[data-stream-unit]")[i];
    el?.scrollIntoView({ behavior: "instant", block: "start" });
  }, index);
  await page.waitForTimeout(SNAP_SETTLE_MS);
}

async function readHash(page: Page): Promise<string> {
  return page.evaluate(() => location.hash);
}

/** 断言当前视口中心命中「流内第 index 个单元」，返回该单元指纹（供翻转前后比对） */
async function anchorAt(page: Page, index: number): Promise<string> {
  const target = await getUnitAt(page, index);
  expect(target, `流内必须存在第 ${index + 1} 个 [data-stream-unit]`).not.toBeNull();
  const targetFp = fingerprintOf(target);
  expect(targetFp, "指纹不能是空组合（缺 data-* 契约属性会退化成全等假绿）").not.toContain("∅|∅|∅");
  await scrollUnitIntoView(page, index);

  const before = await observeCenterUnit(page);
  expect(before.unit, "翻转前视口中心必须命中某个流单元").not.toBeNull();
  expect(
    fingerprintOf(before.unit),
    `翻转前中心指纹应 == 定位目标指纹 ${targetFp}（scrollIntoView 必须真实落位）`,
  ).toBe(targetFp);
  expect(
    before.unitHeight ?? 0,
    "翻转前目标单元应铺满竖屏视口（height ≈ innerHeight）",
  ).toBeGreaterThan(before.innerH * 0.95);
  return targetFp;
}

// ============================================================================
// OR.PM1 [det-playwright][OR-C1] 竖→横翻转保持当前单元
// kill：重锚 no-op（scrollTop 绝对像素保留 1688 → 横屏漂移到第 4/5 个单元）+
//       「检测/重锚整段缺失」+ 「viewport 未真翻转导致的全等假绿」（驱动自检硬断言）
// ============================================================================
describe("[OR.PM1][OR-C1] 竖→横翻转保持当前单元", () => {
  it("竖屏定位第 3 个流单元 → setViewportSize(844,390) → settle ≥800ms → 视口中心命中同一单元", async ({
    page,
  }) => {
    await gotoStream(page);

    // 定位：流内第 3 个 [data-stream-unit]（fixture 契约：今日无 date-separator 置顶，
    // 流内第 3 个单元 = 今日 rank=3 photo；今日 20 张 ≥ 3，目标稳定）
    const target = await getUnitAt(page, 2);
    expect(target, "流内必须存在第 3 个 [data-stream-unit]").not.toBeNull();
    expect(target?.unitType, "fixture 契约：第 3 个单元应是 photo").toBe("photo");
    expect(
      target?.photoRank,
      "fixture 契约：流内第 3 个单元应为今日 rank=3（若蓝队挂载顺序变化请核对 fixture）",
    ).toBe("3");
    expect(target?.dayDate, "photo 单元 DOM 契约：必须带 data-day-date").toBe(todayDate);

    const targetFp = await anchorAt(page, 2);

    // —— 驱动：竖 → 横 ——
    await page.setViewportSize({ width: LANDSCAPE.width, height: LANDSCAPE.height });
    await page.waitForTimeout(FLIP_SETTLE_MS);

    const after = await observeCenterUnit(page);
    // 驱动自检：视口必须真的翻转了（否则下面的指纹全等是假绿）
    expect(after.innerW, "翻转后 innerWidth 应为 844").toBe(LANDSCAPE.width);
    expect(after.innerH, "翻转后 innerHeight 应为 390").toBe(LANDSCAPE.height);
    expect(after.unit, "翻转后视口中心必须命中某个流单元（不得落到流外空白）").not.toBeNull();
    expect(
      after.unitHeight ?? 0,
      "翻转后单元应铺满横屏视口（100dvh 重排必须已完成）",
    ).toBeGreaterThan(after.innerH * 0.95);

    // OR-C1 硬断言：settle 后中心命中单元与翻转前为同一单元
    expect(
      fingerprintOf(after.unit),
      `OR-C1: 竖→横 settle 后中心指纹 ${fingerprintOf(after.unit)} 应 == 翻转前 ${targetFp}`,
    ).toBe(targetFp);

    await writeArtifact("OR.PM1", JSON.stringify({ targetFp, after }));
  });
});

// ============================================================================
// OR.PM2 [det-playwright][OR-C1] 横→竖转回仍保持
// kill：只做单向/一次性重锚（第一次翻转后守卫失效）、回翻 no-op
// ============================================================================
describe("[OR.PM2][OR-C1] 横→竖转回仍保持", () => {
  it("竖→横→竖两次翻转 settle 后视口中心始终是同一单元", async ({ page }) => {
    await gotoStream(page);
    const targetFp = await anchorAt(page, 2);

    // 竖 → 横（前置：PM1 已证单向重锚成立；此处硬断言保证 PM2 不是从错误态出发）
    await page.setViewportSize({ width: LANDSCAPE.width, height: LANDSCAPE.height });
    await page.waitForTimeout(FLIP_SETTLE_MS);
    const mid = await observeCenterUnit(page);
    expect(mid.innerW).toBe(LANDSCAPE.width);
    expect(mid.innerH).toBe(LANDSCAPE.height);
    expect(
      fingerprintOf(mid.unit),
      "前置：竖→横后中心指纹应 == 初始指纹（否则 PM2 的回翻断言无意义）",
    ).toBe(targetFp);

    // 横 → 竖
    await page.setViewportSize({ width: PORTRAIT.width, height: PORTRAIT.height });
    await page.waitForTimeout(FLIP_SETTLE_MS);
    const back = await observeCenterUnit(page);
    expect(back.innerW, "回翻后 innerWidth 应为 390").toBe(PORTRAIT.width);
    expect(back.innerH, "回翻后 innerHeight 应为 844").toBe(PORTRAIT.height);
    expect(back.unit, "回翻后视口中心必须命中某个流单元").not.toBeNull();
    expect(
      fingerprintOf(back.unit),
      `OR-C1(PM2): 横→竖 settle 后中心指纹 ${fingerprintOf(back.unit)} 应 == 初始 ${targetFp}`,
    ).toBe(targetFp);

    await writeArtifact(
      "OR.PM2",
      JSON.stringify({ targetFp, mid: fingerprintOf(mid.unit), back: fingerprintOf(back.unit) }),
    );
  });
});

// ============================================================================
// OR.PM3 [det-playwright][OR-C2] 翻转后 URL 不被过渡态改写
// kill：programmatic 闸门缺失（过渡态深链被 replaceState 固化）、重锚后 URL 指向别的单元
// ============================================================================
describe("[OR.PM3][OR-C2] 翻转后 URL 不被过渡态改写", () => {
  it("翻转 settle（越过闸门 + debounce）后 location.hash 与翻转前逐字一致", async ({ page }) => {
    await gotoStream(page);

    // 先让翻转前 hash 稳定（既有契约 3：滚动静止后 URL hash 同步当前单元深链）
    await scrollUnitIntoView(page, 2);
    await page.waitForTimeout(URL_DEBOUNCE_MS);
    const hashBefore = await readHash(page);
    // 非空化前置：若翻转前 URL 联动本就缺失（hash 为空），比较会退化成 ''==='' 假绿 —— 先卡死
    expect(
      hashBefore,
      `翻转前 hash=${hashBefore} 应含 date=${todayDate}（既有 URL 联动契约）`,
    ).toContain(`date=${todayDate}`);
    expect(hashBefore, `翻转前 hash=${hashBefore} 应含 rank=3`).toContain("rank=3");

    // —— 驱动：竖 → 横，settle 越过 800ms + 闸门 ~900ms + debounce 300ms ——
    await page.setViewportSize({ width: LANDSCAPE.width, height: LANDSCAPE.height });
    await page.waitForTimeout(URL_GATE_SETTLE_MS);

    const hashAfter = await readHash(page);
    // OR-C2 硬断言：settle 后 hash 与翻转前逐字一致
    expect(
      hashAfter,
      `OR-C2: 翻转 settle 后 hash=${hashAfter} 应与翻转前 ${hashBefore} 逐字一致（不被过渡态改写）`,
    ).toBe(hashBefore);
    // 双保险：hash 仍指向翻转前那个单元（防「翻转被写成了另一条合法深链」的假绿）
    expect(hashAfter).toContain(`date=${todayDate}`);
    expect(hashAfter).toContain("rank=3");

    await writeArtifact("OR.PM3", JSON.stringify({ hashBefore, hashAfter }));
  });
});

// ============================================================================
// OR.PM4 [det-playwright][OR-C3] 同朝向小幅 resize 不重锚
// kill：任意 resize 一律滚动的误触发、滚动位置被重置（scrollTo(0) / snap 失效跳单元）
// ============================================================================
describe("[OR.PM4][OR-C3] 同朝向小幅 resize 不重锚", () => {
  it("390×844 → 390×860（同朝向 +1.9%）视口中心单元不跳变、hash 不改写", async ({ page }) => {
    await gotoStream(page);
    const targetFp = await anchorAt(page, 2);
    await page.waitForTimeout(URL_DEBOUNCE_MS);
    const hashBefore = await readHash(page);
    expect(hashBefore, `resize 前 hash=${hashBefore} 应含 date=${todayDate}`).toContain(
      `date=${todayDate}`,
    );

    // —— 驱动：同朝向小幅 resize（宽不变，高度 +16px = +1.9%，在 ±10% 契约带内）——
    await page.setViewportSize({ width: PORTRAIT.width, height: PORTRAIT.height + 16 });
    await page.waitForTimeout(FLIP_SETTLE_MS);

    const after = await observeCenterUnit(page);
    // 驱动自检：视口必须真的变高了、且仍是竖屏（innerHeight >= innerWidth 朝向状态未翻转）
    expect(after.innerW, "同朝向 resize 不应改变宽度").toBe(PORTRAIT.width);
    expect(after.innerH, "resize 后 innerHeight 应为 860").toBe(PORTRAIT.height + 16);
    expect(after.innerH >= after.innerW, "朝向状态应仍是 portrait").toBe(true);
    expect(after.unit, "resize 后视口中心必须命中某个流单元").not.toBeNull();

    // OR-C3 硬断言：无单元级滚动跳变
    expect(
      fingerprintOf(after.unit),
      `OR-C3: 同朝向小幅 resize 后中心指纹 ${fingerprintOf(after.unit)} 应 == resize 前 ${targetFp}`,
    ).toBe(targetFp);
    // 强证据：仍是同一个单元节点（photoId 逐字一致，而不是「恰好同型不同张」）
    expect(after.unit?.photoId, "中心单元 photoId 不应变化").toBe(
      (await getUnitAt(page, 2))?.photoId ?? null,
    );

    // 越过 debounce 后 URL 也不应被改写（防 resize 路径把过渡态写进 URL）
    await page.waitForTimeout(URL_DEBOUNCE_MS);
    expect(await readHash(page), "同朝向小幅 resize 不应改写 URL").toBe(hashBefore);

    await writeArtifact("OR.PM4", JSON.stringify({ targetFp, after: fingerprintOf(after.unit) }));
  });
});

// ============================================================================
// 附加：OR-C4 视频全屏期间（document.fullscreenElement 非空）翻转不执行重锚
// 预注册谓词清单（OR.PM1~PM5）外的契约补充覆盖；同文件内先证「无全屏时重锚对视频单元成立」，
// 排除「重锚整体缺失导致本用例假绿」的可能。
// CONTRACT_AMBIGUOUS: 「不执行重锚」的黑盒观测依赖设计 Context 根因 —— 全屏期间重锚被抑制时
//   scrollTop 按绝对像素保留 + re-snap 漂移到非视频单元；若 UA 采用「保元素重吸」语义则会假红。
//   为消除流尾 clamp 干扰，翻转方向选 横→竖（内容总高增大，scrollTop 不被截断）。
// 驱动机制（2026-08-30 auto-fix 例外，用户批准方案 A=契约 seam stub）：原「真全屏中
//   setViewportSize」被 Chromium CDP 拒绝（To resize minimized/maximized/fullscreen window,
//   restore it to normal state first），属驱动机制不可能性而非实现偏差。改为：先真全屏一次
//   背书 seam 真实可达（fullscreenElement 非空），退真全屏后以 Object.defineProperty stub
//   document.fullscreenElement（OR-C4 契约原文即以该 API 非空定义「全屏期间」）维持契约前提，
//   翻转仍走真实 setViewportSize。stub 前后各加硬断言排除「exitFullscreen / stub 副作用导致
//   假绿」；收尾 Reflect.deleteProperty 还原 document。
// 断言反转（2026-08-31 auto-fix#2，用户批准）：探针实证（吞 resize 监听使重锚死亡后翻转，
//   scrollTop 仍被精确补偿 1688→780=2×390 / 8580→18568=22×844）——Chromium 靠 scroll
//   anchoring（overflow-anchor）+ snap target 保留在翻转时天然稳住视觉元素，「重锚被抑制 ≡
//   无实现 ≡ 自然保持」三者观测全同，原 not.toBe(videoFp)（漂移观测）在 Chromium 无论实现
//   对错永假（真机 WebKit 无 overflow-anchor 才会漂移，此为原 bug 只在 iPhone 复现的根源）。
//   断言反转为用户可感契约「全屏期旋转不被甩离视频单元」（可 kill：滚到顶/锚错单元/位置重置）。
//   认知边界：「守卫抑制 vs 自然保持」的区分在 Chromium 黑盒不可观测，由 app.js 守卫代码
//   路径（fullscreenElement 非空 → early return）+ 真机人工验证保障。
// ============================================================================
describe("[OR-C4] 视频全屏期间翻转不执行重锚", () => {
  it("全屏期翻转 settle 后不被甩离视频单元（旋转不打断观看）", async ({ page }) => {
    await gotoStream(page);

    // —— 起点：横屏 + 视频单元（横→竖翻转，内容总高增大、scrollTop 不被 clamp）——
    await page.setViewportSize({ width: LANDSCAPE.width, height: LANDSCAPE.height });
    await page.waitForTimeout(FLIP_SETTLE_MS);
    await page.waitForSelector('[data-stream-unit][data-unit-type="video"]', { timeout: 8000 });
    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="video"]')
        ?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await page.waitForTimeout(SNAP_SETTLE_MS);

    const videoUnit = await page.evaluate((): UnitFingerprint | null => {
      const el = document.querySelector('[data-stream-unit][data-unit-type="video"]');
      if (!el) return null;
      return {
        unitType: el.getAttribute("data-unit-type"),
        dayDate: el.getAttribute("data-day-date"),
        photoRank: el.getAttribute("data-photo-rank"),
        videoId: el.getAttribute("data-video-id"),
        photoId: el.getAttribute("data-photo-id"),
      };
    });
    expect(videoUnit, "流内必须存在 video 单元").not.toBeNull();
    expect(videoUnit?.videoId, "video 单元 DOM 契约：必须带 data-video-id").toBe(videoThemeKey);
    const videoFp = fingerprintOf(videoUnit);

    const center0 = await observeCenterUnit(page);
    expect(fingerprintOf(center0.unit), "定位后视口中心应是视频单元").toBe(videoFp);
    // 两种中心判定在非全屏下必须一致（为全屏期改用几何判定背书）
    const geo0 = await observeGeometricCenterUnit(page);
    expect(geo0.index, "几何中心应命中视频单元位次").toBeGreaterThanOrEqual(0);
    expect(fingerprintOf(geo0.unit), "几何中心判定应与 elementFromPoint 判定一致").toBe(videoFp);

    // —— 对照组（无全屏）：翻转必须重锚回视频单元，证明「重锚」本身在工作 ——
    await page.setViewportSize({ width: PORTRAIT.width, height: PORTRAIT.height });
    await page.waitForTimeout(FLIP_SETTLE_MS);
    const control = await observeCenterUnit(page);
    expect(
      fingerprintOf(control.unit),
      `对照组：无全屏翻转后中心指纹 ${fingerprintOf(control.unit)} 应 == 视频单元 ${videoFp}`,
    ).toBe(videoFp);
    // 回到横屏 + 视频单元，作为全屏相位起点
    await page.setViewportSize({ width: LANDSCAPE.width, height: LANDSCAPE.height });
    await page.waitForTimeout(FLIP_SETTLE_MS);
    const restored = await observeCenterUnit(page);
    expect(fingerprintOf(restored.unit), "回到横屏后应重锚回视频单元").toBe(videoFp);

    // —— 真全屏背书（真实手势点击，沿用 gallery-video-fullscreen 契约路径）：
    //    证明全屏期间 document.fullscreenElement 真实非空，后续 stub 的 seam 与真全屏同源 ——
    await page.waitForSelector(
      '.unit-video[data-load-state="loaded"] [data-role="video-fullscreen"]',
      { timeout: 10000 },
    );
    await page
      .locator('.unit-video[data-load-state="loaded"] [data-role="video-fullscreen"]')
      .first()
      .click({ timeout: 4000 });
    await page.waitForFunction(
      () => {
        const v = document.querySelector(".unit-video video");
        const fsEl = document.fullscreenElement;
        return !!fsEl && !!v && (fsEl === v || fsEl.contains(v));
      },
      undefined,
      { timeout: 3000, polling: 50 },
    );
    expect(
      await page.evaluate(() => document.fullscreenElement !== null),
      "前置：必须已进入真全屏（fullscreenElement 非空）",
    ).toBe(true);
    // 前置：点击全屏按钮不得把滚动位置带跑（否则下面的「≠视频单元」是点击副作用造成的假绿）
    const geoPre = await observeGeometricCenterUnit(page);
    expect(fingerprintOf(geoPre.unit), `进入全屏后（翻转前）几何中心应是视频单元 ${videoFp}`).toBe(
      videoFp,
    );

    // —— 退真全屏 + 契约 seam stub（2026-08-30 用户批准的驱动机制，见文件头说明）：
    //    Chromium 拒绝在全屏态 setViewportSize（CDP Browser.setWindowBounds），
    //    以 stub 维持 OR-C4 契约前提（fullscreenElement 非空），翻转走真实布局变化 ——
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => document.fullscreenElement === null, undefined, {
      timeout: 2000,
      polling: 50,
    });
    await page.waitForTimeout(FLIP_SETTLE_MS);
    // 退真全屏副作用守卫：stub 前中心必须仍是视频单元（否则下面「≠视频单元」是退出副作用的假绿）
    const geoPost = await observeGeometricCenterUnit(page);
    expect(
      fingerprintOf(geoPost.unit),
      `退真全屏后（stub 前）几何中心应仍是视频单元 ${videoFp}`,
    ).toBe(videoFp);
    await page.evaluate(() => {
      const video = document.querySelector(".unit-video video");
      // 实例 own property 遮蔽 Document.prototype 原生 accessor；configurable 保证可清理还原
      Object.defineProperty(document, "fullscreenElement", {
        get: () => video,
        configurable: true,
      });
    });
    expect(
      await page.evaluate(() => document.fullscreenElement !== null),
      "stub 前提：fullscreenElement 非空（OR-C4 契约定义的「全屏期间」）",
    ).toBe(true);

    // —— 全屏期间翻转：契约要求此时不执行重锚 ——
    await page.setViewportSize({ width: PORTRAIT.width, height: PORTRAIT.height });
    await page.waitForTimeout(FLIP_SETTLE_MS);
    expect(
      await page.evaluate(() => document.fullscreenElement !== null),
      "翻转后仍应处于全屏（契约前提：全屏期间）",
    ).toBe(true);

    const geo = await observeGeometricCenterUnit(page);
    expect(geo.unit, "全屏期翻转后几何中心必须命中某个流单元").not.toBeNull();
    const geoFp = fingerprintOf(geo.unit);
    // 用户可感契约：全屏期旋转不得把用户甩离正在看的视频单元（不滚顶/不锚错/不重置）。
    // 「守卫抑制 vs 自然保持」在 Chromium 观测等价，见文件头「断言反转」认知边界说明。
    expect(
      geoFp,
      `OR-C4: 全屏期翻转后几何中心指纹 ${geoFp} 应仍是视频单元 ${videoFp}（旋转不打断观看）`,
    ).toBe(videoFp);

    // 收尾：清理 stub 还原 document（configurable: true 保证可 delete），
    // 确认 fullscreenElement 复位，避免污染同 worker 后续用例
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "fullscreenElement");
    });
    await page.waitForFunction(() => document.fullscreenElement === null, undefined, {
      timeout: 2000,
      polling: 50,
    });
    await writeArtifact(
      "OR.C4",
      JSON.stringify({ videoFp, geoIndex: geo.index, geoFp, scrollTop: geo.scrollTop }),
    );
  });
});

// ============================================================================
// 附加：OR.S1 守卫链稳健性（2026-08-31 qa-reviewer 谓词充分性缺口 #2/#4/#5 闭合，编排器补谓词）
//   覆盖风险面：streamEl.hidden 错误态守卫（showError 路径翻转不得抛未捕获异常）+
//   orientationAnchorWired retry 重入防重复注册（重复注册的 resize 处理器若含异常会以
//   pageerror 显形）+ isConnected 失效锚（retry 重挂载后旧 activeUnit detached，重锚不崩）。
//   断言：错误态翻转零 pageerror；retry 成功后翻转中心保持且仍零 pageerror。
// ============================================================================
describe("[OR.S1][QA-review 补谓词] 错误态与重试后的翻转稳健性", () => {
  it("错误态翻转零异常；retry 成功后翻转重锚仍工作（无重复注册异常）", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(String(err?.message ?? String(err))));

    // —— 错误态：manifest 500 → showError（stream hidden + activeUnit 未初始化）——
    await page.route("**/manifest.json", (route) => route.fulfill({ status: 500, body: "boom" }));
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("#error-fallback:not([hidden])", { timeout: 8000 });

    // 错误态翻转：守卫链应全部安全短路，零未捕获异常
    await page.setViewportSize(LANDSCAPE);
    await page.waitForTimeout(FLIP_SETTLE_MS);
    expect(pageErrors, `错误态翻转不应产生未捕获异常: ${pageErrors.join("; ")}`).toEqual([]);

    // —— retry：解除拦截 → 重试成功 → 流重挂载（旧 activeUnit 若有已 detached）——
    await page.unroute("**/manifest.json");
    await page.locator('[data-role="retry-button"]').click({ timeout: 4000 });
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    await page.waitForFunction(
      () => document.querySelectorAll("[data-stream-unit]").length >= 3,
      undefined,
      { timeout: 8000, polling: 100 },
    );

    // —— retry 后翻转：重锚仍工作（监听重入不重复注册、无异常）——
    const fp = await anchorAt(page, 2);
    await page.setViewportSize({ width: LANDSCAPE.width, height: LANDSCAPE.height });
    await page.waitForTimeout(FLIP_SETTLE_MS);
    const after = await observeCenterUnit(page);
    expect(fingerprintOf(after.unit), `retry 后翻转中心指纹应保持 ${fp}`).toBe(fp);
    expect(pageErrors, `retry 后翻转不应产生未捕获异常: ${pageErrors.join("; ")}`).toEqual([]);

    await writeArtifact(
      "OR.S1",
      JSON.stringify({ pageErrors, fp, after: fingerprintOf(after.unit) }),
    );
  });
});

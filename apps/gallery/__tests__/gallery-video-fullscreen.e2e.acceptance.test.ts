/**
 * 验收测试（红队 E2E）：gallery 视频「真全屏 + 引导横屏」（谓词 FS.PM1 ~ FS.PM5）
 *
 * 设计契约来源（需求《gallery 视频真全屏 + 引导横屏》——本文件唯一需求真相源）：
 *   DOM 契约（蓝队 1:1 挂载）：
 *     - button.video-fullscreen[data-role="video-fullscreen"][type="button"]
 *       [aria-label="全屏观看"] 挂载于每个 .unit-video 内
 *     - [data-role="video-hint"] 挂载于 .unit-video 内，默认不可见；
 *       降级显示时 textContent 含「横屏」
 *     - .unit-video[data-load-state="error"] 内 [data-role="video-fullscreen"]
 *       computed display === "none"
 *     - 既有契约（回归背景）：[data-role="video-sound"] 声音按钮
 *       （机读态 data-sound-state="muted|unmuted"——契约演进 [2026-08-30]：
 *       原 textContent "🔇"/"🔊" emoji 契约随图标 SVG 化演进为 data-sound-state，
 *       见 state.md《给视频和图片增加下载》契约演进节）；video 单元 dataset:
 *       streamUnit/unitType="video"/mediaType="video"/videoId/loadState
 *
 *   行为契约：
 *     - 能力探测顺序：video.webkitEnterFullscreen 优先，否则 requestFullscreen
 *       （成功后尝试 screen.orientation.lock("landscape")，失败静默）；
 *       两者均不可用或调用失败 → 页内降级提示
 *     - 点击全屏按钮（loaded 态）→ 保持进入前声音态（契约演进 [2026-08-30]：
 *       不再强制 muted=false，安静场合友好）、确保播放（paused===false）、
 *       全屏内启用原生 controls（可拖进度/自行开声）、进入全屏
 *       （document.fullscreenElement 非空且包含该 video）
 *     - 退出全屏（Escape / document.exitFullscreen()）→ muted=true、
 *       声音按钮 data-sound-state="muted"、原生 controls 移除
 *     - 降级提示 ≤3000ms 自动隐藏
 *     - 视频源 404 → data-load-state="error" → 全屏按钮 display:none
 *
 * 谓词覆盖：
 *   - FS.PM1 [det-machine] 每个 video 单元含全屏按钮（aria-label/type 字面量）
 *   - FS.PM2 [real-process] loaded 态点击全屏按钮 → ≤1000ms 内 fullscreenElement
 *     包含 video 且 muted===true（保持进入前态）且 paused===false 且 controls===true
 *   - FS.PM3 [real-process] 退出全屏 → muted===true 且声音按钮
 *     data-sound-state="muted" 且 controls===false
 *   - FS.PM4 [det-machine] mp4 404 → error 单元内全屏按钮 computed display==="none"
 *   - FS.PM5 [real-process] 双 API 删除 → hint 含「横屏」出现且 ≤3000ms 不可见
 *
 * 红队铁律：不读 app.js/app.css/index.html，仅依据上述契约 + 谓词黑盒编写。
 *   - harness 约定沿用 gallery-video-errors.e2e.acceptance.test.ts：
 *     beforeAll 拷贝三件套+fonts 到隔离目录、generateFixture() 造 manifest+素材、
 *     python3 -m http.server 起静态服务、MOBILE_VIEWPORT 390x844、
 *     artifact 写 /tmp/autopilot-artifacts/<id>.out
 *   - 端口 8767：避开既有 8765(stream)/8766(video-errors) 默认端口；
 *     playwright.config.ts workers=1 + fullyParallel=false，文件间串行，
 *     共享 fixture 目录 /tmp/relight-gallery-fixture 不会并发互踩
 *     （如需彻底隔离，运行侧可设 GALLERY_FIXTURE_DIR，工厂已支持）
 *
 * 强断言铁律：每个 it 含 expect.* 硬断言，失败必挂；无宽容跳过模式。
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
const STATIC_PORT = Number(process.env.GALLERY_STATIC_PORT ?? 8767);
// 隔离临时目录（避免污染开发目录 apps/gallery/，跑完整体删除）
const GALLERY_DIR =
  process.env.GALLERY_DIR ?? path.join(os.tmpdir(), `relight-gallery-e2e-${STATIC_PORT}`);
const SRC_GALLERY_DIR = path.resolve(__dirname, "../");
const STATIC_BASE = `http://localhost:${STATIC_PORT}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

let serverProc: ChildProcess | null = null;
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
  manifestPath = fx.manifestPath;

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
    serverProc?.stderr?.on("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  // 注：@playwright/test 1.59.1 的 beforeAll 类型已无 (fn, timeout) 重载，
  // hook 超时依赖 playwright.config.ts 的 timeout: 30_000
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

async function writeArtifact(id: string, content: string): Promise<void> {
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

const MOBILE_VIEWPORT = { width: 390, height: 844 };
beforeEach(async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
});

// ============================================================================
// 共享步骤 / 页面侧谓词
// ============================================================================

/** 打开流，滚到视频单元，硬等 loaded 态（fixture 提供可播放 mp4，加载失败即红灯） */
async function gotoStreamAndWaitVideoLoaded(page: Page): Promise<void> {
  await page.goto(`${STATIC_BASE}/#/`);
  await page.waitForSelector(".unit-video", { timeout: 8000 });
  await page.evaluate(() => {
    document.querySelector(".unit-video")?.scrollIntoView({
      behavior: "instant",
      block: "center",
    });
  });
  await page.waitForSelector('.unit-video[data-load-state="loaded"]', { timeout: 10000 });
}

/** 真实用户手势点击全屏按钮（仅 loaded 态单元内） */
async function clickFullscreenButton(page: Page): Promise<void> {
  const btn = page
    .locator('.unit-video[data-load-state="loaded"] [data-role="video-fullscreen"]')
    .first();
  await btn.click({ timeout: 4000 });
}

/** 硬等 W3C 全屏进入：fullscreenElement 非空且包含该 video（=== 或 contains 双保险） */
async function waitFullscreenEntered(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const v = document.querySelector(".unit-video video");
      if (!v) return false;
      const fsEl = document.fullscreenElement;
      return !!fsEl && (fsEl === v || fsEl.contains(v));
    },
    undefined,
    { timeout: timeoutMs, polling: 50 },
  );
}

// ============================================================================
// FS.PM1 [det-machine] 每个 video 单元挂载全屏按钮（契约字面量）
// ============================================================================
describe("[FS.PM1][det-machine] 每个 video 单元含全屏按钮 + hint 默认不可见", () => {
  it("每个 .unit-video 内存在 button.video-fullscreen[data-role=video-fullscreen][type=button][aria-label=全屏观看]", async ({
    page,
  }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector(".unit-video", { timeout: 8000 });

    // 刚挂载、零交互时检查（「默认不可见」语义）
    const info = await page.evaluate(() => {
      const units = Array.from(document.querySelectorAll(".unit-video"));
      return {
        unitCount: units.length,
        buttons: units.map((u) => {
          const btn = u.querySelector('[data-role="video-fullscreen"]');
          const hint = u.querySelector('[data-role="video-hint"]');
          let hintHidden = false;
          let hintMounted = false;
          if (hint) {
            hintMounted = true;
            // CONTRACT_AMBIGUOUS: 「不可见」的机制设计未指定——按
            // display:none ∨ visibility:hidden ∨ opacity:0 ∨ 零尺寸任一成立判定
            const cs = getComputedStyle(hint);
            const r = hint.getBoundingClientRect();
            hintHidden =
              cs.display === "none" ||
              cs.visibility === "hidden" ||
              cs.opacity === "0" ||
              r.width === 0 ||
              r.height === 0;
          }
          return {
            unitType: u.getAttribute("data-unit-type"),
            exists: !!btn,
            tag: btn?.tagName ?? null,
            cls: btn?.getAttribute("class") ?? "",
            role: btn?.getAttribute("data-role"),
            type: btn?.getAttribute("type"),
            aria: btn?.getAttribute("aria-label"),
            hintMounted,
            hintHidden,
          };
        }),
      };
    });

    await writeArtifact("FS.PM1", JSON.stringify(info));
    expect(info.unitCount).toBeGreaterThan(0);
    for (const b of info.buttons) {
      expect(b.unitType).toBe("video");
      expect(b.exists, "全屏按钮必须挂载于每个 .unit-video 内").toBe(true);
      expect(b.tag).toBe("BUTTON");
      expect(b.cls).toContain("video-fullscreen");
      expect(b.role).toBe("video-fullscreen");
      expect(b.type).toBe("button");
      expect(b.aria).toBe("全屏观看");
      expect(b.hintMounted, "[data-role=video-hint] 必须挂载于 .unit-video 内").toBe(true);
      expect(b.hintHidden, "video-hint 默认必须不可见").toBe(true);
    }
  });
});

// ============================================================================
// FS.PM2 [real-process] loaded 态点击全屏按钮 → 真全屏 + 保持静音 + 原生控制条
// ============================================================================
describe("[FS.PM2][real-process] 点击全屏按钮进入真全屏（保持声音态 + 启用 controls）", () => {
  it("点击后 ≤1000ms 内 fullscreenElement 包含 video 且 muted===true(保持进入前态) 且 paused===false 且 controls===true", async ({
    page,
  }) => {
    await gotoStreamAndWaitVideoLoaded(page);

    // ≤1000ms 预算从点击时刻起算（含点击本身耗时）
    const t0 = Date.now();
    await clickFullscreenButton(page);
    const budgetMs = Math.max(250, 1000 - (Date.now() - t0));

    await page.waitForFunction(
      () => {
        const v = document.querySelector(".unit-video video") as HTMLVideoElement | null;
        if (!v) return false;
        const fsEl = document.fullscreenElement;
        const fsOk = !!fsEl && (fsEl === v || fsEl.contains(v));
        // 契约演进 [2026-08-30]：进全屏不再强制出声——muted 保持进入前态
        // （流内 autoplay 恒 muted=true）；controls=true 为全屏内原生控制条
        return fsOk && v.muted === true && v.paused === false && v.controls === true;
      },
      undefined,
      { timeout: budgetMs, polling: 50 },
    );

    // 复取终态做双保险硬断言 + artifact
    const state = await page.evaluate(() => {
      const v = document.querySelector(".unit-video video") as HTMLVideoElement | null;
      const fsEl = document.fullscreenElement;
      return {
        fsNonNull: fsEl !== null,
        fsContainsVideo: !!fsEl && !!v && (fsEl === v || fsEl.contains(v)),
        muted: v ? v.muted : null,
        paused: v ? v.paused : null,
        controls: v ? v.controls : null,
      };
    });

    await writeArtifact(
      "FS.PM2",
      JSON.stringify({ ...state, elapsedMs: Date.now() - t0, budgetMs }),
    );
    expect(state.fsNonNull).toBe(true);
    expect(state.fsContainsVideo).toBe(true);
    expect(state.muted).toBe(true);
    expect(state.paused).toBe(false);
    expect(state.controls).toBe(true);
  });
});

// ============================================================================
// FS.PM3 [real-process] 退出全屏 → 恢复静音 + 声音按钮 data-sound-state 回 muted
// ============================================================================
describe("[FS.PM3][real-process] 退出全屏恢复静音", () => {
  it("全屏中保持静音（data-sound-state=muted），document.exitFullscreen() 后 muted===true 且按钮态回 muted 且 controls 移除", async ({
    page,
  }) => {
    await gotoStreamAndWaitVideoLoaded(page);

    // 前置探针：声音按钮切换语义——机读态 data-sound-state 随点击翻转
    // （契约演进 [2026-08-30]：替代原 textContent "🔇"/"🔊" emoji 断言，
    // 等效覆盖「按钮态忠实反映 muted」这一被证性质，非弱化）
    const soundBtn = page
      .locator('.unit-video[data-load-state="loaded"] [data-role="video-sound"]')
      .first();
    await soundBtn.click();
    await page.waitForFunction(
      () => {
        const v = document.querySelector(".unit-video video") as HTMLVideoElement | null;
        const s = document.querySelector('.unit-video [data-role="video-sound"]');
        return !!v && v.muted === false && s?.getAttribute("data-sound-state") === "unmuted";
      },
      undefined,
      { timeout: 1000, polling: 50 },
    );
    await soundBtn.click();
    await page.waitForFunction(
      () => {
        const v = document.querySelector(".unit-video video") as HTMLVideoElement | null;
        const s = document.querySelector('.unit-video [data-role="video-sound"]');
        return !!v && v.muted === true && s?.getAttribute("data-sound-state") === "muted";
      },
      undefined,
      { timeout: 1000, polling: 50 },
    );

    // 前置：经全屏按钮进入全屏（FS.PM2 已覆盖进入本身，这里作为前置硬断言）
    await clickFullscreenButton(page);
    await waitFullscreenEntered(page, 3000);

    // 全屏中保持进入前声音态（muted）+ 原生 controls 启用
    // （契约演进 [2026-08-30]：旧契约「全屏中出声（🔊）」已随不再强制出声反转）
    await page.waitForFunction(
      () => {
        const v = document.querySelector(".unit-video video") as HTMLVideoElement | null;
        const s = document.querySelector('.unit-video [data-role="video-sound"]');
        return (
          !!v &&
          v.muted === true &&
          v.paused === false &&
          v.controls === true &&
          s?.getAttribute("data-sound-state") === "muted"
        );
      },
      undefined,
      { timeout: 2000, polling: 50 },
    );

    // 退出全屏。契约允许 Escape 或 document.exitFullscreen() 两条路径；
    // headless Chromium 中浏览器层 Escape 退出不可靠，选契约明示的
    // document.exitFullscreen() 路径（fullscreenchange 处理器必须对其生效）
    await page.evaluate(() => document.exitFullscreen());

    await page.waitForFunction(() => document.fullscreenElement === null, undefined, {
      timeout: 2000,
      polling: 50,
    });

    // 退出恢复为事件驱动（fullscreenchange → restore），平台在属性置 null 与事件
    // 任务之间存在毫秒级交错窗口（探针实证 3/3：restore 与退出事件同毫秒、≤100ms
    // 内完成）。契约对退出侧未规定时间预算，按进入侧同款 ≤1000ms 预算等待终态
    // （2026-08-29 用户授权的红队时序放宽，断言值不弱化）。
    await page.waitForFunction(
      () => {
        const v = document.querySelector(".unit-video video") as HTMLVideoElement | null;
        const s = document.querySelector('.unit-video [data-role="video-sound"]');
        return (
          document.fullscreenElement === null &&
          !!v &&
          v.muted === true &&
          v.controls === false &&
          s?.getAttribute("data-sound-state") === "muted"
        );
      },
      undefined,
      { timeout: 1000, polling: 50 },
    );

    const after = await page.evaluate(() => {
      const v = document.querySelector(".unit-video video") as HTMLVideoElement | null;
      const s = document.querySelector('.unit-video [data-role="video-sound"]');
      return {
        fsNull: document.fullscreenElement === null,
        muted: v ? v.muted : null,
        controls: v ? v.controls : null,
        soundState: s?.getAttribute("data-sound-state") ?? null,
      };
    });

    await writeArtifact("FS.PM3", JSON.stringify(after));
    expect(after.fsNull).toBe(true);
    expect(after.muted).toBe(true);
    expect(after.controls).toBe(false);
    expect(after.soundState).toBe("muted");
  });
});

// ============================================================================
// FS.PM4 [det-machine] 视频源 404 → error 单元内全屏按钮 display:none
// ============================================================================
describe("[FS.PM4][det-machine] 视频 404 后全屏按钮不可见不可点", () => {
  it("拦截 mp4 404 → .unit-video[data-load-state=error] 内全屏按钮 computed display === 'none'", async ({
    page,
  }) => {
    await page.route("**/*.mp4", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" }),
    );

    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector(".unit-video", { timeout: 8000 });
    // 进视口触发加载 → 404 → onerror → error 态
    await page.evaluate(() => {
      document.querySelector(".unit-video")?.scrollIntoView({
        behavior: "instant",
        block: "center",
      });
    });
    // 硬等 error 态（不宽容等待）
    await page.waitForFunction(
      () => document.querySelector('.unit-video[data-load-state="error"]') !== null,
      undefined,
      { timeout: 8000, polling: 100 },
    );

    const info = await page.evaluate(() => {
      const unit = document.querySelector('.unit-video[data-load-state="error"]');
      const btn = unit?.querySelector('[data-role="video-fullscreen"]');
      const cs = btn ? getComputedStyle(btn) : null;
      return {
        unitState: unit?.getAttribute("data-load-state") ?? null,
        btnExists: !!btn,
        display: cs?.display ?? null,
      };
    });

    await writeArtifact("FS.PM4", JSON.stringify(info));
    expect(info.unitState).toBe("error");
    // DOM 契约：按钮仍挂载于每个 .unit-video（含 error 单元），仅以 display:none 隐藏
    expect(info.btnExists).toBe(true);
    expect(info.display).toBe("none");
  });
});

// ============================================================================
// FS.PM5 [real-process] 双 API 均不可用 → 页内降级提示 + ≤3000ms 自动隐藏
// ============================================================================
describe("[FS.PM5][real-process] 无全屏能力时降级提示自动隐藏", () => {
  it("删除 webkitEnterFullscreen 与 requestFullscreen 后点击 → hint 含「横屏」出现且 ≤3000ms 不可见", async ({
    page,
  }) => {
    // 在任何页面脚本之前删除两条全屏路径（能力探测顺序的唯一两支）
    await page.addInitScript(() => {
      const vproto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
      // biome-ignore lint/performance/noDelete: 测试需真实移除原型属性模拟 API 缺失（in/typeof 探测均须为无）
      delete vproto.webkitEnterFullscreen;
      const eproto = Element.prototype as unknown as Record<string, unknown>;
      // biome-ignore lint/performance/noDelete: 同上，requestFullscreen 必须不存在而非 undefined
      delete eproto.requestFullscreen;
    });

    await gotoStreamAndWaitVideoLoaded(page);

    const t0 = Date.now();
    await clickFullscreenButton(page);

    // 提示必须出现（硬断言：杀「无 hint」no-op mutation）
    await page.waitForFunction(
      () => {
        const h = document.querySelector('[data-role="video-hint"]');
        if (!h) return false;
        const cs = getComputedStyle(h);
        const r = h.getBoundingClientRect();
        return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
      },
      undefined,
      // CONTRACT_AMBIGUOUS: 提示出现的时限设计未指定，取 1500ms 探测窗
      { timeout: 1500, polling: 50 },
    );

    const shown = await page.evaluate(() => {
      const h = document.querySelector('[data-role="video-hint"]');
      return {
        text: h?.textContent ?? "",
        fsNull: document.fullscreenElement === null,
      };
    });
    expect(shown.text).toContain("横屏");
    // 双 API 均不可用 → 不得进入全屏
    expect(shown.fsNull).toBe(true);

    // ≤3000ms（自点击起算 +150ms 采样容差）自动隐藏
    //（杀「提示常驻不隐藏」mutation；「从未出现」已被上面的出现断言排除）
    const remainMs = Math.max(300, 3000 - (Date.now() - t0) + 150);
    await page.waitForFunction(
      () => {
        const h = document.querySelector('[data-role="video-hint"]');
        if (!h) return true; // 已从 DOM 移除 = 不可见
        // CONTRACT_AMBIGUOUS: 「不可见」机制未指定——同 FS.PM1 的判定集合
        const cs = getComputedStyle(h);
        const r = h.getBoundingClientRect();
        return (
          cs.display === "none" ||
          cs.visibility === "hidden" ||
          cs.opacity === "0" ||
          r.width === 0 ||
          r.height === 0
        );
      },
      undefined,
      { timeout: remainMs, polling: 50 },
    );

    await writeArtifact(
      "FS.PM5",
      JSON.stringify({
        text: shown.text,
        hideBudgetRemainMs: remainMs,
        totalElapsedMs: Date.now() - t0,
      }),
    );
  });
});

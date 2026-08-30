/**
 * 验收测试（红队 E2E）：gallery 单一垂直沉浸流（det-machine 谓词 S1/S2/S3/S5/S6/S7/S8/S9/S10/S14）
 *
 * 设计契约来源（state.md §验收场景 + §契约规约 前端流单元 DOM 契约）：
 *   - 流单元 data-* 契约属性（蓝队 1:1 挂载，红队 selector 据此）：
 *     data-stream-unit / data-unit-type(photo|video|wallpaper|date-separator)
 *     data-load-state(loading|loaded|error) / data-day-date / data-day-index
 *     data-photo-rank / data-photo-id / data-takenat-absent / data-role
 *   - 首屏首个流单元 = 今日 rank=1 照片且全屏铺满（S1.PM1）
 *   - 零点击直达，无 nav/cover-card/history-entry/thumbnail-grid（S1.PM2）
 *   - 标题与拍摄时刻压图渲染（S1.PM3）
 *   - 暖黑基底全屏（S1.PM4）
 *   - 跨日 day-index 切换（S2.PM1）
 *   - 日期分隔卡倒序严格递减（S2.PM2）
 *   - 全程无 #/history（S2.PM3）
 *   - 每个 photo 含非空 narrative（S3.PM1）
 *   - 同时播放视频 <=1（S5.PM1）
 *   - 当日流末尾 wallpaper-card（S6.PM1）+ save-hint（S6.PM2）
 *   - 无壁纸天非 wallpaper-card（S7.PM1）
 *   - takenAt 缺失无 dateline（S8.PM1）+ 无 null 泄漏（S8.PM2）+ 脏字符串同样不渲染（S8.PM3）
 *   - 占位防 CLS 含 width=0 fallback 3/4（S9.PM1）+ original 指向 mid（S9.PM2）
 *     + mid 失败 fallback thumb（S9.PM3，fixture 变体）
 *   - 首屏挂载 <=60（S10.PM1）+ 懒加载（S10.PM2）
 *   - 深链 #/?date= 流内定位（S14.PM1）
 *
 * 三变体 fixture 注入（gen-manifest.mjs）：
 *   ① takenAt=null（rank 5，S8.PM1）
 *   ② takenAt="undefined"（rank 10，S8.PM3）
 *   ③ width=0/height=0（rank 15，S9.PM1）
 *   ④ original===thumbnail mid 失败（rank 18，S9.PM3）
 *
 * 红队铁律：本文件仅依据设计文档 + DOM 契约属性编写，不读蓝队 app.js/app.css/index.html。
 *   - 用 python3 -m http.server 起 apps/gallery/ 静态 server
 *   - 用 fixture manifest.json（含三变体）替换 server 根的 manifest
 *   - playwright 驱动断言 data-* 属性 + boundingRect
 *
 * 强断言铁律：每个 it 含 expect.* 硬断言，失败必挂。
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
const STATIC_PORT = Number(process.env.GALLERY_STATIC_PORT ?? 8765);
// 隔离临时目录（避免污染开发目录 apps/gallery/，跑完整体删除）
const GALLERY_DIR =
  process.env.GALLERY_DIR ?? path.join(os.tmpdir(), `relight-gallery-e2e-${STATIC_PORT}`);
// 开发目录（三件套 + fonts 来源，仅读不写）
const SRC_GALLERY_DIR = path.resolve(__dirname, "../");
const STATIC_BASE = `http://localhost:${STATIC_PORT}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

let serverProc: ChildProcess | null = null;
let fixtureDir: string;
let manifestPath: string;

// ============================================================================
// 启动静态 server（python3 -m http.server）服务 apps/gallery/ 目录
// manifest.json 由 fixture 工厂生成后 copy 到 gallery 根（覆盖式，不污染蓝队产物）
// ============================================================================
beforeAll(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  // 拷贝三件套 + fonts 到隔离临时目录（不污染开发目录 apps/gallery/）
  fs.rmSync(GALLERY_DIR, { recursive: true, force: true });
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
  for (const f of ["index.html", "app.css", "app.js"]) {
    fs.copyFileSync(path.join(SRC_GALLERY_DIR, f), path.join(GALLERY_DIR, f));
  }
  fs.cpSync(path.join(SRC_GALLERY_DIR, "fonts"), path.join(GALLERY_DIR, "fonts"), {
    recursive: true,
  });

  // 生成 fixture
  const fx = generateFixture();
  fixtureDir = fx.manifestDir;
  manifestPath = fx.manifestPath;

  // 把 fixture 产物软链/copy 进 gallery 目录（让静态 server 服务到）
  // 用 copy 而非软链：避免 server 不 follow 软链
  const targetManifest = path.join(GALLERY_DIR, "manifest.json");
  fs.copyFileSync(manifestPath, targetManifest);
  // 把 photos/wallpapers/videos 目录 copy 进 gallery（覆盖式 fixture）
  for (const sub of ["photos", "wallpapers", "videos"]) {
    const src = path.join(fixtureDir, sub);
    const dst = path.join(GALLERY_DIR, sub);
    if (fs.existsSync(src)) {
      fs.cpSync(src, dst, { recursive: true });
    }
  }

  // 启动 python http.server
  serverProc = spawn(
    "python3",
    ["-m", "http.server", String(STATIC_PORT), "--directory", GALLERY_DIR],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  // 等 server 起来
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("static server 启动超时")), 8000);
    serverProc?.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Serving HTTP")) {
        clearTimeout(timer);
        resolve();
      }
    });
    // 兜底：探测端口
    setTimeout(() => {
      clearTimeout(timer);
      resolve();
    }, 1500);
  });
}, 30000);

afterAll(async () => {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
  // 整体删除隔离临时目录（三件套 + fixture，不污染开发目录 apps/gallery/）
  try {
    fs.rmSync(GALLERY_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// 写 artifact 辅助
async function writeArtifact(id: string, content: string): Promise<void> {
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

// 滚动 stream 容器（body { overflow: hidden }，window.scrollBy/scrollTo 无效；
// 实际滚动容器是 <main id="stream" overflow-y:scroll>）。所有需程序化滚动的测试统一走此入口。
async function scrollStreamBy(page: import("@playwright/test").Page, dy: number): Promise<void> {
  await page.evaluate((y) => {
    const stream = document.getElementById("stream");
    if (stream) stream.scrollBy(0, y);
  }, dy);
}
async function scrollStreamTo(page: import("@playwright/test").Page, y: number): Promise<void> {
  await page.evaluate((top) => {
    const stream = document.getElementById("stream");
    if (stream) stream.scrollTop = top;
  }, y);
}
async function scrollStreamToBottom(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const stream = document.getElementById("stream");
    if (stream) stream.scrollTop = stream.scrollHeight;
  });
}

// mobile viewport（移动端优先）
const MOBILE_VIEWPORT = { width: 390, height: 844 };

beforeEach(async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
});

// ============================================================================
// S1.PM1：首屏首个流单元是今日 rank=1 照片且全屏铺满
// ============================================================================
describe("[S1.PM1] 首屏首单元 = 今日 rank=1 photo 全屏铺满", () => {
  it("首单元 data-unit-type=photo AND data-photo-rank=1 AND 全屏铺满", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    const first = await page.evaluate(() => {
      const el = document.querySelectorAll("[data-stream-unit]")[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        unitType: el.getAttribute("data-unit-type"),
        photoRank: el.getAttribute("data-photo-rank"),
        width: r.width,
        height: r.height,
        top: r.top,
        left: r.left,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
      };
    });

    await writeArtifact("S1.PM1", JSON.stringify(first));
    expect(first, "首单元必须存在").not.toBeNull();
    expect(first?.unitType).toBe("photo");
    expect(first?.photoRank).toBe("1");
    // 全屏铺满（width === innerWidth, height === innerHeight，零偏移）
    expect(first?.width).toBe(first?.innerW);
    expect(first?.height).toBe(first?.innerH);
    expect(first?.top).toBe(0);
    expect(first?.left).toBe(0);
  });
});

// ============================================================================
// S1.PM2：零点击直达，无可交互导航/封面卡/缩略图栅格
// ============================================================================
describe("[S1.PM2] 首屏无 nav/cover-card/history-entry/thumbnail-grid", () => {
  it("nav/cover-card/history-entry/thumbnail-grid 数 == 0", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    const count = await page.evaluate(() => {
      return document.querySelectorAll(
        'nav, [data-role="cover-card"], [data-role="history-entry"], [data-role="thumbnail-grid"]',
      ).length;
    });

    await writeArtifact("S1.PM2", `count=${count}`);
    expect(count).toBe(0);
  });
});

// ============================================================================
// S1.PM3：标题与拍摄时刻压图渲染
// ============================================================================
describe("[S1.PM3] 标题压图渲染", () => {
  it("首单元 [data-role=title] 文本非空 AND 与图片容器重叠", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit][data-unit-type='photo']", { timeout: 8000 });

    const info = await page.evaluate(() => {
      const unit = document.querySelector("[data-stream-unit][data-unit-type='photo']");
      if (!unit) return null;
      const title = unit.querySelector('[data-role="title"]');
      const img = unit.querySelector("img");
      if (!title || !img) return { titleOk: false, overlap: false, reason: "missing" };
      const tr = title.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      const overlap = !(
        tr.right < ir.left ||
        tr.left > ir.right ||
        tr.bottom < ir.top ||
        tr.top > ir.bottom
      );
      return {
        titleText: title.textContent ?? "",
        titleLen: (title.textContent ?? "").trim().length,
        overlap,
      };
    });

    await writeArtifact("S1.PM3", JSON.stringify(info));
    expect(info, "首 photo 单元必须有 title + img").not.toBeNull();
    expect(info?.titleLen ?? 0).toBeGreaterThanOrEqual(1);
    expect(info?.overlap).toBe(true);
  });
});

// ============================================================================
// S1.PM4：沉浸暖黑暗色全屏基底
// ============================================================================
describe("[S1.PM4] 暖黑基底全屏", () => {
  it("body 背景为暖黑 AND 首单元零偏移占满视口", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    const info = await page.evaluate(() => {
      const bgRaw = getComputedStyle(document.body).backgroundColor;
      // 新版 Chromium 计算样式可能保留 oklch() 原样不转 rgb —— 用临时元素 + canvas 把任意颜色
      // 规范化成 [r,g,b]。挂在 DOM 上（visibility:hidden）确保 getComputedStyle 解析 oklch。
      const probe = document.createElement("div");
      probe.style.visibility = "hidden";
      probe.style.backgroundColor = bgRaw;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const first = document.querySelectorAll("[data-stream-unit]")[0];
      const r = first?.getBoundingClientRect();
      return {
        bg: resolved,
        bgRaw,
        first: r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
      };
    });

    await writeArtifact("S1.PM4", JSON.stringify(info));
    // 暖黑 oklch(0.155 0.006 95) 解析后约 rgb(20,20,21)。新版 Chromium 经临时元素
    // getComputedStyle 后会转 rgb；若仍保留 oklch 字符串，用其 lightness=0.155 直接判定暗色。
    const m = info?.bg?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const oklchM = info?.bg?.match(/oklch\(\s*([\d.]+)/);
    expect(
      m || oklchM,
      `body 背景应是 rgb/oklch 暗色，实际 bg=${info?.bg} bgRaw=${info?.bgRaw}`,
    ).not.toBeNull();
    if (m) {
      const [_, r, g, b] = m;
      expect(Number(r)).toBeLessThanOrEqual(50);
      expect(Number(g)).toBeLessThanOrEqual(50);
      expect(Number(b)).toBeLessThanOrEqual(50);
    } else if (oklchM) {
      // oklch lightness 0.155 ≪ 0.2，确认为暗色基底
      expect(Number(oklchM[1])).toBeLessThanOrEqual(0.2);
    }
    // 首单元零偏移占满
    expect(info?.first?.top).toBe(0);
    expect(info?.first?.left).toBe(0);
    expect(info?.first?.width).toBe(info?.innerW);
    expect(info?.first?.height).toBe(info?.innerH);
  });
});

// ============================================================================
// S2.PM1：滑过今日 rank=20 后下一照片单元是昨日 rank=1
// ============================================================================
describe("[S2.PM1] 跨日 day-index 切换", () => {
  it("越过 day-index=0 最后一张后视口首 photo 是 day-index=1 rank=1", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // 越过 day-index=0 最后一张：先确认 day-index=0 有 photo 序列，
    // 再用 stream 容器滚动让 day-index=1 的 rank=1 进入视口。
    // window.scrollBy 无效（body overflow:hidden）；stream scroll-snap-stop:always 会吸附到单元 start，
    // 故直接 scrollIntoView day-index=1 rank=1 photo（block:start），让 snap 吸附它到视口顶。
    const target = await page.evaluate(() => {
      const photos = Array.from(
        document.querySelectorAll('[data-stream-unit][data-unit-type="photo"][data-day-index="0"]'),
      );
      return photos.length ? photos[photos.length - 1].getAttribute("data-photo-rank") : null;
    });
    expect(target, "day-index=0 必须有 photo 单元").not.toBeNull();

    await page.evaluate(() => {
      document
        .querySelector(
          '[data-stream-unit][data-unit-type="photo"][data-day-index="1"][data-photo-rank="1"]',
        )
        ?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    // 等 scroll-snap smooth 吸附完成
    await page.waitForTimeout(700);

    const next = await page.evaluate(() => {
      // 找视口内首个 day-index=1 的 photo
      const vph = window.innerHeight;
      const candidates = Array.from(
        document.querySelectorAll('[data-stream-unit][data-unit-type="photo"][data-day-index="1"]'),
      );
      const inView = candidates.find((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.top < vph * 0.6;
      });
      return inView
        ? {
            dayIndex: inView.getAttribute("data-day-index"),
            rank: inView.getAttribute("data-photo-rank"),
          }
        : null;
    });

    await writeArtifact("S2.PM1", JSON.stringify({ target, next }));
    expect(next, "应找到视口内 day-index=1 的 photo").not.toBeNull();
    expect(next?.dayIndex).toBe("1");
    expect(next?.rank).toBe("1");
  });
});

// ============================================================================
// S2.PM2：日期分隔卡按倒序严格递减
// ============================================================================
describe("[S2.PM2] 日期分隔卡倒序严格递减", () => {
  it("所有 [data-unit-type=date-separator] 的 data-day-date 严格递减", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // 触发增量挂载直到挂完所有天（滚动 stream 到底；window.scrollTo 在 body overflow:hidden 无效）
    for (let i = 0; i < 10; i++) {
      await scrollStreamToBottom(page);
      await page.waitForTimeout(400);
    }

    const dates = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-unit-type="date-separator"]')).map((el) =>
        el.getAttribute("data-day-date"),
      );
    });

    await writeArtifact("S2.PM2", JSON.stringify(dates));
    expect(dates.length).toBeGreaterThanOrEqual(2);
    // 严格递减（ISO 字符串字典序；toBeLessThan 只接受 number，字符串用 < 运算符判定）
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]! < dates[i - 1]!, `第 ${i} 个 date 应严格小于前一个`).toBe(true);
    }
  });
});

// ============================================================================
// S2.PM3：全程无 #/history 独立历史页跳转
// ============================================================================
describe("[S2.PM3] 全程无 #/history", () => {
  it("滚动全程 location.hash 永不 == #/history", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    const observed: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
      await page.waitForTimeout(300);
      const hash = await page.evaluate(() => window.location.hash);
      observed.push(hash);
    }

    await writeArtifact("S2.PM3", JSON.stringify(observed));
    expect(observed.every((h) => h !== "#/history")).toBe(true);
  });
});

// ============================================================================
// S3.PM1：每个照片单元含非空 narrative
// ============================================================================
describe("[S3.PM1] 每个 photo 含非空 narrative", () => {
  it("所有 photo 单元 [data-role=narrative] textContent.trim().length >= 1", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // 挂载更多
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(300);
    }

    const lengths = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll('[data-stream-unit][data-unit-type="photo"]'),
      ).map((el) => {
        const n = el.querySelector('[data-role="narrative"]');
        return n ? (n.textContent ?? "").trim().length : -1;
      });
    });

    await writeArtifact("S3.PM1", JSON.stringify(lengths));
    expect(lengths.length).toBeGreaterThan(0);
    // 全部 >= 1（fixture 故意都填了 narrative；脏数据除外由别处测）
    for (const len of lengths) {
      expect(len).toBeGreaterThanOrEqual(1);
    }
  });
});

// ============================================================================
// S6.PM1 / S6.PM2：当日流末尾 wallpaper-card + save-hint
// ============================================================================
describe("[S6.PM1/S6.PM2] 当日流末尾 wallpaper-card 含 img + save-hint", () => {
  it("day-index=0 最后单元 data-role=wallpaper-card", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // 触发挂载（今日已首屏，但确保 wallpaper 单元挂上）
    await page.waitForTimeout(500);

    const lastRole = await page.evaluate(() => {
      const units = Array.from(document.querySelectorAll('[data-stream-unit][data-day-index="0"]'));
      const last = units[units.length - 1];
      return last ? last.getAttribute("data-role") : null;
    });

    await writeArtifact("S6.PM1", String(lastRole));
    expect(lastRole).toBe("wallpaper-card");
  });

  it("wallpaper-card 含可保存 img + 下载按钮（save-hint 已契约演进删除）", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector('[data-role="wallpaper-card"]', { timeout: 8000 });

    const card = page.locator('[data-role="wallpaper-card"]').first();
    const img = card.locator("img").first();
    const src = await img.getAttribute("src");
    // 契约演进（2026-08-29，state.md 实现计划 3 / testing.md [2026-07-02] 协议）：「长按图片保存到相册」
    // 提示（save-hint）被下载按钮覆盖且优于长按语义，机械同步反转为 save-hint 不存在 + 下载按钮存在。
    const saveHintExists = await card.locator('[data-role="save-hint"]').count();
    const downloadBtnExists = await card
      .locator('[data-role="wallpaper-download-portrait"]')
      .count();

    await writeArtifact("S6.PM2", JSON.stringify({ src, saveHintExists, downloadBtnExists }));
    expect(src, "wallpaper-card img src 非空").toBeTruthy();
    expect(src!.length).toBeGreaterThanOrEqual(1);
    expect(saveHintExists, "save-hint 必须不存在（契约演进）").toBe(0);
    expect(
      downloadBtnExists,
      "wallpaper-download-portrait 按钮必须存在（取代 save-hint）",
    ).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// S7.PM1：无壁纸天流末尾非 wallpaper-card
// ============================================================================
describe("[S7.PM1] 无壁纸天流末尾非 wallpaper-card", () => {
  it("day-index=2（fixture 无壁纸天）流末尾单元 data-role != wallpaper-card", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // 触发挂载到 day-index=2（前天，fixture 设无壁纸）。
    // window.scrollBy 无效（body overflow:hidden）；stream 的 scroll-snap-stop:always 会阻止
    // scrollBy 越过当前单元，故直接设 scrollTop=scrollHeight 强制触底，触发 sentinel IO 增量挂载下一天。
    for (let i = 0; i < 10; i++) {
      await scrollStreamToBottom(page);
      await page.waitForTimeout(400);
    }

    const lastRole = await page.evaluate(() => {
      const units = Array.from(document.querySelectorAll('[data-stream-unit][data-day-index="2"]'));
      const last = units[units.length - 1];
      return last ? last.getAttribute("data-role") : null;
    });

    await writeArtifact("S7.PM1", String(lastRole));
    expect(lastRole, "无壁纸天应有挂载单元").not.toBeNull();
    expect(lastRole).not.toBe("wallpaper-card");
  });
});

// ============================================================================
// S8.PM1 / S8.PM3：takenAt 缺失/脏字符串 dateline 不渲染
// ============================================================================
describe("[S8.PM1/S8.PM3] takenAt 缺失/脏字符串 dateline 不渲染", () => {
  it("S8.PM1：data-takenat-absent=true 的单元无 dateline 节点（或空）", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // fixture rank 5 注入了 takenAt=null → 应标记 data-takenat-absent="true"
    const result = await page.evaluate(() => {
      const absent = document.querySelector('[data-stream-unit][data-takenat-absent="true"]');
      if (!absent) return { found: false };
      const dateline = absent.querySelector('[data-role="dateline"]');
      return {
        found: true,
        datelineExists: !!dateline,
        datelineText: dateline ? (dateline.textContent ?? "").trim() : "",
      };
    });

    await writeArtifact("S8.PM1", JSON.stringify(result));
    expect(
      result.found,
      "fixture rank5 注入 takenAt=null，应至少有一个 data-takenat-absent=true 单元",
    ).toBe(true);
    // dateline 节点不存在 OR textContent 为空
    expect(result.datelineExists === false || result.datelineText === "").toBe(true);
  });

  it("S8.PM3：takenAt='undefined' 脏字符串单元 dateline 同样不渲染", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // fixture rank 10 注入 takenAt="undefined" —— 蓝队应把脏字符串也标 absent 或 dateline 为空
    // 红队断言：rank 10 单元的 dateline 节点不存在或文本为空
    const result = await page.evaluate(() => {
      const rank10 = document.querySelector(
        '[data-stream-unit][data-unit-type="photo"][data-photo-rank="10"]',
      );
      if (!rank10) return { found: false };
      const dateline = rank10.querySelector('[data-role="dateline"]');
      return {
        found: true,
        datelineExists: !!dateline,
        datelineText: dateline ? (dateline.textContent ?? "").trim() : "",
      };
    });

    await writeArtifact("S8.PM3", JSON.stringify(result));
    expect(result.found, "rank 10 photo 单元必须存在").toBe(true);
    // 脏字符串 → dateline 不渲染（不存在 OR 空），且不应出现 "Invalid Date" / "undefined" / "null"
    expect(result.datelineExists === false || result.datelineText === "").toBe(true);
  });
});

// ============================================================================
// S8.PM2：全流无 null/undefined/Invalid Date 泄漏
// ============================================================================
describe("[S8.PM2] 全流无 null/undefined/Invalid Date 文本泄漏", () => {
  it("body.textContent 不匹配 'Invalid Date|undefined|null'", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // 挂载更多天
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(300);
    }

    const bodyText = await page.evaluate(() => document.body.textContent ?? "");
    const leakCount = (bodyText.match(/Invalid Date|undefined|null/g) ?? []).length;

    await writeArtifact("S8.PM2", `leakCount=${leakCount}`);
    expect(leakCount).toBe(0);
  });
});

// ============================================================================
// S9.PM1：流单元按 width/height 预留占位防 CLS（含 width=0 fallback 3/4）
// ============================================================================
describe("[S9.PM1] 占位防 CLS（width/height + width=0 fallback 3/4）", () => {
  // 设计文档：占位防 CLS 用容器 inline style="aspect-ratio: W/H"（取自 manifest），
  // 缺失（=0）时 fallback 3/4。红队不假设蓝队把 aspect-ratio 挂在 img 还是父容器，
  // 扫描 photo 单元内所有元素的 computed aspect-ratio，找到匹配的即通过。
  it("width>0 photo 单元存在元素 aspect-ratio ~= 4032/3024（容差 0.02，fixture rank1）", async ({
    page,
  }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit][data-unit-type='photo']", { timeout: 8000 });

    // fixture rank 1 是 4032x3024 → aspect-ratio = 4032/3024 ≈ 1.3333
    const result = await page.evaluate(() => {
      const unit = document.querySelector(
        '[data-stream-unit][data-unit-type="photo"][data-photo-rank="1"]',
      );
      if (!unit) return { found: false };
      // 扫描 unit 自身 + 所有子元素的 computed aspect-ratio
      const candidates = [unit, ...Array.from(unit.querySelectorAll("*"))];
      const target = 4032 / 3024;
      let best: { selector: string; ar: string; ratio: number; diff: number } | null = null;
      for (const el of candidates) {
        const ar = getComputedStyle(el).aspectRatio;
        if (!ar || ar === "auto") continue;
        // aspectRatio 可能是 "4032 / 3024" 或 "1.3333" 或 "1.3333 / 1"
        const parts = ar.split("/").map((s) => Number.parseFloat(s.trim()));
        if (parts.some((n) => Number.isNaN(n))) continue;
        const ratio = parts.length === 2 ? parts[0] / parts[1] : parts[0];
        const diff = Math.abs(ratio - target);
        if (!best || diff < best.diff) {
          best = {
            selector: (el as Element).tagName.toLowerCase() + (el.id ? `#${el.id}` : ""),
            ar,
            ratio,
            diff,
          };
        }
      }
      return { found: true, best };
    });

    await writeArtifact("S9.PM1a", JSON.stringify(result));
    expect(result.found, "rank1 photo 单元必须存在").toBe(true);
    expect(result.best, "应至少有一个元素声明 aspect-ratio").not.toBeNull();
    expect(result.best?.diff ?? 99, `最佳匹配 ${result.best?.ar} 应在容差内`).toBeLessThan(0.02);
  });

  it("width=0/height=0 photo 单元存在元素 aspect-ratio ~= 0.75（3/4 兜底，fixture rank15）", async ({
    page,
  }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    const result = await page.evaluate(() => {
      const unit = document.querySelector(
        '[data-stream-unit][data-unit-type="photo"][data-photo-rank="15"]',
      );
      if (!unit) return { found: false };
      const candidates = [unit, ...Array.from(unit.querySelectorAll("*"))];
      const target = 0.75;
      let best: { ar: string; ratio: number; diff: number } | null = null;
      for (const el of candidates) {
        const ar = getComputedStyle(el).aspectRatio;
        if (!ar || ar === "auto") continue;
        const parts = ar.split("/").map((s) => Number.parseFloat(s.trim()));
        if (parts.some((n) => Number.isNaN(n))) continue;
        const ratio = parts.length === 2 ? parts[0] / parts[1] : parts[0];
        const diff = Math.abs(ratio - target);
        if (!best || diff < best.diff) {
          best = { ar, ratio, diff };
        }
      }
      return { found: true, best };
    });

    await writeArtifact("S9.PM1b", JSON.stringify(result));
    expect(result.found, "rank 15 photo 单元必须存在").toBe(true);
    expect(result.best, "应至少有一个元素声明 aspect-ratio").not.toBeNull();
    expect(
      result.best?.diff ?? 99,
      `fallback 3/4=0.75 容差内，最佳=${result.best?.ar}`,
    ).toBeLessThan(0.02);
  });
});

// ============================================================================
// S9.PM2：original 指向 mid 尺寸图
// ============================================================================
describe("[S9.PM2] original 指向 mid 尺寸图", () => {
  it("首 photo 单元 img.currentSrc 含 -mid.jpg", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit][data-unit-type='photo']", { timeout: 8000 });

    // 蓝队实现含两张 img：.photo-blur（thumbnail 占位）+ .photo-img（original/mid 主图）。
    // 本谓词验 original 指向 mid，应读 .photo-img.currentSrc（不是 .photo-blur 的 thumb）。
    const rank1 = page
      .locator('[data-stream-unit][data-unit-type="photo"][data-photo-rank="1"] .photo-img')
      .first();
    await rank1.waitFor({ state: "attached", timeout: 5000 });

    // 等 .photo-img 加载完成（mid 替换初始空 src），多采样
    let src = "";
    for (let i = 0; i < 10; i++) {
      src = await page.evaluate(() => {
        const img = document.querySelector(
          '[data-stream-unit][data-unit-type="photo"][data-photo-rank="1"] .photo-img',
        ) as HTMLImageElement | null;
        return img?.currentSrc ?? "";
      });
      if (src.includes("-mid.jpg")) break;
      await page.waitForTimeout(400);
    }

    await writeArtifact("S9.PM2", src);
    expect(src).toContain("-mid.jpg");
  });
});

// ============================================================================
// S9.PM3：mid 失败 fallback thumbnail（fixture rank 18 original===thumbnail）
// ============================================================================
describe("[S9.PM3] mid 失败 fallback thumbnail（防 masked false-green）", () => {
  it("fixture rank 18 单元 img.currentSrc 含 -thumb.jpg AND data-load-state != error", async ({
    page,
  }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // rank 18 离屏约 18 屏，img loading="lazy" 离屏不加载 → currentSrc 为空。
    // 先 scrollIntoView 触发加载，等 .photo-img（original===thumbnail）加载完成。
    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="photo"][data-photo-rank="18"]')
        ?.scrollIntoView({ behavior: "instant", block: "center" });
    });
    await page.waitForTimeout(1500);

    // 读 .photo-img（fixture rank 18 original===thumbnail，src 直接是 thumb）
    const result = await page.evaluate(() => {
      const rank18 = document.querySelector(
        '[data-stream-unit][data-unit-type="photo"][data-photo-rank="18"]',
      );
      if (!rank18) return { found: false };
      const img = rank18.querySelector(".photo-img");
      return {
        found: true,
        currentSrc: (img as HTMLImageElement | null)?.currentSrc ?? "",
        loadState: rank18.getAttribute("data-load-state"),
      };
    });

    await writeArtifact("S9.PM3", JSON.stringify(result));
    expect(result.found, "rank 18 photo 单元必须存在").toBe(true);
    expect(result.currentSrc).toContain("-thumb.jpg");
    expect(result.loadState).not.toBe("error");
  });
});

// ============================================================================
// S10.PM1：首屏挂载 <=60
// ============================================================================
describe("[S10.PM1] 首屏挂载流单元 <=60", () => {
  it("load 事件后 [data-stream-unit] 数 <= 60", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForLoadState("load");
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    const count = await page.evaluate(() => document.querySelectorAll("[data-stream-unit]").length);

    await writeArtifact("S10.PM1", `count=${count}`);
    expect(count).toBeLessThanOrEqual(60);
  });
});

// ============================================================================
// S10.PM2：视口外图片懒加载
// ============================================================================
describe("[S10.PM2] 视口外图片懒加载", () => {
  it(">=80% 已加载 img 距视口 < 3*innerHeight", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForLoadState("load");
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // 等首屏 img 加载
    await page.waitForTimeout(2000);

    const stats = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      const completed = imgs.filter((img) => img.complete && img.naturalWidth > 0);
      const vph = window.innerHeight;
      const near = completed.filter((img) => {
        const r = img.getBoundingClientRect();
        // 距视口顶距离（含滚动后位置）
        const dist = Math.abs(r.top);
        return dist < 3 * vph;
      });
      return { total: imgs.length, completed: completed.length, near: near.length };
    });

    await writeArtifact("S10.PM2", JSON.stringify(stats));
    expect(stats.completed, "应至少有 1 张已加载 img").toBeGreaterThan(0);
    const ratio = stats.near / stats.completed;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });
});

// ============================================================================
// S14.PM1：深链 #/?date= 流内定位到该日
// ============================================================================
describe("[S14.PM1] 深链 #/?date= 流内定位", () => {
  it("访问 #/?date=<历史日> 视口首单元 data-day-date == 该日", async ({ page }) => {
    // fixture 第二天是昨日，确定其日期
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    const targetDate = manifest.days[1].pickDate; // 倒序后 days[1] 是中间一天

    await page.goto(`${STATIC_BASE}/#/?date=${targetDate}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // 等 scrollIntoView 完成
    await page.waitForTimeout(1500);

    const visible = await page.evaluate(() => {
      const vph = window.innerHeight;
      const units = Array.from(document.querySelectorAll("[data-stream-unit]"));
      const inView = units.find((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= -50 && r.top < vph * 0.5;
      });
      return inView ? inView.getAttribute("data-day-date") : null;
    });

    await writeArtifact("S14.PM1", JSON.stringify({ targetDate, visible }));
    expect(visible).toBe(targetDate);
  });
});

// ============================================================================
// S17：人脸聚焦 object-position（竖图 cover 聚焦）
// 契约：
//   - 竖图 photo（width<height）且 faceFocus 非空 → .photo-img + .photo-blur 设 inline
//     object-position: ${x*100}% ${y*100}%
//   - faceFocus=null → 默认 center（50% 50%，无 inline object-position）
//   - 横图（width>=height）→ 不设（contain 不裁）
// fixture：rank 3 竖图 faceFocus={0.5,0.26} / rank 12 竖图 faceFocus={0.2,0.8}
//          rank 7 横图（4032x3024）faceFocus=null
// ============================================================================
describe("[S17] 人脸聚焦 object-position（竖图 cover）", () => {
  it("S17.PM1：竖图 faceFocus={0.5,0.26} → .photo-img object-position 含 50% 和 26%（容差 ±2%）", async ({
    page,
  }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // rank 3 竖图（width=3024<height=4032）faceFocus={0.5,0.26} → 期望 object-position: 50% 26%
    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="photo"][data-photo-rank="3"]')
        ?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await page.waitForTimeout(800);

    const result = await page.evaluate(() => {
      const unit = document.querySelector(
        '[data-stream-unit][data-unit-type="photo"][data-photo-rank="3"]',
      );
      if (!unit) return { found: false };
      const img = unit.querySelector(".photo-img") as HTMLElement | null;
      if (!img) return { found: true, imgFound: false };
      const inline = img.style.objectPosition;
      const computed = getComputedStyle(img).objectPosition;
      return { found: true, imgFound: true, inline, computed };
    });

    await writeArtifact("S17.PM1", JSON.stringify(result));
    expect(result.found, "rank 3 photo 单元必须存在").toBe(true);
    expect(result.imgFound, "rank 3 .photo-img 必须存在").toBe(true);
    // inline 或 computed 含 50% 和 26%（容差 ±2%：26% 范围 [24,28]）
    const src = result.inline || result.computed || "";
    expect(
      src,
      `object-position 应非空，inline=${result.inline} computed=${result.computed}`,
    ).toBeTruthy();
    // 解析 x% / y% 两个数值
    const m = src.match(/([\d.]+)%\s+([\d.]+)%/);
    expect(m, `object-position 应是 "x% y%" 格式，实际=${src}`).not.toBeNull();
    const xPct = Number(m![1]);
    const yPct = Number(m![2]);
    expect(Math.abs(xPct - 50), `x%=${xPct} 应 ≈ 50`).toBeLessThanOrEqual(2);
    expect(Math.abs(yPct - 26), `y%=${yPct} 应 ≈ 26（容差 ±2）`).toBeLessThanOrEqual(2);
  });

  it("S17.PM2：faceFocus=null（rank 7 横图）→ .photo-img 无 inline object-position 或为 50% 50%", async ({
    page,
  }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // rank 7 默认横图（4032x3024）faceFocus=null
    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="photo"][data-photo-rank="7"]')
        ?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await page.waitForTimeout(800);

    const result = await page.evaluate(() => {
      const unit = document.querySelector(
        '[data-stream-unit][data-unit-type="photo"][data-photo-rank="7"]',
      );
      if (!unit) return { found: false };
      const img = unit.querySelector(".photo-img") as HTMLElement | null;
      if (!img) return { found: true, imgFound: false };
      return { found: true, imgFound: true, inline: img.style.objectPosition };
    });

    await writeArtifact("S17.PM2", JSON.stringify(result));
    expect(result.found, "rank 7 photo 单元必须存在").toBe(true);
    expect(result.imgFound, "rank 7 .photo-img 必须存在").toBe(true);
    // faceFocus=null → 无 inline object-position（空串）OR 显式 50% 50%
    const inline = result.inline ?? "";
    const isDefault = inline === "" || inline === "50% 50%";
    expect(
      isDefault,
      `faceFocus=null 应默认 center，inline object-position="${inline}" 应为空或 50% 50%`,
    ).toBe(true);
  });

  it("S17.PM3：rank 3 .photo-blur object-position 与 .photo-img 一致", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="photo"][data-photo-rank="3"]')
        ?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await page.waitForTimeout(800);

    const result = await page.evaluate(() => {
      const unit = document.querySelector(
        '[data-stream-unit][data-unit-type="photo"][data-photo-rank="3"]',
      );
      if (!unit) return { found: false };
      const img = unit.querySelector(".photo-img") as HTMLElement | null;
      const blur = unit.querySelector(".photo-blur") as HTMLElement | null;
      if (!img || !blur) return { found: true, complete: false };
      const imgInline = img.style.objectPosition;
      const blurInline = blur.style.objectPosition;
      const imgComputed = getComputedStyle(img).objectPosition;
      const blurComputed = getComputedStyle(blur).objectPosition;
      return { found: true, complete: true, imgInline, blurInline, imgComputed, blurComputed };
    });

    await writeArtifact("S17.PM3", JSON.stringify(result));
    expect(result.found, "rank 3 单元必须存在").toBe(true);
    expect(result.complete, ".photo-img 和 .photo-blur 都必须存在").toBe(true);
    // 优先比对 inline；inline 都为空时比 computed
    const imgSrc = result.imgInline || result.imgComputed || "";
    const blurSrc = result.blurInline || result.blurComputed || "";
    expect(imgSrc, ".photo-img object-position 应非空").toBeTruthy();
    // blur 与 img 应一致（都是 cover 聚焦同一坐标）
    expect(blurSrc, `.photo-blur object-position=${blurSrc} 应与 .photo-img=${imgSrc} 一致`).toBe(
      imgSrc,
    );
  });
});

// ============================================================================
// S18：URL 随滑动变化（history.replaceState 不进栈）
// 契约：
//   - photo → #/?date=<dayDate>&rank=<photoRank>
//   - date-separator → #/?date=<dayDate>（无 rank）
//   - video → #/video/<videoId>
//   - wallpaper → 不改 URL
//   - 滚动停在某单元 300ms 后触发（debounce）
//   - history.replaceState（不进栈 → 连续滑 history.length 增量 ≤ 2）
// ============================================================================
describe("[S18] URL 随滑动变化（replaceState）", () => {
  it("S18.PM1：滚到 rank 12 等 500ms → hash 含 date=<今日> AND rank=12", async ({ page }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    const todayDate = manifest.days[0].pickDate;

    // rank 12 竖图 faceFocus={0.2,0.8}（今日）
    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="photo"][data-photo-rank="12"]')
        ?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    // 等 debounce 300ms + 余量
    await page.waitForTimeout(500);

    const hash = await page.evaluate(() => location.hash);
    await writeArtifact("S18.PM1", JSON.stringify({ todayDate, hash }));
    expect(hash, `hash=${hash} 应含 date=${todayDate}`).toContain(`date=${todayDate}`);
    expect(hash, `hash=${hash} 应含 rank=12`).toContain("rank=12");
  });

  it("S18.PM2：滚到某 date-separator 等 500ms → hash 为 #/?date=<该日>（无 rank）", async ({
    page,
  }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    // 找第一个 date-separator（倒序第二天 = 昨日）
    const targetDate = await page.evaluate(() => {
      const sep = document.querySelector('[data-stream-unit][data-unit-type="date-separator"]');
      return sep ? sep.getAttribute("data-day-date") : null;
    });
    expect(targetDate, "应至少有一个 date-separator").not.toBeNull();

    await page.evaluate(() => {
      document
        .querySelector('[data-stream-unit][data-unit-type="date-separator"]')
        ?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await page.waitForTimeout(500);

    const hash = await page.evaluate(() => location.hash);
    await writeArtifact("S18.PM2", JSON.stringify({ targetDate, hash }));
    expect(hash, `hash=${hash} 应含 date=${targetDate}`).toContain(`date=${targetDate}`);
    expect(hash, "date-separator 不应有 rank").not.toContain("rank=");
  });

  it("S18.PM3：访问 #/?date=<昨日>&rank=3 等 1500ms → 视口首 photo 单元 dayDate==昨日 AND photoRank==3", async ({
    page,
  }) => {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    const yesterdayDate = manifest.days[1].pickDate; // 倒序第二天

    await page.goto(`${STATIC_BASE}/#/?date=${yesterdayDate}&rank=3`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // 等深链 scrollIntoView 完成
    await page.waitForTimeout(1500);

    const visible = await page.evaluate(() => {
      const vph = window.innerHeight;
      const photos = Array.from(
        document.querySelectorAll('[data-stream-unit][data-unit-type="photo"]'),
      );
      const inView = photos.find((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= -50 && r.top < vph * 0.5;
      });
      return inView
        ? {
            dayDate: inView.getAttribute("data-day-date"),
            photoRank: inView.getAttribute("data-photo-rank"),
          }
        : null;
    });

    await writeArtifact("S18.PM3", JSON.stringify({ yesterdayDate, visible }));
    expect(visible, "视口内应有一个 photo 单元").not.toBeNull();
    expect(visible?.dayDate, `dayDate=${visible?.dayDate} 应 == 昨日 ${yesterdayDate}`).toBe(
      yesterdayDate,
    );
    expect(visible?.photoRank, `photoRank=${visible?.photoRank} 应 == 3`).toBe("3");
  });

  it("S18.PM4：连续滑过 5 单元 → history.length 增量 ≤ 2（replaceState 不进栈）", async ({
    page,
  }) => {
    await page.goto(`${STATIC_BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });

    const initialLen = await page.evaluate(() => history.length);

    // 连续滑过 5 个 photo 单元，每个等 debounce
    for (let i = 0; i < 5; i++) {
      await page.evaluate((idx) => {
        const photos = document.querySelectorAll('[data-stream-unit][data-unit-type="photo"]');
        const target = photos[idx + 1]; // 从 rank 2 开始滑
        target?.scrollIntoView({ behavior: "instant", block: "start" });
      }, i);
      await page.waitForTimeout(500);
    }

    const finalLen = await page.evaluate(() => history.length);
    const delta = finalLen - initialLen;
    await writeArtifact("S18.PM4", JSON.stringify({ initialLen, finalLen, delta }));
    expect(delta, `history.length 增量=${delta} 应 ≤ 2（replaceState 不进栈）`).toBeLessThanOrEqual(
      2,
    );
  });
});

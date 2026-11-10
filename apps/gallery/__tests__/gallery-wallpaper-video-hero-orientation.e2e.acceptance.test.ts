/**
 * 验收测试：画廊主视频朝向自适应 — 方图/横版 hero → 16:9 杂志卡；竖版 hero → 竖版卡（20261110 方图翻转）
 *
 * 20261110 蓝队迁移注记：本套件原为 20261023 朝向自适应红队验收（方图归竖版分支），
 * 按需求《20261110-直接实现》state.md 翻转方图分支——方图（宽高比 [0.9,1.1] 双闭区间）
 * 改为 16:9 杂志卡优先（0 裁切纸底 letterbox），竖版卡降为兜底；横版/竖版/维度缺失
 * 三分支行为逐字不变。契约权威 = state.md §契约规约 M1-M4，谓词编号亦换轨到新 state.md。
 *
 * 对应谓词（state.md §验收场景，冻结 SSOT）：
 *   - 场景 1.P1 [det-machine]：方图 hero 日壁纸卡自动播放 16:9 横版杂志卡
 *     （video src contains "_native.mp4" && not contains "_portrait.mp4"）
 *   - 场景 1.P3 [visual-residue]：方图日 16:9 卡 contain 纸底 letterbox 截图 + 二值清单
 *   - 场景 2.P1 [det-machine]：方图日主钮「保存视频」取回 16:9 卡（fetchLog 断言）
 *   - 场景 3.P1 [det-machine]：竖版 hero 日仍自动播放竖版卡（回归护栏）
 *   - 场景 4.P1 [det-machine]：横版 hero 日仍自动播放 16:9 卡（回归护栏，real-process 探针）
 *   - 场景 5.P1/P2/P3 [det-machine]：方图判定边界——r=0.9 / r=1.1 闭端点归方图（native）、
 *     r=0.89 带外归竖版（portrait）；r=1.11 带外与 1.1 同源观测（均 native），防分类回归
 *   - 场景 6.P1/P2 [det-machine]：方图日「更多」菜单保留「保存竖版视频」且仍指向竖版卡（M3）
 *   - 场景 7.P1 [det-machine]：hero 维度缺失 → 兜底基线 native 优先，不误判为方图分支
 *   - 场景 8.P1 [det-machine]：零视频字段日 → 静态卡回退（回归护栏）
 *   - 契约 M1/M4 补面：landscape-only 变体日（native+portrait 皆缺 → 第三兜底 .mov）；
 *     方图 hero 无 portrait 字段（0928~1008 存量日）→ native 兜底语义不变
 *   - 回归护栏（非谓词）：竖版卡 visual-residue 截图、404 静态卡重渲零 JS 错误、
 *     竖版日/横版日主钮保存数据源、竖版卡 UX 启发式走查、EXIF 旋转对
 *     （3024×4032 vs 4032×3024 由场景 3.P1/4.P1 用例锚定分归竖版/横版分支）
 *
 * 部署侧谓词（场景 1.P2 相邻日滑动进入、9.P1 ux-exploration 真实驱动，merge 阶段补验）不在本文件。
 *
 * 黑盒 DOM 契约锚点（既有先例）：[data-stream-unit][data-unit-type="wallpaper"][data-day-date]
 * / data-has-video / data-fill（smart-fill cover|contain）/ .wallpaper-stage /
 * [data-role^="wallpaper-download"] / [data-role="more-menu"]（popover 常驻 DOM 初始 hidden）/
 * #/?date= 深链落当日壁纸卡。
 * driver = 本地 fixture manifest + 真实 mp4（native 1280×720 16:9 由 ffmpeg 现造——ffmpeg
 * 为项目硬依赖，缺失即真红；portrait 用 fixtures 既有 736×1600 样本 = 真实竖版卡比例档；
 * landscape 档复用 native 母带字节落 .mov 文件名 = mp4 容器 QuickTime 双兼容），
 * python3 http.server --bind 127.0.0.1（隔离临时目录；端口 8796 避开先例 8794/8795 与
 * webServer 8088；套件间 workers=1 串行）。
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
/** portrait 卡样本：fixtures 既有 736×1600 竖版壁纸视频（1290×2796 比例档，Chromium 可解码） */
const PORTRAIT_SAMPLE = path.join(__dirname, "fixtures", "wallpaper-portrait-736x1600.mp4");

const PORT_ORIENT = 8796; // 朝向自适应矩阵站（先例 8794/8795 已占用，webServer 8088 避开）
const BASE = `http://127.0.0.1:${PORT_ORIENT}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

/** native 卡 = 16:9 杂志卡语义档（20261009 排版解耦恒产出 1920×1080，fixture 等比 1280×720） */
const NATIVE_W = 1280;
const NATIVE_H = 720;

// ---- fixture 日期（UTC 偏移派生，manifest 与断言同源）----
const dateOffset = (offset: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
};

interface DaySpec {
  key: string;
  date: string;
  title: string;
  /** hero（photos[0]）显示维度——契约 M2 的朝向信号 */
  heroW: number;
  heroH: number;
  native: boolean;
  portrait: boolean;
  /** M1 第三兜底链用：仅 landscape（Aerial .mov）字段日 */
  landscape?: boolean;
}

/**
 * 契约 M2 全矩阵 fixture（13 日，20261110 方图翻转版）：
 *   portrait          竖版 hero（r=0.75）     双卡 → 期望 portrait 胜出（回归护栏）
 *   square            方图 hero（r=1.0）      双卡 → 期望 native 胜出（20261110 翻转）
 *   landscape         横版 hero（r=1.333）    双卡 → 期望 native 胜出（现状不回归）
 *   missingDims       维度缺失（w/h 有 0）    双卡 → 期望兜底基线 native 优先（不得误判方图）
 *   portraitNoCard    竖版 hero 仅 native     → 回退链 portrait>native 落 native，仍动态
 *   landscapeNoCard   横版 hero 仅 portrait   → 回退链 native>portrait 落 portrait，仍动态
 *   noVideo           竖版 hero 零视频字段    → 静态卡回退（M1）
 *   squareLowEdge     方图下边界 r=0.9        双卡 → 闭端点归方图 → native（场景5.P1）
 *   squareHighEdge    方图上边界 r=1.1        双卡 → 闭端点归方图 → native（场景5.P2）
 *   belowSquare       r=0.89 带外             双卡 → 归竖版分支 → portrait（场景5.P3）
 *   aboveSquare       r=1.11 带外             双卡 → 归横版分支 → native（与 1.1 同源观测，防分类回归）
 *   squareLandscapeOnly 方图 hero 仅 landscape → M1 第三兜底落 .mov，仍动态
 *   squareNoPortrait  方图 hero 仅 native     → M4 存量日（0928~1008 无 portrait 字段）native 兜底不变
 * EXIF 旋转对：portrait（3024×4032）与 landscape（4032×3024）互为旋转变换对，
 * photos 表未做宽高互换——两分支判定由场景 3.P1 / 4.P1 用例锚定。
 */
const DAY_SPECS: DaySpec[] = [
  {
    key: "portrait",
    date: dateOffset(0),
    title: "朝向自适应 · 竖版日",
    heroW: 3024,
    heroH: 4032,
    native: true,
    portrait: true,
  },
  {
    key: "square",
    date: dateOffset(1),
    title: "朝向自适应 · 方图日",
    heroW: 1080,
    heroH: 1080,
    native: true,
    portrait: true,
  },
  {
    key: "landscape",
    date: dateOffset(2),
    title: "朝向自适应 · 横版日",
    heroW: 4032,
    heroH: 3024,
    native: true,
    portrait: true,
  },
  {
    key: "missingDims",
    date: dateOffset(3),
    title: "朝向自适应 · 维度缺失日",
    heroW: 0,
    heroH: 0,
    native: true,
    portrait: true,
  },
  {
    key: "portraitNoCard",
    date: dateOffset(4),
    title: "朝向自适应 · 竖版缺竖卡日",
    heroW: 3024,
    heroH: 4032,
    native: true,
    portrait: false,
  },
  {
    key: "landscapeNoCard",
    date: dateOffset(5),
    title: "朝向自适应 · 横版缺横卡日",
    heroW: 4032,
    heroH: 3024,
    native: false,
    portrait: true,
  },
  {
    key: "noVideo",
    date: dateOffset(6),
    title: "朝向自适应 · 无视频日",
    heroW: 3024,
    heroH: 4032,
    native: false,
    portrait: false,
  },
  {
    key: "squareLowEdge",
    date: dateOffset(7),
    title: "朝向自适应 · 方图下边界日",
    heroW: 900,
    heroH: 1000,
    native: true,
    portrait: true,
  },
  {
    key: "squareHighEdge",
    date: dateOffset(8),
    title: "朝向自适应 · 方图上边界日",
    heroW: 1100,
    heroH: 1000,
    native: true,
    portrait: true,
  },
  {
    key: "belowSquare",
    date: dateOffset(9),
    title: "朝向自适应 · 带外竖版日",
    heroW: 890,
    heroH: 1000,
    native: true,
    portrait: true,
  },
  {
    key: "aboveSquare",
    date: dateOffset(10),
    title: "朝向自适应 · 带外横版日",
    heroW: 1110,
    heroH: 1000,
    native: true,
    portrait: true,
  },
  {
    key: "squareLandscapeOnly",
    date: dateOffset(11),
    title: "朝向自适应 · 方图仅横版卡日",
    heroW: 1080,
    heroH: 1080,
    native: false,
    portrait: false,
    landscape: true,
  },
  {
    key: "squareNoPortrait",
    date: dateOffset(12),
    title: "朝向自适应 · 方图缺竖卡日",
    heroW: 1080,
    heroH: 1080,
    native: true,
    portrait: false,
  },
];

const daySpec = (key: string): DaySpec => {
  const spec = DAY_SPECS.find((d) => d.key === key);
  if (!spec) throw new Error(`未知 day spec: ${key}`);
  return spec;
};

/** 契约 M1 输入字段名逐字：wallpaperVideoNative / wallpaperVideoPortrait / wallpaperVideoLandscape */
const nativeRelPath = (spec: DaySpec): string => `videos/${spec.date}_native.mp4`;
const portraitRelPath = (spec: DaySpec): string => `videos/${spec.date}_portrait.mp4`;
const landscapeRelPath = (spec: DaySpec): string => `videos/${spec.date}_landscape.mov`;
const nativeUrl = (spec: DaySpec): string => new URL(nativeRelPath(spec), `${BASE}/`).href;
const portraitUrl = (spec: DaySpec): string => new URL(portraitRelPath(spec), `${BASE}/`).href;
const landscapeUrl = (spec: DaySpec): string => new URL(landscapeRelPath(spec), `${BASE}/`).href;

// ---- fixture 占位 JPEG（既有先例同款 base64，零运行时依赖）----
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcXGRolJicoKSo0NTY3ODk6M0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwAAAwEBAgEBAQEBAQAAAAEAAgIDAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmGmaq6OkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3iigoAKKKKACiiigA/9k=";
const WP_LANDSCAPE_JPEG_B64 =
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAEAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJAA/9k=";
const WP_PORTRAIT_JPEG_B64 =
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJAAP//Z";

function writeJpeg(filePath: string, b64: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
}

function buildFixture(): string {
  const dir = path.join(os.tmpdir(), `relight-gallery-orient-e2e-${PORT_ORIENT}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["index.html", "app.css", "app.js"]) {
    fs.copyFileSync(path.join(SRC_GALLERY_DIR, f), path.join(dir, f));
  }
  const fontsDir = path.join(SRC_GALLERY_DIR, "fonts");
  if (fs.existsSync(fontsDir)) {
    fs.cpSync(fontsDir, path.join(dir, "fonts"), { recursive: true });
  }

  // native 卡：ffmpeg 现造一段 16:9 真实 mp4，逐日复制为 <date>_native.mp4（红队铁律：
  // fixture 失败即真红，不静默跳过）
  fs.mkdirSync(path.join(dir, "videos"), { recursive: true });
  const nativeMaster = path.join(dir, "videos", `_master-native-${NATIVE_W}x${NATIVE_H}.mp4`);
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
      nativeMaster,
    ],
    { encoding: "utf-8", timeout: 60000 },
  );
  if (r.status !== 0 || !fs.existsSync(nativeMaster)) {
    throw new Error(`ffmpeg 造 native fixture 失败（红队铁律：fixture 失败即真红）: ${r.stderr}`);
  }

  const days = DAY_SPECS.map((spec) => {
    // 每日壁纸图两档（静态卡/模糊垫底封面共用，字段名逐字：wallpaperLandscape / wallpaperPortrait）
    const wpLandscape = `wallpapers/${spec.date}_v2-contain-default.jpg`;
    const wpPortrait = `wallpapers/${spec.date}_v2-contain-1290x2796.jpg`;
    writeJpeg(path.join(dir, wpLandscape), WP_LANDSCAPE_JPEG_B64);
    writeJpeg(path.join(dir, wpPortrait), WP_PORTRAIT_JPEG_B64);

    if (spec.native) fs.copyFileSync(nativeMaster, path.join(dir, nativeRelPath(spec)));
    if (spec.portrait) fs.copyFileSync(PORTRAIT_SAMPLE, path.join(dir, portraitRelPath(spec)));
    // landscape 档（Aerial .mov）：复用 native 母带字节（mp4 容器 QuickTime 双兼容，
    // Chromium 按内容 demux；python http.server 对 .mov 回 video/quicktime 不影响播放）
    if (spec.landscape) fs.copyFileSync(nativeMaster, path.join(dir, landscapeRelPath(spec)));

    const mkPhoto = (rank: number, width: number, height: number) => {
      const id = `photo-${spec.date}-${String(rank).padStart(2, "0")}`;
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
        width,
        height,
      };
    };

    return {
      pickDate: spec.date,
      title: spec.title,
      narrative: `${spec.title}的整体叙事。`,
      wallpaperLandscape: wpLandscape,
      wallpaperPortrait: wpPortrait,
      // photos[0] = hero：width/height 为契约 C1 的朝向信号（维度缺失日 w/h 有 0）
      photos: [mkPhoto(1, spec.heroW, spec.heroH), mkPhoto(2, 4032, 3024)],
      ...(spec.native ? { wallpaperVideoNative: nativeRelPath(spec) } : {}),
      ...(spec.portrait ? { wallpaperVideoPortrait: portraitRelPath(spec) } : {}),
      ...(spec.landscape ? { wallpaperVideoLandscape: landscapeRelPath(spec) } : {}),
    };
  });
  fs.rmSync(nativeMaster, { force: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    days,
    videos: [] as Array<Record<string, unknown>>,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

// ---- 静态服务（--bind 127.0.0.1，规避 dual-stack 坑，既有惯例）----

const servers: ChildProcess[] = [];
let fixtureDir = "";

async function startStaticServer(port: number, dir: string): Promise<void> {
  const proc = spawn(
    "python3",
    ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", dir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  servers.push(proc);
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
  fixtureDir = buildFixture();
  await startStaticServer(PORT_ORIENT, fixtureDir);
}, 60000);

afterAll(async () => {
  for (const s of servers) s.kill("SIGTERM");
  if (fixtureDir) {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // fetch 直链日志（保存视频主钮数据源断言用；不依赖 app.js 内部）
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

// ---- DOM 契约锚点（既有红队先例同款）----

const wallpaperCardSel = (date: string) =>
  `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${date}"]`;

/** 深链 `#/?date=` 打开目标日（无 rank 深链优先落该日壁纸卡，既有 DL/DW 契约）并等媒体就绪 */
async function openWallpaperDay(page: Page, date: string): Promise<void> {
  await page.goto(`${BASE}/#/?date=${date}`);
  await page.waitForSelector(wallpaperCardSel(date), { timeout: 12000 });
  await page.evaluate((d) => {
    document
      .querySelector(`[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`)
      ?.scrollIntoView({ behavior: "instant", block: "center" });
  }, date);
  // bounded 等待动态变体起播（动态日）；静态日轮询即刻通过（无 video 时跳过）
  await page.waitForFunction(
    (d) => {
      const v = document.querySelector(
        `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"] video`,
      ) as HTMLVideoElement | null;
      return !v || (v.readyState >= 2 && !v.paused);
    },
    date,
    { timeout: 15000 },
  );
  await page.waitForTimeout(400); // 派生样式/布局稳定
}

interface VideoState {
  cardExists: boolean;
  hasVideoAttr: string | null;
  videoExists: boolean;
  /** smart-fill 机读态（cover|contain，元数据就绪前置空） */
  fill: string | null;
  src: string | null;
  readyState: number;
  paused: boolean | null;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  clientWidth: number;
  clientHeight: number;
  muted: boolean | null;
  loop: boolean | null;
  playsinline: boolean;
  objectFit: string;
}

async function readVideoState(page: Page, date: string): Promise<VideoState> {
  return page.evaluate((d) => {
    const card = document.querySelector(
      `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`,
    );
    const v = card?.querySelector("video") as HTMLVideoElement | null;
    return {
      cardExists: !!card,
      hasVideoAttr: card?.getAttribute("data-has-video") ?? null,
      videoExists: !!v,
      // smart-fill 机读态（cover|contain）：方图日 16:9 卡在竖版视口 → contain（0 裁切 letterbox）
      fill: card?.getAttribute("data-fill") ?? null,
      src: v?.src ?? null,
      readyState: v?.readyState ?? 0,
      paused: v ? v.paused : null,
      duration: v?.duration ?? 0,
      videoWidth: v?.videoWidth ?? 0,
      videoHeight: v?.videoHeight ?? 0,
      clientWidth: v?.clientWidth ?? 0,
      clientHeight: v?.clientHeight ?? 0,
      muted: v ? v.muted : null,
      loop: v ? v.loop : null,
      playsinline: v ? v.hasAttribute("playsinline") : false,
      objectFit: v ? getComputedStyle(v).objectFit || "fill" : "none",
    };
  }, date);
}

// ---- ffprobe 探测（场景 1.P3 / 2.P2 / 3.P1 谓词 driver：node-script:probe-downloaded-file）----

interface ProbeResult {
  status: number;
  contentType: string;
  contentLength: number;
  width: number;
  height: number;
}

function probeVideoFile(filePath: string): { width: number; height: number } {
  const r = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf-8", timeout: 30000 },
  );
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`ffprobe 探测失败（红队铁律：fixture 工具缺失即真红）: ${r.stderr}`);
  }
  const parsed = JSON.parse(r.stdout) as { streams?: Array<{ width?: number; height?: number }> };
  const stream = parsed.streams?.[0];
  return { width: stream?.width ?? 0, height: stream?.height ?? 0 };
}

async function downloadAndProbe(url: string): Promise<ProbeResult> {
  const res = await fetch(url);
  const status = res.status;
  const contentType = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(
    os.tmpdir(),
    `relight-orient-e2e-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
  );
  fs.writeFileSync(tmp, buf);
  try {
    const dims = probeVideoFile(tmp);
    return { status, contentType, contentLength: buf.length, ...dims };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ============================================================================
// 场景 3.P1 [det-machine]：竖版 hero 日 → 主视频为竖版卡（portrait > native，回归护栏）
// ============================================================================

describe("[场景3.P1 回归护栏] 竖版 hero 日 → 主视频=竖版卡（portrait>native）", () => {
  it("3.P1: 动态变体以 video 元素渲染且元数据就绪（data-has-video=1 ∧ duration>0 ∧ readyState≥2）∧ src==manifest wallpaperVideoPortrait 字段", async ({
    page,
  }) => {
    const spec = daySpec("portrait");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.cardExists, "竖版日壁纸卡必须挂载").toBe(true);
    expect(state.hasVideoAttr, '动态变体必须 data-has-video="1"').toBe("1");
    expect(state.videoExists, "动态变体必须以 <video> 元素渲染").toBe(true);
    // 谓词字面量（3.P1）：元数据就绪可播 → duration > 0（readyState≥2 为就绪前提）
    expect(state.duration, "视频元数据必须就绪（duration > 0）").toBeGreaterThan(0);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
    expect(state.paused, "动态变体必须在播").toBe(false);

    // 契约 M2 字面量：竖版 hero（r<0.9）→ portrait > native——src 必须等于 manifest
    // wallpaperVideoPortrait 字段值，且绝不能取到 native（方图翻转外溢到竖版分支时此断言红）
    expect(state.src, "竖版日视频 src 必须取 portrait 卡").toBe(portraitUrl(spec));
    await writeArtifact("s3p1", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });

  it("3.P1 探针: 已下载的主视频产物 ffprobe 探测为竖版（width < height）", async ({ page }) => {
    const spec = daySpec("portrait");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);
    expect(state.src, "主视频 URL 必须非空").not.toBeNull();

    const probe = await downloadAndProbe(state.src!);
    // 探针字面量：width < height
    expect(probe.status, "主视频资源必须可达").toBe(200);
    expect(probe.width, `主视频必须为竖版（实际 ${probe.width}x${probe.height}）`).toBeLessThan(
      probe.height,
    );
    await writeArtifact("s3p1-probe", JSON.stringify({ url: state.src, ...probe }, null, 2));
  });
});

// ============================================================================
// 回归护栏 [visual-residue]：竖版动态变体截图 + 二值清单（留 QA 真机判定）
// ============================================================================

describe("[回归护栏] VISUAL_RESIDUE：竖版壁纸卡截图 + 二值清单", () => {
  // VISUAL_RESIDUE: 留 QA 真机判定——截图与清单为人工判定辅助，非免自动化金牌
  it("竖版动态变体播放中元素截图落 artifact + 二值清单，video 渲染占位非零且竖版成型", async ({
    page,
  }) => {
    const spec = daySpec("portrait");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);
    expect(state.videoExists, "竖版日必须有动态变体").toBe(true);

    // 自动化代理断言：渲染占位非零，且渲染矩形为竖版成型（横版卡回退即红）
    const box = await page.locator(wallpaperCardSel(spec.date)).locator("video").boundingBox();
    expect(box, "video 元素必须有渲染占位").not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);
    expect(
      (box?.height ?? 0) > (box?.width ?? 0),
      `渲染矩形必须竖版成型（实际 ${box?.width}x${box?.height}）`,
    ).toBe(true);

    const card = page.locator(wallpaperCardSel(spec.date)).first();
    const shotPath = path.join(ARTIFACT_DIR, "s3p5-portrait-wallpaper-card.png");
    await card.screenshot({ path: shotPath });

    const checklist = [
      "s3p5 二值清单（VISUAL_RESIDUE: 留 QA 真机判定）",
      `截图: ${shotPath}`,
      "fixture: portrait 卡 736×1600（1290×2796 比例档），视口 390×844",
      "- [ ] 画面比例 == 视频原生比例（无横向压扁/纵向拉伸）",
      "- [ ] 无异常黑边（展示区与卡片/文字栏对齐，模糊垫底自然）",
      "- [ ] 无错位裁切（主体不被异常裁掉，排版文字可读）",
      "QA 结论（Y/N）: ____",
    ].join("\n");
    await writeArtifact("s3p5", checklist);

    expect(fs.existsSync(shotPath), "截图必须落 artifact 目录").toBe(true);
    expect(fs.statSync(shotPath).size, "截图必须非空").toBeGreaterThan(0);
  });
});

// ============================================================================
// 场景 1.P1 [det-machine] + 1.P3 [visual-residue]：方图 hero 日 → 16:9 杂志卡
// （20261110 翻转：[0.9,1.1] 带归方图分支，native 优先——0 裁切纸底 letterbox）
// ============================================================================

describe("[场景1.P1] 方图 hero 日 → 16:9 杂志卡（20261110 翻转）", () => {
  it("1.P1: 自动播放 16:9 横版杂志卡（src==native 字段 ∧ 非竖版卡 ∧ smart-fill contain 纸底 letterbox）", async ({
    page,
  }) => {
    const spec = daySpec("square");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.hasVideoAttr, '方图日动态变体必须 data-has-video="1"').toBe("1");
    // 谓词字面量（1.P1）：src contains "_native.mp4" && not contains "_portrait.mp4"
    expect(state.src, "方图日（[0.9,1.1] 带）必须归入方图分支取 native 16:9 卡").toBe(
      nativeUrl(spec),
    );
    expect(state.src, "方图日不得再取竖版卡").not.toContain("_portrait.mp4");
    expect(state.paused, "动态变体必须在播").toBe(false);
    // 元数据面佐证：16:9 卡 videoWidth > videoHeight（竖版卡回退即红）
    expect(
      state.videoWidth,
      `方图日主视频必须为横版 16:9（实际 ${state.videoWidth}x${state.videoHeight}）`,
    ).toBeGreaterThan(state.videoHeight);
    // smart-fill 机读态：16:9 卡在竖版视口 cropRatio≈0.74 > 0.3 → contain（0 裁切纸底 letterbox；
    // 旧竖版卡近满贴 → cover——此断言同时杀「翻转未生效」与「翻转但展示策略错」两类 No-op）
    expect(state.fill, "方图日 16:9 卡必须走 contain（纸底 letterbox，0 裁切）").toBe("contain");
    await writeArtifact("s1p1", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });

  it("1.P1 探针: 主视频产物下载 status==200 且 ffprobe 探测 width > height（fixture 替代真实 COS）", async ({
    page,
  }) => {
    const spec = daySpec("square");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);
    expect(state.src).not.toBeNull();

    const probe = await downloadAndProbe(state.src!);
    // 探针字面量：status == 200 && width > height
    expect(probe.status).toBe(200);
    expect(probe.contentLength, "资源必须非空").toBeGreaterThan(0);
    expect(
      probe.width,
      `方图日主视频必须为横版 16:9（实际 ${probe.width}x${probe.height}）`,
    ).toBeGreaterThan(probe.height);
    await writeArtifact("s1p1-probe", JSON.stringify({ url: state.src, ...probe }, null, 2));
  });
});

// ============================================================================
// 场景 1.P3 [visual-residue]：方图日 16:9 卡 contain 纸底 letterbox 截图 + 二值清单
// ============================================================================

describe("[场景1.P3] VISUAL_RESIDUE：方图日 16:9 卡截图 + 二值清单", () => {
  // VISUAL_RESIDUE: 留 QA 真机判定——截图与清单为人工判定辅助，非免自动化金牌
  it("16:9 卡播放中卡片截图落 artifact + 二值清单，渲染占位非零且 contain letterbox", async ({
    page,
  }) => {
    const spec = daySpec("square");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);
    expect(state.videoExists, "方图日必须有动态变体").toBe(true);
    expect(state.fill, "contain letterbox 前提").toBe("contain");

    // 自动化代理断言：渲染占位非零（letterbox 形态由 fill=contain + ffprobe 横版双锚定）
    const box = await page.locator(wallpaperCardSel(spec.date)).locator("video").boundingBox();
    expect(box, "video 元素必须有渲染占位").not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    const card = page.locator(wallpaperCardSel(spec.date)).first();
    const shotPath = path.join(ARTIFACT_DIR, "s1p3-square-native-card.png");
    await card.screenshot({ path: shotPath });

    const checklist = [
      "s1p3 二值清单（VISUAL_RESIDUE: 留 QA 真机判定）",
      `截图: ${shotPath}`,
      "fixture: native 卡 1280×720（16:9 杂志卡档），视口 390×844，smart-fill=contain",
      "- [ ] 出现纸底 letterbox 条（上下留白垫底）且人物主体完整在画框内（0 裁切）",
      "- [ ] 画面比例 == 视频原生比例（无横向压扁/纵向拉伸）",
      "- [ ] 无异常黑边（展示区与卡片/文字栏对齐，模糊垫底自然）",
      "QA 结论（Y/N）: ____",
    ].join("\n");
    await writeArtifact("s1p3", checklist);

    expect(fs.existsSync(shotPath), "截图必须落 artifact 目录").toBe(true);
    expect(fs.statSync(shotPath).size, "截图必须非空").toBeGreaterThan(0);
  });
});

// ============================================================================
// 场景 4.P1 [det-machine]：横版 hero 日行为不回归（native > portrait 现状维持）
// ============================================================================

describe("[场景4.P1 回归护栏] 横版 hero 日行为不回归（维持 16:9 杂志卡）", () => {
  it("4.P1(fixture 等价面): 视频变体仍指向 native 基线资源，不指向竖版卡", async ({ page }) => {
    const spec = daySpec("landscape");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.hasVideoAttr, '横版日动态变体必须 data-has-video="1"').toBe("1");
    // 谓词字面量（4.P1 negate 面）：video_url == 基线（native 16:9 卡），不指向竖版卡资源
    expect(state.src, "横版日视频变体必须维持 native 基线").toBe(nativeUrl(spec));
    expect(state.src?.includes("_portrait.mp4"), "横版日不得回退到竖版卡资源").toBe(false);
    expect(state.paused, "动态变体必须在播（现状不回归）").toBe(false);
  });

  it("4.P1 探针: 主视频产物 ffprobe 探测保持横版（width > height）", async ({ page }) => {
    const spec = daySpec("landscape");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);
    expect(state.src).not.toBeNull();

    const probe = await downloadAndProbe(state.src!);
    expect(probe.status).toBe(200);
    // 探针字面量：width > height
    expect(
      probe.width,
      `横版日主视频必须保持横版（实际 ${probe.width}x${probe.height}）`,
    ).toBeGreaterThan(probe.height);
    await writeArtifact("s4p1", JSON.stringify({ url: state.src, ...probe }, null, 2));
  });
});

// ============================================================================
// 契约 M2/M4 全矩阵补面：维度缺失兜底 + 单字段回退链
// ============================================================================

describe("[契约M2/M4 补面] 维度缺失兜底与单字段回退链", () => {
  it("场景7.P1: 维度缺失（w/h 有 0）→ 兜底基线 native 优先，不得仅因缺维度误判（契约 M2 第四规则）", async ({
    page,
  }) => {
    const spec = daySpec("missingDims");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.videoExists, "维度缺失日不得误判为无视频").toBe(true);
    expect(state.src, "维度缺失日必须维持兜底基线 native 优先").toBe(nativeUrl(spec));
    expect(state.paused).toBe(false);
    await writeArtifact("s7p1", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });

  it("竖版 hero 仅 native 字段 → portrait>native>landscape 回退链落 native 且仍动态", async ({
    page,
  }) => {
    const spec = daySpec("portraitNoCard");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.videoExists, "portrait 缺失日不得退化为静态卡（回退链必须接住）").toBe(true);
    expect(state.src, "竖版 hero 无 portrait 卡时必须回退 native").toBe(nativeUrl(spec));
    expect(state.paused, "回退后动态变体仍须在播").toBe(false);
    await writeArtifact("c1-matrix-portrait-fallback", JSON.stringify(state, null, 2));
  });

  it("横版 hero 仅 portrait 字段 → native>portrait>landscape 回退链落 portrait 且仍动态", async ({
    page,
  }) => {
    const spec = daySpec("landscapeNoCard");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.videoExists, "native 缺失日不得退化为静态卡（回退链必须接住）").toBe(true);
    expect(state.src, "横版 hero 无 native 卡时必须回退 portrait").toBe(portraitUrl(spec));
    expect(state.paused, "回退后动态变体仍须在播").toBe(false);
    await writeArtifact("c1-matrix", JSON.stringify({ landscapeNoCard: state }, null, 2));
  });
});

// ============================================================================
// 场景 5.P1/P2/P3 [det-machine]：方图判定边界（闭区间端点 + 带外判别对）
//   整数尺寸 fixture 防浮点歧义；r=0.9/1.1 双闭端点归方图（native），r=0.89 归竖版
//   （portrait）。r=1.11 与 1.1 的播放观测同源（均 16:9 卡）——state.md 场景 5 备注
//   不设 UI 判别谓词，此处作分类回归面（防带状阈值被误改成 1.2 等更宽区间）。
// ============================================================================

describe("[场景5 边界] 方图判定闭区间端点与带外判别对", () => {
  it("5.P1: hero 宽高比恰为 0.9（900×1000）→ 按方图判定播放 16:9 卡", async ({ page }) => {
    const spec = daySpec("squareLowEdge");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    // 谓词字面量（5.P1）：src contains "_native.mp4"——r=0.9 闭端点必须落入方图分支
    //（实现写成 r > 0.9 开区间时此断言红）
    expect(state.src, "r=0.9 闭端点必须归方图分支取 native 卡").toBe(nativeUrl(spec));
    expect(state.src).not.toContain("_portrait.mp4");
    expect(state.paused).toBe(false);
    await writeArtifact("s5p1", JSON.stringify({ spec: spec.key, ratio: 0.9, ...state }, null, 2));
  });

  it("5.P2: hero 宽高比恰为 1.1（1100×1000）→ 按方图判定播放 16:9 卡", async ({ page }) => {
    const spec = daySpec("squareHighEdge");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    // 谓词字面量（5.P2）：src contains "_native.mp4"——r=1.1 闭端点必须落入方图分支
    //（实现写成 r < 1.1 开区间时此断言红；注意 r=1.1 旧实现会落入横版分支，观测同源不变红，
    //  分类正确性由 r=0.9 端点 + r=0.89 带外判别对合围锚定）
    expect(state.src, "r=1.1 闭端点必须归方图分支取 native 卡").toBe(nativeUrl(spec));
    expect(state.paused).toBe(false);
    await writeArtifact("s5p2", JSON.stringify({ spec: spec.key, ratio: 1.1, ...state }, null, 2));
  });

  it("5.P3: hero 宽高比为 0.89（890×1000）→ 按竖版分支播放竖版卡", async ({ page }) => {
    const spec = daySpec("belowSquare");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    // 谓词字面量（5.P3）：src contains "_portrait.mp4" && not contains "_native.mp4"
    //——带外下侧必须与方图分支判别（`>=` 写成 `>` 或带宽放宽即红）
    expect(state.src, "r=0.89 带外必须归竖版分支取 portrait 卡").toBe(portraitUrl(spec));
    expect(state.src, "r=0.89 带外不得误入方图分支").not.toContain("_native.mp4");
    expect(state.paused).toBe(false);
    await writeArtifact("s5p3", JSON.stringify({ spec: spec.key, ratio: 0.89, ...state }, null, 2));
  });

  it("1.11 带外（1110×1000）→ 归横版分支播放 16:9 卡（分类回归面，UI 观测与 1.1 同源）", async ({
    page,
  }) => {
    const spec = daySpec("aboveSquare");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.src, "r=1.11 带外必须归横版分支取 native 卡").toBe(nativeUrl(spec));
    expect(state.paused).toBe(false);
    await writeArtifact("s5p4", JSON.stringify({ spec: spec.key, ratio: 1.11, ...state }, null, 2));
  });
});

// ============================================================================
// 契约 M1 第三兜底链 + M4 存量日兼容（plan 审查重要问题 1 闭合）
//   landscape-only 变体日：方图 hero 且 native+portrait 皆缺 → 第三兜底落 Aerial .mov；
//   squareNoPortrait：0928~1008 原生比例存量日无 portrait 字段 → native 兜底语义不变。
// ============================================================================

describe("[契约M1/M4 补面] landscape-only 第三兜底与存量日无 portrait 兜底", () => {
  it("M1 第三兜底: 方图 hero 仅 landscape 字段 → 落 Aerial .mov 且仍动态（回退链必须接住）", async ({
    page,
  }) => {
    const spec = daySpec("squareLandscapeOnly");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.videoExists, "landscape-only 日不得退化为静态卡（回退链必须接住）").toBe(true);
    expect(state.src, "方图 hero 双卡皆缺时必须回退 landscape .mov").toBe(landscapeUrl(spec));
    expect(state.paused, "回退后动态变体仍须在播").toBe(false);

    const probe = await downloadAndProbe(state.src!);
    expect(probe.status, "landscape .mov 资源必须可达").toBe(200);
    expect(probe.width, "landscape 档必须保持横版").toBeGreaterThan(probe.height);
    await writeArtifact("m1-landscape-only", JSON.stringify({ ...state, probe }, null, 2));
  });

  it("M4 存量日: 方图 hero 无 portrait 字段（0928~1008 原生比例存量）→ native 兜底语义不变", async ({
    page,
  }) => {
    const spec = daySpec("squareNoPortrait");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.videoExists, "存量日不得退化为静态卡").toBe(true);
    expect(state.src, "方图 hero 无 portrait 字段时必须落 native（存量语义不变）").toBe(
      nativeUrl(spec),
    );
    expect(state.paused).toBe(false);
    await writeArtifact("m4-square-no-portrait", JSON.stringify(state, null, 2));
  });
});

// ============================================================================
// 契约 M3：主钮「保存视频」URL 跟随朝向契约、文件名契约不变
// ============================================================================

describe("[契约M3] 主钮「保存视频」URL 跟随朝向契约、文件名不变", () => {
  const SAVE_BTN_SEL = '[data-role^="wallpaper-download"]';

  it("场景2.P1: 方图日点击保存 → 数据源取 _native.mp4（不取 portrait）∧ 文件名不变（20261110 翻转）", async ({
    page,
  }) => {
    const spec = daySpec("square");
    await openWallpaperDay(page, spec.date);
    await page.waitForSelector(`${wallpaperCardSel(spec.date)} video`, { timeout: 8000 });

    const saveBtn = page.locator(wallpaperCardSel(spec.date)).first().locator(SAVE_BTN_SEL).first();
    await saveBtn.waitFor({ state: "visible", timeout: 8000 });

    const dlPromise = page.waitForEvent("download", { timeout: 15000 });
    await saveBtn.click();
    const dl = await dlPromise;

    // 文件名字面量（契约 M3）：拾光动态壁纸-{pickDate}.mp4，朝向自适应不改名
    expect(dl.suggestedFilename(), "方图日保存文件名契约不变").toBe(
      `拾光动态壁纸-${spec.date}.mp4`,
    );
    // 下载走 fetch→blob 流水线，数据源断言按既有惯例用 __fetchLog（video 元素自身播放
    // 加载不经 window.fetch，fetchLog 只含 app 发起的下载请求——断言干净）
    const fetchLog = await page.evaluate(
      () => (window as unknown as { __fetchLog: string[] }).__fetchLog,
    );
    const nativeFetched = fetchLog.find((u) => u.includes("_native.mp4"));
    expect(
      nativeFetched,
      `方图日保存视频必须取 native 卡数据源，实际 fetchLog：${JSON.stringify(fetchLog)}`,
    ).toContain("_native.mp4");
    expect(
      fetchLog.some((u) => u.includes("_portrait.mp4")),
      "方图日保存视频不得请求 portrait 卡（主钮 URL 绑定同函数）",
    ).toBe(false);
    await writeArtifact(
      "s2p1",
      JSON.stringify({ suggestedFilename: dl.suggestedFilename(), fetchLog }, null, 2),
    );
  });

  it("竖版日：点击保存 → 数据源取 _portrait.mp4（不取 native）∧ 文件名 拾光动态壁纸-<pickDate>.mp4", async ({
    page,
  }) => {
    const spec = daySpec("portrait");
    await openWallpaperDay(page, spec.date);
    await page.waitForSelector(`${wallpaperCardSel(spec.date)} video`, { timeout: 8000 });

    const saveBtn = page.locator(wallpaperCardSel(spec.date)).first().locator(SAVE_BTN_SEL).first();
    await saveBtn.waitFor({ state: "visible", timeout: 8000 });

    const dlPromise = page.waitForEvent("download", { timeout: 15000 });
    await saveBtn.click();
    const dl = await dlPromise;

    // 文件名字面量（契约 C1）：拾光动态壁纸-{pickDate}.mp4，朝向自适应不改名
    expect(dl.suggestedFilename(), "保存文件名契约不变").toBe(`拾光动态壁纸-${spec.date}.mp4`);
    // 下载走 fetch→blob 流水线，数据源断言按既有惯例用 __fetchLog
    const fetchLog = await page.evaluate(
      () => (window as unknown as { __fetchLog: string[] }).__fetchLog,
    );
    const portraitFetched = fetchLog.find((u) => u.includes("_portrait.mp4"));
    expect(
      portraitFetched,
      `竖版日保存视频必须取 portrait 卡数据源，实际 fetchLog：${JSON.stringify(fetchLog)}`,
    ).toContain("_portrait.mp4");
    expect(
      fetchLog.some((u) => u.includes("_native.mp4")),
      "竖版日保存视频不得请求 native 卡（主钮 URL 绑定同函数）",
    ).toBe(false);
    await writeArtifact(
      "c1-save-portrait",
      JSON.stringify({ suggestedFilename: dl.suggestedFilename(), fetchLog }, null, 2),
    );
  });

  it("横版日：点击保存 → 数据源取 _native.mp4（不取 portrait）∧ 文件名不变（回归）", async ({
    page,
  }) => {
    const spec = daySpec("landscape");
    await openWallpaperDay(page, spec.date);
    await page.waitForSelector(`${wallpaperCardSel(spec.date)} video`, { timeout: 8000 });

    const saveBtn = page.locator(wallpaperCardSel(spec.date)).first().locator(SAVE_BTN_SEL).first();
    await saveBtn.waitFor({ state: "visible", timeout: 8000 });

    const dlPromise = page.waitForEvent("download", { timeout: 15000 });
    await saveBtn.click();
    const dl = await dlPromise;

    expect(dl.suggestedFilename(), "横版日保存文件名契约不变").toBe(
      `拾光动态壁纸-${spec.date}.mp4`,
    );
    const fetchLog = await page.evaluate(
      () => (window as unknown as { __fetchLog: string[] }).__fetchLog,
    );
    const nativeFetched = fetchLog.find((u) => u.includes("_native.mp4"));
    expect(
      nativeFetched,
      `横版日保存视频必须取 native 卡数据源，实际 fetchLog：${JSON.stringify(fetchLog)}`,
    ).toContain("_native.mp4");
    expect(
      fetchLog.some((u) => u.includes("_portrait.mp4")),
      "横版日保存视频不得请求 portrait 卡",
    ).toBe(false);
    await writeArtifact(
      "c1-save-landscape",
      JSON.stringify({ suggestedFilename: dl.suggestedFilename(), fetchLog }, null, 2),
    );
  });
});

// ============================================================================
// 场景 6.P1/P2 [det-machine]（契约 M3）：方图日「更多」菜单保留「保存竖版视频」
//   菜单项恒读 day.wallpaperVideoPortrait 字段（与主钮选卡解耦）——方图日主钮改指
//   16:9 卡后，菜单项是竖版卡的唯一手动入口，不得被顺手删除。
// ============================================================================

describe("[场景6] 方图日「更多」菜单保留「保存竖版视频」且仍指向竖版卡", () => {
  it("6.P1: 菜单展开后「保存竖版视频」入口存在且可见", async ({ page }) => {
    const spec = daySpec("square");
    await openWallpaperDay(page, spec.date);
    await page.waitForSelector(`${wallpaperCardSel(spec.date)} video`, { timeout: 8000 });

    // 先展开「更多」菜单（popover 常驻 DOM 初始 hidden，既有先例同款交互）
    const moreBtn = page
      .locator(wallpaperCardSel(spec.date))
      .first()
      .locator('[data-role="more-menu"]');
    await moreBtn.waitFor({ state: "visible", timeout: 8000 });
    await moreBtn.click();

    // 谓词字面量（6.P1）：menu contains "保存竖版视频" && item_visible == true
    const portraitVideoItem = page
      .locator(wallpaperCardSel(spec.date))
      .first()
      .locator('[data-role="wallpaper-download-video-portrait"]');
    await portraitVideoItem.waitFor({ state: "visible", timeout: 8000 });
    expect(await portraitVideoItem.isVisible(), "「保存竖版视频」菜单项必须可见").toBe(true);
    expect((await portraitVideoItem.innerText()).trim(), "菜单项文案必须是「保存竖版视频」").toBe(
      "保存竖版视频",
    );
    await writeArtifact("s6p1", JSON.stringify({ spec: spec.key, menuVisible: true }, null, 2));
  });

  it("6.P2: 方图日点击「保存竖版视频」→ 取回竖版卡 mp4（文件名 -竖版 后缀契约）", async ({
    page,
  }) => {
    const spec = daySpec("square");
    await openWallpaperDay(page, spec.date);
    await page.waitForSelector(`${wallpaperCardSel(spec.date)} video`, { timeout: 8000 });

    const moreBtn = page
      .locator(wallpaperCardSel(spec.date))
      .first()
      .locator('[data-role="more-menu"]');
    await moreBtn.waitFor({ state: "visible", timeout: 8000 });
    await moreBtn.click();

    const portraitVideoItem = page
      .locator(wallpaperCardSel(spec.date))
      .first()
      .locator('[data-role="wallpaper-download-video-portrait"]');
    await portraitVideoItem.waitFor({ state: "visible", timeout: 8000 });

    const dlPromise = page.waitForEvent("download", { timeout: 15000 });
    await portraitVideoItem.click();
    const dl = await dlPromise;

    expect(dl.suggestedFilename(), "菜单保存文件名契约不变（-竖版 后缀）").toBe(
      `拾光动态壁纸-${spec.date}-竖版.mp4`,
    );
    const fetchLog = await page.evaluate(
      () => (window as unknown as { __fetchLog: string[] }).__fetchLog,
    );
    // 谓词字面量（6.P2）：target contains "_portrait.mp4"
    const portraitFetched = fetchLog.find((u) => u.includes("_portrait.mp4"));
    expect(
      portraitFetched,
      `方图日菜单保存必须取 portrait 卡数据源，实际 fetchLog：${JSON.stringify(fetchLog)}`,
    ).toContain("_portrait.mp4");
    await writeArtifact(
      "s6p2",
      JSON.stringify({ suggestedFilename: dl.suggestedFilename(), fetchLog }, null, 2),
    );
  });
});

// ============================================================================
// 场景 8.P1 [det-machine]：零视频字段日 → 静态卡回退（回归护栏）
// ============================================================================

describe("[场景8.P1 回归护栏] 零视频字段日 → 卡片仍渲染有效展示（静态卡回退）", () => {
  it("无视频日壁纸卡：零 <video> ∧ 无 data-has-video ∧ 静态 img（==manifest wallpaperPortrait 字段）加载完成", async ({
    page,
  }) => {
    const spec = daySpec("noVideo");
    await page.goto(`${BASE}/#/?date=${spec.date}`);
    await page.waitForSelector(wallpaperCardSel(spec.date), { timeout: 12000 });
    // bounded 等待静态 img 加载完成（稳定终态）
    await page.waitForFunction(
      (d) => {
        const unit = document.querySelector(
          `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`,
        );
        const img = unit?.querySelector("img") as HTMLImageElement | null;
        return !!unit && !!img && img.complete && (img.naturalWidth ?? 0) > 0;
      },
      spec.date,
      { timeout: 10000 },
    );

    const result = await page.evaluate((d) => {
      const unit = document.querySelector(
        `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`,
      );
      const img = unit?.querySelector("img") as HTMLImageElement | null;
      return {
        cardRendered: !!unit,
        hasVideoAttr: unit?.getAttribute("data-has-video") ?? null,
        videoCount: unit?.querySelectorAll("video").length ?? -1,
        imgComplete: img?.complete ?? false,
        imgNaturalWidth: img?.naturalWidth ?? 0,
        imgSrc: img?.getAttribute("src") ?? null,
      };
    }, spec.date);

    // 谓词字面量（7.P1）：card_rendered == true ∧ video_node exists == false（零视频字段日）
    expect(result.cardRendered, "无视频日壁纸卡必须仍渲染").toBe(true);
    expect(result.videoCount, "无视频日卡内不得出现 video 节点").toBe(0);
    expect(result.hasVideoAttr, "无视频日不得带动态变体机读标记").toBeNull();
    expect(result.imgComplete, "静态卡 img 必须加载完成（有效展示）").toBe(true);
    expect(result.imgNaturalWidth).toBeGreaterThan(0);
    // 数据流字段一致性：静态 img 数据源 == manifest wallpaperPortrait 字段值
    expect(result.imgSrc, "静态卡 img 必须取 manifest wallpaperPortrait 字段").toBe(
      `wallpapers/${spec.date}_v2-contain-1290x2796.jpg`,
    );
    await writeArtifact("s8p1", JSON.stringify(result, null, 2));
  });
});

// ============================================================================
// 回归护栏：主视频 URL 非空但 404 → 零未捕获 JS 错误 + 静态卡重渲稳定终态（M1 既有链）
// ============================================================================

describe("[回归护栏] 主视频 404 → 静态卡重渲 + 零 JS 错误", () => {
  it("portrait.mp4 拦截 404 → 页面无未捕获错误 ∧ 不卡死在加载态（静态 img 终态）", async ({
    page,
  }) => {
    const spec = daySpec("portrait");
    const pageErrors: string[] = [];
    const appConsoleErrors: string[] = [];
    const mp4Statuses: number[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (msg) => {
      // 契约 C2「零 console.error」口径：app.js 自身链路不得产生 console.error
      //（浏览器网络层 Failed to load resource 的 location 非 app.js，不计入）
      if (msg.type() === "error" && (msg.location()?.url ?? "").endsWith("app.js")) {
        appConsoleErrors.push(msg.text());
      }
    });
    page.on("response", (r) => {
      if (new URL(r.url()).pathname.endsWith(".mp4")) mp4Statuses.push(r.status());
    });
    await page.route("**/*.mp4", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" }),
    );

    await page.goto(`${BASE}/#/?date=${spec.date}`);
    await page.waitForSelector(wallpaperCardSel(spec.date), { timeout: 12000 });

    // 拦截必须真实命中（No-op kill：路由未生效即红）
    {
      const deadline = Date.now() + 6000;
      while (!mp4Statuses.includes(404) && Date.now() < deadline) {
        await page.waitForTimeout(200);
      }
    }
    expect(mp4Statuses, "portrait.mp4 请求未被 404 拦截命中").toContain(404);

    // bounded 等待降级终态：video 移除、静态 img 加载完成（不卡死在加载态）
    await page.waitForFunction(
      (d) => {
        const unit = document.querySelector(
          `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`,
        );
        const img = unit?.querySelector("img") as HTMLImageElement | null;
        return (
          !!unit &&
          !unit.querySelector("video") &&
          !!img &&
          img.complete &&
          (img.naturalWidth ?? 0) > 0
        );
      },
      spec.date,
      { timeout: 10000 },
    );

    const playingVideos = await page.evaluate(
      () => Array.from(document.querySelectorAll("video")).filter((v) => !v.paused).length,
    );
    expect(playingVideos, "降级后播放态 video 数量必须 == 0").toBe(0);
    // 谓词字面量（7.P2）：js_error_count == 0 ∧ page_reach_stable_state == true
    expect(pageErrors, `不得有未捕获 JS 错误：${JSON.stringify(pageErrors)}`).toHaveLength(0);
    expect(
      appConsoleErrors,
      `app.js 链路不得产生 console.error：${JSON.stringify(appConsoleErrors)}`,
    ).toHaveLength(0);
    await writeArtifact(
      "regress-404",
      JSON.stringify({ mp4Statuses, pageErrors, appConsoleErrors, playingVideos }, null, 2),
    );
  });
});

// ============================================================================
// 回归护栏 [ux-exploration]：竖版视频卡 UX 启发式走查 critical == 0
// ============================================================================

describe("[回归护栏·UX] 竖版视频卡 UX 启发式走查", () => {
  it("走查全部启发式零 Critical：动态变体就绪/渲染竖版成型/主钮可用/无横向溢出/零错误/起播契约", async ({
    page,
  }) => {
    const spec = daySpec("portrait");
    const pageErrors: string[] = [];
    const appConsoleErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (msg) => {
      if (msg.type() === "error" && (msg.location()?.url ?? "").endsWith("app.js")) {
        appConsoleErrors.push(msg.text());
      }
    });

    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);
    const box = await page.locator(wallpaperCardSel(spec.date)).locator("video").boundingBox();
    const saveBtn = page
      .locator(wallpaperCardSel(spec.date))
      .first()
      .locator('[data-role^="wallpaper-download"]')
      .first();
    const saveVisible = await saveBtn.isVisible();
    const saveEnabled = await saveBtn.isEnabled();
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    const criticals: string[] = [];
    if (!state.cardExists) criticals.push("竖版日壁纸卡未挂载");
    if (state.hasVideoAttr !== "1") criticals.push('动态变体缺 data-has-video="1" 机读标记');
    if (!state.videoExists) criticals.push("动态变体未以 video 元素渲染");
    if (!(state.duration > 0)) criticals.push("视频元数据未就绪（duration==0）");
    if (!(state.clientWidth > 0 && state.clientHeight > 0)) criticals.push("video 渲染占位为零");
    if (!(state.clientHeight > state.clientWidth))
      criticals.push("竖版视频未竖版成型（渲染矩形 h<=w）");
    if (!box || box.width <= 0 || box.height <= 0) criticals.push("video boundingBox 无效");
    if (!saveVisible) criticals.push("保存视频主钮不可见");
    if (!saveEnabled) criticals.push("保存视频主钮不可用");
    if (overflow.scrollWidth > overflow.clientWidth + 2) criticals.push("页面存在横向溢出");
    if (state.muted !== true) criticals.push("起播未 muted（自动播契约）");
    if (!state.loop) criticals.push("契约 <video loop> 缺失");
    if (!state.playsinline) criticals.push("契约 playsinline 缺失");
    if (pageErrors.length > 0) criticals.push(`未捕获 JS 错误: ${JSON.stringify(pageErrors)}`);
    if (appConsoleErrors.length > 0)
      criticals.push(`app.js console.error: ${JSON.stringify(appConsoleErrors)}`);

    const card = page.locator(wallpaperCardSel(spec.date)).first();
    const shotPath = path.join(ARTIFACT_DIR, "regress-ux-portrait-card.png");
    await card.screenshot({ path: shotPath });

    const report = [
      "regress-ux UX 启发式走查（playwright:apps/gallery，竖版 hero 日）",
      `截图: ${shotPath}`,
      "启发式: 动态变体就绪/渲染竖版成型/主钮可见可用/无横向溢出/muted+loop+playsinline/零未捕获错误/零 app.js console.error",
      `critical_count: ${criticals.length}`,
      ...criticals.map((c) => `- CRITICAL: ${c}`),
      `state: ${JSON.stringify(state)}`,
      `overflow: ${JSON.stringify(overflow)}`,
    ].join("\n");
    await writeArtifact("regress-ux-portrait", report);

    // 谓词字面量（8.P1）：critical_count == 0
    expect(criticals, `UX 走查存在 Critical 发现：\n${criticals.join("\n")}`).toHaveLength(0);
    expect(fs.existsSync(shotPath), "走查截图必须落 artifact 目录").toBe(true);
  });
});

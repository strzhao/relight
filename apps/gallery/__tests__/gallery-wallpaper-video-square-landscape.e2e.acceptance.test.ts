/**
 * 验收测试（红队 E2E）：方图 hero 日壁纸视频改用 16:9 横版杂志卡（0 裁切纸底 letterbox）
 *
 * 设计文档（state.md §目标 / §设计文档 / §契约规约 M1-M4 / §验收场景 场景 1-8）对应谓词：
 *   - 场景1.P1 [det-machine]：方图日（w/h==1.0）壁纸卡自动播放 16:9 横版杂志卡
 *     （video src contains "_native.mp4" && not contains "_portrait.mp4"，#/?date= 深链直达）
 *   - 场景1.P2 [det-machine]：同一历史日由相邻日滑动进入（非深链）同样选 16:9 卡
 *   - 场景1.P3 [visual-residue]：方图日 16:9 卡播放截图 + 二值清单（contain 纸底 letterbox
 *     且人物主体完整）// VISUAL_RESIDUE: 留 QA 真机判定，自动化仅做渲染成型代理断言
 *   - 场景2.P1 [det-machine]：方图日主钮「保存视频」取回 16:9 卡
 *     （下载目标 contains "_native.mp4" && not contains "_portrait.mp4" ∧ 文件名契约不变）
 *   - 场景3.P1 [det-machine]：竖版 hero 日（r=0.75）仍自动播放竖版卡（回归护栏）
 *   - 场景4.P1 [det-machine]：横版 hero 日（r=1.5）仍自动播放 16:9 卡（回归护栏）
 *   - 场景5.P1/P2 [det-machine]：方图闭区间端点 r=0.9 / r=1.1 → 16:9 卡（整数尺寸防浮点歧义）
 *   - 场景5.P3 [det-machine]：带外 r=0.89 → 竖版分支播竖版卡（下边界判别对；SSOT 备注：
 *     r=1.11 与 1.1 播放观测同源均 16:9 卡，UI 层不可判别，明示不设判别谓词）
 *   - 场景6.P1 [det-machine]：方图日「更多」菜单保留「保存竖版视频」入口且可见
 *   - 场景6.P2 [det-machine]：点击「保存竖版视频」→ 取回竖版卡（target contains "_portrait.mp4"）
 *   - 场景7.P1 [det-machine]：hero 维度缺失 → 按兜底基线 native>portrait>landscape 选择
 *     且零未捕获错误（negate：不得仅因缺维度误入新方图分支——行为与基线一致）
 *   - 场景7.P2 [det-machine]：维度缺失且仅存竖版卡单一变体 → 播该唯一可用变体
 *   - 场景8.P1 [det-machine]：零动态字段日 → 静态壁纸卡回退（video 不可见 ∧ 静态 img 可见
 *     加载完成 ∧ 零未捕获错误；negate：不得出现空 video 或裂图）
 *   - 场景8.P2 [det-machine]：动态字段存在但为空串 → 同样回退静态卡
 *   - M4/兜底链补面（plan 审查重要问题 1 闭合）：方图存量日无 portrait 字段 → 兜底 native
 *     语义不变（0928~1008 legacy 日）；landscape-only 变体日 → 第三兜底可达（M1 链尾）
 *   - 场景9 [ux-exploration]：由 QA 阶段承接，不在本文件
 *
 * 红队铁律：不读 app.js/app.css/index.html 内容（蓝队产出）。黑盒 DOM 契约锚点
 * （[data-stream-unit][data-unit-type="wallpaper"][data-day-date] / data-has-video /
 * [data-role^="wallpaper-download"] / [data-role="more-menu"] / [data-role="more-menu-popover"] /
 * stream 滚动容器 #stream / #/?date= 深链落当日壁纸卡）取自既有红队测试先例
 * （gallery-wallpaper-video-hero-orientation / gallery-wallpaper-hero / gallery-download-core /
 * gallery-stream）。
 * driver = 本地 fixture manifest + 真实视频（native 1280×720 16:9 与 landscape 1280×720 .mov
 * 均由 ffmpeg 现造；portrait 用 fixtures 既有 736×1600 样本——ffmpeg 为项目硬依赖，缺失即真红），
 * python3 http.server --bind 127.0.0.1（隔离临时目录；端口 8797 避开先例 8792/8794/8795/8796
 * 与 webServer 8088）。
 *
 * Mutation-kill 自查（No-op = 保持旧「方图→竖版序」实现）：
 *   1.P1 杀 No-op（旧实现方图播竖版卡 → contains "_portrait.mp4" 必红）；
 *   1.P2 杀「仅深链路径翻转」条件突变；2.P1 杀「只改播放不改保存」半改；
 *   3.P1/4.P1 杀过度改动伤及竖/横版；5.P1/P3 杀 0.9 侧 `<`/`<=` 方向写反与严格 r==1 突变；
 *   5.P2 按谓词字面量锚定（1.1 侧边界突变 UI 层不可判别，SSOT 备注 explicit 交实现内单测/QA）；
 *   6.P1/P2 杀顺手删入口/菜单改线；7.P1 杀缺维度崩溃突变（r=NaN/Infinity 抛错）；
 *   7.P2 杀单一变体误退化静态；8.P1/P2 杀空值误判动态/空 video/裂图。
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

const PORT_SQUARE = 8797; // 方图日横屏化矩阵站（先例 8792/8794/8795/8796 已占用，webServer 8088 避开）
const BASE = `http://127.0.0.1:${PORT_SQUARE}`;
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
  /** hero（photos[0]）显示维度——契约 M2 的方图判定信号（w/h 均为正才参与比例带判定） */
  heroW: number;
  heroH: number;
  native: boolean;
  portrait: boolean;
  landscape: boolean;
}

/**
 * 契约 M2 全矩阵 fixture（12 日；days[0] = 流顶 = 场景1.P2 的相邻日入场点）：
 *   squareMain      方图 hero（1080×1080, r=1.0）native+portrait+landscape 三字段全 → 期望 16:9 卡
 *                   （场景1.P1/1.P2/1.P3/2.P1/6.P1/6.P2 主战场）
 *   portraitDay     竖版 hero（3024×4032, r=0.75）双字段 → 期望竖版卡（回归护栏，场景3.P1）
 *   landscapeDay    横版 hero（4032×3024, r≈1.333）双字段 → 期望 16:9 卡（回归护栏，场景4.P1）
 *   bandLow         方图闭区间下端点（900×1000, r=0.9 整数尺寸）→ 期望 16:9 卡（场景5.P1）
 *   bandHigh        方图闭区间上端点（1100×1000, r=1.1 整数尺寸）→ 期望 16:9 卡（场景5.P2）
 *   belowBand       带外下侧（890×1000, r=0.89）→ 期望竖版卡（场景5.P3 判别对）
 *   missingDimsA    维度缺失（w/h==0）双字段 → 期望基线 native 优先 + 零错误（场景7.P1）
 *   missingDimsB    维度缺失仅 portrait 单变体 → 期望播唯一变体（场景7.P2）
 *   squareLegacy    方图 hero 仅 native 字段（0928~1008 存量日形态）→ 期望兜底 native（M4）
 *   landscapeOnly   方图 hero 仅 landscape 字段 → 期望第三兜底 landscape（M1 链尾）
 *   noVideo         零动态字段 → 静态卡回退（场景8.P1）
 *   emptyStrings    动态字段存在但空串 → 静态卡回退（场景8.P2）
 */
const DAY_SPECS: DaySpec[] = [
  {
    key: "portraitDay",
    date: dateOffset(0),
    title: "方图横屏化 · 竖版日",
    heroW: 3024,
    heroH: 4032,
    native: true,
    portrait: true,
    landscape: false,
  },
  {
    key: "squareMain",
    date: dateOffset(1),
    title: "方图横屏化 · 方图日",
    heroW: 1080,
    heroH: 1080,
    native: true,
    portrait: true,
    landscape: true,
  },
  {
    key: "landscapeDay",
    date: dateOffset(2),
    title: "方图横屏化 · 横版日",
    heroW: 4032,
    heroH: 3024,
    native: true,
    portrait: true,
    landscape: false,
  },
  {
    key: "bandLow",
    date: dateOffset(3),
    title: "方图横屏化 · 下端点 r0.9 日",
    heroW: 900,
    heroH: 1000,
    native: true,
    portrait: true,
    landscape: false,
  },
  {
    key: "bandHigh",
    date: dateOffset(4),
    title: "方图横屏化 · 上端点 r1.1 日",
    heroW: 1100,
    heroH: 1000,
    native: true,
    portrait: true,
    landscape: false,
  },
  {
    key: "belowBand",
    date: dateOffset(5),
    title: "方图横屏化 · 带外 r0.89 日",
    heroW: 890,
    heroH: 1000,
    native: true,
    portrait: true,
    landscape: false,
  },
  {
    key: "missingDimsA",
    date: dateOffset(6),
    title: "方图横屏化 · 维度缺失双卡日",
    heroW: 0,
    heroH: 0,
    native: true,
    portrait: true,
    landscape: false,
  },
  {
    key: "missingDimsB",
    date: dateOffset(7),
    title: "方图横屏化 · 维度缺失单卡日",
    heroW: 0,
    heroH: 0,
    native: false,
    portrait: true,
    landscape: false,
  },
  {
    key: "squareLegacy",
    date: dateOffset(8),
    title: "方图横屏化 · 方图存量无竖卡日",
    heroW: 1080,
    heroH: 1080,
    native: true,
    portrait: false,
    landscape: false,
  },
  {
    key: "landscapeOnly",
    date: dateOffset(9),
    title: "方图横屏化 · 仅 Aerial 卡日",
    heroW: 1080,
    heroH: 1080,
    native: false,
    portrait: false,
    landscape: true,
  },
  {
    key: "noVideo",
    date: dateOffset(10),
    title: "方图横屏化 · 无视频日",
    heroW: 3024,
    heroH: 4032,
    native: false,
    portrait: false,
    landscape: false,
  },
  {
    key: "emptyStrings",
    date: dateOffset(11),
    title: "方图横屏化 · 空串字段日",
    heroW: 3024,
    heroH: 4032,
    native: false,
    portrait: false,
    landscape: false,
  },
];

const daySpec = (key: string): DaySpec => {
  const spec = DAY_SPECS.find((d) => d.key === key);
  if (!spec) throw new Error(`未知 day spec: ${key}`);
  return spec;
};

/** 契约 M1 字段名逐字：wallpaperVideoNative / wallpaperVideoPortrait / wallpaperVideoLandscape
 *  （manifest 产物文件名约定：_native.mp4 / _portrait.mp4 / _landscape.mov） */
const nativeRelPath = (spec: DaySpec): string => `videos/${spec.date}_native.mp4`;
const portraitRelPath = (spec: DaySpec): string => `videos/${spec.date}_portrait.mp4`;
const landscapeRelPath = (spec: DaySpec): string => `videos/${spec.date}_landscape.mov`;
const nativeUrl = (spec: DaySpec): string => new URL(nativeRelPath(spec), `${BASE}/`).href;
const portraitUrl = (spec: DaySpec): string => new URL(portraitRelPath(spec), `${BASE}/`).href;

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

function encodeFixtureVideo(
  outPath: string,
  size: string,
  duration: number,
  containerArgs: string[],
): void {
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${size}:rate=24:duration=${duration}`,
      ...containerArgs,
      outPath,
    ],
    { encoding: "utf-8", timeout: 60000 },
  );
  if (r.status !== 0 || !fs.existsSync(outPath)) {
    throw new Error(`ffmpeg 造 fixture 失败（红队铁律：fixture 失败即真红）: ${r.stderr}`);
  }
}

function buildFixture(): string {
  const dir = path.join(os.tmpdir(), `relight-gallery-square-e2e-${PORT_SQUARE}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["index.html", "app.css", "app.js"]) {
    fs.copyFileSync(path.join(SRC_GALLERY_DIR, f), path.join(dir, f));
  }
  const fontsDir = path.join(SRC_GALLERY_DIR, "fonts");
  if (fs.existsSync(fontsDir)) {
    fs.cpSync(fontsDir, path.join(dir, "fonts"), { recursive: true });
  }

  // native 卡（16:9 杂志卡档）：ffmpeg 现造真实 mp4，逐日复制为 <date>_native.mp4
  fs.mkdirSync(path.join(dir, "videos"), { recursive: true });
  const nativeMaster = path.join(dir, "videos", `_master-native-${NATIVE_W}x${NATIVE_H}.mp4`);
  encodeFixtureVideo(nativeMaster, `${NATIVE_W}x${NATIVE_H}`, 10, [
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
  ]);
  // landscape 卡（Aerial .mov 档）：H.264 编码 .mov 容器（Chromium 可解码），第三兜底链 fixture
  const landscapeMaster = path.join(dir, "videos", `_master-landscape-${NATIVE_W}x${NATIVE_H}.mov`);
  encodeFixtureVideo(landscapeMaster, `${NATIVE_W}x${NATIVE_H}`, 2, [
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
  ]);

  const days = DAY_SPECS.map((spec) => {
    // 每日壁纸图两档（静态卡/模糊垫底封面共用，字段名逐字：wallpaperLandscape / wallpaperPortrait）
    const wpLandscape = `wallpapers/${spec.date}_v2-contain-default.jpg`;
    const wpPortrait = `wallpapers/${spec.date}_v2-contain-1290x2796.jpg`;
    writeJpeg(path.join(dir, wpLandscape), WP_LANDSCAPE_JPEG_B64);
    writeJpeg(path.join(dir, wpPortrait), WP_PORTRAIT_JPEG_B64);

    if (spec.native) fs.copyFileSync(nativeMaster, path.join(dir, nativeRelPath(spec)));
    if (spec.portrait) fs.copyFileSync(PORTRAIT_SAMPLE, path.join(dir, portraitRelPath(spec)));
    if (spec.landscape) fs.copyFileSync(landscapeMaster, path.join(dir, landscapeRelPath(spec)));

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
      // photos[0] = hero：width/height 为契约 M2 的方图判定信号（维度缺失日 w/h==0）
      photos: [mkPhoto(1, spec.heroW, spec.heroH), mkPhoto(2, 4032, 3024)],
      ...(spec.native ? { wallpaperVideoNative: nativeRelPath(spec) } : {}),
      ...(spec.portrait ? { wallpaperVideoPortrait: portraitRelPath(spec) } : {}),
      ...(spec.landscape ? { wallpaperVideoLandscape: landscapeRelPath(spec) } : {}),
    };
  });
  fs.rmSync(nativeMaster, { force: true });
  fs.rmSync(landscapeMaster, { force: true });

  // 场景8.P2 专属：动态字段存在但为空串（在 manifest 层显式写 ""，isDynamic 判空链）
  const emptySpec = daySpec("emptyStrings");
  const emptyDay = days.find((d) => d.pickDate === emptySpec.date);
  if (emptyDay) {
    (emptyDay as Record<string, unknown>).wallpaperVideoNative = "";
    (emptyDay as Record<string, unknown>).wallpaperVideoPortrait = "";
    (emptyDay as Record<string, unknown>).wallpaperVideoLandscape = "";
  }

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
  await startStaticServer(PORT_SQUARE, fixtureDir);
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
  // fetch 直链日志（保存视频数据源断言用；视频元素起播不走 fetch，不污染日志）
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

/** 深链 `#/?date=` 打开目标日（无 rank 深链优先落该日壁纸卡，既有 DL/DW 契约）并等媒体就绪。
 *  requirePlaying=false 时仅等卡片挂载（landscape .mov 链尾日只断言 src 不断言播放态） */
async function openWallpaperDay(page: Page, date: string, requirePlaying = true): Promise<void> {
  await page.goto(`${BASE}/#/?date=${date}`);
  await page.waitForSelector(wallpaperCardSel(date), { timeout: 12000 });
  await page.evaluate((d) => {
    document
      .querySelector(`[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`)
      ?.scrollIntoView({ behavior: "instant", block: "center" });
  }, date);
  if (!requirePlaying) {
    await page.waitForTimeout(400);
    return;
  }
  // bounded 等待动态变体起播；data-has-video=="1"（动态日）严格等 video 挂载+起播——防卡片已渲染
  // 但 video 元素未挂载的空窗被 `!v` 空放（20261110 auto-fix 加固：全量并行负载下 1.P1/M4 各偶发
  // 一次红的共同上游竞态；静态日/非动态日轮询即刻通过，语义不变）
  await page.waitForFunction(
    (d) => {
      const card = document.querySelector(
        `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`,
      );
      const v = card?.querySelector("video") as HTMLVideoElement | null;
      if (card?.getAttribute("data-has-video") !== "1") return true;
      return !!v && v.readyState >= 2 && !v.paused;
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
  /** smart-fill 机读态（cover|contain，元数据就绪前置空——CSS 默认 contain） */
  fill: string | null;
  src: string | null;
  readyState: number;
  paused: boolean | null;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  clientWidth: number;
  clientHeight: number;
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
      // smart-fill 机读态挂流单元（unitEl.dataset.fill，app.js applySmartFill）
      fill: card?.getAttribute("data-fill") ?? null,
      src: v?.src ?? null,
      readyState: v?.readyState ?? 0,
      paused: v ? v.paused : null,
      duration: v?.duration ?? 0,
      videoWidth: v?.videoWidth ?? 0,
      videoHeight: v?.videoHeight ?? 0,
      clientWidth: v?.clientWidth ?? 0,
      clientHeight: v?.clientHeight ?? 0,
    };
  }, date);
}

// ---- 沉浸流滚动（body overflow:hidden，实际滚动容器 #stream，gallery-stream 先例）----

async function scrollStreamToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stream = document.getElementById("stream");
    if (stream) stream.scrollTop = stream.scrollHeight;
  });
}

/** 增量挂载直到目标日壁纸卡出现（sentinel IO 逐日挂载，bounded 轮询） */
async function mountDayCard(page: Page, date: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const found = await page.evaluate((d) => {
      return !!document.querySelector(
        `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`,
      );
    }, date);
    if (found) return;
    await scrollStreamToBottom(page);
    await page.waitForTimeout(300);
  }
  throw new Error(`目标日壁纸卡始终未挂载: ${date}`);
}

// ---- 「更多」菜单（gallery-wallpaper-hero 先例：popover 常驻 DOM，点击触发钮 toggle hidden）----

const MORE_TRIGGER = (cardSel: string) => `${cardSel} [data-role="more-menu"]`;
const MORE_POPOVER = (cardSel: string) => `${cardSel} [data-role="more-menu-popover"]`;

async function openMoreMenu(page: Page, cardSel: string): Promise<void> {
  const trigger = page.locator(MORE_TRIGGER(cardSel));
  await trigger.waitFor({ state: "visible", timeout: 8000 });
  await trigger.click();
  await page.waitForFunction(
    (sel: string) => {
      const pop = document.querySelector(`${sel} [data-role="more-menu-popover"]`);
      return !!pop && !pop.hasAttribute("hidden");
    },
    cardSel,
    { timeout: 5000, polling: 100 },
  );
}

interface MenuItemState {
  /** 可达名（aria-label，无则退化 textContent） */
  name: string;
  /** 可见文本（textContent，谓词「菜单 DOM 文本项」的观测面） */
  visibleText: string;
  role: string | null;
  popoverOpen: boolean;
  itemVisible: boolean;
}

/** 按标签扫菜单项状态：可达名与可见文本任一含 want 即命中（动态日菜单项可达名为
 *  「保存竖版动态壁纸视频（手机全屏）」、可见文本为「保存竖版视频」，联合匹配两者） */
async function findMenuItem(
  page: Page,
  cardSel: string,
  label: string,
): Promise<MenuItemState | null> {
  return page.evaluate(
    ({ sel, want }) => {
      const pop = document.querySelector(`${sel} [data-role="more-menu-popover"]`);
      if (!pop) return null;
      const items = Array.from(pop.querySelectorAll("button, [role='menuitem'], a"));
      const hit = items.find((el) => {
        const aria = (el.getAttribute("aria-label") ?? "").trim();
        const text = (el.textContent ?? "").trim();
        return aria.includes(want) || text.includes(want);
      });
      const miss = {
        name: "",
        visibleText: "",
        role: null,
        popoverOpen: !pop.hasAttribute("hidden"),
        itemVisible: false,
      };
      if (!hit) return miss;
      const style = getComputedStyle(hit);
      const visible =
        !pop.hasAttribute("hidden") &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        hit.getClientRects().length > 0;
      return {
        name: (hit.getAttribute("aria-label") ?? hit.textContent ?? "").trim(),
        visibleText: (hit.textContent ?? "").trim(),
        role: hit.getAttribute("data-role"),
        popoverOpen: !pop.hasAttribute("hidden"),
        itemVisible: visible,
      };
    },
    { sel: cardSel, want: label },
  );
}

// ============================================================================
// 场景 1.P1 + 1.P2：方图日壁纸卡自动播放 16:9 横版杂志卡（深链 + 相邻日滑动两种进入路径）
// ============================================================================

describe("[场景1.P1+1.P2] 方图日壁纸卡自动播放 16:9 横版杂志卡（两种进入路径）", () => {
  it("1.P1: 方图日（r=1.0）深链直达 → video src contains _native.mp4 && not _portrait.mp4（No-op 杀手：旧实现播竖版卡必红）", async ({
    page,
  }) => {
    const spec = daySpec("squareMain");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.cardExists, "方图日壁纸卡必须挂载").toBe(true);
    expect(state.hasVideoAttr, '方图日动态变体必须 data-has-video="1"').toBe("1");
    expect(state.videoExists, "方图日必须以 video 元素渲染动态变体").toBe(true);
    expect(state.paused, "动态变体必须在播").toBe(false);
    // 谓词字面量（1.P1）：src contains "_native.mp4" && src not contains "_portrait.mp4"
    expect(state.src, "方图日必须播放 16:9 横版杂志卡").toContain("_native.mp4");
    expect(state.src, "方图日不得播放竖版卡").not.toContain("_portrait.mp4");
    // 数据流字段一致性：src 逐字等于 manifest wallpaperVideoNative 字段值（M1 契约 plumbing）
    expect(state.src, "src 必须逐字等于 manifest wallpaperVideoNative 字段值").toBe(
      nativeUrl(spec),
    );
    await writeArtifact("s1p1", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });

  it("1.P2: 同一历史日由相邻日滑动进入（根流入场 + stream 滚动，非深链）→ 同样选 16:9 卡", async ({
    page,
  }) => {
    const squareSpec = daySpec("squareMain");
    const adjacentSpec = daySpec("portraitDay"); // days[0] 流顶 = squareMain 的相邻日
    await page.goto(`${BASE}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 12000 });

    // 前置：入场点是相邻日（竖版日）壁纸卡在视口（根流从流顶开始，非深链进入）
    const adjacentVisible = await page.locator(wallpaperCardSel(adjacentSpec.date)).isVisible();
    expect(adjacentVisible, "入场前置：相邻日壁纸卡必须在流顶视口可见").toBe(true);

    // 滑动进入目标日：stream 容器滚动 + scroll-snap 吸附（gallery-stream S2.PM1 先例）
    await mountDayCard(page, squareSpec.date);
    await page.evaluate((d) => {
      document
        .querySelector(`[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`)
        ?.scrollIntoView({ behavior: "instant", block: "start" });
    }, squareSpec.date);
    await page.waitForTimeout(700); // 等 scroll-snap 吸附完成
    await page.waitForFunction(
      (d) => {
        const v = document.querySelector(
          `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"] video`,
        ) as HTMLVideoElement | null;
        return !!v && v.readyState >= 2 && !v.paused;
      },
      squareSpec.date,
      { timeout: 15000 },
    );

    const state = await readVideoState(page, squareSpec.date);
    // 谓词字面量（1.P2）：src contains "_native.mp4"
    expect(state.src, "滑动进入方图日同样必须选 16:9 卡（进入路径无关性）").toContain(
      "_native.mp4",
    );
    expect(state.src).not.toContain("_portrait.mp4");
    await writeArtifact("s1p2", JSON.stringify({ spec: squareSpec.key, ...state }, null, 2));
  });
});

// ============================================================================
// 场景 1.P3 [visual-residue]：方图日 16:9 卡 contain 纸底 letterbox 截图 + 二值清单
// ============================================================================

describe("[场景1.P3] VISUAL_RESIDUE：方图日 16:9 卡截图 + 二值清单", () => {
  // VISUAL_RESIDUE: 留 QA 真机判定——截图与清单为人工判定辅助，非免自动化金牌
  it("方图日 16:9 卡播放中元素截图落 artifact + 二值清单，video 渲染占位非零且 contain 完整呈现（竖版满屏裁切即红）", async ({
    page,
  }) => {
    const spec = daySpec("squareMain");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);
    expect(state.videoExists, "方图日必须有动态变体").toBe(true);

    // 自动化代理断言：渲染占位非零，且内容适配为 contain 完整呈现（16:9 卡零裁切纸底 letterbox）。
    // 20261110 auto-fix 修订（红队铁律例外「断言机制错」，证据链见 state.md 变更日志）：
    // 原「布局盒 w>h」观测面错误——CSS 契约 .wallpaper-video width/height:100% + 单元 100dvh，
    // 布局盒恒满单元（竖版视口必 h>w，任何实现必红），contain 适配发生在 object-fit 层不改布局盒。
    // 改量内容适配机读态 data-fill（smart-fill 判定）+ 卡内容横版（videoWidth>videoHeight），
    // 与迁移套件 1.P3 同观测面（hero-orientation 绿态先例）；旧竖版卡 cover 满屏裁切则 fill=="cover" → 红。
    const box = await page.locator(wallpaperCardSel(spec.date)).locator("video").boundingBox();
    expect(box, "video 元素必须有渲染占位").not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);
    expect(
      state.fill,
      "方图日 16:9 卡必须 contain 完整呈现（fill==cover 即旧竖版满屏裁切实现）",
    ).toBe("contain");
    expect(
      state.videoWidth > state.videoHeight,
      `卡内容必须横版成型（实际 ${state.videoWidth}x${state.videoHeight}）`,
    ).toBe(true);

    const card = page.locator(wallpaperCardSel(spec.date)).first();
    const shotPath = path.join(ARTIFACT_DIR, "s1p3-square-native-card.png");
    await card.screenshot({ path: shotPath });

    const checklist = [
      "s1p3 二值清单（VISUAL_RESIDUE: 留 QA 真机判定）",
      `截图: ${shotPath}`,
      "fixture: native 卡 1280×720 16:9（1920×1080 比例档），视口 390×844，方图 hero 1080×1080",
      "- [ ] 出现纸底 letterbox 条（上下/左右留白 == 纸底，非黑边）",
      "- [ ] 人物主体完整在画框内（0 裁切——旧竖版卡 cover 裁掉约 54% 源宽度即不通过）",
      "- [ ] 画面比例 == 16:9 原生比例（无拉伸变形）",
      "QA 结论（Y/N）: ____",
    ].join("\n");
    await writeArtifact("s1p3", checklist);

    expect(fs.existsSync(shotPath), "截图必须落 artifact 目录").toBe(true);
    expect(fs.statSync(shotPath).size, "截图必须非空").toBeGreaterThan(0);
  });
});

// ============================================================================
// 场景 2.P1：方图日主钮「保存视频」保存 16:9 卡
// ============================================================================

describe("[场景2.P1] 方图日主钮「保存视频」→ 16:9 卡", () => {
  it("点击主钮保存 → 下载目标 contains _native.mp4 && not _portrait.mp4 ∧ 文件名 拾光动态壁纸-<pickDate>.mp4 契约不变", async ({
    page,
  }) => {
    const spec = daySpec("squareMain");
    await openWallpaperDay(page, spec.date);
    await page.waitForSelector(`${wallpaperCardSel(spec.date)} video`, { timeout: 8000 });

    const saveBtn = page
      .locator(wallpaperCardSel(spec.date))
      .first()
      .locator('[data-role^="wallpaper-download"]')
      .first();
    await saveBtn.waitFor({ state: "visible", timeout: 8000 });

    const dlPromise = page.waitForEvent("download", { timeout: 15000 });
    await saveBtn.click();
    const dl = await dlPromise;

    // 文件名字面量（契约 M3）：拾光动态壁纸-{pickDate}.mp4，方图横屏化不改名
    expect(dl.suggestedFilename(), "保存文件名契约不变（M3）").toBe(
      `拾光动态壁纸-${spec.date}.mp4`,
    );
    // 下载走 fetch→blob 流水线，数据源断言按既有惯例用 __fetchLog
    const fetchLog = await page.evaluate(
      () => (window as unknown as { __fetchLog: string[] }).__fetchLog,
    );
    const nativeFetched = fetchLog.find((u) => u.includes("_native.mp4"));
    // 谓词字面量（2.P1）：target contains "_native.mp4" && target not contains "_portrait.mp4"
    expect(
      nativeFetched,
      `方图日保存视频必须取 16:9 卡数据源，实际 fetchLog：${JSON.stringify(fetchLog)}`,
    ).toContain("_native.mp4");
    expect(
      fetchLog.some((u) => u.includes("_portrait.mp4")),
      "方图日主钮保存不得取竖版卡（杀「只改播放不改保存」半改突变）",
    ).toBe(false);
    await writeArtifact(
      "s2p1",
      JSON.stringify({ suggestedFilename: dl.suggestedFilename(), fetchLog }, null, 2),
    );
  });
});

// ============================================================================
// 场景 3.P1：竖版 hero 日仍自动播放竖版卡（回归护栏）
// ============================================================================

describe("[场景3.P1] 竖版 hero 日仍自动播放竖版卡（回归护栏）", () => {
  it("竖版日（r=0.75）→ video src contains _portrait.mp4 && not _native.mp4（防过度改动伤及竖版）", async ({
    page,
  }) => {
    const spec = daySpec("portraitDay");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.cardExists, "竖版日壁纸卡必须挂载").toBe(true);
    expect(state.videoExists, "竖版日必须以 video 元素渲染动态变体").toBe(true);
    expect(state.paused, "动态变体必须在播").toBe(false);
    // 谓词字面量（3.P1）：src contains "_portrait.mp4" && src not contains "_native.mp4"
    expect(state.src, "竖版日必须仍播放竖版卡").toContain("_portrait.mp4");
    expect(state.src, "竖版日不得改播 16:9 卡").not.toContain("_native.mp4");
    // 数据流字段一致性：src 逐字等于 manifest wallpaperVideoPortrait 字段值
    expect(state.src, "src 必须逐字等于 manifest wallpaperVideoPortrait 字段值").toBe(
      portraitUrl(spec),
    );
    await writeArtifact("s3p1", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });
});

// ============================================================================
// 场景 4.P1：横版 hero 日仍自动播放 16:9 卡（回归护栏）
// ============================================================================

describe("[场景4.P1] 横版 hero 日仍自动播放 16:9 卡（回归护栏）", () => {
  it("横版日（r≈1.333）→ video src contains _native.mp4 && not _portrait.mp4（20261023 现状不回归）", async ({
    page,
  }) => {
    const spec = daySpec("landscapeDay");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.cardExists, "横版日壁纸卡必须挂载").toBe(true);
    expect(state.videoExists, "横版日必须以 video 元素渲染动态变体").toBe(true);
    expect(state.paused, "动态变体必须在播").toBe(false);
    // 谓词字面量（4.P1）：src contains "_native.mp4" && src not contains "_portrait.mp4"
    expect(state.src, "横版日必须仍播放 16:9 卡").toContain("_native.mp4");
    expect(state.src, "横版日不得改播竖版卡").not.toContain("_portrait.mp4");
    await writeArtifact("s4p1", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });
});

// ============================================================================
// 场景 5.P1-P3：方图判定边界（闭区间端点 + 下边界判别对；整数尺寸防浮点歧义）
// ============================================================================

describe("[场景5.P1-P3] 方图判定边界", () => {
  it("5.P1: r==0.9（900×1000，闭区间下端点）→ 按方图判定播 16:9 卡（杀 >= 写成 > 的方向突变）", async ({
    page,
  }) => {
    const spec = daySpec("bandLow");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.videoExists, "下端点日必须有动态变体").toBe(true);
    // 谓词字面量（5.P1）：src contains "_native.mp4"
    expect(state.src, "r=0.9 恰在闭区间内必须按方图播 16:9 卡").toContain("_native.mp4");
    expect(state.src).not.toContain("_portrait.mp4");
    expect(state.paused).toBe(false);
    await writeArtifact("s5p1", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });

  it("5.P2: r==1.1（1100×1000，闭区间上端点）→ 按方图判定播 16:9 卡（谓词字面量锚定；1.1 侧边界突变 UI 不可判别，SSOT 备注 explicit 交实现内单测）", async ({
    page,
  }) => {
    const spec = daySpec("bandHigh");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.videoExists, "上端点日必须有动态变体").toBe(true);
    // 谓词字面量（5.P2）：src contains "_native.mp4"
    expect(state.src, "r=1.1 恰在闭区间内必须按方图播 16:9 卡").toContain("_native.mp4");
    expect(state.src).not.toContain("_portrait.mp4");
    expect(state.paused).toBe(false);
    await writeArtifact("s5p2", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });

  it("5.P3: r==0.89（890×1000，带外下侧）→ 按竖版分支播竖版卡（0.9/0.89 判别对，杀下边界吞入突变）", async ({
    page,
  }) => {
    const spec = daySpec("belowBand");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.videoExists, "带外下侧日必须有动态变体").toBe(true);
    // 谓词字面量（5.P3）：src contains "_portrait.mp4" && src not contains "_native.mp4"
    expect(state.src, "r=0.89 在带外必须按竖版分支播竖版卡").toContain("_portrait.mp4");
    expect(state.src, "r=0.89 不得被吞入方图/横版分支播 16:9 卡").not.toContain("_native.mp4");
    expect(state.paused).toBe(false);
    await writeArtifact("s5p3", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });
});

// ============================================================================
// 场景 6.P1 + 6.P2：方图日「更多」菜单保留「保存竖版视频」且仍指向竖版卡文件
// ============================================================================

describe("[场景6.P1+6.P2] 方图日「更多」菜单保留「保存竖版视频」", () => {
  const PORTRAIT_SAVE_LABEL = "保存竖版视频";

  it("6.P1: 方图日展开「更多」菜单 → 菜单含「保存竖版视频」项且可见（杀顺手删入口突变）", async ({
    page,
  }) => {
    const spec = daySpec("squareMain");
    await openWallpaperDay(page, spec.date);
    const cardSel = wallpaperCardSel(spec.date);
    await page.waitForSelector(cardSel, { timeout: 8000 });

    await openMoreMenu(page, cardSel);
    const hit = await findMenuItem(page, cardSel, PORTRAIT_SAVE_LABEL);
    await writeArtifact("s6p1", JSON.stringify(hit, null, 2));

    // 谓词字面量（6.P1）：menu contains "保存竖版视频" && item_visible == true
    expect(hit, "展开的菜单中必须存在「保存竖版视频」项").not.toBeNull();
    expect(hit?.visibleText ?? "", "菜单项可见文本必须含「保存竖版视频」").toContain(
      PORTRAIT_SAVE_LABEL,
    );
    expect(hit?.itemVisible, "「保存竖版视频」菜单项必须可见").toBe(true);
  });

  it("6.P2: 方图日点击「保存竖版视频」→ 取回竖版卡 mp4（target contains _portrait.mp4，杀菜单改线突变）", async ({
    page,
  }) => {
    const spec = daySpec("squareMain");
    await openWallpaperDay(page, spec.date);
    const cardSel = wallpaperCardSel(spec.date);

    await openMoreMenu(page, cardSel);
    // 先经 evaluate 找到匹配项的 data-role（不硬编码未在先例声明的私有 role）
    const hit = await findMenuItem(page, cardSel, PORTRAIT_SAVE_LABEL);
    expect(hit, "菜单项「保存竖版视频」必须存在").not.toBeNull();
    const itemLocator = hit?.role
      ? page.locator(`${MORE_POPOVER(cardSel)} [data-role="${hit.role}"]`)
      : page.locator(`${MORE_POPOVER(cardSel)} *`).filter({ hasText: PORTRAIT_SAVE_LABEL });
    await itemLocator.first().waitFor({ state: "visible", timeout: 5000 });

    const dlPromise = page.waitForEvent("download", { timeout: 15000 });
    await itemLocator.first().click();
    const dl = await dlPromise;

    // CONTRACT_AMBIGUOUS: 竖版保存文件名契约未在 §契约规约 声明（主钮名契约 M3 仅覆盖主视频
    // 16:9 卡），故只断言下载产物为视频类型，不锚定具体文件名
    expect(dl.suggestedFilename(), "竖版保存产物必须是 mp4 视频").toContain(".mp4");

    const fetchLog = await page.evaluate(
      () => (window as unknown as { __fetchLog: string[] }).__fetchLog,
    );
    const portraitFetched = fetchLog.find((u) => u.includes("_portrait.mp4"));
    // 谓词字面量（6.P2）：target contains "_portrait.mp4"
    expect(
      portraitFetched,
      `「保存竖版视频」必须取竖版卡数据源，实际 fetchLog：${JSON.stringify(fetchLog)}`,
    ).toContain("_portrait.mp4");
    expect(
      fetchLog.some((u) => u.includes("_native.mp4")),
      "「保存竖版视频」不得改线到 16:9 卡（恒读 portrait 字段，M3）",
    ).toBe(false);
    await writeArtifact(
      "s6p2",
      JSON.stringify({ fetchLog, suggestedFilename: dl.suggestedFilename() }, null, 2),
    );
  });
});

// ============================================================================
// 场景 7.P1 + 7.P2：照片宽高缺失回退现状兜底，不被误判为方图
// ============================================================================

describe("[场景7.P1+7.P2] 维度缺失回退兜底基线", () => {
  it("7.P1: hero 维度缺失（w/h==0）双卡日 → 按基线 native>portrait>landscape 选择且零未捕获错误（negate：缺维度不得误入新方图分支——行为与基线一致）", async ({
    page,
  }) => {
    const spec = daySpec("missingDimsA");
    const pageErrors: string[] = [];
    const appConsoleErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (msg) => {
      // 「零 console.error」口径：app.js 自身链路不得产生 console.error
      //（浏览器网络层 Failed to load resource 的 location 非 app.js，不计入）
      if (msg.type() === "error" && (msg.location()?.url ?? "").endsWith("app.js")) {
        appConsoleErrors.push(msg.text());
      }
    });

    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    // negate 断言：不得仅因缺维度被归入新方图分支之外的行为（渲染失效/退静态/抛错）
    expect(state.videoExists, "维度缺失日不得误判为无视频").toBe(true);
    // 谓词字面量（7.P1）：src 按基线序选择（native > portrait > landscape）→ native
    expect(state.src, "维度缺失日必须按基线 native 优先选择").toBe(nativeUrl(spec));
    expect(state.paused).toBe(false);
    // 谓词字面量（7.P1）：console_error_count == 0（杀 r=NaN/Infinity 崩溃突变）
    expect(pageErrors, `不得有未捕获 JS 错误：${JSON.stringify(pageErrors)}`).toHaveLength(0);
    expect(
      appConsoleErrors,
      `app.js 链路不得产生 console.error：${JSON.stringify(appConsoleErrors)}`,
    ).toHaveLength(0);
    await writeArtifact(
      "s7p1",
      JSON.stringify({ spec: spec.key, ...state, pageErrors, appConsoleErrors }, null, 2),
    );
  });

  it("7.P2: 维度缺失且仅存竖版卡单一变体 → 播该唯一可用变体（杀缺维度误退化静态突变）", async ({
    page,
  }) => {
    const spec = daySpec("missingDimsB");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.videoExists, "单一变体日不得退化为静态卡").toBe(true);
    // 谓词字面量（7.P2）：src contains "_portrait.mp4"
    expect(state.src, "仅存竖版卡时必须播放该唯一变体").toContain("_portrait.mp4");
    expect(state.src, "src 必须逐字等于 manifest wallpaperVideoPortrait 字段值").toBe(
      portraitUrl(spec),
    );
    expect(state.paused, "唯一变体必须在播").toBe(false);
    await writeArtifact("s7p2", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });
});

// ============================================================================
// 场景 8.P1 + 8.P2：manifest 无动态视频字段日回退静态卡不受影响（回归护栏）
// ============================================================================

describe("[场景8.P1+8.P2] 静态卡回退护栏", () => {
  const readStaticState = (page: Page, date: string) =>
    page.evaluate((d) => {
      const unit = document.querySelector(
        `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${d}"]`,
      );
      const videos = Array.from(unit?.querySelectorAll("video") ?? []);
      const img = unit?.querySelector("img") as HTMLImageElement | null;
      return {
        cardRendered: !!unit,
        hasVideoAttr: unit?.getAttribute("data-has-video") ?? null,
        videoCount: videos.length,
        videoVisible: videos.some(
          (v) => getComputedStyle(v).display !== "none" && v.getClientRects().length > 0,
        ),
        imgVisible: !!img && img.getClientRects().length > 0,
        imgComplete: img?.complete ?? false,
        imgNaturalWidth: img?.naturalWidth ?? 0,
        imgSrc: img?.getAttribute("src") ?? null,
      };
    }, date);

  it("8.P1: 零动态字段日 → 静态壁纸卡（video 不可见 ∧ 静态 img 可见加载完成 ∧ 零错误；不得空 video 或裂图）", async ({
    page,
  }) => {
    const spec = daySpec("noVideo");
    const pageErrors: string[] = [];
    const appConsoleErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (msg) => {
      if (msg.type() === "error" && (msg.location()?.url ?? "").endsWith("app.js")) {
        appConsoleErrors.push(msg.text());
      }
    });

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

    const result = await readStaticState(page, spec.date);
    // 谓词字面量（8.P1）：video_visible == false && static_img_visible == true
    expect(result.videoCount, "零字段日卡内不得出现任何 video 节点（negate：不得空 video）").toBe(
      0,
    );
    expect(result.videoVisible, "video 不得可见").toBe(false);
    expect(result.imgVisible, "静态 img 必须可见").toBe(true);
    expect(
      result.imgComplete && result.imgNaturalWidth > 0,
      "静态 img 必须加载完成（negate：裂图）",
    ).toBe(true);
    // 数据流字段一致性：静态 img 数据源 == manifest wallpaperPortrait 字段值
    expect(result.imgSrc, "静态卡 img 必须取 manifest wallpaperPortrait 字段").toBe(
      `wallpapers/${spec.date}_v2-contain-1290x2796.jpg`,
    );
    expect(pageErrors, `不得有未捕获 JS 错误：${JSON.stringify(pageErrors)}`).toHaveLength(0);
    expect(
      appConsoleErrors,
      `app.js 链路不得产生 console.error：${JSON.stringify(appConsoleErrors)}`,
    ).toHaveLength(0);
    await writeArtifact(
      "s8p1",
      JSON.stringify({ ...result, pageErrors, appConsoleErrors }, null, 2),
    );
  });

  it("8.P2: 动态字段存在但为空串 → 同样回退静态卡（video 不可见 ∧ 静态 img 可见，杀空串误判动态突变）", async ({
    page,
  }) => {
    const spec = daySpec("emptyStrings");
    await page.goto(`${BASE}/#/?date=${spec.date}`);
    await page.waitForSelector(wallpaperCardSel(spec.date), { timeout: 12000 });
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

    const result = await readStaticState(page, spec.date);
    // 谓词字面量（8.P2）：video_visible == false && static_img_visible == true
    expect(result.videoVisible, "空串字段日不得出现可见 video（空串必须按无动态处理）").toBe(false);
    expect(result.imgVisible, "空串字段日必须回退静态 img 可见").toBe(true);
    expect(result.imgComplete && result.imgNaturalWidth > 0, "静态 img 必须加载完成").toBe(true);
    await writeArtifact("s8p2", JSON.stringify(result, null, 2));
  });
});

// ============================================================================
// M4 / 兜底链补面（plan 审查重要问题 1 闭合）
// ============================================================================

describe("[M4/兜底链补面] 存量日无 portrait 兜底 native + landscape 第三兜底", () => {
  it("M4: 方图存量日仅 native 字段（0928~1008 legacy 形态）→ 兜底 native 语义不变（仍动态）", async ({
    page,
  }) => {
    const spec = daySpec("squareLegacy");
    await openWallpaperDay(page, spec.date);
    const state = await readVideoState(page, spec.date);

    expect(state.videoExists, "存量日无 portrait 不得退化为静态卡").toBe(true);
    expect(state.src, "方图存量日兜底必须落 native（语义不变）").toBe(nativeUrl(spec));
    expect(state.paused, "兜底后动态变体仍须在播").toBe(false);
    await writeArtifact("m4-square-legacy", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });

  it("M1 链尾: 方图日仅 landscape 字段 → 第三兜底可达（video 渲染 ∧ src contains _landscape.mov）", async ({
    page,
  }) => {
    const spec = daySpec("landscapeOnly");
    // .mov 链尾日仅断言选择结果（src），不断言播放态（fixture .mov 若解码失败会误红）
    await openWallpaperDay(page, spec.date, false);
    const state = await readVideoState(page, spec.date);

    expect(state.videoExists, "landscape-only 日必须渲染动态变体（不得退静态）").toBe(true);
    expect(state.src, "第三兜底必须落 Aerial 卡").toContain("_landscape.mov");
    expect(state.src).not.toContain("_native.mp4");
    expect(state.src).not.toContain("_portrait.mp4");
    await writeArtifact("m1-landscape-only", JSON.stringify({ spec: spec.key, ...state }, null, 2));
  });
});

/**
 * 验收测试（红队 E2E）：推送链接直达当日壁纸卡（谓词 DW.P1-P6 + 错误契约补充）
 *
 * 设计契约来源（state.md §目标 / §方案设计（方案 A）/ §契约规约 / §修复后的期望行为 / §验收场景）：
 *   - 目标：企微推送链接 `galleryPublicUrl + /#/?date=<pickDate>` 打开后直接定位当日壁纸卡
 *     （动态变体自动播放），而非落到第一张照片；后端拼链零改动，仅画廊前端 handleDeeplink
 *     无 rank date 分支的定位优先级改为：该日壁纸卡 → date-separator → 该日首照片。
 *   - rank 分支与 #/video/<id> 分支零改动；无 hash 加载零改动；scheduleUrlSync 维持排除壁纸卡回写。
 *
 * 契约规约（断言锚点与 state.md §契约规约 逐字一致）：
 *   - URL 契约：#/?date=<pickDate>（^\d{4}-\d{2}-\d{2}$），可选 &rank=<n>（n ≥ 1 整数）
 *   - 壁纸卡 DOM：[data-stream-unit][data-unit-type="wallpaper"][data-day-date="<pickDate>"]；
 *     动态变体附加 data-has-video="1"；卡内 .wallpaper-stage（模糊封面 img 垫底）+
 *     <video muted loop playsinline>，src = manifest wallpaperVideoPortrait；
 *     静态变体 <img> src = manifest wallpaperPortrait、无 <video> 元素
 *   - 照片卡：[data-unit-type="photo"][data-day-date][data-photo-rank]；
 *     分隔卡：[data-unit-type="date-separator"][data-day-date]
 *   - W1: 壁纸卡 top < vph*0.5 且 top > -unitHeight*0.5（DL.V2 rect 口径）；该日 separator top < vph*0.5
 *   - W2: 动态变体定位后 ≤3s 轮询窗口内 video.paused == false 且 video.muted == true
 *   - W4: URL 含 rank → rank 分支优先，壁纸卡不得劫持
 *   - W6: 目标日未挂载（dayIndex ≥ 2）→ 按日增量挂载至该日后重查壁纸卡（禁 mountAllUnits 全量兜底）
 *   - 错误契约：play() reject → 吞错、定位仍完成、无未捕获异常；深链日期无对应日 → 不崩、流正常渲染
 *
 * 谓词覆盖（每个 it 均含 expect.* 硬断言，失败必挂；无 skip / warn-soft-pass）：
 *   - DW.P1 [det-machine] 静态壁纸历史日（days[1]）no-rank 深链 → 壁纸卡定位（W1 + 静态变体 DOM 契约）
 *   - DW.P2 [det-machine] 流顶日动态壁纸卡（days[0]）no-rank 深链 → 定位 + muted 起播
 *     （主链路 = 推送真实场景；Tier 1.5 真实场景谓词求值，artifact 落 /tmp/autopilot-artifacts/DW.P2.out）
 *   - DW.P3 [det-machine] 深历史日动态壁纸卡（days[3]，dayIndex ≥ 2 初始未挂载）→
 *     增量挂载后定位 + 起播（W6；含「目标日之后一天不被挂出」判别断言杀 mountAllUnits 兜底 mutation）
 *   - DW.P4 [det-machine] 无壁纸卡历史日（days[2]）→ 回退 separator（零回归）
 *   - DW.P5 [det-machine] rank 深链（days[1]&rank=3）不被壁纸卡劫持（回归，W4）
 *   - DW.P6 [det-machine] #/video/<themeKey> 定位（DL.V2 口径）+ 无 hash 加载零回归（冒烟）
 *   - [错误契约·补充] 深链日期无对应日 → 不崩；壁纸视频解码失败 → 定位仍完成、无未捕获异常
 *
 * fixture 依赖（红队私有 fixture，禁改共享 gen-manifest.mjs 默认输出语义；沿
 * gallery-wallpaper-hero / gallery-wallpaper-video 私有 buildFixture 惯例）：
 *   - days[0] 动态顶日（wallpaperPortrait + wallpaperVideoPortrait → fixtures/video-sample.mp4 拷贝）
 *   - days[1] 静态（wallpaperPortrait 有、无 wallpaperVideoPortrait 字段）+ rank=1..4 照片（P5 用 rank=3）
 *   - days[2] 无壁纸（wallpaperLandscape/wallpaperPortrait 显式 null）
 *   - days[3] 动态 + rank=1..8 照片（dayIndex=3 ≥ 初始挂载 2 天；竖比照片保证该日足够高，
 *     落位后不触发尾部分页懒挂载 → days[4] 守卫日不被意外挂出）
 *   - days[4] 无壁纸守卫日（W6 判别：mountAllUnits 全量兜底会把它挂出来 → 增量挂载则不可见）
 *   - videos[0] 归属 days[1] 的主题视频（themeKey，DW.P6 video 深链目标，初始挂载内免全量挂载）
 *   - 错误契约夹具（独立端口 8796）：days[0] wallpaperVideoPortrait 指向非法字节文件（解码失败路径）
 *
 * 红队铁律：不读 app.js/app.css/index.html 实现内容，仅依据上述契约 + DOM 锚点黑盒编写。
 *   harness 约定沿 gallery-deeplink / gallery-wallpaper-video 套件：隔离临时目录 +
 *   python3 -m http.server --bind 127.0.0.1（避 dual-stack 半死态坑）+ 套件专属端口
 *   8794（备 8795 自动让位；env GALLERY_DW_PORT 显式优先）+ GALLERY_SRC_DIR 暂存区支持；
 *   artifact 落 /tmp/autopilot-artifacts。
 *   等待策略：waitForFunction 轮询「目标单元 rect 数值」而非仅 visible，轮询通过后再复评
 *   终态做硬断言（滚动/挂载/rAF 重查完成前不判负，完成后不宽容）。
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
const { describe, beforeAll, afterAll, beforeEach } = test;
const it = test;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 暂存区运行由 GALLERY_SRC_DIR 指向真实 apps/gallery；merge 后 __dirname/../ 即 apps/gallery
const SRC_GALLERY_DIR = process.env.GALLERY_SRC_DIR ?? path.resolve(__dirname, "../");
/** 预生成可播放 mp4 样本（10s baseline H.264，Chromium 可解码 autoplay；fixtures 既有资产）。
 *  target 位置 = __dirname/fixtures/；暂存区运行回退 SRC_GALLERY_DIR/__tests__/fixtures/。 */
const VIDEO_SAMPLE = ((): string => {
  const inTarget = path.join(__dirname, "fixtures", "video-sample.mp4");
  if (fs.existsSync(inTarget)) return inTarget;
  return path.join(SRC_GALLERY_DIR, "__tests__", "fixtures", "video-sample.mp4");
})();
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

// 端口：主夹具 8794（备 8795 自动让位）/ 错误契约夹具 8796；env 显式指定优先
const PORT_ERR = Number(process.env.GALLERY_DW_ERR_PORT ?? 8796);
const BASE_ERR = `http://127.0.0.1:${PORT_ERR}`;

let STATIC_PORT = 0;
let STATIC_BASE = "";
let MAIN_DIR = "";
let mainManifest: FixtureManifest;
let errManifest: FixtureManifest;
const servers: ChildProcess[] = [];
const fixtureRoots: string[] = [];

// ---- fixture 占位 JPEG（零运行时依赖；与 fixtures/gen-manifest.mjs 同源 base64）----
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomIygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmGmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3iigoAKKKKACiiigA/9k=";
const WP_LANDSCAPE_JPEG_B64 =
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAEAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJAA/9k=";
const WP_PORTRAIT_JPEG_B64 =
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJAAP//Z";

function writeJpeg(filePath: string, b64: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
}

// ---- 私有 fixture manifest 类型（字段名与共享 gen-manifest.mjs 产物同源）----
interface FixturePhoto {
  photoId: string;
  rank: number;
  title: string;
  narrative: string;
  thumbnail: string;
  original: string;
  takenAt: string;
  width: number;
  height: number;
}
interface FixtureDay {
  pickDate: string;
  title: string;
  narrative: string;
  wallpaperLandscape: string | null;
  wallpaperPortrait: string | null;
  wallpaperVideoPortrait?: string;
  photos: FixturePhoto[];
}
interface FixtureVideo {
  id: string;
  themeKey: string;
  themeKind: string;
  title: string;
  narrative: string;
  mp4: string;
  cover: string;
  durationSec: number;
  photoCount: number;
  createdAt: string;
}
interface FixtureManifest {
  generatedAt: string;
  days: FixtureDay[];
  videos: FixtureVideo[];
}

/** DW.P6 video 深链目标 themeKey（归属 days[1]，初始挂载内 → 冒烟路径免全量挂载） */
const THEME_KEY = "trip-deeplink-wp-2024";

/**
 * 构建隔离 fixture 目录：三件套 + fonts + 私有 manifest.json + 占位图/视频。
 * - 默认：days[0]/days[3] 动态、days[1] 静态、days[2]/days[4] 无壁纸。
 * - corruptWallpaperVideo=true（错误契约夹具）：days[0] 的竖版壁纸 mp4 换成非法字节
 *   （HTTP 200 但非媒体 → 解码失败 → play() reject 路径）。
 */
function buildFixture(
  rootDir: string,
  opts: { corruptWallpaperVideo?: boolean } = {},
): FixtureManifest {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.mkdirSync(rootDir, { recursive: true });
  for (const f of ["index.html", "app.css", "app.js"]) {
    fs.copyFileSync(path.join(SRC_GALLERY_DIR, f), path.join(rootDir, f));
  }
  const fontsDir = path.join(SRC_GALLERY_DIR, "fonts");
  if (fs.existsSync(fontsDir)) {
    fs.cpSync(fontsDir, path.join(rootDir, "fonts"), { recursive: true });
  }

  const iso = (offsetDays: number) =>
    new Date(Date.now() - offsetDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const d = [iso(0), iso(1), iso(2), iso(3), iso(4)];

  let photoSeq = 0;
  const mkPhoto = (dayTag: string, rank: number, width: number, height: number): FixturePhoto => {
    photoSeq += 1;
    const photoId = `photo-dw-${dayTag}-${String(rank).padStart(2, "0")}-${String(photoSeq).padStart(3, "0")}`;
    writeJpeg(path.join(rootDir, "photos", `${photoId}-thumb.jpg`), TINY_JPEG_B64);
    writeJpeg(path.join(rootDir, "photos", `${photoId}-mid.jpg`), TINY_JPEG_B64);
    return {
      photoId,
      rank,
      title: `DW 第 ${rank} 张`,
      narrative: `DW fixture 第 ${rank} 张的叙事文案，长度足够通过非空断言。`,
      thumbnail: `photos/${photoId}-thumb.jpg`,
      original: `photos/${photoId}-mid.jpg`,
      takenAt: "2024-07-15T10:00:00.000Z",
      width,
      height,
    };
  };
  const mkPhotos = (dayTag: string, count: number, width = 4032, height = 3024) =>
    Array.from({ length: count }, (_, i) => mkPhoto(dayTag, i + 1, width, height));

  // 壁纸占位图（days[0]/days[1]/days[3] 有壁纸；days[2]/days[4] 无 → 字段显式 null）
  for (const date of [d[0], d[1], d[3]]) {
    writeJpeg(
      path.join(rootDir, "wallpapers", `${date}_v2-contain-default.jpg`),
      WP_LANDSCAPE_JPEG_B64,
    );
    writeJpeg(
      path.join(rootDir, "wallpapers", `${date}_v2-contain-1290x2796.jpg`),
      WP_PORTRAIT_JPEG_B64,
    );
  }

  // 动态壁纸竖版视频（days[0]/days[3]；错误契约夹具把 days[0] 的 mp4 换成非法字节）
  fs.mkdirSync(path.join(rootDir, "wallpaper-videos"), { recursive: true });
  const wallpaperVideoPortrait = (date: string) => `wallpaper-videos/${date}_portrait.mp4`;
  for (const date of [d[0], d[3]]) {
    const dst = path.join(rootDir, wallpaperVideoPortrait(date));
    if (opts.corruptWallpaperVideo === true && date === d[0]) {
      fs.writeFileSync(dst, Buffer.from("not-a-valid-mp4-dw-error-contract-corrupt-bytes", "utf8"));
    } else {
      fs.copyFileSync(VIDEO_SAMPLE, dst);
    }
  }

  // 主题视频（归属 days[1]，DW.P6 video 深链目标）
  fs.mkdirSync(path.join(rootDir, "videos"), { recursive: true });
  const themeMp4 = `videos/${THEME_KEY}.mp4`;
  const themeCover = `videos/${THEME_KEY}-cover.jpg`;
  fs.copyFileSync(VIDEO_SAMPLE, path.join(rootDir, themeMp4));
  writeJpeg(path.join(rootDir, themeCover), TINY_JPEG_B64);

  const mkDay = (
    date: string,
    title: string,
    wallpaper: boolean,
    video: boolean,
    photos: FixturePhoto[],
  ): FixtureDay => {
    const day: FixtureDay = {
      pickDate: date,
      title,
      narrative: `${title}的整体叙事。`,
      wallpaperLandscape: wallpaper ? `wallpapers/${date}_v2-contain-default.jpg` : null,
      wallpaperPortrait: wallpaper ? `wallpapers/${date}_v2-contain-1290x2796.jpg` : null,
      photos,
    };
    if (video) day.wallpaperVideoPortrait = wallpaperVideoPortrait(date);
    return day;
  };

  const manifest: FixtureManifest = {
    generatedAt: new Date().toISOString(),
    days: [
      // days[0] 动态顶日（推送真实场景 = 主链路 DW.P2）
      mkDay(d[0], "今日精选", true, true, mkPhotos("d0", 3)),
      // days[1] 静态壁纸日（DW.P1 / DW.P5 rank=3）
      mkDay(d[1], "昨日精选", true, false, mkPhotos("d1", 4)),
      // days[2] 无壁纸日（DW.P4 回退 separator）
      mkDay(d[2], "前天精选", false, false, mkPhotos("d2", 3)),
      // days[3] 深历史动态日（DW.P3 增量挂载路径；竖比照片抬高该日，
      // 避免落位后触发尾部分页把守卫日懒挂载出来）
      mkDay(d[3], "大前天精选", true, true, mkPhotos("d3", 8, 3024, 4032)),
      // days[4] 无壁纸守卫日（W6 判别：全量挂载兜底会把它挂出来）
      mkDay(d[4], "四天前精选", false, false, mkPhotos("d4", 2)),
    ],
    videos: [
      {
        id: "5f2a7c1e-93d4-4b15-8a2e-6b0c9d1e0001",
        themeKey: THEME_KEY,
        themeKind: "trip",
        title: "DW 深链冒烟视频",
        narrative: "归属昨日（初始挂载内）的 video 深链冒烟目标。",
        mp4: themeMp4,
        cover: themeCover,
        durationSec: 60,
        photoCount: 3,
        createdAt: `${d[1]}T03:00:00.000Z`,
      },
    ],
  };
  fs.writeFileSync(path.join(rootDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---- 静态服务（--bind 127.0.0.1，规避 python http.server dual-stack 半死态坑）----

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function startStaticServer(port: number, dir: string): Promise<void> {
  const pyLogPath = path.join(dir, "py-server.log");
  const pyLogFd = fs.openSync(pyLogPath, "a");
  const proc = spawn(
    process.env.GALLERY_PYTHON_BIN ?? "python3",
    ["-m", "http.server", "--bind", "127.0.0.1", String(port), "--directory", dir],
    { stdio: ["ignore", pyLogFd, pyLogFd] },
  );
  servers.push(proc);
  fixtureRoots.push(dir);
  // 轮询就绪（比固定 sleep 更稳；失败带日志尾部）
  const deadline = Date.now() + 20000;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/manifest.json`);
      if (res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const logTail = fs.existsSync(pyLogPath)
    ? fs.readFileSync(pyLogPath, "utf8").slice(-800)
    : "(无日志)";
  throw new Error(`静态服务 ${port} 未就绪（lastErr: ${lastErr}；py-server.log 尾部: ${logTail}）`);
}

beforeAll(async () => {
  test.setTimeout(30_000); // hook 级超时（Playwright 1.59 beforeAll 无 timeout 重载）
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  expect(
    fs.existsSync(VIDEO_SAMPLE),
    `可播放 mp4 样本必须存在（target 或 SRC_GALLERY_DIR 回退路径）: ${VIDEO_SAMPLE}`,
  ).toBe(true);

  STATIC_PORT = process.env.GALLERY_DW_PORT
    ? Number(process.env.GALLERY_DW_PORT)
    : (await isPortFree(8794))
      ? 8794
      : 8795;
  STATIC_BASE = `http://127.0.0.1:${STATIC_PORT}`;
  MAIN_DIR = path.join(os.tmpdir(), `relight-gallery-dw-${STATIC_PORT}`);

  const errDir = path.join(os.tmpdir(), `relight-gallery-dw-err-${PORT_ERR}`);
  mainManifest = buildFixture(MAIN_DIR);
  errManifest = buildFixture(errDir, { corruptWallpaperVideo: true });
  await startStaticServer(STATIC_PORT, MAIN_DIR);
  await startStaticServer(PORT_ERR, errDir);
});

afterAll(async () => {
  for (const s of servers) s.kill("SIGTERM");
  for (const dir of fixtureRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
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
// fixture 目标定位（前置硬断言：fixture 不满足契约 → 直接红，不静默降级）
// ============================================================================

/** 初始挂载天数（设计：初始只挂最新 2 天） */
const INITIAL_MOUNT_DAYS = 2;

interface DwTargets {
  dynamicTopDay: string;
  staticDay: string;
  noWallpaperDay: string;
  deepHistoryDay: string;
  guardDay: string;
  themeKey: string;
}

function fixtureTargets(): DwTargets {
  const days = mainManifest.days;
  expect(
    days,
    "fixture 应有 5 天（0 动态顶日 / 1 静态 / 2 无壁纸 / 3 动态深历史 / 4 守卫）",
  ).toHaveLength(5);
  expect(days[0]!.wallpaperPortrait, "days[0] 动态顶日应有 wallpaperPortrait").toBeTruthy();
  expect(
    days[0]!.wallpaperVideoPortrait,
    "days[0] 动态顶日应有 wallpaperVideoPortrait",
  ).toBeTruthy();
  expect(days[1]!.wallpaperPortrait, "days[1] 静态日应有 wallpaperPortrait").toBeTruthy();
  expect(
    days[1]!.wallpaperVideoPortrait,
    "days[1] 静态日不得有 wallpaperVideoPortrait 字段",
  ).toBeUndefined();
  expect(days[2]!.wallpaperPortrait ?? null, "days[2] 应无竖版壁纸（null）").toBeNull();
  expect(days[2]!.wallpaperLandscape ?? null, "days[2] 应无横版壁纸（null）").toBeNull();
  expect(days[3]!.wallpaperPortrait, "days[3] 深历史日应有 wallpaperPortrait").toBeTruthy();
  expect(
    days[3]!.wallpaperVideoPortrait,
    "days[3] 深历史日应有 wallpaperVideoPortrait",
  ).toBeTruthy();
  expect(
    days[1]!.photos.some((p) => p.rank === 3),
    "fixture days[1] 应含 rank=3 照片（DW.P5 依赖）",
  ).toBe(true);
  const themeVideo = mainManifest.videos[0]!;
  expect(themeVideo.themeKey, `videos[0].themeKey 应为 ${THEME_KEY}（DW.P6 深链目标）`).toBe(
    THEME_KEY,
  );
  expect(
    mainManifest.videos.some((v) => v.createdAt.slice(0, 10) === days[1]!.pickDate),
    "主题视频应归属 days[1]（初始挂载内，DW.P6 冒烟免全量挂载）",
  ).toBe(true);
  // days[3] 必须在初始挂载之外（DW.P3 前提）；days[4] 守卫日在其后
  expect(INITIAL_MOUNT_DAYS, "设计：初始只挂最新 2 天").toBe(2);
  expect(days[3]!.pickDate, "days[3] 必须是 dayIndex=3 的深历史日").toBeTruthy();

  return {
    dynamicTopDay: days[0]!.pickDate,
    staticDay: days[1]!.pickDate,
    noWallpaperDay: days[2]!.pickDate,
    deepHistoryDay: days[3]!.pickDate,
    guardDay: days[4]!.pickDate,
    themeKey: themeVideo.themeKey,
  };
}

// ============================================================================
// 契约锚点选择器（断言锚点与 §契约规约 逐字一致）
// ============================================================================

const wallpaperCardSelector = (date: string) =>
  `[data-stream-unit][data-unit-type="wallpaper"][data-day-date="${date}"]`;
const separatorSelector = (date: string) =>
  `[data-stream-unit][data-unit-type="date-separator"][data-day-date="${date}"]`;

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
  dayDate: string | null;
  hasVideo: string | null;
  photoRank: string | null;
  videoId: string | null;
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
        dayDate: null,
        hasVideo: null,
        photoRank: null,
        videoId: null,
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
      dayDate: el.getAttribute("data-day-date"),
      hasVideo: el.getAttribute("data-has-video"),
      photoRank: el.getAttribute("data-photo-rank"),
      videoId: el.getAttribute("data-video-id"),
    };
  }, selector);
}

/**
 * 硬等目标单元进入「视口上半区」：top < vph*0.5 且 top > -unitHeight*0.5（W1/DL.V2 契约字面量）。
 * 深链的定位（含增量挂载 + rAF 重查 + scrollIntoView）全部完成前不判负；超时即红（kill no-op mutation）。
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
  await page.waitForTimeout(800);
}

/** W2 口径：卡内 <video> muted 起播（paused==false 且 muted==true），3s 轮询窗口由调用方传入 */
async function waitVideoPlaying(page: Page, selector: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (sel: string) => {
      const v = document.querySelector(sel)?.querySelector("video") as HTMLVideoElement | null;
      return !!v && v.paused === false && v.muted === true;
    },
    selector,
    { timeout: timeoutMs, polling: 100 },
  );
}

/** 视口停留单元（首个与视口相交的流单元），沿 DL.P1 的「in-view」口径 */
async function firstInViewUnit(
  page: Page,
): Promise<{ dayDate: string | null; unitType: string | null }> {
  return page.evaluate(() => {
    const vph = window.innerHeight;
    const el = Array.from(document.querySelectorAll("[data-stream-unit]")).find((u) => {
      const r = u.getBoundingClientRect();
      return r.top < vph && r.bottom > 0;
    });
    return el
      ? { dayDate: el.getAttribute("data-day-date"), unitType: el.getAttribute("data-unit-type") }
      : { dayDate: null, unitType: null };
  });
}

// ============================================================================
// DW.P1 [det-machine]：静态壁纸历史日 no-rank 深链 → 壁纸卡定位
// ============================================================================

describe("[DW.P1][det-machine] 静态壁纸历史日 no-rank 深链 → 该日壁纸卡定位（W1）", () => {
  it("打开 #/?date=<days[1]> 后静态壁纸卡进视口上半区且该日 separator 过折叠线", async ({
    page,
  }) => {
    const t = fixtureTargets();
    const cardSel = wallpaperCardSelector(t.staticDay);
    const sepSel = separatorSelector(t.staticDay);

    await page.goto(`${STATIC_BASE}/#/?date=${t.staticDay}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    await waitUnitInUpperHalf(page, cardSel, 10000);

    const rect = await readUnitRect(page, cardSel);
    const sep = await readUnitRect(page, sepSel);
    const inView = await firstInViewUnit(page);
    // 静态变体 DOM 契约：<img src=wallpaperPortrait> ∧ 零 <video> ∧ 无 data-has-video
    const staticDom = await page.evaluate((sel: string) => {
      const card = document.querySelector(sel);
      const img = card?.querySelector("img") as HTMLImageElement | null;
      return {
        hasVideoAttr: card?.getAttribute("data-has-video") ?? null,
        videoCount: card ? card.querySelectorAll("video").length : -1,
        imgSrc: img?.getAttribute("src") ?? null,
      };
    }, cardSel);

    await writeArtifact(
      "DW.P1",
      JSON.stringify({ targetDate: t.staticDay, rect, sep, inView, staticDom }),
    );

    // 谓词字面量：壁纸卡存在 ∧ top < vph*0.5 ∧ top > -卡高*0.5
    expect(rect.exists, `该日壁纸卡必须挂载：${cardSel}`).toBe(true);
    expect(rect.unitType).toBe("wallpaper");
    expect(rect.dayDate).toBe(t.staticDay);
    expect(rect.top, `壁纸卡 top=${rect.top} 应 < vph*0.5=${rect.vph * 0.5}`).toBeLessThan(
      rect.vph * 0.5,
    );
    expect(
      rect.top,
      `壁纸卡 top=${rect.top} 应 > -卡高*0.5=${-(rect.height * 0.5)}`,
    ).toBeGreaterThan(-(rect.height * 0.5));
    // 谓词字面量：该日 separator top < vph*0.5（过折叠线）
    expect(sep.exists, `该日 date-separator 必须挂载：${sepSel}`).toBe(true);
    expect(sep.top, `separator top=${sep.top} 应 < vph*0.5=${sep.vph * 0.5}`).toBeLessThan(
      sep.vph * 0.5,
    );
    // 谓词字面量：视口停留单元 data-day-date == 目标日
    expect(inView.dayDate, `视口停留单元 dayDate=${inView.dayDate} 应 == ${t.staticDay}`).toBe(
      t.staticDay,
    );
    // DOM 契约（静态变体）：无 data-has-video ∧ 零 <video> ∧ <img src=wallpaperPortrait>
    expect(staticDom.hasVideoAttr, "静态变体不得带 data-has-video（仅动态变体附加）").toBeNull();
    expect(staticDom.videoCount, "静态变体卡内不得有 <video> 元素").toBe(0);
    expect(staticDom.imgSrc, "静态变体 <img> src 应指向 manifest wallpaperPortrait").toContain(
      mainManifest.days[1]!.wallpaperPortrait!,
    );
  });
});

// ============================================================================
// DW.P2 [det-machine]：流顶日动态壁纸卡 no-rank 深链 → 定位 + muted 起播（主链路）
// ============================================================================

describe("[DW.P2][det-machine] 流顶日动态壁纸卡 no-rank 深链 → 定位 + muted 起播（主链路 = 推送真实场景）", () => {
  it("打开 #/?date=<days[0]> 后动态壁纸卡（data-has-video=1）进视口上半区且 video muted 起播", async ({
    page,
  }) => {
    const t = fixtureTargets();
    const day = mainManifest.days[0]!;
    const cardSel = wallpaperCardSelector(t.dynamicTopDay);

    await page.goto(`${STATIC_BASE}/#/?date=${t.dynamicTopDay}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // 定位同 DW.P1 口径
    await waitUnitInUpperHalf(page, cardSel, 10000);
    // W2：定位后 ≤3s 轮询窗口内 muted 起播
    await waitVideoPlaying(page, cardSel, 3000);

    const rect = await readUnitRect(page, cardSel);
    const inView = await firstInViewUnit(page);
    const video = await page.evaluate((sel: string) => {
      const card = document.querySelector(sel);
      const v = card?.querySelector("video") as HTMLVideoElement | null;
      return {
        hasVideoAttr: card?.getAttribute("data-has-video") ?? null,
        stageExists: !!card?.querySelector(".wallpaper-stage"),
        videoExists: !!v,
        muted: v ? v.muted : null,
        paused: v ? v.paused : null,
        loop: v ? v.loop : null,
        playsinline: v ? v.hasAttribute("playsinline") : null,
        src: v?.src ?? null,
      };
    }, cardSel);

    await writeArtifact(
      "DW.P2",
      JSON.stringify({ targetDate: t.dynamicTopDay, rect, inView, video }),
    );

    // 契约字面量：动态变体机读标记 data-has-video="1"
    expect(video.hasVideoAttr, '动态壁纸卡必须 data-has-video="1"').toBe("1");
    // 定位同 DW.P1 口径：top < vph*0.5 ∧ top > -卡高*0.5 ∧ 视口停留该日
    expect(rect.exists, `顶日壁纸卡必须挂载：${cardSel}`).toBe(true);
    expect(rect.unitType).toBe("wallpaper");
    expect(rect.dayDate).toBe(t.dynamicTopDay);
    expect(rect.top, `壁纸卡 top=${rect.top} 应 < vph*0.5=${rect.vph * 0.5}`).toBeLessThan(
      rect.vph * 0.5,
    );
    expect(
      rect.top,
      `壁纸卡 top=${rect.top} 应 > -卡高*0.5=${-(rect.height * 0.5)}`,
    ).toBeGreaterThan(-(rect.height * 0.5));
    expect(inView.dayDate, `视口停留单元 dayDate=${inView.dayDate} 应 == ${t.dynamicTopDay}`).toBe(
      t.dynamicTopDay,
    );
    // DOM 契约（动态变体）：.wallpaper-stage（模糊封面垫底）+ <video muted loop playsinline>
    expect(video.stageExists, "动态变体卡内必须有 .wallpaper-stage").toBe(true);
    expect(video.videoExists, "动态变体卡内必须有 <video> 元素").toBe(true);
    // 谓词字面量（W2）：video.muted == true ∧ video.paused == false
    expect(video.muted, "起播必须 muted==true（W2）").toBe(true);
    expect(video.paused, "定位后 ≤3s 内必须起播（paused==false，W2）").toBe(false);
    expect(video.loop, "契约：<video loop>").toBe(true);
    expect(video.playsinline, "契约：<video playsinline>").toBe(true);
    // 契约字面量：video src == manifest wallpaperVideoPortrait
    expect(video.src, "video src 应 == manifest wallpaperVideoPortrait 绝对地址").toBe(
      new URL(day.wallpaperVideoPortrait!, `${STATIC_BASE}/`).href,
    );
  });
});

// ============================================================================
// DW.P3 [det-machine]：深历史日动态壁纸卡（增量挂载路径，W6）
// ============================================================================

describe("[DW.P3][det-machine] 深历史日动态壁纸卡（增量挂载路径，W6）", () => {
  it("dayIndex≥2 未挂载日深链 → 增量挂载后壁纸卡定位 + muted 起播，且不触发全量兜底", async ({
    page,
  }) => {
    test.setTimeout(45_000); // 前置探针 + 增量挂载 + 起播三段等待
    const t = fixtureTargets();
    const cardSel = wallpaperCardSelector(t.deepHistoryDay);
    const guardSel = `[data-stream-unit][data-day-date="${t.guardDay}"]`;

    // 前置硬断言（独立探针页，不污染主流程导航）：初始只挂最新 2 天
    // → 目标日（days[3]）与守卫日（days[4]）均不在 DOM
    const probe = await page.context().newPage();
    await probe.setViewportSize(MOBILE_VIEWPORT);
    await probe.goto(`${STATIC_BASE}/`);
    await probe.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    await probe.waitForTimeout(1000);
    const pre = await probe.evaluate(
      ({ cardSel, guardSel }: { cardSel: string; guardSel: string }) => ({
        cardMounted: !!document.querySelector(cardSel),
        guardMounted: !!document.querySelector(guardSel),
        unitCount: document.querySelectorAll("[data-stream-unit]").length,
      }),
      { cardSel, guardSel },
    );
    await probe.close();
    expect(pre.unitCount, "无 hash 首页流内必须有单元").toBeGreaterThan(0);
    expect(pre.cardMounted, "前置：days[3] 壁纸卡在初始挂载（最新 2 天）外，不应已在 DOM").toBe(
      false,
    );
    expect(pre.guardMounted, "前置：守卫日 days[4] 不应已在 DOM").toBe(false);

    // 深链 → 按日增量挂载至该日出现 → rAF 重查壁纸卡优先 → 定位（W6）
    await page.goto(`${STATIC_BASE}/#/?date=${t.deepHistoryDay}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    await waitUnitInUpperHalf(page, cardSel, 15000);
    await waitVideoPlaying(page, cardSel, 3000);

    const rect = await readUnitRect(page, cardSel);
    const video = await page.evaluate((sel: string) => {
      const v = document.querySelector(sel)?.querySelector("video") as HTMLVideoElement | null;
      return {
        hasVideoAttr: document.querySelector(sel)?.getAttribute("data-has-video") ?? null,
        muted: v ? v.muted : null,
        paused: v ? v.paused : null,
      };
    }, cardSel);
    const guardMountedAfter = await page.evaluate(
      (sel: string) => !!document.querySelector(sel),
      guardSel,
    );

    await writeArtifact(
      "DW.P3",
      JSON.stringify({
        targetDate: t.deepHistoryDay,
        pre,
        rect,
        video,
        guardMountedAfter,
      }),
    );

    // 谓词字面量：增量挂载发生后该日壁纸卡定位同 DW.P1 口径
    expect(rect.exists, `增量挂载后该日壁纸卡必须存在：${cardSel}`).toBe(true);
    expect(rect.unitType).toBe("wallpaper");
    expect(rect.dayDate).toBe(t.deepHistoryDay);
    expect(rect.top, `壁纸卡 top=${rect.top} 应 < vph*0.5=${rect.vph * 0.5}`).toBeLessThan(
      rect.vph * 0.5,
    );
    expect(
      rect.top,
      `壁纸卡 top=${rect.top} 应 > -卡高*0.5=${-(rect.height * 0.5)}`,
    ).toBeGreaterThan(-(rect.height * 0.5));
    expect(video.hasVideoAttr, '深历史日动态壁纸卡必须 data-has-video="1"').toBe("1");
    // 谓词字面量：video.paused == false（muted 起播同 W2 口径）
    expect(video.paused, "增量挂载落位后动态壁纸必须起播").toBe(false);
    expect(video.muted, "起播必须 muted==true").toBe(true);
    // W6 判别断言（禁 mountAllUnits 全量兜底）：增量挂载只到目标日出现为止，
    // 目标日之后一天（守卫日）不得被挂出——若被挂出说明走了全量挂载兜底。
    // （若实现带「目标日 +1」预取导致误红，请提请 design 仲裁，不得放宽为软跳过）
    expect(
      guardMountedAfter,
      "守卫日 days[4] 不得被挂出（出现即违反 W6 禁 mountAllUnits 全量兜底）",
    ).toBe(false);
  });
});

// ============================================================================
// DW.P4 [det-machine]：无壁纸卡历史日 → 回退 separator（零回归）
// ============================================================================

describe("[DW.P4][det-machine] 无壁纸卡历史日深链 → 回退该日 separator（零回归）", () => {
  it("打开 #/?date=<days[2]> 后该日 separator 过折叠线、视口停留该日、无 pageerror", async ({
    page,
  }) => {
    const t = fixtureTargets();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    const cardSel = wallpaperCardSelector(t.noWallpaperDay);
    const sepSel = separatorSelector(t.noWallpaperDay);

    await page.goto(`${STATIC_BASE}/#/?date=${t.noWallpaperDay}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // 等回退终态：该日 separator 过折叠线 ∧ 视口停留该日（days[2] 走增量挂载路径）
    await page.waitForFunction(
      ({ sepSel, date }: { sepSel: string; date: string }) => {
        const sep = document.querySelector(sepSel);
        if (!sep) return false;
        if (sep.getBoundingClientRect().top >= window.innerHeight * 0.5) return false;
        const vph = window.innerHeight;
        return Array.from(document.querySelectorAll("[data-stream-unit]")).some((el) => {
          const r = el.getBoundingClientRect();
          return r.top < vph && r.bottom > 0 && el.getAttribute("data-day-date") === date;
        });
      },
      { sepSel, date: t.noWallpaperDay },
      { timeout: 15000, polling: 100 },
    );
    await page.waitForTimeout(800);

    const sep = await readUnitRect(page, sepSel);
    const inView = await firstInViewUnit(page);
    const cardMounted = await page.evaluate(
      (sel: string) => !!document.querySelector(sel),
      cardSel,
    );

    await writeArtifact(
      "DW.P4",
      JSON.stringify({ targetDate: t.noWallpaperDay, sep, inView, cardMounted, pageErrors }),
    );

    // 前置契约：wallpaperPortrait=null 日不得渲染壁纸卡（该日无壁纸卡分支前提）
    expect(cardMounted, "无壁纸日不得渲染壁纸卡").toBe(false);
    // 谓词字面量：该日 separator 存在 ∧ separator top < vph*0.5
    expect(sep.exists, `该日 date-separator 必须挂载：${sepSel}`).toBe(true);
    expect(sep.top, `separator top=${sep.top} 应 < vph*0.5=${sep.vph * 0.5}`).toBeLessThan(
      sep.vph * 0.5,
    );
    // 谓词字面量：视口停留单元 data-day-date == 目标日
    expect(inView.dayDate, `视口停留单元 dayDate=${inView.dayDate} 应 == ${t.noWallpaperDay}`).toBe(
      t.noWallpaperDay,
    );
    // 谓词字面量：无 pageerror
    expect(pageErrors, "不得出现未捕获 JS 异常").toHaveLength(0);
  });
});

// ============================================================================
// DW.P5 [det-machine]：rank 深链不被壁纸卡劫持（回归，W4）
// ============================================================================

describe("[DW.P5][det-machine] rank 深链不被壁纸卡劫持（回归，W4）", () => {
  it("打开 #/?date=<days[1]>&rank=3 后目标 photo 单元进视口上半区（unit-type=photo）", async ({
    page,
  }) => {
    const t = fixtureTargets();
    const targetPhoto = mainManifest.days[1]!.photos.find((p) => p.rank === 3);
    expect(targetPhoto, "fixture days[1] 应含 rank=3 照片").toBeDefined();
    // 契约锚点（照片卡）：[data-unit-type="photo"][data-day-date][data-photo-rank]
    const photoSel = `[data-stream-unit][data-unit-type="photo"][data-day-date="${t.staticDay}"][data-photo-rank="3"]`;

    await page.goto(`${STATIC_BASE}/#/?date=${t.staticDay}&rank=3`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    await waitUnitInUpperHalf(page, photoSel, 10000);

    const rect = await readUnitRect(page, photoSel);
    await writeArtifact(
      "DW.P5",
      JSON.stringify({ targetDate: t.staticDay, rank: 3, photoId: targetPhoto!.photoId, rect }),
    );

    // 谓词字面量：目标 photo 单元存在 ∧ data-unit-type == "photo"
    expect(rect.exists, `目标 photo 单元必须挂载：${photoSel}`).toBe(true);
    expect(rect.unitType, "rank 深链必须落 photo 单元（壁纸卡不得劫持）").toBe("photo");
    expect(rect.dayDate).toBe(t.staticDay);
    expect(rect.photoRank).toBe("3");
    // 谓词字面量：top < vph*0.5 ∧ top > -高*0.5
    expect(rect.top, `photo top=${rect.top} 应 < vph*0.5=${rect.vph * 0.5}`).toBeLessThan(
      rect.vph * 0.5,
    );
    expect(rect.top, `photo top=${rect.top} 应 > -高*0.5=${-(rect.height * 0.5)}`).toBeGreaterThan(
      -(rect.height * 0.5),
    );
  });
});

// ============================================================================
// DW.P6 [det-machine]：video 深链与无 hash 加载零回归（冒烟）
// ============================================================================

describe("[DW.P6][det-machine] video 深链与无 hash 加载零回归（冒烟）", () => {
  it("打开 #/video/<themeKey> 后目标 video 单元定位（DL.V2 口径）", async ({ page }) => {
    const t = fixtureTargets();
    const videoSel = `[data-stream-unit][data-unit-type="video"][data-video-id="${t.themeKey}"]`;

    await page.goto(`${STATIC_BASE}/#/video/${t.themeKey}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    await waitUnitInUpperHalf(page, videoSel, 10000);

    const rect = await readUnitRect(page, videoSel);
    await writeArtifact("DW.P6-video", JSON.stringify({ themeKey: t.themeKey, rect }));

    expect(rect.exists, `目标 video 单元必须挂载：${videoSel}`).toBe(true);
    expect(rect.unitType).toBe("video");
    expect(rect.videoId).toBe(t.themeKey);
    // DL.V2 口径：top < vph*0.5 ∧ top > -unitHeight*0.5
    expect(rect.top, `video top=${rect.top} 应 < vph*0.5=${rect.vph * 0.5}`).toBeLessThan(
      rect.vph * 0.5,
    );
    expect(rect.top).toBeGreaterThan(-(rect.height * 0.5));
  });

  it("无 hash 打开首页 → 无 pageerror ∧ [data-stream-unit] 数 > 0 ∧ stream.scrollTop == 0", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(`${STATIC_BASE}/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // 给潜在的错误深链滚动留足观察时间，再验证零回归终态
    await page.waitForTimeout(2500);

    const state = await page.evaluate(() => {
      const stream = document.querySelector('[data-role="stream"]') as HTMLElement | null;
      return {
        streamFound: !!stream,
        scrollTop: stream ? stream.scrollTop : Number.NaN,
        unitCount: document.querySelectorAll("[data-stream-unit]").length,
      };
    });

    await writeArtifact("DW.P6-nohash", JSON.stringify({ ...state, pageErrors }));
    expect(state.streamFound, "滚动容器 [data-role=stream] 必须存在").toBe(true);
    expect(state.unitCount, "流内必须有单元（页面正常渲染）").toBeGreaterThan(0);
    expect(
      state.scrollTop,
      `无 hash 加载不得触发深链定位滚动（scrollTop=${state.scrollTop} 应 == 0）`,
    ).toBe(0);
    expect(pageErrors, "不得出现未捕获 JS 异常").toHaveLength(0);
  });
});

// ============================================================================
// [错误契约·补充]（state.md §契约规约 错误契约，非 DW.P1-P6 谓词，设计声明的功能点）
// ============================================================================

describe("[错误契约·补充] 深链日期在 manifest 无对应日 → 不崩、流正常渲染", () => {
  it("打开 #/?date=1999-01-01 → 无 pageerror ∧ 流单元数 > 0", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(`${STATIC_BASE}/#/?date=1999-01-01`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    await page.waitForTimeout(2500);

    const unitCount = await page.evaluate(
      () => document.querySelectorAll("[data-stream-unit]").length,
    );
    await writeArtifact("DW.ERR-unknown-date", JSON.stringify({ unitCount, pageErrors }));
    expect(unitCount, "未知日期深链下流必须正常渲染").toBeGreaterThan(0);
    expect(pageErrors, "未知日期深链不得产生未捕获异常（现状行为保持）").toHaveLength(0);
  });
});

describe("[错误契约·补充] 壁纸视频解码失败 → play() reject 被吞、定位仍完成", () => {
  it("corrupt mp4 夹具上深链 days[0] → 壁纸卡定位完成 ∧ 无未捕获异常", async ({ page }) => {
    const t = fixtureTargets();
    // 错误契约夹具前置自检：days[0] 竖版壁纸 mp4 字段存在（文件内容为非法字节）
    expect(
      errManifest.days[0]!.wallpaperVideoPortrait,
      "错误契约夹具 days[0] 应有 wallpaperVideoPortrait 字段",
    ).toBeTruthy();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    const cardSel = wallpaperCardSelector(t.dynamicTopDay);

    await page.goto(`${BASE_ERR}/#/?date=${t.dynamicTopDay}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 8000 });
    // 定位发生在 video 解码失败之前/竞态期均须完成
    await waitUnitInUpperHalf(page, cardSel, 12000);
    // 等 video error → 重渲回退/播放失败链路收敛，再取终态
    await page.waitForTimeout(2000);

    const rect = await readUnitRect(page, cardSel);
    await writeArtifact(
      "DW.ERR-play-reject",
      JSON.stringify({ targetDate: t.dynamicTopDay, rect, pageErrors }),
    );

    expect(rect.exists, "解码失败下壁纸卡必须仍在（定位目标不消失）").toBe(true);
    // 错误契约字面量：定位仍完成（上界 < vph*0.5；下界放宽到 -整卡高——
    // video error → 静态变体重渲可能与动态变体有轻微几何差，仅容忍下界）
    expect(rect.top, `定位仍完成：top=${rect.top} 应 < vph*0.5=${rect.vph * 0.5}`).toBeLessThan(
      rect.vph * 0.5,
    );
    expect(rect.top).toBeGreaterThan(-rect.height);
    // 错误契约字面量：play() reject 必须被吞（吞错），页面无未捕获异常
    expect(pageErrors, "play() reject 必须被吞（console.warn），不得出现未捕获异常").toHaveLength(
      0,
    );
  });
});

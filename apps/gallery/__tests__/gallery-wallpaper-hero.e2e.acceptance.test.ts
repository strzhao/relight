/**
 * 验收测试（红队 E2E）：画廊壁纸卡首屏化（hero）+ 动作栏两态矩阵 + 智能拉通 + 动态视频下载
 *
 * SSOT：.autopilot/runtime/requirements/20260914-开始实现/state.md `## 验收场景` 场景 1-15（全部谓词）。
 * 设计契约：同文件 `## 设计文档` §A 流序重排 / §B 动作栏+更多菜单 / §C 下载接线 / §D 智能拉通 / §契约规约。
 *
 * 谓词 → test 映射（test 标题携带谓词 id）：
 *   场景1.P1-P4  → describe [场景1]（今日动态日 D1 顺序 / 历史日分隔卡+壁纸位 / 静音自动播放 / 照片序）
 *   场景2.P1-P7  → describe [场景2]（主钮可达名 / Web Share mp4 / 更多菜单两项 / 菜单 JPG 项 /
 *                  a.download 文件名 / 下载进度 loading+% / fs-grep VIDEO_DOWNLOAD_TIMEOUT_MS）
 *   场景3.P1-P3  → describe [场景3]（静态卡 D4：主钮连续「保存壁纸」/ JPG 下载 / 菜单仅电脑版）
 *   场景4.P1-P3  → describe [场景4]（F-near 铺满两轴 / cropRatio≤0.3 → data-fill=cover / 两类卡至少一轴铺满）
 *   场景5.P1-P3  → describe [场景5]（壁纸卡 16:9 裁切>30% → contain+模糊垫底；主题视频卡同回退）
 *   场景6.P1-P3  → describe [场景6]（D3 无壁纸素材日回落 + 混日独立生效）
 *   场景7.P1-P3  → describe [场景7]（date/rank 深链不漂移）
 *   场景8.P1-P2  → describe [场景8]（#/video/<themeKey> 深链定位 + 静音自动播放）
 *   场景9.P1-P3  → describe [场景9]（两卡交界单播放器互斥 + 让渡暂停 + 播放态恒 muted）
 *   场景10.P1-P3 → describe [场景10]（D4 静态壁纸日仍居首 + 无 video + 静态按钮矩阵）
 *   场景11.P1-P3 → describe [场景11]（三级降级逐级冒烟：Web Share / a.download / 直链真实 HTTP 可达）
 *   场景12.P1-P3 → describe [场景12]（微信 UA 引导遮罩 + 前两级零触发 + 关闭恢复滚动）
 *   场景13.P1-P3 → describe [场景13]（更多菜单 Esc/外点关闭 + aria 复位 + 菜单项常驻 DOM）
 *   场景14.P1-P3 → describe [场景14]（壁纸视频 404 → 静态重渲 + 主钮降级 + 菜单仅电脑版）
 *   场景15.P1-P2 → describe [场景15]（变体 B：今日无壁纸素材 → 流顶回落 photo rank=1）
 *
 * 红队铁律：不读 app.js/app.css 内容（蓝队并行产出）；行为锚点 = 设计契约 DOM 规约 + 既有套件惯例。
 *   唯一例外：场景2.P7 fs-grep 文本契约锚点（Node fs 运行时读 app.js 断言
 *   VIDEO_DOWNLOAD_TIMEOUT_MS 位于 wallpaper-download-video 调用处——SSOT 指定 driver）。
 *
 * CONTRACT_AMBIGUOUS（设计契约歧义登记，断言取可辩护读法）：
 *   1. 场景4/5「展示区容器」取 [data-stream-unit] 单元根 boundingBox——§D 明确
 *      `.unit-wallpaper` padding 归零 + 媒体盒模型 width/height:100% + 动作栏悬浮于媒体上，
 *      故媒体应与单元根同尺寸；若实现引入带内边距/留白的中间 stage 层，几何锚点需对齐该层。
 *   2. 场景5「渲染宽高比保持自然」：§D「仅切换 object-fit，不改布局高度」⇒ contain 态元素盒
 *      恒铺满容器，「媒体渲染尺寸」按 object-fit 数学推导内容盒测量（可观测原语：元素盒 +
 *      computed object-fit + 固有宽高）。
 *   3. 场景6.P3 字面量「d1.types[1] == wallpaper」与场景1.P1（D1 流顶无 date-separator ⇒
 *      types[0]==wallpaper）矛盾——按该场景预期「D1 壁纸居首」断言 D1.types[0]==wallpaper，
 *      「分隔日壁纸位于 index==1」以 D2（带分隔卡）承担。
 *   4. 场景7.P1「photos[N]」数组下标与 rank 语义含混——按 rank 字段语义查找
 *      （data-photo-rank="5" ↔ manifest rank==5 的 photoId）。
 *   5. 场景11.P2「url contains .mp4」：a.download 降级产物为 blob: URL 时 download.url() 不含
 *      .mp4——断言为 (url 含 .mp4) ∨ (suggestedFilename 以 .mp4 结尾)，两者均记录 artifact。
 *   6. 场景2.P2 share payload「contains mp4」依赖下载文件名贯穿 Web Share File 命名
 *      （既有 gallery-download-core 场景1 惯例：files[*].name 即下载文件名）。
 *
 * fixture：自带私有 buildHeroFixtureA/B（沿 gallery-wallpaper-video 套件私有 fixture 惯例，
 * 不动共享 gen-manifest.mjs，避免对 9 个旧套件锚点的二次破坏）：
 *   - 变体 A（PORT_MAIN）：今日 D1 动态日（壁纸图[645×1398] + 壁纸视频 mp4[128×220，
 *     宽高比 0.5818 → 390×844 下 cropRatio≈0.206 → cover] + 主题视频 mp4[160×120=4:3 →
 *     cropRatio≈0.653 → contain 回退] + 12 照片 + 横版壁纸）+ 昨日 D2 同构历史日
 *     （date-separator + 壁纸 + 视频 + 3 照片）+ 前日 D3 无任何壁纸素材日（主题视频 + 3 照片）
 *     + 大前日 D4 静态壁纸日（壁纸图有、wallpaperVideoPortrait 缺省、横版有）。
 *   - 变体 B（PORT_FALLBACK）：今日无壁纸素材（3 照片）+ 昨日有壁纸历史日
 *     （wallpaperPortrait 为 16:9 横比图 320×180 → 裁切 74% → contain，兼作场景5 壁纸卡例）。
 *   - 进度夹具（PORT_SLOW）：变体 A 克隆，D1 wallpaperVideoPortrait 指向慢速 Node 服务
 *     （349KB 合法 mp4，16KB/60ms 分块 ≈1.3s 传输窗，Content-Length 精确 + CORS 全开）。
 *   - 壁纸视频媒体：预生成占位 mp4 随 fixtures 提交（wall-video-portrait-128x220.mp4 /
 *     wall-video-portrait-slow-128x220.mp4）；缺失时 beforeAll 内 ffmpeg 现场生成兜底
 *     （防 CI 环境差异，plan 步骤 7 红线）。
 *   - manifest 字段遵循既有约定：wallpaperPortrait / wallpaperVideoPortrait / wallpaperLandscape /
 *     photos[].rank / videos[].themeKey|mp4|cover|createdAt（createdAt 前 10 位 = 归属日）。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
const { describe, beforeAll, afterAll, beforeEach } = test;
const it = test;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_GALLERY_DIR = path.resolve(__dirname, "../");
const FIXTURES_DIR = path.join(__dirname, "fixtures");

// ---- 预生成媒体资产（一次性产物随 fixtures 提交；缺失时 ffmpeg 现场生成兜底）----
const PORTRAIT_VIDEO_SAMPLE = path.join(FIXTURES_DIR, "wall-video-portrait-128x220.mp4");
const SLOW_VIDEO_SAMPLE = path.join(FIXTURES_DIR, "wall-video-portrait-slow-128x220.mp4");
const PORTRAIT_JPEG = path.join(FIXTURES_DIR, "wall-portrait-645x1398.jpg");
const LANDSCAPE_JPEG = path.join(FIXTURES_DIR, "wall-landscape-320x180.jpg");
const THEME_VIDEO_SAMPLE = path.join(FIXTURES_DIR, "video-sample.mp4"); // 160×120 = 4:3 既有资产

// ---- 端口（避开既有 8765-8770 / 8792-8793 / 8088）----
const PORT_MAIN = Number(process.env.GALLERY_HERO_MAIN_PORT ?? 8801); // 变体 A：D1-D4 四形态
const PORT_FALLBACK = Number(process.env.GALLERY_HERO_FB_PORT ?? 8802); // 变体 B：流顶无壁纸回落
const PORT_SLOW = Number(process.env.GALLERY_HERO_SLOW_PORT ?? 8803); // 进度夹具（D1 视频走慢速服务）
const BASE_MAIN = `http://127.0.0.1:${PORT_MAIN}`;
const BASE_FALLBACK = `http://127.0.0.1:${PORT_FALLBACK}`;
const BASE_SLOW = `http://127.0.0.1:${PORT_SLOW}`;
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";
const MOBILE_VIEWPORT = { width: 390, height: 844 };

const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const WECHAT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003133) NetType/WIFI Language/zh_CN";

// ---- fixture 占位 JPEG（1×1 照片缩略位；与 gen-manifest.mjs 同源）----
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomIygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImIkpOUlZaXmGmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3iigoAKKKKACiiigA/9k=";

/** ffmpeg 兜底生成（仅当预生成资产缺失；正常路径零 ffmpeg 依赖） */
function ensureMediaAssets(): void {
  const jobs: Array<{ file: string; args: string[] }> = [
    {
      file: PORTRAIT_VIDEO_SAMPLE,
      args: [
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=4:size=128x220:rate=12",
        "-c:v",
        "libx264",
        "-profile:v",
        "baseline",
        "-level",
        "3.0",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
      ],
    },
    {
      file: SLOW_VIDEO_SAMPLE,
      args: [
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=60:size=128x220:rate=12",
        "-c:v",
        "libx264",
        "-profile:v",
        "baseline",
        "-level",
        "3.0",
        "-b:v",
        "48k",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
      ],
    },
    {
      file: PORTRAIT_JPEG,
      args: ["-f", "lavfi", "-i", "color=c=0x2a2620:s=645x1398", "-frames:v", "1", "-q:v", "6"],
    },
    {
      file: LANDSCAPE_JPEG,
      args: ["-f", "lavfi", "-i", "color=c=0x3a3228:s=320x180", "-frames:v", "1", "-q:v", "6"],
    },
  ];
  for (const job of jobs) {
    if (fs.existsSync(job.file) && fs.statSync(job.file).size > 0) continue;
    const r = spawnSync("ffmpeg", ["-y", "-v", "error", ...job.args, job.file], {
      stdio: "ignore",
    });
    if (!fs.existsSync(job.file) || fs.statSync(job.file).size === 0) {
      throw new Error(
        `fixture 媒体资产缺失且 ffmpeg 兜底生成失败（exit=${String(r.status)} ${String(r.error)}）: ${job.file}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 私有 fixture 构建
// ---------------------------------------------------------------------------

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
interface FixtureDay {
  pickDate: string;
  title: string;
  narrative: string;
  wallpaperLandscape?: string;
  wallpaperPortrait?: string;
  wallpaperVideoPortrait?: string;
  photos: FixturePhoto[];
}
interface FixtureManifest {
  generatedAt: string;
  days: FixtureDay[];
  videos: FixtureVideo[];
}
interface BuiltFixture {
  dir: string;
  manifest: FixtureManifest;
  dates: { today: string; minus1: string; minus2: string; minus3: string };
}

function dateStr(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function writeJpeg(filePath: string, b64: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
}

function rank2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 拷贝三件套 + fonts 到隔离目录（既有红队套件惯例） */
function copyShell(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["index.html", "app.css", "app.js"]) {
    fs.copyFileSync(path.join(SRC_GALLERY_DIR, f), path.join(dir, f));
  }
  const fontsDir = path.join(SRC_GALLERY_DIR, "fonts");
  if (fs.existsSync(fontsDir)) {
    fs.cpSync(fontsDir, path.join(dir, "fonts"), { recursive: true });
  }
}

/**
 * 变体 A：今日 D1 动态日（壁纸图 + 壁纸视频 + 主题视频 + 12 照片 + 横版壁纸）→
 * 昨日 D2 同构历史日 → 前日 D3 无任何壁纸素材日 → 大前日 D4 静态壁纸日。
 * slowWallpaperVideoAbsoluteUrl 提供时（进度夹具），仅 D1 的 wallpaperVideoPortrait 改指该绝对 URL。
 */
function buildHeroFixtureA(
  dir: string,
  opts: { slowWallpaperVideoAbsoluteUrl?: string } = {},
): BuiltFixture {
  copyShell(dir);
  const dates = { today: dateStr(0), minus1: dateStr(1), minus2: dateStr(2), minus3: dateStr(3) };
  const wpPortraitPath = (d: string) => `wallpapers/${d}_v2-contain-1290x2796.jpg`;
  const wpLandscapePath = (d: string) => `wallpapers/${d}_v2-contain-default.jpg`;

  // 壁纸媒体（真实宽高占位：竖版 645×1398 比例 0.4614 → cover；16:9 横比 320×180 → contain）
  fs.mkdirSync(path.join(dir, "wallpapers"), { recursive: true });
  for (const d of [dates.today, dates.minus1, dates.minus3]) {
    fs.copyFileSync(PORTRAIT_JPEG, path.join(dir, wpPortraitPath(d)));
    fs.copyFileSync(LANDSCAPE_JPEG, path.join(dir, wpLandscapePath(d)));
  }
  // 竖版壁纸视频（128×220 占位，本地可播放 muted autoplay）
  fs.mkdirSync(path.join(dir, "wallpaper-videos"), { recursive: true });
  fs.copyFileSync(
    PORTRAIT_VIDEO_SAMPLE,
    path.join(dir, `wallpaper-videos/${dates.today}_portrait.mp4`),
  );
  fs.copyFileSync(
    PORTRAIT_VIDEO_SAMPLE,
    path.join(dir, `wallpaper-videos/${dates.minus1}_portrait.mp4`),
  );

  const mkPhoto = (prefix: string, rank: number): FixturePhoto => {
    const id = `hero-${prefix}-${rank2(rank)}`;
    writeJpeg(path.join(dir, "photos", `${id}-thumb.jpg`), TINY_JPEG_B64);
    writeJpeg(path.join(dir, "photos", `${id}-mid.jpg`), TINY_JPEG_B64);
    return {
      photoId: id,
      rank,
      title: `${prefix} 第 ${rank} 张`,
      narrative: `${prefix} 第 ${rank} 张的叙事文案，长度足够通过非空断言。`,
      thumbnail: `photos/${id}-thumb.jpg`,
      original: `photos/${id}-mid.jpg`,
      takenAt: "2024-07-15T10:00:00.000Z",
      width: 4032,
      height: 3024,
    };
  };
  const photos = (prefix: string, count: number): FixturePhoto[] =>
    Array.from({ length: count }, (_, i) => mkPhoto(prefix, i + 1));

  const mkThemeVideo = (seq: number, themeKey: string, pickDate: string): FixtureVideo => {
    const mp4 = `videos/${themeKey}.mp4`;
    const cover = `videos/${themeKey}-cover.jpg`;
    fs.mkdirSync(path.join(dir, "videos"), { recursive: true });
    fs.copyFileSync(THEME_VIDEO_SAMPLE, path.join(dir, mp4));
    writeJpeg(path.join(dir, cover), TINY_JPEG_B64);
    return {
      id: `1e6c9a10-0000-4a6b-9cde-${String(seq).padStart(12, "0")}`,
      themeKey,
      themeKind: "trip",
      title: `主题视频 ${themeKey}`,
      narrative: `主题视频 ${themeKey} 的叙事文案。`,
      mp4,
      cover,
      durationSec: 45,
      photoCount: 3,
      createdAt: `${pickDate}T02:00:00.000Z`, // 前 10 位 = 归属日（SSOT 约定）
    };
  };

  const manifest: FixtureManifest = {
    generatedAt: new Date().toISOString(),
    days: [
      {
        pickDate: dates.today,
        title: "今日精选",
        narrative: "今日的整体叙事。",
        wallpaperPortrait: wpPortraitPath(dates.today),
        wallpaperLandscape: wpLandscapePath(dates.today),
        wallpaperVideoPortrait:
          opts.slowWallpaperVideoAbsoluteUrl ?? `wallpaper-videos/${dates.today}_portrait.mp4`,
        photos: photos("today", 12),
      },
      {
        pickDate: dates.minus1,
        title: "昨日精选",
        narrative: "昨日的整体叙事。",
        wallpaperPortrait: wpPortraitPath(dates.minus1),
        wallpaperLandscape: wpLandscapePath(dates.minus1),
        wallpaperVideoPortrait: `wallpaper-videos/${dates.minus1}_portrait.mp4`,
        photos: photos("d2", 3),
      },
      {
        // D3：无任何壁纸素材（字段缺省，模拟「回执列空 → JSON 字段缺省」）
        pickDate: dates.minus2,
        title: "前日精选",
        narrative: "前日的整体叙事。",
        photos: photos("d3", 3),
      },
      {
        // D4：静态壁纸日（壁纸图有、壁纸视频字段缺省、横版有）
        pickDate: dates.minus3,
        title: "大前日精选",
        narrative: "大前日的整体叙事。",
        wallpaperPortrait: wpPortraitPath(dates.minus3),
        wallpaperLandscape: wpLandscapePath(dates.minus3),
        photos: photos("d4", 3),
      },
    ],
    videos: [
      mkThemeVideo(1, "hero-trip-today", dates.today),
      mkThemeVideo(2, "hero-trip-d2", dates.minus1),
      mkThemeVideo(3, "hero-trip-d3", dates.minus2),
      mkThemeVideo(4, "hero-trip-d4", dates.minus3),
    ],
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir, manifest, dates };
}

/**
 * 变体 B：今日无壁纸素材（3 照片，验证流顶回落 photo rank=1）+
 * 昨日有壁纸历史日（wallpaperPortrait 为 16:9 横比图 320×180 → contain，兼作场景5 壁纸卡例）。
 */
function buildHeroFixtureB(dir: string): BuiltFixture {
  copyShell(dir);
  const dates = { today: dateStr(0), minus1: dateStr(1), minus2: dateStr(2), minus3: dateStr(3) };
  const wpLandscapePath = (d: string) => `wallpapers/${d}_v2-contain-default.jpg`;
  fs.mkdirSync(path.join(dir, "wallpapers"), { recursive: true });
  const b2Portrait16x9 = `wallpapers/${dates.minus1}-hero-16x9.jpg`;
  fs.copyFileSync(LANDSCAPE_JPEG, path.join(dir, b2Portrait16x9));
  fs.copyFileSync(LANDSCAPE_JPEG, path.join(dir, wpLandscapePath(dates.minus1)));

  const mkPhotos = (prefix: string, count: number): FixturePhoto[] => {
    const list: FixturePhoto[] = Array.from({ length: count }, (_, i) => {
      const id = `hero-${prefix}-${rank2(i + 1)}`;
      return {
        photoId: id,
        rank: i + 1,
        title: `${prefix} 第 ${i + 1} 张`,
        narrative: `${prefix} 第 ${i + 1} 张的叙事文案。`,
        thumbnail: `photos/${id}-thumb.jpg`,
        original: `photos/${id}-mid.jpg`,
        takenAt: "2024-07-15T10:00:00.000Z",
        width: 4032,
        height: 3024,
      };
    });
    for (const p of list) {
      writeJpeg(path.join(dir, p.thumbnail), TINY_JPEG_B64);
      writeJpeg(path.join(dir, p.original), TINY_JPEG_B64);
    }
    return list;
  };

  const manifest: FixtureManifest = {
    generatedAt: new Date().toISOString(),
    days: [
      {
        pickDate: dates.today,
        title: "今日精选",
        narrative: "今日叙事。",
        photos: mkPhotos("b1", 3),
      },
      {
        pickDate: dates.minus1,
        title: "昨日精选",
        narrative: "昨日叙事。",
        wallpaperPortrait: b2Portrait16x9,
        wallpaperLandscape: wpLandscapePath(dates.minus1),
        photos: mkPhotos("b2", 3),
      },
    ],
    videos: [],
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir, manifest, dates };
}

// ---------------------------------------------------------------------------
// 静态服务 + 慢速服务（--bind 127.0.0.1，规避 dual-stack/getfqdn 半死态坑）
// ---------------------------------------------------------------------------

const servers: ChildProcess[] = [];
const fixtureRoots: string[] = [];
let dirMain = "";
let dirFallback = "";
let dirSlow = "";
let manifestMain: FixtureManifest;
let manifestFallback: FixtureManifest;
let datesMain: BuiltFixture["dates"];
let datesFallback: BuiltFixture["dates"];
let slowPort = 0;

async function startStaticServer(port: number, dir: string): Promise<void> {
  const proc = spawn(
    "python3",
    ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", dir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  servers.push(proc);
  fixtureRoots.push(dir);
  const deadline = Date.now() + 15000;
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

/** 慢速静态服务：CORS 全开 + Content-Length 精确 + 分块限速（16KB/60ms ≈ 1.3s / 349KB） */
function startSlowServer(samplePath: string): Promise<void> {
  const body = fs.readFileSync(samplePath);
  const CHUNK = 16 * 1024;
  const INTERVAL_MS = 60;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(body.length),
        "Access-Control-Allow-Origin": "*",
      });
      let off = 0;
      const tick = (): void => {
        if (res.destroyed) return;
        const end = Math.min(off + CHUNK, body.length);
        res.write(body.subarray(off, end));
        off = end;
        if (off < body.length) setTimeout(tick, INTERVAL_MS);
        else res.end();
      };
      tick();
    });
    server.listen(0, "127.0.0.1", () => {
      slowPort = (server.address() as AddressInfo).port;
      resolve();
    });
  });
}

beforeAll(async () => {
  test.setTimeout(60_000);
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  ensureMediaAssets();
  if (!fs.existsSync(THEME_VIDEO_SAMPLE)) {
    throw new Error(`既有 fixture 资产缺失: ${THEME_VIDEO_SAMPLE}`);
  }
  await startSlowServer(SLOW_VIDEO_SAMPLE);

  const fxA = buildHeroFixtureA(path.join(os.tmpdir(), `relight-gallery-hero-a-${PORT_MAIN}`));
  dirMain = fxA.dir;
  manifestMain = fxA.manifest;
  datesMain = fxA.dates;

  const fxB = buildHeroFixtureB(path.join(os.tmpdir(), `relight-gallery-hero-b-${PORT_FALLBACK}`));
  dirFallback = fxB.dir;
  manifestFallback = fxB.manifest;
  datesFallback = fxB.dates;

  // 进度夹具 = 变体 A 克隆，D1 壁纸视频指向慢速服务绝对 URL
  const fxSlow = buildHeroFixtureA(
    path.join(os.tmpdir(), `relight-gallery-hero-slow-${PORT_SLOW}`),
    {
      slowWallpaperVideoAbsoluteUrl: `http://127.0.0.1:${slowPort}/slow/slow-portrait.mp4`,
    },
  );
  dirSlow = fxSlow.dir;

  await startStaticServer(PORT_MAIN, dirMain);
  await startStaticServer(PORT_FALLBACK, dirFallback);
  await startStaticServer(PORT_SLOW, dirSlow);
}, 60_000);

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

beforeEach(async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
});

async function writeArtifact(id: string, content: string): Promise<void> {
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

// ---------------------------------------------------------------------------
// DOM / 交互探针（沿 gallery-download-* 套件惯例）
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __shareCalls: Array<Array<{ name: string; type: string; size: number }>>;
    __openCalls: string[];
    __fetchLog: string[];
  }
}

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

async function openProbePage(
  browser: Browser,
  opts: { share: "resolve" | "abort" | "noshare"; mobile: boolean; ua?: string },
): Promise<ProbeHandles> {
  const ctx = await browser.newContext({
    viewport: opts.mobile ? MOBILE_VIEWPORT : { width: 1280, height: 800 },
    hasTouch: opts.mobile,
    isMobile: opts.mobile,
    userAgent: opts.ua ?? (opts.mobile ? IOS_SAFARI_UA : DESKTOP_CHROME_UA),
  });
  const page = await ctx.newPage();
  await page.addInitScript(buildProbeScript(opts.share));
  const downloads: Download[] = [];
  page.on("download", (d) => downloads.push(d));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  return { ctx, page, downloads, pageErrors, close: () => ctx.close() };
}

// ---------------------------------------------------------------------------
// 流读取 / 滚动 / 几何探针
// ---------------------------------------------------------------------------

/** 今日 D1 壁纸卡（流顶日 dayIndex=0 无 date-separator，壁纸卡为首单元） */
const WALL_CARD_D1 = '[data-stream-unit][data-role="wallpaper-card"][data-day-index="0"]';
const D1_THEME_VIDEO_UNIT = '[data-stream-unit][data-unit-type="video"][data-day-index="0"]';
const MORE_TRIGGER = (cardSel: string) => `${cardSel} [data-role="more-menu"]`;
const MORE_POPOVER = (cardSel: string) => `${cardSel} [data-role="more-menu-popover"]`;

interface DayUnit {
  type: string | null;
  rank: string | null;
  photoId: string | null;
  videoId: string | null;
  role: string | null;
  hasVideo: string | null;
  fill: string | null;
  dayDate: string | null;
}

async function readDayUnits(page: Page, dayIndex: number): Promise<DayUnit[]> {
  return page.evaluate((idx: number) => {
    return Array.from(document.querySelectorAll(`[data-stream-unit][data-day-index="${idx}"]`)).map(
      (u) => ({
        type: u.getAttribute("data-unit-type"),
        rank: u.getAttribute("data-photo-rank"),
        photoId: u.getAttribute("data-photo-id"),
        videoId: u.getAttribute("data-video-id"),
        role: u.getAttribute("data-role"),
        hasVideo: u.getAttribute("data-has-video"),
        fill: u.getAttribute("data-fill"),
        dayDate: u.getAttribute("data-day-date"),
      }),
    );
  }, dayIndex);
}

/**
 * 增量挂载兜底：历史日（dayIndex≥2）可能不在初始「最新 2 天」挂载窗口内——
 * 循环把滚动容器推到底触发后续日挂载，直到该日最后 rank 的照片单元存在。
 */
async function mountDaySegment(page: Page, dayIndex: number, lastRank: number): Promise<void> {
  const target = `[data-stream-unit][data-day-index="${dayIndex}"][data-photo-rank="${lastRank}"]`;
  for (let i = 0; i < 40; i++) {
    const found = await page.evaluate((sel: string) => !!document.querySelector(sel), target);
    if (found) return;
    await page.evaluate(() => {
      const stream = document.getElementById("stream");
      const scroller = (
        stream && stream.scrollHeight > stream.clientHeight + 10
          ? stream
          : document.scrollingElement
      ) as HTMLElement | null;
      if (!scroller) return;
      const prevSnap = scroller.style.scrollSnapType;
      const prevSmooth = scroller.style.scrollBehavior;
      scroller.style.scrollSnapType = "none";
      scroller.style.scrollBehavior = "auto";
      scroller.scrollTop = scroller.scrollHeight;
      void prevSnap;
      void prevSmooth;
    });
    await page.waitForTimeout(250);
  }
  const finalCheck = await page.evaluate((sel: string) => !!document.querySelector(sel), target);
  expect(finalCheck, `day-index=${dayIndex} 的单元（${target}）经滚动增量挂载后仍不存在`).toBe(
    true,
  );
}

async function scrollUnitIntoView(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel: string) => {
    document.querySelector(sel)?.scrollIntoView({ behavior: "instant", block: "center" });
  }, selector);
  await page.waitForTimeout(300);
}

/** 把 dayIndex 段滚入视野并确保壁纸卡挂载（dayIndex 0/1 直接等待即可） */
async function ensureWallpaperCardReady(
  page: Page,
  dayIndex: number,
  lastRank: number,
): Promise<string> {
  const cardSel = `[data-stream-unit][data-role="wallpaper-card"][data-day-index="${dayIndex}"]`;
  if (dayIndex >= 2) await mountDaySegment(page, dayIndex, lastRank);
  await page.waitForSelector(cardSel, { timeout: 12000 });
  await scrollUnitIntoView(page, cardSel);
  return cardSel;
}

async function waitForVideoPlaying(page: Page, videoSel: string, timeout = 15000): Promise<void> {
  await page.waitForFunction(
    (sel: string) => {
      const v = document.querySelector(sel) as HTMLVideoElement | null;
      return !!v && v.readyState >= 2 && !v.paused;
    },
    videoSel,
    { timeout, polling: 150 },
  );
}

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

async function waitUnitIntersecting(page: Page, selector: string, timeout = 12000): Promise<Rect> {
  await page.waitForFunction(
    (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0
      );
    },
    selector,
    { timeout, polling: 120 },
  );
  return page.evaluate((sel: string) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
    };
  }, selector);
}

interface FillState {
  exists: boolean;
  fill: string | null;
  hasVideoAttr: string | null;
  mediaTag: string | null;
  unitBox: { w: number; h: number } | null;
  mediaBox: { w: number; h: number } | null;
  natural: { w: number; h: number };
  objectFit: string;
  blurRadius: number;
  content: { w: number; h: number } | null;
  cropRatio: number | null;
  videoCount: number;
}

/**
 * 读取智能拉通可观测状态（CONTRACT_AMBIGUOUS 1/2 的测量口径见文件头）：
 *   - 容器 = 单元根 boundingBox；媒体 = 单元内首个 video/img。
 *   - content = object-fit 数学推导的媒体内容渲染盒（cover 取 max 缩放 / contain 取 min 缩放）。
 *   - blurRadius = 单元内任一节点 computed filter 的 blur(px) 最大值。
 */
async function readFillState(page: Page, unitSel: string): Promise<FillState> {
  return page.evaluate((sel: string) => {
    const unit = document.querySelector(sel) as HTMLElement | null;
    if (!unit) {
      return {
        exists: false,
        fill: null,
        hasVideoAttr: null,
        mediaTag: null,
        unitBox: null,
        mediaBox: null,
        natural: { w: 0, h: 0 },
        objectFit: "",
        blurRadius: 0,
        content: null,
        cropRatio: null,
        videoCount: 0,
      };
    }
    const media = (unit.querySelector("video") ?? unit.querySelector("img")) as
      | HTMLVideoElement
      | HTMLImageElement
      | null;
    const unitRect = unit.getBoundingClientRect();
    const mRect = media ? media.getBoundingClientRect() : null;
    const isVideo = media instanceof HTMLVideoElement;
    const nw = isVideo
      ? (media as HTMLVideoElement).videoWidth
      : ((media as HTMLImageElement | null)?.naturalWidth ?? 0);
    const nh = isVideo
      ? (media as HTMLVideoElement).videoHeight
      : ((media as HTMLImageElement | null)?.naturalHeight ?? 0);
    const objectFit = media ? window.getComputedStyle(media).objectFit : "";
    let blurRadius = 0;
    for (const el of Array.from(unit.querySelectorAll("*"))) {
      const f = window.getComputedStyle(el).filter;
      const m = /blur\((\d+(?:\.\d+)?)px\)/.exec(f);
      if (m) blurRadius = Math.max(blurRadius, Number.parseFloat(m[1] ?? "0"));
    }
    let content: { w: number; h: number } | null = null;
    let cropRatio: number | null = null;
    if (mRect && nw > 0 && nh > 0) {
      const scaleCover = Math.max(mRect.width / nw, mRect.height / nh);
      const scaleContain = Math.min(mRect.width / nw, mRect.height / nh);
      const scale = objectFit === "cover" ? scaleCover : scaleContain;
      content = { w: nw * scale, h: nh * scale };
      const a = unitRect.width / nw;
      const b = unitRect.height / nh;
      cropRatio = 1 - Math.min(a, b) / Math.max(a, b);
    }
    return {
      exists: true,
      fill: unit.getAttribute("data-fill"),
      hasVideoAttr: unit.getAttribute("data-has-video"),
      mediaTag: media ? media.tagName : null,
      unitBox: { w: unitRect.width, h: unitRect.height },
      mediaBox: mRect ? { w: mRect.width, h: mRect.height } : null,
      natural: { w: nw, h: nh },
      objectFit,
      blurRadius,
      content,
      cropRatio,
      videoCount: unit.querySelectorAll("video").length,
    };
  }, unitSel);
}

/** bounded 等待单元 data-fill 就绪（未就绪不置 data-fill——SSOT 契约） */
async function waitForFill(page: Page, unitSel: string, timeout = 15000): Promise<void> {
  await page.waitForFunction(
    (sel: string) => {
      const u = document.querySelector(sel);
      return !!u && !!u.getAttribute("data-fill");
    },
    unitSel,
    { timeout, polling: 120 },
  );
}

/** 展开「更多」菜单（契约：点击触发钮 toggle hidden + aria-expanded 同步） */
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

interface MenuItem {
  name: string;
  role: string | null;
}

async function readPopoverItems(page: Page, cardSel: string): Promise<MenuItem[] | null> {
  return page.evaluate((sel: string) => {
    const pop = document.querySelector(`${sel} [data-role="more-menu-popover"]`);
    if (!pop) return null;
    return Array.from(pop.querySelectorAll("button, [role='menuitem'], a")).map((el) => ({
      name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim(),
      role: el.getAttribute("data-role"),
    }));
  }, cardSel);
}

/** 弹层关闭态的机读断言值（hidden 属性 + aria-expanded） */
async function readMenuToggleState(
  page: Page,
  cardSel: string,
): Promise<{ popoverHidden: boolean; ariaExpanded: string | null }> {
  return page.evaluate((sel: string) => {
    const pop = document.querySelector(`${sel} [data-role="more-menu-popover"]`);
    const trigger = document.querySelector(`${sel} [data-role="more-menu"]`);
    return {
      popoverHidden: !pop || pop.hasAttribute("hidden"),
      ariaExpanded: trigger ? trigger.getAttribute("aria-expanded") : null,
    };
  }, cardSel);
}

// ============================================================================
// 场景 1：当日动态壁纸卡上移至每日第一内容位（新顺序正向）
// ============================================================================

describe("[场景1] 今日动态壁纸卡上移至每日第一内容位", () => {
  it("[场景1.P1] 今日 D1 单元序列 == [wallpaper, video, photo×12]（长度 14 逐位匹配，无 date-separator）", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 12000 });
    await page.waitForSelector('[data-stream-unit][data-day-index="0"][data-photo-rank="12"]', {
      timeout: 12000,
    });

    const units = await readDayUnits(page, 0);
    const types = units.map((u) => u.type);
    const expected = ["wallpaper", "video", ...Array.from({ length: 12 }, () => "photo")];

    await writeArtifact("场景1.P1", JSON.stringify({ types, expected }));
    expect(types, `今日日段类型序列应为 ${JSON.stringify(expected)}`).toEqual(expected);
    expect(types, "今日日段不得含 date-separator（流顶规则不变）").not.toContain("date-separator");
  });

  it("[场景1.P2] D2 历史日 seg[0]==date-separator ∧ seg[1]==wallpaper；D1 seg[0]==wallpaper", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector('[data-stream-unit][data-day-index="1"][data-photo-rank="3"]', {
      timeout: 12000,
    });

    const d1 = await readDayUnits(page, 0);
    const d2 = await readDayUnits(page, 1);

    await writeArtifact(
      "场景1.P2",
      JSON.stringify({ d1: d1.map((u) => u.type), d2: d2.map((u) => u.type) }),
    );
    expect(d2[0]?.type, "历史日 D2 首单元必须为 date-separator").toBe("date-separator");
    expect(d2[1]?.type, "历史日 D2 第二单元必须为壁纸卡（上移后）").toBe("wallpaper");
    expect(d1[0]?.type, "今日 D1 首单元必须为壁纸卡（流顶无分隔卡）").toBe("wallpaper");
  });

  it("[场景1.P3] D1 动态壁纸卡进入视口 → 视频静音自动播放（muted==true ∧ paused==false）", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(WALL_CARD_D1, { timeout: 12000 });
    await scrollUnitIntoView(page, WALL_CARD_D1);
    await waitForVideoPlaying(page, `${WALL_CARD_D1} video`);

    const state = await page.evaluate((sel: string) => {
      const v = document.querySelector(`${sel} video`) as HTMLVideoElement | null;
      if (!v) return null;
      return {
        muted: v.muted,
        paused: v.paused,
        readyState: v.readyState,
        hasVideoAttr: document.querySelector(sel)?.getAttribute("data-has-video"),
      };
    }, WALL_CARD_D1);

    await writeArtifact("场景1.P3", JSON.stringify(state));
    expect(state, "壁纸卡内必须存在 <video>").not.toBeNull();
    expect(state?.muted).toBe(true);
    expect(state?.paused).toBe(false);
    // 动态变体机读标记（契约：data-has-video="1" 仅动态壁纸变体）
    expect(state?.hasVideoAttr).toBe("1");
  });

  it("[场景1.P4] D1 的 12 张照片相对顺序 == manifest 顺序（photoId 逐位相等）", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector('[data-stream-unit][data-day-index="0"][data-photo-rank="12"]', {
      timeout: 12000,
    });

    const units = await readDayUnits(page, 0);
    const observed = units.filter((u) => u.type === "photo").map((u) => u.photoId);
    const expected = manifestMain.days[0]!.photos.map((p) => p.photoId);

    await writeArtifact("场景1.P4", JSON.stringify({ observed, expected }));
    expect(observed, "照片 photoId 序列必须逐位等于 manifest 顺序").toEqual(expected);
  });
});

// ============================================================================
// 场景 2：动态壁纸卡动作栏——主按钮保存动态视频 mp4 + 「更多」菜单收敛
// ============================================================================

describe("[场景2] 动态壁纸卡动作栏（保存视频主钮 + 更多菜单）", () => {
  it("[场景2.P1] 动态态主钮可达性名称含「保存」且 role == wallpaper-download-video", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(`${WALL_CARD_D1} [data-role="wallpaper-download-video"]`, {
      timeout: 12000,
    });

    const primary = await page.evaluate((sel: string) => {
      const b = document.querySelector(`${sel} [data-role="wallpaper-download-video"]`);
      if (!b) return null;
      // AX name 解析：aria-label 优先，退化到可见文本（既有 readUiState 口径）
      return {
        axName: (b.getAttribute("aria-label") ?? b.textContent ?? "").trim(),
        state: b.getAttribute("data-download-state"),
        text: (b.textContent ?? "").trim(),
      };
    }, WALL_CARD_D1);

    await writeArtifact("场景2.P1", JSON.stringify(primary));
    expect(primary, "动态卡必须存在主操作钮 [data-role=wallpaper-download-video]").not.toBeNull();
    expect(primary?.axName ?? "", "主钮可达性名称必须含「保存」（谓词字面量）").toContain("保存");
    expect(primary?.state, "初始态必须为 idle").toBe("idle");
  });

  it("[场景2.P2] 点击主钮（Web Share 可用）→ shareCalls>=1 且 payload 含 mp4 无 .jpg", async ({
    browser,
  }) => {
    const { page, close } = await openProbePage(browser, { share: "resolve", mobile: true });
    try {
      await page.goto(`${BASE_MAIN}/#/`);
      const btn = page.locator(`${WALL_CARD_D1} [data-role="wallpaper-download-video"]`);
      await btn.waitFor({ state: "visible", timeout: 12000 });
      await btn.click();
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 15000,
      });
      await page.waitForTimeout(300);

      const shareCalls = await page.evaluate(() => window.__shareCalls);
      const payload = JSON.stringify(shareCalls);
      // artifact 嵌谓词 id + 执行时间戳：同型交互（如场景11.P1）的确定性 payload 需可自证独立执行
      await writeArtifact(
        "场景2.P2",
        JSON.stringify({ pred: "场景2.P2", executedAt: new Date().toISOString(), shareCalls }),
      );
      expect(shareCalls.length, "必须调用 navigator.share").toBeGreaterThanOrEqual(1);
      expect(payload, "share payload 必须含 mp4（文件名或 MIME）").toContain("mp4");
      expect(payload, "share payload 不得含 .jpg（互斥：主钮存的是视频）").not.toContain(".jpg");
    } finally {
      await close();
    }
  });

  it("[场景2.P3] 展开「更多」菜单 → 同时呈现 静态JPG下载项 与 电脑版（itemCount>=2）", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(WALL_CARD_D1, { timeout: 12000 });
    await scrollUnitIntoView(page, WALL_CARD_D1);
    await openMoreMenu(page, WALL_CARD_D1);

    const items = await readPopoverItems(page, WALL_CARD_D1);
    const names = (items ?? []).map((i) => i.name);
    await writeArtifact("场景2.P3", JSON.stringify({ items, names }));
    expect(items, "弹层必须常驻且已展开").not.toBeNull();
    expect(names.length, "动态卡菜单必须至少两项（静态JPG + 电脑版）").toBeGreaterThanOrEqual(2);
    expect(
      names.some((n) => n.includes("电脑版")),
      `菜单必须含「电脑版」入口，实际 names=${JSON.stringify(names)}`,
    ).toBe(true);
    expect(
      (items ?? []).some((i) => i.role === "wallpaper-download-portrait"),
      "菜单必须含静态 JPG 下载项（role=wallpaper-download-portrait）",
    ).toBe(true);
    expect(
      names.some((n) => n.includes("保存静态壁纸")),
      `静态 JPG 下载项可达名必须含「保存静态壁纸」，实际 names=${JSON.stringify(names)}`,
    ).toBe(true);
  });

  it("[场景2.P4] 点击菜单静态 JPG 项 → 下载目标含 .jpg 且不含 .mp4", async ({ browser }) => {
    const { page, close } = await openProbePage(browser, { share: "resolve", mobile: true });
    try {
      await page.goto(`${BASE_MAIN}/#/`);
      await page.waitForSelector(WALL_CARD_D1, { timeout: 12000 });
      await scrollUnitIntoView(page, WALL_CARD_D1);
      await openMoreMenu(page, WALL_CARD_D1);

      const item = page.locator(
        `${MORE_POPOVER(WALL_CARD_D1)} [data-role="wallpaper-download-portrait"]`,
      );
      await item.waitFor({ state: "visible", timeout: 5000 });
      await item.click();
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 15000,
      });
      await page.waitForTimeout(300);

      const shareCalls = await page.evaluate(() => window.__shareCalls);
      const payload = JSON.stringify(shareCalls);
      await writeArtifact("场景2.P4", JSON.stringify({ shareCalls }));
      expect(payload, "静态壁纸项目标必须含 .jpg").toContain(".jpg");
      expect(payload, "静态壁纸项目标不得含 .mp4（互斥）").not.toContain(".mp4");
    } finally {
      await close();
    }
  });

  it("[场景2.P5] 无 Web Share 走 a.download 降级 → 文件名 == 拾光动态壁纸-{pickDate}.mp4", async ({
    browser,
  }) => {
    const { page, downloads, close } = await openProbePage(browser, {
      share: "noshare",
      mobile: true,
    });
    try {
      await page.goto(`${BASE_MAIN}/#/`);
      const btn = page.locator(`${WALL_CARD_D1} [data-role="wallpaper-download-video"]`);
      await btn.waitFor({ state: "visible", timeout: 12000 });
      await btn.click();

      const dl = await page.waitForEvent("download", { timeout: 20000 });
      downloads.push(dl);
      const filename = dl.suggestedFilename();
      const expected = `拾光动态壁纸-${datesMain.today}.mp4`;

      await writeArtifact("场景2.P5", JSON.stringify({ filename, expected, url: dl.url() }));
      expect(filename, `a.download 降级文件名必须为 ${expected}`).toBe(expected);
    } finally {
      await close();
    }
  });

  it("[场景2.P6] 下载进行中主钮 loading 态 + 文本含整数百分比", async ({ browser }) => {
    test.setTimeout(45_000);
    const { page, close } = await openProbePage(browser, { share: "resolve", mobile: true });
    try {
      await page.goto(`${BASE_SLOW}/#/`);
      const btn = page.locator(`${WALL_CARD_D1} [data-role="wallpaper-download-video"]`);
      await btn.waitFor({ state: "visible", timeout: 15000 });
      await btn.click();

      // 慢速服务 ≈1.3s 传输窗：bounded 轮询捕获 loading + 百分比（漏捕即红）
      await page.waitForFunction(
        () => {
          const b = document.querySelector(
            '[data-stream-unit][data-role="wallpaper-card"][data-day-index="0"] [data-role="wallpaper-download-video"]',
          );
          if (!b) return false;
          return (
            b.getAttribute("data-download-state") === "loading" &&
            /\d+%/.test((b.textContent ?? "").trim())
          );
        },
        undefined,
        { timeout: 8000, polling: 40 },
      );
      const mid = await page.evaluate((sel: string) => {
        const b = document.querySelector(`${sel} [data-role="wallpaper-download-video"]`);
        return {
          state: b?.getAttribute("data-download-state") ?? null,
          text: (b?.textContent ?? "").trim(),
          ariaValuenow: b?.getAttribute("aria-valuenow") ?? null,
        };
      }, WALL_CARD_D1);

      await writeArtifact("场景2.P6", JSON.stringify(mid));
      expect(mid.state, "下载进行中主钮必须为 loading 态").toBe("loading");
      expect(mid.text, `主钮文本必须含百分比，实际="${mid.text}"`).toMatch(/\d+%/);
      if (mid.ariaValuenow != null) {
        expect(
          Number.parseInt(mid.ariaValuenow, 10),
          "aria-valuenow 必须为 0-100 整数进度",
        ).toBeGreaterThanOrEqual(0);
        expect(Number.parseInt(mid.ariaValuenow, 10)).toBeLessThanOrEqual(100);
      }
      // 收尾：等链路走完（share 发起），不留悬挂请求
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 20000,
      });
    } finally {
      await close();
    }
  });

  it("[场景2.P7] fs-grep：VIDEO_DOWNLOAD_TIMEOUT_MS 位于 wallpaper-download-video 调用处（300000ms 档）", async () => {
    // SSOT 指定 driver: fs-grep:apps/gallery/app.js——文本契约锚点，非实现镜像
    const src = fs.readFileSync(path.join(SRC_GALLERY_DIR, "app.js"), "utf8");
    const lines = src.split("\n");
    const roleLineIdx = lines.findIndex((l) => l.includes("wallpaper-download-video"));
    expect(
      roleLineIdx,
      "app.js 必须存在 wallpaper-download-video 调用处（动态主钮接线）",
    ).toBeGreaterThanOrEqual(0);

    const windowLines = lines.slice(Math.max(0, roleLineIdx - 20), roleLineIdx + 20);
    const hasTimeoutConst = windowLines.some((l) => l.includes("VIDEO_DOWNLOAD_TIMEOUT_MS"));
    const has300kLiteral = windowLines.some((l) => /300_?000/.test(l));
    const defMatch = /VIDEO_DOWNLOAD_TIMEOUT_MS\s*=\s*([0-9_]{4,9})/.exec(src);

    await writeArtifact(
      "场景2.P7",
      JSON.stringify({ roleLineIdx, hasTimeoutConst, has300kLiteral, def: defMatch?.[1] ?? null }),
    );
    expect(
      hasTimeoutConst || has300kLiteral,
      `wallpaper-download-video 调用处 ±20 行内必须引用 VIDEO_DOWNLOAD_TIMEOUT_MS（或 300000 字面量），实际上下文：\n${windowLines.join("\n")}`,
    ).toBe(true);
    if (defMatch) {
      expect(
        Number.parseInt(defMatch[1]!.replace(/_/g, ""), 10),
        "VIDEO_DOWNLOAD_TIMEOUT_MS 常量值必须为 300000ms",
      ).toBe(300000);
    }
  });
});

// ============================================================================
// 场景 3：静态壁纸卡动作栏矩阵（主按钮保存壁纸 JPG + 「更多」仅电脑版）——D4
// ============================================================================

describe("[场景3] 静态壁纸卡动作栏矩阵（D4）", () => {
  it("[场景3.P1] 纯静态壁纸卡主钮可达名含连续「保存壁纸」且 role == wallpaper-download-portrait", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    const cardSel = await ensureWallpaperCardReady(page, 3, 3);

    const primary = await page.evaluate((sel: string) => {
      const b = document.querySelector(`${sel} [data-role="wallpaper-download-portrait"]`);
      if (!b) return null;
      return {
        axName: (b.getAttribute("aria-label") ?? b.textContent ?? "").trim(),
        text: (b.textContent ?? "").trim(),
        state: b.getAttribute("data-download-state"),
      };
    }, cardSel);

    await writeArtifact("场景3.P1", JSON.stringify(primary));
    expect(primary, "静态卡必须存在主钮 [data-role=wallpaper-download-portrait]").not.toBeNull();
    expect(
      primary?.axName ?? "",
      "静态主钮可达名必须含连续子串「保存壁纸」（plan 步骤 3 红线：不允许「保存手机竖版壁纸」类断开文案）",
    ).toContain("保存壁纸");
    expect(primary?.state).toBe("idle");
  });

  it("[场景3.P2] 点击静态卡主钮 → 下载目标含 .jpg 且不含 .mp4", async ({ browser }) => {
    const { page, close } = await openProbePage(browser, { share: "resolve", mobile: true });
    try {
      await page.goto(`${BASE_MAIN}/#/`);
      const cardSel = await ensureWallpaperCardReady(page, 3, 3);
      const btn = page.locator(`${cardSel} [data-role="wallpaper-download-portrait"]`);
      await btn.waitFor({ state: "visible", timeout: 8000 });
      await btn.click();
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 15000,
      });
      await page.waitForTimeout(300);

      const shareCalls = await page.evaluate(() => window.__shareCalls);
      const payload = JSON.stringify(shareCalls);
      await writeArtifact("场景3.P2", JSON.stringify({ shareCalls }));
      expect(payload, "静态主钮目标必须含 .jpg").toContain(".jpg");
      expect(payload, "静态主钮目标不得含 .mp4").not.toContain(".mp4");
    } finally {
      await close();
    }
  });

  it("[场景3.P3] 静态卡「更多」菜单有且仅有「电脑版」（itemCount==1）", async ({ page }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    const cardSel = await ensureWallpaperCardReady(page, 3, 3);
    await openMoreMenu(page, cardSel);

    const items = await readPopoverItems(page, cardSel);
    const names = (items ?? []).map((i) => i.name);
    await writeArtifact("场景3.P3", JSON.stringify({ items, names }));
    expect(items, "静态卡弹层必须存在").not.toBeNull();
    expect(names.length, `静态卡菜单项必须有且仅有 1 项，实际=${JSON.stringify(names)}`).toBe(1);
    expect(names[0] ?? "", "唯一菜单项必须为「电脑版」").toContain("电脑版");
    expect((items ?? [])[0]?.role, "唯一菜单项 role 必须为 wallpaper-download-landscape").toBe(
      "wallpaper-download-landscape",
    );
  });
});

// ============================================================================
// 场景 4：展示区智能拉通——拉伸代价小的方向恒铺满（F-near：D1 壁纸视频 128×220）
// ============================================================================

describe("[场景4] 智能拉通 F-near 铺满（壁纸视频卡 + 主题视频卡）", () => {
  it("[场景4.P1][场景4.P2] F-near 壁纸卡铺满两轴（±1px）∧ cropRatio≤0.30 ∧ data-fill=cover", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(WALL_CARD_D1, { timeout: 12000 });
    await scrollUnitIntoView(page, WALL_CARD_D1);
    await page.waitForSelector(`${WALL_CARD_D1} video`, { timeout: 12000 });
    await waitForFill(page, WALL_CARD_D1);

    const st = await readFillState(page, WALL_CARD_D1);
    await writeArtifact("场景4.P1", JSON.stringify(st));

    // P1 字面量：abs(mediaW − containerW) <= 1 且 abs(mediaH − containerH) <= 1
    expect(st.exists, "壁纸卡单元必须存在").toBe(true);
    expect(st.mediaBox, "卡内必须存在媒体元素").not.toBeNull();
    expect(
      Math.abs(st.mediaBox!.w - st.unitBox!.w),
      `媒体宽必须铺满容器宽（media=${st.mediaBox?.w}, unit=${st.unitBox?.w}）`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(st.mediaBox!.h - st.unitBox!.h),
      `媒体高必须铺满容器高（media=${st.mediaBox?.h}, unit=${st.unitBox?.h}）`,
    ).toBeLessThanOrEqual(1);

    // P2：隐含 cover 裁切率 ≤ 30% + 机读 data-fill == "cover"
    await writeArtifact(
      "场景4.P2",
      JSON.stringify({ cropRatio: st.cropRatio, fill: st.fill, natural: st.natural }),
    );
    expect(
      st.cropRatio,
      `F-near 裁切率必须 ≤0.30（128×220 于 390×844 ≈ 0.206），实际=${st.cropRatio}`,
    ).toBeLessThanOrEqual(0.3);
    expect(st.fill, "单元机读 data-fill 必须为 cover").toBe("cover");
  });

  it("[场景4.P3] 壁纸卡与主题视频卡均至少一轴媒体渲染尺寸等于容器对应尺寸（±1px）", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(WALL_CARD_D1, { timeout: 12000 });
    await scrollUnitIntoView(page, WALL_CARD_D1);
    await waitForFill(page, WALL_CARD_D1);
    await scrollUnitIntoView(page, D1_THEME_VIDEO_UNIT);
    await waitForFill(page, D1_THEME_VIDEO_UNIT);

    const wp = await readFillState(page, WALL_CARD_D1);
    const vid = await readFillState(page, D1_THEME_VIDEO_UNIT);
    const axisFilled = (s: FillState): boolean =>
      !!s.mediaBox &&
      (Math.abs(s.mediaBox.w - s.unitBox!.w) <= 1 || Math.abs(s.mediaBox.h - s.unitBox!.h) <= 1);

    await writeArtifact("场景4.P3", JSON.stringify({ wallpaper: wp, themeVideo: vid }));
    expect(wp.exists && vid.exists, "两类卡单元必须都存在").toBe(true);
    expect(
      axisFilled(wp),
      `壁纸卡（${wp.fill}）必须至少一轴铺满：media=${JSON.stringify(wp.mediaBox)}, unit=${JSON.stringify(wp.unitBox)}`,
    ).toBe(true);
    expect(
      axisFilled(vid),
      `主题视频卡（${vid.fill}）必须至少一轴铺满：media=${JSON.stringify(vid.mediaBox)}, unit=${JSON.stringify(vid.unitBox)}`,
    ).toBe(true);
  });
});

// ============================================================================
// 场景 5：智能拉通——另一方向裁切超 30% 回退 contain + 模糊垫底
//   P1/P2 目标 = 变体 B 昨日壁纸卡（16:9 横比图 320×180 于 390×844 → cropRatio≈0.74）
//   P3 目标 = 变体 A D1 主题视频卡（4:3 160×120 → cropRatio≈0.65）
// ============================================================================

const FALLBACK_WALL_CARD_D2 = '[data-stream-unit][data-role="wallpaper-card"][data-day-index="1"]';

describe("[场景5] 裁切>30% 回退 contain + 模糊垫底", () => {
  it("[场景5.P1][场景5.P2] 壁纸卡 F-one-axis：contain 形态（内容盒保自然比例）∧ 模糊垫底层 blurRadius>0", async ({
    page,
  }) => {
    await page.goto(`${BASE_FALLBACK}/#/`);
    await page.waitForSelector(FALLBACK_WALL_CARD_D2, { timeout: 12000 });
    await scrollUnitIntoView(page, FALLBACK_WALL_CARD_D2);
    await page.waitForSelector(`${FALLBACK_WALL_CARD_D2} img`, { timeout: 12000 });
    await waitForFill(page, FALLBACK_WALL_CARD_D2);

    const st = await readFillState(page, FALLBACK_WALL_CARD_D2);
    await writeArtifact("场景5.P1", JSON.stringify(st));

    expect(st.exists, "昨日壁纸卡必须存在").toBe(true);
    expect(st.fill, "16:9 媒体于竖版视口必须回退 contain（cropRatio≈0.74 > 0.3）").toBe("contain");
    expect(st.objectFit.toLowerCase(), "computed object-fit 必须为 contain").toContain("contain");
    // 内容盒渲染宽高比保持自然（±2%），且完整落入容器（该轴回退为完整可见）
    expect(st.content, "固有尺寸就绪后必须可推导内容盒").not.toBeNull();
    const naturalAspect = st.natural.w / st.natural.h;
    const contentAspect = st.content!.w / st.content!.h;
    expect(
      Math.abs(contentAspect - naturalAspect) / naturalAspect,
      `contain 内容盒宽高比必须保持自然值（content=${contentAspect.toFixed(3)}, natural=${naturalAspect.toFixed(3)}）`,
    ).toBeLessThanOrEqual(0.02);
    expect(
      st.content!.h,
      `contain 内容盒高不得超出容器高（content.h=${st.content!.h}, container.h=${st.unitBox!.h}）`,
    ).toBeLessThanOrEqual(st.unitBox!.h + 1);
    expect(
      st.content!.w,
      `contain 内容盒宽不得超出容器宽（content.w=${st.content!.w}, container.w=${st.unitBox!.w}）`,
    ).toBeLessThanOrEqual(st.unitBox!.w + 1);

    // P2：媒体底层模糊垫底节点存在且 blur 半径 > 0
    await writeArtifact("场景5.P2", JSON.stringify({ blurRadius: st.blurRadius }));
    expect(
      st.blurRadius,
      "触发 30% 回退后卡内必须存在模糊垫底层（computed filter blur(px) > 0）",
    ).toBeGreaterThan(0);
  });

  it("[场景5.P3] 主题视频卡触发 >30% 裁切 → 相同回退（contain 形态 + 模糊垫底）", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(D1_THEME_VIDEO_UNIT, { timeout: 12000 });
    await scrollUnitIntoView(page, D1_THEME_VIDEO_UNIT);
    await page.waitForSelector(`${D1_THEME_VIDEO_UNIT} video`, { timeout: 12000 });
    await waitForFill(page, D1_THEME_VIDEO_UNIT);

    const st = await readFillState(page, D1_THEME_VIDEO_UNIT);
    await writeArtifact("场景5.P3", JSON.stringify(st));

    expect(st.exists, "D1 主题视频单元必须存在").toBe(true);
    expect(st.fill, "4:3 主题视频于竖版视口必须 contain（cropRatio≈0.65 > 0.3）").toBe("contain");
    expect(st.objectFit.toLowerCase(), "computed object-fit 必须为 contain").toContain("contain");
    const naturalAspect = st.natural.w / st.natural.h;
    const contentAspect = st.content!.w / st.content!.h;
    expect(
      Math.abs(contentAspect - naturalAspect) / naturalAspect,
      "主题视频卡 contain 内容盒宽高比必须保持自然值",
    ).toBeLessThanOrEqual(0.02);
    expect(st.blurRadius, "主题视频卡 contain 态必须有模糊垫底层（blur(px) > 0）").toBeGreaterThan(
      0,
    );
  });
});

// ============================================================================
// 场景 6：无壁纸素材日回落现有顺序（D3 不出现壁纸卡）
// ============================================================================

describe("[场景6] 无壁纸素材日回落 + 混日独立生效", () => {
  it("[场景6.P1][场景6.P2] D3 日段 wallpaperCount==0 ∧ 维持既有顺序 [date-separator, video, photo×3]", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await mountDaySegment(page, 2, 3);

    const d3 = await readDayUnits(page, 2);
    const types = d3.map((u) => u.type);
    const wallpaperCount = types.filter((t) => t === "wallpaper").length;
    const expected = ["date-separator", "video", "photo", "photo", "photo"];

    await writeArtifact("场景6.P1", JSON.stringify({ types, wallpaperCount }));
    expect(wallpaperCount, "D3 日段不得出现 wallpaper 类型单元").toBe(0);
    expect(
      d3.filter((u) => u.role === "wallpaper-card").length,
      "D3 日段不得存在 wallpaper-card 角色节点",
    ).toBe(0);

    await writeArtifact("场景6.P2", JSON.stringify({ types, expected }));
    expect(types, `D3 无壁纸素材日必须回落既有顺序，实际=${JSON.stringify(types)}`).toEqual(
      expected,
    );
  });

  it("[场景6.P3] 同一 manifest 含 D1 与 D3 → 两日段各自独立生效（D1 壁纸居首 ∧ D3 无壁纸卡；分隔日壁纸位以 D2 承担）", async ({
    page,
  }) => {
    // CONTRACT_AMBIGUOUS 3：谓词字面量 d1.types[1]==wallpaper 与场景1.P1 矛盾（D1 流顶无分隔卡），
    // 按「D1 壁纸居首」断言 types[0]，分隔日 seg[1]==wallpaper 由 D2 承担。
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector('[data-stream-unit][data-day-index="1"][data-photo-rank="3"]', {
      timeout: 12000,
    });
    await mountDaySegment(page, 2, 3);

    const d1 = await readDayUnits(page, 0);
    const d2 = await readDayUnits(page, 1);
    const d3 = await readDayUnits(page, 2);

    const payload = {
      d1: d1.map((u) => u.type),
      d2: d2.map((u) => u.type),
      d3: d3.map((u) => u.type),
    };
    await writeArtifact("场景6.P3", JSON.stringify(payload));
    expect(d1[0]?.type, "D1 壁纸必须居该日首位").toBe("wallpaper");
    expect(d2[0]?.type, "D2 分隔卡必须居首").toBe("date-separator");
    expect(d2[1]?.type, "D2（分隔日）壁纸卡必须位于 index==1").toBe("wallpaper");
    expect(d3.map((u) => u.type).filter((t) => t === "wallpaper").length, "D3 必须零壁纸卡").toBe(
      0,
    );
  });
});

// ============================================================================
// 场景 7：date/rank 深链在新顺序下定位不漂移（D1 rank=5）
// ============================================================================

describe("[场景7] date/rank 深链定位不漂移", () => {
  it("[场景7.P1][场景7.P2][场景7.P3] #/?date=<D1>&rank=5 → 定位 photo 单元（photoId 相符 ∧ 在视口内 ∧ 类型为 photo）", async ({
    page,
  }) => {
    // CONTRACT_AMBIGUOUS 4：photos[N] 下标语义按 rank 字段查找（rank=5 ↔ data-photo-rank="5"）
    const day = manifestMain.days[0]!;
    const target = day.photos.find((p) => p.rank === 5);
    expect(target, "fixture D1 必须含 rank=5 照片").toBeDefined();

    await page.goto(`${BASE_MAIN}/#/?date=${day.pickDate}&rank=5`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 12000 });
    const rect = await waitUnitIntersecting(
      page,
      `[data-stream-unit][data-photo-id="${target!.photoId}"]`,
    );

    const probe = await page.evaluate((photoId: string) => {
      const el = document.querySelector(`[data-stream-unit][data-photo-id="${photoId}"]`);
      if (!el) return null;
      return {
        unitType: el.getAttribute("data-unit-type"),
        photoRank: el.getAttribute("data-photo-rank"),
        dayIndex: el.getAttribute("data-day-index"),
      };
    }, target!.photoId);

    await writeArtifact(
      "场景7.P1",
      JSON.stringify({ expectedPhotoId: target!.photoId, probe, rect }),
    );
    // P1：定位单元 photoId == manifest 该日 rank=5 的 photoId
    expect(probe, "深链目标照片单元必须挂载").not.toBeNull();
    expect(probe?.unitType, "P3：定位单元类型必须为 photo").toBe("photo");
    expect(probe?.photoRank, "P3：rank 深链不得漂移到相邻 rank").toBe("5");
    expect(probe?.unitType, "P3： negate wallpaper").not.toBe("wallpaper");
    expect(probe?.unitType, "P3： negate date-separator").not.toBe("date-separator");
    // P2：目标单元滚入视口（boundingBox 与 viewport 相交）
    await writeArtifact("场景7.P2", JSON.stringify({ rect }));
    expect(
      rect.top < 844 && rect.bottom > 0,
      `目标单元必须与视口相交（rect.top=${rect.top}, rect.bottom=${rect.bottom}）`,
    ).toBe(true);
  });
});

// ============================================================================
// 场景 8：video 深链定位与静音自动播放（D1 主题视频）
// ============================================================================

describe("[场景8] #/video/<themeKey> 深链定位 + 静音自动播放", () => {
  it("[场景8.P1][场景8.P2] 直开深链 → 定位该 themeKey 视频卡 ∧ 静音自动播放", async ({ page }) => {
    const video = manifestMain.videos[0]!;
    const unitSel = `[data-stream-unit][data-video-id="${video.themeKey}"]`;

    await page.goto(`${BASE_MAIN}/#/video/${video.themeKey}`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 12000 });
    await waitUnitIntersecting(page, unitSel);

    const probe = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return {
        unitType: el.getAttribute("data-unit-type"),
        mediaKey: el.getAttribute("data-video-id"),
        uuid: el.getAttribute("data-video-uuid"),
      };
    }, unitSel);

    await writeArtifact("场景8.P1", JSON.stringify({ themeKey: video.themeKey, probe }));
    expect(probe, "深链目标视频单元必须挂载").not.toBeNull();
    expect(probe?.unitType, "定位卡类型必须为 video").toBe("video");
    expect(probe?.mediaKey, "mediaKey（data-video-id）必须等于深链 videoId").toBe(video.themeKey);

    await waitForVideoPlaying(page, `${unitSel} video`);
    const playback = await page.evaluate((sel: string) => {
      const v = document.querySelector(`${sel} video`) as HTMLVideoElement | null;
      return v ? { muted: v.muted, paused: v.paused } : null;
    }, unitSel);
    await writeArtifact("场景8.P2", JSON.stringify(playback));
    expect(playback?.muted, "深链落位视频必须静音").toBe(true);
    expect(playback?.paused, "深链落位视频必须自动播放").toBe(false);
  });
});

// ============================================================================
// 场景 9：壁纸动态视频与主题视频单播放器互斥（D1 两卡相邻）
// ============================================================================

describe("[场景9] 壁纸视频与主题视频单播放器互斥", () => {
  it("[场景9.P1] 两卡交界同屏相交时至多一条视频处于播放态", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(WALL_CARD_D1, { timeout: 12000 });
    // 前置：壁纸卡视频先进入播放态（排除「都没播」的 vacuous 绿）
    await scrollUnitIntoView(page, WALL_CARD_D1);
    await waitForVideoPlaying(page, `${WALL_CARD_D1} video`);

    // 停在两卡交界：壁纸卡底部 420px + 主题视频卡顶部 424px 同时与视口相交
    await page.evaluate(() => {
      const stream = document.getElementById("stream");
      const scroller = (
        stream && stream.scrollHeight > stream.clientHeight + 10
          ? stream
          : document.scrollingElement
      ) as HTMLElement | null;
      if (!scroller) return;
      scroller.style.scrollSnapType = "none"; // 交界停驻需临时解除吸附（测试装置行为）
      scroller.style.scrollBehavior = "auto";
      const videoUnit = document.querySelector(
        '[data-stream-unit][data-unit-type="video"][data-day-index="0"]',
      ) as HTMLElement | null;
      if (!videoUnit) return;
      const relTop = videoUnit.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = relTop - 424;
    });
    await page.waitForTimeout(500);

    const probe = await page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const vids = Array.from(document.querySelectorAll("video")).map((v) => {
        const r = v.getBoundingClientRect();
        return {
          intersects: r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0,
          paused: v.paused,
          muted: v.muted,
        };
      });
      return {
        intersecting: vids.filter((v) => v.intersects).length,
        playing: vids.filter((v) => v.intersects && !v.paused).length,
      };
    });

    await writeArtifact("场景9.P1", JSON.stringify(probe));
    expect(
      probe.intersecting,
      "两卡交界处必须至少两条视频与视口相交（vacuity guard）",
    ).toBeGreaterThanOrEqual(2);
    expect(probe.playing, "同屏相交视频中处于播放态的必须 ≤1").toBeLessThanOrEqual(1);
  });

  it("[场景9.P2][场景9.P3] 主题视频起播 → 壁纸视频让渡暂停 ∧ 播放态恒 muted", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(WALL_CARD_D1, { timeout: 12000 });
    // 壁纸视频先播（让渡前提）
    await scrollUnitIntoView(page, WALL_CARD_D1);
    await waitForVideoPlaying(page, `${WALL_CARD_D1} video`);

    // 触发主题视频起播
    await scrollUnitIntoView(page, D1_THEME_VIDEO_UNIT);
    await waitForVideoPlaying(page, `${D1_THEME_VIDEO_UNIT} video`);

    const state = await page.evaluate(() => {
      const wpVideo = document.querySelector(
        '[data-stream-unit][data-role="wallpaper-card"][data-day-index="0"] video',
      ) as HTMLVideoElement | null;
      const all = Array.from(document.querySelectorAll("video")).map((v) => ({
        paused: v.paused,
        muted: v.muted,
      }));
      return {
        wpVideoPaused: wpVideo ? wpVideo.paused : null,
        playingAllMuted: all.filter((v) => !v.paused).every((v) => v.muted),
        playingCount: all.filter((v) => !v.paused).length,
      };
    });

    // 同一 test 的两个谓词快照（确定性 state）分别嵌 pred id，防 MD5 撞车误判复制
    await writeArtifact(
      "场景9.P2",
      JSON.stringify({ pred: "场景9.P2", executedAt: new Date().toISOString(), ...state }),
    );
    expect(state.wpVideoPaused, "主题视频起播后壁纸视频必须转为暂停").toBe(true);
    await writeArtifact(
      "场景9.P3",
      JSON.stringify({ pred: "场景9.P3", executedAt: new Date().toISOString(), ...state }),
    );
    expect(
      state.playingCount,
      "场景内必须有视频处于播放态（vacuity guard）",
    ).toBeGreaterThanOrEqual(1);
    expect(state.playingAllMuted, "任一播放态视频必须 muted == true").toBe(true);
  });
});

// ============================================================================
// 场景 10：壁纸图存在但壁纸视频字段缺失——静态壁纸卡仍居首（D4）
// ============================================================================

describe("[场景10] D4 静态壁纸日（视频字段缺省）仍居首", () => {
  it("[场景10.P1] D4 序列 == [date-separator, wallpaper, video, photo×3]（逐位匹配）", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await mountDaySegment(page, 3, 3);

    const d4 = await readDayUnits(page, 3);
    const types = d4.map((u) => u.type);
    const expected = ["date-separator", "wallpaper", "video", "photo", "photo", "photo"];

    await writeArtifact("场景10.P1", JSON.stringify({ types, expected }));
    expect(types, `D4 静态壁纸日序列必须为 ${JSON.stringify(expected)}`).toEqual(expected);
  });

  it("[场景10.P2] D4 壁纸卡呈静态渲染（video 元素数 == 0 ∧ data-has-video 缺省）", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    const cardSel = await ensureWallpaperCardReady(page, 3, 3);

    const probe = await page.evaluate((sel: string) => {
      const unit = document.querySelector(sel) as HTMLElement | null;
      if (!unit) return null;
      const img = unit.querySelector("img");
      return {
        videoElementCount: unit.querySelectorAll("video").length,
        hasVideoAttr: unit.getAttribute("data-has-video"),
        imgNaturalWidth: img?.naturalWidth ?? 0,
      };
    }, cardSel);

    await writeArtifact("场景10.P2", JSON.stringify(probe));
    expect(probe, "D4 壁纸卡必须存在").not.toBeNull();
    expect(probe?.videoElementCount, "静态壁纸卡不得含 video 元素").toBe(0);
    expect(probe?.hasVideoAttr, "data-has-video 必须缺省").toBeNull();
    expect(probe?.imgNaturalWidth, "静态壁纸图必须已解码").toBeGreaterThan(0);
  });

  it("[场景10.P3] D4 静态按钮矩阵：主钮含「保存壁纸」∧ 菜单仅[电脑版] ∧ 全部下载目标无 .mp4", async ({
    browser,
  }) => {
    const { page, close } = await openProbePage(browser, { share: "resolve", mobile: true });
    try {
      await page.goto(`${BASE_MAIN}/#/`);
      const cardSel = await ensureWallpaperCardReady(page, 3, 3);

      // 主钮：role + 可达名
      const primary = await page.evaluate((sel: string) => {
        const b = document.querySelector(`${sel} [data-role="wallpaper-download-portrait"]`);
        return b ? (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() : null;
      }, cardSel);
      expect(primary ?? "", "静态主钮可达名必须含连续「保存壁纸」").toContain("保存壁纸");

      // mp4 下载入口结构性缺席
      const videoBtnCount = await page.evaluate(
        (sel: string) =>
          document.querySelectorAll(`${sel} [data-role="wallpaper-download-video"]`).length,
        cardSel,
      );
      expect(videoBtnCount, "静态卡不得存在 mp4 下载入口").toBe(0);

      // 菜单：有且仅有电脑版；逐项点击收集下载目标，均 .jpg 无 .mp4
      await openMoreMenu(page, cardSel);
      const items = await readPopoverItems(page, cardSel);
      const names = (items ?? []).map((i) => i.name);
      expect(names.length, `静态卡菜单必须有且仅有[电脑版]，实际=${JSON.stringify(names)}`).toBe(1);
      expect(names[0] ?? "").toContain("电脑版");

      const payloads: string[] = [];
      // 主钮点击
      const primaryBtn = page.locator(`${cardSel} [data-role="wallpaper-download-portrait"]`);
      await primaryBtn.click();
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 15000,
      });
      payloads.push(JSON.stringify(await page.evaluate(() => window.__shareCalls)));
      // 菜单电脑版项点击
      await openMoreMenu(page, cardSel);
      const landscapeItem = page.locator(
        `${MORE_POPOVER(cardSel)} [data-role="wallpaper-download-landscape"]`,
      );
      await landscapeItem.waitFor({ state: "visible", timeout: 5000 });
      await landscapeItem.click();
      await page.waitForFunction(() => window.__shareCalls.length >= 2, undefined, {
        timeout: 15000,
      });
      payloads.push(JSON.stringify(await page.evaluate(() => window.__shareCalls)));

      const allTargets = payloads.join("|");
      await writeArtifact("场景10.P3", JSON.stringify({ primary, names, allTargets }));
      expect(allTargets, "全部下载目标必须含 .jpg").toContain(".jpg");
      expect(allTargets, "全部下载目标不得含 .mp4").not.toContain(".mp4");
    } finally {
      await close();
    }
  });
});

// ============================================================================
// 场景 11：动态视频下载复用既有三级降级链路（逐级冒烟）
// ============================================================================

describe("[场景11] 三级降级链路逐级冒烟", () => {
  it("[场景11.P1] tier1（iOS-like UA + Web Share stub）点主钮 → 优先 Web Share 且 payload 含 mp4", async ({
    browser,
  }) => {
    const { page, close } = await openProbePage(browser, { share: "resolve", mobile: true });
    try {
      await page.goto(`${BASE_MAIN}/#/`);
      const btn = page.locator(`${WALL_CARD_D1} [data-role="wallpaper-download-video"]`);
      await btn.waitFor({ state: "visible", timeout: 12000 });
      await btn.click();
      await page.waitForFunction(() => window.__shareCalls.length >= 1, undefined, {
        timeout: 15000,
      });

      const shareCalls = await page.evaluate(() => window.__shareCalls);
      const payload = JSON.stringify(shareCalls);
      await writeArtifact(
        "场景11.P1",
        JSON.stringify({ pred: "场景11.P1", executedAt: new Date().toISOString(), shareCalls }),
      );
      expect(shareCalls.length, "Web Share 可用时必须优先走 share 路径").toBeGreaterThanOrEqual(1);
      expect(payload, "share payload 必须含 mp4").toContain("mp4");
    } finally {
      await close();
    }
  });

  it("[场景11.P2] tier2（桌面 Chromium 无 navigator.share）点主钮 → a.download 触发浏览器下载（.mp4）", async ({
    browser,
  }) => {
    // CONTRACT_AMBIGUOUS 5：blob: 下载 url() 不含 .mp4，断言 url 或 suggestedFilename 之一承载 .mp4
    const { page, downloads, close } = await openProbePage(browser, {
      share: "noshare",
      mobile: false,
    });
    try {
      await page.goto(`${BASE_MAIN}/#/`);
      const btn = page.locator(`${WALL_CARD_D1} [data-role="wallpaper-download-video"]`);
      await btn.waitFor({ state: "visible", timeout: 12000 });
      await btn.click();

      const dl = await page.waitForEvent("download", { timeout: 20000 });
      downloads.push(dl);
      const url = dl.url();
      const filename = dl.suggestedFilename();

      await writeArtifact("场景11.P2", JSON.stringify({ url, filename }));
      expect(
        downloads.length,
        "无 navigator.share 必须降级触发浏览器下载事件",
      ).toBeGreaterThanOrEqual(1);
      expect(
        url.includes(".mp4") || filename.endsWith(".mp4"),
        `下载目标必须承载 .mp4（url=${url}, filename=${filename}）`,
      ).toBe(true);
    } finally {
      await close();
    }
  });

  it("[场景11.P3] 终极直链兜底目标网络可达（fixture 本地服务真实 HTTP：200 ∧ content-type video/）", async () => {
    const rel = manifestMain.days[0]!.wallpaperVideoPortrait!;
    expect(typeof rel).toBe("string");
    const url = new URL(rel, `${BASE_MAIN}/`).href;
    const res = await fetch(url);
    const contentType = res.headers.get("content-type") ?? "";

    await writeArtifact("场景11.P3", JSON.stringify({ url, status: res.status, contentType }));
    expect(res.status, "壁纸视频直链必须真实可达（不依赖外网 COS）").toBe(200);
    expect(contentType, `content-type 必须为 video/*，实际=${contentType}`).toContain("video/");
  });
});

// ============================================================================
// 场景 12：微信内置浏览器动态视频下载弹「在 Safari 中打开」引导遮罩
// ============================================================================

describe("[场景12] 微信 UA 动态视频下载引导遮罩", () => {
  it("[场景12.P1][场景12.P2] 微信 UA 点主钮 → 遮罩含 Safari 文案 ∧ share/download 前两级零触发", async ({
    browser,
  }) => {
    // share stub 保持可用：验证 isWeChat 门控优先于分享能力探测（沿既有场景W1 惯例）
    const { page, downloads, close } = await openProbePage(browser, {
      share: "resolve",
      mobile: true,
      ua: WECHAT_UA,
    });
    try {
      await page.goto(`${BASE_MAIN}/#/`);
      const btn = page.locator(`${WALL_CARD_D1} [data-role="wallpaper-download-video"]`);
      await btn.waitFor({ state: "visible", timeout: 12000 });
      await btn.click();

      // 遮罩可能带淡入过渡，必须等「真正可见」
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
        { timeout: 6000 },
      );
      await page.waitForTimeout(500); // 等待可能迟到的 share/download 副作用（negate 观测窗）

      const overlayText = await page.evaluate(() => {
        const g = document.querySelector('[data-role="wechat-guide"]');
        return g ? (g.textContent ?? "").trim() : "";
      });
      const shareCalls = await page.evaluate(() => window.__shareCalls);
      const openCalls = await page.evaluate(() => window.__openCalls);
      const fetchLog = await page.evaluate(() => window.__fetchLog);

      await writeArtifact(
        "场景12.P1",
        JSON.stringify({ overlayText, shareCalls: shareCalls.length, downloads: downloads.length }),
      );
      expect(overlayText, "引导遮罩必须可见").not.toBe("");
      expect(overlayText, "遮罩文案必须含「Safari」（在 Safari 中打开）").toContain("Safari");

      await writeArtifact(
        "场景12.P2",
        JSON.stringify({
          shareCalls: shareCalls.length,
          downloadEvents: downloads.length,
          openCalls: openCalls.length,
          mp4Fetches: fetchLog.filter((u) => u.includes(".mp4")).length,
        }),
      );
      expect(shareCalls.length, "微信环境不得触发 navigator.share").toBe(0);
      expect(downloads.length, "微信环境不得触发 a.download").toBe(0);
      expect(openCalls, "微信环境不得新开直链").toHaveLength(0);
      expect(
        fetchLog.every((u) => !u.includes(".mp4")),
        "微信环境不得发起 mp4 fetch（契约：遮罩引导优先于 fetch）",
      ).toBe(true);
    } finally {
      await close();
    }
  });

  it("[场景12.P3] 关闭引导遮罩 → 遮罩消失 ∧ scroll-snap 容器可继续滚动", async ({ browser }) => {
    const { page, close } = await openProbePage(browser, {
      share: "resolve",
      mobile: true,
      ua: WECHAT_UA,
    });
    try {
      await page.goto(`${BASE_MAIN}/#/`);
      const btn = page.locator(`${WALL_CARD_D1} [data-role="wallpaper-download-video"]`);
      await btn.waitFor({ state: "visible", timeout: 12000 });
      await btn.click();
      await page.waitForSelector('[data-role="wechat-guide"]', { timeout: 6000 });

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

      // 滚动可恢复性：真实滚动 delta 探针（临时解除吸附）
      const scrollProbe = await page.evaluate(() => {
        const stream = document.getElementById("stream");
        const scroller = (
          stream && stream.scrollHeight > stream.clientHeight + 10
            ? stream
            : document.scrollingElement
        ) as HTMLElement | null;
        if (!scroller) return { before: -1, after: -1, delta: 0 };
        const prevSnap = scroller.style.scrollSnapType;
        const prevSmooth = scroller.style.scrollBehavior;
        scroller.style.scrollSnapType = "none";
        scroller.style.scrollBehavior = "auto";
        const before = scroller.scrollTop;
        scroller.scrollTop = before + 300;
        const after = scroller.scrollTop;
        scroller.style.scrollSnapType = prevSnap;
        scroller.style.scrollBehavior = prevSmooth;
        return { before, after, delta: Math.abs(after - before) };
      });
      const overlayGone = await page.evaluate(() => {
        const g = document.querySelector('[data-role="wechat-guide"]');
        if (!g) return true;
        const s = window.getComputedStyle(g);
        return s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0;
      });

      await writeArtifact("场景12.P3", JSON.stringify({ overlayGone, scrollProbe }));
      expect(overlayGone, "关闭后遮罩必须消失").toBe(true);
      expect(scrollProbe.delta, "关闭后滚动容器必须可继续滚动（delta > 50）").toBeGreaterThan(50);
    } finally {
      await close();
    }
  });
});

// ============================================================================
// 场景 13：更多菜单关闭契约（Esc / 外点关闭 + aria 复位 + 菜单项常驻 DOM）
// ============================================================================

describe("[场景13] 更多菜单关闭契约（D1 动态卡）", () => {
  it("[场景13.P1] 展开态按 Esc → 弹层 hidden ∧ aria-expanded == 'false'", async ({ page }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(WALL_CARD_D1, { timeout: 12000 });
    await scrollUnitIntoView(page, WALL_CARD_D1);

    const initial = await readMenuToggleState(page, WALL_CARD_D1);
    expect(initial.popoverHidden, "初始弹层必须 hidden").toBe(true);
    expect(initial.ariaExpanded, "初始 aria-expanded 必须非 true").not.toBe("true");

    await openMoreMenu(page, WALL_CARD_D1);
    const opened = await readMenuToggleState(page, WALL_CARD_D1);
    expect(opened.popoverHidden, "展开后弹层必须取消 hidden").toBe(false);
    expect(opened.ariaExpanded, "展开后 aria-expanded 必须同步为 true").toBe("true");

    await page.keyboard.press("Escape");
    await page.waitForFunction(
      (sel: string) => {
        const pop = document.querySelector(`${sel} [data-role="more-menu-popover"]`);
        return !!pop && pop.hasAttribute("hidden");
      },
      WALL_CARD_D1,
      { timeout: 5000, polling: 100 },
    );
    const closed = await readMenuToggleState(page, WALL_CARD_D1);
    await writeArtifact("场景13.P1", JSON.stringify({ initial, opened, closed }));
    expect(closed.popoverHidden, "Esc 后弹层必须置 hidden").toBe(true);
    expect(closed.ariaExpanded, "Esc 后 aria-expanded 必须复位 false").toBe("false");
  });

  it("[场景13.P2] 展开态点击弹层外区域 → 弹层 hidden ∧ aria-expanded == 'false'", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(WALL_CARD_D1, { timeout: 12000 });
    await scrollUnitIntoView(page, WALL_CARD_D1);
    await openMoreMenu(page, WALL_CARD_D1);

    // 弹层定位右下、动作栏上方 → 外点取视口上部中点（媒体区，必然在弹层外）
    await page.mouse.click(195, 90);
    await page.waitForFunction(
      (sel: string) => {
        const pop = document.querySelector(`${sel} [data-role="more-menu-popover"]`);
        return !!pop && pop.hasAttribute("hidden");
      },
      WALL_CARD_D1,
      { timeout: 5000, polling: 100 },
    );
    const closed = await readMenuToggleState(page, WALL_CARD_D1);
    await writeArtifact("场景13.P2", JSON.stringify(closed));
    expect(closed.popoverHidden, "外点后弹层必须置 hidden").toBe(true);
    expect(closed.ariaExpanded, "外点后 aria-expanded 必须复位 false").toBe("false");
  });

  it("[场景13.P3] 菜单未展开时菜单项按钮常驻 DOM（卡内 wallpaper-download-portrait 计数 == 1）", async ({
    page,
  }) => {
    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(WALL_CARD_D1, { timeout: 12000 });
    await scrollUnitIntoView(page, WALL_CARD_D1);

    const probe = await page.evaluate((sel: string) => {
      const card = document.querySelector(sel);
      return {
        portraitItemCount: card
          ? card.querySelectorAll('[data-role="wallpaper-download-portrait"]').length
          : -1,
        popoverInDom: !!document.querySelector(`${sel} [data-role="more-menu-popover"]`),
        popoverHidden: document
          .querySelector(`${sel} [data-role="more-menu-popover"]`)
          ?.hasAttribute("hidden"),
        downloadVideoCount: card
          ? card.querySelectorAll('[data-role="wallpaper-download-video"]').length
          : -1,
      };
    }, WALL_CARD_D1);

    await writeArtifact("场景13.P3", JSON.stringify(probe));
    expect(probe?.portraitItemCount, "未展开态静态壁纸菜单项必须已常驻 DOM（计数 == 1）").toBe(1);
    expect(probe?.popoverInDom, "弹层节点必须常驻 DOM（非懒创建）").toBe(true);
    expect(probe?.popoverHidden, "未展开态弹层必须 hidden").toBe(true);
    expect(probe?.downloadVideoCount, "动态卡主钮恰一个").toBe(1);
  });
});

// ============================================================================
// 场景 14：壁纸视频加载失败降级矩阵（error → 静态重渲 + 主钮降级）
// ============================================================================

describe("[场景14] 壁纸视频 404 降级矩阵", () => {
  it("[场景14.P1][场景14.P2][场景14.P3] video error → 整卡重渲静态 ∧ 主钮降级保存壁纸 ∧ 菜单仅电脑版 ∧ 零 mp4 入口", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const wall404Responses: number[] = [];
    await page.route(
      (url) => url.pathname.includes("wallpaper-videos"),
      (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" }),
    );
    page.on("response", (r) => {
      if (r.url().includes("wallpaper-videos")) wall404Responses.push(r.status());
    });

    await page.goto(`${BASE_MAIN}/#/`);
    await page.waitForSelector(WALL_CARD_D1, { timeout: 12000 });
    await scrollUnitIntoView(page, WALL_CARD_D1);

    // 拦截必须真实命中（No-op kill：404 未命中则后续回退断言全失去意义）
    {
      const deadline = Date.now() + 8000;
      while (!wall404Responses.includes(404) && Date.now() < deadline) {
        await page.waitForTimeout(200);
      }
    }
    expect(wall404Responses, "壁纸视频请求必须被 404 拦截命中").toContain(404);

    // P1：整卡重渲为静态变体（img naturalWidth>0 ∧ data-has-video 移除 ∧ 零 video）
    await page.waitForFunction(
      (sel: string) => {
        const unit = document.querySelector(sel) as HTMLElement | null;
        if (!unit) return false;
        if (unit.hasAttribute("data-has-video")) return false;
        const img = unit.querySelector("img");
        return (
          !!img &&
          img.complete &&
          (img.naturalWidth ?? 0) > 0 &&
          unit.querySelectorAll("video").length === 0
        );
      },
      WALL_CARD_D1,
      { timeout: 15000, polling: 150 },
    );
    const afterError = await page.evaluate((sel: string) => {
      const unit = document.querySelector(sel) as HTMLElement | null;
      if (!unit) return null;
      const img = unit.querySelector("img");
      return {
        videoCount: unit.querySelectorAll("video").length,
        hasVideoAttr: unit.getAttribute("data-has-video"),
        imgNaturalWidth: img?.naturalWidth ?? 0,
        imgComplete: img?.complete ?? false,
        downloadVideoCount: unit.querySelectorAll('[data-role="wallpaper-download-video"]').length,
      };
    }, WALL_CARD_D1);
    await writeArtifact("场景14.P1", JSON.stringify({ wall404Responses, afterError }));
    expect(afterError?.videoCount, "降级后卡内不得残留 video 元素").toBe(0);
    expect(afterError?.hasVideoAttr, "data-has-video 必须移除").toBeNull();
    expect(
      afterError?.imgNaturalWidth,
      "静态重渲后壁纸图必须已解码（naturalWidth > 0）",
    ).toBeGreaterThan(0);
    expect(afterError?.imgComplete).toBe(true);

    // P2：主钮降级为静态保存（role == wallpaper-download-portrait ∧ 可达名含连续「保存壁纸」）
    const primary = await page.evaluate((sel: string) => {
      const b = document.querySelector(`${sel} [data-role="wallpaper-download-portrait"]`);
      return b
        ? {
            role: b.getAttribute("data-role"),
            axName: (b.getAttribute("aria-label") ?? b.textContent ?? "").trim(),
          }
        : null;
    }, WALL_CARD_D1);
    await writeArtifact("场景14.P2", JSON.stringify(primary));
    expect(primary, "降级后必须存在静态主钮").not.toBeNull();
    expect(primary?.role, "降级后主钮 role 必须为 wallpaper-download-portrait").toBe(
      "wallpaper-download-portrait",
    );
    expect(primary?.axName ?? "", "降级后主钮可达名必须含连续「保存壁纸」").toContain("保存壁纸");

    // P3：零 mp4 入口 ∧ 菜单仅剩电脑版
    expect(afterError?.downloadVideoCount, "降级后 wallpaper-download-video 计数必须为 0").toBe(0);
    await openMoreMenu(page, WALL_CARD_D1);
    const items = await readPopoverItems(page, WALL_CARD_D1);
    const names = (items ?? []).map((i) => i.name);
    await writeArtifact("场景14.P3", JSON.stringify({ names }));
    expect(names.length, `降级后菜单项必须仅剩[电脑版]，实际=${JSON.stringify(names)}`).toBe(1);
    expect(names[0] ?? "", "降级后唯一菜单项必须为电脑版").toContain("电脑版");
  });
});

// ============================================================================
// 场景 15：流顶日无壁纸素材回落（变体 B：首单元 = rank1 照片）
// ============================================================================

describe("[场景15] 变体 B：今日无壁纸素材流顶回落", () => {
  it("[场景15.P1][场景15.P2] 流首单元 == photo[data-photo-rank='1'] ∧ 今日日段 wallpaperCount == 0", async ({
    page,
  }) => {
    await page.goto(`${BASE_FALLBACK}/#/`);
    await page.waitForSelector("[data-stream-unit]", { timeout: 12000 });
    await page.waitForSelector('[data-stream-unit][data-day-index="0"][data-photo-rank="3"]', {
      timeout: 12000,
    });

    const first = await page.evaluate(() => {
      const el = document.querySelector("[data-stream-unit]");
      if (!el) return null;
      return {
        unitType: el.getAttribute("data-unit-type"),
        photoRank: el.getAttribute("data-photo-rank"),
        photoId: el.getAttribute("data-photo-id"),
        dayIndex: el.getAttribute("data-day-index"),
      };
    });
    const day0 = await readDayUnits(page, 0);

    await writeArtifact("场景15.P1", JSON.stringify({ first }));
    expect(first?.unitType, "流首单元类型必须为 photo").toBe("photo");
    expect(first?.photoRank, "流首单元必须为 rank=1 照片").toBe("1");
    expect(first?.photoId, "流首照片必须为 manifest 今日 rank=1 的 photoId").toBe(
      manifestFallback.days[0]!.photos.find((p) => p.rank === 1)?.photoId,
    );

    const wallpaperCount = day0.map((u) => u.type).filter((t) => t === "wallpaper").length;
    await writeArtifact(
      "场景15.P2",
      JSON.stringify({ wallpaperCount, day0: day0.map((u) => u.type) }),
    );
    expect(wallpaperCount, "今日日段 wallpaper 单元计数必须为 0").toBe(0);
  });
});

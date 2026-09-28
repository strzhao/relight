/**
 * 验收测试（红队）：单腿原生壁纸视频 — 转码 invariant（真实小样本 ffmpeg/ffprobe）
 *
 * 设计文档（state.md §设计文档 D2 / §验收场景）对应谓词：
 *   - 场景 3.P1 [real-process→转码级代码化]：兼容窗口内转码段产出
 *     width==1920 && height==1080 && format contains mov
 *     （输入 = 原生画布 1312×864（3:2，ratio≈1.5185 ∈ [1.5,1.9]）；真实 ffprobe 断言）
 *   - 场景 3.P2 [det-machine]：转码 filter 链无造成非等比形变——「绝不拉伸」。
 *     driver 设计文档为 fs-grep 转码命令日志；本文件以更强的像素级黑盒断言代码化：
 *     源图中心放正方形标记 → 转码产物首帧中标记必须仍为正方形（若实现跳过 crop 前置、
 *     直接把 1312×864 拉伸到 1920×1080，正方形会变 439×375 长方形 → 红）。
 *     crop 前置 + scale=1920:1080 等比后置时正方形保持（缩放统一 ×1.4634）。
 *   - 场景 3.P4 [det-machine]：裁切面积占比 ≤ 0.15（T_crop=0.15，防大幅裁切伪装微裁）。
 *     行灰度梯度源：产物首帧中心列像素值反演存活的源行带 → cropFrac = 1 - 带高/864。
 *     3:2（1312×864）最小 16:9 居中裁切 = 1312×738 → cropFrac = 14.58% ≤ 15%；
 *     并断言居中（D2「ffmpeg 居中裁到 16:9」）：带顶 ≈ 63±10、带底距底 ≈ 63±10。
 *   - 转码A 对照（D2：沿用 transcodeForGallery 无 -vf 尺寸透传 → probe 断言 w×h == 画布）：
 *     1312×864 输入 → 产物 1312×864 + mp4/h264/aac 立体声/+faststart（v2 invariant 沿承）。
 *     // CONTRACT_AMBIGUOUS: transcodeForGallery 的「probe 断言 == 画布」预期值来源
 *     //（签名是否新增画布参数）契约未逐字固定——本文件按既有参数面 (src, dst) 两参调用，
 *     // 画布尺寸输入下产物 invariant 必须成立；护栏注入面（错尺寸拒绝）落 job 级验收文件。
 *
 * 惯例沿 wallpaper-video-transcode.acceptance.test.ts：真实 ffmpeg/ffprobe（缺失即真红，
 * 项目硬依赖）+ mock config/db 仅保证模块 import 安全。
 * 红队铁律：transcodeForGallery / transcodeForAerialNative 按契约函数名黑盒 import 执行；不 skip。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// hoisted holder + mock（config 全量 stub / db 真实 drizzle——仅保证模块 import 安全）
// ============================================================================

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  storageRoot: "/tmp/relight-none",
}));

const TEST_COS = vi.hoisted(() => ({
  bucket: "little-bee-assets-1324334992",
  region: "ap-shanghai",
  prefix: "relight",
}));

vi.mock("../lib/config", () => ({
  config: {
    get databasePath() {
      return process.env.DATABASE_PATH ?? holder.dbPath;
    },
    get storageRoot() {
      return holder.storageRoot;
    },
    wallpaperVideoEnabled: true,
    wallpaperVideoSeconds: 4,
    wallpaperVideoLoopSeconds: 8,
    wallpaperVideoSpawnTimeoutMs: 5400000,
    honeydoCliPath: "/usr/bin/false",
    wallpaperVideoPrompt:
      "画面中的景物以极缓慢的速度轻微摇曳，光影柔和流动，随后一切缓缓回到初始位置，如呼吸般自然",
    videoWorkspacePath: "/tmp/relight-none/video-workspace",
    repoRoot: "/tmp/relight-none",
    port: 3000,
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-wvnt-test",
    dailySelectionConcurrency: 1,
    dailyAutoHealDays: 0,
    dailySelectEnabled: false,
    ai: { baseUrl: "", apiKey: "", visionModel: "", model: "", promptVersion: "v2" },
    video: { enabled: true, frameCount: 6, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" },
    daily: { cronTime: "0 0 * * *", maxCandidates: 20, timezone: "Asia/Shanghai" },
    cos: {
      secretId: "test-id",
      secretKey: "test-key",
      bucket: TEST_COS.bucket,
      region: TEST_COS.region,
      prefix: TEST_COS.prefix,
    },
    galleryPublicUrl: "https://gallery.stringzhao.life",
    gallery: { vpsHost: "127.0.0.1", vpsUser: "test", vpsKey: "/tmp/test-key", vpsPath: "/tmp/g" },
  },
}));

vi.mock("../db", async () => {
  const actualSchema = await import("../db/schema");
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const sqlite = new Database(holder.dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { db: drizzle(sqlite, { schema: actualSchema }), schema: actualSchema };
});

// ============================================================================
// ffprobe / 像素提取辅助
// ============================================================================

interface ProbeResult {
  formatName: string;
  videoCodec: string | null;
  codecTag: string | null;
  width: number | null;
  height: number | null;
  audioStreams: number;
  audioCodec: string | null;
  audioChannels: number | null;
}

function probe(file: string): ProbeResult {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { encoding: "utf-8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`ffprobe 失败（${file}）: ${r.stderr}`);
  }
  const j = JSON.parse(r.stdout) as {
    format?: { format_name?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      codec_tag_string?: string;
      width?: number;
      height?: number;
      channels?: number;
    }>;
  };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const audios = streams.filter((s) => s.codec_type === "audio");
  return {
    formatName: j.format?.format_name ?? "",
    videoCodec: v?.codec_name ?? null,
    codecTag: v?.codec_tag_string ?? null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    audioStreams: audios.length,
    audioCodec: audios[0]?.codec_name ?? null,
    audioChannels: audios[0]?.channels ?? null,
  };
}

function moovBeforeMdat(file: string): boolean {
  const buf = fs.readFileSync(file);
  const moov = buf.indexOf("moov");
  const mdat = buf.indexOf("mdat");
  return moov >= 0 && mdat >= 0 && moov < mdat;
}

/** 提取首帧 rgb24 原始像素（W×H×3） */
function firstFrameRaw(file: string, width: number, height: number): Buffer {
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < width * height * 3) {
    throw new Error(`首帧提取失败（${file}）: ${r.stderr?.toString().slice(0, 500)}`);
  }
  return Buffer.from(r.stdout);
}

function pixelAt(
  buf: Buffer,
  width: number,
  x: number,
  y: number,
): { r: number; g: number; b: number } {
  const idx = (y * width + x) * 3;
  return { r: buf[idx] as number, g: buf[idx + 1] as number, b: buf[idx + 2] as number };
}

// ============================================================================
// fixture 生成
// ============================================================================

let tmpRoot = "";
let canvasMaster = ""; // 1312×864 带立体声音轨（原生画布母版形态）
let markerSrc = ""; // 1312×864 中心 300×300 红方块（形变检测）
let gradientSrc = ""; // 1312×864 行灰度梯度（裁切率检测）
let transcodeForGallery: (src: string, dst: string) => Promise<void>;
let transcodeForAerialNative: (src: string, dst: string) => Promise<void>;

function makeSrcWithStereoAudio(outPath: string, size: string): void {
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${size}:rate=24:duration=2`,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
      "-shortest",
      outPath,
    ],
    { encoding: "utf-8", timeout: 60000 },
  );
  if (r.status !== 0 || !fs.existsSync(outPath)) {
    throw new Error(`fixture ffmpeg 造样片失败（${size}）: ${r.stderr}`);
  }
}

/** 行灰度梯度 png：第 y 行灰度 = round(y*255/(H-1))（裁切率反演用） */
async function makeRowGradientPng(outPath: string, width: number, height: number): Promise<void> {
  const sharp = (await import("sharp")).default;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const g = Math.round((y * 255) / (height - 1));
    rows.push(Buffer.alloc(width * 3, g));
  }
  await sharp(Buffer.concat(rows), { raw: { width, height, channels: 3 } })
    .png()
    .toFile(outPath);
}

beforeAll(async () => {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    const p = spawnSync(bin, ["-version"], { encoding: "utf-8", timeout: 15000 });
    if (p.status !== 0) {
      throw new Error(`${bin} 不可用——转码验收要求真实环境`);
    }
  }

  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvntr-"));
  const dbPath = path.join(tmpRoot, "test.db");
  holder.dbPath = dbPath;
  holder.storageRoot = path.join(tmpRoot, "storage");
  process.env.DATABASE_PATH = dbPath;
  process.env.STORAGE_ROOT = holder.storageRoot;

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite.close();

  // 原生画布母版：1312×864（3:2 hero → computeNativeCanvas D1 参考输出）带立体声音轨
  canvasMaster = path.join(tmpRoot, "canvas-1312x864.mp4");
  makeSrcWithStereoAudio(canvasMaster, "1312x864");

  // 形变检测源：1312×864 蓝底 + 中心 300×300 红方块
  markerSrc = path.join(tmpRoot, "marker-1312x864.png");
  {
    const sharp = (await import("sharp")).default;
    const square = await sharp({
      create: { width: 300, height: 300, channels: 3, background: "#cc2222" },
    })
      .png()
      .toBuffer();
    await sharp({
      create: { width: 1312, height: 864, channels: 3, background: "#2288cc" },
    })
      .composite([
        { input: square, left: Math.round((1312 - 300) / 2), top: Math.round((864 - 300) / 2) },
      ])
      .png()
      .toFile(markerSrc);
  }

  // 裁切率检测源：1312×864 行灰度梯度
  gradientSrc = path.join(tmpRoot, "gradient-1312x864.png");
  await makeRowGradientPng(gradientSrc, 1312, 864);

  const mod = (await import("../lib/wallpaper/video")) as unknown as Record<string, unknown>;
  expect(
    typeof mod.transcodeForGallery,
    "契约函数 transcodeForGallery 未由 lib/wallpaper/video 导出",
  ).toBe("function");
  expect(
    typeof mod.transcodeForAerialNative,
    "契约函数 transcodeForAerialNative 未由 lib/wallpaper/video 导出",
  ).toBe("function");
  transcodeForGallery = mod.transcodeForGallery as typeof transcodeForGallery;
  transcodeForAerialNative = mod.transcodeForAerialNative as typeof transcodeForAerialNative;
}, 60000);

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// 场景 3.P1：兼容窗口画布输入 → Aerial 转码段产出 1920×1080 mov
// ============================================================================

describe("场景 3.P1：1312×864（3:2 原生画布，窗口内）→ transcodeForAerialNative 产出 1920×1080 mov", () => {
  it("产物 width==1920 && height==1080 && format contains mov ∧ hvc1 ∧ 音轨保留 ∧ faststart", async () => {
    const dst = path.join(tmpRoot, "2026-09-20_landscape.mov");
    // 音轨保留语义 = pass-through：输入必须自带音轨（生产输入 mmh3turbo 产物自带音轨）
    await transcodeForAerialNative(canvasMaster, dst);

    expect(fs.existsSync(dst), `Aerial 转码产物不存在: ${dst}`).toBe(true);
    expect(fs.statSync(dst).size).toBeGreaterThan(0);

    const p = probe(dst);
    // 谓词字面量：width==1920 && height==1080 && format contains mov
    expect(p.width, `宽度必须 1920，实际 ${p.width}`).toBe(1920);
    expect(p.height, `高度必须 1080，实际 ${p.height}`).toBe(1080);
    expect(p.formatName, `容器必须 mov，实际 ${p.formatName}`).toContain("mov");
    expect(p.codecTag, `tag 必须 hvc1，实际 ${p.codecTag}`).toBe("hvc1");
    expect(p.audioStreams, "必须保留音轨").toBe(1);
    expect(p.audioCodec).toBe("aac");
    expect(moovBeforeMdat(dst), "mov 必须 +faststart（moov 在 mdat 之前）").toBe(true);
  }, 600000);
});

// ============================================================================
// 场景 3.P2：绝不拉伸（像素级正方形标记不变形）
// ============================================================================

describe("场景 3.P2：转码 filter 链无非等比形变（1312×864 → 1920×1080 正方形标记保持）", () => {
  it("中心红方块转码后 bounding box 接近正方形（直接拉伸突变体会呈 439×375 → 红）", async () => {
    const dst = path.join(tmpRoot, "distortion-check.mov");
    await transcodeForAerialNative(markerSrc, dst);

    const W = 1920;
    const H = 1080;
    const raw = firstFrameRaw(dst, W, H);

    // 红像素 bounding box（阈值放宽容忍 h264 色度压缩）
    let minX = W;
    let minY = H;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = pixelAt(raw, W, x, y);
        if (p.r > 150 && p.g < 90 && p.b < 90) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    expect(maxX, "产物首帧必须能找到红色标记（标记丢失=裁切错位）").toBeGreaterThanOrEqual(0);
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;

    // 统一缩放（crop 前置 + 等比 scale）：300×300 → ≈439×439；
    // 跳过 crop 直接拉伸：→ 439×375（宽高差 ≈15%）。容差 6% 分离两种实现。
    const maxSide = Math.max(bw, bh);
    const asym = Math.abs(bw - bh) / maxSide;
    expect(
      asym,
      `标记必须保持正方形（绝不拉伸）：bounding box ${bw}x${bh}，不对称率 ${(asym * 100).toFixed(1)}% 超容差 6%`,
    ).toBeLessThanOrEqual(0.06);
    // 标记确实被等比放大（≈×1.4634 → 439 上下），排除「原样 copy 无转码」假阳性
    expect(bw).toBeGreaterThan(380);
    expect(bh).toBeGreaterThan(380);
  }, 600000);
});

// ============================================================================
// 场景 3.P4：裁切面积占比 ≤ 0.15 且居中（行灰度梯度反演）
// ============================================================================

describe("场景 3.P4：3:2 → 16:9 裁切面积占比 ≤ 0.15 且为居中裁切", () => {
  it("梯度源反演存活行带：cropFrac ≤ 0.15、带顶 ≈63±6、带底距底 ≈63±6", async () => {
    const dst = path.join(tmpRoot, "crop-ratio-check.mov");
    await transcodeForAerialNative(gradientSrc, dst);

    const W = 1920;
    const H = 1080;
    const raw = firstFrameRaw(dst, W, H);
    const SRC_H = 864;
    const x = Math.floor(W / 2);

    // 中心列每行灰度 → 反演源行号（梯度 y → gray=round(y*255/863)；反演 y=gray*863/255）
    const mappedRows: number[] = [];
    for (let y = 0; y < H; y++) {
      const g = pixelAt(raw, W, x, y).g;
      mappedRows.push(Math.round((g * (SRC_H - 1)) / 255));
    }
    // 最小 16:9 居中裁切保留源行 [63, 800]（738 行）。h264 边缘模糊容差 ±3。
    const yTop = Math.min(...mappedRows);
    const yBottom = Math.max(...mappedRows);
    const bandRows = yBottom - yTop + 1;
    const cropFrac = 1 - bandRows / SRC_H;

    expect(
      cropFrac,
      `裁切面积占比 ${(cropFrac * 100).toFixed(2)}% 必须 ≤ 15%（存活源行带 ${yTop}..${yBottom}，${bandRows}/${SRC_H} 行）`,
    ).toBeLessThanOrEqual(0.15);

    // D2「居中裁到 16:9」：带顶 ≈ (864-738)/2 = 63，带底距底 ≈ 63
    // 容差 ±10：min/max 反演受压缩噪声偏差 ~±7 行，防假红
    expect(yTop, `裁切带顶部应 ≈63（居中），实际 ${yTop}`).toBeGreaterThanOrEqual(53);
    expect(yTop).toBeLessThanOrEqual(73);
    expect(
      SRC_H - 1 - yBottom,
      `裁切带底部距底应 ≈63（居中），实际 ${SRC_H - 1 - yBottom}`,
    ).toBeGreaterThanOrEqual(53);
    expect(SRC_H - 1 - yBottom).toBeLessThanOrEqual(73);
  }, 600000);
});

// ============================================================================
// 转码A（画廊原生腿）：无 -vf 尺寸透传 → 画布尺寸 invariant + v2 容器/编码 invariant
// ============================================================================

describe("转码A：transcodeForGallery 1312×864 原生画布输入 → 产物 == 画布尺寸（probe 断言 == 画布的放行面）", () => {
  it("产物 1312×864 ∧ mp4 ∧ h264 ∧ aac 立体声 ∧ faststart（场景 5.P3 native 腿放行面的真实产物形态）", async () => {
    const dst = path.join(tmpRoot, "2026-09-20_native.mp4");
    await transcodeForGallery(canvasMaster, dst);

    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.statSync(dst).size).toBeGreaterThan(0);

    const p = probe(dst);
    // 画布尺寸透传 invariant（无 -vf 尺寸操作）：产物 == 源 == 画布
    expect(p.width, `宽度必须 1312（画布透传），实际 ${p.width}`).toBe(1312);
    expect(p.height, `高度必须 864（画布透传），实际 ${p.height}`).toBe(864);
    expect(p.formatName).toContain("mp4");
    expect(p.videoCodec).toBe("h264");
    expect(p.audioStreams).toBe(1);
    expect(p.audioCodec).toBe("aac");
    expect(p.audioChannels).toBe(2);
    expect(moovBeforeMdat(dst), "mp4 必须 +faststart").toBe(true);
  }, 120000);
});

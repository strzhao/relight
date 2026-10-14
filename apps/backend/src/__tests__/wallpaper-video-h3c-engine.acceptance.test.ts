/**
 * 验收测试（红队）：wallpaper-video h3c 引擎派发（20261014 h3.c 接入；mock spawn 面，无 GPU）
 *
 * 锁定契约：
 *   - 引擎派发：config.wallpaperVideoEngine === "h3c" → 全程恰 1 次 spawnH3cVideo、
 *     spawnHoneydoVideo 零调用（kill 双引擎并发 No-op）
 *   - 画布预算引擎感知：h3c 引擎画布 = computeNativeCanvas(dims, {maxPixels: 768×1344})——
 *     1:1 hero → 992×992（默认预算会出 1056² 超引擎上限，必须被钳）；32 倍数 + 像素积 ≤
 *     1,032,192（引擎硬校验超限报错退出，调用方必须先钳）
 *   - argv 档位：spawnH3cVideo opts 携带 config.h3c 的 A/B 验证档（steps 20/layers 45/
 *     reuse 2/seed 42/ssdStreaming true）
 *   - 下游引擎无关：双卡渲染 ×2 + 三转码 + 三件套上传 + DB 三列非空（与 honeydo 完全同构）
 *
 * 测试策略（同 wallpaper-video-native-job.acceptance.test.ts 惯例）：真实 SQLite + 真实
 * ffmpeg/ffprobe（尺寸护栏真跑）+ mock lib/wallpaper/video 的 spawn/overlay/转码面。
 * 前置校验 assertVideoSpawnPrerequisites 真跑（config.h3c.binPath/modelDir 指向本机存在路径），
 * 无 capability gate——不依赖本机 honeydo/h3.c 安装。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// hoisted holder + mocks
// ============================================================================

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  storageRoot: "/tmp/relight-none",
  videoWorkspacePath: "/tmp/relight-none/video-workspace",
  enabled: true,
  seconds: 4,
  loopSeconds: 8,
  honeydoPath: "/usr/bin/false",
  h3cBinPath: "/bin/sh",
  h3cModelDir: "/tmp/relight-none",
  h3cSteps: 20,
  h3cLayers: 45,
  h3cReuse: 2,
  h3cSeed: 42,
  h3cSsdStreaming: true,
  motionMinPeak: 2.0,
  motionMaxAttempts: 2,
  /** measureVideoMotion mock 的 peak 序列（按调用次序弹出； Infinity=throw fail-open） */
  motionPeaks: [] as number[],
  firstFramePath: "/tmp/relight-none/first.png",
  /** spawn mock 产物登记表：`${width}x${height}` → 源 mp4 路径 */
  productByCanvas: new Map<string, string>(),
  loopPath: "/tmp/relight-none/loop-master.mp4",
  landscapeCardPath: "/tmp/relight-none/card-1920x1080.mp4",
  portraitCardPath: "/tmp/relight-none/card-1290x2796.mp4",
  aerialOkPath: "/tmp/relight-none/ok-1920x1080.mp4",
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
    get wallpaperVideoEnabled() {
      return holder.enabled;
    },
    get wallpaperVideoSeconds() {
      return holder.seconds;
    },
    get wallpaperVideoLoopSeconds() {
      return holder.loopSeconds;
    },
    get wallpaperVideoMotionMinPeak() {
      return holder.motionMinPeak;
    },
    get wallpaperVideoMotionMaxAttempts() {
      return holder.motionMaxAttempts;
    },
    wallpaperVideoSpawnTimeoutMs: 5400000,
    // 引擎固定 h3c（本套件的被测对象）
    wallpaperVideoEngine: "h3c",
    get h3c() {
      return {
        binPath: holder.h3cBinPath,
        modelDir: holder.h3cModelDir,
        steps: holder.h3cSteps,
        layers: holder.h3cLayers,
        reuse: holder.h3cReuse,
        seed: holder.h3cSeed,
        ssdStreaming: holder.h3cSsdStreaming,
        lastFrameAnchor: true,
        motionPromptBoost: true,
      };
    },
    wallpaperVideoPromptPerson:
      "人物转头看向镜头，笑容绽开。Audio: warm indoor ambience, no talking",
    wallpaperVideoPromptScene: "镜头明显推近，云层快速流动。Audio: natural ambience, no talking",
    get videoWorkspacePath() {
      return holder.videoWorkspacePath;
    },
    get honeydoCliPath() {
      return holder.honeydoPath;
    },
    repoRoot: "/tmp/relight-none",
    port: 3000,
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-wvh3c-test",
    dailySelectionConcurrency: 1,
    dailyAutoHealDays: 0,
    dailySelectEnabled: false,
    ai: {
      baseUrl: "",
      apiKey: "",
      visionModel: "",
      model: "",
      promptVersion: "v2",
      motion: { enabled: false, baseUrl: "", apiKey: "", model: "" },
    },
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

const mockUploadFile = vi.hoisted(() => vi.fn());

vi.mock("../lib/cos/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cos/upload")>();
  return { ...actual, uploadFile: mockUploadFile };
});

const mockSyncDayToGallery = vi.hoisted(() => vi.fn(async (_pickDate: string) => {}));

vi.mock("../lib/gallery/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/gallery/sync")>();
  return { ...actual, syncDayToGallery: mockSyncDayToGallery };
});

const mockPreprocessHeroFrame = vi.hoisted(() => vi.fn());
const mockSpawnHoneydoVideo = vi.hoisted(() => vi.fn());
const mockSpawnH3cVideo = vi.hoisted(() => vi.fn());
const mockBuildLoop = vi.hoisted(() => vi.fn());
const mockRenderTextOverlay = vi.hoisted(() => vi.fn());
const mockTranscodeForAerial = vi.hoisted(() => vi.fn());
const mockTranscodeForGallery = vi.hoisted(() => vi.fn());
const mockMeasureVideoMotion = vi.hoisted(() => vi.fn());

vi.mock("../lib/wallpaper/video", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallpaper/video")>();
  return {
    ...actual,
    preprocessHeroFrame: mockPreprocessHeroFrame,
    spawnHoneydoVideo: mockSpawnHoneydoVideo,
    spawnH3cVideo: mockSpawnH3cVideo,
    buildLoop: mockBuildLoop,
    renderTextOverlay: mockRenderTextOverlay,
    transcodeForAerialNative: mockTranscodeForAerial,
    transcodeForGallery: mockTranscodeForGallery,
    measureVideoMotion: mockMeasureVideoMotion,
  };
});

vi.mock("../jobs/queues", () => ({
  scanQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  analyzeQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  dailyQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  dailyPushQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  dailyVideoQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  wallpaperVideoQueue: { add: vi.fn(async () => ({ id: "mock" })) },
}));

// ============================================================================
// 契约字面量
// ============================================================================

const PREFIX = TEST_COS.prefix;
function nativeKey(pickDate: string): string {
  return `${PREFIX}/wallpaper-videos/${pickDate}_native.mp4`;
}
function landscapeKey(pickDate: string): string {
  return `${PREFIX}/wallpaper-videos/${pickDate}_landscape.mov`;
}
function portraitKey(pickDate: string): string {
  return `${PREFIX}/wallpaper-videos/${pickDate}_portrait.mp4`;
}
function receiptFor(cosKey: string): string {
  return `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${cosKey}`;
}

/** 1:1 hero（h3c 预算画布 992×992） */
const PICK_SQUARE = "2026-10-14";

// ============================================================================
// fixture
// ============================================================================

let tmpRoot = "";
let sqlite: Database.Database;

function ensureWallpaperVideoColumns(db: Database.Database): void {
  const cols = (db.prepare("PRAGMA table_info(daily_picks)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes("wallpaper_video_landscape_url")) {
    db.exec("ALTER TABLE daily_picks ADD COLUMN wallpaper_video_landscape_url TEXT");
  }
  if (!cols.includes("wallpaper_video_portrait_url")) {
    db.exec("ALTER TABLE daily_picks ADD COLUMN wallpaper_video_portrait_url TEXT");
  }
  if (!cols.includes("wallpaper_video_native_url")) {
    db.exec("ALTER TABLE daily_picks ADD COLUMN wallpaper_video_native_url TEXT");
  }
}

async function makeHeroJpeg(outPath: string, width: number, height: number): Promise<void> {
  await sharp({ create: { width, height, channels: 3, background: "#2288cc" } })
    .jpeg()
    .toFile(outPath);
}

/** 1 秒真实 H.264 mp4（spawn mock 产物 / 护栏校验对象） */
function makeTinyMp4(outPath: string, size: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${size}:rate=12:duration=1`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      outPath,
    ],
    { encoding: "utf-8", timeout: 30000 },
  );
  if (r.status !== 0 || !fs.existsSync(outPath)) {
    throw new Error(`fixture ffmpeg 造样片失败（${size}）: ${r.stderr}`);
  }
}

function wireMocks(): void {
  mockPreprocessHeroFrame.mockReset();
  mockSpawnHoneydoVideo.mockReset();
  mockSpawnH3cVideo.mockReset();
  mockBuildLoop.mockReset();
  mockRenderTextOverlay.mockReset();
  mockTranscodeForAerial.mockReset();
  mockTranscodeForGallery.mockReset();
  mockUploadFile.mockReset();
  mockSyncDayToGallery.mockReset();
  mockMeasureVideoMotion.mockReset();

  mockMeasureVideoMotion.mockImplementation(async (filePath: string) => {
    const peak = holder.motionPeaks.shift();
    if (peak === undefined || !Number.isFinite(peak)) {
      throw new Error(`measureVideoMotion mock: 测量失败（${filePath}）`);
    }
    return { peak, fdiffAvg: peak / 10, frames: 107 };
  });

  mockPreprocessHeroFrame.mockImplementation(async () => holder.firstFramePath);
  // h3c spawn mock：按请求画布落真实 mp4 产物（产物在 outPath），opts 原样回显供断言
  mockSpawnH3cVideo.mockImplementation(
    async (opts: { outPath?: string; width?: number; height?: number }) => {
      const out = opts?.outPath ?? "/tmp/relight-none/out.mp4";
      const src = holder.productByCanvas.get(`${opts?.width}x${opts?.height}`);
      if (!src) {
        throw new Error(
          `spawnH3cVideo mock 未登记画布 ${opts?.width}x${opts?.height}——job 未按 h3c 预算画布请求`,
        );
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(src, out);
      return { outPath: out, stdout: "h3.c mock done" };
    },
  );
  mockSpawnHoneydoVideo.mockImplementation(async () => {
    throw new Error("honeydo 引擎在 h3c 模式下不应被调用");
  });
  mockBuildLoop.mockImplementation(async (src: string, _targetSeconds: number) => {
    fs.mkdirSync(path.dirname(holder.loopPath), { recursive: true });
    fs.copyFileSync(src, holder.loopPath);
    return { loopPath: holder.loopPath, segments: 2 };
  });
  mockRenderTextOverlay.mockImplementation(
    async (_videoPath: string, _meta: unknown, variant: string) => {
      const fixture = variant === "landscape" ? holder.landscapeCardPath : holder.portraitCardPath;
      const out = path.join(path.dirname(fixture), `overlay-out-${variant}.mp4`);
      fs.copyFileSync(fixture, out);
      return { overlaidPath: out };
    },
  );
  mockTranscodeForGallery.mockImplementation((src: string, dst: string) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  });
  mockTranscodeForAerial.mockImplementation((_src: string, dst: string) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(holder.aerialOkPath, dst);
  });
  mockUploadFile.mockImplementation(async (_localPath: string, cosKey: string) =>
    receiptFor(cosKey),
  );
  mockSyncDayToGallery.mockImplementation(async () => {});
}

// ============================================================================
// beforeAll / beforeEach / afterAll
// ============================================================================

let runWallpaperVideo: (pickDate: string) => Promise<unknown>;

beforeAll(async () => {
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8", timeout: 10000 });
  if (ff.status !== 0) {
    throw new Error("ffmpeg 不可用——本验收要求真实 ffmpeg 环境");
  }

  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvh3c-"));
  const dbPath = path.join(tmpRoot, "test.db");
  const storageRoot = path.join(tmpRoot, "storage");
  fs.mkdirSync(storageRoot, { recursive: true });

  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  ensureWallpaperVideoColumns(sqlite);

  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES ('src-wvh3c', '测试存储源', 'local', ?, 1)`,
    )
    .run(storageRoot);

  const heroSquare = path.join(tmpRoot, "hero-square.jpg");
  await makeHeroJpeg(heroSquare, 2000, 2000); // 1:1 → h3c 预算 992×992
  sqlite
    .prepare(
      `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, created_at)
       VALUES ('photo-h3c-square', 'src-wvh3c', ?, ?, 2000, 2000, 1024, '2026-01-01T00:00:00.000Z')`,
    )
    .run(heroSquare, "hash-h3c-square");
  sqlite
    .prepare(
      `INSERT INTO daily_picks
         (id, photo_id, pick_date, title, narrative, score, composed_image_path, members, created_at,
          wallpaper_video_landscape_url, wallpaper_video_portrait_url, wallpaper_video_native_url)
       VALUES (?, ?, ?, '金色黄昏', '五年前的今天，你在海边捕捉到了这张温暖的照片。', 8.5,
               ?, '[]', '2026-09-12T06:00:00.000Z', NULL, NULL, NULL)`,
    )
    .run(
      `pick-${PICK_SQUARE}`,
      "photo-h3c-square",
      PICK_SQUARE,
      `daily-composed/${PICK_SQUARE}.jpg`,
    );

  holder.dbPath = dbPath;
  holder.storageRoot = storageRoot;
  holder.h3cModelDir = tmpRoot; // assertVideoSpawnPrerequisites access 校验用（必存）
  process.env.DATABASE_PATH = dbPath;
  process.env.STORAGE_ROOT = storageRoot;

  // fixture 媒体
  holder.firstFramePath = path.join(tmpRoot, "first-frame.png");
  fs.writeFileSync(
    holder.firstFramePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  // h3c 预算画布产物（1:1 hero → 992×992）
  const squareProduct = path.join(tmpRoot, "product-992x992.mp4");
  makeTinyMp4(squareProduct, "992x992");
  holder.productByCanvas.set("992x992", squareProduct);
  // 护栏对照样本 + 双卡排版档产物
  holder.aerialOkPath = path.join(tmpRoot, "ok-1920x1080.mp4");
  makeTinyMp4(holder.aerialOkPath, "1920x1080");
  holder.loopPath = path.join(tmpRoot, "loop-master.mp4");
  holder.landscapeCardPath = path.join(tmpRoot, "card-1920x1080.mp4");
  holder.portraitCardPath = path.join(tmpRoot, "card-1290x2796.mp4");
  makeTinyMp4(holder.landscapeCardPath, "1920x1080");
  makeTinyMp4(holder.portraitCardPath, "1290x2796");
  holder.videoWorkspacePath = path.join(tmpRoot, "video-workspace");

  // Remotion 运行时脚手架（assertVideoSpawnPrerequisites fs access 校验；渲染被 mock）
  const ws = holder.videoWorkspacePath;
  for (const rel of [
    path.join("wallpaper-overlay", "package.json"),
    path.join("wallpaper-overlay", "src", "index.ts"),
    path.join("wallpaper-overlay", "public", "fonts", "NotoSerifSC-Regular.otf"),
    path.join("wallpaper-overlay", "public", "fonts", "NotoSerifSC-Bold.otf"),
    path.join("wallpaper-overlay", "public", "fonts", "Fraunces-Regular.otf"),
    path.join("wallpaper-overlay", "public", "fonts", "Fraunces-Bold.otf"),
    path.join(
      "node_modules",
      ".remotion",
      "chrome-headless-shell",
      "mac-arm64",
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell",
    ),
  ]) {
    const p = path.join(ws, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "// mock workspace scaffold\n");
  }
  const binDir = path.join(ws, "node_modules", ".bin");
  const remotionBin = path.join(binDir, "remotion");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(remotionBin, "#!/bin/sh\n");
  fs.chmodSync(remotionBin, 0o755);

  wireMocks();

  const mod = (await import("../jobs/wallpaper-video")) as {
    runWallpaperVideo: (pickDate: string) => Promise<unknown>;
  };
  runWallpaperVideo = mod.runWallpaperVideo;
}, 60000);

beforeEach(() => {
  holder.enabled = true;
  holder.seconds = 4;
  holder.loopSeconds = 8;
  holder.motionMinPeak = 2.0;
  holder.motionMaxAttempts = 2;
  holder.motionPeaks = [10]; // 默认首发即达标（既有用例的常态路径）
  wireMocks();
});

afterAll(() => {
  try {
    sqlite?.close();
  } catch {
    // ignore
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// 用例
// ============================================================================

describe("wallpaper-video h3c 引擎派发（1:1 hero）", () => {
  it("恰 1 次 spawnH3cVideo、spawnHoneydoVideo 零调用（双引擎互斥）", async () => {
    await runWallpaperVideo(PICK_SQUARE);
    expect(mockSpawnH3cVideo).toHaveBeenCalledTimes(1);
    expect(mockSpawnHoneydoVideo).not.toHaveBeenCalled();
  });

  it("画布 h3c 预算钳制：992×992（默认预算会出 1056² 超引擎上限）+ preprocess 同画布 + opts 携带画布与 A/B 档", async () => {
    const { H3C_CANVAS_PIXEL_BUDGET, computeNativeCanvas } = await import(
      "../lib/wallpaper/native-canvas"
    );
    await runWallpaperVideo(PICK_SQUARE);

    const canvas = computeNativeCanvas(2000, 2000, { maxPixels: H3C_CANVAS_PIXEL_BUDGET });
    expect(canvas).toEqual({ width: 992, height: 992 });
    // 引擎硬约束谓词：32 倍数 + 像素积 ≤ 768×1344
    expect(canvas.width % 32).toBe(0);
    expect(canvas.height % 32).toBe(0);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(768 * 1344);

    // preprocess 按钳后画布调用
    const pp = mockPreprocessHeroFrame.mock.calls[0] as unknown[];
    expect(`${pp[1]}x${pp[2]}`).toBe("992x992");

    // spawn opts：画布两轴 + config.h3c A/B 验证档逐字透传
    const sp = mockSpawnH3cVideo.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sp.width).toBe(992);
    expect(sp.height).toBe(992);
    expect(sp.steps).toBe(20);
    expect(sp.layers).toBe(45);
    expect(sp.reuse).toBe(2);
    expect(sp.seed).toBe(42);
    expect(sp.ssdStreaming).toBe(true);
    expect(sp.seconds).toBe(4);
    expect(sp.binPath).toBe(holder.h3cBinPath);
    expect(sp.modelDir).toBe(holder.h3cModelDir);
    // 20261014 定案：双锚定默认（保身份）+ L1 包覆式动作强化（attempt 1 档）
    expect(sp.lastFrame).toBe(holder.firstFramePath);
    expect(String(sp.prompt)).toContain("动作幅度很大：");
    expect(String(sp.prompt)).toContain("所有人的动作快速而大力");
    // 负面清单护栏（20261014 社区调研）：防幻觉加字/切镜/变形/自加配乐
    expect(String(sp.prompt)).toContain("全程单镜头不切镜");
    expect(String(sp.prompt)).toContain("无背景音乐");
  });

  it("下游引擎无关：双卡渲染 ×2 + 三转码 + 三件套上传 + DB 三列非空 + 画廊同步", async () => {
    await runWallpaperVideo(PICK_SQUARE);

    expect(mockRenderTextOverlay).toHaveBeenCalledTimes(2);
    expect(mockTranscodeForGallery).toHaveBeenCalledTimes(2);
    expect(mockTranscodeForAerial).toHaveBeenCalledTimes(1);

    const keys = mockUploadFile.mock.calls.map((c) => String(c?.[1]));
    expect(keys).toHaveLength(3);
    expect(keys).toContain(nativeKey(PICK_SQUARE));
    expect(keys).toContain(portraitKey(PICK_SQUARE));
    expect(keys).toContain(landscapeKey(PICK_SQUARE));

    const row = sqlite
      .prepare(
        `SELECT wallpaper_video_native_url, wallpaper_video_landscape_url, wallpaper_video_portrait_url
         FROM daily_picks WHERE pick_date = ?`,
      )
      .get(PICK_SQUARE) as {
      wallpaper_video_native_url: string | null;
      wallpaper_video_landscape_url: string | null;
      wallpaper_video_portrait_url: string | null;
    };
    expect(row.wallpaper_video_native_url).toBe(receiptFor(nativeKey(PICK_SQUARE)));
    expect(row.wallpaper_video_portrait_url).toBe(receiptFor(portraitKey(PICK_SQUARE)));
    expect(row.wallpaper_video_landscape_url).toBe(receiptFor(landscapeKey(PICK_SQUARE)));
    expect(mockSyncDayToGallery).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 运动量验收门（20261014）：低峰值换 seed 重试 / 取优发布 / fail-open
// ============================================================================

describe("wallpaper-video 运动量验收门（h3c 换 seed 重试）", () => {
  it("首发低于门槛 → 换 seed 重试（seed 42→43），次发达标发布，尝试产物清理", async () => {
    holder.motionPeaks = [0.5, 6.0];
    await runWallpaperVideo(PICK_SQUARE);

    expect(mockSpawnH3cVideo).toHaveBeenCalledTimes(2);
    const seeds = mockSpawnH3cVideo.mock.calls.map((c) => (c?.[0] as { seed: number }).seed);
    expect(seeds).toEqual([42, 43]);
    // 尝试产物清理：发布成功后 raw/attempt 文件都不残留
    const dir = path.join(holder.storageRoot, "wallpaper-videos");
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes("-native-raw"));
    expect(leftovers, `尝试产物应清理干净，实际残留: ${leftovers.join(",")}`).toEqual([]);
    // 正常发布三件套
    const row = sqlite
      .prepare("SELECT wallpaper_video_native_url FROM daily_picks WHERE pick_date = ?")
      .get(PICK_SQUARE) as { wallpaper_video_native_url: string | null };
    expect(row.wallpaper_video_native_url).toBe(receiptFor(nativeKey(PICK_SQUARE)));
  });

  it("全部尝试低于门槛 → 耗尽次数取优发布（不空转、不失败）", async () => {
    holder.motionPeaks = [1.0, 0.5];
    await runWallpaperVideo(PICK_SQUARE);

    expect(mockSpawnH3cVideo).toHaveBeenCalledTimes(2);
    const seeds = mockSpawnH3cVideo.mock.calls.map((c) => (c?.[0] as { seed: number }).seed);
    expect(seeds).toEqual([42, 43]);
    const dir = path.join(holder.storageRoot, "wallpaper-videos");
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes("-native-raw"));
    expect(leftovers).toEqual([]);
    const row = sqlite
      .prepare("SELECT wallpaper_video_native_url FROM daily_picks WHERE pick_date = ?")
      .get(PICK_SQUARE) as { wallpaper_video_native_url: string | null };
    expect(row.wallpaper_video_native_url).toBe(receiptFor(nativeKey(PICK_SQUARE)));
  });

  it("首发达标 → 恰 1 次 spawn（seed 42），不触发重试", async () => {
    holder.motionPeaks = [5.0];
    await runWallpaperVideo(PICK_SQUARE);
    expect(mockSpawnH3cVideo).toHaveBeenCalledTimes(1);
    expect((mockSpawnH3cVideo.mock.calls[0]?.[0] as { seed: number }).seed).toBe(42);
  });

  it("运动量测量失败 → fail-open 放行（单次尝试、正常发布）", async () => {
    holder.motionPeaks = [Number.POSITIVE_INFINITY];
    await runWallpaperVideo(PICK_SQUARE);
    expect(mockSpawnH3cVideo).toHaveBeenCalledTimes(1);
    const row = sqlite
      .prepare("SELECT wallpaper_video_native_url FROM daily_picks WHERE pick_date = ?")
      .get(PICK_SQUARE) as { wallpaper_video_native_url: string | null };
    expect(row.wallpaper_video_native_url).toBe(receiptFor(nativeKey(PICK_SQUARE)));
  });
});

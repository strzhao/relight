/**
 * 验收测试（红队）：单腿原生壁纸视频 — job 行为契约（mock spawn 面，无 GPU）
 *
 * 设计文档（state.md §设计文档 D2 / §验收场景）对应谓词：
 *   - 场景 1.P2 [det-machine]（job 级代码化）：生成画布跟随原图比例 —— job 以
 *     computeNativeCanvas(hero 原图 dims) 的画布调 preprocessHeroFrame，并把 W/H 透传
 *     spawnHoneydoVideo（契约 6：spawn argv --width W --height H 两轴显式覆盖档位）
 *   - 场景 1.P3 [det-machine]（job 级代码化）：画布像素 ≤ 1177600 && ≥ /2
 *   - 场景 1.P4 [det-machine]：DB 当日行 wallpaper_video_native_url != ""
 *     && wallpaper_video_landscape_url == "" && wallpaper_video_portrait_url == ""
 *     （DB 列「空」在本套件惯例为 NULL——与既有 wallpaper-video-job 验收同语义）
 *   - 场景 3.P3 [det-machine]（COS HEAD 前置）：护栏通过后 wallpaper_video_landscape_url
 *     != ""（兼容日；真实 COS HEAD 200 落 realprocess 文件）
 *   - 场景 4.P1 [det-machine]（job 级代码化）：非兼容日产物零 .mov —— transcodeForAerial
 *     调用次数 == 0 且无 _landscape.mov 上传
 *   - 场景 4.P4 [det-machine]：非兼容日 wallpaper_video_landscape_url == ""（未上传）
 *   - 场景 5.P1 [real-process→job 级代码化]：注入错尺寸转码产物 → 护栏阻断：
 *     job 失败（runWallpaperVideo reject → rerun CLI exit != 0 的进程级前提）且回执列空
 *   - 场景 5.P2 [det-machine]：失败日志显式含尺寸断言语义（禁静默失败）
 *   - 场景 5.P3 [det-machine]：对照组正确尺寸 → 护栏放行、回执写库（kill 永远拒绝 No-op）
 *   - 场景 7 [det-machine DB 侧]：兼容日 native 与 landscape 并存（302 路由 302→landscape、
 *     manifest 取 native 的断言落 route/manifest 两个验收文件）
 *
 * 设计契约（D2 逐字）：produceNativeSide 单腿——单腿 = 全程恰 1 次 honeydo spawn（kill
 *   双腿 No-op）；转码A（画廊原生，沿用 transcodeForGallery）恒发生；转码B（条件 Aerial）
 *   仅画布 ratio ∈ [1.5, 1.9] 发生；legacy 竖腿删除 → _portrait.mp4 不再新写（契约 2）。
 *
 * // CONTRACT_AMBIGUOUS: 尺寸护栏的实现位置（job 级 post-transcode probe vs 转码函数内部）
 * // 契约未声明导出名——本文件按 D2「每条转码产物 probe 断言尺寸，不匹配即 throw」在 job
 * // 边界注入（mock 转码产物落错尺寸文件），护栏无论住在哪里都必须拦下错尺寸产物；真实
 * // ffmpeg 转码自身的产物 invariant 落 wallpaper-video-native-transcode 验收文件。
 * // CONTRACT_AMBIGUOUS: 失败日志的措辞未契约化——5.P2 断言捕获的 console 输出包含注入的
 * // 错误宽度字面量（日志必须能定位「什么尺寸不匹配」），不锁定措辞。
 *
 * 红队铁律：不读蓝队实现代码；注入点只用契约已声明接口名：computeNativeCanvas（绑定表
 *   SSOT）/ preprocessHeroFrame / spawnHoneydoVideo / buildLoop / renderTextOverlay /
 *   transcodeForAerial / transcodeForGallery / uploadFile / safeUploadFile / syncDayToGallery。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// [capability-gate 惯例，同 wallpaper-video-job.acceptance.test.ts]：job 前置校验会
// access honeydo 路径——CI 无 honeydo 时整组 skip（本机装 honeydo 即自动真跑）。
// 纯函数/manifest/route/transcode 级断言在其它验收文件中无条件可跑。
const HONEYDO_AVAILABLE = spawnSync("which", ["honeydo"], { encoding: "utf8" }).status === 0;
if (!HONEYDO_AVAILABLE) {
  console.warn("[wallpaper-video-native-job] honeydo 不可用——job 级用例 capability-gate skip");
}
const dJob = HONEYDO_AVAILABLE ? describe : describe.skip;

// ============================================================================
// hoisted holder + mocks
// ============================================================================

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  storageRoot: "/tmp/relight-none",
  videoWorkspacePath: "/tmp/relight-none/video-workspace",
  enabled: true,
  receiptMode: "url" as "url" | "empty",
  seconds: 4,
  loopSeconds: 8,
  honeydoPath: "/usr/bin/false",
  firstFramePath: "/tmp/relight-none/first.png",
  /** spawn mock 产物登记表：`${width}x${height}` → 源 mp4 路径 */
  productByCanvas: new Map<string, string>(),
  loopPath: "/tmp/relight-none/loop-master.mp4",
  overlaidPath: "/tmp/relight-none/overlaid.mp4",
  /** transcodeForGallery 产物模式：pass=复制源 / badsz=落错尺寸文件 */
  galleryMode: "pass" as "pass" | "badsz",
  /** transcodeForAerial 产物模式：pass=落 1920×1080 / badsz=落 1918×1080 */
  aerialMode: "pass" as "pass" | "badsz",
  galleryBadPath: "/tmp/relight-none/bad-1310x864.mp4",
  aerialBadPath: "/tmp/relight-none/bad-1918x1080.mp4",
  aerialOkPath: "/tmp/relight-none/ok-1920x1080.mp4",
}));

/** 串接顺序游标 */
const pipelineSeq: string[] = [];

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
    wallpaperVideoSpawnTimeoutMs: 5400000,
    wallpaperVideoPromptPerson:
      "人物保持自然状态，轻轻侧头微笑，发丝和衣角随风轻扬，手部小幅度轻柔互动，光影缓缓流动",
    wallpaperVideoPromptScene:
      "镜头极缓慢推近，光影柔和流动，云影水波轻轻变幻，花草树叶随风微动，画面宁静而生动",
    get videoWorkspacePath() {
      return holder.videoWorkspacePath;
    },
    get honeydoCliPath() {
      return holder.honeydoPath;
    },
    repoRoot: "/tmp/relight-none",
    port: 3000,
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-wvn-test",
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

const mockCosPutObject = vi.hoisted(() => vi.fn(async () => ({})));
const mockCosSliceUploadFile = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("cos-nodejs-sdk-v5", () => {
  const S3 = vi.fn(() => ({
    putObject: mockCosPutObject,
    sliceUploadFile: mockCosSliceUploadFile,
    getObjectUrl: vi.fn(),
  }));
  return { default: S3 };
});

const mockUploadFile = vi.hoisted(() => vi.fn());
const mockSafeUpload = vi.hoisted(() => vi.fn());

vi.mock("../lib/cos/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cos/upload")>();
  return { ...actual, uploadFile: mockUploadFile };
});

const mockSyncDayToGallery = vi.hoisted(() => vi.fn(async (_pickDate: string) => {}));

vi.mock("../lib/gallery/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/gallery/sync")>();
  return { ...actual, syncDayToGallery: mockSyncDayToGallery, safeUploadFile: mockSafeUpload };
});

const mockPreprocessHeroFrame = vi.hoisted(() => vi.fn());
const mockSpawnHoneydoVideo = vi.hoisted(() => vi.fn());
const mockBuildLoop = vi.hoisted(() => vi.fn());
const mockRenderTextOverlay = vi.hoisted(() => vi.fn());
const mockTranscodeForAerial = vi.hoisted(() => vi.fn());
const mockTranscodeForGallery = vi.hoisted(() => vi.fn());

vi.mock("../lib/wallpaper/video", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallpaper/video")>();
  return {
    ...actual,
    preprocessHeroFrame: mockPreprocessHeroFrame,
    spawnHoneydoVideo: mockSpawnHoneydoVideo,
    buildLoop: mockBuildLoop,
    renderTextOverlay: mockRenderTextOverlay,
    transcodeForAerialNative: mockTranscodeForAerial,
    transcodeForGallery: mockTranscodeForGallery,
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
// 契约字面量（§契约规约 逐字）
// ============================================================================

const PREFIX = TEST_COS.prefix;
/** 契约 2：COS key = relight/wallpaper-videos/{pickDate}_native.mp4（新） */
function nativeKey(pickDate: string): string {
  return `${PREFIX}/wallpaper-videos/${pickDate}_native.mp4`;
}
function landscapeKey(pickDate: string): string {
  return `${PREFIX}/wallpaper-videos/${pickDate}_landscape.mov`;
}
function receiptFor(cosKey: string): string {
  if (holder.receiptMode === "empty") return "";
  return `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${cosKey}`;
}

/** 兼容日：hero 3000×2000（3:2，画布 ratio 1312/864≈1.5185 ∈ [1.5, 1.9] → 出 .mov） */
const PICK_COMPAT = "2026-09-20";
/** 非兼容日：hero 2000×2000（1:1，画布 ratio 1.0 < 1.5 → 无 .mov，mac 静态回退） */
const PICK_SQUARE = "2026-09-21";

// ============================================================================
// 临时环境 + fixture
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
  // 契约 1：daily_picks 新增列 wallpaper_video_native_url TEXT NULL（红队 fixture 兜底：
  // helper DDL 若未含此列则补齐；蓝队 schema 落地后此分支不再触发）
  if (!cols.includes("wallpaper_video_native_url")) {
    db.exec("ALTER TABLE daily_picks ADD COLUMN wallpaper_video_native_url TEXT");
  }
}

/** 真实 JPEG fixture（D2：sharp 读 hero 原图 dims —— 照片文件必须可解码） */
async function makeHeroJpeg(outPath: string, width: number, height: number): Promise<void> {
  await sharp({ create: { width, height, channels: 3, background: "#2288cc" } })
    .jpeg()
    .toFile(outPath);
}

/** 1 秒真实 H.264 mp4（spawn mock 产物 / 护栏注入样本） */
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

function seedPick(pickDate: string, photoId: string): void {
  sqlite
    .prepare(
      `INSERT INTO daily_picks
         (id, photo_id, pick_date, title, narrative, score, composed_image_path, members, created_at,
          wallpaper_video_landscape_url, wallpaper_video_portrait_url, wallpaper_video_native_url)
       VALUES (?, ?, ?, '金色黄昏', '五年前的今天，你在海边捕捉到了这张温暖的照片。', 8.5,
               ?, '[]', '2026-09-12T06:00:00.000Z', NULL, NULL, NULL)`,
    )
    .run(`pick-${pickDate}`, photoId, pickDate, `daily-composed/${pickDate}.jpg`);
}

function getPickRow(pickDate: string): {
  wallpaper_video_native_url: string | null;
  wallpaper_video_landscape_url: string | null;
  wallpaper_video_portrait_url: string | null;
} {
  return sqlite
    .prepare(
      `SELECT wallpaper_video_native_url, wallpaper_video_landscape_url, wallpaper_video_portrait_url
       FROM daily_picks WHERE pick_date = ?`,
    )
    .get(pickDate) as {
    wallpaper_video_native_url: string | null;
    wallpaper_video_landscape_url: string | null;
    wallpaper_video_portrait_url: string | null;
  };
}

/** 上传边界调用总次数（safeUploadFile 与 uploadFile 两条路径合计），并汇总全部 cosKey */
function uploadCalls(): Array<{ localPath: string; cosKey: string }> {
  const calls: Array<{ localPath: string; cosKey: string }> = [];
  for (const c of [...mockSafeUpload.mock.calls, ...mockUploadFile.mock.calls]) {
    calls.push({ localPath: String(c?.[0]), cosKey: String(c?.[1]) });
  }
  return calls;
}

function wireMocks(): void {
  mockPreprocessHeroFrame.mockReset();
  mockSpawnHoneydoVideo.mockReset();
  mockBuildLoop.mockReset();
  mockRenderTextOverlay.mockReset();
  mockTranscodeForAerial.mockReset();
  mockTranscodeForGallery.mockReset();
  mockUploadFile.mockReset();
  mockSafeUpload.mockReset();
  mockSyncDayToGallery.mockReset();
  pipelineSeq.length = 0;
  holder.galleryMode = "pass";
  holder.aerialMode = "pass";

  mockPreprocessHeroFrame.mockImplementation(async () => {
    pipelineSeq.push("preprocess");
    return holder.firstFramePath;
  });
  // spawn：按 job 请求的画布 `${width}x${height}` 落对应尺寸的真实 mp4 产物（契约：产物在 outPath）
  mockSpawnHoneydoVideo.mockImplementation(
    async (opts: {
      outPath?: string;
      width?: number;
      height?: number;
    }) => {
      pipelineSeq.push("spawn");
      const out = opts?.outPath ?? "/tmp/relight-none/out.mp4";
      const src = holder.productByCanvas.get(`${opts?.width}x${opts?.height}`);
      if (!src) {
        throw new Error(
          `spawn mock 未登记画布 ${opts?.width}x${opts?.height}——job 未按 computeNativeCanvas 画布请求`,
        );
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(src, out);
      return {
        outPath: out,
        duration: 1,
        stdout: `{"out":"${out}","duration":1,"res":"${opts?.width}x${opts?.height}"}`,
      };
    },
  );
  mockBuildLoop.mockImplementation(async (src: string, _targetSeconds: number) => {
    pipelineSeq.push("buildLoop");
    fs.mkdirSync(path.dirname(holder.loopPath), { recursive: true });
    fs.copyFileSync(src, holder.loopPath);
    return { loopPath: holder.loopPath, segments: 2 };
  });
  mockRenderTextOverlay.mockImplementation(async (videoPath: string, _meta: unknown) => {
    pipelineSeq.push("overlay");
    fs.mkdirSync(path.dirname(holder.overlaidPath), { recursive: true });
    fs.copyFileSync(videoPath, holder.overlaidPath);
    return { overlaidPath: holder.overlaidPath };
  });
  mockTranscodeForGallery.mockImplementation((src: string, dst: string) => {
    pipelineSeq.push("gallery");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(holder.galleryMode === "badsz" ? holder.galleryBadPath : src, dst);
  });
  mockTranscodeForAerial.mockImplementation((src: string, dst: string) => {
    pipelineSeq.push("aerial");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(
      holder.aerialMode === "badsz" ? holder.aerialBadPath : holder.aerialOkPath,
      dst,
    );
  });
  mockUploadFile.mockImplementation(async (_localPath: string, cosKey: string) =>
    receiptFor(cosKey),
  );
  mockSafeUpload.mockImplementation(async (_localPath: string, cosKey: string) =>
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

  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvnjob-"));
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
       VALUES ('src-wvn', '测试存储源', 'local', ?, 1)`,
    )
    .run(storageRoot);

  // hero 照片：真实 JPEG（job 会 sharp 读原图 dims → computeNativeCanvas）
  const heroCompat = path.join(tmpRoot, "hero-compat.jpg");
  const heroSquare = path.join(tmpRoot, "hero-square.jpg");
  await makeHeroJpeg(heroCompat, 3000, 2000); // 3:2
  await makeHeroJpeg(heroSquare, 2000, 2000); // 1:1
  for (const [pid, p] of [
    ["photo-compat", heroCompat],
    ["photo-square", heroSquare],
  ] as Array<[string, string]>) {
    sqlite
      .prepare(
        `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, created_at)
         VALUES (?, 'src-wvn', ?, ?, 3000, 2000, 1024, '2026-01-01T00:00:00.000Z')`,
      )
      .run(pid, p, `hash-${pid}`);
  }
  seedPick(PICK_COMPAT, "photo-compat");
  seedPick(PICK_SQUARE, "photo-square");

  holder.dbPath = dbPath;
  holder.storageRoot = storageRoot;
  const honeydoWhich = spawnSync("which", ["honeydo"], { encoding: "utf8" });
  holder.honeydoPath = honeydoWhich.status === 0 ? String(honeydoWhich.stdout).trim() : "";
  process.env.DATABASE_PATH = dbPath;
  process.env.STORAGE_ROOT = storageRoot;

  // fixture 媒体：首帧 png（1×1 最小合法 PNG）+ 画布尺寸产物 + 护栏注入样本
  holder.firstFramePath = path.join(tmpRoot, "first-frame.png");
  fs.writeFileSync(
    holder.firstFramePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  // 生成产物按画布登记（3:2 hero → 1312×864（D1 参考输出）；1:1 hero → 1056×1056）
  const compatProduct = path.join(tmpRoot, "product-1312x864.mp4");
  const squareProduct = path.join(tmpRoot, "product-1056x1056.mp4");
  makeTinyMp4(compatProduct, "1312x864");
  makeTinyMp4(squareProduct, "1056x1056");
  holder.productByCanvas.set("1312x864", compatProduct);
  holder.productByCanvas.set("1056x1056", squareProduct);
  // 护栏对照/注入样本（场景 5：1918×1080 注入 → 拒绝；1920×1080 对照 → 放行）
  holder.aerialOkPath = path.join(tmpRoot, "ok-1920x1080.mp4");
  holder.aerialBadPath = path.join(tmpRoot, "bad-1918x1080.mp4");
  holder.galleryBadPath = path.join(tmpRoot, "bad-1310x864.mp4");
  makeTinyMp4(holder.aerialOkPath, "1920x1080");
  makeTinyMp4(holder.aerialBadPath, "1918x1080");
  makeTinyMp4(holder.galleryBadPath, "1310x864");
  holder.loopPath = path.join(tmpRoot, "loop-master.mp4");
  holder.overlaidPath = path.join(tmpRoot, "overlaid.mp4");
  holder.videoWorkspacePath = path.join(tmpRoot, "video-workspace");

  // Remotion 运行时脚手架（job 前置 fs access 校验；渲染本身被 mock——
  // 惯例同 wallpaper-video-job.acceptance.test.ts）
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
  holder.receiptMode = "url";
  holder.seconds = 4;
  holder.loopSeconds = 8;
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
// 场景 1.P4 + 4.P1/P4：非兼容日（1:1 hero）——单腿原生，无 .mov
// ============================================================================

dJob("场景 1.P4/4.P1/4.P4：非兼容日（画布 ratio<1.5）单腿原生——无 .mov、回执仅 native", () => {
  it("恰 1 次 spawn（kill 双腿 No-op）+ transcodeForAerial 零调用 + 仅 native key 上传", async () => {
    await runWallpaperVideo(PICK_SQUARE);

    // 场景 1.P1 的 job 级代码化：单腿 = 全程恰 1 次 honeydo spawn
    expect(mockSpawnHoneydoVideo).toHaveBeenCalledTimes(1);
    // 场景 4.P1 的 job 级代码化：非兼容日零 Aerial 转码（产物目录无 1920×1080 .mov 的因）
    expect(mockTranscodeForAerial).toHaveBeenCalledTimes(0);
    expect(mockTranscodeForGallery).toHaveBeenCalledTimes(1);

    const uploads = uploadCalls();
    expect(uploads.length, "非兼容日仅 1 次（native）上传").toBe(1);
    expect(uploads[0]?.cosKey).toBe(nativeKey(PICK_SQUARE));
    expect(
      uploads.some((u) => u.cosKey.includes("_landscape.mov")),
      "非兼容日不得上传 _landscape.mov",
    ).toBe(false);
    expect(
      uploads.some((u) => u.cosKey.includes("_portrait.mp4")),
      "legacy 竖腿已删除——不得再上传 _portrait.mp4（契约 2）",
    ).toBe(false);
  });

  it("画布跟随原图：preprocess 按 computeNativeCanvas(2000,2000) 画布、spawn 显式携带 W/H（契约 6）", async () => {
    const { computeNativeCanvas } = await import("../lib/wallpaper/native-canvas");
    await runWallpaperVideo(PICK_SQUARE);

    const canvas = computeNativeCanvas(2000, 2000);
    // 场景 1.P3 字面量（画布像素预算窗口）
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(1_177_600);
    expect(canvas.width * canvas.height).toBeGreaterThanOrEqual(1_177_600 / 2);

    // preprocess 被以画布 W/H 调用（第 2/3 参）
    const pp = mockPreprocessHeroFrame.mock.calls[0] as unknown[];
    expect(`${pp[1]}x${pp[2]}`, "preprocess 画布必须 == computeNativeCanvas(2000,2000)").toBe(
      `${canvas.width}x${canvas.height}`,
    );
    // 契约 6：spawn argv --width W --height H（spawnHoneydoVideo opts 两轴显式覆盖）
    const sp = mockSpawnHoneydoVideo.mock.calls[0]?.[0] as { width?: number; height?: number };
    expect(sp.width, "spawn.opts.width 必须 == 画布宽").toBe(canvas.width);
    expect(sp.height, "spawn.opts.height 必须 == 画布高").toBe(canvas.height);
  });

  it("场景 1.P4 [det-machine]：DB 行 native != 空 && landscape == 空 && portrait == 空", async () => {
    await runWallpaperVideo(PICK_SQUARE);

    const row = getPickRow(PICK_SQUARE);
    expect(row.wallpaper_video_native_url, "native 回执列必须非空（回执 URL 逐字）").toBe(
      receiptFor(nativeKey(PICK_SQUARE)),
    );
    expect(row.wallpaper_video_landscape_url, "非兼容日 landscape 列必须为空").toBeNull();
    expect(row.wallpaper_video_portrait_url, "portrait 列必须为空（legacy 不再新写）").toBeNull();
    expect(mockSyncDayToGallery).toHaveBeenCalledTimes(1);
    expect(mockSyncDayToGallery.mock.calls[0]?.[0]).toBe(PICK_SQUARE);
  });
});

// ============================================================================
// 场景 3.P3（DB 侧）+ 场景 7 DB 共存：兼容日（3:2 hero，ratio ∈ [1.5,1.9]）
// ============================================================================

dJob("场景 3.P3 DB 侧 / 7：兼容日——native 与 landscape 并存、portrait 恒空", () => {
  it("transcodeForAerial 恰 1 次（输入=文字成品）+ native/_landscape.mov 双 key 上传", async () => {
    await runWallpaperVideo(PICK_COMPAT);

    expect(mockSpawnHoneydoVideo).toHaveBeenCalledTimes(1);
    expect(mockTranscodeForGallery).toHaveBeenCalledTimes(1);
    expect(
      mockTranscodeForAerial,
      "兼容日（3:2 画布 ratio≈1.52 ∈ [1.5,1.9]）必须产出 Aerial",
    ).toHaveBeenCalledTimes(1);
    // v2 契约沿承：transcodeForAerial 输入 = Remotion 合成后的最终成品
    expect(mockTranscodeForAerial.mock.calls[0]?.[0]).toBe(holder.overlaidPath);

    const uploads = uploadCalls();
    const keys = uploads.map((u) => u.cosKey);
    expect(keys, "兼容日恰 2 次上传（native + _landscape.mov）").toHaveLength(2);
    expect(keys).toContain(nativeKey(PICK_COMPAT));
    expect(keys).toContain(landscapeKey(PICK_COMPAT));
  });

  it("护栏通过后 DB：native != 空 且 wallpaper_video_landscape_url != 空（场景 3.P3 前置）且 portrait 空", async () => {
    await runWallpaperVideo(PICK_COMPAT);

    const row = getPickRow(PICK_COMPAT);
    expect(row.wallpaper_video_native_url).toBe(receiptFor(nativeKey(PICK_COMPAT)));
    expect(
      row.wallpaper_video_landscape_url,
      "场景 3.P3：护栏通过后 landscape 列必须非空（真实 COS HEAD 落 realprocess 文件）",
    ).toBe(receiptFor(landscapeKey(PICK_COMPAT)));
    expect(row.wallpaper_video_portrait_url).toBeNull();
  });

  it("D2 画布联动：preprocess 画布 == computeNativeCanvas(3000,2000)（=1312×864，D1 参考输出）", async () => {
    const { computeNativeCanvas } = await import("../lib/wallpaper/native-canvas");
    await runWallpaperVideo(PICK_COMPAT);

    const canvas = computeNativeCanvas(3000, 2000);
    expect(`${canvas.width}x${canvas.height}`).toBe("1312x864"); // D1 参考输出锁
    const pp = mockPreprocessHeroFrame.mock.calls[0] as unknown[];
    expect(`${pp[1]}x${pp[2]}`).toBe("1312x864");
    const sp = mockSpawnHoneydoVideo.mock.calls[0]?.[0] as { width?: number; height?: number };
    expect(sp.width).toBe(1312);
    expect(sp.height).toBe(864);
  });
});

// ============================================================================
// 场景 5：尺寸护栏拦截错尺寸产物（注入 / 日志 / 对照）
// ============================================================================

dJob("场景 5：尺寸护栏——错尺寸产物阻断（回执列空 + 日志显式），正确尺寸放行", () => {
  // 隔离：场景 3.P3 兼容日成功路径已为 PICK_COMPAT 写列，场景 5 断言「两列空」前必须先清列
  beforeEach(() => {
    sqlite
      .prepare(
        "UPDATE daily_picks SET wallpaper_video_native_url = NULL, wallpaper_video_landscape_url = NULL, wallpaper_video_portrait_url = NULL",
      )
      .run();
  });

  it("场景 5.P1：注入 1918×1080 Aerial 产物 → 护栏阻断：job 失败（reject）且回执列空", async () => {
    holder.aerialMode = "badsz";
    const consoleSpy: string[] = [];
    const e = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      consoleSpy.push(a.map(String).join(" "));
    });
    const w = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      consoleSpy.push(a.map(String).join(" "));
    });

    let rejected = false;
    try {
      await runWallpaperVideo(PICK_COMPAT);
    } catch {
      rejected = true;
    }
    e.mockRestore();
    w.mockRestore();

    // P1 字面量「exit != 0」的 job 级前提：护栏 throw 必须传播（被旁路吞掉则 CLI exit==0）
    expect(rejected, "尺寸护栏必须使 job 失败（rerun CLI exit != 0 的前提）").toBe(true);
    // 回执列空（契约 8：任一环节失败 → 两列均空）
    const row = getPickRow(PICK_COMPAT);
    expect(row.wallpaper_video_native_url).toBeNull();
    expect(row.wallpaper_video_landscape_url).toBeNull();
    expect(row.wallpaper_video_portrait_url).toBeNull();
  });

  it("场景 5.P1（native 腿）：注入 1310×864 画廊产物（≠画布 1312×864）→ 阻断 + 两列空", async () => {
    holder.galleryMode = "badsz";
    let rejected = false;
    try {
      await runWallpaperVideo(PICK_COMPAT);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    const row = getPickRow(PICK_COMPAT);
    expect(row.wallpaper_video_native_url).toBeNull();
    expect(row.wallpaper_video_landscape_url).toBeNull();
  });

  it("场景 5.P2 [det-machine]：失败日志显式含尺寸断言语义（输出含注入错误宽度 1918，禁静默失败）", async () => {
    holder.aerialMode = "badsz";
    const consoleSpy: string[] = [];
    const e = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      consoleSpy.push(a.map(String).join(" "));
    });
    const w = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      consoleSpy.push(a.map(String).join(" "));
    });
    // 实现的失败日志经 log 回调（默认 console.log）输出，须一并捕获
    const l = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      consoleSpy.push(a.map(String).join(" "));
    });
    try {
      await runWallpaperVideo(PICK_COMPAT);
    } catch {
      // 预期 reject（5.P1 已断言）；此处只采集日志
    }
    e.mockRestore();
    w.mockRestore();
    l.mockRestore();

    const log = consoleSpy.join("\n");
    // CONTRACT_AMBIGUOUS（措辞不锁定）：日志必须能定位「什么尺寸不匹配」→ 含注入错误宽度
    expect(
      log,
      `失败日志必须显式含尺寸断言语义（含注入宽度 1918），实际日志：\n${log.slice(0, 2000)}`,
    ).toContain("1918");
  });

  it("场景 5.P3 [det-machine]：对照组 1920×1080 → 护栏放行、landscape 回执写库（kill 永远拒绝 No-op）", async () => {
    holder.aerialMode = "pass"; // mock 落 1920×1080 正确尺寸
    await runWallpaperVideo(PICK_COMPAT);

    const row = getPickRow(PICK_COMPAT);
    expect(row.wallpaper_video_landscape_url, "对照组正确尺寸必须放行并写回执").toBe(
      receiptFor(landscapeKey(PICK_COMPAT)),
    );
    expect(row.wallpaper_video_native_url).toBe(receiptFor(nativeKey(PICK_COMPAT)));
  });
});

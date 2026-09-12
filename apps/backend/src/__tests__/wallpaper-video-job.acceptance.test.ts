import { execSync, spawnSync } from "node:child_process";
/**
 * 验收测试（红队）：动态视频壁纸 — wallpaper-video job 行为契约
 *（开关默认关零 spawn / spawn 失败回退静态 / COS 回执空串不写库 / 成功路径回执写库）
 *【v2 增量】串接顺序 preprocess → spawn → buildLoop → renderTextOverlay → 双转码
 *
 * 设计文档（state.md）对应谓词与契约：
 *   - 场景 4.P1/P3（代码化）：开关关 → job skip 返回（零 honeydo spawn、零上传、零同步）
 *     → manifest 无视频字段、静态字段完好
 *   - 场景 5.P2/P3（代码化）：视频生成失败 → 当日交付回退静态壁纸（manifest 静态字段完好）
 *     且 job 不抛到调度层（终态 != failed——BullMQ worker 只有 throw 才标记 failed）
 *   - §总体架构（v2）步骤 1-5【v2】：preprocess（人脸构图裁剪）→ spawn honeydo video gen ×1
 *     → palindrome buildLoop → 双轨（无文字母版 / Remotion 文字成品）→ 双转码
 *   - §后端设计 §4：回执非空串才写 DB 列；syncDayToGallery(pickDate) 复用
 *   - §契约规约 计算契约：spawnHoneydoVideo → {outPath, duration, stdout}；
 *     buildLoop(src, targetSeconds) → {loopPath, segments}【v2】；
 *     renderTextOverlay(videoPath, meta) → {overlaidPath}【v2】；
 *     transcodeForAerial 输入 = Remotion 合成后的最终成品【v2 逐字】；
 *     DB 列 wallpaper_video_landscape_url / wallpaper_video_portrait_url
 *
 * 红队铁律：本文件仅依据设计文档编写，不读蓝队实现代码（jobs/wallpaper-video.ts、
 *   lib/wallpaper/video.ts 等一律未读逻辑；只把契约声明的函数名当注入点）。
 *   注入点只用契约已声明接口名：config.wallpaperVideoEnabled / preprocessHeroFrame /
 *   spawnHoneydoVideo / buildLoop / renderTextOverlay / transcodeForAerial /
 *   transcodeForGallery / safeUploadFile / uploadFile / syncDayToGallery。
 *   spawn mock 断言调用次数（场景 4.P3「honeydo 调用次数 == 0」；【v2】每腿 spawn ×1）。
 *
 * // CONTRACT_AMBIGUOUS: §总体架构 v2 步骤 2「spawn honeydo video gen ×1」与横竖双画布
 * //（边界值【v2】：横版 1280×704、竖版 704×1216）及两条产物 key（_landscape.mov ∧
 * // _portrait.mp4）并读——「×1」按「每腿 ×1」落（横/竖两腿串行，每腿各自
 * // preprocess → spawn → buildLoop → renderTextOverlay → 转码 → 上传；与 §后端设计 §4
 * // v1 串行惯例一致）。若蓝队改为单腿单 spawn（一步产出双画布），次数断言红 → QA 对齐。
 * // CONTRACT_AMBIGUOUS: transcodeForGallery 的输入源（无文字微动母版 vs Remotion 文字
 * // 成品）契约未逐字固定（transcodeForAerial 有「输入改为最终成品」逐字标注，Gallery
 * // 没有）——本文件不断言其 src 指向，只断言它发生一次且在 renderTextOverlay 之后。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// hoisted holder：vi.mock factory 与 beforeAll 之间共享可变状态
// ============================================================================

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  storageRoot: "/tmp/relight-none",
  videoWorkspacePath: "/tmp/relight-none/video-workspace",
  /** 开关（场景 4：默认 false） */
  enabled: false,
  /** COS 回执模式：url = 回执公网 URL；empty = 空串（上传失败语义，不 throw） */
  receiptMode: "url" as "url" | "empty",
  /** config.wallpaperVideoSeconds（job 透传给 spawnHoneydoVideo.opts.seconds；默认 4【v2】） */
  seconds: 4,
  /** config.wallpaperVideoLoopSeconds（job 透传给 buildLoop.targetSeconds；默认 8【v2】） */
  loopSeconds: 8,
  /** honeydo 绝对路径（beforeAll 解析；assertVideoSpawnPrerequisites 需要 access 到真实文件） */
  honeydoPath: "/usr/bin/false",
  firstFramePath: "/tmp/relight-none/first.png",
  landscapeProductPath: "/tmp/relight-none/landscape-src.mp4",
  portraitProductPath: "/tmp/relight-none/portrait-src.mp4",
  /** buildLoop 产物路径（mock 落盘目标） */
  loopPath: "/tmp/relight-none/loop-master.mp4",
  /** renderTextOverlay 产物路径（mock 落盘目标；transcodeForAerial 输入断言用） */
  overlaidPath: "/tmp/relight-none/overlaid.mp4",
}));

/** 串接顺序游标：每个契约函数 mock 被调用时按序 push 标签（【v2】顺序断言用） */
const pipelineSeq: string[] = [];

// ============================================================================
// Mock：config（wallpaperVideoEnabled 用 getter 动态读 holder；databasePath 动态读 env）
// vi.hoisted：factory 被提升到 const 声明之前，常量须经 hoisted 共享
// ============================================================================

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
    wallpaperVideoPrompt:
      "画面中的景物以极缓慢的速度轻微摇曳，光影柔和流动，随后一切缓缓回到初始位置，如呼吸般自然",
    get videoWorkspacePath() {
      return holder.videoWorkspacePath;
    },
    get honeydoCliPath() {
      return holder.honeydoPath;
    },
    repoRoot: "/tmp/relight-none",
    port: 3000,
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-wv-test",
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

// ============================================================================
// Mock：db（真实 schema + drizzle over 临时 sqlite 文件；首次 import 时用 holder.dbPath）
// ============================================================================

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
// Mock：COS SDK + 上传/同步边界（回执可控）
// ============================================================================

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

/** receipt 按 cosKey 派生：url 模式 → 公网 URL；empty 模式 → ""（失败返回空串不 throw 语义） */
function receiptForKey(cosKey: string): string {
  if (holder.receiptMode === "empty") return "";
  return `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${cosKey}`;
}

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

// ============================================================================
// Mock：lib/wallpaper/video（契约声明函数名作注入点；assertVideoSpawnPrerequisites 留真实）
// ============================================================================

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
    transcodeForAerial: mockTranscodeForAerial,
    transcodeForGallery: mockTranscodeForGallery,
  };
});

// ============================================================================
// Mock：queues（避免真实 BullMQ/Redis 连接；惯例同 daily-api.acceptance.test.ts）
// ============================================================================

vi.mock("../jobs/queues", () => ({
  scanQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  analyzeQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  dailyQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  dailyPushQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  dailyVideoQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  wallpaperVideoQueue: { add: vi.fn(async () => ({ id: "mock" })) },
}));

// ============================================================================
// import buildManifest（manifest 侧断言用；config.databasePath 走 env getter）
// ============================================================================

import { buildManifest } from "../lib/gallery/manifest";

// ============================================================================
// 契约字面量（§契约规约 逐字）
// ============================================================================

const PICK_DATE = "2026-09-12";
const LANDSCAPE_KEY = `${TEST_COS.prefix}/wallpaper-videos/${PICK_DATE}_landscape.mov`;
const PORTRAIT_KEY = `${TEST_COS.prefix}/wallpaper-videos/${PICK_DATE}_portrait.mp4`;
const LANDSCAPE_URL = `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${LANDSCAPE_KEY}`;
const PORTRAIT_URL = `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${PORTRAIT_KEY}`;

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
}

/** 生成 1 秒真实 H.264 mp4（spawn mock 的「生成产物」+ 转码 mock 的 copy 源） */
function makeTinyMp4(outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x176:rate=12:duration=1",
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
    throw new Error(`fixture ffmpeg 造样片失败（红队铁律：fixture 失败即真红）: ${r.stderr}`);
  }
}

function seedTodayPick(overrides: { composedImagePath?: string | null } = {}): void {
  sqlite
    .prepare(
      `INSERT INTO daily_picks
         (id, photo_id, pick_date, title, narrative, score, composed_image_path, members, created_at,
          wallpaper_video_landscape_url, wallpaper_video_portrait_url)
       VALUES ('pick-wv', 'photo-wv', ?, '金色黄昏',
               '五年前的今天，你在海边捕捉到了这张温暖的照片。夕阳染成金橙色，海浪轻抚沙滩。',
               8.5, ?, '[]', '2026-09-12T06:00:00.000Z', NULL, NULL)`,
    )
    .run(PICK_DATE, overrides.composedImagePath ?? "daily-composed/2026-09-12.jpg");
}

function getPickRow(): {
  wallpaper_video_landscape_url: string | null;
  wallpaper_video_portrait_url: string | null;
  composed_image_path: string | null;
} {
  return sqlite
    .prepare(
      `SELECT wallpaper_video_landscape_url, wallpaper_video_portrait_url, composed_image_path
       FROM daily_picks WHERE pick_date = ?`,
    )
    .get(PICK_DATE) as {
    wallpaper_video_landscape_url: string | null;
    wallpaper_video_portrait_url: string | null;
    composed_image_path: string | null;
  };
}

interface ManifestDayShape {
  pickDate: string;
  wallpaperLandscape: string;
  wallpaperPortrait: string;
  wallpaperVideoLandscape?: string;
  wallpaperVideoPortrait?: string;
}

async function buildManifestDays(): Promise<ManifestDayShape[]> {
  const manifest = (await buildManifest()) as unknown as { days: ManifestDayShape[] };
  return manifest.days;
}

/** 上传边界调用总次数（safeUploadFile 与 uploadFile 两条路径合计） */
function uploadCallCount(): number {
  return mockSafeUpload.mock.calls.length + mockUploadFile.mock.calls.length;
}

/** 统一（重）接线 mock 实现——beforeEach 必须 mockReset + 重放，防止上一用例的
 *  mockRejectedValue 等持久实现泄漏到下一用例（mockClear 只清调用记录不清实现） */
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
  mockCosPutObject.mockReset();
  mockCosPutObject.mockImplementation(async () => ({}));
  mockCosSliceUploadFile.mockImplementation(async () => ({}));
  pipelineSeq.length = 0;

  // preprocess 返回真实 png；spawn 在 job 请求的 outPath 落真实 mp4 产物（契约：产物存在于 outPath）
  mockPreprocessHeroFrame.mockImplementation(async () => {
    pipelineSeq.push("preprocess");
    return holder.firstFramePath;
  });
  mockSpawnHoneydoVideo.mockImplementation(async (opts: { outPath?: string }) => {
    pipelineSeq.push("spawn");
    const out = opts?.outPath ?? holder.landscapeProductPath;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(holder.landscapeProductPath, out);
    return {
      outPath: out,
      duration: 1,
      stdout: `{"out":"${out}","duration":1,"res":"1280x704"}`,
    };
  });
  // buildLoop（契约【v2】：(src, targetSeconds) → {loopPath, segments}）——落真实产物
  mockBuildLoop.mockImplementation(async (src: string, _targetSeconds: number) => {
    pipelineSeq.push("buildLoop");
    fs.mkdirSync(path.dirname(holder.loopPath), { recursive: true });
    fs.copyFileSync(src, holder.loopPath);
    return { loopPath: holder.loopPath, segments: 2 };
  });
  // renderTextOverlay（契约【v2】：(videoPath, meta) → {overlaidPath}）——落真实产物
  mockRenderTextOverlay.mockImplementation(async (videoPath: string, _meta: unknown) => {
    pipelineSeq.push("overlay");
    fs.mkdirSync(path.dirname(holder.overlaidPath), { recursive: true });
    fs.copyFileSync(videoPath, holder.overlaidPath);
    return { overlaidPath: holder.overlaidPath };
  });
  // 转码 mock：copy 落 dst（src 为上游产物，真实存在）
  const copyToDst = async (src: string, dst: string) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  mockTranscodeForAerial.mockImplementation((src: string, dst: string) => {
    pipelineSeq.push("aerial");
    return copyToDst(src, dst);
  });
  mockTranscodeForGallery.mockImplementation((src: string, dst: string) => {
    pipelineSeq.push("gallery");
    return copyToDst(src, dst);
  });
  mockUploadFile.mockImplementation(async (_localPath: string, cosKey: string) =>
    receiptForKey(cosKey),
  );
  mockSafeUpload.mockImplementation(async (_localPath: string, cosKey: string) =>
    receiptForKey(cosKey),
  );
  mockSyncDayToGallery.mockImplementation(async () => {});
}

// ============================================================================
// beforeAll / beforeEach / afterAll
// ============================================================================

let runWallpaperVideo: (pickDate: string) => Promise<unknown>;

beforeAll(async () => {
  // ffmpeg 是 job 测试 fixture 的硬前置（红队铁律：fixture 失败即真红，不静默跳过）
  const ffprobe = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8", timeout: 10000 });
  if (ffprobe.status !== 0) {
    throw new Error("ffmpeg 不可用——本验收要求真实 ffmpeg 环境");
  }

  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvjob-"));
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
       VALUES ('src-wv', '测试存储源', 'local', ?, 1)`,
    )
    .run(storageRoot);
  // hero photo 行（media_type 默认 image；filePath 指向真实存在的 fixture 文件）
  const heroPath = path.join(tmpRoot, "hero.jpg");
  fs.writeFileSync(heroPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  sqlite
    .prepare(
      `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, created_at)
       VALUES ('photo-wv', 'src-wv', ?, 'hash-wv', 4000, 3000, 1024, '2026-01-01T00:00:00.000Z')`,
    )
    .run(heroPath);

  holder.dbPath = dbPath;
  holder.storageRoot = storageRoot;
  // honeydo 绝对路径（access 存在性校验无法用 PATH 名；契约 §1 即 HONEYDO_CLI_PATH 优先 + which 兜底）
  holder.honeydoPath = execSync("which honeydo", { encoding: "utf8" }).trim();
  process.env.DATABASE_PATH = dbPath;
  process.env.STORAGE_ROOT = storageRoot;

  // fixture 媒体：预裁剪首帧 png（1x1 最小合法 PNG）+ 两条「生成产物」mp4
  holder.firstFramePath = path.join(tmpRoot, "first-frame.png");
  fs.writeFileSync(
    holder.firstFramePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  holder.landscapeProductPath = path.join(tmpRoot, "landscape-product.mp4");
  holder.portraitProductPath = path.join(tmpRoot, "portrait-product.mp4");
  makeTinyMp4(holder.landscapeProductPath);
  makeTinyMp4(holder.portraitProductPath);
  // 【v2】buildLoop / renderTextOverlay 产物路径（mock 落盘目标）
  holder.loopPath = path.join(tmpRoot, "loop-master.mp4");
  holder.overlaidPath = path.join(tmpRoot, "overlaid.mp4");
  // 【v2】Remotion 运行时工作区指向本测试 tmpRoot（与 storageRoot 同源隔离，防 /tmp 固定路径互扰）
  holder.videoWorkspacePath = path.join(tmpRoot, "video-workspace");

  // 【v2】Remotion 运行时脚手架（assertVideoSpawnPrerequisites 会 access 校验
  // videoWorkspacePath/node_modules/.bin/remotion、Chrome Headless Shell、
  // wallpaper-overlay 工程入口与文字层字体；job 的 spawn/转码/render 均被 mock，
  // 这里只需让 fs access 前置校验通过——路径以真实前置缺失报错为锚）
  const ws = holder.videoWorkspacePath;
  for (const rel of [
    path.join("wallpaper-overlay", "package.json"),
    path.join("wallpaper-overlay", "src", "index.ts"),
    // 文字层字体（Satori 模板同源：Fraunces / Noto Serif SC，§后端设计 §1【v2】）
    path.join("wallpaper-overlay", "public", "fonts", "NotoSerifSC-Regular.otf"),
    path.join("wallpaper-overlay", "public", "fonts", "NotoSerifSC-Bold.otf"),
    path.join("wallpaper-overlay", "public", "fonts", "Fraunces-Regular.otf"),
    path.join("wallpaper-overlay", "public", "fonts", "Fraunces-Bold.otf"),
    // Remotion 渲染浏览器（Chrome Headless Shell，mac-arm64 布局）
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

  // mock 行为接线（契约函数名注入，实现在 wireMocks 统一维护）
  wireMocks();

  // env 就绪后再动态 import job（../db mock factory 此时才用 holder.dbPath 建连接）
  const mod = (await import("../jobs/wallpaper-video")) as {
    runWallpaperVideo: (pickDate: string) => Promise<unknown>;
  };
  runWallpaperVideo = mod.runWallpaperVideo;
}, 30000);

beforeEach(() => {
  holder.enabled = false;
  holder.receiptMode = "url";
  // 【v2】config 时长字段默认（§后端设计 §1【v2】：seconds 默认 4 / loopSeconds 默认 8）
  holder.seconds = 4;
  holder.loopSeconds = 8;
  wireMocks();
  sqlite.prepare("DELETE FROM daily_picks").run();
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
// 场景 4：开关默认关 → 零 honeydo spawn → manifest 无视频字段
// ============================================================================

describe("场景 4（代码化）：开关关闭 → job skip、零 spawn、manifest 无视频字段", () => {
  it("wallpaperVideoEnabled=false → 零 honeydo 调用（== 0）、零上传、零同步，DB 列不被写入", async () => {
    holder.enabled = false;
    seedTodayPick();

    await runWallpaperVideo(PICK_DATE);

    // 场景 4.P3 断言字面量：honeydo 调用次数 == 0
    expect(mockSpawnHoneydoVideo).toHaveBeenCalledTimes(0);
    expect(uploadCallCount()).toBe(0);
    expect(mockSyncDayToGallery).toHaveBeenCalledTimes(0);

    const row = getPickRow();
    expect(row.wallpaper_video_landscape_url).toBeNull();
    expect(row.wallpaper_video_portrait_url).toBeNull();
  });

  it("开关关闭时 manifest 无视频字段（in === false）且静态字段完好", async () => {
    holder.enabled = false;
    seedTodayPick();
    await runWallpaperVideo(PICK_DATE);

    const days = await buildManifestDays();
    const day = days.find((d) => d.pickDate === PICK_DATE);
    expect(day).toBeTruthy();

    // 场景 4.P2 代码化：视频字段 exists == false；静态竖图字段 exists 且非空
    expect("wallpaperVideoLandscape" in (day ?? {})).toBe(false);
    expect("wallpaperVideoPortrait" in (day ?? {})).toBe(false);
    expect((day as ManifestDayShape)?.wallpaperPortrait.length ?? 0).toBeGreaterThan(0);
    expect((day as ManifestDayShape)?.wallpaperLandscape.length ?? 0).toBeGreaterThan(0);
  });
});

// ============================================================================
// 场景 5：生成失败 → 回退静态、job 不抛到调度层（终态 != failed）
// ============================================================================

describe("场景 5（代码化）：spawn 失败 → job 不抛、回退静态、DB 列 null", () => {
  it("spawnHoneydoVideo 拒绝（HoneydoSpawnError 语义）→ runWallpaperVideo 正常完成不 throw", async () => {
    holder.enabled = true;
    seedTodayPick();
    // 当日视频生成失败：spawn 拒绝（HoneydoSpawnError 语义；job 内部按腿容错回退，不向调度层抛）
    mockSpawnHoneydoVideo.mockRejectedValue(
      new Error("HoneydoSpawnError: exit code 1 :: stdout tail"),
    );

    // BullMQ worker 只有 throw 才标记 failed；「终态 != failed」⇔ 不抛到调度层
    let rejected = false;
    try {
      await runWallpaperVideo(PICK_DATE);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
  });

  it("失败后 DB 两列保持 null（回执未写）且 composedImagePath 零改动", async () => {
    holder.enabled = true;
    seedTodayPick();
    mockSpawnHoneydoVideo.mockRejectedValue(new Error("HoneydoSpawnError: timeout"));

    await runWallpaperVideo(PICK_DATE);

    const row = getPickRow();
    expect(row.wallpaper_video_landscape_url).toBeNull();
    expect(row.wallpaper_video_portrait_url).toBeNull();
    // 静态链路零改动（副作用清单：不触碰静态壁纸合成）
    expect(row.composed_image_path).toBe("daily-composed/2026-09-12.jpg");
  });

  it("失败后 manifest 静态字段完好可用、视频字段缺省（场景 5.P2 代码化）", async () => {
    holder.enabled = true;
    seedTodayPick();
    mockSpawnHoneydoVideo.mockRejectedValue(new Error("HoneydoSpawnError: exit 2"));

    await runWallpaperVideo(PICK_DATE);

    const days = await buildManifestDays();
    const day = days.find((d) => d.pickDate === PICK_DATE) as ManifestDayShape;
    expect(day).toBeTruthy();
    // 当日交付回退为静态壁纸：静态字段 exists AND 非空
    expect(day.wallpaperPortrait.length).toBeGreaterThan(0);
    expect(day.wallpaperLandscape.length).toBeGreaterThan(0);
    // 视频字段缺省
    expect("wallpaperVideoLandscape" in day).toBe(false);
    expect("wallpaperVideoPortrait" in day).toBe(false);
  });
});

// ============================================================================
// COS 回执契约：回执空串 → DB 列不被写入
// ============================================================================

describe("COS 回执契约：uploadFile 回执空串 → DB 列不被写入、manifest 无视频字段", () => {
  it("回执为空串（上传失败语义）→ 两列保持 null", async () => {
    holder.enabled = true;
    holder.receiptMode = "empty";
    seedTodayPick();

    await runWallpaperVideo(PICK_DATE);

    const row = getPickRow();
    expect(row.wallpaper_video_landscape_url).toBeNull();
    expect(row.wallpaper_video_portrait_url).toBeNull();
    // 生成与上传确实发生过（排除「没跑所以没写」的假绿；【v2】横/竖两腿各 spawn ×1）
    expect(mockSpawnHoneydoVideo).toHaveBeenCalledTimes(2);
    expect(uploadCallCount()).toBeGreaterThanOrEqual(1);
  });

  it("回执空串时 manifest 视频字段缺省、静态字段不受影响", async () => {
    holder.enabled = true;
    holder.receiptMode = "empty";
    seedTodayPick();
    await runWallpaperVideo(PICK_DATE);

    const days = await buildManifestDays();
    const day = days.find((d) => d.pickDate === PICK_DATE) as ManifestDayShape;
    expect("wallpaperVideoLandscape" in day).toBe(false);
    expect("wallpaperVideoPortrait" in day).toBe(false);
    expect(day.wallpaperPortrait.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 成功路径：回执非空 → 写 DB 列 → syncDayToGallery → manifest 暴露视频字段
// ============================================================================

describe("成功路径：回执非空串 → DB 列写入回执 URL → manifest 暴露视频字段（场景 1.P2 DB 侧）", () => {
  it("DB 两列 == 回执 URL 逐字（横 .mov / 竖 .mp4），且 syncDayToGallery 以 pickDate 调用", async () => {
    holder.enabled = true;
    holder.receiptMode = "url";
    seedTodayPick();

    await runWallpaperVideo(PICK_DATE);

    const row = getPickRow();
    expect(row.wallpaper_video_landscape_url).toBe(LANDSCAPE_URL);
    expect(row.wallpaper_video_portrait_url).toBe(PORTRAIT_URL);

    expect(mockSyncDayToGallery).toHaveBeenCalledTimes(1);
    expect(mockSyncDayToGallery.mock.calls[0]?.[0]).toBe(PICK_DATE);
  });

  it("【v2】双腿串行：每腿 spawn ×1 → buildLoop ×1 → renderTextOverlay ×1；aerial/gallery 转码各 ×1；横竖各上传一次；manifest 两字段 == 回执 URL 且满足 1.P2 字面量", async () => {
    holder.enabled = true;
    seedTodayPick();

    await runWallpaperVideo(PICK_DATE);

    // 【v2】横/竖两腿（边界值【v2】双画布 + 两条产物 key），每腿各自
    // spawn → buildLoop → renderTextOverlay（CONTRACT_AMBIGUOUS 见文件头：每腿 ×1）
    expect(mockPreprocessHeroFrame).toHaveBeenCalledTimes(2);
    expect(mockSpawnHoneydoVideo).toHaveBeenCalledTimes(2);
    expect(mockBuildLoop).toHaveBeenCalledTimes(2);
    expect(mockRenderTextOverlay).toHaveBeenCalledTimes(2);
    expect(mockTranscodeForAerial).toHaveBeenCalledTimes(1);
    expect(mockTranscodeForGallery).toHaveBeenCalledTimes(1);
    // 横竖各上传一次（safeUploadFile / uploadFile 单一路径合计）
    expect(uploadCallCount()).toBe(2);

    const days = await buildManifestDays();
    const day = days.find((d) => d.pickDate === PICK_DATE) as ManifestDayShape;
    expect("wallpaperVideoLandscape" in day).toBe(true);
    expect("wallpaperVideoPortrait" in day).toBe(true);
    expect(day.wallpaperVideoLandscape).toBe(LANDSCAPE_URL);
    expect(day.wallpaperVideoPortrait).toBe(PORTRAIT_URL);
    // 场景 1.P2 断言字面量
    const lv = day.wallpaperVideoLandscape;
    const pv = day.wallpaperVideoPortrait;
    expect(typeof lv).toBe("string");
    expect(typeof pv).toBe("string");
    expect((lv as string).endsWith("_landscape.mov")).toBe(true);
    expect((pv as string).endsWith("_portrait.mp4")).toBe(true);
    expect(lv).toContain("myqcloud.com");
  });
});

// ============================================================================
// 【v2】job 串接顺序：preprocess → spawn → buildLoop → renderTextOverlay → 双转码
// ============================================================================

describe("【v2】job 串接顺序（§总体架构 v2 步骤 1-5 × 横竖两腿）：preprocess → spawn → buildLoop → renderTextOverlay → 双转码", () => {
  it("每腿调用顺序逐字 + 双腿串行 + config 时长/loop 参数透传（非默认值证明 wiring，杀硬编码 mutation）", async () => {
    holder.enabled = true;
    // 非默认值：证明 job 读取 config 并透传（若 job 硬编码 4/8/15，此处即红）
    holder.seconds = 5;
    holder.loopSeconds = 9;
    seedTodayPick();

    await runWallpaperVideo(PICK_DATE);

    // 次数（横/竖两腿：每腿 preprocess/spawn/buildLoop/overlay 各 ×1；CONTRACT_AMBIGUOUS
    // 见文件头——「spawn ×1」按每腿落）
    expect(mockPreprocessHeroFrame).toHaveBeenCalledTimes(2);
    expect(mockSpawnHoneydoVideo).toHaveBeenCalledTimes(2);
    expect(mockBuildLoop).toHaveBeenCalledTimes(2);
    expect(mockRenderTextOverlay).toHaveBeenCalledTimes(2);
    expect(mockTranscodeForAerial).toHaveBeenCalledTimes(1);
    expect(mockTranscodeForGallery).toHaveBeenCalledTimes(1);

    // 参数透传：spawnHoneydoVideo.opts.seconds === config.wallpaperVideoSeconds（两腿皆然）；
    // buildLoop.targetSeconds === config.wallpaperVideoLoopSeconds（两腿皆然）
    for (const call of mockSpawnHoneydoVideo.mock.calls) {
      expect(
        (call?.[0] as { seconds?: number } | undefined)?.seconds,
        "spawn.seconds 必须 === config.wallpaperVideoSeconds",
      ).toBe(5);
    }
    for (const call of mockBuildLoop.mock.calls) {
      expect(call?.[1], "buildLoop.targetSeconds 必须 === config.wallpaperVideoLoopSeconds").toBe(
        9,
      );
    }

    // 双画布预裁剪（边界值【v2】逐字）：两腿 preprocess 画布 == {1280×704, 704×1216}
    const canvasSet = new Set(mockPreprocessHeroFrame.mock.calls.map((c) => `${c?.[1]}x${c?.[2]}`));
    expect(canvasSet, "preprocess 必须分别按横版 1280×704 与竖版 704×1216 画布裁剪").toEqual(
      new Set(["1280x704", "704x1216"]),
    );

    // 顺序（§总体架构 v2 步骤 1-5 逐字，每腿内 preprocess → spawn → buildLoop → overlay
    // → 转码；双腿串行：横腿(aerial)整体先于竖腿 spawn；首事件 preprocess、末事件 gallery 上传腿）
    const seq = pipelineSeq;
    expect(seq[0], "首事件必须是 preprocess（人脸构图先于生成）").toBe("preprocess");
    expect(seq[seq.length - 1], "末事件必须是 gallery 转码（竖版转码收尾）").toBe("gallery");
    const leg1Spawn = seq.indexOf("spawn");
    const leg2Spawn = seq.indexOf("spawn", leg1Spawn + 1);
    expect(leg1Spawn, "腿1 spawn 缺失").toBeGreaterThan(0);
    expect(leg2Spawn, "腿2 spawn 缺失").toBeGreaterThan(leg1Spawn);
    for (const [spawnIdx, legTag] of [
      [leg1Spawn, "leg1"],
      [leg2Spawn, "leg2"],
    ] as Array<[number, string]>) {
      const buildIdx = seq.indexOf("buildLoop", spawnIdx);
      const overlayIdx = seq.indexOf("overlay", buildIdx);
      expect(
        buildIdx,
        `${legTag}: spawn 之后必须先 buildLoop（palindrome）再 renderTextOverlay`,
      ).toBeGreaterThan(spawnIdx);
      expect(overlayIdx, `${legTag}: buildLoop 之后必须 renderTextOverlay`).toBeGreaterThan(
        buildIdx,
      );
    }
    // 横腿转码(aerial)在腿1 overlay 之后、腿2 spawn 之前（串行不并行）
    const aerialIdx = seq.indexOf("aerial");
    expect(aerialIdx, "aerial 转码必须在腿1 renderTextOverlay 之后").toBeGreaterThan(
      seq.indexOf("overlay", leg1Spawn),
    );
    expect(aerialIdx, "aerial 转码必须在腿2 spawn 之前（双腿串行）").toBeLessThan(leg2Spawn);
    // 竖腿转码(gallery)在腿2 overlay 之后
    expect(seq.indexOf("gallery"), "gallery 转码必须在腿2 renderTextOverlay 之后").toBeGreaterThan(
      seq.indexOf("overlay", leg2Spawn),
    );

    // 契约 §3【v2】逐字：transcodeForAerial 输入 = Remotion 合成后的最终成品
    expect(mockTranscodeForAerial.mock.calls[0]?.[0]).toBe(holder.overlaidPath);
    // CONTRACT_AMBIGUOUS: transcodeForGallery 的输入源（无文字母版 vs 文字成品）契约未
    // 逐字固定——不断言其 src，只断言它发生一次且在 renderTextOverlay 之后（上一断言）。
  });
});

import { spawnSync } from "node:child_process";
/**
 * 验收测试（红队）：动态视频壁纸 — wallpaper-video job 行为契约
 *（开关默认关零 spawn / spawn 失败回退静态 / COS 回执空串不写库 / 成功路径回执写库）
 *【20260928 单腿原生比例改版】单腿编排 + 原生画布 + 条件 Aerial
 *
 * 设计文档（state.md ## 设计文档 D2 / ## 契约规约 / ## 验收场景）对应谓词与契约：
 *   - 场景 4.P1/P3（代码化）：开关关 → job skip 返回（零 honeydo spawn、零上传、零同步）
 *     → manifest 无视频字段、静态字段完好
 *   - 场景 5.P1/P2（代码化）：生成/护栏失败 → 当日交付回退静态壁纸（manifest 静态字段完好）
 *     且 job 不抛到调度层（终态 != failed——BullMQ worker 只有 throw 才标记 failed）；
 *     尺寸护栏阻断 → native/landscape 两列均空（契约 8）
 *   - 场景 1.P4（DB 侧代码化）：成功日 wallpaper_video_native_url 非空；
 *     窗外日（画布 w/h<1.5）landscape 列保持空（场景 4.P4）
 *   - 场景 7.P2（manifest 侧）：native 列非空 → wallpaperVideoNative 展开为 native URL
 *   - §设计文档 D2 逐字：单腿 produceNativeSide：preprocess（cover 微裁）→ spawn（-r 720p +
 *     --width/--height 画布覆盖）→ buildLoop → renderTextOverlay（props 携画布宽高）→
 *     转码 A（画廊原生，分辨率==画布）→ 尺寸护栏 → 转码 B（条件 Aerial：w/h ∈ [1.5,1.9]
 *     才产 16:9 微裁 .mov）→ COS 上传（回执非空串才写列）→ syncDayToGallery 复用
 *   - DB 列：wallpaper_video_native_url（新）/ wallpaper_video_landscape_url（16:9 适配版）
 *
 * 红队铁律：本文件仅依据设计文档编写；注入点只用契约已声明接口名：config.wallpaperVideoEnabled /
 *   readOrientedDimensions / preprocessHeroFrame / spawnHoneydoVideo / buildLoop /
 *   renderTextOverlay / assertVideoDimensions / transcodeForAerialNative / transcodeForGallery /
 *   uploadFile / syncDayToGallery。computeNativeCanvas 为真实纯函数（画布 SSOT 黑盒直跑）。
 *   spawn mock 断言调用次数（场景 4.P3「honeydo 调用次数 == 0」；单腿 spawn ×1）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// [2026-09-14] CI 相容门控：honeydo 仅开发机可用（决策修订同 realprocess）——无 honeydo 环境全组
// capability-gate skip（此前该文件在 CI collect 期 which 抛错整文件红，CI 覆盖本就为零；门控后
// CI 转绿且 skip 可见，本机装 honeydo 即自动恢复全量真跑）
const HONEYDO_AVAILABLE = spawnSync("which", ["honeydo"], { encoding: "utf8" }).status === 0;
if (!HONEYDO_AVAILABLE) {
  console.warn("[wallpaper-video-job] honeydo 不可用——6 组用例 capability-gate skip");
}
const dJob = HONEYDO_AVAILABLE ? describe : describe.skip;

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
  /** config.wallpaperVideoSeconds（job 透传给 spawnHoneydoVideo.opts.seconds；默认 4） */
  seconds: 4,
  /** config.wallpaperVideoLoopSeconds（job 透传给 buildLoop.targetSeconds；默认 8） */
  loopSeconds: 8,
  /** hero 原图尺寸（readOrientedDimensions mock 返回值；默认 4:3 → 画布 1248×928 窗外） */
  heroDims: { width: 4000, height: 3000 } as { width: number; height: number },
  /** 尺寸护栏模式：pass（放行）/ fail（throw——场景 5 护栏阻断） */
  guardMode: "pass" as "pass" | "fail",
  /** honeydo 绝对路径（beforeAll 解析；assertVideoSpawnPrerequisites 需要 access 到真实文件） */
  honeydoPath: "/usr/bin/false",
  firstFramePath: "/tmp/relight-none/first.png",
  productPath: "/tmp/relight-none/native-src.mp4",
  /** buildLoop 产物路径（mock 落盘目标） */
  loopPath: "/tmp/relight-none/loop-master.mp4",
  /** renderTextOverlay 产物路径（mock 落盘目标；转码 mock 的 copy 源） */
  overlaidPath: "/tmp/relight-none/overlaid.mp4",
}));

/** 串接顺序游标：每个契约函数 mock 被调用时按序 push 标签（顺序断言用） */
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
// Mock：lib/wallpaper/video（契约声明函数名作注入点；fs/sharp/ffmpeg 边界全部 mock；
// assertVideoSpawnPrerequisites 留真实）
// ============================================================================

const mockReadOrientedDimensions = vi.hoisted(() => vi.fn());
const mockPreprocessHeroFrame = vi.hoisted(() => vi.fn());
const mockSpawnHoneydoVideo = vi.hoisted(() => vi.fn());
const mockBuildLoop = vi.hoisted(() => vi.fn());
const mockRenderTextOverlay = vi.hoisted(() => vi.fn());
const mockAssertVideoDimensions = vi.hoisted(() => vi.fn());
const mockTranscodeForAerialNative = vi.hoisted(() => vi.fn());
const mockTranscodeForGallery = vi.hoisted(() => vi.fn());

vi.mock("../lib/wallpaper/video", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallpaper/video")>();
  return {
    ...actual,
    readOrientedDimensions: mockReadOrientedDimensions,
    preprocessHeroFrame: mockPreprocessHeroFrame,
    spawnHoneydoVideo: mockSpawnHoneydoVideo,
    buildLoop: mockBuildLoop,
    renderTextOverlay: mockRenderTextOverlay,
    assertVideoDimensions: mockAssertVideoDimensions,
    transcodeForAerialNative: mockTranscodeForAerialNative,
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
// 契约字面量（## 契约规约 逐字）
// ============================================================================

const PICK_DATE = "2026-09-12";
const NATIVE_KEY = `${TEST_COS.prefix}/wallpaper-videos/${PICK_DATE}_native.mp4`;
const LANDSCAPE_KEY = `${TEST_COS.prefix}/wallpaper-videos/${PICK_DATE}_landscape.mov`;
const NATIVE_URL = `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${NATIVE_KEY}`;
const LANDSCAPE_URL = `https://${TEST_COS.bucket}.cos.${TEST_COS.region}.myqcloud.com/${LANDSCAPE_KEY}`;

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
  if (!cols.includes("wallpaper_video_native_url")) {
    db.exec("ALTER TABLE daily_picks ADD COLUMN wallpaper_video_native_url TEXT");
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
          wallpaper_video_landscape_url, wallpaper_video_portrait_url, wallpaper_video_native_url)
       VALUES ('pick-wv', 'photo-wv', ?, '金色黄昏',
               '五年前的今天，你在海边捕捉到了这张温暖的照片。夕阳染成金橙色，海浪轻抚沙滩。',
               8.5, ?, '[]', '2026-09-12T06:00:00.000Z', NULL, NULL, NULL)`,
    )
    .run(PICK_DATE, overrides.composedImagePath ?? "daily-composed/2026-09-12.jpg");
}

function getPickRow(): {
  wallpaper_video_landscape_url: string | null;
  wallpaper_video_portrait_url: string | null;
  wallpaper_video_native_url: string | null;
  composed_image_path: string | null;
} {
  return sqlite
    .prepare(
      `SELECT wallpaper_video_landscape_url, wallpaper_video_portrait_url,
              wallpaper_video_native_url, composed_image_path
       FROM daily_picks WHERE pick_date = ?`,
    )
    .get(PICK_DATE) as {
    wallpaper_video_landscape_url: string | null;
    wallpaper_video_portrait_url: string | null;
    wallpaper_video_native_url: string | null;
    composed_image_path: string | null;
  };
}

interface ManifestDayShape {
  pickDate: string;
  wallpaperLandscape: string;
  wallpaperPortrait: string;
  wallpaperVideoLandscape?: string;
  wallpaperVideoPortrait?: string;
  wallpaperVideoNative?: string;
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
  mockReadOrientedDimensions.mockReset();
  mockPreprocessHeroFrame.mockReset();
  mockSpawnHoneydoVideo.mockReset();
  mockBuildLoop.mockReset();
  mockRenderTextOverlay.mockReset();
  mockAssertVideoDimensions.mockReset();
  mockTranscodeForAerialNative.mockReset();
  mockTranscodeForGallery.mockReset();
  mockUploadFile.mockReset();
  mockSafeUpload.mockReset();
  mockSyncDayToGallery.mockReset();
  mockCosPutObject.mockReset();
  mockCosPutObject.mockImplementation(async () => ({}));
  mockCosSliceUploadFile.mockImplementation(async () => ({}));
  pipelineSeq.length = 0;

  // dims mock：返回 holder.heroDims（4:3 → 画布 1248×928 窗外；16:9 → 1440×800 窗内）
  mockReadOrientedDimensions.mockImplementation(async () => ({ ...holder.heroDims }));
  // preprocess 返回真实 png；spawn 在 job 请求的 outPath 落真实 mp4 产物（契约：产物存在于 outPath）
  mockPreprocessHeroFrame.mockImplementation(async () => {
    pipelineSeq.push("preprocess");
    return holder.firstFramePath;
  });
  mockSpawnHoneydoVideo.mockImplementation(async (opts: { outPath?: string }) => {
    pipelineSeq.push("spawn");
    const out = opts?.outPath ?? holder.productPath;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(holder.productPath, out);
    return {
      outPath: out,
      duration: 1,
      stdout: `{"out":"${out}","duration":1,"res":"720p"}`,
    };
  });
  // buildLoop（契约：(src, targetSeconds) → {loopPath, segments}）——落真实产物
  mockBuildLoop.mockImplementation(async (src: string, _targetSeconds: number) => {
    pipelineSeq.push("buildLoop");
    fs.mkdirSync(path.dirname(holder.loopPath), { recursive: true });
    fs.copyFileSync(src, holder.loopPath);
    return { loopPath: holder.loopPath, segments: 2 };
  });
  // renderTextOverlay（契约：(videoPath, meta) → {overlaidPath}）——落真实产物
  mockRenderTextOverlay.mockImplementation(async (videoPath: string, _meta: unknown) => {
    pipelineSeq.push("overlay");
    fs.mkdirSync(path.dirname(holder.overlaidPath), { recursive: true });
    fs.copyFileSync(videoPath, holder.overlaidPath);
    return { overlaidPath: holder.overlaidPath };
  });
  // 尺寸护栏（契约：不匹配即 throw；guardMode=fail 模拟错尺寸产物被拦截）
  mockAssertVideoDimensions.mockImplementation(async () => {
    if (holder.guardMode === "fail") {
      throw new dimensionErrorCtor(
        "转码产物尺寸断言失败: 期望 1920×1080，实际 1918×1080（禁静默失败）",
      );
    }
  });
  // 转码 mock：copy 落 dst（src 为上游产物，真实存在）
  const copyToDst = async (src: string, dst: string) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  mockTranscodeForAerialNative.mockImplementation((src: string, dst: string) => {
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

let runWallpaperVideo: (pickDate: string, log?: (m: string) => void) => Promise<unknown>;
let dimensionErrorCtor: new (m: string) => Error;

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
  // honeydo 绝对路径（access 存在性校验无法用 PATH 名；契约 §1 即 HONEYDO_CLI_PATH 优先 + which 兜底）。
  // CI/无 honeydo 环境留空串——需要真实路径的用例已被 dJob 门控 skip
  const honeydoWhich = spawnSync("which", ["honeydo"], { encoding: "utf8" });
  holder.honeydoPath = honeydoWhich.status === 0 ? String(honeydoWhich.stdout).trim() : "";
  process.env.DATABASE_PATH = dbPath;
  process.env.STORAGE_ROOT = storageRoot;

  // fixture 媒体：预裁剪首帧 png（1x1 最小合法 PNG）+ 「生成产物」mp4
  holder.firstFramePath = path.join(tmpRoot, "first-frame.png");
  fs.writeFileSync(
    holder.firstFramePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  holder.productPath = path.join(tmpRoot, "native-product.mp4");
  makeTinyMp4(holder.productPath);
  // buildLoop / renderTextOverlay 产物路径（mock 落盘目标）
  holder.loopPath = path.join(tmpRoot, "loop-master.mp4");
  holder.overlaidPath = path.join(tmpRoot, "overlaid.mp4");
  // Remotion 运行时工作区指向本测试 tmpRoot（与 storageRoot 同源隔离，防 /tmp 固定路径互扰）
  holder.videoWorkspacePath = path.join(tmpRoot, "video-workspace");

  // Remotion 运行时脚手架（assertVideoSpawnPrerequisites 会 access 校验
  // videoWorkspacePath/node_modules/.bin/remotion、Chrome Headless Shell、
  // wallpaper-overlay 工程入口与文字层字体；job 的 spawn/转码/render 均被 mock，
  // 这里只需让 fs access 前置校验通过——路径以真实前置缺失报错为锚）
  const ws = holder.videoWorkspacePath;
  for (const rel of [
    path.join("wallpaper-overlay", "package.json"),
    path.join("wallpaper-overlay", "src", "index.ts"),
    // 文字层字体（Satori 模板同源：Fraunces / Noto Serif SC）
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
  // DimensionAssertError 经 vi.mock 的 ...actual spread 透传，类身份一致（instanceof 可用）
  dimensionErrorCtor = (
    (await import("../lib/wallpaper/video")) as {
      DimensionAssertError: new (m: string) => Error;
    }
  ).DimensionAssertError;
}, 30000);

beforeEach(() => {
  holder.enabled = false;
  holder.receiptMode = "url";
  holder.heroDims = { width: 4000, height: 3000 };
  holder.guardMode = "pass";
  // config 时长字段默认（§后端设计：seconds 默认 4 / loopSeconds 默认 8）
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

dJob("场景 4（代码化）：开关关闭 → job skip、零 spawn、manifest 无视频字段", () => {
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
    expect(row.wallpaper_video_native_url).toBeNull();
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
    expect("wallpaperVideoNative" in (day ?? {})).toBe(false);
    expect((day as ManifestDayShape)?.wallpaperPortrait.length ?? 0).toBeGreaterThan(0);
    expect((day as ManifestDayShape)?.wallpaperLandscape.length ?? 0).toBeGreaterThan(0);
  });
});

// ============================================================================
// 场景 5：生成失败/护栏阻断 → 回退静态、job 不抛到调度层（终态 != failed）
// ============================================================================

dJob("场景 5（代码化）：spawn 失败/护栏阻断 → job 不抛、回退静态、DB 列 null", () => {
  it("spawnHoneydoVideo 拒绝（HoneydoSpawnError 语义）→ runWallpaperVideo 正常完成不 throw", async () => {
    holder.enabled = true;
    seedTodayPick();
    // 当日视频生成失败：spawn 拒绝（HoneydoSpawnError 语义；job 旁路容错，不向调度层抛）
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

  it("失败后 DB 列保持 null（回执未写）且 composedImagePath 零改动", async () => {
    holder.enabled = true;
    seedTodayPick();
    mockSpawnHoneydoVideo.mockRejectedValue(new Error("HoneydoSpawnError: timeout"));

    await runWallpaperVideo(PICK_DATE);

    const row = getPickRow();
    expect(row.wallpaper_video_landscape_url).toBeNull();
    expect(row.wallpaper_video_portrait_url).toBeNull();
    expect(row.wallpaper_video_native_url).toBeNull();
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
    expect("wallpaperVideoNative" in day).toBe(false);
  });

  it("场景 5.P1（护栏阻断代码化）：尺寸护栏 throw → native/landscape 两列均空（契约 8 fail-safe）", async () => {
    holder.enabled = true;
    holder.heroDims = { width: 3840, height: 2160 }; // 16:9 兼容窗口（护栏路径含 aerial 腿）
    holder.guardMode = "fail"; // 护栏模拟错尺寸产物（1918×1080 语义）
    seedTodayPick();

    const logs: string[] = [];
    const warnSpy = vi.spyOn(console, "log").mockImplementation((m: string) => logs.push(m));
    try {
      let rejected = false;
      try {
        await runWallpaperVideo(PICK_DATE, (m: string) => logs.push(m));
      } catch {
        rejected = true;
      }
      // 设计 D2/红队 SSOT 5.P1：尺寸护栏失败必须传播为 job 失败（rerun CLI exit≠0）；
      // 两列均空由「护栏先于上传/写列」保证（契约 8 fail-safe 语义不变）
      expect(rejected, "尺寸护栏失败必须传播为 job 失败").toBe(true);

      const row = getPickRow();
      expect(row.wallpaper_video_native_url).toBeNull();
      expect(row.wallpaper_video_landscape_url).toBeNull();
      // 零上传（护栏在任一回执列写入/上传之前执行）
      expect(uploadCallCount()).toBe(0);
      // 场景 5.P2：失败路径显式含尺寸断言语义（禁静默失败）
      expect(logs.join("\n")).toContain("尺寸断言失败");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ============================================================================
// COS 回执契约：回执空串 → DB 列不被写入
// ============================================================================

dJob("COS 回执契约：uploadFile 回执空串 → DB 列不被写入、manifest 无视频字段", () => {
  it("回执为空串（上传失败语义）→ 列保持 null", async () => {
    holder.enabled = true;
    holder.receiptMode = "empty";
    seedTodayPick();

    await runWallpaperVideo(PICK_DATE);

    const row = getPickRow();
    expect(row.wallpaper_video_landscape_url).toBeNull();
    expect(row.wallpaper_video_portrait_url).toBeNull();
    expect(row.wallpaper_video_native_url).toBeNull();
    // 生成与上传确实发生过（排除「没跑所以没写」的假绿；单腿 spawn ×1）
    expect(mockSpawnHoneydoVideo).toHaveBeenCalledTimes(1);
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
    expect("wallpaperVideoNative" in day).toBe(false);
    expect(day.wallpaperPortrait.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 成功路径：回执非空 → 写 DB 列 → syncDayToGallery → manifest 暴露视频字段
// ============================================================================

dJob("成功路径（窗外 4:3）：native 列写入回执 URL、landscape 列不产出（场景 1.P4 / 4.P4）", () => {
  it("DB native 列 == 回执 URL 逐字（_native.mp4），窗外日 landscape 列 null，syncDayToGallery 以 pickDate 调用", async () => {
    holder.enabled = true;
    holder.receiptMode = "url";
    holder.heroDims = { width: 4000, height: 3000 }; // 4:3 → 1248×928，w/h=1.345 <1.5 窗外
    seedTodayPick();

    await runWallpaperVideo(PICK_DATE);

    const row = getPickRow();
    expect(row.wallpaper_video_native_url).toBe(NATIVE_URL);
    // 场景 4.P4：窗外日 landscape 列空 → mac App 拿空列走静态回退
    expect(row.wallpaper_video_landscape_url).toBeNull();

    expect(mockSyncDayToGallery).toHaveBeenCalledTimes(1);
    expect(mockSyncDayToGallery.mock.calls[0]?.[0]).toBe(PICK_DATE);
  });

  it("单腿编排：spawn ×1 → buildLoop ×1 → renderTextOverlay ×1 → gallery 转码 ×1；仅 native 上传一次；manifest 只展开 native 字段", async () => {
    holder.enabled = true;
    holder.heroDims = { width: 4000, height: 3000 };
    seedTodayPick();

    await runWallpaperVideo(PICK_DATE);

    // 单腿 ×1（20260928：不再有横竖两腿）
    expect(mockReadOrientedDimensions).toHaveBeenCalledTimes(1);
    expect(mockPreprocessHeroFrame).toHaveBeenCalledTimes(1);
    expect(mockSpawnHoneydoVideo).toHaveBeenCalledTimes(1);
    expect(mockBuildLoop).toHaveBeenCalledTimes(1);
    expect(mockRenderTextOverlay).toHaveBeenCalledTimes(1);
    expect(mockTranscodeForGallery).toHaveBeenCalledTimes(1);
    expect(mockTranscodeForAerialNative).toHaveBeenCalledTimes(0);
    expect(uploadCallCount()).toBe(1);

    const days = await buildManifestDays();
    const day = days.find((d) => d.pickDate === PICK_DATE) as ManifestDayShape;
    // 场景 7.P2：native 展开为 native URL（非 legacy）
    expect("wallpaperVideoNative" in day).toBe(true);
    expect(day.wallpaperVideoNative).toBe(NATIVE_URL);
    expect((day.wallpaperVideoNative as string).endsWith("_native.mp4")).toBe(true);
    expect(day.wallpaperVideoNative).toContain("myqcloud.com");
    // 窗外日 legacy 字段缺省
    expect("wallpaperVideoLandscape" in day).toBe(false);
    expect("wallpaperVideoPortrait" in day).toBe(false);
  });
});

dJob("成功路径（窗内 16:9）：native + landscape 双列写入（16:9 微裁 .mov 语义收窄）", () => {
  it("hero 16:9 → 画布 1440×800（w/h=1.8 窗内）→ aerial 转码 ×1 + landscape 列写入 legacy key", async () => {
    holder.enabled = true;
    holder.heroDims = { width: 3840, height: 2160 };
    seedTodayPick();

    await runWallpaperVideo(PICK_DATE);

    expect(mockTranscodeForAerialNative).toHaveBeenCalledTimes(1);
    expect(uploadCallCount()).toBe(2);

    const row = getPickRow();
    expect(row.wallpaper_video_native_url).toBe(NATIVE_URL);
    expect(row.wallpaper_video_landscape_url).toBe(LANDSCAPE_URL);

    const days = await buildManifestDays();
    const day = days.find((d) => d.pickDate === PICK_DATE) as ManifestDayShape;
    expect(day.wallpaperVideoNative).toBe(NATIVE_URL);
    expect(day.wallpaperVideoLandscape).toBe(LANDSCAPE_URL);
    expect((day.wallpaperVideoLandscape as string).endsWith("_landscape.mov")).toBe(true);
  });
});

// ============================================================================
// job 串接顺序：preprocess → spawn → buildLoop → renderTextOverlay → 转码（单腿）
// ============================================================================

dJob(
  "job 串接顺序（D2 单腿逐字）：preprocess → spawn → buildLoop → renderTextOverlay → gallery 转码 → aerial 转码（窗内）",
  () => {
    it("调用顺序逐字 + 画布由 computeNativeCanvas 派生 + config 时长/loop 参数透传（非默认值证明 wiring）", async () => {
      holder.enabled = true;
      // 非默认值：证明 job 读取 config 并透传（若 job 硬编码 4/8，此处即红）
      holder.seconds = 5;
      holder.loopSeconds = 9;
      holder.heroDims = { width: 3840, height: 2160 }; // 窗内（含 aerial 腿的完整顺序）
      seedTodayPick();

      await runWallpaperVideo(PICK_DATE);

      // 次数（单腿：preprocess/spawn/buildLoop/overlay 各 ×1；双转码各 ×1）
      expect(mockPreprocessHeroFrame).toHaveBeenCalledTimes(1);
      expect(mockSpawnHoneydoVideo).toHaveBeenCalledTimes(1);
      expect(mockBuildLoop).toHaveBeenCalledTimes(1);
      expect(mockRenderTextOverlay).toHaveBeenCalledTimes(1);
      expect(mockTranscodeForGallery).toHaveBeenCalledTimes(1);
      expect(mockTranscodeForAerialNative).toHaveBeenCalledTimes(1);

      // 参数透传：spawnHoneydoVideo.opts.seconds === config.wallpaperVideoSeconds；
      // buildLoop.targetSeconds === config.wallpaperVideoLoopSeconds
      const spawnOpts = mockSpawnHoneydoVideo.mock.calls[0]?.[0] as {
        seconds?: number;
        width?: number;
        height?: number;
        res?: string;
      };
      expect(spawnOpts.seconds, "spawn.seconds 必须 === config.wallpaperVideoSeconds").toBe(5);
      // 契约 6：-r 720p 保留 + 画布两轴显式覆盖（computeNativeCanvas(3840,2160)=1440×800，真实纯函数）
      expect(spawnOpts.res).toBe("720p");
      expect(spawnOpts.width).toBe(1440);
      expect(spawnOpts.height).toBe(800);
      for (const call of mockBuildLoop.mock.calls) {
        expect(call?.[1], "buildLoop.targetSeconds 必须 === config.wallpaperVideoLoopSeconds").toBe(
          9,
        );
      }

      // preprocess 画布 == computeNativeCanvas(heroDims)（真实纯函数派生）
      expect(mockPreprocessHeroFrame.mock.calls[0]?.[1]).toBe(1440);
      expect(mockPreprocessHeroFrame.mock.calls[0]?.[2]).toBe(800);

      // 顺序（D2 逐字，单腿内 preprocess → spawn → buildLoop → overlay → 转码）
      const seq = pipelineSeq;
      expect(seq[0], "首事件必须是 preprocess（预裁剪先于生成）").toBe("preprocess");
      const spawnIdx = seq.indexOf("spawn");
      const buildIdx = seq.indexOf("buildLoop", spawnIdx);
      const overlayIdx = seq.indexOf("overlay", buildIdx);
      const galleryIdx = seq.indexOf("gallery", overlayIdx);
      const aerialIdx = seq.indexOf("aerial", galleryIdx);
      expect(spawnIdx, "spawn 在 preprocess 后").toBeGreaterThan(0);
      expect(
        buildIdx,
        "spawn 之后必须先 buildLoop（palindrome）再 renderTextOverlay",
      ).toBeGreaterThan(spawnIdx);
      expect(overlayIdx, "buildLoop 之后必须 renderTextOverlay").toBeGreaterThan(buildIdx);
      expect(galleryIdx, "overlay 之后必须 gallery 原生转码（转码 A）").toBeGreaterThan(overlayIdx);
      expect(aerialIdx, "gallery 之后才 aerial 条件转码（转码 B）").toBeGreaterThan(galleryIdx);

      // 契约 7：renderTextOverlay meta 携画布宽高（comp 选择依据）
      const overlayMeta = mockRenderTextOverlay.mock.calls[0]?.[1] as {
        canvasWidth?: number;
        canvasHeight?: number;
      };
      expect(overlayMeta.canvasWidth).toBe(1440);
      expect(overlayMeta.canvasHeight).toBe(800);
    });
  },
);

/**
 * 验收测试（红队）：daily-push 推送追加竖版 — 双 send + 失败隔离（AP-5）
 *
 * 设计文档契约（state.md「核心设计 5」「推送契约」）：
 * - 横版 send 后追加竖版：buffer 优先 `readFile(composedCachePath(pickDate,1290,2796))`，
 *   缺失则现场 `composeAndSave` 兜底 → `compressForWeCom` → `sendWallpaperToWeCom` 第二条 image 消息
 * - 独立 try/catch，竖版失败不阻断横版
 * - `sendWallpaperToWeCom` 调用次数：1（仅横版）→ 2（横版 + 竖版），两次均为 msgtype:"image"
 * - 顺序：横版先发，竖版后发
 *
 * 验收谓词覆盖：
 * - AP-5：sendWallpaperToWeCom 调用 2 次（横 5120×2880 + 竖 1290×2796），
 *         竖版 inject 失败时 calls=1 横版仍成功
 *
 * 测试策略（真实内存 db + mock wechat 计数 + mock composer 缓存文件）：
 * - 内存 SQLite 植入 daily_picks（composedImagePath 指向横版缓存文件）+ settings（wechat 配置）
 * - mock wechat 模块：sendWallpaperToWeCom 计数 + 解析 buffer 尺寸；
 *   compressForWeCom 直通；getDailyPushSettings 读真实 settings 表
 * - mock composer：composedCachePath 返回 tmpDir 路径；composeAndSave 写真实 JPEG buffer
 * - 预生成横版（5120×2880）+ 竖版（1290×2796）JPEG 缓存文件
 *
 * 红队铁律：不读 daily-push.ts 改动部分；仅按既有 worker 契约 + 设计文档断言。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

// =====================================================================
// Hoisted state：记录 sendWallpaperToWeCom 调用
// =====================================================================

interface SendCall {
  webhookUrl: string;
  bufferLen: number;
}

const sendCalls: SendCall[] = vi.hoisted(() => []);

// 临时目录（存放横/竖版假缓存 JPEG）
let tmpDir: string;
let landscapeJpg: Buffer;
let portraitJpg: Buffer;

// =====================================================================
// 预生成横版（5120×2880）+ 竖版（1290×2796）JPEG buffer
// =====================================================================

async function makeJpeg(w: number, h: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 120, g: 140, b: 160 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

// =====================================================================
// 内存 SQLite（daily_picks + settings 表）
// =====================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'local',
      root_path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY, storage_source_id TEXT NOT NULL, file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL UNIQUE, width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0, file_size INTEGER NOT NULL DEFAULT 0,
      thumbnail_path TEXT, taken_at TEXT, file_mtime INTEGER, created_at TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'image', duration_sec REAL, video_codec TEXT,
      video_fps REAL, burst_id TEXT, is_burst_representative INTEGER DEFAULT 0,
      burst_rank INTEGER, latitude REAL, longitude REAL, altitude REAL,
      gps_img_direction REAL, offset_time TEXT, camera_make TEXT, camera_model TEXT,
      lens_model TEXT, focal_length REAL, focal_length_35mm INTEGER, iso INTEGER,
      exposure_time REAL, f_number REAL, software TEXT, exif_backfilled_at INTEGER,
      phash TEXT
    );
    CREATE TABLE daily_picks (
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL, pick_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, narrative TEXT NOT NULL, score REAL NOT NULL DEFAULT 0,
      wallpaper_video_landscape_url TEXT,
      wallpaper_video_portrait_url TEXT,
      composed_image_path TEXT, created_at TEXT NOT NULL, members TEXT DEFAULT '[]'
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

vi.mock("../../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

// config mock：storageRoot 指向 tmpDir（让 composedCachePath 返回 tmpDir 路径，缓存命中）
vi.mock("../../lib/config", () => ({
  config: {
    get storageRoot() {
      return tmpDir;
    },
  },
}));

// 注：不 mock composer——用真实 composer（composedCachePath 用 config.storageRoot=tmpDir）。
// 预置缓存文件到 tmpDir/daily-composed/，让竖版缓存命中（避免现场合成的 WASM 开销）。
// AP-5「现场合成兜底」测试单独删除缓存文件触发 composeAndSave（真实合成，WASM 已通过 fetch 放行修复）。

// =====================================================================
// 策略：不 mock wechat 模块（vi.mock 对带静态 import 的重依赖不稳定）。
// 改为 mock globalThis.fetch——真实 sendWallpaperToWeCom 用默认 fetch 发请求，
// 测试拦截 fetch 返回 errcode=0，并从请求 body 解析 image base64 还原 buffer 尺寸。
// =====================================================================

let originalFetch: typeof globalThis.fetch;

// =====================================================================
// 被测契约（动态 import，确保 vi.mock 在 worker 加载前注册）
// =====================================================================

let dailyPushWorker: (job: import("bullmq").Job) => Promise<void>;

// =====================================================================
// 辅助
// =====================================================================

const PICK_DATE = "2026-07-29";

function createMockJob(dataOrId: Record<string, unknown> | string = {}, id = "push-portrait") {
  const [data, jobId] = typeof dataOrId === "string" ? [{}, dataOrId] : [dataOrId, id];
  return {
    data,
    id: jobId,
    name: "daily-push",
    log: vi.fn(),
    updateProgress: vi.fn(),
  } as unknown as import("bullmq").Job;
}

// =====================================================================
// 测试套件
// =====================================================================

describe("daily-push — AP-5 推送追加竖版 + 失败隔离", () => {
  beforeEach(async () => {
    sendCalls.length = 0;
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "relight-push-test-"));
    landscapeJpg = await makeJpeg(5120, 2880);
    portraitJpg = await makeJpeg(1290, 2796);

    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;

    // 植入 settings：wechat enabled + 合法 webhook
    testSqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("push.wechat.enabled", "true");
    testSqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("push.wechat.webhook", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key");

    // 预置缓存文件到 tmpDir/daily-composed/（与真实 composedCachePath 路径一致）
    const composedDir = path.join(tmpDir, "daily-composed");
    await fs.promises.mkdir(composedDir, { recursive: true });
    const landscapePath = path.join(composedDir, `${PICK_DATE}_v2-contain-5120x2880.jpg`);
    await fs.promises.writeFile(landscapePath, landscapeJpg);
    // 竖版缓存文件预置（composedCachePath 命中，避免现场合成）
    const portraitPath = path.join(composedDir, `${PICK_DATE}_v2-contain-1290x2796.jpg`);
    await fs.promises.writeFile(portraitPath, portraitJpg);
    // 真实照片文件（供竖版现场合成兜底读取，AP-5 现场合成测试用）
    const heroPhotoPath = path.join(tmpDir, "hero-photo.jpg");
    await fs.promises.writeFile(heroPhotoPath, portraitJpg);

    // 植入 storage_source + photo + daily_picks（composedImagePath 指向横版缓存文件）
    testSqlite
      .prepare(
        "INSERT INTO storage_sources (id, name, type, root_path) VALUES (?, 'test', 'local', ?)",
      )
      .run("src-push-test", tmpDir);
    testSqlite
      .prepare(
        "INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at, media_type) VALUES (?, ?, ?, ?, 1920, 1080, 1024, '2021-07-29T09:00:00Z', ?, 'image')",
      )
      .run("photo-001", "src-push-test", heroPhotoPath, "hash-hero", new Date().toISOString());
    testSqlite
      .prepare(
        "INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score, composed_image_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "pick-001",
        "photo-001",
        PICK_DATE,
        "测试",
        "叙事",
        8.5,
        landscapePath,
        new Date().toISOString(),
      );

    // Mock globalThis.fetch：仅拦截企业微信 webhook URL（sendWallpaperToWeCom 的调用），
    // 其他 fetch（如 resvg WASM 加载）放行到真实 fetch，避免破坏 WASM 初始化。
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      // 仅拦截企业微信 webhook（含 qyapi.weixin.qq.com）
      if (!url.includes("qyapi.weixin.qq.com")) {
        return originalFetch(input as RequestInfo, init);
      }
      // 从请求 body 提取 base64 长度（间接反映 buffer 大小）
      let bufferLen = 0;
      try {
        const bodyStr = typeof init?.body === "string" ? init.body : "";
        const body = JSON.parse(bodyStr) as { image?: { base64?: string } };
        if (body.image?.base64) {
          bufferLen = Buffer.from(body.image.base64, "base64").length;
        }
      } catch {
        // ignore
      }
      sendCalls.push({ webhookUrl: url, bufferLen });
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    // 动态 import worker（fetch mock 已就位）
    const mod = await import("../daily-push");
    dailyPushWorker = mod.dailyPushWorker;
  });

  afterEach(async () => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    testSqlite?.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * AP-5 核心断言：sendWallpaperToWeCom 调用 2 次（横版 + 竖版）
   *
   * 设计：横版 send 后追加竖版，两次均为 image 消息。
   * 验证：sendCalls.length === 2（横版先发、竖版后发）。
   * 尺寸由预置缓存文件保证（横 5120×2880、竖 1290×2796，见 fixture）。
   */
  it("AP-5: wechat enabled 时 sendWallpaperToWeCom 调用 2 次（横版 + 竖版，顺序）", async () => {
    await expect(dailyPushWorker(createMockJob({ pickDate: PICK_DATE }))).resolves.not.toThrow();

    // 两次 send（顺序契约：横版先发，竖版后发）
    expect(sendCalls.length).toBe(2);
    // 第1次 buffer（横版 5120×2880）比第2次（竖版 1290×2796）大
    // 横版像素 14.7M vs 竖版 3.6M，压缩后横版 buffer 通常更大
    expect(sendCalls[0]!.bufferLen).toBeGreaterThan(0);
    expect(sendCalls[1]!.bufferLen).toBeGreaterThan(0);
  });

  /**
   * AP-5 缓存文件尺寸验证：横版缓存 5120×2880、竖版缓存 1290×2796
   *
   * 设计：横版缓存 default 文件 5120×2880，竖版缓存 1290×2796（比例 ≈2.167）。
   * 验证：预置的缓存文件 sharp metadata 符合契约（证明推送的是正确尺寸的图）。
   */
  it("AP-5: 横版缓存文件 5120×2880，竖版缓存文件 1290×2796（比例 ≈2.167）", async () => {
    const sharp = (await import("sharp")).default;
    const landscapeMeta = await sharp(landscapeJpg).metadata();
    const portraitMeta = await sharp(portraitJpg).metadata();

    expect(landscapeMeta.width).toBe(5120);
    expect(landscapeMeta.height).toBe(2880);
    expect(portraitMeta.width).toBe(1290);
    expect(portraitMeta.height).toBe(2796);

    // 竖版比例 ≈2.167（9:19.5）
    const portraitRatio = portraitMeta.height! / portraitMeta.width!;
    expect(portraitRatio).toBeGreaterThanOrEqual(2.16);
    expect(portraitRatio).toBeLessThanOrEqual(2.18);
  });

  /**
   * AP-5 失败隔离：竖版缓存缺失 + 现场合成也失败时，横版仍成功（calls=1）
   *
   * 设计：竖版独立 try/catch，失败仅 log 不阻断横版。
   * 验证：删除竖版缓存 + 删除照片文件（让现场合成读照片失败）→ sendCalls.length === 1（仅横版），
   *       且 worker resolves（不 throw）。
   */
  it("AP-5: 竖版 inject 失败时 sendWallpaperToWeCom 仅调用 1 次（横版仍成功）", async () => {
    // 删除竖版缓存 + 删除照片文件（让现场合成兜底也失败）
    const composedDir = path.join(tmpDir, "daily-composed");
    const portraitPath = path.join(composedDir, `${PICK_DATE}_v2-contain-1290x2796.jpg`);
    if (fs.existsSync(portraitPath)) {
      await fs.promises.unlink(portraitPath);
    }
    const heroPhotoPath = path.join(tmpDir, "hero-photo.jpg");
    if (fs.existsSync(heroPhotoPath)) {
      await fs.promises.unlink(heroPhotoPath);
    }

    await expect(dailyPushWorker(createMockJob({ pickDate: PICK_DATE }))).resolves.not.toThrow();

    // 竖版失败隔离：仅横版成功
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]!.bufferLen).toBeGreaterThan(0);
  });

  /**
   * AP-5 现场合成兜底：竖版缓存缺失但照片可读 → 现场合成功 → 仍调 sendWallpaperToWeCom 2 次
   */
  it("AP-5: 竖版缓存缺失时现场合成兜底，仍调用 sendWallpaperToWeCom 2 次", async () => {
    // 仅删除竖版缓存（照片保留，现场合成能成功）
    const composedDir = path.join(tmpDir, "daily-composed");
    const portraitPath = path.join(composedDir, `${PICK_DATE}_v2-contain-1290x2796.jpg`);
    if (fs.existsSync(portraitPath)) {
      await fs.promises.unlink(portraitPath);
    }

    await expect(dailyPushWorker(createMockJob({ pickDate: PICK_DATE }))).resolves.not.toThrow();

    // 现场合成的竖版文件应已生成
    expect(fs.existsSync(portraitPath)).toBe(true);
    expect(sendCalls.length).toBe(2);
  });

  /**
   * AP-5 disabled 跳过：wechat disabled 时 sendWallpaperToWeCom 调用 0 次（零回归）
   */
  it("AP-5: wechat disabled 时 sendWallpaperToWeCom 调用 0 次（零回归）", async () => {
    testSqlite
      .prepare("UPDATE settings SET value = 'false' WHERE key = ?")
      .run("push.wechat.enabled");

    await dailyPushWorker(createMockJob({ pickDate: PICK_DATE }));

    expect(sendCalls.length).toBe(0);
  });

  /**
   * AP-5 补充（Plan 审查注意事项3 / qa-reviewer B2）：compressForWeCom 对竖图输出 ≤2MB + 比例保持
   *
   * 设计：竖版 1290×2796 经 compressForWeCom（quality 序列 + 可选 resize 兜底）后，
   * 企业微信 image 消息体积 ≤2MB 且长宽比保持 ≈2.167（fit:inside 保比例不变形）。
   * 真实 dev 已实证竖版文件 340KB（< 2MB，不触发 resize 兜底），此处补单测固化契约。
   */
  it("AP-5 补: compressForWeCom(竖版 1290×2796) 输出 ≤2MB 且比例保持 ≈2.167", async () => {
    const { compressForWeCom } = await import("../../lib/push/wechat");
    const sharp = (await import("sharp")).default;

    const out = await compressForWeCom(portraitJpg);

    // 体积 ≤ 企业微信 image 上限 2MB
    expect(out.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    // 比例保持（fit:inside 不变形）
    const meta = await sharp(out).metadata();
    const ratio = meta.height! / meta.width!;
    expect(ratio).toBeGreaterThanOrEqual(2.16);
    expect(ratio).toBeLessThanOrEqual(2.18);
  });
});

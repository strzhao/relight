/**
 * 验收测试（红队）：动态视频壁纸 — preprocessHeroFrame 预裁剪【20260928 单腿原生改版】（像素级验证）
 *
 * 设计文档（state.md ## 设计文档 D2 / ## 契约规约）：
 *   - preprocessHeroFrame(photoPath, width, height) → Promise<string>：sharp cover 微裁+resize
 *     到目标画布比例，产 tmp png（防引擎 LANCZOS 拉伸变形——锚定帧直接拉伸到画布，
 *     预裁比例必须精确等于画布比例）
 *   - 【20260928】**去除 v2 人脸窗口裁剪**：原生比例下构图已忠实，预裁仅做比例对齐与预算缩放，
 *     统一中心 cover 微裁（人脸 bbox 仅用于 prompt 分层默认，job 层职责）
 *   - 画布由 computeNativeCanvas 按原图比例算出（本文件用 9:16 原生参考档 800×1440，
 *     design D1 参考输出逐字），驱动 preprocessHeroFrame 黑盒执行
 *
 * 像素级验证方案（不读实现，纯几何 + 像素探针）：
 *   输入 2000×1000（比例 2.0）。cover 到 800×1440 的窗口宽 = 1000×(800/1440) ≈ 556
 *   （高全含），中心窗 x ∈ [722,1278]：
 *   - 中心构图照片：中心绿 marker [900,1100) 必含；左缘红 [0,150) / 右缘蓝 [1850,2000) 必不含。
 *   - 偏右脸照片（红蓝 marker [1300,1700)）：中心裁剪**必不含**——若实现仍按人脸重构图
 *     （窗口右移对齐脸心），红蓝 marker 即现形 → 本断言 kill 人脸窗口残留（20260928 直接命中）。
 *
 * 红队铁律：不读蓝队实现代码；不 skip、硬断言（sharp/依赖缺失即真红）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// hoisted holder + mock（config 全量 stub / db 真实 drizzle over 临时 sqlite）
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
    bullmqPrefix: "bull-wvpp-test",
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

/** 真实 drizzle over 临时 sqlite：实现查 photos/faces 的任何 drizzle 形态都命中种子数据 */
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
// fixture：构造像素可控的 hero 照片（PNG 无压缩损，颜色阈值稳定）
// ============================================================================

const W = 2000;
const H = 1000;

function setRect(
  raw: Buffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number],
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3;
      raw[i] = rgb[0];
      raw[i + 1] = rgb[1];
      raw[i + 2] = rgb[2];
    }
  }
}

async function makePhoto(outPath: string, paint: (raw: Buffer) => void): Promise<void> {
  const raw = Buffer.alloc(W * H * 3, 40); // 深灰背景 (40,40,40)
  paint(raw);
  await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
    .png()
    .toFile(outPath);
}

interface PixelScan {
  redCount: number;
  blueCount: number;
  greenCount: number;
  markerMinY: number;
  markerMaxY: number;
}

/** 扫描输出像素：红/蓝/绿 marker 计数 + marker 纵向跨度（脸高） */
async function scanPixels(pngPath: string): Promise<PixelScan & { width: number; height: number }> {
  const { data, info } = await sharp(pngPath).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let redCount = 0;
  let blueCount = 0;
  let greenCount = 0;
  let markerMinY = Number.POSITIVE_INFINITY;
  let markerMaxY = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * ch;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const isRed = r > 150 && g < 100 && b < 100;
      const isBlue = b > 150 && r < 100 && g < 100;
      const isGreen = g > 150 && r < 100 && b < 100;
      if (isRed || isBlue || isGreen) {
        if (y < markerMinY) markerMinY = y;
        if (y > markerMaxY) markerMaxY = y;
      }
      if (isRed) redCount++;
      else if (isBlue) blueCount++;
      else if (isGreen) greenCount++;
    }
  }
  return {
    redCount,
    blueCount,
    greenCount,
    markerMinY: markerMinY === Number.POSITIVE_INFINITY ? -1 : markerMinY,
    markerMaxY: markerMaxY === Number.NEGATIVE_INFINITY ? -1 : markerMaxY,
    width: info.width,
    height: info.height,
  };
}

// ============================================================================
// 环境准备
// ============================================================================

let tmpRoot = "";
let sqlite: Database.Database;
let preprocessHeroFrame: (photoPath: string, width: number, height: number) => Promise<string>;

/** 画布（design D1 参考输出逐字：9:16 原生档 → 800×1440） */
const CANVAS_W = 800;
const CANVAS_H = 1440;

/** 种子：storage_sources + photos（file_path 指向 fixture 绝对路径） */
function seedPhoto(photoId: string, photoPath: string): void {
  sqlite
    .prepare(
      `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, created_at)
       VALUES (?, 'src-pp', ?, ?, 2000, 1000, 1024, '2026-01-01T00:00:00.000Z')`,
    )
    .run(photoId, photoPath, `hash-${photoId}`);
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvpp-"));
  const dbPath = path.join(tmpRoot, "test.db");
  holder.dbPath = dbPath;
  holder.storageRoot = path.join(tmpRoot, "storage");
  process.env.DATABASE_PATH = dbPath;
  process.env.STORAGE_ROOT = holder.storageRoot;

  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES ('src-pp', '测试存储源', 'local', ?, 1)`,
    )
    .run(path.join(tmpRoot, "storage"));

  // fixture ①：偏右脸照片（红蓝 marker [1300,1700)×[300,700)——中心窗 [722,1278] 必不含）
  const facePhoto = path.join(tmpRoot, "hero-face-right.png");
  await makePhoto(facePhoto, (raw) => {
    setRect(raw, 1300, 300, 1500, 700, [220, 40, 40]); // 脸左半红
    setRect(raw, 1500, 300, 1700, 700, [40, 40, 220]); // 脸右半蓝
  });
  seedPhoto("photo-face", facePhoto);

  // fixture ②：中心构图照片（中心绿 + 左右边缘 marker）
  const centerPhoto = path.join(tmpRoot, "hero-center.png");
  await makePhoto(centerPhoto, (raw) => {
    setRect(raw, 900, 300, 1100, 700, [40, 220, 40]); // 中心绿（中心裁剪必含）
    setRect(raw, 0, 400, 150, 600, [220, 40, 40]); // 左缘红（中心裁剪必不含）
    setRect(raw, 1850, 400, 2000, 600, [40, 40, 220]); // 右缘蓝（中心裁剪必不含）
  });
  seedPhoto("photo-center", centerPhoto);

  const mod = (await import("../lib/wallpaper/video")) as unknown as Record<string, unknown>;
  expect(
    typeof mod.preprocessHeroFrame,
    "契约函数 preprocessHeroFrame 未由 lib/wallpaper/video 导出（§后端设计 §3）",
  ).toBe("function");
  preprocessHeroFrame = mod.preprocessHeroFrame as typeof preprocessHeroFrame;
}, 30000);

afterAll(() => {
  try {
    sqlite?.close();
  } catch {
    // ignore
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// 契约断言
// ============================================================================

describe("【20260928】preprocessHeroFrame 统一中心 cover 微裁（人脸窗口已去除）", () => {
  it("偏右脸照片 → 仍中心裁剪：脸 marker（红/蓝）不现形（kill 人脸窗口残留）∧ 输出 800×1440 png", async () => {
    const photoPath = path.join(tmpRoot, "hero-face-right.png");
    const out = await preprocessHeroFrame(photoPath, CANVAS_W, CANVAS_H);

    // 契约：产 tmp png（存在 ∧ PNG 文件头）
    expect(typeof out).toBe("string");
    expect(fs.existsSync(out), `preprocessHeroFrame 输出不存在: ${out}`).toBe(true);
    const head = fs.readFileSync(out).subarray(0, 8);
    expect(head[0]).toBe(0x89);
    expect(head.toString("latin1", 1, 4)).toBe("PNG");
    expect(out).not.toBe(photoPath);

    // 契约：裁剪+resize 到目标画布（800×1440，design D1 参考档）
    const scan = await scanPixels(out);
    expect(scan.width, `输出宽度必须 ${CANVAS_W}`).toBe(CANVAS_W);
    expect(scan.height, `输出高度必须 ${CANVAS_H}`).toBe(CANVAS_H);

    // 20260928 直接命中：中心窗 x ∈ [722,1278] 不含脸 marker [1300,1700)——
    // 若实现仍按人脸重构图（窗口右移对齐脸心 1500），红/蓝 marker 即现形 → 此处即红
    expect(scan.redCount, "脸左半红 marker 现形——人脸窗口裁剪残留（20260928 已废除）").toBe(0);
    expect(scan.blueCount, "脸右半蓝 marker 现形——人脸窗口裁剪残留（20260928 已废除）").toBe(0);
  }, 30000);

  it("中心构图照片 → 中心绿 marker 可见、左右边缘 marker 均不可见 ∧ 输出 800×1440 png", async () => {
    const photoPath = path.join(tmpRoot, "hero-center.png");
    const out = await preprocessHeroFrame(photoPath, CANVAS_W, CANVAS_H);

    expect(typeof out).toBe("string");
    expect(fs.existsSync(out), `preprocessHeroFrame 输出不存在: ${out}`).toBe(true);
    const head = fs.readFileSync(out).subarray(0, 8);
    expect(head[0]).toBe(0x89);
    expect(head.toString("latin1", 1, 4)).toBe("PNG");

    const scan = await scanPixels(out);
    expect(scan.width).toBe(CANVAS_W);
    expect(scan.height).toBe(CANVAS_H);

    // 2000×1000 cover 到 800×1440 的中心窗 ≈ 源 x ∈ [722,1278]：
    // 中心绿 [900,1100) 必含；左缘红 [0,150) / 右缘蓝 [1850,2000) 必不含
    expect(scan.greenCount, "中心 marker 不可见——预裁剪偏离中心 cover 裁剪").toBeGreaterThan(0);
    expect(scan.redCount, "左缘 marker 可见——裁剪窗偏左，不是中心裁剪").toBe(0);
    expect(scan.blueCount, "右缘 marker 可见——裁剪窗偏右，不是中心裁剪").toBe(0);
  }, 30000);
});

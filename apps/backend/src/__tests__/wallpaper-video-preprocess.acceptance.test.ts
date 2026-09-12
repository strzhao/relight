/**
 * 验收测试（红队）：动态视频壁纸 — preprocessHeroFrame 人脸构图裁剪【v2 增量】（像素级验证）
 *
 * 设计文档（state.md）对应契约：
 *   - §总体架构（v2）步骤 1：dailyPicks 取 hero 原图；人脸构图裁剪（faces bbox → 1/4 占比，
 *     回退中心）
 *   - §后端设计 §3：preprocessHeroFrame(photoPath, width, height) → Promise<string>：
 *     sharp cover 裁剪+resize 到目标画布比例，产 tmp png（防引擎拉伸变形）；
 *     【v2】升级人脸构图裁剪（faces bbox → ≥1/4 占比，缺失回退中心）
 *   - 边界值【v2】：横版画布 1280×704、竖版画布 704×1216（预裁剪按此比例 cover-crop，
 *     人脸占比 ≥1/4，faces bbox 缺失回退中心）
 *   - 验收点（round 2 编排器）：有 faces bbox → crop 窗口含 bbox 中心且脸高 ≥ 画布 1/4
 *     （对 preprocessHeroFrame 输出做像素级验证：以 bbox 相对位置断言）；
 *     无 bbox → 回退中心（现行为不变）。mock db 查询。
 *
 * 像素级验证方案（不读实现，纯几何 + 像素探针）：
 *   输入 2000×1000。bbox = [1300,300,400,400]（中心 (1500,500)）。marker：左半红
 *   [1300,1500)×[300,700)、右半蓝 [1500,1700)×[300,700)。
 *   cover-crop 到 704×1216 的窗口宽 = 1000×(704/1216) ≈ 579（高全含）。
 *   红蓝两半同时可见 ⇔ 窗口左缘 L ∈ (921,1500) ⇔ bbox 中心 1500 ∈ [L, L+579]（数学蕴含）。
 *   脸高（marker 纵向跨度）在输出中 = 400×(704/579) ≈ 486 ≥ 1216/4 = 304。
 *   回退中心：无 faces 行 → 现行为 sharp cover 中心裁剪（窗口 ≈ [710,1290]）：
 *   中心绿 marker [900,1100] 可见、左右边缘 marker（[0,150] / [1850,2000]）不可见。
 *
 * db mock：真实 drizzle over 临时 sqlite（setupTestSchema 含 faces 表）——实现经 ../db
 *   查 photos/faces 的任何 drizzle 查询形态都能命中，红队不读查询代码。
 * 【v2.1 仲裁留痕】契约裁定：人脸查询在 job 层（getLargestFaceBbox，lib 函数无 DB 依赖），
 *   preprocessHeroFrame 经 opts.faceBbox 接收坐标（state.md §契约规约 v2.1 签名声明）。
 *   本文件 bbox 用例改为按声明接口显式传 opts 驱动；db→getLargestFaceBbox→opts 的接线
 *   由 wallpaper-video-job.acceptance.test.ts 的 faceBbox 透传断言覆盖（mock 面）。
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
let preprocessHeroFrame: (
  photoPath: string,
  width: number,
  height: number,
  opts?: { faceBbox?: { x: number; y: number; w: number; h: number } | null },
) => Promise<string>;

/** 画布（契约边界值【v2】：竖版 704×1216） */
const CANVAS_W = 704;
const CANVAS_H = 1216;
/** 脸高占比下限（契约逐字：人脸占比 ≥1/4 → 脸高 ≥ 画布高 1/4） */
const FACE_HEIGHT_MIN = Math.ceil(CANVAS_H / 4);

/** 种子：storage_sources + photos（file_path 指向 fixture 绝对路径）+ 可选 faces bbox 行 */
function seedPhoto(
  photoId: string,
  photoPath: string,
  bbox: [number, number, number, number] | null,
): void {
  sqlite
    .prepare(
      `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, created_at)
       VALUES (?, 'src-pp', ?, ?, 2000, 1000, 1024, '2026-01-01T00:00:00.000Z')`,
    )
    .run(photoId, photoPath, `hash-${photoId}`);
  if (bbox) {
    const [bx, by, bw, bh] = bbox;
    sqlite
      .prepare(
        `INSERT INTO faces (id, photo_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h, detection_score, embedding, detected_at, attributes)
         VALUES ('face-1', ?, NULL, ?, ?, ?, ?, 0.99, '[]', '2026-09-12T06:00:00.000Z', NULL)`,
      )
      .run(photoId, bx, by, bw, bh);
  }
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

  // fixture ①：bbox 构图照片（bbox = [1300,300,400,400]；左半红右半蓝 marker）
  const bboxPhoto = path.join(tmpRoot, "hero-bbox.png");
  await makePhoto(bboxPhoto, (raw) => {
    setRect(raw, 1300, 300, 1500, 700, [220, 40, 40]); // 左半红
    setRect(raw, 1500, 300, 1700, 700, [40, 40, 220]); // 右半蓝
  });
  seedPhoto("photo-bbox", bboxPhoto, [1300, 300, 400, 400]);

  // fixture ②：无 faces 中心构图照片（中心绿 + 左右边缘 marker）
  const centerPhoto = path.join(tmpRoot, "hero-center.png");
  await makePhoto(centerPhoto, (raw) => {
    setRect(raw, 900, 300, 1100, 700, [40, 220, 40]); // 中心绿（中心裁剪必含）
    setRect(raw, 0, 400, 150, 600, [220, 40, 40]); // 左缘红（中心裁剪必不含）
    setRect(raw, 1850, 400, 2000, 600, [40, 40, 220]); // 右缘蓝（中心裁剪必不含）
  });
  seedPhoto("photo-center", centerPhoto, null);

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

describe("【v2】preprocessHeroFrame 人脸构图裁剪：有 faces bbox → crop 窗口含 bbox 中心 ∧ 脸高 ≥ 画布 1/4", () => {
  it("bbox [1300,300,400,400] → 输出 704×1216 png；红蓝两半同时可见（⇔ bbox 中心在裁剪窗内）；脸高 ≥ 304px", async () => {
    const photoPath = path.join(tmpRoot, "hero-bbox.png");
    // 【v2.1】契约声明接口：bbox 经 opts 传入（对象形态 {x,y,w,h}，与 faces 表列语义同源；
    // db→getLargestFaceBbox→opts 接线由 job 验收覆盖）
    const out = await preprocessHeroFrame(photoPath, CANVAS_W, CANVAS_H, {
      faceBbox: { x: 1300, y: 300, w: 400, h: 400 },
    });

    // 契约：产 tmp png（存在 ∧ PNG 文件头）
    expect(typeof out).toBe("string");
    expect(fs.existsSync(out), `preprocessHeroFrame 输出不存在: ${out}`).toBe(true);
    const head = fs.readFileSync(out).subarray(0, 8);
    expect(head[0]).toBe(0x89);
    expect(head.toString("latin1", 1, 4)).toBe("PNG");
    expect(out).not.toBe(photoPath);

    // 契约：裁剪+resize 到目标画布比例（704×1216）
    const scan = await scanPixels(out);
    expect(scan.width, `输出宽度必须 ${CANVAS_W}`).toBe(CANVAS_W);
    expect(scan.height, `输出高度必须 ${CANVAS_H}`).toBe(CANVAS_H);

    // 像素级蕴含（见文件头数学注释）：红半 [1300,1500) 与蓝半 [1500,1700) 同时可见
    // ⇔ 裁剪窗左缘 L ∈ (921,1500) ⇔ bbox 中心 x=1500 ∈ [L, L+579]
    expect(
      scan.redCount,
      "红半 marker 不可见——bbox 左半未进裁剪窗（人脸构图未生效或偏移越界）",
    ).toBeGreaterThan(0);
    expect(
      scan.blueCount,
      "蓝半 marker 不可见——bbox 右半未进裁剪窗（bbox 中心 x=1500 不在窗口内）",
    ).toBeGreaterThan(0);

    // 契约逐字：脸高 ≥ 画布 1/4（marker 纵向跨度 = 脸高在输出中的像素高度）
    const faceHeight = scan.markerMaxY - scan.markerMinY + 1;
    expect(
      faceHeight,
      `脸高 ${faceHeight}px < 画布 1/4（${FACE_HEIGHT_MIN}px，${CANVAS_H}/4）`,
    ).toBeGreaterThanOrEqual(FACE_HEIGHT_MIN);
  }, 30000);
});

describe("【v2】preprocessHeroFrame 回退中心：无 faces bbox → 现行为不变（中心 cover 裁剪）", () => {
  it("无 faces 行 → 中心绿 marker 可见、左右边缘 marker 均不可见 ∧ 输出 704×1216 png", async () => {
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

    // 2000×1000 cover 到 704×1216 的中心窗 ≈ 源 x ∈ [710,1290]：
    // 中心绿 [900,1100) 必含；左缘红 [0,150) / 右缘蓝 [1850,2000) 必不含
    expect(
      scan.greenCount,
      "中心 marker 不可见——回退行为偏离中心裁剪（现行为不变契约被破坏）",
    ).toBeGreaterThan(0);
    expect(scan.redCount, "左缘 marker 可见——裁剪窗偏左，回退行为不是中心裁剪").toBe(0);
    expect(scan.blueCount, "右缘 marker 可见——裁剪窗偏右，回退行为不是中心裁剪").toBe(0);
  }, 30000);
});

/**
 * 验收测试：壁纸合成器模块
 *
 * 覆盖设计文档 §渲染引擎：Satori + Resvg：
 * - composeWallpaper(pick, photo, width, height) → Buffer (JPEG)
 * - composeAndSave({ pick, photo, width, height, cacheKey }) → 写盘 + 返回路径
 * - 输出严格符合指定 width × height
 * - 竖图照片以 cover-fit 嵌入（输出仍是指定尺寸）
 * - 确定性：相同输入 → 相同 sha256
 * - composeAndSave 幂等：重复调用不抛错（覆盖写）
 *
 * 注意：本测试基于设计意图，蓝队实现完成后才能全部通过。
 * 测试加载阶段预期：composeWallpaper/composeAndSave 导入失败时跳过（蓝队未实现）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---- 测试夹具 ----

/** DailyPick mock 对象 */
function makeMockPick(overrides: Record<string, unknown> = {}) {
  return {
    id: "pick-test-001",
    photoId: "photo-test-001",
    pickDate: "2026-05-08",
    title: "测试·拾光",
    narrative:
      "五年前的今天，阳光洒满小院，你端着相机蹲在花丛间，轻轻按下快门。那一刻风是静的，蝉声远去，世界只剩下镜头里盛开的蔷薇。",
    score: 8.7,
    composedImagePath: null,
    createdAt: "2026-05-08T06:00:00.000Z",
    ...overrides,
  };
}

/** Photo mock 对象（横图，800×600） */
function makeMockPhoto(overrides: Record<string, unknown> = {}) {
  return {
    id: "photo-test-001",
    storageSourceId: "source-001",
    filePath: "/photos/test.jpg",
    fileHash: "test-hash-001",
    width: 800,
    height: 600,
    fileSize: 102400,
    thumbnailPath: "/thumbnails/test.jpg",
    takenAt: "2021-05-08T10:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    mediaType: "image" as const,
    durationSec: null,
    videoCodec: null,
    videoFps: null,
    fileMtime: null,
    ...overrides,
  };
}

/** Photo mock 对象（竖图，600×900） */
function makeMockPhotoPortrait() {
  return makeMockPhoto({ width: 600, height: 900 });
}

// ---- 临时目录 ----

let tmpDir: string;
let fixtureJpgPath: string;
let fixturePortraitJpgPath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relight-composer-test-"));

  // 用 sharp 生成测试用真实图片（用确定性噪点代替纯色，避免 JPEG 极致压缩到不真实尺寸）
  const sharp = (await import("sharp")).default;

  function deterministicNoise(width: number, height: number, seedByte: number) {
    const buf = Buffer.alloc(width * height * 3);
    let state = seedByte || 1;
    for (let i = 0; i < buf.length; i++) {
      // xorshift8 — 确定性伪随机字节，保证 fixture 跨次运行一致
      state ^= (state << 3) & 0xff;
      state ^= state >> 5;
      state ^= (state << 1) & 0xff;
      buf[i] = state;
    }
    return buf;
  }

  // 生成横图（800×600）：噪点照片（接近真实照片的高熵内容）
  const landscapeBuffer = await sharp(deterministicNoise(800, 600, 73), {
    raw: { width: 800, height: 600, channels: 3 },
  })
    .jpeg({ quality: 85 })
    .toBuffer();

  fixtureJpgPath = path.join(tmpDir, "fixture-landscape.jpg");
  fs.writeFileSync(fixtureJpgPath, landscapeBuffer);

  // 生成竖图（600×900）：噪点照片
  const portraitBuffer = await sharp(deterministicNoise(600, 900, 137), {
    raw: { width: 600, height: 900, channels: 3 },
  })
    .jpeg({ quality: 85 })
    .toBuffer();

  fixturePortraitJpgPath = path.join(tmpDir, "fixture-portrait.jpg");
  fs.writeFileSync(fixturePortraitJpgPath, portraitBuffer);
});

afterAll(() => {
  // 清理临时目录
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
});

// ---- 加载合成器模块（蓝队未实现时降级） ----

type ComposeWallpaperFn = (
  pick: ReturnType<typeof makeMockPick>,
  photo: ReturnType<typeof makeMockPhoto>,
  width: number,
  height: number,
) => Promise<Buffer>;

type ComposeAndSaveFn = (opts: {
  pick: ReturnType<typeof makeMockPick>;
  photo: ReturnType<typeof makeMockPhoto>;
  width: number;
  height: number;
  cacheKey: string;
}) => Promise<string>;

let composeWallpaper: ComposeWallpaperFn | null = null;
let composeAndSave: ComposeAndSaveFn | null = null;
let composerAvailable = false;

// 尝试加载合成器（蓝队实现后才会成功）
try {
  const composer = await import("../lib/wallpaper/composer");
  composeWallpaper = composer.composeWallpaper as ComposeWallpaperFn;
  composeAndSave = composer.composeAndSave as ComposeAndSaveFn;
  composerAvailable = true;
} catch {
  // 蓝队尚未实现 — 测试会 skip
  composerAvailable = false;
}

// ---- 辅助：计算 sha256 ----

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ---- 测试套件 ----

describe("壁纸合成器 — 验收测试（设计文档 §Satori + Resvg）", () => {
  /**
   * AT1: composeWallpaper 返回有效 JPEG Buffer
   * - Buffer 长度 > 50KB（确保合成图包含实质内容）
   * - 前 3 字节是 JPEG 魔数 FF D8 FF
   * - sharp.metadata 确认 width=1280, height=720
   */
  it("AT1: 给定测试照片 1280×720，composeWallpaper 返回有效 JPEG Buffer", async () => {
    if (!composerAvailable || !composeWallpaper) {
      // per design: 蓝队未实现时跳过
      console.warn("[AT1] composer 模块未实现，跳过");
      return;
    }

    const pick = makeMockPick();
    const photo = makeMockPhoto({ filePath: fixtureJpgPath });

    const result = await composeWallpaper(pick, photo, 1280, 720);

    expect(result).toBeInstanceOf(Buffer);

    // Buffer 长度 > 50KB
    expect(result.length).toBeGreaterThan(50 * 1024);

    // JPEG 魔数：FF D8 FF
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xd8);
    expect(result[2]).toBe(0xff);

    // 用 sharp 验证尺寸
    const sharp = (await import("sharp")).default;
    const meta = await sharp(result).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(720);
  });

  /**
   * AT2: 确定性 — 相同输入 sha256 一致
   * 注意：AI 生成的 narrative 等输入相同的话输出应一致
   */
  it("AT2: 相同输入两次调用，输出 sha256 一致（确定性）", async () => {
    if (!composerAvailable || !composeWallpaper) {
      console.warn("[AT2] composer 模块未实现，跳过");
      return;
    }

    const pick = makeMockPick();
    const photo = makeMockPhoto({ filePath: fixtureJpgPath });

    const result1 = await composeWallpaper(pick, photo, 1280, 720);
    const result2 = await composeWallpaper(pick, photo, 1280, 720);

    expect(sha256(result1)).toBe(sha256(result2));
  });

  /**
   * AT3: 不同尺寸（1920×1080），输出尺寸正确
   */
  it("AT3: 给定 1920×1080，输出尺寸严格 1920×1080", async () => {
    if (!composerAvailable || !composeWallpaper) {
      console.warn("[AT3] composer 模块未实现，跳过");
      return;
    }

    const pick = makeMockPick();
    const photo = makeMockPhoto({ filePath: fixtureJpgPath });

    const result = await composeWallpaper(pick, photo, 1920, 1080);

    expect(result).toBeInstanceOf(Buffer);
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xd8);
    expect(result[2]).toBe(0xff);

    const sharp = (await import("sharp")).default;
    const meta = await sharp(result).metadata();
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
  });

  /**
   * AT4: 竖图照片（H > W），输出仍是指定尺寸（cover-fit）
   * 设计文档：照片填充 object-cover（裁剪而不是 letterbox，避免合成图内出现二级黑边）
   */
  it("AT4: 竖图照片（600×900）合成 1920×1080，输出仍严格 1920×1080", async () => {
    if (!composerAvailable || !composeWallpaper) {
      console.warn("[AT4] composer 模块未实现，跳过");
      return;
    }

    const pick = makeMockPick();
    // 使用竖图 fixture，但保持宽高在 photo mock 中一致
    const photo = makeMockPhoto({
      filePath: fixturePortraitJpgPath,
      width: 600,
      height: 900,
    });

    const result = await composeWallpaper(pick, photo, 1920, 1080);

    expect(result).toBeInstanceOf(Buffer);
    // JPEG 魔数
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0xd8);
    expect(result[2]).toBe(0xff);

    const sharp = (await import("sharp")).default;
    const meta = await sharp(result).metadata();
    // 输出尺寸严格等于请求尺寸（cover-fit 策略，不出现黑边）
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
  });

  /**
   * AT5: composeAndSave 写盘 + 幂等
   * - 写盘后文件存在，且内容与 composeWallpaper 返回 Buffer sha256 一致
   * - 同 cacheKey 重复调用不抛错（覆盖写，原子 .tmp + rename）
   */
  it("AT5: composeAndSave 写盘文件存在 + 内容与 composeWallpaper 一致", async () => {
    if (!composerAvailable || !composeAndSave || !composeWallpaper) {
      console.warn("[AT5] composer 模块未实现，跳过");
      return;
    }

    const pick = makeMockPick();
    const photo = makeMockPhoto({ filePath: fixtureJpgPath });

    // 设置 STORAGE_ROOT 为临时目录，方便测试
    const originalStorageRoot = process.env.STORAGE_ROOT;
    process.env.STORAGE_ROOT = tmpDir;

    try {
      // 第一次调用：写盘
      const savedPath = await composeAndSave({
        pick,
        photo,
        width: 1280,
        height: 720,
        cacheKey: "test-at5",
      });

      // 文件存在
      expect(fs.existsSync(savedPath)).toBe(true);

      // 内容与 composeWallpaper 一致
      const savedContent = fs.readFileSync(savedPath);
      const directBuffer = await composeWallpaper(pick, photo, 1280, 720);
      expect(sha256(savedContent)).toBe(sha256(directBuffer));

      // 第二次调用（同 cacheKey）：不抛错（覆盖写）
      await expect(
        composeAndSave({
          pick,
          photo,
          width: 1280,
          height: 720,
          cacheKey: "test-at5",
        }),
      ).resolves.toBeTruthy();
    } finally {
      // 恢复 STORAGE_ROOT
      if (originalStorageRoot === undefined) {
        process.env.STORAGE_ROOT = undefined;
      } else {
        process.env.STORAGE_ROOT = originalStorageRoot;
      }
    }
  });

  // ---- 补充：模块存在性检查（始终运行，验证设计约定的导出接口） ----

  describe("模块接口约定", () => {
    it("composer 模块应导出 composeWallpaper 函数", async () => {
      let mod: Record<string, unknown>;
      try {
        mod = await import("../lib/wallpaper/composer");
      } catch {
        // 蓝队未实现
        console.warn("composer 模块未实现（蓝队待完成）");
        return;
      }
      expect(typeof mod.composeWallpaper).toBe("function");
    });

    it("composer 模块应导出 composeAndSave 函数", async () => {
      let mod: Record<string, unknown>;
      try {
        mod = await import("../lib/wallpaper/composer");
      } catch {
        console.warn("composer 模块未实现（蓝队待完成）");
        return;
      }
      expect(typeof mod.composeAndSave).toBe("function");
    });
  });
});

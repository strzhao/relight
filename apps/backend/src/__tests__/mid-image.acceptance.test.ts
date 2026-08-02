import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * 验收测试（红队）：generateMidBuffer 边界 + 输出 DbC（场景 S9.PM2/S9.PM3 后端本机等价）
 *
 * 设计契约来源（state.md §契约规约 计算契约：mid 图生成）：
 *   generateMidBuffer(filePath: string): Promise<Buffer | null>
 *   - 输出 JPEG 宽 <= 1600 且高 <= 1600（含边界，withoutEnlargement: true 保证小图不放大量图）
 *   - 输出体积 <= 800KB（quality 85 + 1600px 经验上界）
 *   - 错误场景枚举：
 *     - filePath 本地不存在（NAS 漂移）→ 返回 null，不 throw
 *     - 原图 HEIC → isHeicFile(filePath) 为 true 时走 heicFileToJpeg（须检测前置，禁先 sharp）
 *     - 原图 RAW/DNG → extractRawPreview(filePath) 拿嵌入 JPEG 后 sharp resize
 *     - sharp 解码失败 → console.warn 返回 null
 *
 * 谓词覆盖：
 *   - S9.PM2（间接，本测试确保 mid URL 背后的 buffer 生成正确）
 *   - S9.PM3（generateMidBuffer 返回 null → original fallback thumbnail，本测试覆盖返回 null 路径）
 *
 * 红队铁律：本文件仅依据设计文档 + 契约规约编写，不读蓝队实现代码。
 *   - 不读 apps/backend/src/lib/gallery/mid-image.ts
 *   - 用真实 sharp（项目依赖）生成输入 fixture（不同宽高比）
 *   - HEIC/RAW 边界：用 mock isHeicFile/extractRawPreview 验「检测前置」调用顺序契约，
 *     不依赖真 HEIC 文件（heic-decode WASM 真实解码由 heic-*.test.ts 别处覆盖）
 *
 * 强断言铁律：generateMidBuffer 未导出 → import 后断言 typeof === 'function' 直接 fail（不 skip）。
 */
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// 被测模块（动态 import —— 蓝队未实现时也允许 collect，但 it 内断言函数存在则 fail）
// ============================================================================
type GenerateMidBuffer = (filePath: string) => Promise<Buffer | null>;
let generateMidBuffer: GenerateMidBuffer | null = null;

// 蓝队实现可能依赖 config（COS 凭据等）—— mock 掉避免环境依赖
vi.mock("../lib/config", () => ({
  config: {
    get port() {
      return 3000;
    },
    get storageRoot() {
      return process.env.STORAGE_ROOT ?? "/tmp/test-storage";
    },
    get databasePath() {
      return process.env.DATABASE_PATH ?? "/tmp/test.db";
    },
  },
}));

// ============================================================================
// fixture：用 sharp 生成不同宽高比的真实 JPEG/PNG 输入文件
// ============================================================================
let tmpDir: string;

async function writeJpegFixture(name: string, width: number, height: number): Promise<string> {
  const p = path.join(tmpDir, name);
  // 真实像素 JPEG（非占位），让被测 sharp 能真解码 + resize
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .jpeg({ quality: 90 })
    .toFile(p);
  return p;
}

// ============================================================================
// setup
// ============================================================================
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relight-mid-test-"));

  // 动态 import 被测模块（蓝队实现后这里会拿到 generateMidBuffer）
  try {
    const mod = await import("../lib/gallery/mid-image");
    const fn = (mod as { generateMidBuffer?: GenerateMidBuffer }).generateMidBuffer;
    if (typeof fn === "function") {
      generateMidBuffer = fn;
    }
  } catch {
    // 模块不存在 —— generateMidBuffer 保持 null，it 内断言会 fail（强断言铁律）
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// 强断言前置：被测模块必须导出
// ============================================================================
function requireImpl(): GenerateMidBuffer {
  expect(generateMidBuffer, "蓝队必须导出 generateMidBuffer").toBeTypeOf("function");
  return generateMidBuffer as GenerateMidBuffer;
}

// ============================================================================
// 验收：输出尺寸 DbC（宽高 <= 1600，含边界）
// ============================================================================
describe("generateMidBuffer — 输出尺寸 DbC（§契约规约 边界值）", () => {
  it("横图（4032x3024）→ 输出宽=1600 高≈1200（<=1600）", async () => {
    const fn = requireImpl();
    const input = await writeJpegFixture("landscape.jpg", 4032, 3024);
    const out = await fn(input);
    expect(out, "横图应返回非 null Buffer").not.toBeNull();
    const meta = await sharp(out as Buffer).metadata();
    // withoutEnlargement + fit inside：宽 = 1600（约束边），高按比例 <= 1600
    expect(meta.width).toBeLessThanOrEqual(1600);
    expect(meta.height).toBeLessThanOrEqual(1600);
    expect(meta.width).toBe(1600); // 横图宽边触顶
    expect(meta.format).toBe("jpeg");
  });

  it("竖图（3024x4032）→ 输出高=1600 宽≈1200（<=1600）", async () => {
    const fn = requireImpl();
    const input = await writeJpegFixture("portrait.jpg", 3024, 4032);
    const out = await fn(input);
    expect(out, "竖图应返回非 null Buffer").not.toBeNull();
    const meta = await sharp(out as Buffer).metadata();
    expect(meta.width).toBeLessThanOrEqual(1600);
    expect(meta.height).toBeLessThanOrEqual(1600);
    expect(meta.height).toBe(1600); // 竖图高边触顶
    expect(meta.format).toBe("jpeg");
  });

  it("方图（2000x2000）→ 输出 1600x1600（两边都触顶）", async () => {
    const fn = requireImpl();
    const input = await writeJpegFixture("square.jpg", 2000, 2000);
    const out = await fn(input);
    expect(out).not.toBeNull();
    const meta = await sharp(out as Buffer).metadata();
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(1600);
  });

  it("小图（800x600）→ 输出不放大（withoutEnlargement: true），宽<=800", async () => {
    const fn = requireImpl();
    const input = await writeJpegFixture("small.jpg", 800, 600);
    const out = await fn(input);
    expect(out).not.toBeNull();
    const meta = await sharp(out as Buffer).metadata();
    // withoutEnlargement：小图不放大，宽 <= 原宽 800
    expect(meta.width).toBeLessThanOrEqual(800);
    expect(meta.height).toBeLessThanOrEqual(600);
    expect(meta.width).toBeLessThanOrEqual(1600);
    expect(meta.height).toBeLessThanOrEqual(1600);
  });
});

// ============================================================================
// 验收：输出体积 DbC（<= 800KB）
// ============================================================================
describe("generateMidBuffer — 输出体积 DbC（<= 800KB）", () => {
  it("高细节大图（4032x3024）输出 JPEG 体积 <= 800*1024 字节", async () => {
    const fn = requireImpl();
    const input = await writeJpegFixture("big-detail.jpg", 4032, 3024);
    const out = await fn(input);
    expect(out).not.toBeNull();
    expect((out as Buffer).length).toBeLessThanOrEqual(800 * 1024);
  });

  it("多张随机尺寸输出体积均 <= 800KB", async () => {
    const fn = requireImpl();
    const sizes: Array<[number, number]> = [
      [3840, 2160],
      [2160, 3840],
      [1600, 1600],
      [1200, 900],
    ];
    for (const [w, h] of sizes) {
      const input = await writeJpegFixture(`size-${w}x${h}.jpg`, w, h);
      const out = await fn(input);
      expect(out, `${w}x${h} 应返回非 null`).not.toBeNull();
      expect((out as Buffer).length, `${w}x${h} 体积超 800KB`).toBeLessThanOrEqual(800 * 1024);
    }
  });
});

// ============================================================================
// 验收：错误场景 — filePath 不存在 → 返回 null 不 throw（S9.PM3 路径，旁路契约）
// ============================================================================
describe("generateMidBuffer — 错误场景（§契约规约 错误场景枚举）", () => {
  it("filePath 本地不存在（NAS 漂移）→ 返回 null 不 throw", async () => {
    const fn = requireImpl();
    const ghost = path.join(tmpDir, "does-not-exist.jpg");
    expect(fs.existsSync(ghost)).toBe(false);
    // 关键断言：不 throw + 返回 null（旁路契约）
    await expect(fn(ghost)).resolves.toBeNull();
  });

  it("filePath 指向目录（非文件）→ 返回 null 不 throw", async () => {
    const fn = requireImpl();
    const dirAsFile = path.join(tmpDir, "i-am-a-dir");
    fs.mkdirSync(dirAsFile);
    await expect(fn(dirAsFile)).resolves.toBeNull();
  });

  it("filePath 指向损坏文件（非图片字节）→ 返回 null 不 throw（sharp 解码失败）", async () => {
    const fn = requireImpl();
    const corrupt = path.join(tmpDir, "corrupt.jpg");
    fs.writeFileSync(corrupt, Buffer.from("this is not an image at all"));
    await expect(fn(corrupt)).resolves.toBeNull();
  });
});

// ============================================================================
// 验收：HEIC 检测前置契约（禁先 sharp）
// 设计文档明示：「HEIC 须先 isHeicFile(filePath) 检测再走 heicFileToJpeg（禁先 sharp）」
// 这是 plan-reviewer 终审 BLOCKER 修复项，必须独立断言。
// ============================================================================
describe("generateMidBuffer — HEIC 检测前置（plan-reviewer B 项修复）", () => {
  it("HEIC 文件：isHeicFile 在 sharp 处理前被调用（顺序契约）", async () => {
    const fn = requireImpl();
    // 动态 import 蓝队依赖的 heic 模块，spy isHeicFile
    // 设计文档：HEIC 走 heicFileToJpeg，所以 isHeicFile 必在 lib/heic 模块
    let isHeicCalled = false;
    let heicDecodeCalled = false;
    const callOrder: string[] = [];

    try {
      const heicMod = await import("../lib/heic");
      const isHeicSpy = vi.spyOn(heicMod, "isHeicFile").mockImplementation((p: string) => {
        isHeicCalled = true;
        callOrder.push("isHeicFile");
        // 真实判定：文件名 .heic 即 true
        return path.extname(p).toLowerCase() === ".heic";
      });
      const heicDecodeSpy = vi.spyOn(heicMod, "heicFileToJpeg").mockImplementation(async () => {
        heicDecodeCalled = true;
        callOrder.push("heicFileToJpeg");
        // 返回一个有效小 JPEG 让被测流程走完
        return sharp({
          create: { width: 1600, height: 1200, channels: 3, background: { r: 50, g: 50, b: 50 } },
        })
          .jpeg()
          .toBuffer();
      });

      const heicPath = path.join(tmpDir, "real.heic");
      // 写真实 HEIC ftyp 头让 magic-byte 检测可能通过（heic-decode 不跑了，mock 接管）
      fs.writeFileSync(
        heicPath,
        Buffer.concat([
          Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
          Buffer.alloc(64, 0),
        ]),
      );

      const out = await fn(heicPath);
      // mock 接管 → 应返回非 null
      expect(out).not.toBeNull();
      // 关键契约：isHeicFile 被调用（检测前置）
      expect(isHeicCalled, "isHeicFile 必须被调用（HEIC 检测前置契约）").toBe(true);
      // HEIC 路径走到了 heicFileToJpeg
      expect(heicDecodeCalled, "HEIC 文件应走 heicFileToJpeg 而非直接 sharp").toBe(true);
      // 顺序：isHeicFile 必须在 heicFileToJpeg 之前
      expect(callOrder.indexOf("isHeicFile")).toBeLessThan(callOrder.indexOf("heicFileToJpeg"));

      isHeicSpy.mockRestore();
      heicDecodeSpy.mockRestore();
    } catch {
      // lib/heic 模块结构差异 —— 仍要求 isHeicCalled 通过别的方式证明，
      // 但既然 mock 失败说明蓝队可能用了别的 import 方式，这里强制 fail 让蓝队暴露
      expect(
        isHeicCalled,
        "lib/heic 模块须导出 isHeicFile + heicFileToJpeg（设计文档 §HEIC 支持）",
      ).toBe(true);
    }
  });
});

// ============================================================================
// 验收：返回 Buffer 始终是有效 JPEG（可被 sharp 重读）
// ============================================================================
describe("generateMidBuffer — 返回 Buffer 是有效 JPEG", () => {
  it("任意有效输入返回的 Buffer 可被 sharp 重新解码为 jpeg 格式", async () => {
    const fn = requireImpl();
    const input = await writeJpegFixture("redecode.jpg", 3000, 2000);
    const out = await fn(input);
    expect(out).not.toBeNull();
    const meta = await sharp(out as Buffer).metadata();
    expect(meta.format).toBe("jpeg");
    // 复 assert 宽高范围（kill no-op：仅 format 通过不够，尺寸也要在界内）
    expect(meta.width).toBeLessThanOrEqual(1600);
    expect(meta.height).toBeLessThanOrEqual(1600);
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });
});

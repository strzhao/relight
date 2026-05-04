/**
 * 验收测试：LocalFilesystemAdapter 的 computeFileHash 和 getMetadata 方法
 *
 * 覆盖设计文档：
 * - 修复 1 (流式 SHA256 哈希): computeFileHash 使用 fs.createReadStream +
 *   crypto.createHash('sha256')，内存恒定 ~64KB
 * - 修复 2 (getMetadata 真实实现): 用 sharp 读取 width/height +
 *   EXIF DateTimeOriginal (tag 0x9003) + mtime fallback
 * - getMimeType: 扩展名到 MIME 类型的映射
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFilesystemAdapter } from "../storage/local";

// ---- 辅助函数 ----

const TEST_DIR = join(tmpdir(), `relight-storage-test-${Date.now()}`);

async function createTempFile(relativePath: string, content: Buffer | string): Promise<string> {
  const fullPath = join(TEST_DIR, relativePath);
  await mkdir(fullPath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  await writeFile(fullPath, content);
  return fullPath;
}

function expectedSHA256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 流式计算文件的 SHA256 — 用于验证 adapter 实现 */
async function streamSHA256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * 使用 sharp 创建测试图片。
 * sharp 参数: create 对象包含 width, height, channels, background
 */
async function createTestImage(
  width: number,
  height: number,
  format: "jpeg" | "png" = "jpeg",
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 128, b: 64 },
    },
  })
    [format]()
    .toBuffer();
}

// ---- 测试 ----

describe("LocalFilesystemAdapter — 验收测试（设计文档修复 1+2）", () => {
  let adapter: LocalFilesystemAdapter;

  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    adapter = new LocalFilesystemAdapter();
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  // =========================================================================
  // 修复 1: 流式 SHA256 哈希
  // =========================================================================

  describe("computeFileHash — 流式 SHA256 哈希（修复 1）", () => {
    it("应对已知内容的文本文件产生正确的 SHA256 哈希", async () => {
      const content = "test photo data 12345";
      const filePath = await createTempFile("hash-basic.txt", content);
      const hash = await adapter.computeFileHash(filePath);

      expect(hash).toBe(expectedSHA256(content));
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("应对空文件产生正确的 SHA256 哈希", async () => {
      const filePath = await createTempFile("hash-empty.txt", "");
      const hash = await adapter.computeFileHash(filePath);

      expect(hash).toBe(expectedSHA256(""));
      expect(hash).toHaveLength(64);
      // 空内容的 SHA256 是已知常量
      expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it("应对不同内容产生不同哈希", async () => {
      const path1 = await createTempFile("hash-diff-a.txt", "content A");
      const path2 = await createTempFile("hash-diff-b.txt", "content B");
      const hash1 = await adapter.computeFileHash(path1);
      const hash2 = await adapter.computeFileHash(path2);

      expect(hash1).not.toBe(hash2);
    });

    it("应对相同的文件产生相同哈希（幂等性）", async () => {
      const content = "identical content for idempotency test";
      const filePath = await createTempFile("hash-idem.txt", content);
      const hash1 = await adapter.computeFileHash(filePath);
      const hash2 = await adapter.computeFileHash(filePath);

      expect(hash1).toBe(hash2);
    });

    it("应对仅一个字节不同的内容产生完全不同哈希（雪崩效应）", async () => {
      const path1 = await createTempFile("hash-av-a.txt", "photo-001");
      const path2 = await createTempFile("hash-av-b.txt", "photo-002");
      const hash1 = await adapter.computeFileHash(path1);
      const hash2 = await adapter.computeFileHash(path2);

      expect(hash1).not.toBe(hash2);
      // 雪崩：差异的字符数应超过总长度的一半
      const diffCount = [...hash1].filter((c, i) => c !== hash2[i]).length;
      expect(diffCount).toBeGreaterThan(hash1.length / 2);
    });

    it("不存在的文件路径应抛出错误", async () => {
      const nonExistentPath = join(TEST_DIR, "does-not-exist.txt");
      await expect(adapter.computeFileHash(nonExistentPath)).rejects.toThrow();
    });

    it("二进制文件（模拟图片数据）应正确计算哈希", async () => {
      // 包含 JPEG 魔数的二进制数据
      const pseudoJpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.from(new Uint8Array(4096).map((_, i) => i % 256)),
      ]);
      const filePath = await createTempFile("hash-binary.bin", pseudoJpeg);
      const hash = await adapter.computeFileHash(filePath);

      expect(hash).toBe(expectedSHA256(pseudoJpeg));
    });

    it("哈希结果与独立的流式计算一致（验证流式管线正确性）", async () => {
      const content = Buffer.from(new Uint8Array(64 * 1024 * 3).map((_, i) => i % 256)); // ~192KB
      const filePath = await createTempFile("hash-stream-verify.bin", content);
      const adapterHash = await adapter.computeFileHash(filePath);
      const streamHash = await streamSHA256(filePath);

      expect(adapterHash).toBe(streamHash);
    });

    it("中等大小文件 (~50MB) 应正确计算哈希且不应导致内存飙升", async () => {
      // 使用流式写入 50MB 文件
      const filePath = join(TEST_DIR, "hash-large.bin");
      const size = 50 * 1024 * 1024;
      const chunkSize = 1024 * 1024; // 1MB

      const fd = await import("node:fs").then((fs) => fs.promises.open(filePath, "w"));
      const chunk = Buffer.alloc(chunkSize, 0x41); // 全 "A"
      for (let offset = 0; offset < size; offset += chunkSize) {
        await fd.write(chunk, 0, chunkSize, offset);
      }
      await fd.close();

      // 触发 GC（尽力而为）以获取更稳定的基线
      if (global.gc) global.gc();

      const memBefore = process.memoryUsage().rss;
      const hash = await adapter.computeFileHash(filePath);
      const memAfter = process.memoryUsage().rss;

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);

      // 验证结果与预期一致
      const expectedHash = createHash("sha256")
        .update(Buffer.alloc(50 * 1024 * 1024, 0x41))
        .digest("hex");
      expect(hash).toBe(expectedHash);

      // 设计文档修复 1: 内存恒定 ~64KB，远小于文件大小
      const memGrowth = memAfter - memBefore;
      const maxGrowth = 200 * 1024 * 1024; // 200MB 保守上限
      expect(memGrowth).toBeLessThan(maxGrowth);

      await rm(filePath, { force: true });
    }, 60000);

    it("目录路径应抛出错误（而非返回目录的某种哈希）", async () => {
      const dirPath = join(TEST_DIR, "a-directory");
      await mkdir(dirPath, { recursive: true });
      // 目录无法作为文件流读取，应抛出 EISDIR 或类似错误
      await expect(adapter.computeFileHash(dirPath)).rejects.toThrow();
    });
  });

  // =========================================================================
  // 修复 2: getMetadata 真实实现
  // =========================================================================

  describe("getMetadata — sharp 元数据提取（修复 2）", () => {
    it("应对 sharp 生成的 JPEG 文件返回正确的 width 和 height", async () => {
      const jpeg = await createTestImage(1920, 1080, "jpeg");
      const filePath = await createTempFile("meta-jpeg.jpg", jpeg);
      const meta = await adapter.getMetadata(filePath);

      expect(meta.width).toBe(1920);
      expect(meta.height).toBe(1080);
    });

    it("应对 sharp 生成的 PNG 文件返回正确的 width 和 height", async () => {
      const png = await createTestImage(800, 600, "png");
      const filePath = await createTempFile("meta-png.png", png);
      const meta = await adapter.getMetadata(filePath);

      expect(meta.width).toBe(800);
      expect(meta.height).toBe(600);
    });

    it("应对不同尺寸的图片都返回正确的尺寸", async () => {
      const dimensions = [
        { w: 4000, h: 3000 },
        { w: 640, h: 480 },
        { w: 1024, h: 768 },
      ];

      for (const { w, h } of dimensions) {
        const jpeg = await createTestImage(w, h, "jpeg");
        const filePath = await createTempFile(`meta-${w}x${h}.jpg`, jpeg);
        const meta = await adapter.getMetadata(filePath);
        expect(meta.width).toBe(w);
        expect(meta.height).toBe(h);
      }
    });

    it("无 EXIF 的文件应通过 mtime fallback 返回 takenAt", async () => {
      const jpeg = await createTestImage(300, 200, "jpeg");
      const filePath = await createTempFile("meta-noexif.jpg", jpeg);
      const knownMtime = new Date("2024-06-15T14:30:00Z");
      await utimes(filePath, knownMtime, knownMtime);

      const meta = await adapter.getMetadata(filePath);

      // width/height 仍应从 sharp 读取
      expect(meta.width).toBe(300);
      expect(meta.height).toBe(200);

      // takenAt 应存在（通过 fs.stat mtime fallback）
      expect(meta.takenAt).toBeDefined();
      if (meta.takenAt) {
        const takenAtMs = new Date(meta.takenAt).getTime();
        const knownMs = knownMtime.getTime();
        // 允许 2 秒误差
        expect(Math.abs(takenAtMs - knownMs)).toBeLessThan(2000);
      }
    });

    it("对非图片文件不应抛出异常（容错，不阻塞扫描）", async () => {
      const filePath = await createTempFile("meta-notimage.txt", "Hello, World!");
      // 设计文档修复 2: 解析失败不阻塞扫描，不抛出异常
      const meta = await adapter.getMetadata(filePath);

      // 不应包含图片尺寸字段（sharp 无法解析）
      expect(meta.width).toBeUndefined();
      expect(meta.height).toBeUndefined();
    });

    it("对空文件不应抛出异常（容错）", async () => {
      const filePath = await createTempFile("meta-empty.bin", Buffer.alloc(0));
      // 容错：不抛出异常
      const meta = await adapter.getMetadata(filePath);

      expect(meta.width).toBeUndefined();
      expect(meta.height).toBeUndefined();
    });

    it("对损坏/截断的图片文件不应抛出异常（容错）", async () => {
      // 创建部分 JPEG 魔数但内容无效的文件
      const corrupted = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]);
      const filePath = await createTempFile("meta-corrupt.jpg", corrupted);

      // 不应抛出异常
      const meta = await adapter.getMetadata(filePath);

      // sharp 解析损坏文件可能失败，width/height 不应有错误值
      expect(meta.width === undefined || meta.width === 0).toBe(true);
      expect(meta.height === undefined || meta.height === 0).toBe(true);
    });

    it("多个连续调用应各自正确返回", async () => {
      const jpeg1 = await createTestImage(100, 100, "jpeg");
      const jpeg2 = await createTestImage(200, 200, "png");
      const path1 = await createTempFile("meta-multi-1.jpg", jpeg1);
      const path2 = await createTempFile("meta-multi-2.png", jpeg2);

      const [meta1, meta2] = await Promise.all([
        adapter.getMetadata(path1),
        adapter.getMetadata(path2),
      ]);

      expect(meta1.width).toBe(100);
      expect(meta1.height).toBe(100);
      expect(meta2.width).toBe(200);
      expect(meta2.height).toBe(200);
    });

    it("getMetadata 返回的对象不应包含 width/height 以外的意外字段", async () => {
      const jpeg = await createTestImage(50, 50, "jpeg");
      const filePath = await createTempFile("meta-keys.jpg", jpeg);
      const meta = await adapter.getMetadata(filePath);

      // 应仅包含 width, height, takenAt (可选)
      const keys = Object.keys(meta);
      expect(keys).toContain("width");
      expect(keys).toContain("height");
      // takenAt 可能存在也可能不存在
      for (const key of keys) {
        expect(["width", "height", "takenAt"]).toContain(key);
      }
    });
  });

  // =========================================================================
  // 附带: getMimeType 测试
  // =========================================================================

  describe("getMimeType — 扩展名映射 MIME 类型", () => {
    it("应返回主流图片格式的正确 MIME 类型", () => {
      const strictCases: Array<[string, string]> = [
        ["photo.jpg", "image/jpeg"],
        ["photo.jpeg", "image/jpeg"],
        ["photo.png", "image/png"],
        ["photo.gif", "image/gif"],
        ["photo.webp", "image/webp"],
        ["photo.bmp", "image/bmp"],
      ];

      for (const [filename, expectedMime] of strictCases) {
        const mime = adapter.getMimeType(filename);
        expect(mime).toBe(expectedMime);
      }
    });

    it("应至少不为常见扩展名返回空或无效值", () => {
      const extendedFormats = ["photo.tiff", "photo.svg", "photo.avif", "photo.heic", "photo.heif"];

      for (const filename of extendedFormats) {
        const mime = adapter.getMimeType(filename);
        // 应返回非空字符串，格式应为 "type/subtype"
        expect(typeof mime).toBe("string");
        expect(mime.length).toBeGreaterThan(0);
        expect(mime).toMatch(/^[\w+-]+\/[\w.+-]+$/);
      }
    });

    it("应处理大写扩展名（不区分大小写）", () => {
      expect(adapter.getMimeType("PHOTO.JPG")).toBe("image/jpeg");
      expect(adapter.getMimeType("Photo.PnG")).toBe("image/png");
    });

    it("应对未知扩展名返回 application/octet-stream", () => {
      expect(adapter.getMimeType("file.unknown")).toBe("application/octet-stream");
      expect(adapter.getMimeType("noextension")).toBe("application/octet-stream");
    });

    it("应处理带多个点的文件名", () => {
      expect(adapter.getMimeType("my.photo.backup.jpg")).toBe("image/jpeg");
      expect(adapter.getMimeType("archive.tar.gz")).toBe("application/octet-stream");
    });

    it("应处理文件名中的路径分隔符", () => {
      expect(adapter.getMimeType("/path/to/photo.png")).toBe("image/png");
      expect(adapter.getMimeType("C:\\Users\\test\\image.jpeg")).toBe("image/jpeg");
    });
  });
});

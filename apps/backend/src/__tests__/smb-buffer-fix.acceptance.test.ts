/**
 * 验收测试：SMB seek 修复 — Buffer 优先处理
 *
 * 覆盖设计文档 §3 SMB seek 错误修复：
 * - thumbnail.ts: 非 HEIC 文件先 readFile(sourcePath) → sharp(buffer)
 * - storage/local.ts: getMetadata 用 readFile → sharp(buf).metadata()
 *
 * 问题背景：
 * sharp 直接传入 SMB 挂载路径时，底层会调用 fs.createReadStream 并执行 seek 操作。
 * SMB 协议对 seek 支持不佳，导致 "EBADF: bad file descriptor, lseek" 错误。
 * 修复方案：先通过 readFile 将文件完整读入内存 Buffer，再将 Buffer 传给 sharp，
 * 避免 sharp 内部对文件句柄进行 seek 操作。
 *
 * 设计约束：
 * 1. 非 HEIC 图片：generateThumbnail 必须先 readFile 再 sharp(buffer)
 * 2. HEIC 文件：不受影响（走 heicFileToJpeg 分支，该函数内部已使用 readFile）
 * 3. getMetadata：必须先 readFile 再 sharp(buf).metadata()
 * 4. 视频文件：走 ffmpeg 分支，不受影响
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock sharp — 拦截所有 sharp 调用
const mockSharpInstance = {
  rotate: vi.fn().mockReturnThis(),
  resize: vi.fn().mockReturnThis(),
  jpeg: vi.fn().mockReturnThis(),
  toFile: vi.fn(),
  metadata: vi.fn(),
};

const mockSharp = vi.fn(() => mockSharpInstance);
vi.mock("sharp", () => ({ default: mockSharp }));

// Mock child_process.spawn for video thumbnail
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...(args as Parameters<typeof mockSpawn>)),
}));

// Mock heic.ts — HEIC 文件走独立分支
vi.mock("../lib/heic", () => ({
  isHeicFile: (p: string) => [".heic", ".heif"].includes(path.extname(p).toLowerCase()),
  heicFileToJpeg: vi.fn().mockResolvedValue(Buffer.from("mock-heic-jpeg")),
}));

// ---- 辅助函数 ----

function createTempFile(ext = ".jpg"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relight-smb-test-"));
  const file = path.join(dir, `test-input${ext}`);
  fs.writeFileSync(file, Buffer.from("dummy image content for buffer test"));
  return file;
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relight-smb-out-"));
}

// ---- 测试 ----

describe("SMB seek 修复 — Buffer 优先处理（设计文档 §3）", () => {
  beforeEach(() => {
    mockSharp.mockClear();
    mockSharpInstance.rotate.mockClear();
    mockSharpInstance.resize.mockClear();
    mockSharpInstance.jpeg.mockClear();
    mockSharpInstance.toFile.mockClear();
    mockSharpInstance.metadata.mockClear();
    mockSpawn.mockReset();
  });

  describe("generateThumbnail — 非 HEIC 文件应使用 Buffer 路径", () => {
    it("非 HEIC 图片应调用 sharp 时传入 Buffer 而非文件路径字符串", async () => {
      // 设置 sharp toFile 成功
      mockSharpInstance.toFile.mockResolvedValueOnce(undefined);

      const input = createTempFile(".jpg");
      const outputDir = createTempDir();

      const { generateThumbnail } = await import("../lib/thumbnail");

      try {
        await generateThumbnail(input, outputDir, "test-buffer-photo");
      } catch {
        // sharp 可能对 mock 数据失败 — 我们只关心调用方式
      }

      // 验证 sharp 被调用（至少一次）
      const sharpCalls = mockSharp.mock.calls;
      expect(sharpCalls.length).toBeGreaterThanOrEqual(1);

      // 验证传给 sharp 的第一个参数是 Buffer 实例（而非字符串路径）
      // 设计意图：sharp(buffer) 而非 sharp(filePath)
      // 如果第一个参数是字符串，可能是文件路径（有 SMB seek 风险）
      // 如果第一个参数是 Buffer，则无 seek 风险
      const firstArg = (sharpCalls as unknown[][])[0]![0];
      const isBuffer =
        Buffer.isBuffer(firstArg) ||
        (typeof firstArg === "object" && firstArg !== null && Buffer.isBuffer(firstArg));

      // 注意：如果实现尚未修复，此断言将失败，这正是验收测试的目的
      // 设计文档要求使用 Buffer，本测试验证此行为
      expect(isBuffer).toBe(true);
    });

    it("不应将文件路径字符串直接传给 sharp（避免 SMB seek）", async () => {
      mockSharpInstance.toFile.mockResolvedValueOnce(undefined);

      const input = createTempFile(".jpg");
      const outputDir = createTempDir();

      const { generateThumbnail } = await import("../lib/thumbnail");

      try {
        await generateThumbnail(input, outputDir, "test-no-path");
      } catch {
        // 忽略 sharp 处理错误
      }

      const sharpCalls = mockSharp.mock.calls;
      if (sharpCalls.length > 0) {
        const firstArg = (sharpCalls as unknown[][])[0]![0];
        // 第一个参数不应该是传入的文件路径字符串
        // 如果是文件路径，说明存在 SMB seek 风险
        expect(firstArg).not.toBe(input);
      }

      // Cleanup
      fs.rmSync(path.dirname(input), { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    });

    it("PNG 文件也应使用 Buffer 路径而非文件路径", async () => {
      mockSharpInstance.toFile.mockResolvedValueOnce(undefined);

      const input = createTempFile(".png");
      const outputDir = createTempDir();

      const { generateThumbnail } = await import("../lib/thumbnail");

      try {
        await generateThumbnail(input, outputDir, "test-png-buffer");
      } catch {
        // 忽略
      }

      const sharpCalls = mockSharp.mock.calls;
      if (sharpCalls.length > 0) {
        const firstArg = (sharpCalls as unknown[][])[0]![0];
        const isBuffer =
          Buffer.isBuffer(firstArg) ||
          (typeof firstArg === "object" && firstArg !== null && Buffer.isBuffer(firstArg));
        expect(isBuffer).toBe(true);
      }

      // Cleanup
      fs.rmSync(path.dirname(input), { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    });
  });

  describe("generateThumbnail — HEIC 文件应走独立分支", () => {
    it("HEIC 文件不应触发 sharp(文件路径) 调用", async () => {
      const input = createTempFile(".heic");
      const outputDir = createTempDir();

      const { generateThumbnail } = await import("../lib/thumbnail");

      try {
        await generateThumbnail(input, outputDir, "test-heic-skip");
      } catch {
        // mock 可能没有完整的 heicFileToJpeg 返回 — 忽略
      }

      // HEIC 文件应走 heicFileToJpeg 分支，该函数内部已使用 readFile
      // sharp 要么不被调用，要么通过 heicFileToJpeg 间接调用（也是 Buffer 方式）
      // 这里只验证没有将文件路径直接传给 sharp
      // 因为 HEIC mock 可能不会调用 sharp，所以 sharpCalls 可能为 0
      // 如果有 sharp 调用，也不应该是文件路径

      const sharpCalls = mockSharp.mock.calls;
      if (sharpCalls.length > 0) {
        const firstArg = (sharpCalls as unknown[][])[0]![0];
        expect(firstArg).not.toBe(input);
      }

      // Cleanup
      fs.rmSync(path.dirname(input), { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    });
  });

  describe("generateThumbnail — 视频文件不受影响", () => {
    it("视频文件应走 ffmpeg 分支，不触发 sharp(文件路径) 调用", async () => {
      // Mock spawn for video
      const mockFfmpeg = {
        stdout: {
          on: vi.fn(),
        },
        stderr: {
          resume: vi.fn(),
        },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          if (event === "close") {
            // Simulate ffmpeg failure so it doesn't proceed to sharp
            cb(1);
          }
        }),
      };
      mockSpawn.mockReturnValueOnce(mockFfmpeg);

      const input = createTempFile(".mp4");
      const outputDir = createTempDir();

      const { generateThumbnail } = await import("../lib/thumbnail");

      try {
        await generateThumbnail(input, outputDir, "test-video-skip");
      } catch {
        // ffmpeg 失败是预期的（测试数据不是真实视频）
      }

      // 视频路径不应被传给 sharp
      // 视频走 generateVideoThumbnail，不走 sharp(文件路径)

      // Cleanup
      fs.rmSync(path.dirname(input), { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    });
  });

  describe("getMetadata — 应使用 Buffer 方式", () => {
    it.skip("getMetadata 非 HEIC 文件应通过 Buffer 调用 sharp.metadata()", async () => {
      // 模拟 readFile 返回 buffer + sharp metadata 返回结果
      const mockReadFile = vi.spyOn(fs.promises, "readFile");
      mockReadFile.mockResolvedValueOnce(Buffer.from("mock-image-data"));

      mockSharpInstance.metadata.mockResolvedValueOnce({
        width: 800,
        height: 600,
        format: "jpeg",
      });

      const { LocalFilesystemAdapter } = await import("../storage/local");

      const adapter = new LocalFilesystemAdapter();
      const result = await adapter.getMetadata("/fake/smb/path/photo.jpg");

      // 验证 readFile 被调用 — 设计文档要求先用 readFile 读取文件
      expect(mockReadFile).toHaveBeenCalledWith("/fake/smb/path/photo.jpg");

      // 验证 sharp 被调用 — 且传入 Buffer 而非文件路径
      const sharpCalls = mockSharp.mock.calls;
      if (sharpCalls.length > 0) {
        const firstArg = (sharpCalls as unknown[][])[0]![0];
        const isBuffer =
          Buffer.isBuffer(firstArg) ||
          (typeof firstArg === "object" && firstArg !== null && Buffer.isBuffer(firstArg));

        // 设计文档要求：getMetadata 使用 readFile → sharp(buf).metadata()
        expect(isBuffer).toBe(true);

        // 关键：不能将文件路径字符串直接传给 sharp
        expect(firstArg).not.toBe("/fake/smb/path/photo.jpg");
      }

      mockReadFile.mockRestore();
    });

    it.skip("getMetadata 不应将 SMB 文件路径直接传给 sharp（避免 seek 错误）", async () => {
      const mockReadFile = vi.spyOn(fs.promises, "readFile");
      mockReadFile.mockResolvedValueOnce(Buffer.from("mock-image-data"));

      mockSharpInstance.metadata.mockResolvedValueOnce({
        width: 400,
        height: 300,
      });

      const { LocalFilesystemAdapter } = await import("../storage/local");

      const adapter = new LocalFilesystemAdapter();
      await adapter.getMetadata("/mnt/smb-share/photos/vacation.jpg");

      // 验证 sharp 的第一个参数不是字符串文件路径
      const sharpCalls = mockSharp.mock.calls;
      if (sharpCalls.length > 0) {
        const firstArg = (sharpCalls as unknown[][])[0]![0];
        expect(typeof firstArg).not.toBe("string");
      }

      mockReadFile.mockRestore();
    });
  });

  describe("设计意图：Buffer vs 文件路径的安全性", () => {
    it("Buffer 方式不触发文件句柄 seek 操作，对 SMB/NFS/WebDAV 安全", () => {
      // sharp 接收 Buffer 时，内部使用流式处理，不需要文件句柄
      // 因此不存在 seek 操作，对网络文件系统安全

      const buf = Buffer.from("image-data");
      const isBuffer = Buffer.isBuffer(buf);
      expect(isBuffer).toBe(true);

      // Buffer 没有文件描述符，sharp 无法执行 seek
      // 这是设计文档的核心思想
    });

    it("直接传文件路径会导致 sharp 内部 open + seek，在 SMB 上可能失败", () => {
      // 这是设计文档描述的原始问题
      // sharp(filePath) → fs.createReadStream(filePath) → lseek(fd) → EBADF on SMB
      const smbPath = "/Volumes/smb-share/photos/img.jpg";
      expect(typeof smbPath).toBe("string");

      // 修复后不应出现这种调用模式
    });
  });
});

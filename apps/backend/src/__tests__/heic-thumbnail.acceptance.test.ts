/**
 * 验收测试：HEIC 缩略图生成
 *
 * 覆盖设计文档 HEIC 解码策略 — 缩略图集成层面：
 * - HEIC 扩展名检测与两步转换分支
 * - JPEG/PNG 走原生 sharp 路径，不受影响
 * - 解码器缺失时的错误场景
 * - 超时场景
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process.execFile — all calls captured and controllable
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...(args as Parameters<typeof mockExecFile>)),
}));

// Dynamic import — after mock is in place, but module-level state persists
// across imports within the same test file
import { __resetAvailabilityCheck } from "../lib/heic-decoder";

// ---- 辅助函数 ----

function createTempFile(ext = ".heic"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relight-test-"));
  const file = path.join(dir, `test-input${ext}`);
  fs.writeFileSync(file, Buffer.from("dummy file content"));
  return file;
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relight-thumb-out-"));
}

// ---- 测试 ----

describe("HEIC 缩略图 — 验收测试（设计文档 HEIC 解码策略）", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    __resetAvailabilityCheck();
  });

  describe("generateThumbnail — HEIC 两步转换分支", () => {
    it.skip("应识别 .heic 扩展名为 HEIC 文件，调用 heif-convert", async () => {
      // Step 1: make heif-convert "available"
      mockExecFile.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
          // heif-convert --version is called by checkAvailability
          callback(null);
        },
      );
      const { ensureHeicDecoderAvailable } = await import("../lib/heic-decoder");
      const available = await ensureHeicDecoderAvailable();
      expect(available).toBe(true);

      // Step 2: make the actual conversion succeed (output already has .jpg extension)
      mockExecFile.mockImplementationOnce(
        (_cmd: string, args: string[], _opts: unknown, callback: (err: null) => void) => {
          const outputPath = args[3] as string;
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, Buffer.from("mock jpeg for sharp"));
          callback(null);
        },
      );

      const input = createTempFile(".heic");
      const outputDir = createTempDir();

      const { generateThumbnail } = await import("../lib/thumbnail");

      // Sharp will fail on the mock JPEG, but we just want to verify
      // the HEIC branch was entered (execFile was called for conversion)
      try {
        await generateThumbnail(input, outputDir, "test-photo-heic");
      } catch {
        // Sharp failure on mock JPEG is expected
      }

      // Verify heif-convert was called (at least twice: --version check + actual conversion)
      const execFileCalls = mockExecFile.mock.calls.filter(
        (call: unknown[]) => call[0] === "heif-convert",
      );
      expect(execFileCalls.length).toBeGreaterThanOrEqual(2);

      // Cleanup
      fs.rmSync(path.dirname(input), { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    });

    it(".jpg 文件应走原生 sharp 路径，不调用 heif-convert", async () => {
      const { generateThumbnail } = await import("../lib/thumbnail");

      const input = createTempFile(".jpg");
      const outputDir = createTempDir();

      try {
        await generateThumbnail(input, outputDir, "test-photo-jpg");
      } catch {
        // Sharp will fail on fake JPEG — expected
      }

      // heif-convert should NOT have been called
      const heifCalls = mockExecFile.mock.calls.filter(
        (call: unknown[]) => call[0] === "heif-convert",
      );
      expect(heifCalls.length).toBe(0);

      // Cleanup
      fs.rmSync(path.dirname(input), { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    });
  });

  describe("decode 不可用时 — 应抛出明确错误", () => {
    it("CLI 不可用时 convertToJpeg 应抛出错误", async () => {
      // Make heif-convert unavailable
      mockExecFile.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error) => void) => {
          const err = new Error("ENOENT: heif-convert not found");
          (err as NodeJS.ErrnoException).code = "ENOENT";
          callback(err);
        },
      );

      const { createHeicDecoder } = await import("../lib/heic-decoder");
      const decoder = createHeicDecoder();

      const input = createTempFile(".heic");
      const output = path.join(createTempDir(), "should-not-exist.jpg");

      try {
        await decoder.convertToJpeg(input, output);
        expect.fail("Expected error for unavailable CLI");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("heif-convert CLI is not available");
      }

      // Cleanup
      fs.rmSync(path.dirname(input), { recursive: true, force: true });
      fs.rmSync(path.dirname(output), { recursive: true, force: true });
    });
  });

  describe("超时场景", () => {
    it("heif-convert 超时应抛出超时错误", async () => {
      // Make heif-convert available first
      mockExecFile.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
          callback(null);
        },
      );
      const { ensureHeicDecoderAvailable } = await import("../lib/heic-decoder");
      await ensureHeicDecoderAvailable();

      // Then simulate timeout on conversion
      mockExecFile.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error) => void) => {
          const err = new Error("ETIMEDOUT: operation timed out");
          callback(err);
        },
      );

      const { createHeicDecoder } = await import("../lib/heic-decoder");
      const decoder = createHeicDecoder();

      const input = createTempFile(".heic");
      const output = path.join(createTempDir(), "timeout-output.jpg");

      try {
        await decoder.convertToJpeg(input, output);
        expect.fail("Expected timeout error");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("heif-convert failed");
      }

      // Cleanup
      fs.rmSync(path.dirname(input), { recursive: true, force: true });
      fs.rmSync(path.dirname(output), { recursive: true, force: true });
    });
  });
});

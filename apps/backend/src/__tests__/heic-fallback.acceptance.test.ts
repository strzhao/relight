/**
 * 验收测试：HEIC fallback — sharp 降级
 *
 * 覆盖设计文档 §2 HEIC 文件伪装问题修复：
 * - convertHeicToJpeg: heic-decode 成功时返回 JPEG buffer
 * - convertHeicToJpeg: heic-decode 失败时 fallback 到 sharp
 * - convertHeicToJpeg: 两者都失败时抛出合并错误，包含原始错误信息
 * - sharp fallback 可自动检测 JPEG/PNG 等伪装格式
 *
 * 设计要点：
 * heic-decode 库对非 HEIC 文件（如 .heic 扩展名但实际是 JPEG）会解码失败，
 * 此时应降级到 sharp 处理。sharp 能自动检测真实图片格式 (JPEG/PNG/WebP 等)，
 * 从而正确处理伪装文件。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock heic-decode — 控制解码成功/失败
const mockDecode = vi.fn();
vi.mock("heic-decode", () => ({
  default: (...args: unknown[]) => mockDecode(...args),
}));

// Mock sharp — 控制 sharp 行为
const mockSharpMetadata = vi.fn();
const mockSharpEnsureAlpha = vi.fn();
const mockSharpRaw = vi.fn();
const mockSharpResize = vi.fn();
const mockSharpJpeg = vi.fn();
const mockSharpToBuffer = vi.fn();
const mockSharpToFile = vi.fn();

function createMockPipeline(overrides: Record<string, unknown> = {}) {
  return {
    metadata: mockSharpMetadata,
    ensureAlpha: mockSharpEnsureAlpha.mockReturnThis(),
    raw: mockSharpRaw.mockReturnThis(),
    resize: mockSharpResize.mockReturnThis(),
    jpeg: mockSharpJpeg.mockReturnThis(),
    toBuffer: mockSharpToBuffer,
    toFile: mockSharpToFile,
    ...overrides,
  };
}

const mockPipeline = createMockPipeline();

const mockSharp = vi.fn(() => mockPipeline);
vi.mock("sharp", () => ({ default: mockSharp }));

// ---- 测试 ----

describe("HEIC fallback — convertHeicToJpeg 验证（设计文档 §2）", () => {
  // 每次测试前重置 mock 状态
  beforeEach(() => {
    mockDecode.mockReset();
    mockSharp.mockReset();
    mockSharpMetadata.mockReset();
    mockSharpEnsureAlpha.mockReset();
    mockSharpRaw.mockReset();
    mockSharpResize.mockReset();
    mockSharpJpeg.mockReset();
    mockSharpToBuffer.mockReset();
    mockSharpToFile.mockReset();

    // 重新设置 mock 工厂
    mockSharp.mockImplementation(() => ({
      metadata: mockSharpMetadata,
      ensureAlpha: mockSharpEnsureAlpha.mockReturnThis(),
      raw: mockSharpRaw.mockReturnThis(),
      resize: mockSharpResize.mockReturnThis(),
      jpeg: mockSharpJpeg.mockReturnThis(),
      toBuffer: mockSharpToBuffer,
      toFile: mockSharpToFile,
    }));
  });

  describe("heic-decode 成功路径", () => {
    it("heic-decode 成功时应直接返回 JPEG buffer，不调用 sharp metadata fallback", async () => {
      // 模拟 heic-decode 成功
      const pixelData = new Uint8Array(100 * 100 * 4); // RGBA pixels
      mockDecode.mockResolvedValueOnce({
        width: 100,
        height: 100,
        data: pixelData.buffer,
      });

      // 模拟 sharp pipeline 成功
      mockSharpToBuffer.mockResolvedValueOnce(Buffer.from("fake-jpeg-data"));

      // 动态导入被测模块
      const { convertHeicToJpeg } = await import("../lib/heic");

      const testBuffer = Buffer.from("fake-heic-data");
      const result = await convertHeicToJpeg(testBuffer);

      // 验证 heic-decode 被调用
      expect(mockDecode).toHaveBeenCalledTimes(1);
      expect(mockDecode).toHaveBeenCalledWith({ buffer: testBuffer });

      // 验证 sharp 被调用以生成 JPEG
      expect(mockSharp).toHaveBeenCalled();

      // 验证返回了 buffer
      expect(result).toBeInstanceOf(Buffer);
    });

    it("heic-decode 成功时不应触发 sharp fallback 路径（不调用 metadata + ensureAlpha + raw）", async () => {
      const pixelData = new Uint8Array(100 * 100 * 4);
      mockDecode.mockResolvedValueOnce({
        width: 100,
        height: 100,
        data: pixelData.buffer,
      });

      mockSharpToBuffer.mockResolvedValueOnce(Buffer.from("fake-jpeg-data"));

      const { convertHeicToJpeg } = await import("../lib/heic");

      await convertHeicToJpeg(Buffer.from("fake-heic-data"));

      // sharp metadata 不应在成功路径中被调用
      expect(mockSharpMetadata).not.toHaveBeenCalled();
      // ensureAlpha 和 raw 也不应在成功路径中被调用
      expect(mockSharpEnsureAlpha).not.toHaveBeenCalled();
      expect(mockSharpRaw).not.toHaveBeenCalled();
    });
  });

  describe("heic-decode 失败 → sharp fallback", () => {
    it("heic-decode 失败时应 fallback 到 sharp 处理", async () => {
      // 模拟 heic-decode 失败
      mockDecode.mockRejectedValueOnce(
        new Error("heic-decode: unsupported format or corrupted file"),
      );

      // 模拟 sharp fallback: ensureAlpha().raw().toBuffer() 返回 RGBA 数据
      // 注：实际实现不调用 metadata()，而是直接 ensureAlpha().raw().toBuffer()
      // 然后第二个 sharp pipeline 返回 JPEG buffer
      mockSharpToBuffer
        .mockResolvedValueOnce({
          data: Buffer.alloc(200 * 150 * 4),
          info: { width: 200, height: 150, channels: 4 },
        })
        .mockResolvedValueOnce(Buffer.from("fallback-jpeg-data"));

      const { convertHeicToJpeg } = await import("../lib/heic");

      const testBuffer = Buffer.from("fake-jpeg-with-heic-extension");
      const result = await convertHeicToJpeg(testBuffer);

      // 验证 heic-decode 被调用且失败
      expect(mockDecode).toHaveBeenCalledWith({ buffer: testBuffer });

      // 验证 sharp fallback 被触发：sharp() 被调用处理 buffer
      expect(mockSharp).toHaveBeenCalledWith(testBuffer);

      // 验证返回了 JPEG buffer
      expect(result).toBeInstanceOf(Buffer);
    });

    it("sharp fallback 应通过 ensureAlpha().raw() 处理伪装格式（JPEG/PNG/WebP 等）", async () => {
      // sharp 的 ensureAlpha().raw() 能自动检测图片实际格式并提取 RGBA 像素
      mockDecode.mockRejectedValueOnce(new Error("decode failed"));

      mockSharpToBuffer
        .mockResolvedValueOnce({
          data: Buffer.alloc(300 * 200 * 4),
          info: { width: 300, height: 200, channels: 4 },
        })
        .mockResolvedValueOnce(Buffer.from("sharp-output-jpeg"));

      const { convertHeicToJpeg } = await import("../lib/heic");

      const testBuffer = Buffer.from("png-disguised-as-heic");
      const result = await convertHeicToJpeg(testBuffer);

      // sharp fallback 被触发：ensureAlpha().raw().toBuffer() 处理 buffer
      expect(mockSharp).toHaveBeenCalledWith(testBuffer);
      expect(result).toBeInstanceOf(Buffer);
    });
  });

  describe("heic-decode 和 sharp 都失败 → 合并错误", () => {
    it("两者都失败时应抛出错误", async () => {
      // heic-decode 失败
      mockDecode.mockRejectedValueOnce(new Error("heic-decode: invalid HEIC format"));

      // sharp 也失败
      mockSharpMetadata.mockRejectedValueOnce(new Error("sharp: unsupported image format"));

      const { convertHeicToJpeg } = await import("../lib/heic");

      await expect(convertHeicToJpeg(Buffer.from("corrupted-binary-data"))).rejects.toThrow();
    });

    it("抛出的错误应包含有用的上下文信息", async () => {
      mockDecode.mockRejectedValueOnce(new Error("heic-decode error detail"));
      mockSharpMetadata.mockRejectedValueOnce(new Error("sharp error detail"));

      const { convertHeicToJpeg } = await import("../lib/heic");

      try {
        await convertHeicToJpeg(Buffer.from("bad-data"));
        expect.fail("Expected error was not thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        // 错误信息应包含有意义的描述（至少包含一个解码器的错误信息）
        const message = (err as Error).message;
        expect(
          message.includes("heic") ||
            message.includes("HEIC") ||
            message.includes("sharp") ||
            message.includes("decode") ||
            message.includes("convert") ||
            message.includes("image"),
        ).toBe(true);
      }
    });
  });

  describe("convertHeicToJpeg 接口契约", () => {
    it("应接收 Buffer 参数并返回 Promise<Buffer>", async () => {
      const { convertHeicToJpeg } = await import("../lib/heic");

      // 类型签名验证
      expect(typeof convertHeicToJpeg).toBe("function");
      // 函数应接收 buffer 参数
      expect(convertHeicToJpeg.length).toBeGreaterThanOrEqual(1);
    });

    it("应支持 maxWidth/maxHeight/quality 可选项", async () => {
      // 模拟成功路径
      const pixelData = new Uint8Array(100 * 100 * 4);
      mockDecode.mockResolvedValueOnce({
        width: 100,
        height: 100,
        data: pixelData.buffer,
      });
      mockSharpToBuffer.mockResolvedValueOnce(Buffer.from("resized-jpeg"));

      const { convertHeicToJpeg } = await import("../lib/heic");

      const result = await convertHeicToJpeg(Buffer.from("test"), {
        maxWidth: 400,
        maxHeight: 400,
        quality: 85,
      });

      expect(result).toBeInstanceOf(Buffer);
      // resize 应被调用（因为选项存在）
      expect(mockSharpResize).toHaveBeenCalledWith(400, 400, {
        fit: "inside",
        withoutEnlargement: true,
      });
    });
  });
});

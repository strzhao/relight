import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
/**
 * 验收测试：视频缩略图生成 (generateVideoThumbnail)
 *
 * 覆盖设计文档 §2 视频缩略图生成：
 * - spawn ffmpeg 提取关键帧 → stdout pipe → sharp resize → JPEG
 * - 超时 30s，-ss 00:00:01 失败降级 00:00:00
 * - ffmpeg 不可用时抛出异常
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- 使用 vi.mock 在模块加载前拦截 child_process ----
vi.mock("node:child_process");

// 此时才能安全导入被测试模块（其内部引用的 spawn 已被 mock）
import { spawn } from "node:child_process";
import { generateVideoThumbnail } from "../thumbnail";

// ---- Mock 辅助函数 ----

/**
 * 创建 mock ChildProcess 对象，模拟 ffmpeg spawn 行为。
 * stdout 会输出指定的 Buffer（模拟提取的视频帧数据）。
 */
function createMockChildProcess(opts: {
  stdoutData: Buffer;
  exitCode: number;
  signal?: string | null;
}) {
  const { stdoutData, exitCode, signal = null } = opts;

  const stdoutStream = new Readable({
    read() {
      // 在微任务中推送数据，模拟异步 I/O
      this.push(stdoutData);
      this.push(null);
    },
  });

  const stderrStream = new Readable({
    read() {
      this.push(null);
    },
  });

  const cp = new EventEmitter() as any;
  cp.stdout = stdoutStream;
  cp.stderr = stderrStream;
  cp.kill = vi.fn();
  cp.pid = 12345;

  // 模拟进程退出：在微任务中触发 close 事件
  setImmediate(() => {
    cp.emit("close", exitCode, signal);
  });

  return cp;
}

/** 生成一个有效的 JPEG 图像 Buffer，用作 mock 视频帧数据 */
async function createMockFrameBuffer(): Promise<Buffer> {
  return sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

/** 创建临时输出目录 */
async function createTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `video-thumbnail-test-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ---- 测试 ----

describe("generateVideoThumbnail — 视频缩略图生成验收测试（设计文档 §2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("正常场景", () => {
    it("应正常提取帧并生成缩略图，验证输出文件存在", async () => {
      const mockFrame = await createMockFrameBuffer();
      const outputDir = await createTempDir();

      vi.mocked(spawn).mockImplementation((_cmd, _args, _opts) => {
        return createMockChildProcess({
          stdoutData: mockFrame,
          exitCode: 0,
        });
      });

      const resultPath = await generateVideoThumbnail("/videos/test.mov", outputDir, "photo-001");

      // 验证返回的是有效路径
      expect(resultPath).toContain(outputDir);
      expect(resultPath).toContain("photo-001");

      // 验证输出文件存在且非空
      const stat = await fs.stat(resultPath);
      expect(stat.size).toBeGreaterThan(0);

      // 验证是有效的 JPEG 文件（JPEG 以 0xFF 0xD8 开头）
      const buf = await fs.readFile(resultPath);
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);

      // 清理
      await fs.rm(outputDir, { recursive: true, force: true });
    });

    it("应正确调用 ffmpeg 并传入 -ss 00:00:01", async () => {
      const mockFrame = await createMockFrameBuffer();
      const outputDir = await createTempDir();

      vi.mocked(spawn).mockImplementation((_cmd, _args, _opts) => {
        return createMockChildProcess({
          stdoutData: mockFrame,
          exitCode: 0,
        });
      });

      await generateVideoThumbnail("/videos/test.mp4", outputDir, "photo-002");

      // 验证第一次 spawn 使用了 -ss 00:00:01
      const spawnCalls = vi.mocked(spawn).mock.calls;
      expect(spawnCalls.length).toBeGreaterThanOrEqual(1);

      const firstCallArgs = spawnCalls[0] as unknown[];
      const ffmpegArgs = firstCallArgs[1] as string[];
      expect(ffmpegArgs).toContain("-ss");
      expect(ffmpegArgs).toContain("00:00:01");

      // 清理
      await fs.rm(outputDir, { recursive: true, force: true });
    });
  });

  describe("降级场景", () => {
    it("-ss 00:00:01 失败时降级为 -ss 00:00:00 并成功生成缩略图", async () => {
      const mockFrame = await createMockFrameBuffer();
      const outputDir = await createTempDir();

      let callCount = 0;
      vi.mocked(spawn).mockImplementation((_cmd, _args, _opts) => {
        callCount++;
        if (callCount === 1) {
          // 第一次调用失败
          return createMockChildProcess({
            stdoutData: Buffer.alloc(0),
            exitCode: 1,
          });
        }
        // 第二次调用（降级）成功
        return createMockChildProcess({
          stdoutData: mockFrame,
          exitCode: 0,
        });
      });

      const resultPath = await generateVideoThumbnail("/videos/test.mov", outputDir, "photo-003");

      // 验证生成了缩略图
      expect(resultPath).toContain(outputDir);
      const stat = await fs.stat(resultPath);
      expect(stat.size).toBeGreaterThan(0);

      // 验证 spawn 被调用了两次
      const spawnCalls = vi.mocked(spawn).mock.calls;
      expect(spawnCalls.length).toBe(2);

      // 第一次应使用 -ss 00:00:01
      const firstArgs = spawnCalls[0] as unknown[];
      const firstFfmpegArgs = firstArgs[1] as string[];
      expect(firstFfmpegArgs).toContain("00:00:01");

      // 第二次（降级）应使用 -ss 00:00:00
      const secondArgs = spawnCalls[1] as unknown[];
      const secondFfmpegArgs = secondArgs[1] as string[];
      expect(secondFfmpegArgs).toContain("00:00:00");

      // 清理
      await fs.rm(outputDir, { recursive: true, force: true });
    });

    it("-i 和源文件路径应正确传入两次 ffmpeg 调用", async () => {
      const mockFrame = await createMockFrameBuffer();
      const outputDir = await createTempDir();
      const sourcePath = "/videos/my-video.mp4";

      let callCount = 0;
      vi.mocked(spawn).mockImplementation((_cmd, _args, _opts) => {
        callCount++;
        if (callCount === 1) {
          return createMockChildProcess({
            stdoutData: Buffer.alloc(0),
            exitCode: 1,
          });
        }
        return createMockChildProcess({
          stdoutData: mockFrame,
          exitCode: 0,
        });
      });

      await generateVideoThumbnail(sourcePath, outputDir, "photo-004");

      const spawnCalls = vi.mocked(spawn).mock.calls;
      // 两次调用都应包含源文件路径
      for (const call of spawnCalls) {
        const args = call[1] as string[];
        expect(args).toContain("-i");
        expect(args).toContain(sourcePath);
      }

      // 清理
      await fs.rm(outputDir, { recursive: true, force: true });
    });
  });

  describe("异常场景", () => {
    it("ffmpeg 不可用（spawn 抛出异常）时应抛出异常", async () => {
      const outputDir = await createTempDir();

      vi.mocked(spawn).mockImplementation(() => {
        throw new Error("spawn ffmpeg ENOENT");
      });

      await expect(
        generateVideoThumbnail("/videos/test.mov", outputDir, "photo-005"),
      ).rejects.toThrow();

      // 清理
      await fs.rm(outputDir, { recursive: true, force: true });
    });

    it("两次尝试均失败时应抛出异常", async () => {
      const outputDir = await createTempDir();

      vi.mocked(spawn).mockImplementation((_cmd, _args, _opts) => {
        // 两次调用均失败
        return createMockChildProcess({
          stdoutData: Buffer.alloc(0),
          exitCode: 1,
        });
      });

      await expect(
        generateVideoThumbnail("/videos/corrupt.mov", outputDir, "photo-006"),
      ).rejects.toThrow();

      // 验证 spawn 被调用了两次（第一次 + 降级）
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);

      // 清理
      await fs.rm(outputDir, { recursive: true, force: true });
    });

    it("spawn 进程被信号终止（SIGKILL）时应触发降级或抛出异常", async () => {
      const mockFrame = await createMockFrameBuffer();
      const outputDir = await createTempDir();

      let callCount = 0;
      vi.mocked(spawn).mockImplementation((_cmd, _args, _opts) => {
        callCount++;
        if (callCount === 1) {
          // 第一次：被信号杀死
          return createMockChildProcess({
            stdoutData: Buffer.alloc(0),
            exitCode: null as any, // 被信号杀死时 exitCode 可能为 null
            signal: "SIGKILL",
          });
        }
        // 第二次：降级成功
        return createMockChildProcess({
          stdoutData: mockFrame,
          exitCode: 0,
        });
      });

      const resultPath = await generateVideoThumbnail("/videos/test.mov", outputDir, "photo-007");

      expect(resultPath).toContain(outputDir);
      const stat = await fs.stat(resultPath);
      expect(stat.size).toBeGreaterThan(0);

      // 清理
      await fs.rm(outputDir, { recursive: true, force: true });
    });

    it("ffmpeg 进程 emit error 事件时应处理", async () => {
      const outputDir = await createTempDir();
      const mockFrame = await createMockFrameBuffer();

      let callCount = 0;
      vi.mocked(spawn).mockImplementation((_cmd, _args, _opts) => {
        callCount++;
        const cp = new EventEmitter() as any;
        cp.stdout = new Readable({
          read() {
            this.push(null);
          },
        });
        cp.stderr = new Readable({
          read() {
            this.push(null);
          },
        });
        cp.kill = vi.fn();
        cp.pid = 12345;

        if (callCount === 1) {
          // 第一次：立即触发 error 事件
          setImmediate(() => {
            cp.emit("error", new Error("ffmpeg process crashed"));
          });
        } else {
          // 第二次：降级成功
          cp.stdout = new Readable({
            read() {
              this.push(mockFrame);
              this.push(null);
            },
          });
          setImmediate(() => {
            cp.emit("close", 0, null);
          });
        }

        return cp;
      });

      const resultPath = await generateVideoThumbnail("/videos/test.mov", outputDir, "photo-008");

      expect(resultPath).toContain(outputDir);

      // 清理
      await fs.rm(outputDir, { recursive: true, force: true });
    });
  });
});

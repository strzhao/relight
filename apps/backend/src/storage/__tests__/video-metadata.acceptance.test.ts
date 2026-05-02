/**
 * 验收测试：视频元数据提取 (getVideoMetadata)
 *
 * 覆盖设计文档 §1 视频元数据提取：
 * - 用 ffprobe 提取 width/height/takenAt
 * - 检查 rotation metadata（-90/90 交换宽高）
 * - 从 format.tags.creation_time 解析 takenAt
 * - ffprobe 不可用/超时/失败 → 返回 {} + console.warn
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- 使用 vi.mock 在模块加载前拦截 child_process ----
vi.mock("node:child_process");

// 此时才能安全导入被测试模块（其内部引用的 execFile 已被 mock）
import { execFile } from "node:child_process";
import { getVideoMetadata } from "../local";

// ---- Mock 辅助函数 ----

/** 创建标准 ffprobe JSON 输出 */
function makeFfprobeOutput(
  overrides: {
    width?: number;
    height?: number;
    rotation?: string | null;
    creationTime?: string | null;
    hasVideoStream?: boolean;
  } = {},
): string {
  const {
    width = 1920,
    height = 1080,
    rotation = "0",
    creationTime = "2024-01-15T10:30:00.000000Z",
    hasVideoStream = true,
  } = overrides;

  const streams: unknown[] = [];
  if (hasVideoStream) {
    const stream: Record<string, unknown> = {
      index: 0,
      codec_name: "h264",
      codec_type: "video",
      width,
      height,
    };
    // rotation 在 ffprobe 中位于 side_data_list
    if (rotation !== null) {
      stream.side_data_list = [{ rotation: Number.parseInt(rotation, 10) }];
    }
    streams.push(stream);
  }

  const format: Record<string, unknown> = {
    filename: "test.mov",
    nb_streams: hasVideoStream ? 1 : 0,
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
  };

  if (creationTime !== null) {
    format.tags = { creation_time: creationTime };
  }

  return JSON.stringify({ streams, format });
}

/** 设置 execFile mock 以返回成功的 ffprobe 输出 */
function mockExecFileSuccess(stdout: string) {
  vi.mocked(execFile).mockImplementation((...allArgs: unknown[]) => {
    const maybeCb = allArgs[allArgs.length - 1];
    if (typeof maybeCb === "function") {
      (maybeCb as (err: null, stdout: string, stderr: string) => void)(null, stdout, "");
    }
    return {} as ReturnType<typeof execFile>;
  });
}

/** 设置 execFile mock 以返回失败的 ffprobe 调用 */
function mockExecFileError(error: NodeJS.ErrnoException) {
  vi.mocked(execFile).mockImplementation((...allArgs: unknown[]) => {
    const maybeCb = allArgs[allArgs.length - 1];
    if (typeof maybeCb === "function") {
      (maybeCb as (err: NodeJS.ErrnoException, stdout: string, stderr: string) => void)(
        error,
        "",
        error.message,
      );
    }
    return {} as ReturnType<typeof execFile>;
  });
}

// ---- 测试 ----

describe("getVideoMetadata — 视频元数据提取验收测试（设计文档 §1）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("正常场景", () => {
    it("应正确返回 width/height/takenAt", async () => {
      mockExecFileSuccess(makeFfprobeOutput());

      const result = await getVideoMetadata("/videos/test.mov");

      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.takenAt).toBeInstanceOf(Date);
      expect(result.takenAt?.toISOString()).toBe("2024-01-15T10:30:00.000Z");
    });

    it("应正确解析 4K 视频的宽高", async () => {
      mockExecFileSuccess(makeFfprobeOutput({ width: 3840, height: 2160 }));

      const result = await getVideoMetadata("/videos/4k-test.mp4");

      expect(result.width).toBe(3840);
      expect(result.height).toBe(2160);
    });
  });

  describe("rotation 处理", () => {
    it("竖拍视频 rotation: -90 应正确交换宽高", async () => {
      // 原始编码为 1080x1920，rotation -90 表示需要旋转 -90 度观看
      mockExecFileSuccess(makeFfprobeOutput({ width: 1080, height: 1920, rotation: "-90" }));

      const result = await getVideoMetadata("/videos/portrait-90.mov");

      // rotation -90 → 交换宽高：实际可视尺寸为 1920x1080
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });

    it("竖拍视频 rotation: 90 应正确交换宽高", async () => {
      mockExecFileSuccess(makeFfprobeOutput({ width: 1080, height: 1920, rotation: "90" }));

      const result = await getVideoMetadata("/videos/portrait+90.mov");

      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });

    it("rotation: 180 不应交换宽高", async () => {
      mockExecFileSuccess(makeFfprobeOutput({ width: 1920, height: 1080, rotation: "180" }));

      const result = await getVideoMetadata("/videos/upside-down.mov");

      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });

    it("rotation: 0 不应交换宽高", async () => {
      mockExecFileSuccess(makeFfprobeOutput({ width: 1920, height: 1080, rotation: "0" }));

      const result = await getVideoMetadata("/videos/normal.mov");

      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });

    it("无 rotation tag 时不应交换宽高", async () => {
      const output = JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: 1920,
            height: 1080,
          },
        ],
        format: {
          tags: { creation_time: "2024-05-20T15:00:00Z" },
        },
      });
      mockExecFileSuccess(output);

      const result = await getVideoMetadata("/videos/no-rotation.mov");

      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });
  });

  describe("takenAt 解析", () => {
    it("无 creation_time 时 takenAt 应为 undefined", async () => {
      mockExecFileSuccess(makeFfprobeOutput({ creationTime: null }));

      const result = await getVideoMetadata("/videos/no-date.mov");

      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.takenAt).toBeUndefined();
    });

    it("format 无 tags 字段时 takenAt 应为 undefined", async () => {
      const output = JSON.stringify({
        streams: [{ codec_type: "video", width: 1920, height: 1080 }],
        format: {
          filename: "test.mov",
        },
      });
      mockExecFileSuccess(output);

      const result = await getVideoMetadata("/videos/no-tags.mov");

      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.takenAt).toBeUndefined();
    });

    it("应正确解析不同格式的 creation_time", async () => {
      mockExecFileSuccess(makeFfprobeOutput({ creationTime: "2023-12-25T08:15:30.000000Z" }));

      const result = await getVideoMetadata("/videos/christmas.mov");

      expect(result.takenAt).toBeInstanceOf(Date);
      expect(result.takenAt?.getFullYear()).toBe(2023);
      expect(result.takenAt?.getMonth()).toBe(11); // December
      expect(result.takenAt?.getDate()).toBe(25);
    });
  });

  describe("无 video stream", () => {
    it("无 video stream 时应返回 {}", async () => {
      const output = JSON.stringify({
        streams: [{ codec_type: "audio", codec_name: "aac" }],
        format: {
          tags: { creation_time: "2024-01-15T10:30:00Z" },
        },
      });
      mockExecFileSuccess(output);

      const result = await getVideoMetadata("/videos/audio-only.m4a");

      expect(result.width).toBeUndefined();
      expect(result.height).toBeUndefined();
      expect(result.takenAt).toBeUndefined();
    });

    it("streams 为空数组时应返回 {}", async () => {
      const output = JSON.stringify({
        streams: [],
        format: {
          tags: { creation_time: "2024-01-15T10:30:00Z" },
        },
      });
      mockExecFileSuccess(output);

      const result = await getVideoMetadata("/videos/empty-streams.mov");

      expect(result.width).toBeUndefined();
      expect(result.height).toBeUndefined();
    });
  });

  describe("ffprobe 异常处理", () => {
    it("ffprobe 不存在 (ENOENT) 时返回 {} 并 console.warn", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error: NodeJS.ErrnoException = new Error("spawn ffprobe ENOENT");
      error.code = "ENOENT";
      mockExecFileError(error);

      const result = await getVideoMetadata("/videos/test.mov");

      expect(result.width).toBeUndefined();
      expect(result.height).toBeUndefined();
      expect(result.takenAt).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("ffprobe 超时时返回 {} 并 console.warn", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error: NodeJS.ErrnoException = new Error("ETIMEDOUT");
      error.code = "ETIMEDOUT";
      mockExecFileError(error);

      const result = await getVideoMetadata("/videos/test.mov");

      expect(result.width).toBeUndefined();
      expect(result.height).toBeUndefined();
      expect(result.takenAt).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("ffprobe 返回非零退出码时返回 {} 并 console.warn", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error: NodeJS.ErrnoException = new Error("Command failed: ffprobe ...");
      error.code = 1; // 非零退出码
      mockExecFileError(error);

      const result = await getVideoMetadata("/videos/corrupt.mov");

      expect(result.width).toBeUndefined();
      expect(result.height).toBeUndefined();
      expect(result.takenAt).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("ffprobe 返回无效 JSON 时返回 {}", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(execFile).mockImplementation((...allArgs: unknown[]) => {
        const maybeCb = allArgs[allArgs.length - 1];
        if (typeof maybeCb === "function") {
          (maybeCb as (err: null, stdout: string, stderr: string) => void)(
            null,
            "not valid json at all",
            "",
          );
        }
        return {} as ReturnType<typeof execFile>;
      });

      const result = await getVideoMetadata("/videos/bad-output.mov");

      expect(result.width).toBeUndefined();
      expect(result.height).toBeUndefined();
      expect(result.takenAt).toBeUndefined();
      warnSpy.mockRestore();
    });
  });
});

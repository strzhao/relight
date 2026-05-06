/**
 * 验收测试：Whisper 转录模块 (transcribe.ts)
 *
 * 覆盖风险点 A：Whisper CLI 输出位置
 * - 脚本写 JSON 到 <outputDir>/<stem>.json 文件，stdout 是日志
 * - transcribeAudio() 必须从文件读取 JSON，而不是从 stdout 读取
 * - 验证 detectWhisperCapability() 接口契约
 *
 * 测试策略：
 * - mock child_process.spawn，模拟脚本执行：向 stdout 写垃圾日志，向文件写正确 JSON
 * - 验证 transcribeAudio() 返回的内容来自文件而非 stdout
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 被测模块（蓝队实现后才能通过）
import { detectWhisperCapability, transcribeAudio } from "../transcribe";

/** 标准转录 JSON 格式 */
interface WhisperResult {
  text: string;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
  }>;
}

describe("detectWhisperCapability — Whisper 可用性检测 (风险点 A 前置契约)", () => {
  it("应返回包含 available 布尔属性的对象", async () => {
    const result = await detectWhisperCapability();

    expect(result).toBeDefined();
    expect(typeof result.available).toBe("boolean");
  });

  it("即使 Whisper 不可用也不应抛出异常", async () => {
    // 可用性检测本身不能抛 — 只能返回 false
    await expect(detectWhisperCapability()).resolves.toBeDefined();
  });
});

describe("transcribeAudio — 从文件读取 JSON 契约 (风险点 A BLOCKER)", () => {
  let tempDir: string;
  let fakeAudioPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "relight-transcribe-test-"));
    // 创建假的音频文件（内容不重要，只需文件存在）
    fakeAudioPath = path.join(tempDir, "test-audio.wav");
    fs.writeFileSync(fakeAudioPath, Buffer.from("FAKE_AUDIO_CONTENT"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  it("【BLOCKER 风险点 A】stdout 是垃圾日志、JSON 写在文件时：必须从文件返回正确结果", async () => {
    /**
     * 这是最关键的验收测试：
     *
     * 1. mock spawn，让脚本：
     *    - stdout 发出垃圾日志（非 JSON）
     *    - 在 outputDir/<stem>.json 写入正确 JSON
     *    - 退出码 0
     *
     * 2. 调用 transcribeAudio()
     *
     * 3. 验证返回结果来自文件 JSON，而非 stdout
     */

    const expectedResult: WhisperResult = {
      text: "这是从文件读取的正确转录文本",
      segments: [
        { start: 0, end: 2.5, text: "这是" },
        { start: 2.5, end: 5.0, text: "从文件读取的正确转录文本" },
      ],
    };

    // 计算脚本期望写入的文件路径：<outputDir>/<stem>.json
    const audioStem = path.basename(fakeAudioPath, path.extname(fakeAudioPath));

    // mock spawn：stdout 写垃圾日志，文件写正确 JSON，进程退出码 0
    const { spawn } = await import("node:child_process");
    const spawnMock = vi
      .spyOn(await import("node:child_process"), "spawn")
      .mockImplementation((cmd: string, args: readonly string[]) => {
        // 找到 outputDir 参数（假设以 --output-dir 或 -o 传递）
        const outputDirIdx = args.findIndex((a) => a === "--output-dir" || a === "-o");
        const outputDir = outputDirIdx !== -1 ? args[outputDirIdx + 1] : tempDir;

        // 向 outputDir 写入正确 JSON
        const jsonPath = path.join(outputDir as string, `${audioStem}.json`);
        fs.mkdirSync(outputDir as string, { recursive: true });

        const fakeProcess = {
          stdout: {
            on: (event: string, cb: (data: Buffer) => void) => {
              if (event === "data") {
                // stdout 故意输出垃圾日志（非 JSON）
                setTimeout(() => {
                  cb(Buffer.from("INFO: Processing audio file...\n"));
                  cb(Buffer.from("DEBUG: Loading model whisper-medium\n"));
                  cb(Buffer.from("WARNING: some irrelevant log line\n"));
                }, 10);
              }
            },
          },
          stderr: {
            on: (_event: string, _cb: unknown) => {},
          },
          on: (event: string, cb: (code: number) => void) => {
            if (event === "close") {
              // 先写文件，再触发 close 事件
              setTimeout(() => {
                fs.writeFileSync(jsonPath, JSON.stringify(expectedResult), "utf-8");
                cb(0); // 退出码 0
              }, 50);
            }
          },
        };
        return fakeProcess as ReturnType<typeof spawn>;
      });

    try {
      const result = await transcribeAudio(fakeAudioPath);

      // 验证返回的是文件内容，而非 stdout 垃圾
      expect(result).not.toBeNull();
      if (!result) throw new Error("transcribeAudio 返回 null（未预期）");
      expect(result.text).toBe(expectedResult.text);
      expect(Array.isArray(result.segments)).toBe(true);
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0]?.start).toBe(0);
      expect(result.segments[0]?.text).toBe("这是");
    } finally {
      spawnMock.mockRestore();
    }
  });

  it("【风险点 A 反向验证】stdout 解析的结果不应被采用", async () => {
    /**
     * stdout 输出了一个 JSON 字符串，但文件内容不同。
     * 验证最终结果应来自文件，而非 stdout。
     */
    const { spawn } = await import("node:child_process");
    const audioStem = path.basename(fakeAudioPath, path.extname(fakeAudioPath));

    const fileResult: WhisperResult = { text: "文件里的内容" };
    const stdoutResult = { text: "stdout里的错误内容" };

    const spawnMock = vi
      .spyOn(await import("node:child_process"), "spawn")
      .mockImplementation((cmd: string, args: readonly string[]) => {
        const outputDirIdx = args.findIndex((a) => a === "--output-dir" || a === "-o");
        const outputDir = outputDirIdx !== -1 ? args[outputDirIdx + 1] : tempDir;
        const jsonPath = path.join(outputDir as string, `${audioStem}.json`);
        fs.mkdirSync(outputDir as string, { recursive: true });

        const fakeProcess = {
          stdout: {
            on: (event: string, cb: (data: Buffer) => void) => {
              if (event === "data") {
                setTimeout(() => {
                  // stdout 输出一个诱骗性的 JSON（不应被采用）
                  cb(Buffer.from(`${JSON.stringify(stdoutResult)}\n`));
                }, 10);
              }
            },
          },
          stderr: {
            on: (_event: string, _cb: unknown) => {},
          },
          on: (event: string, cb: (code: number) => void) => {
            if (event === "close") {
              setTimeout(() => {
                // 文件里写入不同内容
                fs.writeFileSync(jsonPath, JSON.stringify(fileResult), "utf-8");
                cb(0);
              }, 50);
            }
          },
        };
        return fakeProcess as ReturnType<typeof spawn>;
      });

    try {
      const result = await transcribeAudio(fakeAudioPath);
      expect(result).not.toBeNull();
      if (!result) throw new Error("transcribeAudio 返回 null（未预期）");
      // 结果应来自文件（"文件里的内容"），不应来自 stdout（"stdout里的错误内容"）
      expect(result.text).toBe(fileResult.text);
      expect(result.text).not.toBe(stdoutResult.text);
    } finally {
      spawnMock.mockRestore();
    }
  });

  it("脚本退出码非 0 时：应抛出包含原因的错误", async () => {
    const { spawn } = await import("node:child_process");

    const spawnMock = vi
      .spyOn(await import("node:child_process"), "spawn")
      .mockImplementation(() => {
        const fakeProcess = {
          stdout: { on: (_e: string, _cb: unknown) => {} },
          stderr: {
            on: (event: string, cb: (data: Buffer) => void) => {
              if (event === "data") {
                setTimeout(() => cb(Buffer.from("ERROR: model load failed\n")), 10);
              }
            },
          },
          on: (event: string, cb: (code: number) => void) => {
            if (event === "close") {
              setTimeout(() => cb(1), 30); // 非 0 退出码
            }
          },
        };
        return fakeProcess as ReturnType<typeof spawn>;
      });

    try {
      await expect(transcribeAudio(fakeAudioPath)).rejects.toThrow();
    } finally {
      spawnMock.mockRestore();
    }
  });

  it("JSON 文件不存在时（脚本退出 0 但未写文件）：应抛出有意义错误", async () => {
    const { spawn } = await import("node:child_process");

    const spawnMock = vi
      .spyOn(await import("node:child_process"), "spawn")
      .mockImplementation(() => {
        const fakeProcess = {
          stdout: { on: (_e: string, _cb: unknown) => {} },
          stderr: { on: (_e: string, _cb: unknown) => {} },
          on: (event: string, cb: (code: number) => void) => {
            if (event === "close") {
              setTimeout(() => cb(0), 20); // 退出 0 但没写文件
            }
          },
        };
        return fakeProcess as ReturnType<typeof spawn>;
      });

    try {
      await expect(transcribeAudio(fakeAudioPath)).rejects.toThrow();
    } finally {
      spawnMock.mockRestore();
    }
  });
});

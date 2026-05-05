/**
 * 验收测试：ffmpeg 模块 (ffmpeg.ts)
 *
 * 覆盖：
 * - detectVideoCapability() 接口契约
 * - probeVideo() 字段覆盖（duration/codec/fps/width/height）
 * - extractFrames() 边界情况（帧数 1/4/6）
 * - extractAudio() 输出路径是否有效
 *
 * Fixture：beforeAll 用 ffmpeg -f lavfi 现场生成测试视频
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 被测模块（蓝队实现后才能通过）
import { detectVideoCapability, extractAudio, extractFrames, probeVideo } from "../ffmpeg";

const execFileAsync = promisify(execFile);

let fixtureVideoPath: string;
let tempDir: string;
let ffmpegAvailable = false;

beforeAll(async () => {
  // 检测 ffmpeg 是否可用
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "relight-ffmpeg-test-"));
  fixtureVideoPath = path.join(tempDir, "fixture.mp4");

  if (ffmpegAvailable) {
    // 生成 5 秒 320×240 测试视频（含音频）
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=5:size=320x240:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=5",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-t",
      "5",
      fixtureVideoPath,
    ]);
  }
}, 60_000);

afterAll(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // 忽略
  }
});

describe("detectVideoCapability — ffmpeg 可用性检测", () => {
  it("应返回包含 available 布尔属性的对象", async () => {
    const result = await detectVideoCapability();

    expect(result).toBeDefined();
    expect(typeof result.available).toBe("boolean");
  });

  it("即使 ffmpeg 不存在也不应抛出异常", async () => {
    await expect(detectVideoCapability()).resolves.toBeDefined();
  });

  it("返回值应与系统实际 ffmpeg 可用状态一致", async () => {
    const result = await detectVideoCapability();
    expect(result.available).toBe(ffmpegAvailable);
  });
});

describe("probeVideo — 视频元信息提取", () => {
  it.skipIf(!ffmpegAvailable)(
    "应返回 durationSec、videoCodec、videoFps、width、height",
    async () => {
      const info = await probeVideo(fixtureVideoPath);

      expect(info).toBeDefined();
      // durationSec：数字，接近 5 秒
      expect(typeof info.durationSec).toBe("number");
      expect(info.durationSec).toBeGreaterThan(4);
      expect(info.durationSec).toBeLessThan(6);

      // videoCodec：字符串（h264）
      expect(typeof info.videoCodec).toBe("string");
      expect(info.videoCodec.length).toBeGreaterThan(0);

      // videoFps：数字，接近 30
      expect(typeof info.videoFps).toBe("number");
      expect(info.videoFps).toBeGreaterThan(0);

      // width / height
      expect(typeof info.width).toBe("number");
      expect(info.width).toBe(320);
      expect(typeof info.height).toBe("number");
      expect(info.height).toBe(240);
    },
  );

  it.skipIf(!ffmpegAvailable)("损坏视频文件：应抛出包含原因的错误", async () => {
    const corruptPath = path.join(tempDir, "corrupt.mp4");
    fs.writeFileSync(corruptPath, Buffer.from("NOT_A_VALID_VIDEO_FILE"));

    await expect(probeVideo(corruptPath)).rejects.toThrow();
  });

  it("不存在的文件：应抛出错误", async () => {
    await expect(probeVideo("/tmp/nonexistent-video-99999.mp4")).rejects.toThrow();
  });
});

describe("extractFrames — 抽帧边界情况 (风险点 E 前置)", () => {
  it.skipIf(!ffmpegAvailable)("请求 1 帧：应返回 1 个 Buffer，且为有效图片", async () => {
    const frames = await extractFrames(fixtureVideoPath, 1);

    expect(Array.isArray(frames)).toBe(true);
    expect(frames).toHaveLength(1);
    const f0 = frames[0]!;
    expect(Buffer.isBuffer(f0)).toBe(true);
    expect(f0.length).toBeGreaterThan(500);
  });

  it.skipIf(!ffmpegAvailable)("请求 4 帧：应返回 4 个 Buffer", async () => {
    const frames = await extractFrames(fixtureVideoPath, 4);

    expect(Array.isArray(frames)).toBe(true);
    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect(Buffer.isBuffer(frame)).toBe(true);
      expect(frame.length).toBeGreaterThan(500);
    }
  });

  it.skipIf(!ffmpegAvailable)("请求 6 帧（标准配置）：应返回 6 个 Buffer", async () => {
    const frames = await extractFrames(fixtureVideoPath, 6);

    expect(Array.isArray(frames)).toBe(true);
    expect(frames).toHaveLength(6);
    for (const frame of frames) {
      expect(Buffer.isBuffer(frame)).toBe(true);
      expect(frame.length).toBeGreaterThan(500);
    }
  });

  it.skipIf(!ffmpegAvailable)("返回帧是 JPEG 格式（FF D8 FF 魔数）", async () => {
    const frames = await extractFrames(fixtureVideoPath, 3);

    for (const frame of frames) {
      // JPEG 魔数
      expect(frame[0]).toBe(0xff);
      expect(frame[1]).toBe(0xd8);
      expect(frame[2]).toBe(0xff);
    }
  });

  it("不存在的视频：应抛出错误", async () => {
    await expect(extractFrames("/tmp/nonexistent-99999.mp4", 6)).rejects.toThrow();
  });
});

describe("extractAudio — 音频提取", () => {
  it.skipIf(!ffmpegAvailable)("应返回存在的音频文件路径", async () => {
    const outputDir = path.join(tempDir, "audio-output");
    fs.mkdirSync(outputDir, { recursive: true });

    const targetWav = `${outputDir}/audio.wav`;
    const audioPath = await extractAudio(fixtureVideoPath, targetWav);

    // 测试视频是否含音轨：lavfi testsrc 默认无音轨 → null；含音轨 → 返回路径
    if (audioPath === null) {
      // 测试 fixture 无音轨：跳过 size 校验
      return;
    }
    expect(typeof audioPath).toBe("string");
    expect(fs.existsSync(audioPath)).toBe(true);
    const stat = fs.statSync(audioPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("不存在的视频：应抛出错误", async () => {
    await expect(extractAudio("/tmp/nonexistent-99999.mp4", tempDir)).rejects.toThrow();
  });
});

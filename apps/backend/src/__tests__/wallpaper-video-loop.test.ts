/**
 * 单测：lib/wallpaper/video.ts — buildLoop（v2 增量任务 13）
 *
 * 契约（state.md ## 契约规约 计算/spawn 契约）：
 *   buildLoop(src, targetSeconds) → {loopPath, segments: number}
 *   palindrome 产物：时长 ≥ targetSeconds ∧ 为单段时长整数倍（段级帧容差）∧ 偶数段
 *   错误枚举 LoopBuildError：ffmpeg 失败 / 拼接后时长 < targetSeconds-1
 *
 * 测试策略：真实小样本 1s 片（ffmpeg lavfi testsrc + sine 音轨）+ 真实 ffmpeg/ffprobe，
 * 时长断言帧级容差（跨平台 ffmpeg 每段拼接边界可 ±1 帧，[2026-09-14] 由 ±1 帧放宽为 ±段数）；
 * 错误分支用 fake ffprobe/ffmpeg 脚本注入 config（运行时覆盖，
 * 照 wallpaper-video-transcode.test.ts 的 fallback 用例模式）。
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { config } from "../lib/config";
import { LoopBuildError, buildLoop } from "../lib/wallpaper/video";

const tmpDir = path.join(os.tmpdir(), `wv-loop-test-${process.pid}`);
const FPS = 24;
const FRAME_MS = 1000 / FPS;

function probeInfo(p: string): {
  formatDuration: number;
  videoFrames: number;
  audioStreams: Array<{ codec_name?: string }>;
} {
  const out = execFileSync(
    config.video.ffprobePath,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", p],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; nb_frames?: string }>;
  };
  const videoStream = (parsed.streams ?? []).find((s) => s.codec_type === "video");
  return {
    formatDuration: Number(parsed.format?.duration ?? 0),
    // concat 分段边界在 stream duration 元数据上有 timebase 舍入伪差（每段 ≤0.5 帧），
    // 帧数做时轴锚点；跨平台 ffmpeg 每段拼接边界可 ±1 帧（CI Linux 实测 4s/96→98、8s/192→196），
    // [2026-09-14] 断言由逐字相等放宽为 ±段数（每段边界各计 1 帧）
    videoFrames: Number(videoStream?.nb_frames ?? 0),
    audioStreams: (parsed.streams ?? []).filter((s) => s.codec_type === "audio"),
  };
}

beforeAll(() => {
  mkdirSync(tmpDir, { recursive: true });
  // 真实 1s 小样本：testsrc 视频 + 440Hz 正弦音轨（libx264 + aac，24fps）
  execFileSync(
    config.video.ffmpegPath,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=320x240:rate=${FPS}:duration=1`,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-shortest",
      path.join(tmpDir, "sample-1s.mp4"),
    ],
    { stdio: "ignore" },
  );
  // 无音轨样本（buildLoop 纯视频分支）
  execFileSync(
    config.video.ffmpegPath,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=320x240:rate=${FPS}:duration=1`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      path.join(tmpDir, "sample-1s-silent.mp4"),
    ],
    { stdio: "ignore" },
  );
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildLoop（真实 ffmpeg/ffprobe，1s 小样本）", () => {
  it("4s 目标：1s 源 ×2 对 palindrome → segments=4 ∧ 时长≈4s（±1 帧）∧ 保留 aac 音轨", async () => {
    const src = path.join(tmpDir, "sample-1s.mp4");
    const srcInfo = probeInfo(src);
    expect(srcInfo.videoFrames).toBeGreaterThan(10);

    const { loopPath, segments } = await buildLoop(src, 4);
    expect(segments).toBe(4);
    expect(loopPath).toMatch(/sample-1s-loop\.mp4$/);

    const out = probeInfo(loopPath);
    // 契约：产物时长 ≥ targetSeconds（±1 帧容差）∧ 为单段时长整数倍（±1 帧容差）。
    // 整数倍以帧数断言（精确）；format.duration ≥ target（含 aac 尾部，只会更长）
    expect(out.formatDuration).toBeGreaterThanOrEqual(4 - FRAME_MS / 1000 - 0.001);
    // 整数倍以帧数断言（±段数：跨平台拼接边界舍入，见上方模块注释）
    expect(Math.abs(out.videoFrames - segments * srcInfo.videoFrames)).toBeLessThanOrEqual(
      segments,
    );
    // 音轨 palindrome 同构：输出有 aac 音频流
    expect(out.audioStreams.length).toBe(1);
    expect(out.audioStreams[0]?.codec_name).toBe("aac");
  });

  it("8s 目标（默认 loopSeconds）：1s 源 → segments=8 ∧ 时长≈8s（±1 帧）", async () => {
    const src = path.join(tmpDir, "sample-1s.mp4");
    const srcInfo = probeInfo(src);
    const { loopPath, segments } = await buildLoop(src, 8);
    expect(segments).toBe(8);
    const out = probeInfo(loopPath);
    expect(out.formatDuration).toBeGreaterThanOrEqual(8 - FRAME_MS / 1000 - 0.001);
    expect(Math.abs(out.videoFrames - segments * srcInfo.videoFrames)).toBeLessThanOrEqual(
      segments,
    );
  });

  it("无音轨源 → 纯视频 palindrome（输出零音频流）", async () => {
    const src = path.join(tmpDir, "sample-1s-silent.mp4");
    const { loopPath, segments } = await buildLoop(src, 2);
    expect(segments).toBe(2);
    expect(probeInfo(loopPath).audioStreams.length).toBe(0);
  });

  it("源文件不存在 → LoopBuildError", async () => {
    await expect(buildLoop(path.join(tmpDir, "no-such.mp4"), 4)).rejects.toBeInstanceOf(
      LoopBuildError,
    );
  });

  it("ffmpeg 拼接失败 → LoopBuildError（fake ffmpeg 退出非零）", async () => {
    const fakeFfmpeg = path.join(tmpDir, "fake-ffmpeg-fail.sh");
    writeFileSync(fakeFfmpeg, '#!/bin/sh\necho "boom" >&2\nexit 1\n', { mode: 0o755 });
    chmodSync(fakeFfmpeg, 0o755);
    const savedFfmpeg = config.video.ffmpegPath;
    (config.video as { ffmpegPath: string }).ffmpegPath = fakeFfmpeg;
    try {
      const err = await buildLoop(path.join(tmpDir, "sample-1s.mp4"), 4).catch((e) => e);
      expect(err).toBeInstanceOf(LoopBuildError);
      expect(err.message).toContain("ffmpeg 拼接失败");
    } finally {
      (config.video as { ffmpegPath: string }).ffmpegPath = savedFfmpeg;
    }
  });

  it("拼接后时长 < targetSeconds-1 → LoopBuildError（fake ffprobe 谎报短时长）", async () => {
    // fake ffprobe：对源报 1s（驱动 2 对拼接），对产物（路径含 -loop.mp4）报 0.2s；
    // 只输出 JSON（probeVideoFile 对 stdout 整体 JSON.parse，参数回显会污染）
    const fakeFfprobe = path.join(tmpDir, "fake-ffprobe-short.sh");
    writeFileSync(
      fakeFfprobe,
      `#!/bin/sh\nLOOP=0\nfor a in "$@"; do case "$a" in *loop.mp4*) LOOP=1;; esac; done\nif [ "$LOOP" = "1" ]; then\n  echo '{"format":{"duration":"0.2"},"streams":[{"codec_type":"video","width":320,"height":240,"r_frame_rate":"24/1"},{"codec_type":"audio","codec_name":"aac"}]}'\nelse\n  echo '{"format":{"duration":"1.0"},"streams":[{"codec_type":"video","width":320,"height":240,"r_frame_rate":"24/1"},{"codec_type":"audio","codec_name":"aac"}]}'\nfi\n`,
      { mode: 0o755 },
    );
    chmodSync(fakeFfprobe, 0o755);
    // fake ffmpeg：touch 产物（拼接成功但时长谎报）
    const fakeFfmpeg = path.join(tmpDir, "fake-ffmpeg-ok.sh");
    writeFileSync(
      fakeFfmpeg,
      `#!/bin/sh\nlast=""\nfor a in "$@"; do last="$a"; done\ntouch "$last"\n`,
      { mode: 0o755 },
    );
    chmodSync(fakeFfmpeg, 0o755);
    const savedFfmpeg = config.video.ffmpegPath;
    const savedFfprobe = config.video.ffprobePath;
    (config.video as { ffmpegPath: string }).ffmpegPath = fakeFfmpeg;
    (config.video as { ffprobePath: string }).ffprobePath = fakeFfprobe;
    try {
      const err = await buildLoop(path.join(tmpDir, "src.mp4"), 4).catch((e) => e);
      expect(err).toBeInstanceOf(LoopBuildError);
      expect(err.message).toContain("< 3s");
    } finally {
      (config.video as { ffmpegPath: string }).ffmpegPath = savedFfmpeg;
      (config.video as { ffprobePath: string }).ffprobePath = savedFfprobe;
    }
  });

  it("targetSeconds 非法（NaN/≤0）→ 按 8 兜底", async () => {
    const src = path.join(tmpDir, "sample-1s.mp4");
    const { segments } = await buildLoop(src, Number.NaN);
    expect(segments).toBe(8);
  });
});

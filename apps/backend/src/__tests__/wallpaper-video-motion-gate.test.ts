/**
 * 单测：lib/wallpaper/video.ts — measureVideoMotion（20261014 运动量验收门）
 *
 * 契约：
 *   measureVideoMotion(filePath) → {peak, fdiffAvg, frames}
 *   - peak = max_i mean(|frame_i − frame_0|)/255×100；fdiffAvg = 平均帧间变化
 *   - 无损 gray 320×180 rawvideo（禁 JPEG——压缩噪声污染测量）
 *   - ffmpeg 失败/帧数 <2 → throw（调用方 fail-open）
 *
 * 测试策略：真实 ffmpeg 造两类样本——testsrc2（持续运动）与纯色静帧（近零运动），
 * 锁「运动源 peak 显著高于静帧源」与静帧源 peak < 1%。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measureVideoMotion } from "../lib/wallpaper/video";

const tmpDir = path.join(os.tmpdir(), `wv-motion-test-${process.pid}`);

function makeSample(name: string, args: string[]): string {
  const out = path.join(tmpDir, name);
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args, "-pix_fmt", "yuv420p", "-an", out], {
    timeout: 30000,
  });
  return out;
}

describe("measureVideoMotion", () => {
  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("运动源（testsrc2）peak 显著高于零，帧数正确", async () => {
    const moving = makeSample("moving.mp4", [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24:duration=2",
      "-c:v",
      "libx264",
    ]);
    const stats = await measureVideoMotion(moving);
    expect(stats.frames).toBeGreaterThanOrEqual(40);
    // testsrc2 运动区占画幅比例有限（边缘静态标尺区），实测 ~4.6%
    expect(stats.peak).toBeGreaterThan(3);
    expect(stats.fdiffAvg).toBeGreaterThan(0.1);
  });

  it("静帧源（纯色）peak < 1%（近零基线，正是 2026-10-14 生产腿的病征）", async () => {
    const still = makeSample("still.mp4", [
      "-f",
      "lavfi",
      "-i",
      "color=c=0x2288cc:size=320x180:rate=24:duration=2",
      "-c:v",
      "libx264",
    ]);
    const stats = await measureVideoMotion(still);
    expect(stats.peak).toBeLessThan(1);
    expect(stats.fdiffAvg).toBeLessThan(0.05);
  });

  it("ffmpeg 失败（非媒体文件）→ throw（调用方 fail-open 的前提）", async () => {
    const bad = path.join(tmpDir, "not-a-video.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(bad, "definitely not a video");
    await expect(measureVideoMotion(bad)).rejects.toThrow();
  });
});

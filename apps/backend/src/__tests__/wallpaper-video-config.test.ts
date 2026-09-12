/**
 * 单测：动态视频壁纸配置项（设计文档「后端设计 1. 配置」契约，v2 增量任务 12）
 *
 * - wallpaperVideoEnabled 默认关（DAILY_WALLPAPER_VIDEO 缺省 → false）
 * - wallpaperVideoSeconds 默认 4（recipes 纪律单条 ≤5s；v2 修订）
 * - wallpaperVideoLoopSeconds 默认 8（palindrome 目标时长；v2 新增）
 * - wallpaperVideoSpawnTimeoutMs 默认 5400000（90min/条）
 * - honeydoCliPath 存在（本机 which honeydo 可解析）且为绝对路径
 * - wallpaperVideoPrompt 人物收敛模板（「轻微呼吸起伏…动作轻柔」句式，30-50 字）
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function getFreshConfig() {
  const mod = await import("../lib/config");
  return mod.config;
}

describe("wallpaper video config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("DAILY_WALLPAPER_VIDEO 未设置时默认关闭", async () => {
    // biome-ignore lint/performance/noDelete: process.env 必须用 delete 取消设置
    delete process.env.DAILY_WALLPAPER_VIDEO;
    vi.resetModules();
    const config = await getFreshConfig();
    expect(config.wallpaperVideoEnabled).toBe(false);
  });

  it("DAILY_WALLPAPER_VIDEO=false 时关闭", async () => {
    process.env.DAILY_WALLPAPER_VIDEO = "false";
    vi.resetModules();
    const config = await getFreshConfig();
    expect(config.wallpaperVideoEnabled).toBe(false);
  });

  it("DAILY_WALLPAPER_VIDEO=true 时开启", async () => {
    process.env.DAILY_WALLPAPER_VIDEO = "true";
    vi.resetModules();
    const config = await getFreshConfig();
    expect(config.wallpaperVideoEnabled).toBe(true);
  });

  it("wallpaperVideoSeconds 默认 4（recipes 纪律单条 ≤5s，v2）", async () => {
    // biome-ignore lint/performance/noDelete: process.env 必须用 delete 取消设置
    delete process.env.WALLPAPER_VIDEO_SECONDS;
    vi.resetModules();
    const config = await getFreshConfig();
    expect(config.wallpaperVideoSeconds).toBe(4);
  });

  it("wallpaperVideoSeconds 可被 env 覆盖", async () => {
    process.env.WALLPAPER_VIDEO_SECONDS = "3";
    vi.resetModules();
    const config = await getFreshConfig();
    expect(config.wallpaperVideoSeconds).toBe(3);
  });

  it("wallpaperVideoLoopSeconds 默认 8（palindrome 目标时长，v2 新增）", async () => {
    // biome-ignore lint/performance/noDelete: process.env 必须用 delete 取消设置
    delete process.env.WALLPAPER_VIDEO_LOOP_SECONDS;
    vi.resetModules();
    const config = await getFreshConfig();
    expect(config.wallpaperVideoLoopSeconds).toBe(8);
  });

  it("wallpaperVideoLoopSeconds 可被 env 覆盖", async () => {
    process.env.WALLPAPER_VIDEO_LOOP_SECONDS = "12";
    vi.resetModules();
    const config = await getFreshConfig();
    expect(config.wallpaperVideoLoopSeconds).toBe(12);
  });

  it("wallpaperVideoSpawnTimeoutMs 默认 5400000", async () => {
    // biome-ignore lint/performance/noDelete: process.env 必须用 delete 取消设置
    delete process.env.WALLPAPER_VIDEO_SPAWN_TIMEOUT_MS;
    vi.resetModules();
    const config = await getFreshConfig();
    expect(config.wallpaperVideoSpawnTimeoutMs).toBe(5400000);
  });

  it("wallpaperVideoPrompt 为人物收敛模板（呼吸起伏/动作轻柔句式，30-50 字）", async () => {
    const config = await getFreshConfig();
    expect(config.wallpaperVideoPrompt).toContain("呼吸起伏");
    expect(config.wallpaperVideoPrompt).toContain("动作轻柔");
    expect(config.wallpaperVideoPrompt.length).toBeGreaterThanOrEqual(30);
    expect(config.wallpaperVideoPrompt.length).toBeLessThanOrEqual(50);
  });

  it("honeydoCliPath 为绝对路径（本机 which honeydo 可解析）", async () => {
    const config = await getFreshConfig();
    expect(config.honeydoCliPath).toBeTruthy();
    expect(config.honeydoCliPath.startsWith("/")).toBe(true);
  });
});

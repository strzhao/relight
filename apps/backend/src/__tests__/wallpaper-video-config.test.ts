/**
 * 单测：动态视频壁纸配置项（设计文档「后端设计 1. 配置」契约，v2 增量任务 12）
 *
 * - wallpaperVideoEnabled 默认关（DAILY_WALLPAPER_VIDEO 缺省 → false）
 * - wallpaperVideoSeconds 默认 4（recipes 纪律单条 ≤5s；v2 修订）
 * - wallpaperVideoLoopSeconds 默认 8（palindrome 目标时长；v2 新增）
 * - wallpaperVideoSpawnTimeoutMs 默认 5400000（90min/条）
 * - honeydoCliPath 存在（本机 which honeydo 可解析）且为绝对路径
 * - wallpaperVideoPromptPerson/Scene 分层默认模板（2026-09-13 修订：30-50 字 + Audio 指引，
 *   env WALLPAPER_VIDEO_PROMPT_PERSON/SCENE 可覆盖）
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

  it("wallpaperVideoPromptPerson/Scene 分层默认模板（30-50 字 + Audio 指引 + no talking）", async () => {
    const config = await getFreshConfig();
    // 人物默认：放开动作（2026-09-13 修订：去掉「保持姿态稳定/回到初始画面」过度收敛句式）
    expect(config.wallpaperVideoPromptPerson).not.toContain("保持姿态稳定");
    expect(config.wallpaperVideoPromptPerson).not.toContain("回到初始画面");
    expect(config.wallpaperVideoPromptPerson).toContain("Audio:");
    expect(config.wallpaperVideoPromptPerson).toContain("no talking");
    // 风景默认：镜头/环境运动 + Audio 指引
    expect(config.wallpaperVideoPromptScene).toContain("镜头");
    expect(config.wallpaperVideoPromptScene).toContain("Audio:");
    expect(config.wallpaperVideoPromptScene).toContain("no talking");
    // 30-50 字中文主体纪律（Audio 后缀不计入）
    for (const p of [config.wallpaperVideoPromptPerson, config.wallpaperVideoPromptScene]) {
      expect(p, "分层默认 prompt 必须存在").toBeTruthy();
      const zh = (p ?? "").split("Audio:")[0]?.trim() ?? "";
      expect(zh.length).toBeGreaterThanOrEqual(30);
      expect(zh.length).toBeLessThanOrEqual(50);
    }
  });

  it("WALLPAPER_VIDEO_PROMPT_PERSON/SCENE env 可覆盖分层默认（A/B 调参入口）", async () => {
    process.env.WALLPAPER_VIDEO_PROMPT_PERSON = "自定义人物运动描述，用于 A/B 验证";
    process.env.WALLPAPER_VIDEO_PROMPT_SCENE = "自定义风景运动描述，用于 A/B 验证";
    try {
      const config = await getFreshConfig();
      expect(config.wallpaperVideoPromptPerson).toContain("自定义人物");
      expect(config.wallpaperVideoPromptScene).toContain("自定义风景");
    } finally {
      process.env.WALLPAPER_VIDEO_PROMPT_PERSON = undefined;
      process.env.WALLPAPER_VIDEO_PROMPT_SCENE = undefined;
    }
  });

  it("honeydoCliPath 为绝对路径（本机 which honeydo 可解析）", async () => {
    const config = await getFreshConfig();
    expect(config.honeydoCliPath).toBeTruthy();
    expect(config.honeydoCliPath.startsWith("/")).toBe(true);
  });
});

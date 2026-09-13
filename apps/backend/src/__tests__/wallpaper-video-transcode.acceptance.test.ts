/**
 * 验收测试（红队）：动态视频壁纸 — 双转码产物 invariant【v2 增量】（真实小样本 ffprobe）
 *
 * 设计文档（state.md）对应契约（§契约规约 计算/spawn 契约【v2】逐字）：
 *   - transcodeForGallery 产物 invariant【v2】：容器 mp4 ∧ H.264 ∧ 有音频流（aac 立体声）
 *     ∧ 分辨率 == 源（704×1216）∧ faststart（画廊静音自动播放 + 点击开声）
 *   - transcodeForAerial 产物 invariant（2026-09-13 验收反转）：容器 mov ∧ HEVC（tag hvc1）
 *     ∧ 1920×1080 ∧ **保留音轨**（aac 立体声）∧ moov 在前（faststart）
 *   - §总体架构（v2）步骤 5：横版 HEVC(hvc1) .mov 1920×1080 带音轨 +faststart（Aerial 注入
 *     无声播放不受影响，下载/外放有环境音）；竖版 H.264 mp4 带音轨 +faststart（画廊用）
 *   - §Mac 注入契约（2026-09-13 更新）：双轨均保留音轨
 *
 * 验收点（round 2 编排器）：mock ffmpeg 参数断言见 wallpaper-video-overlay.acceptance.test.ts
 * （mock 面）；本文件为真实小样本 ffprobe 断言（验收点 4 可选项落实）——输入用 ffmpeg 造
 * 2s 短样片（画廊源 704×1216 竖版带立体声音轨；Aerial 源 1280×704 横版带音轨——
 * 带音轨是为了证明音轨真实保留而非静默丢弃）。
 *
 * 红队铁律：不读蓝队实现代码；transcodeForGallery / transcodeForAerial 按契约函数名黑盒
 *   import 执行；不 skip、硬断言——ffmpeg/ffprobe 不可用一律真红。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// hoisted holder + mock（config 全量 stub / db 真实 drizzle——仅保证模块 import 安全）
// ============================================================================

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  storageRoot: "/tmp/relight-none",
}));

const TEST_COS = vi.hoisted(() => ({
  bucket: "little-bee-assets-1324334992",
  region: "ap-shanghai",
  prefix: "relight",
}));

vi.mock("../lib/config", () => ({
  config: {
    get databasePath() {
      return process.env.DATABASE_PATH ?? holder.dbPath;
    },
    get storageRoot() {
      return holder.storageRoot;
    },
    wallpaperVideoEnabled: true,
    wallpaperVideoSeconds: 4,
    wallpaperVideoLoopSeconds: 8,
    wallpaperVideoSpawnTimeoutMs: 5400000,
    honeydoCliPath: "/usr/bin/false",
    wallpaperVideoPrompt:
      "画面中的景物以极缓慢的速度轻微摇曳，光影柔和流动，随后一切缓缓回到初始位置，如呼吸般自然",
    videoWorkspacePath: "/tmp/relight-none/video-workspace",
    repoRoot: "/tmp/relight-none",
    port: 3000,
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-wvtc-test",
    dailySelectionConcurrency: 1,
    dailyAutoHealDays: 0,
    dailySelectEnabled: false,
    ai: { baseUrl: "", apiKey: "", visionModel: "", model: "", promptVersion: "v2" },
    video: { enabled: true, frameCount: 6, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" },
    daily: { cronTime: "0 0 * * *", maxCandidates: 20, timezone: "Asia/Shanghai" },
    cos: {
      secretId: "test-id",
      secretKey: "test-key",
      bucket: TEST_COS.bucket,
      region: TEST_COS.region,
      prefix: TEST_COS.prefix,
    },
    galleryPublicUrl: "https://gallery.stringzhao.life",
    gallery: { vpsHost: "127.0.0.1", vpsUser: "test", vpsKey: "/tmp/test-key", vpsPath: "/tmp/g" },
  },
}));

vi.mock("../db", async () => {
  const actualSchema = await import("../db/schema");
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const sqlite = new Database(holder.dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { db: drizzle(sqlite, { schema: actualSchema }), schema: actualSchema };
});

// ============================================================================
// ffprobe / faststart 探测辅助
// ============================================================================

interface ProbeResult {
  formatName: string;
  videoCodec: string | null;
  codecTag: string | null;
  width: number | null;
  height: number | null;
  audioStreams: number;
  audioCodec: string | null;
  audioChannels: number | null;
}

function probe(file: string): ProbeResult {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { encoding: "utf-8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`ffprobe 失败（${file}）: ${r.stderr}`);
  }
  const j = JSON.parse(r.stdout) as {
    format?: { format_name?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      codec_tag_string?: string;
      width?: number;
      height?: number;
      channels?: number;
    }>;
  };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const audios = streams.filter((s) => s.codec_type === "audio");
  return {
    formatName: j.format?.format_name ?? "",
    videoCodec: v?.codec_name ?? null,
    codecTag: v?.codec_tag_string ?? null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    audioStreams: audios.length,
    audioCodec: audios[0]?.codec_name ?? null,
    audioChannels: audios[0]?.channels ?? null,
  };
}

/** faststart 不变式：moov box 在 mdat box 之前（文件字节序探测，与容器无关） */
function moovBeforeMdat(file: string): boolean {
  const buf = fs.readFileSync(file);
  const moov = buf.indexOf("moov");
  const mdat = buf.indexOf("mdat");
  return moov >= 0 && mdat >= 0 && moov < mdat;
}

// ============================================================================
// fixture：ffmpeg 造 2s 带立体声音轨样片（画廊源 704×1216 / Aerial 源 1280×704）
// ============================================================================

let tmpRoot = "";
let gallerySrc = "";
let aerialSrc = "";
let transcodeForGallery: (src: string, dst: string) => Promise<void>;
let transcodeForAerial: (src: string, dst: string) => Promise<void>;

function makeSrcWithStereoAudio(outPath: string, size: string): void {
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${size}:rate=24:duration=2`,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
      "-shortest",
      outPath,
    ],
    { encoding: "utf-8", timeout: 60000 },
  );
  if (r.status !== 0 || !fs.existsSync(outPath)) {
    throw new Error(`fixture ffmpeg 造样片失败（${size}）: ${r.stderr}`);
  }
}

beforeAll(async () => {
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8", timeout: 15000 });
  if (ff.status !== 0) {
    throw new Error("ffmpeg 不可用——转码验收要求真实 ffmpeg 环境");
  }
  const fp = spawnSync("ffprobe", ["-version"], { encoding: "utf-8", timeout: 15000 });
  if (fp.status !== 0) {
    throw new Error("ffprobe 不可用——转码验收要求真实 ffprobe 环境");
  }

  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvtc-"));
  const dbPath = path.join(tmpRoot, "test.db");
  holder.dbPath = dbPath;
  holder.storageRoot = path.join(tmpRoot, "storage");
  process.env.DATABASE_PATH = dbPath;
  process.env.STORAGE_ROOT = holder.storageRoot;

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite.close();

  // 画廊源：704×1216 竖版（契约 invariant 逐字分辨率）带立体声音轨
  gallerySrc = path.join(tmpRoot, "gallery-src.mp4");
  makeSrcWithStereoAudio(gallerySrc, "704x1216");
  // Aerial 源：1280×704 横版带音轨（证明 -an 真实剥离）
  aerialSrc = path.join(tmpRoot, "aerial-src.mp4");
  makeSrcWithStereoAudio(aerialSrc, "1280x704");

  // fixture 前置自检：源确有 1 条立体声音轨（fixture 失效即真红）
  for (const src of [gallerySrc, aerialSrc]) {
    const p = probe(src);
    expect(p.audioStreams, `fixture 源 ${src} 必须带音轨`).toBe(1);
    expect(p.audioChannels, "fixture 源音轨必须立体声（2 ch）").toBe(2);
  }

  const mod = (await import("../lib/wallpaper/video")) as unknown as Record<string, unknown>;
  expect(
    typeof mod.transcodeForGallery,
    "契约函数 transcodeForGallery 未由 lib/wallpaper/video 导出",
  ).toBe("function");
  expect(
    typeof mod.transcodeForAerial,
    "契约函数 transcodeForAerial 未由 lib/wallpaper/video 导出",
  ).toBe("function");
  transcodeForGallery = mod.transcodeForGallery as typeof transcodeForGallery;
  transcodeForAerial = mod.transcodeForAerial as typeof transcodeForAerial;
}, 60000);

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// 契约断言
// ============================================================================

describe("【v2】transcodeForGallery 产物 invariant：mp4 ∧ H.264 ∧ aac 立体声 ∧ 分辨率==源 ∧ faststart", () => {
  it("704×1216 竖版源 → 产物容器 mp4、h264、1 条 aac 立体声音轨、704×1216、moov 在前", async () => {
    const dst = path.join(tmpRoot, "2026-09-12_portrait.mp4");
    await transcodeForGallery(gallerySrc, dst);

    // 产物存在 ∧ 非空 ∧ ≠ 源
    expect(fs.existsSync(dst), `画廊转码产物不存在: ${dst}`).toBe(true);
    expect(fs.statSync(dst).size).toBeGreaterThan(0);

    const p = probe(dst);
    // 契约逐字 ①：容器 mp4
    expect(p.formatName, `容器必须为 mp4，实际 format_name=${p.formatName}`).toContain("mp4");
    // 契约逐字 ②：H.264
    expect(p.videoCodec, `视频编码必须为 h264，实际 ${p.videoCodec}`).toBe("h264");
    // 契约逐字 ③：有音频流（aac 立体声）
    expect(p.audioStreams, `必须含 1 条音频流（v2 画廊版保留音轨），实际 ${p.audioStreams}`).toBe(
      1,
    );
    expect(p.audioCodec, `音频编码必须为 aac，实际 ${p.audioCodec}`).toBe("aac");
    expect(p.audioChannels, `音频必须立体声（2 ch），实际 ${p.audioChannels}`).toBe(2);
    // 契约逐字 ④：分辨率 == 源（704×1216）
    expect(p.width, `宽度必须 704，实际 ${p.width}`).toBe(704);
    expect(p.height, `高度必须 1216，实际 ${p.height}`).toBe(1216);
    // 契约逐字 ⑤：faststart（moov 在前）
    expect(moovBeforeMdat(dst), "mp4 必须 +faststart（moov box 在 mdat 之前）").toBe(true);
  }, 120000);
});

describe("transcodeForAerial 产物 invariant（2026-09-13 起：mov ∧ hvc1 ∧ 1920×1080 ∧ 带音轨 ∧ faststart）", () => {
  it("1280×704 带音轨源 → 产物容器 mov、tag hvc1、1920×1080、1 条 aac 立体声音轨、moov 在前", async () => {
    const dst = path.join(tmpRoot, "2026-09-12_landscape.mov");
    await transcodeForAerial(aerialSrc, dst);

    expect(fs.existsSync(dst), `Aerial 转码产物不存在: ${dst}`).toBe(true);
    expect(fs.statSync(dst).size).toBeGreaterThan(0);

    const p = probe(dst);
    // 契约逐字 ①：容器 mov
    expect(p.formatName, `容器必须为 mov，实际 format_name=${p.formatName}`).toContain("mov");
    // 契约逐字 ②：HEVC（tag hvc1）
    expect(p.codecTag, `视频 tag 必须为 hvc1，实际 ${p.codecTag}`).toBe("hvc1");
    // 契约逐字 ③：1920×1080
    expect(p.width, `宽度必须 1920，实际 ${p.width}`).toBe(1920);
    expect(p.height, `高度必须 1080，实际 ${p.height}`).toBe(1080);
    // 契约逐字 ④：保留音轨（2026-09-13 验收要求：以后生成的视频带音轨）
    expect(p.audioStreams, `必须保留 1 条音频流，实际 ${p.audioStreams}`).toBe(1);
    expect(p.audioCodec, `音频编码必须为 aac，实际 ${p.audioCodec}`).toBe("aac");
    expect(p.audioChannels, `音频必须立体声（2 ch），实际 ${p.audioChannels}`).toBe(2);
    // 契约逐字 ⑤：faststart（moov 在前）
    expect(moovBeforeMdat(dst), "mov 必须 +faststart（moov box 在 mdat 之前）").toBe(true);
  }, 600000);
});

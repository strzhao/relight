/**
 * 验收测试（红队）：动态视频壁纸 — buildLoop palindrome 拼接契约【v2 增量】
 *
 * 设计文档（state.md）对应契约（§契约规约 计算/spawn 契约【v2】逐字）：
 *   - buildLoop(src, targetSeconds) → {loopPath, segments: number}
 *   - 边界值【v2】：palindrome 产物时长 ≥ loopSeconds ∧ 为单段时长整数倍（±1 帧容差）
 *   - 错误枚举：LoopBuildError（ffmpeg 失败 / 拼接后时长 < targetSeconds-1）
 *   - §总体架构（v2）步骤 3：palindrome 拼接至 WALLPAPER_VIDEO_LOOP_SECONDS(默认8s)
 *   - 验收点（round 2 编排器）：palindrome 产物时长 ≥ loopSeconds ∧ 偶数段；
 *     真实小样本测试（ffmpeg 造 1s 样片，产物 ffprobe 断言时长与段结构）
 *
 * 段结构断言语义（§契约规约「为单段时长整数倍」锚定）：
 *   段 = 拼接的单向基本片段（含顺放/逆放各一段，每段时长 == 源片时长）。
 *   产物时长 ≈ segments × 源片时长（±1 帧容差）∧ segments 为偶数 ∧ ≥2
 *   —— 联合锚定 palindrome（顺放+逆放成对）结构。
 *   // CONTRACT_AMBIGUOUS: segments 计数语义（单向 run vs palindrome 对）未在契约中逐字固定；
 *   // 本文件按「单向 run」断言（与「为单段时长整数倍」联合自洽）。若蓝队以 palindrome 对
 *   // 计数，此断言红 → QA 对齐语义后调整，不得静默放宽。
 *
 * 红队铁律：不读蓝队实现代码；lib/wallpaper/video 按契约函数名黑盒 import 执行。
 *   config 全量 stub（honeydoCliPath 指向 /usr/bin/false——buildLoop 的 seed+1 二段生成
 *   仅在 sec≤2 时允许（§契约规约【v2】），stub wallpaperVideoSeconds=4 保证纯 ffmpeg
 *   palindrome 路径；任何意外 honeydo spawn 会立即失败而非烧 GPU）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// hoisted holder + mock（config 全量 stub / db 真实 drizzle over 临时 sqlite——仅保证
// 模块 import 安全，被测函数 buildLoop 不触 DB）
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
    // §后端设计 §1【v2】：默认 4（>2 ⇒ buildLoop 走纯 ffmpeg palindrome，不触发 seed+1 二段生成）
    wallpaperVideoSeconds: 4,
    wallpaperVideoLoopSeconds: 8,
    wallpaperVideoSpawnTimeoutMs: 5400000,
    // 任何意外 honeydo spawn 立即非零退出（真红，而非烧 GPU）
    honeydoCliPath: "/usr/bin/false",
    wallpaperVideoPrompt:
      "画面中的景物以极缓慢的速度轻微摇曳，光影柔和流动，随后一切缓缓回到初始位置，如呼吸般自然",
    videoWorkspacePath: "/tmp/relight-none/video-workspace",
    repoRoot: "/tmp/relight-none",
    port: 3000,
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-wvloop-test",
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
// ffprobe 断言辅助（真实 ffprobe，红队不 mock 探测面）
// ============================================================================

interface ProbeResult {
  formatName: string;
  durationSec: number;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  avgFps: number;
}

function ffprobeJson(file: string): {
  format?: { format_name?: string; duration?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
  }>;
} {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { encoding: "utf-8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`ffprobe 失败（${file}）: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

function probe(file: string): ProbeResult {
  const j = ffprobeJson(file);
  const v = (j.streams ?? []).find((s) => s.codec_type === "video");
  const fpsParts = (v?.avg_frame_rate ?? "0/1").split("/");
  const fps =
    Number.parseInt(fpsParts[1] ?? "0", 10) > 0
      ? Number.parseInt(fpsParts[0] ?? "0", 10) / Number.parseInt(fpsParts[1] as string, 10)
      : 0;
  return {
    formatName: j.format?.format_name ?? "",
    durationSec: Number.parseFloat(j.format?.duration ?? "0"),
    videoCodec: v?.codec_name ?? null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    avgFps: fps,
  };
}

// ============================================================================
// fixture：ffmpeg 造 1s 真实样片（验收点指定：用 ffmpeg 造 1s 样片）
// ============================================================================

let tmpRoot = "";
let srcClip = "";
let srcDur = 0;
let buildLoop: (
  src: string,
  targetSeconds: number,
) => Promise<{ loopPath: string; segments: number }>;

beforeAll(async () => {
  // ffmpeg 硬前置（红队铁律：fixture 失败即真红，不静默跳过）
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8", timeout: 15000 });
  if (ff.status !== 0) {
    throw new Error("ffmpeg 不可用——buildLoop 验收要求真实 ffmpeg 环境");
  }

  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvloop-"));
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

  // 1s 320×176 @24fps 无音轨样片（testsrc2 确定性内容；24fps 整数秒便于时长断言）
  srcClip = path.join(tmpRoot, "src-1s.mp4");
  const gen = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x176:rate=24:duration=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      srcClip,
    ],
    { encoding: "utf-8", timeout: 60000 },
  );
  if (gen.status !== 0 || !fs.existsSync(srcClip)) {
    throw new Error(`fixture ffmpeg 造 1s 样片失败: ${gen.stderr}`);
  }
  srcDur = probe(srcClip).durationSec;
  expect(srcDur).toBeGreaterThan(0.9);
  expect(srcDur).toBeLessThan(1.1);

  const mod = (await import("../lib/wallpaper/video")) as unknown as Record<string, unknown>;
  expect(
    typeof mod.buildLoop,
    "契约函数 buildLoop 未由 lib/wallpaper/video 导出（§契约规约【v2】：buildLoop(src, targetSeconds) → {loopPath, segments}）",
  ).toBe("function");
  buildLoop = mod.buildLoop as typeof buildLoop;
}, 60000);

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 契约容差：±1 帧（按源片 24fps 折算）+ 容器时长毫秒级舍入余量 */
function frameTolerance(): number {
  return 1 / 24 + 0.01;
}

function assertPalindromeShape(loopPath: string, segments: number, targetSeconds: number): void {
  // 产物存在 ∧ 非空 ∧ ≠ 源（新产物，不原地覆写）
  expect(fs.existsSync(loopPath), `loop 产物不存在: ${loopPath}`).toBe(true);
  expect(fs.statSync(loopPath).size).toBeGreaterThan(0);
  expect(loopPath).not.toBe(srcClip);

  const p = probe(loopPath);
  // 契约逐字 ①：产物时长 ≥ loopSeconds（targetSeconds）
  expect(
    p.durationSec,
    `palindrome 产物时长 ${p.durationSec}s < targetSeconds ${targetSeconds}s`,
  ).toBeGreaterThanOrEqual(targetSeconds);

  // 契约逐字 ②（验收点「偶数段」）：segments 偶数 ∧ ≥2（顺放+逆放成对）
  expect(Number.isInteger(segments), `segments 必须为整数，实际 ${segments}`).toBe(true);
  expect(segments, `segments 必须 ≥ 2，实际 ${segments}`).toBeGreaterThanOrEqual(2);
  expect(segments % 2, `palindrome 段数必须为偶数（顺放+逆放成对），实际 ${segments}`).toBe(0);

  // 契约逐字 ③：产物时长为单段（源片）时长整数倍（±1 帧容差）
  const expected = segments * srcDur;
  expect(
    Math.abs(p.durationSec - expected),
    `产物时长 ${p.durationSec}s ≠ segments(${segments}) × 源片时长(${srcDur}s) = ${expected}s（±1 帧容差）`,
  ).toBeLessThanOrEqual(frameTolerance());

  // 产物可解码（视频流完整）
  expect(p.videoCodec).toBe("h264");
}

// ============================================================================
// 契约断言
// ============================================================================

describe("【v2】buildLoop palindrome 契约（真实小样本：ffmpeg 1s 样片 + ffprobe）", () => {
  it("targetSeconds=6 → 产物时长 ≥ 6 ∧ 偶数段 ∧ 时长为单段时长整数倍（±1 帧）", async () => {
    const res = await buildLoop(srcClip, 6);
    expect(res).toBeTruthy();
    expect(typeof res.loopPath).toBe("string");
    assertPalindromeShape(res.loopPath, res.segments, 6);
  }, 120000);

  it("targetSeconds=3（1s 源 palindrome 单对 2s 不足）→ 补段后时长 ≥ 3 ∧ 偶数段", async () => {
    const res = await buildLoop(srcClip, 3);
    assertPalindromeShape(res.loopPath, res.segments, 3);
  }, 120000);

  it("targetSeconds=8（config.wallpaperVideoLoopSeconds 默认值档）→ 产物时长 ≥ 8", async () => {
    const res = await buildLoop(srcClip, 8);
    assertPalindromeShape(res.loopPath, res.segments, 8);
  }, 120000);

  it("ffmpeg 失败（源文件不存在）→ 拒绝且错误枚举 LoopBuildError（§契约规约【v2】逐字）", async () => {
    const bogus = path.join(tmpRoot, "not-exist-src.mp4");
    expect(fs.existsSync(bogus)).toBe(false);

    let caught: unknown;
    try {
      await buildLoop(bogus, 8);
    } catch (e) {
      caught = e;
    }
    expect(caught, "buildLoop 对 ffmpeg 失败必须拒绝（不得静默 resolve）").toBeDefined();
    const e = caught as { name?: string; message?: string; constructor?: { name?: string } };
    const hits = [e?.name, e?.message, e?.constructor?.name].filter(
      (s): s is string => typeof s === "string",
    );
    expect(
      hits.some((s) => s.includes("LoopBuildError")),
      `错误枚举必须为 LoopBuildError，实际 name=${e?.name} message=${String(e?.message).slice(0, 300)}`,
    ).toBe(true);
  }, 60000);
});

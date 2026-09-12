import { spawnSync } from "node:child_process";
/**
 * 验收测试（红队）：动态视频壁纸 — renderTextOverlay / 双转码 spawn 调用契约【v2 增量】（mock 面）
 *
 * 设计文档（state.md）对应契约（§契约规约 计算/spawn 契约【v2】逐字）：
 *   - renderTextOverlay(videoPath, meta: {pickDate,title,narrative}) → {overlaidPath}
 *   - 错误枚举：OverlayRenderError（remotion 非零退出 / 产物缺失 / 超时 900s（v2.1））
 *   - §后端设计 §1【v2】：videoWorkspacePath 下新增 wallpaper-overlay/ 工程，
 *     直接 `npx remotion render`（无 AI、确定性渲染）
 *   - transcodeForGallery【v2】：保留音轨 `-c:v libx264 -crf 18 -c:a aac -b:a 128k
 *     -movflags +faststart`（画廊静音自动播放 + 点击开声），超时 120s
 *   - transcodeForAerial：`-vf scale=1920:1080:flags=lanczos -c:v hevc_videotoolbox
 *     -b:v 8M -tag:v hvc1 -an -movflags +faststart`（hevc_videotoolbox 失败 fallback
 *     `-c:v libx265 -crf 22 -tag:v hvc1`），超时 600s（Aerial 转码未改，v2.1 只调 renderTextOverlay 900s）
 *
 * 验收点（round 2 编排器）：mock spawn 为主——本文件 mock node:child_process.spawn 断言
 *   调用形态与错误枚举；产物 invariant（同分辨率同帧率 ∧ mp4 ∧ 首帧像素差异 >0）需真实
 *   渲染，落在 wallpaper-video-overlay-realprocess.acceptance.test.ts（独立 real-process
 *   文件 + 超小输入）；转码产物 ffprobe invariant 落在 wallpaper-video-transcode.acceptance.test.ts。
 *
 * // CONTRACT_AMBIGUOUS: meta {pickDate,title,narrative} 到 remotion 渲染的传递机制
 * //（--props JSON / props 文件 / 环境注入）未在契约中逐字固定——本文件不断言 argv 携带
 * // meta 的形态，只断言 spawn 发生且指向 wallpaper-overlay 工程；「文字层真实存在」由
 * // real-process 文件的首帧像素差异断言兜底。
 *
 * 红队铁律：不读蓝队实现代码；lib/wallpaper/video 按契约函数名黑盒 import 执行。
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// hoisted holder + spawn mock（仅 mock spawn，spawnSync/execSync 保持真实）
// ============================================================================

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  storageRoot: "/tmp/relight-none",
  videoWorkspacePath: "/tmp/relight-none/video-workspace",
}));

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mockSpawn };
});

interface SpawnCall {
  cmd: string;
  args: string[];
  cwd: string | undefined;
}

const spawnCalls: SpawnCall[] = [];
/** 产物落盘规则：spawn argv 命中 key(dst) 时把 value(src) copy 到 dst（模拟转码/渲染产物） */
const registeredOutputs = new Map<string, string>();
/** remotion 渲染产物落盘：success 模式下把输入视频 copy 到 argv 中的输出 .mp4 路径 */
let overlayMode: "success" | "fail" | "missing" = "success";
let overlayInputPath = "";

/** 构造最小假 child 进程：stdout/stderr 可监听，nextTick 后 emit close(code) */
function fakeChild(code: number): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => false;
  child.pid = 42424;
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("mock-stdout"));
    child.stderr.emit("data", Buffer.from("mock-stderr"));
    child.emit("close", code);
  });
  return child;
}

function wireSpawn(): void {
  mockSpawn.mockReset();
  spawnCalls.length = 0;
  registeredOutputs.clear();
  mockSpawn.mockImplementation((cmd: unknown, args: unknown, opts: unknown) => {
    const rawArgs = Array.isArray(args) ? args.map(String) : String(args).split(/\s+/);
    const cwd = (opts as { cwd?: string } | undefined)?.cwd;
    spawnCalls.push({ cmd: String(cmd), args: rawArgs, cwd });
    const all = [String(cmd), ...rawArgs, cwd ?? ""];

    if (all.some((a) => a.includes("remotion")) && all.some((a) => a === "render")) {
      // remotion render 调用：按 overlayMode 模拟成功/失败/缺产物
      if (overlayMode === "fail") return fakeChild(1);
      const candidates = rawArgs.filter(
        (a) => a.endsWith(".mp4") && a !== overlayInputPath && !a.includes("://"),
      );
      if (overlayMode === "success") {
        for (const out of candidates) {
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.copyFileSync(overlayInputPath, out);
        }
      }
      return fakeChild(0);
    }

    // 其余（ffmpeg 转码等）：命中注册产物路径则落盘，恒 exit 0
    for (const [dst, src] of registeredOutputs) {
      if (all.includes(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
    return fakeChild(0);
  });
}

// ============================================================================
// config / db mock（config 全量 stub；db 真实 drizzle——仅保证模块 import 安全）
// ============================================================================

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
    get videoWorkspacePath() {
      return holder.videoWorkspacePath;
    },
    repoRoot: "/tmp/relight-none",
    port: 3000,
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-wvov-test",
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
// helpers
// ============================================================================

/** 错误枚举断言：name / message / constructor.name 三面任一携带枚举名（枚举名漂移即红） */
function assertErrorEnum(caught: unknown, enumName: string): void {
  const e = caught as { name?: string; message?: string; constructor?: { name?: string } };
  const hits = [e?.name, e?.message, e?.constructor?.name].filter(
    (s): s is string => typeof s === "string",
  );
  expect(
    hits.some((s) => s.includes(enumName)),
    `错误枚举必须为 ${enumName}，实际 name=${e?.name} message=${String(e?.message).slice(0, 300)}`,
  ).toBe(true);
}

/** 取 argv 中 flag 的下一个值（无则 null） */
function flagValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return null;
  return args[i + 1] ?? null;
}

// ============================================================================
// 环境准备
// ============================================================================

let tmpRoot = "";
let renderTextOverlay: (
  videoPath: string,
  meta: { pickDate: string; title: string; narrative: string },
) => Promise<{ overlaidPath: string }>;
let transcodeForGallery: (src: string, dst: string) => Promise<void>;
let transcodeForAerial: (src: string, dst: string) => Promise<void>;
let overlaySrc = "";
let gallerySrc = "";
let aerialSrc = "";

beforeAll(async () => {
  // 真实 ffmpeg 仅用于造 fixture（spawn 已被 mock，被测函数不会真跑 ffmpeg）
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8", timeout: 15000 });
  if (ff.status !== 0) {
    throw new Error("ffmpeg 不可用——本验收 fixture 要求真实 ffmpeg 环境");
  }

  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvov-"));
  const dbPath = path.join(tmpRoot, "test.db");
  holder.dbPath = dbPath;
  holder.storageRoot = path.join(tmpRoot, "storage");
  holder.videoWorkspacePath = path.join(tmpRoot, "video-workspace");
  process.env.DATABASE_PATH = dbPath;
  process.env.STORAGE_ROOT = holder.storageRoot;

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite.close();

  // wallpaper-overlay 工程最小脚手架（§后端设计 §1【v2】；实现 spawn 前有工程存在性
  // 预校验——mock spawn 拦截真实渲染，这里只需让 fs access 预校验通过：
  // remotion 工程惯例含 package.json / remotion.config.ts / src/index.ts 入口 + 可执行 bin）
  const ws = holder.videoWorkspacePath;
  const overlayDir = path.join(ws, "wallpaper-overlay");
  for (const rel of [
    path.join("wallpaper-overlay", "package.json"),
    path.join("wallpaper-overlay", "remotion.config.ts"),
    path.join("wallpaper-overlay", "src", "index.ts"),
    path.join("wallpaper-overlay", "src", "Root.tsx"),
  ]) {
    const p = path.join(ws, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "// mock workspace scaffold\n");
  }
  for (const binDir of [
    path.join(ws, "node_modules", ".bin"),
    path.join(overlayDir, "node_modules", ".bin"),
  ]) {
    const bin = path.join(binDir, "remotion");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.chmodSync(bin, 0o755);
  }

  // fixture：小 mp4（overlay 输入 / 转码源）
  const makeTiny = (out: string): void => {
    const r = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x176:rate=12:duration=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        out,
      ],
      { encoding: "utf-8", timeout: 30000 },
    );
    if (r.status !== 0 || !fs.existsSync(out)) {
      throw new Error(`fixture ffmpeg 造样片失败: ${r.stderr}`);
    }
  };
  overlaySrc = path.join(tmpRoot, "overlay-src.mp4");
  gallerySrc = path.join(tmpRoot, "gallery-src.mp4");
  aerialSrc = path.join(tmpRoot, "aerial-src.mp4");
  makeTiny(overlaySrc);
  makeTiny(gallerySrc);
  makeTiny(aerialSrc);

  const mod = (await import("../lib/wallpaper/video")) as unknown as Record<string, unknown>;
  expect(
    typeof mod.renderTextOverlay,
    "契约函数 renderTextOverlay 未由 lib/wallpaper/video 导出（§契约规约【v2】）",
  ).toBe("function");
  expect(typeof mod.transcodeForGallery, "契约函数 transcodeForGallery 未导出").toBe("function");
  expect(typeof mod.transcodeForAerial, "契约函数 transcodeForAerial 未导出").toBe("function");
  renderTextOverlay = mod.renderTextOverlay as typeof renderTextOverlay;
  transcodeForGallery = mod.transcodeForGallery as typeof transcodeForGallery;
  transcodeForAerial = mod.transcodeForAerial as typeof transcodeForAerial;
}, 60000);

beforeEach(() => {
  overlayMode = "success";
  overlayInputPath = "";
  wireSpawn();
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// renderTextOverlay：调用形态 + OverlayRenderError（mock spawn）
// ============================================================================

describe("【v2】renderTextOverlay spawn 调用契约（mock spawn；§后端设计 §1 wallpaper-overlay 工程）", () => {
  /** 每用例独立输入（独立子目录）：防上一用例的派生产物泄漏造成「产物缺失」分支假绿 */
  function makeIsolatedInput(tag: string): string {
    const dir = path.join(tmpRoot, `overlay-${tag}`);
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, "input.mp4");
    fs.copyFileSync(overlaySrc, input);
    return input;
  }

  it("成功路径：spawn remotion render 指向 wallpaper-overlay 工程 → resolve {overlaidPath} 且产物存在", async () => {
    overlayInputPath = makeIsolatedInput("success");
    const res = await renderTextOverlay(overlayInputPath, {
      pickDate: "2026-09-12",
      title: "金色黄昏",
      narrative: "五年前的今天，你在海边捕捉到了这张温暖的照片。",
    });

    // 返回契约：{overlaidPath}（产物必须真实存在于磁盘）
    expect(res).toBeTruthy();
    expect(typeof res.overlaidPath).toBe("string");
    expect(res.overlaidPath.length).toBeGreaterThan(0);
    expect(
      fs.existsSync(res.overlaidPath),
      `renderTextOverlay resolve 的 overlaidPath 不存在: ${res.overlaidPath}`,
    ).toBe(true);

    // 调用形态：spawn 发生 ≥1 次；命中 remotion render
    const remotionCalls = spawnCalls.filter((c) =>
      [c.cmd, ...c.args, c.cwd ?? ""].join(" ").includes("remotion"),
    );
    expect(
      remotionCalls.length,
      `未发生 remotion 渲染 spawn；全部调用：${JSON.stringify(spawnCalls)}`,
    ).toBeGreaterThanOrEqual(1);
    const joined = remotionCalls.map((c) => [c.cmd, ...c.args, c.cwd ?? ""].join(" ")).join("\n");
    // 逐字：`npx remotion render`（cmd/args 组合含 render 子命令）
    expect(joined).toContain("render");
    // 逐字：videoWorkspacePath 下新增 wallpaper-overlay/ 工程（cmd/args/cwd 任一携带）
    expect(joined, `remotion 渲染调用未指向 wallpaper-overlay 工程：\n${joined}`).toContain(
      "wallpaper-overlay",
    );
  }, 30000);

  it("remotion 非零退出 → 拒绝且错误枚举 OverlayRenderError（§契约规约【v2】逐字）", async () => {
    overlayInputPath = makeIsolatedInput("fail");
    overlayMode = "fail";
    let caught: unknown;
    try {
      await renderTextOverlay(overlayInputPath, {
        pickDate: "2026-09-12",
        title: "金色黄昏",
        narrative: "narrative",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, "remotion 非零退出必须拒绝（不得静默 resolve）").toBeDefined();
    assertErrorEnum(caught, "OverlayRenderError");
  }, 30000);

  it("remotion exit 0 但产物缺失 → 拒绝且错误枚举 OverlayRenderError（产物缺失枚举分支）", async () => {
    overlayInputPath = makeIsolatedInput("missing");
    overlayMode = "missing"; // exit 0，但 mock 不落任何产物文件
    let caught: unknown;
    try {
      await renderTextOverlay(overlayInputPath, {
        pickDate: "2026-09-12",
        title: "金色黄昏",
        narrative: "narrative",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, "产物缺失必须拒绝（契约错误枚举包含『产物缺失』）").toBeDefined();
    assertErrorEnum(caught, "OverlayRenderError");
  }, 30000);
});

// ============================================================================
// 双转码：spawn argv 参数契约（mock 面；产物 ffprobe invariant 见 transcode 文件）
// ============================================================================

describe("【v2】transcodeForGallery spawn argv 契约（保留音轨：libx264/aac/128k/faststart）", () => {
  it("argv 含 -c:v libx264 ∧ -crf 18 ∧ -c:a aac ∧ -b:a 128k ∧ -movflags +faststart，且含 src/dst", async () => {
    const dst = path.join(tmpRoot, "argv-gallery.mp4");
    registeredOutputs.set(dst, gallerySrc);
    await transcodeForGallery(gallerySrc, dst);

    const call = spawnCalls.find((c) => c.args.includes(dst));
    expect(
      call,
      `未找到含 dst(${dst}) 的 spawn 调用；全部调用：${JSON.stringify(spawnCalls)}`,
    ).toBeTruthy();
    const args = call?.args ?? [];
    expect(args).toContain(gallerySrc);
    // 契约逐字：-c:v libx264 -crf 18 -c:a aac -b:a 128k -movflags +faststart
    expect(flagValue(args, "-c:v"), "-c:v 必须为 libx264").toBe("libx264");
    expect(flagValue(args, "-crf"), "-crf 必须为 18").toBe("18");
    expect(flagValue(args, "-c:a"), "-c:a 必须为 aac（v2 画廊版保留音轨）").toBe("aac");
    expect(flagValue(args, "-b:a"), "-b:a 必须为 128k").toBe("128k");
    expect(flagValue(args, "-movflags"), "-movflags 必须为 +faststart").toBe("+faststart");
  }, 30000);
});

describe("transcodeForAerial spawn argv 契约（v1 维持：scale 1920×1080/hvc1/-an/faststart）", () => {
  it("argv 含 -vf scale=1920:1080 ∧ -tag:v hvc1 ∧ -an ∧ -movflags +faststart；-c:v ∈ {hevc_videotoolbox, libx265}", async () => {
    const dst = path.join(tmpRoot, "argv-aerial.mov");
    registeredOutputs.set(dst, aerialSrc);
    await transcodeForAerial(aerialSrc, dst);

    const call = spawnCalls.find((c) => c.args.includes(dst));
    expect(
      call,
      `未找到含 dst(${dst}) 的 spawn 调用；全部调用：${JSON.stringify(spawnCalls)}`,
    ).toBeTruthy();
    const args = call?.args ?? [];
    expect(args).toContain(aerialSrc);
    // 契约逐字：-vf scale=1920:1080:flags=lanczos
    const vf = flagValue(args, "-vf");
    expect(vf, "-vf 必须存在").not.toBeNull();
    expect(vf ?? "", "-vf 必须含 scale=1920:1080").toContain("scale=1920:1080");
    // 契约逐字：-tag:v hvc1
    expect(flagValue(args, "-tag:v"), "-tag:v 必须为 hvc1").toBe("hvc1");
    // 契约逐字：-an（无音轨——Mac 注入契约）
    expect(args, "必须含 -an（Aerial 版无音轨）").toContain("-an");
    // 契约逐字：-movflags +faststart
    expect(flagValue(args, "-movflags"), "-movflags 必须为 +faststart").toBe("+faststart");
    // 契约：hevc_videotoolbox 失败 fallback libx265——二者之一
    const cv = flagValue(args, "-c:v");
    expect(
      cv === "hevc_videotoolbox" || cv === "libx265",
      `-c:v 必须为 hevc_videotoolbox（或 fallback libx265），实际 ${cv}`,
    ).toBe(true);
    // videotoolbox 主路径必须带 -b:v 8M（fallback libx265 路径用 -crf 22，不强制 -b:v）
    if (cv === "hevc_videotoolbox") {
      expect(flagValue(args, "-b:v"), "hevc_videotoolbox 路径必须带 -b:v 8M").toBe("8M");
    }
  }, 30000);
});

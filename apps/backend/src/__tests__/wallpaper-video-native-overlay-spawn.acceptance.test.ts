import { spawnSync } from "node:child_process";
/**
 * 验收测试（红队）：单腿原生壁纸视频 — renderTextOverlay 画布参数化（mock spawn 面）
 *
 * 设计文档（state.md §设计文档 D2/D3 / §验收场景）对应谓词：
 *   - 场景 9.P2 [det-machine]：spawn 命令行显式携带画布宽高参数（kill 尺寸写死 No-op）。
 *     契约 7：Overlay props = {videoPath, pickDate, title, narrative, captureDateline,
 *     canvasWidth, canvasHeight}（既有字段不动，纯超集扩展）；D3：Root.tsx 两个 comp 增加
 *     calculateMetadata，从新增 props canvasWidth/canvasHeight 返回动态 width/height。
 *     断言：renderTextOverlay 调起 remotion render 时，其命令行（argv 直含，或 argv 引用的
 *     props 载荷文件内容）必须同时含 canvasWidth/canvasHeight 键名与本次画布数值。
 *   - D2：comp 选择按 canvasWidth/canvasHeight 比例（≥0.9 横版两栏 comp，<0.9 竖版全屏
 *     comp）——横竖两种画布各渲染一次，载荷必须随画布变化（数值不同），证明参数化通路贯通。
 *     // CONTRACT_AMBIGUOUS: comp id 命名未在契约中声明——不锁定 comp 名，以「载荷随画布
 *     // 变化 + 画布键值显式出现」代码化 9.P2；comp 选择真伪由 realprocess 文件的产物尺寸
 *     // 断言（场景 9.P1）兜底。
 *
 * 惯例沿 wallpaper-video-overlay.acceptance.test.ts：mock node:child_process.spawn 断言调用
 * 形态；产物落盘用「argv 命中输出路径 → copy 输入视频」模拟。无 GPU、无真实渲染——无条件可跑。
 * 红队铁律：不读蓝队实现代码；renderTextOverlay 按契约函数名黑盒 import 执行；不 skip。
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// hoisted holder + spawn mock
// ============================================================================

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  storageRoot: "/tmp/relight-none",
  videoWorkspacePath: "/tmp/relight-none/video-workspace",
  inputVideo: "/tmp/relight-none/input.mp4",
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

/** 构造最小假 child 进程：stdout/stderr 可监听，nextTick 后 emit close(0) */
function fakeChild(): EventEmitter {
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
    child.emit("close", 0);
  });
  return child;
}

beforeEach(() => {
  mockSpawn.mockReset();
  mockSpawn.mockImplementation((cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args: [...args], cwd: process.cwd() });
    // 产物落盘：argv 中最后一个 .mp4 输出路径（≠输入视频）← copy 输入视频
    const outs = args.filter(
      (a) => typeof a === "string" && a.endsWith(".mp4") && a !== holder.inputVideo,
    );
    const out = outs[outs.length - 1];
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(holder.inputVideo, out);
    }
    return fakeChild();
  });
  spawnCalls.length = 0;
});

// ============================================================================
// config / db mock（import 安全 + workspace 脚手架）
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
    wallpaperVideoPrompt: "画面中的景物以极缓慢的速度轻微摇曳",
    get videoWorkspacePath() {
      return holder.videoWorkspacePath;
    },
    repoRoot: "/tmp/relight-none",
    port: 3000,
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-wvnos-test",
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
// 载荷收集：argv 直含 + argv 引用的 .json 载荷文件内容（--props 文件形态兼容）
// ============================================================================

function collectPayload(call: SpawnCall): string {
  let payload = call.args.join("\n");
  for (const token of call.args) {
    if (typeof token === "string" && token.endsWith(".json") && fs.existsSync(token)) {
      payload += `\n${fs.readFileSync(token, "utf8")}`;
    }
  }
  return payload;
}

// ============================================================================
// fixture + 被测函数导入
// ============================================================================

let tmpRoot = "";
let renderTextOverlay: (
  videoPath: string,
  meta: {
    pickDate: string;
    title: string;
    narrative: string;
    captureDateline?: string;
    canvasWidth?: number;
    canvasHeight?: number;
  },
) => Promise<{ overlaidPath: string }>;

beforeAll(async () => {
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8", timeout: 10000 });
  if (ff.status !== 0) {
    throw new Error("ffmpeg 不可用——本验收要求真实 ffmpeg 环境");
  }

  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvnos-"));
  const dbPath = path.join(tmpRoot, "test.db");
  holder.dbPath = dbPath;
  holder.storageRoot = path.join(tmpRoot, "storage");
  holder.videoWorkspacePath = path.join(tmpRoot, "video-workspace");
  // renderTextOverlay 前置检查 remotion bin 存在性（设计约定「不自动安装」）——
  // 本测试 mock 了 child_process.spawn 只为捕获载荷，须先造假 bin 让 access() 通过
  const overlayBinDir = path.join(holder.videoWorkspacePath, "node_modules", ".bin");
  fs.mkdirSync(overlayBinDir, { recursive: true });
  const overlayBin = path.join(overlayBinDir, "remotion");
  fs.writeFileSync(overlayBin, "#!/bin/sh\n");
  fs.chmodSync(overlayBin, 0o755);
  process.env.DATABASE_PATH = dbPath;
  process.env.STORAGE_ROOT = holder.storageRoot;

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite.close();

  // 输入母版：1s 1312×864 mp4（尺寸不影响本文件断言——spawn 形态为主）
  holder.inputVideo = path.join(tmpRoot, "input-1312x864.mp4");
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1312x864:rate=24:duration=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      holder.inputVideo,
    ],
    { encoding: "utf-8", timeout: 30000 },
  );
  if (r.status !== 0 || !fs.existsSync(holder.inputVideo)) {
    throw new Error(`fixture ffmpeg 造样片失败: ${r.stderr}`);
  }

  // wallpaper-overlay 工程脚手架（fs access 前置校验用；渲染被 mock）
  const ws = holder.videoWorkspacePath;
  for (const rel of [
    path.join("wallpaper-overlay", "package.json"),
    path.join("wallpaper-overlay", "src", "index.ts"),
    path.join("wallpaper-overlay", "public", "fonts", "NotoSerifSC-Regular.otf"),
    path.join("wallpaper-overlay", "public", "fonts", "Fraunces-Regular.otf"),
  ]) {
    const p = path.join(ws, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "// mock workspace scaffold\n");
  }

  const mod = (await import("../lib/wallpaper/video")) as unknown as Record<string, unknown>;
  expect(
    typeof mod.renderTextOverlay,
    "契约函数 renderTextOverlay 未由 lib/wallpaper/video 导出",
  ).toBe("function");
  renderTextOverlay = mod.renderTextOverlay as typeof renderTextOverlay;
}, 60000);

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// 场景 9.P2：spawn 命令行显式携带画布宽高参数
// ============================================================================

describe("场景 9.P2 [det-machine]：renderTextOverlay spawn 显式携带画布宽高（契约 7 props 超集）", () => {
  it("横版画布 1312×864 → 载荷含 canvasWidth/canvasHeight 键名与数值 1312/864", async () => {
    const res = await renderTextOverlay(holder.inputVideo, {
      pickDate: "2026-09-20",
      title: "金色黄昏",
      narrative: "五年前的今天，你在海边捕捉到了这张温暖的照片。",
      captureDateline: "拍摄于 2021-05-05 18:30 · 5 年前",
      canvasWidth: 1312,
      canvasHeight: 864,
    });
    expect(res.overlaidPath, "渲染必须产出 overlaidPath").toBeTruthy();
    expect(fs.existsSync(res.overlaidPath), "渲染产物必须落盘").toBe(true);
    expect(spawnCalls.length, "必须发生 remotion render spawn").toBeGreaterThan(0);

    const payloads = spawnCalls.map(collectPayload).join("\n---call---\n");
    expect(payloads, `载荷必须显式含 canvasWidth 键：\n${payloads.slice(0, 2000)}`).toContain(
      "canvasWidth",
    );
    expect(payloads).toContain("canvasHeight");
    expect(payloads, "载荷必须携带画布宽 1312").toContain("1312");
    expect(payloads, "载荷必须携带画布高 864").toContain("864");
  });

  it("竖版画布 800×1440（9:16 原生档，<0.9 → 竖版 comp）→ 载荷含 canvasWidth/canvasHeight 数值 800/1440", async () => {
    const res = await renderTextOverlay(holder.inputVideo, {
      pickDate: "2026-09-21",
      title: "夏日正午",
      narrative: "那天午后，阳光正好。",
      canvasWidth: 800,
      canvasHeight: 1440,
    });
    expect(res.overlaidPath).toBeTruthy();
    expect(fs.existsSync(res.overlaidPath)).toBe(true);

    const payloads = spawnCalls.map(collectPayload).join("\n---call---\n");
    expect(payloads).toContain("canvasWidth");
    expect(payloads).toContain("canvasHeight");
    expect(payloads, "载荷必须携带画布宽 800").toContain("800");
    expect(payloads, "载荷必须携带画布高 1440").toContain("1440");
  });

  it("画布参数随输入变化（1312×864 vs 800×1440 载荷不同）——kill 画布写死 No-op", async () => {
    /** 提取载荷中 canvasWidth 键后紧跟的数值（JSON / argv 形态兼容） */
    function canvasWidthIn(payload: string): number | null {
      const m = payload.match(/canvasWidth["'\s:=]+(\d+)/);
      return m ? Number(m[1]) : null;
    }

    await renderTextOverlay(holder.inputVideo, {
      pickDate: "2026-09-20",
      title: "t",
      narrative: "n",
      canvasWidth: 1312,
      canvasHeight: 864,
    });
    const firstPayload = spawnCalls.map(collectPayload).join("\n");
    expect(canvasWidthIn(firstPayload), "第一次渲染载荷 canvasWidth 必须 == 1312").toBe(1312);

    spawnCalls.length = 0;
    await renderTextOverlay(holder.inputVideo, {
      pickDate: "2026-09-21",
      title: "t",
      narrative: "n",
      canvasWidth: 800,
      canvasHeight: 1440,
    });
    const secondPayload = spawnCalls.map(collectPayload).join("\n");

    // 两次渲染的载荷必须真实携带各自画布数值（若实现写死 1280×704/736×1600，此断言红）
    expect(canvasWidthIn(secondPayload), "第二次渲染载荷 canvasWidth 必须 == 800").toBe(800);
  });
});

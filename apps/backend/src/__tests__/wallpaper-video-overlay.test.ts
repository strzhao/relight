/**
 * 单测：lib/wallpaper/video.ts — renderTextOverlay + assertVideoSpawnPrerequisites
 * （v2 增量任务 14：Remotion 文字层）
 *
 * 契约（state.md ## 契约规约 计算/spawn 契约）：
 *   renderTextOverlay(videoPath, meta: {pickDate,title,narrative,takenAt?}) → {overlaidPath}
 *   spawn `npx remotion render`（cwd=wallpaper-overlay 工程、npx 绝对路径、
 *     AbortController 600s 超时、stdout tail 留证）
 *   错误枚举 OverlayRenderError：工程缺失 / Remotion 运行时缺失（不自动安装）/
 *     remotion 非零退出 / 产物缺失 / 超时
 *
 * 测试策略：vi.mock node:child_process 的 spawn（任务指定 mock spawn）——参数拼装/
 * 错误 tail/超时；ffprobe/ffmpeg 走真实二进制（真实 0.5s 小样本定 compId 与 --frames）。
 */
import { execFileSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OverlayRenderError,
  buildCaptureDateline,
  renderTextOverlay,
} from "../lib/wallpaper/video";

const holder = vi.hoisted(() => ({
  tmpDir: `/tmp/wv-overlay-test-${process.pid}`,
  workspacePath: `/tmp/wv-overlay-test-${process.pid}/workspace`,
  spawnCalls: [] as Array<{
    cmd: string;
    args: string[];
    opts: Record<string, unknown> | undefined;
  }>,
  sawPublicInput: false as boolean,
}));

// mock spawn（任务指定）；其余 child_process 能力（execFile/execFileSync）保持真实
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { writeFileSync, existsSync } = await import("node:fs");
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts?: Record<string, unknown>) => {
      holder.spawnCalls.push({ cmd, args, opts });
      // spawn 时刻输入视频应已拷入工程 public/
      holder.sawPublicInput = existsSync(
        `${holder.workspacePath}/wallpaper-overlay/public/wallpaper-overlay-input.mp4`,
      );
      const proc = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      (proc as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }).stdout = stdout;
      (proc as EventEmitter & { stderr: EventEmitter }).stderr = stderr;
      const outPath = typeof args[4] === "string" ? args[4] : "";
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from("remotion-progress-line\n"));
        if (behavior.mode === "timeout") {
          // 模拟真实 kill 语义：signal abort → 'error'（AbortError）→ 'close'（stdio 已冲刷）
          const signal = opts?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            queueMicrotask(() => {
              const e = new Error("This operation was aborted");
              (e as Error & { name: string }).name = "AbortError";
              proc.emit("error", e);
              proc.emit("close", null);
            });
          });
          return;
        }
        if (behavior.mode === "success" && outPath) {
          writeFileSync(outPath, "fake-overlay-mp4");
        }
        proc.emit("close", behavior.mode === "nonzero" ? 1 : 0);
      });
      return proc;
    }),
  };
});

// fake remotion 行为（各用例覆写）
const behavior = vi.hoisted(() => ({
  mode: "success" as "success" | "nonzero" | "no-product" | "timeout",
}));

vi.mock("../lib/config", () => ({
  config: {
    databasePath: ":memory:",
    storageRoot: `/tmp/wv-overlay-test-${process.pid}/storage`,
    videoWorkspacePath: holder.workspacePath,
    video: {
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
    },
  },
}));

const OVERLAY_DIR = `${holder.workspacePath}/wallpaper-overlay`;
const OVERLAY_PUBLIC_INPUT = `${OVERLAY_DIR}/public/wallpaper-overlay-input.mp4`;

beforeAll(() => {
  // fake 工程：入口 + Remotion 运行时 + 字体
  mkdirSync(`${OVERLAY_DIR}/src`, { recursive: true });
  writeFileSync(`${OVERLAY_DIR}/src/index.ts`, "// fake entry\n");
  mkdirSync(`${holder.workspacePath}/node_modules/.bin`, { recursive: true });
  writeFileSync(`${holder.workspacePath}/node_modules/.bin/remotion`, "#!/bin/sh\n", {
    mode: 0o755,
  });
  mkdirSync(`${OVERLAY_DIR}/public/fonts`, { recursive: true });
  writeFileSync(`${OVERLAY_DIR}/public/fonts/NotoSerifSC-Regular.otf`, "fake-font");
  // 浏览器缓存 fixture（--browser-executable 解析目标）
  mkdirSync(
    `${holder.workspacePath}/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64`,
    { recursive: true },
  );
  writeFileSync(
    `${holder.workspacePath}/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    "#!/bin/sh\n",
    { mode: 0o755 },
  );
  // 真实 0.5s 小样本（竖版 704×1216 → portrait comp）
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=704x1216:rate=24:duration=0.5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.5",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-shortest",
      `${holder.tmpDir}/input-portrait.mp4`,
    ],
    { stdio: "ignore" },
  );
  // 横版样本 320×240 → landscape comp
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=24:duration=0.5",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      `${holder.tmpDir}/input-landscape.mp4`,
    ],
    { stdio: "ignore" },
  );
});

beforeEach(() => {
  holder.spawnCalls = [];
  behavior.mode = "success";
  rmSync(OVERLAY_PUBLIC_INPUT, { force: true });
  rmSync(`${holder.tmpDir}/input-portrait-loop-overlay.mp4`, { force: true });
  rmSync(`${holder.tmpDir}/input-portrait-overlay.mp4`, { force: true });
});

afterAll(() => {
  rmSync(holder.tmpDir, { recursive: true, force: true });
});

const META = {
  pickDate: "2026-09-12",
  title: "巷口的猫",
  narrative: "午后的光落在墙沿。",
  takenAt: "2016-07-18T14:35:53.000Z",
};

describe("renderTextOverlay（mock spawn）", () => {
  it("参数拼装：npx 绝对路径 + remotion render src/index.ts <compId> + --props/--frames + cwd=工程目录", async () => {
    const res = await renderTextOverlay(`${holder.tmpDir}/input-portrait.mp4`, META);

    expect(holder.spawnCalls).toHaveLength(1);
    const call = holder.spawnCalls[0];
    // npx 与 node 同目录（绝对路径解析，PM2 PATH 不保证）
    expect(call?.cmd).toBe(path.join(path.dirname(process.execPath), "npx"));
    expect(call?.opts?.cwd).toBe(OVERLAY_DIR);
    const args = call?.args ?? [];
    expect(args[0]).toBe("remotion");
    expect(args[1]).toBe("render");
    expect(args[2]).toBe("src/index.ts");
    // 竖版输入 → portrait composition
    expect(args[3]).toBe("wallpaper-overlay-portrait");
    expect(args[4]).toMatch(/input-portrait-overlay\.mp4$/);
    // props 契约：{videoPath, pickDate, title, narrative, captureDateline}
    const propsIdx = args.indexOf("--props");
    const props = JSON.parse(args[propsIdx + 1] ?? "{}") as Record<string, unknown>;
    expect(props).toEqual({
      videoPath: "wallpaper-overlay-input.mp4",
      pickDate: META.pickDate,
      title: META.title,
      narrative: META.narrative,
      captureDateline: buildCaptureDateline(META.takenAt),
    });
    // frames = ceil(duration × fps)（0.5s × 24fps = 12 帧 → 0-11）
    const framesIdx = args.indexOf("--frames");
    expect(args[framesIdx + 1]).toMatch(/^0-\d+$/);
    // 浏览器显式指定 workspace 缓存（避免 remotion 按 cwd 解析缓存目录触发联网重下）
    const browserIdx = args.indexOf("--browser-executable");
    expect(browserIdx).toBeGreaterThan(0);
    expect(args[browserIdx + 1]).toBe(
      path.join(
        holder.workspacePath,
        "node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell",
      ),
    );

    // 返回值 overlaidPath = 输入同目录 -overlay.mp4
    expect(res.overlaidPath).toMatch(/input-portrait-overlay\.mp4$/);
  });

  it("横版输入 → landscape composition", async () => {
    await renderTextOverlay(`${holder.tmpDir}/input-landscape.mp4`, META);
    const args = holder.spawnCalls[0]?.args ?? [];
    expect(args[3]).toBe("wallpaper-overlay-landscape");
  });

  it("takenAt 缺失 → props.captureDateline 为 null（footer 不渲染契约）", async () => {
    await renderTextOverlay(`${holder.tmpDir}/input-portrait.mp4`, {
      ...META,
      takenAt: null,
    });
    const args = holder.spawnCalls[0]?.args ?? [];
    const propsIdx = args.indexOf("--props");
    const props = JSON.parse(args[propsIdx + 1] ?? "{}") as Record<string, unknown>;
    expect(props.captureDateline).toBeNull();
  });

  it("渲染期把输入拷入工程 public/，完成即清理", async () => {
    const res = await renderTextOverlay(`${holder.tmpDir}/input-portrait.mp4`, META);
    // spawn 时刻输入已就位（fake spawn 内记录）
    expect(holder.sawPublicInput).toBe(true);
    // 结束后清理
    expect(existsSync(OVERLAY_PUBLIC_INPUT)).toBe(false);
    expect(res.overlaidPath).toBeTruthy();
  });

  it("remotion 非零退出 → OverlayRenderError，message 含 stdout tail", async () => {
    behavior.mode = "nonzero";
    const err = await renderTextOverlay(`${holder.tmpDir}/input-portrait.mp4`, META).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(OverlayRenderError);
    expect(err.message).toContain("退出码 1");
    expect(err.message).toContain("remotion-progress-line");
  });

  it("产物缺失（退出码 0 但未产文件）→ OverlayRenderError", async () => {
    behavior.mode = "no-product";
    const err = await renderTextOverlay(`${holder.tmpDir}/input-portrait.mp4`, META).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(OverlayRenderError);
    expect(err.message).toContain("产物文件不存在");
  });

  it("超时 → OverlayRenderError，message 含超时毫秒数与 stdout tail", async () => {
    behavior.mode = "timeout";
    const err = await renderTextOverlay(`${holder.tmpDir}/input-portrait.mp4`, META, {
      timeoutMs: 300,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OverlayRenderError);
    expect(err.message).toContain("300ms");
    expect(err.message).toContain("remotion-progress-line");
  });

  it("工程缺失 → OverlayRenderError（不自动安装）", async () => {
    const { config } = await import("../lib/config");
    const saved = config.videoWorkspacePath;
    (config as { videoWorkspacePath: string }).videoWorkspacePath = `${holder.tmpDir}/no-workspace`;
    try {
      const err = await renderTextOverlay(`${holder.tmpDir}/input-portrait.mp4`, META).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(OverlayRenderError);
      expect(err.message).toContain("wallpaper-overlay 工程缺失");
    } finally {
      (config as { videoWorkspacePath: string }).videoWorkspacePath = saved;
    }
  });

  it("Remotion 运行时缺失 → OverlayRenderError（不自动安装）", async () => {
    const { config } = await import("../lib/config");
    const saved = config.videoWorkspacePath;
    const ws = `${holder.tmpDir}/no-remotion-ws`;
    mkdirSync(`${ws}/wallpaper-overlay/src`, { recursive: true });
    writeFileSync(`${ws}/wallpaper-overlay/src/index.ts`, "// entry\n");
    try {
      (config as { videoWorkspacePath: string }).videoWorkspacePath = ws;
      const err = await renderTextOverlay(`${holder.tmpDir}/input-portrait.mp4`, META).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(OverlayRenderError);
      expect(err.message).toContain("Remotion 运行时缺失");
      expect(err.message).toContain("不自动安装");
    } finally {
      (config as { videoWorkspacePath: string }).videoWorkspacePath = saved;
    }
  });
});

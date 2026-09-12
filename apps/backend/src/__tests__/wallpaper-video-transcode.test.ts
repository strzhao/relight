/**
 * 单测：lib/wallpaper/video.ts — transcodeForAerial / transcodeForGallery /
 * assertVideoSpawnPrerequisites / clampWallpaperVideoSeconds（任务 2 + v2 增量任务 12/14/15）
 *
 * 契约（state.md ## 契约规约）：
 *   transcodeForAerial 产物 invariant：容器 mov ∧ HEVC(tag hvc1) ∧ 1920×1080 ∧ 无音频 ∧ faststart
 *   transcodeForGallery 产物 invariant【v2】：容器 mp4 ∧ H.264（libx264 crf18）∧
 *     有音频流（aac 128k）∧ faststart（画廊静音自动播放 + 点击开声）
 *   hevc_videotoolbox 失败 fallback libx265 -crf 22 -tag:v hvc1
 *   assertVideoSpawnPrerequisites【v2】增查：wallpaper-overlay 工程 / Remotion 运行时 /
 *     overlay 字体（缺失报错，不自动安装）
 *   clampWallpaperVideoSeconds：非有限 → 默认 4（v2 recipes 纪律）
 *
 * 测试策略：mock ../lib/config 注入 fake ffmpeg shell 脚本（记录 argv 后 touch 产物/
 * 退出非零），黑盒断言参数拼装与 fallback 行为。
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// hoisted：vi.mock factory 只能引用 vi.hoisted 产物；路径全部在此计算（process 是全局）
const holder = vi.hoisted(() => {
  const tmpDir = `/tmp/wv-transcode-test-${process.pid}`;
  return {
    tmpDir,
    ffmpegArgsDir: `${tmpDir}/args`,
    ffmpegCountPath: `${tmpDir}/ffmpeg-count`,
    ffmpegPath: `${tmpDir}/fake-ffmpeg`,
    // fail-once：第 1 次调用退出非零，第 2 次成功（模拟 hevc_videotoolbox 硬件编码器失败）
    ffmpegFailOncePath: `${tmpDir}/fake-ffmpeg-fail-once`,
    honeydoPath: `${tmpDir}/fake-honeydo`,
    // v2 前置校验 fixture：workspace = tmpDir（含 wallpaper-overlay 工程 + Remotion 运行时）
    workspacePath: tmpDir,
  };
});

vi.mock("../lib/config", () => ({
  config: {
    databasePath: ":memory:",
    honeydoCliPath: holder.honeydoPath,
    wallpaperVideoSpawnTimeoutMs: 5_400_000,
    wallpaperVideoSeconds: 4,
    wallpaperVideoLoopSeconds: 8,
    videoWorkspacePath: holder.workspacePath,
    video: {
      ffmpegPath: holder.ffmpegPath,
      ffprobePath: `${holder.tmpDir}/fake-ffprobe`,
    },
  },
}));

import {
  assertVideoSpawnPrerequisites,
  clampWallpaperVideoSeconds,
  transcodeForAerial,
  transcodeForGallery,
} from "../lib/wallpaper/video";

function readArgs(n: number): string[] {
  return execFileSync("cat", [`${holder.ffmpegArgsDir}/args-${n}.txt`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((l) => l.length > 0);
}

beforeAll(() => {
  mkdirSync(holder.ffmpegArgsDir, { recursive: true });

  // fake ffmpeg：追加记录 argv 到 args-<n>.txt，并 touch 最后一个参数（产物）
  const okBody = `n=$(cat "${holder.ffmpegCountPath}" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "${holder.ffmpegCountPath}"\nprintf '%s\\n' "$@" > "${holder.ffmpegArgsDir}/args-$n.txt"\n`;
  writeFileSync(
    holder.ffmpegPath,
    `#!/bin/sh\n${okBody}last=""\nfor a in "$@"; do last="$a"; done\ntouch "$last"\n`,
    { mode: 0o755 },
  );
  chmodSync(holder.ffmpegPath, 0o755);

  // fail-once ffmpeg：第 1 次 exit 1，第 2 次走成功路径（touch 产物）
  writeFileSync(
    holder.ffmpegFailOncePath,
    `#!/bin/sh\n${okBody}if [ "$n" = "1" ]; then echo "fake hw encoder failure" >&2; exit 1; fi\nlast=""\nfor a in "$@"; do last="$a"; done\ntouch "$last"\n`,
    { mode: 0o755 },
  );
  chmodSync(holder.ffmpegFailOncePath, 0o755);

  // fake honeydo（存在性校验用）
  writeFileSync(holder.honeydoPath, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(holder.honeydoPath, 0o755);

  // v2 前置校验 fixture：wallpaper-overlay 工程 + Remotion 运行时 + 字体 + 浏览器
  mkdirSync(`${holder.workspacePath}/wallpaper-overlay/src`, { recursive: true });
  writeFileSync(`${holder.workspacePath}/wallpaper-overlay/src/index.ts`, "// fake entry\n");
  mkdirSync(`${holder.workspacePath}/node_modules/.bin`, { recursive: true });
  writeFileSync(`${holder.workspacePath}/node_modules/.bin/remotion`, "#!/bin/sh\n", {
    mode: 0o755,
  });
  mkdirSync(`${holder.workspacePath}/wallpaper-overlay/public/fonts`, { recursive: true });
  writeFileSync(
    `${holder.workspacePath}/wallpaper-overlay/public/fonts/NotoSerifSC-Regular.otf`,
    "fake-font",
  );
  mkdirSync(
    `${holder.workspacePath}/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64`,
    { recursive: true },
  );
  writeFileSync(
    `${holder.workspacePath}/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    "#!/bin/sh\n",
    { mode: 0o755 },
  );
});

beforeEach(() => {
  // 每个用例重置 fake ffmpeg 调用计数
  rmSync(holder.ffmpegCountPath, { force: true });
});

afterAll(() => {
  rmSync(holder.tmpDir, { recursive: true, force: true });
});

describe("transcodeForAerial / transcodeForGallery", () => {
  it("transcodeForAerial：hevc_videotoolbox + scale=1920:1080 + hvc1 + -an +faststart", async () => {
    const dst = `${holder.tmpDir}/out.mov`;
    await transcodeForAerial("/tmp/src.mp4", dst);

    const args = readArgs(1);
    expect(args).toContain("-i");
    expect(args).toContain("scale=1920:1080:flags=lanczos");
    expect(args).toContain("hevc_videotoolbox");
    expect(args).toContain("hvc1");
    expect(args).toContain("-an");
    expect(args).toContain("+faststart");
  });

  it("transcodeForAerial：hevc_videotoolbox 失败 → fallback libx265 -crf 22 -tag:v hvc1", async () => {
    // fail-once ffmpeg：第 1 次（hevc_videotoolbox）失败，第 2 次（libx265）成功
    const { config } = await import("../lib/config");
    const saved = (config.video as { ffmpegPath: string }).ffmpegPath;
    (config.video as { ffmpegPath: string }).ffmpegPath = holder.ffmpegFailOncePath;
    try {
      const dst = `${holder.tmpDir}/out-fallback.mov`;
      await transcodeForAerial("/tmp/src.mp4", dst);

      const args1 = readArgs(1);
      expect(args1).toContain("hevc_videotoolbox");
      const args2 = readArgs(2);
      expect(args2).toContain("libx265");
      expect(args2).toContain("-crf");
      expect(args2[args2.indexOf("-crf") + 1]).toBe("22");
      expect(args2).toContain("hvc1");
    } finally {
      (config.video as { ffmpegPath: string }).ffmpegPath = saved;
    }
  });

  it("transcodeForGallery【v2】：libx264 crf18 + aac 128k + faststart（保留音轨）", async () => {
    const dst = `${holder.tmpDir}/out.mp4`;
    await transcodeForGallery("/tmp/src.mp4", dst);

    const args = readArgs(1);
    expect(args).toContain("-c:v");
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args).toContain("-crf");
    expect(args[args.indexOf("-crf") + 1]).toBe("18");
    expect(args).toContain("-c:a");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args).toContain("-b:a");
    expect(args[args.indexOf("-b:a") + 1]).toBe("128k");
    expect(args).toContain("+faststart");
    // v2 契约反转：不再去音轨（无 -an）
    expect(args).not.toContain("-an");
    // v2：不再流拷贝（-c:v copy → 重编码）
    expect(args[args.indexOf("-c:v") + 1]).not.toBe("copy");
  });
});

describe("assertVideoSpawnPrerequisites", () => {
  it("honeydo bin / ffmpeg / 原图 / overlay 工程 / Remotion 运行时 / 字体 全存在 → 通过", async () => {
    const photo = `${holder.tmpDir}/hero.png`;
    writeFileSync(photo, "fake-image");
    await expect(assertVideoSpawnPrerequisites(photo)).resolves.toBeUndefined();
  });

  it("原图缺失 → throw（message 含 label 与路径）", async () => {
    const missing = `${holder.tmpDir}/no-such-hero.png`;
    await expect(assertVideoSpawnPrerequisites(missing)).rejects.toThrow(/hero 原图/);
  });

  it("【v2】Remotion 运行时缺失 → throw（不自动安装）", async () => {
    const { config } = await import("../lib/config");
    const saved = config.videoWorkspacePath;
    (config as { videoWorkspacePath: string }).videoWorkspacePath =
      `${holder.tmpDir}/no-such-workspace`;
    try {
      const photo = `${holder.tmpDir}/hero.png`;
      writeFileSync(photo, "fake-image");
      await expect(assertVideoSpawnPrerequisites(photo)).rejects.toThrow(/Remotion 运行时/);
    } finally {
      (config as { videoWorkspacePath: string }).videoWorkspacePath = saved;
    }
  });

  it("【v2】wallpaper-overlay 工程缺失 → throw", async () => {
    const { config } = await import("../lib/config");
    const saved = config.videoWorkspacePath;
    (config as { videoWorkspacePath: string }).videoWorkspacePath =
      `${holder.tmpDir}/empty-workspace`;
    mkdirSync(`${holder.tmpDir}/empty-workspace/node_modules/.bin`, { recursive: true });
    writeFileSync(`${holder.tmpDir}/empty-workspace/node_modules/.bin/remotion`, "#!/bin/sh\n");
    try {
      const photo = `${holder.tmpDir}/hero.png`;
      writeFileSync(photo, "fake-image");
      await expect(assertVideoSpawnPrerequisites(photo)).rejects.toThrow(/wallpaper-overlay 工程/);
    } finally {
      (config as { videoWorkspacePath: string }).videoWorkspacePath = saved;
    }
  });
});

describe("clampWallpaperVideoSeconds", () => {
  it("clamp ∈ [1,15]：0→1，4→4，15→15，16→15，-5→1，非有限→4（v2 默认）", () => {
    expect(clampWallpaperVideoSeconds(0)).toBe(1);
    expect(clampWallpaperVideoSeconds(4)).toBe(4);
    expect(clampWallpaperVideoSeconds(15)).toBe(15);
    expect(clampWallpaperVideoSeconds(16)).toBe(15);
    expect(clampWallpaperVideoSeconds(-5)).toBe(1);
    expect(clampWallpaperVideoSeconds(Number.NaN)).toBe(4);
  });
});

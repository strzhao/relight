/**
 * 单测：lib/wallpaper/video.ts — transcodeForAerialNative / transcodeForGallery /
 * assertVideoDimensions / assertVideoSpawnPrerequisites / clampWallpaperVideoSeconds
 * （任务 2 + v2 增量任务 12/14/15；20260928 单腿原生：条件 Aerial crop 链 + 尺寸护栏）
 *
 * 契约（state.md ## 契约规约 / ## 设计文档 D2）：
 *   transcodeForAerialNative 产物 invariant：容器 mov ∧ HEVC(tag hvc1) ∧ 1920×1080 ∧
 *     带音轨 aac 128k ∧ faststart；滤镜链 crop 前置（居中裁恰 16:9）+ scale=1920:1080 后置
 *     （crop 已保证入 scale 前比例恰 16:9，绝不拉伸）+ setsar=1
 *   transcodeForGallery 产物 invariant【v2】：容器 mp4 ∧ H.264（libx264 crf18）∧
 *     有音频流（aac 128k）∧ faststart（画廊静音自动播放 + 点击开声）∧ 无 -vf 尺寸透传
 *   assertVideoDimensions（20260928 尺寸护栏）：ffprobe 断言产物尺寸，不匹配即 throw
 *     （message 显式含「尺寸断言失败」语义——场景 5.P2 禁静默失败）
 *   isAerialCompatCanvas：画布长短轴比 ∈ [1.5, 1.9]（闭区间；窗外 mac 静态回退）
 *   hevc_videotoolbox 失败 fallback libx265 -crf 22 -tag:v hvc1
 *   assertVideoSpawnPrerequisites【v2】增查：wallpaper-overlay 工程 / Remotion 运行时 /
 *     overlay 字体（缺失报错，不自动安装）
 *   clampWallpaperVideoSeconds：非有限 → 默认 4（v2 recipes 纪律）
 *
 * 测试策略：mock ../lib/config 注入 fake ffmpeg shell 脚本（记录 argv 后 touch 产物/
 * 退出非零），黑盒断言参数拼装与 fallback 行为；assertVideoDimensions 用真实 ffmpeg 造
 * 定尺寸小样片 + 真实 ffprobe（护栏本身必须对真实媒体文件判别）。
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

import { config } from "../lib/config";
import {
  assertVideoDimensions,
  assertVideoSpawnPrerequisites,
  clampWallpaperVideoSeconds,
  isAerialCompatCanvas,
  transcodeForAerialNative,
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

describe("transcodeForAerialNative / transcodeForGallery（20260928）", () => {
  it("transcodeForAerialNative：crop 前置（居中裁 16:9）+ scale=1920:1080 后置 setsar=1 + hvc1 + 带音轨 aac +faststart", async () => {
    const dst = `${holder.tmpDir}/out.mov`;
    await transcodeForAerialNative("/tmp/src.mp4", dst);

    const args = readArgs(1);
    expect(args).toContain("-i");
    // 滤镜链逐字（D2 转码 B）：crop 前置 + 等比 scale 后置 + setsar=1（绝不拉伸）
    const vfIdx = args.indexOf("-vf");
    const vf = args[vfIdx + 1] ?? "";
    expect(vf).toContain("crop=w='min(iw,ih*16/9)':h='min(ih,iw*9/16)'");
    expect(vf).toContain("scale=1920:1080:flags=lanczos");
    expect(vf).toContain("setsar=1");
    // crop 必须先于 scale（场景 3.P2：crop 前置保证入 scale 前比例恰 16:9）
    expect(vf.indexOf("crop=")).toBeLessThan(vf.indexOf("scale="));
    expect(args).toContain("hevc_videotoolbox");
    expect(args).toContain("hvc1");
    // 2026-09-13 验收要求：以后生成的视频带音轨
    expect(args).not.toContain("-an");
    expect(args).toContain("-c:a");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args).toContain("-b:a");
    expect(args[args.indexOf("-b:a") + 1]).toBe("128k");
    expect(args).toContain("+faststart");
  });

  it("transcodeForAerialNative：hevc_videotoolbox 失败 → fallback libx265 -crf 22 -tag:v hvc1", async () => {
    // fail-once ffmpeg：第 1 次（hevc_videotoolbox）失败，第 2 次（libx265）成功
    const { config } = await import("../lib/config");
    const saved = (config.video as { ffmpegPath: string }).ffmpegPath;
    (config.video as { ffmpegPath: string }).ffmpegPath = holder.ffmpegFailOncePath;
    try {
      const dst = `${holder.tmpDir}/out-fallback.mov`;
      await transcodeForAerialNative("/tmp/src.mp4", dst);

      const args1 = readArgs(1);
      expect(args1).toContain("hevc_videotoolbox");
      const args2 = readArgs(2);
      expect(args2).toContain("libx265");
      expect(args2).toContain("-crf");
      expect(args2[args2.indexOf("-crf") + 1]).toBe("22");
      expect(args2).toContain("hvc1");
      // fallback 链同样带 crop 前置（窗口内任何硬件路径都不得拉伸）
      const vf2 = args2[args2.indexOf("-vf") + 1] ?? "";
      expect(vf2).toContain("crop=");
    } finally {
      (config.video as { ffmpegPath: string }).ffmpegPath = saved;
    }
  });

  it("transcodeForGallery【v2】：libx264 crf18 + aac 128k + faststart（保留音轨）；无 -vf 尺寸透传（原生比例直通）", async () => {
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
    // 20260928：无 -vf（分辨率 == 源画布，画廊消费原生比例）
    expect(args).not.toContain("-vf");
  });
});

describe("isAerialCompatCanvas（20260928 方向性比例窗口 [1.5, 1.9] 闭区间）", () => {
  it("窗口内（含边界，仅横版画布）→ true", () => {
    expect(isAerialCompatCanvas({ width: 1500, height: 1000 })).toBe(true); // 1.5 恰边界
    expect(isAerialCompatCanvas({ width: 1900, height: 1000 })).toBe(true); // 1.9 恰边界
    expect(isAerialCompatCanvas({ width: 1440, height: 800 })).toBe(true); // 1.8（16:9 档）
    expect(isAerialCompatCanvas({ width: 1312, height: 864 })).toBe(true); // 1.5185（3:2 档）
  });

  it("窗外 → false（竖版画布 w/h<1 恒窗外；超宽全景/1:1 也不产 .mov，mac 静态回退）", () => {
    expect(isAerialCompatCanvas({ width: 1496, height: 1000 })).toBe(false); // 1.496 < 1.5
    expect(isAerialCompatCanvas({ width: 1912, height: 1000 })).toBe(false); // 1.912 > 1.9
    expect(isAerialCompatCanvas({ width: 800, height: 1440 })).toBe(false); // 竖版 0.5556（竖裁横砍 69% 画面）
    expect(isAerialCompatCanvas({ width: 1664, height: 704 })).toBe(false); // 2.3636（超宽兜底档）
    expect(isAerialCompatCanvas({ width: 1056, height: 1056 })).toBe(false); // 1:1
  });
});

describe("assertVideoDimensions（20260928 尺寸护栏，真实 ffmpeg/ffprobe 判别）", () => {
  // 本组用真实 ffprobe（文件级 config mock 注入的是 fake 路径）——护栏必须对真实媒体判别
  const videoCfg = config.video as { ffprobePath: string };
  const savedFfprobe = videoCfg.ffprobePath;
  videoCfg.ffprobePath = "ffprobe";
  afterAll(() => {
    videoCfg.ffprobePath = savedFfprobe;
  });

  /** ffmpeg 造定尺寸 0.3s 小样片（真实媒体，护栏必须对真实文件判别） */
  function makeTinyMp4(outPath: string, size: string): void {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${size}:rate=12:duration=0.3`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        outPath,
      ],
      { timeout: 30000 },
    );
  }

  it("尺寸匹配 → 放行（1920×1080 期望 vs 1920×1080 产物）", async () => {
    const src = `${holder.tmpDir}/guard-ok.mp4`;
    makeTinyMp4(src, "1920x1080");
    await expect(assertVideoDimensions(src, 1920, 1080)).resolves.toBeUndefined();
  });

  it("尺寸不匹配 → throw 且 message 显式含「尺寸断言失败」与期望/实际值（禁静默失败）", async () => {
    const src = `${holder.tmpDir}/guard-bad.mp4`;
    makeTinyMp4(src, "1918x1080");
    const err = (await assertVideoDimensions(src, 1920, 1080).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("尺寸断言失败");
    expect(err.message).toContain("1920×1080");
    expect(err.message).toContain("1918×1080");
  });

  it("文件不存在/非媒体 → throw（ffprobe 探测异常分支同样显式报错）", async () => {
    const err = (await assertVideoDimensions(`${holder.tmpDir}/no-such.mp4`, 1920, 1080).catch(
      (e) => e,
    )) as Error;
    expect(err.message).toContain("尺寸断言失败");
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

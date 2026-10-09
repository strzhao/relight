/**
 * 验收测试（红队，real-process，capability-gate）：renderTextOverlay 排版档恒定真渲染
 *
 * 设计文档（state.md §设计文档 D3 / §验收场景）对应谓词（20261009 排版解耦改版）：
 *   - 场景 9.P1 [real-process]：以 4:3 档生成画布输入（1248×928）触发 `npx remotion render`
 *     → 产物尺寸 == variant 排版档恒定值（landscape 1920×1080 / portrait 1290×2796）。
 *     kill 20260928 画布参数化回归（若 comp 尺寸重新跟随 props.canvasWidth/canvasHeight，
 *     产物会变成 1248×928 → 红）；同时 kill 输入分辨率透传（产物不随输入 1248×928）。
 *
 * 设计契约（20261009 逐字）：Root.tsx 两 comp 尺寸恒定 1920×1080 / 1290×2796
 *   （calculateMetadata 参数化已移除）；WallpaperOverlay.tsx 布局分支按 props.variant
 *   显式判定（缺省回退画布比例 ≥0.9，Studio 预览兼容）；输入 loop 任意原生比例由
 *   comp 内 contain（landscape）/cover（portrait）适配。
 *
 * 环境前提（惯例沿 wallpaper-video-overlay-realprocess.acceptance.test.ts）：
 *   {config.videoWorkspacePath}/wallpaper-overlay 工程存在——CI 必然缺失 → capability-gate
 *   skip + warn，本机工作区就绪即自动真跑（真实 npx remotion render，无 GPU 依赖；
 *   首跑 bundling 冷启动可达 600s 级）。
 * 输入：4:3 档画布 1248×928（D1 参考输出，非历史默认 1280×704/736×1600）× 2s 母版。
 * 红队铁律：不读蓝队实现代码；renderTextOverlay 按契约函数名黑盒 import；不宽容跳过。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../lib/config";

const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

function writeArtifact(id: string, content: string): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

/** §设计文档 D3 逐字：videoWorkspacePath 下 wallpaper-overlay 工程 */
const OVERLAY_WORKSPACE = path.join(config.videoWorkspacePath, "wallpaper-overlay");

// [capability-gate 惯例]：overlay 工程是本机 runtime 工作区产物（不入库）——
// 缺失时 skip + warn，本机存在即自动真跑（同 wallpaper-video-overlay-realprocess 决策留痕）。
const OVERLAY_WS_AVAILABLE = fs.existsSync(OVERLAY_WORKSPACE);
if (!OVERLAY_WS_AVAILABLE) {
  console.warn(
    "[wallpaper-video-native-overlay-realprocess] Remotion 文字层工程不在本机——real-process 用例 skip（工作区就绪时自动真跑）",
  );
}
const dOverlay = OVERLAY_WS_AVAILABLE ? describe : describe.skip;

let tmpRoot = "";
let inputVideo = "";
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
  variant: "landscape" | "portrait",
) => Promise<{ overlaidPath: string }>;

interface ProbeResult {
  width: number | null;
  height: number | null;
  formatName: string;
}

function probeVideo(file: string): ProbeResult {
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
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const v = (j.streams ?? []).find((s) => s.codec_type === "video");
  return {
    width: v?.width ?? null,
    height: v?.height ?? null,
    formatName: j.format?.format_name ?? "",
  };
}

beforeAll(async () => {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    const p = spawnSync(bin, ["-version"], { encoding: "utf-8", timeout: 15000 });
    if (p.status !== 0) {
      throw new Error(`${bin} 不可用——本验收要求真实环境`);
    }
  }

  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvnosreal-"));

  // 4:3 档画布母版 1248×928（D1 参考输出；非排版档 1920×1080/1290×2796）× 2s
  inputVideo = path.join(tmpRoot, "input-1248x928.mp4");
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1248x928:rate=24:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      inputVideo,
    ],
    { encoding: "utf-8", timeout: 60000 },
  );
  if (r.status !== 0 || !fs.existsSync(inputVideo)) {
    throw new Error(`fixture ffmpeg 造样片失败: ${r.stderr}`);
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

dOverlay("场景 9.P1 [real-process]：4:3 档输入真渲染 → 产物尺寸 == variant 排版档恒定值", () => {
  it("renderTextOverlay(…, 'landscape') → 产物恒 1920×1080 mp4（画布参数化/输入透传回归即红）", async () => {
    const res = await renderTextOverlay(
      inputVideo,
      {
        pickDate: "2026-09-20",
        title: "金色黄昏",
        narrative: "五年前的今天，你在海边捕捉到了这张温暖的照片。夕阳将天空染成金橙色。",
        captureDateline: "拍摄于 2021-05-05 18:30 · 5 年前",
        canvasWidth: 1248,
        canvasHeight: 928,
      },
      "landscape",
    );

    expect(res.overlaidPath, "必须产出 overlaidPath").toBeTruthy();
    expect(fs.existsSync(res.overlaidPath), `产物不存在: ${res.overlaidPath}`).toBe(true);

    const meta = probeVideo(res.overlaidPath);
    writeArtifact("s9p1", JSON.stringify({ overlaidPath: res.overlaidPath, ...meta }, null, 2));

    // 谓词字面量：产物尺寸 == landscape 排版档（与输入 1248×928 / 生成画布解耦）
    expect(meta.width, `产物宽必须恒 1920（排版档），实际 ${meta.width}`).toBe(1920);
    expect(meta.height, `产物高必须恒 1080（排版档），实际 ${meta.height}`).toBe(1080);
    // 历史回归直杀断言：产物不得跟随输入/生成画布（1248×928）
    expect(`${meta.width}x${meta.height}`).not.toBe("1248x928");
    expect(meta.formatName).toContain("mp4");
  }, 900000);

  it("renderTextOverlay(…, 'portrait') → 产物恒 1290×2796 mp4（竖版排版档）", async () => {
    const res = await renderTextOverlay(
      inputVideo,
      {
        pickDate: "2026-09-20",
        title: "金色黄昏",
        narrative: "五年前的今天，你在海边捕捉到了这张温暖的照片。夕阳将天空染成金橙色。",
        captureDateline: "拍摄于 2021-05-05 18:30 · 5 年前",
        canvasWidth: 1248,
        canvasHeight: 928,
      },
      "portrait",
    );

    expect(res.overlaidPath, "必须产出 overlaidPath").toBeTruthy();
    expect(fs.existsSync(res.overlaidPath), `产物不存在: ${res.overlaidPath}`).toBe(true);

    const meta = probeVideo(res.overlaidPath);
    writeArtifact(
      "s9p1-portrait",
      JSON.stringify({ overlaidPath: res.overlaidPath, ...meta }, null, 2),
    );

    expect(meta.width, `产物宽必须恒 1290（竖版排版档），实际 ${meta.width}`).toBe(1290);
    expect(meta.height, `产物高必须恒 2796（竖版排版档），实际 ${meta.height}`).toBe(2796);
    expect(meta.formatName).toContain("mp4");
  }, 900000);
});

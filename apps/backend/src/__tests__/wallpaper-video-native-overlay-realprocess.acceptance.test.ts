/**
 * 验收测试（红队，real-process，capability-gate）：renderTextOverlay 画布参数化真渲染
 *
 * 设计文档（state.md §设计文档 D3 / §验收场景）对应谓词：
 *   - 场景 9.P1 [real-process]：以非历史默认画布（4:3 档 1248×928）触发 `npx remotion render`
 *     → 产物尺寸 == 参数化 W×H（kill 尺寸写死 No-op：若实现仍写死 1280×704/736×1600，
 *     产物不会是 1248×928 → 红）
 *
 * 设计契约（D3 逐字）：Root.tsx 两个 comp 增加 calculateMetadata，从新增 props
 *   canvasWidth/canvasHeight 返回动态 width/height（Remotion v4 支持）；
 *   WallpaperOverlay.tsx 布局分支统一按 props 比例判定（≥0.9 两栏横版 / <0.9 竖版全屏）。
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

  // 4:3 档画布母版 1248×928（D1 参考输出；非历史默认 1280×704 / 736×1600）× 2s
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

dOverlay("场景 9.P1 [real-process]：4:3 档画布（1248×928）真渲染 → 产物尺寸 == 参数化 W×H", () => {
  it("renderTextOverlay(canvasWidth=1248, canvasHeight=928) → 产物 1248×928 mp4（尺寸写死即红）", async () => {
    const res = await renderTextOverlay(inputVideo, {
      pickDate: "2026-09-20",
      title: "金色黄昏",
      narrative: "五年前的今天，你在海边捕捉到了这张温暖的照片。夕阳将天空染成金橙色。",
      captureDateline: "拍摄于 2021-05-05 18:30 · 5 年前",
      canvasWidth: 1248,
      canvasHeight: 928,
    });

    expect(res.overlaidPath, "必须产出 overlaidPath").toBeTruthy();
    expect(fs.existsSync(res.overlaidPath), `产物不存在: ${res.overlaidPath}`).toBe(true);

    const meta = probeVideo(res.overlaidPath);
    writeArtifact("s9p1", JSON.stringify({ overlaidPath: res.overlaidPath, ...meta }, null, 2));

    // 谓词字面量：产物尺寸 == 参数化 W×H
    expect(meta.width, `产物宽必须 1248（参数化画布），实际 ${meta.width}`).toBe(1248);
    expect(meta.height, `产物高必须 928（参数化画布），实际 ${meta.height}`).toBe(928);
    // 历史默认尺寸写死的直杀断言
    expect(`${meta.width}x${meta.height}`).not.toBe("1280x704");
    expect(`${meta.width}x${meta.height}`).not.toBe("736x1600");
    expect(meta.formatName).toContain("mp4");
  }, 900000);
});

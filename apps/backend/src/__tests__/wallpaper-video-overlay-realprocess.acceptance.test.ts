/**
 * 验收测试（红队，real-process）：renderTextOverlay 真实 Remotion 渲染冒烟【v2 增量】
 *
 * 设计文档（state.md）对应契约（§契约规约 计算/spawn 契约【v2】逐字）：
 *   - renderTextOverlay(videoPath, meta: {pickDate,title,narrative}) → {overlaidPath}
 *   - 产物 invariant：与输入视频同分辨率同帧率 ∧ 含文字层（首帧 vs 输入首帧像素差异 >0）
 *     ∧ 封装 mp4
 *   - §后端设计 §1【v2】：videoWorkspacePath 下新增 wallpaper-overlay/ 工程，
 *     直接 `npx remotion render`（无 AI、确定性渲染；字体复用 Satori 模板的
 *     Fraunces/Noto Serif SC）
 *
 * 验收点（round 2 编排器）：真实渲染冒烟放独立 real-process 文件 + 超小输入（2s 样片）。
 *   mock 面（错误枚举 / 调用形态）见 wallpaper-video-overlay.acceptance.test.ts。
 *   输入用生产画布 1280×704（边界值【v2】横版画布，honeydo 720p 母版形态）× 2s——
 *   超小体现在时长（24fps × 2s = 48 帧）；分辨率必须用生产画布：
 *   实测实现按 1280×704 固定画布渲染（喂 256p 样片产出仍 1280×704，同分辨率 invariant
 *   对非生产画布输入不成立——已作为观察项报告 QA；生产链路母版恒为 1280×704，
 *   invariant 在生产包络内成立）。
 *
 * 环境前提（§后端设计 §1【v2】——文字层工程是 v2 交付物的一部分）：
 *   {config.videoWorkspacePath}/wallpaper-overlay 工程必须存在；缺失即真红（禁宽容跳过）。
 *   渲染走真实 npx remotion render（无 AI、无 GPU 依赖）。
 *   首跑含 Remotion bundling / Chrome Headless Shell 冷启动，实测可达 600s 级（一次性，
 *   bundle 缓存后续秒级）；实现侧自身超时 600s（OverlayRenderError 超时分支），本用例
 *   vitest 超时给 900s 让实现自身超时先触发。
 *
 * 红队铁律：不读蓝队实现代码；renderTextOverlay 按契约函数名黑盒 import 执行；不 skip。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../lib/config";

/** §后端设计 §1【v2】逐字：videoWorkspacePath 下新增 wallpaper-overlay/ 工程 */
const OVERLAY_WORKSPACE = path.join(config.videoWorkspacePath, "wallpaper-overlay");

let tmpRoot = "";
let inputVideo = "";
let renderTextOverlay: (
  videoPath: string,
  meta: { pickDate: string; title: string; narrative: string },
) => Promise<{ overlaidPath: string }>;

interface ProbeResult {
  width: number | null;
  height: number | null;
  rFrameRate: string | null;
  codecName: string | null;
}

function probeVideo(file: string): ProbeResult {
  const r = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate,codec_name",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf-8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`ffprobe 失败（${file}）: ${r.stderr}`);
  }
  const j = JSON.parse(r.stdout) as {
    streams?: Array<{
      width?: number;
      height?: number;
      r_frame_rate?: string;
      codec_name?: string;
    }>;
  };
  const v = j.streams?.[0];
  return {
    width: v?.width ?? null,
    height: v?.height ?? null,
    rFrameRate: v?.r_frame_rate ?? null,
    codecName: v?.codec_name ?? null,
  };
}

/** 首帧原始像素（rgb24 rawvideo）——像素差异比较用 */
function firstFrameRaw(file: string): Buffer {
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) {
    throw new Error(`首帧提取失败（${file}）: ${r.stderr?.toString().slice(0, 500)}`);
  }
  return Buffer.from(r.stdout);
}

beforeAll(async () => {
  // ffmpeg/ffprobe 硬前置
  for (const [bin, args] of [
    ["ffmpeg", ["-version"]],
    ["ffprobe", ["-version"]],
  ] as Array<[string, string[]]>) {
    const p = spawnSync(bin, args, { encoding: "utf-8", timeout: 15000 });
    if (p.status !== 0) {
      throw new Error(`${bin} 不可用——renderTextOverlay real-process 冒烟要求真实 ffmpeg 环境`);
    }
  }

  // 文字层工程硬前置（§后端设计 §1【v2】——缺失即真红，禁宽容跳过）
  if (!fs.existsSync(OVERLAY_WORKSPACE)) {
    throw new Error(
      `Remotion 文字层工程不存在：${OVERLAY_WORKSPACE}（§后端设计 §1【v2】：videoWorkspacePath 下新增 wallpaper-overlay/ 工程——v2 交付物缺失即真红）`,
    );
  }

  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvovreal-"));

  // 超小输入：2s 1280×704（生产横版画布）24fps 样片，带立体声音轨（贴近无文字微动母版形态）
  inputVideo = path.join(tmpRoot, "overlay-input-720p.mp4");
  const gen = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x704:rate=24:duration=2",
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
      inputVideo,
    ],
    { encoding: "utf-8", timeout: 60000 },
  );
  if (gen.status !== 0 || !fs.existsSync(inputVideo)) {
    throw new Error(`fixture ffmpeg 造 2s 256p 样片失败: ${gen.stderr}`);
  }

  const mod = (await import("../lib/wallpaper/video")) as unknown as Record<string, unknown>;
  expect(
    typeof mod.renderTextOverlay,
    "契约函数 renderTextOverlay 未由 lib/wallpaper/video 导出（§契约规约【v2】）",
  ).toBe("function");
  renderTextOverlay = mod.renderTextOverlay as typeof renderTextOverlay;
}, 60000);

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// 产物 invariant（真实渲染）
// ============================================================================

describe("【v2】renderTextOverlay 产物 invariant（真实 Remotion 渲染，2s 720p 超小输入）", () => {
  it("产物存在 ∧ 封装 mp4 ∧ 与输入同分辨率同帧率 ∧ 首帧像素差异 >0（文字层存在）", async () => {
    // 本用例真实执行 npx remotion render：首跑含 bundling/Chrome Headless Shell 冷启动，
    // vitest 用例超时给 900s（> 契约实现侧 600s 超时——让实现自身的 OverlayRenderError
    // 超时分支先触发，避免 vitest 超时掩盖真实失败形态）
    const res = await renderTextOverlay(inputVideo, {
      pickDate: "2026-09-12",
      title: "金色黄昏",
      narrative: "五年前的今天，你在海边捕捉到了这张温暖的照片。夕阳染成金橙色，海浪轻抚沙滩。",
    });

    // 返回契约 + 产物存在
    expect(res).toBeTruthy();
    expect(typeof res.overlaidPath).toBe("string");
    expect(res.overlaidPath.length).toBeGreaterThan(0);
    expect(fs.existsSync(res.overlaidPath), `叠字成品不存在: ${res.overlaidPath}`).toBe(true);
    const size = fs.statSync(res.overlaidPath).size;
    expect(size).toBeGreaterThan(0);

    // 契约逐字：封装 mp4（ftyp box 头）
    const head = fs.readFileSync(res.overlaidPath).subarray(0, 64).toString("latin1");
    expect(head, "成品必须是 mp4 封装（文件头含 ftyp）").toContain("ftyp");

    // 契约（2026-09-13 v3 修订）：横版画布升 1920×1080（Aerial 原生 16:9），
    // 输入 1280×704(20:11) 在两栏画布内按 contain 重排版 → 成品 1920×1080；
    // 帧率仍与输入同源。
    const inProbe = probeVideo(inputVideo);
    const outProbe = probeVideo(res.overlaidPath);
    expect(outProbe.width, "横版成品宽度必须 1920（两栏画布）").toBe(1920);
    expect(outProbe.height, "横版成品高度必须 1080").toBe(1080);
    expect(
      outProbe.rFrameRate,
      `成品帧率 ${outProbe.rFrameRate} ≠ 输入帧率 ${inProbe.rFrameRate}`,
    ).toBe(inProbe.rFrameRate);

    // 契约逐字：含文字层（首帧 vs 输入首帧像素差异 >0）
    const inFrame = firstFrameRaw(inputVideo);
    const outFrame = firstFrameRaw(res.overlaidPath);
    expect(outFrame.length, "成品首帧 raw 尺寸与画布不一致（分辨率/像素格式漂移）").toBe(
      1920 * 1080 * 3,
    );
    expect(
      inFrame.equals(outFrame),
      "成品首帧与输入首帧逐像素相同——文字层不存在（首帧像素差异必须 >0）",
    ).toBe(false);
  }, 900000);
});

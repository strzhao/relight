/**
 * 验收测试（红队）：壁纸视频产物画布契约【20260928 单腿原生改版——native 版】
 *
 * 设计文档（state.md ## 验收场景）对应谓词（QA 真机绑定求值）：
 *   - 场景 1.P2 [det-machine]：生成画布跟随原图比例（32 倍数 +
 *     abs(h - w*srcH/srcW) <= 32）｜ driver: 本地 ffprobe 尺寸探测
 *   - 场景 1.P3 [det-machine]：width*height <= 1177600 && >= 1177600/2
 *   - 场景 2.P3 形态（沿用）：产物为浏览器可直接播放、首帧前可解码、保留音轨的 mp4
 *     assert: video_codec=="h264" && has_audio_stream==true && moov_before_mdat==true
 *             && http_status in {200,206}
 *   - 历史竖版 2.P1（比例对齐 1290×2796 静态壁纸）随固定竖版画布一并退役——原生画布
 *     比例跟随原图，不再有统一竖版档
 *
 * QA 真机绑定项（信息隔离下只声明类别，求值时以 env 绑定，绑定缺失留 artifact + 可见 skip，
 * 绑定存在但资源缺失/断言失败一律真红）：
 *   - WVQA_NATIVE_MP4        重跑后的 native 产物落盘路径
 *   - WVQA_SOURCE_W/H        hero 原图尺寸（1.P2 比例跟随断言用；未绑定则该谓词跳过并留痕）
 *   - WVQA_NATIVE_URL        native 产物公网地址（HTTP 面；缺省回退 DB 回执列派生）
 *   - WVQA_DB_PATH           SQLite 路径（从 daily_picks.wallpaper_video_native_url 派生公网地址）
 *
 * 假绿防护（harness 自检，始终真跑）：ffmpeg 合成正/负对照验证测量函数判别力——
 *   faststart 与非 faststart 产物 moov 顺序必须被正确区分；预算数学方向正确（1920×1080 超预算）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const ARTIFACT_DIR = "/tmp/autopilot-artifacts";
const NATIVE_MP4 = process.env.WVQA_NATIVE_MP4 ?? "";
const SOURCE_W = Number(process.env.WVQA_SOURCE_W ?? "");
const SOURCE_H = Number(process.env.WVQA_SOURCE_H ?? "");
const NATIVE_URL = process.env.WVQA_NATIVE_URL ?? "";
const DB_PATH = process.env.WVQA_DB_PATH ?? process.env.DATABASE_PATH ?? "";

/** 像素预算（## 契约规约 实现绑定表逐字：pixel_budget = 1177600，下限语义 ≥ budget/2） */
const PIXEL_BUDGET = 1_177_600;

function writeArtifact(id: string, content: string): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

// ---- 工具：ffprobe / moov box 解析（纯黑盒，针对媒体文件而非实现代码）----

interface VideoStreamInfo {
  width: number;
  height: number;
  codecName: string;
  hasAudio: boolean;
  durationSec: number;
}

function ffprobeStreams(file: string): VideoStreamInfo {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height,codec_name,codec_type",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out) as {
    streams: Array<{ width?: number; height?: number; codec_name?: string; codec_type?: string }>;
    format: { duration?: string };
  };
  const video = parsed.streams.find((s) => s.codec_type === "video");
  expect(video, `ffprobe 未找到视频流: ${file}`).toBeTruthy();
  return {
    width: video!.width ?? 0,
    height: video!.height ?? 0,
    codecName: video!.codec_name ?? "",
    hasAudio: parsed.streams.some((s) => s.codec_type === "audio"),
    durationSec: Number(parsed.format.duration ?? 0),
  };
}

/** 顶层 box 顺序解析：返回 {moov, mdat} 的文件偏移（缺失为 -1） */
function topLevelBoxOffsets(file: string): { moov: number; mdat: number } {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(8);
    const offsets = { moov: -1, mdat: -1 };
    let pos = 0;
    const size = fs.fstatSync(fd).size;
    for (let i = 0; i < 32 && pos < size; i++) {
      const n = fs.readSync(fd, head, 0, 8, pos);
      if (n < 8) break;
      const boxSize = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      let advance = boxSize;
      if (boxSize === 1) {
        const large = Buffer.alloc(8);
        fs.readSync(fd, large, 0, 8, pos + 8);
        advance = Number(large.readBigUInt64BE(0));
      } else if (boxSize === 0) {
        advance = size - pos;
      }
      if (type === "moov" && offsets.moov < 0) offsets.moov = pos;
      if (type === "mdat" && offsets.mdat < 0) offsets.mdat = pos;
      if (advance <= 0) break;
      pos += advance;
    }
    return offsets;
  } finally {
    fs.closeSync(fd);
  }
}

// ---- QA 绑定评估：绑定缺失 → 留 artifact + 可见 skip（绑定存在即真红铁律生效）----

const NATIVE_BOUND = NATIVE_MP4.trim().length > 0;
if (!NATIVE_BOUND) {
  writeArtifact(
    "场景1native-跳过原因",
    "WVQA_NATIVE_MP4 未绑定——重跑产物尚未产出（native 谓词需先真跑一次壁纸视频重跑）。" +
      "求值时绑定 env WVQA_NATIVE_MP4（可加 WVQA_SOURCE_W / WVQA_SOURCE_H / WVQA_NATIVE_URL / WVQA_DB_PATH）后重跑本套件；不得静默置 PASS。",
  );
  console.warn(
    "[native-canvas] WVQA_NATIVE_MP4 未绑定——native 产物谓词 skip（留 artifact 场景1native-跳过原因）",
  );
}
const dProduct = NATIVE_BOUND ? describe : describe.skip;

dProduct("场景 1.P2/1.P3：native 产物画布跟随原图比例 + 像素预算（本地 ffprobe）", () => {
  const product = path.resolve(NATIVE_MP4);

  it("产物文件存在（绑定路径缺失即真红）", () => {
    expect(fs.existsSync(product), `native 产物不存在: ${product}`).toBe(true);
  });

  it("1.P3 像素预算：width*height ∈ [1177600/2, 1177600]", () => {
    const info = ffprobeStreams(product);
    const pixels = info.width * info.height;
    writeArtifact(
      "场景1.P3",
      JSON.stringify({ video: `${info.width}x${info.height}`, pixels, budget: PIXEL_BUDGET }),
    );
    expect(pixels).toBeLessThanOrEqual(PIXEL_BUDGET);
    expect(pixels).toBeGreaterThanOrEqual(PIXEL_BUDGET / 2);
  });

  it("1.P2 画布跟随原图比例：w/h 均 32 倍数 ∧ abs(h - w*srcH/srcW) <= 32", () => {
    expect(
      Number.isFinite(SOURCE_W) && Number.isFinite(SOURCE_H) && SOURCE_W > 0 && SOURCE_H > 0,
      "WVQA_SOURCE_W / WVQA_SOURCE_H 未绑定——1.P2 比例跟随面无法求值（留 skip 痕迹，不静默 PASS）",
    ).toBe(true);
    const info = ffprobeStreams(product);
    writeArtifact(
      "场景1.P2",
      JSON.stringify({
        video: `${info.width}x${info.height}`,
        source: `${SOURCE_W}x${SOURCE_H}`,
        mod32: [info.width % 32, info.height % 32],
        expectedH: (info.width * SOURCE_H) / SOURCE_W,
      }),
    );
    expect(info.width % 32).toBe(0);
    expect(info.height % 32).toBe(0);
    const expectedH = (info.width * SOURCE_H) / SOURCE_W;
    expect(Math.abs(info.height - expectedH)).toBeLessThanOrEqual(32);
  });
});

// ---- 2.P3（沿用）：编码/音轨/moov（本地 ffprobe）+ 真实 HTTP Range（公网地址）----

function deriveNativeUrlFromDb(): string {
  if (!DB_PATH.trim() || !fs.existsSync(DB_PATH)) return "";
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        "SELECT wallpaper_video_native_url AS u FROM daily_picks WHERE wallpaper_video_native_url IS NOT NULL ORDER BY pick_date DESC LIMIT 1",
      )
      .get() as { u: string | null } | undefined;
    return row?.u ?? "";
  } finally {
    db.close();
  }
}

dProduct("场景 2.P3（沿用）：native 产物可播放性（h264 + 音轨 + moov 前置 + 真实 HTTP）", () => {
  const product = path.resolve(NATIVE_MP4);

  it("video_codec == h264 且保留音轨（本地 ffprobe 流信息）", () => {
    const info = ffprobeStreams(product);
    writeArtifact(
      "场景2.P3-流信息",
      JSON.stringify({ codec: info.codecName, hasAudio: info.hasAudio }, null, 2),
    );
    expect(info.codecName).toBe("h264");
    expect(info.hasAudio).toBe(true);
  });

  it("moov 原子在 mdat 之前（首帧前可解码 / faststart）", () => {
    const offsets = topLevelBoxOffsets(product);
    writeArtifact("场景2.P3-moov", JSON.stringify(offsets));
    expect(offsets.moov).toBeGreaterThan(0);
    expect(offsets.mdat).toBeGreaterThan(0);
    expect(offsets.moov).toBeLessThan(offsets.mdat);
  });

  it("真实 HTTP Range 请求 → status ∈ {200, 206}", async () => {
    const url = NATIVE_URL.trim() || deriveNativeUrlFromDb();
    expect(
      url,
      "WVQA_NATIVE_URL 未绑定且 DB native 回执列无法派生公网地址——HTTP 面无法求值（真红）",
    ).not.toBe("");
    const res = await fetch(url, { headers: { Range: "bytes=0-1023" } });
    let snippet = "";
    try {
      snippet = Buffer.from(await res.arrayBuffer())
        .subarray(0, 16)
        .toString("latin1");
    } catch {
      // body 读取失败不掩盖状态码断言
    }
    writeArtifact(
      "场景2.P3-http",
      JSON.stringify({
        url,
        status: res.status,
        contentType: res.headers.get("content-type"),
        head: snippet,
      }),
    );
    expect([200, 206]).toContain(res.status);
  }, 30000);
});

// ============================================================================
// harness 自检（始终真跑）：测量函数判别力 —— kill no-op mutation
// ============================================================================

describe("harness 自检：ffprobe/moov 解析与预算数学的判别力", () => {
  let tmpRoot = "";

  const genVideo = (out: string, faststart: boolean, size = "184x400"): void => {
    const args = [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `gradients=size=${size}:c0=0x224466:c1=0x886633`,
      "-loop",
      "1",
      "-t",
      "1",
      "-vf",
      `scale=${size.replace("x", ":")}`,
      "-frames:v",
      "24",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "baseline",
    ];
    if (faststart) args.push("-movflags", "+faststart");
    args.push(out);
    execFileSync("ffmpeg", args, { encoding: "utf-8", timeout: 60000 });
  };

  it("ffmpeg/ffprobe 可用（仓内既定环境要求，缺失即真红）", () => {
    for (const bin of ["ffmpeg", "ffprobe"]) {
      const probe = spawnSync(bin, ["-version"], { encoding: "utf-8", timeout: 15000 });
      expect(probe.status, `${bin} 不可用——环境要求 ffmpeg ≥ 4.0`).toBe(0);
    }
  });

  it("faststart 产物 moov<mdat，非 faststart 产物 moov>mdat（解析器双向判别）", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wv-canvas-harness-"));
    const fast = path.join(tmpRoot, "fast.mp4");
    const slow = path.join(tmpRoot, "slow.mp4");
    genVideo(fast, true);
    genVideo(slow, false);
    const fastOffsets = topLevelBoxOffsets(fast);
    const slowOffsets = topLevelBoxOffsets(slow);
    expect(fastOffsets.moov).toBeLessThan(fastOffsets.mdat);
    expect(slowOffsets.mdat).toBeGreaterThan(0);
    expect(slowOffsets.moov).toBeGreaterThan(slowOffsets.mdat);
  });

  it("预算数学方向：1056×1056（1:1 档）在预算带内；1920×1080 超预算（判别不恒真）", () => {
    expect(1056 * 1056).toBeLessThanOrEqual(PIXEL_BUDGET);
    expect(1056 * 1056).toBeGreaterThanOrEqual(PIXEL_BUDGET / 2);
    expect(1920 * 1080).toBeGreaterThan(PIXEL_BUDGET);
  });

  it("音轨探测：合成无声产物 hasAudio==false（探测器不做恒真）", () => {
    tmpRoot = tmpRoot || fs.mkdtempSync(path.join(os.tmpdir(), "wv-canvas-harness-"));
    const silent = path.join(tmpRoot, "silent.mp4");
    if (!fs.existsSync(silent)) genVideo(silent, true);
    expect(ffprobeStreams(silent).hasAudio).toBe(false);
  });
});

/**
 * 验收测试（红队）：竖版成片画布比例与手机展示比例对齐（场景 2）
 *
 * 设计文档（state.md）对应谓词：
 *   - 2.P1 [det-machine]：竖版产物宽高比落在 [0.44, 0.48] 且与静态竖版壁纸宽高比偏差 ≤ 5%
 *     assert: 0.44 <= (w/h)_video <= 0.48 && abs((w/h)_video - (w/h)_static)/(w/h)_static <= 0.05
 *     driver: node-script 本地 ffprobe 尺寸探测（无网络）
 *   - 2.P2 [det-machine]：竖版产物保持手机全屏清晰度
 *     assert: width >= 640 && height >= 1280
 *   - 2.P3 [real-process]：竖版产物为浏览器可直接播放、首帧前可解码、保留音轨的 mp4
 *     assert: video_codec=="h264" && has_audio_stream==true && moov_before_mdat==true
 *             && http_status in {200,206}
 *     driver: ffprobe 流信息 + 一次真实 HTTP Range 请求
 *
 * QA 真机绑定项（信息隔离下只声明类别，求值时以 env 绑定，绑定缺失留 artifact + 可见 skip，
 * 绑定存在但资源缺失/断言失败一律真红）：
 *   - WVQA_PORTRAIT_MP4      重跑后的竖版产物落盘路径
 *   - WVQA_LANDSCAPE_MOV     重跑后的横版产物落盘路径（旁证，可选）
 *   - WVQA_STATIC_PORTRAIT_JPG 静态竖版壁纸路径（比例锚点；缺省用设计锚 1290×2796）
 *   - WVQA_PORTRAIT_URL      竖版产物公网地址（2.P3 HTTP Range；缺省回退 DB 回执列，见姊妹文件）
 *   - WVQA_DB_PATH           SQLite 路径（用于从 daily_picks.wallpaper_video_portrait_url 派生公网地址）
 *
 * 假绿防护（harness 自检，始终真跑）：用 ffmpeg 合成正/负对照验证测量函数的判别力——
 *   faststart 与非 faststart 产物 moov 顺序必须被正确区分（kill moov 解析 no-op）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const ARTIFACT_DIR = "/tmp/autopilot-artifacts";
const PORTRAIT_MP4 = process.env.WVQA_PORTRAIT_MP4 ?? "";
const STATIC_JPG = process.env.WVQA_STATIC_PORTRAIT_JPG ?? "";
const PORTRAIT_URL = process.env.WVQA_PORTRAIT_URL ?? "";
const DB_PATH = process.env.WVQA_DB_PATH ?? process.env.DATABASE_PATH ?? "";

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

function ratioDeviation(a: number, b: number): number {
  return Math.abs(a - b) / b;
}

// ---- QA 绑定评估：绑定缺失 → 留 artifact + 可见 skip（绑定存在即真红铁律生效）----

const PORTRAIT_BOUND = PORTRAIT_MP4.trim().length > 0;
if (!PORTRAIT_BOUND) {
  writeArtifact(
    "场景2-跳过原因",
    "WVQA_PORTRAIT_MP4 未绑定——重跑产物尚未产出（场景 2 谓词需先真跑一次壁纸视频重跑）。" +
      "求值时绑定 env WVQA_PORTRAIT_MP4（可加 WVQA_STATIC_PORTRAIT_JPG / WVQA_PORTRAIT_URL / WVQA_DB_PATH）后重跑本套件；不得静默置 PASS。",
  );
  console.warn(
    "[portrait-canvas] WVQA_PORTRAIT_MP4 未绑定——场景 2 谓词 skip（留 artifact 场景2-跳过原因）",
  );
}
const dProduct = PORTRAIT_BOUND ? describe : describe.skip;

dProduct("场景 2.P1/2.P2：竖版产物画布比例与清晰度（本地 ffprobe）", () => {
  const product = path.resolve(PORTRAIT_MP4);

  it("产物文件存在（绑定路径缺失即真红）", () => {
    expect(fs.existsSync(product), `竖版产物不存在: ${product}`).toBe(true);
  });

  it("2.P1 宽高比 ∈ [0.44, 0.48] 且与静态竖版壁纸比例偏差 ≤ 5%", () => {
    const info = ffprobeStreams(product);
    const ar = info.width / info.height;
    // 静态锚点：QA 绑定文件优先，缺省用设计锚 1290×2796（§改动 A 逐字）
    let staticAr = 1290 / 2796;
    let staticSource = "设计锚 1290×2796";
    if (STATIC_JPG.trim()) {
      const staticInfo = ffprobeStreams(path.resolve(STATIC_JPG));
      staticAr = staticInfo.width / staticInfo.height;
      staticSource = `WVQA_STATIC_PORTRAIT_JPG ${staticInfo.width}×${staticInfo.height}`;
    }
    const deviation = ratioDeviation(ar, staticAr);
    writeArtifact(
      "场景2.P1",
      JSON.stringify(
        {
          video: `${info.width}x${info.height}`,
          ar,
          staticAr,
          staticSource,
          deviation,
          thresholds: { arRange: [0.44, 0.48], maxDeviation: 0.05 },
        },
        null,
        2,
      ),
    );
    expect(ar).toBeGreaterThanOrEqual(0.44);
    expect(ar).toBeLessThanOrEqual(0.48);
    expect(deviation).toBeLessThanOrEqual(0.05);
  });

  it("2.P2 width >= 640 && height >= 1280", () => {
    const info = ffprobeStreams(product);
    writeArtifact("场景2.P2", JSON.stringify({ width: info.width, height: info.height }));
    expect(info.width).toBeGreaterThanOrEqual(640);
    expect(info.height).toBeGreaterThanOrEqual(1280);
  });
});

// ---- 2.P3：编码/音轨/moov（本地 ffprobe）+ 真实 HTTP Range（公网地址）----

function derivePortraitUrlFromDb(): string {
  if (!DB_PATH.trim() || !fs.existsSync(DB_PATH)) return "";
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        "SELECT wallpaper_video_portrait_url AS u FROM daily_picks ORDER BY pick_date DESC LIMIT 1",
      )
      .get() as { u: string | null } | undefined;
    return row?.u ?? "";
  } finally {
    db.close();
  }
}

dProduct("场景 2.P3：竖版产物可播放性（h264 + 音轨 + moov 前置 + 真实 HTTP）", () => {
  const product = path.resolve(PORTRAIT_MP4);

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
    const url = PORTRAIT_URL.trim() || derivePortraitUrlFromDb();
    expect(
      url,
      "WVQA_PORTRAIT_URL 未绑定且 DB 回执列无法派生公网地址——2.P3 HTTP 面无法求值（真红）",
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

describe("harness 自检：ffprobe/moov 解析与比例数学的判别力", () => {
  let tmpRoot = "";

  const genVideo = (out: string, faststart: boolean): void => {
    const args = [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "gradients=size=184x400:c0=0x224466:c1=0x886633",
      "-loop",
      "1",
      "-t",
      "1",
      "-vf",
      "scale=184:400",
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

  it("比例数学：0.46 通过、旧画布 0.579 被拒（偏差函数方向正确）", () => {
    const staticAr = 1290 / 2796;
    expect(ratioDeviation(736 / 1600, staticAr)).toBeLessThanOrEqual(0.05);
    expect(ratioDeviation(704 / 1216, staticAr)).toBeGreaterThan(0.05);
  });

  it("音轨探测：合成无声产物 hasAudio==false（探测器不做恒真）", () => {
    tmpRoot = tmpRoot || fs.mkdtempSync(path.join(os.tmpdir(), "wv-canvas-harness-"));
    const silent = path.join(tmpRoot, "silent.mp4");
    if (!fs.existsSync(silent)) genVideo(silent, true);
    expect(ffprobeStreams(silent).hasAudio).toBe(false);
  });
});

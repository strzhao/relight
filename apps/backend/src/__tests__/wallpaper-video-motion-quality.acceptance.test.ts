/**
 * 验收测试（红队）：成片具备肉眼可见的画面状态改变（场景 3，运动量实测）
 *
 * 设计文档（state.md）对应谓词：
 *   - 3.P1 [det-machine]：对竖版成片均匀采样 9 帧（统一 64×112 灰度）度量
 *     assert: D_mid >= 3.0 && D_mid / D_adj >= 2.0
 *     D_mid = 首帧↔中点帧平均绝对像素差（累积型变化）；D_adj = 相邻采样帧平均绝对像素差（原地波动）。
 *     阈值说明（设计逐字）：伪循环首尾同锚定，刻意不比较首帧与末帧；若实测阈值过严，
 *     须在 artifact 记录实测分布后再调整，不得事后静默放宽——本文件因此把实测分布写入 artifact。
 *   - 3.P2 [det-machine]：以改动前近 7 天同渠道成片为负对照
 *     assert: D_mid_new >= 2 * p90(D_mid_control)
 *   - 3.P3 [visual-residue]：9 帧拼图 + 二值清单（留 QA 真人判定，本文件产出 artifact）
 *
 * QA 真机绑定项：
 *   - WVQA_PORTRAIT_MP4   重跑后的竖版成片路径（3.P1/3.P2/3.P3 的被测对象）
 *   - WVQA_CONTROL_DIR    重跑前冻结的对照成片目录（近 7 天历史成片，3.P2/3.P3 负对照）
 *
 * 假绿防护（harness 判别力自检，始终真跑，kill no-op mutation）：
 *   - 合成「慢速累积缩放」视频（伪循环同构）→ 必须通过 3.P1 判据（D_mid≥3 ∧ ratio≥2）
 *   - 合成「原地波动」视频（testsrc2）  → 必须被 ratio 判据拒绝（区分状态改变 vs 微动）
 *   - 合成「静止」视频                  → 必须被 D_mid 判据拒绝
 *   authoring 时实测：zoom=4.49 通过 / testsrc2 ratio=0.87 被拒 / static D_mid=0 被拒
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ARTIFACT_DIR = "/tmp/autopilot-artifacts";
const PORTRAIT_MP4 = process.env.WVQA_PORTRAIT_MP4 ?? "";
const CONTROL_DIR = process.env.WVQA_CONTROL_DIR ?? "";

function writeArtifact(id: string, content: string): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

// ---- 帧采样与度量（authoring 时已对合成样本校验，见文件头）----

const FRAME_W = 64;
const FRAME_H = 112;

function probeStream(file: string): {
  nbFrames: number;
  fps: number;
  width: number;
  height: number;
} {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=r_frame_rate,nb_frames,width,height",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 },
  );
  const st = (JSON.parse(out) as { streams: Array<Record<string, string>> }).streams[0];
  if (!st?.r_frame_rate) throw new Error(`ffprobe 未返回视频流: ${file}`);
  const [num, den] = st.r_frame_rate.split("/").map(Number);
  if (num === undefined || den === undefined || den === 0) {
    throw new Error(`ffprobe r_frame_rate 异常: ${st.r_frame_rate}`);
  }
  return {
    nbFrames: Number(st.nb_frames),
    fps: num / den,
    width: Number(st.width),
    height: Number(st.height),
  };
}

function grayFrameAt(file: string, t: number): Buffer {
  return execFileSync(
    "ffmpeg",
    [
      "-loglevel",
      "error",
      "-ss",
      t.toFixed(3),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale=${FRAME_W}:${FRAME_H}`,
      "-pix_fmt",
      "gray",
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
  );
}

/** 均匀采样 9 帧灰度（首帧=0，末帧=最后一个可解码帧；空帧回退重试） */
function sampleGrayFrames(file: string, n = 9): Buffer[] {
  const st = probeStream(file);
  const lastT = Math.max(0, (st.nbFrames - 1) / st.fps);
  const frames: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    let t = (lastT * i) / (n - 1);
    let buf = grayFrameAt(file, t);
    let tries = 0;
    while (buf.length < FRAME_W * FRAME_H && tries < 10) {
      tries++;
      t = Math.max(0, t - 0.05);
      buf = grayFrameAt(file, t);
    }
    if (buf.length < FRAME_W * FRAME_H) {
      throw new Error(`抽帧失败 @${t.toFixed(3)}s（${file}）`);
    }
    frames.push(buf);
  }
  return frames;
}

function mad(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length;
}

interface MotionMetrics {
  dMid: number;
  dAdj: number;
  ratio: number;
}

/** 3.P1 观测量：D_mid（首↔中）与 D_adj（相邻均值），刻意不比较首帧与末帧（设计逐字） */
function measureMotion(frames: Buffer[]): MotionMetrics {
  const mid = Math.floor(frames.length / 2);
  const f0 = frames[0];
  const fm = frames[mid];
  if (!f0 || !fm) throw new Error("帧数组为空，无法度量");
  const dMid = mad(f0, fm);
  let adjSum = 0;
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const cur = frames[i];
    if (!prev || !cur) throw new Error(`帧数组索引越界 i=${i}`);
    adjSum += mad(prev, cur);
  }
  const dAdj = adjSum / (frames.length - 1);
  return { dMid, dAdj, ratio: dAdj === 0 ? Number.POSITIVE_INFINITY : dMid / dAdj };
}

/** 3.P1 判据（谓词字面量）：D_mid >= 3.0 && D_mid / D_adj >= 2.0 */
function passesMotionPredicate(m: MotionMetrics): boolean {
  return m.dMid >= 3.0 && m.ratio >= 2.0;
}

/** 3.P2 分位数：离散 p90 = sorted[ceil(0.9*n)-1] */
function p90(values: number[]): number {
  expect(values.length, "对照组为空——负对照缺失即真红").toBeGreaterThan(0);
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.9 * sorted.length) - 1;
  const v = sorted[idx];
  if (v === undefined) throw new Error("p90 索引越界");
  return v;
}

// ---- QA 绑定评估 ----

const PORTRAIT_BOUND = PORTRAIT_MP4.trim().length > 0;
if (!PORTRAIT_BOUND) {
  writeArtifact(
    "场景3-跳过原因",
    "WVQA_PORTRAIT_MP4 未绑定——3.P1/3.P2/3.P3 需先真跑一次重跑并冻结近 7 天负对照" +
      "（WVQA_CONTROL_DIR）。对照集必须在重跑前冻结（COS key 同名覆盖会毁掉对照）。不得静默置 PASS。",
  );
  console.warn(
    "[motion-quality] WVQA_PORTRAIT_MP4 未绑定——场景 3 谓词 skip（留 artifact 场景3-跳过原因）",
  );
}
const dProduct = PORTRAIT_BOUND ? describe : describe.skip;

// ============================================================================
// 场景 3.P1 / 3.P2 / 3.P3：真实成片运动量
// ============================================================================

dProduct("场景 3.P1：成片呈累积型画面变化而非原地波动", () => {
  const product = path.resolve(PORTRAIT_MP4);
  let metrics: MotionMetrics;

  beforeAll(() => {
    expect(fs.existsSync(product), `竖版成片不存在: ${product}`).toBe(true);
    metrics = measureMotion(sampleGrayFrames(product));
  }, 120000);

  it("采样并度量 9 帧（实测分布写入 artifact，阈值调整须留痕）", () => {
    writeArtifact(
      "场景3.P1",
      JSON.stringify(
        {
          product,
          dMid: Number(metrics.dMid.toFixed(4)),
          dAdj: Number(metrics.dAdj.toFixed(4)),
          ratio: Number(metrics.ratio.toFixed(4)),
          thresholds: { dMidMin: 3.0, ratioMin: 2.0 },
          note: "阈值过严时须依实测分布调整并在报告记录，不得静默放宽",
        },
        null,
        2,
      ),
    );
    // 谓词字面量：D_mid >= 3.0 && D_mid / D_adj >= 2.0
    expect(metrics.dMid).toBeGreaterThanOrEqual(3.0);
    expect(metrics.ratio).toBeGreaterThanOrEqual(2.0);
  });

  it("3.P2 显著优于改动前近 7 天负对照：D_mid_new >= 2 * p90(D_mid_control)", () => {
    expect(CONTROL_DIR.trim(), "WVQA_CONTROL_DIR 未绑定——负对照必须先于重跑冻结（真红）").not.toBe(
      "",
    );
    expect(fs.existsSync(CONTROL_DIR), `对照目录不存在: ${CONTROL_DIR}`).toBe(true);
    const controls = fs
      .readdirSync(CONTROL_DIR)
      .filter((f) => /\.(mp4|mov)$/i.test(f))
      .sort();
    writeArtifact("场景3.P2-对照清单", controls.join("\n"));
    expect(controls.length, "对照目录无成片文件").toBeGreaterThan(0);
    const controlDMids = controls.map((f) => {
      const m = measureMotion(sampleGrayFrames(path.join(CONTROL_DIR, f)));
      return m.dMid;
    });
    const baseline = p90(controlDMids);
    writeArtifact(
      "场景3.P2",
      JSON.stringify(
        {
          controlCount: controls.length,
          controlDMids: controlDMids.map((v) => Number(v.toFixed(4))),
          p90Control: Number(baseline.toFixed(4)),
          dMidNew: Number(metrics.dMid.toFixed(4)),
          requiredMin: Number((2 * baseline).toFixed(4)),
        },
        null,
        2,
      ),
    );
    // 谓词字面量：D_mid_new >= 2 * p90(D_mid_control)
    expect(metrics.dMid).toBeGreaterThanOrEqual(2 * baseline);
  });

  it("3.P3 [visual-residue] 产出 9 帧 contact sheet + 二值清单 artifact（留 QA 真人判定）", () => {
    // VISUAL_RESIDUE: 留 QA 真机判定 —— 本用例自动化产出判定素材（9 帧拼图）与二值清单，
    // 「是/否」结论由 QA 依据清单填写后回填 artifact。
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wv-motion-sheet-"));
    try {
      const st = probeStream(product);
      const lastT = Math.max(0, (st.nbFrames - 1) / st.fps);
      for (let i = 0; i < 9; i++) {
        const t = (lastT * i) / 8;
        const png = path.join(tmpRoot, `f${String(i).padStart(2, "0")}.png`);
        execFileSync(
          "ffmpeg",
          [
            "-y",
            "-loglevel",
            "error",
            "-ss",
            t.toFixed(3),
            "-i",
            product,
            "-frames:v",
            "1",
            "-vf",
            "scale=180:320",
            png,
          ],
          { encoding: "utf-8", timeout: 60000 },
        );
      }
      const sheet = path.join(ARTIFACT_DIR, "场景3.P3-contact-sheet.png");
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-framerate",
          "1",
          "-i",
          path.join(tmpRoot, "f%02d.png"),
          "-vf",
          "tile=3x3",
          sheet,
        ],
        { encoding: "utf-8", timeout: 60000 },
      );
      const checklist = [
        "# 场景 3.P3 二值清单（visual-residue，QA 真人判定）",
        `被测成片: ${product}`,
        `拼图: ${sheet}（首帧↔末帧同锚定的伪循环，请观察中段帧与首帧的差异）`,
        "",
        "判定「是」= 存在可指认的累积变化（云移动/水波推进/光影迁移/主体位置变化/镜头推进）",
        "判定「否」= 仅有呼吸/眨眼/发丝级微动",
        "",
        "- [ ] 存在至少一处可指认的画面状态改变（是/否）：____",
      ].join("\n");
      writeArtifact("场景3.P3", checklist);
      expect(fs.existsSync(sheet), "contact sheet 未产出").toBe(true);
      expect(fs.statSync(sheet).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// harness 判别力自检（始终真跑）：kill 度量函数 no-op mutation
// ============================================================================

describe("harness 自检：帧差度量的判别力（合成正/负对照）", () => {
  let tmpRoot = "";

  const gen = (name: string, lavfi: string, extraVf = ""): string => {
    const out = path.join(tmpRoot, name);
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        lavfi,
        "-t",
        "6",
        ...(extraVf ? ["-vf", extraVf] : []),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "baseline",
        out,
      ],
      { encoding: "utf-8", timeout: 120000 },
    );
    return out;
  };

  it("ffmpeg/ffprobe 可用（仓内既定环境要求，缺失即真红）", () => {
    for (const bin of ["ffmpeg", "ffprobe"]) {
      const probe = spawnSync(bin, ["-version"], { encoding: "utf-8", timeout: 15000 });
      expect(probe.status, `${bin} 不可用——环境要求 ffmpeg ≥ 4.0`).toBe(0);
    }
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wv-motion-harness-"));
  });

  it("合成「慢速累积缩放」（伪循环同构）→ 通过 3.P1 判据（D_mid≥3 ∧ ratio≥2）", () => {
    const grad = path.join(tmpRoot, "grad.png");
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "gradients=size=184x400:c0=0xff8830:c1=0x3040ff:x0=20:y0=50:x1=160:y1=380",
        "-frames:v",
        "1",
        grad,
      ],
      { encoding: "utf-8", timeout: 60000 },
    );
    const zoom = path.join(tmpRoot, "zoom.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-loop",
        "1",
        "-i",
        grad,
        "-vf",
        "zoompan=z='min(zoom+0.002,1.6)':d=144:s=184x400:fps=24",
        "-frames:v",
        "144",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "baseline",
        zoom,
      ],
      { encoding: "utf-8", timeout: 120000 },
    );
    const m = measureMotion(sampleGrayFrames(zoom));
    writeArtifact(
      "harness-正控-zoom",
      JSON.stringify({ dMid: Number(m.dMid.toFixed(4)), ratio: Number(m.ratio.toFixed(4)) }),
    );
    expect(
      passesMotionPredicate(m),
      `累积变化合成样本必须通过判据（实测 ${JSON.stringify(m)}）`,
    ).toBe(true);
  });

  it("合成「原地波动」（testsrc2）→ ratio 判据拒绝（状态改变 vs 微动的区分力）", () => {
    const flicker = gen("flicker.mp4", "testsrc2=size=184x400:rate=24:duration=6");
    const m = measureMotion(sampleGrayFrames(flicker));
    writeArtifact(
      "harness-负控-flicker",
      JSON.stringify({ dMid: Number(m.dMid.toFixed(4)), ratio: Number(m.ratio.toFixed(4)) }),
    );
    // 原地波动样本 D_adj 与 D_mid 同量级 → ratio < 2.0 必被拒
    expect(m.ratio).toBeLessThan(2.0);
  });

  it("合成「静止」→ D_mid 判据拒绝（恒真探测器被排除）", () => {
    const still = gen("still.mp4", "color=c=0x808080:size=184x400:rate=24:duration=6");
    const m = measureMotion(sampleGrayFrames(still));
    expect(m.dMid).toBeLessThan(3.0);
    expect(passesMotionPredicate(m)).toBe(false);
  });
});

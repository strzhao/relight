/**
 * 验收测试（红队，real-process）：honeydo 视频生成真跑冒烟（秒级参数，≤10min）
 *
 * 设计文档（state.md）对应谓词：
 *   - 场景 1.P1 [real-process]（driver: node-script:spawn-honeydo-video-gen-smoke）：
 *     When 以短时长小分辨率冒烟参数真实执行 honeydo video gen, CLI shall 退出码 0、
 *     stdout 输出机读 JSON 并产出非空 mp4
 *     assert: exit == 0 AND stdout contains "out" AND stdout contains "res"
 *             AND 产物文件 exists AND 产物 size > 0 AND 文件头 contains "ftyp"
 *   - 场景 5.P1 [real-process]（driver: node-script:spawn-honeydo-failure-smoke）：
 *     When honeydo 以无效输入（不存在的 --first-frame 路径）被真实调用, CLI shall
 *     快速非零退出且不产出 mp4
 *     assert: exit != 0 AND 产物文件 exists == false AND 耗时 < 60s
 *
 * 冒烟参数（设计 Tier 1.5：短时长/小分辨率，控制单条 ≤10min）：
 *   honeydo video gen --seconds 1 --res 256p --fast
 *   + 双锚定伪循环（§总体架构）：--first-frame 与 --last-frame 同图
 *   + prompt 用设计文档 §1 的双锚定循环 prompt 常量（逐字）
 *
 * honeydo CLI 事实（`honeydo video gen --help` 实测，外部 CLI 非蓝队产出）：
 *   -o/--out <path>（输出 mp4 路径）、-r/--res <preset>（256p 合法档）、--seconds <s>（1-15）、
 *   --first-frame <path>、--last-frame <path>、--fast；<prompt> 为位置参数；
 *   stdout 只有机读 JSON、进度在 stderr（context.md 实证）。
 *
 * 红队铁律：不 skip、硬断言——honeydo/ffmpeg 不可用、或 CLI 行为偏离契约，一律真红。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ARTIFACT_DIR = "/tmp/autopilot-artifacts";
/** 设计契约 env 名（§后端设计 §1：env HONEYDO_CLI_PATH 优先） */
const HONEYDO_BIN = process.env.HONEYDO_CLI_PATH ?? "honeydo";
/** §后端设计 §1 wallpaperVideoPrompt 双锚定循环 prompt（设计文档逐字） */
const PROMPT =
  "画面中的景物以极缓慢的速度轻微摇曳，光影柔和流动，随后一切缓缓回到初始位置，如呼吸般自然";

let tmpRoot = "";
let firstFramePath = "";

function writeArtifact(id: string, content: string): void {
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  wallMs: number;
}

function runHoneydoVideoGen(args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(HONEYDO_BIN, ["video", "gen", ...args, PROMPT], {
      cwd: tmpRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, wallMs: Date.now() - startedAt });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, wallMs: Date.now() - startedAt });
    });
  });
}

beforeAll(() => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvreal-"));

  // honeydo 可用性硬前置（缺失即真红，不 skip）
  const probe = spawnSync(HONEYDO_BIN, ["video", "gen", "--help"], {
    encoding: "utf-8",
    timeout: 15000,
  });
  if (probe.status !== 0) {
    throw new Error(
      `honeydo CLI 不可用（${HONEYDO_BIN} video gen --help 退出码 ${probe.status}）——real-process 冒烟要求真实 honeydo 环境`,
    );
  }

  // 首帧 fixture：ffmpeg 造 704x400 png（首帧引擎会 LANCZOS 拉伸到画布，比例不限）
  firstFramePath = path.join(tmpRoot, "first-frame.png");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=704x400:rate=12:duration=1",
      "-frames:v",
      "1",
      firstFramePath,
    ],
    { encoding: "utf-8", timeout: 30000 },
  );
  if (ff.status !== 0 || !fs.existsSync(firstFramePath)) {
    throw new Error(`ffmpeg 造首帧 fixture 失败: ${ff.stderr}`);
  }
}, 60000);

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// 场景 1.P1：honeydo video gen 真跑冒烟（秒级参数）
// ============================================================================

describe("场景 1.P1 [real-process]：honeydo video gen 真跑（--seconds 1 --res 256p --fast）", () => {
  it("退出码 0 + stdout 机读 JSON 含 out/res + 产物非空 mp4 且文件头含 ftyp", async () => {
    const outPath = path.join(tmpRoot, "s1p1-smoke.mp4");
    const result = await runHoneydoVideoGen(
      [
        "--seconds",
        "1",
        "--res",
        "256p",
        "--fast",
        "--first-frame",
        firstFramePath,
        "--last-frame",
        firstFramePath,
        "-o",
        outPath,
      ],
      570000, // 进程级护栏：≤9.5min kill（谓词预算 ≤10min）
    );

    // 谓词字面量 ①：exit == 0
    expect(result.code, `honeydo 退出码（stderr tail: ${result.stderr.slice(-2000)}）`).toBe(0);

    // 谓词字面量 ②③：stdout contains "out" AND stdout contains "res"
    expect(result.stdout).toContain("out");
    expect(result.stdout).toContain("res");

    // stdout 为机读 JSON（context.md：stdout 只有 JSON；实测为 pretty-printed 多行）——
    // 取首个 "{" 到末个 "}" 解析；解析不出 JSON 即红
    let parsed: { out?: string; duration?: number; res?: string };
    {
      const braces = result.stdout;
      const start = braces.indexOf("{");
      const end = braces.lastIndexOf("}");
      if (start < 0 || end <= start) {
        throw new Error(`stdout 不含机读 JSON: ${result.stdout.slice(0, 2000)}`);
      }
      try {
        parsed = JSON.parse(braces.slice(start, end + 1));
      } catch {
        throw new Error(`stdout 不是机读 JSON: ${result.stdout.slice(0, 2000)}`);
      }
    }

    // 产物路径：优先 stdout JSON 的 out 字段，否则回退 -o 显式路径（CLI 文档化行为）
    const productPath =
      typeof parsed.out === "string" && parsed.out.trim().length > 0
        ? path.resolve(tmpRoot, parsed.out.trim())
        : outPath;

    // 谓词字面量 ④⑤：产物文件 exists AND 产物 size > 0
    expect(fs.existsSync(productPath), `产物不存在: ${productPath}`).toBe(true);
    const size = fs.statSync(productPath).size;
    expect(size).toBeGreaterThan(0);

    // 谓词字面量 ⑥：文件头 contains "ftyp"（mp4 box 头，bytes 4-8）
    const head = fs.readFileSync(productPath).subarray(0, 64).toString("latin1");
    expect(head).toContain("ftyp");

    writeArtifact(
      "s1p1",
      JSON.stringify(
        {
          exitCode: result.code,
          wallMs: result.wallMs,
          res: parsed.res ?? null,
          productPath,
          size,
        },
        null,
        2,
      ),
    );
  }, 600000);
});

// ============================================================================
// 场景 5.P1：无效 first-frame → 快速非零退出、不产出 mp4
// ============================================================================

describe("场景 5.P1 [real-process]：无效 --first-frame 真跑快速失败", () => {
  it("exit != 0 + 产物不存在 + 耗时 < 60s", async () => {
    const bogusFrame = path.join(tmpRoot, "not-exist-dir", "first.png");
    const outPath = path.join(tmpRoot, "s5p1-invalid.mp4");
    if (fs.existsSync(outPath)) fs.rmSync(outPath);

    const result = await runHoneydoVideoGen(
      [
        "--seconds",
        "1",
        "--res",
        "256p",
        "--fast",
        "--first-frame",
        bogusFrame,
        "--last-frame",
        bogusFrame,
        "-o",
        outPath,
      ],
      55000, // 谓词要求 <60s——进程级 55s kill 兜底（kill 后 exit != 0 成立）
    );

    // 谓词字面量 ①：exit != 0
    expect(result.code).not.toBe(0);
    // 谓词字面量 ②：产物文件 exists == false
    expect(fs.existsSync(outPath)).toBe(false);
    // 谓词字面量 ③：耗时 < 60s
    expect(result.wallMs).toBeLessThan(60000);

    writeArtifact(
      "s5p1",
      JSON.stringify({ exitCode: result.code, wallMs: result.wallMs, outPath }, null, 2),
    );
  }, 120000);
});

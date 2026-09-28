/**
 * 验收测试（红队）：竖版画布 704×1216 → 736×1600 + motionPrompt 拆分 —— 契约字面量与配置行为
 *
 * 设计文档（state.md §契约规约 C1-C10）对应验收点（本文件覆盖契约元素，谓词级断言见姊妹文件）：
 *   - C1 honeydo CLI：`lmedia video gen` 新增 `--width <px>` / `--height <px>`；
 *     非法（非 32 倍数）→ exit 2。R4 机器可读验证：dist 产物含 `--width`；
 *     `honeydo video gen … --width 700` → exit 2 且 stderr 含 `--width`（700=21.875×32 非法）。
 *   - C2 relight spawn：`HoneydoVideoOptions` 可选 `width?/height?`；`spawnHoneydoVideo`
 *     仅在传入时追加 `--width`/`--height`；单腿显式传画布（computeNativeCanvas 产出）。
 *   - C3 画布 SSOT（20260928 单腿原生改版）：`native-canvas.ts` 导出
 *     `computeNativeCanvas(origW, origH)` + `NATIVE_CANVAS_PIXEL_BUDGET = 1177600` +
 *     `NATIVE_CANVAS_MIN_SHORT = 704`；固定画布常量
 *     `WALLPAPER_VIDEO_LANDSCAPE_CANVAS` / `WALLPAPER_VIDEO_PORTRAIT_CANVAS` 必须从
 *     backend src 全部清除（R3 假绿陷阱：旧字面量 704×1216 不再作为现行画布）。
 *   - C4 Remotion composition：`calculateMetadata` 从 props `canvasWidth/canvasHeight`
 *     动态返回 width/height（尺寸参数化）；props 契约（20260928 契约 7 纯超集扩展）
 *     {videoPath,pickDate,title,narrative,captureDateline,canvasWidth,canvasHeight}。
 *   - C5 DB 列：`daily_picks.motion_prompt` 列名与语义不变，不新增列。
 *   - C7 prompt 目录：`v2/daily/motion-facts/{system,user}.txt` 与 `v2/daily/motion/{system,user}.txt`。
 *   - C8 配置：`config.ai.motionBaseUrl/motionApiKey/motionModel`（env `AI_MOTION_BASE_URL/
 *     AI_MOTION_API_KEY/AI_MOTION_MODEL`），默认指向 deepseek 接入点；凭据值不入仓库。
 *   - C9 narrate 契约收窄：`dailyNarrateResponseSchema` 移除 motionPrompt；narrate system.txt
 *     移除 motionPrompt 创作准则与 JSON 契约键。
 *   - C10 运动准则来源：motion/system.txt 逐字承载「## motionPrompt 创作准则」整段
 *     （含 `Audio: ` 短语与 `no talking` 收尾的原口径锚点）。
 *
 * 红队铁律：本文件仅依据设计文档编写；对实现侧只做文本级 grep 断言（det-machine，
 * 惯例同 wallpaper-video-contract-literals.acceptance.test.ts）与 import 黑盒执行，
 * 不解析、不阅读实现逻辑。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/__tests__ → 仓库根：src(1) apps/backend(2) apps(3) relight(4)
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const BACKEND_SRC = path.join(REPO_ROOT, "apps/backend/src");
const HONEYDO_ROOT = path.join(os.homedir(), "workspace/honeydo");
const OVERLAY_DIR = path.join(
  REPO_ROOT,
  ".autopilot/runtime/requirements/20260725-每日视频生成/video-dryrun/wallpaper-overlay",
);
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

/** 读文本文件；不存在即硬失败（红队铁律：缺文件即真红） */
function readText(absPath: string, what: string): string {
  if (!fs.existsSync(absPath)) {
    throw new Error(`${what} 不存在：${absPath}（红队铁律：缺文件即真红）`);
  }
  return fs.readFileSync(absPath, "utf-8").replace(/\r\n/g, "\n");
}

/** 递归收集目录下全部 .ts/.tsx 文本（跳过 __tests__ 与 .d.ts） */
function collectCorpus(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(p);
      } else if (/\.(tsx?|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n"));
      }
    }
  };
  walk(dir);
  return out.join("\n");
}

/** 截取从 anchor 首次出现开始的 region 字符 */
function regionFrom(source: string, anchor: RegExp, chars: number): string {
  const m = anchor.exec(source);
  if (!m || m.index == null) return "";
  return source.slice(m.index, m.index + chars);
}

function writeArtifact(id: string, content: string): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

// ============================================================================
// C1：honeydo CLI --width/--height 透传 + 非法倍数 exit 2（真子进程探针）
// ============================================================================

const HONEYDO_BIN = process.env.HONEYDO_CLI_PATH ?? "honeydo";
const HONEYDO_ROOT_PRESENT = fs.existsSync(path.join(HONEYDO_ROOT, "package.json"));
const lmediaDist = path.join(HONEYDO_ROOT, "packages/lmedia/dist/index.js");

// [2026-09-25] CI 相容门控（惯例同 wallpaper-video-realprocess）：honeydo 仅开发机可用。
// skip 在报告可见并留 artifact；本机装 honeydo 即自动恢复真跑。
if (!HONEYDO_ROOT_PRESENT) {
  writeArtifact(
    "场景C1-跳过原因",
    "honeydo 仓库不在本机（~/workspace/honeydo 缺失）——C1 真子进程探针 skip；本机可用时自动真跑",
  );
  console.warn("[canvas-contract] honeydo 仓库不可达——C1 探针 skip（留 artifact 场景C1-跳过原因）");
}
const dHoneydo = HONEYDO_ROOT_PRESENT ? describe : describe.skip;

dHoneydo("C1：honeydo CLI 透传 --width/--height（R4 机器可读验证）", () => {
  it("lmedia dist 构建产物含 --width 与 --height 字面量（跨仓构建已同步）", () => {
    // R4：不重建则 relight 跑旧 dist——dist 内容是跨仓同步的权威信号
    const dist = readText(lmediaDist, "lmedia dist 构建产物");
    expect(dist).toContain("--width");
    expect(dist).toContain("--height");
    writeArtifact(
      "场景C1-dist-grep",
      `lmedia dist 含 --width/--height；mtime=${fs.statSync(lmediaDist).mtime.toISOString()}`,
    );
  });

  it("非法倍数 --width 700（非 32 的倍数）→ exit 2 且 stderr 含 --width（不真正生成）", async () => {
    const tmpOut = path.join(os.tmpdir(), `wv-c1-invalid-${Date.now()}.mp4`);
    const res = spawnSync(
      HONEYDO_BIN,
      [
        "video",
        "gen",
        "--seconds",
        "1",
        "--res",
        "256p",
        "--fast",
        "--width",
        "700",
        "-o",
        tmpOut,
        "冒烟",
      ],
      { encoding: "utf-8", timeout: 60000 },
    );
    const stderr = `${res.stderr ?? ""}\n${res.stdout ?? ""}`;
    writeArtifact(
      "场景C1-非法倍数探针",
      JSON.stringify({ status: res.status, stderr: stderr.slice(0, 4000) }, null, 2),
    );
    // 契约 C1 逐字：非法 → console.error + exit 2
    expect(res.status, `期望 exit 2（stderr: ${stderr.slice(0, 800)}）`).toBe(2);
    expect(stderr.toLowerCase()).toContain("--width");
    expect(fs.existsSync(tmpOut)).toBe(false);
  }, 90000);
});

// ============================================================================
// C2/C3：relight spawn 契约字面量 + 旧画布字面量清除（R3 假绿陷阱）
// ============================================================================

describe("C2/C3：relight 侧画布 SSOT（native-canvas.ts）与 spawn 契约字面量", () => {
  const corpus = collectCorpus(BACKEND_SRC);
  const nativeCanvasSrc = readText(
    path.join(BACKEND_SRC, "lib/wallpaper/native-canvas.ts"),
    "lib/wallpaper/native-canvas.ts",
  );

  it("含画布 SSOT computeNativeCanvas 导出（尺寸计算入口，场景谓词实现绑定）", () => {
    expect(nativeCanvasSrc).toMatch(/export\s+function\s+computeNativeCanvas/);
    expect(nativeCanvasSrc).toMatch(/origW:\s*number/);
    expect(nativeCanvasSrc).toMatch(/origH:\s*number/);
  });

  it("像素预算 BUDGET=1177600 与短轴下限 MIN_SHORT=704 落在 native-canvas.ts（SSOT 逐字）", () => {
    expect(nativeCanvasSrc).toMatch(/NATIVE_CANVAS_PIXEL_BUDGET\s*=\s*1_177_600/);
    expect(nativeCanvasSrc).toMatch(/NATIVE_CANVAS_MIN_SHORT\s*=\s*704/);
    // 比例 clamp 上界 2.40（design D1 逐字）
    expect(nativeCanvasSrc).toMatch(/NATIVE_CANVAS_MAX_RATIO\s*=\s*2\.4/);
  });

  it("固定画布常量已删除（R3 假绿陷阱：20260928 单腿原生，横竖两档画布不再是现行契约）", () => {
    expect(corpus, "WALLPAPER_VIDEO_LANDSCAPE_CANVAS 残留").not.toMatch(
      /WALLPAPER_VIDEO_LANDSCAPE_CANVAS/,
    );
    expect(corpus, "WALLPAPER_VIDEO_PORTRAIT_CANVAS 残留").not.toMatch(
      /WALLPAPER_VIDEO_PORTRAIT_CANVAS/,
    );
    expect(corpus, "WALLPAPER_VIDEO_PORTRAIT_RES 残留").not.toMatch(/WALLPAPER_VIDEO_PORTRAIT_RES/);
  });

  it("旧画布字面量 704×1216 不再被表述为现行画布（R3：实现注释也必须手改）", () => {
    // R3 假绿陷阱的字面量面：只打击「把旧画布当现行」的表述——
    // 行内仅出现旧值（704+1216）= 陈旧声明，红。
    const staleLines: string[] = [];
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          walk(p);
        } else if (/\.(tsx?|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
          const src = fs.readFileSync(p, "utf-8");
          src.split("\n").forEach((line, i) => {
            const mentionsOld = line.includes("704") && line.includes("1216");
            if (mentionsOld) {
              staleLines.push(`${path.relative(REPO_ROOT, p)}:${i + 1}: ${line.trim()}`);
            }
          });
        }
      }
    };
    walk(BACKEND_SRC);
    writeArtifact("场景C3-旧字面量扫描", staleLines.join("\n") || "(无残留)");
    expect(staleLines, `旧竖版画布字面量残留：\n${staleLines.join("\n")}`).toHaveLength(0);
  });

  it("job 层从 native-canvas 引入画布 SSOT（computeNativeCanvas import 锚定）", () => {
    const job = readText(
      path.join(BACKEND_SRC, "jobs/wallpaper-video.ts"),
      "jobs/wallpaper-video.ts",
    );
    expect(job).toMatch(/computeNativeCanvas/);
    expect(job).toMatch(/native-canvas/);
  });

  it("spawn 侧含 --width/--height args 追加与 HoneydoVideoOptions 可选 width?/height?", () => {
    // C2 逐字：HoneydoVideoOptions 可选 width?/height?
    expect(corpus).toMatch(/HoneydoVideoOptions/);
    const typeBlock = regionFrom(corpus, /HoneydoVideoOptions/, 1600);
    expect(typeBlock, "HoneydoVideoOptions 未声明可选 width?").toMatch(/width\?/);
    expect(typeBlock, "HoneydoVideoOptions 未声明可选 height?").toMatch(/height\?/);
    // C2 逐字：spawnHoneydoVideo 仅在传入时向 args 追加 --width/--height
    expect(corpus).toMatch(/spawnHoneydoVideo/);
    expect(corpus).toContain("--width");
    expect(corpus).toContain("--height");
  });
});

// overlay 工程在 .autopilot/runtime/ 下（不入库）——CI 无此目录，capability-gate 惯例同前
const OVERLAY_PRESENT = fs.existsSync(OVERLAY_DIR);
if (!OVERLAY_PRESENT) {
  console.warn(
    "[canvas-contract] wallpaper-overlay 工程不在本机（runtime/ 不入库）——C4 断言跳过，实现侧锚定已生效",
  );
}
const dOverlay = OVERLAY_PRESENT ? describe : describe.skip;

dOverlay("C4：Remotion comp 尺寸参数化（calculateMetadata + props 画布契约）", () => {
  const overlayCorpus = (() => {
    // describe.skip 仍会执行本收集回调——目录缺失（CI）时直接返回空 corpus 防 ENOENT
    // （2026-09-26 CI 实证：探针 WARN 打了，readdirSync 照样崩）
    if (!OVERLAY_PRESENT) return "";
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "out") continue;
          walk(p);
        } else if (/\.(tsx?|jsx?|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
          out.push(fs.readFileSync(p, "utf-8"));
        }
      }
    };
    walk(OVERLAY_DIR);
    return out.join("\n");
  })();

  it("两个 comp id 存在且挂 calculateMetadata（尺寸参数化，kill 写死）", () => {
    expect(overlayCorpus).toMatch(/wallpaper-overlay-landscape/);
    expect(overlayCorpus).toMatch(/wallpaper-overlay-portrait/);
    expect(overlayCorpus).toMatch(/calculateMetadata/);
    expect(overlayCorpus).toMatch(/canvasWidth/);
    expect(overlayCorpus).toMatch(/canvasHeight/);
    // 旧固定档清除：comp 声明不再含历史画布字面量
    expect(overlayCorpus).not.toMatch(/1216/);
  });

  it("props 契约七字段逐字（20260928 契约 7 纯超集扩展）", () => {
    for (const prop of [
      "videoPath",
      "pickDate",
      "title",
      "narrative",
      "captureDateline",
      "canvasWidth",
      "canvasHeight",
    ]) {
      expect(overlayCorpus, `overlay 工程缺 props 字段 ${prop}`).toContain(prop);
    }
  });

  it("布局分支按 props 画布比例判定（≥0.9 两栏横版 / <0.9 竖版全屏）", () => {
    expect(overlayCorpus).toMatch(/0\.9/);
  });
});

// ============================================================================
// C5：daily_picks.motion_prompt 列名与语义不变（不新增列）
// ============================================================================

describe("C5：daily_picks.motion_prompt 列契约不变", () => {
  it("db/schema.ts 含 motion_prompt 列且仍归属 daily_picks 表块", () => {
    const schema = readText(path.join(BACKEND_SRC, "db/schema.ts"), "db/schema.ts");
    expect(schema).toContain("motion_prompt");
    const picksBlock = regionFrom(schema, /export\s+const\s+dailyPicks\s*=/, 2200);
    expect(picksBlock, "motion_prompt 列未落在 dailyPicks 表定义块内").toContain("motion_prompt");
  });

  it("dailyNarrateResponseSchema 定义块不再含 motionPrompt 字段（C9 契约收窄）", () => {
    const corpus = collectCorpus(BACKEND_SRC);
    const m = /dailyNarrateResponseSchema/.exec(corpus);
    expect(m, "backend src 未找到 dailyNarrateResponseSchema").not.toBeNull();
    // 取 schema 定义块（z.object 到收尾 `});`）
    const block = corpus.slice(m!.index, corpus.indexOf("});", m!.index) + 3);
    expect(block, "dailyNarrateResponseSchema 定义块内不得再含 motionPrompt 字段").not.toContain(
      "motionPrompt",
    );
  });
});

// ============================================================================
// C7/C9/C10：prompt 目录与准则搬移契约
// ============================================================================

describe("C7/C9/C10：motion prompt 目录与准则逐字搬移", () => {
  const promptsDir = path.join(BACKEND_SRC, "ai/prompts/v2/daily");

  it("C7：motion-facts/{system,user}.txt 与 motion/{system,user}.txt 四件套存在", () => {
    for (const rel of [
      "motion-facts/system.txt",
      "motion-facts/user.txt",
      "motion/system.txt",
      "motion/user.txt",
    ]) {
      expect(fs.existsSync(path.join(promptsDir, rel)), `缺 prompt 文件 ${rel}`).toBe(true);
    }
  });

  it("C10：motion/system.txt 承载「## motionPrompt 创作准则」整段 + Audio/no talking 原口径锚点", () => {
    const motion = readText(path.join(promptsDir, "motion/system.txt"), "motion/system.txt");
    expect(motion).toContain("## motionPrompt 创作准则");
    expect(motion).toContain("Audio");
    expect(motion).toContain("no talking");
    writeArtifact(
      "场景C10-准则锚点",
      `motion/system.txt 字节数=${Buffer.byteLength(motion)}；含准则标题/Audio/no talking 锚点`,
    );
  });

  it("C9：narrate/system.txt 不再含 motionPrompt（创作准则与 JSON 契约键已移除）", () => {
    const narrate = readText(path.join(promptsDir, "narrate/system.txt"), "narrate/system.txt");
    expect(narrate, "narrate/system.txt 仍含 motionPrompt——双写来源违反 C9").not.toContain(
      "motionPrompt",
    );
  });
});

// ============================================================================
// C8：config.ai motion* 三键（行为面黑盒 + 凭据不入仓库）
// ============================================================================

vi.mock("dotenv/config", () => ({}));

async function loadMotionConfig(): Promise<Record<string, unknown>> {
  const mod = (await import("../lib/config")) as {
    config: { ai: Record<string, unknown> };
  };
  return mod.config.ai;
}

describe("C8：config.ai motionBaseUrl/motionApiKey/motionModel", () => {
  afterEach(() => {
    vi.resetModules();
    process.env.AI_MOTION_BASE_URL = undefined;
    process.env.AI_MOTION_API_KEY = undefined;
    process.env.AI_MOTION_MODEL = undefined;
  });

  it("默认指向 deepseek 接入点（非本地 qwen），凭据默认为空", async () => {
    vi.resetModules();
    const ai = await loadMotionConfig();
    expect(ai).toHaveProperty("motionBaseUrl");
    expect(ai).toHaveProperty("motionApiKey");
    expect(ai).toHaveProperty("motionModel");
    const base = String(ai.motionBaseUrl ?? "");
    const model = String(ai.motionModel ?? "");
    writeArtifact("场景C8-默认值", JSON.stringify({ base, model, hasKey: !!ai.motionApiKey }));
    // 设计 R7：deepseek 接入点 = api.deepseek.com（OpenAI 兼容）；不得默认指向本地 qwen :8001
    expect(base).toMatch(/deepseek/i);
    expect(base.startsWith("http://127.0.0.1:8001")).toBe(false);
    expect(model).toMatch(/deepseek/i);
    // C8 逐字：凭据值不写入仓库，只经 env 注入 → 默认必须为空
    expect(String(ai.motionApiKey ?? "")).toBe("");
  });

  it("env AI_MOTION_BASE_URL / AI_MOTION_API_KEY / AI_MOTION_MODEL 注入生效", async () => {
    process.env.AI_MOTION_BASE_URL = "https://api.deepseek.com/v1";
    process.env.AI_MOTION_API_KEY = "test-key-from-env";
    process.env.AI_MOTION_MODEL = "deepseek-chat";
    vi.resetModules();
    const ai = await loadMotionConfig();
    expect(ai.motionBaseUrl).toBe("https://api.deepseek.com/v1");
    expect(ai.motionApiKey).toBe("test-key-from-env");
    expect(ai.motionModel).toBe("deepseek-chat");
  });

  it("config.ts 无硬编码凭据形态字面量（sk- 开头长 token）", () => {
    const configSrc = readText(path.join(BACKEND_SRC, "lib/config.ts"), "lib/config.ts");
    const secretShaped = configSrc.match(/sk-[A-Za-z0-9]{20,}/g) ?? [];
    expect(secretShaped, `config.ts 疑似硬编码凭据：${secretShaped.join(",")}`).toHaveLength(0);
  });
});

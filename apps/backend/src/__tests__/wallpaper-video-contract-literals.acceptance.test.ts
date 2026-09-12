/**
 * 验收测试（红队）：动态视频壁纸 — 跨系统契约字面量（规则 6：三方逐字一致）
 * + 配置默认关（场景 4.P1）+ 队列注册 attempts 奎约
 *
 * 设计文档（state.md）对应谓词与契约：
 *   - 场景 4.P1 [det-machine]（driver: fs-grep:backend-config-default）：
 *     后端以默认配置启动 → 配置层报告视频功能关闭（解析值 ∈ {false, "off", 0, "disabled"}）
 *     契约表达式（§后端设计 §1 逐字）：(env DAILY_WALLPAPER_VIDEO ?? "false") === "true"
 *   - 规则 6（跨系统数据流）：manifest 字段名 ↔ 画廊消费字段名 ↔ API 字段名三方逐字一致
 *     wallpaperVideoLandscape / wallpaperVideoPortrait / wallpaperVideoUrl
 *     —— 用 fs 读设计文档契约 + 各系统源码文本做字面量断言（不读实现逻辑，只读文本做
 *        字符串断言，惯例同 daily-video-url.acceptance.test.ts）
 *   - §后端设计 §4 逐字：wallpaperVideoQueue 显式 defaultJobOptions: { attempts: 1 }
 *     （覆盖全局 attempts:3 —— 单条 spawn 90min 级，失败重试会连环占串行 Worker）
 *   - §契约规约 COS key 逐字：{prefix}/wallpaper-videos/{pickDate}_landscape.mov /
 *     {pickDate}_portrait.mp4；contentType：video/quicktime / video/mp4
 *
 * 红队铁律：本文件仅依据设计文档编写；对蓝队产出文件只做文本级 grep 断言（det-machine），
 *   不解析、不 import 其实现逻辑（config 行为面测试除外——import 是黑盒执行，非阅读）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/__tests__ → 仓库根：src(1) apps/backend(2) apps(3) relight(4)
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const BACKEND_SRC = path.join(REPO_ROOT, "apps/backend/src");
const DESIGN_DOC = path.join(
  REPO_ROOT,
  ".autopilot/runtime/requirements/20260912-开始实现动态视频壁纸/state.md",
);

/** 读文本文件；不存在即硬失败（红队铁律：不静默跳过） */
function readText(absPath: string, what: string): string {
  if (!fs.existsSync(absPath)) {
    throw new Error(`${what} 不存在：${absPath}（红队铁律：缺文件即真红）`);
  }
  return fs.readFileSync(absPath, "utf-8").replace(/\r\n/g, "\n");
}

/** 截取从 anchor 首次出现开始的 region 字符 */
function regionFrom(source: string, anchor: RegExp, chars: number): string {
  const m = anchor.exec(source);
  if (!m || m.index == null) return "";
  return source.slice(m.index, m.index + chars);
}

// ============================================================================
// 契约字面量（§契约规约 / §后端设计 逐字）
// ============================================================================

// 三方字段名（规则 6 的三方：manifest 产出 ↔ 画廊消费 ↔ API 暴露）
const MANIFEST_FIELD_LANDSCAPE = "wallpaperVideoLandscape";
const MANIFEST_FIELD_PORTRAIT = "wallpaperVideoPortrait";
const GALLERY_CONSUMED_PORTRAIT = "wallpaperVideoPortrait";
const API_FIELD_URL = "wallpaperVideoUrl";
// DB 列名（snake_case，§后端设计 §2 逐字）
const DB_COL_LANDSCAPE = "wallpaper_video_landscape_url";
const DB_COL_PORTRAIT = "wallpaper_video_portrait_url";
// COS key / contentType（§契约规约 逐字）
const COS_KEY_DIR = "wallpaper-videos/";
const COS_KEY_LANDSCAPE_SUFFIX = "_landscape.mov";
const COS_KEY_PORTRAIT_SUFFIX = "_portrait.mp4";
const CONTENT_TYPE_LANDSCAPE = "video/quicktime";
const CONTENT_TYPE_PORTRAIT = "video/mp4";
// 开关（§后端设计 §1 逐字）
const ENV_NAME = "DAILY_WALLPAPER_VIDEO";
// Mac 侧标记（§Mac App 设计 §5 / 场景 6.P2 逐字）
const FALLBACK_MARKER = "aerial-fallback";

// ============================================================================
// 场景 4.P1 — 配置默认关（行为面 + fs-grep 面，driver: fs-grep:backend-config-default)
// ============================================================================

// 行为面：mock 掉 dotenv（隔离仓库 .env 污染），动态 import 真实 config 做黑盒断言。
// import 执行 ≠ 阅读实现——红队只断言设计契约规定的对外行为。
vi.mock("dotenv/config", () => ({}));

async function loadConfigWithEnv(envValue: string | undefined): Promise<unknown> {
  const had = Object.prototype.hasOwnProperty.call(process.env, ENV_NAME);
  const prev = process.env[ENV_NAME];
  try {
    if (envValue === undefined) {
      delete process.env[ENV_NAME];
    } else {
      process.env[ENV_NAME] = envValue;
    }
    vi.resetModules();
    const mod = (await import("../lib/config")) as {
      config: { wallpaperVideoEnabled: unknown };
    };
    return mod.config.wallpaperVideoEnabled;
  } finally {
    if (had) {
      process.env[ENV_NAME] = prev;
    } else {
      delete process.env[ENV_NAME];
    }
  }
}

describe("场景 4.P1：配置层默认报告视频功能为关闭", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("行为面：未设 DAILY_WALLPAPER_VIDEO（默认配置启动）→ wallpaperVideoEnabled === false", async () => {
    const enabled = await loadConfigWithEnv(undefined);
    // 契约：解析值 ∈ {false, "off", 0, "disabled"} —— 本设计逐字为 (env ?? "false") === "true"
    expect(enabled).toBe(false);
  });

  it("行为面：DAILY_WALLPAPER_VIDEO=true → true；'1' / 'TRUE' → false（严格 === \"true\" 语义）", async () => {
    expect(await loadConfigWithEnv("true")).toBe(true);
    expect(await loadConfigWithEnv("1")).toBe(false);
    expect(await loadConfigWithEnv("TRUE")).toBe(false);
  });

  it('fs 面：config.ts 内 DAILY_WALLPAPER_VIDEO 的默认值必须落在 "false"（缺省语义逐字）', () => {
    const src = readText(path.join(BACKEND_SRC, "lib/config.ts"), "lib/config.ts");
    // wallpaperVideoEnabled 字段必须声明
    expect(src).toMatch(/wallpaperVideoEnabled/);
    // 取所有引用该 env 的行做逐行断言（容忍 helper 变量等排版差异，语义不放宽）
    const envLines = src.split("\n").filter((l) => l.includes(ENV_NAME));
    expect(envLines.length, "config.ts 未引用 DAILY_WALLPAPER_VIDEO").toBeGreaterThan(0);
    // 契约逐字：(env DAILY_WALLPAPER_VIDEO ?? "false") —— 默认必须落在 "false"
    expect(
      envLines.some((l) => /\?\?\s*"false"/.test(l)),
      `DAILY_WALLPAPER_VIDEO 默认值未落在 "false"：\n${envLines.join("\n")}`,
    ).toBe(true);
    // No-op mutation kill：默认改成 "true" / "1" 时即红
    expect(envLines.some((l) => /\?\?\s*"true"/.test(l) || /\?\?\s*"1"/.test(l))).toBe(false);
    // 比较语义必须严格 === "true"
    expect(src).toMatch(/===\s*"true"/);
  });
});

// ============================================================================
// 队列注册契约：wallpaperVideoQueue 显式 attempts: 1
// ============================================================================

describe("队列注册契约：wallpaperVideoQueue 显式 defaultJobOptions { attempts: 1 }", () => {
  it("queues.ts 的 wallpaperVideoQueue 注册块内含 attempts: 1（不继承全局 attempts: 3）", () => {
    const src = readText(path.join(BACKEND_SRC, "jobs/queues.ts"), "jobs/queues.ts");
    const block = regionFrom(src, /export\s+const\s+wallpaperVideoQueue/, 800);
    expect(block, "queues.ts 未注册 wallpaperVideoQueue").not.toBe("");
    expect(block).toContain("wallpaperVideoQueue");
    // §后端设计 §4 逐字：显式 defaultJobOptions: { attempts: 1 }
    expect(block).toMatch(/defaultJobOptions\s*:\s*\{[\s\S]*?attempts\s*:\s*1/);
    // 全局默认仍是 attempts: 3（新队列必须显式覆盖，而非改动全局默认殃及他人）
    expect(src).toMatch(/attempts\s*:\s*3/);
  });
});

// ============================================================================
// COS key / contentType / DB 列 契约字面量
// ============================================================================

describe("COS key 与 contentType 契约字面量（§契约规约 逐字）", () => {
  it("manifest.ts 含 wallpaper-videos/ 目录与 _landscape.mov / _portrait.mp4 key 字面量", () => {
    const src = readText(
      path.join(BACKEND_SRC, "lib/gallery/manifest.ts"),
      "lib/gallery/manifest.ts",
    );
    expect(src).toContain(COS_KEY_DIR);
    expect(src).toContain(COS_KEY_LANDSCAPE_SUFFIX);
    expect(src).toContain(COS_KEY_PORTRAIT_SUFFIX);
  });

  it("contentType 字面量 video/quicktime 与 video/mp4 存在于 job/视频库/manifest 之一", () => {
    const candidates = [
      path.join(BACKEND_SRC, "jobs/wallpaper-video.ts"),
      path.join(BACKEND_SRC, "lib/wallpaper/video.ts"),
      path.join(BACKEND_SRC, "lib/gallery/manifest.ts"),
    ];
    const corpus = candidates
      .filter((f) => fs.existsSync(f))
      .map((f) => readText(f, f))
      .join("\n");
    expect(corpus).toContain(CONTENT_TYPE_LANDSCAPE);
    expect(corpus).toContain(CONTENT_TYPE_PORTRAIT);
  });

  it("schema.ts 含两列 snake_case 列名（nullable TEXT 语义由列名锚定）", () => {
    const src = readText(path.join(BACKEND_SRC, "db/schema.ts"), "db/schema.ts");
    expect(src).toContain(DB_COL_LANDSCAPE);
    expect(src).toContain(DB_COL_PORTRAIT);
  });
});

// ============================================================================
// 规则 6：manifest 字段名 ↔ 画廊消费字段名 ↔ API 字段名 三方逐字一致
// ============================================================================

describe("规则 6：三方字段名逐字一致（manifest ↔ 画廊 ↔ API）", () => {
  it("manifest 产出侧（lib/gallery/manifest.ts）含 wallpaperVideoLandscape / wallpaperVideoPortrait 两个逐字字段名", () => {
    const src = readText(path.join(BACKEND_SRC, "lib/gallery/manifest.ts"), "manifest.ts");
    expect(src).toContain(MANIFEST_FIELD_LANDSCAPE);
    expect(src).toContain(MANIFEST_FIELD_PORTRAIT);
  });

  it("画廊消费侧（apps/gallery/app.js）消费的字段名与 manifest 产出侧逐字相同（wallpaperVideoPortrait）", () => {
    const src = readText(path.join(REPO_ROOT, "apps/gallery/app.js"), "apps/gallery/app.js");
    expect(src).toContain(GALLERY_CONSUMED_PORTRAIT);
    // 逐字一致（同源字面量比较——名称漂移在此即红）
    expect(GALLERY_CONSUMED_PORTRAIT).toBe(MANIFEST_FIELD_PORTRAIT);
  });

  it("API 侧（routes/daily.ts）含 wallpaperVideoUrl 字段名与 wallpaper-video 路由字面量", () => {
    const src = readText(path.join(BACKEND_SRC, "routes/daily.ts"), "routes/daily.ts");
    expect(src).toContain(API_FIELD_URL);
    expect(src).toContain("wallpaper-video");
  });

  it("设计文档（SSOT）同时声明三方字段名，实现侧 token 均可溯源到 SSOT", () => {
    const doc = readText(DESIGN_DOC, "state.md（设计文档）");
    for (const token of [
      MANIFEST_FIELD_LANDSCAPE,
      MANIFEST_FIELD_PORTRAIT,
      API_FIELD_URL,
      DB_COL_LANDSCAPE,
      DB_COL_PORTRAIT,
      ENV_NAME,
      FALLBACK_MARKER,
    ]) {
      expect(doc, `设计文档应声明 ${token}`).toContain(token);
    }
  });
});

// ============================================================================
// 设计文档 SSOT 契约字面量冻结（state.md §契约规约 关键字面量不得漂移）
// ============================================================================

describe("设计文档 SSOT 字面量冻结（场景谓词 assert 字段取值的出处）", () => {
  it("state.md 含 hvc1 / 1920×1080 / 704×1216 / video/quicktime / video/mp4 / attempts: 1 / wallpaper-videos key 字面量", () => {
    const doc = readText(DESIGN_DOC, "state.md（设计文档）");
    expect(doc).toContain("hvc1");
    expect(doc).toContain("1920×1080");
    expect(doc).toContain("704×1216");
    expect(doc).toContain(CONTENT_TYPE_LANDSCAPE);
    expect(doc).toContain(CONTENT_TYPE_PORTRAIT);
    expect(doc).toContain("attempts: 1");
    expect(doc).toContain(`${COS_KEY_DIR}{pickDate}${COS_KEY_LANDSCAPE_SUFFIX}`);
    expect(doc).toContain(`${COS_KEY_DIR}{pickDate}${COS_KEY_PORTRAIT_SUFFIX}`);
    expect(doc).toContain(FALLBACK_MARKER);
    expect(doc).toContain("aerialNotSelected");
  });
});

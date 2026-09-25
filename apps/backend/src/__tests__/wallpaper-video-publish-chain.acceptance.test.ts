/**
 * 验收测试（红队，real-process）：重跑产物发布链路端到端闭合（场景 4 / 1.P5 / 7.P2 的网络面）
 *
 * 设计文档（state.md）对应谓词：
 *   - 1.P5 [real-process]：对画廊实际托管的该日竖版视频地址发起一次真实请求
 *     assert: status in {200,206} && content_type contains "video" && ffprobe_duration_sec > 1
 *   - 4.P1 [real-process]：重跑并同步完成后，画廊暴露该日竖版视频引用且可拉取
 *     assert: portrait_field exists && field_value contains "/wallpaper-videos/" && video_http_status == 200
 *     driver: curl manifest.json 与视频地址
 *   - 4.P4 [det-machine]：本次重跑生成完成后，新产物比壁纸视频生成链路源码更新
 *     assert: stdout == "FRESH" && exit == 0
 *     driver: freshness 新竖版产物路径 vs 壁纸视频生成链路源码目录（mtime 对比实现）
 *   - 7.P2 [real-process]：视频生成失败当日，画廊回退为静态壁纸卡且静态资源可访问
 *     assert: video_field_absent==true && static_field_exists==true && static_http_status==200
 *
 * QA 真机绑定项（绑定缺失留 artifact + 可见 skip；绑定存在但断言失败一律真红）：
 *   - WVQA_GALLERY_BASE        画廊公网基址（如 https://gallery.stringzhao.life）
 *   - WVQA_MANIFEST_URL        manifest.json 公网地址（缺省 = GALLERY_BASE + /manifest.json）
 *   - WVQA_MANIFEST_JSON       或已落盘的 manifest 本地路径（二选一）
 *   - WVQA_PICK_DATE           被评估日（缺省取 manifest 内最新有竖版视频的一天）
 *   - WVQA_PORTRAIT_URL        竖版视频公网地址（1.P5；缺省从 manifest 竖版字段派生）
 *   - WVQA_PORTRAIT_MP4        本地竖版产物路径（4.P4 freshness 被检对象）
 *   - WVQA_SOURCE_DIR          壁纸视频生成链路源码目录（4.P4；缺省 apps/backend/src）
 *   - WVQA_STATIC_FALLBACK_DATE 7.P2 静态回退日（缺省自动取 manifest 无视频字段的一天）
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/__tests__ → 仓库根：src(1) apps/backend(2) apps(3) relight(4)
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

const GALLERY_BASE = (process.env.WVQA_GALLERY_BASE ?? "").replace(/\/$/, "");
const MANIFEST_URL = (
  process.env.WVQA_MANIFEST_URL ?? (GALLERY_BASE ? `${GALLERY_BASE}/manifest.json` : "")
).trim();
const MANIFEST_JSON = (process.env.WVQA_MANIFEST_JSON ?? "").trim();
const PICK_DATE = (process.env.WVQA_PICK_DATE ?? "").trim();
const PORTRAIT_URL = (process.env.WVQA_PORTRAIT_URL ?? "").trim();
const PORTRAIT_MP4 = (process.env.WVQA_PORTRAIT_MP4 ?? "").trim();
const SOURCE_DIR = (process.env.WVQA_SOURCE_DIR ?? path.join(REPO_ROOT, "apps/backend/src")).trim();
const STATIC_FALLBACK_DATE = (process.env.WVQA_STATIC_FALLBACK_DATE ?? "").trim();

function writeArtifact(id: string, content: string): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

interface ManifestDay {
  pickDate: string;
  [key: string]: unknown;
}

async function loadManifest(): Promise<{ days: ManifestDay[]; source: string }> {
  if (MANIFEST_JSON) {
    expect(fs.existsSync(MANIFEST_JSON), `manifest 文件不存在: ${MANIFEST_JSON}`).toBe(true);
    return {
      days: (JSON.parse(fs.readFileSync(MANIFEST_JSON, "utf-8")) as { days: ManifestDay[] }).days,
      source: MANIFEST_JSON,
    };
  }
  expect(
    MANIFEST_URL,
    "WVQA_MANIFEST_URL / WVQA_GALLERY_BASE / WVQA_MANIFEST_JSON 均未绑定",
  ).not.toBe("");
  const res = await fetch(MANIFEST_URL);
  expect(res.status, `manifest 拉取失败: ${MANIFEST_URL}`).toBe(200);
  return { days: ((await res.json()) as { days: ManifestDay[] }).days, source: MANIFEST_URL };
}

/** manifest 日对象中的竖版视频字段值（字段名为 QA 绑定类别，运行时按 portrait+video 语义发现） */
function portraitVideoField(day: ManifestDay): string {
  for (const [k, v] of Object.entries(day)) {
    if (/portrait/i.test(k) && /video/i.test(k) && typeof v === "string" && v) return v;
  }
  return "";
}

function staticPortraitField(day: ManifestDay): string {
  for (const [k, v] of Object.entries(day)) {
    if (/^wallpaperPortrait$/i.test(k) && typeof v === "string" && v) return v;
    if (
      /portrait/i.test(k) &&
      /wallpaper/i.test(k) &&
      !/video/i.test(k) &&
      typeof v === "string" &&
      v
    )
      return v;
  }
  return "";
}

function absolute(base: string, ref: string): string {
  if (/^https?:\/\//i.test(ref)) return ref;
  return `${base.replace(/\/$/, "")}/${ref.replace(/^\//, "")}`;
}

function probeDurationSec(file: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf-8", timeout: 30000 },
  ).trim();
  return Number(out);
}

// ---- 门控 ----

const NET_BOUND = Boolean(MANIFEST_JSON || MANIFEST_URL);
if (!NET_BOUND) {
  for (const id of ["场景1.P5", "场景4.P1", "场景7.P2"]) {
    writeArtifact(
      `${id}-跳过原因`,
      "画廊公网基址 / manifest 地址未绑定（WVQA_GALLERY_BASE 或 WVQA_MANIFEST_URL 或 WVQA_MANIFEST_JSON）" +
        "——本谓词为真实网络请求求值，绑定后重跑本套件；不得静默置 PASS。",
    );
  }
  console.warn(
    "[publish-chain] manifest 绑定缺失——1.P5/4.P1/7.P2 skip（逐谓词留跳过原因 artifact）",
  );
}
const dNet = NET_BOUND ? describe : describe.skip;

// ============================================================================
// 4.P1：画廊 manifest 暴露该日竖版视频引用且可拉取
// ============================================================================

dNet("场景 4.P1 [real-process]：manifest 竖版视频引用闭合", () => {
  let days: ManifestDay[] = [];
  let base = "";

  beforeAll(async () => {
    const m = await loadManifest();
    days = m.days;
    base = MANIFEST_JSON
      ? GALLERY_BASE || path.dirname(MANIFEST_JSON)
      : new URL(MANIFEST_URL).origin;
    if (MANIFEST_JSON && !GALLERY_BASE) {
      // 本地 manifest：资源地址相对 manifest 同目录（fixture/落盘场景）
      base = `file://${path.dirname(path.resolve(MANIFEST_JSON))}`;
    }
  }, 30000);

  it("该日 portrait 字段存在且值含 /wallpaper-videos/，视频地址真实请求 200", async () => {
    const target =
      (PICK_DATE ? days.find((d) => d.pickDate === PICK_DATE) : undefined) ??
      [...days].reverse().find((d) => portraitVideoField(d) !== "");
    expect(target, "manifest 中找不到含竖版视频引用的该日（真红）").toBeTruthy();
    const field = portraitVideoField(target!);
    writeArtifact(
      "场景4.P1",
      JSON.stringify(
        { pickDate: target!.pickDate, field, manifestSource: MANIFEST_JSON || MANIFEST_URL },
        null,
        2,
      ),
    );
    // 谓词字面量①：portrait_field exists
    expect(field, "该日 manifest 无竖版视频字段").not.toBe("");
    // 谓词字面量②：field_value contains "/wallpaper-videos/"
    expect(field, `竖版视频引用不含 /wallpaper-videos/: ${field}`).toContain("/wallpaper-videos/");
    // 谓词字面量③：video_http_status == 200
    const videoUrl = absolute(base, field);
    const res = await fetch(videoUrl, { method: "GET", headers: { Range: "bytes=0-1023" } });
    writeArtifact("场景4.P1-http", JSON.stringify({ videoUrl, status: res.status }));
    expect(res.status, `视频地址请求非 200: ${videoUrl}`).toBe(200);
  }, 60000);
});

// ============================================================================
// 1.P5：托管竖版视频真实请求可解码可播放
// ============================================================================

dNet("场景 1.P5 [real-process]：托管竖版视频可解码可播放", () => {
  it("status ∈ {200,206} && content-type contains video && ffprobe duration > 1", async () => {
    const { days } = await loadManifest();
    const target =
      (PICK_DATE ? days.find((d) => d.pickDate === PICK_DATE) : undefined) ??
      [...days].reverse().find((d) => portraitVideoField(d) !== "");
    expect(target, "manifest 中找不到竖版视频日").toBeTruthy();
    const ref = PORTRAIT_URL || portraitVideoField(target!);
    expect(ref, "WVQA_PORTRAIT_URL 未绑定且 manifest 无竖版字段可派生").not.toBe("");
    const base = MANIFEST_URL
      ? new URL(MANIFEST_URL).origin
      : GALLERY_BASE || `file://${path.dirname(path.resolve(MANIFEST_JSON))}`;
    const url = absolute(base, ref);

    const res = await fetch(url, { headers: { Range: "bytes=0-" } });
    const contentType = res.headers.get("content-type") ?? "";
    writeArtifact("场景1.P5", JSON.stringify({ url, status: res.status, contentType }, null, 2));
    // 谓词字面量①②：status in {200,206} && content_type contains "video"
    expect([200, 206]).toContain(res.status);
    expect(contentType).toContain("video");
    // 谓词字面量③：ffprobe_duration_sec > 1（下载到临时文件后真解析）
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length, "下载内容为空").toBeGreaterThan(0);
    const tmp = path.join(os.tmpdir(), `wv-1p5-${Date.now()}.mp4`);
    fs.writeFileSync(tmp, buf);
    try {
      const durationSec = probeDurationSec(tmp);
      writeArtifact("场景1.P5-ffprobe", JSON.stringify({ durationSec }));
      expect(durationSec).toBeGreaterThan(1);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }, 120000);
});

// ============================================================================
// 4.P4：新产物比生成链路源码更新（freshness）
// ============================================================================

const FRESHNESS_BOUND = PORTRAIT_MP4.length > 0;
if (!FRESHNESS_BOUND) {
  writeArtifact(
    "场景4.P4-跳过原因",
    "WVQA_PORTRAIT_MP4 未绑定——4.P4 需重跑产物落盘后求值；不得静默置 PASS。",
  );
  console.warn("[publish-chain] WVQA_PORTRAIT_MP4 未绑定——4.P4 skip（留 artifact）");
}
const dFreshness = FRESHNESS_BOUND ? describe : describe.skip;

dFreshness("场景 4.P4 [det-machine]：新产物 freshness 检查", () => {
  it("产物 mtime 晚于生成链路源码最新 mtime → stdout == FRESH && exit == 0", () => {
    expect(fs.existsSync(PORTRAIT_MP4), `竖版产物不存在: ${PORTRAIT_MP4}`).toBe(true);
    expect(fs.existsSync(SOURCE_DIR), `源码目录不存在: ${SOURCE_DIR}`).toBe(true);
    // driver 形态：独立进程输出 FRESH/STALE（stdout == "FRESH" && exit == 0 为谓词字面量）
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const product = process.argv[1];
      const srcDir = process.argv[2];
      let newestSrc = 0;
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name === "__tests__") continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else newestSrc = Math.max(newestSrc, fs.statSync(p).mtimeMs);
        }
      };
      walk(srcDir);
      const productM = fs.statSync(product).mtimeMs;
      if (productM > newestSrc) { console.log("FRESH"); process.exit(0); }
      console.log("STALE product=" + new Date(productM).toISOString() + " newestSrc=" + new Date(newestSrc).toISOString());
      process.exit(1);
    `;
    const res = spawnSync(process.execPath, ["-e", script, PORTRAIT_MP4, SOURCE_DIR], {
      encoding: "utf-8",
      timeout: 30000,
    });
    writeArtifact(
      "场景4.P4",
      JSON.stringify({
        product: PORTRAIT_MP4,
        sourceDir: SOURCE_DIR,
        exit: res.status,
        stdout: res.stdout.trim(),
      }),
    );
    expect(res.status, `freshness 判 STALE：${res.stdout.trim()}`).toBe(0);
    expect(res.stdout.trim()).toBe("FRESH");
  }, 60000);
});

// ============================================================================
// 7.P2：视频生成失败日 → 画廊回退静态壁纸卡且静态资源可访问
// ============================================================================

dNet("场景 7.P2 [real-process]：视频失败日回退静态壁纸卡", () => {
  it("video_field_absent && static_field_exists && static_http_status == 200", async () => {
    const { days } = await loadManifest();
    const target =
      (STATIC_FALLBACK_DATE ? days.find((d) => d.pickDate === STATIC_FALLBACK_DATE) : undefined) ??
      [...days]
        .reverse()
        .find((d) => portraitVideoField(d) === "" && staticPortraitField(d) !== "");
    expect(
      target,
      "manifest 中找不到「无视频字段且有静态竖版壁纸」的回退日（可用 WVQA_STATIC_FALLBACK_DATE 指定）",
    ).toBeTruthy();
    const videoField = portraitVideoField(target!);
    const staticField = staticPortraitField(target!);
    // 谓词字面量①②：video_field_absent==true && static_field_exists==true
    expect(videoField, `回退日仍含视频字段: ${videoField}`).toBe("");
    expect(staticField, "回退日缺静态竖版壁纸字段").not.toBe("");
    // 谓词字面量③：static_http_status == 200
    const base = MANIFEST_URL
      ? new URL(MANIFEST_URL).origin
      : GALLERY_BASE || `file://${path.dirname(path.resolve(MANIFEST_JSON))}`;
    const staticUrl = absolute(base, staticField);
    const res = await fetch(staticUrl, { headers: { Range: "bytes=0-1023" } });
    writeArtifact(
      "场景7.P2",
      JSON.stringify({ pickDate: target!.pickDate, staticUrl, status: res.status }, null, 2),
    );
    expect(res.status, `静态壁纸地址请求非 200: ${staticUrl}`).toBe(200);
  }, 60000);
});

/**
 * 验收测试（红队，real-process，env 门控）：单腿原生壁纸视频 — 全链路真跑 + COS 分发
 *
 * 设计文档（state.md §验证方案 / §验收场景）：
 *   「真实生成（40-90min GPU）不进 CI 化 QA：1s 探针 + 自然日出片由用户按 SOP 验收」——
 *   本文件即 SOP 化的真跑验收，缺省 skip，操作者显式 env 接入后真跑（既有 env 门控模式，
 *   参 WVQA_PORTRAIT_MP4 惯例；skip 在报告可见，非宽容跳过——det-machine 断言在其它
 *   验收文件中无条件可跑）。
 *
 * 对应谓词：
 *   - 场景 1.P1 [real-process]：触发
 *     `pnpm --filter @relight/backend run wallpaper-video:rerun -- --pickDate=D`
 *     → exit==0 且当日视频产物总数恰为 1（生成产物计数，排除 loop/overlay/转码中间产物）
 *     ｜ env: WVQA_NATIVE_RERUN=1 + WVQA_NATIVE_RERUN_PICKDATE=D（进程 env 须已含
 *     DAILY_WALLPAPER_VIDEO=true——rerun SOP 既有要求）
 *   - 场景 1.P2 [det-machine]：生成画布跟随原图比例（32 倍数 + abs(h - w*srcH/srcW) ≤ 32）
 *     ｜ observe: ffprobe 产物 + DB 原图 dims
 *   - 场景 1.P3 [det-machine]：width*height ≤ 1177600 && ≥ 1177600/2 ｜ observe: ffprobe
 *   - 场景 3.P3 [real-process]：兼容日护栏通过后 wallpaper_video_landscape_url != ""
 *     且 COS HEAD 200 ｜ env: WVQA_LANDSCAPE_COS_URL
 *   - 场景 6.P3 [real-process]：历史 COS 对象 HEAD 200 content-length>0
 *     ｜ env: WVQA_LEGACY_COS_URL
 *   - 场景 8.P3 [real-process]：原生视频 COS HEAD 200 video/mp4 ｜ env: WVQA_NATIVE_COS_URL
 *
 * 红队铁律：门控 = 显式 env 接入（不是 try/catch 吞错、不是断言前 if 分支）；接入后全部
 * 硬断言，失败即红。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../lib/config";

const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

function writeArtifact(id: string, content: string): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

// ============================================================================
// 门控（显式 env 接入，缺省 skip 可见）
// ============================================================================

const RERUN_ENABLED = process.env.WVQA_NATIVE_RERUN === "1";
const RERUN_PICKDATE = process.env.WVQA_NATIVE_RERUN_PICKDATE ?? "";
const dRerun = RERUN_ENABLED && RERUN_PICKDATE ? describe : describe.skip;
if (RERUN_ENABLED && !RERUN_PICKDATE) {
  throw new Error(
    "WVQA_NATIVE_RERUN=1 时必须同时提供 WVQA_NATIVE_RERUN_PICKDATE=<YYYY-MM-DD>（禁无目标真跑）",
  );
}
if (!RERUN_ENABLED) {
  console.warn(
    "[wallpaper-video-native-realprocess] 全链路真跑未接入（WVQA_NATIVE_RERUN!=1）——3 组真跑用例 skip（SOP：DAILY_WALLPAPER_VIDEO=true 下接入）",
  );
}

// ============================================================================
// ffprobe 辅助
// ============================================================================

interface ProbeResult {
  formatName: string;
  width: number | null;
  height: number | null;
}

function probe(file: string): ProbeResult {
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
    formatName: j.format?.format_name ?? "",
    width: v?.width ?? null,
    height: v?.height ?? null,
  };
}

/** HEAD 请求（原生 fetch；断言状态/类型/长度） */
async function head(
  url: string,
): Promise<{ status: number; contentType: string; contentLength: number }> {
  const res = await fetch(url, { method: "HEAD" });
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    contentLength: Number(res.headers.get("content-length") ?? "0"),
  };
}

// ============================================================================
// 场景 1.P1 / 1.P2 / 1.P3：rerun 全链路真跑
// ============================================================================

dRerun(`场景 1：rerun 全链路真跑（pickDate=${RERUN_PICKDATE}，40-90min GPU，SOP 接入）`, () => {
  it(
    "场景 1.P1 [real-process]：rerun exit==0 且当日生成产物总数恰为 1",
    async () => {
      // 谓词逐字命令：pnpm --filter @relight/backend run wallpaper-video:rerun -- --pickDate=D
      const repoRoot = path.resolve(__dirname, "../../..");
      const startedAt = new Date(Date.now() - 5000); // 5s 容差（文件 mtime 粒度）
      const r = spawnSync(
        "pnpm",
        [
          "--filter",
          "@relight/backend",
          "run",
          "wallpaper-video:rerun",
          "--",
          `--pickDate=${RERUN_PICKDATE}`,
        ],
        {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 2.5 * 3600 * 1000,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, DAILY_WALLPAPER_VIDEO: "true" },
        },
      );
      writeArtifact(
        "s1p1",
        JSON.stringify(
          {
            exitCode: r.status,
            signal: r.signal,
            stdoutTail: (r.stdout ?? "").slice(-2000),
            stderrTail: (r.stderr ?? "").slice(-2000),
          },
          null,
          2,
        ),
      );
      // 谓词字面量：exit == 0
      expect(r.status, `rerun 必须退出码 0（stderr tail: ${(r.stderr ?? "").slice(-2000)}）`).toBe(
        0,
      );

      // 当日生成产物计数：run 期间新建的 .mp4/.mov，排除 loop/overlay/转码/首帧中间产物与
      // legacy 命名——单腿原生 = 恰 1 个「生成」产物（native 母版）。
      // 生成/转码产物落 {STORAGE_ROOT}/wallpaper-videos/（jobs/wallpaper-video.ts wallpaperVideoDir），
      // 非 videoWorkspacePath（那是 Remotion overlay 工程与中间件目录）。
      const ws = path.join(config.storageRoot, "wallpaper-videos");
      const fresh: string[] = [];
      const scan = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            scan(p);
            continue;
          }
          if (!/\.(mp4|mov)$/i.test(e.name)) continue;
          if (
            /(loop|overlay|_landscape\.mov|_portrait\.mp4|first-frame|last-frame|preprocess)/i.test(
              e.name,
            )
          ) {
            continue;
          }
          if (fs.statSync(p).mtimeMs > startedAt.getTime()) fresh.push(p);
        }
      };
      expect(fs.existsSync(ws), `videoWorkspacePath 不存在: ${ws}`).toBe(true);
      scan(ws);
      writeArtifact("s1p1-products", JSON.stringify(fresh, null, 2));
      expect(
        fresh.length,
        `当日生成产物总数必须恰为 1（单腿），实际 ${fresh.length}: ${JSON.stringify(fresh)}`,
      ).toBe(1);
    },
    2.6 * 3600 * 1000,
  );

  it("场景 1.P2/P3 [det-machine]：生成画布跟随原图比例（32 倍数 + |h - w*srcH/srcW| ≤ 32）且像素预算窗口", async () => {
    // 原图 dims：DB 当日 pick → photos 行（真实环境 DATABASE_PATH，只读）
    const Database = (await import("better-sqlite3")).default;
    const sqlite = new Database(config.databasePath, { readonly: true });
    const row = sqlite
      .prepare(
        `SELECT p.file_path AS file_path, p.width AS w, p.height AS h
           FROM daily_picks dp JOIN photos p ON p.id = dp.photo_id
           WHERE dp.pick_date = ?`,
      )
      .get(RERUN_PICKDATE) as { file_path: string; w: number; h: number } | undefined;
    sqlite.close();
    expect(row, `DB 缺 ${RERUN_PICKDATE} 当日 pick/photo 行`).toBeTruthy();
    const src = row as { file_path: string; w: number; h: number };

    // 产物定位：同上轮扫描约定（native 生成产物，落 STORAGE_ROOT/wallpaper-videos/）
    const ws = path.join(config.storageRoot, "wallpaper-videos");
    const startedAt = Date.now() - 3 * 3600 * 1000; // 3h 窗口（同轮真跑产物）
    const fresh: string[] = [];
    const scan = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          scan(p);
          continue;
        }
        if (!/\.(mp4|mov)$/i.test(e.name)) continue;
        if (
          /(loop|overlay|_landscape\.mov|_portrait\.mp4|first-frame|last-frame|preprocess)/i.test(
            e.name,
          )
        ) {
          continue;
        }
        if (fs.statSync(p).mtimeMs > startedAt) fresh.push(p);
      }
    };
    scan(ws);
    fresh.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const product = fresh[0];
    expect(product, `找不到近期生成产物（ scanned ${fresh.length} 个）`).toBeTruthy();

    const meta = probe(product as string);
    const w = meta.width as number;
    const h = meta.height as number;
    // 谓词字面量：32 倍数
    expect(w % 32, `产物宽 ${w} 必须是 32 倍数`).toBe(0);
    expect(h % 32, `产物高 ${h} 必须是 32 倍数`).toBe(0);
    // 谓词字面量：abs(h - w*srcH/srcW) <= 32（画布跟随原图比例）
    const expectedH = w * (src.h / src.w);
    expect(
      Math.abs(h - expectedH),
      `画布比例必须跟随原图：|${h} - ${w}*${src.h}/${src.w}| = ${Math.abs(h - expectedH).toFixed(1)} > 32`,
    ).toBeLessThanOrEqual(32);
    // 谓词字面量：width*height <= 1177600 && >= 1177600/2
    const pixels = w * h;
    expect(pixels).toBeLessThanOrEqual(1_177_600);
    expect(pixels).toBeGreaterThanOrEqual(1_177_600 / 2);
    writeArtifact("s1p2", JSON.stringify({ product, w, h, srcW: src.w, srcH: src.h, pixels }));
    writeArtifact("s1p3", JSON.stringify({ product, pixels, budget: 1_177_600 }));
  }, 120000);
});

// ============================================================================
// COS 分发真跑（场景 3.P3 / 6.P3 / 8.P3）——env 提供 URL 接入（it.skipIf 收集期门控）
// ============================================================================

const LANDSCAPE_COS_URL = process.env.WVQA_LANDSCAPE_COS_URL;
const LEGACY_COS_URL = process.env.WVQA_LEGACY_COS_URL;
const NATIVE_COS_URL = process.env.WVQA_NATIVE_COS_URL;

if (!LANDSCAPE_COS_URL || !LEGACY_COS_URL || !NATIVE_COS_URL) {
  console.warn(
    "[wallpaper-video-native-realprocess] COS HEAD 未全部接入（WVQA_LANDSCAPE_COS_URL / WVQA_LEGACY_COS_URL / WVQA_NATIVE_COS_URL）——对应组 skip（自然日出片后接入）",
  );
}

describe("场景 COS HEAD 真跑（env 接入式门控）", () => {
  it.skipIf(!LANDSCAPE_COS_URL)(
    "场景 3.P3 [real-process]：兼容日 landscape .mov COS HEAD 200",
    async () => {
      const r = await head(LANDSCAPE_COS_URL as string);
      writeArtifact("s3p3", JSON.stringify({ url: LANDSCAPE_COS_URL, ...r }));
      expect(r.status).toBe(200);
      expect(r.contentLength).toBeGreaterThan(0);
    },
  );

  it.skipIf(!LEGACY_COS_URL)(
    "场景 6.P3 [real-process]：历史 legacy COS 对象 HEAD 200 content-length>0",
    async () => {
      const r = await head(LEGACY_COS_URL as string);
      writeArtifact("s6p3", JSON.stringify({ url: LEGACY_COS_URL, ...r }));
      expect(r.status).toBe(200);
      expect(r.contentLength).toBeGreaterThan(0);
    },
  );

  it.skipIf(!NATIVE_COS_URL)(
    "场景 8.P3 [real-process]：原生视频 COS HEAD 200 video/mp4",
    async () => {
      const r = await head(NATIVE_COS_URL as string);
      writeArtifact("s8p3", JSON.stringify({ url: NATIVE_COS_URL, ...r }));
      expect(r.status).toBe(200);
      expect(r.contentType).toContain("video/mp4");
      expect(r.contentLength).toBeGreaterThan(0);
    },
  );
});

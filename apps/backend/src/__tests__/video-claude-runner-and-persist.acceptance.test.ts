/**
 * 验收测试（红队）：claude runner 产出 + DB 持久化 + 失败不降级
 *
 * 设计契约来源（state.md ## 契约规约 + ## 验收场景）：
 *
 *   claude-runner（src/lib/video/claude-runner.ts）契约（仅读 export 签名）：
 *     runVideoGeneration(theme, outputPath, metaPath): Promise<{ok, meta?, err?}>
 *     VideoTheme = {themeKind, themeKey, titleHint, photoIds, personId?, toYear}
 *     VideoMeta  = {title, durationSec, photoIds}
 *     VideoGenResult = {ok, meta?, err?}
 *     - spawn claude -p，cwd=config.videoWorkspacePath，绝对路径 config.claudeCliPath
 *     - spawn 前三存在校验（node_modules + render-immersive.mjs + SKILL.md）→ 缺失即 fail
 *     - AbortController 600s 超时 → SIGTERM → 清理 .tmp → 返回 err
 *     - 失败不降级、不重试渲染；成功 mp4+json 落盘到 outputPath/metaPath
 *
 *   daily-video job（src/jobs/daily-video.ts）契约：
 *     dailyVideoWorker(job): Promise<void>
 *     - discover → 选 1 候选 → runVideoGeneration → 事务写 videos+videoUsages → 推送
 *     - 失败写 failed 行；无候选空完成（不推送）
 *     - 产物 mp4 → STORAGE_ROOT/.video-cache/<themeKind>-<themeKey>.mp4
 *
 * 覆盖预注册谓词：
 *   5. CLAUDE-P-PRODUCES-MP4：stub claude exit 0 产 mp4 → ffprobe 校验 1920x1080 h264
 *   6. DB-PERSIST-WRITE-COMPLETED：mp4 产出后 videos 行 + video_usages 行一致 + 文件存在
 *   9. FAILURE-NO-DEGRADE：stub exit 1 / 前置缺失 → 无 completed mp4 + 有 failed 行
 *
 * 红队铁律：
 *   - 不读 claude-runner.ts / daily-video.ts 实现逻辑（仅 export 签名作契约）
 *   - spawn stub：构造真实 fake claude shell 脚本（exit 0 产 fixture mp4 / exit 1），
 *     config.claudeCliPath 指向它。比 mock child_process 更黑盒、更接近真实 spawn 路径。
 *   - mp4 用真实 ffprobe 校验（项目要求 ffmpeg≥4.0，本机 /opt/homebrew/bin/ffprobe）；
 *     ffprobe 不可用 → 测试 fail（红队铁律：不 silent skip，逼环境履约）。
 *
 * 驱动机制：
 *   - 真实 SQLite（better-sqlite3 + 临时文件），fixture 植入与 job 读写共享同一 drizzle 实例
 *     （mock ../db 返回包装 env.sqlite 的 drizzle，避免 WAL 多连接 read-isolation flaky）
 *   - ffmpeg 生成 1920x1080 H264 test mp4 作 stub 产物模板
 *   - 写 fake claude shell 脚本，chmod +x，holder 暂存路径供 config getter 返回
 *   - mock ../lib/push/wechat（dailyVideoWorker 会触发推送，本文件不验推送，仅防真实 HTTP）
 *   - mock ../lib/config + node:os（HOME 重定向让 SKILL.md 前置校验命中临时目录）
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// ffprobe 探测（项目要求 ffmpeg≥4.0；无则测试 fail）
// ============================================================================

function ffprobeAvailable(): boolean {
  try {
    const r = spawnSync("ffprobe", ["-version"], { encoding: "utf-8", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

const HAS_FFPROBE = ffprobeAvailable();

// ============================================================================
// hoisted holder：在 vi.mock factory 与 beforeAll 间共享路径
// ============================================================================

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  workspacePath: "/tmp/relight-none",
  fakeClaudePath: "/usr/bin/false",
  storageRoot: "/tmp/relight-none",
  tmpRoot: "/tmp/relight-none",
}));

// mock config（claude-runner 读 config.claudeCliPath/videoWorkspacePath；db 读 databasePath）
vi.mock("../lib/config", () => ({
  config: {
    get databasePath() {
      return holder.dbPath;
    },
    get storageRoot() {
      return holder.storageRoot;
    },
    get videoWorkspacePath() {
      return holder.workspacePath;
    },
    get claudeCliPath() {
      return holder.fakeClaudePath;
    },
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-video-test",
    ai: { baseUrl: "", apiKey: "", visionModel: "", model: "", promptVersion: "v2" },
    daily: { cronTime: "0 3 * * *", maxCandidates: 20, timezone: "Asia/Shanghai" },
    video: { enabled: true, frameCount: 6, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" },
    dailySelectionConcurrency: 1,
    dailyAutoHealDays: 0,
    dailySelectEnabled: false,
    minAestheticScorePrimary: 7.0,
    face: {},
  },
}));

// mock HOME 让 SKILL.md 前置校验（~/.claude/skills/memory-video/SKILL.md）命中临时目录
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => holder.tmpRoot,
  };
});

// mock db：用 holder.dbPath 建唯一 drizzle 连接（beforeAll 先于测试内 import 注入路径）
// 真实 schema 保留（含蓝队 T1 的 videos/videoUsages）。
vi.mock("../db", async () => {
  const actualSchema = await import("../db/schema");
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const sqlite = new Database(holder.dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema: actualSchema });
  return { db, schema: actualSchema };
});

// mock wechat（dailyVideoWorker 会推送；本文件谓词 7 验推送内容，需捕获 url+buffer 参数）
// 显式声明 vi.fn 参数签名，让 mock.calls[0] 类型可读（否则推断为 never[]）
const wechatMocks = vi.hoisted(() => ({
  sendWallpaperToWeCom: vi.fn(async (_url: string, _imageBuffer: Buffer) => ({
    errcode: 0,
    errmsg: "ok",
  })),
  compressForWeCom: vi.fn(async (buf: Buffer) => buf),
  getDailyPushSettings: vi.fn(async () => ({
    webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-token-001",
    enabled: true,
  })),
  sendWeComText: vi.fn(async (_url: string, _content: string) => ({ errcode: 0, errmsg: "ok" })),
}));
vi.mock("../lib/push/wechat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push/wechat")>();
  return {
    ...actual,
    sendWallpaperToWeCom: wechatMocks.sendWallpaperToWeCom,
    compressForWeCom: wechatMocks.compressForWeCom,
    getDailyPushSettings: wechatMocks.getDailyPushSettings,
  };
});

vi.mock("../lib/push/wechat-text", () => ({
  sendWeComText: wechatMocks.sendWeComText,
}));

// ============================================================================
// 临时环境
// ============================================================================

interface RunnerEnv {
  tmpRoot: string;
  dbPath: string;
  storageRoot: string;
  videoCacheDir: string;
  workspacePath: string;
  sqlite: Database.Database;
}

function createRunnerEnv(): RunnerEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-videorun-"));
  const dbPath = path.join(tmpRoot, "test.db");
  const storageRoot = path.join(tmpRoot, "storage");
  const videoCacheDir = path.join(storageRoot, ".video-cache");
  const workspacePath = path.join(tmpRoot, "workspace");
  fs.mkdirSync(videoCacheDir, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });

  // spawn 前置三存在校验所需文件
  fs.mkdirSync(path.join(workspacePath, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "render-immersive.mjs"), "// test stub");
  // SKILL.md 在 HOME/.claude/skills/memory-video/（HOME 已被 mock 到 tmpRoot）
  const skillDir = path.join(tmpRoot, ".claude/skills/memory-video");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# memory-video test stub");

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY, theme_kind TEXT NOT NULL, theme_key TEXT NOT NULL,
      title TEXT NOT NULL, output_path TEXT NOT NULL, cover_path TEXT NOT NULL,
      duration_sec INTEGER, photo_ids TEXT, status TEXT NOT NULL, error_msg TEXT,
      created_at TEXT NOT NULL, UNIQUE(theme_kind, theme_key)
    );
    CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at);
    CREATE TABLE IF NOT EXISTS video_usages (
      id TEXT PRIMARY KEY, theme_kind TEXT NOT NULL, theme_key TEXT NOT NULL,
      photo_id TEXT NOT NULL, consumed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_video_usages_photo ON video_usages(photo_id);
    CREATE INDEX IF NOT EXISTS idx_video_usages_theme ON video_usages(theme_kind, theme_key);
  `);
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES ('src-test', '测试', 'local', ?, 1)`,
    )
    .run(storageRoot);

  return { tmpRoot, dbPath, storageRoot, videoCacheDir, workspacePath, sqlite };
}

function disposeRunnerEnv(env: RunnerEnv): void {
  try {
    env.sqlite.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(env.tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ============================================================================
// 生成真实的 1920x1080 H264 test mp4（作 stub 产物模板）
// ============================================================================

function generateTestMp8(outPath: string): boolean {
  if (!HAS_FFPROBE) return false;
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1920x1080:rate=24",
      "-frames:v",
      "24",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ],
    { encoding: "utf-8", timeout: 30_000 },
  );
  return r.status === 0 && fs.existsSync(outPath);
}

function probeMp8(mp4Path: string): { width: number; height: number; codec: string } | null {
  if (!HAS_FFPROBE) return null;
  // 用 json 输出避免 csv 列顺序不稳定（ffprobe 内部顺序，非 -show_entries 请求顺序）
  const r = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,codec_name",
      "-of",
      "json",
      mp4Path,
    ],
    { encoding: "utf-8", timeout: 10_000 },
  );
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const parsed = JSON.parse(r.stdout) as {
      streams?: Array<{ width?: number; height?: number; codec_name?: string }>;
    };
    const s = parsed.streams?.[0];
    if (!s) return null;
    return {
      width: s.width ?? 0,
      height: s.height ?? 0,
      codec: s.codec_name ?? "",
    };
  } catch {
    return null;
  }
}

// ============================================================================
// fake claude 脚本工厂（从 env 读 OUTPUT_PATH / META_PATH，蓝队 spawn 时注入）
// ============================================================================

function writeFakeClaude(tmpRoot: string, mode: "ok" | "fail", testMp8Template: string): string {
  const scriptPath = path.join(
    tmpRoot,
    `fake-claude-${mode}-${Math.random().toString(36).slice(2)}.sh`,
  );
  let body: string;
  if (mode === "ok") {
    body = `#!/bin/sh
set -e
cp "${testMp8Template}" "$OUTPUT_PATH"
cat > "$META_PATH" <<'EOF'
{"title":"测试视频标题","durationSec":60,"photoIds":["p1","p2","p3"]}
EOF
exit 0
`;
  } else {
    body = `#!/bin/sh
echo "claude-p: 原图缺失或渲染失败" >&2
exit 1
`;
  }
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

// ============================================================================
// 辅助：植入旅行素材（重庆·川南 GPS lat29.5 lng106.5，连续天）
// ============================================================================

function seedTripPhotos(sqlite: Database.Database, prefix: string, count = 21): void {
  const baseDate = new Date("2024-09-10T10:00:00Z").getTime();
  const stmt = sqlite.prepare(
    `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height,
                         file_size, thumbnail_path, taken_at, created_at, media_type,
                         latitude, longitude)
     VALUES (?, 'src-test', ?, ?, 1920, 1080, 1024, ?, ?, ?, 'image', ?, ?)`,
  );
  for (let i = 0; i < count; i++) {
    stmt.run(
      `${prefix}-${i}`,
      `photos/${prefix}-${i}.jpg`,
      `h-${prefix}-${i}-${Math.random().toString(36).slice(2)}`,
      `/tmp/t-${prefix}-${i}.jpg`,
      new Date(baseDate + i * 86_400_000).toISOString(),
      new Date().toISOString(),
      29.5,
      106.5,
    );
  }
}

/** mock job 对象（dailyVideoWorker 接受 BullMQ Job，只用 data/log/updateProgress） */
function makeJob(id: string, data: Record<string, unknown> = {}): unknown {
  return {
    data,
    id,
    name: "daily-video-cron",
    log: () => {},
    updateProgress: () => {},
  };
}

// ============================================================================
// 测试套件
// ============================================================================

describe("claude runner + DB 持久化 — 验收测试（谓词 5/6/9）", () => {
  let env: RunnerEnv;
  let testMp8Template: string;

  beforeAll(() => {
    // 红队铁律：ffprobe 不可用直接 fail（项目要求 ffmpeg≥4.0）
    expect(HAS_FFPROBE, "ffprobe 不可用：项目要求 ffmpeg≥4.0，请 brew install ffmpeg").toBe(true);

    env = createRunnerEnv();
    // 把 env 路径注入 holder，供 mock config getter / os.homedir / db factory 读取
    holder.dbPath = env.dbPath;
    holder.workspacePath = env.workspacePath;
    holder.storageRoot = env.storageRoot;
    holder.tmpRoot = env.tmpRoot;

    testMp8Template = path.join(env.tmpRoot, "template.mp4");
    const templateReady = generateTestMp8(testMp8Template);
    expect(templateReady, "ffmpeg 应能生成 1920x1080 H264 测试 mp4 模板").toBe(true);
  });

  afterAll(() => {
    disposeRunnerEnv(env);
  });

  beforeEach(() => {
    for (const tbl of ["video_usages", "videos", "faces", "persons", "photo_analyses", "photos"]) {
      env.sqlite.exec(`DELETE FROM ${tbl};`);
    }
    wechatMocks.sendWallpaperToWeCom.mockClear();
    wechatMocks.compressForWeCom.mockClear();
    wechatMocks.sendWeComText.mockClear();
    wechatMocks.getDailyPushSettings.mockClear();
  });

  // ==========================================================================
  // 谓词 5：CLAUDE-P-PRODUCES-MP4
  // stub claude exit 0 产 mp4 → ffprobe 校验 1920x1080 h264
  // ==========================================================================

  describe("CLAUDE-P-PRODUCES-MP4：成功产出 mp4 技术规格", () => {
    it("runVideoGeneration 成功：返回 {ok:true} 且 outputPath 指向真实 mp4 文件（size>0）", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "ok", testMp8Template);

      const { runVideoGeneration } = await import("../lib/video/claude-runner");
      const outputPath = path.join(env.videoCacheDir, "trip-chongqing-2024.mp4");
      const metaPath = path.join(env.videoCacheDir, "trip-chongqing-2024.json");

      const result = await runVideoGeneration(
        {
          themeKind: "trip",
          themeKey: "chongqing-2024",
          titleHint: "重庆·川南 2024",
          photoIds: ["p1", "p2", "p3"],
          toYear: 2024,
        },
        outputPath,
        metaPath,
      );

      expect(result.ok, "exit 0 产 mp4 应返回 ok=true").toBe(true);
      expect(fs.existsSync(outputPath), "产物 mp4 应落盘到 outputPath").toBe(true);
      const stat = fs.statSync(outputPath);
      expect(stat.size, "mp4 文件 size > 0").toBeGreaterThan(0);
    });

    it("ffprobe 校验：产物为 1920x1080 H264（width=1920, height=1080, codec_name=h264）", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "ok", testMp8Template);

      const { runVideoGeneration } = await import("../lib/video/claude-runner");
      const outputPath = path.join(env.videoCacheDir, "probe-test.mp4");
      const metaPath = path.join(env.videoCacheDir, "probe-test.json");

      const result = await runVideoGeneration(
        {
          themeKind: "trip",
          themeKey: "probe-2024",
          titleHint: "probe",
          photoIds: ["p1"],
          toYear: 2024,
        },
        outputPath,
        metaPath,
      );
      expect(result.ok).toBe(true);

      const probe = probeMp8(outputPath);
      expect(probe, "ffprobe 应能解析产物 mp4").not.toBeNull();
      expect(probe!.width, "宽度应为 1920").toBe(1920);
      expect(probe!.height, "高度应为 1080").toBe(1080);
      expect(probe!.codec, "编码应为 h264").toBe("h264");
    });

    it("成功时返回 meta（title/durationSec/photoIds 源自 skill 写的 json）", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "ok", testMp8Template);

      const { runVideoGeneration } = await import("../lib/video/claude-runner");
      const outputPath = path.join(env.videoCacheDir, "meta-test.mp4");
      const metaPath = path.join(env.videoCacheDir, "meta-test.json");

      const result = await runVideoGeneration(
        {
          themeKind: "person",
          themeKey: "person-42-2024",
          titleHint: "人物成长线",
          photoIds: [],
          personId: "person-42",
          toYear: 2024,
        },
        outputPath,
        metaPath,
      );

      expect(result.ok).toBe(true);
      expect(result.meta, "应返回 meta").toBeDefined();
      expect(typeof result.meta!.title, "meta.title 应为 string").toBe("string");
      expect(result.meta!.title.length, "meta.title 非空").toBeGreaterThan(0);
      expect(typeof result.meta!.durationSec, "meta.durationSec 应为 number").toBe("number");
      expect(Array.isArray(result.meta!.photoIds), "meta.photoIds 应为数组").toBe(true);
    });
  });

  // ==========================================================================
  // 谓词 9：FAILURE-NO-DEGRADE（先于持久化测试建立失败语义）
  // stub exit 1 / 前置缺失 → 无 completed mp4 + 返回 err
  // ==========================================================================

  describe("FAILURE-NO-DEGRADE：runner 失败不降级、不产片", () => {
    it("claude-p 非零退出（exit 1）：返回 {ok:false, err} 且不产 mp4", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "fail", testMp8Template);

      const { runVideoGeneration } = await import("../lib/video/claude-runner");
      const outputPath = path.join(env.videoCacheDir, "fail-test.mp4");
      const metaPath = path.join(env.videoCacheDir, "fail-test.json");

      const result = await runVideoGeneration(
        {
          themeKind: "trip",
          themeKey: "fail-2024",
          titleHint: "fail",
          photoIds: ["p1"],
          toYear: 2024,
        },
        outputPath,
        metaPath,
      );

      // 契约：失败返回 {ok:false, err}
      expect(result.ok, "exit 1 应返回 ok=false").toBe(false);
      expect(result.err, "应有 err 诊断信息").toBeDefined();
      expect(result.err!.length, "err 非空").toBeGreaterThan(0);
      expect(fs.existsSync(outputPath), "失败不应留下 completed mp4").toBe(false);
    });

    it("失败时 meta 不应返回（无降级文案/无占位叙事）", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "fail", testMp8Template);

      const { runVideoGeneration } = await import("../lib/video/claude-runner");
      const outputPath = path.join(env.videoCacheDir, "fail-meta.mp4");
      const metaPath = path.join(env.videoCacheDir, "fail-meta.json");

      const result = await runVideoGeneration(
        {
          themeKind: "trip",
          themeKey: "fail-meta-2024",
          titleHint: "fail",
          photoIds: ["p1"],
          toYear: 2024,
        },
        outputPath,
        metaPath,
      );

      expect(result.ok).toBe(false);
      expect(result.meta, "失败不应返回 meta（无降级文案）").toBeUndefined();
    });

    it("前置缺失（render-immersive.mjs 不存在）：返回 {ok:false, err} 不降级不重试", async () => {
      // 删除 workspace 的 render-immersive.mjs 模拟前置缺失
      const renderScript = path.join(env.workspacePath, "render-immersive.mjs");
      const backup = `${renderScript}.bak`;
      fs.renameSync(renderScript, backup);
      try {
        holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "ok", testMp8Template);

        const { runVideoGeneration } = await import("../lib/video/claude-runner");
        const outputPath = path.join(env.videoCacheDir, "precheck-fail.mp4");
        const metaPath = path.join(env.videoCacheDir, "precheck-fail.json");

        const result = await runVideoGeneration(
          {
            themeKind: "trip",
            themeKey: "precheck-2024",
            titleHint: "precheck",
            photoIds: ["p1"],
            toYear: 2024,
          },
          outputPath,
          metaPath,
        );

        // 契约：前置缺失 → fail（不降级、不重试渲染）
        expect(result.ok, "前置缺失应返回 ok=false").toBe(false);
        expect(result.err, "应返回 err 说明缺失项").toBeDefined();
        expect(fs.existsSync(outputPath), "前置缺失不应产 mp4").toBe(false);
      } finally {
        fs.renameSync(backup, renderScript);
      }
    });
  });

  // ==========================================================================
  // 谓词 6：DB-PERSIST-WRITE-COMPLETED
  // mp4 产出后 videos 行 + video_usages 行一致 + 文件存在（事务性）
  // ==========================================================================

  describe("DB-PERSIST-WRITE-COMPLETED：落盘 + 写库一致性", () => {
    it("dailyVideoWorker 成功：videos 新增 1 行 status=completed，字段齐全 + mp4 文件存在", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "ok", testMp8Template);
      seedTripPhotos(env.sqlite, "persist");

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-persist-001") as never);

      const rows = env.sqlite
        .prepare(
          `SELECT theme_kind, theme_key, title, output_path, cover_path, duration_sec,
                  photo_ids, status, error_msg FROM videos WHERE status='completed'`,
        )
        .all() as Array<Record<string, unknown>>;

      expect(rows.length, "应新增 ≥1 行 completed").toBeGreaterThanOrEqual(1);
      const v = rows[0]!;
      expect(v.theme_kind, "theme_kind ∈ {trip,person}").toMatch(/^(trip|person)$/);
      expect(typeof v.theme_key, "theme_key 非空 string").toBe("string");
      expect((v.theme_key as string).length).toBeGreaterThan(0);
      expect(typeof v.title, "title 非空").toBe("string");
      expect((v.title as string).length).toBeGreaterThan(0);
      expect(typeof v.output_path, "output_path 非空").toBe("string");
      expect(v.status).toBe("completed");
      // 实际 mp4 文件应存在于 output_path
      expect(fs.existsSync(v.output_path as string), "output_path 指向的 mp4 文件应真实存在").toBe(
        true,
      );
    });

    it("video_usages 行与 videos 行 themeKind/themeKey 一致（跨表去重追踪）", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "ok", testMp8Template);
      seedTripPhotos(env.sqlite, "consist");

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-consist-001") as never);

      const videoRow = env.sqlite
        .prepare(`SELECT theme_kind, theme_key FROM videos WHERE status='completed' LIMIT 1`)
        .get() as { theme_kind: string; theme_key: string } | undefined;
      expect(videoRow, "应有 completed video 行").toBeDefined();

      const usageRows = env.sqlite
        .prepare("SELECT theme_kind, theme_key, photo_id FROM video_usages")
        .all() as Array<{ theme_kind: string; theme_key: string; photo_id: string }>;
      expect(usageRows.length, "应有 video_usages 行（消耗的照片）").toBeGreaterThan(0);

      // 跨表一致性：每个 usage 行的 theme_kind + theme_key 都与 video 行一致
      for (const u of usageRows) {
        expect(u.theme_kind, "usage.theme_kind 与 video 一致").toBe(videoRow!.theme_kind);
        expect(u.theme_key, "usage.theme_key 与 video 一致").toBe(videoRow!.theme_key);
      }
    });

    it("失败路径：dailyVideoWorker 写 failed 行（status=failed + error_msg 非空）且无 completed", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "fail", testMp8Template);
      seedTripPhotos(env.sqlite, "faildb");

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-fail-001") as never);

      const failedRows = env.sqlite
        .prepare(`SELECT status, error_msg FROM videos WHERE status='failed'`)
        .all() as Array<{ status: string; error_msg: string | null }>;
      expect(failedRows.length, "应有 failed 行记录诊断").toBeGreaterThanOrEqual(1);
      const f = failedRows[0]!;
      expect(f.error_msg, "failed 行 error_msg 非空").toBeTruthy();
      expect((f.error_msg ?? "").length).toBeGreaterThan(0);

      const completedCount = (
        env.sqlite.prepare(`SELECT COUNT(*) as c FROM videos WHERE status='completed'`).get() as {
          c: number;
        }
      ).c;
      expect(completedCount, "失败不应留下 completed 行").toBe(0);
    });

    it("事务性：失败时 video_usages 不应写入半成品（无孤儿 usage 行）", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "fail", testMp8Template);
      seedTripPhotos(env.sqlite, "tx");

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-tx-001") as never);

      // 契约：事务性——失败时 video_usages 不应留下半成品
      // （video_usages 只在成功事务内写入，与 videos completed 行同生共死）
      const usageCount = (
        env.sqlite.prepare("SELECT COUNT(*) as c FROM video_usages").get() as { c: number }
      ).c;
      expect(usageCount, "失败事务不应写 video_usages（无孤儿行）").toBe(0);
    });

    it("无降级短片：失败时不产任何新 .mp4 文件（video-cache 无新增 completed 产物）", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "fail", testMp8Template);
      seedTripPhotos(env.sqlite, "nodegrade");

      // 记录失败前 video-cache 目录的 mp4 数
      const beforeMp8s = fs.readdirSync(env.videoCacheDir).filter((f) => f.endsWith(".mp4"));

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-nodegrade-001") as never);

      const afterMp8s = fs.readdirSync(env.videoCacheDir).filter((f) => f.endsWith(".mp4"));
      // 契约：失败不应在 video-cache 留下任何新 mp4（无降级短片/占位片）
      expect(afterMp8s.length, "失败不应产新 mp4（无降级短片）").toBe(beforeMp8s.length);
    });
  });

  // ==========================================================================
  // 谓词 7：WECOM-PUSH-ON-NEW-VIDEO
  // completed 后 mock webhook 收到 ≥1 次 POST（文字消息：title + 视频链接；封面不再推群——首帧文字卡不好看）
  // 复用本文件已有的真实 DB + worker + wechatMocks 环境（dailyVideoWorker 成功路径触发推送）
  // ==========================================================================

  describe("WECOM-PUSH-ON-NEW-VIDEO：新视频 completed → 推企业微信", () => {
    it("成功完成视频后 sendWeComText 至少调用 1 次（推文字消息：标题+视频链接）", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "ok", testMp8Template);
      seedTripPhotos(env.sqlite, "push7");

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-push7-001") as never);

      // 契约：completed 后推送文字消息（封面不再推群——首帧文字卡不好看）
      expect(
        wechatMocks.sendWeComText,
        "completed 后应调用 sendWeComText 推文字消息",
      ).toHaveBeenCalled();
      expect(
        wechatMocks.sendWeComText.mock.calls.length,
        "至少 1 次文字 POST",
      ).toBeGreaterThanOrEqual(1);
      // 封面不再推送：sendWallpaperToWeCom 不应被调用
      expect(wechatMocks.sendWallpaperToWeCom).not.toHaveBeenCalled();
    });

    it("推送的 webhook URL = settings.webhook（企业微信群机器人 URL 透传）", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "ok", testMp8Template);
      seedTripPhotos(env.sqlite, "push7url");

      const expectedWebhook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-token-001";

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-push7-url") as never);

      expect(wechatMocks.sendWeComText.mock.calls.length).toBeGreaterThanOrEqual(1);
      // 文字消息第一次调用的首参应严格等于 settings.webhook
      const firstCallUrl = wechatMocks.sendWeComText.mock.calls[0]?.[0] as string;
      expect(firstCallUrl, "webhook URL 应透传 settings.webhook").toBe(expectedWebhook);
    });

    it("文字消息内容含「新视频」前缀 + 视频链接（galleryPublicUrl/#/video/<id>）", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "ok", testMp8Template);
      seedTripPhotos(env.sqlite, "push7buf");

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-push7-buf") as never);

      expect(wechatMocks.sendWeComText.mock.calls.length).toBeGreaterThanOrEqual(1);
      const content = wechatMocks.sendWeComText.mock.calls[0]?.[1] as string;
      expect(content, "含「新视频」前缀").toContain("新视频");
      expect(content, "含视频链接路径 /#/video/").toContain("/#/video/");
    });

    it("封面已去掉：compressForWeCom / sendWallpaperToWeCom 都不应被调用", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "ok", testMp8Template);
      seedTripPhotos(env.sqlite, "push7compress");

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-push7-compress") as never);

      // 封面不再推群：压缩与图片发送都不应触发
      expect(wechatMocks.compressForWeCom, "封面去掉后不应再压缩").not.toHaveBeenCalled();
      expect(wechatMocks.sendWallpaperToWeCom, "封面去掉后不应再推图").not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 谓词 8（本文件部分）：失败路径不推送
  // 完整的「无候选不推送」在 video-push-and-api.acceptance.test.ts，
  // 这里补强「候选存在但渲染失败 → 不推送」（同一 worker 上下文）
  // ==========================================================================

  describe("NO-PUSH-ON-FAILURE：claude-p 失败时不推送（谓词 8 失败分支）", () => {
    it("claude-p exit 1 → sendWallpaperToWeCom 调用 0 次", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "fail", testMp8Template);
      seedTripPhotos(env.sqlite, "nopush8fail");

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-nopush8-fail") as never);

      // 契约：失败不出片 → 不推送
      expect(wechatMocks.sendWallpaperToWeCom, "失败不应触发推送").not.toHaveBeenCalled();
      expect(wechatMocks.sendWallpaperToWeCom.mock.calls.length, "webhook POST 次数应为 0").toBe(0);
    });

    it("claude-p exit 1 也不应调 compressForWeCom（前置短路）", async () => {
      holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, "fail", testMp8Template);
      seedTripPhotos(env.sqlite, "nopush8compress");

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-nopush8-compress") as never);

      expect(wechatMocks.compressForWeCom, "失败不应触发压缩（无封面要推）").not.toHaveBeenCalled();
    });
  });
});

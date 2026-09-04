/**
 * 验收测试（红队）：daily-video 推送深链 URL 必须用 themeKey（谓词 DL.V1）
 *
 * 设计契约来源（state.md §背景 / §根因 V1 / §契约规约 4 / §验收场景 DL.V1）：
 *   - 背景：企微视频推送深链 `galleryPublicUrl/#/video/<id>` 打开后定位不到视频。
 *   - 根因 V1：推送 URL 用 videos 表 DB id（UUID），而画廊前端单元 data-video-id 是 themeKey
 *     → 永远匹配不到 → 静默留顶。
 *   - 契约规约 4：`videoUrl = config.galleryPublicUrl + "/#/video/" + themeKey`；
 *     消息文本格式 `🎬 新视频：${titleHint}\n观看：${videoUrl}`。
 *
 * 谓词 DL.V1 [det-machine]：
 *   observe: vitest 捕获 sendWeComText 的消息内容（真实跑 dailyVideoWorker，mock wechat 出口）
 *   assert:  消息含 `#/video/<themeKey>`，且 URL id 段不匹配 UUID 形态
 *            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
 *
 * 与既有测试的边界（兼容红线，不重复覆盖）：
 *   - daily-video-url.acceptance.test.ts 已做源码文本静态断言（config.galleryPublicUrl /
 *     videoId 标识符 / #/video/ hash 路由）；本文件做**行为级**断言：真实跑 worker、
 *     捕获推送文本、与 DB 落库行 theme_key 逐一比对——能杀死「只把域名换公网、id 段仍用
 *     videos.id（UUID）」的 no-op mutation（静态文本断言杀不死）。
 *
 * 驱动机制（沿用 video-claude-runner-and-persist.acceptance.test.ts harness）：
 *   - 真实 SQLite（临时文件）+ 真实 schema（setupTestSchema）+ 真实 spawn fake claude 脚本
 *   - mock ../lib/config（galleryPublicUrl 指到测试域，避免断言依赖真实生产域名）
 *   - mock ../lib/push/wechat + ../lib/push/wechat-text 捕获推送内容（防真实 HTTP）
 *   - mock node:os.homedir + config.memoryVideoSkillPath 让 SKILL.md 前置校验命中临时目录
 *
 * 红队铁律：不读 jobs/daily-video.ts 实现源码（仅按 export 契约 dailyVideoWorker(job) 驱动）；
 *   每个 it 含 expect.* 硬断言，失败必挂；无 skip / warn-soft-pass。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

/** UUID 形态（DL.V1 断言字面量：URL id 段不得是 UUID） */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

// ============================================================================
// hoisted holder：vi.mock factory 与 beforeAll 之间共享（vitest 禁止 factory 引用外层 let）
// ============================================================================

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  workspacePath: "/tmp/relight-none",
  fakeClaudePath: "/usr/bin/false",
  storageRoot: "/tmp/relight-none",
  tmpRoot: "/tmp/relight-none",
  galleryPublicUrl: "https://gallery-deeplink.example.com",
}));

// mock config（daily-video 读 config.galleryPublicUrl 构造推送 URL；claude-runner/db 同步注入）
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
    get memoryVideoSkillPath() {
      return path.join(holder.tmpRoot, ".claude/skills/memory-video/SKILL.md");
    },
    galleryPublicUrl: holder.galleryPublicUrl,
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-video-deeplink-test",
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

// mock HOME：SKILL.md 前置校验由 config.memoryVideoSkillPath getter 指向临时目录
// （2026-09-04 skill 迁入仓库 .claude/skills/）；spawn env 的 HOME 同步走 homedir()
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => holder.tmpRoot,
  };
});

// mock db：holder.dbPath 上的唯一 drizzle 连接（避免 WAL 多连接 read-isolation flaky）
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

// mock wechat 出口：捕获推送文本（DL.V1 的 observe 通道），防真实 HTTP
const wechatMocks = vi.hoisted(() => ({
  sendWallpaperToWeCom: vi.fn(async (_url: string, _imageBuffer: Buffer) => ({
    errcode: 0,
    errmsg: "ok",
  })),
  compressForWeCom: vi.fn(async (buf: Buffer) => buf),
  getDailyPushSettings: vi.fn(async () => ({
    webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-token-dlv1",
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
// 临时环境（真实 SQLite + fake claude 可 spawn）
// ============================================================================

interface RunnerEnv {
  tmpRoot: string;
  dbPath: string;
  storageRoot: string;
  videoCacheDir: string;
  workspacePath: string;
  sqlite: Database.Database;
}

function ffprobeAvailable(): boolean {
  try {
    const r = spawnSync("ffprobe", ["-version"], { encoding: "utf-8", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}
const HAS_FFPROBE = ffprobeAvailable();

function createRunnerEnv(): RunnerEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), ".relight-test-dlv1-"));
  const dbPath = path.join(tmpRoot, "test.db");
  const storageRoot = path.join(tmpRoot, "storage");
  const videoCacheDir = path.join(storageRoot, ".video-cache");
  const workspacePath = path.join(tmpRoot, "workspace");
  fs.mkdirSync(videoCacheDir, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });

  // spawn 前置三存在校验所需文件
  fs.mkdirSync(path.join(workspacePath, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "render-immersive.mjs"), "// test stub");
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
  `);
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES ('src-dlv1', '测试', 'local', ?, 1)`,
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

/** 生成真实 1920x1080 H264 测试 mp4（fake claude 的产物模板，保证 Chromium/校验可消费） */
function generateTestMp4(outPath: string): boolean {
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

/** fake claude：exit 0 并产出 mp4 + meta json（成功路径触发推送） */
function writeFakeClaude(tmpRoot: string, template: string): string {
  const scriptPath = path.join(tmpRoot, `fake-claude-ok-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh
set -e
cp "${template}" "$OUTPUT_PATH"
cat > "$META_PATH" <<'EOF'
{"title":"深链推送测试视频","durationSec":60,"photoIds":["p1","p2","p3"]}
EOF
exit 0
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

/** 植入旅行素材（重庆 GPS，连续天）——discovery 命中 trip 分支 */
function seedTripPhotos(sqlite: Database.Database, prefix: string, count = 21): void {
  const baseDate = new Date("2024-09-10T10:00:00Z").getTime();
  const stmt = sqlite.prepare(
    `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height,
                         file_size, thumbnail_path, taken_at, created_at, media_type,
                         latitude, longitude)
     VALUES (?, 'src-dlv1', ?, ?, 1920, 1080, 1024, ?, ?, ?, 'image', ?, ?)`,
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

/** mock BullMQ Job（dailyVideoWorker 只用 data/log/updateProgress） */
function makeJob(id: string, data: Record<string, unknown> = {}): unknown {
  return {
    data,
    id,
    name: "daily-video-cron",
    log: () => {},
    updateProgress: () => {},
  };
}

interface VideoRow {
  id: string;
  theme_key: string;
  theme_kind: string;
  title: string;
}

// ============================================================================
// 测试套件：DL.V1
// ============================================================================

describe("DL.V1：daily-video 推送观看 URL 用 themeKey（非 DB UUID id）", () => {
  let env: RunnerEnv;
  let testMp4Template: string;

  beforeAll(() => {
    // 红队铁律：ffmpeg 缺失直接 fail（项目要求 ffmpeg≥4.0），不 silent skip
    expect(HAS_FFPROBE, "ffprobe 不可用：项目要求 ffmpeg≥4.0，请 brew install ffmpeg").toBe(true);

    env = createRunnerEnv();
    holder.dbPath = env.dbPath;
    holder.workspacePath = env.workspacePath;
    holder.storageRoot = env.storageRoot;
    holder.tmpRoot = env.tmpRoot;

    testMp4Template = path.join(env.tmpRoot, "template.mp4");
    expect(generateTestMp4(testMp4Template), "ffmpeg 应能生成测试 mp4 模板").toBe(true);
  });

  afterAll(() => {
    disposeRunnerEnv(env);
  });

  beforeEach(() => {
    for (const tbl of ["video_usages", "videos", "faces", "persons", "photo_analyses", "photos"]) {
      env.sqlite.exec(`DELETE FROM ${tbl};`);
    }
    wechatMocks.sendWeComText.mockClear();
    wechatMocks.sendWallpaperToWeCom.mockClear();
    wechatMocks.compressForWeCom.mockClear();
    wechatMocks.getDailyPushSettings.mockClear();
  });

  /** 跑一次 worker 并返回（推送文本, 落库 completed 行）——所有断言的前置观测 */
  async function runWorkerAndCapture(): Promise<{ contents: string[]; row: VideoRow }> {
    holder.fakeClaudePath = writeFakeClaude(env.tmpRoot, testMp4Template);
    seedTripPhotos(env.sqlite, "dlv1");

    const { dailyVideoWorker } = await import("../jobs/daily-video");
    await dailyVideoWorker(makeJob("job-dlv1-001") as never);

    const contents = wechatMocks.sendWeComText.mock.calls.map((c) => String(c[1] ?? ""));
    expect(
      contents.length,
      "completed 后应调用 sendWeComText 推文字消息（无推送则 URL 契约无从谈起）",
    ).toBeGreaterThanOrEqual(1);

    const rows = env.sqlite
      .prepare(
        `SELECT id, theme_key, theme_kind, title FROM videos WHERE status='completed'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .all() as VideoRow[];
    expect(rows.length, "应有 completed 视频行（推送必须对应本次真实产出）").toBeGreaterThanOrEqual(
      1,
    );

    // 求值产物（沿用红队 /tmp/autopilot-artifacts 约定；写失败不影响断言）
    try {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(ARTIFACT_DIR, "DL.V1.out"),
        JSON.stringify(
          {
            galleryPublicUrl: holder.galleryPublicUrl,
            completedRow: rows[0],
            pushes: wechatMocks.sendWeComText.mock.calls.map((c) => ({
              webhook: c[0],
              content: c[1],
            })),
          },
          null,
          2,
        ),
      );
    } catch {
      // ignore（断言全部在 expect 中）
    }

    return { contents, row: rows[0]! };
  }

  it("DL.V1.1 推送文本含「观看：」行，URL 精确等于 galleryPublicUrl + '/#/video/' + themeKey", async () => {
    const { contents, row } = await runWorkerAndCapture();

    // 消息格式契约：`🎬 新视频：${titleHint}\n观看：${videoUrl}`
    const withNewVideo = contents.filter((c) => c.includes("新视频"));
    expect(withNewVideo.length, "推送文本应含「新视频」前缀").toBeGreaterThanOrEqual(1);
    const content = withNewVideo[0]!;

    const watchLine = content.split("\n").find((l) => l.includes("观看："));
    expect(
      watchLine,
      `推送文本应含「观看：<url>」行，实际=${JSON.stringify(content)}`,
    ).toBeDefined();
    const url = (watchLine as string).split("观看：")[1]!.trim();
    expect(url, "观看：后应为 http(s) URL").toMatch(/^https?:\/\//);

    const expected = `${holder.galleryPublicUrl}/#/video/${row.theme_key}`;
    expect(url, `videoUrl 应精确等于契约形态 ${expected}（实测 ${url}）`).toBe(expected);
  });

  it("DL.V1.2 URL id 段 == themeKey 且不匹配 UUID 形态（杀「仍用 videos.id」no-op mutation）", async () => {
    const { contents, row } = await runWorkerAndCapture();

    const withUrl = contents.filter((c) => c.includes("#/video/"));
    expect(withUrl.length, "推送文本应含 #/video/ 深链").toBeGreaterThanOrEqual(1);
    const url = (withUrl[0] as string)
      .split("\n")
      .find((l) => l.includes("#/video/"))!
      .trim();

    const idSegment = url.split("/#/video/")[1] ?? "";
    expect(idSegment.length, `URL 应含 #/video/<id> 段（实测 ${url}）`).toBeGreaterThan(0);
    expect(idSegment, "URL id 段必须等于落库行 theme_key").toBe(row.theme_key);
    expect(
      idSegment,
      `URL id 段不得是 UUID 形态（根因 V1：DB id 与前端 data-video-id=themeKey 永不匹配），实际=${idSegment}`,
    ).not.toMatch(UUID_RE);
    expect(url, "整条 URL 不得出现任何 UUID（防 id 段之外的 UUID 拼接）").not.toMatch(UUID_RE);
    expect(url, `URL 不得包含 videos 表 DB id（${row.id}）——那是 V1 根因本身`).not.toContain(
      row.id,
    );
  });

  it("DL.V1.3 每一条含深链的推送文本都满足 themeKey 契约（防多条推送里夹带旧 URL）", async () => {
    const { contents, row } = await runWorkerAndCapture();

    const deepLinked = contents.filter((c) => c.includes("#/video/"));
    expect(deepLinked.length, "应至少有 1 条含深链的推送").toBeGreaterThanOrEqual(1);

    for (const content of deepLinked) {
      const line = content.split("\n").find((l) => l.includes("#/video/"));
      expect(line, "深链应独立成行（观看：<url>）").toBeDefined();
      const url = (line as string).split("观看：")[1]?.trim() ?? "";
      expect(
        url,
        `每条推送 URL 都必须是 ${holder.galleryPublicUrl}/#/video/${row.theme_key}，实际=${url}`,
      ).toBe(`${holder.galleryPublicUrl}/#/video/${row.theme_key}`);
      expect(url).not.toMatch(UUID_RE);
    }
  });

  it("DL.V2 推送标题优先 skill 写出的 meta.title（vietnam-2026 教训：titleHint 仅兜底）", async () => {
    const { contents } = await runWorkerAndCapture();

    const withTitle = contents.filter((c) => c.includes("新视频"));
    expect(withTitle.length, "应有一条「新视频」推送").toBeGreaterThanOrEqual(1);
    const titleLine = withTitle[0]!.split("\n")[0]!;

    // fake claude 的 meta.json title = "深链推送测试视频"——推送必须用它
    expect(titleLine, `推送标题行应是 meta.title（实测 ${JSON.stringify(titleLine)}）`).toContain(
      "深链推送测试视频",
    );
    expect(
      titleLine,
      "推送标题行不得再用 GPS 围栏推断的 titleHint（trip titleHint 含 region 中文名「重庆·川南」）",
    ).not.toContain("重庆");
  });
});

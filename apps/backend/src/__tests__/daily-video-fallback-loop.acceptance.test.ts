/**
 * 验收测试：daily-video 拒做顺延循环（2026-09-28 顺延层）
 *
 * 契约（design.md L1 / experiments/REPORT.md 实验 1）：
 *   F1 拒做顺延：skill exit 2（协议化拒做）→ 写 failed 行 → 顺延下一个候选 →
 *      后续候选成功 → completed 落库（一天不因单个脏簇烧掉）
 *   F2 非拒做中止：exit 1（崩溃/基础设施失败，超时同理）→ 写 failed 行 → 当天中止，
 *      不再调用 spawn（45min 级成本不连环烧）
 *   F3 全拒耗尽：所有候选都 exit 2 → 全部落 failed 行（自动进 7 天冷却）→ 正常结束不推送
 *   F4 isSkillRejection 分类：exit 2 / mp4 产物缺失 = 拒做；超时 / 其他退出码 = 非拒做
 *
 * 驱动机制（沿用 video-claude-runner-and-persist harness）：
 *   - 真实 SQLite（临时文件）+ 真实 schema（setupTestSchema）+ 真实 discovery
 *     （种两个不同月GPS 旅行簇 → 新鲜度降序 = 先新后旧）+ fake claude 脚本带调用计数
 *
 * 红队铁律：不读 jobs/daily-video.ts 实现源码（按 export 契约 dailyVideoWorker(job) 驱动）；
 *   每个 it 含 expect.* 硬断言；无 skip / warn-soft-pass。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

const HAS_FFPROBE = (() => {
  try {
    const r = spawnSync("ffprobe", ["-version"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
})();

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  workspacePath: "/tmp/relight-none",
  fakeClaudePath: "/usr/bin/false",
  storageRoot: "/tmp/relight-none",
  tmpRoot: "/tmp/relight-none",
}));

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
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-video-fallback-test",
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

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => holder.tmpRoot,
  };
});

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

const wechatMocks = vi.hoisted(() => ({
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
    getDailyPushSettings: wechatMocks.getDailyPushSettings,
  };
});
vi.mock("../lib/push/wechat-text", () => ({
  sendWeComText: wechatMocks.sendWeComText,
}));

interface FallbackEnv {
  tmpRoot: string;
  dbPath: string;
  storageRoot: string;
  videoCacheDir: string;
  workspacePath: string;
  sqlite: Database.Database;
  counterPath: string;
}

function createFallbackEnv(): FallbackEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-videofb-"));
  const dbPath = path.join(tmpRoot, "test.db");
  const storageRoot = path.join(tmpRoot, "storage");
  const videoCacheDir = path.join(storageRoot, ".video-cache");
  const workspacePath = path.join(tmpRoot, "workspace");
  fs.mkdirSync(videoCacheDir, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
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
    CREATE TABLE IF NOT EXISTS video_theme_pool (
      id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      why TEXT, arc TEXT, confidence TEXT NOT NULL, photo_ids TEXT, selection_hint TEXT,
      status TEXT NOT NULL DEFAULT 'active', video_id TEXT,
      proposed_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(kind, title)
    );
    CREATE TABLE IF NOT EXISTS video_usages (
      id TEXT PRIMARY KEY, theme_kind TEXT NOT NULL, theme_key TEXT NOT NULL,
      photo_id TEXT NOT NULL, consumed_at TEXT NOT NULL
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES ('src-test', '测试', 'local', ?, 1)`,
    )
    .run(storageRoot);

  return {
    tmpRoot,
    dbPath,
    storageRoot,
    videoCacheDir,
    workspacePath,
    sqlite,
    counterPath: path.join(tmpRoot, "invocations"),
  };
}

function disposeFallbackEnv(env: FallbackEnv): void {
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

function generateTestMp4(outPath: string): boolean {
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

/**
 * fake claude：带调用计数的三种行为模式。
 * counter 文件每次调用 +1；按模式决定 exit 2（拒做）/ exit 1（崩溃）/ 产 mp4。
 */
function writeCountingFakeClaude(
  env: FallbackEnv,
  mode: "reject-then-ok" | "always-reject" | "always-crash",
  mp4Template: string,
): string {
  const scriptPath = path.join(
    env.tmpRoot,
    `fake-claude-${mode}-${Math.random().toString(36).slice(2)}.sh`,
  );
  const counter = env.counterPath;
  const body = `#!/bin/sh
n=$(cat "${counter}" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "${counter}"
${
  mode === "always-crash"
    ? `echo "claude-p: 渲染崩溃" >&2
exit 1`
    : mode === "always-reject"
      ? `echo "拒做：素材身份错乱，不做" >&2
exit 2`
      : `if [ "$n" -le 1 ]; then
  echo "拒做：素材身份错乱，不做" >&2
  exit 2
fi
cp "${mp4Template}" "$OUTPUT_PATH"
cat > "$META_PATH" <<'EOF'
{"title":"第二个主题成片","durationSec":60,"photoIds":["p1"]}
EOF
exit 0`
}
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

function invocationCount(env: FallbackEnv): number {
  try {
    return Number.parseInt(fs.readFileSync(env.counterPath, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** 种旅行簇：lat29.5 lng106.5（重庆围栏），baseDate 起每天 1 张 × count（连 21 天） */
function seedTrip(sqlite: Database.Database, prefix: string, baseIso: string): void {
  const base = new Date(baseIso).getTime();
  const stmt = sqlite.prepare(
    `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height,
                         file_size, thumbnail_path, taken_at, created_at, media_type,
                         latitude, longitude)
     VALUES (?, 'src-test', ?, ?, 1920, 1080, 1024, ?, ?, ?, 'image', 29.5, 106.5)`,
  );
  for (let i = 0; i < 21; i++) {
    stmt.run(
      `${prefix}-${i}`,
      `photos/${prefix}-${i}.jpg`,
      `h-${prefix}-${i}-${Math.random().toString(36).slice(2)}`,
      `/tmp/t-${prefix}-${i}.jpg`,
      new Date(base + i * 86_400_000).toISOString(),
      new Date().toISOString(),
    );
  }
}

function makeJob(id: string): unknown {
  return { data: {}, id, name: "daily-video-cron", log: () => {}, updateProgress: () => {} };
}

describe("daily-video 拒做顺延循环 — 验收测试（F1~F4）", () => {
  let env: FallbackEnv;
  let mp4Template: string;

  beforeAll(() => {
    expect(HAS_FFPROBE, "ffprobe 不可用：项目要求 ffmpeg≥4.0").toBe(true);
    env = createFallbackEnv();
    holder.dbPath = env.dbPath;
    holder.workspacePath = env.workspacePath;
    holder.storageRoot = env.storageRoot;
    holder.tmpRoot = env.tmpRoot;
    mp4Template = path.join(env.tmpRoot, "template.mp4");
    expect(generateTestMp4(mp4Template), "ffmpeg 应能生成测试 mp4 模板").toBe(true);
  });

  afterAll(() => {
    disposeFallbackEnv(env);
  });

  beforeEach(() => {
    for (const tbl of ["video_usages", "videos", "faces", "persons", "photo_analyses", "photos"]) {
      env.sqlite.exec(`DELETE FROM ${tbl};`);
    }
    fs.rmSync(env.counterPath, { force: true });
    wechatMocks.sendWeComText.mockClear();
    wechatMocks.getDailyPushSettings.mockClear();
  });

  it("F4 isSkillRejection：exit 2 / mp4 产物缺失 = 拒做；超时 / exit 1 / 空 = 非拒做", async () => {
    const { isSkillRejection } = await import("../jobs/daily-video");
    expect(isSkillRejection("claude -p 退出码 2（stderr=拒做 | stdout=…）")).toBe(true);
    expect(isSkillRejection("mp4 产物缺失: /x/y.mp4（stdout=…）")).toBe(true);
    expect(isSkillRejection("claude -p 超时（2700000ms）")).toBe(false);
    expect(isSkillRejection("claude -p 退出码 1（stderr=crash | stdout=…）")).toBe(false);
    expect(isSkillRejection("spawn 前置缺失: node_modules")).toBe(false);
    expect(isSkillRejection(undefined)).toBe(false);
  });

  it("F1 拒做顺延：第 1 候选 exit 2 → failed 行 → 第 2 候选成功 → completed + 单次推送", async () => {
    // 新鲜度：10 月簇 > 9 月簇 → discovery 先试 10 月
    seedTrip(env.sqlite, "tripA", "2024-10-10T10:00:00Z");
    seedTrip(env.sqlite, "tripB", "2024-09-10T10:00:00Z");
    holder.fakeClaudePath = writeCountingFakeClaude(env, "reject-then-ok", mp4Template);

    const { dailyVideoWorker } = await import("../jobs/daily-video");
    await dailyVideoWorker(makeJob("fb-f1") as never);

    expect(invocationCount(env), "应恰好 spawn 两次（拒 1 + 成 1）").toBe(2);

    const rows = env.sqlite
      .prepare("SELECT theme_key, status, error_msg FROM videos ORDER BY status")
      .all() as Array<{ theme_key: string; status: string; error_msg: string | null }>;
    expect(rows, "两个候选都应落库（一 failed 一 completed）").toHaveLength(2);

    const failed = rows.filter((r) => r.status === "failed");
    const completed = rows.filter((r) => r.status === "completed");
    expect(failed, "恰好 1 条 failed").toHaveLength(1);
    expect(completed, "恰好 1 条 completed").toHaveLength(1);
    // 顺序断言：新鲜度最高的 10 月簇先被拒
    expect(failed[0]!.theme_key, "先试的新簇应是被拒的").toMatch(/202410/);
    expect(failed[0]!.error_msg ?? "", "failed 行应记录 exit 2 拒做").toContain("退出码 2");
    expect(completed[0]!.theme_key, "后试的旧簇应完成").toMatch(/202409/);

    expect(wechatMocks.sendWeComText.mock.calls.length, "成功后应推送一次").toBe(1);
  });

  it("F2 非拒做中止：第 1 候选 exit 1 → failed 行 → 当天中止不试第 2 候选", async () => {
    seedTrip(env.sqlite, "tripA", "2024-10-10T10:00:00Z");
    seedTrip(env.sqlite, "tripB", "2024-09-10T10:00:00Z");
    holder.fakeClaudePath = writeCountingFakeClaude(env, "always-crash", mp4Template);

    const { dailyVideoWorker } = await import("../jobs/daily-video");
    await dailyVideoWorker(makeJob("fb-f2") as never);

    expect(invocationCount(env), "只应 spawn 一次（非拒做当天中止）").toBe(1);
    const rows = env.sqlite.prepare("SELECT theme_key, status FROM videos").all() as Array<{
      theme_key: string;
      status: string;
    }>;
    expect(rows, "只有首个候选落 failed 行").toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(wechatMocks.sendWeComText.mock.calls.length, "无成片不推送").toBe(0);
  });

  it("F3 全拒耗尽：两个候选都 exit 2 → 全部落 failed 行 → 正常结束", async () => {
    seedTrip(env.sqlite, "tripA", "2024-10-10T10:00:00Z");
    seedTrip(env.sqlite, "tripB", "2024-09-10T10:00:00Z");
    holder.fakeClaudePath = writeCountingFakeClaude(env, "always-reject", mp4Template);

    const { dailyVideoWorker } = await import("../jobs/daily-video");
    await dailyVideoWorker(makeJob("fb-f3") as never);

    expect(invocationCount(env), "两个候选都应被试过").toBe(2);
    const rows = env.sqlite
      .prepare("SELECT theme_key, status FROM videos ORDER BY theme_key")
      .all() as Array<{ theme_key: string; status: string }>;
    expect(rows, "两个候选都落 failed 行（进 7 天冷却）").toHaveLength(2);
    expect(
      rows.every((r) => r.status === "failed"),
      "全部 status=failed",
    ).toBe(true);
    expect(wechatMocks.sendWeComText.mock.calls.length, "无成片不推送").toBe(0);
  });
});

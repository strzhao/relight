/**
 * 验收测试：daily-video 消费 AI 策展候选池（2026-09-28 策展层 L2）
 *
 * 契约（design.md L2 / experiments/REPORT.md 实验 3）：
 *   P1 池优先：active 硬候选（photoIds ≥12）先于 discovery 消费；成功 →
 *      video 行 themeKey=curator-<id8> + 池行 status=done 且回链 videoId
 *   P2 池拒做顺延：池候选被拒 → 池行 status=rejected → 继续消费 discovery 候选
 *   P3 软候选跳过：photoIds <12 的 active 池行不被消费（保持 active），discovery 照常
 *   P4 池候选非拒做失败 → 池行 status=expired（毒候选不挡明天的名额）+ 当天中止
 *
 * 驱动机制：真实 SQLite + 真实 discovery（种 GPS 旅行簇）+ fake claude 计数脚本
 * （沿用 daily-video-fallback-loop harness 模式）。
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
    bullmqPrefix: "bull-video-pool-test",
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

interface PoolEnv {
  tmpRoot: string;
  dbPath: string;
  storageRoot: string;
  videoCacheDir: string;
  workspacePath: string;
  sqlite: Database.Database;
  counterPath: string;
}

function createPoolEnv(): PoolEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-videopool-"));
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
    CREATE TABLE IF NOT EXISTS video_usages (
      id TEXT PRIMARY KEY, theme_kind TEXT NOT NULL, theme_key TEXT NOT NULL,
      photo_id TEXT NOT NULL, consumed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_theme_pool (
      id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      why TEXT, arc TEXT, confidence TEXT NOT NULL, photo_ids TEXT, selection_hint TEXT,
      status TEXT NOT NULL DEFAULT 'active', video_id TEXT,
      proposed_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(kind, title)
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

function disposePoolEnv(env: PoolEnv): void {
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

function writeCountingFakeClaude(
  env: PoolEnv,
  mode: "reject-then-ok" | "always-reject" | "always-crash" | "ok",
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
      : mode === "ok"
        ? `cp "${mp4Template}" "$OUTPUT_PATH"
cat > "$META_PATH" <<'EOF'
{"title":"池候选成片","durationSec":60,"photoIds":["p1"]}
EOF
exit 0`
        : `if [ "$n" -le 1 ]; then
  echo "拒做：素材身份错乱，不做" >&2
  exit 2
fi
cp "${mp4Template}" "$OUTPUT_PATH"
cat > "$META_PATH" <<'EOF'
{"title":"兜底成片","durationSec":60,"photoIds":["p1"]}
EOF
exit 0`
}
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

function invocationCount(env: PoolEnv): number {
  try {
    return Number.parseInt(fs.readFileSync(env.counterPath, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** 种池候选行（photoIds 指向真实 photos 行，供 spawn prompt；存在性由池语义保证不校验） */
function seedPoolRow(
  env: PoolEnv,
  opts: {
    kind: string;
    title: string;
    photoCount: number;
    confidence?: string;
    proposedAt: string;
  },
): string {
  const id = crypto.randomUUID();
  const photoIds = Array.from({ length: opts.photoCount }, (_, i) => `pool-ph-${i}`);
  env.sqlite
    .prepare(
      `INSERT INTO video_theme_pool (id, kind, title, why, arc, confidence, photo_ids, selection_hint,
                                     status, proposed_at, updated_at)
       VALUES (?, ?, ?, 'why', 'arc', ?, ?, NULL, 'active', ?, ?)`,
    )
    .run(
      id,
      opts.kind,
      opts.title,
      opts.confidence ?? "high",
      JSON.stringify(photoIds),
      opts.proposedAt,
      opts.proposedAt,
    );
  return id;
}

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

describe("daily-video 消费 AI 策展候选池 — 验收测试（P1~P4）", () => {
  let env: PoolEnv;
  let mp4Template: string;

  beforeAll(() => {
    expect(HAS_FFPROBE, "ffprobe 不可用：项目要求 ffmpeg≥4.0").toBe(true);
    env = createPoolEnv();
    holder.dbPath = env.dbPath;
    holder.workspacePath = env.workspacePath;
    holder.storageRoot = env.storageRoot;
    holder.tmpRoot = env.tmpRoot;
    mp4Template = path.join(env.tmpRoot, "template.mp4");
    expect(generateTestMp4(mp4Template), "ffmpeg 应能生成测试 mp4 模板").toBe(true);
  });

  afterAll(() => {
    disposePoolEnv(env);
  });

  beforeEach(() => {
    for (const tbl of [
      "video_usages",
      "videos",
      "video_theme_pool",
      "faces",
      "persons",
      "photo_analyses",
      "photos",
    ]) {
      env.sqlite.exec(`DELETE FROM ${tbl};`);
    }
    fs.rmSync(env.counterPath, { force: true });
    wechatMocks.sendWeComText.mockClear();
    wechatMocks.getDailyPushSettings.mockClear();
  });

  it("P1 池优先：active 硬候选先消费，成功 → curator 视频行 + 池行 done 回链 videoId", async () => {
    const poolId = seedPoolRow(env, {
      kind: "recurring_event",
      title: "岁岁团圆 · 老家的春节",
      photoCount: 13,
      proposedAt: "2026-09-22T01:20:00.000Z",
    });
    seedTrip(env.sqlite, "tripA", "2024-10-10T10:00:00Z");
    holder.fakeClaudePath = writeCountingFakeClaude(env, "ok", mp4Template);

    const { dailyVideoWorker } = await import("../jobs/daily-video");
    await dailyVideoWorker(makeJob("pool-p1") as never);

    expect(invocationCount(env), "池候选先行且成功 → 只 spawn 一次").toBe(1);
    const video = env.sqlite.prepare("SELECT theme_kind, theme_key, status FROM videos").get() as {
      theme_kind: string;
      theme_key: string;
      status: string;
    };
    expect(video.theme_kind, "池候选视频 theme_kind=curator").toBe("curator");
    expect(video.theme_key, "themeKey=curator-<poolId8>").toBe(`curator-${poolId.slice(0, 8)}`);
    expect(video.status).toBe("completed");
    const pool = env.sqlite
      .prepare("SELECT status, video_id FROM video_theme_pool WHERE id = ?")
      .get(poolId) as { status: string; video_id: string | null };
    expect(pool.status, "池行置 done").toBe("done");
    expect(pool.video_id, "池行回链 videoId").toBe(
      env.sqlite.prepare("SELECT id FROM videos").get()?.["id" as keyof unknown],
    );
  });

  it("P2 池拒做顺延：池候选 exit 2 → 池行 rejected → discovery 兜底候选成功", async () => {
    seedPoolRow(env, {
      kind: "place_revisit",
      title: "十年，同一个地方",
      photoCount: 20,
      proposedAt: "2026-09-22T01:20:00.000Z",
    });
    seedTrip(env.sqlite, "tripA", "2024-10-10T10:00:00Z");
    holder.fakeClaudePath = writeCountingFakeClaude(env, "reject-then-ok", mp4Template);

    const { dailyVideoWorker } = await import("../jobs/daily-video");
    await dailyVideoWorker(makeJob("pool-p2") as never);

    expect(invocationCount(env), "池候选被拒后继续试 discovery").toBe(2);
    const pool = env.sqlite.prepare("SELECT status FROM video_theme_pool").get() as {
      status: string;
    };
    expect(pool.status, "被拒池行置 rejected").toBe("rejected");
    const completed = env.sqlite
      .prepare(`SELECT theme_kind FROM videos WHERE status = 'completed'`)
      .get() as { theme_kind: string };
    expect(completed.theme_kind, "兜底候选完成").toBe("trip");
  });

  it("P3 软候选跳过：photoIds <12 的池行不消费（保持 active），discovery 照常", async () => {
    const poolId = seedPoolRow(env, {
      kind: "relationship",
      title: "一起长大 · 手足同框",
      photoCount: 5,
      proposedAt: "2026-09-22T01:20:00.000Z",
    });
    seedTrip(env.sqlite, "tripA", "2024-10-10T10:00:00Z");
    holder.fakeClaudePath = writeCountingFakeClaude(env, "ok", mp4Template);

    const { dailyVideoWorker } = await import("../jobs/daily-video");
    await dailyVideoWorker(makeJob("pool-p3") as never);

    expect(invocationCount(env), "软候选不 spawn，直接消费 discovery").toBe(1);
    const pool = env.sqlite
      .prepare("SELECT status FROM video_theme_pool WHERE id = ?")
      .get(poolId) as { status: string };
    expect(pool.status, "软候选保持 active 待 skill 扩选").toBe("active");
    const video = env.sqlite.prepare("SELECT theme_kind FROM videos").get() as {
      theme_kind: string;
    };
    expect(video.theme_kind, "成片来自 discovery 兜底").toBe("trip");
  });

  it("P4 池候选非拒做失败 → 池行 expired（毒候选不挡明天）+ 当天中止", async () => {
    seedPoolRow(env, {
      kind: "trip",
      title: "十月远行 · 2025",
      photoCount: 20,
      proposedAt: "2026-09-22T01:20:00.000Z",
    });
    seedTrip(env.sqlite, "tripA", "2024-10-10T10:00:00Z");
    holder.fakeClaudePath = writeCountingFakeClaude(env, "always-crash", mp4Template);

    const { dailyVideoWorker } = await import("../jobs/daily-video");
    await dailyVideoWorker(makeJob("pool-p4") as never);

    expect(invocationCount(env), "非拒做中止 → 只 spawn 一次").toBe(1);
    const pool = env.sqlite.prepare("SELECT status FROM video_theme_pool").get() as {
      status: string;
    };
    expect(pool.status, "毒池候选置 expired").toBe("expired");
    const rows = env.sqlite.prepare("SELECT theme_kind, status FROM videos").all() as Array<{
      theme_kind: string;
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
  });
});

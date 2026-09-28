/**
 * 验收测试：curator-video Worker 入池语义（2026-09-28 策展层 L2）
 *
 * 契约（design.md L2 / prompts/v2/curator/discover system.txt）：
 *   C1 正常入池：提案 upsert video_theme_pool；编造 id 剔除保留真实子集；
 *      confidence=low 跳过；UNIQUE(kind,title) 重提 = 内容刷新 + 状态复位 active
 *   C2 done 不复活：已拍成片（status=done）的提案被重提时内容可刷新但状态保持 done
 *   C3 旁路容错：runner 失败 → worker 正常返回，池零写入
 *
 * 驱动：真实 SQLite + mock runCuratorDiscovery（fixture 提案数组）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  runMock: vi.fn(),
}));

vi.mock("../lib/config", () => ({
  config: {
    get databasePath() {
      return holder.dbPath;
    },
    get storageRoot() {
      return "/tmp/relight-none";
    },
    curatorVideoEnabled: true,
    curatorTimeoutMs: 900_000,
    claudeCliPath: "/usr/bin/true",
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-curator-test",
    ai: { baseUrl: "", apiKey: "", visionModel: "", model: "", promptVersion: "v2" },
    daily: { cronTime: "0 3 * * *", maxCandidates: 20, timezone: "Asia/Shanghai" },
    video: { enabled: true, frameCount: 6, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" },
    face: {},
  },
}));

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

vi.mock("../lib/curator/runner", () => ({
  runCuratorDiscovery: (...args: unknown[]) => holder.runMock(...args),
}));

interface CuratorEnv {
  tmpRoot: string;
  sqlite: Database.Database;
}

function createCuratorEnv(): CuratorEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-curator-"));
  const sqlite = new Database(path.join(tmpRoot, "test.db"));
  sqlite.pragma("journal_mode = WAL");
  setupTestSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS video_theme_pool (
      id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      why TEXT, arc TEXT, confidence TEXT NOT NULL, photo_ids TEXT, selection_hint TEXT,
      status TEXT NOT NULL DEFAULT 'active', video_id TEXT,
      proposed_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(kind, title)
    );
  `);
  return { tmpRoot, sqlite };
}

function disposeCuratorEnv(env: CuratorEnv): void {
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

function makeJob(id: string): unknown {
  return { data: {}, id, name: "curator-video-cron", log: () => {}, updateProgress: () => {} };
}

/** 提案 fixture：一条合格（混 1 个编造 id）、一条 low、一条与已完成主题同名（重提） */
function fixtureProposals(realPhotoId: string) {
  return [
    {
      kind: "recurring_event",
      title: "岁岁团圆 · 老家的春节",
      why: "三个春节窗口证据",
      arc: "团圆构图一年年变化",
      confidence: "high",
      photo_ids: [realPhotoId, "fake-invented-id", realPhotoId],
    },
    {
      kind: "relationship",
      title: "一起长大 · 手足同框",
      confidence: "low",
      photo_ids: [realPhotoId],
    },
    {
      kind: "place_revisit",
      title: "十年，同一个地方",
      confidence: "medium",
      photo_ids: [realPhotoId],
      selection_hint: "每次到访选 1-2 张同机位",
    },
  ];
}

describe("curator-video Worker 入池语义 — 验收测试（C1~C3）", () => {
  let env: CuratorEnv;
  const realPhotoId = "photo-real-0001";

  beforeAll(() => {
    env = createCuratorEnv();
    holder.dbPath = path.join(env.tmpRoot, "test.db");
  });

  afterAll(() => {
    disposeCuratorEnv(env);
  });

  beforeEach(() => {
    env.sqlite.exec("DELETE FROM video_theme_pool;");
    env.sqlite.exec("DELETE FROM photos;");
    env.sqlite.exec(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES ('src-test', '测试', 'local', '/tmp/relight-none', 1)
       ON CONFLICT(id) DO NOTHING;`,
    );
    env.sqlite
      .prepare(
        `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height,
                             file_size, thumbnail_path, taken_at, created_at, media_type)
         VALUES (?, 'src-test', 'photos/x.jpg', 'h1', 100, 100, 1, NULL,
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'image')`,
      )
      .run(realPhotoId);
    holder.runMock.mockReset();
  });

  it("C1 正常入池：真实 id 保留 + 编造 id 剔除 + 去重 + low 跳过 + 重提复位 active", async () => {
    // 预置一条 rejected 的同题提案（重提应复位 active）
    env.sqlite
      .prepare(
        `INSERT INTO video_theme_pool (id, kind, title, confidence, photo_ids, status,
                                       proposed_at, updated_at)
         VALUES ('pool-old-1', 'recurring_event', '岁岁团圆 · 老家的春节', 'medium',
                 '["old"]', 'rejected', '2026-09-15T01:20:00Z', '2026-09-15T01:20:00Z')`,
      )
      .run();

    holder.runMock.mockResolvedValue({ ok: true, proposals: fixtureProposals(realPhotoId) });

    const { curatorVideoWorker } = await import("../jobs/curator-video");
    await curatorVideoWorker(makeJob("c1") as never);

    const rows = env.sqlite
      .prepare(
        "SELECT kind, title, status, confidence, photo_ids, selection_hint FROM video_theme_pool ORDER BY kind",
      )
      .all() as Array<{
      kind: string;
      title: string;
      status: string;
      confidence: string;
      photo_ids: string | null;
      selection_hint: string | null;
    }>;

    // low 提案不入池：只剩 2 条
    expect(rows, "low confidence 不入池").toHaveLength(2);

    const spring = rows.find((r) => r.kind === "recurring_event")!;
    expect(spring.status, "重提复位 active").toBe("active");
    const springIds = JSON.parse(spring.photo_ids ?? "[]") as string[];
    expect(springIds, "编造 id 剔除 + 物理去重").toEqual([realPhotoId]);

    const place = rows.find((r) => r.kind === "place_revisit")!;
    expect(place.status).toBe("active");
    expect(place.selection_hint, "软候选 hint 落库").toBe("每次到访选 1-2 张同机位");
  });

  it("C2 done 不复活：已成片提案被重提，状态保持 done", async () => {
    env.sqlite
      .prepare(
        `INSERT INTO video_theme_pool (id, kind, title, confidence, photo_ids, status, video_id,
                                       proposed_at, updated_at)
         VALUES ('pool-done-1', 'place_revisit', '十年，同一个地方', 'medium', '["old"]',
                 'done', 'video-1', '2026-09-15T01:20:00Z', '2026-09-15T01:20:00Z')`,
      )
      .run();

    holder.runMock.mockResolvedValue({ ok: true, proposals: fixtureProposals(realPhotoId) });

    const { curatorVideoWorker } = await import("../jobs/curator-video");
    await curatorVideoWorker(makeJob("c2") as never);

    const row = env.sqlite
      .prepare(`SELECT status, video_id FROM video_theme_pool WHERE kind='place_revisit'`)
      .get() as { status: string; video_id: string | null };
    expect(row.status, "done 不被重提复活").toBe("done");
    expect(row.video_id, "成片回链保留").toBe("video-1");
  });

  it("C3 旁路容错：runner 失败 → worker 正常返回，池零写入", async () => {
    holder.runMock.mockResolvedValue({ ok: false, err: "claude -p 超时（900000ms）" });

    const { curatorVideoWorker } = await import("../jobs/curator-video");
    await expect(curatorVideoWorker(makeJob("c3") as never)).resolves.toBeUndefined();

    const count = env.sqlite.prepare("SELECT COUNT(*) AS c FROM video_theme_pool").get() as {
      c: number;
    };
    expect(count.c, "池零写入").toBe(0);
  });
});

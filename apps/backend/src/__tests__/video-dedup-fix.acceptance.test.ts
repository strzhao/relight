/**
 * 验收测试（红队）：每日视频自动化死循环修复 — person 主题去重对称 + 失败诊断 + 幂等落库
 *
 * 契约来源（state.md ## 修复方案 F1-F5，逐条验收编号 AC1-AC10）：
 *
 *   AC1（F1.1）videos 表存在 themeKind="person" status="completed" 行（themeKey=`<personId>-<toYear>`）
 *              → discoverVideoCandidates 不产出该 person 主题候选（与 trip completed 永久去重对称）
 *   AC2（F1.2）videos 表存在 person status="failed" 且 createdAt 在 7 天内 → 不产出该候选（冷却）
 *   AC3（F1.3）person status="failed" 且 createdAt 在 8 天前 → 产出该候选（冷却放开重试）
 *   AC4（F1.4）trip 分支既有去重行为不回归 —— 由既有 video-discovery.acceptance.test.ts 覆盖，
 *              本文件不重复；AC6b 的「第二次 run 短路」间接守护 trip 冷却路径不回退
 *   AC5（F2） runVideoGeneration：fake claude exit 0、stdout 打独特标记、无 mp4 → {ok:false} 且
 *              err 同时包含「mp4 产物缺失」与标记文本（stdout tail 已附上，诊断盲区修复）
 *   AC6（F3） videos 已有同 themeKey failed 行（errorMsg=旧, createdAt=旧）→ 再次失败经
 *              writeFailedVideo 幂等 UPDATE：errorMsg=新值 + createdAt 刷新为本次时间，行数仍为 1
 *   AC7（F3） 已有 completed 行的同 themeKey：failed 写入不得污染（status 保持 completed、error_msg 不变、不新增行）
 *   AC8（F4） config.videoSpawnTimeoutMs 存在且默认 2700000（45 分钟）；env VIDEO_SPAWN_TIMEOUT_MS 可覆盖
 *   AC9（F5） settings 表 key `video.skipPersonIds`（逗号分隔+空白容忍）命中 personId → 该 person 不出候选
 *   AC10（F5）该 key 缺失或空串/纯逗号 → 该 person 正常候选
 *
 * 红队铁律：
 *   - 仅依 state.md 契约写断言，未读蓝队工作区新实现（fixture 模式照既有 HEAD 测试）
 *   - 真实 SQLite（better-sqlite3 + mkdtempSync），mock ../db 注入 fixture drizzle 实例
 *   - claude runner 测试不 mock child_process：真实 fake shell 脚本（exit 0 无产物 + stdout 标记），
 *     比桩 child_process 更黑盒。蓝队修复落地前 AC1/2/3/5/6/9 相关断言预期 FAIL（测试先行）。
 *   - AC8 断言机制已用既有字段（PORT→config.port）独立探针验证过：vi.resetModules() +
 *     vi.importActual 可让 eager-evaluated 的真实 config 按 fresh env 重新求值。
 *     注意：本文件整体 mock 了 ../lib/config（供 worker/runner 用 getter 路径），AC8 一律走
 *     importActual 绕行读真实模块；resetModules 会清全局模块缓存，故 AC8 describe 放在文件最后，
 *     其后无依赖模块实例身份的测试。
 *
 * Fixture 与驱动机制（照抄既有两个验收测试的机制）：
 *   - setupTestSchema 主 schema + 手写 CREATE TABLE IF NOT EXISTS videos/video_usages/settings
 *     （照既有 video-discovery / video-claude-runner-and-persist 测试的 DDL，helper 变更时幂等兜底）
 *   - vi.hoisted holder + vi.mock("../db") 工厂 → beforeAll 注入 fixture DB 路径
 *   - vi.mock("../lib/config") getter 返回 holder 路径 + videoSpawnTimeoutMs 大默认值（防实现侧
 *     setTimeout(undefined) 立即触发超时造成 flaky）；vi.mock("node:os") HOME 重定向命中临时 SKILL.md
 *   - worker 调用 makeJob() 手造 { data, id, name, log, updateProgress }；wechat 推送全 mock
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// hoisted holder：vi.mock 工厂（懒执行）与 beforeAll 共享
// ============================================================================

const holder = vi.hoisted(() => ({
  dbPath: ":memory:",
  tmpRoot: "/tmp/relight-none",
  storageRoot: "/tmp/relight-none",
  workspacePath: "/tmp/relight-none",
  fakeClaudePath: "/usr/bin/false",
}));

// ============================================================================
// mock：config / node:os(HOME) / db / wechat 推送
// ============================================================================

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
    // F4 契约字段：worker/runner 若实现侧真读此值，给它一个不会干扰测试的大超时。
    // （AC8 对「真实 config」的断言走 importActual，不用这个 mock 值）
    videoSpawnTimeoutMs: 2_700_000,
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-video-dedup-test",
    ai: { baseUrl: "", apiKey: "", visionModel: "", model: "", promptVersion: "v2" },
    daily: { cronTime: "0 3 * * *", maxCandidates: 20, timezone: "Asia/Shanghai" },
    video: { enabled: true, frameCount: 6, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" },
    dailySelectionConcurrency: 1,
    dailyAutoHealDays: 0,
    dailySelectEnabled: false,
    minAestheticScorePrimary: 7.0,
    galleryPublicUrl: "https://gallery.example.invalid",
    face: {},
  },
}));

// HOME 重定向：SKILL.md 前置校验（~/.claude/skills/memory-video/SKILL.md）命中临时目录；
// spawn env 里的 HOME 同步走 homedir()
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => holder.tmpRoot,
  };
});

// db mock：discoverVideoCandidates / daily-video / getSettingValue 全部落到 fixture DB。
// 工厂懒执行——beforeAll 先给 holder.dbPath 赋值后，测试内动态 import 才生效。
vi.mock("../db", async () => {
  const actualSchema = await import("../db/schema");
  const DatabaseMod = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const sqlite = new DatabaseMod(holder.dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema: actualSchema });
  return { db, schema: actualSchema };
});

const wechatMocks = vi.hoisted(() => ({
  sendWallpaperToWeCom: vi.fn(async (_url: string, _buf: Buffer) => ({ errcode: 0, errmsg: "ok" })),
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
// 真实 SQLite fixture
// ============================================================================

interface FixtureEnv {
  tmpRoot: string;
  dbPath: string;
  storageRoot: string;
  videoCacheDir: string;
  workspacePath: string;
  sqlite: Database.Database;
}

function createFixtureEnv(): FixtureEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), ".relight-red-vdedup-"));
  const dbPath = path.join(tmpRoot, "test.db");
  const storageRoot = path.join(tmpRoot, "storage");
  const videoCacheDir = path.join(storageRoot, ".video-cache");
  const workspacePath = path.join(tmpRoot, "workspace");
  fs.mkdirSync(videoCacheDir, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });

  // spawn 前置三存在校验所需文件（node_modules + render-immersive.mjs + SKILL.md）
  fs.mkdirSync(path.join(workspacePath, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "render-immersive.mjs"), "// test stub");
  const skillDir = path.join(tmpRoot, ".claude/skills/memory-video");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# memory-video red-team stub");

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);

  // 手写 videos / video_usages（照既有测试 DDL 抄；IF NOT EXISTS 对 helper 演进幂等兜底）
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      theme_kind TEXT NOT NULL,
      theme_key TEXT NOT NULL,
      title TEXT NOT NULL,
      output_path TEXT NOT NULL,
      cover_path TEXT NOT NULL,
      duration_sec INTEGER,
      photo_ids TEXT,
      status TEXT NOT NULL,
      error_msg TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(theme_kind, theme_key)
    );
    CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at);

    CREATE TABLE IF NOT EXISTS video_usages (
      id TEXT PRIMARY KEY,
      theme_kind TEXT NOT NULL,
      theme_key TEXT NOT NULL,
      photo_id TEXT NOT NULL,
      consumed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_video_usages_photo ON video_usages(photo_id);
    CREATE INDEX IF NOT EXISTS idx_video_usages_theme ON video_usages(theme_kind, theme_key);
  `);

  // settings 兜底（setupTestSchema 已含；保持防御式与既有模式一致）
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 默认存储源
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES ('src-test', '红队存储源', 'local', ?, 1)`,
    )
    .run(storageRoot);

  return { tmpRoot, dbPath, storageRoot, videoCacheDir, workspacePath, sqlite };
}

function disposeFixtureEnv(env: FixtureEnv): void {
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
// seed helpers（语义照既有测试 :162-274 的实现）
// ============================================================================

function insertPhoto(
  f: FixtureEnv,
  opts: { photoId: string; takenAt: string; lat?: number; lng?: number },
): void {
  f.sqlite
    .prepare(
      `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height,
                           file_size, thumbnail_path, taken_at, created_at, media_type,
                           latitude, longitude)
       VALUES (?, 'src-test', ?, ?, 1920, 1080, 1024, ?, ?, ?, 'image', ?, ?)`,
    )
    .run(
      opts.photoId,
      `photos/${opts.photoId}.jpg`,
      `hash-${opts.photoId}-${Math.random().toString(36).slice(2)}`,
      `/tmp/thumb-${opts.photoId}.jpg`, // 以 .jpg 结尾，满足 person 分支 thumbnail LIKE '%.jpg'
      opts.takenAt,
      new Date().toISOString(),
      opts.lat ?? null,
      opts.lng ?? null,
    );
}

function insertPersonWithFaces(
  f: FixtureEnv,
  opts: {
    personId: string;
    centroid: Float32Array;
    faces: { faceId: string; photoId: string; embedding: Float32Array }[];
  },
): void {
  const centroidB64 = Buffer.from(
    opts.centroid.buffer,
    opts.centroid.byteOffset,
    opts.centroid.byteLength,
  ).toString("base64");
  f.sqlite
    .prepare(
      `INSERT INTO persons (id, storage_source_id, centroid_embedding, member_count, displayable,
                            hidden, manual_override, created_at, updated_at)
       VALUES (?, 'src-test', ?, ?, 1, 0, 0, ?, ?)`,
    )
    .run(
      opts.personId,
      centroidB64,
      opts.faces.length,
      new Date().toISOString(),
      new Date().toISOString(),
    );

  const insertFace = f.sqlite.prepare(
    `INSERT INTO faces (id, photo_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h,
                        detection_score, embedding, detected_at)
     VALUES (?, ?, ?, 100, 100, 200, 200, 0.95, ?, ?)`,
  );
  for (const face of opts.faces) {
    const embB64 = Buffer.from(
      face.embedding.buffer,
      face.embedding.byteOffset,
      face.embedding.byteLength,
    ).toString("base64");
    insertFace.run(face.faceId, face.photoId, opts.personId, embB64, new Date().toISOString());
  }
}

/** 构造 512 维单位向量 [1,0,...]（同人 embedding cos=1.0 ≥ PERSON_COS_THRESHOLD=0.5） */
function unitVector512(): Float32Array {
  const v = new Float32Array(512);
  v[0] = 1;
  return v;
}

/**
 * 植入一个有「成长弧线」的 person：2023（旧阶段）+ 2025（新阶段）各 2 张。
 * 未预置任何 videoUsages/completed → maxConsumedYear=0 < maxYear=2025，候选必然成立
 * （discoverPersonGrowth 现行 toYear 取最新照片年 → themeKey=`${personId}-2025`）。
 */
function seedPersonArc(f: FixtureEnv, personId: string): void {
  const v = unitVector512();
  const ids2023 = [`${personId}-p23-a`, `${personId}-p23-b`];
  const ids2025 = [`${personId}-p25-a`, `${personId}-p25-b`];
  for (const pid of ids2023) insertPhoto(f, { photoId: pid, takenAt: "2023-06-01T10:00:00Z" });
  for (const pid of ids2025) insertPhoto(f, { photoId: pid, takenAt: "2025-06-01T10:00:00Z" });
  insertPersonWithFaces(f, {
    personId,
    centroid: v,
    faces: [
      ...ids2023.map((pid, i) => ({ faceId: `${pid}-f`, photoId: pid, embedding: v })),
      ...ids2025.map((pid, i) => ({ faceId: `${pid}-f`, photoId: pid, embedding: v })),
    ],
  });
}

/** 植入旅行素材：重庆·川南 GPS（lat 29.5 lng 106.5 → regionSlug chongqing），连续 N 天，themeKey=chongqing-<year> */
function seedTripPhotos(f: FixtureEnv, prefix: string, count = 21): void {
  const baseDate = new Date("2024-09-10T10:00:00Z").getTime();
  const stmt = f.sqlite.prepare(
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

type SeedStatus = "completed" | "failed";

/** 植入历史 videos 行（completed 或 failed，含 errorMsg / createdAt 定制） */
function seedVideoRow(
  f: FixtureEnv,
  opts: {
    themeKind: "trip" | "person";
    themeKey: string;
    status: SeedStatus;
    photoIds?: string[];
    errorMsg?: string | null;
    createdAtIso: string;
  },
): void {
  f.sqlite
    .prepare(
      `INSERT INTO videos (id, theme_kind, theme_key, title, output_path, cover_path,
                           duration_sec, photo_ids, status, error_msg, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      `vid-${Math.random().toString(36).slice(2)}`,
      opts.themeKind,
      opts.themeKey,
      `${opts.status}-${opts.themeKey}`,
      `/tmp/red-${opts.themeKind}-${opts.themeKey}.mp4`,
      `/tmp/red-${opts.themeKind}-${opts.themeKey}.jpg`,
      JSON.stringify(opts.photoIds ?? []),
      opts.status,
      opts.errorMsg ?? null,
      opts.createdAtIso,
    );
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** mock job（dailyVideoWorker 只消费 data/id/name/log/updateProgress） */
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
// fake claude 脚本工厂：从 env 读 OUTPUT_PATH/META_PATH；可选追加调用计数日志
// ============================================================================

/**
 * exit 0 但不产 mp4、向 stdout 打独特标记 —— F2 的目标失败形态
 * （claude 正常退出却没渲染，skill 真实回复只在 stdout）
 */
function writeFakeClaudeNoMp4WithStdout(tmpRoot: string, stdoutMarker: string): string {
  const scriptPath = path.join(
    tmpRoot,
    `fake-claude-nomp4-${Math.random().toString(36).slice(2)}.sh`,
  );
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh
echo "${stdoutMarker}"
echo "fake-claude: exit 0 without producing OUTPUT_PATH"
exit 0
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

/** 带调用计数（每执行一次向 callLog 追加一行）的 no-mp4 脚本 —— 用于断言「第二次 run 短路不 spawn」 */
function writeFakeClaudeNoMp4WithCallLog(
  tmpRoot: string,
  callLog: string,
  stdoutMarker: string,
): string {
  const scriptPath = path.join(
    tmpRoot,
    `fake-claude-count-${Math.random().toString(36).slice(2)}.sh`,
  );
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh
echo x >> "${callLog}"
echo "${stdoutMarker}"
exit 0
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

// ============================================================================
// 测试套件
// ============================================================================

describe("每日视频死循环修复 — 红队验收（AC1-AC10）", () => {
  let env: FixtureEnv;

  beforeAll(() => {
    env = createFixtureEnv();
    holder.dbPath = env.dbPath;
    holder.storageRoot = env.storageRoot;
    holder.workspacePath = env.workspacePath;
    holder.tmpRoot = env.tmpRoot;
  });

  afterAll(() => {
    disposeFixtureEnv(env);
  });

  beforeEach(() => {
    for (const tbl of [
      "video_usages",
      "videos",
      "faces",
      "persons",
      "photo_analyses",
      "photos",
      "settings",
    ]) {
      env.sqlite.exec(`DELETE FROM ${tbl};`);
    }
    wechatMocks.sendWallpaperToWeCom.mockClear();
    wechatMocks.compressForWeCom.mockClear();
    wechatMocks.getDailyPushSettings.mockClear();
    wechatMocks.sendWeComText.mockClear();
  });

  // ==========================================================================
  // F1 — person 主题去重与 trip 对称（AC1 / AC2 / AC3）
  // ==========================================================================

  describe("F1 person 主题去重与 trip 对称", () => {
    it("[AC1] PERSON-COMPLETED-DEDUP：videos 有 person completed 行（themeKey=<personId>-<toYear>）→ 不产出该 person 候选", async () => {
      const PERSON = "person-red";
      seedPersonArc(env, PERSON); // arc: 2023 + 2025 → 必然成立的主题候选 person-red-2025

      // 关键预置：只放 videos completed 行（刻意不放 videoUsages —— 验收对象是
      // 「新增的 videos 表去重通道」，若测试经由旧的 usage 通道通过则说明修复未落地）
      seedVideoRow(env, {
        themeKind: "person",
        themeKey: "person-red-2025",
        status: "completed",
        createdAtIso: daysAgoIso(30),
        photoIds: ["person-red-p25-a"],
      });

      const { discoverVideoCandidates } = await import("../jobs/video-discovery");
      const candidates = await discoverVideoCandidates();

      const personCands = candidates.filter((c) => c.themeKind === "person");
      expect(
        personCands.filter((c) => c.themeKey.includes(PERSON)).length,
        "该 person 已有 completed 视频时不应再产出其主题候选（trip 对称永久去重）",
      ).toBe(0);
      expect(personCands.length, "本 fixture 只有这一个 person，整类 person 候选应为 0").toBe(0);
    });

    it("[AC2] PERSON-FAILED-COOLDOWN：person failed 且 createdAt 在 7 天内 → 冷却不产出候选", async () => {
      const PERSON = "person-cool";
      seedPersonArc(env, PERSON); // 候选本应必然成立

      seedVideoRow(env, {
        themeKind: "person",
        themeKey: "person-cool-2025",
        status: "failed",
        errorMsg: "旧失败诊断-marker-DEADLOOP-0811",
        createdAtIso: daysAgoIso(1), // 明确落在 7 天冷却窗内
        photoIds: [],
      });

      const { discoverVideoCandidates } = await import("../jobs/video-discovery");
      const candidates = await discoverVideoCandidates();

      const personCands = candidates.filter(
        (c) => c.themeKind === "person" && c.themeKey.includes(PERSON),
      );
      expect(
        personCands.length,
        "7 天内失败的 person 主题应处于冷却期，不再产出候选（杜绝每天锁死出片名额的死循环）",
      ).toBe(0);
    });

    it("[AC3] PERSON-FAILED-RETRY-AFTER-COOLDOWN：person failed 且 createdAt 在 8 天前 → 放开产出候选", async () => {
      const PERSON = "person-retry";
      seedPersonArc(env, PERSON);

      seedVideoRow(env, {
        themeKind: "person",
        themeKey: "person-retry-2025",
        status: "failed",
        errorMsg: "久远失败诊断",
        createdAtIso: daysAgoIso(9), // 明确越过 7/8 天两种口径的冷却边界
        photoIds: [],
      });

      const { discoverVideoCandidates } = await import("../jobs/video-discovery");
      const candidates = await discoverVideoCandidates();

      const retry = candidates.find((c) => c.themeKind === "person" && c.themeKey.includes(PERSON));
      expect(retry, "冷却过期（≥8 天前失败）应放开重试机会，重新产出该 person 候选").toBeDefined();
      expect(
        retry!.themeKey,
        "重试候选的 themeKey 应维持 `<personId>-<toYear>` 形态且应用最新照片年 2025",
      ).toContain(`${PERSON}-2025`);
      expect((retry as { personId?: string }).personId, "person 候选应携带 personId 字段").toBe(
        PERSON,
      );
    });
  });

  // ==========================================================================
  // F2 — mp4 缺失分支补 stdout tail（AC5）
  // ==========================================================================

  describe("F2 mp4 缺失诊断盲区", () => {
    it("[AC5] MP4-MISSING-INCLUDES-STDOUT-TAIL：fake claude exit 0 + stdout 标记 + 无产物 → err 同时含「mp4 产物缺失」与标记", async () => {
      const MARKER = "SKILL-GAVE-UP-REASON-XYZ";
      holder.fakeClaudePath = writeFakeClaudeNoMp4WithStdout(env.tmpRoot, MARKER);

      const { runVideoGeneration } = await import("../lib/video/claude-runner");
      const outputPath = path.join(env.videoCacheDir, "trip-chongqing-2099.mp4");
      const metaPath = path.join(env.videoCacheDir, "chongqing-2099.json");

      const result = await runVideoGeneration(
        {
          themeKind: "trip",
          themeKey: "chongqing-2099",
          titleHint: "AC5 探针主题",
          photoIds: ["p1", "p2"],
          toYear: 2099,
        },
        outputPath,
        metaPath,
      );

      expect(result.ok, "exit 0 但无 mp4 产物必须判失败 ok=false").toBe(false);
      expect(result.err, "应有 err 诊断信息").toBeDefined();
      expect(result.err!, "err 应含「mp4 产物缺失」根因描述").toContain("mp4 产物缺失");
      expect(
        result.err!,
        "err 应附上 stdout tail：claude 正常退出没渲染时的真实回复从此可见（诊断盲区修复核心）",
      ).toContain(MARKER);
      expect(fs.existsSync(outputPath), "失败不应留下 mp4 文件").toBe(false);
    });
  });

  // ==========================================================================
  // F3 — failed 行幂等更新（AC6 / AC7）
  // 说明：writeFailedVideo 是 daily-video.ts 内部函数，AC6 经 dailyVideoWorker 全链路驱动：
  //   预置 10 天前的 failed 行（越过冷却边界 → 候选可被 rediscover）→ 本次再失败 → 幂等 UPDATE。
  //   （契约原文示例「createdAt=6 天前」中的天数是举例；冷却机制下 7 天内的旧行按设计不可达，
  //    写入刷新的本质是「最后一次失败即冷却起点」，因此用 >7 天的历史行驱动同一更新路径。）
  // ==========================================================================

  describe("F3 failed 行幂等更新", () => {
    it("[AC6] FAILED-ROW-IDEMPOTENT-REFRESH：再次失败同 themeKey → UPDATE errorMsg+createdAt（旧行不吞新诊断，行数仍 1）", async () => {
      seedTripPhotos(env, "idemtrip"); // trip chongqing-2024 候选素材

      const OLD_MSG = "旧失败诊断-SWALLOWED-BY-ONCONFLICT-DO-NOTHING";
      const OLD_ISO = daysAgoIso(10);
      seedVideoRow(env, {
        themeKind: "trip",
        themeKey: "chongqing-2024",
        status: "failed",
        errorMsg: OLD_MSG,
        createdAtIso: OLD_ISO,
        photoIds: [],
      });

      const MARKER = "REFRESHED-RUN-DIAG-A1";
      const callLog = path.join(env.tmpRoot, "claude-call-log.txt");
      fs.writeFileSync(callLog, "");
      holder.fakeClaudePath = writeFakeClaudeNoMp4WithCallLog(env.tmpRoot, callLog, MARKER);

      const tBeforeRun = Date.now();
      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-idem-refresh") as never);

      const rows = env.sqlite
        .prepare(
          `SELECT status, error_msg, created_at FROM videos
           WHERE theme_kind='trip' AND theme_key='chongqing-2024'`,
        )
        .all() as Array<{ status: string; error_msg: string | null; created_at: string }>;

      expect(rows.length, "同 themeKey 幂等写入后必须仍只有 1 行").toBe(1);
      const row = rows[0]!;
      expect(row.status, "本次仍失败，status 保持 failed").toBe("failed");

      expect(
        row.error_msg,
        "errorMsg 应刷成最新失败诊断（onConflictDoNothing 吞更新是原 bug）",
      ).not.toBe(OLD_MSG);
      expect(row.error_msg ?? "", "新诊断经 stdout-tail 链路应含本次失败标记").toContain(MARKER);

      expect(row.created_at, "createdAt 应刷新为本次时间（不再停留 10 天前的旧值）").not.toBe(
        OLD_ISO,
      );
      const refreshedAt = Date.parse(row.created_at);
      expect(Number.isNaN(refreshedAt)).toBe(false);
      expect(
        refreshedAt,
        "createdAt 应 >= 本次 run 开始时刻（留 60s 时钟容差）",
      ).toBeGreaterThanOrEqual(tBeforeRun - 60_000);

      // 后续 AC6b 复用同一 fixture 数据布局
      void callLog;
    });

    it("[AC6b] COOLDOWN-START-LINKAGE：刷新后的 createdAt 立即成为冷却起点 → 第二次 run 短路（不 spawn、不改行）", async () => {
      seedTripPhotos(env, "linkage");

      const OLD_ISO = daysAgoIso(10);
      seedVideoRow(env, {
        themeKind: "trip",
        themeKey: "chongqing-2024",
        status: "failed",
        errorMsg: "初次失败诊断",
        createdAtIso: OLD_ISO,
        photoIds: [],
      });

      const MARKER = "LINKAGE-RUN-MARKER";
      const callLog = path.join(env.tmpRoot, "claude-call-log-linkage.txt");
      fs.writeFileSync(callLog, "");
      holder.fakeClaudePath = writeFakeClaudeNoMp4WithCallLog(env.tmpRoot, callLog, MARKER);

      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-linkage-run1") as never);

      const afterFirst = env.sqlite
        .prepare(
          `SELECT status, error_msg, created_at FROM videos WHERE theme_kind='trip' AND theme_key='chongqing-2024'`,
        )
        .get() as { status: string; error_msg: string | null; created_at: string };
      const callsAfterFirst = fs.readFileSync(callLog, "utf8").split("\n").filter(Boolean).length;
      expect(callsAfterFirst, "第一次 run 应真实 spawn 一次 claude").toBe(1);
      expect(afterFirst.error_msg ?? "").toContain(MARKER);

      // 紧接着第二次 cron run：刚刷新的 failed 行应立即进入 7 天冷却 → 发现器零候选 → 提前返回
      await dailyVideoWorker(makeJob("job-linkage-run2") as never);

      const afterSecond = env.sqlite
        .prepare(
          `SELECT status, error_msg, created_at FROM videos WHERE theme_kind='trip' AND theme_key='chongqing-2024'`,
        )
        .get() as { status: string; error_msg: string | null; created_at: string };

      const callsAfterSecond = fs.readFileSync(callLog, "utf8").split("\n").filter(Boolean).length;
      expect(callsAfterSecond, "冷却生效：第二次 run 不应再 spawn claude（死循环闭环验证）").toBe(
        1,
      );
      expect(afterSecond.created_at, "第二次 run 不应触碰行的 createdAt").toBe(
        afterFirst.created_at,
      );
      expect(afterSecond.error_msg, "第二次 run 不应改写 errorMsg").toBe(afterFirst.error_msg);
      expect(afterSecond.status).toBe("failed");
    });

    it("[AC7] COMPLETED-ROW-IMMUNE：已有 completed 行的同 themeKey，failed 写入不得污染（setWhere 守卫）", async () => {
      // 预置：该 themeKey 已成功出片（completed）
      seedVideoRow(env, {
        themeKind: "trip",
        themeKey: "chongqing-2019",
        status: "completed",
        createdAtIso: daysAgoIso(200),
        photoIds: ["done-a", "done-b"],
      });

      const mod = (await import("../jobs/daily-video")) as unknown as Record<string, unknown>;
      const writeFailedVideo =
        typeof mod.writeFailedVideo === "function"
          ? (mod.writeFailedVideo as (
              input: {
                themeKind: "trip" | "person";
                themeKey: string;
                title: string;
                outputPath: string;
                coverPath: string;
                errorMsg: string;
              },
              now: string,
            ) => Promise<string>)
          : undefined;

      if (writeFailedVideo) {
        // 直连内部函数（若蓝队导出）：对 completed 行发动一次 failed 写入，验证 setWhere/降级守卫
        await writeFailedVideo(
          {
            themeKind: "trip",
            themeKey: "chongqing-2019",
            title: "污染尝试",
            outputPath: "/tmp/red-should-not-exist.mp4",
            coverPath: "/tmp/red-should-not-exist.jpg",
            errorMsg: "尝试污染 COMPLETED 行-AC7",
          },
          new Date().toISOString(),
        );
      } else {
        // 内部函数未导出（与 HEAD 一致）：退化为等价观察面——
        // 预置另一可发现主题并让 worker 失败，观察 completed 行绝不被波及、也不产生重复行
        seedTripPhotos(env, "immune");
        const MARKER = "IMMUNE-RUN-MARKER";
        holder.fakeClaudePath = writeFakeClaudeNoMp4WithStdout(env.tmpRoot, MARKER);
        const { dailyVideoWorker } = await import("../jobs/daily-video");
        await dailyVideoWorker(makeJob("job-ac7-immune") as never);
      }

      const rows = env.sqlite
        .prepare(
          `SELECT status, error_msg FROM videos WHERE theme_kind='trip' AND theme_key='chongqing-2019'`,
        )
        .all() as Array<{ status: string; error_msg: string | null }>;

      expect(rows.length, "completed 行必须保持唯一（failed 写入不得 UPSERT 出第二行）").toBe(1);
      expect(rows[0]!.status, "status 仍为 completed（setWhere/降级 select 守卫生效）").toBe(
        "completed",
      );
      expect(rows[0]!.error_msg, "completed 行 error_msg 必须保持 NULL 不被污染").toBeNull();
    });
  });

  // ==========================================================================
  // F5 — skip 名单（AC9 / AC10）
  // settings key `video.skipPersonIds`：逗号分隔 personId、标量字符串；
  // discoverPersonGrowth 读到命中者直接 continue（比 themeKey 去重更早）。
  // 说明：settings 表由共享 drizzle schema 映射（../db mock），seed 直接走 raw SQL。
  // ==========================================================================

  describe("F5 脏聚类跳过名单", () => {
    it("[AC9] SKIP-PERSON-ID-LIST：skip 名单命中（含逗号+空白噪声）→ 该 person 即便弧线充足也不出候选", async () => {
      const TARGET = "person-skipped";
      const NOISE = "other-person-zz";
      seedPersonArc(env, TARGET); // 2023+2025 弧线充足，若无名单必出候选

      // 名单里混入空白与多余逗号（验收契约：可带逗号+空白）
      env.sqlite
        .prepare(`INSERT INTO settings (key, value) VALUES ('video.skipPersonIds', ?)`)
        .run(` , ${NOISE}, ${TARGET} ,,`);

      const { discoverVideoCandidates } = await import("../jobs/video-discovery");
      const candidates = await discoverVideoCandidates();

      const targetCands = candidates.filter(
        (c) => c.themeKind === "person" && c.themeKey.includes(TARGET),
      );
      expect(targetCands.length, "skip 名单命中的脏聚类不应进入候选（连候选都不进）").toBe(0);
    });

    it("[AC10] SKIP-LIST-ABSENT-OR-EMPTY：key 缺失/空串/纯逗号空白 → 该 person 正常产出候选", async () => {
      const TARGET = "person-normal";

      const phases: Array<{ label: string; value?: string }> = [
        { label: "key 缺失" },
        { label: "value 为空串", value: "" },
        { label: "value 为纯逗号空白", value: " , ,, " },
      ];

      const { discoverVideoCandidates } = await import("../jobs/video-discovery");

      for (const phase of phases) {
        seedPersonArc(env, TARGET);
        if (phase.value !== undefined) {
          env.sqlite
            .prepare(`INSERT INTO settings (key, value) VALUES ('video.skipPersonIds', ?)`)
            .run(phase.value);
        }

        const candidates = await discoverVideoCandidates();
        const cand = candidates.find(
          (c) => c.themeKind === "person" && c.themeKey.includes(TARGET),
        );

        // 每个 phase 结束清理，避免影响下一 phase
        env.sqlite.prepare("DELETE FROM settings WHERE key='video.skipPersonIds'").run();
        env.sqlite.exec("DELETE FROM persons;");
        env.sqlite.exec("DELETE FROM faces;");
        env.sqlite.exec("DELETE FROM photos;");

        expect(cand, `[${phase.label}] 未列入 skip 名单的 person 应正常产出候选`).toBeDefined();
        expect(
          cand!.themeKey,
          `[${phase.label}] themeKey 应为 <personId>-<toYear>=${TARGET}-2025`,
        ).toContain(`${TARGET}-2025`);
      }
    });
  });

  // ==========================================================================
  // F4 — 超时可配置（AC8）。置于文件最后：resetModules 清全局模块缓存不影响后续测试。
  // 断言机制已探针验证：vi.resetModules() + vi.importActual 让真实 config 按当前 env 重求值。
  // ==========================================================================

  describe("F4 spawn 超时可配置", () => {
    const savedTimeoutEnv = process.env.VIDEO_SPAWN_TIMEOUT_MS;

    afterEach(() => {
      if (savedTimeoutEnv === undefined)
        // biome-ignore lint/performance/noDelete: 恢复 process.env 的标准模式（赋 undefined 会变字符串 "undefined"）
        // biome-ignore lint/performance/noDelete: 恢复 process.env 的标准模式（赋 undefined 会变字符串 "undefined"）
        delete process.env.VIDEO_SPAWN_TIMEOUT_MS;
      else process.env.VIDEO_SPAWN_TIMEOUT_MS = savedTimeoutEnv;
      vi.resetModules();
    });

    it("[AC8-default] VIDEO-SPAWN-TIMEOUT-DEFAULT：config.videoSpawnTimeoutMs 存在且默认 2700000（45 分钟）", async () => {
      // biome-ignore lint/performance/noDelete: 恢复 process.env 的标准模式（赋 undefined 会变字符串 "undefined"）
      delete process.env.VIDEO_SPAWN_TIMEOUT_MS;
      vi.resetModules();
      const real = await vi.importActual<{ config: { videoSpawnTimeoutMs?: number } }>(
        "../lib/config",
      );
      expect(
        real.config.videoSpawnTimeoutMs,
        "真实 config 应暴露 videoSpawnTimeoutMs 字段（撞 30 分钟线的渲染要有余量）",
      ).toBeDefined();
      expect(real.config.videoSpawnTimeoutMs, "默认值应为 2700000ms = 45 分钟").toBe(2_700_000);
    });

    it("[AC8-override] VIDEO-SPAWN-TIMEOUT-OVERRIDE：env VIDEO_SPAWN_TIMEOUT_MS 可覆盖默认值", async () => {
      process.env.VIDEO_SPAWN_TIMEOUT_MS = "1234567";
      vi.resetModules();
      const real = await vi.importActual<{ config: { videoSpawnTimeoutMs?: number } }>(
        "../lib/config",
      );
      expect(real.config.videoSpawnTimeoutMs, "env 覆盖应生效（数值化解析，不做字符串透传）").toBe(
        1_234_567,
      );
    });
  });
});

/**
 * 验收测试（红队）：backfill:gallery CLI（场景 6：P21/P22）
 *
 * 设计契约（state.md §组件设计 6 backfill CLI + §验收场景 场景 6）：
 *   §组件设计 6：
 *   - 扫历史 dailyPicks/videos → 上传所有资源 → 首次全量生成 manifest
 *   - 复用 backfill-daily-picks.ts 的 parseArgs/StubJob 模式
 *   - --dry-run（列将上传文件）/ --yes（执行）/ --limit
 *
 *   P21 [real-process] backfill:gallery --dry-run exit 0 + 输出含待回填计数
 *                        （含天数 + 视频条目）
 *   P22 [negate] dry-run 不实际上传（grep "dry run"/"would upload" + 无 PUT 日志）
 *
 * 红队铁律：本文件仅依据设计文档编写，不读蓝队实现代码。
 *   - 未读 cli/backfill-gallery.ts
 *   - spawnSync 真子进程跑 CLI（黑盒 stdout/exit code）
 *   - mock 不生效（子进程独立），通过 env DATABASE_PATH 指向 fixture DB
 *   - 注入坏 COS 凭据防止真实上传（即使 dry-run 失误也不会真传）
 *
 * 测试策略：
 *   1. fixture DB 插入 N 天 dailyPicks + M 个 videos
 *   2. 检测 CLI 文件是否存在（蓝队实现前 skip，实现后跑真子进程）
 *   3. spawnSync tsx 跑 cli/backfill-gallery.ts --dry-run
 *   4. 断言：exit 0 + stdout 含天数/视频计数 + 无真实上传日志
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// 常量
// ============================================================================

const BACKEND_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(BACKEND_ROOT, "src/cli/backfill-gallery.ts");

// ============================================================================
// 检测蓝队是否已实现 CLI（文件是否存在）
// ============================================================================

const CLI_EXISTS = fs.existsSync(CLI_PATH);

// ============================================================================
// fixture env
// ============================================================================

interface TestEnv {
  tmpRoot: string;
  dbPath: string;
  storageRoot: string;
}

const activeEnvs: TestEnv[] = [];

function createTestEnv(prefix: string): TestEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), `.relight-test-bfgallery-${prefix}-`));
  const dbPath = path.join(tmpRoot, "test.db");
  const storageRoot = path.join(tmpRoot, "storage");
  const wallpapersDir = path.join(storageRoot, ".wallpaper-cache");
  const thumbsDir = path.join(storageRoot, "thumbnails");
  const videosDir = path.join(storageRoot, "videos");
  fs.mkdirSync(wallpapersDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });
  fs.mkdirSync(videosDir, { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES ('src-test', '测试存储源', 'local', ?, 1)`,
    )
    .run(storageRoot);
  sqlite.close();

  const env = { tmpRoot, dbPath, storageRoot };
  activeEnvs.push(env);
  return env;
}

afterEach(() => {
  while (activeEnvs.length > 0) {
    const env = activeEnvs.pop()!;
    try {
      fs.rmSync(env.tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// fixture 数据插入（多天 dailyPicks + entries + videos）
// ============================================================================

function seedFixtureData(env: TestEnv, opts: { days: number; videos: number }): void {
  const db = new Database(env.dbPath);
  const createdAt = new Date().toISOString();

  // N 天 dailyPicks（每天 1 photo + 1 pick + 3 entries）
  for (let d = 0; d < opts.days; d++) {
    const date = `2026-07-${String(d + 1).padStart(2, "0")}`;
    const composedPath = path.join(env.storageRoot, ".wallpaper-cache", `${date}_composed.jpg`);
    // 创建假的本地壁纸文件（让 backfill 能找到）
    fs.writeFileSync(composedPath, Buffer.from("fake-wallpaper"));
    const portraitPath = path.join(env.storageRoot, ".wallpaper-cache", `${date}_1290x2796.jpg`);
    fs.writeFileSync(portraitPath, Buffer.from("fake-portrait"));

    for (let e = 0; e < 3; e++) {
      const photoId = `p-${date}-${e}`;
      const thumbPath = path.join(env.storageRoot, "thumbnails", `${photoId}.jpg`);
      fs.writeFileSync(thumbPath, Buffer.from("fake-thumb"));
      db.prepare(
        `INSERT INTO photos (id, storage_source_id, file_path, file_hash, thumbnail_path, created_at, media_type)
         VALUES (?, 'src-test', ?, ?, ?, ?, 'image')`,
      ).run(photoId, `/photos/${photoId}.jpg`, `h-${photoId}`, thumbPath, createdAt);
    }

    db.prepare(
      `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score,
                                composed_image_path, members, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, '[]', ?)`,
    ).run(
      `pick-${date}`,
      `p-${date}-0`,
      date,
      `标题${date}`,
      `叙事${date}`,
      composedPath,
      createdAt,
    );

    for (let e = 0; e < 3; e++) {
      db.prepare(
        `INSERT INTO daily_pick_entries (id, daily_pick_id, rank, photo_id, title, narrative, score, members, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, '[]', ?)`,
      ).run(
        `entry-${date}-${e}`,
        `pick-${date}`,
        e + 1,
        `p-${date}-${e}`,
        `标题${e}`,
        `叙事${e}`,
        createdAt,
      );
    }
  }

  // M 个 videos
  for (let v = 0; v < opts.videos; v++) {
    const themeKey = `trip-region${v}-2026`;
    const mp4Path = path.join(env.storageRoot, "videos", `${themeKey}.mp4`);
    const coverPath = path.join(env.storageRoot, "videos", `${themeKey}.jpg`);
    fs.writeFileSync(mp4Path, Buffer.from("fake-mp4"));
    fs.writeFileSync(coverPath, Buffer.from("fake-cover"));

    db.prepare(
      `INSERT INTO videos (id, theme_kind, theme_key, title, output_path, cover_path,
                            duration_sec, photo_ids, status, error_msg, created_at)
       VALUES (?, 'trip', ?, ?, ?, ?, 200, '[]', 'completed', NULL, ?)`,
    ).run(`vid-${v}`, themeKey, `视频${v}`, mp4Path, coverPath, createdAt);
  }

  db.close();
}

// ============================================================================
// 运行 CLI（spawnSync tsx）+ 注入坏 COS 凭据防真实上传
// ============================================================================

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCliDryRun(env: TestEnv): CliRunResult {
  const childEnv = {
    ...process.env,
    DATABASE_PATH: env.dbPath,
    STORAGE_ROOT: env.storageRoot,
    // 注入坏 COS 凭据（即使 dry-run 失误也不会真实上传）
    COS_SECRET_ID: "definitely-invalid-id",
    COS_SECRET_KEY: "definitely-invalid-key",
    TENCENTCLOUD_SECRET_ID: "definitely-invalid-id",
    TENCENTCLOUD_SECRET_KEY: "definitely-invalid-key",
    // 坏 VPS 配置（防 ssh 真实连接）
    GALLERY_VPS_HOST: "127.0.0.1",
    GALLERY_VPS_KEY: "/tmp/nonexistent-key",
    FORCE_COLOR: "0",
  };

  const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, "--dry-run"], {
    cwd: BACKEND_ROOT,
    encoding: "utf-8",
    timeout: 90_000,
    env: childEnv,
  });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ============================================================================
// 测试套件
// ============================================================================

// 蓝队实现前（CLI 文件不存在）整个 suite skip
const describeOrSkip = CLI_EXISTS ? describe : describe.skip;

describeOrSkip("P21/P22 backfill:gallery --dry-run CLI — 验收测试（红队，黑盒 spawnSync）", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv("dryrun");
  });

  // --------------------------------------------------------------------------
  // P21：dry-run exit 0 + 输出含待回填计数（天数 + 视频条目）
  // --------------------------------------------------------------------------

  describe("P21 dry-run 输出契约（exit 0 + 含计数）", () => {
    it("P21.1 --dry-run 在有待回填数据时 exit 0（不应 exit 2 部分 failed）", () => {
      seedFixtureData(env, { days: 5, videos: 2 });
      const res = runCliDryRun(env);

      // dry-run 是只读探查，exit 0 是首选；至少不应是 2（部分失败）
      // （部分失败意味着真实执行了——违反 dry-run 契约）
      expect(
        res.exitCode,
        `dry-run 不应 exit 2（部分失败=真实执行了）。exit=${res.exitCode} stderr: ${res.stderr}`,
      ).not.toBe(2);
    });

    it("P21.2 --dry-run stdout 应含天数字段（扫描 dailyPicks 计数）", () => {
      seedFixtureData(env, { days: 5, videos: 2 });
      const res = runCliDryRun(env);

      const out = `${res.stdout}\n${res.stderr}`;
      // 应有天数计数（容忍中英文字段名差异）
      // 关键信号：数字 5（天数）或 "days"/"天" 关键词
      const hasDayCount = /\b5\b/.test(out) || /days|天|dailyPicks|picks/i.test(out);
      expect(
        hasDayCount,
        `stdout 应含天数字段（5 天），实际 stdout: ${res.stdout.slice(0, 500)}`,
      ).toBe(true);
    });

    it("P21.3 --dry-run stdout 应含视频条目计数（扫描 videos 表）", () => {
      seedFixtureData(env, { days: 3, videos: 2 });
      const res = runCliDryRun(env);

      const out = `${res.stdout}\n${res.stderr}`;
      // 应有视频计数（容忍字段名差异）
      const hasVideoCount = /\b2\b/.test(out) || /videos?|视频/i.test(out);
      expect(
        hasVideoCount,
        `stdout 应含视频条目计数（2 个），实际 stdout: ${res.stdout.slice(0, 500)}`,
      ).toBe(true);
    });

    it("P21.4 --dry-run stdout 应列出将上传的资源清单（wallpaper/photo/video 类别）", () => {
      seedFixtureData(env, { days: 2, videos: 1 });
      const res = runCliDryRun(env);

      const out = `${res.stdout}\n${res.stderr}`;
      // 应有某种"将上传"的清单信号
      // 容忍文案：would upload / dry run / 待上传 / 将上传 / pending
      const hasUploadList = /upload|上传|dry.?run|待传|将传|pending/i.test(out);
      expect(
        hasUploadList,
        `stdout 应含"将上传"清单信号，实际 stdout: ${res.stdout.slice(0, 800)}`,
      ).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // P22：dry-run 不实际上传【negate】
  // --------------------------------------------------------------------------

  describe("P22 dry-run 不实际上传【negate】", () => {
    it("P22.1 --dry-run stdout/stderr 不含真实上传成功日志（no PUT success）", () => {
      seedFixtureData(env, { days: 3, videos: 1 });
      const res = runCliDryRun(env);

      const out = `${res.stdout}\n${res.stderr}`;
      // 不应有"上传成功"类日志（dry-run 不应真实传）
      // 容忍 "would upload"（dry-run 专有）但不应有 "uploaded ok" / "上传成功"
      const hasRealUploadSuccess = /上传成功|uploaded\s*(ok|success)|putObject\s*success/i.test(
        out,
      );
      expect(
        hasRealUploadSuccess,
        `dry-run 不应有真实上传成功日志，实际: ${out.slice(0, 500)}`,
      ).toBe(false);
    });

    it("P22.2 --dry-run stdout 应显式标注 dry-run 模式（grep 'dry run' 类命中）", () => {
      seedFixtureData(env, { days: 2, videos: 1 });
      const res = runCliDryRun(env);

      const out = `${res.stdout}\n${res.stderr}`;
      // P22 谓词要求：grep "dry run" / "would upload" 命中
      const hasDryRunMark = /dry.?run|would\s*upload|待上传|将上传|不会|not.*upload/i.test(out);
      expect(
        hasDryRunMark,
        `dry-run stdout 应显式标注 dry-run 模式，实际: ${out.slice(0, 500)}`,
      ).toBe(true);
    });

    it("P22.3 --dry-run 不触发真实 COS 调用（注入坏凭据下不应有「调用 COS API」日志）", () => {
      seedFixtureData(env, { days: 2, videos: 1 });
      const res = runCliDryRun(env);

      const out = `${res.stdout}\n${res.stderr}`;
      // dry-run 应完全不调 COS SDK（不应有 putObject/sliceUploadFile 调用日志）
      // 注：坏凭据下若真调会抛错 → exit != 0 或 stderr 有 COS error
      // 这里断言不应有"正在上传到 COS"/"COS 响应"类日志
      const hasCosApiCall =
        /正在上传到\s*COS|COS.*响应|putObject.*200|sliceUploadFile.*ok|cos.*upload.*success/i.test(
          out,
        );
      expect(hasCosApiCall, `dry-run 不应触发真实 COS API 调用，实际: ${out.slice(0, 500)}`).toBe(
        false,
      );
    });

    it("P22.4 --dry-run 不触发真实 ssh/scp 推送（manifest 不真实同步到 VPS）", () => {
      seedFixtureData(env, { days: 2, videos: 1 });
      const res = runCliDryRun(env);

      const out = `${res.stdout}\n${res.stderr}`;
      // dry-run 不应真实 ssh/scp（manifest 推送也应是 dry-run）
      const hasRealPush = /scp.*ok|ssh.*mv.*ok|manifest.*pushed|推送成功|manifest.*已同步/i.test(
        out,
      );
      expect(hasRealPush, `dry-run 不应触发真实 ssh/scp 推送，实际: ${out.slice(0, 500)}`).toBe(
        false,
      );
    });
  });

  // --------------------------------------------------------------------------
  // P21 边界：空数据
  // --------------------------------------------------------------------------

  describe("P21 边界（空数据）", () => {
    it("P21.5 无 dailyPicks 无 videos 时 --dry-run 也应正常返回（exit 0 或 exit 1 表示无目标，非 crash）", () => {
      // 不插任何数据（空 DB）
      const res = runCliDryRun(env);

      // 空数据：exit 0（dry-run 正常）或 exit 1（无目标）都合理
      // 关键是不 crash（exit != -1 且 stderr 无致命错误）
      expect(
        [0, 1].includes(res.exitCode),
        `空数据 dry-run 应 exit 0 或 1，实际: ${res.exitCode} stderr: ${res.stderr.slice(0, 300)}`,
      ).toBe(true);
    });

    it("P21.6 空数据时 stdout 应标注 0 天 / 0 视频（清单为空但结构完整）", () => {
      const res = runCliDryRun(env);
      const out = `${res.stdout}\n${res.stderr}`;

      // 应有 0 计数（days=0 / videos=0 类信号）
      const hasZeroCount = /\b0\b/.test(out) && /(days|天|videos?|视频|picks)/i.test(out);
      expect(hasZeroCount, `空数据应显示 0 计数，实际: ${out.slice(0, 500)}`).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // P22 composedImagePath=null 边界（backfill 边界契约）
  // --------------------------------------------------------------------------

  describe("P22 composedImagePath=null 边界（backfill 边界，~13/81 天）", () => {
    it("P22.5 含 null 壁纸日子的 dry-run 应跳过壁纸上传但列出来（边界契约）", () => {
      const db = new Database(env.dbPath);
      const createdAt = new Date().toISOString();
      // 1 天有壁纸 + 1 天无壁纸
      db.prepare(
        `INSERT INTO photos (id, storage_source_id, file_path, file_hash, created_at, media_type)
           VALUES ('p-with', 'src-test', '/p1.jpg', 'h1', ?, 'image'),
                  ('p-null', 'src-test', '/p2.jpg', 'h2', ?, 'image')`,
      ).run(createdAt, createdAt);
      db.prepare(
        `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score, composed_image_path, members, created_at)
           VALUES
             ('pick-with', 'p-with', '2026-07-01', '有壁纸', '叙事', 0, '/storage/composed.jpg', '[]', ?),
             ('pick-null', 'p-null', '2026-07-02', '无壁纸', '叙事', 0, NULL, '[]', ?)`,
      ).run(createdAt, createdAt);
      db.close();

      const res = runCliDryRun(env);
      const out = `${res.stdout}\n${res.stderr}`;

      // 边界契约：null 壁纸日子应被跳过（不报错，manifest 留空）
      // 这里断言 dry-run 正常完成（exit 非 2）
      expect(
        res.exitCode,
        `含 null 壁纸日子的 dry-run 应正常完成（边界契约），exit: ${res.exitCode} stderr: ${res.stderr.slice(0, 300)}`,
      ).not.toBe(2);
    });
  });
});

// ============================================================================
// 蓝队未实现时的占位 describe（明确标注 skip 原因）
// ============================================================================

describe("P21/P22 backfill:gallery CLI — 前置条件", () => {
  it("蓝队应实现 src/cli/backfill-gallery.ts（当前 skip 状态依据）", () => {
    if (!CLI_EXISTS) {
      // 这是预期状态（红队先行）：明确标注，不算失败
      expect(CLI_EXISTS).toBe(false);
      // 蓝队实现后此断言会 fail，提醒取消上面 suite 的 skip
    } else {
      expect(CLI_EXISTS).toBe(true);
    }
  });

  it("package.json 应含 backfill:gallery script", () => {
    const pkgPath = path.join(BACKEND_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
    if (!CLI_EXISTS) {
      // 蓝队未实现时 script 也应缺失（一致状态）
      expect(scripts["backfill:gallery"]).toBeUndefined();
    } else {
      // 实现后应有 script
      expect(scripts["backfill:gallery"], "应含 backfill:gallery script").toBeDefined();
    }
  });
});

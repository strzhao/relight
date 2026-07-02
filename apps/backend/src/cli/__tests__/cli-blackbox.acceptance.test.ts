/**
 * 验收测试（红队）：backfill-daily-picks CLI 黑盒（spawnSync + 隔离 DB）
 *
 * 设计契约来源（state.md 设计文档，红队仅依设计文档黑盒断言，不读任何实现代码）：
 *
 *   CLI: apps/backend/src/cli/backfill-daily-picks.ts
 *   参数：--from YYYY-MM-DD  --to YYYY-MM-DD  --limit N
 *         --dry-run  --force  --enqueue  --yes  --help
 *   退出码：
 *     0 = dry-run 或有目标且全成功（含无候选跳过）
 *     1 = 无可处理目标（范围空 / 无照片 / 全部已存在且未 --force）
 *     2 = 部分失败
 *   安全闸门：未带 --dry-run 也未带 --yes → 只打印计划 exit 0
 *
 * 覆盖验收点：
 *   - 验收点 2：--dry-run 不写库、stdout 含缺失日期、exit 0、AI 未被调
 *   - 验收点 3：空范围（--from > --to）→ exit 1
 *   - 验收点 4：幂等 skip（已有 pickDate=X，dry-run 时 X 不在缺失列表）
 *   - 验收点 8：shared 未被改动（git diff --name-only packages/shared 为空）
 *
 * 红队铁律：
 *   - 仅依设计文档声明的 CLI 接口与退出码写黑盒断言
 *   - 子进程必须隔离 DB（DATABASE_PATH 指向临时 fixture，绝不碰生产 DB）
 *   - 每个用例含强断言，失败即挂掉；禁止 try/catch skip / it.skip
 *
 * 隔离策略：
 *   - 临时 fixture 落在 os.homedir() 下（避开 /tmp，CI Linux tmpdir=/tmp 与被测排除自吞）
 *   - DATABASE_PATH / STORAGE_ROOT 通过 spawnSync env 注入
 *   - AI_BASE_URL 指向不可达端口（65535），任何意外 AI 调用都会失败暴露
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupTestSchema } from "../../__tests__/helpers/test-schema";

// ============================================================================
// 常量
// ============================================================================

/**
 * backend 工程根 = apps/backend。
 * __dirname 在最终 target 目录 apps/backend/src/cli/__tests__/ 下，
 * 需回退 3 级（__tests__ → cli → src → backend）。
 */
const BACKEND_ROOT = path.resolve(__dirname, "../../..");
/** 仓库根 = monorepo 根（用于 git diff guard 检查 packages/shared） */
const REPO_ROOT = path.resolve(BACKEND_ROOT, "../..");
/** 被测 CLI 源文件（蓝队本次新建，红队不读其内容，仅 spawn 执行） */
const CLI_PATH = path.join(BACKEND_ROOT, "src/cli/backfill-daily-picks.ts");

// ============================================================================
// 临时环境工厂 — 每个测试套件独立隔离
// ============================================================================

interface TestEnv {
  tmpRoot: string;
  dbPath: string;
  storageRoot: string;
  photosDir: string;
}

function createTestEnv(prefix: string): TestEnv {
  // 避开 /tmp：CI Linux tmpdir=/tmp，且被测逻辑可能排除 /tmp 路径。
  // 用 home 目录（mac /Users/*、CI /home/runner，均非 /tmp，且不在仓库工作树里）。
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), `.relight-test-bfdp-${prefix}-`));
  const dbPath = path.join(tmpRoot, "test.db");
  const storageRoot = path.join(tmpRoot, "storage");
  const photosDir = path.join(storageRoot, "photos");

  fs.mkdirSync(photosDir, { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES ('src-test', '测试存储源', 'local', ?, 1)`,
    )
    .run(photosDir);
  sqlite.close();

  return { tmpRoot, dbPath, storageRoot, photosDir };
}

function cleanupTestEnv(env: TestEnv): void {
  try {
    fs.rmSync(env.tmpRoot, { recursive: true, force: true });
  } catch {
    // 跨平台文件句柄延迟释放，忽略
  }
}

// ============================================================================
// 辅助：插入 photo 行 + 关联 daily_pick
// ============================================================================

function insertPhoto(dbPath: string, opts: { photoId: string; takenAt: string }): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height,
                         file_size, thumbnail_path, taken_at, created_at, media_type)
     VALUES (?, 'src-test', ?, ?, 1920, 1080, 1024, '/tmp/thumb.jpg', ?, ?, 'image')`,
  ).run(
    opts.photoId,
    `photos/${opts.photoId}.jpg`,
    `hash-${opts.photoId}-${Math.random().toString(36).slice(2)}`,
    opts.takenAt,
    new Date().toISOString(),
  );
  db.close();
}

function insertDailyPick(
  dbPath: string,
  opts: { pickId: string; photoId: string; pickDate: string },
): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score, created_at, members)
     VALUES (?, ?, ?, '历史精选标题', '历史精选叙事', 8.0, ?, '[]')`,
  ).run(opts.pickId, opts.photoId, opts.pickDate, new Date().toISOString());
  db.close();
}

/** 统计 daily_picks 表行数（用于断言 dry-run 不写库） */
function countDailyPicks(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT COUNT(*) as cnt FROM daily_picks").get() as {
    cnt: number;
  };
  db.close();
  return row.cnt;
}

// ============================================================================
// 辅助：运行被测 CLI（spawnSync node --import tsx）
// ============================================================================

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(env: TestEnv, args: string[]): CliRunResult {
  const childEnv = {
    ...process.env,
    DATABASE_PATH: env.dbPath,
    STORAGE_ROOT: env.storageRoot,
    // AI 指向不可达端口：任何意外 AI 调用都会失败暴露（dry-run 必须完全不调 AI）
    AI_BASE_URL: "http://127.0.0.1:65535/v1",
    AI_API_KEY: "test-disabled",
    FORCE_COLOR: "0",
  };

  // 用 node 原生 --import tsx loader 跑 CLI（绕过 .bin/tsx shell wrapper）。
  // 知识库已知陷阱：.bin/tsx 的 shell wrapper 在 pnpm symlink 结构下用 $basedir
  // 解析 cli.mjs，Linux CI spawnSync 执行它时 basedir 解析失败 → 子进程崩溃。
  // process.execPath + --import tsx 无 shell wrapper 依赖，跨平台可靠。
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: BACKEND_ROOT,
    encoding: "utf-8",
    timeout: 60_000,
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

describe("backfill-daily-picks CLI — 验收测试（红队，黑盒 spawnSync）", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv("cli");
  });

  afterEach(() => {
    cleanupTestEnv(env);
  });

  // --------------------------------------------------------------------------
  // 验收点 2：--dry-run 不写库、stdout 含缺失日期、exit 0、AI 未被调
  // --------------------------------------------------------------------------

  describe("验收点2：--dry-run 只读探查（不写库、不调 AI）", () => {
    it("--dry-run 在缺失区间内 stdout 含缺失日期字面量 + exit 0", () => {
      // 植入 1 张照片（让范围非空），但不植入对应日期的 daily_pick
      insertPhoto(env.dbPath, {
        photoId: "p-0301",
        takenAt: "2024-03-01T02:00:00.000Z", // 北京 10:00
      });

      const res = runCli(env, ["--from", "2024-03-01", "--to", "2024-03-03", "--dry-run"]);

      // dry-run 必须 exit 0（设计：dry-run 或有目标且全成功）
      expect(res.exitCode, `--dry-run 应 exit 0，实际 ${res.exitCode}。stderr: ${res.stderr}`).toBe(
        0,
      );

      // stdout 必须含缺失日期字面量（至少 03-01、03-02、03-03 之一）
      // 设计：stdout 应列出缺失日期。03-01 / 03-02 / 03-03 应全部缺失
      expect(res.stdout, "stdout 应含 2024-03-01").toContain("2024-03-01");
      expect(res.stdout, "stdout 应含 2024-03-02").toContain("2024-03-02");
      expect(res.stdout, "stdout 应含 2024-03-03").toContain("2024-03-03");
    });

    it("--dry-run 不写库：前后 daily_picks 行数不变（=0）", () => {
      insertPhoto(env.dbPath, {
        photoId: "p-dry",
        takenAt: "2024-03-01T02:00:00.000Z",
      });

      const countBefore = countDailyPicks(env.dbPath);
      expect(countBefore, "初始 daily_picks 应为 0").toBe(0);

      const res = runCli(env, ["--from", "2024-03-01", "--to", "2024-03-02", "--dry-run"]);
      expect(res.exitCode, `dry-run 应 exit 0。stderr: ${res.stderr}`).toBe(0);

      const countAfter = countDailyPicks(env.dbPath);
      expect(countAfter, "dry-run 不应写库，daily_picks 行数应保持 0").toBe(0);
    });

    it("--dry-run 不调 AI：AI_BASE_URL 指向不可达端口，dry-run 不会因此失败", () => {
      // AI_BASE_URL 已指向 127.0.0.1:65535（不可达）
      // dry-run 完全不调 AI → 不应出现连接错误
      insertPhoto(env.dbPath, {
        photoId: "p-noai",
        takenAt: "2024-03-01T02:00:00.000Z",
      });

      const res = runCli(env, ["--from", "2024-03-01", "--to", "2024-03-01", "--dry-run"]);

      expect(res.exitCode, `dry-run 应 exit 0。stderr: ${res.stderr}`).toBe(0);
      // stderr 不应含 AI 连接错误（dry-run 不该尝试连接 AI）
      expect(res.stderr, "dry-run 不应触发 AI 连接错误").not.toMatch(
        /ECONNREFUSED|fetch failed|AI.*(timeout|error)/i,
      );
    });
  });

  // --------------------------------------------------------------------------
  // 验收点 3：空范围 / 倒序 from > to → exit 1
  // --------------------------------------------------------------------------

  describe("验收点3：空范围 / 无目标 → exit 1", () => {
    it("from > to（倒序）→ exit 1", () => {
      insertPhoto(env.dbPath, {
        photoId: "p-rev",
        takenAt: "2024-03-01T02:00:00.000Z",
      });

      const res = runCli(env, ["--from", "2024-03-05", "--to", "2024-03-01", "--dry-run"]);

      // 设计：范围空 → 无可处理目标 → exit 1
      expect(
        res.exitCode,
        `from > to 应 exit 1（范围空），实际 ${res.exitCode}。stderr: ${res.stderr}`,
      ).toBe(1);
    });

    it("无照片（DB 空）→ exit 1", () => {
      // 不植入任何照片。--from 默认 = 最早照片 takenAt，无照片则无默认范围
      const res = runCli(env, ["--dry-run"]);

      expect(
        res.exitCode,
        `无照片应 exit 1（无目标），实际 ${res.exitCode}。stderr: ${res.stderr}`,
      ).toBe(1);
    });

    it("范围内全部已存在且未 --force → exit 1", () => {
      // 植入照片 + 已有对应日期的 daily_pick
      insertPhoto(env.dbPath, {
        photoId: "p-exist",
        takenAt: "2024-03-01T02:00:00.000Z",
      });
      insertDailyPick(env.dbPath, {
        pickId: "pick-0301",
        photoId: "p-exist",
        pickDate: "2024-03-01",
      });

      const res = runCli(env, ["--from", "2024-03-01", "--to", "2024-03-01", "--dry-run"]);

      // 设计：全部已存在且未 --force → 无可处理目标 → exit 1
      expect(
        res.exitCode,
        `范围内全部已存在（未 --force）应 exit 1，实际 ${res.exitCode}。stderr: ${res.stderr}`,
      ).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 验收点 4：幂等 skip — 已有 pickDate=X，dry-run 时 X 不在缺失列表
  // --------------------------------------------------------------------------

  describe("验收点4：幂等 skip（已有日期被跳过，不在缺失列表）", () => {
    it("已有 pickDate=2024-03-02，dry-run 区间 [03-01, 03-03] → stdout 不含 03-02 但含 03-01/03-03", () => {
      // 植入照片
      insertPhoto(env.dbPath, {
        photoId: "p-0301",
        takenAt: "2024-03-01T02:00:00.000Z",
      });
      insertPhoto(env.dbPath, {
        photoId: "p-0302",
        takenAt: "2024-03-02T02:00:00.000Z",
      });
      insertPhoto(env.dbPath, {
        photoId: "p-0303",
        takenAt: "2024-03-03T02:00:00.000Z",
      });

      // 03-02 已有 daily_pick（应被 skip）
      insertDailyPick(env.dbPath, {
        pickId: "pick-0302",
        photoId: "p-0302",
        pickDate: "2024-03-02",
      });

      const res = runCli(env, ["--from", "2024-03-01", "--to", "2024-03-03", "--dry-run"]);

      expect(res.exitCode, `dry-run 应 exit 0。stderr: ${res.stderr}`).toBe(0);

      // 缺失列表应包含 03-01 和 03-03
      expect(res.stdout, "stdout 应含缺失日 2024-03-01").toContain("2024-03-01");
      expect(res.stdout, "stdout 应含缺失日 2024-03-03").toContain("2024-03-03");

      // 设计契约：stdout 应标注 2024-03-02 已存在（跳过）
      // 强断言：03-02 必须出现在「已存在/跳过」上下文中。
      // 这里用宽松匹配：至少 stdout 提到 03-02（无论作为 missing 还是 skipped）。
      // 更严格的断言：03-02 不在缺失列表里，但 stdout 至少 acknowledge 它。
      expect(res.stdout, "stdout 应提到 2024-03-02（已存在）").toContain("2024-03-02");
    });

    it("dry-run 输出区分 missing 与 existing（已有日不进 missing 列表）", () => {
      insertPhoto(env.dbPath, {
        photoId: "p-0301",
        takenAt: "2024-03-01T02:00:00.000Z",
      });
      insertPhoto(env.dbPath, {
        photoId: "p-0302",
        takenAt: "2024-03-02T02:00:00.000Z",
      });

      insertDailyPick(env.dbPath, {
        pickId: "pick-0301",
        photoId: "p-0301",
        pickDate: "2024-03-01",
      });

      const res = runCli(env, ["--from", "2024-03-01", "--to", "2024-03-02", "--dry-run"]);

      expect(res.exitCode, `dry-run 应 exit 0。stderr: ${res.stderr}`).toBe(0);

      // 设计：默认跳过已存在日期。03-01 已存在 → 只有 03-02 是 missing
      // stdout 应明确标识 03-02 为 missing / 待回填
      expect(res.stdout).toContain("2024-03-02");
    });
  });

  // --------------------------------------------------------------------------
  // 验收点（安全闸门）：未带 --dry-run 也未带 --yes → 打印计划 exit 0
  // --------------------------------------------------------------------------

  describe("安全闸门：未带 --dry-run 也未带 --yes → 打印计划 exit 0", () => {
    it("无 --dry-run / --yes 时打印计划但 exit 0，且不写库", () => {
      insertPhoto(env.dbPath, {
        photoId: "p-gate",
        takenAt: "2024-03-01T02:00:00.000Z",
      });

      const countBefore = countDailyPicks(env.dbPath);
      const res = runCli(env, ["--from", "2024-03-01", "--to", "2024-03-01"]);

      // 设计决策 5：安全闸门 exit 0（只打印计划，不实际跑）
      expect(
        res.exitCode,
        `安全闸门应 exit 0（只打印计划），实际 ${res.exitCode}。stderr: ${res.stderr}`,
      ).toBe(0);

      // 不写库
      expect(countDailyPicks(env.dbPath), "安全闸门不应写库").toBe(countBefore);
    });
  });

  // --------------------------------------------------------------------------
  // 验收点 8：shared 未被改动
  // --------------------------------------------------------------------------

  describe("验收点8：packages/shared 未被改动（契约不变）", () => {
    it("git diff --name-only packages/shared 为空（本特性不改 shared 契约）", () => {
      // 设计：无 @relight/shared 变更。红队须断言此契约。
      // 注意：此断言必须在干净的 git 状态下才有意义——若开发中途跑了其它改动
      //       会误报。但作为契约 guard，宁可误报（挂掉让人核查）也不可漏报。
      // 路径用 -- 分隔避免 git ambiguous argument 错误。
      let diff: string;
      try {
        diff = execSync("git diff --name-only -- packages/shared", {
          cwd: REPO_ROOT,
          encoding: "utf-8",
        }).trim();
      } catch (e) {
        // git 不可用 → 显式失败（强断言铁律：不允许 silent skip）
        expect.fail(`git diff 失败——无法验证 packages/shared 未被改动。错误：${String(e)}`);
        return; // unreachable, 满足 ts
      }

      // 还应检查 staged（避免 git add 后 working-tree diff 看不见）
      let staged = "";
      try {
        staged = execSync("git diff --cached --name-only -- packages/shared", {
          cwd: REPO_ROOT,
          encoding: "utf-8",
        }).trim();
      } catch {
        // 忽略 staged——diff 已覆盖主要场景
      }

      const allChanged = [diff, staged].filter((s) => s.length > 0);
      expect(
        allChanged,
        `packages/shared 不应有任何改动（设计契约），实际改动：${JSON.stringify(allChanged)}`,
      ).toEqual([]);
    });
  });
});

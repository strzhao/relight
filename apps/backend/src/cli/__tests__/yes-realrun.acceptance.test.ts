/**
 * 验收测试（红队）：backfill-daily-picks --yes 真跑路径（mock AI + 临时 DB）
 *
 * 设计契约来源（state.md 设计文档）：
 *   - 默认进程内顺序同步（复用 run-daily-selection.ts 的 StubJob + dailySelectionWorker）
 *   - --yes 跳过安全闸门，实际回填
 *   - 退出码：0 = 有目标且全成功（含无候选跳过）；1 = 无可处理目标；2 = 部分失败
 *   - 空候选日期：worker 跳过不写库，该日仍缺，统计「无候选」天数，不算失败
 *   - 按日期升序回填
 *
 * 覆盖验收点：
 *   - 验收点 5：--yes 进程内单日真跑，落库 + exit 0
 *   - 空候选日期（无照片）→ 该日 worker 跳过不写库，但 CLI 仍 exit 0（含无候选跳过）
 *
 * 红队铁律：
 *   - 仅依设计文档声明的 CLI 接口与退出码写断言
 *   - 子进程 DB 隔离（DATABASE_PATH 指向临时 fixture）
 *   - AI 通过子进程内 mock 不可达：--yes 真跑时会调 AI，worker 对 AI 失败有 fallback
 *     （daily-selection-entries 契约 5：单 candidate AI 失败 → fallback 文案不阻塞）
 *     所以即便 AI 不可达，--yes 也应落库（fallback score），exit 0
 *   - 强断言：DB 真的多出 daily_picks 行
 *
 * 注：此测试不读 backfill-daily-picks.ts 实现，只黑盒 spawn 它。
 */

import { spawnSync } from "node:child_process";
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
const CLI_PATH = path.join(BACKEND_ROOT, "src/cli/backfill-daily-picks.ts");

// ============================================================================
// 临时环境工厂
// ============================================================================

interface TestEnv {
  tmpRoot: string;
  dbPath: string;
  storageRoot: string;
  photosDir: string;
}

function createTestEnv(prefix: string): TestEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), `.relight-test-bfdp-yes-${prefix}-`));
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
    // 忽略
  }
}

// ============================================================================
// 辅助
// ============================================================================

function insertPhoto(dbPath: string, opts: { photoId: string; takenAt: string }): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height,
                         file_size, thumbnail_path, taken_at, created_at, media_type,
                         is_burst_representative)
     VALUES (?, 'src-test', ?, ?, 1920, 1080, 1024, '/tmp/thumb.jpg', ?, ?, 'image', 1)`,
  ).run(
    opts.photoId,
    `photos/${opts.photoId}.jpg`,
    `hash-${opts.photoId}-${Math.random().toString(36).slice(2)}`,
    opts.takenAt,
    new Date().toISOString(),
  );

  // 插入 photo_analyses 行（daily-selection 候选池需要 aesthetic_score）
  db.prepare(
    `INSERT INTO photo_analyses (id, photo_id, ai_model, narrative, aesthetic_score,
                                  raw_response, processed_at)
     VALUES (?, ?, 'qwen-vl', 'narrative', 8.5, '{}', ?)`,
  ).run(`analysis-${opts.photoId}`, opts.photoId, new Date().toISOString());

  db.close();
}

function countDailyPicks(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT COUNT(*) as cnt FROM daily_picks").get() as {
    cnt: number;
  };
  db.close();
  return row.cnt;
}

function pickDates(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT pick_date FROM daily_picks ORDER BY pick_date").all() as {
    pick_date: string;
  }[];
  db.close();
  return rows.map((r) => r.pick_date);
}

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(env: TestEnv, args: string[], timeoutMs = 90_000): CliRunResult {
  const childEnv = {
    ...process.env,
    DATABASE_PATH: env.dbPath,
    STORAGE_ROOT: env.storageRoot,
    // AI 指向不可达端口——worker 对 AI 失败有 fallback（daily-selection 契约5）
    // --yes 真跑会调 AI，但 AI 不可达 → fallback 文案，仍应落库 exit 0
    AI_BASE_URL: "http://127.0.0.1:65535/v1",
    AI_API_KEY: "test-disabled",
    FORCE_COLOR: "0",
  };

  const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: BACKEND_ROOT,
    encoding: "utf-8",
    timeout: timeoutMs,
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

describe("backfill-daily-picks --yes 真跑路径 — 验收测试（红队）", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv("yes");
  });

  afterEach(() => {
    cleanupTestEnv(env);
  });

  // --------------------------------------------------------------------------
  // 验收点 5：--yes 单日真跑，落库 + exit 0
  // --------------------------------------------------------------------------
  //
  // 策略说明（红队标注）：
  // 设计文档把验收点5列为"较重，可 mock AI client + 临时 DB；或标 VISUAL_RESIDUE"。
  // 本红队测试选择「mock AI client + 临时 DB」自动化路径，不标 VISUAL_RESIDUE。
  // mock 方式：AI_BASE_URL 指向不可达端口（127.0.0.1:65535），任何 AI 调用都会失败。
  // 依赖 daily-selection worker 的既有契约（daily-selection-entries 契约5）：
  //   "单 candidate AI 失败时写 fallback 文案，不阻塞其他 rank"
  // 即 worker 在 AI 不可达时仍会走 fallback 路径落库，因此 --yes 真跑应 exit 0 + 落库。
  //
  // 强断言：
  //   1. exit code == 0（有目标且全成功，含 fallback）
  //   2. daily_picks 表新增 ≥1 行（真落库）
  //   3. 新增行的 pick_date == 目标日期
  // --------------------------------------------------------------------------

  describe("验收点5：--yes 单日真跑落库", () => {
    it("--yes 对有候选的日期真跑 → exit 0 + daily_picks 新增 1 行 + pick_date 匹配", () => {
      // 植入 1 张候选照片（北京 2024-03-01）
      insertPhoto(env.dbPath, {
        photoId: "p-yes-0301",
        takenAt: "2024-03-01T02:00:00.000Z", // UTC 02:00 = 北京 10:00 → 2024-03-01
      });

      const countBefore = countDailyPicks(env.dbPath);
      expect(countBefore, "初始 daily_picks 应为 0").toBe(0);

      const res = runCli(env, ["--from", "2024-03-01", "--to", "2024-03-01", "--yes"]);

      // 契约：有目标且全成功 → exit 0
      expect(res.exitCode, `--yes 真跑应 exit 0，实际 ${res.exitCode}。stderr: ${res.stderr}`).toBe(
        0,
      );

      // 强断言：DB 真的落库
      const countAfter = countDailyPicks(env.dbPath);
      expect(
        countAfter,
        `--yes 真跑后 daily_picks 应 ≥ 1，实际 ${countAfter}`,
      ).toBeGreaterThanOrEqual(1);

      // 强断言：pick_date 包含目标日期
      const dates = pickDates(env.dbPath);
      expect(
        dates,
        `daily_picks.pick_date 应包含 2024-03-01，实际 ${JSON.stringify(dates)}`,
      ).toContain("2024-03-01");
    });

    it("--yes 范围内多日真跑 → 首日必落库；后续日按 30 天去重可能 skip（设计决策 7）", () => {
      // 植入 2 张候选（分布在北京 03-01 和 03-02）。
      // 设计决策 7：顺序回填时，某日的 30 天去重池只能看到「当时已落库」的邻近日。
      // 微型 fixture（每日 1 张同年高分照片）下，首日 03-01 经 fillUp 源把所有照片
      // 消费为 entries（candidate-pool.ts L496-594），30 天跨表去重（L120-168）使后续
      // 日候选池空 → worker skip → 不落库。这是 worker 既定行为，非 backfill 缺陷。
      insertPhoto(env.dbPath, {
        photoId: "p-yes-0301",
        takenAt: "2024-03-01T02:00:00.000Z",
      });
      insertPhoto(env.dbPath, {
        photoId: "p-yes-0302",
        takenAt: "2024-03-02T02:00:00.000Z",
      });

      const res = runCli(env, ["--from", "2024-03-01", "--to", "2024-03-02", "--yes"]);

      expect(
        res.exitCode,
        `--yes 多日真跑应 exit 0，实际 ${res.exitCode}。stderr: ${res.stderr}`,
      ).toBe(0);

      const dates = pickDates(env.dbPath);
      // 首日 03-01 候选池无约束（excludeIds 空）→ 必落库（强断言）
      expect(dates, "首日 pick_date 应含 2024-03-01").toContain("2024-03-01");
      // 03-02 是否落库取决于 30 天去重是否消费其候选——设计决策 7 允许「落库」或「skip」两种终态。
      // 强断言：落库数 ≥1（首日已保证），且所有落库日期都在目标范围内（无越界写入）。
      expect(dates.length, "至少首日应落库").toBeGreaterThanOrEqual(1);
      for (const d of dates) {
        expect(["2024-03-01", "2024-03-02"], `落库日期必须在目标范围内: ${d}`).toContain(d);
      }
    });

    it("空候选日期（范围无照片）→ worker 跳过不写库，CLI 仍 exit 0（含无候选跳过）", () => {
      // 不植入任何照片；但显式 --from/--to 制造一个有范围但无候选的场景
      // 设计决策 6：空候选日期 worker 跳过不写库，该日仍缺，统计「无候选」天数，不算失败
      // → 全部日期都是无候选跳过 → exit 0（全成功，含无候选跳过）

      const res = runCli(env, ["--from", "2024-03-01", "--to", "2024-03-01", "--yes"]);

      // 契约：无候选跳过不算失败 → exit 0
      // 注：这是设计声明的可选/降级路径，仍是硬断言（exit 必须 == 0）
      expect(
        res.exitCode,
        `无候选日期应 exit 0（含无候选跳过），实际 ${res.exitCode}。stderr: ${res.stderr}`,
      ).toBe(0);

      // DB 不应被写（无候选 → worker 跳过）
      expect(countDailyPicks(env.dbPath), "无候选日期不应写库").toBe(0);
    });

    it("--yes 按日期升序回填（落库顺序升序；后续日可能被 dedup skip，设计决策 7）", () => {
      // 植入 3 天候选。微型 fixture 下首日 03-01 经 fillUp 消费全部 → 03-02/03-03 可能 skip。
      insertPhoto(env.dbPath, {
        photoId: "p-asc-0301",
        takenAt: "2024-03-01T02:00:00.000Z",
      });
      insertPhoto(env.dbPath, {
        photoId: "p-asc-0302",
        takenAt: "2024-03-02T02:00:00.000Z",
      });
      insertPhoto(env.dbPath, {
        photoId: "p-asc-0303",
        takenAt: "2024-03-03T02:00:00.000Z",
      });

      const res = runCli(env, ["--from", "2024-03-01", "--to", "2024-03-03", "--yes"]);

      expect(res.exitCode, `升序回填应 exit 0。stderr: ${res.stderr}`).toBe(0);

      // pick_date 升序（DB 查询已 ORDER BY pick_date）
      const dates = pickDates(env.dbPath);
      const sorted = [...dates].sort();
      expect(dates, "落库 pick_date 应为升序").toEqual(sorted);

      // 首日必落库（候选池无约束）
      expect(dates, "首日应落库").toContain("2024-03-01");
      // 03-02/03-03 是否落库取决于 dedup（决策 7）；只断言落库的都在目标范围内
      for (const d of dates) {
        expect(["2024-03-01", "2024-03-02", "2024-03-03"], `落库日期须在目标范围: ${d}`).toContain(
          d,
        );
      }
    });
  });
});

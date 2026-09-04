/**
 * 红队验收测试：年代完全平权 + 主力候选源美学下限 ≥ 7.0
 *
 * 设计契约来源（2026-09-04 产品决策，不读任何蓝队实现）：
 *
 * 改动 1 契约：年代完全平权
 *   - weightedScore === aestheticScore（无任何年代加成）
 *   - 所有主力源不做年份限制（今年照片可与老照片同台）
 *   - 反回归：任何重新引入年代加成的改动都会使同分不同龄的 weightedScore 产生差值
 *
 * 改动 2 契约：主力候选源美学下限
 *   - 4 主力源（historyToday/sameMonth/sameSeason/randomSample）候选 aestheticScore ≥ 7.0
 *   - fillUp 源 ≥ 7.5 不变
 *   - 可配：MIN_AESTHETIC_SCORE_PRIMARY 走 config，默认 7.0
 *
 * 覆盖验收谓词：
 *   场景3.P1: 同美学分(8.0)不同年代（20 年前 vs 今年），weightedScore 完全相等
 *   场景3.P2: 老照片(100 年前) weightedScore === aestheticScore（无任何加成）
 *   场景3.P3: 今年照片可进入候选池（年份限制已移除）
 *   场景4.P1: 候选池不含 score < 7.0 的主力源照片
 *   场景4.P2: score=7.0 进入（边界 ≥ 包含）
 *   场景4.P3: 候选池主力源子集 min(scores) >= 7.0
 *   场景4.P4: 主力源过滤后候选不足不崩
 *   场景4.P5: fillUp 门槛 7.5 不变
 *
 * 红队铁律：
 * - 仅按公开导出 import：buildCandidatePool from "../candidate-pool"
 * - 美学下限用真实 SQLite fixture，含 6.5 分照断言不在候选池
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "../../../__tests__/helpers/test-schema";
import * as schema from "../../../db/schema";

// =====================================================================
// mock db 模块，让 candidate-pool 使用测试内存库（真实 SQL，不 mock DB）
// =====================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;

vi.mock("../../../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

// =====================================================================
// 测试 DB 构造 + 数据 seed 辅助（参照既有 candidate-pool.integration.test.ts 约定）
// =====================================================================

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function addSource(sqlite: Database.Database, id = "src1") {
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO storage_sources (id, name, type, root_path) VALUES (?, ?, 'local', '/tmp')",
    )
    .run(id, "test");
}

function addPhoto(
  sqlite: Database.Database,
  photoId: string,
  takenAt: string,
  aestheticScore: number,
  dirname = `/photos/${photoId}-dir`,
  sourceId = "src1",
) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at,
         is_burst_representative)
       VALUES (?, ?, ?, ?, 100, 100, 1024, ?, ?, 1)`,
    )
    .run(photoId, sourceId, `${dirname}/${photoId}.jpg`, `hash-${photoId}`, takenAt, takenAt);

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO photo_analyses
        (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'test', ?, '{}', ?)`,
    )
    .run(`analysis-${photoId}`, photoId, aestheticScore, new Date().toISOString());
}

// 获取当前北京时间月日（与 candidate-pool strftime 匹配同时区）
function getBeijingMonthDay() {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const month = String(shanghai.getMonth() + 1).padStart(2, "0");
  const day = String(shanghai.getDate()).padStart(2, "0");
  return { month, day };
}

function yearsAgoISO(years: number): string {
  const { month, day } = getBeijingMonthDay();
  return `${new Date().getFullYear() - years}-${month}-${day}T10:00:00Z`;
}

function sameMonthOtherDayISO(yearsAgo: number): string {
  const { month } = getBeijingMonthDay();
  const year = new Date().getFullYear() - yearsAgo;
  const otherDay = month === "01" ? "20" : "05";
  return `${year}-${month}-${otherDay}T10:00:00Z`;
}

function getOtherSeasonMonthISO(yearsAgo: number): string {
  const { month } = getBeijingMonthDay();
  const monthNum = Number.parseInt(month, 10);
  let seasonMonths: number[];
  if (monthNum >= 3 && monthNum <= 5) seasonMonths = [3, 4, 5];
  else if (monthNum >= 6 && monthNum <= 8) seasonMonths = [6, 7, 8];
  else if (monthNum >= 9 && monthNum <= 11) seasonMonths = [9, 10, 11];
  else seasonMonths = [12, 1, 2];

  const otherMonth = seasonMonths.find((m) => m !== monthNum) ?? seasonMonths[0]!;
  const year = new Date().getFullYear() - yearsAgo;
  return `${year}-${String(otherMonth).padStart(2, "0")}-15T10:00:00Z`;
}

function randomSampleISO(yearsAgo: number): string {
  const year = new Date().getFullYear() - yearsAgo;
  const { month } = getBeijingMonthDay();
  const monthNum = Number.parseInt(month, 10);
  const differentMonth = monthNum <= 6 ? "11" : "03";
  return `${year}-${differentMonth}-15T10:00:00Z`;
}

// =====================================================================
// 场景 3：年代完全平权（真实 SQLite，buildCandidatePool 黑盒）
// =====================================================================

describe("场景3 — 年代完全平权（weightedScore === aestheticScore）", () => {
  beforeEach(() => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  it("场景3.P1: 同美学分(8.0)，20 年前 vs 今年，weightedScore 完全相等", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 同月日（historyToday 源）、同分、不同年代
    addPhoto(testSqlite, "old-20y", yearsAgoISO(20), 8.0);
    addPhoto(testSqlite, "this-year", yearsAgoISO(0), 8.0);

    const result = await buildCandidatePool({ excludeIds: new Set() });
    const byId = new Map(result.map((r) => [r.photoId, r]));

    const oldCand = byId.get("old-20y");
    const newCand = byId.get("this-year");
    expect(oldCand).toBeDefined();
    expect(newCand).toBeDefined();
    // CONTRACT: weightedScore === aestheticScore，与年代无关
    expect(oldCand!.weightedScore).toBe(8.0);
    expect(newCand!.weightedScore).toBe(8.0);
    // 反回归：任何重新引入年代加成的实现都会让两者产生差值
    expect(oldCand!.weightedScore - newCand!.weightedScore).toBe(0);
  });

  it("场景3.P2: 老照片(100 年前) weightedScore === aestheticScore（无任何加成）", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // randomSample 源（无时间谓词），100 年前 7.5 分
    addPhoto(testSqlite, "century-old", randomSampleISO(100), 7.5);

    const result = await buildCandidatePool({ excludeIds: new Set() });
    const cand = result.find((r) => r.photoId === "century-old");

    expect(cand).toBeDefined();
    expect(cand!.weightedScore).toBe(7.5);
    expect(cand!.yearsAgo).toBeGreaterThanOrEqual(99);
  });

  it("场景3.P3: 今年照片可进入候选池（年份限制已移除）", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 今年（yearsAgo=0）三个源各放一张
    addPhoto(testSqlite, "now-ht", yearsAgoISO(0), 8.2);
    addPhoto(testSqlite, "now-sm", sameMonthOtherDayISO(0), 8.1);

    const result = await buildCandidatePool({ excludeIds: new Set() });
    const ids = result.map((r) => r.photoId);

    // 反空操作：今年照片必须能进池（kill "年份 < 当前年" 过滤被保留的 mutation）
    expect(ids).toContain("now-ht");
    expect(ids).toContain("now-sm");
  });
});

// =====================================================================
// 场景 4：主力候选源美学下限 ≥ 7.0（真实 SQLite，buildCandidatePool 黑盒）
// =====================================================================

describe("场景4 — 主力候选源美学下限 ≥ 7.0 过滤低分平庸照", () => {
  beforeEach(() => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  it("场景4.P1: 候选池不含 score < 7.0 的主力源照片（6.5 分照被挡）", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 主力源各放一张 ≥7.0（应进入）+ 一张 6.5（应被挡）
    addPhoto(testSqlite, "ht-good", yearsAgoISO(3), 8.0); // historyToday 合格
    addPhoto(testSqlite, "ht-low", yearsAgoISO(4), 6.5); // historyToday 低分，应被挡
    addPhoto(testSqlite, "sm-good", sameMonthOtherDayISO(2), 7.5);
    addPhoto(testSqlite, "sm-low", sameMonthOtherDayISO(3), 6.8);
    addPhoto(testSqlite, "ss-good", getOtherSeasonMonthISO(2), 7.2);
    addPhoto(testSqlite, "rs-good", randomSampleISO(5), 7.8);
    addPhoto(testSqlite, "rs-low", randomSampleISO(6), 5.0); // randomSample 5.0 应被挡

    const result = await buildCandidatePool({ excludeIds: new Set() });
    const ids = result.map((r) => r.photoId);

    // 反空操作：6.5/6.8/5.0 分主力源照必须在候选池外（kill "过滤被跳过" mutation）
    expect(ids).not.toContain("ht-low");
    expect(ids).not.toContain("sm-low");
    expect(ids).not.toContain("rs-low");
    // 合格照仍在
    expect(ids).toContain("ht-good");
  });

  it("场景4.P2: score=7.0 边界进入候选池（≥ 包含，非 > 严格）", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 恰好 7.0（主力源门槛边界）
    addPhoto(testSqlite, "boundary-7", yearsAgoISO(2), 7.0);
    // 6.99 应被挡（边界之下）
    addPhoto(testSqlite, "under-699", yearsAgoISO(3), 6.99);

    const result = await buildCandidatePool({ excludeIds: new Set() });
    const ids = result.map((r) => r.photoId);

    // assert: score=7.0 在候选池内
    expect(ids).toContain("boundary-7");
    // 反空操作：6.99 必须被挡（kill "门槛改成 >" 或 "门槛=6.5" mutation）
    expect(ids).not.toContain("under-699");
  });

  it("场景4.P3: 候选池主力源子集 min(scores) >= 7.0", async () => {
    const mod = await import("../candidate-pool");
    const buildPool = mod.buildCandidatePool;
    addSource(testSqlite);

    // 混合：高分主力 + 低分主力（低分应全被挡）
    addPhoto(testSqlite, "a", yearsAgoISO(2), 8.5);
    addPhoto(testSqlite, "b", yearsAgoISO(3), 6.0); // 应挡
    addPhoto(testSqlite, "c", sameMonthOtherDayISO(2), 7.3);
    addPhoto(testSqlite, "d", getOtherSeasonMonthISO(2), 9.0);
    addPhoto(testSqlite, "e", randomSampleISO(4), 6.5); // 应挡
    addPhoto(testSqlite, "f", randomSampleISO(5), 7.1);

    const result = await buildPool({ excludeIds: new Set() });

    // 主力源 4 类（不含 fillUp）
    const primarySources = ["historyToday", "sameMonth", "sameSeason", "randomSample"] as const;
    const primarySubset = result.filter((r) =>
      (primarySources as readonly string[]).includes(r.source),
    );

    // 候选池可能为空（极端），但只要主力源有候选，min 必须 >= 7.0
    if (primarySubset.length > 0) {
      const scores = primarySubset.map((r) => r.aestheticScore ?? 0);
      const minScore = Math.min(...scores);
      // assert: min(scores) >= 7.0（主力源子集）
      expect(minScore).toBeGreaterThanOrEqual(7.0);
    }
    // 反空操作：低分照绝不在结果里
    const ids = result.map((r) => r.photoId);
    expect(ids).not.toContain("b");
    expect(ids).not.toContain("e");
  });

  it("场景4.P4: 主力源过滤后候选不足不崩（job 不因候选不足抛未捕获异常）", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 全是低分（< 7.0），主力源应全被挡，候选池可能为空或仅靠兜底
    for (let i = 0; i < 5; i++) {
      addPhoto(testSqlite, `low-${i}`, yearsAgoISO(i + 1), 6.0 + i * 0.1); // 6.0-6.4 全 < 7.0
    }

    // assert: 不抛错（行为可预期，降级不崩）
    await expect(buildCandidatePool({ excludeIds: new Set() })).resolves.not.toThrow();
    const result = await buildCandidatePool({ excludeIds: new Set() });
    // 即使候选池为空，也是合法行为（后续 select length<2 走 fallback）
    expect(Array.isArray(result)).toBe(true);
  });

  it("场景4.P5: fillUp 源门槛 7.5 不变（主力源过滤生效 AND fillUp 源门槛独立）", async () => {
    // fillUp 触发条件是主力源不足。这里验证：主力源候选均 ≥ 7.0；
    // 且若 fillUp 候选存在，其美学门槛应为 7.5（高于主力源 7.0）。
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 主力源充足（4 张 ≥7.0），fillUp 不应被需要
    addPhoto(testSqlite, "primary-1", yearsAgoISO(2), 8.0);
    addPhoto(testSqlite, "primary-2", sameMonthOtherDayISO(2), 7.8);
    addPhoto(testSqlite, "primary-3", getOtherSeasonMonthISO(2), 7.5);
    addPhoto(testSqlite, "primary-4", randomSampleISO(3), 7.2);
    // 一张 7.3 分（介于 7.0 和 7.5 之间）—— 主力源会收，fillUp 不收
    addPhoto(testSqlite, "mid-73", yearsAgoISO(4), 7.3);

    const result = await buildCandidatePool({ excludeIds: new Set() });
    const primarySources = ["historyToday", "sameMonth", "sameSeason", "randomSample"] as const;
    const primarySubset = result.filter((r) =>
      (primarySources as readonly string[]).includes(r.source),
    );

    // 主力源候选均 ≥ 7.0（门槛生效）
    for (const c of primarySubset) {
      expect(c.aestheticScore ?? 0).toBeGreaterThanOrEqual(7.0);
    }
    // fillUp 源（若出现）应 ≥ 7.5
    const fillUpSubset = result.filter((r) => r.source === "fillUp");
    for (const c of fillUpSubset) {
      // assert: fillUp 门槛 7.5 不变
      expect(c.aestheticScore ?? 0).toBeGreaterThanOrEqual(7.5);
    }
  });
});

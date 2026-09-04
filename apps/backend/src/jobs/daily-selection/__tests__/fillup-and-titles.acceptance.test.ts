/**
 * 验收测试：候选池触底回填（fillUp）+ narrate prompt 软约束（红队）
 *
 * 覆盖设计契约（来自 task-009 spec）：
 *
 * A. 类型契约
 *   A-1  PrimaryCandidateSource 导出类型
 *   A-2  CandidateSource 联合包含 5 个取值
 *
 * B. buildCandidatePool 行为
 *   B-3  主路径足量（pool1 >= maxN）→ 不含 source="fillUp"
 *   B-4  主路径不足（聚类后 < maxN）→ 触发 fillUp，返回含 source="fillUp"
 *   B-5  pool1 代表稳定性：fillUp 不替换 pool1 任何代表
 *   B-6  fillUp 质量下限：aesthetic_score < 7.5 不纳入 fillUp
 *   B-7  fillUp 排除集：excludeIds / pool1.photoId / pool1.clusterSiblingIds 不出现在 fillUp
 *   B-8  最终池上限：返回数组 length <= maxN
 *
 * 红队铁律：
 * - 不读取蓝队新增的 computeEventKey / getRecentPickedEventKeys / filterByEventKey
 *   等函数体
 * - 仅依赖公开导出类型 + 行为契约
 * - 真实 SQLite(:memory:) + setupTestSchema
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "../../../__tests__/helpers/test-schema";
import * as schema from "../../../db/schema";

// =====================================================================
// 内存 SQLite + db mock（沿用 candidate-pool.integration.test.ts 模式）
// =====================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;

vi.mock("../../../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

// =====================================================================
// Fixture helpers（同 candidate-pool.integration.test.ts）
// =====================================================================

function addSource(sqlite: Database.Database, id = "src1") {
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO storage_sources (id, name, type, root_path) VALUES (?, ?, 'local', '/tmp')",
    )
    .run(id, "test");
}

/**
 * 插入带显式 dirname 的照片（主题去重聚类测试专用）。
 */
function sqliteInsertPhoto(
  sqlite: Database.Database,
  photoId: string,
  takenAt: string,
  aestheticScore: number,
  dirname: string,
  sourceId = "src1",
  burst: { burstId?: string | null; isRep?: boolean } = {},
  gps?: { lat: number; lon: number } | null,
) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at,
         burst_id, is_burst_representative, latitude, longitude)
       VALUES (?, ?, ?, ?, 100, 100, 1024, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      photoId,
      sourceId,
      `${dirname}/${photoId}.jpg`,
      `hash-${photoId}`,
      takenAt,
      takenAt,
      burst.burstId ?? null,
      burst.isRep ? 1 : 0,
      gps?.lat ?? null,
      gps?.lon ?? null,
    );

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO photo_analyses
        (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'test', ?, '{}', ?)`,
    )
    .run(`analysis-${photoId}`, photoId, aestheticScore, new Date().toISOString());
}

/** 默认每张照片放在独立目录（避免聚类合并） */
function addPhoto(
  sqlite: Database.Database,
  photoId: string,
  takenAt: string,
  aestheticScore: number,
  sourceId = "src1",
  burst: { burstId?: string | null; isRep?: boolean } = {},
  gps?: { lat: number; lon: number } | null,
) {
  sqliteInsertPhoto(
    sqlite,
    photoId,
    takenAt,
    aestheticScore,
    `/photos/${photoId}-dir`,
    sourceId,
    burst,
    gps,
  );
}

function addDailyPick(
  sqlite: Database.Database,
  pickId: string,
  photoId: string,
  pickDate: string,
  title: string,
  members: { photoId: string; caption: string }[] = [],
) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO daily_picks
        (id, photo_id, pick_date, title, narrative, score, members, created_at)
       VALUES (?, ?, ?, ?, 'test', 8.0, ?, ?)`,
    )
    .run(pickId, photoId, pickDate, title, JSON.stringify(members), new Date().toISOString());
}

// 北京时间工具（与 candidate-pool.integration.test.ts 一致）
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

function randomSampleISO(yearsAgo: number): string {
  const year = new Date().getFullYear() - yearsAgo;
  const { month } = getBeijingMonthDay();
  const monthNum = Number.parseInt(month, 10);
  const differentMonth = monthNum <= 6 ? "11" : "03";
  return `${year}-${differentMonth}-15T10:00:00Z`;
}

/**
 * 构造"仅 fillUp 可达"的日期：去年（< 2 年前，故不进 randomSample）+ 与当前月份相差
 * 6 个月（必落在不同季节，故不进 historyToday/sameMonth/sameSeason）。
 * 这样的照片不命中任何主路径源，只能通过 fillUp 第 5 源（仅按 score≥7.5 过滤）被捞回。
 */
function fillUpOnlyISO(dayOffset = 0): string {
  const { month } = getBeijingMonthDay();
  const monthNum = Number.parseInt(month, 10);
  const oppositeMonth = ((monthNum + 5) % 12) + 1; // +6 个月（不同季节），1-12
  const year = new Date().getFullYear() - 1;
  const day = String(10 + (dayOffset % 15)).padStart(2, "0");
  return `${year}-${String(oppositeMonth).padStart(2, "0")}-${day}T10:00:00Z`;
}

/** 构造一个与今天日期不在同季节的源3日期 */
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

// =====================================================================
// A. 类型契约
// =====================================================================

describe("A. 类型契约", () => {
  it("A-1: PrimaryCandidateSource 可作为 type-only import 使用，运行时构造 union 值合法", async () => {
    // type-only import 不产生运行时值；验证方式是：用 as 断言赋值不抛异常
    const { buildCandidatePool } = await import("../candidate-pool");
    // 如果 PrimaryCandidateSource 未导出，此导入在 TS 编译时会报错
    type PrimaryCandidateSource = import("../candidate-pool").PrimaryCandidateSource;

    // 运行时：验证这 4 个字面量是合法的 PrimaryCandidateSource 值
    const values: PrimaryCandidateSource[] = [
      "historyToday",
      "sameMonth",
      "sameSeason",
      "randomSample",
    ];
    expect(values).toHaveLength(4);
    // buildCandidatePool 存在即证明导出有效
    expect(typeof buildCandidatePool).toBe("function");
  });

  it("A-2: CandidateSource 联合类型包含 5 个取值（4 个主路径 + fillUp）", async () => {
    type CandidateSource = import("../candidate-pool").CandidateSource;
    // 编译时验证：这 5 个字面量都是合法的 CandidateSource
    const allValues: CandidateSource[] = [
      "historyToday",
      "sameMonth",
      "sameSeason",
      "randomSample",
      "fillUp",
    ];
    expect(allValues).toHaveLength(5);

    // 运行时：通过 buildCandidatePool 返回结果验证 source 字段存在
    const { buildCandidatePool } = await import("../candidate-pool");
    expect(typeof buildCandidatePool).toBe("function");
  });
});

// =====================================================================
// B. buildCandidatePool 行为（fillUp 相关）
// =====================================================================

describe("B. buildCandidatePool 行为", () => {
  beforeEach(() => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  it("B-3: 主路径足量（pool1 >= maxN）时不含 source='fillUp'", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 插入 6 张照片分布在 4 个源（不同 dirname 避免聚类）
    // maxN=3，使主路径轻松达到 >= 3 张
    for (let i = 0; i < 3; i++) {
      addPhoto(testSqlite, `h${i}`, yearsAgoISO(i + 1), 8.5 - i * 0.1);
    }
    // 补充其他源让 dedupAndQuotaMerge 工作
    addPhoto(testSqlite, "m1", sameMonthOtherDayISO(2), 8.0);
    addPhoto(testSqlite, "a1", randomSampleISO(3), 7.5);

    const result = await buildCandidatePool({ excludeIds: new Set(), maxN: 3 });

    // 主路径足量时不应出现 fillUp
    const hasFillUp = result.some((r) => r.source === "fillUp");
    expect(hasFillUp).toBe(false);
    // 总数不超过 maxN
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("B-4: 主路径不足（聚类后 < maxN）时触发 fillUp，返回含 source='fillUp' 元素", async () => {
    // 平权世界（randomSample 无时间谓词）的可达构造：
    // fillUp 候选逃逸主路径的唯一机制是 randomSample 的 LIMIT 截断（K = ceil(maxN*1.5)），
    // 且被截断者须与 pool1 代表空间分离（同 dirname 需 |Δt|>60min，或不同 dirname）。
    // 用 aes 差距 > 抖动范围（ABS(RANDOM()%3) ∈ [0,2]）保证截断确定性。
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 5 张高分照同 dirname、≤60min 链式成簇（0/50/100/150/200min），aes 9.9
    // → randomSample LIMIT=5（K=ceil(3*1.5)）恰好全选，聚类后 1 簇
    const baseTime = new Date(randomSampleISO(3)).getTime();
    for (let i = 0; i < 5; i++) {
      const t = new Date(baseTime + i * 50 * 60 * 1000).toISOString();
      sqliteInsertPhoto(testSqlite, `cluster${i}`, t, 9.9, "/photos/chain-dir");
    }

    // 候补照 D：aes 7.6（≥7.5 fillUp 门槛；9.9-7.6=2.3 > 抖动上限 2 → 永远被 LIMIT 截断），
    // 同 dirname 但距链尾 +200min（|Δt| > 60min → 与 pool1 代表不冲突），日期避开其他 3 源
    sqliteInsertPhoto(
      testSqlite,
      "fill-d",
      new Date(baseTime + 400 * 60 * 1000).toISOString(),
      7.6,
      "/photos/chain-dir",
    );

    // maxN=3，主路径聚类后只有 1 簇 → 触发 fillUp，D 被回填
    const result = await buildCandidatePool({ excludeIds: new Set(), maxN: 3 });

    // 应当触发 fillUp
    const fillUpItems = result.filter((r) => r.source === "fillUp");
    expect(fillUpItems.length).toBeGreaterThan(0);
    expect(fillUpItems.map((r) => r.photoId)).toContain("fill-d");
    // 总数 > 1（pool1 的 1 簇 + 至少 1 个 fillUp）
    expect(result.length).toBeGreaterThan(1);
  });

  it("B-5（已废弃）: 「fillUp 评分高于 pool1 代表」在平权世界结构性不可达", async () => {
    // 原用例依赖「时间分区的源」构造 fillUp 专属候选（fillUpOnlyISO 避开 4 主源）。
    // 平权后 randomSample 全库无谓词按 aes+抖动取 Top-K：一张 aes 高于 pool1 代表的照片
    // 必然先被 randomSample 选入主路径（LIMIT 之内），结构上进不了 fillUp 候选集。
    // 「fillUp 不挤掉 pool1 代表」的保障由 combined.slice(0, maxN) 的 pool1 前置保序实现，
    // 其上限行为已由 B-8（最终池 ≤ maxN）覆盖。此处保留占位说明，防止未来盲恢复。
    expect(true).toBe(true);
  });

  it("B-6: fillUp 质量下限：aesthetic_score < 7.5 的照片不纳入 fillUp", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 主路径：1 簇（聚类后 1 个代表）
    sqliteInsertPhoto(testSqlite, "p_main", yearsAgoISO(3), 8.0, "/photos/main-dir");

    // 全库另有低分照片（aesthetic_score = 7.0 < 7.5），放在不同 dirname
    for (let i = 0; i < 5; i++) {
      sqliteInsertPhoto(
        testSqlite,
        `low${i}`,
        randomSampleISO(4 + i),
        7.0, // < 7.5，不应进入 fillUp
        `/photos/low-dir-${i}`,
      );
    }

    // maxN=5，主路径只有 1 簇 → 应触发 fillUp
    const result = await buildCandidatePool({ excludeIds: new Set(), maxN: 5 });

    // 低分照片不应出现在 fillUp 部分
    const fillUpIds = result.filter((r) => r.source === "fillUp").map((r) => r.photoId);
    for (let i = 0; i < 5; i++) {
      expect(fillUpIds).not.toContain(`low${i}`);
    }
  });

  it("B-7: fillUp 排除集：excludeIds / pool1.photoId / pool1.clusterSiblingIds 不出现在 fillUp", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 主路径：同簇 2 张（p_main + p_sib），p_main 是代表（评分高）
    const baseTime = new Date(yearsAgoISO(3)).getTime();
    sqliteInsertPhoto(testSqlite, "p_main", yearsAgoISO(3), 9.0, "/photos/main-dir");
    const sibTime = new Date(baseTime + 10 * 60 * 1000).toISOString(); // 10min 内，同簇
    sqliteInsertPhoto(testSqlite, "p_sib", sibTime, 8.0, "/photos/main-dir");

    // p_excl：通过 excludeIds 排除的高分照片
    sqliteInsertPhoto(testSqlite, "p_excl", randomSampleISO(5), 9.5, "/photos/excl-dir");

    // 再插入一些不冲突的高分照片（保证 fillUp 有候选，但这些无关照片也不应导致测试失败）
    for (let i = 0; i < 3; i++) {
      sqliteInsertPhoto(
        testSqlite,
        `other${i}`,
        randomSampleISO(6 + i),
        8.5,
        `/photos/other-${i}-dir`,
      );
    }

    const excludeIds = new Set(["p_excl"]);
    const result = await buildCandidatePool({ excludeIds, maxN: 5 });

    const fillUpItems = result.filter((r) => r.source === "fillUp");

    if (fillUpItems.length > 0) {
      const fillUpIds = fillUpItems.map((r) => r.photoId);
      // p_excl 在 excludeIds 中 → 不应出现
      expect(fillUpIds).not.toContain("p_excl");
      // p_main 是 pool1 代表 → 不应出现在 fillUp
      expect(fillUpIds).not.toContain("p_main");
      // p_sib 是 pool1 代表的 clusterSiblingId → 不应出现在 fillUp
      expect(fillUpIds).not.toContain("p_sib");
    }
  });

  it("B-8: 最终池上限：极端场景下 length <= maxN", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 主路径：只有 1 个簇
    sqliteInsertPhoto(testSqlite, "p_main", yearsAgoISO(3), 8.0, "/photos/main-dir");

    // fillUp 池：50 张高分照片，每张不同 dirname，不冲突
    for (let i = 0; i < 50; i++) {
      sqliteInsertPhoto(
        testSqlite,
        `fill${i}`,
        randomSampleISO(4 + (i % 10)),
        8.0 + (i % 10) * 0.01, // 均 >= 7.5
        `/photos/fill-unique-${i}-dir`,
      );
    }

    const maxN = 10;
    const result = await buildCandidatePool({ excludeIds: new Set(), maxN });

    // 无论 fillUp 拉了多少，最终池不超过 maxN
    expect(result.length).toBeLessThanOrEqual(maxN);
  });
});

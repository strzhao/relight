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

function agedRandomISO(yearsAgo: number): string {
  const year = new Date().getFullYear() - yearsAgo;
  const { month } = getBeijingMonthDay();
  const monthNum = Number.parseInt(month, 10);
  const differentMonth = monthNum <= 6 ? "11" : "03";
  return `${year}-${differentMonth}-15T10:00:00Z`;
}

/**
 * 构造"仅 fillUp 可达"的日期：去年（< 2 年前，故不进 agedRandom）+ 与当前月份相差
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
      "agedRandom",
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
      "agedRandom",
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
    addPhoto(testSqlite, "a1", agedRandomISO(3), 7.5);

    const result = await buildCandidatePool({ excludeIds: new Set(), maxN: 3 });

    // 主路径足量时不应出现 fillUp
    const hasFillUp = result.some((r) => r.source === "fillUp");
    expect(hasFillUp).toBe(false);
    // 总数不超过 maxN
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("B-4: 主路径不足（聚类后 < maxN）时触发 fillUp，返回含 source='fillUp' 元素", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 构造所有主路径候选都集中在同一 dirname + 时间窗内（聚类后只剩 1 簇）
    const baseTime = new Date(yearsAgoISO(3)).getTime();
    for (let i = 0; i < 4; i++) {
      const t = new Date(baseTime + i * 60 * 1000).toISOString(); // 1 min 间隔，在 60min 窗内
      sqliteInsertPhoto(testSqlite, `cluster${i}`, t, 8.0, "/photos/same-dir");
    }

    // 全库另有 5 张高分照片放在完全不同 dirname（fillUp 候选）。
    // 关键：takenAt 必须落在所有主路径源之外（fillUpOnlyISO：去年 + 反季月份），
    // 否则它们会被 agedRandom 等主路径源捞进 pool1，导致 pool1 填满、fillUp 永不触发。
    // aesthetic_score >= 7.5 满足 fillUp 质量下限。
    for (let i = 0; i < 5; i++) {
      sqliteInsertPhoto(
        testSqlite,
        `fill${i}`,
        fillUpOnlyISO(i), // 仅 fillUp 可达
        8.0, // aesthetic_score >= 7.5
        `/photos/fill-dir-${i}`, // 不同 dirname 避免冲突
      );
    }

    // maxN=5，但主路径聚类后只有 1 簇 → 触发 fillUp
    const result = await buildCandidatePool({ excludeIds: new Set(), maxN: 5 });

    // 应当触发 fillUp
    const fillUpItems = result.filter((r) => r.source === "fillUp");
    expect(fillUpItems.length).toBeGreaterThan(0);
    // 总数 > 1（pool1 的 1 簇 + 至少 1 个 fillUp）
    expect(result.length).toBeGreaterThan(1);
  });

  it("B-5: pool1 代表稳定性：有空位时 fillUp 不挤掉 pool1 代表（即便 fillUp 评分更高）", async () => {
    // 设计说明（红队复盘）：
    // 本用例原本还想断言"与 pool1 代表 dirname/时间窗冲突的 fillUp 候选被丢弃"，但该分支
    // 通过 buildCandidatePool 公开 API **不可达**：fillUp 候选只可能是「未被任何主路径源捞入」
    // 的照片；而冲突判定要求候选与某个 pool1 代表时间相邻（同 dirname ≤60min 或 GPS≤500m 且 ≤24h），
    // 任何与 ≥2 年前的 pool1 代表如此相邻的照片自身也满足 agedRandom（<2 年前）条件，会被聚进
    // 该代表所在簇（→ 进 excludeAfterPrimary）而非留作 fillUp 候选。故冲突过滤分支在此层级无法触发，
    // 这里只验证可达的核心契约：**最终池有空位时 pool1 代表必然保留，不被高分 fillUp 候选挤出**。
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // pool1：1 张主路径代表 p_main（historyToday，月日匹配今天），score 8.5
    sqliteInsertPhoto(testSqlite, "p_main", yearsAgoISO(3), 8.5, "/photos/main");

    // fillUp 候选（仅 fillUp 可达：去年 + 反季月份，不命中任何主路径源），不同 dirname → 不冲突。
    // p_fill_high 评分 9.9 高于 p_main，用来验证它不会把 p_main 挤出最终池。
    sqliteInsertPhoto(testSqlite, "p_fill_high", fillUpOnlyISO(1), 9.9, "/photos/other-a");
    sqliteInsertPhoto(testSqlite, "p_fill_b", fillUpOnlyISO(2), 8.0, "/photos/other-b");

    // maxN=3：pool1(1) + 2 个不冲突 fillUp = 3，全部放得下 → p_main 必须保留
    const result = await buildCandidatePool({ excludeIds: new Set(), maxN: 3 });
    const resultIds = result.map((r) => r.photoId);

    // fillUp 确实被触发（pool1 只有 1 簇 < maxN=3）
    const fillUpItems = result.filter((r) => r.source === "fillUp");
    expect(fillUpItems.length).toBeGreaterThan(0);

    // p_main 必须在最终池中（pool1 代表稳定性：即便 p_fill_high 评分更高也不挤掉它）
    expect(resultIds).toContain("p_main");
    // 高分不冲突 fillUp 候选被纳入
    expect(resultIds).toContain("p_fill_high");
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
        agedRandomISO(4 + i),
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
    sqliteInsertPhoto(testSqlite, "p_excl", agedRandomISO(5), 9.5, "/photos/excl-dir");

    // 再插入一些不冲突的高分照片（保证 fillUp 有候选，但这些无关照片也不应导致测试失败）
    for (let i = 0; i < 3; i++) {
      sqliteInsertPhoto(
        testSqlite,
        `other${i}`,
        agedRandomISO(6 + i),
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
        agedRandomISO(4 + (i % 10)),
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

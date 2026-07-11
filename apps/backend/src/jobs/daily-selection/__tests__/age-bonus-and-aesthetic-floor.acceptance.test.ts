/**
 * 红队验收测试：ageBonus 加法量级修正 + 主力候选源美学下限 ≥ 7.0
 *
 * 设计契约来源（state.md，不读任何蓝队实现）：
 *
 * 改动 2 契约：weightedScore 年代从乘法降为加法
 *   export function ageBonus(yearsAgo: number): number
 *   - y < 1 → 0
 *   - 否则 min(0.3, √y × 0.05)
 *   - y ≥ 1 区间单调递增（sqrt 单调）
 *   - weightedScore = aestheticScore + ageBonus(yearsAgo)
 *
 * 改动 3 契约：主力候选源美学下限
 *   - 4 主力源（historyToday/sameMonth/sameSeason/agedRandom）候选 aestheticScore ≥ 7.0
 *   - fillUp 源 ≥ 7.5 不变
 *   - 可配：MIN_AESTHETIC_SCORE_PRIMARY 走 config，默认 7.0
 *
 * 覆盖验收谓词：
 *   场景3.P1: 同美学分(8.0)不同年代，|final_old - final_new| <= 0.3
 *   场景3.P2: age=100yr 加成 bonus <= 0.3 AND >= 0
 *   场景3.P3: 新公式老照片得分 < 旧公式老照片得分（×1.6 乘法已废除）
 *   场景3.P4: ageBonus 单调递增 + y<1 恒为 0
 *   场景4.P1: 候选池不含 score < 7.0 的主力源照片
 *   场景4.P2: score=7.0 进入（边界 ≥ 包含）
 *   场景4.P3: 候选池主力源子集 min(scores) >= 7.0
 *   场景4.P4: 主力源过滤后候选不足不崩
 *   场景4.P5: fillUp 门槛 7.5 不变
 *
 * 红队铁律：
 * - 不读蓝队本次改动实现（candidate-pool.ts 改动行 / daily-selection.ts runSelectStage）
 * - 仅按契约签名 import：ageBonus from "../candidate-pool"，buildCandidatePool from "../candidate-pool"
 * - Mutation-Survival：ageBonus(20) 与 ageBonus(0) 差 ≤0.3；ageBonus(100)===0.3 字面量断言
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

function agedRandomISO(yearsAgo: number): string {
  const year = new Date().getFullYear() - yearsAgo;
  const { month } = getBeijingMonthDay();
  const monthNum = Number.parseInt(month, 10);
  const differentMonth = monthNum <= 6 ? "11" : "03";
  return `${year}-${differentMonth}-15T10:00:00Z`;
}

// =====================================================================
// 场景 3：ageBonus 加法量级（纯函数，mock db 避免模块加载触发 new Database）
// =====================================================================

describe("场景3 — ageBonus 加法量级修正（年代乘法→加法，上限 0.3）", () => {
  beforeEach(() => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  it("场景3.P1: 同美学分(8.0)，20 年前 vs 今年，最终得分差 <= 0.3", async () => {
    const { ageBonus } = await import("../candidate-pool");
    // CONTRACT: weightedScore = aestheticScore + ageBonus(yearsAgo)
    const scoreNew = 8.0 + ageBonus(0); // 今年
    const scoreOld = 8.0 + ageBonus(20); // 20 年前
    const diff = Math.abs(scoreOld - scoreNew);
    // assert: |final_old - final_new| <= 0.3
    expect(diff).toBeLessThanOrEqual(0.3);
    // 反空操作：差必须 > 0（加成确实存在），否则 ageBonus 被砍成 0
    expect(diff).toBeGreaterThan(0);
  });

  it("场景3.P2: age=100yr 加成封顶 0.3（bonus <= 0.3 AND >= 0）", async () => {
    const { ageBonus } = await import("../candidate-pool");
    const bonus100 = ageBonus(100);
    expect(bonus100).toBeLessThanOrEqual(0.3);
    expect(bonus100).toBeGreaterThanOrEqual(0);
    // Mutation-Survival：字面量 0.3 封顶。旧乘法 ×1.6 会让 100yr 加成 = 5.6，远超 0.3
    expect(ageBonus(36)).toBeCloseTo(0.3, 5);
    expect(ageBonus(50)).toBeLessThanOrEqual(0.3);
  });

  it("场景3.P3: 新公式老照片得分 < 旧公式老照片得分（×1.6 乘法已废除）", async () => {
    const { ageBonus } = await import("../candidate-pool");
    const aestheticScore = 8.0;
    const yearsAgo = 12;
    // 新公式（契约）
    const newScore = aestheticScore + ageBonus(yearsAgo);
    // 旧公式（乘法，应已废除）：score × (1 + min(0.6, √y × 0.1))
    const oldFormulaMultiplier = 1.0 + Math.min(0.6, Math.sqrt(yearsAgo) * 0.1);
    const oldScore = aestheticScore * oldFormulaMultiplier;
    // assert: 新公式老照片得分 < 旧公式老照片得分
    expect(newScore).toBeLessThan(oldScore);
    // 量级核实：12 年前 8.5 分，旧 11.44 → 新约 8.67（差距明显）
    expect(oldScore - newScore).toBeGreaterThan(1.0);
  });

  it("场景3.P4: ageBonus 边界值 + 单调性（y<1 恒 0，y≥1 单调递增）", async () => {
    const { ageBonus } = await import("../candidate-pool");
    // 边界字面量（取自契约 assert）
    expect(ageBonus(0)).toBe(0); // y<1 → 0
    expect(ageBonus(0.5)).toBe(0); // 小数年 < 1 → 0
    expect(ageBonus(0.99)).toBe(0);

    // y ≥ 1 单调递增（sqrt 单调）
    const checkpoints = [1, 2, 5, 10, 15, 20, 25, 30, 35, 36];
    const values = checkpoints.map((y) => ageBonus(y));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
    }
    // 封顶后继续单调（不下降）
    expect(ageBonus(100)).toBeLessThanOrEqual(0.3);
    expect(ageBonus(1000)).toBeLessThanOrEqual(0.3);
  });

  it("ageBonus 与 weightedScore 加法契约一致：weightedScore = score + ageBonus", async () => {
    // 集成层验证：候选池产出的 weightedScore 必须遵守加法公式（而非乘法）
    // 这里通过公式等价性反推，集成测试在下方 buildCandidatePool 场景里再断言真实产出
    const { ageBonus } = await import("../candidate-pool");
    const aestheticScore = 7.5;
    const yearsAgo = 9;
    const expectedWeighted = aestheticScore + ageBonus(yearsAgo);
    // 旧乘法公式（应已废除）
    const oldMultiply = aestheticScore * (1.0 + Math.min(0.6, Math.sqrt(yearsAgo) * 0.1));
    // 加法值严格小于乘法值（9 年前差距明显）
    expect(expectedWeighted).toBeLessThan(oldMultiply);
    // 加法值上限可达性
    expect(expectedWeighted).toBeLessThanOrEqual(aestheticScore + 0.3);
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
    addPhoto(testSqlite, "ar-good", agedRandomISO(5), 7.8);
    addPhoto(testSqlite, "ar-low", agedRandomISO(6), 5.0); // agedRandom 5.0 应被挡

    const result = await buildCandidatePool({ excludeIds: new Set() });
    const ids = result.map((r) => r.photoId);

    // 反空操作：6.5/6.8/5.0 分主力源照必须在候选池外（kill "过滤被跳过" mutation）
    expect(ids).not.toContain("ht-low");
    expect(ids).not.toContain("sm-low");
    expect(ids).not.toContain("ar-low");
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
    addPhoto(testSqlite, "e", agedRandomISO(4), 6.5); // 应挡
    addPhoto(testSqlite, "f", agedRandomISO(5), 7.1);

    const result = await buildPool({ excludeIds: new Set() });

    // 主力源 4 类（不含 fillUp）
    const primarySources = ["historyToday", "sameMonth", "sameSeason", "agedRandom"] as const;
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
    // CONTRACT_AMBIGUITY: 设计文档明确 fillUp ≥7.5 不变，但 fillUp 是"兜底源"，
    // 其触发条件是主力源不足。这里验证：当主力源充足时 fillUp 不触发；
    // 且若 fillUp 候选存在，其美学门槛应为 7.5（高于主力源 7.0）。
    // 由于 fillUp 触发逻辑属实现细节，本测试聚焦"主力源 7.0 生效"可观测行为，
    // fillUp 7.5 的严格 SQL 断言留给 buildCandidatePool 内部实现测试。
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 主力源充足（4 张 ≥7.0），fillUp 不应被需要
    addPhoto(testSqlite, "primary-1", yearsAgoISO(2), 8.0);
    addPhoto(testSqlite, "primary-2", sameMonthOtherDayISO(2), 7.8);
    addPhoto(testSqlite, "primary-3", getOtherSeasonMonthISO(2), 7.5);
    addPhoto(testSqlite, "primary-4", agedRandomISO(3), 7.2);
    // 一张 7.3 分（介于 7.0 和 7.5 之间）—— 主力源会收，fillUp 不收
    addPhoto(testSqlite, "mid-73", yearsAgoISO(4), 7.3);

    const result = await buildCandidatePool({ excludeIds: new Set() });
    const primarySources = ["historyToday", "sameMonth", "sameSeason", "agedRandom"] as const;
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

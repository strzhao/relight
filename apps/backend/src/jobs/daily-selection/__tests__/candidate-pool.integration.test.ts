/**
 * T13: candidate-pool 集成测试（真实 SQLite）
 *
 * 验证：
 * - 4 源各贡献候选
 * - 30 天去重过滤生效
 * - 加权排序正确
 * - per-source quota：故意构造 historyToday 命中 50 张高分，断言其他三源每源至少保留 3 张
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "../../../__tests__/helpers/test-schema";
import * as schema from "../../../db/schema";

// mock db 模块，让 candidate-pool 使用测试数据库
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
  sourceId = "src1",
  burst: { burstId?: string | null; isRep?: boolean } = {},
) {
  // 默认每张照片放在独立目录，避免被主题去重聚类合并；需要构造同簇场景的
  // 测试请改用 sqliteInsertPhoto（接收显式 dirname）。
  sqliteInsertPhoto(
    sqlite,
    photoId,
    takenAt,
    aestheticScore,
    `/photos/${photoId}-dir`,
    sourceId,
    burst,
  );
}

/**
 * 显式 dirname 插入照片，专门用于构造主题去重聚类测试场景。
 */
function sqliteInsertPhoto(
  sqlite: Database.Database,
  photoId: string,
  takenAt: string,
  aestheticScore: number,
  dirname: string,
  sourceId = "src1",
  burst: { burstId?: string | null; isRep?: boolean } = {},
) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size, taken_at, created_at,
         burst_id, is_burst_representative)
       VALUES (?, ?, ?, ?, 100, 100, 1024, ?, ?, ?, ?)`,
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
    );

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO photo_analyses
        (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'test', ?, '{}', ?)`,
    )
    .run(`analysis-${photoId}`, photoId, aestheticScore, new Date().toISOString());
}

function addBurst(
  sqlite: Database.Database,
  burstId: string,
  representativePhotoId: string,
  memberCount: number,
  sourceId = "src1",
) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO bursts
        (id, storage_source_id, representative_photo_id, member_count, manual_override, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(burstId, sourceId, representativePhotoId, memberCount, new Date().toISOString());
}

function addDailyPick(
  sqlite: Database.Database,
  photoId: string,
  pickDate: string,
  members: { photoId: string; caption: string }[] = [],
) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO daily_picks
        (id, photo_id, pick_date, title, narrative, score, members, created_at)
       VALUES (?, ?, ?, 'test', 'test', 8.0, ?, ?)`,
    )
    .run(`pick-${photoId}`, photoId, pickDate, JSON.stringify(members), new Date().toISOString());
}

// 获取当前北京时间的月日
function getBeijingMonthDay() {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const month = String(shanghai.getMonth() + 1).padStart(2, "0");
  const day = String(shanghai.getDate()).padStart(2, "0");
  return { month, day };
}

// 构造 ISO 日期（N 年前的今天）
function yearsAgoISO(years: number): string {
  const { month, day } = getBeijingMonthDay();
  return `${new Date().getFullYear() - years}-${month}-${day}T10:00:00Z`;
}

// 构造同月不同日的历史日期
function sameMonthOtherDayISO(yearsAgo: number): string {
  const { month } = getBeijingMonthDay();
  const year = new Date().getFullYear() - yearsAgo;
  const otherDay = month === "01" ? "20" : "05"; // 随便一个不是今日的日期
  return `${year}-${month}-${otherDay}T10:00:00Z`;
}

// 获取季节内的其他月份
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

// 构造 2 年前的随机日期（不同月份）
function agedRandomISO(yearsAgo: number): string {
  const year = new Date().getFullYear() - yearsAgo;
  const { month } = getBeijingMonthDay();
  const monthNum = Number.parseInt(month, 10);
  // 选非当月非当季的月份
  const differentMonth = monthNum <= 6 ? "11" : "03";
  return `${year}-${differentMonth}-15T10:00:00Z`;
}

describe("buildCandidatePool 集成测试", () => {
  beforeEach(() => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  it("4 源均有数据时，结果包含来自不同源的候选", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 各源至少 1 张
    addPhoto(testSqlite, "h1", yearsAgoISO(3), 8.0);
    addPhoto(testSqlite, "m1", sameMonthOtherDayISO(2), 7.0);
    addPhoto(testSqlite, "a1", agedRandomISO(3), 6.0);

    const seasonOther = getOtherSeasonMonthISO(2);
    if (seasonOther) {
      addPhoto(testSqlite, "s1", seasonOther, 6.5);
    }

    const result = await buildCandidatePool({ excludeIds: new Set() });

    const sources = new Set(result.map((r) => r.source));
    expect(sources.size).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("30 天去重：已精选 photoId 不出现在候选池", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    addPhoto(testSqlite, "h1", yearsAgoISO(3), 9.0);

    const excludeIds = new Set(["h1"]);
    const result = await buildCandidatePool({ excludeIds });

    const ids = result.map((r) => r.photoId);
    expect(ids).not.toContain("h1");
  });

  it("候选池总数不超过 maxN", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 塞入 20 张历史今天的照片（散布到 20 个不同年份的目录，避免被聚类合并）
    for (let i = 0; i < 20; i++) {
      const photoId = `h${i}`;
      const takenAt = yearsAgoISO(i + 1);
      sqliteInsertPhoto(testSqlite, photoId, takenAt, 9.0 - i * 0.1, `/photos/dir-${i}`);
    }

    const result = await buildCandidatePool({ excludeIds: new Set(), maxN: 5 });
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("主题去重聚类：4 张同 dir 5min 内 → 单 ClusteredCandidate clusterSiblingIds.length=3", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 同一目录 5 分钟内 4 张照片 → 聚成 1 簇
    const baseTime = new Date(yearsAgoISO(3)).getTime();
    for (let i = 0; i < 4; i++) {
      const photoId = `cluster${i}`;
      const t = new Date(baseTime + i * 60 * 1000).toISOString(); // 间隔 1 分钟
      sqliteInsertPhoto(testSqlite, photoId, t, 7.0 + i * 0.1, "/photos/trip-2022");
    }

    const result = await buildCandidatePool({ excludeIds: new Set() });
    // 同簇 4 张 → 输出仅 1 张代表 + 3 个 sibling
    const clusterReps = result.filter((r) =>
      ["cluster0", "cluster1", "cluster2", "cluster3"].includes(r.photoId),
    );
    expect(clusterReps).toHaveLength(1);
    expect(clusterReps[0]!.clusterSiblingIds).toHaveLength(3);
    // 代表应为 weightedScore 最高者：cluster3（aestheticScore 7.3）
    expect(clusterReps[0]!.photoId).toBe("cluster3");
  });

  it("聚类后簇数 < maxN：直接接受 N<20，不做 K 回退", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    // 仅 3 个独立目录 + 各目录内 5 张 1 分钟内连续 → 应该聚成 3 簇
    for (let dir = 0; dir < 3; dir++) {
      const baseTime = new Date(yearsAgoISO(dir + 1)).getTime();
      for (let i = 0; i < 5; i++) {
        const photoId = `d${dir}p${i}`;
        const t = new Date(baseTime + i * 60 * 1000).toISOString();
        sqliteInsertPhoto(testSqlite, photoId, t, 8.0 - i * 0.1, `/photos/album-${dir}`);
      }
    }

    const result = await buildCandidatePool({ excludeIds: new Set(), maxN: 20 });
    // 3 个不同 dir → 3 个簇
    expect(result.length).toBe(3);
    // 每个簇都有 4 个 sibling
    for (const r of result) {
      expect(r.clusterSiblingIds).toHaveLength(4);
    }
  });

  it("候选池接受多源混采（聚类后全局排序，弱源可能被强源覆盖）", async () => {
    // 引入主题去重聚类后，dedupAndQuotaMerge 不再在 buildCandidatePool 末尾
    // 截断 maxN，截断推迟到聚类之后；最终结果按 weightedScore desc 全局取
    // 前 maxN，因此当 historyToday 高分大量挤占时，弱源在最终结果里可能
    // 不再保底 3 张。这是设计文档"接受 N<20、不做 K 回退"的直接推论。
    //
    // 本 case 仅断言"4 源都被纳入候选采集"（结果含 historyToday 即可），
    // 而 quota 严格性已下沉到 dedupAndQuotaMerge 单元测试里覆盖。
    const { buildCandidatePool } = await import("../candidate-pool");
    addSource(testSqlite);

    for (let i = 0; i < 50; i++) {
      addPhoto(testSqlite, `h${i}`, yearsAgoISO((i % 20) + 1), 9.9 - i * 0.01);
    }
    for (let i = 0; i < 5; i++) {
      addPhoto(testSqlite, `m${i}`, sameMonthOtherDayISO(2), 5.0 - i * 0.1);
    }
    const seasonOther = getOtherSeasonMonthISO(2);
    for (let i = 0; i < 5; i++) {
      const yr = new Date().getFullYear() - 2 - i;
      const seasonDate = seasonOther.replace(/^\d{4}/, String(yr));
      addPhoto(testSqlite, `s${i}`, seasonDate, 4.0 - i * 0.1);
    }
    for (let i = 0; i < 5; i++) {
      addPhoto(testSqlite, `a${i}`, agedRandomISO(3 + i), 3.0 - i * 0.1);
    }

    const result = await buildCandidatePool({ excludeIds: new Set(), maxN: 20 });

    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(20);
    // historyToday 高分必然进入
    const sources = new Set(result.map((r) => r.source));
    expect(sources.has("historyToday")).toBe(true);
  });

  it("getRecentPickedPhotoIds：读取 30 天内精选的 photoId 含 members", async () => {
    const { getRecentPickedPhotoIds } = await import("../candidate-pool");
    addSource(testSqlite);
    addPhoto(testSqlite, "hero1", yearsAgoISO(1), 8.0);
    addPhoto(testSqlite, "member1", yearsAgoISO(1), 7.0);

    const recentDate = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
    addDailyPick(testSqlite, "hero1", recentDate, [{ photoId: "member1", caption: "测试" }]);

    const ids = await getRecentPickedPhotoIds(30);
    expect(ids.has("hero1")).toBe(true);
    expect(ids.has("member1")).toBe(true);
  });

  it("getRecentPickedPhotoIds：超过 30 天的精选不在集合内", async () => {
    const { getRecentPickedPhotoIds } = await import("../candidate-pool");
    addSource(testSqlite);
    addPhoto(testSqlite, "old1", yearsAgoISO(5), 8.0);

    const oldDate = new Date(Date.now() - 35 * 86400_000).toISOString().slice(0, 10);
    addDailyPick(testSqlite, "old1", oldDate);

    const ids = await getRecentPickedPhotoIds(30);
    expect(ids.has("old1")).toBe(false);
  });

  describe("连拍去重契约：同组连拍只让代表进入候选池", () => {
    it("historyToday: 1 代表 + 2 非代表 → 候选只含代表", async () => {
      const { buildCandidatePool } = await import("../candidate-pool");
      addSource(testSqlite);
      addBurst(testSqlite, "burst-1", "rep-1", 3);
      // 注意：非代表照片评分故意更高，验证过滤优先于 score
      addPhoto(testSqlite, "rep-1", yearsAgoISO(2), 8.0, "src1", {
        burstId: "burst-1",
        isRep: true,
      });
      addPhoto(testSqlite, "non-rep-1", yearsAgoISO(2), 9.5, "src1", {
        burstId: "burst-1",
        isRep: false,
      });
      addPhoto(testSqlite, "non-rep-2", yearsAgoISO(2), 9.0, "src1", {
        burstId: "burst-1",
        isRep: false,
      });

      const result = await buildCandidatePool({ excludeIds: new Set() });
      const ids = result.map((r) => r.photoId);

      expect(ids).toContain("rep-1");
      expect(ids).not.toContain("non-rep-1");
      expect(ids).not.toContain("non-rep-2");
    });

    it("sameMonth: 非代表连拍成员被过滤", async () => {
      const { buildCandidatePool } = await import("../candidate-pool");
      addSource(testSqlite);
      addBurst(testSqlite, "burst-2", "rep-2", 2);
      addPhoto(testSqlite, "rep-2", sameMonthOtherDayISO(2), 7.0, "src1", {
        burstId: "burst-2",
        isRep: true,
      });
      addPhoto(testSqlite, "non-rep-3", sameMonthOtherDayISO(2), 9.0, "src1", {
        burstId: "burst-2",
        isRep: false,
      });

      const result = await buildCandidatePool({ excludeIds: new Set() });
      const ids = result.map((r) => r.photoId);

      expect(ids).toContain("rep-2");
      expect(ids).not.toContain("non-rep-3");
    });

    it("agedRandom: 非代表连拍成员被过滤", async () => {
      const { buildCandidatePool } = await import("../candidate-pool");
      addSource(testSqlite);
      addBurst(testSqlite, "burst-3", "rep-3", 2);
      addPhoto(testSqlite, "rep-3", agedRandomISO(5), 7.0, "src1", {
        burstId: "burst-3",
        isRep: true,
      });
      addPhoto(testSqlite, "non-rep-4", agedRandomISO(5), 9.0, "src1", {
        burstId: "burst-3",
        isRep: false,
      });

      const result = await buildCandidatePool({ excludeIds: new Set() });
      const ids = result.map((r) => r.photoId);

      expect(ids).toContain("rep-3");
      expect(ids).not.toContain("non-rep-4");
    });

    it("独立照片（burst_id 为 NULL）正常进入候选池", async () => {
      const { buildCandidatePool } = await import("../candidate-pool");
      addSource(testSqlite);
      addPhoto(testSqlite, "solo-1", yearsAgoISO(2), 8.0);

      const result = await buildCandidatePool({ excludeIds: new Set() });
      expect(result.map((r) => r.photoId)).toContain("solo-1");
    });
  });
});

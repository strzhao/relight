/**
 * 验收测试：candidate-pool peopleNicknames 注入（红队 — 核心）
 *
 * 设计契约来源（state.md §契约规约 §数据契约 / §验证方案 §红队验收测试方向 1-13）：
 *
 *   EnrichedCandidate.peopleNicknames: string[]（**必填**，新字段）
 *
 *   过滤规则（**全部满足才入列**）：
 *     - TRIM(COALESCE(person.nickname,'')) != ''   （命名）
 *     - person.hidden = 0                          （未隐藏）
 *     - person.id != settings.selfPersonId         （非 self；未设置时此条恒真）
 *   类型：string[]，可以为空数组 []；**视频候选恒为 []**（detect-faces 跳过 video）
 *   顺序：bbox 面积降序（同 photo_id 内）
 *   唯一性：同一 person 只出现一次（去重 by person.id）
 *
 * 验证点（state.md §验证方案 §红队验收测试方向）：
 *   #1  peopleNicknames 在 candidate 上必填且类型为 string[]
 *   #2  selfPersonId 已设置时，candidate.peopleNicknames 不含 self 的 nickname
 *   #3  hidden=true 的 person 即使 nickname 非空也不应出现
 *   #4  一张照片同 person 多张脸 → 去重，nickname 只出现一次
 *   #5  顺序：bbox 面积大的在前
 *   #6  全部 person 未命名 / 被过滤 → peopleNicknames=[]
 *   #12 mediaType==='video' 候选 peopleNicknames 恒为 []
 *   #13 注入时机=cluster 之后；同 cluster 内非代表的人物不被 union 到代表
 *
 * 红队铁律：
 * - 不读取 candidate-pool.ts 实现源码（蓝队正在改）
 * - 通过 buildCandidatePool 公共导出黑盒调用
 * - 用真实 SQLite（:memory:）+ setupTestSchema 完整 DDL（含 persons/faces/settings）
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "../../../__tests__/helpers/test-schema";
import * as schema from "../../../db/schema";

// =====================================================================
// 内存 SQLite + db 模块 mock
// =====================================================================

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;

vi.mock("../../../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

const SOURCE_ID = "src-people-injection";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, 'TestSource', 'local', '/test', 1)",
    )
    .run(SOURCE_ID);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

// =====================================================================
// 数据构造辅助
// =====================================================================

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 构造北京时间 N 年前今天的 ISO，确保照片落入 historyToday 源
 */
function yearsAgoBJ(years: number): string {
  const now = new Date(Date.now() + 8 * 3600_000);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const year = now.getFullYear() - years;
  return `${year}-${month}-${day}T10:00:00Z`;
}

function fakeEmbeddingBase64(): string {
  const buf = Buffer.alloc(512 * 4);
  for (let i = 0; i < 512; i++) buf.writeFloatLE(0.001 * i, i * 4);
  return buf.toString("base64");
}

function insertPhoto(opts: {
  id: string;
  takenAt: string;
  aestheticScore?: number;
  dirname?: string;
  mediaType?: "image" | "video";
}): void {
  const {
    id,
    takenAt,
    aestheticScore = 8.0,
    dirname = `/photos/${id}-dir`,
    mediaType = "image",
  } = opts;
  testSqlite
    .prepare(
      `INSERT INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size,
         taken_at, created_at, media_type, is_burst_representative)
       VALUES (?, ?, ?, ?, 100, 100, 1024, ?, ?, ?, 1)`,
    )
    .run(id, SOURCE_ID, `${dirname}/${id}.jpg`, `hash-${id}`, takenAt, takenAt, mediaType);
  testSqlite
    .prepare(
      `INSERT INTO photo_analyses
        (id, photo_id, ai_model, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'test', ?, '{}', ?)`,
    )
    .run(`analysis-${id}`, id, aestheticScore, nowIso());
}

function insertPerson(opts: {
  id: string;
  nickname?: string | null;
  name?: string | null;
  hidden?: boolean;
}): void {
  const ts = nowIso();
  testSqlite
    .prepare(
      `INSERT INTO persons
        (id, storage_source_id, name, nickname, bio, representative_face_id,
         avatar_path, custom_avatar_path, centroid_embedding,
         member_count, manual_override, displayable, hidden,
         created_at, updated_at, attribute_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      SOURCE_ID,
      opts.name ?? null,
      opts.nickname ?? null,
      null,
      null,
      null,
      null,
      fakeEmbeddingBase64(),
      1,
      0,
      1,
      opts.hidden ? 1 : 0,
      ts,
      ts,
      null,
    );
}

function insertFace(opts: {
  id: string;
  photoId: string;
  personId: string | null;
  bboxW?: number;
  bboxH?: number;
}): void {
  testSqlite
    .prepare(
      `INSERT INTO faces
        (id, photo_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h,
         detection_score, embedding, detected_at, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.photoId,
      opts.personId,
      10,
      10,
      opts.bboxW ?? 100,
      opts.bboxH ?? 100,
      0.95,
      fakeEmbeddingBase64(),
      nowIso(),
      null,
    );
}

function setSelfSetting(personId: string): void {
  testSqlite
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('selfPersonId', ?)")
    .run(personId);
}

// 找到对应 photoId 的 candidate（支持代表或被聚类合并到代表）
function findCandidateByPhotoId(
  result: Array<{ photoId: string; peopleNicknames?: unknown }>,
  photoId: string,
): { photoId: string; peopleNicknames: string[] } | null {
  const found = result.find((r) => r.photoId === photoId);
  if (!found) return null;
  return found as { photoId: string; peopleNicknames: string[] };
}

// =====================================================================
// 测试
// =====================================================================

describe("buildCandidatePool peopleNicknames 注入 — 验收测试（红队核心）", () => {
  beforeEach(() => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  it("契约 §数据.r1 candidate.peopleNicknames 字段存在且类型为 string[]（每个 candidate）", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    // P1 含 2 张脸 → 命名 person
    insertPhoto({ id: "P1", takenAt: yearsAgoBJ(2), aestheticScore: 8.5 });
    insertPerson({ id: "person-A", nickname: "妈妈" });
    insertPerson({ id: "person-B", nickname: "六六" });
    insertFace({ id: "f-P1-A", photoId: "P1", personId: "person-A", bboxW: 200, bboxH: 200 });
    insertFace({ id: "f-P1-B", photoId: "P1", personId: "person-B", bboxW: 100, bboxH: 100 });

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      peopleNicknames?: unknown;
    }>;

    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const c of result) {
      expect(c).toHaveProperty("peopleNicknames");
      expect(Array.isArray(c.peopleNicknames)).toBe(true);
      // 每个元素都应是字符串
      for (const n of c.peopleNicknames as unknown[]) {
        expect(typeof n).toBe("string");
      }
    }
  });

  it("契约 §数据.r1 含 2 张命名脸（'妈妈','六六'） + 1 张未命名脸 → peopleNicknames 仅含命名两条，不含未命名", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    insertPhoto({ id: "P1", takenAt: yearsAgoBJ(2), aestheticScore: 8.5 });
    insertPerson({ id: "p-mama", nickname: "妈妈" });
    insertPerson({ id: "p-liuliu", nickname: "六六" });
    insertPerson({ id: "p-unnamed", nickname: "", name: "" });
    insertFace({ id: "f-mama", photoId: "P1", personId: "p-mama", bboxW: 200, bboxH: 200 });
    insertFace({ id: "f-liuliu", photoId: "P1", personId: "p-liuliu", bboxW: 150, bboxH: 150 });
    insertFace({ id: "f-unnamed", photoId: "P1", personId: "p-unnamed", bboxW: 100, bboxH: 100 });

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      peopleNicknames: string[];
    }>;

    const c = findCandidateByPhotoId(result, "P1");
    expect(c).not.toBeNull();
    expect(c!.peopleNicknames.sort()).toEqual(["六六", "妈妈"].sort());
  });

  it("契约 §数据.filter.hidden=1 hidden=true 的 person 即使 nickname 非空也不出现", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    insertPhoto({ id: "P2", takenAt: yearsAgoBJ(2), aestheticScore: 8.5 });
    insertPerson({ id: "p-mama", nickname: "妈妈" });
    insertPerson({ id: "p-stranger", nickname: "陌生人", hidden: true });
    insertFace({ id: "f-P2-mama", photoId: "P2", personId: "p-mama", bboxW: 200, bboxH: 200 });
    insertFace({
      id: "f-P2-stranger",
      photoId: "P2",
      personId: "p-stranger",
      bboxW: 150,
      bboxH: 150,
    });

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      peopleNicknames: string[];
    }>;

    const c = findCandidateByPhotoId(result, "P2");
    expect(c).not.toBeNull();
    expect(c!.peopleNicknames).toEqual(["妈妈"]);
    expect(c!.peopleNicknames).not.toContain("陌生人");
  });

  it("契约 §数据.filter.self settings.selfPersonId='F' 时，candidate.peopleNicknames 不含 self 的 nickname", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    insertPhoto({ id: "P3", takenAt: yearsAgoBJ(2), aestheticScore: 8.5 });
    insertPerson({ id: "p-baba", nickname: "爸爸" });
    insertFace({ id: "f-P3-baba", photoId: "P3", personId: "p-baba", bboxW: 200, bboxH: 200 });

    // 设置 self = 爸爸
    setSelfSetting("p-baba");

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      peopleNicknames: string[];
    }>;

    const c = findCandidateByPhotoId(result, "P3");
    expect(c).not.toBeNull();
    // self 被过滤 → 空数组（自拍场景）
    expect(c!.peopleNicknames).toEqual([]);
  });

  it("契约 §数据.filter.self 一张照片含 self + 非 self → 仅返回非 self 的 nickname", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    insertPhoto({ id: "P-mix", takenAt: yearsAgoBJ(2), aestheticScore: 8.5 });
    insertPerson({ id: "p-baba", nickname: "爸爸" });
    insertPerson({ id: "p-mama", nickname: "妈妈" });
    insertFace({ id: "f-mix-baba", photoId: "P-mix", personId: "p-baba", bboxW: 200, bboxH: 200 });
    insertFace({ id: "f-mix-mama", photoId: "P-mix", personId: "p-mama", bboxW: 150, bboxH: 150 });

    setSelfSetting("p-baba");

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      peopleNicknames: string[];
    }>;

    const c = findCandidateByPhotoId(result, "P-mix");
    expect(c).not.toBeNull();
    expect(c!.peopleNicknames).toEqual(["妈妈"]);
    expect(c!.peopleNicknames).not.toContain("爸爸");
  });

  it("契约 §数据.video 视频候选 mediaType='video' 的 peopleNicknames 恒为 []", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    insertPhoto({ id: "V1", takenAt: yearsAgoBJ(2), aestheticScore: 8.5, mediaType: "video" });
    // 故意给这张视频建几张脸（哪怕 detect-faces 实际不会跑视频），验证候选侧无论如何强制空
    insertPerson({ id: "p-ghost", nickname: "幽灵命名" });
    insertFace({ id: "f-V1", photoId: "V1", personId: "p-ghost", bboxW: 200, bboxH: 200 });

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      mediaType?: string;
      peopleNicknames: string[];
    }>;

    const c = result.find((r) => r.photoId === "V1");
    expect(c).not.toBeUndefined();
    expect(c!.peopleNicknames).toEqual([]);
  });

  it("契约 §数据.uniq 同一 person 在一张照片有多张脸 → peopleNicknames 只含一次该 nickname", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    insertPhoto({ id: "P-dup", takenAt: yearsAgoBJ(2), aestheticScore: 8.5 });
    insertPerson({ id: "p-mama", nickname: "妈妈" });
    // 同一 person 在同一张照片上的两张人脸（极端：误检 + 真检 / 镜像反射）
    insertFace({ id: "f-mama-1", photoId: "P-dup", personId: "p-mama", bboxW: 200, bboxH: 200 });
    insertFace({ id: "f-mama-2", photoId: "P-dup", personId: "p-mama", bboxW: 150, bboxH: 150 });
    insertFace({ id: "f-mama-3", photoId: "P-dup", personId: "p-mama", bboxW: 100, bboxH: 100 });

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      peopleNicknames: string[];
    }>;

    const c = findCandidateByPhotoId(result, "P-dup");
    expect(c).not.toBeNull();
    expect(c!.peopleNicknames.filter((n) => n === "妈妈")).toHaveLength(1);
    expect(c!.peopleNicknames).toEqual(["妈妈"]);
  });

  it("契约 §数据.order bbox 面积大的 person 排在前（按 area DESC）", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    insertPhoto({ id: "P-order", takenAt: yearsAgoBJ(2), aestheticScore: 8.5 });
    insertPerson({ id: "p-mama", nickname: "妈妈" });
    insertPerson({ id: "p-liuliu", nickname: "六六" });
    insertPerson({ id: "p-baba", nickname: "爸爸" });

    // 故意制造 area: 妈妈最大 (300*300=90000)，爸爸中 (200*200=40000)，六六最小 (100*100=10000)
    insertFace({
      id: "f-order-mama",
      photoId: "P-order",
      personId: "p-mama",
      bboxW: 300,
      bboxH: 300,
    });
    insertFace({
      id: "f-order-baba",
      photoId: "P-order",
      personId: "p-baba",
      bboxW: 200,
      bboxH: 200,
    });
    insertFace({
      id: "f-order-liu",
      photoId: "P-order",
      personId: "p-liuliu",
      bboxW: 100,
      bboxH: 100,
    });

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      peopleNicknames: string[];
    }>;

    const c = findCandidateByPhotoId(result, "P-order");
    expect(c).not.toBeNull();
    expect(c!.peopleNicknames).toEqual(["妈妈", "爸爸", "六六"]);
  });

  it("契约 §数据.empty 全部 person 未命名 / 被过滤 → peopleNicknames=[]", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    insertPhoto({ id: "P-empty", takenAt: yearsAgoBJ(2), aestheticScore: 8.5 });
    // 一个未命名 person + 一个 hidden
    insertPerson({ id: "p-unnamed", nickname: "", name: null });
    insertPerson({ id: "p-hidden", nickname: "陌生人", hidden: true });
    insertFace({
      id: "f-empty-1",
      photoId: "P-empty",
      personId: "p-unnamed",
      bboxW: 200,
      bboxH: 200,
    });
    insertFace({
      id: "f-empty-2",
      photoId: "P-empty",
      personId: "p-hidden",
      bboxW: 150,
      bboxH: 150,
    });

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      peopleNicknames: string[];
    }>;

    const c = findCandidateByPhotoId(result, "P-empty");
    expect(c).not.toBeNull();
    expect(c!.peopleNicknames).toEqual([]);
  });

  it("契约 §数据.empty 完全没有 face 记录的照片 → peopleNicknames=[]", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    insertPhoto({ id: "P-noface", takenAt: yearsAgoBJ(2), aestheticScore: 8.5 });
    // 没有 face、没有 person

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      peopleNicknames: string[];
    }>;

    const c = findCandidateByPhotoId(result, "P-noface");
    expect(c).not.toBeNull();
    expect(c!.peopleNicknames).toEqual([]);
  });

  it("契约 §数据.filter.null 未命名（nickname=NULL） / 仅空白（'  '） / 仅空串 都被过滤", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    insertPhoto({ id: "P-blank", takenAt: yearsAgoBJ(2), aestheticScore: 8.5 });
    insertPerson({ id: "p-null", nickname: null, name: null });
    insertPerson({ id: "p-empty", nickname: "" });
    insertPerson({ id: "p-spaces", nickname: "   " });
    insertPerson({ id: "p-real", nickname: "妈妈" });
    insertFace({
      id: "f-blank-null",
      photoId: "P-blank",
      personId: "p-null",
      bboxW: 300,
      bboxH: 300,
    });
    insertFace({
      id: "f-blank-empty",
      photoId: "P-blank",
      personId: "p-empty",
      bboxW: 200,
      bboxH: 200,
    });
    insertFace({
      id: "f-blank-spaces",
      photoId: "P-blank",
      personId: "p-spaces",
      bboxW: 150,
      bboxH: 150,
    });
    insertFace({
      id: "f-blank-real",
      photoId: "P-blank",
      personId: "p-real",
      bboxW: 100,
      bboxH: 100,
    });

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      peopleNicknames: string[];
    }>;

    const c = findCandidateByPhotoId(result, "P-blank");
    expect(c).not.toBeNull();
    // 只有 "妈妈" 一条
    expect(c!.peopleNicknames).toEqual(["妈妈"]);
  });

  it("契约 §数据.r13 同 cluster 内非代表的人物不被 union 到代表的 peopleNicknames", async () => {
    const { buildCandidatePool } = await import("../candidate-pool");

    // 构造同一 dirname + 1 分钟内 2 张照片 → 一个 cluster 簇（代表 + sibling）
    // sibling 上含命名人物"爸爸"，代表上含"妈妈"。
    // 注入时机=cluster 之后只查代表 photoId，因此代表的 peopleNicknames 只含"妈妈"。
    const t1 = yearsAgoBJ(2);
    const t2 = new Date(new Date(t1).getTime() + 60 * 1000).toISOString();

    insertPhoto({
      id: "rep-photo",
      takenAt: t1,
      aestheticScore: 9.0,
      dirname: "/photos/trip-cluster",
    });
    insertPhoto({
      id: "sibling-photo",
      takenAt: t2,
      aestheticScore: 7.0,
      dirname: "/photos/trip-cluster",
    });
    insertPerson({ id: "p-mama", nickname: "妈妈" });
    insertPerson({ id: "p-baba", nickname: "爸爸" });
    insertFace({
      id: "f-rep-mama",
      photoId: "rep-photo",
      personId: "p-mama",
      bboxW: 200,
      bboxH: 200,
    });
    insertFace({
      id: "f-sib-baba",
      photoId: "sibling-photo",
      personId: "p-baba",
      bboxW: 200,
      bboxH: 200,
    });

    const result = (await buildCandidatePool({ excludeIds: new Set() })) as Array<{
      photoId: string;
      peopleNicknames: string[];
      clusterSiblingIds?: string[];
    }>;

    // cluster 后只代表（评分高者 = rep-photo, aesthetic 9.0）进结果
    const c = result.find((r) => r.photoId === "rep-photo");
    expect(c).not.toBeUndefined();
    // 代表的 peopleNicknames 只查代表 photoId 的 faces → 仅"妈妈"，不 union sibling 的"爸爸"
    expect(c!.peopleNicknames).toEqual(["妈妈"]);
    expect(c!.peopleNicknames).not.toContain("爸爸");
  });
});

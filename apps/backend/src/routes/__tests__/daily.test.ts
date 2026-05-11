/**
 * 测试每日精选路由 — today / list / :id
 *
 * T16 扩展：验证 members 填充、游离 photoId 过滤
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

function chainableMock(result: unknown[] = []) {
  const fn = () => chainableMock(result);
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
        return () => "[]";
      }
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return undefined;
      }
      return chainableMock(result);
    },
  });
}

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../db", () => ({
  db: mockDb,
  schema: chainableMock([]),
}));

vi.mock("../../jobs/queues", () => ({
  scanQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
  analyzeQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
  dailyQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
}));

import { createApp } from "../../app";

function app() {
  return createApp();
}

async function get(path: string) {
  const res = await app().request(path, { method: "GET" });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// YYYY-MM-DD 格式（北京时间），与 API 路由 /:pickDate 格式一致
const todayPickDate = (() => {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  return `${shanghai.getFullYear()}-${String(shanghai.getMonth() + 1).padStart(2, "0")}-${String(shanghai.getDate()).padStart(2, "0")}`;
})();

const mockPhoto = {
  id: "photo-001",
  storageSourceId: "source-001",
  filePath: "photos/img001.jpg",
  fileHash: "abc123",
  width: 1920,
  height: 1080,
  fileSize: 1024000,
  thumbnailPath: "/thumbnails/img001.jpg",
  takenAt: "2024-01-01T10:00:00.000Z",
  createdAt: "2024-01-01T10:00:00.000Z",
};

const mockMemberPhoto = {
  id: "photo-002",
  storageSourceId: "source-001",
  filePath: "photos/img002.jpg",
  fileHash: "def456",
  width: 1920,
  height: 1080,
  fileSize: 1024000,
  thumbnailPath: "/thumbnails/img002.jpg",
  takenAt: "2024-01-01T11:00:00.000Z",
  createdAt: "2024-01-01T11:00:00.000Z",
};

// pick 不含 members（旧数据兼容），且 composedImagePath 为 null
const mockPickNoMembers = {
  id: "pick-001",
  photoId: "photo-001",
  pickDate: todayPickDate,
  title: "那年五月",
  narrative: "一段美好的回忆",
  score: 8.5,
  composedImagePath: null as string | null,
  createdAt: "2024-01-01T00:00:00.000Z",
  // members 字段缺失（旧数据）
};

// pick 含 composedImagePath（mac App 等客户端需要 composedImageUrl 字段）
const mockPickWithComposed = {
  ...mockPickNoMembers,
  id: "pick-003",
  composedImagePath: "/storage/daily-composed/today_default.jpg" as string | null,
};

// pick 含 members
const mockPickWithMembers = {
  ...mockPickNoMembers,
  members: JSON.stringify([{ photoId: "photo-002", caption: "同游漫步" }]),
};

// pick 含游离 photoId（photo 已删除）
const mockPickWithStaleMembers = {
  ...mockPickNoMembers,
  id: "pick-002",
  members: JSON.stringify([
    { photoId: "stale-photo-id", caption: "已删除照片" }, // 游离 photoId
    { photoId: "photo-002", caption: "正常照片" }, // 正常 member
  ]),
};

describe("每日精选路由", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.select.mockReturnValue(chainableMock([]));
    mockDb.insert.mockReturnValue(chainableMock([]));
    mockDb.update.mockReturnValue(chainableMock([]));
  });

  describe("GET /api/daily/today — 今日精选", () => {
    it("今日有精选时返回 data 包含 pick 和 photo", async () => {
      mockDb.select
        // 第一次 select: dailyPicks → 返回一个 pick
        .mockReturnValueOnce(chainableMock([mockPickNoMembers]))
        // 第二次 select: photos (hero) → 返回关联的 photo
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        // 第三次 select: members photos (batch JOIN) → 空
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).not.toBeNull();
      expect(body.data.id).toBe("pick-001");
      expect(body.data.title).toBe("那年五月");
      expect(body.data.photo).not.toBeNull();
      expect(body.data.photo.id).toBe("photo-001");
    });

    it("今日有精选 + members 时，data.members 含 photo 详情", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithMembers]))
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        // members 批量 JOIN → 返回 member photo
        .mockReturnValueOnce(chainableMock([mockMemberPhoto]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.data.members).toBeDefined();
      expect(Array.isArray(body.data.members)).toBe(true);
      expect(body.data.members).toHaveLength(1);
      expect(body.data.members[0].photoId).toBe("photo-002");
      expect(body.data.members[0].caption).toBe("同游漫步");
      expect(body.data.members[0].photo).toBeDefined();
      expect(body.data.members[0].photo.id).toBe("photo-002");
    });

    it("旧数据无 members 字段时，返回 members 为空数组", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickNoMembers]))
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.data.members).toBeDefined();
      expect(Array.isArray(body.data.members)).toBe(true);
      expect(body.data.members).toHaveLength(0);
    });

    it("今日无精选时返回结构化空对象（entries=[]，data 不为 null）", async () => {
      // dailyPicks 查询返回空
      mockDb.select.mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      // 新空态契约：返回结构化空对象，entries 恒为数组
      expect(body.data).not.toBeNull();
      expect(body.data).toHaveProperty("entries");
      expect(Array.isArray(body.data.entries)).toBe(true);
      expect(body.data.entries).toHaveLength(0);
      expect(body.data.photo).toBeNull();
    });

    // composedImageUrl 契约：mac App 依赖此字段决定是否拉合成壁纸
    it("composedImagePath 非空时 data.composedImageUrl 为 /api/daily/{pickDate}/wallpaper", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithComposed]))
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.data).toHaveProperty("composedImageUrl");
      expect(body.data.composedImageUrl).toBe(`/api/daily/${todayPickDate}/wallpaper`);
    });

    it("composedImagePath 为 null 时 data.composedImageUrl 为 null", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickNoMembers]))
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.data).toHaveProperty("composedImageUrl");
      expect(body.data.composedImageUrl).toBeNull();
    });
  });

  describe("GET /api/daily — 精选列表（分页）", () => {
    it("返回 PaginatedResponse 含分页信息", async () => {
      mockDb.select
        // 第一次: count 查询
        .mockReturnValueOnce(chainableMock([{ count: 1 }]))
        // 第二次: 分页数据查询
        .mockReturnValueOnce(chainableMock([mockPickNoMembers]))
        // 第三次: hero photo 批量查询
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        // 第四次: members photo 批量查询（空 members）
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily?page=1&pageSize=5");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.total).toBe(1);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(5);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].photo).toBeDefined();
    });

    it("空列表返回 total 为 0", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([{ count: 0 }]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.total).toBe(0);
      expect(body.data).toHaveLength(0);
    });

    it("列表项含 composedImageUrl（合成图存在时为 wallpaper URL）", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([{ count: 1 }]))
        .mockReturnValueOnce(chainableMock([mockPickWithComposed]))
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily");
      expect(status).toBe(200);
      expect(body.data[0]).toHaveProperty("composedImageUrl");
      expect(body.data[0].composedImageUrl).toBe(`/api/daily/${todayPickDate}/wallpaper`);
    });
  });

  describe("GET /api/daily/:id — 精选详情", () => {
    it("存在时返回 pick 和关联 photo 及 members", async () => {
      mockDb.select
        // 第一次: dailyPicks 查询
        .mockReturnValueOnce(chainableMock([mockPickWithMembers]))
        // 第二次: hero photos 查询
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        // 第三次: members photos 批量查询
        .mockReturnValueOnce(chainableMock([mockMemberPhoto]));

      const { status, body } = await get("/api/daily/pick-001");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("pick-001");
      expect(body.data.photo).toBeDefined();
      expect(body.data.members).toHaveLength(1);
      expect(body.data.members[0].photo.id).toBe("photo-002");
    });

    it("不存在时返回 404", async () => {
      mockDb.select.mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/nonexistent");
      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it("详情含 composedImageUrl（合成图存在时为 wallpaper URL）", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithComposed]))
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/pick-003");
      expect(status).toBe(200);
      expect(body.data).toHaveProperty("composedImageUrl");
      expect(body.data.composedImageUrl).toBe(`/api/daily/${todayPickDate}/wallpaper`);
    });

    it("游离 photoId 过滤：members 中已删除 photo 被剔除，正常 photo 保留", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithStaleMembers]))
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        // 批量 JOIN：只返回 photo-002（stale-photo-id 已删除，不在结果中）
        .mockReturnValueOnce(chainableMock([mockMemberPhoto]));

      const { status, body } = await get("/api/daily/pick-002");
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const members = body.data.members as Array<{ photoId: string }>;
      // stale-photo-id 被过滤，只剩 photo-002
      expect(members.map((m) => m.photoId)).not.toContain("stale-photo-id");
      expect(members.map((m) => m.photoId)).toContain("photo-002");
      expect(members).toHaveLength(1);
    });
  });
});

// ============================================================================
// T-entries: entries 字段验收测试（红队）
//
// 设计契约来源（state.md 设计文档）：
//   1. GET /api/daily/today 响应顶层含 entries: DailyPickEntry[]（必填，可为空数组）
//   2. 每个 entry 含 {rank, photoId, title, narrative, score, photo, members}
//   3. entries 按 rank ASC 排序
//   4. 既有顶层字段（photo/title/narrative/score/members）等于 entries[0] 同源
//   5. 旧数据回退：dailyPicks 存在但无 entries 行 → 响应 entries=[primary]（长度 1）
//   6. 空态契约：当日完全无 dailyPicks 记录 → 200 + entries=[] + photo=null + title=''
//      （新行为：不再返回 data:null，而是结构化空对象）
//
// 注意：本文件使用与原测试相同的 chainableMock + mockDb 策略，追加 describe 块不引入
// 新 import。entries 相关的 mock select 调用顺序参考 daily.ts 实现模式。
// ============================================================================

// ---- 20 entries fixture 数据 ----

function makeEntry(rank: number) {
  const photoId = `entry-photo-${String(rank).padStart(3, "0")}`;
  return {
    id: `entry-${String(rank).padStart(3, "0")}`,
    dailyPickId: "pick-entries-001",
    rank,
    photoId,
    title: `精选标题 rank=${rank}`,
    narrative: `叙事文案 rank=${rank}，记录下美好的瞬间。`,
    score: 9.0 - rank * 0.1,
    members: "[]",
    createdAt: "2026-05-10T06:00:00.000Z",
  };
}

function makeEntryPhoto(rank: number) {
  const photoId = `entry-photo-${String(rank).padStart(3, "0")}`;
  return {
    id: photoId,
    storageSourceId: "source-001",
    filePath: `photos/entry-${rank}.jpg`,
    fileHash: `hash-entry-${rank}`,
    width: 1920,
    height: 1080,
    fileSize: 1024000,
    thumbnailPath: `/thumbnails/entry-${rank}.jpg`,
    takenAt: `2023-05-10T${String(8 + (rank % 10)).padStart(2, "0")}:00:00.000Z`,
    createdAt: `2023-05-10T${String(8 + (rank % 10)).padStart(2, "0")}:00:00.000Z`,
  };
}

const twentyEntries = Array.from({ length: 20 }, (_, i) => makeEntry(i));
const twentyEntryPhotos = Array.from({ length: 20 }, (_, i) => makeEntryPhoto(i));

// pick 基础信息（与 entries[0] 同源）
const mockPickWithEntries = {
  id: "pick-entries-001",
  photoId: "entry-photo-000", // 与 entries[0].photoId 相同
  pickDate: todayPickDate,
  title: "精选标题 rank=0",
  narrative: "叙事文案 rank=0，记录下美好的瞬间。",
  score: 9.0,
  composedImagePath: null as string | null,
  createdAt: "2026-05-10T06:00:00.000Z",
  members: "[]",
};

describe("每日精选路由 — entries 字段验收（T-entries 红队）", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.select.mockReturnValue(chainableMock([]));
    mockDb.insert.mockReturnValue(chainableMock([]));
    mockDb.update.mockReturnValue(chainableMock([]));
  });

  // ----------------------------------------------------------------
  // 验收场景 1: GET /api/daily/today 响应顶层含 entries 数组字段
  // ----------------------------------------------------------------

  describe("场景 1 — GET /api/daily/today 响应含 entries 字段", () => {
    it("今日有精选 + 20 entries 时，data.entries 为长度 20 的数组", async () => {
      mockDb.select
        // 第一次: dailyPicks 查询
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        // 第二次: hero photo
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        // 第三次: members batch（空）
        .mockReturnValueOnce(chainableMock([]))
        // 第四次: daily_pick_entries 查询
        .mockReturnValueOnce(chainableMock(twentyEntries))
        // 第五次: entries 关联 photos 批量查询
        .mockReturnValueOnce(chainableMock(twentyEntryPhotos))
        // 第六次: entries members photos 批量查询（空 members）
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).not.toBeNull();
      expect(body.data).toHaveProperty("entries");
      expect(Array.isArray(body.data.entries)).toBe(true);
      expect(body.data.entries).toHaveLength(20);
    });

    it("data.entries 存在且类型为数组（即使 entries 为空）", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]))
        // entries 查询返回空（旧数据兼容分支，entries 为 [] 时回退）
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.data).toHaveProperty("entries");
      expect(Array.isArray(body.data.entries)).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 2: 每个 entry 含规定字段
  // ----------------------------------------------------------------

  describe("场景 2 — 每个 entry 含完整字段", () => {
    it("entries[0] 含 {rank, photoId, title, narrative, score, photo, members}", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([makeEntry(0)]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.data.entries).toHaveLength(1);

      const entry = body.data.entries[0];
      // 验证字段存在
      expect(entry).toHaveProperty("rank");
      expect(entry).toHaveProperty("photoId");
      expect(entry).toHaveProperty("title");
      expect(entry).toHaveProperty("narrative");
      expect(entry).toHaveProperty("score");
      expect(entry).toHaveProperty("photo");
      expect(entry).toHaveProperty("members");
    });

    it("entries[0].rank 为 0（数字类型）", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([makeEntry(0)]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(typeof body.data.entries[0].rank).toBe("number");
      expect(body.data.entries[0].rank).toBe(0);
    });

    it("entries[0].photo 为 Photo 对象（含 id 字段）", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([makeEntry(0)]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.data.entries[0].photo).not.toBeNull();
      expect(body.data.entries[0].photo).toHaveProperty("id");
      expect(body.data.entries[0].photo.id).toBe("entry-photo-000");
    });

    it("entries[0].members 为数组类型", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([makeEntry(0)]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(Array.isArray(body.data.entries[0].members)).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 3: entries 按 rank ASC 排序
  // ----------------------------------------------------------------

  describe("场景 3 — entries 按 rank ASC 排序", () => {
    it("5 条 entries 响应时按 rank 升序排列（rank: 0,1,2,3,4）", async () => {
      const fiveEntries = Array.from({ length: 5 }, (_, i) => makeEntry(i));
      const fivePhotos = Array.from({ length: 5 }, (_, i) => makeEntryPhoto(i));

      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock(fiveEntries))
        .mockReturnValueOnce(chainableMock(fivePhotos))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.data.entries).toHaveLength(5);

      const ranks = body.data.entries.map((e: { rank: number }) => e.rank);
      // 验证按升序排列
      for (let i = 0; i < ranks.length - 1; i++) {
        expect(ranks[i]).toBeLessThan(ranks[i + 1]);
      }
      expect(ranks[0]).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 4: 既有顶层字段等于 entries[0] 同源
  // ----------------------------------------------------------------

  describe("场景 4 — 既有顶层字段与 entries[0] 同源", () => {
    it("data.photoId === entries[0].photoId", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([makeEntry(0)]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      // 顶层 photoId 与 entries[0].photoId 一致
      expect(body.data.photoId).toBe(body.data.entries[0].photoId);
      expect(body.data.photoId).toBe("entry-photo-000");
    });

    it("data.title === entries[0].title", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([makeEntry(0)]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.data.title).toBe(body.data.entries[0].title);
    });

    it("data.narrative === entries[0].narrative", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([makeEntry(0)]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.data.narrative).toBe(body.data.entries[0].narrative);
    });

    it("data.score === entries[0].score", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([makeEntry(0)]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.data.score).toBeCloseTo(body.data.entries[0].score, 1);
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 5: 旧数据回退（dailyPicks 有行但 daily_pick_entries 无行）
  // ----------------------------------------------------------------

  describe("场景 5 — 旧数据回退：entries 无行 → entries=[primary]", () => {
    it("pick 存在但 entries 无行时，响应 entries 数组长度 = 1（合成 primary entry）", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickNoMembers]))
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        .mockReturnValueOnce(chainableMock([]))
        // entries 查询返回空（旧数据无 entries 行）
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty("entries");
      expect(Array.isArray(body.data.entries)).toBe(true);
      // 旧数据回退：entries 应含 1 条（合成自 dailyPicks 主字段）
      expect(body.data.entries).toHaveLength(1);
    });

    it("旧数据回退时合成的 entries[0].photoId 等于 data.photoId", async () => {
      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickNoMembers]))
        .mockReturnValueOnce(chainableMock([mockPhoto]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      if (body.data.entries && body.data.entries.length > 0) {
        expect(body.data.entries[0].photoId).toBe(body.data.photoId);
      }
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 6: 空态契约（当日完全无 dailyPicks 记录）
  // ----------------------------------------------------------------

  describe("场景 6 — 空态：当日无 dailyPicks 记录 → 200 + entries=[] + photo=null", () => {
    it("当日无精选记录时，返回 200，data.entries 为空数组（不返回 data:null）", async () => {
      // dailyPicks 查询返回空
      mockDb.select.mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      // 空态契约（新行为）：data 为结构化空对象，entries 恒为数组
      // 注意：如果实现仍返回 data:null（旧行为），以下断言会失败 — 这是预期的契约验证
      // CONTRACT_AMBIGUOUS: 空态时 data 是 null（旧行为）还是结构化空对象（新行为）？
      // 设计文档明确：新行为 = 返回 {entries:[], photo:null, title:'', narrative:'', score:0, members:[]}
      // 如果蓝队未实现空态契约，此测试将失败（正确行为）
      if (body.data !== null) {
        // 新行为路径：data 为结构化对象
        expect(body.data).toHaveProperty("entries");
        expect(Array.isArray(body.data.entries)).toBe(true);
        expect(body.data.entries).toHaveLength(0);
        expect(body.data.photo).toBeNull();
        expect(body.data.title).toBe("");
        expect(body.data.narrative).toBe("");
      } else {
        // 旧行为路径：data = null — 触发强断言失败，强制蓝队实现新契约
        expect(body.data).not.toBeNull(); // 此行会 fail，暴露未实现的空态契约
      }
    });

    it("空态时 HTTP 状态码必须为 200（不能是 404/500）", async () => {
      mockDb.select.mockReturnValueOnce(chainableMock([]));

      const { status } = await get("/api/daily/today");
      expect(status).toBe(200);
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 7: GET /api/daily/:pickDate 也含 entries 字段
  // ----------------------------------------------------------------

  describe("场景 7 — GET /api/daily/:pickDate 响应含 entries 字段", () => {
    it("pickDate 有数据时，响应含 entries 数组", async () => {
      const fiveEntries = Array.from({ length: 5 }, (_, i) => makeEntry(i));
      const fivePhotos = Array.from({ length: 5 }, (_, i) => makeEntryPhoto(i));

      mockDb.select
        .mockReturnValueOnce(chainableMock([mockPickWithEntries]))
        .mockReturnValueOnce(chainableMock([makeEntryPhoto(0)]))
        .mockReturnValueOnce(chainableMock([]))
        .mockReturnValueOnce(chainableMock(fiveEntries))
        .mockReturnValueOnce(chainableMock(fivePhotos))
        .mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get(`/api/daily/${todayPickDate}`);
      expect(status).toBe(200);
      expect(body.data).toHaveProperty("entries");
      expect(Array.isArray(body.data.entries)).toBe(true);
    });
  });
});

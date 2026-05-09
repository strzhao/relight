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

const todayPickDate = new Date().toLocaleDateString("zh-CN", {
  timeZone: "Asia/Shanghai",
});

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

    it("今日无精选时返回 data 为 null", async () => {
      // dailyPicks 查询返回空
      mockDb.select.mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
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

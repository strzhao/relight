/**
 * 测试每日精选路由 — today / list / :id
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

const mockPick = {
  id: "pick-001",
  photoId: "photo-001",
  pickDate: todayPickDate,
  title: "那年五月",
  narrative: "一段美好的回忆",
  score: 8.5,
  createdAt: "2024-01-01T00:00:00.000Z",
};

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

describe("每日精选路由", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnValue(chainableMock([]));
    mockDb.insert.mockReturnValue(chainableMock([]));
    mockDb.update.mockReturnValue(chainableMock([]));
  });

  describe("GET /api/daily/today — 今日精选", () => {
    it("今日有精选时返回 data 包含 pick 和 photo", async () => {
      mockDb.select
        // 第一次 select: dailyPicks → 返回一个 pick
        .mockReturnValueOnce(chainableMock([mockPick]))
        // 第二次 select: photos → 返回关联的 photo
        .mockReturnValueOnce(chainableMock([mockPhoto]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).not.toBeNull();
      expect(body.data.id).toBe("pick-001");
      expect(body.data.title).toBe("那年五月");
      expect(body.data.photo).not.toBeNull();
      expect(body.data.photo.id).toBe("photo-001");
    });

    it("今日无精选时返回 data 为 null", async () => {
      // dailyPicks 查询返回空
      mockDb.select.mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/today");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
    });
  });

  describe("GET /api/daily — 精选列表（分页）", () => {
    it("返回 PaginatedResponse 含分页信息", async () => {
      mockDb.select
        // 第一次: count 查询
        .mockReturnValueOnce(chainableMock([{ count: 1 }]))
        // 第二次: 分页数据查询
        .mockReturnValueOnce(chainableMock([mockPick]))
        // 第三次: photo 批量查询
        .mockReturnValueOnce(chainableMock([mockPhoto]));

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
  });

  describe("GET /api/daily/:id — 精选详情", () => {
    it("存在时返回 pick 和关联 photo", async () => {
      mockDb.select
        // 第一次: dailyPicks 查询
        .mockReturnValueOnce(chainableMock([mockPick]))
        // 第二次: photos 查询
        .mockReturnValueOnce(chainableMock([mockPhoto]));

      const { status, body } = await get("/api/daily/pick-001");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("pick-001");
      expect(body.data.photo).toBeDefined();
    });

    it("不存在时返回 404", async () => {
      mockDb.select.mockReturnValueOnce(chainableMock([]));

      const { status, body } = await get("/api/daily/nonexistent");
      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });
  });
});

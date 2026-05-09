/**
 * 连拍检测器单元测试
 *
 * 使用 vitest mock 隔离 DB 和 phash 依赖，专注测试聚类逻辑
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hammingDistance } from "../phash";

// ===========================================================
// Mock 依赖
// ===========================================================

// 模拟的数据库状态（内存 store）
interface MockPhoto {
  id: string;
  storageSourceId: string;
  takenAt: string | null;
  fileSize: number;
  phash: string | null;
  thumbnailPath: string | null;
  burstId: string | null;
  isBurstRepresentative: boolean;
}

interface MockBurst {
  id: string;
  storageSourceId: string;
  representativePhotoId: string | null;
  memberCount: number;
  manualOverride: boolean;
  createdAt: string;
}

let mockPhotos: MockPhoto[] = [];
let mockBursts: MockBurst[] = [];

// 记录插入/更新调用
const dbCalls = {
  burstInserts: 0,
  photoUpdates: 0,
  burstUpdates: 0,
};

vi.mock("../../db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockImplementation((cond: unknown) => {
          // 根据 table 返回对应的 mock 数据
          // 简单实现：select from photos → mockPhotos, from bursts → mockBursts
          const tableName = String(table);
          if (tableName.includes("burst") || tableName === "[object Object]") {
            return Promise.resolve(mockBursts);
          }
          return Promise.resolve(mockPhotos);
        }),
      })),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        dbCalls.burstInserts++;
        const burst = vals as MockBurst;
        mockBursts.push(burst);
        return Promise.resolve();
      }),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          dbCalls.photoUpdates++;
          return Promise.resolve();
        }),
      })),
    })),
    delete: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockReturnValue(Promise.resolve()),
    })),
  },
  schema: {
    photos: {
      id: "id",
      storageSourceId: "storageSourceId",
      takenAt: "takenAt",
      burstId: "burstId",
    },
    bursts: {
      id: "id",
      storageSourceId: "storageSourceId",
    },
  },
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockRejectedValue(new Error("no thumbnail in tests")),
  },
}));

// ===========================================================
// hammingDistance 独立测试（不依赖 DB）
// ===========================================================
describe("hammingDistance 功能验证", () => {
  it("相同 hash 距离 0", () => {
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
  });

  it("全0 vs 全f 距离 64", () => {
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
  });

  it("1 位不同距离 1", () => {
    expect(hammingDistance("0000000000000000", "0000000000000001")).toBe(1);
  });

  it("对称性", () => {
    const a = "1234567890abcdef";
    const b = "fedcba0987654321";
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });
});

// ===========================================================
// detectBursts 集成测试（Mock DB）
// ===========================================================
describe("detectBursts 聚类逻辑", () => {
  beforeEach(() => {
    mockPhotos = [];
    mockBursts = [];
    dbCalls.burstInserts = 0;
    dbCalls.photoUpdates = 0;
    dbCalls.burstUpdates = 0;
    vi.clearAllMocks();
  });

  // 构建测试照片 helper
  function makePhoto(id: string, takenAt: string, phash: string, fileSize = 1000): MockPhoto {
    return {
      id,
      storageSourceId: "src-1",
      takenAt,
      fileSize,
      phash,
      thumbnailPath: null,
      burstId: null,
      isBurstRepresentative: false,
    };
  }

  it("时间间隔 ≤3s 且 hamming ≤10 → 应聚为 1 组", async () => {
    // 5 张照片，连续拍摄（1s 间隔），相同 phash
    const photos = [
      makePhoto("p1", "2024-01-01T10:00:00.000Z", "0000000000000000"),
      makePhoto("p2", "2024-01-01T10:00:01.000Z", "0000000000000001"),
      makePhoto("p3", "2024-01-01T10:00:02.000Z", "0000000000000001"),
      makePhoto("p4", "2024-01-01T10:00:03.000Z", "0000000000000001"),
      makePhoto("p5", "2024-01-01T10:00:04.000Z", "0000000000000002"),
    ];
    mockPhotos = photos;

    // 模拟 DB select 返回正确的 photos
    const { db } = await import("../../db");
    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue(
              photos.map((p) => ({
                ...p,
                mediaType: "image",
              })),
            ),
          })),
        }) as unknown as ReturnType<typeof db.select>,
    );

    const { detectBursts } = await import("../burst-detector");
    const result = await detectBursts({
      storageSourceId: "src-1",
      photoIds: photos.map((p) => p.id),
    });

    // 应该产生至少 1 个连拍组
    expect(result.groupsCreated).toBeGreaterThanOrEqual(1);
  });

  it("时间间隔 >3s → 不应聚组", async () => {
    const photos = [
      makePhoto("p1", "2024-01-01T10:00:00.000Z", "0000000000000000"),
      makePhoto("p2", "2024-01-01T10:00:10.000Z", "0000000000000000"), // 10s 后
      makePhoto("p3", "2024-01-01T10:00:20.000Z", "0000000000000000"),
    ];
    mockPhotos = photos;

    const { db } = await import("../../db");
    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue(photos.map((p) => ({ ...p, mediaType: "image" }))),
          })),
        }) as unknown as ReturnType<typeof db.select>,
    );

    const { detectBursts } = await import("../burst-detector");
    const result = await detectBursts({
      storageSourceId: "src-1",
      photoIds: photos.map((p) => p.id),
    });

    expect(result.groupsCreated).toBe(0);
    expect(result.photosGrouped).toBe(0);
  });

  it("时间近但 hamming >10 → 不应聚组（场景不同）", async () => {
    // phash 差异大（hamming 距离 = 64）
    const photos = [
      makePhoto("p1", "2024-01-01T10:00:00.000Z", "0000000000000000"),
      makePhoto("p2", "2024-01-01T10:00:01.000Z", "ffffffffffffffff"),
    ];
    mockPhotos = photos;

    const { db } = await import("../../db");
    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue(photos.map((p) => ({ ...p, mediaType: "image" }))),
          })),
        }) as unknown as ReturnType<typeof db.select>,
    );

    const { detectBursts } = await import("../burst-detector");
    const result = await detectBursts({
      storageSourceId: "src-1",
      photoIds: photos.map((p) => p.id),
    });

    expect(result.groupsCreated).toBe(0);
    expect(result.photosGrouped).toBe(0);
  });

  it("空 photoIds → 返回全 0 不报错", async () => {
    const { detectBursts } = await import("../burst-detector");
    const result = await detectBursts({
      storageSourceId: "src-1",
      photoIds: [],
    });

    expect(result.groupsCreated).toBe(0);
    expect(result.photosGrouped).toBe(0);
  });

  it("单张照片 → 不产生连拍组（只含 1 张的组丢弃）", async () => {
    const photos = [makePhoto("p1", "2024-01-01T10:00:00.000Z", "1234567890abcdef")];
    mockPhotos = photos;

    const { db } = await import("../../db");
    vi.mocked(db.select).mockImplementation(
      () =>
        ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue(photos.map((p) => ({ ...p, mediaType: "image" }))),
          })),
        }) as unknown as ReturnType<typeof db.select>,
    );

    const { detectBursts } = await import("../burst-detector");
    const result = await detectBursts({
      storageSourceId: "src-1",
      photoIds: ["p1"],
    });

    expect(result.groupsCreated).toBe(0);
  });
});

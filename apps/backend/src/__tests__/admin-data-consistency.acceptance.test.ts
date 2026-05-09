/**
 * 验收测试：Admin API 数据一致性
 *
 * 覆盖设计文档「管理后台」数据流：
 * - stats 端点返回的 totalPhotos / analyzedPhotos / avgAestheticScore / passRate 应与 DB 实际数据一致
 * - storageSources 中 photoCount 应与实际关联照片数一致
 * - recentAnalyses 最多 10 条，按 processedAt 降序
 * - photos 端点支持 sortBy=aestheticScore|processedAt 排序
 * - photos 端点分页行为正确
 *
 * 本测试使用内存 SQLite + Drizzle 验证完整数据链路的一致性。
 */
import Database from "better-sqlite3";
import { desc, eq, sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as realSchema from "../db/schema";
import { setupTestSchema } from "./helpers/test-schema";

// 表 DDL 委托给 helpers/test-schema.ts，与 prod schema 保持同步
const createTables = setupTestSchema;

// ---- 类型定义 ----

interface AdminStatsData {
  totalPhotos: number;
  analyzedPhotos: number;
  avgAestheticScore: number;
  passRate: number;
  storageSources: Array<{ name: string; type: string; photoCount: number }>;
  recentAnalyses: Array<{ filePath: string; aestheticScore: number; processedAt: string }>;
}

interface PhotoAnalysisItem {
  id: string;
  filePath: string;
  createdAt: string;
  latestAnalysis: {
    aestheticScore: number;
    processedAt: string;
    id?: string;
    aiModel?: string | null;
    narrative?: string | null;
  } | null;
}

interface PaginatedPhotosResponse {
  success: boolean;
  data: {
    data: PhotoAnalysisItem[];
    total: number;
    page: number;
    pageSize: number;
  };
}

// ---- 测试 DB Holder（vi.hoisted 确保在 mock 提升前可用） ----

const __holder = vi.hoisted(() => ({
  db: null as BetterSQLite3Database<typeof realSchema> | null,
}));

vi.mock("../db", () => ({
  db: __holder.db,
  schema: realSchema,
}));

// Mock 队列（admin/queues 端点使用，非本次一致性测试重点）
vi.mock("../jobs/queues", () => {
  const defaults = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  const mockQ = () =>
    new Proxy(
      {},
      {
        get(_t, p) {
          if (typeof p === "string" && p !== "then") return () => Promise.resolve({ ...defaults });
          return undefined;
        },
      },
    );
  return { scanQueue: mockQ(), analyzeQueue: mockQ(), dailyQueue: mockQ() };
});

// ---- 全局测试状态 ----

let app: Hono;
let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof realSchema>;
let storageId: string;
const photoIds: string[] = [];
const now = "2026-05-02T10:00:00.000Z";
const oneHourAgo = "2026-05-02T09:00:00.000Z";
const twoHoursAgo = "2026-05-02T08:00:00.000Z";

beforeAll(async () => {
  // 1. 创建内存数据库
  sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite, { schema: realSchema });

  // 注入 mock
  __holder.db = db;

  // 2. 建表
  createTables(sqlite);

  // 3. 创建存储源
  storageId = crypto.randomUUID();
  await db.insert(realSchema.storageSources).values({
    id: storageId,
    name: "NAS 照片库",
    type: "local",
    rootPath: "/Users/stringzhao/nas-photos",
    enabled: true,
    lastScanAt: now,
  });

  const storageId2 = crypto.randomUUID();
  await db.insert(realSchema.storageSources).values({
    id: storageId2,
    name: "备用存储",
    type: "local",
    rootPath: "/mnt/backup/photos",
    enabled: false,
    lastScanAt: null,
  });

  // 4. 创建 8 张测试照片（不同评分，便于验证统计）
  const photosData = [
    { filePath: "/nas-photos/landscape_01.jpg", fileHash: "h001", score: 9, time: now },
    { filePath: "/nas-photos/portrait_01.jpg", fileHash: "h002", score: 8, time: oneHourAgo },
    { filePath: "/nas-photos/sunset_01.jpg", fileHash: "h003", score: 7, time: twoHoursAgo },
    {
      filePath: "/nas-photos/macro_01.jpg",
      fileHash: "h004",
      score: 6,
      time: "2026-05-02T07:00:00.000Z",
    },
    {
      filePath: "/nas-photos/street_01.jpg",
      fileHash: "h005",
      score: 5,
      time: "2026-05-02T06:00:00.000Z",
    },
    {
      filePath: "/nas-photos/night_01.jpg",
      fileHash: "h006",
      score: 8,
      time: "2026-05-02T05:00:00.000Z",
    },
    {
      filePath: "/nas-photos/travel_01.jpg",
      fileHash: "h007",
      score: 9,
      time: "2026-05-02T04:00:00.000Z",
    },
    {
      filePath: "/nas-photos/food_01.jpg",
      fileHash: "h008",
      score: 4,
      time: "2026-05-02T03:00:00.000Z",
    },
  ];

  for (const p of photosData) {
    const id = crypto.randomUUID();
    photoIds.push(id);
    await db.insert(realSchema.photos).values({
      id,
      storageSourceId: storageId,
      filePath: p.filePath,
      fileHash: p.fileHash,
      width: 1920,
      height: 1080,
      fileSize: 1024000,
      thumbnailPath: null,
      takenAt: null,
      createdAt: p.time,
    });
  }

  // 5. 插入一张未分析的照片（验证 totalPhotos > analyzedPhotos）
  const unanalyzedId = crypto.randomUUID();
  photoIds.push(unanalyzedId);
  await db.insert(realSchema.photos).values({
    id: unanalyzedId,
    storageSourceId: storageId,
    filePath: "/nas-photos/unanalyzed_01.jpg",
    fileHash: "h009",
    width: 1920,
    height: 1080,
    fileSize: 512000,
    thumbnailPath: null,
    takenAt: null,
    createdAt: "2026-05-02T02:00:00.000Z",
  });

  // 6. 为前 8 张照片创建 AI 分析记录（含评分）
  // 评分分布: 9, 8, 7, 6, 5, 8, 9, 4 → 平均 7.0, >=8 的有 4 张 (50%)
  for (let i = 0; i < 8; i++) {
    const analysisId = crypto.randomUUID();
    const p = photosData[i];
    if (!p) continue;
    await db.insert(realSchema.photoAnalyses).values({
      id: analysisId,
      photoId: photoIds[i] ?? "",
      aiModel: "qwen3.6-35b",
      rawResponse: "{}",
      narrative: `这是第 ${i + 1} 张照片的叙事描述`,
      aestheticScore: p.score,
      tags: [],
      composition: { type: "unknown", score: 5, description: "" },
      colorAnalysis: { palette: [], dominant: "#000", mood: "neutral" },
      emotionalAnalysis: { primary: "neutral", secondary: "calm", intensity: 5 },
      usageSuggestions: "",
      promptVersion: "v1",
      processedAt: p.time,
    });
  }

  // 7. 动态导入 admin router 并创建测试 App
  const adminMod = await import("../routes/admin");
  const adminRouter: Hono = ((adminMod as Record<string, Hono>).adminRouter ||
    (adminMod as Record<string, Hono>).default)!;
  app = new Hono();
  app.use("*", cors());
  app.route("/api/admin", adminRouter);
});

afterAll(() => {
  sqlite?.close();
  vi.clearAllMocks();
});

// ---- 请求辅助 ----

async function get(path: string) {
  const res = await app.request(path, { method: "GET" });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---- 测试 ----

describe("Admin API 数据一致性 — 验收测试", () => {
  // ============================================================
  // Stats 数据一致性
  // ============================================================
  describe("GET /api/admin/stats 数据一致性", () => {
    let stats: AdminStatsData;

    beforeAll(async () => {
      const { body } = await get("/api/admin/stats");
      stats = (body as { success: boolean; data: AdminStatsData }).data;
    });

    it("totalPhotos 应与 DB 中 photos 表行数一致", () => {
      // 已插入 9 张照片
      expect(stats.totalPhotos).toBe(9);
    });

    it("analyzedPhotos 应与 DB 中 photoAnalyses 表的唯一 photoId 数一致", () => {
      // 已插入 8 条分析记录
      expect(stats.analyzedPhotos).toBe(8);
    });

    it("avgAestheticScore 应等于所有分析记录 aestheticScore 的平均值", () => {
      // 评分: 9+8+7+6+5+8+9+4 = 56, avg = 7.0
      expect(stats.avgAestheticScore).toBe(7.0);
    });

    it("passRate 应等于 aestheticScore >= 8 的比例", () => {
      // >=8 的有: 9, 8, 8, 9 → 4 张 out of 8 → 0.5（API 返回小数，非百分比）
      expect(stats.passRate).toBe(0.5);
    });

    it("storageSources 应包含正确的 photoCount", () => {
      // 第一个存储源有 9 张照片
      const nasSource = stats.storageSources.find((s) => s.name === "NAS 照片库");
      expect(nasSource).toBeDefined();
      expect(nasSource?.photoCount).toBe(9);

      // 第二个存储源有 0 张照片
      const backupSource = stats.storageSources.find((s) => s.name === "备用存储");
      expect(backupSource).toBeDefined();
      expect(backupSource?.photoCount).toBe(0);
    });

    it("recentAnalyses 应最多返回 10 条", () => {
      expect(stats.recentAnalyses.length).toBeLessThanOrEqual(10);
    });

    it("recentAnalyses 应按 processedAt 降序排列（最新的在前）", () => {
      const times = stats.recentAnalyses.map((a) => new Date(a.processedAt).getTime());
      for (let i = 1; i < times.length; i++) {
        expect(times[i - 1]).toBeGreaterThanOrEqual(times[i] ?? 0);
      }
    });

    it("recentAnalyses 应包含最新的一条分析记录", () => {
      // 最新的分析是 landscape_01，评分 9
      const latest = stats.recentAnalyses[0];
      expect(latest).toBeDefined();
      if (latest) {
        expect(latest.filePath).toBe("/nas-photos/landscape_01.jpg");
        expect(latest.aestheticScore).toBe(9);
      }
    });
  });

  // ============================================================
  // Photos 分页和排序
  // ============================================================
  describe("GET /api/admin/photos 分页和排序", () => {
    it("默认应返回第 1 页数据", async () => {
      const { body } = await get("/api/admin/photos");
      const parsed = body as PaginatedPhotosResponse;
      expect(parsed.data.page).toBe(1);
      expect(parsed.data.total).toBe(9); // 所有照片（含未分析的）
    });

    it("sortBy=aestheticScore 应按评分降序排列", async () => {
      const { body } = await get("/api/admin/photos?sortBy=aestheticScore");
      const parsed = body as PaginatedPhotosResponse;
      const scores = parsed.data.data.map((p) => p.latestAnalysis?.aestheticScore ?? 0);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i] ?? 0);
      }
    });

    it("sortBy=processedAt 应按处理时间降序排列", async () => {
      const { body } = await get("/api/admin/photos?sortBy=processedAt");
      const parsed = body as PaginatedPhotosResponse;
      const times = parsed.data.data.map((p) =>
        p.latestAnalysis?.processedAt ? new Date(p.latestAnalysis.processedAt).getTime() : 0,
      );
      for (let i = 1; i < times.length; i++) {
        expect(times[i - 1]).toBeGreaterThanOrEqual(times[i] ?? 0);
      }
    });

    it("page=1&pageSize=3 应返回 3 条记录", async () => {
      const { body } = await get("/api/admin/photos?page=1&pageSize=3");
      const parsed = body as PaginatedPhotosResponse;
      expect(parsed.data.data).toHaveLength(3);
      expect(parsed.data.page).toBe(1);
      expect(parsed.data.pageSize).toBe(3);
    });

    it("page=2&pageSize=3 应返回第 2 页的 3 条记录", async () => {
      const { body } = await get("/api/admin/photos?page=2&pageSize=3");
      const parsed = body as PaginatedPhotosResponse;
      expect(parsed.data.page).toBe(2);
      expect(parsed.data.data.length).toBeGreaterThanOrEqual(1);
      expect(parsed.data.data.length).toBeLessThanOrEqual(3);
    });

    it("page=3&pageSize=3 应返回最后 3 条记录（总共 9 条，每页 3 条）", async () => {
      const { body } = await get("/api/admin/photos?page=3&pageSize=3");
      const parsed = body as PaginatedPhotosResponse;
      expect(parsed.data.data).toHaveLength(3);
      expect(parsed.data.page).toBe(3);
    });

    it("page=4&pageSize=3 应返回空数组，total 仍是 9", async () => {
      const { body } = await get("/api/admin/photos?page=4&pageSize=3");
      const parsed = body as PaginatedPhotosResponse;
      expect(parsed.data.data).toHaveLength(0);
      expect(parsed.data.total).toBe(9);
    });

    it("连续翻页不应丢失记录", async () => {
      const allIds = new Set<string>();
      for (let page = 1; ; page++) {
        const { body } = await get(`/api/admin/photos?page=${page}&pageSize=3`);
        const parsed = body as PaginatedPhotosResponse;
        for (const item of parsed.data.data) {
          allIds.add(item.id);
        }
        if (parsed.data.data.length < 3) break;
      }
      // 总共应有 9 条唯一记录（含未分析照片）
      expect(allIds.size).toBe(9);
    });
  });

  // ============================================================
  // Stats 边界情况验证
  // ============================================================
  describe("Stats 边界情况", () => {
    it("analyzedPhotos 不应超过 totalPhotos", async () => {
      const { body } = await get("/api/admin/stats");
      const stats = (body as { success: boolean; data: AdminStatsData }).data;
      expect(stats.analyzedPhotos).toBeLessThanOrEqual(stats.totalPhotos);
    });

    it("avgAestheticScore 应在 1-10 范围内（当有分析记录时）", async () => {
      const { body } = await get("/api/admin/stats");
      const stats = (body as { success: boolean; data: AdminStatsData }).data;
      if (stats.analyzedPhotos > 0) {
        expect(stats.avgAestheticScore).toBeGreaterThanOrEqual(1);
        expect(stats.avgAestheticScore).toBeLessThanOrEqual(10);
      }
    });

    it("passRate 应在 0-1 范围内", async () => {
      const { body } = await get("/api/admin/stats");
      const stats = (body as { success: boolean; data: AdminStatsData }).data;
      expect(stats.passRate).toBeGreaterThanOrEqual(0);
      expect(stats.passRate).toBeLessThanOrEqual(1);
    });

    it("recentAnalyses 的每条记录 filePath 应对应 DB 中存在的照片", async () => {
      const { body } = await get("/api/admin/stats");
      const stats = (body as { success: boolean; data: AdminStatsData }).data;

      for (const analysis of stats.recentAnalyses) {
        const photos = await db
          ?.select({ filePath: realSchema.photos.filePath })
          .from(realSchema.photos)
          .where(eq(realSchema.photos.filePath, analysis.filePath))
          .limit(1);
        expect(photos).toHaveLength(1);
      }
    });
  });

  // ============================================================
  // Photos 端点字段完整性
  // ============================================================
  describe("GET /api/admin/photos 字段完整性", () => {
    it("每条记录应包含 id, filePath, createdAt, latestAnalysis 四个必填字段", async () => {
      const { body } = await get("/api/admin/photos?pageSize=5");
      const parsed = body as PaginatedPhotosResponse;

      for (const item of parsed.data.data) {
        expect(item).toHaveProperty("id");
        expect(typeof item.id).toBe("string");
        expect(item.id.length).toBeGreaterThan(0);

        expect(item).toHaveProperty("filePath");
        expect(typeof item.filePath).toBe("string");

        expect(item).toHaveProperty("createdAt");
        expect(typeof item.createdAt).toBe("string");

        // latestAnalysis 可能为 null（未分析照片）
        if (item.latestAnalysis) {
          expect(typeof item.latestAnalysis.aestheticScore).toBe("number");
          expect(typeof item.latestAnalysis.processedAt).toBe("string");
        }
      }
    });

    it("aestheticScore 值应在 1-10 范围内", async () => {
      const { body } = await get("/api/admin/photos?pageSize=20");
      const parsed = body as PaginatedPhotosResponse;
      for (const item of parsed.data.data) {
        if (item.latestAnalysis) {
          expect(item.latestAnalysis.aestheticScore).toBeGreaterThanOrEqual(1);
          expect(item.latestAnalysis.aestheticScore).toBeLessThanOrEqual(10);
        }
      }
    });
  });
});

// ---- 辅助：手动建表（测试环境不用 drizzle push） ----

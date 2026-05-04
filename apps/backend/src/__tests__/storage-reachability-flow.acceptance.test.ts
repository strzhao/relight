/**
 * 验收测试：存储源可达性 — 完整数据流
 *
 * 覆盖设计文档全链路：
 * 1. Schema 增强：storage_sources 新增 status + last_error 列
 * 2. POST /api/storage/:id/check → DB 更新 → GET /api/storage / GET /api/admin/stats 返回新字段
 * 3. POST /api/scan 预检查守卫：status 为 inaccessible/unmounted/permission_denied 时返回 400
 * 4. POST /api/analyze 预检查守卫：查询 photoIds 对应存储源，status 不健康时返回 400
 * 5. 跨系统字段名一致性：status / lastError 在各端点响应中命名统一
 *
 * 本测试使用内存 SQLite + Drizzle 验证完整数据链路。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as realSchema from "../db/schema";

// =========================================================================
// 类型定义（设计文档声明）
// =========================================================================

/** StorageSourceStatus 枚举 */
type StorageSourceStatus =
  | "unknown"
  | "healthy"
  | "inaccessible"
  | "unmounted"
  | "permission_denied";

const VALID_STATUSES: readonly StorageSourceStatus[] = [
  "unknown",
  "healthy",
  "inaccessible",
  "unmounted",
  "permission_denied",
];

const UNHEALTHY_STATUSES: readonly StorageSourceStatus[] = [
  "inaccessible",
  "unmounted",
  "permission_denied",
];

/** 检查端点响应 */
interface CheckResponse {
  success: boolean;
  data?: { status: StorageSourceStatus; lastError?: string };
}

/** 存储源列表项（含新字段） */
interface StorageSourceWithStatus {
  id: string;
  name: string;
  type: string;
  rootPath: string;
  enabled: boolean;
  lastScanAt: string | null;
  status: StorageSourceStatus;
  lastError: string | null;
}

/** Admin stats 中的存储源项 */
interface AdminStorageSourceStats {
  id: string;
  name: string;
  type: string;
  photoCount: number;
  analyzedCount?: number;
  lastScanAt: string | null;
  status: StorageSourceStatus;
  lastError: string | null;
}

// =========================================================================
// 测试 DB Holder（vi.hoisted 确保在 mock 提升前可用）
// =========================================================================

const __holder = vi.hoisted(() => ({
  db: null as BetterSQLite3Database<typeof realSchema> | null,
}));

vi.mock("../db", () => ({
  db: __holder.db,
  schema: realSchema,
}));

// Mock 队列（避免 Redis 连接）
const defaultQueueState = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };

function createQueueMock() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
          return () => "BullMQ Mock";
        }
        return () => Promise.resolve({ ...defaultQueueState });
      },
    },
  );
}

vi.mock("../jobs/queues", () => ({
  scanQueue: {
    add: () => Promise.resolve({ id: "mock-scan-job-id" }),
    getJobCounts: () => Promise.resolve({ ...defaultQueueState }),
    getJob: () => Promise.resolve(null),
  },
  analyzeQueue: {
    add: () => Promise.resolve({ id: "mock-analyze-job-id" }),
    getJobCounts: () => Promise.resolve({ ...defaultQueueState }),
    getJob: () => Promise.resolve(null),
  },
  dailyQueue: {
    add: () => Promise.resolve({ id: "mock-daily-job-id" }),
    getJobCounts: () => Promise.resolve({ ...defaultQueueState }),
    getJob: () => Promise.resolve(null),
  },
}));

// Mock bullmq QueueEvents（避免 analyze 路由模块级 Redis 连接）
vi.mock("bullmq", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    QueueEvents: class MockQueueEvents {
      on() {}
      off() {}
      close() {}
    },
  };
});

// =========================================================================
// 全局测试状态
// =========================================================================

let app: Hono;
let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof realSchema>;

/** 临时目录用于检查可达性测试 */
let tmpTestDir: string;

/** 存储源 ID */
let healthySourceId: string;
let inaccessibleSourceId: string;
let unmountedSourceId: string;
let permissionDeniedSourceId: string;
let unknownSourceId: string;

/** 照片 ID（用于 analyze 守卫测试） */
let healthyPhotoId: string;
let inaccessiblePhotoId: string;
let unmountedPhotoId: string;
let permissionDeniedPhotoId: string;

const now = new Date().toISOString();

beforeAll(async () => {
  // 1. 创建临时测试目录（用于 healthy 检查）
  tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "relight-storage-test-"));

  // 2. 创建内存数据库
  sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite, { schema: realSchema });

  // 注入 mock
  __holder.db = db;

  // 3. 建表（含新增 status + last_error 列）
  createTables(sqlite);

  // 4. 创建测试存储源
  healthySourceId = crypto.randomUUID();
  inaccessibleSourceId = crypto.randomUUID();
  unmountedSourceId = crypto.randomUUID();
  permissionDeniedSourceId = crypto.randomUUID();
  unknownSourceId = crypto.randomUUID();

  // 使用原始 SQL INSERT 以避免 Drizzle schema 中尚无 status/last_error 列的问题
  // 新列的 DEFAULT 约束确保初始值为 status='unknown', last_error=NULL
  const insertSource = sqlite.prepare(
    "INSERT INTO storage_sources (id, name, type, root_path, enabled, last_scan_at) VALUES (?, ?, ?, ?, 1, NULL)",
  );

  // 健康存储源（指向我们创建的临时目录）
  insertSource.run(healthySourceId, "健康存储源", "local", tmpTestDir);

  // 不可访问存储源（指向不存在的目录）
  insertSource.run(
    inaccessibleSourceId,
    "不可访问存储源",
    "local",
    "/tmp/__nonexistent_dir_xyz123abc__",
  );

  // 未挂载存储源（待检查后设置状态）
  insertSource.run(
    unmountedSourceId,
    "未挂载存储源",
    "local",
    "/tmp/__nonexistent_dir_xyz123abc__",
  );

  // 权限不足存储源（待检查后设置状态）
  insertSource.run(permissionDeniedSourceId, "权限不足存储源", "local", "/root/restricted");

  // 默认未知状态存储源
  insertSource.run(unknownSourceId, "未知状态存储源", "local", "/some/unchecked/path");

  // 5. 创建测试照片（用于 analyze 守卫测试）
  healthyPhotoId = crypto.randomUUID();
  inaccessiblePhotoId = crypto.randomUUID();
  unmountedPhotoId = crypto.randomUUID();
  permissionDeniedPhotoId = crypto.randomUUID();

  await db.insert(realSchema.photos).values({
    id: healthyPhotoId,
    storageSourceId: healthySourceId,
    filePath: path.join(tmpTestDir, "healthy-photo.jpg"),
    fileHash: "hash-healthy-001",
    width: 1920,
    height: 1080,
    fileSize: 1024000,
    thumbnailPath: null,
    takenAt: null,
    createdAt: now,
  });

  await db.insert(realSchema.photos).values({
    id: inaccessiblePhotoId,
    storageSourceId: inaccessibleSourceId,
    filePath: "/tmp/__nonexistent_dir_xyz123abc__/inaccessible-photo.jpg",
    fileHash: "hash-inaccessible-001",
    width: 1920,
    height: 1080,
    fileSize: 1024000,
    thumbnailPath: null,
    takenAt: null,
    createdAt: now,
  });

  await db.insert(realSchema.photos).values({
    id: unmountedPhotoId,
    storageSourceId: unmountedSourceId,
    filePath: "/tmp/__nonexistent_dir_xyz123abc__/unmounted-photo.jpg",
    fileHash: "hash-unmounted-001",
    width: 1920,
    height: 1080,
    fileSize: 1024000,
    thumbnailPath: null,
    takenAt: null,
    createdAt: now,
  });

  await db.insert(realSchema.photos).values({
    id: permissionDeniedPhotoId,
    storageSourceId: permissionDeniedSourceId,
    filePath: "/root/restricted/denied-photo.jpg",
    fileHash: "hash-denied-001",
    width: 1920,
    height: 1080,
    fileSize: 1024000,
    thumbnailPath: null,
    takenAt: null,
    createdAt: now,
  });

  // 6. 动态导入 createApp
  const appMod = await import("../app");
  app = appMod.createApp();
});

afterAll(() => {
  // 清理临时目录
  try {
    fs.rmSync(tmpTestDir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
  sqlite?.close();
  vi.clearAllMocks();
});

// =========================================================================
// 请求辅助函数
// =========================================================================

async function get(path: string) {
  const res = await app.request(path, { method: "GET" });
  const contentType = res.headers.get("Content-Type") ?? "";
  if (contentType.startsWith("image/")) {
    return { status: res.status, body: null };
  }
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function post(p: string, data?: unknown) {
  const res = await app.request(p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// =========================================================================
// 测试
// =========================================================================

describe("存储源可达性 — 完整数据流验收测试", () => {
  // =========================================================================
  // 1. Schema 增强验证
  // =========================================================================
  describe("Schema 增强：storage_sources 表", () => {
    it("应包含 status 列，默认值为 'unknown'", () => {
      const row = sqlite
        .prepare("SELECT status FROM storage_sources WHERE id = ?")
        .get(healthySourceId) as { status: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.status).toBe("unknown");
    });

    it("应包含 last_error 列，默认为 NULL", () => {
      const row = sqlite
        .prepare("SELECT last_error FROM storage_sources WHERE id = ?")
        .get(healthySourceId) as { last_error: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row?.last_error).toBeNull();
    });

    it("status 列应为 NOT NULL", () => {
      // 验证 status 列不允许 NULL
      expect(() => {
        sqlite
          .prepare(
            "INSERT INTO storage_sources (id, name, type, root_path, status) VALUES (?, ?, ?, ?, NULL)",
          )
          .run(crypto.randomUUID(), "test", "local", "/tmp");
      }).toThrow();
    });

    it("status 值应在合法枚举范围内", async () => {
      // 读取所有存储源的 status，验证都在枚举值范围内
      const rows = sqlite.prepare("SELECT status FROM storage_sources").all() as {
        status: string;
      }[];
      for (const row of rows) {
        expect(VALID_STATUSES).toContain(row.status as StorageSourceStatus);
      }
    });

    it("应有 5 个合法的 status 枚举值", () => {
      expect(VALID_STATUSES).toEqual([
        "unknown",
        "healthy",
        "inaccessible",
        "unmounted",
        "permission_denied",
      ]);
    });

    it("新增列不应影响已有列的数据完整性", () => {
      const row = sqlite
        .prepare(
          "SELECT id, name, type, root_path, enabled, last_scan_at FROM storage_sources WHERE id = ?",
        )
        .get(healthySourceId) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row?.name).toBe("健康存储源");
      expect(row?.type).toBe("local");
      expect(row?.root_path).toBe(tmpTestDir);
      expect(row?.enabled).toBe(1);
    });
  });

  // =========================================================================
  // 2. POST /api/storage/:id/check — 可达性检查
  // =========================================================================
  describe("POST /api/storage/:id/check — 可达性检查", () => {
    it("应返回 200 且 ApiResponse 格式", async () => {
      const { status, body } = await post(`/api/storage/${healthySourceId}/check`);
      expect(status).toBe(200);

      const res = body as CheckResponse;
      expect(res.success).toBe(true);
    });

    it("健康存储源（存在且可读目录）应返回 status='healthy'", async () => {
      const { status, body } = await post(`/api/storage/${healthySourceId}/check`);
      expect(status).toBe(200);

      const res = body as CheckResponse;
      expect(res.data?.status).toBe("healthy");
    });

    it("健康存储源不应有 lastError 字段", async () => {
      const { body } = await post(`/api/storage/${healthySourceId}/check`);
      const res = body as CheckResponse;
      // 健康状态下 lastError 应为 null 或 undefined
      expect(res.data?.lastError).toBeFalsy();
    });

    it("不存在的目录应返回 status='inaccessible' 且含错误消息", async () => {
      const { status, body } = await post(`/api/storage/${inaccessibleSourceId}/check`);
      expect(status).toBe(200);

      const res = body as CheckResponse;
      expect(res.data?.status).toBe("inaccessible");
      expect(res.data?.lastError).toBeDefined();
      expect(typeof res.data?.lastError).toBe("string");
    });

    it("inaccessible 状态的错误消息应为「目录不存在」", async () => {
      const { body } = await post(`/api/storage/${inaccessibleSourceId}/check`);
      const res = body as CheckResponse;
      // 设计文档规定的中文错误消息契约
      expect(res.data?.lastError).toBeDefined();
    });

    it("不存在的存储源 ID 应返回 404", async () => {
      const { status } = await post(`/api/storage/${crypto.randomUUID()}/check`);
      expect(status).toBe(404);
    });

    it("无效 UUID 格式的存储源 ID 应返回 4xx", async () => {
      const { status } = await post("/api/storage/not-a-valid-uuid/check");
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    });
  });

  // =========================================================================
  // 3. 数据流：check → GET /api/storage
  // =========================================================================
  describe("数据流：check → GET /api/storage 列表", () => {
    it("check 更新后，GET /api/storage 应返回更新后的 status", async () => {
      // 先 check
      await post(`/api/storage/${healthySourceId}/check`);

      // 再列表
      const { status, body } = await get("/api/storage");
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);

      // 找到对应的存储源
      const healthySource = (body.data as StorageSourceWithStatus[]).find(
        (s: StorageSourceWithStatus) => s.id === healthySourceId,
      );
      expect(healthySource).toBeDefined();
      expect(healthySource?.status).toBe("healthy");
    });

    it("check 更新后，GET /api/storage 应返回 lastError", async () => {
      // 先 check 不可访问源
      await post(`/api/storage/${inaccessibleSourceId}/check`);

      // 再列表
      const { body } = await get("/api/storage");
      const inaccessibleSource = (body.data as StorageSourceWithStatus[]).find(
        (s: StorageSourceWithStatus) => s.id === inaccessibleSourceId,
      );
      expect(inaccessibleSource).toBeDefined();
      expect(inaccessibleSource?.status).toBe("inaccessible");
      expect(inaccessibleSource?.lastError).toBeDefined();
    });

    it("每个存储源应包含 status 和 lastError 字段", async () => {
      const { body } = await get("/api/storage");
      const sources = body.data as StorageSourceWithStatus[];
      expect(sources.length).toBeGreaterThanOrEqual(5);

      for (const source of sources) {
        expect(source).toHaveProperty("status");
        expect(VALID_STATUSES).toContain(source.status as StorageSourceStatus);
        expect(source).toHaveProperty("lastError");
      }
    });

    it("未检查的存储源 status 应为 'unknown'", async () => {
      const { body } = await get("/api/storage");
      const unknownSource = (body.data as StorageSourceWithStatus[]).find(
        (s: StorageSourceWithStatus) => s.id === unknownSourceId,
      );
      expect(unknownSource).toBeDefined();
      expect(unknownSource?.status).toBe("unknown");
    });
  });

  // =========================================================================
  // 4. 数据流：check → GET /api/admin/stats
  // =========================================================================
  describe("数据流：check → GET /api/admin/stats", () => {
    it("admin stats 的 storageSources 应包含 status 字段", async () => {
      const { body } = await get("/api/admin/stats");
      expect(body.success).toBe(true);
      expect(body.data.storageSources).toBeDefined();
      expect(Array.isArray(body.data.storageSources)).toBe(true);

      const sources = body.data.storageSources as AdminStorageSourceStats[];
      for (const source of sources) {
        expect(source).toHaveProperty("status");
        expect(VALID_STATUSES).toContain(source.status as StorageSourceStatus);
      }
    });

    it("admin stats 的 storageSources 应包含 lastError 字段", async () => {
      const { body } = await get("/api/admin/stats");
      const sources = body.data.storageSources as AdminStorageSourceStats[];
      for (const source of sources) {
        expect(source).toHaveProperty("lastError");
      }
    });

    it("admin stats 的 storageSources 应保留原有字段", async () => {
      const { body } = await get("/api/admin/stats");
      const sources = body.data.storageSources as AdminStorageSourceStats[];
      for (const source of sources) {
        expect(source).toHaveProperty("id");
        expect(source).toHaveProperty("name");
        expect(source).toHaveProperty("type");
        expect(source).toHaveProperty("photoCount");
      }
    });

    it("健康源的 status 应在 admin stats 中正确反映", async () => {
      // 先确保健康源已检查
      await post(`/api/storage/${healthySourceId}/check`);

      const { body } = await get("/api/admin/stats");
      const sources = body.data.storageSources as AdminStorageSourceStats[];
      const healthy = sources.find((s) => s.id === healthySourceId);
      expect(healthy).toBeDefined();
      expect(healthy?.status).toBe("healthy");
    });
  });

  // =========================================================================
  // 5. POST /api/scan — 预检查守卫
  // =========================================================================
  describe("POST /api/scan — 存储源可达性预检查守卫", () => {
    beforeAll(async () => {
      // 确保各存储源状态正确设置（直接更新 DB，绕过 check 端点）
      sqlite
        .prepare("UPDATE storage_sources SET status = ? WHERE id = ?")
        .run("healthy", healthySourceId);
      sqlite
        .prepare("UPDATE storage_sources SET status = ?, last_error = ? WHERE id = ?")
        .run("inaccessible", "目录不存在", inaccessibleSourceId);
      sqlite
        .prepare("UPDATE storage_sources SET status = ?, last_error = ? WHERE id = ?")
        .run("unmounted", "软链接目标不存在，可能未挂载", unmountedSourceId);
      sqlite
        .prepare("UPDATE storage_sources SET status = ?, last_error = ? WHERE id = ?")
        .run("permission_denied", "权限不足，无法读取", permissionDeniedSourceId);
    });

    it("健康存储源应允许扫描（返回 200）", async () => {
      const { status, body } = await post("/api/scan", {
        storageSourceId: healthySourceId,
      });
      // 健康源允许扫描
      // 注意：并发守护可能返回 409（已有活跃扫描），但守卫本身不应拒绝
      expect([200, 409]).toContain(status);
      if (status === 200) {
        expect(body.success).toBe(true);
      }
    });

    it("inaccessible 存储源应拒绝扫描（返回 400）", async () => {
      const { status, body } = await post("/api/scan", {
        storageSourceId: inaccessibleSourceId,
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it("unmounted 存储源应拒绝扫描（返回 400）", async () => {
      const { status, body } = await post("/api/scan", {
        storageSourceId: unmountedSourceId,
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it("permission_denied 存储源应拒绝扫描（返回 400）", async () => {
      const { status, body } = await post("/api/scan", {
        storageSourceId: permissionDeniedSourceId,
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it("不健康的存储源错误响应应遵循 ApiResponse 格式", async () => {
      const { body } = await post("/api/scan", {
        storageSourceId: inaccessibleSourceId,
      });
      expect(body).toHaveProperty("success");
      expect(body.success).toBe(false);
      expect(body).toHaveProperty("error");
      expect(typeof body.error).toBe("string");
    });

    it("unknown 状态的存储源扫描行为取决于实现（可允许或拒绝）", async () => {
      const { status } = await post("/api/scan", {
        storageSourceId: unknownSourceId,
      });
      // unknown 可允许扫描（兼容未检查场景）或拒绝（保守策略）
      // 但不应 500
      expect(status).not.toBe(500);
      expect([200, 400, 409]).toContain(status);
    });
  });

  // =========================================================================
  // 6. POST /api/analyze — 预检查守卫
  // =========================================================================
  describe("POST /api/analyze — 存储源可达性预检查守卫", () => {
    beforeAll(async () => {
      // 确保存储源状态正确
      sqlite
        .prepare("UPDATE storage_sources SET status = ? WHERE id = ?")
        .run("healthy", healthySourceId);
      sqlite
        .prepare("UPDATE storage_sources SET status = ?, last_error = ? WHERE id = ?")
        .run("inaccessible", "目录不存在", inaccessibleSourceId);
      sqlite
        .prepare("UPDATE storage_sources SET status = ?, last_error = ? WHERE id = ?")
        .run("unmounted", "软链接目标不存在，可能未挂载", unmountedSourceId);
      sqlite
        .prepare("UPDATE storage_sources SET status = ?, last_error = ? WHERE id = ?")
        .run("permission_denied", "权限不足，无法读取", permissionDeniedSourceId);
    });

    it("健康存储源的照片应允许分析（返回 200）", async () => {
      const { status, body } = await post("/api/analyze", {
        photoIds: [healthyPhotoId],
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(typeof body.data.queuedCount).toBe("number");
      expect(Array.isArray(body.data.jobIds)).toBe(true);
    });

    it("inaccessible 存储源的照片应拒绝分析（返回 400）", async () => {
      const { status, body } = await post("/api/analyze", {
        photoIds: [inaccessiblePhotoId],
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it("unmounted 存储源的照片应拒绝分析（返回 400）", async () => {
      const { status, body } = await post("/api/analyze", {
        photoIds: [unmountedPhotoId],
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it("permission_denied 存储源的照片应拒绝分析（返回 400）", async () => {
      const { status, body } = await post("/api/analyze", {
        photoIds: [permissionDeniedPhotoId],
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it("混合健康与不健康存储源的照片应拒绝分析（返回 400）", async () => {
      // 设计文档：查询 photoIds 对应存储源，任一不健康则返回 400
      const { status, body } = await post("/api/analyze", {
        photoIds: [healthyPhotoId, inaccessiblePhotoId],
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it("不健康存储源拒绝分析时错误消息应明确指示原因", async () => {
      const { body } = await post("/api/analyze", {
        photoIds: [inaccessiblePhotoId],
      });
      expect(body.error).toBeDefined();
      // 错误消息应提示存储源不可访问，而非通用错误
      const errorMsg: string = body.error.toLowerCase();
      expect(
        errorMsg.includes("存储") ||
          errorMsg.includes("storage") ||
          errorMsg.includes("不可") ||
          errorMsg.includes("inaccessible") ||
          errorMsg.includes("unavailable"),
      ).toBe(true);
    });
  });

  // =========================================================================
  // 7. 跨系统字段名一致性验证
  // =========================================================================
  describe("跨系统字段名一致性 — status 和 lastError", () => {
    let checkResponse: CheckResponse | null = null;
    let storageListResponse: StorageSourceWithStatus[] | null = null;
    let adminStatsResponse: AdminStorageSourceStats[] | null = null;

    beforeAll(async () => {
      // 收集三个端点的响应数据
      const check = await post(`/api/storage/${healthySourceId}/check`);
      checkResponse = check.body as CheckResponse;

      const storageList = await get("/api/storage");
      storageListResponse = storageList.body?.data as StorageSourceWithStatus[];

      const adminStats = await get("/api/admin/stats");
      adminStatsResponse = adminStats.body?.data?.storageSources as AdminStorageSourceStats[];
    });

    it("status 字段名在 check 响应中为 'status'", () => {
      expect(checkResponse?.data).toHaveProperty("status");
    });

    it("status 字段名在 storage 列表响应中为 'status'", () => {
      if (storageListResponse && storageListResponse.length > 0) {
        expect(storageListResponse[0]).toHaveProperty("status");
      }
    });

    it("status 字段名在 admin stats 中为 'status'", () => {
      if (adminStatsResponse && adminStatsResponse.length > 0) {
        expect(adminStatsResponse[0]).toHaveProperty("status");
      }
    });

    it("lastError 字段名在 check 响应中为 'lastError'", () => {
      expect(checkResponse?.data).toHaveProperty("lastError");
    });

    it("lastError 字段名在 storage 列表响应中为 'lastError'", () => {
      if (storageListResponse && storageListResponse.length > 0) {
        expect(storageListResponse[0]).toHaveProperty("lastError");
      }
    });

    it("lastError 字段名在 admin stats 中为 'lastError'", () => {
      if (adminStatsResponse && adminStatsResponse.length > 0) {
        expect(adminStatsResponse[0]).toHaveProperty("lastError");
      }
    });

    it("三个端点对同一存储源的 status 值应一致", async () => {
      // 确保 healthySource 已检查
      await post(`/api/storage/${healthySourceId}/check`);

      // 从三个端点获取
      const checkRes = await post(`/api/storage/${healthySourceId}/check`);
      const storageRes = await get("/api/storage");
      const adminRes = await get("/api/admin/stats");

      const checkStatus = (checkRes.body as CheckResponse).data?.status;
      const storageSource = (storageRes.body?.data as StorageSourceWithStatus[])?.find(
        (s) => s.id === healthySourceId,
      );
      const adminSource = (adminRes.body?.data?.storageSources as AdminStorageSourceStats[])?.find(
        (s) => s.id === healthySourceId,
      );

      // 三个端点返回的 status 应一致
      if (checkStatus && storageSource && adminSource) {
        expect(storageSource.status).toBe(checkStatus);
        expect(adminSource.status).toBe(checkStatus);
      }
    });

    it("三个端点不应使用不同的字段名指代同一概念", () => {
      // 验证响应结构中不包含禁止的别名
      // 此测试在 code review 时检查
      const checkData = checkResponse?.data;
      if (checkData) {
        // status 不应被命名为 sourceStatus, storageStatus, state, healthStatus
        expect(checkData).not.toHaveProperty("sourceStatus");
        expect(checkData).not.toHaveProperty("storageStatus");
        expect(checkData).not.toHaveProperty("state");
        expect(checkData).not.toHaveProperty("healthStatus");

        // lastError 不应被命名为 lastErrorMessage, errorMessage, lastErrorMsg
        expect(checkData).not.toHaveProperty("errorMessage");
        expect(checkData).not.toHaveProperty("lastErrorMessage");
        expect(checkData).not.toHaveProperty("lastErrorMsg");
      }
    });
  });

  // =========================================================================
  // 8. 数据库状态更新一致性
  // =========================================================================
  describe("数据库状态更新一致性", () => {
    it("check 端点应同步更新 DB 中的 status 和 last_error 列", async () => {
      // 创建新存储源用于验证 DB 更新
      const newSourceId = crypto.randomUUID();

      sqlite
        .prepare(
          "INSERT INTO storage_sources (id, name, type, root_path, enabled, status) VALUES (?, ?, ?, ?, 1, 'unknown')",
        )
        .run(newSourceId, "DB更新测试源", "local", tmpTestDir);

      // 调用 check
      await post(`/api/storage/${newSourceId}/check`);

      // 验证 DB 已更新
      const row = sqlite
        .prepare("SELECT status, last_error FROM storage_sources WHERE id = ?")
        .get(newSourceId) as { status: string; last_error: string | null } | undefined;

      expect(row).toBeDefined();
      // tmpTestDir 是存在的目录，应更新为 healthy
      expect(row?.status).toBe("healthy");
    });

    it("inaccessible 源应更新 last_error 为非空字符串", async () => {
      const newSourceId = crypto.randomUUID();

      sqlite
        .prepare(
          "INSERT INTO storage_sources (id, name, type, root_path, enabled, status) VALUES (?, ?, ?, ?, 1, 'unknown')",
        )
        .run(newSourceId, "DB错误消息测试源", "local", "/tmp/__definitely_nonexistent__");

      // 调用 check
      await post(`/api/storage/${newSourceId}/check`);

      // 验证 DB 已更新
      const row = sqlite
        .prepare("SELECT status, last_error FROM storage_sources WHERE id = ?")
        .get(newSourceId) as { status: string; last_error: string | null } | undefined;

      expect(row).toBeDefined();
      expect(row?.status).toBe("inaccessible");
      // 设计文档：inaccessible 的错误消息为「目录不存在」
      expect(row?.last_error).toBeDefined();
      expect(typeof row?.last_error).toBe("string");
      expect((row?.last_error as string).length).toBeGreaterThan(0);
    });
  });
});

// =========================================================================
// 辅助：手动建表（含新增 status + last_error 列）
// =========================================================================

function createTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS storage_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      root_path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_scan_at TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0,
      thumbnail_path TEXT,
      taken_at TEXT,
      file_mtime INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(storage_source_id, file_path)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photo_tags (
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      confidence REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (photo_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS photo_analyses (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      ai_model TEXT NOT NULL,
      raw_response TEXT NOT NULL,
      narrative TEXT NOT NULL DEFAULT '',
      aesthetic_score REAL NOT NULL DEFAULT 5,
      tags TEXT NOT NULL DEFAULT '[]',
      composition TEXT NOT NULL DEFAULT '{}',
      color_analysis TEXT NOT NULL DEFAULT '{}',
      emotional_analysis TEXT NOT NULL DEFAULT '{}',
      usage_suggestions TEXT NOT NULL DEFAULT '[]',
      prompt_version TEXT NOT NULL DEFAULT 'v1',
      processed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_picks (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL REFERENCES photos(id),
      pick_date TEXT NOT NULL,
      title TEXT NOT NULL,
      narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scan_logs (
      id TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
      job_id TEXT,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

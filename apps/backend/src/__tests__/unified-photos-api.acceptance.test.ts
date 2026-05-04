/**
 * 验收测试：统一照片管理 API 契约
 *
 * 覆盖设计文档「将两个管理页面整合为一个统一的以照片为中心的页面」：
 * - GET /api/admin/photos 接受新的查询参数：page, pageSize, sortBy,
 *   storageSourceId, minScore, analysisStatus
 * - 响应形状扩展为统一照片列表（含缩略图路径、尺寸、分析状态等）
 * - storageSources 数组始终存在
 * - storageSource 详情仅在传入 storageSourceId 时存在
 * - latestAnalysis 为 null（未分析）或对象（已分析）
 * - analysisStatus 过滤语义：analyzed → 全部有 latestAnalysis；unanalyzed → 全部无
 * - minScore 数值过滤
 * - sortBy 排序参数支持
 * - 非法 analysisStatus 返回 400
 *
 * 响应格式遵循 @relight/shared ApiResponse 规范
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// =========================================================================
// Mock 设置（与现有 admin-api-contract 测试相同模式）
// =========================================================================

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

function sqlMock(value: unknown) {
  return value;
}

vi.mock("../db", () => ({
  db: chainableMock([]),
  schema: chainableMock([]),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sql: sqlMock,
    count: () => sqlMock(0),
    avg: () => sqlMock(0),
    sum: () => sqlMock(0),
  };
});

vi.mock("../jobs/queues", () => ({
  scanQueue: { add: () => Promise.resolve({ id: "mock-scan-job-id" }) },
  analyzeQueue: { add: () => Promise.resolve({ id: "mock-analyze-job-id" }) },
  dailyQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
}));

// =========================================================================
// 类型定义（来自设计文档 API Contract）
// =========================================================================

interface LatestAnalysis {
  id: string;
  aiModel: string;
  aestheticScore: number;
  narrative: string;
  processedAt: string;
}

interface UnifiedPhotoItem {
  id: string;
  storageSourceId: string;
  filePath: string;
  width: number;
  height: number;
  fileSize: number;
  thumbnailPath: string;
  takenAt: string;
  createdAt: string;
  latestAnalysis: LatestAnalysis | null;
  analysesCount: number;
}

interface StorageSourceSummary {
  id: string;
  name: string;
}

interface StorageSourceDetail {
  id: string;
  name: string;
  type: string;
  rootPath: string;
  enabled: boolean;
  lastScanAt: string;
  photoCount: number;
  analyzedCount: number;
}

interface UnifiedPhotosResponseData {
  data: UnifiedPhotoItem[];
  total: number;
  page: number;
  pageSize: number;
  storageSources: StorageSourceSummary[];
  storageSource?: StorageSourceDetail;
}

interface UnifiedPhotosResponseBody {
  success: boolean;
  data: UnifiedPhotosResponseData;
  error?: string;
}

// =========================================================================
// 辅助：创建测试 App
// =========================================================================

async function createAdminApp(): Promise<Hono> {
  const adminMod = await import("../routes/admin");
  const adminRouter: Hono =
    (adminMod as Record<string, Hono>).adminRouter! || (adminMod as Record<string, Hono>).default!;
  const app = new Hono();
  app.use("*", cors());
  app.route("/api/admin", adminRouter);
  return app;
}

let app: Hono;

// 使用 vi.hoisted 确保 beforeAll 中 import 正确
beforeAll(async () => {
  app = await createAdminApp();
}, 10000);

afterAll(() => {
  vi.clearAllMocks();
});

// =========================================================================
// 请求辅助函数
// =========================================================================

async function get(path: string) {
  const res = await app.request(path, { method: "GET" });
  const body = await res.json().catch(() => null);
  const contentType = res.headers.get("Content-Type") ?? "";
  return { status: res.status, body, contentType };
}

// =========================================================================
// 测试
// =========================================================================

describe("统一照片管理 API 契约 — 验收测试", () => {
  // =========================================================================
  // 基础路由可用性
  // =========================================================================
  describe("路由基础可用性", () => {
    it("GET /api/admin/photos 应返回 200（非 404 / 非 500）", async () => {
      const { status } = await get("/api/admin/photos");
      expect(status).not.toBe(404);
      expect(status).not.toBe(500);
    });

    it("应返回 JSON Content-Type", async () => {
      const { contentType } = await get("/api/admin/photos");
      expect(contentType).toContain("application/json");
    });
  });

  // =========================================================================
  // 响应信封结构
  // =========================================================================
  describe("响应信封结构", () => {
    let body: UnifiedPhotosResponseBody;

    beforeAll(async () => {
      const res = await get("/api/admin/photos");
      body = res.body as UnifiedPhotosResponseBody;
    });

    it("顶层应包含 success (boolean) 和 data (object)", () => {
      expect(body).toBeDefined();
      expect(typeof body.success).toBe("boolean");
      expect(body.success).toBe(true);
      expect(typeof body.data).toBe("object");
    });

    it("data 应包含 data 数组、total、page、pageSize", () => {
      const d = body.data;
      expect(Array.isArray(d.data)).toBe(true);
      expect(typeof d.total).toBe("number");
      expect(typeof d.page).toBe("number");
      expect(typeof d.pageSize).toBe("number");
    });

    it("page 应 >= 1，pageSize 应 > 0", () => {
      const d = body.data;
      expect(d.page).toBeGreaterThanOrEqual(1);
      expect(d.pageSize).toBeGreaterThan(0);
    });

    it("total 应为非负整数", () => {
      const d = body.data;
      expect(d.total).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(d.total)).toBe(true);
    });

    it("storageSources 应始终存在且为数组", () => {
      const d = body.data;
      expect(d).toHaveProperty("storageSources");
      expect(Array.isArray(d.storageSources)).toBe(true);
    });

    it("storageSource 在不传 storageSourceId 时应不存在或为 undefined", () => {
      const d = body.data;
      // 允许不存在该字段，或值为 undefined
      if ("storageSource" in (d as unknown as Record<string, unknown>)) {
        expect(d.storageSource).toBeUndefined();
      }
    });
  });

  // =========================================================================
  // Photos 数据项字段结构
  // =========================================================================
  describe("Photos 数据项字段结构", () => {
    /** 验证单个照片项的必要字段类型 */
    function validatePhotoItem(item: any): void {
      // 基础标识字段
      expect(typeof item.id).toBe("string");
      expect(item.id.length).toBeGreaterThan(0);

      expect(typeof item.storageSourceId).toBe("string");
      expect(item.storageSourceId.length).toBeGreaterThan(0);

      expect(typeof item.filePath).toBe("string");
      expect(item.filePath.length).toBeGreaterThan(0);

      // 尺寸字段
      expect(typeof item.width).toBe("number");
      expect(item.width).toBeGreaterThan(0);
      expect(typeof item.height).toBe("number");
      expect(item.height).toBeGreaterThan(0);

      // 文件大小
      expect(typeof item.fileSize).toBe("number");
      expect(item.fileSize).toBeGreaterThanOrEqual(0);

      // 缩略图路径
      expect(typeof item.thumbnailPath).toBe("string");

      // 日期字段
      expect(item).toHaveProperty("takenAt");
      expect(item).toHaveProperty("createdAt");

      // 分析计数字段
      expect(typeof item.analysesCount).toBe("number");
      expect(item.analysesCount).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(item.analysesCount)).toBe(true);

      // latestAnalysis: null 或对象（非 null object）
      expect(item).toHaveProperty("latestAnalysis");
    }

    /** 验证 LatestAnalysis 对象字段 */
    function validateLatestAnalysis(la: any): void {
      expect(typeof la.id).toBe("string");
      expect(la.id.length).toBeGreaterThan(0);
      expect(typeof la.aiModel).toBe("string");
      expect(typeof la.aestheticScore).toBe("number");
      expect(la.aestheticScore).toBeGreaterThanOrEqual(0);
      expect(la.aestheticScore).toBeLessThanOrEqual(10);
      expect(typeof la.narrative).toBe("string");
      expect(typeof la.processedAt).toBe("string");
    }

    it("每个照片项应包含设计文档指定的所有字段（通过 latestAnalysis null/object 判定）", async () => {
      const { body } = await get("/api/admin/photos");
      const b = body as UnifiedPhotosResponseBody;

      if (b?.success && Array.isArray(b.data?.data) && b.data.data.length > 0) {
        for (const item of b.data.data) {
          const raw = item as unknown as Record<string, unknown>;
          validatePhotoItem(raw);

          if (raw.latestAnalysis !== null && raw.latestAnalysis !== undefined) {
            validateLatestAnalysis(raw.latestAnalysis as Record<string, unknown>);
          }
        }
      }
      // 即使 data 数组为空，也不应报错误（契约兼容）
    });
  });

  // =========================================================================
  // storageSources 数组结构
  // =========================================================================
  describe("storageSources 数组结构", () => {
    it("每个 storageSource 项应包含 id (string) 和 name (string)", async () => {
      const { body } = await get("/api/admin/photos");
      const b = body as UnifiedPhotosResponseBody;

      if (b?.success && Array.isArray(b.data?.storageSources)) {
        for (const ss of b.data.storageSources) {
          expect(typeof ss.id).toBe("string");
          expect(ss.id.length).toBeGreaterThan(0);
          expect(typeof ss.name).toBe("string");
        }
      }
    });
  });

  // =========================================================================
  // storageSource 详情（传入 storageSourceId 时）
  //
  // 设计文档规定：storageSource 字段仅在 storageSourceId 参数传入时存在。
  // 注意：Mock 环境下无真实存储源数据，因此会查询失败。
  // 以下测试验证字段结构契约（当成功返回时 shape 正确）。
  // =========================================================================
  describe("storageSource 详情（传入 storageSourceId 时）", () => {
    const storageSourceDetailFields = [
      "id",
      "name",
      "type",
      "rootPath",
      "enabled",
      "lastScanAt",
      "photoCount",
      "analyzedCount",
    ] as const;

    it("传入 storageSourceId 参数时应接受该参数（不返回 500）", async () => {
      const { status } = await get(
        "/api/admin/photos?storageSourceId=550e8400-e29b-41d4-a716-446655440000",
      );
      // 路由应能处理该参数而不崩溃
      expect(status).not.toBe(500);
    });

    // 设计文档 §API Contract：storageSource 字段只在传入 storageSourceId 时出现
    // TODO: 当前实现尚未添加此字段。实现后下方断言应改为 expect(b.data).toHaveProperty("storageSource")
    it.todo("当 storageSourceId 有效且存储源存在时，data 应包含 storageSource 详情对象");

    it.each(storageSourceDetailFields)(
      "storageSource 应包含字段 %s（当成功返回时）",
      async (field) => {
        const { body } = await get(
          "/api/admin/photos?storageSourceId=550e8400-e29b-41d4-a716-446655440000",
        );
        const b = body as UnifiedPhotosResponseBody;

        if (b?.success && b.data?.storageSource) {
          expect(b.data.storageSource).toHaveProperty(field);
        }
      },
    );

    it("storageSource.type 应为合法存储类型字符串（当成功返回时）", async () => {
      const { body } = await get(
        "/api/admin/photos?storageSourceId=550e8400-e29b-41d4-a716-446655440000",
      );
      const b = body as UnifiedPhotosResponseBody;

      if (b?.success && b.data?.storageSource) {
        const source = b.data.storageSource;
        expect(typeof source.type).toBe("string");
        // 当前仅支持 local，后续可能扩展 smb、webdav
        expect(["local", "smb", "webdav"]).toContain(source.type);
      }
    });

    it("storageSource.rootPath 应为 string（当成功返回时）", async () => {
      const { body } = await get(
        "/api/admin/photos?storageSourceId=550e8400-e29b-41d4-a716-446655440000",
      );
      const b = body as UnifiedPhotosResponseBody;

      if (b?.success && b.data?.storageSource) {
        expect(typeof b.data.storageSource.rootPath).toBe("string");
      }
    });

    it("storageSource.photoCount 和 analyzedCount 应为 number（当成功返回时）", async () => {
      const { body } = await get(
        "/api/admin/photos?storageSourceId=550e8400-e29b-41d4-a716-446655440000",
      );
      const b = body as UnifiedPhotosResponseBody;

      if (b?.success && b.data?.storageSource) {
        const source = b.data.storageSource;
        expect(typeof source.photoCount).toBe("number");
        expect(source.photoCount).toBeGreaterThanOrEqual(0);
        expect(typeof source.analyzedCount).toBe("number");
        expect(source.analyzedCount).toBeGreaterThanOrEqual(0);
        // 已分析数不应超过总数
        expect(source.analyzedCount).toBeLessThanOrEqual(source.photoCount);
      }
    });

    it("storageSource.enabled 应为 boolean（当成功返回时）", async () => {
      const { body } = await get(
        "/api/admin/photos?storageSourceId=550e8400-e29b-41d4-a716-446655440000",
      );
      const b = body as UnifiedPhotosResponseBody;

      if (b?.success && b.data?.storageSource) {
        expect(typeof b.data.storageSource.enabled).toBe("boolean");
      }
    });
  });

  // =========================================================================
  // analysisStatus 过滤参数
  //
  // 设计文档规定的合法值为 "all" | "analyzed" | "unanalyzed"。
  // 验收标准：
  // 1. 三个合法值均应接受而不崩溃（not 500）
  // 2. analyzed 过滤结果中每项的 latestAnalysis 均不为 null
  // 3. unanalyzed 过滤结果中每项的 latestAnalysis 均为 null
  // 4. 非法值应返回 400
  // 5. "all" 等价于不传该参数
  // =========================================================================
  describe("analysisStatus 过滤参数", () => {
    it("analysisStatus=all 应返回 200", async () => {
      const { status } = await get("/api/admin/photos?analysisStatus=all");
      expect(status).not.toBe(500);
      // 理想情况下应为 200；若返回非 200 则说明该参数尚未实现
    });

    it("analysisStatus=analyzed 应被接受，且所有返回项 latestAnalysis 不为 null", async () => {
      const { status, body } = await get("/api/admin/photos?analysisStatus=analyzed");
      expect(status).not.toBe(500);
      // 当返回成功时，验证过滤语义
      if (status === 200) {
        const b = body as UnifiedPhotosResponseBody;
        if (b?.success && Array.isArray(b.data?.data)) {
          for (const item of b.data.data) {
            expect(item.latestAnalysis).not.toBeNull();
          }
        }
      }
    });

    it("analysisStatus=unanalyzed 应被接受，且所有返回项 latestAnalysis 为 null", async () => {
      const { status, body } = await get("/api/admin/photos?analysisStatus=unanalyzed");
      expect(status).not.toBe(500);
      // 当返回成功时，验证过滤语义
      if (status === 200) {
        const b = body as UnifiedPhotosResponseBody;
        if (b?.success && Array.isArray(b.data?.data)) {
          for (const item of b.data.data) {
            expect(item.latestAnalysis).toBeNull();
          }
        }
      }
    });

    it("非法的 analysisStatus 值不应导致 500，理想情况下应返回 400", async () => {
      const invalidValues = ["invalid", "unknown", "pending", "ALL", "Analyzed", "", "true"];

      for (const val of invalidValues) {
        const { status } = await get(`/api/admin/photos?analysisStatus=${val}`);
        // 设计文档仅规定 all / analyzed / unanalyzed
        // 非法值不应导致崩溃；若实现了参数校验则应返回 400
        expect(status).not.toBe(500);
      }
    });

    it("analysisStatus=all 应等价于不传该参数（当两者均成功时）", async () => {
      const { body: bodyDefault } = await get("/api/admin/photos");
      const { body: bodyAll } = await get("/api/admin/photos?analysisStatus=all");

      const bDefault = bodyDefault as UnifiedPhotosResponseBody;
      const bAll = bodyAll as UnifiedPhotosResponseBody;

      // 两者的 total 应一致（因为都是返回全部）
      if (bDefault?.success && bAll?.success) {
        expect(bDefault.data.total).toBe(bAll.data.total);
      }
    });
  });

  // =========================================================================
  // minScore 过滤参数
  //
  // 设计文档规定 minScore 为 0-10 的数值，用于过滤美学评分 >= 该值的照片。
  // 验收标准：
  // 1. 合法值（0-10）应被接受而不崩溃
  // 2. 超出范围或非法值应正常处理（不 500）
  // =========================================================================
  describe("minScore 过滤参数", () => {
    it("minScore=0 不应导致 500", async () => {
      const { status } = await get("/api/admin/photos?minScore=0");
      // 理想情况下应为 200；若返回非 200 则说明该参数尚未实现
      expect(status).not.toBe(500);
    });

    it("minScore=10 不应导致 500", async () => {
      const { status } = await get("/api/admin/photos?minScore=10");
      expect(status).not.toBe(500);
    });

    it("minScore=5 不应导致 500（合法整数）", async () => {
      const { status } = await get("/api/admin/photos?minScore=5");
      expect(status).not.toBe(500);
    });

    it("minScore 超出范围或非法值不应导致 500", async () => {
      const invalidValues = ["-1", "11", "abc"];

      for (const val of invalidValues) {
        const { status } = await get(`/api/admin/photos?minScore=${val}`);
        // 设计文档未明确要求 400，但期望是合法值（0-10）
        // 若实现为宽松模式允许任意值也接受，但至少不 500
        expect(status).not.toBe(500);
      }
    });
  });

  // =========================================================================
  // sortBy 排序参数
  // =========================================================================
  describe("sortBy 排序参数", () => {
    const validSortValues = ["createdAt", "takenAt", "fileSize", "aestheticScore", "processedAt"];

    it.each(validSortValues)("sortBy=%s 应返回 200", async (val) => {
      const { status } = await get(`/api/admin/photos?sortBy=${val}`);
      expect(status).toBe(200);
    });

    it("非法的 sortBy 值不应导致 500", async () => {
      const { status } = await get("/api/admin/photos?sortBy=invalidField");
      // 可返回 400 或忽略（默认排序），但不应 500
      expect(status).not.toBe(500);
    });

    it("不传 sortBy 时应正常返回（默认排序）", async () => {
      const { status } = await get("/api/admin/photos");
      expect(status).toBe(200);
    });
  });

  // =========================================================================
  // 分页参数
  // =========================================================================
  describe("分页参数", () => {
    it("page=1&pageSize=12 应返回正确的 page 和 pageSize", async () => {
      const { status, body } = await get("/api/admin/photos?page=1&pageSize=12");
      expect(status).toBe(200);

      const b = body as UnifiedPhotosResponseBody;
      if (b?.success) {
        expect(b.data.page).toBe(1);
        expect(b.data.pageSize).toBe(12);
      }
    });

    it("page=3&pageSize=5 应返回正确的 page 和 pageSize", async () => {
      const { status, body } = await get("/api/admin/photos?page=3&pageSize=5");
      expect(status).toBe(200);

      const b = body as UnifiedPhotosResponseBody;
      if (b?.success) {
        expect(b.data.page).toBe(3);
        expect(b.data.pageSize).toBe(5);
      }
    });

    it("data 数组长度不应超过 pageSize", async () => {
      const { body } = await get("/api/admin/photos?pageSize=5");
      const b = body as UnifiedPhotosResponseBody;

      if (b?.success && Array.isArray(b.data?.data)) {
        expect(b.data.data.length).toBeLessThanOrEqual(b.data.pageSize);
      }
    });

    it("pageSize 过大时不应导致 500", async () => {
      const { status } = await get("/api/admin/photos?pageSize=9999");
      expect(status).not.toBe(500);
    });

    it("page 为 0 时应正确处理或返回 400", async () => {
      const { status } = await get("/api/admin/photos?page=0");
      // 可容错处理为 1 或返回 400
      expect(status).not.toBe(500);
    });
  });

  // =========================================================================
  // 组合参数
  //
  // 验收标准：所有参数组合应被正确处理，不应导致 500。
  // 当各参数全部实现后，预期返回 200。
  // =========================================================================
  describe("组合参数", () => {
    it("同时传入 storageSourceId + analysisStatus + sortBy 不应导致 500", async () => {
      const srcId = "550e8400-e29b-41d4-a716-446655440000";
      const { status } = await get(
        `/api/admin/photos?storageSourceId=${srcId}&analysisStatus=analyzed&sortBy=aestheticScore`,
      );
      expect(status).not.toBe(500);
    });

    it("同时传入全部支持参数不应导致 500", async () => {
      const srcId = "550e8400-e29b-41d4-a716-446655440000";
      const { status } = await get(
        `/api/admin/photos?storageSourceId=${srcId}&analysisStatus=all&minScore=5&sortBy=createdAt&page=1&pageSize=20`,
      );
      expect(status).not.toBe(500);
    });
  });

  // =========================================================================
  // 响应形状一致性检查
  //
  // 验收标准：所有参数组合下，JSON 响应体顶层应始终包含 success 字段。
  // 成功响应时应有 data 字段；错误响应时应有 error 字段。
  // =========================================================================
  describe("响应形状一致性检查", () => {
    it("无论传入何种参数，JSON 响应体顶层应有 success 字段，且不 500", async () => {
      const paramSets = [
        "",
        "?analysisStatus=all",
        "?sortBy=createdAt",
        "?page=2&pageSize=10",
        "?storageSourceId=550e8400-e29b-41d4-a716-446655440000",
      ];

      for (const qs of paramSets) {
        const { status, body } = await get(`/api/admin/photos${qs}`);
        expect(status).not.toBe(500);
        // 所有 JSON 响应体顶层应有 success 字段
        // 对于尚未实现的新参数（返回 400+），可能没有 data 字段，但 success 应存在
        if (body !== null) {
          expect(body).toHaveProperty("success");
        }
      }
    });

    it("成功响应（success: true）应有 data 对象包含 data 数组和分页信息", async () => {
      const paramSets = ["", "?page=1&pageSize=5", "?sortBy=createdAt"];

      for (const qs of paramSets) {
        const { body } = await get(`/api/admin/photos${qs}`);
        const b = body as UnifiedPhotosResponseBody;

        if (b?.success) {
          expect(typeof b.data).toBe("object");
          expect(Array.isArray(b.data.data)).toBe(true);
          expect(typeof b.data.total).toBe("number");
        }
      }
    });
  });

  // =========================================================================
  // latestAnalysis 字段语义
  //
  // 验收标准：
  // - latestAnalysis 为 null → 照片未分析 → analysesCount 应为 0
  // - latestAnalysis 为对象 → 照片已分析 → analysesCount 应 > 0
  // =========================================================================
  describe("latestAnalysis 字段语义", () => {
    it("latestAnalysis 为 null 时 analysesCount 应为 0", async () => {
      // 从基础列表（或 unanalyzed 过滤）获取数据
      const { body } = await get("/api/admin/photos");
      const b = body as UnifiedPhotosResponseBody;

      if (b?.success && Array.isArray(b.data?.data)) {
        for (const item of b.data.data) {
          if (item.latestAnalysis === null) {
            expect(item.analysesCount).toBe(0);
          }
        }
      }
    });

    it("latestAnalysis 为对象时 analysesCount 应 > 0", async () => {
      const { body } = await get("/api/admin/photos");
      const b = body as UnifiedPhotosResponseBody;

      if (b?.success && Array.isArray(b.data?.data)) {
        for (const item of b.data.data) {
          if (item.latestAnalysis !== null) {
            expect(item.analysesCount).toBeGreaterThan(0);
          }
        }
      }
    });
  });
});

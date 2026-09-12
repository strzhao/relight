/**
 * 验收测试（红队）：动态视频壁纸 — API 契约（302/404 路由 + today 字段两态）
 *
 * 设计文档（state.md）对应谓词与契约：
 *   - §契约规约 接口签名（API, invariant）：
 *     GET /api/daily/:pickDate/wallpaper-video
 *       → 302（Header Location = landscape .mov COS URL）
 *       ｜ 404（body JSON 含 error 字段）
 *     GET /api/daily/today 响应 data 增可选字段 wallpaperVideoUrl（landscape .mov COS URL；
 *       无则字段缺省）。example：有值时 data.wallpaperVideoUrl endsWith "_landscape.mov"
 *       且 host contains "myqcloud.com"；反例：URL 列 null → 响应不含该字段。
 *   - 场景 1.P2 [det-machine]（API 侧锚定）：wallpaperVideoUrl endsWith "_landscape.mov"
 *     AND host contains "myqcloud.com"
 *   - 场景 4.P2（字段缺省语义）：列 null → "wallpaperVideoUrl" in data === false
 *     （字段缺省，不是 null、不是空串）
 *   - 后端设计 §5：buildPickResponse 增字段 wallpaperVideoUrl?: string（无则缺省），
 *     数据源为 DB 列 wallpaperVideoLandscapeUrl（schema 契约字段名）
 *
 * 红队铁律：本文件仅依据设计文档编写，不读蓝队实现代码（routes/daily.ts 新改动、
 *   jobs/wallpaper-video.ts、lib/wallpaper/video.ts 等一律未读）。
 *   fixture/mock 惯例沿 daily-api.acceptance.test.ts（chainable mock + createApp 黑盒请求）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 创建可链式调用的 Mock 对象，模拟 Drizzle ORM 的链式调用。
 * （与 daily-api.acceptance.test.ts 同款）
 */
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
        return result[Number(prop)];
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

vi.mock("../db", () => ({
  db: mockDb,
  schema: chainableMock([]),
}));

vi.mock("../jobs/queues", () => ({
  scanQueue: { add: vi.fn(async () => ({ id: "mock-job-id" })) },
  analyzeQueue: { add: vi.fn(async () => ({ id: "mock-job-id" })) },
  dailyQueue: { add: vi.fn(async () => ({ id: "mock-job-id" })) },
  dailyPushQueue: { add: vi.fn(async () => ({ id: "mock-job-id" })) },
  dailyVideoQueue: { add: vi.fn(async () => ({ id: "mock-job-id" })) },
  wallpaperVideoQueue: { add: vi.fn(async () => ({ id: "mock-job-id" })) },
}));

import { createApp } from "../app";

// ---- 契约字面量（§契约规约 逐字）----

const PICK_DATE = "2026-09-12";
/** COS key 契约：{prefix}/wallpaper-videos/{pickDate}_landscape.mov → 公网 URL */
const LANDSCAPE_URL =
  "https://little-bee-assets-1324334992.cos.ap-shanghai.myqcloud.com/relight/wallpaper-videos/2026-09-12_landscape.mov";
/** COS key 契约：{prefix}/wallpaper-videos/{pickDate}_portrait.mp4 → 公网 URL */
const PORTRAIT_URL =
  "https://little-bee-assets-1324334992.cos.ap-shanghai.myqcloud.com/relight/wallpaper-videos/2026-09-12_portrait.mp4";

// ---- 辅助 ----

function app() {
  return createApp();
}

/** 构造 dailyPicks 行（含契约新增的两列 camelCase 字段名） */
function makePick(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pick-wv-001",
    photoId: "photo-wv-001",
    pickDate: PICK_DATE,
    title: "金色黄昏",
    narrative: "五年前的今天，你在海边捕捉到了这张温暖的照片。夕阳将天空染成金橙色，海浪轻抚沙滩。",
    score: 8.5,
    composedImagePath: "/storage/daily-composed/2026-09-12.jpg",
    members: [],
    createdAt: "2026-09-12T06:00:00.000Z",
    // 契约新增 DB 列（schema：wallpaper_video_landscape_url / wallpaper_video_portrait_url）
    wallpaperVideoLandscapeUrl: null as string | null,
    wallpaperVideoPortraitUrl: null as string | null,
    ...overrides,
  };
}

function makePhoto() {
  return {
    id: "photo-wv-001",
    storageSourceId: "source-001",
    filePath: "/photos/sunset.jpg",
    fileHash: "abc123",
    width: 4000,
    height: 3000,
    fileSize: 5242880,
    thumbnailPath: "/thumbnails/sunset.jpg",
    takenAt: "2019-05-05T18:30:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("动态视频壁纸 — API 契约（设计文档 §契约规约 接口签名）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnValue(chainableMock([]));
    mockDb.insert.mockReturnValue(chainableMock([]));
    mockDb.update.mockReturnValue(chainableMock([]));
  });

  // =========================================================================
  // GET /api/daily/:pickDate/wallpaper-video — 302 / 404
  // =========================================================================

  describe("GET /api/daily/:pickDate/wallpaper-video — 下载路由 302/404 契约", () => {
    it("DB landscape 列非空 → 302，且 Location == landscape .mov COS URL（逐字）", async () => {
      // 路由只需查 dailyPicks 一行：第 1 个 select 返回 pick
      mockDb.select.mockReturnValueOnce(
        chainableMock([
          makePick({
            wallpaperVideoLandscapeUrl: LANDSCAPE_URL,
            wallpaperVideoPortraitUrl: PORTRAIT_URL,
          }),
        ]),
      );

      const res = await app().request(`/api/daily/${PICK_DATE}/wallpaper-video`, {
        method: "GET",
      });

      expect(res.status).toBe(302);
      // 契约：Header Location = landscape .mov COS URL（DB 回执 URL 逐字）
      expect(res.headers.get("Location")).toBe(LANDSCAPE_URL);
    });

    it("Location 必须是 landscape .mov（endsWith _landscape.mov 且 host 含 myqcloud.com）", async () => {
      mockDb.select.mockReturnValueOnce(
        chainableMock([
          makePick({
            wallpaperVideoLandscapeUrl: LANDSCAPE_URL,
          }),
        ]),
      );

      const res = await app().request(`/api/daily/${PICK_DATE}/wallpaper-video`, {
        method: "GET",
      });
      const location = res.headers.get("Location") ?? "";

      expect(res.status).toBe(302);
      expect(location.endsWith("_landscape.mov")).toBe(true);
      expect(location).toContain("myqcloud.com");
    });

    it("DB landscape 列为 null → 404，body JSON 含 error 字段（非空字符串）", async () => {
      mockDb.select.mockReturnValueOnce(chainableMock([makePick()]));

      const res = await app().request(`/api/daily/${PICK_DATE}/wallpaper-video`, {
        method: "GET",
      });
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;

      expect(res.status).toBe(404);
      // 契约：404（body JSON 含 error 字段）
      expect(body).not.toBeNull();
      expect(body).toHaveProperty("error");
      expect(typeof body?.error).toBe("string");
      expect((body?.error as string).length).toBeGreaterThan(0);
    });

    it("pickDate 无当日记录 → 404（不抛 500）", async () => {
      mockDb.select.mockReturnValue(chainableMock([]));

      const res = await app().request("/api/daily/2026-01-01/wallpaper-video", {
        method: "GET",
      });
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;

      expect(res.status).toBe(404);
      expect(body).toHaveProperty("error");
    });
  });

  // =========================================================================
  // GET /api/daily/today — wallpaperVideoUrl 字段两态
  // =========================================================================

  describe("GET /api/daily/today — wallpaperVideoUrl 字段有/无两态（fixture DB 种子）", () => {
    it("有值态：字段存在，endsWith _landscape.mov 且 host contains myqcloud.com（场景 1.P2 API 侧）", async () => {
      const pick = makePick({
        wallpaperVideoLandscapeUrl: LANDSCAPE_URL,
        wallpaperVideoPortraitUrl: PORTRAIT_URL,
      });
      // today 路由 DB 调用次序：pick → hero photo → members…（惯例同 daily-api 验收）
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await app().request("/api/daily/today", { method: "GET" });
      const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      // 契约：增可选字段 wallpaperVideoUrl —— 字段必须存在（不是缺省）
      expect("wallpaperVideoUrl" in body.data).toBe(true);
      const url = body.data.wallpaperVideoUrl as string;
      expect(typeof url).toBe("string");
      // 契约 example 逐字：endsWith "_landscape.mov" 且 host contains "myqcloud.com"
      expect(url.endsWith("_landscape.mov")).toBe(true);
      expect(url).toContain("myqcloud.com");
    });

    it("无值态：DB 列 null → 响应不含该字段（字段缺省，非 null 非空串）", async () => {
      const pick = makePick({ wallpaperVideoLandscapeUrl: null });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await app().request("/api/daily/today", { method: "GET" });
      const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      // 契约（场景 4.P2 语义代码化）：字段缺省 —— 用 in 判存在性，不是判空串/null
      expect("wallpaperVideoUrl" in body.data).toBe(false);
    });

    it("空对象头静态字段不受影响：wallpaperVideoUrl 有值时 composedImageUrl 语义不变", async () => {
      const pick = makePick({
        wallpaperVideoLandscapeUrl: LANDSCAPE_URL,
      });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await app().request("/api/daily/today", { method: "GET" });
      const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };

      // 既有静态链路字段零改动（设计：不触碰既有路由语义）
      expect(body.data.composedImageUrl).toBe(`/api/daily/${PICK_DATE}/wallpaper`);
      expect("wallpaperVideoUrl" in body.data).toBe(true);
    });
  });
});

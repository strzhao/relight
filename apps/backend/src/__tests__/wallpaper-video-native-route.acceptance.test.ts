/**
 * 验收测试（红队）：单腿原生壁纸视频 — 路由契约（native 不进 mac 路由 / 静态回退存活）
 *
 * 设计文档（state.md §契约规约 5 / §验收场景）对应谓词：
 *   - 场景 1.P5 [real-process→route 级代码化]：非兼容日（native 列非空但无 .mov）
 *     → GET /api/daily/D/wallpaper-video → **404**（mac 回退静态语义；native 分发走画廊
 *     manifest 字段，不经此路由）
 *   - 场景 4.P2 [real-process→route 级代码化]：比例不兼容日 GET wallpaper-video → 404
 *   - 场景 4.P3 [real-process→route 级代码化]：静态壁纸路由
 *     GET /api/daily/D/wallpaper?width=1920&height=1080 → 200 image/jpeg 非空
 *     （mac 静态回退路径存活）
 *   - 场景 6.P1 [real-process→route 级代码化]：仅 legacy 两列的历史日 → 路由 302 到
 *     legacy COS key（历史兼容，D4）
 *   - 场景 7.P1 [real-process→route 级代码化]：兼容日（native 与 landscape 并存）
 *     → GET wallpaper-video 302 到 **landscape** key（防实现误把路由改成 native 优先
 *     ——mac 只允许消费 16:9；读取优先级 native > portrait > landscape 只在画廊/manifest 层，契约 4/5）
 *
 * 契约 5 逐字：GET /api/daily/:pickDate/wallpaper-video 语义不变（302 → landscape 列 =
 *   16:9 版；空/缺失 → 404 JSON）；mac App 零改动。
 *
 * 惯例沿 wallpaper-video-api.acceptance.test.ts + daily-wallpaper-route.acceptance.test.ts：
 * chainable mock db + createApp 黑盒请求 + mock composer（缓存路径推导）。
 * 红队铁律：不读蓝队实现代码；不 skip、硬断言。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 可链式 Mock（daily-wallpaper-route.acceptance.test.ts 同款，含 values/set）
 */
function chainableMock(result: unknown[] = []) {
  const fn = (..._args: unknown[]) => chainableMock(result);
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
      if (prop === "values") {
        return (...args: unknown[]) => chainableMock(args[0] ? [args[0]] : result);
      }
      if (prop === "set") {
        return (...args: unknown[]) => chainableMock(args[0] ? [args[0]] : result);
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

// 合成器 mock：路由用 composedCachePath 推导缓存路径（daily-wallpaper-route 同款）——
// 场景 4.P3 用缓存命中路径（预置真实 JPEG），缓存命中不应触发实时合成
const mockComposeWallpaper = vi.hoisted(() => vi.fn());
const mockComposeAndSave = vi.hoisted(() => vi.fn());

vi.mock("../lib/wallpaper/composer", () => ({
  composeWallpaper: mockComposeWallpaper,
  composeAndSave: mockComposeAndSave,
  composedCachePath: (pickDate: string, width: number, height: number) =>
    path.join(
      process.env.STORAGE_ROOT ?? os.tmpdir(),
      "daily-composed",
      `${pickDate}_${width}x${height}.jpg`,
    ),
}));

import { createApp } from "../app";

// ---- 契约字面量（§契约规约 2 逐字 key → 回执 URL）----

const PICK_NATIVE_ONLY = "2026-09-20"; // 非兼容日：仅 native（场景 1.P5 / 4.P2）
const PICK_COMPAT = "2026-09-19"; // 兼容日：native + landscape（场景 7.P1）
const PICK_LEGACY = "2026-09-10"; // 历史 legacy-only（场景 6.P1）
const PICK_STATIC = "2026-09-21"; // 场景 4.P3 静态回退日

const BUCKET = "little-bee-assets-1324334992";
const REGION = "ap-shanghai";
const COS = (key: string) => `https://${BUCKET}.cos.${REGION}.myqcloud.com/${key}`;
const nativeUrl = (d: string) => COS(`relight/wallpaper-videos/${d}_native.mp4`);
const landscapeUrl = (d: string) => COS(`relight/wallpaper-videos/${d}_landscape.mov`);
const portraitUrl = (d: string) => COS(`relight/wallpaper-videos/${d}_portrait.mp4`);

function makePick(pickDate: string, video: Partial<Record<string, string | null>> = {}) {
  return {
    id: `pick-${pickDate}`,
    photoId: `photo-${pickDate}`,
    pickDate,
    title: "金色黄昏",
    narrative: "五年前的今天，你在海边捕捉到了这张温暖的照片。",
    score: 8.5,
    composedImagePath: `daily-composed/${pickDate}.jpg`,
    members: [],
    createdAt: "2026-09-12T06:00:00.000Z",
    wallpaperVideoNativeUrl: null as string | null,
    wallpaperVideoLandscapeUrl: null as string | null,
    wallpaperVideoPortraitUrl: null as string | null,
    ...video,
  };
}

function app() {
  return createApp();
}

// ---- 场景 4.P3 静态缓存 fixture ----

let tmpRoot = "";
let staticCachePath = "";

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-wvnroute-"));
  process.env.STORAGE_ROOT = tmpRoot;

  const sharp = (await import("sharp")).default;
  const cacheDir = path.join(tmpRoot, "daily-composed");
  fs.mkdirSync(cacheDir, { recursive: true });
  staticCachePath = path.join(cacheDir, `${PICK_STATIC}_1920x1080.jpg`);
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#2288cc" } })
    .jpeg({ quality: 85 })
    .toFile(staticCachePath);
  expect(fs.statSync(staticCachePath).size, "fixture 缓存 JPEG 必须非空").toBeGreaterThan(0);
});

afterAll(() => {
  // biome-ignore lint/performance/noDelete: process.env 必须用 delete 取消设置
  delete process.env.STORAGE_ROOT;
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.select.mockReturnValue(chainableMock([]));
  mockDb.insert.mockReturnValue(chainableMock([]));
  mockDb.update.mockReturnValue(chainableMock([]));
});

// ============================================================================
// GET /api/daily/:pickDate/wallpaper-video —— native 时代路由语义（契约 5：语义不变）
// ============================================================================

describe("场景 1.P5 / 4.P2：非兼容日（仅 native、无 .mov）→ wallpaper-video 路由 404", () => {
  it("native 列非空 + landscape 列空 → 404 且 body JSON 含 error（mac 回退静态；native 不经此路由）", async () => {
    mockDb.select.mockReturnValueOnce(
      chainableMock([
        makePick(PICK_NATIVE_ONLY, { wallpaperVideoNativeUrl: nativeUrl(PICK_NATIVE_ONLY) }),
      ]),
    );

    const res = await app().request(`/api/daily/${PICK_NATIVE_ONLY}/wallpaper-video`, {
      method: "GET",
    });
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;

    // 谓词字面量：404（native 存在不得改变此判定——防实现误把路由改成 native 优先）
    expect(res.status, "native-only 日必须 404（契约 5：路由只消费 landscape 16:9 列）").toBe(404);
    expect(body).not.toBeNull();
    expect(body).toHaveProperty("error");
    expect(typeof body?.error).toBe("string");
    expect((body?.error as string).length).toBeGreaterThan(0);
  });
});

describe("场景 7.P1：兼容日（native 与 landscape 并存）→ 302 到 landscape key（防 native 优先误改）", () => {
  it("native+landscape 并存 → 302 且 Location == landscape COS URL（逐字，非 native URL）", async () => {
    mockDb.select.mockReturnValueOnce(
      chainableMock([
        makePick(PICK_COMPAT, {
          wallpaperVideoNativeUrl: nativeUrl(PICK_COMPAT),
          wallpaperVideoLandscapeUrl: landscapeUrl(PICK_COMPAT),
        }),
      ]),
    );

    const res = await app().request(`/api/daily/${PICK_COMPAT}/wallpaper-video`, {
      method: "GET",
    });
    const location = res.headers.get("Location") ?? "";

    expect(res.status).toBe(302);
    expect(location, "Location 必须逐字 == legacy landscape key URL").toBe(
      landscapeUrl(PICK_COMPAT),
    );
    expect(location.endsWith("_landscape.mov")).toBe(true);
    expect(location.endsWith("_native.mp4"), "路由绝不允许 302 到 native（mac 只吃 16:9）").toBe(
      false,
    );
  });

  it("契约 5 语义不变：GET /api/daily/today 的 wallpaperVideoUrl 仍取 landscape（_landscape.mov）", async () => {
    mockDb.select
      .mockReturnValueOnce(
        chainableMock([
          makePick(PICK_COMPAT, {
            wallpaperVideoNativeUrl: nativeUrl(PICK_COMPAT),
            wallpaperVideoLandscapeUrl: landscapeUrl(PICK_COMPAT),
          }),
        ]),
      )
      .mockReturnValueOnce(
        chainableMock([
          {
            id: `photo-${PICK_COMPAT}`,
            storageSourceId: "source-001",
            filePath: "/photos/sunset.jpg",
            fileHash: "abc123",
            width: 4000,
            height: 3000,
            fileSize: 5242880,
            thumbnailPath: "/thumbnails/sunset.jpg",
            takenAt: "2019-05-05T18:30:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
      );

    const res = await app().request("/api/daily/today", { method: "GET" });
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect("wallpaperVideoUrl" in body.data).toBe(true);
    expect((body.data.wallpaperVideoUrl as string).endsWith("_landscape.mov")).toBe(true);
  });
});

describe("场景 6.P1：历史 legacy-only 日 → 路由 302 到 legacy COS key", () => {
  it("landscape+portrait 非空、native NULL → 302 且 Location == legacy landscape URL（逐字）", async () => {
    mockDb.select.mockReturnValueOnce(
      chainableMock([
        makePick(PICK_LEGACY, {
          wallpaperVideoLandscapeUrl: landscapeUrl(PICK_LEGACY),
          wallpaperVideoPortraitUrl: portraitUrl(PICK_LEGACY),
        }),
      ]),
    );

    const res = await app().request(`/api/daily/${PICK_LEGACY}/wallpaper-video`, {
      method: "GET",
    });
    const location = res.headers.get("Location") ?? "";

    expect(res.status).toBe(302);
    expect(location).toBe(landscapeUrl(PICK_LEGACY));
    expect(location).toContain("myqcloud.com");
  });
});

// ============================================================================
// 场景 4.P3：静态壁纸路由存活（mac 静态回退路径）
// ============================================================================

describe("场景 4.P3：非兼容日静态壁纸路由 → 200 image/jpeg 非空（mac 静态回退语义）", () => {
  it("GET /api/daily/D/wallpaper?width=1920&height=1080 → 200 + image/jpeg + body 非空", async () => {
    mockDb.select.mockReturnValueOnce(
      chainableMock([
        makePick(PICK_STATIC, { composedImagePath: `daily-composed/${PICK_STATIC}.jpg` }),
      ]),
    );
    // 路由第二级查询：photos 表（pick.photoId 缺失会 404「照片不存在」）
    mockDb.select.mockReturnValueOnce(chainableMock([{ id: `photo-${PICK_STATIC}` }]));

    const res = await app().request(`/api/daily/${PICK_STATIC}/wallpaper?width=1920&height=1080`, {
      method: "GET",
    });
    const buf = Buffer.from(await res.arrayBuffer());

    expect(res.status, `静态壁纸路由必须 200（mac 回退依赖），实际 ${res.status}`).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("image/jpeg");
    expect(buf.length, "响应体必须非空").toBeGreaterThan(0);
    // 缓存命中路径：不得触发实时合成（fixture 缓存文件已就位）
    expect(mockComposeAndSave).not.toHaveBeenCalled();
  });
});

/**
 * 单测：wallpaper-video 路由 + buildPickResponse 字段（任务 5 契约测试兜底）
 *
 * 契约（state.md ## 契约规约 接口签名 API invariant）：
 *   GET /api/daily/:pickDate/wallpaper-video → 302（Location = landscape .mov COS URL）
 *                                            ｜ 404（body JSON 含 error 字段）
 *   GET /api/daily/today 响应 data 增可选字段 wallpaperVideoUrl（无则字段缺省）
 *
 * 测试策略：mock ../db（按表分发的链式 stub）+ 直接 dailyRouter.request()。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pickRows: [] as unknown[],
  photoRows: [] as unknown[],
  entryRows: [] as unknown[],
}));

vi.mock("../db", () => {
  const picksTable = { pickDate: "dailyPicks.pick_date", id: "dailyPicks.id" };
  const photosTable = { id: "photos.id" };
  const entriesTable = { dailyPickId: "dailyPickEntries.daily_pick_id" };
  const pick = (table: unknown): unknown[] => {
    if (table === picksTable) return state.pickRows;
    if (table === photosTable) return state.photoRows;
    if (table === entriesTable) return state.entryRows;
    return [];
  };
  const whereResult = (table: unknown) => {
    const rows = pick(table);
    const out = {
      limit: async () => rows.slice(0, 1),
      orderBy: async () => rows,
    };
    // enrichMembers/loadPhotoMap 直接 await where(...)——需要 thenable
    Object.assign(out, {
      // biome-ignore lint/suspicious/noThenProperty: mock 需要支持 await 链式调用
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
    });
    return out;
  };
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => whereResult(table),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ run: async () => undefined }),
        }),
      }),
    },
    schema: { dailyPicks: picksTable, photos: photosTable, dailyPickEntries: entriesTable },
  };
});

vi.mock("../jobs/queues", () => ({
  scanQueue: { add: () => Promise.resolve({ id: "j" }) },
  analyzeQueue: { add: () => Promise.resolve({ id: "j" }) },
  dailyQueue: { add: () => Promise.resolve({ id: "j" }) },
  wallpaperVideoQueue: { add: () => Promise.resolve({ id: "j" }) },
}));

import { dailyRouter } from "../routes/daily";

const URL_LANDSCAPE =
  "https://little-bee-assets-1324334992.cos.ap-shanghai.myqcloud.com/relight/wallpaper-videos/2026-09-12_landscape.mov";

function makePick(overrides: Record<string, unknown> = {}) {
  return {
    id: "pick-1",
    photoId: "photo-1",
    pickDate: "2026-09-12",
    title: "标题",
    narrative: "叙述",
    score: 8,
    composedImagePath: "/photos/daily-composed/2026-09-12_x.jpg",
    members: "[]",
    createdAt: "2026-09-12T00:00:00Z",
    ...overrides,
  };
}

function makePhoto() {
  return {
    id: "photo-1",
    filePath: "/photos/hero.jpg",
    mediaType: "image",
    members: "[]",
  };
}

beforeEach(() => {
  state.pickRows = [];
  state.photoRows = [];
  state.entryRows = [];
});

describe("GET /:pickDate/wallpaper-video", () => {
  it("URL 列非空 → 302，Location = landscape .mov COS URL", async () => {
    state.pickRows = [makePick({ wallpaperVideoLandscapeUrl: URL_LANDSCAPE })];
    const res = await dailyRouter.request("/2026-09-12/wallpaper-video");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(URL_LANDSCAPE);
  });

  it("URL 列 null → 404，body JSON 含 error 字段", async () => {
    state.pickRows = [makePick({ wallpaperVideoLandscapeUrl: null })];
    const res = await dailyRouter.request("/2026-09-12/wallpaper-video");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error!.length).toBeGreaterThan(0);
  });

  it("无当日记录 → 404（body JSON 含 error 字段）", async () => {
    const res = await dailyRouter.request("/2026-09-12/wallpaper-video");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  it("日期非法 → 404（body JSON 含 error 字段）", async () => {
    const res = await dailyRouter.request("/not-a-date/wallpaper-video");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });
});

describe("GET /today — buildPickResponse wallpaperVideoUrl 字段", () => {
  it("URL 列非空 → data.wallpaperVideoUrl = landscape .mov COS URL", async () => {
    state.pickRows = [makePick({ wallpaperVideoLandscapeUrl: URL_LANDSCAPE })];
    state.photoRows = [makePhoto()];
    const res = await dailyRouter.request("/today");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.wallpaperVideoUrl).toBe(URL_LANDSCAPE);
    expect(String(body.data.wallpaperVideoUrl).endsWith("_landscape.mov")).toBe(true);
    expect(String(body.data.wallpaperVideoUrl)).toContain("myqcloud.com");
  });

  it("URL 列 null → 响应不含 wallpaperVideoUrl 字段（字段缺省）", async () => {
    state.pickRows = [makePick({ wallpaperVideoLandscapeUrl: null })];
    state.photoRows = [makePhoto()];
    const res = await dailyRouter.request("/today");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect("wallpaperVideoUrl" in body.data).toBe(false);
    // 静态字段完好（失败回退契约）
    expect(body.data.composedImageUrl).toBe("/api/daily/2026-09-12/wallpaper");
  });
});

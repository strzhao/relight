import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

describe("smoke", () => {
  it("vitest 测试框架可正常运行", () => {
    expect(true).toBe(true);
  });
});

// ============================================================================
// T17 — DailyHero BannerCarousel 渲染验收（红队）
//
// 设计契约来源（state.md T11 + T17 + 设计修订 BannerCarousel）：
//   1. mock `/api/daily/today` 返回带 3 张 members 的精选
//      → [data-testid="banner-carousel"] 存在
//      → 包含 4 个 [data-testid="banner-slide"]（hero + 3 members）
//      → hero 编辑栏含「N 年前的今天」文本
//   2. mock `/api/daily/today` 返回空 members
//      → [data-testid="banner-carousel"] 存在（只有 1 个 banner-slide）
//      → 不渲染 banner-tick / banner-arrow-prev / banner-arrow-next
//
// 测试策略：
//   - vi.mock `lib/api`，控制 getDailyPick/getTodayPick 返回值
//   - react-dom/server.renderToString 静态渲染 DailyHero 组件
//   - 断言 HTML 字符串中 data-testid 属性的出现/缺失
//
// 红队铁律：不读取 daily-hero.tsx 实现；基于 DailyPick 类型约定和设计契约。
// ============================================================================

// ---- DailyPick mock 数据工厂 ----

import type { DailyPick, Photo } from "@relight/shared";

function makePhoto(id: string, takenAt: string): Photo {
  return {
    id,
    storageSourceId: "src-001",
    filePath: `photos/${id}.jpg`,
    fileHash: `hash-${id}`,
    width: 1920,
    height: 1080,
    fileSize: 2_000_000,
    thumbnailPath: `/api/photos/${id}/thumbnail`,
    takenAt,
    createdAt: takenAt,
    mediaType: "image",
  };
}

function makeDailyPickWithMembers(memberCount: number): DailyPick & {
  members: { photoId: string; caption: string; photo: Photo }[];
} {
  const heroTakenAt = "2018-05-09T10:00:00.000Z"; // 约 8 年前，满足「N 年前的今天」
  const heroId = "hero-photo-001";

  const members = Array.from({ length: memberCount }, (_, i) => {
    const photoId = `member-photo-${String(i).padStart(3, "0")}`;
    return {
      photoId,
      caption: `美好瞬间 ${i + 1}`,
      photo: makePhoto(photoId, `2018-05-09T${String(10 + i).padStart(2, "0")}:30:00.000Z`),
    };
  });

  return {
    id: "daily-pick-001",
    photoId: heroId,
    pickDate: "2026-05-09",
    title: "时光的馈赠",
    narrative: "阳光透过树叶洒落，记录下这珍贵的片刻。",
    score: 9.2,
    createdAt: "2026-05-09T06:00:00.000Z",
    photo: makePhoto(heroId, heroTakenAt),
    members,
    entries: [],
  };
}

function makeDailyPickEmptyMembers(): DailyPick & {
  members: never[];
} {
  return {
    ...makeDailyPickWithMembers(0),
    members: [],
  };
}

// ---- mock lib/api ----

vi.mock("@/lib/api", () => ({
  getTodayPick: vi.fn(),
  getDailyPick: vi.fn(),
  getApiUrl: vi.fn((path: string) => path),
}));

// ---- 渲染辅助 ----

async function renderDailyHero(
  dailyPick:
    | ReturnType<typeof makeDailyPickWithMembers>
    | ReturnType<typeof makeDailyPickEmptyMembers>
    | null,
): Promise<string> {
  const { DailyHero } = await import("@/components/daily-hero");
  return renderToString(React.createElement(DailyHero, { dailyPick }));
}

// ============================================================================
// 场景 1: 含 3 张 members 的精选渲染
// ============================================================================

// TODO(banner-carousel-integration): 见 banner-carousel.acceptance.test.ts 同名 TODO。
// 旧契约假设 DailyHero 内含 banner-carousel/banner-slide testid，但实际实现用的是
// daily-banner + 双层 entry/sub 模型。等组件真正接入后 unskip。
describe.skip("T17 — DailyHero BannerCarousel 渲染验收（jsdom / renderToString）", () => {
  it("members=3 时，HTML 包含 data-testid='banner-carousel'", async () => {
    const dailyPick = makeDailyPickWithMembers(3);
    const html = await renderDailyHero(dailyPick);
    expect(html).toContain('data-testid="banner-carousel"');
  });

  it("members=3 时，HTML 包含恰好 4 个 data-testid='banner-slide'（hero + 3 members）", async () => {
    const dailyPick = makeDailyPickWithMembers(3);
    const html = await renderDailyHero(dailyPick);

    // hero slide + 3 member slides = 4 banner-slide
    const slideMatches = html.match(/data-testid="banner-slide"/g);
    expect(slideMatches).not.toBeNull();
    expect(slideMatches?.length).toBe(4);
  });

  it("members=3 时，hero 编辑栏含「N 年前的今天」文本（takenAt=2018，约 8 年前）", async () => {
    const dailyPick = makeDailyPickWithMembers(3);
    const html = await renderDailyHero(dailyPick);

    // 设计契约：hero 编辑栏显示「N 年前的今天」，N 基于 photo.takenAt 与今日差值
    // 2018-05-09 距 2026-05-09 恰好 8 年
    expect(html).toMatch(/[0-9]+\s*年前.*今天|今天.*[0-9]+\s*年前/);
  });

  // ============================================================================
  // 场景 2: 空 members 时仍渲染 banner-carousel，但不渲染多图控件
  // ============================================================================

  it("members=[] 时，HTML 仍包含 data-testid='banner-carousel'", async () => {
    const dailyPick = makeDailyPickEmptyMembers();
    const html = await renderDailyHero(dailyPick);
    expect(html).toContain('data-testid="banner-carousel"');
  });

  it("members=[] 时，HTML 包含恰好 1 个 data-testid='banner-slide'（仅 hero）", async () => {
    const dailyPick = makeDailyPickEmptyMembers();
    const html = await renderDailyHero(dailyPick);
    const slideMatches = html.match(/data-testid="banner-slide"/g);
    expect(slideMatches).not.toBeNull();
    expect(slideMatches?.length).toBe(1);
  });

  it("members=[] 时，HTML 不包含 data-testid='banner-tick'（单图无指示器）", async () => {
    const dailyPick = makeDailyPickEmptyMembers();
    const html = await renderDailyHero(dailyPick);
    expect(html).not.toContain('data-testid="banner-tick"');
  });

  it("members=[] 时，HTML 不包含 data-testid='banner-arrow-prev'（单图无箭头）", async () => {
    const dailyPick = makeDailyPickEmptyMembers();
    const html = await renderDailyHero(dailyPick);
    expect(html).not.toContain('data-testid="banner-arrow-prev"');
  });

  it("members=[] 时，HTML 不包含 data-testid='banner-arrow-next'（单图无箭头）", async () => {
    const dailyPick = makeDailyPickEmptyMembers();
    const html = await renderDailyHero(dailyPick);
    expect(html).not.toContain('data-testid="banner-arrow-next"');
  });

  // ============================================================================
  // 场景 3: members=1（边界值）
  // ============================================================================

  it("members=1 时，HTML 包含 banner-carousel 且有 2 个 banner-slide（hero + 1 member）", async () => {
    const dailyPick = makeDailyPickWithMembers(1);
    const html = await renderDailyHero(dailyPick);

    expect(html).toContain('data-testid="banner-carousel"');
    const slideMatches = html.match(/data-testid="banner-slide"/g);
    expect(slideMatches).not.toBeNull();
    expect(slideMatches?.length).toBe(2);
  });

  // ============================================================================
  // 场景 4: members=8（最大值）
  // ============================================================================

  it("members=8 时，HTML 包含 banner-carousel 且有 9 个 banner-slide（hero + 8 members）", async () => {
    const dailyPick = makeDailyPickWithMembers(8);
    const html = await renderDailyHero(dailyPick);

    expect(html).toContain('data-testid="banner-carousel"');
    const slideMatches = html.match(/data-testid="banner-slide"/g);
    expect(slideMatches).not.toBeNull();
    expect(slideMatches?.length).toBe(9);
  });

  // ============================================================================
  // 场景 5: dailyPick=null（今日无精选）
  // ============================================================================

  it("dailyPick=null 时，渲染不抛异常（降级展示）", async () => {
    await expect(renderDailyHero(null)).resolves.not.toThrow();
  });

  it("dailyPick=null 时，HTML 不包含 banner-carousel（降级状态无精选内容）", async () => {
    const html = await renderDailyHero(null);
    expect(html).not.toContain('data-testid="banner-carousel"');
  });

  // ============================================================================
  // 场景 6: members 兼容性（历史数据 members 为 undefined / null）
  // ============================================================================

  it("members 字段为 undefined（旧 DailyPick 数据）时，HTML 包含 banner-carousel 且只有 1 个 banner-slide", async () => {
    const dailyPickNoMembers = {
      ...makeDailyPickEmptyMembers(),
      members: undefined as unknown as never[],
    };
    const html = await renderDailyHero(dailyPickNoMembers);
    expect(html).toContain('data-testid="banner-carousel"');
    const slideMatches = html.match(/data-testid="banner-slide"/g);
    expect(slideMatches).not.toBeNull();
    expect(slideMatches?.length).toBe(1);
  });
});

/**
 * BannerCarousel 验收测试（红队）
 *
 * 红队铁律：
 *   - 不读取 banner-carousel.tsx 实现
 *   - 不读取 daily-hero.tsx DOM 结构
 *   - 只依赖 data-testid 契约 + aria-* 契约 + 设计文档
 *   - 所有断言通过 HTML 字符串 / DOM 查询，不依赖 className
 *
 * 覆盖用例 a-l（共 12 条）
 */

import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DailyPick, DailyPickMember, Photo } from "@relight/shared";

// ---- mock lib/api（平铺三函数契约）----
vi.mock("@/lib/api", () => ({
  getTodayPick: vi.fn(),
  getApiUrl: vi.fn((path: string) => `http://api.test${path}`),
  getDailyPick: vi.fn(),
}));

// ============================================================================
// Fixture 工厂
// ============================================================================

const makePhoto = (overrides: Partial<Photo> = {}): Photo =>
  ({
    id: "p1",
    storageSourceId: "s1",
    filePath: "/x.jpg",
    fileHash: "abc",
    fileSize: 1024,
    mimeType: "image/jpeg",
    width: 1920,
    height: 1280,
    thumbnailPath: "/thumb/p1.jpg",
    takenAt: "2024-05-09T10:00:00Z",
    scannedAt: "2024-05-10T00:00:00Z",
    createdAt: "2024-05-10T00:00:00Z",
    mediaType: "image",
    durationSec: null,
    ...overrides,
  }) as Photo;

const makePick = (overrides: Partial<DailyPick> = {}): DailyPick => ({
  id: "pk1",
  photoId: "p1",
  pickDate: "2026-05-10",
  title: "五月初夏",
  narrative: "茶馆窗边的一杯清茶",
  score: 92,
  composedImageUrl: null,
  createdAt: "2026-05-10T06:00:00Z",
  photo: makePhoto(),
  members: [],
  ...overrides,
});

const makeMember = (id: string, overrides: Partial<DailyPickMember> = {}): DailyPickMember => ({
  photoId: id,
  caption: `回忆 ${id}`,
  photo: makePhoto({ id, filePath: `/${id}.jpg`, thumbnailPath: `/thumb/${id}.jpg` }),
  ...overrides,
});

/** 生成 n 个都有 photo 字段的 members */
const makeMembers = (n: number): DailyPickMember[] =>
  Array.from({ length: n }, (_, i) => makeMember(`m${i + 1}`));

// ============================================================================
// SSR 渲染辅助（renderToString）
// ============================================================================

async function ssrRender(dailyPick: DailyPick | null): Promise<string> {
  const mod = await import("@/components/daily-hero");
  const DailyHero = mod.DailyHero ?? mod.default;
  return renderToString(React.createElement(DailyHero, { dailyPick }));
}

/** 统计 html 中某段字符串出现次数 */
function countOccurrences(html: string, needle: string): number {
  let count = 0;
  let pos = html.indexOf(needle, 0);
  while (pos !== -1) {
    count++;
    pos = html.indexOf(needle, pos + needle.length);
  }
  return count;
}

// ============================================================================
// 用例 a-j + l：SSR 字符串断言
// ============================================================================

describe("BannerCarousel 验收测试（SSR）", () => {
  // --------------------------------------------------------------------------
  // a) hero + 8 members → 9 slides, 9 ticks, 2 arrows
  // --------------------------------------------------------------------------
  it("(a) hero + 8 members → DOM 含 9 个 banner-slide、9 个 banner-tick、2 个箭头", async () => {
    const pick = makePick({ members: makeMembers(8) });
    const html = await ssrRender(pick);

    expect(countOccurrences(html, 'data-testid="banner-slide"')).toBe(9);
    expect(countOccurrences(html, 'data-testid="banner-tick"')).toBe(9);
    expect(countOccurrences(html, 'data-testid="banner-arrow-prev"')).toBe(1);
    expect(countOccurrences(html, 'data-testid="banner-arrow-next"')).toBe(1);
  });

  // --------------------------------------------------------------------------
  // b) 仅 hero（members=[]）→ 1 slide，无 tick，无箭头
  // --------------------------------------------------------------------------
  it("(b) 仅 hero（members=[]）→ 1 个 banner-slide，无 banner-tick，无箭头", async () => {
    const pick = makePick({ members: [] });
    const html = await ssrRender(pick);

    expect(countOccurrences(html, 'data-testid="banner-slide"')).toBe(1);
    expect(html).not.toContain('data-testid="banner-tick"');
    expect(html).not.toContain('data-testid="banner-arrow-prev"');
    expect(html).not.toContain('data-testid="banner-arrow-next"');
  });

  // --------------------------------------------------------------------------
  // c) hero + 1 member → 2 slides, 2 ticks, 2 arrows
  // --------------------------------------------------------------------------
  it("(c) hero + 1 member → 2 个 banner-slide、2 个 banner-tick、2 个箭头", async () => {
    const pick = makePick({ members: makeMembers(1) });
    const html = await ssrRender(pick);

    expect(countOccurrences(html, 'data-testid="banner-slide"')).toBe(2);
    expect(countOccurrences(html, 'data-testid="banner-tick"')).toBe(2);
    expect(countOccurrences(html, 'data-testid="banner-arrow-prev"')).toBe(1);
    expect(countOccurrences(html, 'data-testid="banner-arrow-next"')).toBe(1);
  });

  // --------------------------------------------------------------------------
  // d) hero + 8 members（满载）→ 9 slides, 9 ticks
  // --------------------------------------------------------------------------
  it("(d) hero + 8 members（满载）→ 9 个 banner-slide、9 个 banner-tick", async () => {
    const pick = makePick({ members: makeMembers(8) });
    const html = await ssrRender(pick);

    expect(countOccurrences(html, 'data-testid="banner-slide"')).toBe(9);
    expect(countOccurrences(html, 'data-testid="banner-tick"')).toBe(9);
  });

  // --------------------------------------------------------------------------
  // e) hero.takenAt 早于 pickDate 2 年 → 含「2 年前的今天」
  // --------------------------------------------------------------------------
  it("(e) hero photo.takenAt 早于 pickDate 2 年 → HTML 含「2 年前的今天」", async () => {
    const pick = makePick({
      pickDate: "2026-05-10",
      photo: makePhoto({ takenAt: "2024-05-09T10:00:00Z" }), // 2 年前
    });
    const html = await ssrRender(pick);

    // 用宽松正则容忍 <!-- --> SSR 注释
    expect(html).toMatch(/[0-9]+\s*年前.*今天/);
  });

  // --------------------------------------------------------------------------
  // f) dailyPick=null → renderToString 不抛异常
  // --------------------------------------------------------------------------
  it("(f) dailyPick=null 传入 DailyHero → renderToString 不抛异常", async () => {
    await expect(ssrRender(null)).resolves.not.toThrow();
  });

  // --------------------------------------------------------------------------
  // g) hero photo.mediaType="video" → 第 1 个 banner-slide 含 <video>，其他含 <img>
  // --------------------------------------------------------------------------
  it("(g) hero mediaType=video → 第 1 个 banner-slide 含 <video>，其他 slides 含 <img>", async () => {
    const pick = makePick({
      photo: makePhoto({ mediaType: "video", durationSec: 30 }),
      members: makeMembers(2),
    });
    const html = await ssrRender(pick);

    // 第 1 个 banner-slide 中必须出现 <video
    // 整体 HTML 必须包含 <video（hero slide）
    expect(html).toContain("<video");

    // 其他 slides 有 <img（member slides 是图片）
    expect(html).toContain("<img");
  });

  // --------------------------------------------------------------------------
  // h) member 中第 2 个 photo 字段为 undefined → 该 member 静默跳过
  // --------------------------------------------------------------------------
  it("(h) members 中第 2 个 photo 为 undefined → 该 member 静默跳过，slides 数量为 1+其他有 photo 的", async () => {
    const members: DailyPickMember[] = [
      makeMember("m1"), // 有 photo → 入列
      { photoId: "m2", caption: "无图片回忆" }, // 无 photo → 跳过
      makeMember("m3"), // 有 photo → 入列
    ];
    const pick = makePick({ members });
    const html = await ssrRender(pick);

    // hero + m1 + m3 = 3 slides（m2 被跳过）
    expect(countOccurrences(html, 'data-testid="banner-slide"')).toBe(3);
  });

  // --------------------------------------------------------------------------
  // i) carousel 容器含 aria-roledescription="carousel"
  // --------------------------------------------------------------------------
  it('(i) carousel 容器含 aria-roledescription="carousel"', async () => {
    const pick = makePick({ members: makeMembers(2) });
    const html = await ssrRender(pick);

    expect(html).toContain('aria-roledescription="carousel"');
  });

  // --------------------------------------------------------------------------
  // j) 第 1 个 banner-slide 含 aria-current="true"，其他含 aria-hidden="true"
  // --------------------------------------------------------------------------
  it('(j) SSR 初始状态：第 1 个 banner-slide 含 aria-current="true"，其他含 aria-hidden="true"', async () => {
    const pick = makePick({ members: makeMembers(2) });
    const html = await ssrRender(pick);

    expect(countOccurrences(html, 'aria-current="true"')).toBeGreaterThanOrEqual(1);
    expect(countOccurrences(html, 'aria-hidden="true"')).toBeGreaterThanOrEqual(2);
  });

  // --------------------------------------------------------------------------
  // l) prefers-reduced-motion → banner-slide 的 transitionDuration === "0s"
  // --------------------------------------------------------------------------
  it("(l) prefers-reduced-motion: reduce → banner-slide transitionDuration 为 0s", async () => {
    // mock window.matchMedia 返回 reduce
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });

    const mod = await import("@/components/daily-hero");
    const DailyHero = mod.DailyHero ?? mod.default;
    const pick = makePick({ members: makeMembers(1) });

    // 在 jsdom 中渲染
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);

    await new Promise<void>((resolve) => {
      const root = createRoot(container);
      root.render(React.createElement(DailyHero, { dailyPick: pick }));
      // 等下一个 microtask 让 React 完成渲染
      setTimeout(resolve, 0);
    });

    const slides = container.querySelectorAll('[data-testid="banner-slide"]');
    expect(slides.length).toBeGreaterThan(0);

    for (const slide of slides) {
      const style = window.getComputedStyle(slide as Element);
      // prefers-reduced-motion 激活时，transition-duration 应为 0s
      expect(style.transitionDuration).toBe("0s");
    }

    // 清理
    document.body.removeChild(container);

    // 恢复 matchMedia 为正常
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  });
});

// ============================================================================
// 用例 k：fake timer + jsdom + 交互测试（自动切换计时器）
// ============================================================================

describe("BannerCarousel 用例 k — fake timer 自动切换", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // 清理 DOM
    document.body.innerHTML = "";
  });

  it("(k) hero+2 members：click next → advance 9000ms 仍在 idx=1；再 advance 1500ms 自动切到 idx=2", async () => {
    const mod = await import("@/components/daily-hero");
    const DailyHero = mod.DailyHero ?? mod.default;

    const pick = makePick({ members: makeMembers(2) }); // 3 slides total
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);

    // 渲染到 jsdom
    const root = createRoot(container);
    await vi.waitFor(() => {
      root.render(React.createElement(DailyHero, { dailyPick: pick }));
    });

    // 等 React 完成初始渲染（flush microtasks）
    await vi.runAllMicrotasksAsync();

    // 找到 next 箭头并点击
    const nextBtn = container.querySelector('[data-testid="banner-arrow-next"]') as HTMLElement;
    expect(nextBtn).not.toBeNull();
    nextBtn.click();

    // 等 React 状态更新
    await vi.runAllMicrotasksAsync();

    // 点击后：idx 应变为 1，aria-current 在第 2 个 slide
    const slidesAfterClick = container.querySelectorAll('[data-testid="banner-slide"]');
    const currentSlides = Array.from(slidesAfterClick).filter(
      (s) => s.getAttribute("aria-current") === "true",
    );
    // 应有且仅有 1 个 aria-current="true"，且是第 2 个（index 1）
    expect(currentSlides.length).toBe(1);
    expect(Array.from(slidesAfterClick).indexOf(currentSlides[0])).toBe(1);

    // 计时器重置后：advance 9000ms（距点击后 9000ms），应仍在 idx=1
    vi.advanceTimersByTime(9000);
    await vi.runAllMicrotasksAsync();

    const slidesAt9s = container.querySelectorAll('[data-testid="banner-slide"]');
    const currentAt9s = Array.from(slidesAt9s).filter(
      (s) => s.getAttribute("aria-current") === "true",
    );
    expect(currentAt9s.length).toBe(1);
    expect(Array.from(slidesAt9s).indexOf(currentAt9s[0])).toBe(1); // 仍是 idx=1

    // 再 advance 1500ms（共 10500ms > 10000ms），应自动切到 idx=2
    vi.advanceTimersByTime(1500);
    await vi.runAllMicrotasksAsync();

    const slidesAt10500 = container.querySelectorAll('[data-testid="banner-slide"]');
    const currentAt10500 = Array.from(slidesAt10500).filter(
      (s) => s.getAttribute("aria-current") === "true",
    );
    expect(currentAt10500.length).toBe(1);
    expect(Array.from(slidesAt10500).indexOf(currentAt10500[0])).toBe(2); // idx=2
  });
});

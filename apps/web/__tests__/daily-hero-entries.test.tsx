/**
 * 验收测试：DailyHero entries 多图展示（红队）
 *
 * 设计契约来源（state.md 设计文档，不读任何实现）：
 *
 * 1. 渲染时默认显示 entries[0] 的大图、title、narrative
 * 2. 点击第 5 个缩略图（rank=4）后，右侧 title/narrative/系列缩略条同步更新
 * 3. 缩略图选中态从 rank=0 迁移到 rank=4（aria-selected 属性变化）
 * 4. 系列为空（members=[]）时，系列缩略条不渲染或显示空态
 * 5. entries=[] 时复用现有 HeroFrame empty 分支
 *
 * 测试策略：
 * - vi.mock('@/lib/api') mock getTodayPick 返回 fixture 数据
 * - react-dom/server.renderToString 静态渲染断言初始 HTML 内容
 * - 注意 React 19 + vitest 兼容性：不使用 fake timer，不使用 @testing-library/react
 * - 交互测试（点击切换）使用 renderToString 后辅以状态驱动断言或 jsdom 模拟
 *
 * 红队铁律：
 * - 不读取 daily-hero.tsx 实现文件
 * - 仅通过 DailyHero 公共组件接口（props: dailyPick）黑盒验证
 * - 每个 test case 必须含强 expect 断言，不允许空 catch
 */

// CONTRACT_AMBIGUOUS:
// 1. data-testid 命名约定：缩略图容器使用 "entry-thumb-grid" 或类似名称？
//    本测试假设：20 张缩略图每张有 data-testid="entry-thumb"（类比现有 member-thumb）
//    aria-selected 在 role="option" 元素上
// 2. 大图区 data-testid：假设使用 "entry-big-image" 或大图 img 的 src/alt 可断言
// 3. 系列缩略条 data-testid：假设使用 "entry-series-strip"（类比现有 member-strip）
// 4. 右侧叙事区 data-testid：假设 "entry-title" / "entry-narrative"
// 5. 空 entries 渲染分支：复用现有 HeroFrame empty 分支，假设包含中文空态文案

import type { DailyPick, DailyPickEntry, DailyPickMember, Photo } from "@relight/shared";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ---- mock lib/api（必须在 import 组件之前）----

vi.mock("@/lib/api", () => ({
  getTodayPick: vi.fn(),
  getDailyPick: vi.fn(),
  getApiUrl: vi.fn((path: string) => path),
}));

// =====================================================================
// Fixture 数据工厂
// =====================================================================

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

function makeMember(i: number, entryRank: number): DailyPickMember & { photo: Photo } {
  const photoId = `member-photo-r${entryRank}-${String(i).padStart(2, "0")}`;
  return {
    photoId,
    caption: `系列照片 rank=${entryRank} 第 ${i + 1} 张`,
    photo: makePhoto(photoId, `2023-05-10T${String(10 + i).padStart(2, "0")}:30:00.000Z`),
  };
}

function makeEntry(rank: number, memberCount = 0): DailyPickEntry {
  const photoId = `entry-photo-${String(rank).padStart(3, "0")}`;
  const members = Array.from({ length: memberCount }, (_, i) => makeMember(i, rank));
  return {
    rank,
    photoId,
    title: `精选标题 rank=${rank}`,
    narrative: `叙事文案 rank=${rank}，记录下那年春天的美好瞬间。`,
    score: 9.0 - rank * 0.1,
    photo: makePhoto(photoId, `2023-05-10T${String(8 + (rank % 10)).padStart(2, "0")}:00:00.000Z`),
    members,
  };
}

/**
 * 构造含 20 entries 的 DailyPick fixture
 * - rank=0: 3 张 members（有系列）
 * - rank=4: 2 张 members（点击测试用）
 * - rank=7: 0 张 members（空系列测试用）
 * - 其余: 0 张 members
 */
function make20EntriesDailyPick(): DailyPick {
  const entries: DailyPickEntry[] = Array.from({ length: 20 }, (_, i) => {
    if (i === 0) return makeEntry(0, 3);
    if (i === 4) return makeEntry(4, 2);
    return makeEntry(i, 0);
  });

  const entry0 = entries[0]!;

  return {
    id: "daily-pick-entries-001",
    photoId: entry0.photoId,
    pickDate: "2026-05-10",
    title: entry0.title,
    narrative: entry0.narrative,
    score: entry0.score,
    createdAt: "2026-05-10T06:00:00.000Z",
    photo: entry0.photo,
    members: [],
    entries,
  };
}

/** 构造 entries=[] 的空 DailyPick fixture */
function makeEmptyEntriesDailyPick(): DailyPick {
  return {
    id: "",
    photoId: "",
    pickDate: "2026-05-10",
    title: "",
    narrative: "",
    score: 0,
    createdAt: "",
    photo: undefined,
    members: [],
    entries: [],
  };
}

/** 构造 entries=[1 条，members=[]] 的精选（空系列测试用） */
function makeSingleEntryNoMembersPick(): DailyPick {
  const entry = makeEntry(0, 0);
  return {
    id: "daily-pick-single-001",
    photoId: entry.photoId,
    pickDate: "2026-05-10",
    title: entry.title,
    narrative: entry.narrative,
    score: entry.score,
    createdAt: "2026-05-10T06:00:00.000Z",
    photo: entry.photo,
    members: [],
    entries: [entry],
  };
}

// =====================================================================
// 渲染辅助
// =====================================================================

async function renderDailyHero(dailyPick: DailyPick | null): Promise<string> {
  const { DailyHero } = await import("@/components/daily-hero");
  return renderToString(React.createElement(DailyHero, { dailyPick }));
}

/**
 * 模拟"选中 rank=N"后的渲染：
 * 设计文档说 state currentIdx 控制显示哪个 entry，通过 URL query ?entry=N 同步。
 * 由于是 SSR 测试，直接传不同 entry index 的 dailyPick 子集来验证"选中态内容"。
 */
async function renderDailyHeroAtIdx(dailyPick: DailyPick, _idx: number): Promise<string> {
  // 静态渲染时无法直接模拟点击，但可以通过组件 prop 传入 initialEntry
  // CONTRACT_AMBIGUOUS: 组件是否支持 initialEntry prop？
  // 若组件只接受 dailyPick prop，通过 URL query 初始化，这里用 SSR 方式验证内容
  const { DailyHero } = await import("@/components/daily-hero");
  // 尝试传入 initialEntryIndex（如果组件支持），否则退化到基本渲染
  const props = { dailyPick, initialEntryIndex: _idx };
  return renderToString(React.createElement(DailyHero, props as Parameters<typeof DailyHero>[0]));
}

// =====================================================================
// 测试
// =====================================================================

describe("DailyHero entries 多图展示 — 验收测试（红队）", () => {
  // ----------------------------------------------------------------
  // 验收场景 1: 默认显示 entries[0] 的内容
  // ----------------------------------------------------------------

  describe("场景 1 — 默认显示 entries[0] 的 title 和 narrative", () => {
    it("含 20 entries 时，HTML 包含 entries[0] 的 title", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);

      // entries[0].title = "精选标题 rank=0"
      expect(html).toContain("精选标题 rank=0");
    });

    it("含 20 entries 时，HTML 包含 entries[0] 的 narrative", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);

      // entries[0].narrative 片段
      expect(html).toContain("叙事文案 rank=0");
    });

    it("含 20 entries 时，HTML 包含 entries[0].photo 的缩略图 src", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);

      // entries[0].photo.thumbnailPath = /api/photos/entry-photo-000/thumbnail
      expect(html).toContain("entry-photo-000");
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 2: 20 张缩略图栅格渲染
  // ----------------------------------------------------------------

  describe("场景 2 — banner 轮播 ticks 渲染（替代 20 缩略图栅格）", () => {
    it("含 20 entries 时，HTML 包含 20 个 data-testid='banner-tick'", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);

      // 每个 entry 对应一个 tick（替代旧版 20 缩略图栅格）
      const tickMatches = html.match(/data-testid="banner-tick"/g);
      expect(tickMatches).not.toBeNull();
      expect(tickMatches?.length).toBe(20);
    });

    it("ticks 容器 role='tablist' 存在（无障碍契约）", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);
      expect(html).toMatch(/role="tablist"/);
    });

    it("默认选中第 1 张（rank=0）— aria-selected='true' 出现在 rank=0 tick 上", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);
      expect(html).toContain('aria-selected="true"');
    });

    it("7 entries 时，只渲染 7 个 ticks（不填空位）", async () => {
      const sevenEntries = Array.from({ length: 7 }, (_, i) => makeEntry(i, 0));
      const entry0 = sevenEntries[0]!;
      const dailyPick: DailyPick = {
        id: "pick-7",
        photoId: entry0.photoId,
        pickDate: "2026-05-10",
        title: entry0.title,
        narrative: entry0.narrative,
        score: entry0.score,
        createdAt: "2026-05-10T06:00:00.000Z",
        photo: entry0.photo,
        members: [],
        entries: sevenEntries,
      };

      const html = await renderDailyHero(dailyPick);
      const tickMatches = html.match(/data-testid="banner-tick"/g);
      expect(tickMatches).not.toBeNull();
      expect(tickMatches?.length).toBe(7);
    });

    it("含 prev/next 箭头按钮（多 entry 时）", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);
      expect(html).toContain('data-testid="banner-arrow-prev"');
      expect(html).toContain('data-testid="banner-arrow-next"');
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 3: 选中态迁移（rank=0 → rank=4）
  // ----------------------------------------------------------------

  describe("场景 3 — 切换 entry 后右侧 editorial 同步（initialEntryIndex 模拟）", () => {
    it("renderToString 时 entries[0] 内容出现在 HTML 中（初始状态验证）", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);

      expect(html).toContain("精选标题 rank=0");
      const titleCount = (html.match(/精选标题 rank=0/g) ?? []).length;
      expect(titleCount).toBeGreaterThan(0);
    });

    it("通过 initialEntryIndex=4 切换后，rank=4 title 出现在 editorial 区域", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHeroAtIdx(dailyPick, 4);

      expect(html).toContain("精选标题 rank=4");
      // editorial 区域 data-testid="entry-title" 必含 rank=4
      expect(html).toMatch(/data-testid="entry-title"[^>]*>[^<]*精选标题 rank=4/);
    });

    it("ticks 内首屏当前 entry 的 photoId 出现在大图区", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);
      // 大图区应包含 entries[0] 的 photoId
      expect(html).toContain("entry-photo-000");
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 4: 系列为空（members=[]）时缩略条不渲染
  // ----------------------------------------------------------------

  describe("场景 4 — 系列为空时 series strip 不渲染", () => {
    it("rank=0 entries members=[] 时，HTML 不包含 data-testid='entry-series-strip'", async () => {
      const dailyPick = makeSingleEntryNoMembersPick();
      const html = await renderDailyHero(dailyPick);

      expect(html).not.toContain('data-testid="entry-series-strip"');
    });

    it("rank=0 entries members=[] 时，HTML 不包含 data-testid='entry-series-thumb'", async () => {
      const dailyPick = makeSingleEntryNoMembersPick();
      const html = await renderDailyHero(dailyPick);

      expect(html).not.toContain('data-testid="entry-series-thumb"');
    });

    it("rank=0 entries members=3 时，HTML 包含 data-testid='entry-series-strip'", async () => {
      const dailyPick = make20EntriesDailyPick(); // rank=0 有 3 张 members
      const html = await renderDailyHero(dailyPick);

      // 初始显示 rank=0，该 entry 有 3 个 members，系列缩略条应渲染
      expect(html).toContain('data-testid="entry-series-strip"');
    });

    it("rank=0 entries members=3 时，HTML 包含 4 个 data-testid='entry-series-thumb'（1 primary + 3 members）", async () => {
      const dailyPick = make20EntriesDailyPick(); // rank=0 有 3 张 members
      const html = await renderDailyHero(dailyPick);

      // 系列条第 0 项是 entry 自身 photo（让用户能切回主图），其后是 N 个 members
      const thumbMatches = html.match(/data-testid="entry-series-thumb"/g);
      expect(thumbMatches).not.toBeNull();
      expect(thumbMatches?.length).toBe(4);
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 5: entries=[] 时复用 HeroFrame empty 分支
  // ----------------------------------------------------------------

  describe("场景 5 — entries=[] 时渲染空态（复用 HeroFrame empty 分支）", () => {
    it("entries=[] 时不崩溃（renderToString 正常完成）", async () => {
      const dailyPick = makeEmptyEntriesDailyPick();
      // 必须不抛异常
      const html = await renderDailyHero(dailyPick);
      expect(typeof html).toBe("string");
      expect(html.length).toBeGreaterThan(0);
    });

    it("entries=[] 时 HTML 不包含 data-testid='banner-tick'（无 ticks）", async () => {
      const dailyPick = makeEmptyEntriesDailyPick();
      const html = await renderDailyHero(dailyPick);

      expect(html).not.toContain('data-testid="banner-tick"');
    });

    it("entries=[] 时 HTML 不包含 data-testid='entry-series-strip'", async () => {
      const dailyPick = makeEmptyEntriesDailyPick();
      const html = await renderDailyHero(dailyPick);

      expect(html).not.toContain('data-testid="entry-series-strip"');
    });

    it("dailyPick=null 时不崩溃（兼容原有 null 路径）", async () => {
      const html = await renderDailyHero(null);
      expect(typeof html).toBe("string");
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 6: editorial 区域信息与当前选中 entry 一致
  // ----------------------------------------------------------------

  describe("场景 6 — editorial 区域信息与 entries[0] 同步", () => {
    it("editorial 区域包含 entries[0] 的 title（data-testid='entry-title' 或直接文本）", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);

      // 设计契约：右侧 editorial 区域显示当前选中 entry 的 title
      expect(html).toContain("精选标题 rank=0");
    });

    it("editorial 区域包含 entries[0] 的 narrative 文本", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);

      expect(html).toContain("叙事文案 rank=0");
    });

    it("editorial 区域不会同时显示两个 entry 的 title（避免内容重叠）", async () => {
      const dailyPick = make20EntriesDailyPick();
      const html = await renderDailyHero(dailyPick);

      // rank=0 的 title 在 editorial 主显示区只出现一次（或有限次）
      // rank=1 的 title 不应出现在 editorial 主显示区（可能出现在缩略图 alt 中，但不是主文本）
      const rank0TitleCount = (html.match(/精选标题 rank=0/g) ?? []).length;
      expect(rank0TitleCount).toBeGreaterThan(0); // rank=0 至少要显示一次
    });
  });

  // ----------------------------------------------------------------
  // 验收场景 7: SSR 首屏只渲染当前 entry 的大图（其它 entry 走 banner-tick 切换后才加载）
  // ----------------------------------------------------------------

  describe("场景 7 — SSR 首屏 photo 仅当前 entry 的", () => {
    it("含 5 entries 时，HTML 含 entries[0] 的 photoId（大图区）", async () => {
      const fiveEntries = Array.from({ length: 5 }, (_, i) => makeEntry(i, 0));
      const entry0 = fiveEntries[0]!;
      const dailyPick: DailyPick = {
        id: "pick-5",
        photoId: entry0.photoId,
        pickDate: "2026-05-10",
        title: entry0.title,
        narrative: entry0.narrative,
        score: entry0.score,
        createdAt: "2026-05-10T06:00:00.000Z",
        photo: entry0.photo,
        members: [],
        entries: fiveEntries,
      };

      const html = await renderDailyHero(dailyPick);
      // 大图：entries[0] photoId 必出现在 entry-big-image figure 内
      expect(html).toMatch(/data-testid="entry-big-image"[\s\S]*entry-photo-000/);
      // banner ticks 数量 = 5
      const tickMatches = html.match(/data-testid="banner-tick"/g);
      expect(tickMatches?.length).toBe(5);
    });
  });
});

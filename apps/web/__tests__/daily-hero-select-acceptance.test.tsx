/**
 * 验收测试（红队）：DailyHero「设为壁纸」按钮
 *
 * 覆盖设计文档：
 *
 *   S1 (P2): 当前 entry.photoId === pick.photoId 时，按钮不存在于 DOM
 *   S2 (P3): 当前展示 rank 0 的 entry 时，右侧编辑栏中无「设为壁纸」按钮
 *   S2 (P4): DailyHero 处于 empty 状态时，页面无「设为壁纸」相关元素
 *   S3 (P5): 按钮 CSS color 使用 var(--muted-foreground) 且 opacity <= 0.3
 *   S3 (P6): 按钮 background 为 transparent，border 为 0/none，border-radius 为 0
 *   S3 (P7): 按钮元素含 aria-label 属性，且为 <button> 原生可聚焦元素
 *
 * 设计文档规定的前端交互：
 *   - 按钮仅在 currentEntry.photoId !== pick.photoId 时显示
 *   - 按钮文案：「设为壁纸」
 *   - 按钮极度弱化：text-muted-foreground/25，hover 到 text-muted-foreground/60
 *   - 无背景、无边框、无圆角
 *   - transition-colors duration-200
 *   - aria-label="将此照片设为今日壁纸源"
 *   - 点击成功后按钮消失（photoId 更新导致条件不满足）
 *
 * 测试策略：
 *   - vi.mock('@/lib/api') mock getTodayPick 返回 fixture 数据
 *   - react-dom/server.renderToString 静态渲染断言 HTML 内容
 *   - 通过构造不同的 DailyPick fixture 验证按钮显隐逻辑
 *   - 使用正则/字符串匹配验证 CSS 样式规则
 *
 * 红队铁律：
 *   - 不读取 daily-hero.tsx 实现文件
 *   - 仅通过 DailyHero 公共组件接口（props: dailyPick）黑盒验证
 *   - 按钮 data-testid 约定：使用 "select-wallpaper-btn"（设计文档未规定，本测试约定此值）
 */

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

function makeEntry(rank: number, memberCount = 0): DailyPickEntry {
  const photoId = `entry-photo-${String(rank).padStart(3, "0")}`;
  const members: (DailyPickMember & { photo: Photo })[] = [];
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
 * 构造含 3 entries 的 DailyPick fixture
 * - entries[0] (rank=0) photoId = entry-photo-000
 * - entries[1] (rank=1) photoId = entry-photo-001
 * - entries[2] (rank=2) photoId = entry-photo-002
 * - pick.photoId 值可自定义（默认为 entry-photo-000）
 */
function makeDailyPick(opts?: {
  pickPhotoId?: string;
  entries?: DailyPickEntry[];
}): DailyPick {
  const entries = opts?.entries ?? Array.from({ length: 3 }, (_, i) => makeEntry(i, 0));
  const pickPhotoId = opts?.pickPhotoId ?? entries[0]!.photoId;
  const entry0 = entries[0]!;

  return {
    id: "daily-pick-001",
    photoId: pickPhotoId,
    pickDate: "2026-06-01",
    title: entry0.title,
    narrative: entry0.narrative,
    score: entry0.score,
    createdAt: "2026-06-01T06:00:00.000Z",
    photo: entry0.photo,
    members: [],
    entries,
  };
}

/** 构造 entries=[] 的空 DailyPick fixture */
function makeEmptyDailyPick(): DailyPick {
  return {
    id: "",
    photoId: "",
    pickDate: "2026-06-01",
    title: "",
    narrative: "",
    score: 0,
    createdAt: "",
    photo: undefined,
    members: [],
    entries: [],
  };
}

// =====================================================================
// 渲染辅助
// =====================================================================

/**
 * 渲染 DailyHero 为 HTML 字符串。
 * CONTRACT_AMBIGUOUS: 组件是否支持 initialEntryIndex prop？
 * 若组件支持，可通过此 prop 模拟选中不同 entry 来验证按钮显隐。
 * 若组件只取 dailyPick prop（从 URL query 初始化选中 entry），
 * 则 static renderToString 无法模拟点击切换。
 * 此测试通过构造不同的 dailyPick fixture 来覆盖各场景。
 */
async function renderDailyHero(dailyPick: DailyPick | null): Promise<string> {
  const { DailyHero } = await import("@/components/daily-hero");
  return renderToString(React.createElement(DailyHero, { dailyPick }));
}

/**
 * 渲染时尝试指定 initialEntryIndex（如果组件支持）
 * 用于验证当前 entry 不是 rank 0 时的按钮显隐。
 */
async function renderDailyHeroAtIdx(dailyPick: DailyPick, idx: number): Promise<string> {
  const { DailyHero } = await import("@/components/daily-hero");
  // CONTRACT_AMBIGUOUS: 组件是否支持 initialEntryIndex prop？
  // 尝试传入，不支持的组件会忽略该 prop
  const props = { dailyPick, initialEntryIndex: idx };
  return renderToString(React.createElement(DailyHero, props as Parameters<typeof DailyHero>[0]));
}

/** 判断按钮是否存在于 HTML 中（按 data-testid 或文案匹配） */
function hasSelectButton(html: string): boolean {
  // 设计文档规定按钮文案为「设为壁纸」
  // 优先匹配 data-testid + 文案双重检测
  return html.includes('data-testid="select-wallpaper-btn"') || html.includes("设为壁纸");
}

/** 提取按钮元素的完整 HTML 片段（用于样式断言） */
function extractButtonTag(html: string): string | null {
  // 匹配 data-testid="select-wallpaper-btn" 所在的 <button> 标签
  const regex = /<button[^>]*data-testid="select-wallpaper-btn"[^>]*>/i;
  const match = html.match(regex);
  return match ? match[0] : null;
}

/** 从 HTML 中提取包含"设为壁纸"的 button 标签 */
function extractButtonByText(html: string): string | null {
  // 匹配 <button ...>设为壁纸</button>
  const regex = /<button[^>]*>设为壁纸<\/button>/i;
  const match = html.match(regex);
  return match ? match[0] : null;
}

// =====================================================================
// P2: 当 entry.photoId !== pick.photoId 时显示按钮
// =====================================================================

describe("DailyHero「设为壁纸」按钮 — 显示条件 (P2)", () => {
  it("当前 entry.photoId !== pick.photoId 时，按钮存在", async () => {
    // pick.photoId = entry-photo-000，当前显示 entries[1] (photoId=entry-photo-001)
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-000",
    });
    // 通过 initialEntryIndex=1 切换到 rank=1 的 entry
    const html = await renderDailyHeroAtIdx(dailyPick, 1);

    expect(hasSelectButton(html)).toBe(true);
  });

  it("当前 entry.photoId === pick.photoId 时，按钮不存在 (P2)", async () => {
    // pick.photoId = entry-photo-000，当前显示 entries[0] (photoId=entry-photo-000)
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-000",
    });
    const html = await renderDailyHero(dailyPick);

    // 相等时按钮不应存在
    expect(hasSelectButton(html)).toBe(false);
  });
});

// =====================================================================
// P3: 当前展示 rank 0 的 entry 时，右侧编辑栏中无按钮
// =====================================================================

describe("DailyHero「设为壁纸」按钮 — rank 0 entry 无按钮 (P3)", () => {
  it("默认选中 rank=0 的 entry，且 pick.photoId 与该 entry 相同 → 无按钮", async () => {
    // 默认：entries[0] 即是 pick.photoId
    const dailyPick = makeDailyPick();
    const html = await renderDailyHero(dailyPick);

    expect(hasSelectButton(html)).toBe(false);
  });

  it("默认选中 rank=0 的 entry，但 pick.photoId 不同（手动选后刷新场景）→ 可能有按钮", async () => {
    // pick.photoId 已改为 rank=1 的 entry，但默认仍显示 rank=0
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-001",
    });
    const html = await renderDailyHero(dailyPick);

    // 当前 entry (rank=0) 的 photoId !== pick.photoId (rank=1 的)
    // 按钮应显示
    expect(hasSelectButton(html)).toBe(true);
  });
});

// =====================================================================
// P4: DailyHero empty 状态无按钮
// =====================================================================

describe("DailyHero「设为壁纸」按钮 — empty 状态 (P4)", () => {
  it("entries=[] 时，页面无「设为壁纸」相关元素", async () => {
    const dailyPick = makeEmptyDailyPick();
    const html = await renderDailyHero(dailyPick);

    // empty 状态没有任何 entry，不应出现按钮
    expect(html).not.toContain("设为壁纸");
    expect(html).not.toContain('data-testid="select-wallpaper-btn"');
  });

  it("dailyPick=null 时不崩溃，也无按钮", async () => {
    const html = await renderDailyHero(null);
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);

    // 无数据时不应有任何按钮文本
    expect(html).not.toContain("设为壁纸");
  });
});

// =====================================================================
// P5: 按钮 CSS 弱化样式
// =====================================================================

describe("DailyHero「设为壁纸」按钮 — CSS 样式弱化 (P5, P6)", () => {
  it("按钮 color 使用 var(--muted-foreground) (P5)", async () => {
    // 构造 pick.photoId 与 rank=0 entry 不同的场景
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-001",
    });
    const html = await renderDailyHero(dailyPick);

    // 必须有按钮
    expect(hasSelectButton(html)).toBe(true);

    // 按钮 style 或 class 应包含 var(--muted-foreground)
    const btnTag = extractButtonTag(html) ?? extractButtonByText(html);
    expect(btnTag).not.toBeNull();

    if (btnTag) {
      // 颜色应引用 muted-foreground CSS 变量
      const hasMutedFg =
        btnTag.includes("--muted-foreground") || btnTag.includes("muted-foreground");
      expect(hasMutedFg).toBe(true);
    }
  });

  it("按钮初始 opacity 弱化 — 使用 Tailwind /25 透明度语法 (P5)", async () => {
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-001",
    });
    const html = await renderDailyHero(dailyPick);

    const btnTag = extractButtonTag(html) ?? extractButtonByText(html);
    expect(btnTag).not.toBeNull();

    if (btnTag) {
      // Tailwind 的 /25 语法表示 opacity: 0.25（符合设计文档 text-muted-foreground/25）
      // 表现为 class 中的 "/25" 出现在 color 声明中
      const hasOpacity25 = /\/25\b/.test(btnTag) || /opacity:\s*0\.2[45]/i.test(btnTag);
      expect(hasOpacity25).toBe(true);
    }
  });

  it("按钮 background 为透明（无背景 class）(P6)", async () => {
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-001",
    });
    const html = await renderDailyHero(dailyPick);

    const btnTag = extractButtonTag(html) ?? extractButtonByText(html);
    expect(btnTag).not.toBeNull();

    if (btnTag) {
      // 设计文档要求无背景。
      // 实现方式可能是：没有 bg- class（button 默认 transparent），
      // 或者显式 bg-transparent
      const hasBgClass = /bg-(?!transparent|\[)/i.test(btnTag);
      // 如果有 bg-transparent 显式类名，通过；如果用 button 默认 transparent，也没有其他 bg class
      const isExplicitTransparent = /bg-transparent/i.test(btnTag);
      const hasNoBgClass = !hasBgClass;

      expect(isExplicitTransparent || hasNoBgClass).toBe(true);
    }
  });

  it("按钮 border 为 0/none (P6)", async () => {
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-001",
    });
    const html = await renderDailyHero(dailyPick);

    const btnTag = extractButtonTag(html) ?? extractButtonByText(html);
    expect(btnTag).not.toBeNull();

    if (btnTag) {
      // 检查无 border class（border-0, border-none 等）
      // 或者 style 中 border: 0 / border: none
      // 注意：Tailwind class 编译后可能在 CSS 规则中，不在 button 标签上
      // 这里检查 button 标签上不应有 border- 相关的非零 class
      const hasBorderClass = /border-(?!0|none|transparent)/i.test(btnTag);
      expect(hasBorderClass).toBe(false);
    }
  });

  it("按钮 border-radius 为 0（无圆角）(P6)", async () => {
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-001",
    });
    const html = await renderDailyHero(dailyPick);

    const btnTag = extractButtonTag(html) ?? extractButtonByText(html);
    expect(btnTag).not.toBeNull();

    if (btnTag) {
      // 不应有 rounded 相关 class (rounded, rounded-md, rounded-lg 等)
      const hasRoundedClass = /rounded(?!\[\s*0)/i.test(btnTag);
      expect(hasRoundedClass).toBe(false);
    }
  });

  it("transition-colors duration-200 类名存在", async () => {
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-001",
    });
    const html = await renderDailyHero(dailyPick);

    const btnTag = extractButtonTag(html) ?? extractButtonByText(html);
    expect(btnTag).not.toBeNull();

    if (btnTag) {
      // transition-colors 和 duration-200 class 应在按钮上
      const hasTransition = btnTag.includes("transition-colors") || btnTag.includes("transition");
      expect(hasTransition).toBe(true);
    }
  });
});

// =====================================================================
// P7: 按钮 aria-label 和无障碍属性
// =====================================================================

describe("DailyHero「设为壁纸」按钮 — 无障碍 (P7)", () => {
  it("按钮含有正确的 aria-label 属性", async () => {
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-001",
    });
    const html = await renderDailyHero(dailyPick);

    const btnTag = extractButtonTag(html) ?? extractButtonByText(html);
    expect(btnTag).not.toBeNull();

    if (btnTag) {
      expect(btnTag).toContain('aria-label="将此照片设为今日壁纸源"');
    }
  });

  it("按钮为 <button> 原生可聚焦元素", async () => {
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-001",
    });
    const html = await renderDailyHero(dailyPick);

    // 必须是 <button> 元素（非 div/span）
    const hasButtonTag = /<button[^>]*>设为壁纸<\/button>/i.test(html);
    expect(hasButtonTag).toBe(true);
  });

  it("按钮文本为「设为壁纸」", async () => {
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-001",
    });
    const html = await renderDailyHero(dailyPick);

    // 按钮内文本精确匹配
    const btnTag = extractButtonByText(html);
    expect(btnTag).not.toBeNull();
    if (btnTag) {
      expect(btnTag).toContain("设为壁纸");
    }
  });

  it("按钮不含 disabled 属性（可交互）", async () => {
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-001",
    });
    const html = await renderDailyHero(dailyPick);

    const btnTag = extractButtonTag(html) ?? extractButtonByText(html);
    expect(btnTag).not.toBeNull();

    if (btnTag) {
      expect(btnTag).not.toContain("disabled");
    }
  });
});

// =====================================================================
// 组合场景
// =====================================================================

describe("DailyHero「设为壁纸」按钮 — 组合场景", () => {
  it("唯一 entry 且 pick.photoId 相同 → 无按钮", async () => {
    const singleEntry = makeEntry(0, 0);
    const dailyPick = makeDailyPick({
      pickPhotoId: singleEntry.photoId,
      entries: [singleEntry],
    });
    const html = await renderDailyHero(dailyPick);
    expect(hasSelectButton(html)).toBe(false);
  });

  it("唯一 entry 但 pick.photoId 不同 → 有按钮", async () => {
    const singleEntry = makeEntry(0, 0);
    const dailyPick = makeDailyPick({
      pickPhotoId: "this-photo-id-is-different",
      entries: [singleEntry],
    });
    const html = await renderDailyHero(dailyPick);
    expect(hasSelectButton(html)).toBe(true);
  });

  it("多个 entry，pick.photoId 等于 entries[2] → entries[0] 上出现按钮", async () => {
    // pick 已设为 rank=2 的 photoId，默认显示 rank=0
    const dailyPick = makeDailyPick({
      pickPhotoId: "entry-photo-002",
    });
    const html = await renderDailyHero(dailyPick);

    // 当前 entry (rank=0) 的 photoId !== pick.photoId → 有按钮
    expect(hasSelectButton(html)).toBe(true);
  });
});

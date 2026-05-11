/**
 * E2E 验收测试：首页 DailyHero 20 张精选缩略图交互（红队）
 *
 * 设计契约来源（state.md 设计文档，不读任何实现）：
 *
 * 场景 R3（浏览器端）：
 * 1. 访问首页 `/`
 * 2. 等待 20 张缩略图渲染
 * 3. 默认大图（主 editorial 区域）显示 rank=0 的 title/photo
 * 4. 点击第 5 张缩略图（rank=4）→ 大图切换 + 右侧 title 更新
 * 5. API mock：page.route 拦截 `/api/daily/today` 返回固定 20 entries fixture
 *
 * 注意（patterns.md 已记录）：
 * - page.route glob 中 `?` 是单字符通配符，匹配 query string 必须用 `*`
 * - 因此拦截模式使用 '**\/api/daily/today*'（不是 '?today?'）
 *
 * 红队铁律：不读取任何实现文件；仅通过浏览器行为验证契约。
 */

import { expect, test } from "@playwright/test";

// ============================================================================
// Fixture 工厂 — 构造 20 entries 的 DailyPick API 响应
// ============================================================================

function makeEntryPhoto(rank: number) {
  const photoId = `e2e-photo-${String(rank).padStart(3, "0")}`;
  return {
    id: photoId,
    storageSourceId: "src-e2e",
    filePath: `photos/e2e-${rank}.jpg`,
    fileHash: `hash-e2e-${rank}`,
    width: 1920,
    height: 1080,
    fileSize: 1024000,
    thumbnailPath: `/api/photos/${photoId}/thumbnail`,
    takenAt: `2023-05-10T${String(8 + (rank % 10)).padStart(2, "0")}:00:00.000Z`,
    createdAt: `2023-05-10T${String(8 + (rank % 10)).padStart(2, "0")}:00:00.000Z`,
    mediaType: "image",
  };
}

function makeMemberPhoto(entryRank: number, memberIdx: number) {
  const photoId = `e2e-member-r${entryRank}-m${memberIdx}`;
  return {
    id: photoId,
    storageSourceId: "src-e2e",
    filePath: `photos/e2e-member-${entryRank}-${memberIdx}.jpg`,
    fileHash: `hash-member-${entryRank}-${memberIdx}`,
    width: 1920,
    height: 1080,
    fileSize: 512000,
    thumbnailPath: `/api/photos/${photoId}/thumbnail`,
    takenAt: `2023-05-10T${String(10 + memberIdx).padStart(2, "0")}:30:00.000Z`,
    createdAt: `2023-05-10T${String(10 + memberIdx).padStart(2, "0")}:30:00.000Z`,
    mediaType: "image",
  };
}

function makeEntry(rank: number, memberCount = 0) {
  const photoId = `e2e-photo-${String(rank).padStart(3, "0")}`;
  const members = Array.from({ length: memberCount }, (_, i) => {
    const mPhotoId = `e2e-member-r${rank}-m${i}`;
    return {
      photoId: mPhotoId,
      caption: `系列照片 rank=${rank} 第 ${i + 1} 张`,
      photo: makeMemberPhoto(rank, i),
    };
  });

  return {
    rank,
    photoId,
    title: `E2E 精选标题 rank=${rank}`,
    narrative: `E2E 叙事文案 rank=${rank}，记录下那年春天的美好瞬间。`,
    score: 9.0 - rank * 0.1,
    photo: makeEntryPhoto(rank),
    members,
  };
}

/**
 * 构造 20 entries 的完整 API 响应
 * - rank=0: 3 张 members（有系列）
 * - rank=4: 2 张 members（点击测试用）
 * - 其余: 0 张 members
 */
function make20EntriesApiResponse() {
  const entries = Array.from({ length: 20 }, (_, i) => {
    if (i === 0) return makeEntry(0, 3);
    if (i === 4) return makeEntry(4, 2);
    return makeEntry(i, 0);
  });

  const entry0 = entries[0]!;

  const data = {
    id: "e2e-daily-pick-001",
    photoId: entry0.photoId,
    pickDate: "2026-05-10",
    title: entry0.title,
    narrative: entry0.narrative,
    score: entry0.score,
    composedImageUrl: null,
    createdAt: "2026-05-10T06:00:00.000Z",
    photo: entry0.photo,
    members: [],
    entries,
  };

  return {
    success: true,
    data,
  };
}

/** 空态响应（entries=[]）*/
function makeEmptyEntriesApiResponse() {
  return {
    success: true,
    data: {
      id: "",
      photoId: "",
      pickDate: "2026-05-10",
      title: "",
      narrative: "",
      score: 0,
      composedImageUrl: null,
      createdAt: "",
      photo: null,
      members: [],
      entries: [],
    },
  };
}

// ============================================================================
// 辅助：mock 所有缩略图请求（返回空 JPEG，避免真实网络请求导致 flaky）
// ============================================================================

async function mockThumbnails(page: import("@playwright/test").Page) {
  // 注意：使用 * 通配符匹配 query string（patterns.md 记录）
  await page.route("**/api/photos/*/thumbnail*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // 最小 JPEG header
    });
  });
}

// ============================================================================
// 测试
// ============================================================================

test.describe("首页 DailyHero entries 交互 — E2E 验收（R3 场景）", () => {
  // --------------------------------------------------------------------------
  // 场景 R3-1: 首页渲染 20 张缩略图
  // --------------------------------------------------------------------------

  test("R3-1: 访问首页，等待 20 个 banner ticks渲染", async ({ page }) => {
    // mock /api/daily/today（含 query string 变体）
    // 注意：使用 * 而非 ? 匹配 query string（patterns.md 已记录）
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make20EntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    // 等待 20 个 banner ticks渲染
    // 设计契约：每个 entry 对应一个 data-testid="banner-tick"（替代旧版 20 缩略图栅格）
    const thumbs = page.locator('[data-testid="banner-tick"]');
    await expect(thumbs).toHaveCount(20, { timeout: 15000 });
  });

  // --------------------------------------------------------------------------
  // 场景 R3-2: 默认大图与 rank=0 一致
  // --------------------------------------------------------------------------

  test("R3-2: 默认大图区域显示 entries[0] 的 title 或 photo", async ({ page }) => {
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make20EntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    // 等待首页核心内容渲染
    await expect(page.locator('[data-testid="banner-tick"]').first()).toBeVisible({
      timeout: 15000,
    });

    // rank=0 的 title 应在 editorial 区域可见
    await expect(page.getByText("E2E 精选标题 rank=0")).toBeVisible({ timeout: 5000 });
  });

  // --------------------------------------------------------------------------
  // 场景 R3-3: rank=0 缩略图处于选中态（aria-selected="true"）
  // --------------------------------------------------------------------------

  test("R3-3: 默认 rank=0 缩略图 aria-selected=true", async ({ page }) => {
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make20EntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    // 等待缩略图渲染
    await expect(page.locator('[data-testid="banner-tick"]').first()).toBeVisible({
      timeout: 15000,
    });

    // rank=0 缩略图应处于选中态
    const selectedThumb = page.locator('[data-testid="banner-tick"][aria-selected="true"]');
    await expect(selectedThumb).toBeVisible({ timeout: 5000 });
  });

  // --------------------------------------------------------------------------
  // 场景 R3-4: 点击第 5 个缩略图（rank=4）→ 大图切换 + title 更新
  // --------------------------------------------------------------------------

  test("R3-4: 点击 rank=4 缩略图，editorial title 切换为 rank=4 内容", async ({ page }) => {
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make20EntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    // 等待 20 张缩略图渲染
    const thumbs = page.locator('[data-testid="banner-tick"]');
    await expect(thumbs).toHaveCount(20, { timeout: 15000 });

    // 初始状态：rank=0 title 可见
    await expect(page.getByText("E2E 精选标题 rank=0")).toBeVisible({ timeout: 5000 });

    // 点击第 5 个缩略图（索引 4，rank=4）
    // nth(4) 是第 5 个（0-indexed）
    await thumbs.nth(4).click();

    // 点击后：rank=4 的 title 应更新到 editorial 区域
    await expect(page.getByText("E2E 精选标题 rank=4")).toBeVisible({ timeout: 5000 });
  });

  // --------------------------------------------------------------------------
  // 场景 R3-5: 点击 rank=4 后，选中态从 rank=0 迁移到 rank=4
  // --------------------------------------------------------------------------

  test("R3-5: 点击 rank=4 后，aria-selected 从 rank=0 迁移到 rank=4", async ({ page }) => {
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make20EntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    const thumbs = page.locator('[data-testid="banner-tick"]');
    await expect(thumbs).toHaveCount(20, { timeout: 15000 });

    // 点击第 5 个缩略图（rank=4）
    await thumbs.nth(4).click();

    // 等待 UI 更新（切换动画 200ms）
    await page.waitForTimeout(300);

    // rank=4 应有 aria-selected="true"
    const rank4Thumb = thumbs.nth(4);
    await expect(rank4Thumb).toHaveAttribute("aria-selected", "true", { timeout: 3000 });

    // rank=0 不再有 aria-selected="true"
    const rank0Thumb = thumbs.nth(0);
    const rank0Selected = await rank0Thumb.getAttribute("aria-selected");
    expect(rank0Selected).not.toBe("true");
  });

  // --------------------------------------------------------------------------
  // 场景 R3-6: rank=0 有 members 时系列缩略条可见
  // --------------------------------------------------------------------------

  test("R3-6: rank=0 有 3 张 members，entry-series-strip 可见", async ({ page }) => {
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make20EntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    await expect(page.locator('[data-testid="banner-tick"]').first()).toBeVisible({
      timeout: 15000,
    });

    // rank=0 有 3 张 members，系列缩略条应渲染
    const seriesStrip = page.locator('[data-testid="entry-series-strip"]');
    await expect(seriesStrip).toBeVisible({ timeout: 5000 });
  });

  // --------------------------------------------------------------------------
  // 场景 R3-7: 切换到 rank=7（members=[]）后系列缩略条消失
  // --------------------------------------------------------------------------

  test("R3-7: 点击 rank=7（members=[]），系列缩略条隐藏或不渲染", async ({ page }) => {
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make20EntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    const thumbs = page.locator('[data-testid="banner-tick"]');
    await expect(thumbs).toHaveCount(20, { timeout: 15000 });

    // 点击 rank=7（index=7），该 entry 无 members
    await thumbs.nth(7).click();

    await page.waitForTimeout(300);

    // 系列缩略条应消失（不可见 or 不存在）
    const seriesStrip = page.locator('[data-testid="entry-series-strip"]');
    await expect(seriesStrip).not.toBeVisible({ timeout: 3000 });
  });

  // --------------------------------------------------------------------------
  // 场景 R3-8: 空态 entries=[] 时首页渲染友好空态（不崩溃）
  // --------------------------------------------------------------------------

  test("R3-8: entries=[] 时首页不崩溃，渲染空态 UI", async ({ page }) => {
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeEmptyEntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    // 页面应成功加载，不出现 500 错误或 JS 崩溃
    const response = await page.evaluate(() => document.title);
    expect(typeof response).toBe("string");

    // 不应有 entry-thumb（无 entries）
    const thumbs = page.locator('[data-testid="banner-tick"]');
    await expect(thumbs).toHaveCount(0, { timeout: 5000 });
  });

  // --------------------------------------------------------------------------
  // 场景 R3-9: narrative 文案随缩略图切换更新
  // --------------------------------------------------------------------------

  test("R3-9: 点击 rank=4 后，narrative 文案更新为 rank=4 内容", async ({ page }) => {
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make20EntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    const thumbs = page.locator('[data-testid="banner-tick"]');
    await expect(thumbs).toHaveCount(20, { timeout: 15000 });

    // 初始：rank=0 narrative 可见
    await expect(page.getByText(/叙事文案 rank=0/)).toBeVisible({ timeout: 5000 });

    // 点击 rank=4
    await thumbs.nth(4).click();

    // rank=4 narrative 更新
    await expect(page.getByText(/叙事文案 rank=4/)).toBeVisible({ timeout: 5000 });
  });

  // --------------------------------------------------------------------------
  // 场景 R3-10: 连续快速点击多张缩略图，选中态 200ms 内响应
  // --------------------------------------------------------------------------

  test("R3-10: 连续点击多张缩略图，最终选中态正确", async ({ page }) => {
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make20EntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    const thumbs = page.locator('[data-testid="banner-tick"]');
    await expect(thumbs).toHaveCount(20, { timeout: 15000 });

    // 连续快速点击 rank=1, rank=3, rank=9
    await thumbs.nth(1).click();
    await thumbs.nth(3).click();
    await thumbs.nth(9).click();

    // 等待最终状态稳定（允许 300ms 动画）
    await page.waitForTimeout(300);

    // 最终选中态应为 rank=9
    const rank9Thumb = thumbs.nth(9);
    await expect(rank9Thumb).toHaveAttribute("aria-selected", "true", { timeout: 3000 });

    // rank=9 的 title 应显示
    await expect(page.getByText("E2E 精选标题 rank=9")).toBeVisible({ timeout: 3000 });
  });

  // --------------------------------------------------------------------------
  // 场景 R3-11: 系列条点击原地切换大图（不跳转），右侧 editorial 不变
  // --------------------------------------------------------------------------

  test("R3-11: 点击系列条 member，大图原地切换 + 不跳转 + editorial 保持", async ({ page }) => {
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make20EntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    // 等待 banner-tick 渲染
    const ticks = page.locator('[data-testid="banner-tick"]');
    await expect(ticks).toHaveCount(20, { timeout: 15000 });

    // rank=0 有 3 个 members → 系列条共 4 个 thumb（1 primary + 3 members）
    const seriesThumbs = page.locator('[data-testid="entry-series-thumb"]');
    await expect(seriesThumbs).toHaveCount(4, { timeout: 5000 });

    // 初始：第 0 个系列项（primary）aria-selected="true"
    await expect(seriesThumbs.nth(0)).toHaveAttribute("aria-selected", "true");

    // 记录当前 URL（点击 member 不应改 URL ?entry=）
    const urlBefore = page.url();

    // 点击系列条第 2 项（member[1]）
    await seriesThumbs.nth(2).click();
    await page.waitForTimeout(200);

    // 选中态从 primary 迁移到第 2 项
    await expect(seriesThumbs.nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(seriesThumbs.nth(0)).not.toHaveAttribute("aria-selected", "true");

    // URL 不变（系列条点击不改 ?entry= 参数）
    expect(page.url()).toBe(urlBefore);

    // editorial title 仍是 rank=0（系列条切换不改右侧叙事）
    await expect(page.getByText("E2E 精选标题 rank=0")).toBeVisible();
  });

  // --------------------------------------------------------------------------
  // 场景 R3-12: 系列条点击不跳转到 /photos/[id]
  // --------------------------------------------------------------------------

  test("R3-12: 点击系列条 member 不跳转到 /photos/[id]", async ({ page }) => {
    await page.route("**/api/daily/today*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(make20EntriesApiResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/");

    const ticks = page.locator('[data-testid="banner-tick"]');
    await expect(ticks).toHaveCount(20, { timeout: 15000 });

    const seriesThumbs = page.locator('[data-testid="entry-series-thumb"]');
    await expect(seriesThumbs.first()).toBeVisible({ timeout: 5000 });

    // 监听 navigation
    let navigatedAway = false;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && /\/photos\//.test(frame.url())) {
        navigatedAway = true;
      }
    });

    // 点击系列条第 1 项（member[0]）
    await seriesThumbs.nth(1).click();
    await page.waitForTimeout(300);

    expect(navigatedAway).toBe(false);
    expect(page.url()).not.toMatch(/\/photos\//);
  });
});

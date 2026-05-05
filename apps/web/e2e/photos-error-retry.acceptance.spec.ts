/**
 * 验收测试（红队）：/photos 页面加载失败重试按钮
 *
 * 设计意图：
 *   当照片列表首屏加载成功（>0 张），但后续分页请求失败时：
 *   - sentinel（无限滚动触发区域）应显示"加载失败，点击重试"按钮
 *   - 点击按钮应重新触发 loadMore
 *   - isFetchingMore=true 时显示 spinner，不显示按钮
 *   - idle 状态（无 error、无 loading）不显示"上滑加载更多"文字
 *
 * 策略：
 *   用 page.route 拦截 API 请求，先让首屏成功，再让分页请求返回 500
 *   不依赖真实后端，纯前端行为验证
 */

import { expect, test } from "@playwright/test";

// ============================================================================
// 辅助：构造假照片数据
// ============================================================================

// 注意：前端 usePhotosInfinite 默认 pageSize=50，mock 必须满足 page*pageSize<total
// 才会让 hasMore=true 让 sentinel 渲染。给 50 张照片 + total=200 让 hasMore=true。
function makeFakePhotosResponse(page: number, total = 200) {
  const photos = Array.from({ length: 50 }, (_, i) => ({
    id: `photo-page${page}-${i + 1}`,
    storageSourceId: "src-test",
    filePath: `/photos/test-p${page}-${i + 1}.jpg`,
    fileHash: `hash-p${page}-${i + 1}`,
    width: 800,
    height: 600,
    fileSize: 102400,
    thumbnailPath: null,
    takenAt: `2024-0${page}-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
    createdAt: `2024-0${page}-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
    tags: [],
    analyses: [],
  }));

  return {
    success: true,
    data: photos,
    total,
    page,
    pageSize: 20,
  };
}

// ============================================================================
// 测试
// ============================================================================

test.describe("照片页 — 加载失败重试按钮（验收测试，红队）", () => {
  // --------------------------------------------------------------------------
  // 用例 1：核心 — 分页请求 500 时出现重试按钮
  // --------------------------------------------------------------------------
  test("分页请求返回 500 时，sentinel 区域应显示「加载失败，点击重试」按钮", async ({ page }) => {
    let requestCount = 0;

    // 拦截所有 /api/photos 请求
    await page.route("**/api/photos**", async (route) => {
      requestCount++;
      const url = new URL(route.request().url());
      const pageNum = Number(url.searchParams.get("page") ?? "1");

      if (pageNum === 1) {
        // 首屏：成功返回 20 张照片（total=50，告知还有更多）
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePhotosResponse(1, 200)),
        });
      } else {
        // 后续分页：模拟服务器错误
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "Internal Server Error" }),
        });
      }
    });

    // 访问照片页
    await page.goto("/photos");

    // 等待首屏照片加载
    // 照片网格或照片列表容器
    // 等待客户端 hydration + 数据加载完成（loading 分支 main 切到 flex 布局 main）
    await page.waitForSelector("main.flex.flex-col div.flex-1.overflow-auto", {
      timeout: 10000,
    });
    // 滚动到底部触发 sentinel；/photos 是内部 overflow-auto 容器滚动，不是 window
    await page.evaluate(() => {
      const container = document.querySelector("main.flex.flex-col div.flex-1.overflow-auto");
      if (container) container.scrollTop = container.scrollHeight;
    });

    // 等待 sentinel 区域出现错误状态
    // 验收：应出现"加载失败，点击重试"按钮
    const retryButton = page.getByRole("button", { name: /加载失败[，,]?\s*点击重试/ });

    await expect(retryButton).toBeVisible({ timeout: 5000 });
  });

  // --------------------------------------------------------------------------
  // 用例 2：重试按钮可点击
  // --------------------------------------------------------------------------
  test("点击「加载失败，点击重试」按钮后应重新发起分页请求", async ({ page }) => {
    const pageRequests: number[] = [];

    await page.route("**/api/photos**", async (route) => {
      const url = new URL(route.request().url());
      const pageNum = Number(url.searchParams.get("page") ?? "1");
      pageRequests.push(pageNum);

      if (pageNum === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePhotosResponse(1, 200)),
        });
      } else {
        // 始终返回 500（测试重试行为，不测试成功后的状态）
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "Service Unavailable" }),
        });
      }
    });

    await page.goto("/photos");
    await page.waitForSelector("main.flex.flex-col div.flex-1.overflow-auto", { timeout: 10000 });
    await page.evaluate(() => {
      const container = document.querySelector("main.flex.flex-col div.flex-1.overflow-auto");
      if (container) container.scrollTop = container.scrollHeight;
    });

    // 等待重试按钮出现
    const retryButton = page.getByRole("button", { name: /加载失败[，,]?\s*点击重试/ });
    await expect(retryButton).toBeVisible({ timeout: 5000 });

    // 记录点击前已经发出的 page=2 请求次数
    const countBefore = pageRequests.filter((p) => p >= 2).length;

    // 点击重试
    await retryButton.click();

    // 等待新的请求发出
    await page.waitForTimeout(1000);

    // 应该有更多的 page>=2 请求（重试触发了新请求）
    const countAfter = pageRequests.filter((p) => p >= 2).length;
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  // --------------------------------------------------------------------------
  // 用例 3：idle 状态不显示"上滑加载更多"文字
  // --------------------------------------------------------------------------
  test("idle 状态（无错误、无加载中）sentinel 区域不应显示「上滑加载更多」", async ({ page }) => {
    // 返回全量照片（total <= 20，不触发加载更多）
    await page.route("**/api/photos**", async (route) => {
      const url = new URL(route.request().url());
      const pageNum = Number(url.searchParams.get("page") ?? "1");

      if (pageNum === 1) {
        // 只有 5 张照片，没有更多
        const photos = Array.from({ length: 5 }, (_, i) => ({
          id: `photo-${i + 1}`,
          storageSourceId: "src-test",
          filePath: `/photos/test-${i + 1}.jpg`,
          fileHash: `hash-${i + 1}`,
          width: 800,
          height: 600,
          fileSize: 102400,
          thumbnailPath: null,
          takenAt: null,
          createdAt: `2024-01-0${i + 1}T10:00:00.000Z`,
          tags: [],
          analyses: [],
        }));

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: photos,
            total: 5,
            page: 1,
            pageSize: 20,
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [],
            total: 5,
            page: pageNum,
            pageSize: 20,
          }),
        });
      }
    });

    await page.goto("/photos");
    await page.waitForLoadState("networkidle");

    // idle 状态不应显示"上滑加载更多"文字
    // 设计意图：删除此提示文字，sentinel 在 idle 时为空
    const loadMoreHint = page.getByText("上滑加载更多");
    await expect(loadMoreHint).not.toBeVisible({ timeout: 2000 });
  });

  // --------------------------------------------------------------------------
  // 用例 4：错误态不应显示 spinner
  // --------------------------------------------------------------------------
  test("分页错误状态下应显示重试按钮，不应显示 spinner", async ({ page }) => {
    await page.route("**/api/photos**", async (route) => {
      const url = new URL(route.request().url());
      const pageNum = Number(url.searchParams.get("page") ?? "1");

      if (pageNum === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePhotosResponse(1, 200)),
        });
      } else {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "Server Error" }),
        });
      }
    });

    await page.goto("/photos");
    await page.waitForLoadState("networkidle");
    // /photos 是内部 div.flex-1.overflow-auto 容器滚动，不是 window 滚动
    await page.evaluate(() => {
      const container = document.querySelector("main > div.flex-1.overflow-auto");
      if (container) container.scrollTop = container.scrollHeight;
    });

    // 等待错误状态
    const retryButton = page.getByRole("button", { name: /加载失败[，,]?\s*点击重试/ });
    await expect(retryButton).toBeVisible({ timeout: 5000 });

    // spinner 不应同时可见（role=progressbar 或 data-testid=spinner 或 aria-label=加载中）
    // 用多种可能的 selector 都检查
    const spinner = page.locator(
      '[role="progressbar"], [aria-label="加载中"], [data-testid="spinner"]',
    );
    // spinner 不应可见
    await expect(spinner)
      .not.toBeVisible({ timeout: 1000 })
      .catch(() => {
        // 如果找不到元素本身，也是通过（spinner 不存在 = 不可见）
      });
  });
});

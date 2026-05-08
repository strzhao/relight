/**
 * /history 页面 E2E 测试（红队）
 *
 * 覆盖验收基线：
 *   1. 列表渲染 — mock 返回 3 条精选，断言标题可见 + 条目数量
 *   2. 空态     — mock 返回空数组，断言"还没有历史精选"文案
 *   3. 点击跳转 — 点击第一条，断言 URL 跳转到 /photos/<photoId>
 */

import { expect, test } from "@playwright/test";

// ============================================================================
// 辅助：构造假 DailyPick 数据（字段与 packages/shared/src/types.ts 对齐）
// ============================================================================

function makeFakePick(index: number) {
  const photoId = `photo-id-${index}-aaaabbbbccccdddd`;
  return {
    id: `pick-id-${index}`,
    photoId,
    pickDate: `2025-05-0${index}`,
    title: `精选标题${index}`,
    narrative: `这是第 ${index} 条精选的叙事文案，描述了这张照片的美妙之处。`,
    score: 90 - index,
    createdAt: `2025-05-0${index}T06:00:00.000Z`,
    photo: {
      id: photoId,
      storageSourceId: "src-test",
      filePath: `/photos/test-${index}.jpg`,
      fileHash: `hash-${index}`,
      width: 1920,
      height: 1080,
      fileSize: 204800,
      thumbnailPath: null,
      takenAt: `2025-05-0${index}T10:00:00.000Z`,
      createdAt: `2025-05-0${index}T10:00:00.000Z`,
    },
  };
}

function makeFakePicksResponse(count: number, total?: number) {
  const data = Array.from({ length: count }, (_, i) => makeFakePick(i + 1));
  return {
    success: true,
    data,
    total: total ?? count,
    page: 1,
    pageSize: 20,
  };
}

// ============================================================================
// 测试
// ============================================================================

test.describe("/history 页面", () => {
  // --------------------------------------------------------------------------
  // 用例 1：有数据时渲染精选时间线列表
  // --------------------------------------------------------------------------
  test("列表渲染：有数据时显示历史精选时间线列表", async ({ page }) => {
    // mock /api/daily 返回 3 条精选
    await page.route("**/api/daily*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeFakePicksResponse(3)),
      });
    });

    // mock 缩略图请求，避免真实网络请求导致 flaky
    await page.route("**/api/photos/*/thumbnail*", async (route) => {
      await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
    });

    await page.goto("/history");

    // a. "历史精选" 标题可见
    await expect(page.getByText("历史精选")).toBeVisible({ timeout: 10000 });

    // b. 至少 3 个列表条目可见（通过 role=listitem 或 list item container）
    //    实现层会用 <ul>/<li> 或带 role 的元素，用 getByRole 最稳健
    //    备选：通过 data-testid="daily-pick-row" 或条目中的标题文案匹配
    //    这里用宽松策略：断言 mock 返回的 3 条标题都出现在页面中
    await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("精选标题2")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("精选标题3")).toBeVisible({ timeout: 5000 });

    // c. 至少能找到 mock 返回第一条精选的标题文本（冗余确认）
    const firstTitle = page.getByText("精选标题1");
    await expect(firstTitle).toBeVisible();
  });

  // --------------------------------------------------------------------------
  // 用例 2：无数据时显示友好空态提示
  // --------------------------------------------------------------------------
  test("空态：无数据时显示友好空态提示", async ({ page }) => {
    // mock 返回空数组
    await page.route("**/api/daily*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], total: 0, page: 1, pageSize: 20 }),
      });
    });

    await page.route("**/api/photos/*/thumbnail*", async (route) => {
      await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
    });

    await page.goto("/history");

    // 等待页面加载完成（标题出现意味着组件已 mount）
    await expect(page.getByText("历史精选")).toBeVisible({ timeout: 10000 });

    // 空态文案应出现
    await expect(page.getByText("还没有历史精选")).toBeVisible({ timeout: 5000 });
  });

  // --------------------------------------------------------------------------
  // 用例 3：点击条目跳转到 /photos/<photoId>
  // --------------------------------------------------------------------------
  test("点击跳转：点击列表条目跳到 /photos/[id]", async ({ page }) => {
    const firstPick = makeFakePick(1);

    // mock 返回 1 条精选（含 photoId）
    await page.route("**/api/daily*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [firstPick],
          total: 1,
          page: 1,
          pageSize: 20,
        }),
      });
    });

    await page.route("**/api/photos/*/thumbnail*", async (route) => {
      await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
    });

    await page.goto("/history");

    // 等待列表渲染
    await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

    // 找到包含该精选标题的 <a> 链接并点击
    // 实现层会将整行包在 <a href="/photos/<photoId}"> 中
    const link = page.locator(`a[href="/photos/${firstPick.photoId}"]`).first();
    await expect(link).toBeVisible({ timeout: 5000 });
    await link.click();

    // 断言 URL 跳转到 /photos/<photoId>
    await expect(page).toHaveURL(`/photos/${firstPick.photoId}`, { timeout: 5000 });
  });
});

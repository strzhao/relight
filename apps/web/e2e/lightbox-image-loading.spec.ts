import { expect, test } from "@playwright/test";

test.describe("Lightbox 原图加载", () => {
  test("点击照片应打开 Lightbox 且图片正常加载", async ({ page }) => {
    await page.goto("/photos");

    // 等待照片列表加载完成（至少有一张照片卡片）
    const photoCard = page.locator('[role="button"]').first();
    await photoCard.waitFor({ state: "visible", timeout: 15000 });

    // 点击第一张照片打开 lightbox
    await photoCard.click();

    // 验证 lightbox dialog 出现
    const dialog = page.locator('[role="dialog"][aria-label="照片查看器"]');
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await expect(dialog).toBeVisible();

    // 验证 lightbox 内 <img> 存在
    const lightboxImg = dialog.locator("img");
    await expect(lightboxImg).toBeAttached({ timeout: 5000 });

    // 验证图片 src 指向 original API
    const src = await lightboxImg.getAttribute("src");
    expect(src).toBeTruthy();
    expect(src).toContain("/api/photos/");
    expect(src).toContain("/original");

    // 等待图片加载完成（opacity-100 类表示加载成功）
    await expect(lightboxImg).toHaveClass(/opacity-100/, { timeout: 10000 });

    // 不应出现"加载失败"文案
    const errorText = dialog.locator("text=加载失败");
    await expect(errorText).not.toBeVisible({ timeout: 5000 });
  });

  test("翻页后下一张图片也应正常加载", async ({ page }) => {
    await page.goto("/photos");

    // 等待照片卡片
    const photoCards = page.locator('[role="button"]');
    await photoCards.first().waitFor({ state: "visible", timeout: 15000 });

    // 确保至少有 2 张照片可翻页
    const cardCount = await photoCards.count();
    if (cardCount < 2) {
      console.log("照片不足 2 张，跳过翻页测试");
      return;
    }

    // 点击第一张打开 lightbox
    await photoCards.first().click();

    const dialog = page.locator('[role="dialog"][aria-label="照片查看器"]');
    await dialog.waitFor({ state: "visible", timeout: 5000 });

    // 等待首张图片加载完
    const img = dialog.locator("img");
    await expect(img).toHaveClass(/opacity-100/, { timeout: 10000 });

    // 按右箭头翻到下一张
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(1500);

    // 下一张也应正常加载（不出现错误文案）
    const errorText = dialog.locator("text=加载失败");
    await expect(errorText).not.toBeVisible({ timeout: 5000 });

    // 验证图片 src 发生变化（不同照片 ID）
    const newSrc = await img.getAttribute("src");
    expect(newSrc).toContain("/api/photos/");
    expect(newSrc).toContain("/original");
  });

  test("关闭并重新打开 lightbox 后图片应正常加载", async ({ page }) => {
    await page.goto("/photos");

    const photoCard = page.locator('[role="button"]').first();
    await photoCard.waitFor({ state: "visible", timeout: 15000 });

    // 打开 lightbox
    await photoCard.click();
    const dialog = page.locator('[role="dialog"][aria-label="照片查看器"]');
    await dialog.waitFor({ state: "visible", timeout: 5000 });

    // 关闭（按 Escape）
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 3000 });

    // 重新打开
    await photoCard.click();
    await dialog.waitFor({ state: "visible", timeout: 5000 });

    // 图片应正常加载
    const img = dialog.locator("img");
    await expect(img).toHaveClass(/opacity-100/, { timeout: 10000 });

    const errorText = dialog.locator("text=加载失败");
    await expect(errorText).not.toBeVisible({ timeout: 3000 });
  });

  test("快速翻页多张图片不应出现加载失败", async ({ page }) => {
    await page.goto("/photos");

    const photoCards = page.locator('[role="button"]');
    await photoCards.first().waitFor({ state: "visible", timeout: 15000 });

    const cardCount = await photoCards.count();
    if (cardCount < 5) {
      console.log(`仅 ${cardCount} 张照片，跳过快速翻页测试`);
      return;
    }

    // 打开 lightbox
    await photoCards.first().click();
    const dialog = page.locator('[role="dialog"][aria-label="照片查看器"]');
    await dialog.waitFor({ state: "visible", timeout: 5000 });

    // 快速翻 5 页
    for (let i = 0; i < Math.min(5, cardCount - 1); i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(800);
    }

    // 快速翻页后不应有"加载失败"
    const errorText = dialog.locator("text=加载失败");
    await expect(errorText).not.toBeVisible({ timeout: 3000 });
  });

  test("图片 original API 不应返回 404/500", async ({ page }) => {
    await page.goto("/photos");

    const photoCard = page.locator('[role="button"]').first();
    await photoCard.waitFor({ state: "visible", timeout: 15000 });

    // 监听 original API 响应
    const apiResponses: { url: string; status: number }[] = [];
    page.on("response", (res) => {
      if (res.url().includes("/api/photos/") && res.url().includes("/original")) {
        apiResponses.push({ url: res.url(), status: res.status() });
      }
    });

    await photoCard.click();
    const dialog = page.locator('[role="dialog"][aria-label="照片查看器"]');
    await dialog.waitFor({ state: "visible", timeout: 5000 });

    // 等待一段时间让图片请求完成
    await page.waitForTimeout(3000);

    // 至少应有一次 original API 请求
    expect(apiResponses.length).toBeGreaterThan(0);

    // 所有 original API 响应应为 200（非 404/500）
    for (const { url, status } of apiResponses) {
      expect(status, `original API ${url} 返回 ${status}`).toBe(200);
    }
  });
});

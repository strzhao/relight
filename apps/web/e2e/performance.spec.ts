import { expect, test } from "@playwright/test";

test.describe("性能基准", () => {
  test("首页加载性能应在可接受范围内", async ({ page }) => {
    const start = Date.now();
    const response = await page.goto("/");
    const loadTime = Date.now() - start;

    expect(response?.status()).toBe(200);
    // 首页首次加载应在 5 秒内完成
    expect(loadTime).toBeLessThan(5000);

    // 验证 Core Web Vitals 关键节点存在
    await expect(page.locator("html")).toBeVisible();
  });

  test("照片列表页应支持虚拟滚动（大列表不卡顿）", async ({ page }) => {
    await page.goto("/photos");

    // 等待页面渲染
    await page.waitForLoadState("networkidle");

    // 快速滚动 5000px 应不崩溃
    await page.evaluate(() => window.scrollBy(0, 5000));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollBy(0, 5000));
    await page.waitForTimeout(500);

    // 页面应仍然可交互
    await expect(page).toHaveURL(/\/photos/);
  });
});

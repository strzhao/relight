import { expect, test } from "@playwright/test";

test.describe("冒烟测试", () => {
  test("首页应正常加载", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/.+/);
  });

  test("照片页应正常加载", async ({ page }) => {
    const response = await page.goto("/photos");
    expect(response?.status()).toBe(200);
  });
});

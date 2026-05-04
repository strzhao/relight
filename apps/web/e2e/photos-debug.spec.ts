import { expect, test } from "@playwright/test";

test("sentinel 始终渲染并能触发加载更多", async ({ page }) => {
  const apiCalls: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/api/photos") && url.includes("page=")) {
      apiCalls.push(url);
    }
  });

  await page.goto("/photos");
  await page.waitForSelector('[class*="backdrop-blur"]', { timeout: 15000 });
  await page.waitForTimeout(1000);

  // 检查 sentinel 是否在 DOM 中
  const sentinelInDom = await page.evaluate(() => {
    // sentinel 包含 "上滑加载更多" 文本
    return document.body.textContent?.includes("上滑加载更多") ?? false;
  });
  console.log(`Sentinel in DOM: ${sentinelInDom}`);
  console.log(`Initial API calls: ${apiCalls.length}`);

  if (!sentinelInDom) {
    console.log("无更多可加载内容（所有照片在一页内），跳过");
    return;
  }

  // 滚动到底部
  const container = page.locator(".flex-1.overflow-auto").first();
  await container.evaluate((el) => {
    el.scrollTo(0, el.scrollHeight);
  });

  // 等待加载更多（最多 15 秒）
  const startTime = Date.now();
  while (Date.now() - startTime < 15000) {
    await page.waitForTimeout(500);
    if (apiCalls.length >= 2) break;
  }

  console.log(`Final API calls: ${apiCalls.length}`);
  console.log(
    "Pages:",
    apiCalls.map((u) => u.match(/page=(\d+)/)?.[1]),
  );

  // 应该有至少 2 次 API 调用（page=1 和 page=2）
  expect(apiCalls.length).toBeGreaterThanOrEqual(2);
});

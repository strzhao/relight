import { expect, test } from "@playwright/test";

test.describe("/photos 页面滚动体验", () => {
  test("分组标题不应重复出现", async ({ page }) => {
    await page.goto("/photos");
    await page.waitForSelector('[class*="backdrop-blur"]', { timeout: 15000 });
    await page.waitForTimeout(1000);

    const collectVisibleHeaders = async () => {
      return page.evaluate(() => {
        const headers = document.querySelectorAll('[class*="backdrop-blur"] span:first-child');
        return Array.from(headers).map((el) => el.textContent?.trim() ?? "");
      });
    };

    const checkNoDuplicates = async () => {
      const headers = await collectVisibleHeaders();
      const counts = new Map<string, number>();
      for (const h of headers) {
        counts.set(h, (counts.get(h) ?? 0) + 1);
      }
      const duplicates = Array.from(counts.entries()).filter(([, c]) => c > 1);
      expect(duplicates).toHaveLength(0);
    };

    await checkNoDuplicates();

    const container = page.locator(".flex-1.overflow-auto").first();
    for (let i = 0; i < 5; i++) {
      await container.evaluate((el) => {
        el.scrollBy(0, el.clientHeight * 0.8);
      });
      await page.waitForTimeout(500);
      await checkNoDuplicates();
    }

    await container.evaluate((el) => {
      el.scrollTo(0, el.scrollHeight);
    });
    await page.waitForTimeout(2000);
    await checkNoDuplicates();
  });

  test("虚拟列表渲染数量稳定（无 DOM 残留）", async ({ page }) => {
    await page.goto("/photos");
    await page.waitForSelector('[class*="backdrop-blur"]', { timeout: 15000 });
    await page.waitForTimeout(800);

    const getHeaderCount = () =>
      page.evaluate(() => {
        return document.querySelectorAll('[class*="backdrop-blur"]').length;
      });

    const initialCount = await getHeaderCount();
    const container = page.locator(".flex-1.overflow-auto").first();
    await container.evaluate((el) => {
      el.scrollBy(0, el.clientHeight * 1.5);
    });
    await page.waitForTimeout(1000);

    const afterScrollCount = await getHeaderCount();
    expect(Math.abs(afterScrollCount - initialCount)).toBeLessThanOrEqual(3);
  });

  test("滚动到底部触发加载更多（验证 API 调用）", async ({ page }) => {
    // 监听 photos API 请求
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

    // 初始加载应至少有一次 API 调用 (page=1)
    const hasInitialCall = apiCalls.some((url) => url.includes("page=1"));
    expect(hasInitialCall).toBe(true);

    // 检查是否有更多可加载
    const loadMoreHint = page.locator("text=上滑加载更多");
    const hasMore = (await loadMoreHint.count()) > 0;

    if (!hasMore) {
      console.log("所有照片已在一页内，跳过");
      return;
    }

    const callsBeforeScroll = apiCalls.length;

    // 滚动到底部
    const container = page.locator(".flex-1.overflow-auto").first();
    await container.evaluate((el) => {
      el.scrollTo(0, el.scrollHeight);
    });

    // 等待加载更多（最多 15s）
    const startTime = Date.now();
    while (Date.now() - startTime < 15000) {
      await page.waitForTimeout(500);
      if (apiCalls.length > callsBeforeScroll) break;
    }

    console.log(`API 调用: ${callsBeforeScroll} → ${apiCalls.length}`);
    // 应该有新的 API 调用（page=2）
    expect(apiCalls.length).toBeGreaterThan(callsBeforeScroll);
  });

  test("快速连续滚动不触发级联重复加载", async ({ page }) => {
    const apiCalls: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/photos") && url.includes("page=")) {
        apiCalls.push(url);
      }
    });

    await page.goto("/photos");
    await page.waitForSelector('[class*="backdrop-blur"]', { timeout: 15000 });
    await page.waitForTimeout(500);

    const container = page.locator(".flex-1.overflow-auto").first();

    for (let i = 0; i < 3; i++) {
      await container.evaluate((el) => {
        el.scrollBy(0, el.clientHeight * 0.9);
      });
      await page.waitForTimeout(300);
    }

    await container.evaluate((el) => {
      el.scrollTo(0, el.scrollHeight);
    });
    await page.waitForTimeout(4000);

    // 检查 API 调用中没有重复的 page 参数（同一页被请求多次）
    const pages = apiCalls
      .map((url) => {
        const match = url.match(/page=(\d+)/);
        return match ? Number.parseInt(match[1] as string) : null;
      })
      .filter(Boolean);

    const uniquePages = new Set(pages);
    console.log(`API 调用的页码: ${pages.join(", ")}`);
    // 同一页码只应请求一次
    expect(pages.length).toBe(uniquePages.size);
  });
});

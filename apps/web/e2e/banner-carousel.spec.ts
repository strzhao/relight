import { expect, test } from "@playwright/test";

/**
 * 真实浏览器验收 — BannerCarousel 交互
 *
 * 触发本测试的根因：jsdom 不实现 setPointerCapture 副作用，导致单元测试
 * (banner-carousel.acceptance.test.ts 用例 k) 在 jsdom 跑通的 click 事件，
 * 在真实浏览器里被 section 的 pointer capture 吞掉，箭头按钮点击无效。
 * 单元测试天然覆盖不到此类浏览器交互细节，必须有 Playwright 把守。
 */

test.describe("BannerCarousel 真实浏览器交互", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // 等 SSR + CSR 完成，DailyHero fetch 完拿到精选数据
    await page.waitForSelector('[data-testid="banner-carousel"]', { timeout: 15000 });
  });

  test("点击 next 箭头应切换到下一张", async ({ page }) => {
    // 单图退化时无控件 — 跳过此场景
    const nextBtn = page.locator('[data-testid="banner-arrow-next"]');
    if ((await nextBtn.count()) === 0) {
      test.skip(true, "今日精选只有一张，无 banner 控件");
      return;
    }

    const slides = page.locator('[data-testid="banner-slide"]');
    const initialCurrent = page.locator('[data-testid="banner-slide"][aria-current="true"]');
    const initialIdx = await slides.evaluateAll(
      (nodes, target) => {
        const found = nodes.findIndex((n) => n === target);
        return found;
      },
      await initialCurrent.elementHandle(),
    );

    await nextBtn.click();

    // 切换有 720ms 过渡，等 aria-current 移动
    await expect
      .poll(
        async () => {
          const allSlides = await slides.all();
          for (let i = 0; i < allSlides.length; i++) {
            const cur = await allSlides[i]?.getAttribute("aria-current");
            if (cur === "true") return i;
          }
          return -1;
        },
        { timeout: 2000 },
      )
      .not.toBe(initialIdx);
  });

  test("点击 prev 箭头应切换到上一张", async ({ page }) => {
    const prevBtn = page.locator('[data-testid="banner-arrow-prev"]');
    if ((await prevBtn.count()) === 0) {
      test.skip(true, "今日精选只有一张，无 banner 控件");
      return;
    }

    const slides = page.locator('[data-testid="banner-slide"]');
    const total = await slides.count();
    if (total < 2) {
      test.skip(true, "slides 不足 2 张");
      return;
    }

    // 先 next 一次到 idx=1，再 prev 回到 idx=0
    await page.locator('[data-testid="banner-arrow-next"]').click();
    await expect
      .poll(async () => slides.nth(1).getAttribute("aria-current"), { timeout: 2000 })
      .toBe("true");

    await prevBtn.click();
    await expect
      .poll(async () => slides.nth(0).getAttribute("aria-current"), { timeout: 2000 })
      .toBe("true");
  });

  test("键盘 ArrowRight 应切换到下一张（focus 在 carousel 时）", async ({ page }) => {
    const carousel = page.locator('[data-testid="banner-carousel"]');
    const slides = page.locator('[data-testid="banner-slide"]');
    const total = await slides.count();
    if (total < 2) {
      test.skip(true, "单图无法验证键盘切换");
      return;
    }

    await carousel.focus();
    await page.keyboard.press("ArrowRight");

    await expect
      .poll(async () => slides.nth(1).getAttribute("aria-current"), { timeout: 2000 })
      .toBe("true");
  });

  test("点击 tick 应跳转到对应索引", async ({ page }) => {
    const ticks = page.locator('[data-testid="banner-tick"]');
    const total = await ticks.count();
    if (total < 3) {
      test.skip(true, "ticks 不足 3 个");
      return;
    }

    // 第 3 个 tick (index 2)
    await ticks.nth(2).click();

    const slides = page.locator('[data-testid="banner-slide"]');
    await expect
      .poll(async () => slides.nth(2).getAttribute("aria-current"), { timeout: 2000 })
      .toBe("true");
  });

  test("水平拖拽超过阈值应切换", async ({ page }) => {
    const carousel = page.locator('[data-testid="banner-carousel"]');
    const slides = page.locator('[data-testid="banner-slide"]');
    if ((await slides.count()) < 2) {
      test.skip(true, "单图无法验证拖拽");
      return;
    }

    const box = await carousel.boundingBox();
    if (!box) throw new Error("carousel 无法定位");
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const endX = startX - 200; // 左滑 200px > 80 阈值

    // 先 hover 让 mouse 落到中心，再缓慢拖拽（多 step 触发更多 pointermove）
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // 中间 step：模拟用户连续拖动，给 React onPointerMove 累积 dragDeltaX 的机会
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(startX - (i * 200) / 20, startY);
    }
    await page.mouse.up();

    await expect
      .poll(async () => slides.nth(1).getAttribute("aria-current"), { timeout: 3000 })
      .toBe("true");
  });

  test("点击箭头按钮不应被 pointer capture 吞噬（防 setPointerCapture 回归）", async ({ page }) => {
    const nextBtn = page.locator('[data-testid="banner-arrow-next"]');
    if ((await nextBtn.count()) === 0) {
      test.skip(true, "单图无控件");
      return;
    }

    const slides = page.locator('[data-testid="banner-slide"]');
    if ((await slides.count()) < 3) {
      test.skip(true, "ticks 不足 3 张，无法连点验证");
      return;
    }

    // 连点 3 次，验证每次都生效（如果 pointer 被吞，第二次起就不动）
    await nextBtn.click();
    await expect
      .poll(async () => slides.nth(1).getAttribute("aria-current"), { timeout: 2000 })
      .toBe("true");

    await nextBtn.click();
    await expect
      .poll(async () => slides.nth(2).getAttribute("aria-current"), { timeout: 2000 })
      .toBe("true");

    await nextBtn.click();
    // 第 3 次应回到 idx=0 或继续到 idx=3（取决于 slides 总数）
    await expect
      .poll(
        async () => {
          const all = await slides.all();
          for (let i = 0; i < all.length; i++) {
            if ((await all[i]?.getAttribute("aria-current")) === "true") return i;
          }
          return -1;
        },
        { timeout: 2000 },
      )
      .not.toBe(2);
  });
});

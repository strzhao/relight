/**
 * E2E 验收测试（红队）：DailyHero 图片不裁剪契约
 *
 * 设计文档契约（浏览器端）：
 * - `.dh-stage` 改为 align-items: stretch，<img> 不超出 stage 边界
 * - 访问 /?entry=N，<img> getBoundingClientRect() 满足：
 *     imgRect.width ≤ stageRect.width + 1
 *     imgRect.height ≤ stageRect.height + 1
 * - 当原图 aspect ≠ stage aspect 时，至少一边严格相等（contain 行为）
 *
 * 测试策略：
 * - 使用真实后端（dev server 已在 E2E_PORT=5407 运行）
 * - 先 fetch /api/daily/today 判断 entries 数量，数量不足时 throw 让用例失败
 * - 多视口：桌面 1440×900 + 移动 375×812
 *
 * 红队铁律：
 * - 不读取 daily-hero.tsx 实现
 * - 每个用例必须有强 expect 断言
 * - 不用 test.skip / test.fixme / test.fail
 */

import { expect, test } from "@playwright/test";

// ============================================================================
// 辅助：获取今日精选 entries 数量
// ============================================================================

/**
 * 从真实后端 fetch 今日 entries 数量。
 * 失败或 entries 为空时抛出，让调用方决定如何处理。
 */
async function fetchEntriesCount(baseURL: string): Promise<number> {
  const res = await fetch(`${baseURL}/api/daily/today`);
  if (!res.ok) {
    throw new Error(`/api/daily/today 返回 ${res.status}，无法获取 entries`);
  }
  const json = (await res.json()) as { success: boolean; data?: { entries?: unknown[] } };
  if (!json.success || !json.data) {
    throw new Error("/api/daily/today success=false 或 data 为空");
  }
  const entries = json.data.entries ?? [];
  return entries.length;
}

// ============================================================================
// 辅助：测量 <img> 和 stage 的边界矩形
// ============================================================================

/**
 * 在页面中执行 JS，返回 stage 和 img 的 DOMRect。
 *
 * 选择策略：
 * - stage：含 data-testid="dh-stage" 属性的元素
 * - img：stage 内第一个 <img> 元素
 *
 * CONTRACT_AMBIGUOUS: data-testid="dh-stage" 推断自设计文档描述的 ".dh-stage" class；
 * 如果实现使用不同 testid，请对齐后更新此处。
 */
async function measureRects(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    // 尝试多种选择器定位 stage
    const stageSelectors = ['[data-testid="dh-stage"]', ".dh-stage", '[class*="dh-stage"]'];

    let stageEl: Element | null = null;
    for (const sel of stageSelectors) {
      stageEl = document.querySelector(sel);
      if (stageEl) break;
    }

    if (!stageEl) {
      return { error: "找不到 dh-stage 元素，请确认 data-testid 或 class 名称" };
    }

    // stage 内第一个 <img>
    const imgEl = stageEl.querySelector("img");
    if (!imgEl) {
      return { error: "dh-stage 内找不到 <img> 元素" };
    }

    const stageRect = stageEl.getBoundingClientRect();
    const imgRect = imgEl.getBoundingClientRect();

    return {
      stage: {
        width: stageRect.width,
        height: stageRect.height,
        top: stageRect.top,
        left: stageRect.left,
      },
      img: {
        width: imgRect.width,
        height: imgRect.height,
        top: imgRect.top,
        left: imgRect.left,
      },
    };
  });
}

// ============================================================================
// 辅助：核心断言
// ============================================================================

/**
 * 断言 img 不超出 stage（contain 契约）。
 * 误差容忍 ±1px（亚像素渲染）。
 */
function assertNoCrop(
  rects: { stage: { width: number; height: number }; img: { width: number; height: number } },
  label: string,
) {
  const TOLERANCE = 1;

  expect(
    rects.img.width,
    `[${label}] img.width(${rects.img.width.toFixed(1)}) 超出 stage.width(${rects.stage.width.toFixed(1)}) + ${TOLERANCE}px`,
  ).toBeLessThanOrEqual(rects.stage.width + TOLERANCE);

  expect(
    rects.img.height,
    `[${label}] img.height(${rects.img.height.toFixed(1)}) 超出 stage.height(${rects.stage.height.toFixed(1)}) + ${TOLERANCE}px`,
  ).toBeLessThanOrEqual(rects.stage.height + TOLERANCE);
}

/**
 * 等待 DailyHero 加载完成（stage 和 img 都可见）。
 * 超时 15s 以适应首屏 SSR + 数据 fetch。
 */
async function waitForHeroReady(page: import("@playwright/test").Page) {
  // 等待 img 在 stage 内渲染（取任意一种 stage 选择器）
  await page.waitForFunction(
    () => {
      const stageSelectors = ['[data-testid="dh-stage"]', ".dh-stage", '[class*="dh-stage"]'];
      for (const sel of stageSelectors) {
        const stage = document.querySelector(sel);
        if (stage) {
          const img = stage.querySelector("img");
          if (img && img.getBoundingClientRect().width > 0) return true;
        }
      }
      return false;
    },
    { timeout: 15000 },
  );

  // 额外等待图片 load 事件（避免尺寸为 0 的占位状态）
  await page
    .waitForFunction(
      () => {
        const stageSelectors = ['[data-testid="dh-stage"]', ".dh-stage", '[class*="dh-stage"]'];
        for (const sel of stageSelectors) {
          const stage = document.querySelector(sel);
          if (stage) {
            const imgs = stage.querySelectorAll("img");
            // 至少有一张图片 naturalWidth > 0 或 complete=true
            for (const img of imgs) {
              if ((img as HTMLImageElement).complete) return true;
            }
          }
        }
        return false;
      },
      { timeout: 5000 },
    )
    .catch(() => {
      // 图片可能因为跨域等原因 naturalWidth=0，但 complete=false；
      // 不阻断测试，继续用可见尺寸断言
    });
}

// ============================================================================
// 测试套件：桌面视口 1440×900
// ============================================================================

test.describe("DailyHero 图片不裁剪 — 桌面 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /**
   * (a) entry=0（hero 主图）不被裁剪
   */
  test("(a) 访问 / (entry=0)，hero 主图 img 不超出 stage 边界", async ({ page, baseURL }) => {
    // 前置条件：今日有精选数据（entries ≥ 1）
    const count = await fetchEntriesCount(baseURL ?? "http://localhost:5407");
    if (count < 1) {
      // 今日无精选内容，后端数据问题 — 明确失败
      throw new Error(
        `今日精选 entries 数量为 ${count}，无法测试 entry=0。请确认后端已运行 daily-selection job。`,
      );
    }

    await page.goto("/");
    await waitForHeroReady(page);

    const rects = await measureRects(page);

    if ("error" in rects) {
      throw new Error(`measureRects 失败：${rects.error}`);
    }

    assertNoCrop(rects, "desktop entry=0");
  });

  /**
   * (b) entry=1 不被裁剪
   */
  test("(b) 访问 /?entry=1，图片 img 不超出 stage 边界", async ({ page, baseURL }) => {
    const count = await fetchEntriesCount(baseURL ?? "http://localhost:5407");
    if (count < 2) {
      throw new Error(`今日精选 entries 数量为 ${count}，需要 ≥ 2 才能测试 entry=1。`);
    }

    await page.goto("/?entry=1");
    await waitForHeroReady(page);

    const rects = await measureRects(page);

    if ("error" in rects) {
      throw new Error(`measureRects 失败：${rects.error}`);
    }

    assertNoCrop(rects, "desktop entry=1");
  });

  /**
   * (c) entry=2 不被裁剪（landscape 照片场景）
   */
  test("(c) 访问 /?entry=2，图片 img 不超出 stage 边界", async ({ page, baseURL }) => {
    const count = await fetchEntriesCount(baseURL ?? "http://localhost:5407");
    if (count < 3) {
      throw new Error(`今日精选 entries 数量为 ${count}，需要 ≥ 3 才能测试 entry=2。`);
    }

    await page.goto("/?entry=2");
    await waitForHeroReady(page);

    const rects = await measureRects(page);

    if ("error" in rects) {
      throw new Error(`measureRects 失败：${rects.error}`);
    }

    assertNoCrop(rects, "desktop entry=2");
  });

  /**
   * 额外：contain 行为 — 当图片宽高比 ≠ stage 宽高比时，至少一边严格等于 stage
   *
   * 设计文档："当原图 aspect ≠ stage aspect 时至少一边严格相等（contain 行为）"
   * 此断言与 (a) 配对：如果两边都远小于 stage，说明图片未正确 contain（或未渲染）
   */
  test("(a-contain) entry=0 contain 行为：img 至少一边 ≥ stage 对应边 × 0.99", async ({
    page,
    baseURL,
  }) => {
    const count = await fetchEntriesCount(baseURL ?? "http://localhost:5407");
    if (count < 1) {
      throw new Error(`今日精选 entries 数量为 ${count}，无法测试 entry=0 contain 行为。`);
    }

    await page.goto("/");
    await waitForHeroReady(page);

    const rects = await measureRects(page);

    if ("error" in rects) {
      throw new Error(`measureRects 失败：${rects.error}`);
    }

    const { stage, img } = rects;

    // 至少一边：img 的宽或高 ≥ stage 对应维度 × 0.99
    // （0.99 容忍亚像素误差）
    const widthFillsStage = img.width >= stage.width * 0.99;
    const heightFillsStage = img.height >= stage.height * 0.99;

    expect(
      widthFillsStage || heightFillsStage,
      `contain 行为失效：img(${img.width.toFixed(1)}×${img.height.toFixed(1)}) 两边都远小于 stage(${stage.width.toFixed(1)}×${stage.height.toFixed(1)})。图片应 contain 到至少占满一边。`,
    ).toBe(true);
  });
});

// ============================================================================
// 测试套件：移动视口 375×812
// ============================================================================

test.describe("DailyHero 图片不裁剪 — 移动 375×812", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  /**
   * (d) 移动端访问 /，hero 图片不超出 stage
   */
  test("(d) 移动端访问 /，hero 主图 img 不超出 stage 边界", async ({ page, baseURL }) => {
    const count = await fetchEntriesCount(baseURL ?? "http://localhost:5407");
    if (count < 1) {
      throw new Error(`今日精选 entries 数量为 ${count}，移动端无法测试 entry=0。`);
    }

    await page.goto("/");
    await waitForHeroReady(page);

    const rects = await measureRects(page);

    if ("error" in rects) {
      // 移动端可能有不同的布局（如 stage 不渲染），提供清晰错误信息
      throw new Error(
        `移动端 measureRects 失败：${rects.error}。如果移动端布局无 dh-stage，请更新选择器。`,
      );
    }

    assertNoCrop(rects, "mobile entry=0");
  });
});

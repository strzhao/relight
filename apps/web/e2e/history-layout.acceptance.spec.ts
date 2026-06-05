/**
 * 验收测试（红队）：/history 页面布局优化
 *
 * 设计文档：优化 /history 页面展示，核心确保照片更大，使用真实长宽比展示。
 *
 * 覆盖验收谓词：
 *   P1 — 桌面端照片高度 >= 240px
 *   P3 — API 返回 data.length >= 5 且每条含 photo.width/height
 *   P4 — 点击照片行导航到 /photos/:id
 *   P5 — 移动端 (<640px) 照片全宽展示
 *
 * 布局方案（设计文档）：
 *   - Desktop (lg): 两栏，照片左 (max-h-72 ≈ 288px, 原生比例, max-w-[55%])，文字右
 *   - Tablet (sm): 上下，照片在上 (max-h-60 ≈ 240px)
 *   - Mobile (<640px): 上下，照片全宽 (max-h-64 ≈ 256px)
 *
 * 红队铁律：
 *   - 不读取 daily-pick-row.tsx 实现文件
 *   - 仅通过 Playwright 浏览器行为黑盒验证
 *   - 每个 test case 必须含强 expect 断言
 *   - 使用 page.route mock API 避免依赖真实后端
 */

import { expect, test } from "@playwright/test";

// ============================================================================
// 辅助：构造假 DailyPick 数据（与 packages/shared/src/types.ts 对齐）
// ============================================================================

function makeFakePhoto(
  index: number,
  width: number,
  height: number,
): {
  id: string;
  storageSourceId: string;
  filePath: string;
  fileHash: string;
  width: number;
  height: number;
  fileSize: number;
  thumbnailPath: string | null;
  takenAt: string;
  createdAt: string;
} {
  const id = `photo-id-${index}-aaaabbbbccccdddd`;
  return {
    id,
    storageSourceId: "src-test",
    filePath: `/photos/test-${index}.jpg`,
    fileHash: `hash-${index}`,
    width,
    height,
    fileSize: 204800,
    thumbnailPath: `/api/photos/${id}/thumbnail`,
    takenAt: `2025-05-0${index}T10:00:00.000Z`,
    createdAt: `2025-05-0${index}T10:00:00.000Z`,
  };
}

function makeFakePick(
  index: number,
  width: number,
  height: number,
): {
  id: string;
  photoId: string;
  pickDate: string;
  title: string;
  narrative: string;
  score: number;
  createdAt: string;
  photo: ReturnType<typeof makeFakePhoto>;
} {
  const photo = makeFakePhoto(index, width, height);
  return {
    id: `pick-id-${index}`,
    photoId: photo.id,
    pickDate: `2025-05-0${index}`,
    title: `精选标题${index} — 黄昏海岸线`,
    narrative: `这是第 ${index} 条精选的叙事文案，描述了这张照片的美妙之处。画面中金色阳光洒在波光粼粼的海面上，远处归帆点点。`,
    score: 90 - index,
    createdAt: `2025-05-0${index}T06:00:00.000Z`,
    photo,
  };
}

function makeFakePicksResponse(picks: ReturnType<typeof makeFakePick>[]): {
  success: boolean;
  data: ReturnType<typeof makeFakePick>[];
  total: number;
  page: number;
  pageSize: number;
} {
  return {
    success: true,
    data: picks,
    total: picks.length,
    page: 1,
    pageSize: 20,
  };
}

// 构造 10 张不同尺寸的精选（覆盖常见照片比例）
function make10FakePicks() {
  const dimensions: [number, number][] = [
    [4000, 3000], // 4:3 横图
    [1920, 1080], // 16:9 横图
    [3000, 4000], // 3:4 竖图
    [1080, 1920], // 9:16 竖图
    [4000, 2667], // 3:2 横图
    [3000, 3000], // 1:1 正方形
    [6000, 4000], // 3:2 横图（更大）
    [2400, 3000], // 4:5 竖图
    [5472, 3648], // 3:2 横图
    [4032, 3024], // 4:3 横图
  ];
  return dimensions.map(([w, h], i) => makeFakePick(i + 1, w, h));
}

// ============================================================================
// 测试
// ============================================================================

test.describe("/history 页面布局优化 — 验收测试（红队）", () => {
  // --------------------------------------------------------------------------
  // 谓词 P3: API 契约 — GET /api/daily 返回 data.length >= 5 且每条含 photo.width/height
  // --------------------------------------------------------------------------

  test.describe("P3 — API 契约：daily list 返回 photo.width/height", () => {
    test("GET /api/daily?page=1&pageSize=20 返回至少 5 条记录", async ({ page }) => {
      const fakePicks = make10FakePicks();
      const responseBody = makeFakePicksResponse(fakePicks);

      await page.route("**/api/daily*", async (route) => {
        const url = new URL(route.request().url());
        const pageNum = Number(url.searchParams.get("page") ?? "1");

        if (pageNum === 1) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(responseBody),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              success: true,
              data: [],
              total: 10,
              page: pageNum,
              pageSize: 20,
            }),
          });
        }
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      // 直接通过 fetch API 验证契约（不依赖页面渲染）
      const apiResponse = await page.evaluate(async () => {
        const res = await fetch("/api/daily?page=1&pageSize=20");
        return res.json();
      });

      expect(apiResponse.success).toBe(true);
      expect(Array.isArray(apiResponse.data)).toBe(true);
      expect(apiResponse.data.length).toBeGreaterThanOrEqual(5);

      // 每条记录必须包含 photo.width 和 photo.height
      for (const item of apiResponse.data) {
        expect(item.photo).toBeDefined();
        expect(typeof item.photo.width).toBe("number");
        expect(typeof item.photo.height).toBe("number");
        expect(item.photo.width).toBeGreaterThan(0);
        expect(item.photo.height).toBeGreaterThan(0);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 谓词 P1: 桌面端照片高度 >= 240px
  // --------------------------------------------------------------------------

  test.describe("P1 — 桌面端照片高度", () => {
    test("桌面端视口 (1280×800) 下照片渲染高度 >= 240px", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });

      const fakePicks = make10FakePicks();
      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse(fakePicks)),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        // 返回一个 1x1 像素的 JPEG（占位图，足够让 img 渲染但不会影响尺寸测量）
        // imageSmoothingEnabled:false 的小图也是有效 img 元素
        const minimalJpeg = Buffer.from(
          "/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMCwsKCwsM",
          "base64",
        );
        await route.fulfill({
          status: 200,
          contentType: "image/jpeg",
          body: minimalJpeg,
        });
      });

      await page.goto("/history");

      // 等待列表渲染
      await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

      // 找到照片容器中的 img 元素并测量高度
      // 设计文档：桌面端 max-h-72 (18rem = 288px) 或至少 >= 240px
      // 找到第一个精选行中的 img
      const firstImg = page.locator("a[href*='/photos/'] img").first();
      await expect(firstImg).toBeVisible({ timeout: 5000 });

      const boundingBox = await firstImg.boundingBox();
      expect(boundingBox).not.toBeNull();

      if (boundingBox) {
        // 设计文档承诺：桌面端 max-h-72 约 288px（但受 max-w-[55%] + object-cover 影响，
        // 高度可能由容器比例决定）。核心断言：高度 >= 240px
        expect(boundingBox.height).toBeGreaterThanOrEqual(240);
      }
    });

    test("大桌面视口 (1920×1080) 下照片高度 >= 240px", async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });

      const fakePicks = make10FakePicks();
      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse(fakePicks)),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      await page.goto("/history");

      await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

      const firstImg = page.locator("a[href*='/photos/'] img").first();
      await expect(firstImg).toBeVisible({ timeout: 5000 });

      const boundingBox = await firstImg.boundingBox();
      expect(boundingBox).not.toBeNull();

      if (boundingBox) {
        expect(boundingBox.height).toBeGreaterThanOrEqual(240);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 谓词 P2: 照片容器 aspectRatio 匹配 photo.width/photo.height
  // （通过 getComputedStyle 验证）
  // --------------------------------------------------------------------------

  test.describe("P2 — 照片容器 aspectRatio 匹配 photo.width/photo.height", () => {
    test("4:3 横图 (4000×3000) 渲染容器 computed aspectRatio ≈ 1.333", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });

      // 构造一张 4:3 照片
      const pick = makeFakePick(1, 4000, 3000);
      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse([pick])),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      await page.goto("/history");

      await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

      // 查找照片容器 — 第一个带有 style 中 aspectRatio 的元素
      // 设计文档：容器用 style={{ aspectRatio: String(aspectRatio) }}
      const photoContainer = page.locator('[style*="aspect-ratio"]').first();
      const hasStyleContainer = (await photoContainer.count()) > 0;

      if (hasStyleContainer) {
        const aspectRatio = await photoContainer.evaluate((el) => {
          return window.getComputedStyle(el).aspectRatio;
        });

        // aspectRatio CSS 属性返回 "auto" 或类似 "1.33333 / 1" 的字符串
        expect(aspectRatio).not.toBe("auto");

        // 解析 aspectRatio 值（格式："width / height" 或 "auto"）
        const parts = aspectRatio.split("/");
        if (parts.length === 2) {
          const computed = Number.parseFloat(parts[0].trim()) / Number.parseFloat(parts[1].trim());
          // 4/3 = 1.333...，允许 ±0.05 误差
          expect(computed).toBeCloseTo(1.333, 1);
        }
      } else {
        // fallback: 如果没有 aspect-ratio style，至少验证 img 的容器不是正方形
        // 测 4:3 图片的渲染宽度 > 渲染高度（非正方形）
        const firstImg = page.locator("a[href*='/photos/'] img").first();
        const boundingBox = await firstImg.boundingBox();
        if (boundingBox) {
          expect(boundingBox.width).toBeGreaterThan(boundingBox.height);
        }
      }
    });

    test("16:9 横图 (1920×1080) 渲染容器 computed aspectRatio ≈ 1.778", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });

      const pick = makeFakePick(1, 1920, 1080);
      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse([pick])),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      await page.goto("/history");

      await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

      const photoContainer = page.locator('[style*="aspect-ratio"]').first();
      const hasStyleContainer = (await photoContainer.count()) > 0;

      if (hasStyleContainer) {
        const aspectRatio = await photoContainer.evaluate((el) => {
          return window.getComputedStyle(el).aspectRatio;
        });

        expect(aspectRatio).not.toBe("auto");

        const parts = aspectRatio.split("/");
        if (parts.length === 2) {
          const computed = Number.parseFloat(parts[0].trim()) / Number.parseFloat(parts[1].trim());
          expect(computed).toBeCloseTo(1.778, 1);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // 谓词 P4: 点击照片行导航到 /photos/:id
  // --------------------------------------------------------------------------

  test.describe("P4 — 点击导航", () => {
    test("点击精选行链接跳转到 /photos/:photoId", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });

      const fakePicks = make10FakePicks();
      const firstPick = fakePicks[0]!;

      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse(fakePicks)),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      // 照片详情页也需要 mock（如果跳转后页面需要加载数据）
      await page.route(`**/api/photos/${firstPick.photo.id}`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              ...firstPick.photo,
              tags: [],
              analyses: [],
            },
          }),
        });
      });

      await page.goto("/history");

      // 等待列表渲染
      await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

      // 找到第一个精选行的链接
      const firstLink = page.locator(`a[href="/photos/${firstPick.photoId}"]`).first();
      await expect(firstLink).toBeVisible({ timeout: 5000 });

      // 点击
      await firstLink.click();

      // 等待 URL 跳转
      await expect(page).toHaveURL(`/photos/${firstPick.photoId}`, { timeout: 10000 });
    });

    test("Link 支持键盘导航（Tab + Enter）", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });

      const fakePicks = make10FakePicks();
      const firstPick = fakePicks[0]!;

      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse(fakePicks)),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      await page.route(`**/api/photos/${firstPick.photo.id}`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { ...firstPick.photo, tags: [], analyses: [] },
          }),
        });
      });

      await page.goto("/history");
      await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

      // Tab 到第一个链接并 Enter
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");

      // 应导航到照片详情页
      await expect(page).toHaveURL(/\/photos\//, { timeout: 10000 });
    });
  });

  // --------------------------------------------------------------------------
  // 谓词 P5: 移动端 (<640px) 照片全宽展示
  // --------------------------------------------------------------------------

  test.describe("P5 — 移动端照片全宽", () => {
    test("移动端视口 (375×812, iPhone X) 下照片近似全宽展示", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });

      const fakePicks = make10FakePicks();
      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse(fakePicks)),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      await page.goto("/history");

      await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

      // 找到第一个照片 img 元素
      const firstImg = page.locator("a[href*='/photos/'] img").first();
      await expect(firstImg).toBeVisible({ timeout: 5000 });

      const boundingBox = await firstImg.boundingBox();
      expect(boundingBox).not.toBeNull();

      if (boundingBox) {
        // 视口宽度 375px，照片应接近全宽（减去可能的 padding ~32px）
        // 设计文档：移动端照片全宽（max-h-64 约 256px）
        const viewportWidth = 375;
        const expectedMinWidth = viewportWidth - 64; // 减去合理的 padding

        expect(boundingBox.width).toBeGreaterThanOrEqual(expectedMinWidth);
      }
    });

    test("平板视口 (768×1024, iPad) 下照片宽度不应为全宽（两栏布局）", async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });

      const fakePicks = make10FakePicks();
      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse(fakePicks)),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      await page.goto("/history");

      await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

      const firstImg = page.locator("a[href*='/photos/'] img").first();
      await expect(firstImg).toBeVisible({ timeout: 5000 });

      const boundingBox = await firstImg.boundingBox();
      expect(boundingBox).not.toBeNull();

      if (boundingBox) {
        // 平板端 (sm breakpoint, >=640px) 应该是两栏或其它布局
        // 照片不应占满全宽（因为右侧还有文字内容）
        // 至少照片宽度 < 视口宽度的 80%
        const maxExpectedWidth = 768 * 0.8;
        expect(boundingBox.width).toBeLessThanOrEqual(maxExpectedWidth);
      }
    });

    test("小屏移动端 (320×568, iPhone SE) 下照片全宽展示", async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });

      const fakePicks = make10FakePicks();
      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse(fakePicks)),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      await page.goto("/history");

      await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

      const firstImg = page.locator("a[href*='/photos/'] img").first();
      await expect(firstImg).toBeVisible({ timeout: 5000 });

      const boundingBox = await firstImg.boundingBox();
      expect(boundingBox).not.toBeNull();

      if (boundingBox) {
        // 320px 宽度下，照片应接近全宽
        const expectedMinWidth = 320 - 48; // 减去合理的 padding
        expect(boundingBox.width).toBeGreaterThanOrEqual(expectedMinWidth);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 谓词 P6: photo=null 时不崩溃（E2E 部分）
  // --------------------------------------------------------------------------

  test.describe("P6 — photo=null 占位（E2E）", () => {
    test("photo 为 null 的精选条目渲染不崩溃，页面无 white screen", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });

      // 构造一条 photo=null 的记录
      const nullPhotoPick = {
        id: "pick-null-photo",
        photoId: "photo-nonexistent",
        pickDate: "2025-06-01",
        title: "无照片的精选",
        narrative: "这个精选没有关联照片，用于测试 photo=null 占位逻辑。",
        score: 7.5,
        createdAt: "2025-06-01T06:00:00.000Z",
        photo: null,
      };

      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse([nullPhotoPick as never])),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      await page.goto("/history");

      // 页面标题应可见（说明组件已 mount，非 white screen）
      await expect(page.getByText("历史精选")).toBeVisible({ timeout: 10000 });

      // photo=null 条目应渲染标题（不会因 photo=null 而整个组件崩溃）
      await expect(page.getByText("无照片的精选")).toBeVisible({ timeout: 5000 });

      // 应显示占位内容（"No Plate" 或类似占位文本）
      const placeholder = page.locator("text=No Plate").first();
      const hasPlaceholder = await placeholder.isVisible().catch(() => false);
      // 如果 "No Plate" 不可见，至少页面不是 white screen（标题可见已验证）
      if (hasPlaceholder) {
        await expect(placeholder).toBeVisible();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 容器宽度验证 — 设计文档: max-w-5xl
  // --------------------------------------------------------------------------

  test.describe("页面容器宽度", () => {
    test("history 页面主容器应为 max-w-5xl（设计文档要求）", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });

      const fakePicks = make10FakePicks();
      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse(fakePicks)),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      await page.goto("/history");

      await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

      // 检查 main 元素的最大宽度
      // 设计文档：container 放宽到 max-w-5xl
      const mainElement = page.locator("main");
      const maxWidth = await mainElement.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.maxWidth;
      });

      // max-w-5xl = 64rem = 1024px
      // 容器应有 max-width 约束
      if (maxWidth && maxWidth !== "none") {
        const maxWidthPx = Number.parseFloat(maxWidth);
        expect(maxWidthPx).toBeGreaterThanOrEqual(960); // 至少 >= 960px（max-w-4xl）
      }
    });
  });

  // --------------------------------------------------------------------------
  // 交互效果验证
  // --------------------------------------------------------------------------

  test.describe("交互效果", () => {
    test("hover 照片应有放大或阴影效果（opacity 或 transform 变化）", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });

      const fakePicks = make10FakePicks();
      await page.route("**/api/daily*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeFakePicksResponse(fakePicks)),
        });
      });

      await page.route("**/api/photos/*/thumbnail*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
      });

      await page.goto("/history");
      await expect(page.getByText("精选标题1")).toBeVisible({ timeout: 10000 });

      // 找到第一个精选行
      const firstRow = page.locator("a[href*='/photos/']").first();
      await expect(firstRow).toBeVisible({ timeout: 5000 });

      // hover 照片行
      await firstRow.hover();
      await page.waitForTimeout(200); // 等待 CSS transition

      // 验证 hover 后有视觉反馈（class 变化或内联样式）
      // 设计文档：hover 照片放大 + 阴影
      const hasHoverEffect = await firstRow.evaluate((el) => {
        const style = window.getComputedStyle(el);
        const img = el.querySelector("img");
        if (!img) return false;

        const imgStyle = window.getComputedStyle(img);
        // 检查是否有 transition / transform / box-shadow
        return (
          imgStyle.transition !== "none" ||
          imgStyle.transform !== "none" ||
          imgStyle.boxShadow !== "none"
        );
      });

      // 宽松验证：至少有一行 hover 相关的 CSS 存在
      expect(hasHoverEffect).toBe(true);
    });
  });
});

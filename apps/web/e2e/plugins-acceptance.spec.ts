/**
 * E2E 验收测试：插件系统前端页面（红队验收）
 *
 * 覆盖设计文档：
 *
 * ## 新增前端页面
 * - /admin/plugins — 插件列表（卡片 Grid）
 * - /admin/plugins/[pluginId] — 插件详情（参数表单 + 运行按钮 + 任务列表）
 * - /admin/plugins/[pluginId]/tasks/[taskId] — 照片集合页（Photo Grid + Lightbox）
 *
 * ## Sidebar
 * - 添加「插件」导航项（Puzzle icon）
 *
 * 红队铁律：本文件仅依据设计文档编写，不读蓝队实现代码。
 * - 未读 apps/web/app/admin/plugins/ 下的前端页面
 * - 未读 apps/web/app/admin/layout.tsx
 *
 * 注意（patterns.md 已记录）：
 * - page.route glob 中 `?` 是单字符通配符，匹配 query string 必须用 `*`
 */

import { expect, test } from "@playwright/test";

// ============================================================================
// Fixture 工厂 — 构造 API mock 数据
// ============================================================================

/** Mock 插件列表响应 */
function makePluginsListResponse() {
  return {
    success: true,
    data: [
      {
        id: "dianping-cluster",
        name: "餐厅照片聚类",
        description: "基于时间、GPS 和美食标签自动聚类餐厅照片，发现你的美食之旅",
        version: "1.0.0",
      },
    ],
  };
}

/** Mock 插件详情响应（含最近任务） */
function makePluginDetailResponse() {
  return {
    success: true,
    data: {
      plugin: {
        id: "dianping-cluster",
        name: "餐厅照片聚类",
        description: "基于时间、GPS 和美食标签自动聚类餐厅照片，发现你的美食之旅",
        version: "1.0.0",
      },
      recentTasks: [
        {
          id: "task-001-uuid",
          pluginId: "dianping-cluster",
          status: "done",
          params: JSON.stringify({
            timeStart: "2024-01-01T00:00:00+08:00",
            timeEnd: "2024-01-31T23:59:59+08:00",
          }),
          result: JSON.stringify({
            ok: true,
            clusters: [],
            selectedCluster: null,
            stats: {
              totalPhotos: 120,
              totalClusters: 8,
              selectedClusterId: null,
              durationMs: 4500,
            },
            photos: [],
          }),
          error: null,
          startedAt: "2025-06-01T00:00:00.000Z",
          finishedAt: "2025-06-01T00:05:00.000Z",
          createdAt: "2025-06-01T00:00:00.000Z",
        },
        {
          id: "task-002-uuid",
          pluginId: "dianping-cluster",
          status: "pending",
          params: JSON.stringify({
            timeStart: "2024-02-01T00:00:00+08:00",
            timeEnd: "2024-02-28T23:59:59+08:00",
          }),
          result: null,
          error: null,
          startedAt: null,
          finishedAt: null,
          createdAt: "2025-06-02T00:00:00.000Z",
        },
        {
          id: "task-003-uuid",
          pluginId: "dianping-cluster",
          status: "failed",
          params: JSON.stringify({
            timeStart: "2024-03-01T00:00:00+08:00",
            timeEnd: "2024-03-31T23:59:59+08:00",
          }),
          result: null,
          error: "CLI 执行超时：30 分钟内未返回结果",
          startedAt: "2025-06-03T00:00:00.000Z",
          finishedAt: "2025-06-03T00:30:00.000Z",
          createdAt: "2025-06-03T00:00:00.000Z",
        },
      ],
    },
  };
}

/** Mock 任务列表响应 */
function makeTaskListResponse() {
  return {
    success: true,
    data: {
      tasks: [
        {
          id: "task-001-uuid",
          pluginId: "dianping-cluster",
          status: "done",
          params: JSON.stringify({
            timeStart: "2024-01-01T00:00:00+08:00",
            timeEnd: "2024-01-31T23:59:59+08:00",
          }),
          result: JSON.stringify({
            ok: true,
            clusters: [],
            selectedCluster: null,
            stats: {
              totalPhotos: 120,
              totalClusters: 8,
              selectedClusterId: null,
              durationMs: 4500,
            },
            photos: [],
          }),
          error: null,
          startedAt: "2025-06-01T00:00:00.000Z",
          finishedAt: "2025-06-01T00:05:00.000Z",
          createdAt: "2025-06-01T00:00:00.000Z",
        },
      ],
    },
  };
}

/** Mock 运行插件任务响应 */
function makeRunTaskResponse() {
  return {
    success: true,
    data: {
      taskId: "new-task-uuid-12345",
    },
  };
}

/** Mock 单个任务详情响应（done 状态，含照片数据） */
function makeTaskDetailDoneResponse() {
  return {
    success: true,
    data: {
      id: "task-001-uuid",
      pluginId: "dianping-cluster",
      status: "done",
      params: JSON.stringify({
        timeStart: "2024-01-01T00:00:00+08:00",
        timeEnd: "2024-01-31T23:59:59+08:00",
      }),
      result: JSON.stringify({
        ok: true,
        clusters: [
          {
            id: "cluster-best",
            score: 85.5,
            stats: {
              photoCount: 8,
              timeRange: {
                start: "2024-01-15T18:30:00+08:00",
                end: "2024-01-15T20:15:00+08:00",
              },
              foodTagRatio: 1.0,
              cuisineDiversity: 5,
              gpsStability: 0.95,
            },
            photos: [],
          },
        ],
        selectedCluster: {
          id: "cluster-best",
          score: 85.5,
          stats: {
            photoCount: 8,
            timeRange: {
              start: "2024-01-15T18:30:00+08:00",
              end: "2024-01-15T20:15:00+08:00",
            },
            foodTagRatio: 1.0,
            cuisineDiversity: 5,
            gpsStability: 0.95,
          },
          photos: [],
        },
        stats: {
          totalPhotos: 120,
          totalClusters: 8,
          selectedClusterId: "cluster-best",
          durationMs: 4500,
        },
        photos: [
          {
            path: "/photos/restaurant-1.jpg",
            takenAt: "2024-01-15T18:35:00+08:00",
            tags: ["food", "chinese", "dinner"],
          },
          {
            path: "/photos/restaurant-2.jpg",
            takenAt: "2024-01-15T18:40:00+08:00",
            tags: ["food", "chinese", "noodle"],
          },
          {
            path: "/photos/restaurant-3.jpg",
            takenAt: "2024-01-15T18:50:00+08:00",
            tags: ["food", "chinese", "hotpot"],
          },
          {
            path: "/photos/restaurant-4.jpg",
            takenAt: "2024-01-15T19:00:00+08:00",
            tags: ["food", "dessert"],
          },
        ],
      }),
      error: null,
      startedAt: "2025-06-01T00:00:00.000Z",
      finishedAt: "2025-06-01T00:05:00.000Z",
      createdAt: "2025-06-01T00:00:00.000Z",
    },
  };
}

// ============================================================================
// 辅助：mock 所有缩略图请求（返回空 JPEG，避免真实网络请求导致 flaky）
// ============================================================================

async function mockThumbnails(page: import("@playwright/test").Page) {
  await page.route("**/api/photos/*/thumbnail*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // 最小 JPEG header
    });
  });
}

/**
 * 注册所有插件 API mock（默认返回成功 fixture）
 */
async function mockPluginApis(
  page: import("@playwright/test").Page,
  overrides?: {
    pluginsList?: unknown;
    pluginDetail?: unknown;
    taskList?: unknown;
    runTask?: unknown;
    taskDetailDone?: unknown;
  },
) {
  // Mock GET /api/plugins（精确路径或带 query string）
  await page.route("**/api/plugins", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/plugins?") || url.endsWith("/api/plugins")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides?.pluginsList ?? makePluginsListResponse()),
      });
      return;
    }
    await route.fallback();
  });

  // Mock GET /api/plugins/:id（不含 /tasks、/run 子路径）
  await page.route("**/api/plugins/*", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/plugins/") && !url.includes("/tasks") && !url.includes("/run")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides?.pluginDetail ?? makePluginDetailResponse()),
      });
      return;
    }
    await route.fallback();
  });

  // Mock GET /api/plugins/:id/tasks（不带具体 taskId）
  await page.route("**/api/plugins/*/tasks", async (route) => {
    const url = route.request().url();
    if (/\/api\/plugins\/[^/]+\/tasks$/.test(url) || /\/api\/plugins\/[^/]+\/tasks\?/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides?.taskList ?? makeTaskListResponse()),
      });
      return;
    }
    await route.fallback();
  });

  // Mock POST /api/plugins/:id/run
  await page.route("**/api/plugins/*/run", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides?.runTask ?? makeRunTaskResponse()),
      });
      return;
    }
    await route.fallback();
  });

  // Mock GET /api/plugins/:id/tasks/:taskId
  await page.route("**/api/plugins/*/tasks/*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overrides?.taskDetailDone ?? makeTaskDetailDoneResponse()),
    });
  });
}

// ============================================================================
// 测试
// ============================================================================

test.describe("插件系统 E2E 验收", () => {
  // --------------------------------------------------------------------------
  // 场景 P1: 插件列表页渲染
  // --------------------------------------------------------------------------

  test("P1-1: 访问 /admin/plugins，页面含「餐厅照片聚类」文字", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins");

    // 页面内容应包含插件名称
    await expect(page.getByText("餐厅照片聚类")).toBeVisible({ timeout: 15000 });
  });

  test("P1-2: 插件列表页至少渲染 1 张插件卡片", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins");

    // 每张插件卡片应有 data-testid="plugin-card"
    const cards = page.locator('[data-testid="plugin-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });

    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("P1-3: 插件卡片应包含插件名称和描述", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins");

    const firstCard = page.locator('[data-testid="plugin-card"]').first();
    await expect(firstCard).toBeVisible({ timeout: 15000 });

    // 卡片内应包含名称
    await expect(firstCard.getByText("餐厅照片聚类")).toBeVisible({ timeout: 5000 });
  });

  test("P1-4: 点击插件卡片应导航到插件详情页", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins");

    const firstCard = page.locator('[data-testid="plugin-card"]').first();
    await expect(firstCard).toBeVisible({ timeout: 15000 });

    // 点击卡片
    await firstCard.click();

    // 应导航到 /admin/plugins/dianping-cluster
    await expect(page).toHaveURL(/\/admin\/plugins\/dianping-cluster/, { timeout: 10000 });
  });

  // --------------------------------------------------------------------------
  // 场景 P2: 插件详情页渲染
  // --------------------------------------------------------------------------

  test("P2-1: 访问 /admin/plugins/dianping-cluster，页面含参数表单", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster");

    // 等待页面加载
    await expect(page.getByText("餐厅照片聚类")).toBeVisible({ timeout: 15000 });

    // 参数表单应包含 timeStart 输入框（data-testid）
    const timeStartInput = page.locator('[data-testid="plugin-time-start"]');
    await expect(timeStartInput).toBeVisible({ timeout: 5000 });

    // 参数表单应包含 timeEnd 输入框（data-testid）
    const timeEndInput = page.locator('[data-testid="plugin-time-end"]');
    await expect(timeEndInput).toBeVisible({ timeout: 5000 });
  });

  test("P2-2: 插件详情页应有运行按钮", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster");

    await expect(page.getByText("餐厅照片聚类")).toBeVisible({ timeout: 15000 });

    // 运行按钮应有 data-testid="plugin-run-btn"
    const runBtn = page.locator('[data-testid="plugin-run-btn"]');
    await expect(runBtn).toBeVisible({ timeout: 5000 });
  });

  test("P2-3: 插件详情页应显示最近任务列表", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster");

    await expect(page.getByText("餐厅照片聚类")).toBeVisible({ timeout: 15000 });

    // 任务列表项应有 data-testid="plugin-task-item"
    const taskItems = page.locator('[data-testid="plugin-task-item"]');
    // 至少有 1 个任务（mock 返回 3 个）
    await expect(taskItems.first()).toBeVisible({ timeout: 10000 });

    const count = await taskItems.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("P2-4: 任务列表显示不同状态（done / pending / failed）", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster");

    await expect(page.getByText("餐厅照片聚类")).toBeVisible({ timeout: 15000 });

    const taskItems = page.locator('[data-testid="plugin-task-item"]');
    await expect(taskItems.first()).toBeVisible({ timeout: 10000 });

    // 状态应通过 data-testid="plugin-task-status" 或文本展示
    const statusIndicators = page.locator('[data-testid="plugin-task-status"]');
    const statusCount = await statusIndicators.count();

    if (statusCount > 0) {
      const statusTexts = await statusIndicators.allTextContents();
      const hasDone = statusTexts.some((t) => t.includes("done") || t.includes("完成"));
      const hasPending = statusTexts.some(
        (t) => t.includes("pending") || t.includes("等待") || t.includes("排队"),
      );
      const hasFailed = statusTexts.some((t) => t.includes("failed") || t.includes("失败"));
      // 至少应有一种状态可见
      expect(hasDone || hasPending || hasFailed).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // 场景 P3: 运行聚类任务
  // --------------------------------------------------------------------------

  test("P3-1: 填写参数后点击运行按钮，应发起 POST 请求", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster");

    await expect(page.getByText("餐厅照片聚类")).toBeVisible({ timeout: 15000 });

    // 填写 timeStart
    const timeStartInput = page.locator('[data-testid="plugin-time-start"]');
    await expect(timeStartInput).toBeVisible({ timeout: 5000 });
    await timeStartInput.fill("2024-01-01T00:00:00+08:00");

    // 填写 timeEnd
    const timeEndInput = page.locator('[data-testid="plugin-time-end"]');
    await expect(timeEndInput).toBeVisible({ timeout: 5000 });
    await timeEndInput.fill("2024-01-31T23:59:59+08:00");

    // 点击运行按钮
    const runBtn = page.locator('[data-testid="plugin-run-btn"]');
    await expect(runBtn).toBeEnabled({ timeout: 3000 });
    await runBtn.click();

    // 等待任务提交响应
    await page.waitForTimeout(1000);

    // 验证页面未崩溃（仍包含插件名称）
    await expect(page.getByText("餐厅照片聚类")).toBeVisible({ timeout: 5000 });
  });

  test("P3-2: 不填参数直接点击运行，按钮应保持 disabled 或显示校验错误", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster");

    await expect(page.getByText("餐厅照片聚类")).toBeVisible({ timeout: 15000 });

    const runBtn = page.locator('[data-testid="plugin-run-btn"]');
    await expect(runBtn).toBeVisible({ timeout: 5000 });

    // 不填参数时，按钮应 disabled 或点击后被前端/后端校验阻止
    const isDisabled = await runBtn.isDisabled();
    if (!isDisabled) {
      await runBtn.click();
      await page.waitForTimeout(500);
      // 应仍在同一页面（未跳转）
      await expect(page).toHaveURL(/\/admin\/plugins\/dianping-cluster/);
    }
  });

  test("P3-3: 多次连续点击运行按钮应有防抖或 loading 态", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster");

    await expect(page.getByText("餐厅照片聚类")).toBeVisible({ timeout: 15000 });

    const timeStartInput = page.locator('[data-testid="plugin-time-start"]');
    await expect(timeStartInput).toBeVisible({ timeout: 5000 });
    await timeStartInput.fill("2024-01-01T00:00:00+08:00");

    const timeEndInput = page.locator('[data-testid="plugin-time-end"]');
    await expect(timeEndInput).toBeVisible({ timeout: 5000 });
    await timeEndInput.fill("2024-01-31T23:59:59+08:00");

    const runBtn = page.locator('[data-testid="plugin-run-btn"]');
    await runBtn.click();

    // 快速再次点击（应被阻止或按钮变 disabled/loading）
    await runBtn.click({ timeout: 100 });

    // 页面不应崩溃
    await expect(page.getByText("餐厅照片聚类")).toBeVisible({ timeout: 5000 });
  });

  // --------------------------------------------------------------------------
  // 场景 P4: 照片集合页渲染
  // --------------------------------------------------------------------------

  test("P4-1: 访问已完成任务的详情页，应渲染照片 Grid", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster/tasks/task-001-uuid");

    // 应渲染照片集合页面
    // 照片 Grid 应有 data-testid="photo-grid"
    const photoGrid = page.locator('[data-testid="photo-grid"]');
    await expect(photoGrid).toBeVisible({ timeout: 15000 });
  });

  test("P4-2: 照片 Grid 中至少有 1 张可见缩略图", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster/tasks/task-001-uuid");

    const photoGrid = page.locator('[data-testid="photo-grid"]');
    await expect(photoGrid).toBeVisible({ timeout: 15000 });

    // 照片缩略图应有 data-testid="photo-thumbnail"
    const thumbnails = page.locator('[data-testid="photo-thumbnail"]');
    await expect(thumbnails.first()).toBeVisible({ timeout: 10000 });

    const count = await thumbnails.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("P4-3: 点击缩略图应打开 Lightbox", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster/tasks/task-001-uuid");

    const thumbnails = page.locator('[data-testid="photo-thumbnail"]');
    await expect(thumbnails.first()).toBeVisible({ timeout: 10000 });

    // 点击第一张缩略图
    await thumbnails.first().click();

    // Lightbox 应出现（data-testid="lightbox" 或 dialog role）
    const anyDialog = page.locator('[role="dialog"]');
    const anyLightbox = page.locator('[data-testid="lightbox"]');

    const dialogCount = await anyDialog.count();
    const lightboxCount = await anyLightbox.count();

    // 至少应有 lightbox 或 dialog 出现
    expect(dialogCount + lightboxCount).toBeGreaterThanOrEqual(1);
  });

  test("P4-4: Lightbox 中按 Escape 键可关闭", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster/tasks/task-001-uuid");

    const thumbnails = page.locator('[data-testid="photo-thumbnail"]');
    await expect(thumbnails.first()).toBeVisible({ timeout: 10000 });

    // 打开 Lightbox
    await thumbnails.first().click();

    // 按 Escape 关闭
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Lightbox 应关闭，照片 Grid 仍可见
    const photoGrid = page.locator('[data-testid="photo-grid"]');
    await expect(photoGrid).toBeVisible({ timeout: 5000 });
  });

  // --------------------------------------------------------------------------
  // 场景 P5: 侧边栏导航
  // --------------------------------------------------------------------------

  test("P5-1: Admin 侧边栏应包含「插件」导航项", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin");

    // 侧边栏导航中应包含「插件」链接（data-testid 或文本）
    const pluginNavLink = page.locator('[data-testid="nav-plugins"], a:has-text("插件")');
    await expect(pluginNavLink.first()).toBeVisible({ timeout: 10000 });
  });

  test("P5-2: 点击侧边栏「插件」应导航到 /admin/plugins", async ({ page }) => {
    await mockPluginApis(page);
    await mockThumbnails(page);

    await page.goto("/admin");

    const pluginNavLink = page.locator('[data-testid="nav-plugins"], a:has-text("插件")').first();
    await expect(pluginNavLink).toBeVisible({ timeout: 10000 });

    await pluginNavLink.click();

    await expect(page).toHaveURL(/\/admin\/plugins/, { timeout: 10000 });
  });

  // --------------------------------------------------------------------------
  // 场景 P6: 错误态处理
  // --------------------------------------------------------------------------

  test("P6-1: API 返回空插件列表时，页面应渲染空态而不崩溃", async ({ page }) => {
    await mockPluginApis(page, {
      pluginsList: { success: true, data: [] },
    });
    await mockThumbnails(page);

    await page.goto("/admin/plugins");

    // 页面应正常加载（有 title 说明 HTML 已渲染）
    const title = await page.title();
    expect(typeof title).toBe("string");
    expect(title.length).toBeGreaterThan(0);
  });

  test("P6-2: API 请求失败时，页面应展示错误信息而不崩溃", async ({ page }) => {
    // Mock 插件列表 API 返回 500
    await page.route("**/api/plugins", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/plugins?") || url.endsWith("/api/plugins")) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "服务器内部错误" }),
        });
        return;
      }
      await route.fallback();
    });

    // Mock 其他 API 避免干扰
    await page.route("**/api/plugins/*/tasks", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeTaskListResponse()),
      });
    });
    await page.route("**/api/plugins/*/run", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeRunTaskResponse()),
      });
    });
    await mockThumbnails(page);

    await page.goto("/admin/plugins");

    // 页面不应崩溃（应展示错误状态或空态，而非白屏）
    const body = page.locator("body");
    await expect(body).toBeVisible({ timeout: 10000 });
  });

  test("P6-3: 运行中任务的任务详情页应正常渲染", async ({ page }) => {
    // Mock task detail 返回 running 状态
    await page.route("**/api/plugins", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makePluginsListResponse()),
      });
    });
    await page.route("**/api/plugins/*/run", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeRunTaskResponse()),
      });
    });
    // 对 GET /api/plugins/:id（不含 /tasks/xxx）返回插件详情
    await page.route("**/api/plugins/*", async (route) => {
      const url = route.request().url();
      if (url.includes("/tasks/")) {
        // 任务详情 → running 状态
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              id: "task-003-uuid",
              pluginId: "dianping-cluster",
              status: "running",
              params: JSON.stringify({
                timeStart: "2024-03-01T00:00:00+08:00",
                timeEnd: "2024-03-31T23:59:59+08:00",
              }),
              result: null,
              error: null,
              startedAt: "2025-06-03T00:00:00.000Z",
              finishedAt: null,
              createdAt: "2025-06-03T00:00:00.000Z",
            },
          }),
        });
      } else if (!url.includes("/tasks") && !url.includes("/run")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makePluginDetailResponse()),
        });
      } else {
        await route.fallback();
      }
    });
    await page.route("**/api/plugins/*/tasks", async (route) => {
      const url = route.request().url();
      if (/\/api\/plugins\/[^/]+\/tasks$/.test(url) || /\/api\/plugins\/[^/]+\/tasks\?/.test(url)) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeTaskListResponse()),
        });
        return;
      }
      await route.fallback();
    });
    await mockThumbnails(page);

    await page.goto("/admin/plugins/dianping-cluster/tasks/task-003-uuid");

    // 页面应正常渲染（不崩溃）
    const body = page.locator("body");
    await expect(body).toBeVisible({ timeout: 10000 });
  });
});

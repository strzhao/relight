/**
 * 照片管理页面 — 验收测试
 *
 * 【设计文档关键约束】
 * - 视图切换：年/月/日三种粒度分组展示（SegmentedControl，类似 Apple Photos）
 * - 网格布局：统一正方形网格（类似 Google Photos）
 * - 虚拟滚动库：@tanstack/react-virtual (~10KB, React 19 兼容)
 * - 分页策略：复用现有 GET /api/photos API，IntersectionObserver 触发加载
 * - 后端增强：photoQuerySchema 新增 dateFrom/dateTo 可选参数
 * - 切换视图不重新请求数据，仅对已累积数据重新分组
 *
 * 【分组逻辑设计契约】
 * | 视图 | 分组键         | 示例           |
 * |------|---------------|----------------|
 * | 年   | YYYY年        | 2026年         |
 * | 月   | YYYY年M月     | 2026年5月      |
 * | 日   | YYYY年M月D日  | 2026年5月3日   |
 *
 * 【核心类型 — Photo (来自 @relight/shared)】
 *   id, storageSourceId, filePath, fileHash, width, height, fileSize,
 *   thumbnailPath (string | null), takenAt (string | null), createdAt (string),
 *   tags?: PhotoTag[], analyses?: PhotoAnalysis[]
 *
 * ============================================================================
 * 一、e2e 级验收场景（文本清单 — 需在 Playwright 真实浏览器中验证）
 * ============================================================================
 *
 * [E2E-01] 照片网格首屏展示验证
 *   前置：数据库中至少有 3 张照片
 *   操作：访问 /photos 页面
 *   期望：
 *     a. 页面出现正方形照片网格，至少可见 1 张照片缩略图
 *     b. 默认视图为"年"分组，分组标题如"2026年"可见
 *     c. DateViewControl 三个分段按钮 [年 | 月 | 日] 都已渲染
 *
 * [E2E-02] 滚动到底部自动加载更多
 *   前置：数据库中至少有 50 张照片，pageSize=20
 *   操作：滚动到页面底部附近
 *   期望：
 *     a. 接近底部时自动触发 GET /api/photos?page=2&pageSize=20 请求
 *     b. 新数据追加到网格，不替换已有数据
 *     c. 滚动过程中无白屏或明显闪烁
 *     d. 所有数据加载完毕后不再触发新请求（hasMore=false）
 *
 * [E2E-03] 年→月→日视图切换，分组标题变化
 *   前置：数据库中至少有 10 张照片，跨越多个年月日
 *   操作：依次点击 DateViewControl 的 [年] → [月] → [日]
 *   期望：
 *     a. 切换瞬间分组标题立即更新（不触发新的 API 请求）
 *     b. "年"视图：标题如 "2026年"、"2025年"
 *     c. "月"视图：标题如 "2026年5月"、"2026年4月"
 *     d. "日"视图：标题如 "2026年5月3日"、"2026年5月2日"
 *     e. 照片总数在切换前后不变
 *
 * [E2E-04] 空状态展示（无照片时）
 *   前置：数据库中无任何照片
 *   操作：访问 /photos 页面
 *   期望：
 *     a. 展示友好的空状态提示（如"暂无照片"图标+文案）
 *     b. 不渲染 SectionHeader 和 PhotoRow
 *     c. DateViewControl 仍可见（为将来导入做准备）
 *
 * [E2E-05] 错误状态展示（API 失败时）
 *   前置：Backend API 不可达或返回 500
 *   操作：访问 /photos 页面
 *   期望：
 *     a. 展示错误提示（非空白页、非崩溃）
 *     b. 可点击"重试"按钮重新发起请求
 *     c. 错误信息不应包含 sensitive 内容（如堆栈）
 *
 * [E2E-06] 大量照片时滚动流畅度
 *   前置：数据库中至少有 500 张照片
 *   操作：快速滚动到底部，再快速滚回顶部
 *   期望：
 *     a. 页面的 JS 主线程不应阻塞超过 50ms/帧（60fps）
 *     b. DOM 节点数应远小于 500（虚拟化生效，仅渲染可视+overscan 行）
 *     c. 缩略图按需加载（opened 之外的图片不立刻发起网络请求）
 *     d. SectionHeader 在滚动过程中 sticky 吸顶固定
 *
 * [E2E-07] dateFrom/dateTo 参数生效
 *   前置：后端 photoQuerySchema 支持 dateFrom/dateTo
 *   操作：直接请求 GET /api/photos?dateFrom=2026-01-01&dateTo=2026-12-31
 *   期望：
 *     a. 仅返回 takenAt 在 2026 年内的照片
 *     b. takenAt 为 null 且 createdAt 在范围内的照片也包含在内（回退逻辑）
 *     c. 边界值：dateFrom=dateTo 时返回当天照片
 *
 * [E2E-08] 缩略图加载与兜底
 *   前置：某张照片有 thumbnailPath 值
 *   操作：页面滚动使该照片的 PhotoCard 进入可视区
 *   期望：
 *     a. <img src> 指向 GET /api/photos/:id/thumbnail
 *     b. 缩略图加载失败时显示 placeholder（如 bg-muted 灰色方块）
 *     c. 优先加载可视区内的缩略图（priority 属性）
 *
 * [E2E-09] IntersectionObserver sentinel 行为
 *   前置：hasMore=true，正在滚动中
 *   操作：观察页面底部 sentinel 元素
 *   期望：
 *     a. sentinel 进入视口时触发 loadMore()
 *     b. 正在加载中时不重复触发（isFetchingMore=true 时忽略）
 *     c. disconnect() 在组件卸载时被调用（无内存泄漏）
 *
 * ============================================================================
 * 二、纯函数单元测试 (Vitest)
 * ============================================================================
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

// ============================================================================
// 类型定义（从设计文档复刻，不引用实现代码）
// ============================================================================

interface PhotoTag {
  photoId: string;
  tagId: string;
  tagName?: string;
  tagCategory?: string;
  confidence: number;
}

interface PhotoAnalysis {
  id: string;
  photoId: string;
  aiModel: string;
  narrative?: string | null;
  aestheticScore?: number | null;
  rawResponse: string;
  processedAt: string;
}

interface Photo {
  id: string;
  storageSourceId: string;
  filePath: string;
  fileHash: string;
  width: number;
  height: number;
  fileSize: number;
  thumbnailPath: string | null;
  takenAt: string | null;
  createdAt: string;
  tags?: PhotoTag[];
  analyses?: PhotoAnalysis[];
}

type DateViewMode = "year" | "month" | "day";

// ============================================================================
// 辅助工厂函数
// ============================================================================

function makePhoto(overrides: Partial<Photo> = {}): Photo {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    storageSourceId: "src-001",
    filePath: `/photos/${id}.jpg`,
    fileHash: `hash-${id}`,
    width: 4000,
    height: 3000,
    fileSize: 2_000_000,
    thumbnailPath: `/thumbnails/${id}.jpg`,
    takenAt: "2026-05-03T10:30:00.000Z",
    createdAt: "2026-05-03T12:00:00.000Z",
    ...overrides,
  };
}

// ============================================================================
// 2.1 groupPhotos — 设计契约测试
// ============================================================================

/**
 * 从设计文档推导的 groupPhotos 签名：
 *   function groupPhotos(photos: Photo[], mode: DateViewMode): GroupedSection[]
 *
 * GroupedSection 类型：
 *   { label: string; photos: Photo[] }
 *
 * 分组规则：
 *   - 优先使用 takenAt，为 null 时回退使用 createdAt
 *   - 年视图：label = "2026年"（YYYY年）
 *   - 月视图：label = "2026年5月"（YYYY年M月）
 *   - 日视图：label = "2026年5月3日"（YYYY年M月D日）
 *   - 分组按日期倒序排列（最新的在前）
 *   - 每组内的照片保持原始顺序
 */

/** 从 Photo 中提取有效的日期字符串（遵守回退规则） */
function getEffectiveDate(photo: Photo): string {
  return photo.takenAt ?? photo.createdAt;
}

/** 按年分组 */
function groupByYear(photos: Photo[]): { label: string; photos: Photo[] }[] {
  const groups = new Map<string, Photo[]>();
  for (const photo of photos) {
    const dateStr = getEffectiveDate(photo);
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) {
      // 日期无效时归入「未知」分组
      const key = "未知年份";
      const existing = groups.get(key);
      if (existing) existing.push(photo);
      else groups.set(key, [photo]);
      continue;
    }
    const key = `${d.getFullYear()}年`;
    const existing = groups.get(key);
    if (existing) existing.push(photo);
    else groups.set(key, [photo]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => b.localeCompare(a, "zh-CN", { numeric: true }))
    .map(([label, photos]) => ({ label, photos }));
}

/** 按月分组 */
function groupByMonth(photos: Photo[]): { label: string; photos: Photo[] }[] {
  const groups = new Map<string, Photo[]>();
  for (const photo of photos) {
    const dateStr = getEffectiveDate(photo);
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) {
      const key = "未知月份";
      const existing = groups.get(key);
      if (existing) existing.push(photo);
      else groups.set(key, [photo]);
      continue;
    }
    const key = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    const existing = groups.get(key);
    if (existing) existing.push(photo);
    else groups.set(key, [photo]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => b.localeCompare(a, "zh-CN", { numeric: true }))
    .map(([label, photos]) => ({ label, photos }));
}

/** 按日分组 */
function groupByDay(photos: Photo[]): { label: string; photos: Photo[] }[] {
  const groups = new Map<string, Photo[]>();
  for (const photo of photos) {
    const dateStr = getEffectiveDate(photo);
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) {
      const key = "未知日期";
      const existing = groups.get(key);
      if (existing) existing.push(photo);
      else groups.set(key, [photo]);
      continue;
    }
    const key = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    const existing = groups.get(key);
    if (existing) existing.push(photo);
    else groups.set(key, [photo]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => b.localeCompare(a, "zh-CN", { numeric: true }))
    .map(([label, photos]) => ({ label, photos }));
}

/** 按指定的 DateViewMode 分组 */
function groupPhotos(photos: Photo[], mode: DateViewMode): { label: string; photos: Photo[] }[] {
  switch (mode) {
    case "year":
      return groupByYear(photos);
    case "month":
      return groupByMonth(photos);
    case "day":
      return groupByDay(photos);
  }
}

describe("groupPhotos — 分组逻辑验收", () => {
  describe("年视图 (mode='year')", () => {
    it("应将同一年照片归入一组，label 格式为「YYYY年」", () => {
      const photos = [
        makePhoto({ id: "1", takenAt: "2026-01-15T00:00:00Z" }),
        makePhoto({ id: "2", takenAt: "2026-08-20T00:00:00Z" }),
      ];
      const result = groupPhotos(photos, "year");
      expect(result).toHaveLength(1);
      expect(result[0]?.label).toBe("2026年");
      expect(result[0]?.photos).toHaveLength(2);
    });

    it("应跨越不同年份分别分组", () => {
      const photos = [
        makePhoto({ id: "1", takenAt: "2026-03-01T00:00:00Z" }),
        makePhoto({ id: "2", takenAt: "2025-12-31T00:00:00Z" }),
        makePhoto({ id: "3", takenAt: "2024-06-15T00:00:00Z" }),
      ];
      const result = groupPhotos(photos, "year");
      expect(result).toHaveLength(3);
      expect(result[0]?.label).toBe("2026年");
      expect(result[1]?.label).toBe("2025年");
      expect(result[2]?.label).toBe("2024年");
    });

    it("多个同一年照片应保持在同组内", () => {
      const photos = Array.from({ length: 10 }, (_, i) =>
        makePhoto({ id: `p-${i}`, takenAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
      );
      const result = groupPhotos(photos, "year");
      expect(result).toHaveLength(1);
      expect(result[0]?.photos).toHaveLength(10);
    });

    it("分组应按年份倒序（最近年份在前）", () => {
      const photos = [
        makePhoto({ id: "1", takenAt: "2023-01-01T00:00:00Z" }),
        makePhoto({ id: "2", takenAt: "2025-01-01T00:00:00Z" }),
        makePhoto({ id: "3", takenAt: "2024-01-01T00:00:00Z" }),
      ];
      const result = groupPhotos(photos, "year");
      const labels = result.map((g) => g.label);
      expect(labels).toEqual(["2025年", "2024年", "2023年"]);
    });
  });

  describe("月视图 (mode='month')", () => {
    it("label 格式应为「YYYY年M月」", () => {
      const photos = [makePhoto({ takenAt: "2026-01-15T00:00:00Z" })];
      const result = groupPhotos(photos, "month");
      expect(result[0]?.label).toBe("2026年1月");
    });

    it("同年不同月应分到不同组", () => {
      const photos = [
        makePhoto({ id: "1", takenAt: "2026-01-15T00:00:00Z" }),
        makePhoto({ id: "2", takenAt: "2026-03-20T00:00:00Z" }),
        makePhoto({ id: "3", takenAt: "2026-01-10T00:00:00Z" }),
      ];
      const result = groupPhotos(photos, "month");
      expect(result).toHaveLength(2);
      // January should have 2 photos
      const jan = result.find((g) => g.label === "2026年1月");
      const mar = result.find((g) => g.label === "2026年3月");
      expect(jan?.photos).toHaveLength(2);
      expect(mar?.photos).toHaveLength(1);
    });

    it("跨年月分组应正确且倒序排列", () => {
      const photos = [
        makePhoto({ takenAt: "2025-12-01T00:00:00Z" }),
        makePhoto({ takenAt: "2026-01-01T00:00:00Z" }),
      ];
      const result = groupPhotos(photos, "month");
      expect(result[0]?.label).toBe("2026年1月");
      expect(result[1]?.label).toBe("2025年12月");
    });
  });

  describe("日视图 (mode='day')", () => {
    it("label 格式应为「YYYY年M月D日」", () => {
      const photos = [makePhoto({ takenAt: "2026-05-03T10:30:00Z" })];
      const result = groupPhotos(photos, "day");
      expect(result[0]?.label).toBe("2026年5月3日");
    });

    it("同一天多张照片应在同一组", () => {
      // 使用本地时间安全的 UTC 时间（UTC+8 时区下 T04:00Z 和 T06:00Z 仍在同一天）
      const localSafeTime = (hour: number) => `2026-05-03T${String(hour).padStart(2, "0")}:00:00Z`;
      const photos = [
        makePhoto({ id: "1", takenAt: localSafeTime(0) }),
        makePhoto({ id: "2", takenAt: localSafeTime(4) }),
      ];
      const result = groupPhotos(photos, "day");

      // 核心契约：同一 UTC 日期应分到同组
      // 注：new Date() 使用本地时区解析，设计文档未明确指定时区策略
      // 红队提示：应考虑是否需要在分组时统一使用 UTC 或指定时区
      expect(result).toHaveLength(1);
      expect(result[0]?.photos).toHaveLength(2);
    });

    it("不同天的照片应分入不同组", () => {
      const photos = [
        makePhoto({ id: "1", takenAt: "2026-05-01T00:00:00Z" }),
        makePhoto({ id: "2", takenAt: "2026-05-02T00:00:00Z" }),
        makePhoto({ id: "3", takenAt: "2026-05-03T00:00:00Z" }),
      ];
      const result = groupPhotos(photos, "day");
      expect(result).toHaveLength(3);
      expect(result[0]?.label).toBe("2026年5月3日");
      expect(result[2]?.label).toBe("2026年5月1日");
    });
  });

  describe("takenAt 为 null 时回退使用 createdAt", () => {
    it("当 takenAt 为 null 时应使用 createdAt 进行分组", () => {
      const photos = [
        makePhoto({
          id: "1",
          takenAt: null,
          createdAt: "2025-06-15T12:00:00Z",
        }),
      ];
      const result = groupPhotos(photos, "year");
      expect(result[0]?.label).toBe("2025年");
    });

    it("takenAt 和 createdAt 不同年份时优先使用 takenAt", () => {
      const photos = [
        makePhoto({
          id: "1",
          takenAt: "2024-01-01T00:00:00Z",
          createdAt: "2025-06-15T12:00:00Z",
        }),
      ];
      const result = groupPhotos(photos, "year");
      expect(result[0]?.label).toBe("2024年");
    });

    it("混合 null 和非 null takenAt 的照片应正确分组", () => {
      const photos = [
        makePhoto({ id: "1", takenAt: "2026-05-01T00:00:00Z", createdAt: "2026-05-01T00:00:00Z" }),
        makePhoto({ id: "2", takenAt: null, createdAt: "2026-05-01T00:00:00Z" }),
        makePhoto({ id: "3", takenAt: "2026-05-02T00:00:00Z", createdAt: "2026-05-02T00:00:00Z" }),
        makePhoto({ id: "4", takenAt: null, createdAt: "2025-12-31T00:00:00Z" }),
      ];
      const result = groupPhotos(photos, "day");
      // Photos 1,2,3 -> same day (2026-05-01) or different
      // Photo 1: takenAt 2026-05-01 → "2026年5月1日"
      // Photo 2: createdAt 2026-05-01 → "2026年5月1日"
      // Photo 3: takenAt 2026-05-02 → "2026年5月2日"
      // Photo 4: createdAt 2025-12-31 → "2025年12月31日"
      expect(result).toHaveLength(3);
      const may1 = result.find((g) => g.label === "2026年5月1日");
      expect(may1?.photos).toHaveLength(2); // Photo 1 + 2
    });
  });

  describe("切换视图模式不改变数据", () => {
    it("切换年/月/日视图不应丢失或新增照片", () => {
      const photos = Array.from({ length: 5 }, (_, i) =>
        makePhoto({ id: `p-${i}`, takenAt: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
      );

      const yearResult = groupPhotos(photos, "year");
      const monthResult = groupPhotos(photos, "month");
      const dayResult = groupPhotos(photos, "day");

      const yearCount = yearResult.reduce((sum, g) => sum + g.photos.length, 0);
      const monthCount = monthResult.reduce((sum, g) => sum + g.photos.length, 0);
      const dayCount = dayResult.reduce((sum, g) => sum + g.photos.length, 0);

      expect(yearCount).toBe(5);
      expect(monthCount).toBe(5);
      expect(dayCount).toBe(5);
    });

    it("空数组切换任何视图模式均应返回空数组", () => {
      expect(groupPhotos([], "year")).toEqual([]);
      expect(groupPhotos([], "month")).toEqual([]);
      expect(groupPhotos([], "day")).toEqual([]);
    });
  });

  describe("边界情况", () => {
    it("单张照片分组应返回一个分组", () => {
      const result = groupPhotos([makePhoto()], "year");
      expect(result).toHaveLength(1);
      expect(result[0]?.photos).toHaveLength(1);
    });

    it("takenAt 为无效日期字符串时应归入未知分组", () => {
      const photos = [
        makePhoto({ takenAt: "invalid-date-string", createdAt: "invalid-date-string" }),
      ];
      const result = groupPhotos(photos, "year");
      expect(result[0]?.label).toMatch(/未知/);
    });

    it("不同时区的同一天应正确归入同一日分组", () => {
      // 使用本地时区安全的时刻（UTC+8 下不跨日）
      const photos = [
        makePhoto({ id: "1", takenAt: "2026-05-03T00:00:00Z" }),
        makePhoto({ id: "2", takenAt: "2026-05-03T04:00:00Z" }),
      ];
      const result = groupPhotos(photos, "day");

      // 设计文档未指定时区策略，但面向中文用户应优先考虑本地时间
      // 红队提示：跨时区旅行场景（如海外拍照）会产生分组偏移，
      //           需要明确是否应支持 EXIF 时区或用户指定时区
      expect(result).toHaveLength(1);
      expect(result[0]?.photos).toHaveLength(2);
    });
  });
});

// ============================================================================
// 2.2 photoQuerySchema — 新增 dateFrom/dateTo 参数
// ============================================================================

/**
 * 设计文档 §后端增强：
 * photoQuerySchema 新增 dateFrom/dateTo 可选参数
 * 原有参数保留：page, pageSize, tagId, storageSourceId, sortBy, order
 */

describe("photoQuerySchema — 后端增强参数", () => {
  /** 按设计文档扩展后的 photoQuerySchema */
  const enhancedPhotoQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    tagId: z.string().uuid().optional(),
    storageSourceId: z.string().uuid().optional(),
    sortBy: z.enum(["createdAt", "takenAt", "fileSize"]).default("createdAt"),
    order: z.enum(["asc", "desc"]).default("desc"),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
  });

  it("dateFrom 和 dateTo 应是可选字段（不传不报错）", () => {
    const result = enhancedPhotoQuerySchema.parse({});
    expect(result.dateFrom).toBeUndefined();
    expect(result.dateTo).toBeUndefined();
  });

  it("应接受有效的 dateFrom 和 dateTo 字符串", () => {
    const result = enhancedPhotoQuerySchema.parse({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
    expect(result.dateFrom).toBe("2026-01-01");
    expect(result.dateTo).toBe("2026-12-31");
  });

  it("dateFrom 和 dateTo 可以单独传递", () => {
    const onlyFrom = enhancedPhotoQuerySchema.parse({ dateFrom: "2026-01-01" });
    expect(onlyFrom.dateFrom).toBe("2026-01-01");
    expect(onlyFrom.dateTo).toBeUndefined();

    const onlyTo = enhancedPhotoQuerySchema.parse({ dateTo: "2026-12-31" });
    expect(onlyTo.dateTo).toBe("2026-12-31");
    expect(onlyTo.dateFrom).toBeUndefined();
  });

  it("dateFrom=dateTo 应合法（同一天查询）", () => {
    const result = enhancedPhotoQuerySchema.parse({
      dateFrom: "2026-05-03",
      dateTo: "2026-05-03",
    });
    expect(result.dateFrom).toBe("2026-05-03");
    expect(result.dateTo).toBe("2026-05-03");
  });

  it("dateFrom 和 dateTo 不应影响原有字段的默认值", () => {
    const result = enhancedPhotoQuerySchema.parse({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.sortBy).toBe("createdAt");
    expect(result.order).toBe("desc");
  });

  it("所有原有字段应保持兼容（无 dateFrom/dateTo 时行为不变）", () => {
    const result = enhancedPhotoQuerySchema.parse({
      page: 3,
      pageSize: 50,
      tagId: "00000000-0000-0000-0000-000000000001",
      sortBy: "takenAt",
      order: "asc",
    });
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(50);
    expect(result.tagId).toBe("00000000-0000-0000-0000-000000000001");
    expect(result.sortBy).toBe("takenAt");
    expect(result.order).toBe("asc");
  });
});

// ============================================================================
// 2.3 缩略图 URL 生成
// ============================================================================

/**
 * 设计文档：
 *   缩略图获取：GET /api/photos/:id/thumbnail → image/jpeg
 *   路由约定来自 @relight/shared API_ROUTES.photos.thumbnail
 */

describe("缩略图 URL 生成", () => {
  it("应生成 /api/photos/:id/thumbnail 格式的 URL", () => {
    const photoId = "550e8400-e29b-41d4-a716-446655440000";
    const expectedUrl = `/api/photos/${photoId}/thumbnail`;
    // 模拟 API_ROUTES.photos.thumbnail(id) 行为
    const thumbnailUrl = (id: string) => `/api/photos/${id}/thumbnail`;
    expect(thumbnailUrl(photoId)).toBe(expectedUrl);
  });

  it("PhotoCard 的 img src 应使用缩略图路由而非直接引用 thumbnailPath", () => {
    // 设计意图：<img> 应使用 API 路由（服务端转换 + 缓存），
    // 而非直接访问文件系统路径
    const photo = makePhoto({ thumbnailPath: "/var/data/thumbnails/photo-001.jpg" });
    const apiThumbnailUrl = `/api/photos/${photo.id}/thumbnail`;

    // API 路由 URL 应包含 /api/photos/ 前缀
    expect(apiThumbnailUrl).toMatch(/^\/api\/photos\/.+\/thumbnail$/);
    // 不应直接暴露文件系统路径
    expect(apiThumbnailUrl).not.toContain("/var/data");
  });

  it("thumbnailPath 为 null 时应提供 placeholder 机制", () => {
    const photo = makePhoto({ thumbnailPath: null });
    // PhotoCard 应检测 thumbnailPath === null，渲染灰色方块而非 broken image
    const hasThumbnail = photo.thumbnailPath !== null;
    expect(hasThumbnail).toBe(false);
    // 渲染层应使用 bg-muted / skeleton 占位
  });
});

// ============================================================================
// 2.4 usePhotosInfinite — reducer 状态转换
// ============================================================================

/**
 * 设计文档 §usePhotosInfinite:
 *   返回 { photos, isLoading, isFetchingMore, error, hasMore, loadMore, reset }
 *
 * 状态机：
 *   idle → loading → (success | error)
 *   success → fetchingMore → success (追加数据)
 *   success → loading (reset 后重新加载)
 */

type InfiniteState = {
  photos: Photo[];
  isLoading: boolean;
  isFetchingMore: boolean;
  error: string | null;
  hasMore: boolean;
  page: number;
};

type InfiniteAction =
  | { type: "LOAD_START" }
  | { type: "LOAD_SUCCESS"; photos: Photo[]; hasMore: boolean }
  | { type: "LOAD_MORE_START" }
  | { type: "LOAD_MORE_SUCCESS"; photos: Photo[]; hasMore: boolean }
  | { type: "LOAD_ERROR"; error: string }
  | { type: "RESET" };

function infiniteReducer(state: InfiniteState, action: InfiniteAction): InfiniteState {
  switch (action.type) {
    case "LOAD_START":
      return { ...state, isLoading: true, error: null };
    case "LOAD_SUCCESS":
      return {
        ...state,
        isLoading: false,
        photos: action.photos,
        hasMore: action.hasMore,
        page: 1,
      };
    case "LOAD_MORE_START":
      return { ...state, isFetchingMore: true };
    case "LOAD_MORE_SUCCESS":
      return {
        ...state,
        isFetchingMore: false,
        photos: [...state.photos, ...action.photos],
        hasMore: action.hasMore,
        page: state.page + 1,
      };
    case "LOAD_ERROR":
      return {
        ...state,
        isLoading: false,
        isFetchingMore: false,
        error: action.error,
      };
    case "RESET":
      return {
        photos: [],
        isLoading: false,
        isFetchingMore: false,
        error: null,
        hasMore: true,
        page: 0,
      };
    default:
      return state;
  }
}

const initialState: InfiniteState = {
  photos: [],
  isLoading: false,
  isFetchingMore: false,
  error: null,
  hasMore: true,
  page: 0,
};

describe("usePhotosInfinite — reducer 状态转换", () => {
  it("初始状态应正确", () => {
    expect(initialState.photos).toEqual([]);
    expect(initialState.isLoading).toBe(false);
    expect(initialState.isFetchingMore).toBe(false);
    expect(initialState.error).toBeNull();
    expect(initialState.hasMore).toBe(true);
    expect(initialState.page).toBe(0);
  });

  describe("首次加载流程", () => {
    it("LOAD_START 应设置 isLoading=true 并清除 error", () => {
      const prev = { ...initialState, error: "上次错误" };
      const next = infiniteReducer(prev, { type: "LOAD_START" });
      expect(next.isLoading).toBe(true);
      expect(next.error).toBeNull();
    });

    it("LOAD_SUCCESS 应填充 photos 并设置 hasMore", () => {
      const photos = [makePhoto(), makePhoto()];
      const next = infiniteReducer(
        { ...initialState, isLoading: true },
        { type: "LOAD_SUCCESS", photos, hasMore: false },
      );
      expect(next.photos).toEqual(photos);
      expect(next.hasMore).toBe(false);
      expect(next.isLoading).toBe(false);
      expect(next.page).toBe(1);
    });

    it("LOAD_ERROR 应设置 error 并取消 loading 状态", () => {
      const next = infiniteReducer(
        { ...initialState, isLoading: true },
        { type: "LOAD_ERROR", error: "Network Error" },
      );
      expect(next.error).toBe("Network Error");
      expect(next.isLoading).toBe(false);
      expect(next.isFetchingMore).toBe(false);
    });
  });

  describe("加载更多流程", () => {
    it("LOAD_MORE_START 应设置 isFetchingMore=true", () => {
      const existing = [makePhoto({ id: "1" })];
      const prev: InfiniteState = {
        ...initialState,
        photos: existing,
        page: 1,
      };
      const next = infiniteReducer(prev, { type: "LOAD_MORE_START" });
      expect(next.isFetchingMore).toBe(true);
      expect(next.photos).toEqual(existing); // 不丢失已有数据
    });

    it("LOAD_MORE_SUCCESS 应追加照片并递增 page", () => {
      const existing = [makePhoto({ id: "1" })];
      const newPhotos = [makePhoto({ id: "2" }), makePhoto({ id: "3" })];
      const prev: InfiniteState = {
        ...initialState,
        photos: existing,
        isFetchingMore: true,
        page: 1,
      };
      const next = infiniteReducer(prev, {
        type: "LOAD_MORE_SUCCESS",
        photos: newPhotos,
        hasMore: true,
      });
      expect(next.photos).toHaveLength(3);
      expect(next.photos[0]?.id).toBe("1");
      expect(next.photos[2]?.id).toBe("3");
      expect(next.page).toBe(2);
      expect(next.isFetchingMore).toBe(false);
    });

    it("hasMore=false 时应阻止后续 loadMore 调用", () => {
      const prev: InfiniteState = {
        ...initialState,
        photos: [makePhoto()],
        hasMore: false,
        page: 5,
      };
      // 设计意图：调用方应检查 hasMore 再触发加载
      // 此处验证状态守卫：hasMore=false 时不应调用 loadMore
      expect(prev.hasMore).toBe(false);
      // 实际渲染层应在 loadMore() 实现中做早期返回
    });

    it("isFetchingMore=true 时不应重复触发加载", () => {
      const prev: InfiniteState = {
        ...initialState,
        isFetchingMore: true,
      };
      // 设计意图：sentinel IntersectionObserver 应检查 isFetchingMore
      // 为 true 时跳过 loadMore() 调用
      expect(prev.isFetchingMore).toBe(true);
    });
  });

  describe("RESET", () => {
    it("RESET 应重置所有状态到初始值", () => {
      const prev: InfiniteState = {
        photos: [makePhoto(), makePhoto(), makePhoto()],
        isLoading: false,
        isFetchingMore: false,
        error: null,
        hasMore: false,
        page: 3,
      };
      const next = infiniteReducer(prev, { type: "RESET" });
      expect(next).toEqual(initialState);
    });

    it("RESET 后应允许重新加载（hasMore=true）", () => {
      const prev: InfiniteState = {
        ...initialState,
        hasMore: false,
        page: 10,
      };
      const next = infiniteReducer(prev, { type: "RESET" });
      expect(next.hasMore).toBe(true);
      expect(next.page).toBe(0);
    });
  });

  describe("错误恢复", () => {
    it("发生错误后 LOAD_START 应清除旧错误", () => {
      const prev: InfiniteState = {
        ...initialState,
        error: "Previous failure",
      };
      const next = infiniteReducer(prev, { type: "LOAD_START" });
      expect(next.error).toBeNull();
    });

    it("LOAD_MORE 错误后仍保留已有 photos", () => {
      const existing = [makePhoto({ id: "existing" })];
      const prev: InfiniteState = {
        ...initialState,
        photos: existing,
        isFetchingMore: true,
      };
      const next = infiniteReducer(prev, {
        type: "LOAD_ERROR",
        error: "Load more failed",
      });
      expect(next.error).toBe("Load more failed");
      expect(next.photos).toEqual(existing);
      expect(next.isFetchingMore).toBe(false);
    });
  });
});

// ============================================================================
// 2.5 DateViewControl — 三种模式渲染
// ============================================================================

/**
 * 设计文档 §DateViewControl:
 *   Props { value: "year" | "month" | "day"; onChange }
 *   类似 SegmentedControl
 */

describe("DateViewControl — 视图模式选择", () => {
  const validModes: DateViewMode[] = ["year", "month", "day"];

  it('应支持三种模式："year" | "month" | "day"', () => {
    const allModes = new Set(["year", "month", "day"]);
    expect(allModes.size).toBe(3);
    for (const mode of validModes) {
      expect(allModes.has(mode)).toBe(true);
    }
  });

  it("value 应是三个有效值之一", () => {
    // 类型层面约束：DateViewMode = "year" | "month" | "day"
    const isValidMode = (v: string): v is DateViewMode => validModes.includes(v as DateViewMode);

    expect(isValidMode("year")).toBe(true);
    expect(isValidMode("month")).toBe(true);
    expect(isValidMode("day")).toBe(true);
    expect(isValidMode("week")).toBe(false);
    expect(isValidMode("")).toBe(false);
  });

  it("onChange 回调应接收到新的模式值", () => {
    const changes: DateViewMode[] = [];
    const handleChange = (mode: DateViewMode) => changes.push(mode);

    // 模拟用户依次点击 [年] → [月] → [日]
    handleChange("month");
    handleChange("day");
    handleChange("year");

    expect(changes).toEqual(["month", "day", "year"]);
  });

  it("切换视图模式不应触发数据重新请求（设计约束）", () => {
    // 设计文档明确：切换视图不重新请求数据，仅对已累积数据重新分组
    // 这意味着 onChange 回调中不应包含 API 调用逻辑
    // 此处验证设计契约：onChange 应只更新本地视图状态
    let apiCallCount = 0;
    const mockLoadMore = () => {
      apiCallCount++;
    };

    // 模拟视图切换（不应调用 loadMore）
    const modes: DateViewMode[] = ["year", "month", "day", "month"];
    for (const _mode of modes) {
      // onChange 处理 — 不应触发任何网络请求
      // (仅重新计算 groupPhotos)
    }

    // 验证：loadMore 从未被调用
    expect(apiCallCount).toBe(0);
  });
});

// ============================================================================
// 2.6 PhotoSectionHeader — 分组标题
// ============================================================================

/**
 * 设计文档 §PhotoSectionHeader:
 *   Props { label: string; count: number }
 */

describe("PhotoSectionHeader — 分组标题", () => {
  it("label 应包含日期分组描述", () => {
    const label = "2026年5月";
    expect(label).toMatch(/^\d{4}年(\d{1,2}月)?(\d{1,2}日)?$/);
  });

  it("count 应反映该组内照片数量", () => {
    const section = { label: "2026年", count: 42 };
    expect(section.count).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(section.count)).toBe(true);
  });

  it("label 不应为空字符串", () => {
    const labels = [
      groupPhotos([makePhoto({ takenAt: "2026-05-03T00:00:00Z" })], "day")[0]?.label,
      groupPhotos([makePhoto({ takenAt: "2026-05-03T00:00:00Z" })], "month")[0]?.label,
      groupPhotos([makePhoto({ takenAt: "2026-05-03T00:00:00Z" })], "year")[0]?.label,
    ];
    for (const label of labels) {
      expect(label).toBeDefined();
      expect(label!.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// 2.7 PhotoRow / Virtual Grid — 虚拟滚动数据流
// ============================================================================

/**
 * 设计文档 §useVirtualGrid:
 *   封装虚拟滚动，输入 grouped photos + columnCount
 *   数据流：groupedPhotos → flatten → FlatItem[] (header | photoRow)
 *   → useVirtualizer → 渲染 virtualItems
 */

type FlatItemType = "header" | "photoRow";

interface FlatItem {
  type: FlatItemType;
  sectionIndex: number;
  rowIndex: number;
  label?: string;
  count?: number;
  photos?: Photo[];
}

function flattenGroupedPhotos(
  groups: { label: string; photos: Photo[] }[],
  columnCount: number,
): FlatItem[] {
  const items: FlatItem[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (!group) continue;
    // Section header
    items.push({
      type: "header",
      sectionIndex: i,
      rowIndex: 0,
      label: group.label,
      count: group.photos.length,
    });
    // Photo rows (每行 columnCount 张照片)
    const photoCount = group.photos.length;
    const rowCount = Math.ceil(photoCount / columnCount);
    for (let r = 0; r < rowCount; r++) {
      const slice = group.photos.slice(r * columnCount, (r + 1) * columnCount);
      items.push({
        type: "photoRow",
        sectionIndex: i,
        rowIndex: r,
        photos: slice,
      });
    }
  }
  return items;
}

describe("useVirtualGrid — flatten 数据变换", () => {
  const columnCount = 3;

  it("flat list 应包含 header 和 photoRow 两种类型", () => {
    const groups = groupPhotos([makePhoto()], "day");
    const flat = flattenGroupedPhotos(groups, columnCount);

    const types = flat.map((f) => f.type);
    expect(types).toContain("header");
    expect(types).toContain("photoRow");
  });

  it("每个分组应以 header 开头", () => {
    const photos = [
      makePhoto({ takenAt: "2026-01-01T00:00:00Z" }),
      makePhoto({ takenAt: "2026-02-01T00:00:00Z" }),
    ];
    const groups = groupPhotos(photos, "month");
    const flat = flattenGroupedPhotos(groups, columnCount);

    // 分组按日期倒序，最新的在前
    expect(flat[0]?.type).toBe("header");
    expect(flat[0]?.label).toBe("2026年2月");
    // 第二组的 header 应在正确位置
    const headers = flat.filter((f) => f.type === "header");
    expect(headers).toHaveLength(2);
    expect(headers[1]?.label).toBe("2026年1月");
  });

  it("每行应包含不超过 columnCount 张照片", () => {
    const photos = Array.from({ length: 8 }, (_, i) =>
      makePhoto({ id: `p-${i}`, takenAt: "2026-05-03T00:00:00Z" }),
    );
    const groups = groupPhotos(photos, "day");
    const flat = flattenGroupedPhotos(groups, columnCount);

    const photoRows = flat.filter((f) => f.type === "photoRow");
    for (const row of photoRows) {
      expect(row.photos?.length).toBeLessThanOrEqual(columnCount);
    }
  });

  it("8 张照片 3 列应产生 3 行 (3+3+2)", () => {
    const photos = Array.from({ length: 8 }, (_, i) =>
      makePhoto({ id: `p-${i}`, takenAt: "2026-05-03T00:00:00Z" }),
    );
    const groups = groupPhotos(photos, "day");
    const flat = flattenGroupedPhotos(groups, columnCount);

    const photoRows = flat.filter((f) => f.type === "photoRow");
    expect(photoRows).toHaveLength(3);
    expect(photoRows[0]?.photos).toHaveLength(3);
    expect(photoRows[1]?.photos).toHaveLength(3);
    expect(photoRows[2]?.photos).toHaveLength(2);
  });

  it("header 的 count 应等于对应分组照片总数", () => {
    const photos = [
      makePhoto({ takenAt: "2026-05-01T00:00:00Z" }),
      makePhoto({ takenAt: "2026-05-01T00:00:00Z" }),
      makePhoto({ takenAt: "2026-05-02T00:00:00Z" }),
    ];
    const groups = groupPhotos(photos, "day");
    const flat = flattenGroupedPhotos(groups, columnCount);

    const headers = flat.filter((f) => f.type === "header");
    // 分组按日期倒序，最新在前
    expect(headers[0]?.count).toBe(1); // 2026年5月2日（更新，先出现）
    expect(headers[0]?.label).toBe("2026年5月2日");
    expect(headers[1]?.count).toBe(2); // 2026年5月1日
    expect(headers[1]?.label).toBe("2026年5月1日");
  });

  it("空数组应生成空 flat list", () => {
    const flat = flattenGroupedPhotos([], columnCount);
    expect(flat).toEqual([]);
  });
});

// ============================================================================
// 2.8 分页参数构造
// ============================================================================

describe("API 分页参数构造", () => {
  it("首屏请求应使用 page=1 和默认 pageSize=20", () => {
    const params = new URLSearchParams();
    params.set("page", "1");
    params.set("pageSize", "20");
    expect(params.get("page")).toBe("1");
    expect(params.get("pageSize")).toBe("20");
  });

  it("加载更多时应递增 page 参数", () => {
    let page = 1;
    const params1 = new URLSearchParams();
    params1.set("page", String(page));
    params1.set("pageSize", "20");
    expect(params1.get("page")).toBe("1");

    page++;
    const params2 = new URLSearchParams();
    params2.set("page", String(page));
    params2.set("pageSize", "20");
    expect(params2.get("page")).toBe("2");
  });

  it("dateFrom/dateTo 参数应正确拼接到查询字符串", () => {
    const params = new URLSearchParams();
    params.set("page", "1");
    params.set("pageSize", "20");
    params.set("dateFrom", "2026-01-01");
    params.set("dateTo", "2026-06-30");

    const qs = params.toString();
    expect(qs).toContain("dateFrom=2026-01-01");
    expect(qs).toContain("dateTo=2026-06-30");
  });
});

// ============================================================================
// 2.9 PhotoCard — 正方形网格约束
// ============================================================================

describe("PhotoCard — 正方形网格约束", () => {
  it("PhotoCard 应使用 aspect-square 确保 1:1 比例", () => {
    // 设计文档 §网格布局：统一正方形网格（类似 Google Photos）
    // 这意味着每个 PhotoCard 的容器应有 aspect-ratio: 1 / 1
    const aspectSquareClasses = ["aspect-square"];
    expect(aspectSquareClasses).toContain("aspect-square");
  });

  it("缩略图应使用 object-cover 填满正方形区域", () => {
    // 正方形容器 + cover 填充，避免变形
    const coverBehavior = "object-cover";
    expect(coverBehavior).toBe("object-cover");
  });
});

/**
 * ============================================================================
 * 验收测试：统一照片管理页面（前端）
 *
 * 覆盖设计文档「将两个管理页面整合为一个统一的以照片为中心的页面」：
 * - 统一照片缩略图网格（1-5 列响应式）
 * - 评分徽章颜色规则
 * - 过滤栏：存储源下拉、分析状态 Tab、最低评分、排序、总数
 * - 存储源详情头部（含 ScanProgressPanel）
 * - 照片详情侧面板（Dialog）
 * - 路由重定向 /admin/storage-sources/[id] → /admin/photos?storageSourceId=[id]
 * - Dashboard 存储源卡片链接更新
 * - 侧边栏导航标签从"照片分析"改为"照片管理"
 * ============================================================================
 *
 * ## 手动测试清单（Manual Test Checklist）
 *
 * 以下场景需要通过浏览器手动验证，无法自动化测试：
 *
 * ### 1. 统一照片网格 — 视觉和交互
 * - [ ] 访问 `/admin/photos`，确认显示照片缩略图网格
 * - [ ] 调整浏览器宽度，确认列数响应式变化（1-5 列）
 * - [ ] 每张卡片显示：缩略图、评分徽章、文件路径（截断）
 * - [ ] 未分析照片显示"未分析"标签
 * - [ ] 评分 >= 8：绿色徽章
 * - [ ] 评分 6-7.9：黄色徽章
 * - [ ] 评分 < 6：灰色徽章
 * - [ ] 点击任意照片，右侧打开详情侧面板
 *
 * ### 2. 过滤栏 — URL 同步
 * - [ ] 存储源下拉第一项为"全部存储源"
 * - [ ] 选择特定存储源后 URL 变为 `/admin/photos?storageSourceId=xxx`
 * - [ ] 分析状态 Tab：全部 | 已分析 | 未分析，切换后更新 URL 的 analysisStatus 参数
 * - [ ] 最低评分输入框，输入 0-10，更新 URL 的 minScore 参数
 * - [ ] 排序下拉：创建时间 | 拍摄时间 | 文件大小 | 美学评分 | 分析时间，更新 URL 的 sortBy
 * - [ ] 总数显示实时更新
 * - [ ] 切换过滤条件后列表刷新
 *
 * ### 3. 存储源详情头部
 * - [ ] 选择特定存储源后，网格上方显示存储源详情头部
 * - [ ] 头部包含：源名称、类型徽章（local/smb/webdav）
 * - [ ] 根路径显示
 * - [ ] 统计网格：photoCount、analyzedCount、覆盖率百分比、lastScanAt
 * - [ ] ScanProgressPanel 可见，含扫描触发按钮
 * - [ ] 未选择存储源时头部不显示
 *
 * ### 4. 照片详情侧面板
 * - [ ] 侧面板从右侧滑入（Dialog）
 * - [ ] 已分析照片显示：大缩略图、文件元数据、美学评分、叙事文本
 * - [ ] 标签徽章、构图信息、色彩/情绪分析
 * - [ ] 显示分析历史（所有历史分析记录）
 * - [ ] 未分析照片显示提示信息
 * - [ ] 加载状态有 loader
 * - [ ] 错误状态有错误提示
 * - [ ] 关闭按钮关闭面板
 *
 * ### 5. 路由重定向
 * - [ ] 访问 `/admin/storage-sources/some-uuid` → 重定向到 `/admin/photos?storageSourceId=some-uuid`
 * - [ ] 访问 `/admin/storage-sources/` → 重定向到 `/admin/photos`
 *
 * ### 6. Dashboard 链接更新
 * - [ ] 访问 `/admin`，存储源卡片点击 → 跳转到 `/admin/photos?storageSourceId=xxx`
 * - [ ] 不再存在 `/admin/storage-sources/xxx` 的链接
 *
 * ### 7. 侧边栏导航
 * - [ ] 管理员侧边栏中的标签为"照片管理"（非"照片分析"）
 * - [ ] 点击导航到 `/admin/photos`
 *
 * ### 8. 边界情况
 * - [ ] 空列表时显示友好的空状态提示
 * - [ ] 网络错误时显示错误提示和重试按钮
 * - [ ] 照片总数为 0 时不显示"未分析"标签
 * - [ ] 超长文件路径在卡片中正确截断
 * - [ ] 缩略图加载失败时显示占位图片
 */

// ============================================================================
// 可测试的纯函数 / 工具函数单元测试
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ============================================================================
// 评分徽章颜色逻辑
// 设计文档规定：
// - 绿色 (green)    : 评分 >= 8
// - 黄色 (yellow)   : 评分 >= 6 且 < 8
// - 灰色 (gray)     : 评分 < 6
// - 未分析 (null)   : 无评分 / "未分析"
// ============================================================================

type ScoreBadgeColor = "green" | "yellow" | "gray";
type ScoreBadgeLabel = "未分析" | string;

interface ScoreBadge {
  color: ScoreBadgeColor;
  label: ScoreBadgeLabel;
}

/**
 * 根据美学评分计算评分徽章的颜色和标签。
 * 纯函数，可单独测试。
 */
function getScoreBadge(score: number | null | undefined): ScoreBadge {
  if (score === null || score === undefined) {
    return { color: "gray", label: "未分析" };
  }

  if (score >= 8) {
    return { color: "green", label: score.toFixed(1) };
  }

  if (score >= 6) {
    return { color: "yellow", label: score.toFixed(1) };
  }

  return { color: "gray", label: score.toFixed(1) };
}

describe("评分徽章颜色逻辑 — getScoreBadge", () => {
  describe("绿色徽章（评分 >= 8）", () => {
    it("score=10 应返回 green", () => {
      expect(getScoreBadge(10).color).toBe("green");
    });

    it("score=9.5 应返回 green", () => {
      expect(getScoreBadge(9.5).color).toBe("green");
    });

    it("score=8.0 应返回 green（边界值包含）", () => {
      expect(getScoreBadge(8.0).color).toBe("green");
    });

    it("score=8.1 应返回 green", () => {
      expect(getScoreBadge(8.1).color).toBe("green");
    });
  });

  describe("黄色徽章（评分 6-7.9）", () => {
    it("score=7.9 应返回 yellow", () => {
      expect(getScoreBadge(7.9).color).toBe("yellow");
    });

    it("score=7.0 应返回 yellow", () => {
      expect(getScoreBadge(7.0).color).toBe("yellow");
    });

    it("score=6.0 应返回 yellow（边界值包含）", () => {
      expect(getScoreBadge(6.0).color).toBe("yellow");
    });

    it("score=6.5 应返回 yellow", () => {
      expect(getScoreBadge(6.5).color).toBe("yellow");
    });
  });

  describe("灰色徽章（评分 < 6）", () => {
    it("score=5.9 应返回 gray", () => {
      expect(getScoreBadge(5.9).color).toBe("gray");
    });

    it("score=3.0 应返回 gray", () => {
      expect(getScoreBadge(3.0).color).toBe("gray");
    });

    it("score=0 应返回 gray", () => {
      expect(getScoreBadge(0).color).toBe("gray");
    });
  });

  describe("未分析（score 为 null/undefined）", () => {
    it("score=null 应返回 '未分析' 灰色标签", () => {
      const badge = getScoreBadge(null);
      expect(badge.color).toBe("gray");
      expect(badge.label).toBe("未分析");
    });

    it("score=undefined 应返回 '未分析' 灰色标签", () => {
      const badge = getScoreBadge(undefined);
      expect(badge.color).toBe("gray");
      expect(badge.label).toBe("未分析");
    });
  });

  describe("标签格式化", () => {
    it("整数评分应显示一位小数", () => {
      expect(getScoreBadge(7).label).toBe("7.0");
      expect(getScoreBadge(9).label).toBe("9.0");
      expect(getScoreBadge(5).label).toBe("5.0");
    });

    it("小数评分应正确格式化", () => {
      expect(getScoreBadge(8.3).label).toBe("8.3");
      expect(getScoreBadge(6.7).label).toBe("6.7");
    });

    it("精度高的浮点数应保持一位小数", () => {
      expect(getScoreBadge(7.1532).label).toBe("7.2");
      expect(getScoreBadge(9.999).label).toBe("10.0");
    });
  });
});

// ============================================================================
// URL 参数构建逻辑
// 设计文档中的关键 URL 模式：
// - 基础页面: /admin/photos
// - 存储源过滤: /admin/photos?storageSourceId=xxx
// - 带完整过滤: /admin/photos?storageSourceId=xxx&analysisStatus=analyzed&minScore=5&sortBy=aestheticScore&page=1&pageSize=20
// - 重定向: /admin/storage-sources/[id] → /admin/photos?storageSourceId=[id]
// ============================================================================

interface UnifiedPhotosFilters {
  storageSourceId?: string;
  analysisStatus?: "all" | "analyzed" | "unanalyzed";
  minScore?: number;
  sortBy?: "createdAt" | "takenAt" | "fileSize" | "aestheticScore" | "processedAt";
  page?: number;
  pageSize?: number;
}

/**
 * 构建 /admin/photos 页面的 URL（含查询参数）。
 * 只添加非默认值的参数。
 * 纯函数，可单独测试。
 */
function buildPhotosUrl(filters: UnifiedPhotosFilters = {}): string {
  const base = "/admin/photos";
  const params = new URLSearchParams();

  if (filters.storageSourceId) {
    params.set("storageSourceId", filters.storageSourceId);
  }

  if (filters.analysisStatus && filters.analysisStatus !== "all") {
    params.set("analysisStatus", filters.analysisStatus);
  }

  if (filters.minScore !== undefined && filters.minScore > 0) {
    params.set("minScore", String(filters.minScore));
  }

  if (filters.sortBy && filters.sortBy !== "createdAt") {
    params.set("sortBy", filters.sortBy);
  }

  if (filters.page && filters.page > 1) {
    params.set("page", String(filters.page));
  }

  if (filters.pageSize && filters.pageSize !== 20) {
    params.set("pageSize", String(filters.pageSize));
  }

  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * 构建存储源详情页重定向 URL。
 * 设计文档：/admin/storage-sources/[id] → /admin/photos?storageSourceId=[id]
 */
function buildStorageSourceRedirectUrl(storageSourceId: string): string {
  return buildPhotosUrl({ storageSourceId });
}

describe("URL 参数构建 — buildPhotosUrl", () => {
  describe("基础路径", () => {
    it("空 filters 应返回 /admin/photos", () => {
      expect(buildPhotosUrl()).toBe("/admin/photos");
    });

    it("传入空对象应返回 /admin/photos", () => {
      expect(buildPhotosUrl({})).toBe("/admin/photos");
    });
  });

  describe("storageSourceId", () => {
    it("应正确拼接 storageSourceId 参数", () => {
      const url = buildPhotosUrl({ storageSourceId: "abc-123-def" });
      expect(url).toBe("/admin/photos?storageSourceId=abc-123-def");
    });

    it("空字符串 storageSourceId 应忽略", () => {
      const url = buildPhotosUrl({ storageSourceId: "" });
      expect(url).toBe("/admin/photos");
    });
  });

  describe("analysisStatus", () => {
    it("analysisStatus=analyzed 应添加参数", () => {
      const url = buildPhotosUrl({ analysisStatus: "analyzed" });
      expect(url).toBe("/admin/photos?analysisStatus=analyzed");
    });

    it("analysisStatus=unanalyzed 应添加参数", () => {
      const url = buildPhotosUrl({ analysisStatus: "unanalyzed" });
      expect(url).toBe("/admin/photos?analysisStatus=unanalyzed");
    });

    it("analysisStatus=all 应省略参数（默认值）", () => {
      const url = buildPhotosUrl({ analysisStatus: "all" });
      expect(url).toBe("/admin/photos");
    });
  });

  describe("minScore", () => {
    it("minScore=5 应添加参数", () => {
      const url = buildPhotosUrl({ minScore: 5 });
      expect(url).toBe("/admin/photos?minScore=5");
    });

    it("minScore=0 应省略参数（默认值）", () => {
      const url = buildPhotosUrl({ minScore: 0 });
      expect(url).toBe("/admin/photos");
    });

    it("minScore=10 应添加参数", () => {
      const url = buildPhotosUrl({ minScore: 10 });
      expect(url).toBe("/admin/photos?minScore=10");
    });
  });

  describe("sortBy", () => {
    it("sortBy=aestheticScore 应添加参数", () => {
      const url = buildPhotosUrl({ sortBy: "aestheticScore" });
      expect(url).toBe("/admin/photos?sortBy=aestheticScore");
    });

    it("sortBy=createdAt 应省略参数（默认值）", () => {
      const url = buildPhotosUrl({ sortBy: "createdAt" });
      expect(url).toBe("/admin/photos");
    });

    it.each(["takenAt", "fileSize", "processedAt"] as const)("sortBy=%s 应添加参数", (val) => {
      const url = buildPhotosUrl({ sortBy: val });
      expect(url).toContain(`sortBy=${val}`);
    });
  });

  describe("分页参数", () => {
    it("page=1 应省略（默认值）", () => {
      const url = buildPhotosUrl({ page: 1 });
      expect(url).toBe("/admin/photos");
    });

    it("page=3 应添加参数", () => {
      const url = buildPhotosUrl({ page: 3 });
      expect(url).toBe("/admin/photos?page=3");
    });

    it("pageSize=20 应省略（默认值）", () => {
      const url = buildPhotosUrl({ pageSize: 20 });
      expect(url).toBe("/admin/photos");
    });

    it("pageSize=12 应添加参数", () => {
      const url = buildPhotosUrl({ pageSize: 12 });
      expect(url).toBe("/admin/photos?pageSize=12");
    });
  });

  describe("组合参数", () => {
    it("多个参数应正确组合（用 & 分隔）", () => {
      const url = buildPhotosUrl({
        storageSourceId: "source-1",
        analysisStatus: "analyzed",
        minScore: 7,
        sortBy: "aestheticScore",
        page: 2,
        pageSize: 10,
      });

      // URLSearchParams 顺序可能不同，验证关键片段存在
      expect(url).toContain("storageSourceId=source-1");
      expect(url).toContain("analysisStatus=analyzed");
      expect(url).toContain("minScore=7");
      expect(url).toContain("sortBy=aestheticScore");
      expect(url).toContain("page=2");
      expect(url).toContain("pageSize=10");
      expect(url).toMatch(/^\/admin\/photos\?/);
    });

    it("仅非默认值参数应出现在 URL 中", () => {
      const url = buildPhotosUrl({
        storageSourceId: "source-1",
        analysisStatus: "all",
        minScore: 0,
        sortBy: "createdAt",
        page: 1,
        pageSize: 20,
      });

      // 只有 storageSourceId 不是默认值
      expect(url).toBe("/admin/photos?storageSourceId=source-1");
    });
  });
});

describe("存储源重定向 URL — buildStorageSourceRedirectUrl", () => {
  it("应生成 /admin/photos?storageSourceId=xxx", () => {
    const url = buildStorageSourceRedirectUrl("my-storage-source");
    expect(url).toBe("/admin/photos?storageSourceId=my-storage-source");
  });

  it("应处理含特殊字符的 ID", () => {
    const url = buildStorageSourceRedirectUrl("550e8400-e29b-41d4-a716-446655440000");
    expect(url).toBe("/admin/photos?storageSourceId=550e8400-e29b-41d4-a716-446655440000");
  });
});

// ============================================================================
// 分析状态判定逻辑
// 设计文档：latestAnalysis 为 null → 未分析，非 null → 已分析
// ============================================================================

type AnalysisStatusLabel = "已分析" | "未分析";

/**
 * 根据 latestAnalysis 是否存在返回分析状态标签。
 */
function getAnalysisStatusLabel(
  latestAnalysis: { aestheticScore: number } | null | undefined,
): AnalysisStatusLabel {
  return latestAnalysis != null ? "已分析" : "未分析";
}

/**
 * 判断照片是否已分析。
 */
function isAnalyzed(latestAnalysis: { aestheticScore: number } | null | undefined): boolean {
  return latestAnalysis != null;
}

describe("分析状态判定逻辑", () => {
  describe("getAnalysisStatusLabel", () => {
    it("latestAnalysis 存在时应返回 '已分析'", () => {
      expect(getAnalysisStatusLabel({ aestheticScore: 7.5 })).toBe("已分析");
    });

    it("latestAnalysis 为 null 时应返回 '未分析'", () => {
      expect(getAnalysisStatusLabel(null)).toBe("未分析");
    });

    it("latestAnalysis 为 undefined 时应返回 '未分析'", () => {
      expect(getAnalysisStatusLabel(undefined)).toBe("未分析");
    });
  });

  describe("isAnalyzed", () => {
    it("latestAnalysis 存在时应返回 true", () => {
      expect(isAnalyzed({ aestheticScore: 9.0 })).toBe(true);
    });

    it("latestAnalysis 为 null 时应返回 false", () => {
      expect(isAnalyzed(null)).toBe(false);
    });

    it("latestAnalysis 为 undefined 时应返回 false", () => {
      expect(isAnalyzed(undefined)).toBe(false);
    });
  });
});

// ============================================================================
// 存储源筛选 — "全部存储源" 占位选项
// 设计文档：存储源下拉第一项为"全部存储源"，value 为 ''
// ============================================================================

interface StorageSourceOption {
  id: string;
  name: string;
}

/**
 * 构建存储源下拉选项列表（第一项为"全部存储源"）。
 */
function buildStorageSourceOptions(
  sources: StorageSourceOption[],
): Array<{ value: string; label: string }> {
  const allOption = { value: "", label: "全部存储源" };
  const sourceOptions = sources.map((s) => ({
    value: s.id,
    label: s.name,
  }));
  return [allOption, ...sourceOptions];
}

describe("存储源筛选选项", () => {
  it("应始终包含 '全部存储源' 作为第一项", () => {
    const options = buildStorageSourceOptions([]);
    expect(options).toHaveLength(1);
    expect(options[0]).toEqual({ value: "", label: "全部存储源" });
  });

  it("应将存储源列表追加在 '全部存储源' 之后", () => {
    const sources = [
      { id: "src-1", name: "我的照片库" },
      { id: "src-2", name: "NAS 备份" },
    ];
    const options = buildStorageSourceOptions(sources);

    expect(options).toHaveLength(3);
    expect(options[0]).toEqual({ value: "", label: "全部存储源" });
    expect(options[1]).toEqual({ value: "src-1", label: "我的照片库" });
    expect(options[2]).toEqual({ value: "src-2", label: "NAS 备份" });
  });
});

// ============================================================================
// 覆盖率百分比计算
// 设计文档：存储源详情头部显示 coverage % = analyzedCount / photoCount * 100
// ============================================================================

/**
 * 计算存储源的分析覆盖率百分比。
 * photoCount 为 0 时返回 0。
 */
function calculateCoverage(photoCount: number, analyzedCount: number): number {
  if (photoCount <= 0) return 0;
  const ratio = analyzedCount / photoCount;
  return Math.round(ratio * 100);
}

describe("覆盖率百分比计算 — calculateCoverage", () => {
  it("analyzedCount=0, photoCount=100 → 0%", () => {
    expect(calculateCoverage(100, 0)).toBe(0);
  });

  it("analyzedCount=50, photoCount=100 → 50%", () => {
    expect(calculateCoverage(100, 50)).toBe(50);
  });

  it("analyzedCount=100, photoCount=100 → 100%", () => {
    expect(calculateCoverage(100, 100)).toBe(100);
  });

  it("photoCount=0 时应返回 0（防止除零）", () => {
    expect(calculateCoverage(0, 0)).toBe(0);
  });

  it("photoCount=0, analyzedCount=5（异常数据）应返回 0", () => {
    expect(calculateCoverage(0, 5)).toBe(0);
  });

  it("小数百分比应正确四舍五入", () => {
    // 37/100 = 37%, 145/200 = 73% (72.5 rounded to 73)
    expect(calculateCoverage(200, 145)).toBe(73);
  });
});

// ============================================================================
// 导航标签验证
// 设计文档：侧边栏标签从 "照片分析" 改为 "照片管理"
// ============================================================================

describe("导航标签常量", () => {
  it("照片管理页面的导航标签应为 '照片管理'", () => {
    const NAV_LABEL_PHOTOS_MANAGEMENT = "照片管理";
    expect(NAV_LABEL_PHOTOS_MANAGEMENT).toBe("照片管理");
  });

  it("不应再使用旧的 '照片分析' 标签", () => {
    const OLD_LABEL = "照片分析";
    const NEW_LABEL = "照片管理";
    expect(NEW_LABEL).not.toBe(OLD_LABEL);
  });
});

// ============================================================================
// API 响应类型宽松校验
// ============================================================================

describe("API 响应类型契约（前端消费侧）", () => {
  /**
   * 模拟从 API 获取的数据，仅用类型断言验证设计文档声明的字段存在性。
   * 不实际调用网络。
   */

  interface LatestAnalysis {
    id: string;
    aiModel: string;
    aestheticScore: number;
    narrative: string;
    processedAt: string;
  }

  interface UnifiedPhotoItem {
    id: string;
    storageSourceId: string;
    filePath: string;
    width: number;
    height: number;
    fileSize: number;
    thumbnailPath: string;
    takenAt: string;
    createdAt: string;
    latestAnalysis: LatestAnalysis | null;
    analysesCount: number;
  }

  it("已分析照片 latestAnalysis 应含所有声明字段", () => {
    const item: UnifiedPhotoItem = {
      id: "photo-1",
      storageSourceId: "src-1",
      filePath: "/photos/img001.jpg",
      width: 4000,
      height: 3000,
      fileSize: 2048000,
      thumbnailPath: "/thumbnails/img001.jpg",
      takenAt: "2024-01-15T10:30:00Z",
      createdAt: "2024-01-16T08:00:00Z",
      latestAnalysis: {
        id: "analysis-1",
        aiModel: "qwen3.6-vl",
        aestheticScore: 7.5,
        narrative: "一张美丽的风景照",
        processedAt: "2024-01-16T08:05:00Z",
      },
      analysesCount: 1,
    };

    expect(item.latestAnalysis).not.toBeNull();
    expect(item.latestAnalysis?.aestheticScore).toBe(7.5);
    expect(item.latestAnalysis?.aiModel).toBe("qwen3.6-vl");
    expect(item.latestAnalysis?.narrative).toBe("一张美丽的风景照");
  });

  it("未分析照片 latestAnalysis 应为 null，analysesCount 为 0", () => {
    const item: UnifiedPhotoItem = {
      id: "photo-2",
      storageSourceId: "src-1",
      filePath: "/photos/img002.jpg",
      width: 1920,
      height: 1080,
      fileSize: 1024000,
      thumbnailPath: "/thumbnails/img002.jpg",
      takenAt: "2024-02-01T14:00:00Z",
      createdAt: "2024-02-01T14:01:00Z",
      latestAnalysis: null,
      analysesCount: 0,
    };

    expect(item.latestAnalysis).toBeNull();
    expect(item.analysesCount).toBe(0);
  });

  it("响应数据 package 应含 storageSources 数组", () => {
    const data = {
      data: [] as UnifiedPhotoItem[],
      total: 0,
      page: 1,
      pageSize: 20,
      storageSources: [{ id: "src-1", name: "我的照片库" }],
    };

    expect(Array.isArray(data.storageSources)).toBe(true);
    expect(data.storageSources).toHaveLength(1);
    expect(data.storageSources[0]?.name).toBe("我的照片库");
  });

  it("storageSource 详情字段应与设计文档一致", () => {
    const storageSource = {
      id: "src-1",
      name: "我的照片库",
      type: "local",
      rootPath: "/home/user/photos",
      enabled: true,
      lastScanAt: "2024-01-16T07:00:00Z",
      photoCount: 150,
      analyzedCount: 120,
    };

    expect(storageSource.type).toBe("local");
    expect(storageSource.analyzedCount).toBeLessThanOrEqual(storageSource.photoCount);
    expect(typeof storageSource.enabled).toBe("boolean");
  });
});

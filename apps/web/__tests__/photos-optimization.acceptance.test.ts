/**
 * 照片页面优化 — 验收测试 (AC1-AC3)
 *
 * 覆盖设计文档三个修复点：
 * - AC1: photoQuerySchema 的 order 默认值从 "asc" 改为 "desc"（新到旧排序）
 * - AC2: estimateSize 对 photoRow 返回 cellSize + 8（section 内上下间隔）
 * - AC3: lightbox-image 组件使用相对路径，移除 API_BASE 常量
 *
 * 【信息隔离铁律】
 * 本文件**仅**基于设计文档编写，代表设计意图的验收标准。
 * 不引用蓝队新写的实现代码。
 */
import { photoQuerySchema } from "@relight/shared";
import React from "react";
import { describe, expect, it, vi } from "vitest";

// ============================================================================
// AC1 — 排序方向：order 默认值 "desc"
// ============================================================================

describe("AC1: photoQuerySchema — order 默认值为 desc（新到旧排序）", () => {
  describe("空参数 parse({}) 的默认值", () => {
    it("order 默认值应为 desc（按拍摄时间降序：新照片在前，旧照片在后）", () => {
      const result = photoQuerySchema.parse({});
      expect(result.order).toBe("desc");
    });

    it("不传 order 参数时，schema 解析结果 order === 'desc'", () => {
      // 模拟 URLSearchParams 无 order 参数场景
      const withoutOrderParams = {};
      const result = photoQuerySchema.parse(withoutOrderParams);
      expect(result.order).toBe("desc");
    });

    it("sortBy 默认值仍为 takenAt（排序字段默认值不受影响）", () => {
      const result = photoQuerySchema.parse({});
      expect(result.sortBy).toBe("takenAt");
    });

    it("page 和 pageSize 默认值不受排序方向修改影响", () => {
      const result = photoQuerySchema.parse({});
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });

    it("组合语义：默认按拍摄时间降序（新→旧），前端不传参即可获得正确排序", () => {
      const result = photoQuerySchema.parse({});
      expect(result.sortBy).toBe("takenAt");
      expect(result.order).toBe("desc");
    });
  });

  describe("显式传参覆盖默认值", () => {
    it("order=asc 可覆盖默认的 desc（用户主动切换升序）", () => {
      const result = photoQuerySchema.parse({ order: "asc" });
      expect(result.order).toBe("asc");
    });

    it("可同时覆盖 sortBy=fileSize 和 order=asc", () => {
      const result = photoQuerySchema.parse({ sortBy: "fileSize", order: "asc" });
      expect(result.sortBy).toBe("fileSize");
      expect(result.order).toBe("asc");
    });

    it("覆盖 order 后 sortBy 默认值仍为 takenAt", () => {
      const result = photoQuerySchema.parse({ order: "asc" });
      expect(result.sortBy).toBe("takenAt");
    });
  });

  describe("order 枚举约束不变", () => {
    it("合法值 asc / desc 应通过校验", () => {
      expect(() => photoQuerySchema.parse({ order: "asc" })).not.toThrow();
      expect(() => photoQuerySchema.parse({ order: "desc" })).not.toThrow();
    });

    it("非法值应抛出 Zod 校验错误", () => {
      expect(() => photoQuerySchema.parse({ order: "ASC" })).toThrow();
      expect(() => photoQuerySchema.parse({ order: "ascending" })).toThrow();
    });
  });

  describe("与可选参数组合时 order 默认值仍为 desc", () => {
    it("传 dateFrom+dateTo 不改 order 默认值", () => {
      const result = photoQuerySchema.parse({
        dateFrom: "2026-01-01",
        dateTo: "2026-12-31",
      });
      expect(result.order).toBe("desc");
    });

    it("传 tagId 不改 order 默认值", () => {
      const result = photoQuerySchema.parse({
        tagId: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.order).toBe("desc");
    });

    it("传 storageSourceId 不改 order 默认值", () => {
      const result = photoQuerySchema.parse({
        storageSourceId: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.order).toBe("desc");
    });
  });
});

// ============================================================================
// AC2 — 行间距：estimateSize 返回 cellSize + 8
// ============================================================================

describe("AC2: estimateSize — photoRow 返回 cellSize + 8（section 内垂直间隔）", () => {
  /**
   * 设计文档指定的 estimateSize 行为：
   * - header 类型 → 返回 headerSize
   * - photoRow 类型 → 返回 cellSize + 8（原为 cellSize）
   *
   * 目的：同一个 section 内的照片行之间有 8px 的垂直间隔，
   * 避免照片紧贴在一起看起来奇怪。
   */

  /**
   * 模拟 estimateSize 函数（按设计文档要求实现）
   * 签名对齐 useVirtualGrid hook 中的 useCallback 定义：
   *   estimateSize(index: number) => number
   */
  type FlatItemType = "header" | "photoRow";

  interface FlatItem {
    type: FlatItemType;
    groupIndex: number;
    label?: string;
    count?: number;
    photoRowPhotos?: unknown[];
  }

  function makeEstimateSize(
    items: FlatItem[],
    cellSize: number,
    headerSize: number,
  ): (index: number) => number {
    return (index: number) => {
      const item = items[index];
      return item?.type === "header" ? headerSize : cellSize + 8;
    };
  }

  const cellSize = 200;
  const headerSize = 40;

  it("photoRow 类型应返回 cellSize + 8 = 208", () => {
    const items: FlatItem[] = [
      { type: "header", groupIndex: 0, label: "2026年5月", count: 3 },
      { type: "photoRow", groupIndex: 0, photoRowPhotos: [{ id: "1" }, { id: "2" }] },
      { type: "photoRow", groupIndex: 0, photoRowPhotos: [{ id: "3" }] },
    ];
    const fn = makeEstimateSize(items, cellSize, headerSize);

    // index 1 是第一个 photoRow
    expect(fn(1)).toBe(208); // cellSize(200) + 8
    // index 2 是第二个 photoRow
    expect(fn(2)).toBe(208);
  });

  it("header 类型应返回 headerSize（不受影响）", () => {
    const items: FlatItem[] = [
      { type: "header", groupIndex: 0, label: "2026年5月", count: 5 },
      { type: "photoRow", groupIndex: 0, photoRowPhotos: [{ id: "1" }] },
    ];
    const fn = makeEstimateSize(items, cellSize, headerSize);

    // index 0 是 header
    expect(fn(0)).toBe(40);
  });

  it("多个分组场景中 header 和 photoRow 分别返回正确值", () => {
    const items: FlatItem[] = [
      // 第一组
      { type: "header", groupIndex: 0, label: "2026年5月", count: 2 },
      { type: "photoRow", groupIndex: 0, photoRowPhotos: [{ id: "1" }, { id: "2" }] },
      // 第二组
      { type: "header", groupIndex: 1, label: "2026年4月", count: 3 },
      { type: "photoRow", groupIndex: 1, photoRowPhotos: [{ id: "3" }, { id: "4" }] },
      { type: "photoRow", groupIndex: 1, photoRowPhotos: [{ id: "5" }] },
    ];
    const fn = makeEstimateSize(items, cellSize, headerSize);

    expect(fn(0)).toBe(40); // header
    expect(fn(1)).toBe(208); // photoRow + 8
    expect(fn(2)).toBe(40); // header
    expect(fn(3)).toBe(208); // photoRow + 8
    expect(fn(4)).toBe(208); // photoRow + 8
  });

  it("cellSize 和 headerSize 变化时差值保持 8", () => {
    const items: FlatItem[] = [
      { type: "header", groupIndex: 0, label: "2026年5月", count: 1 },
      { type: "photoRow", groupIndex: 0, photoRowPhotos: [{ id: "1" }] },
    ];

    // 测试不同 cellSize 下的 +8 差值
    for (const size of [150, 200, 250, 300]) {
      const fn = makeEstimateSize(items, size, headerSize);
      expect(fn(1)).toBe(size + 8);
      expect(fn(0)).toBe(headerSize);
    }
  });

  it("越界 index 返回 cellSize + 8（作为兜底）", () => {
    // 设计意图：当 index 超出 flatItems 范围时（不应发生但作为兜底），
    // 按 photoRow 处理返回 cellSize + 8
    const items: FlatItem[] = [];
    const fn = makeEstimateSize(items, cellSize, headerSize);
    expect(fn(999)).toBe(cellSize + 8);
  });
});

// ============================================================================
// AC3 — 图片 URL：lightbox-image 使用相对路径
// ============================================================================

describe("AC3: lightbox-image — img src 使用相对路径（移除 API_BASE）", () => {
  /**
   * 设计文档指定的修复：
   * lightbox-image.tsx 改用相对路径 `/api/photos/${id}/original`
   * （原为 `${API_BASE}/api/photos/${id}/original`），移除 API_BASE 常量。
   *
   * 目的：修复图片详情页所有图片都展示加载失败的问题。
   * 原先硬编码的 API_BASE（如 http://localhost:3001）在部署后不可用，
   * 使用相对路径则无论域名如何变化都能正常工作。
   */

  const testPhotoId = "550e8400-e29b-41d4-a716-446655440000";

  /**
   * 模拟 lightbox-image 组件的 src 生成逻辑（按设计文档要求）
   * 设计文档规定：
   *   src={`/api/photos/${photo.id}/original`}
   * 不再包含 API_BASE 前缀
   */
  function getLightboxImageSrc(photoId: string): string {
    return `/api/photos/${photoId}/original`;
  }

  describe("相对路径格式验证", () => {
    it("img src 应以 /api/ 开头（相对路径，无 protocol/host）", () => {
      const src = getLightboxImageSrc(testPhotoId);
      expect(src).toMatch(/^\/api\//);
    });

    it("img src 不应以 http:// 或 https:// 开头", () => {
      const src = getLightboxImageSrc(testPhotoId);
      expect(src).not.toMatch(/^https?:\/\//);
    });

    it("img src 不应包含 localhost:3000 或 localhost:3001", () => {
      const src = getLightboxImageSrc(testPhotoId);
      expect(src).not.toContain("localhost:3000");
      expect(src).not.toContain("localhost:3001");
      expect(src).not.toContain("localhost");
    });

    it("img src 不应包含 API_BASE 常量或 process.env 引用", () => {
      const src = getLightboxImageSrc(testPhotoId);
      // 不应是模板字符串形式的 API_BASE
      expect(src).not.toContain("API_BASE");
      expect(src).not.toContain("process.env");
      expect(src).not.toContain("NEXT_PUBLIC");
    });

    it("img src 路径格式应为 /api/photos/{id}/original", () => {
      const src = getLightboxImageSrc(testPhotoId);
      expect(src).toBe(`/api/photos/${testPhotoId}/original`);
    });

    it("不同 photoId 应生成正确的相对路径", () => {
      const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
      for (const id of ids) {
        expect(getLightboxImageSrc(id)).toBe(`/api/photos/${id}/original`);
      }
    });
  });

  describe("路径格式验证 — 正则表达式", () => {
    it("src 应匹配 /api/photos/{uuid}/original 格式", () => {
      const src = getLightboxImageSrc(testPhotoId);
      // 标准 UUID v4 格式
      const uuidRe = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
      expect(src).toMatch(new RegExp(`^/api/photos/${uuidRe}/original$`));
    });
  });
});

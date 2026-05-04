/**
 * 验收测试：照片排序默认值
 *
 * 覆盖设计文档「修复照片排序 — photoQuerySchema 默认值」：
 * - photoQuerySchema.parse({}) 默认 sortBy="takenAt"（非 "createdAt"）
 * - photoQuerySchema.parse({}) 默认 order="asc"（非 "desc"）
 * - 原有默认值保留：page=1, pageSize=20
 * - 显式传参可覆盖默认值
 * - sortBy 枚举仅允许 createdAt / takenAt / fileSize
 * - order 枚举仅允许 asc / desc
 *
 * 设计文档要求默认排序为按拍摄时间升序（旧→新），
 * 无 EXIF 的照片（takenAt=NULL）由后端 COALESCE(takenAt, createdAt) 回退处理。
 */
import { photoQuerySchema } from "@relight/shared";
import { describe, expect, it } from "vitest";

describe("photoQuerySchema — 排序默认值验收", () => {
  // ==========================================================================
  // 默认值验证（核心验收点）
  // ==========================================================================

  describe("空参数 parse({}) 的默认值", () => {
    it("sortBy 默认值应为 takenAt（按拍摄时间排序，非导入时间）", () => {
      const result = photoQuerySchema.parse({});
      expect(result.sortBy).toBe("takenAt");
    });

    it("order 默认值应为 asc（升序：旧照片在前，新照片在后）", () => {
      const result = photoQuerySchema.parse({});
      expect(result.order).toBe("asc");
    });

    it("page 默认值应为 1（首页）", () => {
      const result = photoQuerySchema.parse({});
      expect(result.page).toBe(1);
    });

    it("pageSize 默认值应为 20", () => {
      const result = photoQuerySchema.parse({});
      expect(result.pageSize).toBe(20);
    });

    it("sortBy + order 组合语义：默认按拍摄时间升序（旧→新），前端不传参即可获得正确排序", () => {
      const result = photoQuerySchema.parse({});
      expect(result.sortBy).toBe("takenAt");
      expect(result.order).toBe("asc");
      // 组合断言：前端 usePhotosInfinite() 不传参 → sortBy=takenAt, order=asc
    });
  });

  // ==========================================================================
  // 显式传参覆盖默认值
  // ==========================================================================

  describe("显式传参覆盖默认值", () => {
    it("sortBy=createdAt 可覆盖默认的 takenAt（用户主动切换排序）", () => {
      const result = photoQuerySchema.parse({ sortBy: "createdAt" });
      expect(result.sortBy).toBe("createdAt");
      expect(result.order).toBe("asc"); // order 保持默认
    });

    it("order=desc 可覆盖默认的 asc（用户切换降序）", () => {
      const result = photoQuerySchema.parse({ order: "desc" });
      expect(result.order).toBe("desc");
      expect(result.sortBy).toBe("takenAt"); // sortBy 保持默认
    });

    it("可同时覆盖 sortBy 和 order", () => {
      const result = photoQuerySchema.parse({ sortBy: "fileSize", order: "desc" });
      expect(result.sortBy).toBe("fileSize");
      expect(result.order).toBe("desc");
    });

    it("覆盖后不影响 page/pageSize 默认值", () => {
      const result = photoQuerySchema.parse({ sortBy: "createdAt", order: "desc" });
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });
  });

  // ==========================================================================
  // sortBy 枚举约束
  // ==========================================================================

  describe("sortBy 枚举约束", () => {
    it("合法值 createdAt / takenAt / fileSize 应通过校验", () => {
      expect(() => photoQuerySchema.parse({ sortBy: "createdAt" })).not.toThrow();
      expect(() => photoQuerySchema.parse({ sortBy: "takenAt" })).not.toThrow();
      expect(() => photoQuerySchema.parse({ sortBy: "fileSize" })).not.toThrow();
    });

    it("非法值应抛出 Zod 校验错误", () => {
      expect(() => photoQuerySchema.parse({ sortBy: "updatedAt" })).toThrow();
      expect(() => photoQuerySchema.parse({ sortBy: "size" })).toThrow();
      expect(() => photoQuerySchema.parse({ sortBy: "" })).toThrow();
    });
  });

  // ==========================================================================
  // order 枚举约束
  // ==========================================================================

  describe("order 枚举约束", () => {
    it("合法值 asc / desc 应通过校验", () => {
      expect(() => photoQuerySchema.parse({ order: "asc" })).not.toThrow();
      expect(() => photoQuerySchema.parse({ order: "desc" })).not.toThrow();
    });

    it("非法值（大写 ASC / 错误拼写等）应抛出 Zod 校验错误", () => {
      expect(() => photoQuerySchema.parse({ order: "ASC" })).toThrow();
      expect(() => photoQuerySchema.parse({ order: "ascending" })).toThrow();
    });
  });

  // ==========================================================================
  // 与其他可选参数组合时默认值不受影响
  // ==========================================================================

  describe("与 dateFrom / dateTo 组合时默认值不变", () => {
    it("传 dateFrom+dateTo 不影响默认 sortBy 和 order", () => {
      const result = photoQuerySchema.parse({
        dateFrom: "2026-01-01",
        dateTo: "2026-12-31",
      });
      expect(result.sortBy).toBe("takenAt");
      expect(result.order).toBe("asc");
      expect(result.dateFrom).toBe("2026-01-01");
      expect(result.dateTo).toBe("2026-12-31");
    });
  });

  describe("与 tagId / storageSourceId 组合时默认值不变", () => {
    it("传 tagId 不影响 sortBy 和 order 默认值", () => {
      const result = photoQuerySchema.parse({
        tagId: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.sortBy).toBe("takenAt");
      expect(result.order).toBe("asc");
    });

    it("传 storageSourceId 不影响 sortBy 和 order 默认值", () => {
      const result = photoQuerySchema.parse({
        storageSourceId: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.sortBy).toBe("takenAt");
      expect(result.order).toBe("asc");
    });
  });

  // ==========================================================================
  // coerce 类型转换
  // ==========================================================================

  describe("coerce 类型转换（Query String 兼容性）", () => {
    it("page 支持字符串转换（?page='3' → page=3）", () => {
      const result = photoQuerySchema.parse({ page: "3" });
      expect(result.page).toBe(3);
    });

    it("pageSize 支持字符串转换（?pageSize='50' → pageSize=50）", () => {
      const result = photoQuerySchema.parse({ pageSize: "50" });
      expect(result.pageSize).toBe(50);
    });

    it("pageSize 超出最大值 100 应抛出校验错误", () => {
      expect(() => photoQuerySchema.parse({ pageSize: "101" })).toThrow();
    });

    it("page 为 0 应抛出校验错误（positive 约束）", () => {
      expect(() => photoQuerySchema.parse({ page: "0" })).toThrow();
    });
  });
});

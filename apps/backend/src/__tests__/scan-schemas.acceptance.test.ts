import { analyzeFilesSchema, scanNowSchema } from "@relight/shared";
/**
 * 验收测试：扫描跳过分析 Schema 校验
 *
 * 覆盖设计文档：
 * - schemas.ts: scanNowSchema 新增 skipAnalysis 字段（z.boolean().optional().default(false)）
 * - schemas.ts: 新增 analyzeFilesSchema
 *   - photoIds: z.array(z.string().uuid()).min(1).max(100)
 *   - force: z.boolean().optional()
 *
 * 验收点：
 * - scanNowSchema 接受/拒绝 skipAnalysis 的各种输入
 * - scanNowSchema skipAnalysis 默认值行为
 * - analyzeFilesSchema photoIds 最小/最大长度校验
 * - analyzeFilesSchema photoIds UUID 格式校验
 * - analyzeFilesSchema force 可选字段行为
 */
import { describe, expect, it } from "vitest";

const TEST_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("扫描跳过分析 Schema — 验收测试", () => {
  // =========================================================================
  // scanNowSchema — skipAnalysis 字段
  // =========================================================================
  describe("scanNowSchema.skipAnalysis", () => {
    it("应接受 skipAnalysis: true", () => {
      const result = scanNowSchema.safeParse({
        storageSourceId: TEST_UUID,
        skipAnalysis: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skipAnalysis).toBe(true);
      }
    });

    it("应接受 skipAnalysis: false", () => {
      const result = scanNowSchema.safeParse({
        storageSourceId: TEST_UUID,
        skipAnalysis: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skipAnalysis).toBe(false);
      }
    });

    it("skipAnalysis 缺失时应默认为 false", () => {
      const result = scanNowSchema.safeParse({
        storageSourceId: TEST_UUID,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skipAnalysis).toBe(false);
      }
    });

    it("应拒绝非布尔值的 skipAnalysis", () => {
      const result = scanNowSchema.safeParse({
        storageSourceId: TEST_UUID,
        skipAnalysis: "yes",
      });
      expect(result.success).toBe(false);
    });

    it("应拒绝 skipAnalysis: 1（数字不是布尔值）", () => {
      const result = scanNowSchema.safeParse({
        storageSourceId: TEST_UUID,
        skipAnalysis: 1,
      });
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // analyzeFilesSchema — 基本结构
  // =========================================================================
  describe("analyzeFilesSchema 基本校验", () => {
    it("应成功导出 analyzeFilesSchema", () => {
      expect(analyzeFilesSchema).toBeDefined();
      expect(typeof analyzeFilesSchema.safeParse).toBe("function");
    });

    it("应接受最小有效载荷（1 个 UUID）", () => {
      const result = analyzeFilesSchema.safeParse({
        photoIds: [TEST_UUID],
      });
      expect(result.success).toBe(true);
    });

    it("应接受最大有效载荷（100 个 UUID）", () => {
      const photoIds = Array.from({ length: 100 }, () => crypto.randomUUID());
      const result = analyzeFilesSchema.safeParse({ photoIds });
      expect(result.success).toBe(true);
    });

    it("应接受 2 个 UUID 的正常载荷", () => {
      const result = analyzeFilesSchema.safeParse({
        photoIds: [TEST_UUID, crypto.randomUUID()],
      });
      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // analyzeFilesSchema — photoIds 校验
  // =========================================================================
  describe("analyzeFilesSchema photoIds 边界校验", () => {
    it("应拒绝空 photoIds 数组（min(1)）", () => {
      const result = analyzeFilesSchema.safeParse({ photoIds: [] });
      expect(result.success).toBe(false);
    });

    it("应拒绝超过 100 个 photoIds（max(100)）", () => {
      const photoIds = Array.from({ length: 101 }, () => crypto.randomUUID());
      const result = analyzeFilesSchema.safeParse({ photoIds });
      expect(result.success).toBe(false);
    });

    it("应拒绝非 UUID 格式的 photoId", () => {
      const result = analyzeFilesSchema.safeParse({
        photoIds: ["not-a-uuid"],
      });
      expect(result.success).toBe(false);
    });

    it("应拒绝混合有效/无效 UUID 的数组", () => {
      const result = analyzeFilesSchema.safeParse({
        photoIds: [TEST_UUID, "invalid-uuid-here"],
      });
      expect(result.success).toBe(false);
    });

    it("应拒绝缺失 photoIds 字段", () => {
      const result = analyzeFilesSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("应拒绝 photoIds 为非数组类型", () => {
      const result = analyzeFilesSchema.safeParse({
        photoIds: "not-an-array",
      });
      expect(result.success).toBe(false);
    });

    it("应拒绝 photoIds 为 null", () => {
      const result = analyzeFilesSchema.safeParse({
        photoIds: null,
      });
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // analyzeFilesSchema — force 字段
  // =========================================================================
  describe("analyzeFilesSchema force 字段", () => {
    it("应接受 force: true", () => {
      const result = analyzeFilesSchema.safeParse({
        photoIds: [TEST_UUID],
        force: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.force).toBe(true);
      }
    });

    it("应接受 force: false", () => {
      const result = analyzeFilesSchema.safeParse({
        photoIds: [TEST_UUID],
        force: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.force).toBe(false);
      }
    });

    it("force 缺失时应为 undefined 或 falsy", () => {
      const result = analyzeFilesSchema.safeParse({
        photoIds: [TEST_UUID],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.force).toBeFalsy();
      }
    });

    it("应拒绝非布尔值的 force", () => {
      const result = analyzeFilesSchema.safeParse({
        photoIds: [TEST_UUID],
        force: "yes",
      });
      expect(result.success).toBe(false);
    });
  });
});

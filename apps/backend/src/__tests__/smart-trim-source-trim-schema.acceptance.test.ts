/**
 * 验收测试：sourceTrim schema 字段校验（红队）
 *
 * 覆盖契约 C2：manifest 新增字段 sourceTrim 的 zod schema
 *
 * C2 规约：
 *   startSec: z.number().nonnegative()         // 必填
 *   endSec: z.number().positive()              // 必填
 *   originalDurationSec: z.number().positive() // 必填
 *   trimmedAt: z.string().optional()           // 可选
 *   status: z.enum(["ok", "trim_failed", "skipped"]).optional() // 可选
 *
 * 测试场景：
 *   - 合法对象 parse OK
 *   - startSec/endSec/originalDurationSec 必填
 *   - status enum 只接受 "ok" | "trim_failed" | "skipped"
 *   - 缺 status 也能 parse（optional）
 *   - 负数 startSec 应被 zod 拒绝
 *
 * 红队铁律：
 *   - 未读 types.ts 中新增的 sourceTrimSchema 实现（虽然 C7 测试可 import 其类型）
 *   - 依据设计文档契约 C2 编写期望
 *   - 允许 import sourceTrimSchema（类型定义文件，被设计文档明确列为允许读的文件）
 */
import { describe, expect, it } from "vitest";

// import sourceTrimSchema from types.ts（允许导入已有的 transcript schema）
import { manifestVideoEntrySchema, sourceTrimSchema } from "../cli/vlog/types";

describe("契约 C2: sourceTrim schema 字段校验", () => {
  describe("合法对象 parse OK", () => {
    it("完整合法对象应 parse 成功", () => {
      const valid = {
        startSec: 10.5,
        endSec: 60.0,
        originalDurationSec: 120.0,
        trimmedAt: "2026-05-16T13:00:00.000Z",
        status: "ok",
      };
      const result = sourceTrimSchema.safeParse(valid);
      expect(
        result.success,
        `parse 失败: ${JSON.stringify((result as { error: unknown }).error)}`,
      ).toBe(true);
    });

    it("仅有必填字段（无可选字段）应 parse 成功", () => {
      const minimal = {
        startSec: 0,
        endSec: 50.0,
        originalDurationSec: 90.0,
      };
      const result = sourceTrimSchema.safeParse(minimal);
      expect(
        result.success,
        `parse 失败: ${JSON.stringify((result as { error: unknown }).error)}`,
      ).toBe(true);
    });

    it("startSec=0 应被接受（nonnegative，允许 0）", () => {
      const obj = { startSec: 0, endSec: 50.0, originalDurationSec: 50.0 };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(true);
    });

    it("trimmedAt 为 ISO 时间字符串时 parse 成功", () => {
      const obj = {
        startSec: 5,
        endSec: 55,
        originalDurationSec: 100,
        trimmedAt: "2026-05-16T12:00:00Z",
      };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(true);
    });
  });

  describe("必填字段缺失应被 zod 拒绝", () => {
    it("缺 startSec → parse 失败", () => {
      const obj = { endSec: 50.0, originalDurationSec: 100.0 };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });

    it("缺 endSec → parse 失败", () => {
      const obj = { startSec: 0, originalDurationSec: 100.0 };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });

    it("缺 originalDurationSec → parse 失败", () => {
      const obj = { startSec: 0, endSec: 50.0 };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });

    it("空对象 → parse 失败", () => {
      const result = sourceTrimSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("数字约束校验", () => {
    it("负数 startSec 应被 zod 拒绝（nonnegative）", () => {
      const obj = { startSec: -1, endSec: 50.0, originalDurationSec: 100.0 };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });

    it("endSec=0 应被 zod 拒绝（positive，不接受 0）", () => {
      const obj = { startSec: 0, endSec: 0, originalDurationSec: 100.0 };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });

    it("负数 endSec 应被 zod 拒绝", () => {
      const obj = { startSec: 0, endSec: -5.0, originalDurationSec: 100.0 };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });

    it("originalDurationSec=0 应被 zod 拒绝（positive）", () => {
      const obj = { startSec: 0, endSec: 50.0, originalDurationSec: 0 };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });

    it("负数 originalDurationSec 应被 zod 拒绝", () => {
      const obj = { startSec: 0, endSec: 50.0, originalDurationSec: -10.0 };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });
  });

  describe("status enum 校验", () => {
    it("status='ok' 应被接受", () => {
      const obj = { startSec: 0, endSec: 50.0, originalDurationSec: 100.0, status: "ok" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("status='trim_failed' 应被接受", () => {
      const obj = { startSec: 0, endSec: 50.0, originalDurationSec: 100.0, status: "trim_failed" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("status='skipped' 应被接受", () => {
      const obj = { startSec: 0, endSec: 50.0, originalDurationSec: 100.0, status: "skipped" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("status='unknown' 应被 zod 拒绝（不在 enum 内）", () => {
      const obj = { startSec: 0, endSec: 50.0, originalDurationSec: 100.0, status: "unknown" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });

    it("status 为数字类型应被 zod 拒绝", () => {
      const obj = { startSec: 0, endSec: 50.0, originalDurationSec: 100.0, status: 1 };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });

    it("缺 status 字段应 parse 成功（optional）", () => {
      const obj = { startSec: 0, endSec: 50.0, originalDurationSec: 100.0 };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("status=null 应被 zod 拒绝（optional 不接受 null）", () => {
      const obj = { startSec: 0, endSec: 50.0, originalDurationSec: 100.0, status: null };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });
  });

  describe("可选字段", () => {
    it("trimmedAt 缺失应 parse 成功（optional）", () => {
      const obj = { startSec: 5, endSec: 55, originalDurationSec: 100, status: "ok" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("status 缺失应 parse 成功（optional）", () => {
      const obj = {
        startSec: 5,
        endSec: 55,
        originalDurationSec: 100,
        trimmedAt: "2026-05-16T13:00:00Z",
      };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("status 和 trimmedAt 均缺失应 parse 成功", () => {
      const obj = { startSec: 5, endSec: 55, originalDurationSec: 100 };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });
  });

  describe("契约 C2：manifestVideoEntrySchema 集成（sourceTrim 作为可选字段）", () => {
    it("manifest video entry 中 sourceTrim 缺失应 parse 成功（向后兼容）", () => {
      const entry = {
        type: "video" as const,
        ok: true,
        filePath: "/tmp/test.mp4",
        realPath: "/tmp/test.mp4",
        sha256: "a".repeat(64),
        fileSize: 1024,
        elapsedMs: 100,
        cacheHit: false,
        width: 1920,
        height: 1080,
        durationSec: 30.0,
        videoCodec: "h264",
        videoFps: 30,
        hasAudio: true,
      };
      const result = manifestVideoEntrySchema.safeParse(entry);
      expect(
        result.success,
        `parse 失败: ${JSON.stringify((result as { error: unknown }).error)}`,
      ).toBe(true);
    });

    it("manifest video entry 中带合法 sourceTrim 应 parse 成功", () => {
      const entry = {
        type: "video" as const,
        ok: true,
        filePath: "/tmp/test.mp4",
        realPath: "/tmp/test.mp4",
        sha256: "a".repeat(64),
        fileSize: 1024,
        elapsedMs: 100,
        cacheHit: false,
        width: 1920,
        height: 1080,
        durationSec: 50.0,
        videoCodec: "h264",
        videoFps: 30,
        hasAudio: true,
        sourceTrim: {
          startSec: 5.0,
          endSec: 55.0,
          originalDurationSec: 120.0,
          status: "ok",
        },
      };
      const result = manifestVideoEntrySchema.safeParse(entry);
      expect(
        result.success,
        `parse 失败: ${JSON.stringify((result as { error: unknown }).error)}`,
      ).toBe(true);
    });

    it("manifest video entry 中 sourceTrim.status='trim_failed' 应 parse 成功", () => {
      const entry = {
        type: "video" as const,
        ok: true,
        filePath: "/tmp/corrupt.mp4",
        realPath: "/tmp/corrupt.mp4",
        sha256: "b".repeat(64),
        fileSize: 512,
        elapsedMs: 5000,
        cacheHit: false,
        width: 1920,
        height: 1080,
        durationSec: 120.0,
        videoCodec: "h264",
        videoFps: 30,
        hasAudio: false,
        sourceTrim: {
          startSec: 0,
          endSec: 50.0,
          originalDurationSec: 120.0,
          status: "trim_failed",
        },
      };
      const result = manifestVideoEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });
  });
});

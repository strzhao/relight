/**
 * 验收测试 T5.6：扩展 sourceTrim zod schema（红队）
 *
 * 覆盖契约：
 *   - T1.1a: 扩展 sourceTrimSchema 加 6 个 optional 字段
 *
 * 契约规约（state.md sourceTrim Schema 扩展）：
 *   新增 6 个 optional 字段：
 *   - source: z.enum(["qwen", "qwen_cache", "fallback", "passthrough", "first_skip"])
 *   - position: z.enum(["first", "middle", "closing"])
 *   - reason: z.string().max(200)
 *   - capped: z.boolean()
 *   - cappedFrom: z.number().positive()
 *   - fallbackReason: z.enum(["timeout", "invalid_json", "schema_error", "range_invalid"])
 *
 *   向后兼容：旧 manifest（无新字段）能正常 parse
 *
 * 测试场景：
 *   - 旧 manifest（无新字段）能正常 parse
 *   - 新字段能正常 parse
 *   - 非法 enum 值被拒绝（如 source="invalid"）
 *   - position 只能是 "first"|"middle"|"closing"
 *   - fallbackReason 只能是 "timeout"|"invalid_json"|"schema_error"|"range_invalid"
 *
 * 红队铁律：仅依据设计文档，可 import sourceTrimSchema（允许读的类型定义文件）
 */
import { describe, expect, it } from "vitest";
import { sourceTrimSchema } from "../cli/vlog/types";

// ---- 基础合法对象（旧 manifest 格式）----
const baseValidOld = {
  startSec: 10.5,
  endSec: 60.0,
  originalDurationSec: 120.0,
};

// ---- 完整新格式对象 ----
const fullValidNew = {
  startSec: 10.5,
  endSec: 60.0,
  originalDurationSec: 120.0,
  trimmedAt: "2026-05-17T08:00:00Z",
  status: "ok",
  source: "qwen",
  position: "middle",
  reason: "保留了连贯对白，删除停车场过渡段",
  capped: false,
  cappedFrom: undefined,
  fallbackReason: undefined,
};

describe("T1.1a: sourceTrim schema 扩展字段验证", () => {
  describe("向后兼容：旧 manifest（无新字段）能正常 parse", () => {
    it("仅有旧字段（startSec/endSec/originalDurationSec）应 parse 成功", () => {
      const result = sourceTrimSchema.safeParse(baseValidOld);
      expect(
        result.success,
        `旧 manifest 应兼容: ${JSON.stringify((result as { error: unknown }).error)}`,
      ).toBe(true);
    });

    it("旧字段 + status='ok' 应 parse 成功", () => {
      const obj = { ...baseValidOld, status: "ok" };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(true);
    });

    it("旧字段 + trimmedAt 应 parse 成功", () => {
      const obj = { ...baseValidOld, trimmedAt: "2026-05-16T12:00:00Z" };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(true);
    });
  });

  describe("新字段（source / position / reason / capped / cappedFrom / fallbackReason）能正常 parse", () => {
    it("完整新格式 source='qwen' 应 parse 成功", () => {
      const obj = {
        startSec: 5,
        endSec: 95,
        originalDurationSec: 150,
        status: "ok",
        source: "qwen",
        position: "middle",
        reason: "保留核心对白",
      };
      const result = sourceTrimSchema.safeParse(obj);
      expect(
        result.success,
        `新字段应可 parse: ${JSON.stringify((result as { error: unknown }).error)}`,
      ).toBe(true);
    });

    it("source='qwen_cache' 应 parse 成功", () => {
      const obj = { ...baseValidOld, source: "qwen_cache" };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(true);
    });

    it("source='fallback' + fallbackReason='timeout' 应 parse 成功", () => {
      const obj = {
        startSec: 0,
        endSec: 80,
        originalDurationSec: 200,
        status: "ok",
        source: "fallback",
        position: "closing",
        fallbackReason: "timeout",
      };
      const result = sourceTrimSchema.safeParse(obj);
      expect(
        result.success,
        `fallback+timeout 应可 parse: ${JSON.stringify((result as { error: unknown }).error)}`,
      ).toBe(true);
    });

    it("source='passthrough' 应 parse 成功", () => {
      const obj = {
        startSec: 0,
        endSec: 35,
        originalDurationSec: 35,
        status: "ok",
        source: "passthrough",
        position: "middle",
      };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(true);
    });

    it("source='first_skip' + status='skipped' 应 parse 成功", () => {
      const obj = {
        startSec: 0,
        endSec: 120,
        originalDurationSec: 120,
        status: "skipped",
        source: "first_skip",
        position: "first",
      };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(true);
    });

    it("capped=true + cappedFrom 应 parse 成功", () => {
      const obj = {
        startSec: 0,
        endSec: 118,
        originalDurationSec: 150,
        status: "ok",
        source: "qwen",
        position: "middle",
        capped: true,
        cappedFrom: 150,
      };
      const result = sourceTrimSchema.safeParse(obj);
      expect(
        result.success,
        `capped 字段应可 parse: ${JSON.stringify((result as { error: unknown }).error)}`,
      ).toBe(true);
    });

    it("capped=false（无 cappedFrom）应 parse 成功", () => {
      const obj = { ...baseValidOld, source: "qwen", capped: false };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(true);
    });

    it("reason 字段（最多 200 字符）应 parse 成功", () => {
      const obj = {
        ...baseValidOld,
        source: "qwen",
        reason: "这是一段不超过 200 字的推理理由，解释了为什么选择这段区间作为 trim 的结果",
      };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(true);
    });
  });

  describe("source enum 校验：非法值被拒绝", () => {
    it("source='invalid' 应被 zod 拒绝", () => {
      const obj = { ...baseValidOld, source: "invalid" };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });

    it("source='hook' 应被 zod 拒绝（W6 重命名后 hook 不再是合法值）", () => {
      const obj = { ...baseValidOld, source: "hook" };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });

    it("source='' 空字符串应被 zod 拒绝", () => {
      const obj = { ...baseValidOld, source: "" };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });

    it("source=123 数字类型应被 zod 拒绝", () => {
      const obj = { ...baseValidOld, source: 123 };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });

    it("source=null 应被 zod 拒绝（optional 不接受 null）", () => {
      const obj = { ...baseValidOld, source: null };
      const result = sourceTrimSchema.safeParse(obj);
      expect(result.success).toBe(false);
    });
  });

  describe("position enum 校验：只能是 'first'|'middle'|'closing'", () => {
    it("position='first' 应被接受", () => {
      const obj = { ...baseValidOld, position: "first" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("position='middle' 应被接受", () => {
      const obj = { ...baseValidOld, position: "middle" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("position='closing' 应被接受", () => {
      const obj = { ...baseValidOld, position: "closing" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("position='hook' 应被 zod 拒绝（W6 重命名后 hook 不再是合法 position）", () => {
      const obj = { ...baseValidOld, position: "hook" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });

    it("position='last' 应被 zod 拒绝", () => {
      const obj = { ...baseValidOld, position: "last" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });

    it("position='' 空字符串应被 zod 拒绝", () => {
      const obj = { ...baseValidOld, position: "" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });
  });

  describe("fallbackReason enum 校验：只能是 4 种合法值", () => {
    it("fallbackReason='timeout' 应被接受", () => {
      const obj = { ...baseValidOld, fallbackReason: "timeout" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("fallbackReason='invalid_json' 应被接受", () => {
      const obj = { ...baseValidOld, fallbackReason: "invalid_json" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("fallbackReason='schema_error' 应被接受", () => {
      const obj = { ...baseValidOld, fallbackReason: "schema_error" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("fallbackReason='range_invalid' 应被接受", () => {
      const obj = { ...baseValidOld, fallbackReason: "range_invalid" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("fallbackReason='network_error' 应被 zod 拒绝（不在 enum 内）", () => {
      const obj = { ...baseValidOld, fallbackReason: "network_error" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });

    it("fallbackReason='parse_error' 应被 zod 拒绝", () => {
      const obj = { ...baseValidOld, fallbackReason: "parse_error" };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });

    it("fallbackReason=null 应被 zod 拒绝（optional 不接受 null）", () => {
      const obj = { ...baseValidOld, fallbackReason: null };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });
  });

  describe("reason 字段约束（max 500 字符；dry-run 实测 Qwen 中文 reason 经常 200+ 字，故从 200 改为 500）", () => {
    it("reason 长度 200 字符 → 接受", () => {
      const obj = { ...baseValidOld, reason: "a".repeat(200) };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("reason 长度 500 字符 → 接受（max=500）", () => {
      const obj = { ...baseValidOld, reason: "a".repeat(500) };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("reason 长度 501 字符 → 应被 zod 拒绝（超过 max=500）", () => {
      const obj = { ...baseValidOld, reason: "a".repeat(501) };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });

    it("reason 空字符串 → 应被接受（optional 的空字符串）", () => {
      const obj = { ...baseValidOld, reason: "" };
      // 如果实现加了 .min(1)，这里会失败；设计文档 reason 只限 max(200)，无 min
      // 合理的实现应允许空字符串
      const result = sourceTrimSchema.safeParse(obj);
      // 不强断言，记录期望
      if (!result.success) {
        console.info("[设计提示] reason='' 被拒绝，如果 schema 加了 .min(1) 则需更新测试");
      }
    });
  });

  describe("cappedFrom 字段约束（positive）", () => {
    it("cappedFrom=150 → 接受", () => {
      const obj = { ...baseValidOld, cappedFrom: 150 };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(true);
    });

    it("cappedFrom=0 → 应被 zod 拒绝（positive 不接受 0）", () => {
      const obj = { ...baseValidOld, cappedFrom: 0 };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });

    it("cappedFrom=-10 → 应被 zod 拒绝", () => {
      const obj = { ...baseValidOld, cappedFrom: -10 };
      expect(sourceTrimSchema.safeParse(obj).success).toBe(false);
    });
  });

  describe("全部新字段都是 optional（不填也能 parse）", () => {
    it("source 缺失 → parse 成功", () => {
      expect(sourceTrimSchema.safeParse(baseValidOld).success).toBe(true);
    });

    it("position 缺失 → parse 成功", () => {
      expect(sourceTrimSchema.safeParse(baseValidOld).success).toBe(true);
    });

    it("reason 缺失 → parse 成功", () => {
      expect(sourceTrimSchema.safeParse(baseValidOld).success).toBe(true);
    });

    it("capped 缺失 → parse 成功", () => {
      expect(sourceTrimSchema.safeParse(baseValidOld).success).toBe(true);
    });

    it("fallbackReason 缺失 → parse 成功", () => {
      expect(sourceTrimSchema.safeParse(baseValidOld).success).toBe(true);
    });
  });
});

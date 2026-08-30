/**
 * 单元测试：setup-cos-cors CLI 纯合并逻辑（state.md §CLI 契约 幂等性）
 *
 * 覆盖：
 * - 空规则表 → 追加 gallery origin 规则（changed=true）
 * - 已含 gallery origin → 幂等跳过，不产生重复规则（场景 C2）
 * - 已有他人规则 → 合并保留原样，新规则追加在后（不覆盖既有配置）
 * - existing 非数组/undefined 防御 → 视为空表
 * - origins 数组任一元素命中即视为已存在
 * - getBucketCors 真实回读 shape：复数键 AllowedOrigins/AllowedMethods + MaxAgeSeconds 字符串
 *   （2026-08-29 C2 假阴性教训：fixture 镜像了实现的错误单数键假设，SDK 源码 base.js:440-446 实证复数键）
 * - 表内重复规则（同 origins+methods 签名）→ 去重写回自愈（action=dedupe）
 */
import { describe, expect, it } from "vitest";
import { GALLERY_ORIGIN, INCOMING_CORS_RULE, mergeCorsRules } from "../cli/setup-cos-cors";

const EXISTING_OTHER_RULE = {
  AllowedOrigin: ["https://example.com"],
  AllowedMethod: ["PUT"],
  AllowedHeader: ["*"],
  MaxAgeSeconds: 300,
};

const EXISTING_GALLERY_RULE = {
  AllowedOrigin: [GALLERY_ORIGIN],
  AllowedMethod: ["GET", "HEAD"],
  AllowedHeader: ["*"],
  MaxAgeSeconds: 600,
};

/** cos-nodejs-sdk-v5 getBucketCors 真实回读 shape（复数键 + MaxAgeSeconds 字符串） */
const SDK_GALLERY_RULE = {
  AllowedOrigins: [GALLERY_ORIGIN],
  AllowedMethods: ["GET", "HEAD"],
  AllowedHeaders: ["*"],
  ExposeHeaders: [],
  MaxAgeSeconds: "600",
};

const SDK_OTHER_RULE = {
  AllowedOrigins: ["https://example.com"],
  AllowedMethods: ["PUT"],
  AllowedHeaders: ["content-type"],
  ExposeHeaders: [],
  MaxAgeSeconds: "300",
};

describe("mergeCorsRules（setup-cos-cors 幂等合并）", () => {
  it("空规则表 → 追加新规则且 changed=true（action=append）", () => {
    const { rules, changed, action } = mergeCorsRules([], INCOMING_CORS_RULE);
    expect(changed).toBe(true);
    expect(action).toBe("append");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual(INCOMING_CORS_RULE);
  });

  it("existing 非数组（undefined/null）→ 防御为空表后追加", () => {
    for (const existing of [undefined, null] as const) {
      const { rules, changed } = mergeCorsRules(existing, INCOMING_CORS_RULE);
      expect(changed).toBe(true);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toEqual(INCOMING_CORS_RULE);
    }
  });

  it("已含 gallery origin（单数键）→ 幂等跳过（changed=false）且无重复规则", () => {
    const { rules, changed, action } = mergeCorsRules([EXISTING_GALLERY_RULE], INCOMING_CORS_RULE);
    expect(changed).toBe(false);
    expect(action).toBe("skip");
    expect(rules).toHaveLength(1);
    expect(rules).toEqual([EXISTING_GALLERY_RULE]);
  });

  it("已含 gallery origin（SDK 复数键真实 shape + MaxAgeSeconds 字符串）→ 幂等跳过（场景 C2 回归防线）", () => {
    const { rules, changed, action } = mergeCorsRules([SDK_GALLERY_RULE], INCOMING_CORS_RULE);
    expect(changed).toBe(false);
    expect(action).toBe("skip");
    expect(rules).toEqual([SDK_GALLERY_RULE]);
  });

  it("origins 数组任一元素命中 gallery origin → 视为已存在", () => {
    const mixed = {
      AllowedOrigins: ["https://a.com", GALLERY_ORIGIN],
      AllowedMethods: ["GET"],
      MaxAgeSeconds: "60",
    };
    const { rules, changed } = mergeCorsRules([mixed], INCOMING_CORS_RULE);
    expect(changed).toBe(false);
    expect(rules).toEqual([mixed]);
  });

  it("已有他人规则（SDK 复数键）→ 合并保留原样，新规则追加在后", () => {
    const { rules, changed, action } = mergeCorsRules([SDK_OTHER_RULE], INCOMING_CORS_RULE);
    expect(changed).toBe(true);
    expect(action).toBe("append");
    expect(rules).toEqual([SDK_OTHER_RULE, INCOMING_CORS_RULE]);
  });

  it("已有他人规则（单数键）→ 合并保留原样，新规则追加在后", () => {
    const { rules, changed } = mergeCorsRules([EXISTING_OTHER_RULE], INCOMING_CORS_RULE);
    expect(changed).toBe(true);
    expect(rules).toEqual([EXISTING_OTHER_RULE, INCOMING_CORS_RULE]);
  });

  it("规则字段内容不同（同 origin 值不同 method）仍按 origin 判幂等，不合并不覆盖", () => {
    const drift = {
      AllowedOrigins: [GALLERY_ORIGIN],
      AllowedMethods: ["GET"],
      MaxAgeSeconds: "60",
    };
    const { rules, changed } = mergeCorsRules([drift], INCOMING_CORS_RULE);
    expect(changed).toBe(false);
    // 不覆盖已有规则的字段内容（保守：只判 origin 存在性）
    expect(rules).toEqual([drift]);
  });

  it("表内存在重复规则（同 origins+methods 签名，2026-08-29 生产桶真实状态）→ 去重写回自愈（action=dedupe）", () => {
    const { rules, changed, action } = mergeCorsRules(
      [SDK_GALLERY_RULE, { ...SDK_GALLERY_RULE }],
      INCOMING_CORS_RULE,
    );
    expect(changed).toBe(true);
    expect(action).toBe("dedupe");
    expect(rules).toHaveLength(1);
    expect(rules).toEqual([SDK_GALLERY_RULE]);
  });

  it("origin 不存在但表内有他人重复规则 → 追加同时去重", () => {
    const { rules, changed, action } = mergeCorsRules(
      [SDK_OTHER_RULE, { ...SDK_OTHER_RULE }],
      INCOMING_CORS_RULE,
    );
    expect(changed).toBe(true);
    expect(action).toBe("append");
    expect(rules).toEqual([SDK_OTHER_RULE, INCOMING_CORS_RULE]);
  });
});

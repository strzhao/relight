import {
  mergePersonSchema,
  setPersonRepresentativeSchema,
  updatePersonSchema,
} from "@relight/shared";
import { describe, expect, it } from "vitest";

describe("updatePersonSchema", () => {
  it("name 最长 20 字符通过", () => {
    expect(updatePersonSchema.safeParse({ name: "a".repeat(20) }).success).toBe(true);
  });

  it("name 21 字符不通过", () => {
    expect(updatePersonSchema.safeParse({ name: "a".repeat(21) }).success).toBe(false);
  });

  it("name=null 通过（视为清空）", () => {
    expect(updatePersonSchema.safeParse({ name: null }).success).toBe(true);
  });

  it('name="" 通过（视为清空）', () => {
    expect(updatePersonSchema.safeParse({ name: "" }).success).toBe(true);
  });

  it("name 省略通过（部分更新）", () => {
    expect(updatePersonSchema.safeParse({}).success).toBe(true);
  });

  it("bio 最长 200 字符通过", () => {
    expect(updatePersonSchema.safeParse({ bio: "a".repeat(200) }).success).toBe(true);
  });

  it("bio 201 字符不通过", () => {
    expect(updatePersonSchema.safeParse({ bio: "a".repeat(201) }).success).toBe(false);
  });

  it("中文也按字符长度计算", () => {
    expect(updatePersonSchema.safeParse({ name: "奶奶" }).success).toBe(true);
    expect(updatePersonSchema.safeParse({ bio: "二零二四年春节后开始记录" }).success).toBe(true);
  });
});

describe("setPersonRepresentativeSchema", () => {
  it("faceId 非空字符串通过", () => {
    expect(setPersonRepresentativeSchema.safeParse({ faceId: "abc" }).success).toBe(true);
  });

  it("faceId 空字符串不通过", () => {
    expect(setPersonRepresentativeSchema.safeParse({ faceId: "" }).success).toBe(false);
  });

  it("缺 faceId 不通过", () => {
    expect(setPersonRepresentativeSchema.safeParse({}).success).toBe(false);
  });
});

describe("mergePersonSchema", () => {
  it("targetPersonId 非空通过", () => {
    expect(mergePersonSchema.safeParse({ targetPersonId: "p2" }).success).toBe(true);
  });

  it("targetPersonId 空字符串不通过", () => {
    expect(mergePersonSchema.safeParse({ targetPersonId: "" }).success).toBe(false);
  });
});

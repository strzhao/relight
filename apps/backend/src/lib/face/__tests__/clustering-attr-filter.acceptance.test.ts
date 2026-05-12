/**
 * 验收测试 R2：shouldMerge / updatePersonAttributeSummary / [I5] 硬过滤生效证据
 * （红队，黑盒）
 *
 * 设计契约（state.md 「设计文档 → 临界区间硬过滤算法」+「Person 级别的属性聚合」）：
 *
 * `shouldMerge(faceAttr, personSummary, sim, config): boolean`
 *  - sim < 0.55 → false（无论属性如何）
 *  - sim >= 0.7  → true（无论属性如何，直接合并）
 *  - 中间区间 [0.55, 0.7)：
 *    - config.midZoneFilter=false → true（默认合并）
 *    - faceAttr=null 或 personSummary=null → true（退化合并）
 *    - personSummary.member_count_with_attr < 2 → true（样本不足）
 *    - gender 不同（任一 unknown 不算冲突）→ false
 *    - age_band 跨 >= 2 档 → false
 *    - 否则 → true
 *
 * `updatePersonAttributeSummary(faces): PersonAttributeSummary | null`
 *  - 多数票选 gender_mode、age_band_mode
 *  - null attributes 不计票
 *  - 全 null → 返回 null 或 member_count_with_attr=0 的 summary
 *  - 平票按字母序（字典序小的优先）
 *
 * age_band 顺序（索引差 >= 2 拒绝）：
 *   infant(0) child(1) teen(2) young_adult(3) middle_aged(4) senior(5)
 *
 * mock 策略：纯算法函数，无需 mock 外部依赖，直接导入调用
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// =========================================================================
// 类型声明（仅用于测试类型标注，契约来自 state.md，不读实现）
// =========================================================================

type AgeBand = "infant" | "child" | "teen" | "young_adult" | "middle_aged" | "senior" | "unknown";

interface FaceAttributes {
  schema_version: 1;
  age_band: AgeBand;
  gender: "male" | "female" | "unknown";
  hair: "long" | "short" | "bald" | "covered" | "unknown";
  glasses: "none" | "normal" | "sunglasses" | "unknown";
  facial_hair: "none" | "stubble" | "beard" | "moustache" | "unknown";
  expression: "neutral" | "smile" | "laugh" | "sad" | "surprised" | "unknown";
}

interface PersonAttributeSummary {
  schema_version: 1;
  gender_mode: "male" | "female" | "unknown";
  age_band_mode: AgeBand;
  member_count_with_attr: number;
}

type ShouldMergeFn = (
  faceAttr: FaceAttributes | null,
  personSummary: PersonAttributeSummary | null,
  sim: number,
  config: { mergeThreshold: number; minThreshold: number; midZoneFilter: boolean },
) => boolean;

type UpdatePersonAttributeSummaryFn = (
  faces: Array<{ attributes: FaceAttributes | null }>,
) => PersonAttributeSummary | null;

// =========================================================================
// 测试配置
// =========================================================================

const BASE_CONFIG = {
  mergeThreshold: 0.7,
  minThreshold: 0.55,
  midZoneFilter: true,
};

// =========================================================================
// 测试夹具构建辅助
// =========================================================================

function makeAttr(overrides: Partial<FaceAttributes> = {}): FaceAttributes {
  return {
    schema_version: 1,
    age_band: "young_adult",
    gender: "male",
    hair: "short",
    glasses: "none",
    facial_hair: "none",
    expression: "neutral",
    ...overrides,
  };
}

function makeSummary(overrides: Partial<PersonAttributeSummary> = {}): PersonAttributeSummary {
  return {
    schema_version: 1,
    gender_mode: "male",
    age_band_mode: "young_adult",
    member_count_with_attr: 5,
    ...overrides,
  };
}

// =========================================================================
// Setup
// =========================================================================

beforeEach(() => {
  vi.resetModules();
});

// =========================================================================
// R2-shouldMerge: 阈值边界
// =========================================================================

describe("shouldMerge — 阈值边界", () => {
  it("R2-1: sim=0.5（低于 minThreshold=0.55）→ false（不管属性如何）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ gender: "male" });
    const summary = makeSummary({ gender_mode: "male", member_count_with_attr: 10 });

    expect(shouldMerge(attr, summary, 0.5, BASE_CONFIG)).toBe(false);
  });

  it("R2-1b: sim=0.54（仍低于 minThreshold）→ false", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ gender: "female" });
    const summary = makeSummary({ gender_mode: "female", member_count_with_attr: 10 });

    expect(shouldMerge(attr, summary, 0.54, BASE_CONFIG)).toBe(false);
  });

  it("R2-2: sim=0.75（高于 mergeThreshold=0.7）→ true（即使 gender 不同）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    // gender 不同，但 sim 高于 mergeThreshold → 直接合并
    const attr = makeAttr({ gender: "male" });
    const summary = makeSummary({ gender_mode: "female", member_count_with_attr: 10 });

    expect(shouldMerge(attr, summary, 0.75, BASE_CONFIG)).toBe(true);
  });

  it("R2-2b: sim=0.70（等于 mergeThreshold）→ true（边界值直接合并）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ gender: "male" });
    const summary = makeSummary({ gender_mode: "female", member_count_with_attr: 10 });

    expect(shouldMerge(attr, summary, 0.7, BASE_CONFIG)).toBe(true);
  });

  it("R2-1c: sim=0.55（等于 minThreshold）→ 进入中间区间（不是直接 false）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    // sim=0.55 属于 [0.55, 0.7) 中间区间
    // gender 相同、age_band 相同、member_count=5 → 应 true
    const attr = makeAttr({ gender: "male", age_band: "young_adult" });
    const summary = makeSummary({
      gender_mode: "male",
      age_band_mode: "young_adult",
      member_count_with_attr: 5,
    });

    expect(shouldMerge(attr, summary, 0.55, BASE_CONFIG)).toBe(true);
  });
});

// =========================================================================
// R2-shouldMerge: 中间区间属性过滤
// =========================================================================

describe("shouldMerge — 中间区间属性硬过滤", () => {
  it("R2-3: sim=0.65, gender 不同（male vs female），member_count=5 → false", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ gender: "male" });
    const summary = makeSummary({ gender_mode: "female", member_count_with_attr: 5 });

    expect(shouldMerge(attr, summary, 0.65, BASE_CONFIG)).toBe(false);
  });

  it("R2-4: sim=0.65, age_band 跨 3 档（child vs middle_aged），member_count=5 → false", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    // child(1) vs middle_aged(4)，差 = 3 >= 2 → 拒绝
    const attr = makeAttr({ age_band: "child", gender: "unknown" });
    const summary = makeSummary({
      age_band_mode: "middle_aged",
      gender_mode: "unknown",
      member_count_with_attr: 5,
    });

    expect(shouldMerge(attr, summary, 0.65, BASE_CONFIG)).toBe(false);
  });

  it("R2-4b: sim=0.65, infant(0) vs young_adult(3)，差=3 → false", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ age_band: "infant", gender: "unknown" });
    const summary = makeSummary({
      age_band_mode: "young_adult",
      gender_mode: "unknown",
      member_count_with_attr: 5,
    });

    expect(shouldMerge(attr, summary, 0.65, BASE_CONFIG)).toBe(false);
  });

  it("R2-4c: sim=0.65, teen(2) vs senior(5)，差=3 → false", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ age_band: "teen", gender: "unknown" });
    const summary = makeSummary({
      age_band_mode: "senior",
      gender_mode: "unknown",
      member_count_with_attr: 5,
    });

    expect(shouldMerge(attr, summary, 0.65, BASE_CONFIG)).toBe(false);
  });

  it("R2-5: sim=0.65, age_band 跨 1 档（child vs teen），member_count=5 → true", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    // child(1) vs teen(2)，差 = 1 < 2 → 允许合并
    const attr = makeAttr({ age_band: "child", gender: "unknown" });
    const summary = makeSummary({
      age_band_mode: "teen",
      gender_mode: "unknown",
      member_count_with_attr: 5,
    });

    expect(shouldMerge(attr, summary, 0.65, BASE_CONFIG)).toBe(true);
  });

  it("R2-5b: sim=0.65, age_band 跨恰好 2 档（infant vs teen）→ false（边界：>=2 拒绝）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    // infant(0) vs teen(2)，差 = 2 → 拒绝（设计：Math.abs >= 2 即拒绝）
    const attr = makeAttr({ age_band: "infant", gender: "unknown" });
    const summary = makeSummary({
      age_band_mode: "teen",
      gender_mode: "unknown",
      member_count_with_attr: 5,
    });

    expect(shouldMerge(attr, summary, 0.65, BASE_CONFIG)).toBe(false);
  });

  it("R2-6: sim=0.65, faceAttr.gender=unknown，personSummary.gender_mode=male → true（unknown 不算冲突）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ gender: "unknown", age_band: "young_adult" });
    const summary = makeSummary({
      gender_mode: "male",
      age_band_mode: "young_adult",
      member_count_with_attr: 5,
    });

    expect(shouldMerge(attr, summary, 0.65, BASE_CONFIG)).toBe(true);
  });

  it("R2-6b: sim=0.65, faceAttr.gender=female，personSummary.gender_mode=unknown → true（unknown 不算冲突）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ gender: "female", age_band: "young_adult" });
    const summary = makeSummary({
      gender_mode: "unknown",
      age_band_mode: "young_adult",
      member_count_with_attr: 5,
    });

    expect(shouldMerge(attr, summary, 0.65, BASE_CONFIG)).toBe(true);
  });

  it("R2-7: sim=0.65, member_count_with_attr=1（<2）→ true（样本不足不投票）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    // gender 不同，但 member_count < 2 → 不投票，直接合并
    const attr = makeAttr({ gender: "male" });
    const summary = makeSummary({ gender_mode: "female", member_count_with_attr: 1 });

    expect(shouldMerge(attr, summary, 0.65, BASE_CONFIG)).toBe(true);
  });

  it("R2-7b: sim=0.65, member_count_with_attr=0 → true（样本为零，不投票）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ gender: "male" });
    const summary = makeSummary({ gender_mode: "female", member_count_with_attr: 0 });

    expect(shouldMerge(attr, summary, 0.65, BASE_CONFIG)).toBe(true);
  });

  it("R2-8: sim=0.65, faceAttr=null → true（属性缺失退化合并）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const summary = makeSummary({ gender_mode: "female", member_count_with_attr: 10 });

    expect(shouldMerge(null, summary, 0.65, BASE_CONFIG)).toBe(true);
  });

  it("R2-9: sim=0.65, personSummary=null → true（属性缺失退化合并）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ gender: "male" });

    expect(shouldMerge(attr, null, 0.65, BASE_CONFIG)).toBe(true);
  });

  it("R2-10: midZoneFilter=false，sim=0.65，gender 不同 → true（关闭硬过滤默认合并）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ gender: "male" });
    const summary = makeSummary({ gender_mode: "female", member_count_with_attr: 10 });
    const configOff = { ...BASE_CONFIG, midZoneFilter: false };

    expect(shouldMerge(attr, summary, 0.65, configOff)).toBe(true);
  });

  it("R2-10b: midZoneFilter=false，sim=0.65，age_band 跨 3 档 → true（关闭过滤不拦截）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const attr = makeAttr({ age_band: "infant", gender: "unknown" });
    const summary = makeSummary({
      age_band_mode: "senior",
      gender_mode: "unknown",
      member_count_with_attr: 10,
    });
    const configOff = { ...BASE_CONFIG, midZoneFilter: false };

    expect(shouldMerge(attr, summary, 0.65, configOff)).toBe(true);
  });
});

// =========================================================================
// R2-updatePersonAttributeSummary: 多数票
// =========================================================================

describe("updatePersonAttributeSummary — 多数票聚合", () => {
  it("R2-update-1: 3 张 face，gender 2 male 1 female → gender_mode=male", async () => {
    const { updatePersonAttributeSummary } = (await import("../clustering")) as {
      updatePersonAttributeSummary: UpdatePersonAttributeSummaryFn;
    };

    const faces = [
      { attributes: makeAttr({ gender: "male", age_band: "young_adult" }) },
      { attributes: makeAttr({ gender: "male", age_band: "young_adult" }) },
      { attributes: makeAttr({ gender: "female", age_band: "young_adult" }) },
    ];

    const result = updatePersonAttributeSummary(faces);
    expect(result).not.toBeNull();
    expect(result?.gender_mode).toBe("male");
  });

  it("R2-update-1b: age_band 2 middle_aged 1 teen → age_band_mode=middle_aged", async () => {
    const { updatePersonAttributeSummary } = (await import("../clustering")) as {
      updatePersonAttributeSummary: UpdatePersonAttributeSummaryFn;
    };

    const faces = [
      { attributes: makeAttr({ age_band: "middle_aged", gender: "unknown" }) },
      { attributes: makeAttr({ age_band: "middle_aged", gender: "unknown" }) },
      { attributes: makeAttr({ age_band: "teen", gender: "unknown" }) },
    ];

    const result = updatePersonAttributeSummary(faces);
    expect(result).not.toBeNull();
    expect(result?.age_band_mode).toBe("middle_aged");
  });

  it("R2-update-2: 1 male + 2 null → member_count_with_attr=1, gender_mode=male", async () => {
    const { updatePersonAttributeSummary } = (await import("../clustering")) as {
      updatePersonAttributeSummary: UpdatePersonAttributeSummaryFn;
    };

    const faces = [
      { attributes: makeAttr({ gender: "male" }) },
      { attributes: null },
      { attributes: null },
    ];

    const result = updatePersonAttributeSummary(faces);
    expect(result).not.toBeNull();
    expect(result?.member_count_with_attr).toBe(1);
    expect(result?.gender_mode).toBe("male");
  });

  it("R2-update-3: 全 null → member_count_with_attr=0（返回 null 或全 unknown summary）", async () => {
    const { updatePersonAttributeSummary } = (await import("../clustering")) as {
      updatePersonAttributeSummary: UpdatePersonAttributeSummaryFn;
    };

    const faces = [{ attributes: null }, { attributes: null }, { attributes: null }];

    const result = updatePersonAttributeSummary(faces);

    // 设计文档未明确指定全 null 时的返回值，允许两种情况：
    // 1. 返回 null
    // 2. 返回含 member_count_with_attr=0 的 summary
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.member_count_with_attr).toBe(0);
    }
  });

  it("R2-update-4: 平票 2 male 2 female → gender_mode=female（字典序 f < m）", async () => {
    const { updatePersonAttributeSummary } = (await import("../clustering")) as {
      updatePersonAttributeSummary: UpdatePersonAttributeSummaryFn;
    };

    const faces = [
      { attributes: makeAttr({ gender: "male" }) },
      { attributes: makeAttr({ gender: "male" }) },
      { attributes: makeAttr({ gender: "female" }) },
      { attributes: makeAttr({ gender: "female" }) },
    ];

    const result = updatePersonAttributeSummary(faces);
    expect(result).not.toBeNull();
    // 平票时按字母序：female < male
    expect(result?.gender_mode).toBe("female");
  });

  it("R2-update-5: member_count_with_attr 正确统计有效（非 null）的 face 数量", async () => {
    const { updatePersonAttributeSummary } = (await import("../clustering")) as {
      updatePersonAttributeSummary: UpdatePersonAttributeSummaryFn;
    };

    const faces = [
      { attributes: makeAttr({ gender: "male" }) },
      { attributes: makeAttr({ gender: "female" }) },
      { attributes: null },
      { attributes: makeAttr({ gender: "male" }) },
    ];

    const result = updatePersonAttributeSummary(faces);
    expect(result).not.toBeNull();
    expect(result?.member_count_with_attr).toBe(3);
  });

  it("R2-update-6: schema_version 必须为 1", async () => {
    const { updatePersonAttributeSummary } = (await import("../clustering")) as {
      updatePersonAttributeSummary: UpdatePersonAttributeSummaryFn;
    };

    const faces = [{ attributes: makeAttr({ gender: "male" }) }];
    const result = updatePersonAttributeSummary(faces);

    if (result !== null) {
      expect(result.schema_version).toBe(1);
    }
  });
});

// =========================================================================
// R2-[I5]: 硬过滤生效证据（多次调用 shouldMerge 模拟批次）
// =========================================================================

describe("[I5] 硬过滤生效证据：开启过滤拆出更多 person", () => {
  /**
   * 模拟一批 8 张脸，配对测试：
   * - 2 对：male vs female，sim=0.65（临界区间，gender 冲突）
   * - 2 对：child vs middle_aged，sim=0.65（临界区间，age_band 跨 3 档）
   * - 2 对：sim=0.65 且属性一致（gender 相同，age_band 相同）→ 无论开不开都合并
   *
   * 统计：
   * - 关闭硬过滤（midZoneFilter=false）：所有临界区间的对都合并 → 合并更多 → 更少 person
   * - 开启硬过滤（midZoneFilter=true）：冲突对被拒 → 拆开 → 更多 person
   *
   * 简化版：不需要真的集成 detect-faces，只通过 shouldMerge 统计
   */

  type FacePair = {
    attr: FaceAttributes | null;
    summary: PersonAttributeSummary | null;
    sim: number;
  };

  function countMerges(
    pairs: FacePair[],
    config: { mergeThreshold: number; minThreshold: number; midZoneFilter: boolean },
    shouldMergeFn: ShouldMergeFn,
  ): number {
    return pairs.filter((p) => shouldMergeFn(p.attr, p.summary, p.sim, config)).length;
  }

  it("[I5] 开启硬过滤时，被拒绝的合并数量 > 关闭时", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    const pairs: FacePair[] = [
      // gender 冲突对 × 4
      {
        attr: makeAttr({ gender: "male", age_band: "young_adult" }),
        summary: makeSummary({
          gender_mode: "female",
          age_band_mode: "young_adult",
          member_count_with_attr: 5,
        }),
        sim: 0.65,
      },
      {
        attr: makeAttr({ gender: "male", age_band: "middle_aged" }),
        summary: makeSummary({
          gender_mode: "female",
          age_band_mode: "middle_aged",
          member_count_with_attr: 3,
        }),
        sim: 0.62,
      },
      {
        attr: makeAttr({ gender: "female", age_band: "teen" }),
        summary: makeSummary({
          gender_mode: "male",
          age_band_mode: "teen",
          member_count_with_attr: 4,
        }),
        sim: 0.67,
      },
      {
        attr: makeAttr({ gender: "female", age_band: "senior" }),
        summary: makeSummary({
          gender_mode: "male",
          age_band_mode: "senior",
          member_count_with_attr: 6,
        }),
        sim: 0.58,
      },
      // age_band 跨 3 档冲突对 × 2
      {
        attr: makeAttr({ gender: "unknown", age_band: "infant" }),
        summary: makeSummary({
          gender_mode: "unknown",
          age_band_mode: "middle_aged",
          member_count_with_attr: 5,
        }),
        sim: 0.61,
      },
      {
        attr: makeAttr({ gender: "unknown", age_band: "child" }),
        summary: makeSummary({
          gender_mode: "unknown",
          age_band_mode: "senior",
          member_count_with_attr: 3,
        }),
        sim: 0.66,
      },
      // 属性一致对 × 2（无论开不开都合并）
      {
        attr: makeAttr({ gender: "male", age_band: "young_adult" }),
        summary: makeSummary({
          gender_mode: "male",
          age_band_mode: "young_adult",
          member_count_with_attr: 5,
        }),
        sim: 0.63,
      },
      {
        attr: makeAttr({ gender: "female", age_band: "middle_aged" }),
        summary: makeSummary({
          gender_mode: "female",
          age_band_mode: "middle_aged",
          member_count_with_attr: 4,
        }),
        sim: 0.68,
      },
    ];

    const configOn = { ...BASE_CONFIG, midZoneFilter: true };
    const configOff = { ...BASE_CONFIG, midZoneFilter: false };

    const mergesWhenOn = countMerges(pairs, configOn, shouldMerge);
    const mergesWhenOff = countMerges(pairs, configOff, shouldMerge);

    // 关闭时更多合并 → mergesWhenOff > mergesWhenOn
    // 即：开启过滤时拒绝更多合并 → 产出更多 person
    expect(mergesWhenOff).toBeGreaterThan(mergesWhenOn);

    // 具体：6 个冲突对 + 2 个无冲突对
    // 关闭时：8 个都合并
    // 开启时：只有 2 个无冲突对合并
    expect(mergesWhenOff).toBe(8); // 全部合并（含 6 个冲突对）
    expect(mergesWhenOn).toBe(2); // 只有 2 个属性一致的合并
  });

  it("[I5] 验证：过滤 personsCount_on > personsCount_off（用 rejected pairs 数量推导）", async () => {
    const { shouldMerge } = (await import("../clustering")) as {
      shouldMerge: ShouldMergeFn;
    };

    // 用 merge 被拒绝（rejected）数量表示产出更多 person 的程度
    // rejected = pairs 数量 - merges 数量
    // personsCount ∝ rejected（拒绝越多 → 不合并 → 更多独立 person）

    const genderConflictPairs: FacePair[] = Array.from({ length: 3 }, () => ({
      attr: makeAttr({ gender: "male", age_band: "young_adult" }),
      summary: makeSummary({
        gender_mode: "female",
        age_band_mode: "young_adult",
        member_count_with_attr: 5,
      }),
      sim: 0.65,
    }));

    const configOn = { ...BASE_CONFIG, midZoneFilter: true };
    const configOff = { ...BASE_CONFIG, midZoneFilter: false };

    const rejectedOn = genderConflictPairs.filter(
      (p) => !shouldMerge(p.attr, p.summary, p.sim, configOn),
    ).length;
    const rejectedOff = genderConflictPairs.filter(
      (p) => !shouldMerge(p.attr, p.summary, p.sim, configOff),
    ).length;

    // 开启时更多被拒 → personsCount_on > personsCount_off
    expect(rejectedOn).toBeGreaterThan(rejectedOff);
    // 关闭时无拒绝
    expect(rejectedOff).toBe(0);
    // 开启时全部被拒
    expect(rejectedOn).toBe(3);
  });
});

// =========================================================================
// R2-shouldMerge: 边界综合验证
// =========================================================================

describe("shouldMerge — age_band 跨度精确验证（所有相邻档差值）", () => {
  const AGE_ORDER: AgeBand[] = ["infant", "child", "teen", "young_adult", "middle_aged", "senior"];

  for (let i = 0; i < AGE_ORDER.length; i++) {
    for (let j = i; j < AGE_ORDER.length; j++) {
      const diff = j - i;
      const expected = diff < 2; // 差 >= 2 → 拒绝（false），差 < 2 → 允许（true）

      it(`age_band: ${AGE_ORDER[i]} vs ${AGE_ORDER[j]}（差=${diff}）→ ${expected ? "允许合并" : "拒绝"}`, async () => {
        vi.resetModules();
        const { shouldMerge } = (await import("../clustering")) as {
          shouldMerge: ShouldMergeFn;
        };

        const attr = makeAttr({ age_band: AGE_ORDER[i] as AgeBand, gender: "unknown" });
        const summary = makeSummary({
          age_band_mode: AGE_ORDER[j] as AgeBand,
          gender_mode: "unknown",
          member_count_with_attr: 5,
        });

        expect(shouldMerge(attr, summary, 0.65, BASE_CONFIG)).toBe(expected);
      });
    }
  }
});

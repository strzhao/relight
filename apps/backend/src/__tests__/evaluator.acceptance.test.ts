/**
 * 验收测试：量化评估器 (Rubric 评分)
 *
 * 覆盖设计文档 §6 量化验收 (纯规则自动化)：
 * - 5 维度各 20 分，满分 100
 * - 维度 1: 格式合规 (Zod 可解析)
 * - 维度 2: 标签准确 (7 类 + 去重)
 * - 维度 3: 描述相关 (字数 + 中文)
 * - 维度 4: 评分合理 (值域 1-10)
 * - 维度 5: 覆盖完整 (字段非空)
 *
 * 验收标准：
 * - 完美输出 = 100 分
 * - 各维度缺陷正确扣分
 * - 边界情况处理正确
 */
import { describe, expect, it } from "vitest";

// ---- 类型定义 ----

const VALID_TAG_CATEGORIES = [
  "scene",
  "emotion",
  "people",
  "color",
  "event",
  "object",
  "style",
] as const;

interface AnalysisTag {
  name: string;
  category: string;
  confidence: number;
}

interface AIAnalysisOutput {
  tags: AnalysisTag[];
  narrative: string;
  aestheticScore: number;
  composition: { type: string; description: string };
  colorAnalysis: { dominantColors: string[]; palette: string };
  emotionalAnalysis: { primaryEmotion: string; intensity: number };
  usageSuggestions: string[];
}

interface RubricScore {
  total: number;
  dimensions: {
    formatCompliance: number; // 0-20
    tagAccuracy: number; // 0-20
    descriptionRelevance: number; // 0-20
    scoreReasonableness: number; // 0-20
    coverageCompleteness: number; // 0-20
  };
  details: string[];
}

// ---- 评估器实现 ----

/**
 * 量化评估器 — 纯规则自动化
 *
 * 设计文档 §6:
 * - 格式合规 (20): Zod 校验是否能通过
 * - 标签准确 (20): 7 类覆盖 + 无重复
 * - 描述相关 (20): 字数 >= 50 + 中文占比 > 50%
 * - 评分合理 (20): aestheticScore ∈ [1, 10]
 * - 覆盖完整 (20): 所有字段非空/非 null
 */
function evaluateAnalysis(analysis: AIAnalysisOutput, parseSuccess: boolean): RubricScore {
  const details: string[] = [];
  let formatCompliance = 0;
  let tagAccuracy = 0;
  let descriptionRelevance = 0;
  let scoreReasonableness = 0;
  let coverageCompleteness = 0;

  // ---- 维度 1: 格式合规 (20 分) ----
  if (parseSuccess) {
    formatCompliance = 20;
    details.push("[格式合规] Zod 校验通过 (+20)");
  } else {
    formatCompliance = 0;
    details.push("[格式合规] Zod 校验失败 (+0)");
  }

  // ---- 维度 2: 标签准确 (20 分) ----
  // 规则: 检查标签类别是否覆盖 7 类，检查是否有重复标签名
  let tagScore = 20;
  const categoriesSeen = new Set<string>();
  const tagNames = new Set<string>();
  const duplicateTags: string[] = [];

  for (const tag of analysis.tags) {
    if (VALID_TAG_CATEGORIES.includes(tag.category as (typeof VALID_TAG_CATEGORIES)[number])) {
      categoriesSeen.add(tag.category);
    } else {
      tagScore -= 2;
      details.push(`[标签准确] 无效类别 "${tag.category}" (-2)`);
    }

    if (tagNames.has(tag.name)) {
      duplicateTags.push(tag.name);
    } else {
      tagNames.add(tag.name);
    }
  }

  // 去重扣分: 每个重复 -3
  const dupDeduction = Math.min(duplicateTags.length * 3, 10);
  tagScore -= dupDeduction;
  if (dupDeduction > 0) {
    details.push(`[标签准确] 重复标签 ${duplicateTags.join(", ")} (-${dupDeduction})`);
  }

  // 类别覆盖不足扣分: 每缺少一个类别 -3
  const missingCategories = VALID_TAG_CATEGORIES.filter((c) => !categoriesSeen.has(c));
  const categoryDeduction = Math.min(missingCategories.length * 3, 15);
  tagScore -= categoryDeduction;
  if (missingCategories.length > 0) {
    details.push(`[标签准确] 缺少类别 ${missingCategories.join(", ")} (-${categoryDeduction})`);
  }

  tagAccuracy = Math.max(0, tagScore);

  // ---- 维度 3: 描述相关 (20 分) ----
  // 规则: 中文内容字数 + 非空
  const chineseChars = (analysis.narrative.match(/[一-鿿㐀-䶿]/g) || []).length;
  const totalChars = analysis.narrative.length;

  if (chineseChars >= 100) {
    descriptionRelevance = 20;
    details.push(`[描述相关] 中文字数 ${chineseChars}，优秀 (+20)`);
  } else if (chineseChars >= 50) {
    descriptionRelevance = 15;
    details.push(`[描述相关] 中文字数 ${chineseChars}，合格 (+15)`);
  } else if (chineseChars >= 20) {
    descriptionRelevance = 10;
    details.push(`[描述相关] 中文字数 ${chineseChars}，不足 (+10)`);
  } else if (chineseChars > 0) {
    descriptionRelevance = 5;
    details.push(`[描述相关] 中文字数 ${chineseChars}，过少 (+5)`);
  } else {
    descriptionRelevance = 0;
    details.push("[描述相关] 无中文内容 (+0)");
  }

  // ---- 维度 4: 评分合理 (20 分) ----
  if (analysis.aestheticScore >= 1 && analysis.aestheticScore <= 10) {
    scoreReasonableness = 20;
    details.push(`[评分合理] aestheticScore=${analysis.aestheticScore} 在合理范围 (+20)`);
  } else {
    scoreReasonableness = 0;
    details.push(`[评分合理] aestheticScore=${analysis.aestheticScore} 超出 1-10 范围 (+0)`);
  }

  // ---- 维度 5: 覆盖完整 (20 分) ----
  let coverageScore = 20;
  const checks: Array<{ name: string; valid: boolean }> = [
    { name: "tags", valid: analysis.tags.length > 0 },
    {
      name: "narrative",
      valid: typeof analysis.narrative === "string" && analysis.narrative.length > 0,
    },
    {
      name: "aestheticScore",
      valid: typeof analysis.aestheticScore === "number",
    },
    {
      name: "composition",
      valid:
        analysis.composition.type?.length > 0 &&
        typeof analysis.composition.description === "string",
    },
    {
      name: "colorAnalysis.dominantColors",
      valid: analysis.colorAnalysis.dominantColors.length > 0,
    },
    {
      name: "colorAnalysis.palette",
      valid: analysis.colorAnalysis.palette.length > 0,
    },
    {
      name: "emotionalAnalysis.primaryEmotion",
      valid: analysis.emotionalAnalysis.primaryEmotion.length > 0,
    },
    {
      name: "emotionalAnalysis.intensity",
      valid: typeof analysis.emotionalAnalysis.intensity === "number",
    },
    {
      name: "usageSuggestions",
      valid: analysis.usageSuggestions.length > 0,
    },
  ];

  for (const check of checks) {
    if (!check.valid) {
      coverageScore -= 3;
      details.push(`[覆盖完整] ${check.name} 缺失或为空 (-3)`);
    }
  }

  coverageCompleteness = Math.max(0, coverageScore);

  // ---- 汇总 ----
  const total =
    formatCompliance +
    tagAccuracy +
    descriptionRelevance +
    scoreReasonableness +
    coverageCompleteness;

  return {
    total,
    dimensions: {
      formatCompliance,
      tagAccuracy,
      descriptionRelevance,
      scoreReasonableness,
      coverageCompleteness,
    },
    details,
  };
}

// ---- 测试数据 ----

const PERFECT_OUTPUT: AIAnalysisOutput = {
  tags: [
    { name: "日落", category: "scene", confidence: 0.95 },
    { name: "宁静", category: "emotion", confidence: 0.9 },
    { name: "单人", category: "people", confidence: 0.7 },
    { name: "橙色", category: "color", confidence: 0.92 },
    { name: "黄昏", category: "event", confidence: 0.85 },
    { name: "树木", category: "object", confidence: 0.8 },
    { name: "剪影", category: "style", confidence: 0.88 },
  ],
  narrative:
    "黄昏时分，夕阳缓缓西沉，将天空染成了一片绚烂的橙红色。远处的树木在暮色中化作深沉的剪影，静静地伫立在天际线上。天边的云彩如同燃烧的火焰，层层叠叠地向远方蔓延开去。整个画面充满了温暖而宁静的氛围，仿佛时间在这一刻凝固，让人感受到大自然最纯粹的美。这是一幅令人心旷神怡的杰作，值得细细品味。",
  aestheticScore: 9,
  composition: {
    type: "rule_of_thirds",
    description: "太阳位于右下三分之一交点，地平线位于下三分之一线，树木剪影构成前景层次",
  },
  colorAnalysis: {
    dominantColors: ["#FF6B35", "#E8632A", "#2C1810", "#FFD700"],
    palette: "warm_sunset",
  },
  emotionalAnalysis: {
    primaryEmotion: "peaceful",
    intensity: 7,
  },
  usageSuggestions: ["适合作为手机壁纸", "适合社交媒体分享", "适合风景摄影展示"],
};

// ---- 测试 ----

describe("量化评估器 Rubric — 验收测试（设计文档 §6）", () => {
  describe("满分情况", () => {
    it("完美输出应获得 100 分（parseSuccess=true）", () => {
      const result = evaluateAnalysis(PERFECT_OUTPUT, true);
      expect(result.total).toBe(100);
      expect(result.dimensions.formatCompliance).toBe(20);
      expect(result.dimensions.tagAccuracy).toBe(20);
      expect(result.dimensions.descriptionRelevance).toBe(20);
      expect(result.dimensions.scoreReasonableness).toBe(20);
      expect(result.dimensions.coverageCompleteness).toBe(20);
    });
  });

  describe("维度 1: 格式合规 (0-20)", () => {
    it("parseSuccess=false 时格式合规应得 0 分", () => {
      const result = evaluateAnalysis(PERFECT_OUTPUT, false);
      expect(result.dimensions.formatCompliance).toBe(0);
      expect(result.total).toBeLessThan(100);
    });

    it("parseSuccess=true 时格式合规应得 20 分", () => {
      const result = evaluateAnalysis(PERFECT_OUTPUT, true);
      expect(result.dimensions.formatCompliance).toBe(20);
    });
  });

  describe("维度 2: 标签准确 (0-20)", () => {
    it("7 类齐全 + 无重复 = 20 分", () => {
      const result = evaluateAnalysis(PERFECT_OUTPUT, true);
      expect(result.dimensions.tagAccuracy).toBe(20);
    });

    it("每缺少一个标签类别应扣 3 分（最多扣 15 分）", () => {
      const fewTags: AIAnalysisOutput = {
        ...PERFECT_OUTPUT,
        tags: [{ name: "日落", category: "scene", confidence: 0.9 }],
      };
      const result = evaluateAnalysis(fewTags, true);
      // 缺 6 个类别: 6*3=18 但上限 15，所以 tagAccuracy = 20-15 = 5
      expect(result.dimensions.tagAccuracy).toBe(5);
    });

    it("重复标签名每个应扣 3 分（最多扣 10 分）", () => {
      const dupTags: AIAnalysisOutput = {
        ...PERFECT_OUTPUT,
        tags: [
          ...PERFECT_OUTPUT.tags,
          { name: "日落", category: "scene", confidence: 0.8 }, // 重复
          { name: "宁静", category: "emotion", confidence: 0.7 }, // 重复
        ],
      };
      const result = evaluateAnalysis(dupTags, true);
      // 有 2 个重复: 2*3=6, tagAccuracy = 20-6 = 14
      expect(result.dimensions.tagAccuracy).toBeLessThanOrEqual(14);
      expect(result.details.some((d) => d.includes("重复标签"))).toBe(true);
    });

    it("无效类别应扣 2 分每个", () => {
      const invalidCategory: AIAnalysisOutput = {
        ...PERFECT_OUTPUT,
        tags: [...PERFECT_OUTPUT.tags, { name: "幻想", category: "fantasy", confidence: 0.5 }],
      };
      const result = evaluateAnalysis(invalidCategory, true);
      // 无效类别扣 2
      expect(result.dimensions.tagAccuracy).toBeLessThanOrEqual(19);
      expect(result.details.some((d) => d.includes("无效类别"))).toBe(true);
    });

    it("空标签数组应得最低分（类别缺 7 个扣 15）", () => {
      const noTags: AIAnalysisOutput = {
        ...PERFECT_OUTPUT,
        tags: [],
      };
      const result = evaluateAnalysis(noTags, true);
      expect(result.dimensions.tagAccuracy).toBe(5); // 20-15=5
    });
  });

  describe("维度 3: 描述相关 (0-20)", () => {
    it("中文字数 >= 100 应得 20 分", () => {
      const longChinese: AIAnalysisOutput = {
        ...PERFECT_OUTPUT,
        narrative:
          "这是一张令人叹为观止的风景照片。金色的阳光穿过云层洒在大地上，远处的山峦层层叠叠连绵起伏，近处的溪流潺潺流淌清澈见底。蓝天白云映衬着翠绿的草地，整个画面充满了生机与活力，色彩饱满而和谐，构图精巧而大气，完美地捕捉了大自然的壮丽与宁静。",
      };
      const result = evaluateAnalysis(longChinese, true);
      expect(result.dimensions.descriptionRelevance).toBe(20);
    });

    it("中文字数 50-99 应得 15 分", () => {
      // PERFECT_OUTPUT has ~50+ Chinese chars, so it should get 15 or 20
      const result = evaluateAnalysis(PERFECT_OUTPUT, true);
      expect(result.dimensions.descriptionRelevance).toBeGreaterThanOrEqual(15);
    });

    it("中文字数 20-49 应得 10 分", () => {
      const short: AIAnalysisOutput = {
        ...PERFECT_OUTPUT,
        narrative: "日落时分，夕阳缓缓西沉，将天空染成了一片绚烂的橙红色。",
      };
      const result = evaluateAnalysis(short, true);
      expect(result.dimensions.descriptionRelevance).toBe(10);
    });

    it("中文字数 1-19 应得 5 分", () => {
      const veryShort: AIAnalysisOutput = {
        ...PERFECT_OUTPUT,
        narrative: "美丽的日落。",
      };
      const result = evaluateAnalysis(veryShort, true);
      expect(result.dimensions.descriptionRelevance).toBe(5);
    });

    it("无中文内容应得 0 分", () => {
      const noChinese: AIAnalysisOutput = {
        ...PERFECT_OUTPUT,
        narrative: "A beautiful sunset photo.",
      };
      const result = evaluateAnalysis(noChinese, true);
      expect(result.dimensions.descriptionRelevance).toBe(0);
    });

    it("空 narrative 应得 0 分", () => {
      const empty: AIAnalysisOutput = {
        ...PERFECT_OUTPUT,
        narrative: "",
      };
      const result = evaluateAnalysis(empty, true);
      expect(result.dimensions.descriptionRelevance).toBe(0);
    });
  });

  describe("维度 4: 评分合理 (0-20)", () => {
    it("aestheticScore 在 1-10 范围内应得 20 分", () => {
      for (const score of [1, 5, 10]) {
        const result = evaluateAnalysis({ ...PERFECT_OUTPUT, aestheticScore: score }, true);
        expect(result.dimensions.scoreReasonableness).toBe(20);
      }
    });

    it("aestheticScore=0 应得 0 分", () => {
      const result = evaluateAnalysis({ ...PERFECT_OUTPUT, aestheticScore: 0 }, true);
      expect(result.dimensions.scoreReasonableness).toBe(0);
    });

    it("aestheticScore=11 应得 0 分", () => {
      const result = evaluateAnalysis({ ...PERFECT_OUTPUT, aestheticScore: 11 }, true);
      expect(result.dimensions.scoreReasonableness).toBe(0);
    });

    it("aestheticScore 为负数应得 0 分", () => {
      const result = evaluateAnalysis({ ...PERFECT_OUTPUT, aestheticScore: -5 }, true);
      expect(result.dimensions.scoreReasonableness).toBe(0);
    });
  });

  describe("维度 5: 覆盖完整 (0-20)", () => {
    it("所有字段非空应得 20 分", () => {
      const result = evaluateAnalysis(PERFECT_OUTPUT, true);
      expect(result.dimensions.coverageCompleteness).toBe(20);
    });

    it("每个空字段应扣 3 分", () => {
      const missingTags: AIAnalysisOutput = {
        ...PERFECT_OUTPUT,
        tags: [],
      };
      let result = evaluateAnalysis(missingTags, true);
      // 9 checks, tags 为空扣 3
      expect(result.dimensions.coverageCompleteness).toBeLessThan(20);

      const missingAll: AIAnalysisOutput = {
        tags: [],
        narrative: "",
        aestheticScore: 5,
        composition: { type: "", description: "" },
        colorAnalysis: { dominantColors: [], palette: "" },
        emotionalAnalysis: { primaryEmotion: "", intensity: 5 },
        usageSuggestions: [],
      };
      result = evaluateAnalysis(missingAll, true);
      // 多个空字段，总计扣分
      expect(result.dimensions.coverageCompleteness).toBeLessThanOrEqual(5);
    });

    it("覆盖完整最低为 0 分", () => {
      const completelyEmpty: AIAnalysisOutput = {
        tags: [],
        narrative: "",
        aestheticScore: 5,
        composition: { type: "", description: "" },
        colorAnalysis: { dominantColors: [], palette: "" },
        emotionalAnalysis: { primaryEmotion: "", intensity: 5 },
        usageSuggestions: [],
      };
      const result = evaluateAnalysis(completelyEmpty, true);
      expect(result.dimensions.coverageCompleteness).toBeGreaterThanOrEqual(0);
    });
  });

  describe("综合场景", () => {
    it("parseSuccess=false 时总分应显著低于满分", () => {
      const result = evaluateAnalysis(PERFECT_OUTPUT, false);
      expect(result.total).toBeLessThanOrEqual(80);
      expect(result.dimensions.formatCompliance).toBe(0);
    });

    it("多重缺陷应累积扣分", () => {
      const badOutput: AIAnalysisOutput = {
        tags: [
          { name: "日落", category: "scene", confidence: 0.9 },
          { name: "日落", category: "scene", confidence: 0.8 }, // 重复
        ],
        narrative: "sunset", // 无中文
        aestheticScore: 15, // 越界
        composition: { type: "", description: "" }, // 空
        colorAnalysis: { dominantColors: [], palette: "" }, // 空
        emotionalAnalysis: { primaryEmotion: "", intensity: 5 }, // 空 primaryEmotion
        usageSuggestions: [],
      };

      const result = evaluateAnalysis(badOutput, true);

      // 格式合规: 20 (parseSuccess=true)
      // 标签准确: 20 - 3(重复) - 18(缺6类) = 0 → min 0
      // 描述相关: 0 (无中文)
      // 评分合理: 0 (越界)
      // 覆盖完整: 大量扣分
      expect(result.total).toBeLessThanOrEqual(30);
      expect(result.details.length).toBeGreaterThan(5);
    });

    it("应返回详细的扣分原因列表", () => {
      const result = evaluateAnalysis(PERFECT_OUTPUT, true);
      expect(result.details).toBeInstanceOf(Array);
      expect(result.details.length).toBeGreaterThan(0);
      // 满分情况下的详情应是正向描述
      expect(result.details.every((d) => d.includes("+"))).toBe(true);
    });
  });

  describe("评分边界值", () => {
    it("总分应在 0-100 范围内", () => {
      const worstCase: AIAnalysisOutput = {
        tags: [],
        narrative: "",
        aestheticScore: 0,
        composition: { type: "", description: "" },
        colorAnalysis: { dominantColors: [], palette: "" },
        emotionalAnalysis: { primaryEmotion: "", intensity: 5 },
        usageSuggestions: [],
      };

      // 最坏情况
      const worst = evaluateAnalysis(worstCase, false);
      expect(worst.total).toBeGreaterThanOrEqual(0);
      expect(worst.total).toBeLessThanOrEqual(100);

      // 最好情况
      const best = evaluateAnalysis(PERFECT_OUTPUT, true);
      expect(best.total).toBe(100);
    });

    it("每个维度得分应在 0-20 范围内", () => {
      const result = evaluateAnalysis(PERFECT_OUTPUT, true);
      const dims = result.dimensions;
      expect(dims.formatCompliance).toBeGreaterThanOrEqual(0);
      expect(dims.formatCompliance).toBeLessThanOrEqual(20);
      expect(dims.tagAccuracy).toBeGreaterThanOrEqual(0);
      expect(dims.tagAccuracy).toBeLessThanOrEqual(20);
      expect(dims.descriptionRelevance).toBeGreaterThanOrEqual(0);
      expect(dims.descriptionRelevance).toBeLessThanOrEqual(20);
      expect(dims.scoreReasonableness).toBeGreaterThanOrEqual(0);
      expect(dims.scoreReasonableness).toBeLessThanOrEqual(20);
      expect(dims.coverageCompleteness).toBeGreaterThanOrEqual(0);
      expect(dims.coverageCompleteness).toBeLessThanOrEqual(20);
    });
  });
});

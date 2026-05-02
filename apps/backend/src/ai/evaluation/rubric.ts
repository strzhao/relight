/**
 * 量化验收评分 Rubric
 *
 * 5 个维度，各 20 分，满分 100 分。
 * 所有评分均为纯规则自动化，不依赖 AI。
 */

export interface DimensionScore {
  name: string;
  score: number; // 0-20
  maxScore: number; // 20
  details: string[];
}

export interface EvaluationResult {
  dimensions: DimensionScore[];
  totalScore: number; // 0-100
  maxScore: number; // 100
  passed: boolean; // >= 80 为通过
  summary: string;
}

export const RUBRIC_DIMENSIONS = [
  {
    key: "formatCompliance",
    name: "格式合规",
    description: "Zod 校验通过 + JSON 格式正确",
  },
  {
    key: "tagAccuracy",
    name: "标签准确",
    description: "7 类标签 + 去重 + 置信度范围",
  },
  {
    key: "descriptionRelevance",
    name: "描述相关",
    description: "字数范围 + 语言为中文 + 内容有意义",
  },
  {
    key: "scoreReasonableness",
    name: "评分合理",
    description: "美学评分在有效值域内 + 构图评分在有效值域内",
  },
  {
    key: "completeness",
    name: "覆盖完整",
    description: "所有必填字段非空 / 非默认值",
  },
] as const;

/** 标签类别集合（用于快速查找） */
export const TAG_CATEGORIES_SET = new Set([
  "scene",
  "emotion",
  "people",
  "color",
  "event",
  "object",
  "style",
]);

/** 叙事描述字数范围 */
export const NARRATIVE_MIN_CHARS = 50;
export const NARRATIVE_MAX_CHARS = 200;

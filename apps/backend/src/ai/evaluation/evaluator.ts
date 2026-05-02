import type { PhotoAnalysisResponse } from "../response-parser";
import {
  type DimensionScore,
  type EvaluationResult,
  NARRATIVE_MAX_CHARS,
  NARRATIVE_MIN_CHARS,
  TAG_CATEGORIES_SET,
} from "./rubric";

/**
 * 自动评估器（纯规则，无 AI 依赖）
 *
 * 对 AI 分析结果进行 5 维度量化评分，每维度 20 分，满分 100。
 */
export function evaluateResponse(
  parsed: PhotoAnalysisResponse | null,
  rawResponse: string,
  zodError: string | null,
): EvaluationResult {
  const dimensions: DimensionScore[] = [];

  dimensions.push(evaluateFormatCompliance(parsed, rawResponse, zodError));
  dimensions.push(evaluateTagAccuracy(parsed));
  dimensions.push(evaluateDescriptionRelevance(parsed));
  dimensions.push(evaluateScoreReasonableness(parsed));
  dimensions.push(evaluateCompleteness(parsed));

  const totalScore = dimensions.reduce((sum, d) => sum + d.score, 0);
  const maxScore = dimensions.reduce((sum, d) => sum + d.maxScore, 0);
  const passed = totalScore >= 80;

  const summary = passed
    ? `通过 (${totalScore}/${maxScore})`
    : `未通过 (${totalScore}/${maxScore}) - 需优化`;

  return { dimensions, totalScore, maxScore, passed, summary };
}

/** 维度 1: 格式合规 (20 分) */
function evaluateFormatCompliance(
  parsed: PhotoAnalysisResponse | null,
  rawResponse: string,
  zodError: string | null,
): DimensionScore {
  const details: string[] = [];
  let score = 0;

  // JSON 块存在 (5 分)
  const hasJsonBlock = /```json[\s\S]*?```/i.test(rawResponse);
  if (hasJsonBlock) {
    score += 5;
    details.push("[5/5] 响应包含 ```json 代码块");
  } else {
    details.push("[0/5] 响应缺少 ```json 代码块");
  }

  // JSON 可解析 (5 分)
  const hasJson = /\{[\s\S]*\}/.test(rawResponse);
  if (hasJson) {
    score += 5;
    details.push("[5/5] 响应包含有效 JSON 结构");
  } else {
    details.push("[0/5] 响应不包含有效 JSON 结构");
  }

  // Zod 校验通过 (10 分)
  if (!zodError && parsed !== null) {
    score += 10;
    details.push("[10/10] Zod 校验通过");
  } else if (parsed !== null) {
    // 部分通过（使用容错恢复）
    score += 5;
    details.push(`[5/10] Zod 校验失败但容错恢复: ${zodError ?? "未知错误"}`);
  } else {
    details.push("[0/10] Zod 校验失败，无法恢复");
  }

  return { name: "格式合规", score, maxScore: 20, details };
}

/** 维度 2: 标签准确 (20 分) */
function evaluateTagAccuracy(parsed: PhotoAnalysisResponse | null): DimensionScore {
  const details: string[] = [];
  let score = 0;

  if (!parsed?.tags || parsed.tags.length === 0) {
    details.push("[0/20] 没有有效标签");
    return { name: "标签准确", score: 0, maxScore: 20, details };
  }

  const tags = parsed.tags;

  // 类别有效性 (8 分)
  const validCategories = tags.filter((t) => TAG_CATEGORIES_SET.has(t.category));
  const categoryRatio = validCategories.length / tags.length;
  const categoryScore = Math.round(categoryRatio * 8);
  score += categoryScore;
  details.push(`[${categoryScore}/8] ${validCategories.length}/${tags.length} 个标签类别有效`);

  // 标签去重 (8 分)
  const uniqueNames = new Set(tags.map((t) => t.name));
  const dupRatio = uniqueNames.size / tags.length;
  const dedupScore = Math.round(dupRatio * 8);
  score += dedupScore;
  details.push(`[${dedupScore}/8] ${uniqueNames.size}/${tags.length} 个不重复标签名`);

  // 置信度范围 (4 分)
  const validConfidence = tags.filter((t) => t.confidence >= 0 && t.confidence <= 1);
  const confidenceScore = validConfidence.length === tags.length ? 4 : 2;
  score += confidenceScore;
  details.push(
    `[${confidenceScore}/4] ${validConfidence.length}/${tags.length} 个置信度在 [0,1] 范围`,
  );

  return { name: "标签准确", score, maxScore: 20, details };
}

/** 维度 3: 描述相关 (20 分) */
function evaluateDescriptionRelevance(parsed: PhotoAnalysisResponse | null): DimensionScore {
  const details: string[] = [];
  let score = 0;

  if (!parsed?.narrative) {
    details.push("[0/20] 没有叙事描述");
    return { name: "描述相关", score: 0, maxScore: 20, details };
  }

  const narrative = parsed.narrative;

  // 字数范围 (10 分)
  const len = narrative.length;
  if (len >= NARRATIVE_MIN_CHARS && len <= NARRATIVE_MAX_CHARS) {
    score += 10;
    details.push(
      `[10/10] 描述长度 ${len} 字在 [${NARRATIVE_MIN_CHARS}, ${NARRATIVE_MAX_CHARS}] 范围内`,
    );
  } else if (len >= NARRATIVE_MIN_CHARS * 0.5 && len <= NARRATIVE_MAX_CHARS * 1.5) {
    score += 5;
    details.push(`[5/10] 描述长度 ${len} 字接近目标范围`);
  } else {
    details.push(`[0/10] 描述长度 ${len} 字偏离目标范围`);
  }

  // 中文内容 (5 分)
  const chineseCount = (narrative.match(/[一-鿿]/g) ?? []).length;
  const chineseRatio = chineseCount / len;
  if (chineseRatio > 0.3) {
    score += 5;
    details.push(`[5/5] 中文占比 ${(chineseRatio * 100).toFixed(0)}%`);
  } else if (chineseRatio > 0.1) {
    score += 2;
    details.push(`[2/5] 中文占比偏低 ${(chineseRatio * 100).toFixed(0)}%`);
  } else {
    details.push(`[0/5] 中文占比过低 ${(chineseRatio * 100).toFixed(0)}%`);
  }

  // 非默认文本 (5 分)
  const isDefaultText =
    narrative.includes("AI 分析失败") ||
    narrative.includes("使用默认值") ||
    narrative.trim().length === 0;
  if (!isDefaultText) {
    score += 5;
    details.push("[5/5] 描述非默认/占位文本");
  } else {
    details.push("[0/5] 描述为默认/占位文本");
  }

  return { name: "描述相关", score, maxScore: 20, details };
}

/** 维度 4: 评分合理 (20 分) */
function evaluateScoreReasonableness(parsed: PhotoAnalysisResponse | null): DimensionScore {
  const details: string[] = [];
  let score = 0;

  if (!parsed) {
    details.push("[0/20] 无分析结果");
    return { name: "评分合理", score: 0, maxScore: 20, details };
  }

  // 美学评分合理 (10 分)
  if (typeof parsed.aestheticScore === "number") {
    if (parsed.aestheticScore >= 0 && parsed.aestheticScore <= 10) {
      // 不是极端默认值
      if (parsed.aestheticScore !== 5.0) {
        score += 10;
        details.push(`[10/10] 美学评分 ${parsed.aestheticScore} 在有效范围且非默认值`);
      } else {
        score += 6;
        details.push(`[6/10] 美学评分 ${parsed.aestheticScore} 在有效范围但为默认值`);
      }
    } else {
      details.push(`[0/10] 美学评分 ${parsed.aestheticScore} 超出 [0,10] 范围`);
    }
  } else {
    details.push("[0/10] 美学评分缺失");
  }

  // 构图评分合理 (5 分)
  const compScore = parsed.composition?.score;
  if (typeof compScore === "number") {
    if (compScore >= 0 && compScore <= 10) {
      if (compScore !== 5.0) {
        score += 5;
        details.push(`[5/5] 构图评分 ${compScore} 在有效范围且非默认值`);
      } else {
        score += 3;
        details.push(`[3/5] 构图评分 ${compScore} 在有效范围但为默认值`);
      }
    } else {
      details.push(`[0/5] 构图评分 ${compScore} 超出 [0,10] 范围`);
    }
  } else {
    details.push("[0/5] 构图评分缺失");
  }

  // 情感强度合理 (5 分)
  const intensity = parsed.emotionalAnalysis?.intensity;
  if (typeof intensity === "number") {
    if (intensity >= 0 && intensity <= 1) {
      if (intensity !== 0.5) {
        score += 5;
        details.push(`[5/5] 情感强度 ${intensity} 在有效范围且非默认值`);
      } else {
        score += 3;
        details.push(`[3/5] 情感强度 ${intensity} 在有效范围但为默认值`);
      }
    } else {
      details.push(`[0/5] 情感强度 ${intensity} 超出 [0,1] 范围`);
    }
  } else {
    details.push("[0/5] 情感强度缺失");
  }

  return { name: "评分合理", score, maxScore: 20, details };
}

/** 维度 5: 覆盖完整 (20 分) */
function evaluateCompleteness(parsed: PhotoAnalysisResponse | null): DimensionScore {
  const details: string[] = [];
  let score = 0;

  if (!parsed) {
    details.push("[0/20] 无分析结果");
    return { name: "覆盖完整", score: 0, maxScore: 20, details };
  }

  // narrative (4 分)
  if (parsed.narrative && parsed.narrative.trim().length > 0) {
    score += 4;
    details.push("[4/4] narrative 存在");
  } else {
    details.push("[0/4] narrative 缺失");
  }

  // tags (4 分)
  if (parsed.tags && parsed.tags.length > 0) {
    score += 4;
    details.push(`[4/4] tags 有 ${parsed.tags.length} 个标签`);
  } else {
    details.push("[0/4] tags 为空");
  }

  // composition (3 分)
  if (parsed.composition) {
    score += 3;
    details.push("[3/3] composition 存在");
  } else {
    details.push("[0/3] composition 缺失");
  }

  // colorAnalysis (3 分)
  if (parsed.colorAnalysis) {
    score += 3;
    details.push("[3/3] colorAnalysis 存在");
  } else {
    details.push("[0/3] colorAnalysis 缺失");
  }

  // emotionalAnalysis (3 分)
  if (parsed.emotionalAnalysis) {
    score += 3;
    details.push("[3/3] emotionalAnalysis 存在");
  } else {
    details.push("[0/3] emotionalAnalysis 缺失");
  }

  // usageSuggestions (3 分)
  if (parsed.usageSuggestions && parsed.usageSuggestions.trim().length > 0) {
    score += 3;
    details.push("[3/3] usageSuggestions 存在");
  } else {
    details.push("[0/3] usageSuggestions 缺失");
  }

  return { name: "覆盖完整", score, maxScore: 20, details };
}

import { z } from "zod";

// ===== Zod Schemas =====

const tagCategoryEnum = z.enum(["scene", "emotion", "people", "color", "event", "object", "style"]);

const analysisTagSchema = z.object({
  name: z.string().min(1),
  category: tagCategoryEnum,
  confidence: z.number().min(0).max(1),
});

const compositionSchema = z.object({
  type: z.string().min(1),
  score: z.number().min(0).max(10),
  description: z.string().min(1),
});

const colorAnalysisSchema = z.object({
  palette: z.array(z.string().min(1)).min(1),
  dominant: z.string().min(1),
  mood: z.string().min(1),
});

const emotionalAnalysisSchema = z.object({
  primary: z.string().min(1),
  secondary: z.string().min(1),
  intensity: z.number().min(0).max(1),
});

export const photoAnalysisResponseSchema = z.object({
  narrative: z.string().min(1),
  aestheticScore: z.number().min(0).max(10),
  tags: z.array(analysisTagSchema).min(1).max(20),
  composition: compositionSchema,
  colorAnalysis: colorAnalysisSchema,
  emotionalAnalysis: emotionalAnalysisSchema,
  usageSuggestions: z.string().min(1),
});

export type PhotoAnalysisResponse = z.infer<typeof photoAnalysisResponseSchema>;

// ===== 每日精选 — 阶段 1 评选响应 =====

export const dailySelectResponseSchema = z.object({
  selectedIndex: z.number().int().min(0),
  reasoning: z.string().min(1),
});

export type DailySelectResponse = z.infer<typeof dailySelectResponseSchema>;

// ===== 每日精选 — 阶段 2 怀旧叙事响应 =====

export const dailyNarrateResponseSchema = z.object({
  title: z.string().min(1).max(8),
  narrative: z.string().min(10).max(200),
  score: z.number().min(0).max(10),
  reasoning: z.string().min(1),
});

export type DailyNarrateResponse = z.infer<typeof dailyNarrateResponseSchema>;

// ===== 标签类别列表（用于默认值填充） =====

export const VALID_TAG_CATEGORIES = [
  "scene",
  "emotion",
  "people",
  "color",
  "event",
  "object",
  "style",
] as const;

// ===== 默认值 =====

const defaultComposition = {
  type: "未识别",
  score: 5.0,
  description: "无法识别构图类型",
};

const defaultColorAnalysis = {
  palette: ["#888888"],
  dominant: "未知",
  mood: "未知",
};

const defaultEmotionalAnalysis = {
  primary: "未知",
  secondary: "未知",
  intensity: 0.5,
};

const defaultTags = [{ name: "待分类", category: "scene" as const, confidence: 0.5 }];

// ===== 解析器 =====

const JSON_BLOCK_RE = /```json\s*([\s\S]*?)\s*```/i;
const JSON_FALLBACK_RE = /\{[\s\S]*\}/;

/**
 * 从 AI 响应中提取并校验 JSON 分析结果
 *
 * 解析策略：
 * 1. 正则提取 ```json 代码块
 * 2. Zod 校验结构
 * 3. 校验失败时返回带默认值的容错结果
 */
export function parseAnalysisResponse(rawResponse: string): {
  parsed: PhotoAnalysisResponse | null;
  error: string | null;
  fallback: PhotoAnalysisResponse;
} {
  let jsonStr: string | null = null;

  // Step 1: 尝试提取 ```json 代码块
  const blockMatch = rawResponse.match(JSON_BLOCK_RE);
  if (blockMatch?.[1]) {
    jsonStr = blockMatch[1].trim();
  } else {
    // 回退：尝试匹配第一个 JSON 对象
    const fallbackMatch = rawResponse.match(JSON_FALLBACK_RE);
    if (fallbackMatch?.[0]) {
      jsonStr = fallbackMatch[0].trim();
    }
  }

  if (!jsonStr) {
    const fallback = buildFallback();
    return { parsed: null, error: "未能从响应中提取 JSON", fallback };
  }

  // Step 2: JSON.parse
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(jsonStr);
  } catch (e) {
    const fallback = buildFallback();
    return {
      parsed: null,
      error: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
      fallback,
    };
  }

  // Step 3: Zod 校验
  const result = photoAnalysisResponseSchema.safeParse(rawJson);

  if (result.success) {
    return { parsed: result.data, error: null, fallback: result.data };
  }

  // Step 4: 校验失败 — 尝试容错修复
  const fallback = buildFallbackWithPartial(rawJson);
  return {
    parsed: null,
    error: `Zod 校验失败: ${result.error.message}`,
    fallback,
  };
}

/**
 * 构建完全默认的响应
 */
function buildFallback(): PhotoAnalysisResponse {
  return {
    narrative: "（AI 分析失败，使用默认值）",
    aestheticScore: 5.0,
    tags: defaultTags,
    composition: defaultComposition,
    colorAnalysis: defaultColorAnalysis,
    emotionalAnalysis: defaultEmotionalAnalysis,
    usageSuggestions: "暂无建议",
  };
}

/**
 * 尝试使用部分解析结果+默认值构建响应
 */
function buildFallbackWithPartial(rawJson: unknown): PhotoAnalysisResponse {
  const fallback = buildFallback();

  if (typeof rawJson !== "object" || rawJson === null) return fallback;

  const obj = rawJson as Record<string, unknown>;

  if (typeof obj.narrative === "string" && obj.narrative.length > 0) {
    fallback.narrative = obj.narrative;
  }
  if (
    typeof obj.aestheticScore === "number" &&
    obj.aestheticScore >= 0 &&
    obj.aestheticScore <= 10
  ) {
    fallback.aestheticScore = obj.aestheticScore;
  }
  if (Array.isArray(obj.tags) && obj.tags.length > 0) {
    const validTags = obj.tags
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => ({
        name: typeof t.name === "string" ? t.name : "未知",
        category: VALID_TAG_CATEGORIES.includes(t.category as never)
          ? (t.category as (typeof VALID_TAG_CATEGORIES)[number])
          : "scene",
        confidence:
          typeof t.confidence === "number" && t.confidence >= 0 && t.confidence <= 1
            ? t.confidence
            : 0.5,
      }));
    if (validTags.length > 0) {
      fallback.tags = validTags;
    }
  }
  if (typeof obj.composition === "object" && obj.composition !== null) {
    const comp = obj.composition as Record<string, unknown>;
    if (typeof comp.type === "string") fallback.composition.type = comp.type;
    if (typeof comp.score === "number" && comp.score >= 0 && comp.score <= 10)
      fallback.composition.score = comp.score;
    if (typeof comp.description === "string") fallback.composition.description = comp.description;
  }
  if (typeof obj.colorAnalysis === "object" && obj.colorAnalysis !== null) {
    const ca = obj.colorAnalysis as Record<string, unknown>;
    if (Array.isArray(ca.palette)) fallback.colorAnalysis.palette = ca.palette as string[];
    if (typeof ca.dominant === "string") fallback.colorAnalysis.dominant = ca.dominant;
    if (typeof ca.mood === "string") fallback.colorAnalysis.mood = ca.mood;
  }
  if (typeof obj.emotionalAnalysis === "object" && obj.emotionalAnalysis !== null) {
    const ea = obj.emotionalAnalysis as Record<string, unknown>;
    if (typeof ea.primary === "string") fallback.emotionalAnalysis.primary = ea.primary;
    if (typeof ea.secondary === "string") fallback.emotionalAnalysis.secondary = ea.secondary;
    if (typeof ea.intensity === "number" && ea.intensity >= 0 && ea.intensity <= 1)
      fallback.emotionalAnalysis.intensity = ea.intensity;
  }
  if (typeof obj.usageSuggestions === "string" && obj.usageSuggestions.length > 0) {
    fallback.usageSuggestions = obj.usageSuggestions;
  }

  return fallback;
}

/**
 * 通用 JSON 提取器：从 AI 响应中提取 JSON 字符串并 parse
 */
function extractAndParseJson(rawResponse: string): {
  parsed: Record<string, unknown> | null;
  error: string | null;
} {
  let jsonStr: string | null = null;

  const blockMatch = rawResponse.match(JSON_BLOCK_RE);
  if (blockMatch?.[1]) {
    jsonStr = blockMatch[1].trim();
  } else {
    const fallbackMatch = rawResponse.match(JSON_FALLBACK_RE);
    if (fallbackMatch?.[0]) {
      jsonStr = fallbackMatch[0].trim();
    }
  }

  if (!jsonStr) {
    return { parsed: null, error: "未能从响应中提取 JSON" };
  }

  try {
    const rawJson = JSON.parse(jsonStr);
    if (typeof rawJson === "object" && rawJson !== null) {
      return { parsed: rawJson as Record<string, unknown>, error: null };
    }
    return { parsed: null, error: "JSON 解析结果不是对象" };
  } catch (e) {
    return {
      parsed: null,
      error: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 解析每日精选阶段 1 评选响应
 */
export function parseDailySelectResponse(rawResponse: string): {
  parsed: DailySelectResponse | null;
  error: string | null;
  fallback: DailySelectResponse;
} {
  const { parsed: rawJson, error: extractError } = extractAndParseJson(rawResponse);

  if (extractError || !rawJson) {
    const fallback = { selectedIndex: 0, reasoning: "" };
    return { parsed: null, error: extractError, fallback };
  }

  const result = dailySelectResponseSchema.safeParse(rawJson);

  if (result.success) {
    return { parsed: result.data, error: null, fallback: result.data };
  }

  // 容错恢复
  const fallback: DailySelectResponse = {
    selectedIndex:
      typeof rawJson.selectedIndex === "number" && rawJson.selectedIndex >= 0
        ? rawJson.selectedIndex
        : 0,
    reasoning:
      typeof rawJson.reasoning === "string" && rawJson.reasoning.length > 0
        ? rawJson.reasoning
        : "",
  };

  return {
    parsed: null,
    error: `Zod 校验失败: ${result.error.message}`,
    fallback,
  };
}

// ===== 每日精选 — 阶段 1.5 关联成员选择响应 =====

export const dailyMemberItemSchema = z.object({
  index: z.number().int().min(0),
  caption: z.string().min(1).max(30),
});

export const dailyMembersResponseSchema = z.object({
  members: z.array(dailyMemberItemSchema),
});

export type DailyMembersResponse = z.infer<typeof dailyMembersResponseSchema>;

/**
 * 解析每日精选阶段 1.5 关联成员选择响应
 *
 * @param rawResponse AI 原始响应字符串
 * @param poolSize 关联候选池大小，用于 index 越界过滤
 */
export function parseDailyMembersResponse(
  rawResponse: string,
  poolSize: number,
): {
  parsed: DailyMembersResponse | null;
  error: string | null;
  fallback: DailyMembersResponse;
} {
  const fallback: DailyMembersResponse = { members: [] };

  const { parsed: rawJson, error: extractError } = extractAndParseJson(rawResponse);

  if (extractError || !rawJson) {
    return { parsed: null, error: extractError, fallback };
  }

  const result = dailyMembersResponseSchema.safeParse(rawJson);

  let members: { index: number; caption: string }[] = [];

  if (result.success) {
    members = result.data.members;
  } else {
    // 容错：尝试从 rawJson 中手动提取
    const rawMembers = rawJson.members;
    if (Array.isArray(rawMembers)) {
      for (const m of rawMembers) {
        if (typeof m === "object" && m !== null) {
          const item = m as Record<string, unknown>;
          if (typeof item.index === "number" && typeof item.caption === "string") {
            members.push({
              index: item.index,
              caption: String(item.caption).slice(0, 30),
            });
          }
        }
      }
    }
    if (members.length === 0) {
      return {
        parsed: null,
        error: `Zod 校验失败: ${result.error.message}`,
        fallback,
      };
    }
  }

  // 越界过滤：保留 0 ≤ index < poolSize，丢弃越界项
  const validMembers = members.filter((m) => m.index >= 0 && m.index < poolSize);

  // 最多 8 张
  const trimmed = validMembers.slice(0, 8);

  const parsed: DailyMembersResponse = { members: trimmed };
  return { parsed, error: result.success ? null : "容错恢复", fallback: parsed };
}

/**
 * 解析每日精选阶段 2 怀旧叙事响应
 */
export function parseDailyNarrateResponse(rawResponse: string): {
  parsed: DailyNarrateResponse | null;
  error: string | null;
  fallback: DailyNarrateResponse;
} {
  const { parsed: rawJson, error: extractError } = extractAndParseJson(rawResponse);

  if (extractError || !rawJson) {
    const fallback: DailyNarrateResponse = {
      title: "今日拾光",
      narrative: "",
      score: 5.0,
      reasoning: "",
    };
    return { parsed: null, error: extractError, fallback };
  }

  const result = dailyNarrateResponseSchema.safeParse(rawJson);

  if (result.success) {
    return { parsed: result.data, error: null, fallback: result.data };
  }

  // 容错恢复
  const fallback: DailyNarrateResponse = {
    title:
      typeof rawJson.title === "string" && rawJson.title.length > 0
        ? rawJson.title.slice(0, 8)
        : "今日拾光",
    narrative:
      typeof rawJson.narrative === "string" && rawJson.narrative.length > 0
        ? rawJson.narrative
        : "",
    score:
      typeof rawJson.score === "number" && rawJson.score >= 0 && rawJson.score <= 10
        ? rawJson.score
        : 5.0,
    reasoning:
      typeof rawJson.reasoning === "string" && rawJson.reasoning.length > 0
        ? rawJson.reasoning
        : "",
  };

  return {
    parsed: null,
    error: `Zod 校验失败: ${result.error.message}`,
    fallback,
  };
}

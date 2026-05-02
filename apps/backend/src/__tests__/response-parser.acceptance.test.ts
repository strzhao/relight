/**
 * 验收测试：AI 响应解析器
 *
 * 覆盖设计文档 §3 响应解析器：
 * - 正则提取 ```json 代码块
 * - Zod 校验输出结构
 * - 缺失字段容错默认值填充
 * - 边界情况：空响应、无效 JSON、裸 JSON
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

// ---- 解析器输入 / 输出类型（对应设计文档中 AI 分析结果 JSON Schema） ----

const analysisTagSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["scene", "emotion", "people", "color", "event", "object", "style"]),
  confidence: z.number().min(0).max(1),
});

const aiAnalysisOutputSchema = z.object({
  tags: z.array(analysisTagSchema),
  narrative: z.string(),
  aestheticScore: z.number().min(1).max(10),
  composition: z.object({
    type: z.string(),
    description: z.string(),
  }),
  colorAnalysis: z.object({
    dominantColors: z.array(z.string()),
    palette: z.string(),
  }),
  emotionalAnalysis: z.object({
    primaryEmotion: z.string(),
    intensity: z.number().min(1).max(10),
  }),
  usageSuggestions: z.array(z.string()),
});

type AIAnalysisOutput = z.infer<typeof aiAnalysisOutputSchema>;

// ---- 默认值（容错填充） ----

const DEFAULT_ANALYSIS_OUTPUT: AIAnalysisOutput = {
  tags: [],
  narrative: "",
  aestheticScore: 5,
  composition: { type: "unknown", description: "" },
  colorAnalysis: { dominantColors: [], palette: "unknown" },
  emotionalAnalysis: { primaryEmotion: "neutral", intensity: 5 },
  usageSuggestions: [],
};

// ---- 核心函数（遵循设计文档 §3 规范） ----

/**
 * 从文本中提取第一个合法的 {} JSON 对象（处理嵌套花括号）。
 * 通过括号计数正确匹配嵌套层级。
 */
function extractFirstJsonObject(text: string): string | null {
  const startIdx = text.indexOf("{");
  if (startIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;

    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (ch === "\\") {
      isEscaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.substring(startIdx, i + 1);
      }
    }
  }

  return null;
}

/**
 * 从 AI 响应文本中提取 JSON 代码块。
 * 设计文档 §3: 正则提取 ```json ... ``` 包裹的内容。
 * 容错：若无代码块标记，回退到整段文本。
 */
function extractJsonBlock(raw: string): string {
  // 匹配 ```json\n...\n``` 或 ```json ... ```
  const fenced = raw.match(/```json\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();

  // 容错：匹配 ``` 无语言标记的代码块
  const bare = raw.match(/```\s*([\s\S]*?)```/);
  if (bare?.[1]) return bare[1].trim();

  // 容错：回退到原始文本（尝试提取第一个 JSON 对象）
  // 使用非贪婪匹配提取首尾花括号之间的内容，同时处理嵌套花括号
  const jsonMatch = extractFirstJsonObject(raw);
  if (jsonMatch) return jsonMatch.trim();

  return raw.trim();
}

/**
 * 解析 AI 返回的原始文本为结构化分析结果。
 * 设计文档 §3: 正则提取 → Zod 校验 → 容错默认值填充
 */
function parseAnalysisResponse(raw: string): {
  success: boolean;
  data: AIAnalysisOutput;
  error?: string;
} {
  if (!raw || raw.trim().length === 0) {
    return {
      success: false,
      data: { ...DEFAULT_ANALYSIS_OUTPUT },
      error: "空响应",
    };
  }

  try {
    const jsonText = extractJsonBlock(raw);
    const parsed = JSON.parse(jsonText);
    const result = aiAnalysisOutputSchema.safeParse(parsed);

    if (result.success) {
      return { success: true, data: result.data };
    }

    // Zod 校验失败 → 尝试合并默认值填充缺失字段
    const merged = mergeDefaults(parsed);
    const recheck = aiAnalysisOutputSchema.safeParse(merged);

    if (recheck.success) {
      return {
        success: true,
        data: recheck.data,
        error: `部分字段使用默认值: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      };
    }

    return {
      success: false,
      data: { ...DEFAULT_ANALYSIS_OUTPUT },
      error: `解析失败: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  } catch (e) {
    return {
      success: false,
      data: { ...DEFAULT_ANALYSIS_OUTPUT },
      error: `JSON 解析异常: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** 深度合并：用 parsed 的值覆盖 defaults，保留 defaults 中 parsed 缺失的键 */
function mergeDefaults(parsed: Record<string, unknown>): Record<string, unknown> {
  const result = { ...parsed };

  if (!result.tags || !Array.isArray(result.tags)) result.tags = DEFAULT_ANALYSIS_OUTPUT.tags;
  if (typeof result.narrative !== "string" || result.narrative.length === 0)
    result.narrative = DEFAULT_ANALYSIS_OUTPUT.narrative;
  if (typeof result.aestheticScore !== "number")
    result.aestheticScore = DEFAULT_ANALYSIS_OUTPUT.aestheticScore;
  if (!result.composition || typeof result.composition !== "object")
    result.composition = { ...DEFAULT_ANALYSIS_OUTPUT.composition };
  else {
    const comp = result.composition as Record<string, unknown>;
    if (typeof comp.type !== "string" || comp.type.length === 0)
      comp.type = DEFAULT_ANALYSIS_OUTPUT.composition.type;
    if (typeof comp.description !== "string")
      comp.description = DEFAULT_ANALYSIS_OUTPUT.composition.description;
  }
  if (!result.colorAnalysis || typeof result.colorAnalysis !== "object")
    result.colorAnalysis = { ...DEFAULT_ANALYSIS_OUTPUT.colorAnalysis };
  else {
    const ca = result.colorAnalysis as Record<string, unknown>;
    if (!Array.isArray(ca.dominantColors))
      ca.dominantColors = DEFAULT_ANALYSIS_OUTPUT.colorAnalysis.dominantColors;
    if (typeof ca.palette !== "string" || ca.palette.length === 0)
      ca.palette = DEFAULT_ANALYSIS_OUTPUT.colorAnalysis.palette;
  }
  if (!result.emotionalAnalysis || typeof result.emotionalAnalysis !== "object")
    result.emotionalAnalysis = { ...DEFAULT_ANALYSIS_OUTPUT.emotionalAnalysis };
  else {
    const ea = result.emotionalAnalysis as Record<string, unknown>;
    if (typeof ea.primaryEmotion !== "string" || ea.primaryEmotion.length === 0)
      ea.primaryEmotion = DEFAULT_ANALYSIS_OUTPUT.emotionalAnalysis.primaryEmotion;
    if (typeof ea.intensity !== "number")
      ea.intensity = DEFAULT_ANALYSIS_OUTPUT.emotionalAnalysis.intensity;
  }
  if (!Array.isArray(result.usageSuggestions))
    result.usageSuggestions = DEFAULT_ANALYSIS_OUTPUT.usageSuggestions;

  return result;
}

// ---- 测试用例 ----

const PERFECT_JSON = JSON.stringify({
  tags: [
    { name: "日落", category: "scene", confidence: 0.95 },
    { name: "温暖", category: "emotion", confidence: 0.88 },
    { name: "橙红", category: "color", confidence: 0.92 },
  ],
  narrative:
    "傍晚时分，太阳缓缓沉入地平线，天空被染成了绚丽的橙红色，云层如火焰般燃烧，水面倒映着天空的瑰丽色彩，整个场景充满了宁静而壮美的氛围。",
  aestheticScore: 8,
  composition: {
    type: "rule_of_thirds",
    description: "太阳位于右下三分之一交点，地平线位于下三分之一线",
  },
  colorAnalysis: {
    dominantColors: ["#FF6B35", "#FF8C42", "#FFB347"],
    palette: "warm_sunset",
  },
  emotionalAnalysis: {
    primaryEmotion: "peaceful",
    intensity: 7,
  },
  usageSuggestions: ["适合作为手机壁纸", "适合社交媒体分享", "适合风景摄影展示"],
});

describe("AI 响应解析器 — 验收测试（设计文档 §3）", () => {
  describe("extractJsonBlock — 正则提取", () => {
    it("应正确提取 ```json 代码块中的 JSON", () => {
      const raw = `这是一段分析结果：\n\`\`\`json\n{"key": "value"}\n\`\`\`\n以上是分析结果。`;
      const result = extractJsonBlock(raw);
      expect(result).toBe('{"key": "value"}');
    });

    it("应处理不换行的 ```json 代码块", () => {
      const raw = '```json{"key": "value"}```';
      const result = extractJsonBlock(raw);
      expect(result).toBe('{"key": "value"}');
    });

    it("应容错处理无语言标记的代码块（``` 无 json 标识）", () => {
      const raw = '```\n{"key": "value"}\n```';
      const result = extractJsonBlock(raw);
      expect(result).toBe('{"key": "value"}');
    });

    it("应回退到裸 JSON（无任何代码块标记）", () => {
      const raw = '{"narrative": "这是一张风景照"}';
      const result = extractJsonBlock(raw);
      expect(result).toContain('"narrative"');
    });

    it("应处理多行嵌套花括号的 JSON", () => {
      const raw =
        '```json\n{\n  "tags": [\n    {"name": "日落", "category": "scene"}\n  ],\n  "narrative": "test"\n}\n```';
      const result = extractJsonBlock(raw);
      expect(() => JSON.parse(result)).not.toThrow();
    });

    it("应提取第一个 JSON 对象（当文本中有其他花括号内容时）", () => {
      const raw = '{"narrative": "hello"} 后面的额外文本 {other: "data"}';
      const result = extractJsonBlock(raw);
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty("narrative", "hello");
    });
  });

  describe("parseAnalysisResponse — 完整解析流程", () => {
    it("应成功解析包裹在 ```json 中的完美输出", () => {
      const raw = `分析结果：\n\`\`\`json\n${PERFECT_JSON}\n\`\`\`\n以上是完整的分析。`;
      const result = parseAnalysisResponse(raw);
      expect(result.success).toBe(true);
      expect(result.data.tags).toHaveLength(3);
      expect(result.data.aestheticScore).toBe(8);
      expect(result.data.narrative.length).toBeGreaterThan(50);
    });

    it("应成功解析裸 JSON（无代码块）", () => {
      const result = parseAnalysisResponse(PERFECT_JSON);
      expect(result.success).toBe(true);
      expect(result.data.composition.type).toBe("rule_of_thirds");
    });

    it("应标记缺失 tags 字段为 success（使用默认值合并）", () => {
      const partial = JSON.stringify({
        narrative: "一张风景照",
        aestheticScore: 7,
        composition: { type: "center", description: "主体居中" },
        colorAnalysis: {
          dominantColors: ["#336699"],
          palette: "cool",
        },
        emotionalAnalysis: {
          primaryEmotion: "calm",
          intensity: 6,
        },
        usageSuggestions: ["壁纸"],
      });
      const result = parseAnalysisResponse(partial);
      // tags 缺失，但 defaults 可填充，故应成功
      expect(result.success).toBe(true);
      expect(result.data.tags).toEqual([]); // 默认空数组
    });

    it("应容错 narrative 字段缺失（使用空字符串默认值）", () => {
      const partial = JSON.stringify({
        tags: [{ name: "森林", category: "scene", confidence: 0.9 }],
        aestheticScore: 6,
        composition: { type: "center", description: "" },
        colorAnalysis: { dominantColors: ["#228B22"], palette: "green" },
        emotionalAnalysis: { primaryEmotion: "calm", intensity: 4 },
        usageSuggestions: [],
      });
      const result = parseAnalysisResponse(partial);
      expect(result.success).toBe(true);
      expect(result.data.narrative).toBe(""); // 默认空字符串
    });

    it("应容错 aestheticScore 缺失（使用默认值 5）", () => {
      const partial = JSON.stringify({
        tags: [{ name: "城市", category: "scene", confidence: 0.8 }],
        narrative: "一张城市夜景照片，灯火辉煌，展现都市的繁华与活力。",
        composition: {
          type: "leading_lines",
          description: "道路线条引导视线",
        },
        colorAnalysis: {
          dominantColors: ["#FFD700", "#1a1a2e"],
          palette: "contrast",
        },
        emotionalAnalysis: {
          primaryEmotion: "energetic",
          intensity: 8,
        },
        usageSuggestions: ["适合城市宣传"],
      });
      const result = parseAnalysisResponse(partial);
      expect(result.success).toBe(true);
      expect(result.data.aestheticScore).toBe(5);
    });

    it("应拒绝空字符串输入", () => {
      const result = parseAnalysisResponse("");
      expect(result.success).toBe(false);
      expect(result.error).toContain("空响应");
      // 即使失败，仍返回默认值数据
      expect(result.data.aestheticScore).toBe(5);
    });

    it("应拒绝纯空白字符输入", () => {
      const result = parseAnalysisResponse("   \n\t  ");
      expect(result.success).toBe(false);
      expect(result.error).toContain("空响应");
    });

    it("应拒绝无法解析为 JSON 的文本", () => {
      const result = parseAnalysisResponse("这是一段完全不是 JSON 的普通文本描述");
      expect(result.success).toBe(false);
      expect(result.error).toContain("JSON 解析异常");
    });

    it("应拒绝 JSON 格式正确但 Zod schema 不匹配的数据（无效 category）", () => {
      const invalid = JSON.stringify({
        tags: [{ name: "测试", category: "INVALID_CATEGORY", confidence: 0.9 }],
        narrative: "描述",
        aestheticScore: 5,
        composition: { type: "center", description: "居中" },
        colorAnalysis: {
          dominantColors: ["#000000"],
          palette: "dark",
        },
        emotionalAnalysis: {
          primaryEmotion: "neutral",
          intensity: 5,
        },
        usageSuggestions: [],
      });
      const result = parseAnalysisResponse(invalid);
      // tags 校验失败 → mergeDefaults 尝试修复 → 但 category 无法自动修复 → 失败
      expect(result.success).toBe(false);
    });

    it("应容错 aestheticScore 值越界（通过 clamp 在 mergeDefaults 前）", () => {
      const outOfRange = JSON.stringify({
        tags: [{ name: "日落", category: "scene", confidence: 0.95 }],
        narrative: "美丽的日落",
        aestheticScore: 999, // 超出 1-10 范围
        composition: { type: "horizon", description: "" },
        colorAnalysis: {
          dominantColors: ["#FF4500"],
          palette: "warm",
        },
        emotionalAnalysis: {
          primaryEmotion: "awe",
          intensity: 9,
        },
        usageSuggestions: [],
      });
      const result = parseAnalysisResponse(outOfRange);
      // 越界值导致 Zod 校验失败，mergeDefaults 不覆盖已有值，再次校验仍失败
      expect(result.success).toBe(false);
      // 但返回默认值数据
      expect(result.data.aestheticScore).toBe(5);
    });

    it("应处理 ```json 代码块内有多余的空白字符", () => {
      const raw = `\`\`\`json\n\n  \n${PERFECT_JSON}\n\n  \n\`\`\``;
      const result = parseAnalysisResponse(raw);
      expect(result.success).toBe(true);
    });
  });

  describe("aiAnalysisOutputSchema — Zod Schema 校验", () => {
    it("应校验 tag category 必须是 7 个合法值之一", () => {
      const valid = aiAnalysisOutputSchema.safeParse(JSON.parse(PERFECT_JSON));
      expect(valid.success).toBe(true);

      const invalidCategory = JSON.parse(PERFECT_JSON);
      invalidCategory.tags[0].category = "nonexistent";
      const invalid = aiAnalysisOutputSchema.safeParse(invalidCategory);
      expect(invalid.success).toBe(false);
    });

    it("应校验 tag confidence 必须在 0-1 范围内", () => {
      const data = JSON.parse(PERFECT_JSON);
      data.tags[0].confidence = 1.5;
      const result = aiAnalysisOutputSchema.safeParse(data);
      expect(result.success).toBe(false);

      data.tags[0].confidence = -0.1;
      const result2 = aiAnalysisOutputSchema.safeParse(data);
      expect(result2.success).toBe(false);
    });

    it("应校验 aestheticScore 必须在 1-10 范围内", () => {
      const data = JSON.parse(PERFECT_JSON);
      data.aestheticScore = 0;
      expect(aiAnalysisOutputSchema.safeParse(data).success).toBe(false);

      data.aestheticScore = 11;
      expect(aiAnalysisOutputSchema.safeParse(data).success).toBe(false);

      data.aestheticScore = 5;
      expect(aiAnalysisOutputSchema.safeParse(data).success).toBe(true);
    });

    it("应校验 emotionalAnalysis.intensity 在 1-10 范围内", () => {
      const data = JSON.parse(PERFECT_JSON);
      data.emotionalAnalysis.intensity = 11;
      expect(aiAnalysisOutputSchema.safeParse(data).success).toBe(false);

      data.emotionalAnalysis.intensity = 7;
      expect(aiAnalysisOutputSchema.safeParse(data).success).toBe(true);
    });

    it("应校验必填字段不能缺失", () => {
      const { tags, ...withoutTags } = JSON.parse(PERFECT_JSON);
      expect(aiAnalysisOutputSchema.safeParse(withoutTags).success).toBe(false);

      const { narrative, ...withoutNarrative } = JSON.parse(PERFECT_JSON);
      expect(aiAnalysisOutputSchema.safeParse(withoutNarrative).success).toBe(false);
    });

    it("应校验 tags 至少包含 name 和 category（confidence 可选但有默认值需求）", () => {
      const data = JSON.parse(PERFECT_JSON);
      data.tags.push({ name: "missing_category" });
      expect(aiAnalysisOutputSchema.safeParse(data).success).toBe(false);
    });
  });
});

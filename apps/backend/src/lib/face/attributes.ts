/**
 * 人脸语义属性分析（方案 C）。
 *
 * 调用 qwen 视觉模型，为 face crop JPEG 打 6 维语义属性标签：
 * age_band / gender / hair / glasses / facial_hair / expression。
 * 所有枚举值固定，缺失/不确定时填 "unknown"。
 *
 * 解析失败时最多重试 1 次（共最多 2 次调用），仍失败返回 null（不抛异常）。
 * 超时 30s（由外部 AI client timeout 兜底，此处做防御）。
 */

export type FaceAttributes = {
  schema_version: 1;
  age_band: "infant" | "child" | "teen" | "young_adult" | "middle_aged" | "senior" | "unknown";
  gender: "male" | "female" | "unknown";
  /** covered = 帽子/头巾 */
  hair: "long" | "short" | "bald" | "covered" | "unknown";
  glasses: "none" | "normal" | "sunglasses" | "unknown";
  facial_hair: "none" | "stubble" | "beard" | "moustache" | "unknown";
  expression: "neutral" | "smile" | "laugh" | "sad" | "surprised" | "unknown";
};

const AGE_BAND_VALUES = [
  "infant",
  "child",
  "teen",
  "young_adult",
  "middle_aged",
  "senior",
  "unknown",
] as const;
const GENDER_VALUES = ["male", "female", "unknown"] as const;
const HAIR_VALUES = ["long", "short", "bald", "covered", "unknown"] as const;
const GLASSES_VALUES = ["none", "normal", "sunglasses", "unknown"] as const;
const FACIAL_HAIR_VALUES = ["none", "stubble", "beard", "moustache", "unknown"] as const;
const EXPRESSION_VALUES = ["neutral", "smile", "laugh", "sad", "surprised", "unknown"] as const;

const SYSTEM_PROMPT = `你是一个专业的人脸属性分析助手。我会给你一张人脸照片，请仔细分析后**只返回**一个 JSON 对象，不要有任何额外文字或解释。

JSON 格式如下（所有字段必填，枚举值必须严格使用列表中的英文，不确定时填 "unknown"）：
{
  "schema_version": 1,
  "age_band": "<infant|child|teen|young_adult|middle_aged|senior|unknown>",
  "gender": "<male|female|unknown>",
  "hair": "<long|short|bald|covered|unknown>",
  "glasses": "<none|normal|sunglasses|unknown>",
  "facial_hair": "<none|stubble|beard|moustache|unknown>",
  "expression": "<neutral|smile|laugh|sad|surprised|unknown>"
}

字段说明：
- age_band: infant=0-2岁, child=3-12岁, teen=13-19岁, young_adult=20-35岁, middle_aged=36-55岁, senior=55岁以上
- gender: male=男性, female=女性
- hair: long=长发, short=短发, bald=秃头, covered=戴帽子/头巾遮住头发
- glasses: none=不戴眼镜, normal=戴普通眼镜, sunglasses=戴墨镜
- facial_hair: none=无胡须, stubble=胡渣, beard=蓄胡, moustache=仅上唇胡须
- expression: neutral=中性/无表情, smile=微笑, laugh=大笑, sad=悲伤, surprised=惊讶

注意：
1. 如果图片中人脸不清晰或某个属性无法判断，该字段填 "unknown"
2. 严格只返回 JSON，不要加代码块标记（\`\`\`）、不要有其他文字`;

const USER_PROMPT = "请分析这张人脸照片的属性，只返回 JSON。";

function isValidEnum<T extends readonly string[]>(values: T, val: unknown): val is T[number] {
  return typeof val === "string" && (values as readonly string[]).includes(val);
}

function parseAttributes(raw: string): FaceAttributes | null {
  let parsed: unknown;
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (obj.schema_version !== 1) return null;
  if (!isValidEnum(AGE_BAND_VALUES, obj.age_band)) return null;
  if (!isValidEnum(GENDER_VALUES, obj.gender)) return null;
  if (!isValidEnum(HAIR_VALUES, obj.hair)) return null;
  if (!isValidEnum(GLASSES_VALUES, obj.glasses)) return null;
  if (!isValidEnum(FACIAL_HAIR_VALUES, obj.facial_hair)) return null;
  if (!isValidEnum(EXPRESSION_VALUES, obj.expression)) return null;

  return {
    schema_version: 1,
    age_band: obj.age_band,
    gender: obj.gender,
    hair: obj.hair,
    glasses: obj.glasses,
    facial_hair: obj.facial_hair,
    expression: obj.expression,
  };
}

/**
 * 分析人脸 JPEG buffer 的语义属性。
 *
 * @param faceCropBuffer 人脸裁剪后的 JPEG/PNG buffer
 * @returns FaceAttributes 或 null（解析失败 / 网络错误 / 枚举非法）
 */
export async function analyzeFaceAttributes(
  faceCropBuffer: Buffer,
): Promise<FaceAttributes | null> {
  const { aiClient } = await import("../../ai/client");
  const { config } = await import("../config");

  const base64 = faceCropBuffer.toString("base64");
  const maxAttempts = Math.max(1, config.face.attributeRetries + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const raw = await Promise.race([
        aiClient.analyzePhoto(base64, "image/jpeg", SYSTEM_PROMPT, USER_PROMPT),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("analyzeFaceAttributes 超时 30s")), 30000),
        ),
      ]);

      const result = parseAttributes(raw);
      if (result !== null) return result;

      console.warn(`[attributes] 第 ${attempt + 1} 次解析失败，原始输出: ${raw.slice(0, 200)}`);
    } catch (err) {
      console.warn(`[attributes] 第 ${attempt + 1} 次调用失败: ${(err as Error).message}`);
    }
  }

  return null;
}

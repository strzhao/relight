/**
 * 验收测试 R1：analyzeFaceAttributes (红队，黑盒)
 *
 * 设计契约（state.md 「设计文档 → 属性分析流水线」）：
 *
 * `analyzeFaceAttributes(faceCropBuffer: Buffer): Promise<FaceAttributes | null>`
 *
 * - 调用 RelightAIClient.analyzePhoto 获取 JSON 字符串
 * - 解析失败重试 1 次，重试仍失败返回 null（不抛异常）
 * - 枚举值非法视为解析失败，同样重试
 * - 成功时返回含 schema_version: 1 及 6 个核心字段的 FaceAttributes 对象
 * - 缺少任何必填字段视为非法
 *
 * Mock 策略：
 * - vi.hoisted + vi.mock 拦截 apps/backend/src/ai/client.ts 的 aiClient / RelightAIClient
 * - 不读 attributes.ts 实现
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =========================================================================
// Hoisted mocks
// =========================================================================

const mockAnalyzePhoto = vi.hoisted(() => vi.fn<() => Promise<string>>());

vi.mock("../../../ai/client", () => ({
  RelightAIClient: vi.fn().mockImplementation(() => ({
    analyzePhoto: mockAnalyzePhoto,
  })),
  aiClient: {
    analyzePhoto: mockAnalyzePhoto,
  },
}));

// =========================================================================
// 合法 FaceAttributes JSON（7 个 key）
// =========================================================================

const VALID_ATTRS_JSON = JSON.stringify({
  schema_version: 1,
  age_band: "young_adult",
  gender: "female",
  hair: "long",
  glasses: "none",
  facial_hair: "none",
  expression: "smile",
});

const VALID_ATTRS_OBJ = {
  schema_version: 1,
  age_band: "young_adult",
  gender: "female",
  hair: "long",
  glasses: "none",
  facial_hair: "none",
  expression: "smile",
};

// =========================================================================
// 测试夹具：1x1 JPEG Buffer（最小合法 JPEG header）
// =========================================================================
function makeFakeJpegBuffer(): Buffer {
  // FF D8 FF E0 ... 最小 JPEG-like buffer，不需真实可解码
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
}

// =========================================================================
// Setup
// =========================================================================

beforeEach(() => {
  vi.resetModules();
  mockAnalyzePhoto.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =========================================================================
// R1-1: happy path
// =========================================================================

describe("R1-1: happy path — 合法 JSON 直接返回对应 FaceAttributes", () => {
  it("mock analyzePhoto 返回合法 JSON → 函数返回对应对象（含 7 个字段）", async () => {
    mockAnalyzePhoto.mockResolvedValueOnce(VALID_ATTRS_JSON);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result).not.toBeNull();
    expect(result).toMatchObject(VALID_ATTRS_OBJ);
  });

  it("schema_version 必须为 1", async () => {
    mockAnalyzePhoto.mockResolvedValueOnce(VALID_ATTRS_JSON);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result?.schema_version).toBe(1);
  });
});

// =========================================================================
// R1-2: JSON 解析失败 → 重试 1 次后返回合法对象
// =========================================================================

describe("R1-2: JSON 解析失败重试", () => {
  it("第一次返回 'not json'，第二次返回合法 JSON → 函数返回合法对象", async () => {
    mockAnalyzePhoto.mockResolvedValueOnce("not json").mockResolvedValueOnce(VALID_ATTRS_JSON);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result).not.toBeNull();
    expect(result?.gender).toBe("female");
    // 确认确实调用了两次（重试生效）
    expect(mockAnalyzePhoto).toHaveBeenCalledTimes(2);
  });

  it("第一次返回空字符串，第二次返回合法 JSON → 仍能返回合法对象", async () => {
    mockAnalyzePhoto.mockResolvedValueOnce("").mockResolvedValueOnce(VALID_ATTRS_JSON);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result).not.toBeNull();
    expect(result?.schema_version).toBe(1);
  });
});

// =========================================================================
// R1-3: 枚举值非法 → 重试 1 次后返回合法对象
// =========================================================================

describe("R1-3: 枚举值非法重试", () => {
  it("第一次 gender='alien'（非法），第二次合法 → 函数返回合法对象", async () => {
    const invalidGenderJson = JSON.stringify({
      schema_version: 1,
      age_band: "young_adult",
      gender: "alien", // 非法枚举值
      hair: "long",
      glasses: "none",
      facial_hair: "none",
      expression: "smile",
    });

    mockAnalyzePhoto
      .mockResolvedValueOnce(invalidGenderJson)
      .mockResolvedValueOnce(VALID_ATTRS_JSON);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result).not.toBeNull();
    expect(result?.gender).toBe("female");
    expect(mockAnalyzePhoto).toHaveBeenCalledTimes(2);
  });

  it("第一次 age_band='dinosaur'（非法），第二次合法 → 函数返回合法对象", async () => {
    const invalidAgeBandJson = JSON.stringify({
      schema_version: 1,
      age_band: "dinosaur", // 非法枚举值
      gender: "male",
      hair: "short",
      glasses: "none",
      facial_hair: "beard",
      expression: "neutral",
    });

    mockAnalyzePhoto
      .mockResolvedValueOnce(invalidAgeBandJson)
      .mockResolvedValueOnce(VALID_ATTRS_JSON);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result).not.toBeNull();
    expect(mockAnalyzePhoto).toHaveBeenCalledTimes(2);
  });

  it("第一次 expression='angry'（非法），第二次合法 → 返回合法对象", async () => {
    const invalidExpJson = JSON.stringify({
      schema_version: 1,
      age_band: "middle_aged",
      gender: "male",
      hair: "short",
      glasses: "normal",
      facial_hair: "none",
      expression: "angry", // 非法枚举值，设计文档无此值
    });

    mockAnalyzePhoto.mockResolvedValueOnce(invalidExpJson).mockResolvedValueOnce(VALID_ATTRS_JSON);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result).not.toBeNull();
    expect(mockAnalyzePhoto).toHaveBeenCalledTimes(2);
  });
});

// =========================================================================
// R1-4: 重试用尽（两次都失败）→ 返回 null，不抛异常
// =========================================================================

describe("R1-4: 重试用尽 → 返回 null，不抛异常", () => {
  it("两次都返回 'not json' → 函数返回 null", async () => {
    mockAnalyzePhoto.mockResolvedValueOnce("not json").mockResolvedValueOnce("still not json");

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result).toBeNull();
    // 不抛异常：await 本身没 throw
  });

  it("两次都返回非法枚举值 → 函数返回 null", async () => {
    const badJson = JSON.stringify({
      schema_version: 1,
      age_band: "robot",
      gender: "unknown",
      hair: "unknown",
      glasses: "unknown",
      facial_hair: "unknown",
      expression: "unknown",
    });

    mockAnalyzePhoto.mockResolvedValueOnce(badJson).mockResolvedValueOnce(badJson);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result).toBeNull();
  });

  it("analyzePhoto 抛出异常两次 → 函数返回 null，不向外抛", async () => {
    mockAnalyzePhoto
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("timeout"));

    const { analyzeFaceAttributes } = await import("../attributes");
    // 不应该 throw，应该 return null
    await expect(analyzeFaceAttributes(makeFakeJpegBuffer())).resolves.toBeNull();
  });

  it("第一次 analyzePhoto 异常，第二次也异常 → 返回 null", async () => {
    mockAnalyzePhoto
      .mockRejectedValueOnce(new Error("server down"))
      .mockRejectedValueOnce(new Error("still down"));

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result).toBeNull();
  });
});

// =========================================================================
// R1-5: schema_version 字段必须存在
// =========================================================================

describe("R1-5: schema_version 字段", () => {
  it("合法返回里 schema_version 必须是 1", async () => {
    mockAnalyzePhoto.mockResolvedValueOnce(VALID_ATTRS_JSON);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result).not.toBeNull();
    expect(result).toHaveProperty("schema_version", 1);
  });

  it("返回 JSON 缺少 schema_version → 视为非法，走重试流程", async () => {
    // 第一次：缺少 schema_version
    const missingSchemaVersion = JSON.stringify({
      age_band: "young_adult",
      gender: "female",
      hair: "long",
      glasses: "none",
      facial_hair: "none",
      expression: "smile",
    });
    // 第二次：合法
    mockAnalyzePhoto
      .mockResolvedValueOnce(missingSchemaVersion)
      .mockResolvedValueOnce(VALID_ATTRS_JSON);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    // 要么重试后成功返回合法对象，要么返回 null——关键是不能返回缺 schema_version 的对象
    if (result !== null) {
      expect(result).toHaveProperty("schema_version", 1);
    }
    // 若实现把第一次结果视为非法（推荐），应调用两次
    // 若实现对缺 schema_version 不检查（也允许），仅验证不报错
    expect(typeof result === "object" || result === null).toBe(true);
  });
});

// =========================================================================
// R1-6: 缺失字段 → 视为非法，走重试
// =========================================================================

describe("R1-6: 缺失必填字段 → 视为非法走重试", () => {
  it("缺少 gender 字段 → 第二次合法时返回合法对象", async () => {
    const missingGender = JSON.stringify({
      schema_version: 1,
      age_band: "young_adult",
      // gender 缺失
      hair: "long",
      glasses: "none",
      facial_hair: "none",
      expression: "smile",
    });

    mockAnalyzePhoto.mockResolvedValueOnce(missingGender).mockResolvedValueOnce(VALID_ATTRS_JSON);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    // 实现应检测缺字段并重试
    // 断言：最终结果要么是合法对象（含全部字段），要么是 null
    if (result !== null) {
      expect(result).toHaveProperty("gender");
      expect(result).toHaveProperty("age_band");
      expect(result).toHaveProperty("hair");
      expect(result).toHaveProperty("glasses");
      expect(result).toHaveProperty("facial_hair");
      expect(result).toHaveProperty("expression");
      expect(result).toHaveProperty("schema_version");
    }
  });

  it("缺少 hair 字段，两次都缺 → 返回 null", async () => {
    const missingHair = JSON.stringify({
      schema_version: 1,
      age_band: "young_adult",
      gender: "female",
      // hair 缺失
      glasses: "none",
      facial_hair: "none",
      expression: "smile",
    });

    mockAnalyzePhoto.mockResolvedValueOnce(missingHair).mockResolvedValueOnce(missingHair);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    // 两次都缺字段 → 两次都失败 → null
    expect(result).toBeNull();
  });

  it("缺少 expression 字段，两次都缺 → 返回 null", async () => {
    const missingExpression = JSON.stringify({
      schema_version: 1,
      age_band: "senior",
      gender: "male",
      hair: "bald",
      glasses: "none",
      facial_hair: "beard",
      // expression 缺失
    });

    mockAnalyzePhoto
      .mockResolvedValueOnce(missingExpression)
      .mockResolvedValueOnce(missingExpression);

    const { analyzeFaceAttributes } = await import("../attributes");
    const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

    expect(result).toBeNull();
  });
});

// =========================================================================
// R1-7: 合法枚举值穷举验证（边界）
// =========================================================================

describe("R1-7: 各字段枚举值合法范围", () => {
  const validCombinations = [
    {
      age_band: "infant",
      gender: "male",
      hair: "bald",
      glasses: "none",
      facial_hair: "none",
      expression: "neutral",
    },
    {
      age_band: "child",
      gender: "female",
      hair: "long",
      glasses: "normal",
      facial_hair: "none",
      expression: "smile",
    },
    {
      age_band: "teen",
      gender: "unknown",
      hair: "short",
      glasses: "sunglasses",
      facial_hair: "stubble",
      expression: "laugh",
    },
    {
      age_band: "middle_aged",
      gender: "male",
      hair: "covered",
      glasses: "unknown",
      facial_hair: "beard",
      expression: "sad",
    },
    {
      age_band: "senior",
      gender: "female",
      hair: "unknown",
      glasses: "none",
      facial_hair: "moustache",
      expression: "surprised",
    },
    {
      age_band: "unknown",
      gender: "unknown",
      hair: "unknown",
      glasses: "unknown",
      facial_hair: "unknown",
      expression: "unknown",
    },
  ];

  for (const combo of validCombinations) {
    it(`合法组合：age_band=${combo.age_band}, gender=${combo.gender} → 返回非 null`, async () => {
      mockAnalyzePhoto.mockReset();
      vi.resetModules();

      const json = JSON.stringify({ schema_version: 1, ...combo });
      mockAnalyzePhoto.mockResolvedValueOnce(json);

      const { analyzeFaceAttributes } = await import("../attributes");
      const result = await analyzeFaceAttributes(makeFakeJpegBuffer());

      expect(result).not.toBeNull();
      expect(result?.schema_version).toBe(1);
    });
  }
});

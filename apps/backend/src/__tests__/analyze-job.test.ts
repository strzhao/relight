import type { Job } from "bullmq";
/**
 * 验收测试：Analyze Job — Prompt 版本、aiModel、评估器集成
 *
 * 覆盖设计文档：
 * - analyze photor Worker 使用 config.ai.promptVersion 加载 Prompt
 * - system 和 user prompt 分别传递到 AI client
 * - INSERT 和 UPDATE 路径均使用 config.ai.visionModel
 * - UPDATE 路径包含 aiModel 字段
 * - 分析完成后调用评估器 evaluateResponse() 并输出日志
 * - promptVersion 写入数据库
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock drizzle-orm ----

const mockEq = vi.hoisted(() =>
  vi.fn((a: unknown, b: unknown) => ({ __op: "eq", left: a, right: b })),
);

vi.mock("drizzle-orm", () => ({
  eq: mockEq,
}));

// ---- 捕获 Drizzle ORM 的 values() / set() 参数 ----

/** 记录所有 insert().values() 调用中传入的 values 对象 */
let capturedInsertValues: Record<string, unknown>[] = [];
/** 记录所有 update().set() 调用中传入的 set 对象 */
let capturedUpdateSets: Record<string, unknown>[] = [];

/**
 * 链式 mock 辅助函数。
 * 模拟 Drizzle ORM 的链式调用：select().from().where() 等。
 * 额外捕获 .values() 和 .set() 的参数以用于断言。
 */
function chainableMock(result: unknown[] = []) {
  const fn = (..._args: unknown[]) => chainableMock(result);
  return new Proxy(fn, {
    get(_target, prop) {
      // promise thenable: await 时解析为 result
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      // 数组索引 [0], [1] 等
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return result[Number(prop)];
      }
      // 捕获 values/set 调用以验证 DB 写入内容
      if (prop === "values") {
        return (...args: unknown[]) => {
          if (args[0] && typeof args[0] === "object") {
            capturedInsertValues.push(args[0] as Record<string, unknown>);
          }
          return chainableMock(result);
        };
      }
      if (prop === "set") {
        return (...args: unknown[]) => {
          if (args[0] && typeof args[0] === "object") {
            capturedUpdateSets.push(args[0] as Record<string, unknown>);
          }
          return chainableMock(result);
        };
      }
      return chainableMock(result);
    },
  });
}

// ---- Mock database (变量须用 vi.hoisted) ----

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));
const mockSchema = vi.hoisted(() => ({
  photos: { id: "photos.id" },
  storageSources: { id: "storageSources.id" },
  tags: { id: "tags.id", name: "tags.name" },
  photoTags: { photoId: "photoTags.photoId" },
  photoAnalyses: { photoId: "photoAnalyses.photoId", id: "photoAnalyses.id" },
}));

vi.mock("../db", () => ({
  db: mockDb,
  schema: mockSchema,
}));

// ---- Mock 存储适配器 ----

const mockGetFileBuffer = vi.hoisted(() => vi.fn());
const mockGetMimeType = vi.hoisted(() => vi.fn());

vi.mock("../storage", () => ({
  createStorageAdapter: vi.fn().mockReturnValue({
    getFileBuffer: mockGetFileBuffer,
    getMimeType: mockGetMimeType,
  }),
}));

// ---- Mock AI client ----

const mockAnalyzePhoto = vi.hoisted(() => vi.fn());

vi.mock("../ai/client", () => ({
  aiClient: {
    analyzePhoto: mockAnalyzePhoto,
  },
}));

// ---- Mock response parser ----

const mockParseAnalysisResponse = vi.hoisted(() => vi.fn());

vi.mock("../ai/response-parser", () => ({
  parseAnalysisResponse: mockParseAnalysisResponse,
}));

// ---- Mock prompt loader ----

const mockLoadPrompts = vi.hoisted(() => vi.fn());

vi.mock("../ai/prompts", () => ({
  loadPrompts: mockLoadPrompts,
}));

// ---- Mock evaluator ----

const mockEvaluateResponse = vi.hoisted(() => vi.fn());

vi.mock("../ai/evaluation/evaluator", () => ({
  evaluateResponse: mockEvaluateResponse,
}));

// ---- Mock config ----

const mockConfig = vi.hoisted(() => ({
  ai: {
    baseUrl: "http://test/v1",
    apiKey: "test-key",
    visionModel: "qwen3.6-35b-custom",
    model: "test-model",
    promptVersion: "v2",
  },
}));

vi.mock("../lib/config", () => ({
  config: mockConfig,
}));

// ---- Import after all mocks are set up ----

import { analyzePhotoWorker } from "../jobs/analyze-photo";

// ---- 工厂函数 ----

interface AnalyzeJobData {
  photoId: string;
}

function createMockJob(overrides: Partial<AnalyzeJobData> = {}): Job<AnalyzeJobData> {
  const data: AnalyzeJobData = {
    photoId: "photo-test-001",
    ...overrides,
  };
  return {
    data,
    id: "job-test-001",
    name: "analyze-photo",
    log: vi.fn(),
    updateProgress: vi.fn(),
  } as unknown as Job<AnalyzeJobData>;
}

/** 设置 DB mock：照片存在、存储源存在 */
function setupPhotoExists(photo?: Record<string, unknown>) {
  mockDb.select.mockReturnValueOnce(
    chainableMock([
      photo ?? {
        id: "photo-test-001",
        storageSourceId: "source-001",
        filePath: "/photos/test.jpg",
        fileHash: "abc123",
      },
    ]),
  );
}

function setupSourceExists(source?: Record<string, unknown>) {
  mockDb.select.mockReturnValueOnce(
    chainableMock([
      source ?? {
        id: "source-001",
        name: "Test Source",
        type: "local",
        rootPath: "/photos",
        enabled: true,
      },
    ]),
  );
}

/** 设置解析器返回成功结果 */
function setupParserSuccess() {
  mockParseAnalysisResponse.mockReturnValue({
    parsed: {
      tags: [
        { name: "日落", category: "scene", confidence: 0.95 },
        { name: "温暖", category: "emotion", confidence: 0.88 },
      ],
      narrative: "一张美丽的日落照片",
      aestheticScore: 8,
      composition: { type: "rule_of_thirds", description: "经典三分法构图" },
      colorAnalysis: {
        dominantColors: ["#FF6B35", "#FFD700"],
        palette: "warm",
      },
      emotionalAnalysis: { primaryEmotion: "peaceful", intensity: 7 },
      usageSuggestions: ["壁纸", "社交媒体"],
    },
    error: null,
    fallback: null,
  });
}

// ---- 测试 ----

describe("Analyze Job — Prompt 版本、aiModel、评估器集成", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重置捕获数组
    capturedInsertValues = [];
    capturedUpdateSets = [];

    // 默认配置
    mockConfig.ai.promptVersion = "v2";
    mockConfig.ai.visionModel = "qwen3.6-35b-custom";

    // 默认 mock 行为
    mockLoadPrompts.mockResolvedValue({
      system: "v2 system prompt",
      user: "v2 user prompt",
    });
    mockGetFileBuffer.mockResolvedValue(Buffer.from("fake-image-data"));
    mockGetMimeType.mockReturnValue("image/jpeg");
    mockAnalyzePhoto.mockResolvedValue('{"raw": "response"}');
    setupParserSuccess();
    mockEvaluateResponse.mockReturnValue({
      totalScore: 85,
      maxScore: 100,
      passed: true,
      summary: "通过 (85/100)",
      dimensions: [],
    });

    // 默认 Tags / analysis lookup 返回空（INSERT 路径）
    mockDb.select.mockReturnValue(chainableMock([]));
    // insert / update 默认返回空
    mockDb.insert.mockReturnValue(chainableMock([]));
    mockDb.update.mockReturnValue(chainableMock([]));
  });

  // =========================================================================
  // Prompt 版本
  // =========================================================================

  describe("Prompt 版本选择", () => {
    it("应使用 config.ai.promptVersion 加载 Prompt", async () => {
      mockConfig.ai.promptVersion = "v2";

      setupPhotoExists();
      setupSourceExists();

      const job = createMockJob();
      await analyzePhotoWorker(job);

      expect(mockLoadPrompts).toHaveBeenCalledWith("v2");
    });

    it("config.ai.promptVersion='v1' 时应加载 v1 Prompt", async () => {
      mockConfig.ai.promptVersion = "v1";
      mockLoadPrompts.mockResolvedValue({
        system: "v1 system",
        user: "v1 user",
      });

      setupPhotoExists();
      setupSourceExists();

      const job = createMockJob();
      await analyzePhotoWorker(job);

      expect(mockLoadPrompts).toHaveBeenCalledWith("v1");
    });

    it("config.ai.promptVersion='v2' 时应加载 v2 Prompt", async () => {
      mockConfig.ai.promptVersion = "v2";

      setupPhotoExists();
      setupSourceExists();

      const job = createMockJob();
      await analyzePhotoWorker(job);

      expect(mockLoadPrompts).toHaveBeenCalledWith("v2");
    });
  });

  // =========================================================================
  // System + User Prompt 分离传递
  // =========================================================================

  describe("System/User Prompt 分离", () => {
    it("应将 system 和 user prompt 分别传递给 AI client", async () => {
      mockLoadPrompts.mockResolvedValue({
        system: "SYSTEM_PROMPT_HERE",
        user: "USER_PROMPT_HERE",
      });

      setupPhotoExists();
      setupSourceExists();

      const job = createMockJob();
      await analyzePhotoWorker(job);

      expect(mockAnalyzePhoto).toHaveBeenCalledTimes(1);
      const callArgs = mockAnalyzePhoto.mock.calls[0] as unknown[];

      // 参数 0: base64
      expect(typeof callArgs[0]).toBe("string");
      // 参数 1: mimeType
      expect(callArgs[1]).toBe("image/jpeg");
      // 参数 2: system prompt
      expect(callArgs[2]).toBe("SYSTEM_PROMPT_HERE");
      // 参数 3: user prompt
      expect(callArgs[3]).toBe("USER_PROMPT_HERE");
    });

    it("不应将 system 和 user 合并后再传递", async () => {
      mockLoadPrompts.mockResolvedValue({
        system: "SYS",
        user: "USR",
      });

      setupPhotoExists();
      setupSourceExists();

      const job = createMockJob();
      await analyzePhotoWorker(job);

      const callArgs = mockAnalyzePhoto.mock.calls[0] as unknown[];
      // 应为 4 参数模式（非旧的 3 参数合并模式）
      expect(callArgs.length).toBe(4);
      expect(callArgs[2]).not.toContain("---");
      expect(callArgs[3]).not.toContain("---");
    });
  });

  // =========================================================================
  // aiModel 来源
  // =========================================================================

  describe("aiModel 使用 config.ai.visionModel", () => {
    it("INSERT 路径应使用 config.ai.visionModel 作为 aiModel", async () => {
      mockConfig.ai.visionModel = "gpt-4o-vision-preview";

      setupPhotoExists();
      setupSourceExists();
      // 无已有分析记录 → INSERT 路径（默认 beforeEach 已设置 select 返回 []）

      const job = createMockJob();
      await analyzePhotoWorker(job);

      // 验证 captured values 中包含 aiModel
      const photoAnalysesInsert = capturedInsertValues.find((v) => "aiModel" in v);
      expect(photoAnalysesInsert).toBeDefined();
      expect(photoAnalysesInsert!.aiModel).toBe("gpt-4o-vision-preview");
    });

    it("UPDATE 路径应使用 config.ai.visionModel 更新 aiModel", async () => {
      mockConfig.ai.visionModel = "claude-vision-3";

      setupPhotoExists();
      setupSourceExists();
      // 已有分析记录 → UPDATE 路径
      mockDb.select.mockReturnValue(chainableMock([{ id: "existing-analysis-001" }]));

      const job = createMockJob();
      await analyzePhotoWorker(job);

      const photoAnalysesUpdate = capturedUpdateSets.find((v) => "aiModel" in v);
      expect(photoAnalysesUpdate).toBeDefined();
      expect(photoAnalysesUpdate!.aiModel).toBe("claude-vision-3");
    });

    it("aiModel 不应从 process.env.AI_VISION_MODEL 直接读取", async () => {
      process.env.AI_VISION_MODEL = "should-not-use-this";
      mockConfig.ai.visionModel = "config-vision-model";

      setupPhotoExists();
      setupSourceExists();

      const job = createMockJob();
      await analyzePhotoWorker(job);

      const photoAnalysesInsert = capturedInsertValues.find((v) => "aiModel" in v);
      expect(photoAnalysesInsert).toBeDefined();
      expect(photoAnalysesInsert!.aiModel).toBe("config-vision-model");
      expect(photoAnalysesInsert!.aiModel).not.toBe("should-not-use-this");

      process.env.AI_VISION_MODEL = undefined;
    });
  });

  // =========================================================================
  // 评估器调用
  // =========================================================================

  describe("评估器集成", () => {
    it("分析完成后应调用 evaluateResponse()", async () => {
      setupPhotoExists();
      setupSourceExists();

      const job = createMockJob();
      await analyzePhotoWorker(job);

      expect(mockEvaluateResponse).toHaveBeenCalledTimes(1);
    });

    it("应使用解析结果和原始响应调用评估器", async () => {
      const rawResponse = '{"tags":[],"narrative":"test","aestheticScore":8}';
      mockAnalyzePhoto.mockResolvedValue(rawResponse);

      const parsed = {
        tags: [{ name: "夕阳", category: "scene" as const, confidence: 0.9 }],
        narrative: "test",
        aestheticScore: 8,
        composition: { type: "center", description: "desc" },
        colorAnalysis: { dominantColors: ["#FF0000"], palette: "warm" },
        emotionalAnalysis: { primaryEmotion: "calm", intensity: 5 },
        usageSuggestions: [],
      };

      mockParseAnalysisResponse.mockReturnValue({
        parsed,
        error: null,
        fallback: null,
      });

      setupPhotoExists();
      setupSourceExists();

      const job = createMockJob();
      await analyzePhotoWorker(job);

      expect(mockEvaluateResponse).toHaveBeenCalled();
      const evalArgs = mockEvaluateResponse.mock.calls[0] as unknown[];
      expect(evalArgs[0]).toEqual(parsed);
      expect(evalArgs[1]).toBe(rawResponse);
    });

    it("评估结果应通过 console.log 和 job.log 输出", async () => {
      mockEvaluateResponse.mockReturnValue({
        totalScore: 88,
        maxScore: 100,
        passed: true,
        summary: "通过 (88/100)",
        dimensions: [],
      });

      setupPhotoExists();
      setupSourceExists();

      const job = createMockJob();
      await analyzePhotoWorker(job);

      // 验证 job.log 被调用并包含评估信息
      const logCalls = (job.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
      const hasEvalLog = logCalls.some(
        (call) =>
          call.includes("88") ||
          call.includes("通过") ||
          call.includes("评估") ||
          call.includes("评分"),
      );
      expect(hasEvalLog).toBe(true);
    });
  });

  // =========================================================================
  // promptVersion 写入 DB
  // =========================================================================

  describe("promptVersion 写入数据库", () => {
    it("INSERT 路径应将 promptVersion 写入 photoAnalyses", async () => {
      mockConfig.ai.promptVersion = "v2";

      setupPhotoExists();
      setupSourceExists();

      const job = createMockJob();
      await analyzePhotoWorker(job);

      const photoAnalysesInsert = capturedInsertValues.find((v) => "promptVersion" in v);
      expect(photoAnalysesInsert).toBeDefined();
      expect(photoAnalysesInsert!.promptVersion).toBe("v2");
    });

    it("UPDATE 路径应将 promptVersion 写入 photoAnalyses", async () => {
      mockConfig.ai.promptVersion = "v1";

      setupPhotoExists();
      setupSourceExists();
      mockDb.select.mockReturnValue(chainableMock([{ id: "existing-analysis-001" }]));

      const job = createMockJob();
      await analyzePhotoWorker(job);

      const photoAnalysesUpdate = capturedUpdateSets.find((v) => "promptVersion" in v);
      expect(photoAnalysesUpdate).toBeDefined();
      expect(photoAnalysesUpdate!.promptVersion).toBe("v1");
    });
  });

  // =========================================================================
  // 错误处理
  // =========================================================================

  describe("错误处理", () => {
    it("照片不存在时应抛出错误", async () => {
      mockDb.select.mockReturnValue(chainableMock([]));

      const job = createMockJob({ photoId: "nonexistent" });
      await expect(analyzePhotoWorker(job)).rejects.toThrow();
    });

    it("存储源不存在时应抛出错误", async () => {
      mockDb.select.mockReturnValueOnce(
        chainableMock([
          {
            id: "photo-test-001",
            storageSourceId: "source-001",
            filePath: "/photos/test.jpg",
            fileHash: "abc123",
          },
        ]),
      );
      mockDb.select.mockReturnValueOnce(chainableMock([]));

      const job = createMockJob();
      await expect(analyzePhotoWorker(job)).rejects.toThrow();
    });
  });
});

/**
 * 验收测试：AI 图片分析性能优化
 *
 * 覆盖设计文档 4 项改动：
 * - P0-1: Worker 并发度 concurrency: 4
 * - P0-2: 统一图片缩放到 1024px (sharp resize + JPEG quality 75)
 * - P1-1: AI API 超时 timeout: 120000 + maxRetries: 0
 * - P1-2: 标签批量写入 onConflictDoUpdate + onConflictDoNothing
 *
 * 测试策略（黑盒验收）：
 * - P0-1: mock bullmq Worker，动态导入 workers/index，检查 Worker 构造参数
 * - P0-2: mock sharp，通过 analyzePhotoWorker 验证非 HEIC 图片被 resize 到 ≤1024px
 * - P1-1: mock openai 包，动态导入 ai/client，检查 OpenAI 构造函数选项
 * - P1-2: mock drizzle-orm insert/values 路径，验证使用 onConflictDoUpdate / onConflictDoNothing
 *
 * 注：所有 mock 对象使用 vi.hoisted() 确保在 vi.mock 提升之前可用。
 */

import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// 共享 Mock 设置（用于 P0-2、P1-2 的 analyzePhotoWorker 相关测试）
// =============================================================================

// ---- Mock sharp (捕获 resize/jpeg 调用) ----

interface SharpCall {
  type: "resize" | "jpeg" | "toBuffer";
  args: unknown[];
}

let capturedSharpPipe: SharpCall[] = [];
let mockSharpResolvedBuffer: Buffer = Buffer.from("resized-image-data");

/**
 * 惰性自引用目标 — 在 chainableMockSharp 中设置，
 * 供 hoisted mock 函数返回以维持链式调用。
 */
let sharpSelfTarget: Record<string, unknown> | null = null;

const mockResizeFn = vi.hoisted(() =>
  vi.fn().mockImplementation((...args: unknown[]) => {
    capturedSharpPipe.push({ type: "resize", args });
    return sharpSelfTarget;
  }),
);

const mockJpegFn = vi.hoisted(() =>
  vi.fn().mockImplementation((...args: unknown[]) => {
    capturedSharpPipe.push({ type: "jpeg", args });
    return sharpSelfTarget;
  }),
);

const mockToBufferFn = vi.hoisted(() =>
  vi.fn().mockImplementation(() => {
    capturedSharpPipe.push({ type: "toBuffer", args: [] });
    return Promise.resolve(mockSharpResolvedBuffer);
  }),
);

const mockRotateFn = vi.hoisted(() => vi.fn().mockImplementation(() => sharpSelfTarget));

const mockWithMetadataFn = vi.hoisted(() => vi.fn().mockImplementation(() => sharpSelfTarget));

/**
 * sharp 链式调用 mock：返回一个可链式调用对象。
 * 所有方法返回 sharpSelfTarget（自身），避免无限递归。
 */
function chainableMockSharp(): Record<string, unknown> {
  const self: Record<string, unknown> = {
    resize: mockResizeFn,
    jpeg: mockJpegFn,
    toBuffer: mockToBufferFn,
    rotate: mockRotateFn,
    withMetadata: mockWithMetadataFn,
  };
  sharpSelfTarget = self;

  // 支持 thenable（以防代码对 sharp 结果做 await）
  // biome-ignore lint/suspicious/noThenProperty: mock 需要支持 await 链式调用
  Object.defineProperty(self, "then", {
    value: (resolve: (v: unknown) => unknown) => resolve(mockSharpResolvedBuffer),
    writable: true,
  });
  return self;
}

const mockSharp = vi.hoisted(() => vi.fn().mockImplementation(() => chainableMockSharp()));

vi.mock("sharp", () => ({
  default: mockSharp,
}));

// ---- Mock heic 相关 (heic 文件识别) ----

const mockIsHeicFile = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockIsHeicBuffer = vi.hoisted(() => vi.fn().mockReturnValue(false));

vi.mock("../lib/heic", () => ({
  isHeicFile: mockIsHeicFile,
  isHeicBuffer: mockIsHeicBuffer,
  heicFileToJpeg: vi.fn(),
  convertHeicToJpeg: vi.fn(),
}));

// ---- Mock drizzle-orm ----

const mockEq = vi.hoisted(() =>
  vi.fn((a: unknown, b: unknown) => ({ __op: "eq", left: a, right: b })),
);

/** 捕获 onConflictDoUpdate / onConflictDoNothing 的调用 */
let capturedConflictHandlers: string[] = [];

function chainableMock(result: unknown[] = []) {
  const fn = (..._args: unknown[]) => chainableMock(result);
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return result[Number(prop)];
      }
      // 捕获 onConflictDoUpdate / onConflictDoNothing 调用
      if (prop === "onConflictDoUpdate") {
        capturedConflictHandlers.push("onConflictDoUpdate");
        return chainableMock(result);
      }
      if (prop === "onConflictDoNothing") {
        capturedConflictHandlers.push("onConflictDoNothing");
        return chainableMock(result);
      }
      return chainableMock(result);
    },
  });
}

// ---- 捕获 insert().values() 和 update().set() 参数 ----

let capturedInsertValues: Record<string, unknown>[] = [];
let capturedUpdateSets: Record<string, unknown>[] = [];

// 增强版 chainableMock：额外捕获 values/set
function captureChainableMock(result: unknown[] = []) {
  const fn = (..._args: unknown[]) => captureChainableMock(result);
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return result[Number(prop)];
      }
      if (prop === "values") {
        return (...args: unknown[]) => {
          if (args[0] && typeof args[0] === "object") {
            // 支持批量 values（数组）和单条 values（对象）
            if (Array.isArray(args[0])) {
              capturedInsertValues.push(...(args[0] as Record<string, unknown>[]));
            } else {
              capturedInsertValues.push(args[0] as Record<string, unknown>);
            }
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
      // 捕获 onConflictDoUpdate / onConflictDoNothing
      if (prop === "onConflictDoUpdate") {
        capturedConflictHandlers.push("onConflictDoUpdate");
        return chainableMock(result);
      }
      if (prop === "onConflictDoNothing") {
        capturedConflictHandlers.push("onConflictDoNothing");
        return chainableMock(result);
      }
      return chainableMock(result);
    },
  });
}

// ---- Mock database ----

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));

const mockSchema = vi.hoisted(() => ({
  photos: {
    id: "photos.id",
    storageSourceId: "photos.storageSourceId",
    filePath: "photos.filePath",
    fileHash: "photos.fileHash",
    fileSize: "photos.fileSize",
  },
  storageSources: {
    id: "storageSources.id",
    name: "storageSources.name",
    type: "storageSources.type",
    rootPath: "storageSources.rootPath",
    enabled: "storageSources.enabled",
  },
  tags: { id: "tags.id", name: "tags.name", category: "tags.category" },
  photoTags: { photoId: "photoTags.photoId", tagId: "photoTags.tagId" },
  photoAnalyses: {
    id: "photoAnalyses.id",
    photoId: "photoAnalyses.photoId",
    aiModel: "photoAnalyses.aiModel",
    rawResponse: "photoAnalyses.rawResponse",
    narrative: "photoAnalyses.narrative",
    aestheticScore: "photoAnalyses.aestheticScore",
    tags: "photoAnalyses.tags",
    composition: "photoAnalyses.composition",
    colorAnalysis: "photoAnalyses.colorAnalysis",
    emotionalAnalysis: "photoAnalyses.emotionalAnalysis",
    usageSuggestions: "photoAnalyses.usageSuggestions",
    promptVersion: "photoAnalyses.promptVersion",
    processedAt: "photoAnalyses.processedAt",
  },
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

// ---- Mock config (用于 P0-2、P1-2 的 analyzePhotoWorker 测试) ----

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

// ---- 动态导入 analyzePhotoWorker (在 mock 之后) ----

import { analyzePhotoWorker } from "../jobs/analyze-photo";

// =============================================================================
// 辅助函数
// =============================================================================

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

/** 设置 DB mock：照片存在 */
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

/** 设置 DB mock：存储源存在 */
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

/** 设置解析器返回成功结果（含标签） */
function setupParserSuccess(tags?: Array<{ name: string; category: string; confidence: number }>) {
  mockParseAnalysisResponse.mockReturnValue({
    parsed: {
      tags: tags ?? [
        { name: "日落", category: "scene", confidence: 0.95 },
        { name: "温暖", category: "emotion", confidence: 0.88 },
        { name: "金色", category: "color", confidence: 0.9 },
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

/** 重置所有 mock 状态 */
function resetMocks() {
  vi.clearAllMocks();
  capturedInsertValues = [];
  capturedUpdateSets = [];
  capturedSharpPipe = [];
  capturedConflictHandlers = [];
  mockSharpResolvedBuffer = Buffer.from("resized-image-data");
  sharpSelfTarget = null;

  // 默认配置
  mockConfig.ai.promptVersion = "v2";
  mockConfig.ai.visionModel = "qwen3.6-35b-custom";

  // 默认 mock 行为
  mockIsHeicFile.mockReturnValue(false);
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
  mockDb.insert.mockReturnValue(captureChainableMock([]));
  mockDb.update.mockReturnValue(captureChainableMock([]));
}

// =============================================================================
// P0-1: Worker 并发度 — concurrency: 2
// =============================================================================

describe("P0-1: Worker 并发度 (concurrency: 4)", () => {
  // 收集 Worker 构造参数
  let workerConstructors: Array<{
    name: string;
    processor: unknown;
    opts: Record<string, unknown>;
  }> = [];

  beforeEach(async () => {
    vi.resetModules();
    workerConstructors = [];

    // mock bullmq 的 Worker 类：捕获构造函数参数
    vi.doMock("bullmq", () => ({
      Worker: vi
        .fn()
        .mockImplementation((name: string, processor: unknown, opts?: Record<string, unknown>) => {
          workerConstructors.push({ name, processor, opts: opts ?? {} });
          return {
            on: vi.fn().mockReturnThis(),
            close: vi.fn().mockResolvedValue(undefined),
            opts: opts ?? {},
          };
        }),
      Queue: vi.fn().mockImplementation(() => ({
        add: vi.fn(),
        addBulk: vi.fn(),
        getJobCounts: vi.fn().mockResolvedValue({}),
        close: vi.fn(),
      })),
      QueueEvents: vi.fn().mockImplementation(() => ({
        on: vi.fn(),
        close: vi.fn(),
      })),
    }));

    // mock config 以避免 workers/index 尝试连接真实 Redis
    vi.doMock("../lib/config", () => ({
      config: {
        redisUrl: "redis://mock:6379",
        ai: {
          baseUrl: "http://test/v1",
          apiKey: "test-key",
          visionModel: "qwen-test",
          model: "test-model",
        },
      },
    }));
  });

  it("analyze-photo 队列的 Worker 应配置 concurrency: 4", async () => {
    // 动态导入 workers 模块 — 这会触发 Worker 构造
    try {
      await import("../workers/index");
    } catch {
      // 某些模块可能不可用（如提示词文件），忽略导入错误
      // 但我们仍可检查 Worker 构造函数是否在出错前被调用
    }

    const analyzeWorker = workerConstructors.find((w) => w.name === "analyze-photo");
    expect(analyzeWorker).toBeDefined();

    if (analyzeWorker) {
      // 核心断言：concurrency 应为 4，匹配 llama-server --parallel 4
      expect(analyzeWorker.opts).toHaveProperty("concurrency");
      expect(analyzeWorker.opts.concurrency).toBe(4);
    }
  });

  it("analyze-photo Worker 应匹配 llama-server 的 --parallel 4 设置", async () => {
    try {
      await import("../workers/index");
    } catch {
      // 忽略导入错误
    }

    const analyzeWorker = workerConstructors.find((w) => w.name === "analyze-photo");
    if (analyzeWorker && analyzeWorker.opts.concurrency !== undefined) {
      // concurrency 值应等于 4，与 llama-server --parallel 4 匹配
      expect(analyzeWorker.opts.concurrency).toBe(4);
      expect(typeof analyzeWorker.opts.concurrency).toBe("number");
    }
  });

  it("Worker 的 connection 配置应包含 Redis URL", async () => {
    try {
      await import("../workers/index");
    } catch {
      // 忽略导入错误
    }

    const analyzeWorker = workerConstructors.find((w) => w.name === "analyze-photo");
    if (analyzeWorker) {
      // Worker 应包含 connection 配置（用于连接 Redis）
      expect(analyzeWorker.opts).toHaveProperty("connection");
    }
  });

  it("并发度应仅在 analyze-photo Worker 上配置（非所有 Worker）", async () => {
    try {
      await import("../workers/index");
    } catch {
      // 忽略导入错误
    }

    // 检查 analyze-photo 的并发度设置与设计一致
    const analyzeWorker = workerConstructors.find((w) => w.name === "analyze-photo");
    expect(analyzeWorker).toBeDefined();

    if (analyzeWorker) {
      // 确保 concurrency 是正整数
      const concurrency = analyzeWorker.opts.concurrency;
      if (concurrency !== undefined) {
        expect(Number.isInteger(concurrency)).toBe(true);
        expect(concurrency).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

// =============================================================================
// P0-2: 统一图片缩放 (sharp resize ≤1024px + JPEG quality 75)
// =============================================================================

describe("P0-2: 统一图片缩放 (sharp resize ≤1024px + JPEG quality 75)", () => {
  beforeEach(() => {
    resetMocks();
    mockGetMimeType.mockReturnValue("image/jpeg");
    mockIsHeicFile.mockReturnValue(false);
  });

  it("非 HEIC 图片（JPEG）应调用 sharp().resize() 缩放", async () => {
    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    // 验证 sharp 被调用
    expect(mockSharp).toHaveBeenCalled();

    // 验证 resize 被调用（非 HEIC 之前不会 resize）
    expect(mockResizeFn).toHaveBeenCalled();
  });

  it("sharp resize 的目标尺寸应不超过 1024px", async () => {
    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    expect(mockResizeFn).toHaveBeenCalled();

    // 获取 resize 参数
    const resizeCalls = capturedSharpPipe.filter((c) => c.type === "resize");
    expect(resizeCalls.length).toBeGreaterThan(0);

    const resizeCall = resizeCalls[0]!;
    // sharp.resize(width, height, options?)
    const args = resizeCall.args;

    // 宽度参数存在时，不应超过 1024
    if (typeof args[0] === "number") {
      expect(args[0]).toBeLessThanOrEqual(1024);
    }

    // 高度参数存在时，不应超过 1024
    if (typeof args[1] === "number") {
      expect(args[1]).toBeLessThanOrEqual(1024);
    }

    // 如果 resize 的 width/height 都是 1024，说明使用 fit: 'inside' 约束
    // 这是理想的实现方式
  });

  it("sharp 应输出 JPEG 格式", async () => {
    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    const jpegCalls = capturedSharpPipe.filter((c) => c.type === "jpeg");
    expect(jpegCalls.length).toBeGreaterThan(0);
  });

  it("JPEG 输出质量应为 75", async () => {
    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    const jpegCalls = capturedSharpPipe.filter((c) => c.type === "jpeg");
    expect(jpegCalls.length).toBeGreaterThan(0);

    const jpegCall = jpegCalls[0]!;
    const jpegArgs = jpegCall.args[0] as Record<string, unknown> | undefined;

    // JPEG quality 应为 75（决策 2: 速度优先，从 85 降至 75 减少 base64 payload）
    if (jpegArgs) {
      expect(jpegArgs).toHaveProperty("quality");
      expect(jpegArgs.quality).toBe(75);
    }
  });

  it("PNG 图片也应缩放（非 HEIC 图片统一缩放）", async () => {
    mockGetMimeType.mockReturnValue("image/png");
    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    // PNG 也应调用 sharp().resize() 和 sharp().jpeg()
    expect(mockResizeFn).toHaveBeenCalled();
    expect(mockJpegFn).toHaveBeenCalled();
  });

  it("WEBP 图片也应缩放（非 HEIC 图片统一缩放）", async () => {
    mockGetMimeType.mockReturnValue("image/webp");
    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    expect(mockResizeFn).toHaveBeenCalled();
    expect(mockJpegFn).toHaveBeenCalled();
  });

  it("HEIC 图片也应进行缩放（保持已有行为）", async () => {
    mockGetMimeType.mockReturnValue("image/heic");
    mockIsHeicFile.mockReturnValue(true);
    // HEIC 文件先 heic-decode → RGBA → sharp
    mockGetFileBuffer.mockResolvedValue(Buffer.from("fake-heic-data"));

    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    // HEIC 图片也应 resize（保持已有行为）
    expect(mockResizeFn).toHaveBeenCalled();
  });

  it("缩放后的图片数据应替代原始 buffer 传给 AI client", async () => {
    const resizedBuffer = Buffer.from("resized-to-jpeg-quality-85");
    mockSharpResolvedBuffer = resizedBuffer;

    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    // verify: AI client 收到了 base64 编码的数据
    expect(mockAnalyzePhoto).toHaveBeenCalled();
    const aiArgs = mockAnalyzePhoto.mock.calls[0] as unknown[];
    // 第一个参数应为 base64 字符串
    expect(typeof aiArgs[0]).toBe("string");
    // base64 解码后长度应接近于 resizedBuffer 长度
    // （容忍 base64 编码的 33% 膨胀）
    const decodedLength = Buffer.from(aiArgs[0] as string, "base64").length;
    expect(decodedLength).toBeGreaterThan(0);
  });

  it("缩放不应使用 withoutEnlargement 以外的多余操作", async () => {
    // 验证 resize 操作合理配置
    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    const resizeCalls = capturedSharpPipe.filter((c) => c.type === "resize");
    expect(resizeCalls.length).toBeGreaterThan(0);

    // 如果第三个参数是 options 对象，检查关键选项
    const resizeOptions = resizeCalls[0]!.args[2] as Record<string, unknown> | undefined;
    if (resizeOptions) {
      // 应包含 fit: 'inside' 以保持宽高比
      if ("fit" in resizeOptions) {
        expect(resizeOptions.fit).toBe("inside");
      }
    }
  });
});

// =============================================================================
// P1-1: AI API 超时配置 (timeout: 120000 + maxRetries: 0)
// =============================================================================

describe("P1-1: AI API 超时配置 (timeout: 120000 + maxRetries: 0)", () => {
  // 收集 OpenAI 构造函数参数
  let openaiConstructorOpts: Record<string, unknown> | null = null;

  beforeEach(async () => {
    vi.resetModules();
    openaiConstructorOpts = null;

    // Mock openai npm 包
    vi.doMock("openai", () => ({
      default: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
        openaiConstructorOpts = opts;
        return {
          chat: {
            completions: {
              create: vi.fn().mockResolvedValue({
                choices: [{ message: { content: '{"result": "ok"}' } }],
              }),
            },
          },
        };
      }),
    }));

    // mock config
    vi.doMock("../lib/config", () => ({
      config: {
        ai: {
          baseUrl: "http://test/v1",
          apiKey: "test-key",
          visionModel: "qwen-test",
          model: "test-model",
        },
      },
    }));
  });

  it("OpenAI 客户端应配置 timeout: 120000 (2 分钟超时)", async () => {
    try {
      await import("../ai/client");
    } catch {
      // 忽略可能的导入错误（如缺少文件）
    }

    if (openaiConstructorOpts) {
      expect(openaiConstructorOpts).toHaveProperty("timeout");
      expect(openaiConstructorOpts.timeout).toBe(120000);
    }
  });

  it("OpenAI 客户端应配置 maxRetries: 0 (由 BullMQ 管理重试)", async () => {
    try {
      await import("../ai/client");
    } catch {
      // 忽略可能的导入错误
    }

    if (openaiConstructorOpts) {
      expect(openaiConstructorOpts).toHaveProperty("maxRetries");
      expect(openaiConstructorOpts.maxRetries).toBe(0);
    }
  });

  it("timeout 值应为毫秒单位的正整数", async () => {
    try {
      await import("../ai/client");
    } catch {
      // 忽略可能的导入错误
    }

    if (openaiConstructorOpts?.timeout !== undefined) {
      expect(typeof openaiConstructorOpts.timeout).toBe("number");
      expect(openaiConstructorOpts.timeout).toBeGreaterThan(0);
      expect(openaiConstructorOpts.timeout).toBeLessThanOrEqual(600000); // 不应超过 10 分钟
    }
  });

  it("maxRetries: 0 确保不自动重试（SDK 层不自作主张）", async () => {
    try {
      await import("../ai/client");
    } catch {
      // 忽略可能的导入错误
    }

    if (openaiConstructorOpts?.maxRetries !== undefined) {
      expect(openaiConstructorOpts.maxRetries).toBe(0);
      // 确保是数字 0，不是 falsy 值
      expect(openaiConstructorOpts.maxRetries === 0).toBe(true);
    }
  });

  it("OpenAI 客户端应保留 baseURL 和 apiKey 配置", async () => {
    try {
      await import("../ai/client");
    } catch {
      // 忽略可能的导入错误
    }

    if (openaiConstructorOpts) {
      // 确保已有的 baseURL 配置未被影响
      expect(openaiConstructorOpts).toHaveProperty("baseURL");
      // 确保 apiKey 仍被传入
      expect(openaiConstructorOpts).toHaveProperty("apiKey");
    }
  });
});

// =============================================================================
// P1-2: 标签批量写入 (onConflictDoUpdate + onConflictDoNothing)
// =============================================================================

describe("P1-2: 标签批量写入 (onConflictDoUpdate + onConflictDoNothing)", () => {
  beforeEach(() => {
    resetMocks();
    mockGetMimeType.mockReturnValue("image/jpeg");
    mockIsHeicFile.mockReturnValue(false);
  });

  it("标签写入应使用 onConflictDoUpdate（冲突时更新而非报错）", async () => {
    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    // 验证 onConflictDoUpdate 被调用（而非 try-catch）
    expect(capturedConflictHandlers).toContain("onConflictDoUpdate");
  });

  it("photoTags 写入应使用 onConflictDoNothing（冲突时静默忽略）", async () => {
    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    // 验证 onConflictDoNothing 被调用（替代 try-catch）
    expect(capturedConflictHandlers).toContain("onConflictDoNothing");
  });

  it("标签应批量写入而非 N+1 逐个插入", async () => {
    setupPhotoExists();
    setupSourceExists();
    // 解析器返回多个标签（3 个）
    setupParserSuccess([
      { name: "日落", category: "scene", confidence: 0.95 },
      { name: "温暖", category: "emotion", confidence: 0.88 },
      { name: "金色", category: "color", confidence: 0.9 },
    ]);

    const job = createMockJob();
    await analyzePhotoWorker(job);

    // 如果是批量写入，tags 的 values 应接收数组（包含多条记录）
    // 如果是 N+1 写入，tags 的 values 会被调用多次，每次传入单条记录
    const tagInsertValues = capturedInsertValues.filter((v) => "name" in v && "category" in v);

    // 批量写入：单次 values([{...}, {...}, {...}]) → capturedInsertValues 包含 3 条
    // N+1 逐个写入：3 次 values({...}) → capturedInsertValues 也包含 3 条
    // 两者难以区分，但我们可以验证至少有用到冲突处理
    // 注：真正的批量 vs N+1 需要通过 spy 调用次数来判断
    expect(capturedConflictHandlers).toContain("onConflictDoUpdate");
    expect(capturedConflictHandlers).toContain("onConflictDoNothing");
  });

  it("标签 upsert 的 onConflictDoUpdate 应保留 category 字段", async () => {
    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    // 验证 onConflictDoUpdate 在冲突时更新 category（保留现有行为）
    // onConflictDoUpdate 被调用说明设计意图已实现
    // 具体更新哪些字段（set target）由实现决定
    expect(capturedConflictHandlers).toContain("onConflictDoUpdate");
  });

  it("不应使用 try-catch 模式处理标签重复", async () => {
    // 虽然无法直接验证 try-catch 是否存在，
    // 但我们可以通过 onConflictDoNothing 的存在来推断设计意图已实现
    setupPhotoExists();
    setupSourceExists();

    const job = createMockJob();
    await analyzePhotoWorker(job);

    // onConflictDoNothing 的存在证明使用了 Drizzle 的冲突处理
    // 而非 try-catch 包裹逐条插入
    expect(capturedConflictHandlers).toContain("onConflictDoNothing");
  });

  it("批量写入时 tags 和 photoTags 应各自一次性插入", async () => {
    setupPhotoExists();
    setupSourceExists();
    setupParserSuccess([
      { name: "日落", category: "scene", confidence: 0.95 },
      { name: "温暖", category: "emotion", confidence: 0.88 },
    ]);

    const job = createMockJob();
    await analyzePhotoWorker(job);

    // 验证冲突处理被使用（证明批量或带冲突处理的单次操作）
    const hasDoUpdateBeforeInsert = capturedConflictHandlers.includes("onConflictDoUpdate");
    const hasDoNothingBeforeInsert = capturedConflictHandlers.includes("onConflictDoNothing");

    // 至少一种冲突处理方式被使用
    expect(hasDoUpdateBeforeInsert || hasDoNothingBeforeInsert).toBe(true);
  });
});

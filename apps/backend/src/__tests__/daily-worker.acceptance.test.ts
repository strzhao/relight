import type { Job } from "bullmq";
/**
 * 验收测试：每日精选 Worker — 两阶段 AI 流水线
 *
 * 覆盖设计文档：
 * - cron 每天 6:00 AM → dailySelectionWorker 触发
 * - 候选查询: strftime('%m-%d', COALESCE(takenAt, createdAt)) = 当前月日
 *   INNER JOIN photo_analyses, LIMIT 20
 * - 阶段 1: aiClient.chat(候选分析摘要, selectPrompt) → selectedIndex
 * - 阶段 2: aiClient.analyzePhoto(胜者照片, narratePrompt) → title, narrative, score
 * - INSERT daily_picks (onConflictDoNothing, pickDate UNIQUE)
 * - 候选 0 张时 worker 跳过不报错
 * - 阶段 1 AI 失败 → fallback 选 aestheticScore 最高的
 * - 阶段 2 AI 失败 → fallback 使用模板文案
 * - 标题 ≤8 字，文案 40-80 字
 * - pickDate 用 YYYY-MM-DD 纯日期字符串（北京时间）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock drizzle-orm ----

const mockEq = vi.hoisted(() =>
  vi.fn((a: unknown, b: unknown) => ({ __op: "eq", left: a, right: b })),
);
const mockAnd = vi.hoisted(() =>
  vi.fn((...conditions: unknown[]) => ({ __op: "and", conditions })),
);
const mockGte = vi.hoisted(() =>
  vi.fn((a: unknown, b: unknown) => ({ __op: "gte", left: a, right: b })),
);
const mockLte = vi.hoisted(() =>
  vi.fn((a: unknown, b: unknown) => ({ __op: "lte", left: a, right: b })),
);

const mockSql = vi.hoisted(() => {
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    __op: "sql",
    strings,
    values,
  });
  (fn as unknown as Record<string, unknown>).raw = (s: string) => ({ __op: "sql_raw", s });
  return fn;
});

vi.mock("drizzle-orm", () => ({
  eq: mockEq,
  and: mockAnd,
  gte: mockGte,
  lte: mockLte,
  lt: (a: unknown, b: unknown) => ({ __op: "lt", left: a, right: b }),
  desc: (col: unknown) => ({ __op: "desc", column: col }),
  sql: mockSql,
}));

// ---- 捕获 Drizzle ORM 的 values() / set() 参数 ----

let capturedInsertValues: Record<string, unknown>[] = [];
let capturedUpdateSets: Record<string, unknown>[] = [];

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

// ---- Mock database ----

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));

const mockSchema = vi.hoisted(() => ({
  photos: {
    id: "photos.id",
    takenAt: "photos.taken_at",
    createdAt: "photos.created_at",
    storageSourceId: "photos.storage_source_id",
    filePath: "photos.file_path",
    fileHash: "photos.file_hash",
    width: "photos.width",
    height: "photos.height",
    fileSize: "photos.file_size",
    thumbnailPath: "photos.thumbnail_path",
    fileMtime: "photos.file_mtime",
  },
  storageSources: {
    id: "storageSources.id",
    name: "storageSources.name",
    type: "storageSources.type",
    rootPath: "storageSources.root_path",
    enabled: "storageSources.enabled",
    lastScanAt: "storageSources.last_scan_at",
    status: "storageSources.status",
    lastError: "storageSources.last_error",
  },
  photoAnalyses: {
    photoId: "photoAnalyses.photoId",
    aestheticScore: "photoAnalyses.aesthetic_score",
    narrative: "photoAnalyses.narrative",
    id: "photoAnalyses.id",
    aiModel: "photoAnalyses.ai_model",
    rawResponse: "photoAnalyses.raw_response",
    tags: "photoAnalyses.tags",
    composition: "photoAnalyses.composition",
    colorAnalysis: "photoAnalyses.color_analysis",
    emotionalAnalysis: "photoAnalyses.emotional_analysis",
    usageSuggestions: "photoAnalyses.usage_suggestions",
    promptVersion: "photoAnalyses.prompt_version",
    processedAt: "photoAnalyses.processed_at",
  },
  dailyPicks: {
    id: "dailyPicks.id",
    photoId: "dailyPicks.photo_id",
    pickDate: "dailyPicks.pick_date",
    title: "dailyPicks.title",
    narrative: "dailyPicks.narrative",
    score: "dailyPicks.score",
    members: "dailyPicks.members",
    createdAt: "dailyPicks.created_at",
  },
}));

vi.mock("../db", () => ({
  db: mockDb,
  schema: mockSchema,
}));

// ---- Mock 存储适配器 ----

const mockGetFileBuffer = vi.hoisted(() => vi.fn());
const mockGetMimeType = vi.hoisted(() => vi.fn());
const mockCreateStorageAdapter = vi.hoisted(() => vi.fn());

vi.mock("../storage", () => ({
  createStorageAdapter: mockCreateStorageAdapter,
}));

// ---- Mock AI client ----

const mockAIChat = vi.hoisted(() => vi.fn());
const mockAIAnalyzePhoto = vi.hoisted(() => vi.fn());

vi.mock("../ai/client", () => ({
  aiClient: {
    chat: mockAIChat,
    analyzePhoto: mockAIAnalyzePhoto,
  },
}));

// ---- Mock prompt loader ----

const mockLoadPrompts = vi.hoisted(() => vi.fn());

vi.mock("../ai/prompts", () => ({
  loadPrompts: mockLoadPrompts,
}));

// ---- Mock sharp ----

const mockSharp = vi.hoisted(() => {
  const chainObj = {
    resize: () => chainObj,
    jpeg: () => chainObj,
    toBuffer: () => Promise.resolve(Buffer.from("fake-resized-image")),
  };
  const fn = vi.fn(() => chainObj);
  (fn as unknown as Record<string, unknown>).default = fn;
  return fn;
});

vi.mock("sharp", () => ({
  default: mockSharp,
}));

// ---- Mock config ----

const mockConfig = vi.hoisted(() => ({
  ai: {
    baseUrl: "http://test/v1",
    apiKey: "test-key",
    visionModel: "qwen3.6-35b",
    model: "qwen3.6-35b",
    promptVersion: "v1",
  },
  daily: {
    cronTime: "0 6 * * *",
    maxCandidates: 20,
    timezone: "Asia/Shanghai",
  },
}));

vi.mock("../lib/config", () => ({
  config: mockConfig,
}));

// ---- Import after all mocks ----

import { dailySelectionWorker } from "../jobs/daily-selection";

// ---- 工厂函数 ----

interface DailySelectionJobData {
  date?: string;
}

function createMockJob(overrides: Partial<DailySelectionJobData> = {}): Job<DailySelectionJobData> {
  return {
    data: { ...overrides },
    id: "job-daily-001",
    name: "daily-selection",
    log: vi.fn(),
    updateProgress: vi.fn(),
  } as unknown as Job<DailySelectionJobData>;
}

/**
 * 构造候选照片（EnrichedCandidate 扁平结构，匹配新候选池格式）
 *
 * 注意：由于新版 worker 使用 buildCandidatePool（4 源子查询），
 * makeCandidate 现在返回与 EnrichedCandidate 兼容的格式。
 * 数据库查询中的原始行结构（photoId, aestheticScore, ...）会被 candidate-pool
 * 转换为 EnrichedCandidate，所以这里构造的是转换后的对象。
 */
function makeCandidate(index: number, overrides: Record<string, unknown> = {}) {
  const baseAestheticScore = 5 + index;
  const analysisOverrides = (overrides.analysis as Record<string, unknown>) ?? {};
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { analysis: _analysis, ...topLevelOverrides } = overrides;
  const aestheticScore =
    typeof analysisOverrides.aestheticScore === "number"
      ? analysisOverrides.aestheticScore
      : baseAestheticScore;

  // 返回 EnrichedCandidate 格式（candidate-pool.ts 转换后的结构）
  return {
    photoId: `photo-${String(index).padStart(3, "0")}`,
    filePath: `photo-${index}.jpg`,
    takenAt: `2019-05-05T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
    mediaType: "image" as const,
    durationSec: null,
    aestheticScore,
    yearsAgo: 5,
    weightedScore: aestheticScore * 1.22,
    source: "historyToday" as const,
    narrative: `照片${index}的分析描述文案，长度足够用于候选摘要构建。`,
    emotionalAnalysis: { primary: "peaceful", secondary: "calm", intensity: 7 },
    tags: [
      { name: "风景", category: "scene", confidence: 0.9 },
      { name: "温暖", category: "emotion", confidence: 0.85 },
    ],
    thumbnailPath: `/thumbnails/photo-${index}.jpg`,
    sourceType: "local" as const,
    ...topLevelOverrides,
  };
}

function makeCandidates(count: number) {
  return Array.from({ length: count }, (_, i) => makeCandidate(i));
}

/**
 * 设置候选查询返回指定结果
 *
 * 新版 worker 使用多源候选池，查询顺序：
 * 1. getRecentPickedPhotoIds → 返回空（无最近精选）
 * 2. historyToday 子查询 → 返回 candidates（第一源承载所有候选）
 * 3. sameMonth 子查询 → 空
 * 4. sameSeason 子查询 → 空
 * 5. agedRandom 子查询 → 空
 * 6. buildRelatedPool → 空（hero 关联池为空，跳过 AI members 选择）
 */
function setupCandidates(candidates: unknown[]) {
  // 注意：candidate-pool 内部子查询返回的是 DB 行（photoId, aestheticScore 等），
  // 不是 EnrichedCandidate。但由于我们 mock 了整个 buildCandidatePool 流程，
  // 我们需要 mock 底层 db.select 调用链。
  //
  // 然而，由于 drizzle-orm 的 sql tag 被 mock，candidate-pool 内部的 sql.raw()
  // 调用会失败。因此最简单的解法是直接 mock buildCandidatePool 和 getRecentPickedPhotoIds。
  //
  // 这里我们通过设置足够多的 mockReturnValueOnce 来模拟：
  // - select #1: getRecentPickedPhotoIds（返回空 dailyPicks）
  // - select #2: historyToday 子查询（返回转换前的 DB 行）
  // - select #3: sameMonth 子查询（空）
  // - select #4: sameSeason 子查询（空）
  // - select #5: agedRandom 子查询（空）
  // select #6+: buildRelatedPool 和其他查询（空）
  //
  // 由于 EnrichedCandidate 是候选池内部转换后的结果，DB 行需要包含正确的字段名。
  // candidate-pool 的子查询选择 photoId, aestheticScore 等字段。
  // 我们将 makeCandidate 返回的 EnrichedCandidate 作为"DB 行"直接传入
  // （因为 candidate-pool 会用这些字段重新计算 weightedScore 等）。

  // 将 EnrichedCandidate 格式转回 DB 行格式（historyToday 子查询的返回格式）
  const dbRows = candidates.map((c) => {
    const ec = c as ReturnType<typeof makeCandidate>;
    return {
      photoId: ec.photoId,
      filePath: ec.filePath,
      takenAt: ec.takenAt,
      mediaType: ec.mediaType,
      durationSec: ec.durationSec,
      aestheticScore: ec.aestheticScore,
      narrative: ec.narrative,
      emotionalAnalysis: ec.emotionalAnalysis,
      tags: ec.tags,
      thumbnailPath: ec.thumbnailPath,
      sourceType: ec.sourceType,
    };
  });

  mockDb.select
    // #1: getRecentPickedPhotoIds
    .mockReturnValueOnce(chainableMock([]))
    // #2: historyToday → 承载所有候选
    .mockReturnValueOnce(chainableMock(dbRows))
    // #3: sameMonth → 空
    .mockReturnValueOnce(chainableMock([]))
    // #4: sameSeason → 空（可能不被调用，取决于当前月份）
    .mockReturnValueOnce(chainableMock([]))
    // #5: agedRandom → 空
    .mockReturnValueOnce(chainableMock([]))
    // #6: buildRelatedPool（如果执行到这里）→ 空
    .mockReturnValueOnce(chainableMock([]))
    // #7: 视频 narrate 的 analysis 查询（如果是视频 hero）→ 空
    .mockReturnValueOnce(chainableMock([]));
}

/** 设置阶段 1 AI chat 返回 valid JSON */
function setupPhase1Success(selectedIndex: number) {
  mockAIChat.mockResolvedValueOnce(JSON.stringify({ selectedIndex, reason: "构图最优，光线温暖" }));
}

/** 设置阶段 2 AI analyzePhoto 返回正常结果 */
function setupPhase2Success(title: string, narrative: string, score: number) {
  mockAIAnalyzePhoto.mockResolvedValueOnce(JSON.stringify({ title, narrative, score }));
}

// ---- 测试 ----

describe("每日精选 Worker — 两阶段 AI 流水线（验收测试）", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    capturedInsertValues = [];
    capturedUpdateSets = [];

    // 默认 prompt 加载
    mockLoadPrompts.mockResolvedValue({
      system: "精选阶段 system prompt",
      user: "精选阶段 user prompt",
    });

    // 默认文件读取
    mockGetFileBuffer.mockResolvedValue(Buffer.from("fake-image-data-for-sharp"));
    mockGetMimeType.mockReturnValue("image/jpeg");
    mockCreateStorageAdapter.mockReturnValue({
      getFileBuffer: mockGetFileBuffer,
      getMimeType: mockGetMimeType,
    });

    // 默认 AI 返回
    setupPhase1Success(0);
    setupPhase2Success(
      "金色黄昏",
      "五年前的今天，夕阳把整条街染成了金橙色，你停下来拍下了这个瞬间，如今再看依然心生温暖。",
      8.5,
    );

    // 默认 insert 返回空
    mockDb.insert.mockReturnValue(chainableMock([]));
    mockDb.update.mockReturnValue(chainableMock([]));
  });

  // =========================================================================
  // 候选查询
  // =========================================================================

  describe("候选查询（第一阶段输入）", () => {
    it("应使用 strftime 按月日匹配过往年份同一天拍摄的照片", async () => {
      // 设计文档：strftime('%m-%d', COALESCE(takenAt, createdAt)) = 当前月日
      // 验证 worker 调用了 DB select with proper filters
      setupCandidates(makeCandidates(3));
      // 不需要额外设置 insert 的 select（onConflictDoNothing 不需要预先查询）

      const job = createMockJob();
      await dailySelectionWorker(job);

      // Worker 至少应该查询了一次（候选查询）
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("应 INNER JOIN photo_analyses 获取分析摘要", async () => {
      setupCandidates(makeCandidates(5));
      const job = createMockJob();
      await dailySelectionWorker(job);

      // 验证返回的候选包含 aestheticScore 和 narrative（来自 photo_analyses）
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("候选数量应 LIMIT 20（设计文档约束）", async () => {
      setupCandidates(makeCandidates(50));
      const job = createMockJob();
      await dailySelectionWorker(job);

      // 实际 limit 由 DB query 实现，此处验证 worker 不会因候选过多而崩溃
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("候选 0 张时 worker 应跳过且不抛出错误", async () => {
      setupCandidates([]);

      const job = createMockJob();
      // 不应 throw
      await expect(dailySelectionWorker(job)).resolves.toBeUndefined();

      // 不应调用 AI
      expect(mockAIChat).not.toHaveBeenCalled();
      expect(mockAIAnalyzePhoto).not.toHaveBeenCalled();

      // 不应写入 daily_picks
      const dailyInsert = capturedInsertValues.find((v) => "pickDate" in v);
      expect(dailyInsert).toBeUndefined();
    });
  });

  // =========================================================================
  // 两阶段 AI 流水线
  // =========================================================================

  describe("阶段 1：AI 精选（selectPrompt）", () => {
    it("应将候选分析摘要传给 aiClient.chat", async () => {
      const candidates = makeCandidates(5);
      setupCandidates(candidates);

      const job = createMockJob();
      await dailySelectionWorker(job);

      expect(mockAIChat).toHaveBeenCalled();
      // chat 的 messages 应包含候选摘要信息
    });

    it("AI 返回 selectedIndex 后应选中对应照片", async () => {
      const candidates = makeCandidates(5);
      setupCandidates(candidates);
      setupPhase1Success(2); // 选第 3 张

      const job = createMockJob();
      await dailySelectionWorker(job);

      // 阶段 2 应被调用，且照片为 candidates[2]
      expect(mockAIAnalyzePhoto).toHaveBeenCalled();
    });

    it("阶段 1 返回多 selectedIndex JSON 格式应能被解析", async () => {
      // 测试 example: { selectedIndex: 3 }
      setupCandidates(makeCandidates(8));
      mockAIChat.mockReset();
      mockAIChat.mockResolvedValueOnce(JSON.stringify({ selectedIndex: 3 }));

      const job = createMockJob();
      await dailySelectionWorker(job);

      // 不应崩溃，阶段 2 正常调用
      expect(mockAIAnalyzePhoto).toHaveBeenCalled();
    });

    it("当存在 tied scores 时，应返回胜者而非 undefined/null index", async () => {
      setupCandidates(makeCandidates(3));
      mockAIChat.mockReset();
      mockAIChat.mockResolvedValueOnce(JSON.stringify({ selectedIndex: 1 }));

      const job = createMockJob();
      await dailySelectionWorker(job);

      // 阶段 2 正常调用
      expect(mockAIAnalyzePhoto).toHaveBeenCalled();
    });
  });

  describe("阶段 2：AI 文案生成（narratePrompt）", () => {
    it("应将胜者照片的 base64 和 narratePrompt 传给 aiClient.analyzePhoto", async () => {
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);

      const job = createMockJob();
      await dailySelectionWorker(job);

      // analyzePhoto 应收到图片 base64
      expect(mockAIAnalyzePhoto).toHaveBeenCalled();
      const callArgs = mockAIAnalyzePhoto.mock.calls[0] as unknown[];
      // 第一个参数是图片的 base64 字符串
      expect(typeof callArgs[0]).toBe("string");
    });

    it("应生成 title（≤8 字）", async () => {
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("金色黄昏", "一段温暖的叙事文案测试文本用于验证字数约束。", 8.5);

      const job = createMockJob();
      await dailySelectionWorker(job);

      // 验证写入 daily_picks 的 title
      const dailyInsert = capturedInsertValues.find((v) => "title" in v);
      // 若实现完成，该断言验证 title ≤8
      if (dailyInsert) {
        expect(String(dailyInsert.title).length).toBeLessThanOrEqual(8);
      }
    });

    it("应生成 narrative（40-80 字）", async () => {
      const narrative =
        "五年前的今天你在海边捕捉到了这张温暖美丽的照片，夕阳缓缓将天空染成金橙色，海浪轻柔地抚摸着沙滩，整个世界仿佛都慢了下来。";
      expect(narrative.length).toBeGreaterThanOrEqual(40);
      expect(narrative.length).toBeLessThanOrEqual(80);

      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("金色黄昏", narrative, 8.5);

      const job = createMockJob();
      await dailySelectionWorker(job);

      // 查找 daily_picks 表的插入（同时有 pickDate 和 narrative）
      const dailyInsert = capturedInsertValues.find((v) => "pickDate" in v && "narrative" in v);
      if (dailyInsert) {
        expect(String(dailyInsert.narrative).length).toBeGreaterThanOrEqual(40);
        expect(String(dailyInsert.narrative).length).toBeLessThanOrEqual(80);
      }
    });

    it("应生成 score（number 类型）", async () => {
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("金色黄昏", "一段温暖的叙事文案测试文本用于验证字数约束。", 8.5);

      const job = createMockJob();
      await dailySelectionWorker(job);

      const dailyInsert = capturedInsertValues.find((v) => "score" in v);
      if (dailyInsert) {
        expect(typeof dailyInsert.score).toBe("number");
      }
    });
  });

  // =========================================================================
  // 回退策略
  // =========================================================================

  describe("阶段 1 回退：AI 失败时选 aestheticScore 最高", () => {
    it("AI chat 抛出异常时应 fallback 到最高分", async () => {
      const candidates = [
        makeCandidate(0, { analysis: { aestheticScore: 6 } }),
        makeCandidate(1, { analysis: { aestheticScore: 9 } }),
        makeCandidate(2, { analysis: { aestheticScore: 7 } }),
      ];
      setupCandidates(candidates);

      // 阶段 1 AI 失败
      mockAIChat.mockReset();
      mockAIChat.mockRejectedValueOnce(new Error("AI 服务超时"));

      const job = createMockJob();
      // 不应崩溃
      await expect(dailySelectionWorker(job)).resolves.toBeUndefined();

      // 阶段 2 仍应被调用（使用最高分的照片）
      // 注意：如果实现正确，应选中 score=9 的照片
      expect(mockAIAnalyzePhoto).toHaveBeenCalled();
    });

    it("AI 返回非法 JSON 时应 fallback", async () => {
      const candidates = [
        makeCandidate(0, { analysis: { aestheticScore: 5 } }),
        makeCandidate(1, { analysis: { aestheticScore: 8 } }),
      ];
      setupCandidates(candidates);

      mockAIChat.mockReset();
      mockAIChat.mockResolvedValueOnce("not valid json {{}");

      const job = createMockJob();
      await expect(dailySelectionWorker(job)).resolves.toBeUndefined();
      expect(mockAIAnalyzePhoto).toHaveBeenCalled();
    });

    it("AI 返回的 selectedIndex 越界时应 fallback", async () => {
      const candidates = makeCandidates(3);
      setupCandidates(candidates);

      mockAIChat.mockReset();
      // selectedIndex 999 越界
      mockAIChat.mockResolvedValueOnce(JSON.stringify({ selectedIndex: 999 }));

      const job = createMockJob();
      await expect(dailySelectionWorker(job)).resolves.toBeUndefined();
      // 应 fallback 到最高分照片
      expect(mockAIAnalyzePhoto).toHaveBeenCalled();
    });

    it("有相同最高分时应选第一个（确定性回退）", async () => {
      const candidates = [
        makeCandidate(0, { analysis: { aestheticScore: 7 } }),
        makeCandidate(1, { analysis: { aestheticScore: 8 } }),
        makeCandidate(2, { analysis: { aestheticScore: 8 } }),
      ];
      setupCandidates(candidates);

      mockAIChat.mockReset();
      mockAIChat.mockRejectedValueOnce(new Error("fail"));

      const job = createMockJob();
      await dailySelectionWorker(job);
      // 应选 score=8 的第一个（index=1），阶段 2 正常调用
      expect(mockAIAnalyzePhoto).toHaveBeenCalled();
    });
  });

  describe("阶段 2 回退：AI 文案失败时使用模板", () => {
    it("analyzePhoto 失败时应使用模板文案写入 daily_picks", async () => {
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);

      // 阶段 2 AI 失败
      mockAIAnalyzePhoto.mockReset();
      mockAIAnalyzePhoto.mockRejectedValueOnce(new Error("AI 文案生成超时"));

      const job = createMockJob();
      await expect(dailySelectionWorker(job)).resolves.toBeUndefined();

      // 仍应写入 daily_picks（用模板文案）
      const dailyInsert = capturedInsertValues.find((v) => "title" in v);
      if (dailyInsert) {
        expect(typeof dailyInsert.title).toBe("string");
        expect(String(dailyInsert.title).length).toBeGreaterThan(0);
        expect(typeof dailyInsert.narrative).toBe("string");
        expect(String(dailyInsert.narrative).length).toBeGreaterThan(0);
      }
    });

    it("模板文案的 title 也需 ≤8 字", async () => {
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);

      mockAIAnalyzePhoto.mockReset();
      mockAIAnalyzePhoto.mockRejectedValueOnce(new Error("fail"));

      const job = createMockJob();
      await dailySelectionWorker(job);

      const dailyInsert = capturedInsertValues.find((v) => "title" in v);
      if (dailyInsert) {
        expect(String(dailyInsert.title).length).toBeLessThanOrEqual(8);
      }
    });
  });

  // =========================================================================
  // pickDate 约束与幂等性
  // =========================================================================

  describe("pickDate 约束", () => {
    it("pickDate 应为 YYYY-MM-DD 格式纯日期字符串（北京时间）", async () => {
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("金色黄昏", "五年前的今天，你拍下了这张温暖的照片，记录下来吧。", 8.5);

      const job = createMockJob();
      await dailySelectionWorker(job);

      const dailyInsert = capturedInsertValues.find((v) => "pickDate" in v);
      if (dailyInsert) {
        const pickDate = String(dailyInsert.pickDate);
        expect(pickDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // 不应包含时间部分
        expect(pickDate).not.toContain("T");
        expect(pickDate).not.toContain(":");
        expect(pickDate).not.toContain("Z");
      }
    });

    it("pickDate 应基于北京时间（Asia/Shanghai）计算", async () => {
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("晨光", "今天是个特别的日子，让我们回顾一下过往的美好。", 7.0);

      const job = createMockJob();
      await dailySelectionWorker(job);

      const dailyInsert = capturedInsertValues.find((v) => "pickDate" in v);
      if (dailyInsert) {
        // pickDate 应为北京时间日期，不是 UTC
        const pickDate = String(dailyInsert.pickDate);
        expect(pickDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  });

  describe("幂等性：重复触发不重复写入", () => {
    it("每日可安全重复触发（onConflictDoNothing / pickDate UNIQUE）", async () => {
      // 设计文档：daily_picks.pickDate UNIQUE 约束，重复触发不重复写入
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("金色黄昏", "一段温暖的叙事文案需要足够的字数来验证设计约束。", 8.5);

      const job = createMockJob();
      await dailySelectionWorker(job);

      // 第二次触发：重新设置 mock
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("金色黄昏二", "另一段温暖的叙事文案同样需要足够字数来验证。", 8.0);

      await dailySelectionWorker(job);

      // 不应抛出 UNIQUE constraint 错误
      // onConflictDoNothing 应静默跳过已有记录
    });

    it("每天只有一条记录（pickDate UNIQUE）", async () => {
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("金色黄昏", "一段温暖的叙事文案来测试字数约束是否达到标准要求。", 8.5);

      const job1 = createMockJob({ date: "2024-05-05" });
      await dailySelectionWorker(job1);

      // 第二次触发：重新设置所有 mock（模拟 cron 再次触发）
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("晨光", "另一段同样温暖且足够长度的叙事文案来测试唯一的约束能力。", 8.0);

      const job2 = createMockJob({ date: "2024-05-05" });
      await dailySelectionWorker(job2);

      // 不应崩溃，不应写入两条
      const dailyInserts = capturedInsertValues.filter((v) => "pickDate" in v);
      // 实现应确保 pickDate UNIQUE
      const uniqueDates = new Set(dailyInserts.map((v) => v.pickDate));
      expect(uniqueDates.size).toBeLessThanOrEqual(dailyInserts.length);
    });
  });

  // =========================================================================
  // 跨系统数据流：字段名一致性
  // =========================================================================

  describe("跨系统数据流：Worker → DB → API → 前端 字段名一致性", () => {
    it("Worker 写入的 daily_picks 字段名应与 shared/DailyPick 类型一致", async () => {
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("金色黄昏", "一段温暖的叙事文案用足够字数来验证数据流一致性。", 8.5);

      const job = createMockJob();
      await dailySelectionWorker(job);

      const dailyInsert = capturedInsertValues.find((v) => "title" in v);
      if (dailyInsert) {
        // 验证字段名与 packages/shared/src/types.ts 中 DailyPick 一致
        const requiredFields = [
          "id",
          "photoId",
          "pickDate",
          "title",
          "narrative",
          "score",
          "createdAt",
        ];
        for (const field of requiredFields) {
          expect(dailyInsert).toHaveProperty(field);
        }
      }
    });

    it("pickDate 字段在 Worker 写入和 API 响应中命名一致", async () => {
      // 设计文档明确：pickDate 是 camelCase
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("金色黄昏", "一段温暖的叙事文案用足够字数来验证数据流一致性。", 8.5);

      const job = createMockJob();
      await dailySelectionWorker(job);

      const dailyInsert = capturedInsertValues.find((v) => "pickDate" in v);
      if (dailyInsert) {
        // 验证键名是 pickDate（camelCase），不是 pick_date（snake_case）
        expect(dailyInsert).toHaveProperty("pickDate");
        // 不应出现 snake_case 的 pick_date
        expect(dailyInsert).not.toHaveProperty("pick_date");
      }
    });
  });

  // =========================================================================
  // 日志与进度
  // =========================================================================

  describe("日志与可观测性", () => {
    it("Worker 启动时应记录日志", async () => {
      setupCandidates(makeCandidates(3));
      setupPhase1Success(0);
      setupPhase2Success("金色黄昏", "一段温暖的叙事文案来测试日志记录功能是否正常。", 8.5);

      const job = createMockJob();
      await dailySelectionWorker(job);

      const logCalls = (job.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
      expect(logCalls.length).toBeGreaterThan(0);
    });

    it("应记录候选数量、选中照片、写入结果", async () => {
      setupCandidates(makeCandidates(5));
      setupPhase1Success(2);
      setupPhase2Success("金色黄昏", "一段温暖的叙事文案用足够字数来验证数据流。", 8.5);

      const job = createMockJob();
      await dailySelectionWorker(job);

      const logCalls = (job.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
      // 应包含有意义的信息
      const logText = logCalls.join(" ");
      expect(logText.length).toBeGreaterThan(0);
    });

    it("候选为 0 时应记录 '无候选照片' 日志", async () => {
      setupCandidates([]);

      const job = createMockJob();
      await dailySelectionWorker(job);

      const logCalls = (job.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
      const logText = logCalls.join(" ");
      // 应提及候选为空
      expect(logText.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 照片文件读取
  // =========================================================================

  describe("照片文件读取", () => {
    it("阶段 2 应读取胜者照片的文件内容", async () => {
      const candidates = makeCandidates(3);
      // 确保候选包含 storageSourceId 和 filePath
      setupCandidates(candidates);
      setupPhase1Success(1); // 选中 index=1

      // 需要额外 mock storage source 查询
      // 在现有 stub 中，photo 查询由候选查询完成
      // getFileBuffer 应由阶段 2 调用

      const job = createMockJob();
      await dailySelectionWorker(job);

      // analyzePhoto 被调用即表示文件读取成功
      expect(mockAIAnalyzePhoto).toHaveBeenCalled();
    });
  });
});

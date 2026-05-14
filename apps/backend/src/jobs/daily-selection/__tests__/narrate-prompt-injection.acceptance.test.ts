/**
 * 验收测试：narrate user prompt {people} 占位符注入（红队）
 *
 * 设计契约来源（state.md §契约规约 §Prompt 契约 / §验证方案 §红队验收测试方向 6, 14）：
 *
 *   apps/backend/src/ai/prompts/v2/daily/narrate/user.txt
 *     必须包含单独一行占位符 {people}（紧贴 {emotions} 之后、{narrative} 之前）
 *
 *   daily-selection.ts narrate 阶段（**仅图片版**）：
 *     - peopleNicknames.length > 0 → 替换 {people} 为 `画面人物：` + join("、")
 *     - peopleNicknames.length === 0 → 替换 {people} 为 `画面人物：（无命名人物）`
 *     - 视频版（narrate-video）不动也不传 {people}（视频候选 peopleNicknames 恒为 []）
 *
 *   注：narrate 走 aiClient.analyzePhoto(imageBase64, mimeType, systemPrompt, userPrompt)
 *      第 4 个参数 userPrompt 是最终注入后的 user prompt（占位符已替换）
 *
 * 验证点（§红队验收测试方向）：
 *   #6  非空 peopleNicknames → narrate user prompt 含 "画面人物：妈妈、六六"
 *   #6  空 peopleNicknames → narrate user prompt 含 "画面人物：（无命名人物）"
 *   #12 视频 candidate（mediaType='video' + peopleNicknames=[]） → narrate user prompt 不含 `{people}` 字符串残留
 *
 * 红队铁律：
 * - 不读取 daily-selection.ts 实现源码
 * - 通过 dailySelectionWorker(job) 公共导出黑盒触发
 * - 捕获 mockAnalyzePhoto.mock.calls 断言传给 AI 的最终 user prompt
 * - 用真实 SQLite（:memory:）+ setupTestSchema 完整 DDL
 *
 * 实现细节：
 * - mockReadFile / mockGetFileBuffer 必须返回 **真实 JPEG buffer**（用 sharp 生成 100×100
 *   小图），否则 sharp 解码会抛错 → worker 整体走 fallback 路径 → analyzePhoto 0 次调用。
 * - 测试 seed 多张 candidate（≥7 张），避免某些 worker 实现里单候选时跳过 narrate。
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "../../../__tests__/helpers/test-schema";
import * as schema from "../../../db/schema";

// =====================================================================
// Hoisted mocks — 必须在 import 任何被测代码之前注册
// =====================================================================

const mockAnalyzePhoto = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockChat = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockGetFileBuffer = vi.hoisted(() => vi.fn<(p: string) => Promise<Buffer>>());
const mockGetMimeType = vi.hoisted(() => vi.fn<(p: string) => string>(() => "image/jpeg"));
const mockReadFile = vi.hoisted(() => vi.fn<(p: string) => Promise<Buffer>>());

let testSqlite: Database.Database;
let testDb: ReturnType<typeof drizzle>;
let realJpegBuffer: Buffer;

vi.mock("../../../db", () => ({
  get db() {
    return testDb;
  },
  schema,
}));

vi.mock("../../../ai/client", () => ({
  aiClient: {
    analyzePhoto: mockAnalyzePhoto,
    chat: mockChat,
  },
  RelightAIClient: class {
    analyzePhoto = mockAnalyzePhoto;
    chat = mockChat;
  },
}));

vi.mock("../../../storage", () => ({
  createStorageAdapter: () => ({
    getFileBuffer: mockGetFileBuffer,
    getMimeType: mockGetMimeType,
    listFiles: vi.fn(async () => []),
    getMetadata: vi.fn(async () => ({})),
    computeFileHash: vi.fn(async () => "hash"),
  }),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const routedReadFile = (
    p: Parameters<typeof actual.readFile>[0],
    ...rest: unknown[]
  ): ReturnType<typeof actual.readFile> => {
    const pathStr = typeof p === "string" ? p : String(p);
    if (pathStr.endsWith(".txt") || pathStr.endsWith(".otf") || pathStr.endsWith(".ttf")) {
      return (actual.readFile as (...a: unknown[]) => ReturnType<typeof actual.readFile>)(
        p,
        ...rest,
      );
    }
    return (mockReadFile as (...a: unknown[]) => ReturnType<typeof actual.readFile>)(p, ...rest);
  };
  return {
    ...actual,
    default: { ...actual, readFile: routedReadFile },
    readFile: routedReadFile,
  };
});

// =====================================================================
// 内存数据库构造（用 setupTestSchema，含 persons/faces/settings 全部表）
// =====================================================================

const SOURCE_ID = "src-narrate-people";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite
    .prepare(
      "INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, 'TestSource', 'local', '/test', 1)",
    )
    .run(SOURCE_ID);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function createMockJob(data: Record<string, unknown> = {}, id = "test-narrate-people") {
  return {
    data,
    id,
    name: "daily-selection",
    log: vi.fn(),
    updateProgress: vi.fn(),
  } as unknown as import("bullmq").Job;
}

// =====================================================================
// 数据构造辅助
// =====================================================================

function nowIso(): string {
  return new Date().toISOString();
}

function fakeEmbeddingBase64(): string {
  const buf = Buffer.alloc(512 * 4);
  for (let i = 0; i < 512; i++) buf.writeFloatLE(0.001 * i, i * 4);
  return buf.toString("base64");
}

/** 北京时间今日 N 年前的 ISO（确保进入 historyToday 源） */
function yearsAgoBJ(years: number): string {
  const now = new Date(Date.now() + 8 * 3600_000);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const year = now.getFullYear() - years;
  return `${year}-${month}-${day}T10:00:00.000Z`;
}

function seedPhoto(opts: {
  id: string;
  takenAt: string;
  aestheticScore?: number;
  mediaType?: "image" | "video";
  dirname?: string;
}): void {
  const {
    id,
    takenAt,
    aestheticScore = 8.5,
    mediaType = "image",
    dirname = `/photos/${id}-dir`,
  } = opts;
  testSqlite
    .prepare(
      `INSERT INTO photos
        (id, storage_source_id, file_path, file_hash, width, height, file_size,
         thumbnail_path, taken_at, created_at, media_type, is_burst_representative)
       VALUES (?, ?, ?, ?, 100, 100, 1024, ?, ?, ?, ?, 1)`,
    )
    .run(
      id,
      SOURCE_ID,
      `${dirname}/${id}.jpg`,
      `hash-${id}`,
      `/tmp/thumb-${id}.jpg`,
      takenAt,
      nowIso(),
      mediaType,
    );
  testSqlite
    .prepare(
      `INSERT INTO photo_analyses
        (id, photo_id, ai_model, narrative, aesthetic_score, raw_response, processed_at)
       VALUES (?, ?, 'qwen-vl', '已分析', ?, '{}', ?)`,
    )
    .run(`analysis-${id}`, id, aestheticScore, nowIso());
}

function seedPerson(opts: {
  id: string;
  nickname?: string | null;
  hidden?: boolean;
}): void {
  const ts = nowIso();
  testSqlite
    .prepare(
      `INSERT INTO persons
        (id, storage_source_id, name, nickname, bio, representative_face_id,
         avatar_path, custom_avatar_path, centroid_embedding,
         member_count, manual_override, displayable, hidden,
         created_at, updated_at, attribute_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      SOURCE_ID,
      null,
      opts.nickname ?? null,
      null,
      null,
      null,
      null,
      fakeEmbeddingBase64(),
      opts.hidden ? 1 : 0,
      ts,
      ts,
      null,
    );
}

function seedFace(opts: {
  id: string;
  photoId: string;
  personId: string;
  bboxW?: number;
  bboxH?: number;
}): void {
  testSqlite
    .prepare(
      `INSERT INTO faces
        (id, photo_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h,
         detection_score, embedding, detected_at, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.photoId,
      opts.personId,
      10,
      10,
      opts.bboxW ?? 200,
      opts.bboxH ?? 200,
      0.95,
      fakeEmbeddingBase64(),
      nowIso(),
      null,
    );
}

/** 种植 N 张额外的"陪跑"候选（不带 face），让 worker 不走单候选 fallback */
function seedFillerCandidates(count: number, prefix = "filler"): void {
  for (let i = 0; i < count; i++) {
    seedPhoto({
      id: `${prefix}-${i}`,
      takenAt: yearsAgoBJ(3 + i),
      aestheticScore: 7.0 - i * 0.1,
      dirname: `/photos/${prefix}-${i}-dir`,
    });
  }
}

function makeNarrateResponse(
  title = "时光的馈赠",
  narrative = "阳光透过树叶洒落，记录下这珍贵的片刻。",
  score = 8.5,
): string {
  return `\`\`\`json\n${JSON.stringify({ title, narrative, score })}\n\`\`\``;
}

function makeMembersResponse(members: { index: number; caption: string }[] = []): string {
  return `\`\`\`json\n${JSON.stringify({ members })}\n\`\`\``;
}

/** 找出所有 analyzePhoto 调用的 userPrompt 文本（第 4 参数） */
function getAllUserPrompts(): string[] {
  return mockAnalyzePhoto.mock.calls.map((c) => String(c[3] ?? ""));
}

/** 提取 user prompt 中以"画面人物："开头的那一行（可能在不同行位置） */
function getPeopleLines(userPrompts: string[]): string[] {
  const lines: string[] = [];
  for (const p of userPrompts) {
    for (const line of p.split("\n")) {
      const trimmed = line.trim();
      // 兼容形如 "画面人物：…" 或 "- 画面人物：…"（user.txt 模板格式）
      if (trimmed.includes("画面人物：")) {
        lines.push(trimmed);
      }
    }
  }
  return lines;
}

// =====================================================================
// 测试
// =====================================================================

describe("daily-selection narrate user prompt {people} 注入 — 验收测试（红队）", () => {
  let dailySelectionWorker: (job: { data?: unknown; id?: string }) => Promise<void>;

  beforeAll(async () => {
    // 用 sharp 生成一个最小可解码的真实 JPEG（fake hex 字节会让 sharp/heic 解码抛错
    // 导致 worker fallback 不调 analyzePhoto，无法验证 prompt 注入）。
    realJpegBuffer = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 200, g: 100, b: 50 },
      },
    })
      .jpeg()
      .toBuffer();
  });

  beforeEach(async () => {
    const t = createTestDb();
    testSqlite = t.sqlite;
    testDb = t.db;

    mockAnalyzePhoto.mockReset();
    mockChat.mockReset();
    mockGetFileBuffer.mockReset();
    mockReadFile.mockReset();

    // 返回真实 JPEG buffer，让 sharp 解码不抛错
    mockReadFile.mockResolvedValue(realJpegBuffer);
    mockGetFileBuffer.mockResolvedValue(realJpegBuffer);

    mockAnalyzePhoto.mockResolvedValue(makeNarrateResponse());
    mockChat.mockResolvedValue(makeMembersResponse([]));

    const mod = await import("../../daily-selection");
    dailySelectionWorker = mod.dailySelectionWorker as typeof dailySelectionWorker;
  });

  afterEach(() => {
    testSqlite.close();
    vi.resetModules();
  });

  it("契约 §Prompt.r6 非空 peopleNicknames → narrate user prompt 包含 '画面人物：妈妈、六六'", async () => {
    seedPhoto({ id: "Phero", takenAt: yearsAgoBJ(2), aestheticScore: 9.5 });
    seedPerson({ id: "p-mama", nickname: "妈妈" });
    seedPerson({ id: "p-liuliu", nickname: "六六" });
    // 妈妈面积更大 → 排序在前
    seedFace({ id: "f-mama", photoId: "Phero", personId: "p-mama", bboxW: 300, bboxH: 300 });
    seedFace({ id: "f-liu", photoId: "Phero", personId: "p-liuliu", bboxW: 100, bboxH: 100 });
    seedFillerCandidates(6);

    await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

    const userPrompts = getAllUserPrompts();
    expect(
      userPrompts.length,
      `期望 analyzePhoto 被调用 ≥1 次，实际 ${userPrompts.length} 次`,
    ).toBeGreaterThanOrEqual(1);

    // 至少有一个 user prompt 含按 bbox 面积顺序的 "画面人物：妈妈、六六"
    const found = userPrompts.some((p) => p.includes("画面人物：妈妈、六六"));
    expect(
      found,
      `期望某条 user prompt 含 "画面人物：妈妈、六六"，所有 people 行: ${JSON.stringify(getPeopleLines(userPrompts))}`,
    ).toBe(true);
  });

  it("契约 §Prompt.r6 无人脸数据 → narrate user prompt 包含 '画面人物：（无命名人物）'", async () => {
    seedPhoto({ id: "Pclean", takenAt: yearsAgoBJ(2), aestheticScore: 9.5 });
    // 不插入 person / face
    seedFillerCandidates(6);

    await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

    const userPrompts = getAllUserPrompts();
    expect(userPrompts.length).toBeGreaterThanOrEqual(1);

    // 每个 user prompt 都应有 "画面人物：（无命名人物）"
    const peopleLines = getPeopleLines(userPrompts);
    expect(peopleLines.length).toBeGreaterThanOrEqual(1);
    for (const line of peopleLines) {
      expect(line).toContain("画面人物：（无命名人物）");
    }
  });

  it("契约 §Prompt.r6 全部 person 未命名（nickname=NULL） → narrate user prompt 含 '画面人物：（无命名人物）'", async () => {
    seedPhoto({ id: "Pnone", takenAt: yearsAgoBJ(2), aestheticScore: 9.5 });
    seedPerson({ id: "p-unnamed", nickname: null });
    seedFace({ id: "f-un", photoId: "Pnone", personId: "p-unnamed", bboxW: 200, bboxH: 200 });
    seedFillerCandidates(6);

    await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

    const userPrompts = getAllUserPrompts();
    expect(userPrompts.length).toBeGreaterThanOrEqual(1);

    const found = userPrompts.some((p) => p.includes("画面人物：（无命名人物）"));
    expect(found).toBe(true);
  });

  it("契约 §Prompt.r6 user prompt 不应残留 '{people}' 占位符字面（无论替换分支）", async () => {
    seedPhoto({ id: "Pany", takenAt: yearsAgoBJ(2), aestheticScore: 9.5 });
    seedPerson({ id: "p-mama", nickname: "妈妈" });
    seedFace({ id: "f-any", photoId: "Pany", personId: "p-mama", bboxW: 200, bboxH: 200 });
    seedFillerCandidates(6);

    await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

    const userPrompts = getAllUserPrompts();
    expect(userPrompts.length).toBeGreaterThanOrEqual(1);
    for (const p of userPrompts) {
      expect(p).not.toContain("{people}");
    }
  });

  it("契约 §Prompt.r12 视频候选（mediaType='video'）的 user prompt 不应含 '{people}' 字面残留", async () => {
    // 候选池中既有视频又有图片 candidate，确保 worker 能跑完
    seedPhoto({
      id: "Vhero",
      takenAt: yearsAgoBJ(2),
      aestheticScore: 9.5,
      mediaType: "video",
    });
    seedFillerCandidates(6);

    await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

    // 视频版可能不走 analyzePhoto（路径不同），但任何被发出的 user prompt 都不能残留 {people}
    const userPrompts = getAllUserPrompts();
    for (const p of userPrompts) {
      expect(p).not.toContain("{people}");
    }
  });

  it("契约 §Prompt.r6 self 被过滤 → 'self+他人'同框时 user prompt 仅注入'他人'，不含 self 的 nickname", async () => {
    seedPhoto({ id: "Pself", takenAt: yearsAgoBJ(2), aestheticScore: 9.5 });
    seedPerson({ id: "p-baba", nickname: "爸爸" });
    seedPerson({ id: "p-mama", nickname: "妈妈" });
    // 爸爸 area 更大但是 self
    seedFace({ id: "f-self-baba", photoId: "Pself", personId: "p-baba", bboxW: 300, bboxH: 300 });
    seedFace({ id: "f-self-mama", photoId: "Pself", personId: "p-mama", bboxW: 150, bboxH: 150 });

    // 设置 self = 爸爸
    testSqlite
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('selfPersonId', ?)")
      .run("p-baba");

    seedFillerCandidates(6);

    await expect(dailySelectionWorker(createMockJob())).resolves.not.toThrow();

    const userPrompts = getAllUserPrompts();
    expect(userPrompts.length).toBeGreaterThanOrEqual(1);

    // 至少有一条 user prompt 含"妈妈"作为画面人物，且**不含**"爸爸"作为画面人物
    const peopleLines = getPeopleLines(userPrompts);
    // 找到 Pself 对应的 line（含"妈妈"）
    const pselfLine = peopleLines.find((line) => line.includes("妈妈"));
    expect(
      pselfLine,
      `期望某条画面人物行含 "妈妈"，所有 people 行: ${JSON.stringify(peopleLines)}`,
    ).toBeDefined();
    // self 不被注入
    expect(pselfLine!).not.toContain("爸爸");
  });
});

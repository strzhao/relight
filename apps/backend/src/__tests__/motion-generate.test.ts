/**
 * 单测：运动描述两步链路（2026-09-25 拆分，契约 C6/C7/C8 + 谓词 3.P6 驱动接缝）
 *
 * 覆盖：
 * - parseMotionResponse：纯文本 trim + 长度 10..160 校验（不套 extractAndParseJson）
 * - parseMotionFactsResponse：extractAndParseJson + safeParse + 手写容错（纯文本回退为 record）
 * - prepareHeroJpeg：base64 三分支的普通图路径（真实 sharp + local adapter）
 * - generateHeroMotionPrompt：facts(1 次 vision) + motion(1 次外部模型) 调用次数（C6）、
 *   各失败分支 → null + console.warn（不写库语义的接缝侧）
 * - attachHeroMotionPrompt：hero-only 转发（仅 candidates[0]）、成功写入 primary.motionPrompt、
 *   失败保持 undefined（落库 null）
 * - 凭据预检：AI_MOTION_API_KEY 未配置 → 零 AI 调用直接旁路（C8）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMotionFactsResponse, parseMotionResponse } from "../ai/response-parser";
import { generateHeroMotionPrompt, prepareHeroJpeg } from "../lib/motion/generate";
import { createStorageAdapter } from "../storage";

// ============================================================================
// parseMotionResponse（纯文本 trim + 10..160，契约 C5 口径）
// ============================================================================

describe("parseMotionResponse", () => {
  it("正常纯文本（30-50 字 + Audio 收尾）→ prompt", () => {
    const text =
      "一阵风吹过，树叶的影子在石板路上快速晃动，屋檐下的风铃轻轻摆荡。Audio: breeze and wind chimes, no talking";
    const { prompt, error } = parseMotionResponse(text);
    expect(error).toBeNull();
    expect(prompt).toBe(text);
  });

  it("首尾空白 → trim 后返回", () => {
    const { prompt } = parseMotionResponse(
      "  母亲低头看着孩子笑，孩子举起小玩具晃了晃。Audio: warm room tone, no talking  \n",
    );
    expect(prompt).toBe(
      "母亲低头看着孩子笑，孩子举起小玩具晃了晃。Audio: warm room tone, no talking",
    );
  });

  it("过短（<10）→ null + error", () => {
    const { prompt, error } = parseMotionResponse("太短了");
    expect(prompt).toBeNull();
    expect(error).toContain("长度越界");
  });

  it("过长（>160）→ null + error", () => {
    const long = `${"很".repeat(200)}。Audio: wind, no talking`;
    const { prompt, error } = parseMotionResponse(long);
    expect(prompt).toBeNull();
    expect(error).toContain("长度越界");
  });

  it("空响应 → null", () => {
    expect(parseMotionResponse("").prompt).toBeNull();
    expect(parseMotionResponse("   \n").prompt).toBeNull();
  });

  it("非字符串 → null", () => {
    expect(parseMotionResponse(undefined as unknown as string).prompt).toBeNull();
  });
});

// ============================================================================
// parseMotionFactsResponse（extractAndParseJson + safeParse + 手写容错）
// ============================================================================

describe("parseMotionFactsResponse", () => {
  it("```json 代码块含 record → parsed", () => {
    const raw = '```json\n{"record": "画面右侧有一位成年女性坐着，占画面约三分之一"}\n```';
    const { parsed, error } = parseMotionFactsResponse(raw);
    expect(error).toBeNull();
    expect(parsed?.record).toBe("画面右侧有一位成年女性坐着，占画面约三分之一");
  });

  it("裸 JSON 含 record → parsed", () => {
    const { parsed } = parseMotionFactsResponse(
      '{"record": "室内窗边，一只橘猫卧在椅子上，左侧有水杯"}',
    );
    expect(parsed?.record).toContain("橘猫");
  });

  it("纯文本（无 JSON）→ parsed null，fallback 把整段 trim 文本当 record（手写容错）", () => {
    const raw = "画面里有一位老人坐在院子中央的藤椅上，身后是木门与砖墙，右侧地面有水盆。";
    const { parsed, error, fallback } = parseMotionFactsResponse(raw);
    expect(parsed).toBeNull();
    expect(error).toBeTruthy();
    expect(fallback?.record).toBe(raw);
  });

  it("空响应 → parsed 与 fallback 均 null（上游按失败旁路）", () => {
    const r = parseMotionFactsResponse("   \n");
    expect(r.parsed).toBeNull();
    expect(r.fallback).toBeNull();
  });

  it("JSON 但 record 过短 → fallback 回退整段原始文本", () => {
    const raw = '{"record": "短"}';
    const { parsed, fallback } = parseMotionFactsResponse(raw);
    expect(parsed).toBeNull();
    expect(fallback?.record).toBe(raw);
  });
});

// ============================================================================
// prepareHeroJpeg（普通图分支：真实 sharp + local adapter）
// ============================================================================

describe("prepareHeroJpeg", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-gen-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("普通 PNG → JPEG base64（2048 内）", async () => {
    const sharp = (await import("sharp")).default;
    const src = path.join(tmpDir, "hero.png");
    await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#2288cc" } })
      .png()
      .toFile(src);
    const base64 = await prepareHeroJpeg(
      { mediaType: "image", filePath: src, thumbnailPath: null },
      createStorageAdapter("local"),
    );
    const decoded = Buffer.from(base64, "base64");
    const meta = await sharp(decoded).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeLessThanOrEqual(2048);
    expect(meta.height).toBeLessThanOrEqual(2048);
  });

  it("视频无 cover 缩略图 → throw", async () => {
    await expect(
      prepareHeroJpeg(
        { mediaType: "video", filePath: "/nope.mp4", thumbnailPath: null },
        createStorageAdapter("local"),
      ),
    ).rejects.toThrow("视频无 cover 缩略图");
  });
});

// ============================================================================
// generateHeroMotionPrompt（mock ai client / prompts / config）
// ============================================================================

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  analyzePhoto: vi.fn(),
  chatWithModel: vi.fn(),
  loadPrompts: vi.fn(),
}));

vi.mock("../ai/client", () => ({
  aiClient: {
    chat: mocks.chat,
    analyzePhoto: mocks.analyzePhoto,
    chatWithModel: mocks.chatWithModel,
  },
}));

vi.mock("../ai/prompts", () => ({
  loadPrompts: mocks.loadPrompts,
}));

vi.mock("../lib/config", () => ({
  config: {
    ai: {
      baseUrl: "http://127.0.0.1:8001/v1",
      apiKey: "qwen-local-key",
      visionModel: "qwen3.6-35b",
      model: "qwen3.6-35b",
      promptVersion: "v2",
      motionBaseUrl: "https://motion.example/v1",
      motionApiKey: "test-motion-key",
      motionModel: "test-motion-model",
    },
  },
}));

const MOTION_TEXT =
  "孩子举起小玩具晃了晃，母亲低头看着他笑，父亲双手在镜头前合拢比心。Audio: warm indoor ambience, no talking";

describe("generateHeroMotionPrompt（hero-only 两步链路，C6 调用次数）", () => {
  let heroPath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const sharp = (await import("sharp")).default;
    heroPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "motion-hero-")), "hero.png");
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#2288cc" } })
      .png()
      .toFile(heroPath);
  });

  afterAll(() => {
    fs.rmSync(path.dirname(heroPath), { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.loadPrompts.mockImplementation(async (_v: string, name: string) => ({
      system: `SYS(${name})`,
      user: name === "daily/motion" ? "facts: {facts}" : "请按上述要求记录这张照片。",
    }));
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  const input = () => ({
    photoId: "photo-hero",
    mediaType: "image",
    filePath: "",
    thumbnailPath: null,
    sourceType: "local",
  });

  it("成功：恰好 1 次 facts(vision) + 1 次 motion(外部模型)，C8 配置透传", async () => {
    mocks.analyzePhoto.mockResolvedValueOnce(
      '```json\n{"record": "画面中央一位女性抱着婴儿坐在沙发上，右侧有落地窗与纱帘"}\n```',
    );
    mocks.chatWithModel.mockResolvedValueOnce(MOTION_TEXT);

    const prompt = await generateHeroMotionPrompt({ ...input(), filePath: heroPath });

    expect(prompt).toBe(MOTION_TEXT);
    // C6：两步各恰好 1 次
    expect(mocks.analyzePhoto).toHaveBeenCalledTimes(1);
    expect(mocks.chatWithModel).toHaveBeenCalledTimes(1);
    // C8：motion 端点按 config.ai.motion* 透传
    const opts = mocks.chatWithModel.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts.model).toBe("test-motion-model");
    expect(opts.baseUrl).toBe("https://motion.example/v1");
    expect(opts.apiKey).toBe("test-motion-key");
    // facts 记录被注入 motion user prompt
    const motionUser = mocks.chatWithModel.mock.calls[0]?.[0] as string;
    expect(motionUser).toContain("落地窗与纱帘");
  });

  it("facts 步解析不出记录 → null + console.warn（含「运动描述」关键词），motion 步零调用", async () => {
    mocks.analyzePhoto.mockResolvedValueOnce("   ");
    const prompt = await generateHeroMotionPrompt({ ...input(), filePath: heroPath });
    expect(prompt).toBeNull();
    expect(mocks.chatWithModel).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("运动描述");
  });

  it("motion 步外部模型抛错 → null + console.warn（不 throw，C6 不写库语义）", async () => {
    mocks.analyzePhoto.mockResolvedValueOnce('{"record": "画面中央一位女性抱着婴儿坐在沙发上"}');
    mocks.chatWithModel.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const prompt = await generateHeroMotionPrompt({ ...input(), filePath: heroPath });
    expect(prompt).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("ECONNREFUSED");
  });

  it("motion 步输出越界 → null + console.warn", async () => {
    mocks.analyzePhoto.mockResolvedValueOnce('{"record": "画面中央一位女性抱着婴儿坐在沙发上"}');
    mocks.chatWithModel.mockResolvedValueOnce("太短");
    const prompt = await generateHeroMotionPrompt({ ...input(), filePath: heroPath });
    expect(prompt).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("运动描述");
  });

  it("AI_MOTION_API_KEY 未配置 → 直接旁路，零 AI 调用（C8 凭据预检）", async () => {
    const { config } = await import("../lib/config");
    const saved = config.ai.motionApiKey;
    (config.ai as { motionApiKey: string }).motionApiKey = "";
    try {
      const prompt = await generateHeroMotionPrompt({ ...input(), filePath: heroPath });
      expect(prompt).toBeNull();
      expect(mocks.analyzePhoto).not.toHaveBeenCalled();
      expect(mocks.chatWithModel).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("AI_MOTION_API_KEY");
    } finally {
      (config.ai as { motionApiKey: string }).motionApiKey = saved;
    }
  });
});

// ============================================================================
// attachHeroMotionPrompt（hero-only 转发 + 失败保持 undefined）
// ============================================================================

describe("attachHeroMotionPrompt", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.doUnmock("../lib/motion/generate");
    vi.doUnmock("../db");
  });

  /**
   * 以 12 条候选规模驱动 attach：hero（candidates[0]）只触发一次生成调用。
   * mock ../db 隔离真实 SQLite（daily-selection 模块图 import 面），mock 生成函数观测触发。
   */
  async function runAttach(candidateCount: number, genImpl: () => Promise<string | null>) {
    vi.doMock("../db", () => ({ db: {}, schema: {} }));
    vi.doMock("../lib/motion/generate", () => ({
      generateHeroMotionPrompt: vi.fn(genImpl),
      prepareHeroJpeg: vi.fn(),
    }));
    const { attachHeroMotionPrompt } = await import("../jobs/daily-selection");
    const hero = {
      photoId: "photo-0",
      mediaType: "image",
      filePath: "/photos/0.jpg",
      thumbnailPath: null,
      sourceType: "local",
    } as never;
    const rest = Array.from({ length: candidateCount - 1 }, (_, i) => ({
      photoId: `photo-${i + 1}`,
    })) as never[];
    const primary = {
      rank: 0,
      photoId: "photo-0",
      title: "",
      narrative: "",
      score: 5,
      members: [] as { photoId: string; caption: string }[],
      motionPrompt: undefined as string | undefined,
    };
    await attachHeroMotionPrompt(hero, primary, () => {});
    const mod = await import("../lib/motion/generate");
    return { primary, hero, rest, gen: vi.mocked(mod.generateHeroMotionPrompt) };
  }

  it("12 条 entry 只触发 1 次 hero 生成（C6 仅 hero），成功写入 primary.motionPrompt", async () => {
    const { primary, gen } = await runAttach(12, async () => "一阵风吹过。Audio: wind, no talking");
    expect(gen).toHaveBeenCalledTimes(1);
    expect(gen.mock.calls[0]?.[0]?.photoId).toBe("photo-0");
    expect(primary.motionPrompt).toBe("一阵风吹过。Audio: wind, no talking");
  });

  it("生成失败（null）→ primary.motionPrompt 保持 undefined（落库 null，C6 不写库）", async () => {
    const { primary, gen } = await runAttach(12, async () => null);
    expect(gen).toHaveBeenCalledTimes(1);
    expect(primary.motionPrompt).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("生成抛异常 → 吞掉不 throw + console.warn 落 stdout，motionPrompt 保持 undefined", async () => {
    const { primary, gen } = await runAttach(12, async () => {
      throw new Error("boom-motion");
    });
    expect(gen).toHaveBeenCalledTimes(1);
    expect(primary.motionPrompt).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("boom-motion");
  });
});

/**
 * 验收测试：AI Client 参数与行为
 *
 * 覆盖设计文档：
 * - analyzePhoto() 升级为 4 参数签名: (base64, mimeType, systemPrompt, userPrompt)
 * - system prompt 通过 role: "system" 独立发送
 * - temperature: 0.3, top_p: 0.9
 * - response_format: { type: "json_object" } 和 seed: 42 在首次调用中
 * - 首次调用失败时不带 response_format 和 seed 进行回退
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---- Mock OpenAI (必须使用 vi.hoisted 因为 vi.mock 会被提升) ----

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  })),
}));

// ---- Mock config ----

vi.mock("../lib/config", () => ({
  config: {
    ai: {
      baseUrl: "http://test.local/v1",
      apiKey: "test-api-key",
      visionModel: "test-vision-model",
      model: "test-model",
      promptVersion: "v2",
    },
  },
}));

import { RelightAIClient } from "../ai/client";

// ---- 测试 ----

describe("AI Client 参数与行为 — 验收测试", () => {
  let client: RelightAIClient;

  beforeEach(() => {
    mockCreate.mockReset();
    client = new RelightAIClient();
  });

  describe("analyzePhoto 四参数签名", () => {
    it("analyzePhoto 应接受 4 个参数: base64, mimeType, systemPrompt, userPrompt", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{"result": "ok"}' } }],
      });

      // 调用时传入 4 个参数 — 不应抛出参数数量错误
      await client.analyzePhoto(
        "iVBORw0KGgo", // base64
        "image/jpeg", // mimeType
        "You are an expert photo analyst.", // systemPrompt
        "请分析这张照片的构图与色彩。", // userPrompt
      );

      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("systemPrompt 应通过 role: 'system' 独立发送", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });

      await client.analyzePhoto(
        "base64data",
        "image/png",
        "System instruction here",
        "User question here",
      );

      const callArgs = mockCreate.mock.calls[0]![0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const { messages } = callArgs;

      // 应包含 system 消息
      const systemMessage = messages.find((m: { role: string }) => m.role === "system");
      expect(systemMessage).toBeDefined();
      expect(systemMessage!.content).toBe("System instruction here");

      // 应包含 user 消息
      const userMessage = messages.find((m: { role: string }) => m.role === "user");
      expect(userMessage).toBeDefined();
    });

    it("user 消息应包含图片 URL 和文本内容", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });

      await client.analyzePhoto("Zm9v", "image/webp", "system", "分析这张照片");

      const callArgs = mockCreate.mock.calls[0]![0] as {
        messages: Array<{
          role: string;
          content: Array<{ type: string; image_url?: { url: string }; text?: string }>;
        }>;
      };
      const userMessage = callArgs.messages.find(
        (m: { role: string }) => m.role === "user",
      );
      expect(userMessage).toBeDefined();

      const userContent = userMessage!.content;
      expect(userContent).toBeInstanceOf(Array);

      // 应包含 image_url 类型
      const imagePart = userContent.find(
        (p: { type: string }) => p.type === "image_url",
      );
      expect(imagePart).toBeDefined();
      expect(imagePart!.image_url!.url).toBe("data:image/webp;base64,Zm9v");

      // 应包含 text 类型
      const textPart = userContent.find(
        (p: { type: string }) => p.type === "text",
      );
      expect(textPart).toBeDefined();
      expect(textPart!.text).toBe("分析这张照片");
    });
  });

  describe("temperature 和 top_p 参数", () => {
    it("API 调用应包含 temperature: 0.3", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });

      await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      const callArgs = mockCreate.mock.calls[0]![0] as { temperature: number };
      expect(callArgs.temperature).toBe(0.3);
    });

    it("API 调用应包含 top_p: 0.9", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });

      await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      const callArgs = mockCreate.mock.calls[0]![0] as { top_p: number };
      expect(callArgs.top_p).toBe(0.9);
    });
  });

  describe("response_format 和 seed", () => {
    it("首次调用应包含 response_format: { type: 'json_object' }", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{"score": 8}' } }],
      });

      await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      const callArgs = mockCreate.mock.calls[0]![0] as {
        response_format: { type: string };
      };
      expect(callArgs.response_format).toEqual({ type: "json_object" });
    });

    it("首次调用应包含 seed: 42", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });

      await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      const callArgs = mockCreate.mock.calls[0]![0] as { seed: number };
      expect(callArgs.seed).toBe(42);
    });
  });

  describe("回退逻辑（fallback on error）", () => {
    it("首次调用失败时应进行第二次调用（不带 response_format 和 seed）", async () => {
      // 第一次调用失败
      mockCreate.mockRejectedValueOnce(new Error("API does not support json_object"));
      // 第二次调用成功
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: '{"score": 7}' } }],
      });

      const result = await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      // 应调用了两次
      expect(mockCreate).toHaveBeenCalledTimes(2);
      // 应返回内容
      expect(result).toBe('{"score": 7}');
    });

    it("回退调用不应包含 response_format 字段", async () => {
      mockCreate.mockRejectedValueOnce(new Error("Bad request"));
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: '{"result": "fallback"}' } }],
      });

      await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      const fallbackArgs = mockCreate.mock.calls[1]![0] as {
        response_format?: unknown;
      };
      expect(fallbackArgs.response_format).toBeUndefined();
    });

    it("回退调用不应包含 seed 字段", async () => {
      mockCreate.mockRejectedValueOnce(new Error("Bad request"));
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: '{"result": "fallback"}' } }],
      });

      await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      const fallbackArgs = mockCreate.mock.calls[1]![0] as { seed?: number };
      expect(fallbackArgs.seed).toBeUndefined();
    });

    it("回退调用仍应包含 temperature 和 top_p", async () => {
      mockCreate.mockRejectedValueOnce(new Error("Bad request"));
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "{}" } }],
      });

      await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      const fallbackArgs = mockCreate.mock.calls[1]![0] as {
        temperature: number;
        top_p: number;
      };
      expect(fallbackArgs.temperature).toBe(0.3);
      expect(fallbackArgs.top_p).toBe(0.9);
    });

    it("回退调用仍应使用相同的 model（config.ai.visionModel）", async () => {
      mockCreate.mockRejectedValueOnce(new Error("Bad request"));
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "{}" } }],
      });

      await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      const fallbackArgs = mockCreate.mock.calls[1]![0] as { model: string };
      expect(fallbackArgs.model).toBe("test-vision-model");
    });
  });

  describe("返回值", () => {
    it("应返回 message.content 字符串", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{"tags":[],"narrative":"test"}' } }],
      });

      const result = await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      expect(typeof result).toBe("string");
      expect(result).toBe('{"tags":[],"narrative":"test"}');
    });

    it("content 为空时应回退到 reasoning_content", async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: "",
              reasoning_content: '{"from_reasoning": true}',
            },
          },
        ],
      });

      const result = await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      expect(result).toBe('{"from_reasoning": true}');
    });
  });

  describe("model 参数", () => {
    it("应使用 config.ai.visionModel 而非 process.env.AI_VISION_MODEL", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });

      await client.analyzePhoto("data", "image/jpeg", "sys", "usr");

      const callArgs = mockCreate.mock.calls[0]![0] as { model: string };
      // 应使用我们 mock 的 config.ai.visionModel = "test-vision-model"
      expect(callArgs.model).toBe("test-vision-model");
    });
  });
});

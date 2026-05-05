import OpenAI from "openai";
import { config } from "../lib/config";

const client = new OpenAI({
  baseURL: config.ai.baseUrl,
  apiKey: config.ai.apiKey,
  timeout: 120000,
  maxRetries: 0,
});

export class RelightAIClient {
  /**
   * 分析照片（视觉模型）
   * @param imageBase64 base64 编码的图片
   * @param mimeType 图片 MIME 类型
   * @param systemPrompt 系统提示词
   * @param userPrompt 用户提示词
   */
  async analyzePhoto(
    imageBase64: string,
    mimeType: string,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${imageBase64}`,
            },
          },
          {
            type: "text",
            text: userPrompt,
          },
        ],
      },
    ];

    // qwen3.6 是推理模型，默认输出到 reasoning_content 而非 content
    // 禁用思考模式以确保 JSON 输出在 content 字段
    const baseParams = {
      model: config.ai.visionModel,
      messages,
      max_tokens: 1024,
      temperature: 0.3,
      top_p: 0.9,
      chat_template_kwargs: { enable_thinking: false } as const,
    };

    // 首次尝试带 response_format 和 seed
    try {
      const response = await client.chat.completions.create({
        ...baseParams,
        response_format: { type: "json_object" },
        seed: 42,
      });
      const msg = response.choices[0]?.message;
      return msg?.content || (msg as unknown as Record<string, string>).reasoning_content || "";
    } catch {
      // 降级：去掉 response_format 和 seed 重试
      const response = await client.chat.completions.create(baseParams);
      const msg = response.choices[0]?.message;
      return msg?.content || (msg as unknown as Record<string, string>).reasoning_content || "";
    }
  }

  /**
   * 文本对话（文本模型）
   */
  async chat(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await client.chat.completions.create({
      model: config.ai.model,
      messages,
      max_tokens: 4096,
      // @ts-expect-error qwen3 chat template extension
      chat_template_kwargs: { enable_thinking: false } as Record<string, unknown>,
    });

    const msg = response.choices[0]?.message;
    return msg?.content || (msg as unknown as Record<string, string>).reasoning_content || "";
  }
}

export const aiClient = new RelightAIClient();

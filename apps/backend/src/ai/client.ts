import OpenAI from "openai";
import { config } from "../lib/config";

const client = new OpenAI({
  baseURL: config.ai.baseUrl,
  apiKey: config.ai.apiKey,
});

export class RelightAIClient {
  /**
   * 分析照片（视觉模型）
   * @param imageBase64 base64 编码的图片
   * @param mimeType 图片 MIME 类型
   * @param prompt 分析提示词
   */
  async analyzePhoto(imageBase64: string, mimeType: string, prompt: string): Promise<string> {
    const response = await client.chat.completions.create({
      model: config.ai.visionModel,
      messages: [
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
              text: prompt,
            },
          ],
        },
      ],
      max_tokens: 1024,
    });

    return response.choices[0]?.message?.content ?? "";
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
      max_tokens: 2048,
    });

    return response.choices[0]?.message?.content ?? "";
  }
}

export const aiClient = new RelightAIClient();

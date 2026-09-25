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
    // max_tokens=4096：视觉分析 JSON 含 narrative+tags+composition+colorAnalysis+emotional 等
    // 复合输出体量 1500-2500 tokens，1024 偏紧会让输出收敛太早（参考 smart-trim 同因 fix
    // 详见 vlog/.autopilot/decisions.md "Qwen smart-trim maxTokens 配置" 条目）。
    const baseParams = {
      model: config.ai.visionModel,
      messages,
      max_tokens: 4096,
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
  async chat(
    prompt: string,
    systemPrompt?: string,
    options?: { maxTokens?: number },
  ): Promise<string> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await client.chat.completions.create({
      model: config.ai.model,
      messages,
      max_tokens: options?.maxTokens ?? 4096,
      // @ts-expect-error qwen3 chat template extension
      chat_template_kwargs: { enable_thinking: false } as Record<string, unknown>,
    });

    const msg = response.choices[0]?.message;
    return msg?.content || (msg as unknown as Record<string, string>).reasoning_content || "";
  }

  /**
   * 文本对话——per-call 覆盖 model/baseUrl/apiKey（2026-09-25 新增：运动描述专用外部
   * 文本模型通路，见 lib/motion/generate.ts）。
   *
   * thinking 参数按 provider 条件化（勿照搬 chat()）：`chat_template_kwargs:
   * {enable_thinking:false}` 是 qwen/llama.cpp 方言，deepseek 等云端 OpenAI 兼容端点
   * 不认（2026-09-25 冒烟：api.deepseek.com/v1 的 deepseek-chat 直出纯文本，无需该参数）。
   * 规则：仅当目标 baseUrl 指向本地服务（127.0.0.1/localhost/[::1]）时才注入该方言参数。
   */
  async chatWithModel(
    prompt: string,
    systemPrompt: string | undefined,
    options: { model: string; baseUrl: string; apiKey: string; maxTokens?: number },
  ): Promise<string> {
    const target = new OpenAI({
      baseURL: options.baseUrl,
      apiKey: options.apiKey,
      timeout: 120000,
      maxRetries: 0,
    });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const isLocalDialect = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(
      options.baseUrl,
    );
    const response = await target.chat.completions.create({
      model: options.model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      // qwen3 chat template extension（仅本地 qwen 方言端点需要）
      ...(isLocalDialect
        ? { chat_template_kwargs: { enable_thinking: false } as Record<string, unknown> }
        : {}),
    });

    const msg = response.choices[0]?.message;
    return msg?.content || "";
  }
}

export const aiClient = new RelightAIClient();

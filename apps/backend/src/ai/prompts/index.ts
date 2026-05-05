import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PromptSet {
  system: string;
  user: string;
}

/** 内存缓存（Promise 级别），避免并发请求时重复读取磁盘 */
const cache = new Map<string, Promise<PromptSet>>();

/**
 * 加载指定版本的 Prompt 文件
 * @param version Prompt 版本号，默认 "v1"（调用方应通过 config.ai.promptVersion 显式传入）
 * @param name 可选子目录路径，如 "daily/select" 或 "daily/narrate"，用于加载多级目录下的 prompt
 */
export async function loadPrompts(version = "v1", name?: string): Promise<PromptSet> {
  const cacheKey = name ? `${version}/${name}` : version;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const dir = name ? path.join(__dirname, version, name) : path.join(__dirname, version);

  const promise = (async (): Promise<PromptSet> => {
    const [system, user] = await Promise.all([
      fs.readFile(path.join(dir, "system.txt"), "utf-8"),
      fs.readFile(path.join(dir, "user.txt"), "utf-8"),
    ]);
    return { system, user };
  })();

  cache.set(cacheKey, promise);
  return promise;
}

/**
 * 合并 System + User Prompt，返回适合旧版 AI client 使用的完整 prompt
 * @deprecated 新代码应使用 loadPrompts() 获取分离的 system/user，通过 analyzePhoto 的独立参数传递
 */
export async function buildPrompt(version?: string): Promise<string> {
  const prompts = await loadPrompts(version);
  return `${prompts.system}\n\n---\n\n${prompts.user}`;
}

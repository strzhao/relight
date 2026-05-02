import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PromptSet {
  system: string;
  user: string;
}

/**
 * 加载指定版本的 Prompt 文件
 * @param version Prompt 版本号，默认 "v1"
 */
export async function loadPrompts(version = "v1"): Promise<PromptSet> {
  const dir = path.join(__dirname, version);

  const [system, user] = await Promise.all([
    fs.readFile(path.join(dir, "system.txt"), "utf-8"),
    fs.readFile(path.join(dir, "user.txt"), "utf-8"),
  ]);

  return { system, user };
}

/**
 * 合并 System + User Prompt，返回适合 AI client 使用的完整 prompt
 */
export async function buildPrompt(version?: string): Promise<string> {
  const prompts = await loadPrompts(version);
  return `${prompts.system}\n\n---\n\n${prompts.user}`;
}

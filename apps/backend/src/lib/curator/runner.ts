/**
 * 策展人 spawn runner——spawn `claude -p`（纯文本提案，非交互）。
 *
 * 与 claude-runner.ts（视频渲染 spawn）的差异：无产物文件契约、无 skill 前置校验、
 * 超时短（config.curatorTimeoutMs 默认 15min，纯文本 claude run 实测 ~2-10min）、
 * 产物是 stdout 里的 JSON 数组。
 *
 * 解析策略：stdout 取首 "[" 到末 "]" 切片 JSON.parse → Zod 校验（response-parser
 * 的多策略修复在这不适用——策展输出是单个数组，不存在多个 json 块歧义）。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { loadPrompts } from "../../ai/prompts";
import { config } from "../config";
import type { CuratorPrep } from "./prep";
import { type CuratorProposal, curatorOutputSchema } from "./schema";

const DEFAULT_CURATOR_TIMEOUT_MS = 900_000;

function curatorTimeoutMs(): number {
  const v = config.curatorTimeoutMs;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CURATOR_TIMEOUT_MS;
}

export interface CuratorRunResult {
  ok: boolean;
  proposals?: CuratorProposal[];
  err?: string;
}

/** 构造策展 prompt：system + user + 备料 JSON（与 loadPrompts 缓存键 v2/curator/discover 对应） */
export async function buildCuratorPrompt(prep: CuratorPrep): Promise<string> {
  const { system, user } = await loadPrompts("v2", "curator/discover");
  return `${system}\n\n${user}\n\n${JSON.stringify(prep, null, 1)}`;
}

/** spawn claude -p 跑策展提案。失败返回 {ok:false, err}，不抛异常。 */
export async function runCuratorDiscovery(prep: CuratorPrep): Promise<CuratorRunResult> {
  if (!config.claudeCliPath) {
    return { ok: false, err: "config.claudeCliPath 为空（claude 未安装且未设 CLAUDE_CLI_PATH）" };
  }

  const prompt = await buildCuratorPrompt(prep);
  const timeoutMs = curatorTimeoutMs();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let stdout = "";
  let stderr = "";
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const proc = spawn(config.claudeCliPath, ["-p", prompt], {
        cwd: config.videoWorkspacePath,
        env: {
          ...process.env,
          HOME: homedir(),
          PATH: process.env.PATH ?? "",
        },
        signal: ac.signal,
        killSignal: "SIGTERM",
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => resolve(code ?? -1));
    });

    if (exitCode !== 0) {
      return {
        ok: false,
        err: `claude -p 退出码 ${exitCode}（stderr=${stderr.slice(-500) || "（空）"} | stdout=${stdout.slice(-2000) || "（空）"}）`,
      };
    }

    // 从 stdout 提取 JSON 数组（容忍模型在数组外遗留少量文字）
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    if (start < 0 || end <= start) {
      return {
        ok: false,
        err: `策展输出无 JSON 数组（stdout=${stdout.slice(-1000) || "（空）"}）`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.slice(start, end + 1));
    } catch (e) {
      return {
        ok: false,
        err: `策展输出 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}（raw=${stdout.slice(start, Math.min(start + 500, end + 1))}…）`,
      };
    }

    const result = curatorOutputSchema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        err: `策展输出 Zod 校验失败: ${result.error.message.slice(0, 500)}`,
      };
    }
    return { ok: true, proposals: result.data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, err: ac.signal.aborted ? `策展 spawn 超时（${timeoutMs}ms）` : msg };
  } finally {
    clearTimeout(timer);
  }
}

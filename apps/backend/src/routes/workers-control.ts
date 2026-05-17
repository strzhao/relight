import { spawn } from "node:child_process";
import { Hono } from "hono";
import { config } from "../lib/config";

type Action = "start" | "stop" | "reload";

async function runPnpm(action: Action): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", [`workers:${action}`], {
      cwd: config.repoRoot,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      // spawn 失败（如 ENOENT pnpm 不在 PATH）：友好提示，引导排查
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "\n[hint] 未找到 pnpm 二进制。请检查 PATH 是否包含 pnpm 安装目录（macOS 通常为 /opt/homebrew/bin）。PM2 化部署需在 ecosystem env 中显式注入 PATH。"
          : "";
      resolve({
        stdout,
        stderr: `${stderr}${err.message}${hint}`,
        exitCode: -1,
      });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

function makeHandler(action: Action) {
  return async (c: import("hono").Context) => {
    const result = await runPnpm(action);
    const success = result.exitCode === 0;
    return c.json({ success, ...result }, success ? 200 : 500);
  };
}

export const workersControlRouter = new Hono()
  .post("/start", makeHandler("start"))
  .post("/stop", makeHandler("stop"))
  .post("/reload", makeHandler("reload"));

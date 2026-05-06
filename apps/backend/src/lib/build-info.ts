import { execSync } from "node:child_process";

/** 安全执行 git 命令，失败时返回 "unknown" */
function tryGit(args: string): string {
  try {
    return execSync(`git ${args}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "unknown";
  }
}

/** 构建信息（模块加载时同步读取，结果缓存为常量） */
export const buildInfo = {
  /** git short commit hash，不可用时为 "unknown" */
  commit: tryGit("rev-parse --short HEAD"),
  /** git commit ISO 时间，不可用时为 "unknown" */
  commitTime: tryGit("log -1 --format=%cI"),
} as const;

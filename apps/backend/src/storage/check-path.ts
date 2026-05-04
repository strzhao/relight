import * as fs from "node:fs";
import type { StorageSourceStatus } from "@relight/shared";

/** 可达性检查结果 */
export interface PathCheckResult {
  status: StorageSourceStatus;
  lastError: string | null;
}

/**
 * 检查存储源根路径的可达性。
 *
 * 逻辑：
 * 1. 路径为空 → "inaccessible"，消息 "路径为空"
 * 2. fs.lstat（不跟随软链接）+ fs.access 组合判断：
 *    - lstat ENOENT → "inaccessible"，消息 "目录不存在"
 *    - lstat ENOTDIR → "inaccessible"，消息 "路径不是目录"
 *    - 链接断链（lstat 成功但 realpath 失败）→ "unmounted"，消息 "软链接目标不存在，可能未挂载"
 *    - EACCES / EPERM → "permission_denied"，消息 "权限不足，无法读取"
 *    - 通过 access(R_OK) → "healthy"
 * 3. 3s 超时保护
 */
export async function checkPathAccessibility(rootPath: string): Promise<PathCheckResult> {
  // 防御：空路径
  if (!rootPath || rootPath.trim() === "") {
    return { status: "inaccessible", lastError: "路径为空" };
  }

  try {
    await withTimeout(checkPath(rootPath), 3000);
    return { status: "healthy", lastError: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // 超时
    if (message === "PATH_CHECK_TIMEOUT") {
      return { status: "inaccessible", lastError: "检查超时" };
    }

    // 分类错误
    if (message.startsWith("UNMOUNTED:")) {
      return { status: "unmounted", lastError: "软链接目标不存在，可能未挂载" };
    }
    if (message === "NOT_DIRECTORY") {
      return { status: "inaccessible", lastError: "路径不是目录" };
    }
    if (message.startsWith("ENOENT:")) {
      return { status: "inaccessible", lastError: "目录不存在" };
    }
    if (message.startsWith("EACCES:") || message.startsWith("EPERM:")) {
      return { status: "permission_denied", lastError: "权限不足，无法读取" };
    }

    // 兜底
    return { status: "inaccessible", lastError: message };
  }
}

/**
 * 核心检查逻辑：
 * 1. fs.lstat（不跟随软链接，判断文件类型和软链接状态）
 * 2. 对软链接，检查目标是否存在（通过 realpath）
 * 3. fs.access 检查读权限
 */
async function checkPath(rootPath: string): Promise<void> {
  // Step 1: lstat（不跟随软链接）
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(rootPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`ENOENT:${rootPath}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`${code}:${rootPath}`);
    }
    if (code === "ENOTDIR") {
      throw new Error("NOT_DIRECTORY");
    }
    throw err;
  }

  // Step 2: 对软链接，检查目标是否存在
  if (stat.isSymbolicLink()) {
    try {
      fs.realpathSync(rootPath);
    } catch {
      throw new Error(`UNMOUNTED:${rootPath}`);
    }
  }

  // Step 3: 检查是否为目录（对非软链接，lstat 已判断；对软链接，需要 stat）
  let targetStat: fs.Stats = stat;
  if (stat.isSymbolicLink()) {
    try {
      targetStat = fs.statSync(rootPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`UNMOUNTED:${rootPath}`);
      }
      if (code === "EACCES" || code === "EPERM") {
        throw new Error(`${code}:${rootPath}`);
      }
      throw err;
    }
  }

  if (!targetStat.isDirectory()) {
    throw new Error("NOT_DIRECTORY");
  }

  // Step 4: 检查读权限
  await fs.promises.access(rootPath, fs.constants.R_OK);
}

/** Promise 超时包装 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("PATH_CHECK_TIMEOUT")), ms)),
  ]);
}

/**
 * check-path 工具测试
 *
 * 覆盖场景：
 * - healthy: 正常可访问目录
 * - inaccessible (ENOENT): 不存在的路径
 * - unmounted: 软链接目标不存在
 * - permission_denied: 权限不足
 * - 空字符串防御
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPathAccessibility } from "../check-path";

describe("checkPathAccessibility", () => {
  const tempRoot = path.join(os.tmpdir(), `relight-check-path-test-${Date.now()}`);
  // 创建测试用的临时目录结构
  const healthyDir = path.join(tempRoot, "healthy");
  fs.mkdirSync(healthyDir, { recursive: true });

  // 一个临时文件（非目录，用于 not-a-directory 测试）
  const emptyFile = path.join(tempRoot, "file.txt");
  fs.writeFileSync(emptyFile, "not a directory", "utf-8");

  // 软链接目标目录
  const symlinkTarget = path.join(tempRoot, "link-target");
  fs.mkdirSync(symlinkTarget, { recursive: true });

  // 一个将被删除的目录
  const removedDir = path.join(tempRoot, "removed");
  fs.mkdirSync(removedDir, { recursive: true });
  fs.rmdirSync(removedDir);

  afterEach(() => {
    // 清理断链软链接（如果存在）
    const brokenLinkPath = path.join(tempRoot, "broken-link");
    try {
      const _stat = fs.lstatSync(brokenLinkPath);
      fs.unlinkSync(brokenLinkPath);
    } catch {
      // 不存在，忽略
    }
  });

  it("healthy: 可访问目录返回 healthy", async () => {
    const result = await checkPathAccessibility(healthyDir);
    expect(result.status).toBe("healthy");
    expect(result.lastError).toBeNull();
  });

  it("inaccessible (ENOENT): 不存在的路径返回 inaccessible", async () => {
    const result = await checkPathAccessibility(removedDir);
    expect(result.status).toBe("inaccessible");
    expect(result.lastError).toBe("目录不存在");
  });

  it("unmounted: 软链接目标不存在", async () => {
    const brokenLinkPath = path.join(tempRoot, "broken-link");
    const nonExistentTarget = path.join(tempRoot, "non-existent-target");
    fs.symlinkSync(nonExistentTarget, brokenLinkPath);

    const result = await checkPathAccessibility(brokenLinkPath);
    expect(result.status).toBe("unmounted");
    expect(result.lastError).toBe("软链接目标不存在，可能未挂载");
  });

  it("权限不足返回 permission_denied（目录无读权限）", async () => {
    // macOS 上 root 用户可能仍能访问，仅对非 root 用户有效
    const noAccessDir = path.join(tempRoot, "no-access");
    fs.mkdirSync(noAccessDir, { recursive: true });

    try {
      // 移除所有权限
      fs.chmodSync(noAccessDir, 0o000);

      const result = await checkPathAccessibility(noAccessDir);

      // 如果是 root，可能仍能通过，此时结果为 healthy
      // 非 root 应返回 permission_denied
      if (process.getuid?.() === 0) {
        // root user: can't deny access, test still valid — just skip assertion
        expect(["healthy", "permission_denied"]).toContain(result.status);
      } else {
        expect(result.status).toBe("permission_denied");
        expect(result.lastError).toBe("权限不足，无法读取");
      }
    } finally {
      // 恢复权限以便清理
      try {
        fs.chmodSync(noAccessDir, 0o755);
      } catch {
        // 忽略
      }
    }
  });

  it("空字符串返回 inaccessible（路径为空）", async () => {
    const result = await checkPathAccessibility("");
    expect(result.status).toBe("inaccessible");
    expect(result.lastError).toBe("路径为空");
  });

  it("空字符串（空白）返回 inaccessible（路径为空）", async () => {
    const result = await checkPathAccessibility("   ");
    expect(result.status).toBe("inaccessible");
    expect(result.lastError).toBe("路径为空");
  });

  it("路径不是目录返回 inaccessible", async () => {
    const result = await checkPathAccessibility(emptyFile);
    expect(result.status).toBe("inaccessible");
    expect(result.lastError).toBe("路径不是目录");
  });

  it("软链接指向有效目录返回 healthy", async () => {
    const goodLinkPath = path.join(tempRoot, "good-link");
    fs.symlinkSync(symlinkTarget, goodLinkPath);

    try {
      const result = await checkPathAccessibility(goodLinkPath);
      expect(result.status).toBe("healthy");
      expect(result.lastError).toBeNull();
    } finally {
      fs.unlinkSync(goodLinkPath);
    }
  });
});

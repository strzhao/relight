/**
 * 验收测试：worktree 自动化环境配置
 *
 * 覆盖设计文档（红队视角，不读实现代码）：
 *
 * 用例 1: sync 脚本在主仓库中 silent exit（不修改任何文件）
 * 用例 2: 新建 worktree 后 .env 文件齐全且端口符合算法
 * 用例 3: 数据路径用绝对路径指向主仓库
 * 用例 4: AUTO-MANAGED 标记保护用户手动维护的文件
 * 用例 5: BullMQ prefix 跨进程一致（通过 .env 读取验证）
 * 用例 6: 跳过（next.config.ts 动态 port 由 QA 阶段真实启动验证）
 * 用例 7: 端口落在 4001-4999 区段（防 collision 主仓库 :3000）
 * 用例 8: 根 package.json 暴露 postinstall 与 worktree:setup 入口
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** 主仓库根目录（绝对路径） */
const REPO_ROOT = path.resolve(__dirname, "../../../../");

/** sync 脚本路径（相对主仓库根） */
const SYNC_SCRIPT = "scripts/sync-worktree-env.mjs";

/** 测试用 worktree 的分支名 */
const TEST_BRANCH = "worktree-redtest-1";

/** 测试用 worktree 的落地路径 */
const WORKTREE_PATH = path.join(os.tmpdir(), "relight-redtest-1");

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：端口计算算法（与设计文档保持一致，红队独立实现用于断言）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 根据分支名哈希派生后端端口。
 * 算法与设计文档完全一致：
 *   let h = 0;
 *   for (let i = 0; i < branch.length; i++) h = (h * 31 + branch.charCodeAt(i)) >>> 0;
 *   return 4001 + (h % 999);
 */
function computePort(branch: string): number {
  let h = 0;
  for (let i = 0; i < branch.length; i++) {
    h = (h * 31 + branch.charCodeAt(i)) >>> 0;
  }
  return 4001 + (h % 999);
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：解析 .env / .env.local 文件为 key-value Map
// ─────────────────────────────────────────────────────────────────────────────

function parseEnvFile(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    result[key] = val;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：运行 sync 脚本（在指定目录下）
// ─────────────────────────────────────────────────────────────────────────────

function runSyncScript(cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const scriptAbsPath = path.join(REPO_ROOT, SYNC_SCRIPT);
  const result = spawnSync(process.execPath, [scriptAbsPath], {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// worktree 生命周期（beforeAll / afterAll）
// ─────────────────────────────────────────────────────────────────────────────

/** 标记 worktree 是否已成功创建，用于 afterAll 安全清理 */
let worktreeCreated = false;

beforeAll(() => {
  // 如果上次测试残留了同名 worktree，先强制删除
  try {
    execSync(`git -C "${REPO_ROOT}" worktree remove --force "${WORKTREE_PATH}"`, {
      stdio: "ignore",
    });
  } catch {
    // 忽略——不存在时正常
  }

  // 删除可能残留的本地分支
  try {
    execSync(`git -C "${REPO_ROOT}" branch -D "${TEST_BRANCH}"`, { stdio: "ignore" });
  } catch {
    // 忽略
  }

  // 如果目标目录还在（孤立目录），一并删除
  if (fs.existsSync(WORKTREE_PATH)) {
    fs.rmSync(WORKTREE_PATH, { recursive: true, force: true });
  }

  // 创建 worktree（从当前 HEAD 创建新分支）
  execSync(`git -C "${REPO_ROOT}" worktree add -b "${TEST_BRANCH}" "${WORKTREE_PATH}"`, {
    stdio: "pipe",
  });
  worktreeCreated = true;
}, 60_000);

afterAll(() => {
  // 不管测试成功与否，都要清理，防止 worktree 泄漏
  if (worktreeCreated) {
    try {
      execSync(`git -C "${REPO_ROOT}" worktree remove --force "${WORKTREE_PATH}"`, {
        stdio: "ignore",
      });
    } catch {
      // 最后兜底：直接删目录
      try {
        fs.rmSync(WORKTREE_PATH, { recursive: true, force: true });
      } catch {
        // 忽略
      }
    }

    // 清理测试分支
    try {
      execSync(`git -C "${REPO_ROOT}" branch -D "${TEST_BRANCH}"`, { stdio: "ignore" });
    } catch {
      // 忽略
    }
  }
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// 用例 1: sync 脚本在主仓库中 silent exit
// ─────────────────────────────────────────────────────────────────────────────

describe("用例 1: sync 脚本在主仓库中 silent exit", () => {
  it("在主仓库根跑 sync 脚本，exit 0 且不生成任何 env 文件", { timeout: 30_000 }, () => {
    // 记录执行前的文件状态
    const backendEnvPath = path.join(REPO_ROOT, "apps/backend/.env");
    const webEnvPath = path.join(REPO_ROOT, "apps/web/.env.local");

    const backendEnvExistedBefore = fs.existsSync(backendEnvPath);
    const webEnvExistedBefore = fs.existsSync(webEnvPath);

    // 如果文件本来就不存在，记录一下；如果存在，记录 mtime
    const backendMtimeBefore = backendEnvExistedBefore ? fs.statSync(backendEnvPath).mtimeMs : null;
    const webMtimeBefore = webEnvExistedBefore ? fs.statSync(webEnvPath).mtimeMs : null;

    const { exitCode } = runSyncScript(REPO_ROOT);

    // 必须 exit 0
    expect(exitCode, "sync 脚本在主仓库运行应 exit 0").toBe(0);

    // .env 文件状态不变：本来不存在就还是不存在，本来存在则 mtime 不变
    if (!backendEnvExistedBefore) {
      expect(
        fs.existsSync(backendEnvPath),
        "主仓库 apps/backend/.env 本来不存在，sync 后不应被创建",
      ).toBe(false);
    } else {
      const backendMtimeAfter = fs.statSync(backendEnvPath).mtimeMs;
      expect(
        backendMtimeAfter,
        "主仓库 apps/backend/.env 已存在，sync 后不应被修改（mtime 不变）",
      ).toBe(backendMtimeBefore);
    }

    if (!webEnvExistedBefore) {
      expect(
        fs.existsSync(webEnvPath),
        "主仓库 apps/web/.env.local 本来不存在，sync 后不应被创建",
      ).toBe(false);
    } else {
      const webMtimeAfter = fs.statSync(webEnvPath).mtimeMs;
      expect(
        webMtimeAfter,
        "主仓库 apps/web/.env.local 已存在，sync 后不应被修改（mtime 不变）",
      ).toBe(webMtimeBefore);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 用例 2 + 3 + 5 + 7: 新建 worktree 后 env 文件齐全 + 端口算法 + 数据路径 + 端口区段
// （合并 beforeAll 中已创建的 worktree，避免重复创建）
// ─────────────────────────────────────────────────────────────────────────────

describe("用例 2/3/5/7: worktree env 文件正确性验证", () => {
  const backendEnvPath = () => path.join(WORKTREE_PATH, "apps/backend/.env");
  const webEnvPath = () => path.join(WORKTREE_PATH, "apps/web/.env.local");

  // 在 worktree 里跑 sync 脚本（每个 describe 独立），确保文件存在
  beforeAll(() => {
    const result = runSyncScript(WORKTREE_PATH);
    // 允许 stderr 有输出，但 exit code 必须 0
    if (result.exitCode !== 0) {
      throw new Error(
        `sync 脚本在 worktree 中失败（exit ${result.exitCode}）：\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
  }, 30_000);

  // ── 用例 2: 文件存在 + AUTO-MANAGED 标记 ──────────────────────────────────

  it("apps/backend/.env 存在，首行含 AUTO-MANAGED 字样", () => {
    const p = backendEnvPath();
    expect(fs.existsSync(p), `${p} 应存在`).toBe(true);

    const lines = fs.readFileSync(p, "utf-8").split("\n");
    expect(lines[0], "首行应含 AUTO-MANAGED 注释标记").toMatch(/AUTO-MANAGED/);
  });

  it("apps/web/.env.local 存在，首行含 AUTO-MANAGED 字样", () => {
    const p = webEnvPath();
    expect(fs.existsSync(p), `${p} 应存在`).toBe(true);

    const lines = fs.readFileSync(p, "utf-8").split("\n");
    expect(lines[0], "首行应含 AUTO-MANAGED 注释标记").toMatch(/AUTO-MANAGED/);
  });

  it("BULLMQ_PREFIX 等于 bull-<branch>", () => {
    const env = parseEnvFile(backendEnvPath());
    expect(env.BULLMQ_PREFIX, "BULLMQ_PREFIX 应等于 bull-worktree-redtest-1").toBe(
      `bull-${TEST_BRANCH}`,
    );
  });

  it("BACKEND PORT 符合哈希算法（4001 + hash(branch) % 999）", () => {
    const env = parseEnvFile(backendEnvPath());
    const expectedPort = computePort(TEST_BRANCH);
    expect(env.PORT, `BACKEND PORT 应等于 ${expectedPort}`).toBe(String(expectedPort));
  });

  it("apps/web/.env.local 中 PORT = BACKEND_PORT + 500", () => {
    const backendEnv = parseEnvFile(backendEnvPath());
    const webEnv = parseEnvFile(webEnvPath());

    const backendPort = Number(backendEnv.PORT);
    const webPort = Number(webEnv.PORT);

    expect(webPort, "WEB PORT 应等于 BACKEND_PORT + 500").toBe(backendPort + 500);
  });

  it("NEXT_PUBLIC_API_URL 指向 http://localhost:<BACKEND_PORT>", () => {
    const backendEnv = parseEnvFile(backendEnvPath());
    const webEnv = parseEnvFile(webEnvPath());

    const backendPort = backendEnv.PORT;
    expect(webEnv.NEXT_PUBLIC_API_URL, "NEXT_PUBLIC_API_URL 应指向 BACKEND_PORT").toBe(
      `http://localhost:${backendPort}`,
    );
  });

  // ── 用例 3: 数据路径绝对路径指向主仓库 ───────────────────────────────────

  it("DATABASE_PATH 是绝对路径，以主仓库根为前缀（数据共享）", () => {
    const env = parseEnvFile(backendEnvPath());
    const dbPath = env.DATABASE_PATH;

    expect(dbPath, "DATABASE_PATH 应存在").toBeTruthy();
    expect(path.isAbsolute(dbPath ?? ""), "DATABASE_PATH 应是绝对路径").toBe(true);
    expect(
      (dbPath ?? "").startsWith(REPO_ROOT),
      `DATABASE_PATH（${dbPath}）应以主仓库根（${REPO_ROOT}）为前缀`,
    ).toBe(true);
  });

  it("STORAGE_ROOT 是绝对路径，以主仓库根为前缀（数据共享）", () => {
    const env = parseEnvFile(backendEnvPath());
    const storageRoot = env.STORAGE_ROOT;

    expect(storageRoot, "STORAGE_ROOT 应存在").toBeTruthy();
    expect(path.isAbsolute(storageRoot ?? ""), "STORAGE_ROOT 应是绝对路径").toBe(true);
    expect(
      (storageRoot ?? "").startsWith(REPO_ROOT),
      `STORAGE_ROOT（${storageRoot}）应以主仓库根（${REPO_ROOT}）为前缀`,
    ).toBe(true);
  });

  // ── 用例 5: BullMQ prefix 跨进程一致 ──────────────────────────────────────
  // 策略：读 apps/backend/.env 中的 BULLMQ_PREFIX，再用 child process 加载
  // 同一个 .env（通过 dotenv）验证进程内读到的值与文件一致。
  // 不启动 Redis，纯进程间 env 一致性验证。

  it("子进程加载 worktree .env 后 BULLMQ_PREFIX 与文件值一致", () => {
    const worktreeBackendEnvPath = backendEnvPath();
    const envFromFile = parseEnvFile(worktreeBackendEnvPath);
    const expectedPrefix = envFromFile.BULLMQ_PREFIX;

    // 用 node -e 加载 dotenv 并输出 BULLMQ_PREFIX
    const scriptContent = `
      const { config } = require('dotenv');
      config({ path: ${JSON.stringify(worktreeBackendEnvPath)} });
      process.stdout.write(process.env.BULLMQ_PREFIX || '');
    `;

    const result = spawnSync(process.execPath, ["-e", scriptContent], {
      // cwd 用主仓库的 apps/backend —— pnpm workspace 下 dotenv 装在那里，
      // worktree 没装 node_modules 解析不到。测试目的是验证 .env 内容被正确读取，cwd 与此无关。
      cwd: path.join(REPO_ROOT, "apps/backend"),
      encoding: "utf-8",
      timeout: 10_000,
      // 子进程不继承父进程 env，确保 BULLMQ_PREFIX 来自 .env 文件
      env: { PATH: process.env.PATH ?? "" },
    });

    expect(result.status, "子进程应 exit 0").toBe(0);
    expect(result.stdout.trim(), "子进程读到的 BULLMQ_PREFIX 应与 .env 文件一致").toBe(
      expectedPrefix,
    );
    expect(expectedPrefix, "BULLMQ_PREFIX 应等于 bull-<branch>").toBe(`bull-${TEST_BRANCH}`);
  });

  // ── 用例 7: 端口区段验证 ───────────────────────────────────────────────────

  it("BACKEND_PORT 在 [4001, 4999] 且不等于 3000", () => {
    const env = parseEnvFile(backendEnvPath());
    const port = Number(env.PORT);

    expect(port, "BACKEND_PORT 应 >= 4001").toBeGreaterThanOrEqual(4001);
    expect(port, "BACKEND_PORT 应 <= 4999").toBeLessThanOrEqual(4999);
    expect(port, "BACKEND_PORT 不应与主仓库 3000 冲突").not.toBe(3000);
  });

  it("WEB_PORT 在 [4501, 5499] 且不等于 3001", () => {
    const webEnv = parseEnvFile(webEnvPath());
    const webPort = Number(webEnv.PORT);

    expect(webPort, "WEB_PORT 应 >= 4501").toBeGreaterThanOrEqual(4501);
    expect(webPort, "WEB_PORT 应 <= 5499").toBeLessThanOrEqual(5499);
    expect(webPort, "WEB_PORT 不应与主仓库 web 3001 冲突").not.toBe(3001);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 用例 4: AUTO-MANAGED 标记保护用户手动维护的文件
// ─────────────────────────────────────────────────────────────────────────────

describe("用例 4: AUTO-MANAGED 保护用户文件", () => {
  it("当 apps/backend/.env 首行不含 AUTO-MANAGED，sync 脚本不覆写", { timeout: 30_000 }, () => {
    const targetEnvPath = path.join(WORKTREE_PATH, "apps/backend/.env");

    // 写一个不含 AUTO-MANAGED 的自定义 .env
    const customContent = "MY_CUSTOM=value\n";
    fs.mkdirSync(path.dirname(targetEnvPath), { recursive: true });
    fs.writeFileSync(targetEnvPath, customContent, "utf-8");

    // 跑 sync 脚本
    const { exitCode } = runSyncScript(WORKTREE_PATH);

    // exit 0（脚本应 graceful skip，不报错）
    expect(exitCode, "sync 脚本对受保护文件应 exit 0").toBe(0);

    // 文件内容不变
    const contentAfter = fs.readFileSync(targetEnvPath, "utf-8");
    expect(contentAfter, "受保护的 .env 文件内容不应被改变").toBe(customContent);

    // 恢复：删掉这个手动文件，让后续 describe（如果有）能正常生成
    // 但注意：前面的 describe 已跑完，顺序无问题
    fs.unlinkSync(targetEnvPath);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 用例 6: 跳过（next.config.ts 动态 port 由 QA 阶段真实启动验证）
// ─────────────────────────────────────────────────────────────────────────────
//
// 原因：验证 next.config.ts 中 remotePatterns 动态解析需要加载 Next.js 配置，
// 依赖 tsx 完整运行时且会读取实现代码，超出红队职责范围。
// 改为在用例 2 中验证 NEXT_PUBLIC_API_URL 的值正确，确保 worktree 产生了
// 正确的 env，由 QA 阶段真实启动 next dev 确认 remotePatterns 行为。

// ─────────────────────────────────────────────────────────────────────────────
// 用例 8: 根 package.json 暴露 postinstall 与 worktree:setup 入口
// ─────────────────────────────────────────────────────────────────────────────

describe("用例 8: 根 package.json 脚本入口验证", () => {
  it("scripts.postinstall 存在且指向 sync 脚本", () => {
    const pkgPath = path.join(REPO_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.postinstall, "package.json scripts.postinstall 应存在").toBeTruthy();
    expect(pkg.scripts?.postinstall, "postinstall 应指向 scripts/sync-worktree-env.mjs").toMatch(
      /sync-worktree-env/,
    );
  });

  it("scripts['worktree:setup'] 存在且指向同一个 sync 脚本", () => {
    const pkgPath = path.join(REPO_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };

    expect(
      pkg.scripts?.["worktree:setup"],
      "package.json scripts['worktree:setup'] 应存在",
    ).toBeTruthy();
    expect(
      pkg.scripts?.["worktree:setup"],
      "worktree:setup 应指向 scripts/sync-worktree-env.mjs",
    ).toMatch(/sync-worktree-env/);
  });

  it("postinstall 与 worktree:setup 指向同一个脚本文件", () => {
    const pkgPath = path.join(REPO_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };

    const postinstall = pkg.scripts?.postinstall ?? "";
    const worktreeSetup = pkg.scripts?.["worktree:setup"] ?? "";

    // 提取脚本路径（去掉 node/pnpm exec 前缀，只比较脚本文件名）
    const extractScriptFile = (cmd: string): string => {
      const match = cmd.match(/scripts\/[\w.-]+\.mjs/);
      return match ? match[0] : cmd;
    };

    expect(
      extractScriptFile(postinstall),
      "postinstall 与 worktree:setup 应指向同一个 .mjs 脚本",
    ).toBe(extractScriptFile(worktreeSetup));
  });
});

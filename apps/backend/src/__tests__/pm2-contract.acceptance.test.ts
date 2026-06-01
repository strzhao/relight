/**
 * 验收测试：任务 4 — PM2 supervisor 脚本契约
 *
 * 契约来源：设计文档「PM2 supervisor（脚本契约）」
 *
 * 验收标准：
 * 1. 仓库根 package.json 的 scripts 包含 workers:start、workers:stop、workers:reload、
 *    workers:logs、workers:status 5 个 key
 * 2. 仓库根存在 ecosystem.config.cjs 文件
 * 3. ecosystem.config.cjs 中 apps[0].name === "relight-workers"
 * 4. pm2 在 devDependencies 中（仅验证 key 存在，不验证版本号）
 *
 * 测试策略：
 * - 纯静态契约测试：读取 package.json / ecosystem.config.cjs，无网络、无 Redis 依赖
 * - ecosystem.config.cjs 用 require() 加载，验证导出结构
 *
 * 红队铁律：不读取 workers/index.ts 或 build-info.ts 的实现。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// =====================================================================
// 常量
// =====================================================================

/** 仓库根目录（绝对路径） */
const REPO_ROOT = path.resolve(__dirname, "../../../../");

const ROOT_PKG_PATH = path.join(REPO_ROOT, "package.json");
const ECOSYSTEM_CONFIG_PATH = path.join(REPO_ROOT, "ecosystem.config.cjs");

// =====================================================================
// 读取 package.json
// =====================================================================

const rootPkg = JSON.parse(fs.readFileSync(ROOT_PKG_PATH, "utf-8")) as {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

// =====================================================================
// PM2 scripts 契约
// =====================================================================

describe("根 package.json scripts — PM2 worker 管理命令契约", () => {
  const requiredScripts = [
    "workers:start",
    "workers:stop",
    "workers:reload",
    "workers:logs",
    "workers:status",
  ] as const;

  for (const scriptName of requiredScripts) {
    it(`scripts["${scriptName}"] 必须存在`, () => {
      expect(
        rootPkg.scripts?.[scriptName],
        `package.json scripts 中缺少 "${scriptName}"`,
      ).toBeTruthy();
    });
  }

  it("5 个 workers:* 命令都存在（一次性断言）", () => {
    const scripts = rootPkg.scripts ?? {};
    const missing = requiredScripts.filter((s) => !scripts[s]);
    expect(missing, `缺少以下 PM2 脚本：${missing.join(", ")}`).toHaveLength(0);
  });
});

// =====================================================================
// pm2 devDependency 契约
// =====================================================================

describe("根 package.json devDependencies — pm2 依赖契约", () => {
  it("pm2 必须在 devDependencies 中", () => {
    expect(
      rootPkg.devDependencies?.pm2,
      "pm2 必须出现在 root package.json devDependencies 中",
    ).toBeTruthy();
  });

  it("pm2 devDependency 版本字符串格式合法（以 ^ 或 ~ 或数字开头）", () => {
    const ver = rootPkg.devDependencies?.pm2 ?? "";
    expect(ver).toMatch(/^[\^~]?\d/);
  });
});

// =====================================================================
// ecosystem.config.cjs 契约
// =====================================================================

describe("ecosystem.config.cjs — PM2 配置文件契约", () => {
  it("仓库根存在 ecosystem.config.cjs 文件", () => {
    expect(fs.existsSync(ECOSYSTEM_CONFIG_PATH), `${ECOSYSTEM_CONFIG_PATH} 文件必须存在`).toBe(
      true,
    );
  });

  it("ecosystem.config.cjs 可以被 require() 加载（语法合法）", () => {
    expect(() => {
      const require = createRequire(import.meta.url);
      require(ECOSYSTEM_CONFIG_PATH);
    }).not.toThrow();
  });

  it("module.exports 包含 apps 数组", () => {
    const require = createRequire(import.meta.url);
    const cfg = require(ECOSYSTEM_CONFIG_PATH) as { apps?: unknown[] };
    expect(Array.isArray(cfg.apps), "ecosystem.config.cjs 的 exports.apps 应为数组").toBe(true);
    expect(cfg.apps?.length, "apps 数组至少有一个条目").toBeGreaterThan(0);
  });

  it("apps[0].name === 'relight-workers'", () => {
    const require = createRequire(import.meta.url);
    const cfg = require(ECOSYSTEM_CONFIG_PATH) as {
      apps: Array<{ name?: string }>;
    };
    expect(cfg.apps[0]?.name).toBe("relight-workers");
  });

  it("apps[0] 包含 script 字段（worker 启动脚本）", () => {
    const require = createRequire(import.meta.url);
    const cfg = require(ECOSYSTEM_CONFIG_PATH) as {
      apps: Array<{ script?: string }>;
    };
    expect(cfg.apps[0]?.script, "apps[0].script 应存在").toBeTruthy();
  });
});

// =====================================================================
// ecosystem.config.cjs — relight-api 条目契约
// =====================================================================

describe("ecosystem.config.cjs — relight-api 条目契约", () => {
  /**
   * 辅助：加载 ecosystem.config.cjs，按 name 查找指定条目。
   * 不假设下标——契约仅约定 name，不约定位置。
   */
  type AppEntry = {
    name?: string;
    cwd?: string;
    script?: string;
    interpreter?: string;
    interpreter_args?: string;
    env?: Record<string, string | undefined>;
  };

  function loadConfig(): { apps: AppEntry[] } {
    const require = createRequire(import.meta.url);
    return require(ECOSYSTEM_CONFIG_PATH) as { apps: AppEntry[] };
  }

  function findApp(name: string): AppEntry | undefined {
    const cfg = loadConfig();
    return cfg.apps.find((a) => a.name === name);
  }

  // ── 数组长度 ──────────────────────────────────────────────────────────
  it("apps.length === 2（workers + api 共 2 个进程）", () => {
    const cfg = loadConfig();
    expect(cfg.apps, "apps 数组应恰好包含 2 个条目").toHaveLength(2);
  });

  // ── relight-api 存在 ──────────────────────────────────────────────────
  it("apps 中存在 name === 'relight-api' 的条目", () => {
    const entry = findApp("relight-api");
    expect(entry, "未找到 name === 'relight-api' 的条目").toBeDefined();
  });

  // ── 字段精确值 ───────────────────────────────────────────────────────
  it("relight-api.cwd === './apps/backend'", () => {
    const entry = findApp("relight-api");
    expect(entry?.cwd).toBe("./apps/backend");
  });

  it("relight-api.script === 'src/index.ts'", () => {
    const entry = findApp("relight-api");
    expect(entry?.script).toBe("src/index.ts");
  });

  it("relight-api.interpreter === 'node'", () => {
    const entry = findApp("relight-api");
    expect(entry?.interpreter).toBe("node");
  });

  it("relight-api.interpreter_args === '--import tsx'", () => {
    const entry = findApp("relight-api");
    expect(entry?.interpreter_args).toBe("--import tsx");
  });

  it("relight-api.env.NODE_ENV === 'development'", () => {
    const entry = findApp("relight-api");
    expect(entry?.env?.NODE_ENV).toBe("development");
  });

  it("relight-api.env.REPO_ROOT 为非空字符串", () => {
    const entry = findApp("relight-api");
    expect(typeof entry?.env?.REPO_ROOT).toBe("string");
    expect(entry?.env?.REPO_ROOT, "REPO_ROOT 不应为空字符串").not.toBe("");
  });

  it("relight-api.env.PATH 为非空字符串", () => {
    const entry = findApp("relight-api");
    expect(typeof entry?.env?.PATH).toBe("string");
    expect(entry?.env?.PATH, "relight-api 的 PATH 不应为空字符串").not.toBe("");
  });

  // ── relight-workers 的 PATH 也必须非空 ───────────────────────────────
  it("relight-workers.env.PATH 为非空字符串", () => {
    const entry = findApp("relight-workers");
    expect(entry, "未找到 name === 'relight-workers' 的条目").toBeDefined();
    expect(typeof entry?.env?.PATH).toBe("string");
    expect(entry?.env?.PATH, "relight-workers 的 PATH 不应为空字符串").not.toBe("");
  });
});

// =====================================================================
// workers:* 命令实际引用 pm2 验证
// =====================================================================

describe("workers:* 命令应引用 pm2 二进制", () => {
  it("workers:start 命令字符串包含 'pm2'", () => {
    const cmd = rootPkg.scripts?.["workers:start"] ?? "";
    expect(cmd, "workers:start 命令应使用 pm2").toContain("pm2");
  });

  it("workers:stop 命令字符串包含 'pm2'", () => {
    const cmd = rootPkg.scripts?.["workers:stop"] ?? "";
    expect(cmd, "workers:stop 命令应使用 pm2").toContain("pm2");
  });

  it("workers:status 命令字符串包含 'pm2'", () => {
    const cmd = rootPkg.scripts?.["workers:status"] ?? "";
    expect(cmd, "workers:status 命令应使用 pm2").toContain("pm2");
  });
});

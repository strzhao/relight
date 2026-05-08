#!/usr/bin/env node
/**
 * sync-worktree-env.mjs
 *
 * postinstall 钩子脚本：在 git worktree 中自动生成专属环境配置。
 * 主仓库直接 silent exit 0，不做任何修改。
 *
 * 生成内容：
 *   - apps/backend/.env     — PORT / DATABASE_PATH / STORAGE_ROOT / REDIS_URL / BULLMQ_PREFIX / AI_*
 *   - apps/web/.env.local   — PORT / NEXT_PUBLIC_API_URL
 *   - local-config.json     — devPort / backendPort / webPort / hostname / enableHttps
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ─── 端口算法（与 string-claude-code-plugin worktree.mjs:computePort() 字节级一致）───
function computePort(branch) {
  let h = 0;
  for (let i = 0; i < branch.length; i++) {
    h = (h * 31 + branch.charCodeAt(i)) >>> 0;
  }
  return 4001 + (h % 999);
}

// ─── .env 文件解析 ───────────────────────────────────────────────────────────
function parseEnvFile(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const map = new Map(); // key → value
  const order = []; // 保留原顺序（包括注释/空行，key=null）
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      order.push({ key: null, raw: line });
      continue;
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      order.push({ key: null, raw: line });
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    map.set(key, value);
    order.push({ key, raw: line });
  }
  return { map, order };
}

// ─── .env 文件序列化 ─────────────────────────────────────────────────────────
function serializeEnv(header, map, originalOrder, whitelist, overrides) {
  const lines = [header];
  const written = new Set();

  for (const entry of originalOrder) {
    if (entry.key === null) {
      // 注释/空行 — 跳过旧的 AUTO-MANAGED 首行，其他保留
      if (entry.raw.startsWith("# AUTO-MANAGED")) continue;
      lines.push(entry.raw);
    } else {
      const key = entry.key;
      written.add(key);
      if (overrides.has(key)) {
        lines.push(`${key}=${overrides.get(key)}`);
      } else {
        lines.push(`${key}=${map.get(key) ?? ""}`);
      }
    }
  }

  // 追加白名单中尚未出现过的 key（例如文件中从未有过 BULLMQ_PREFIX）
  for (const key of whitelist) {
    if (!written.has(key) && overrides.has(key)) {
      lines.push(`${key}=${overrides.get(key)}`);
    }
  }

  return lines.join("\n");
}

const AUTO_MANAGED_MARKER =
  "# AUTO-MANAGED by scripts/sync-worktree-env.mjs - DO NOT EDIT (overwritten on pnpm install)";

// ─── 合并写入 .env 文件 ───────────────────────────────────────────────────────
function mergeWriteEnv(filePath, whitelist, overrides) {
  let existingMap = new Map();
  let existingOrder = [];

  if (fs.existsSync(filePath)) {
    const { map, order } = parseEnvFile(filePath);
    const firstContentLine = order.find(
      (e) => e.key !== null || (e.raw && !e.raw.trim().startsWith("#") && e.raw.trim() !== ""),
    );
    const firstLine = order[0];

    // 如果首行不是 AUTO-MANAGED 标记，视为用户手动维护 → 跳过覆写
    if (firstLine?.raw && !firstLine.raw.startsWith("# AUTO-MANAGED")) {
      process.stderr.write(
        `[sync-worktree-env] warning: ${filePath} 首行不是 AUTO-MANAGED 标记，跳过覆写（用户手动维护文件）\n`,
      );
      return;
    }

    existingMap = map;
    existingOrder = order;
  }

  const content = serializeEnv(
    AUTO_MANAGED_MARKER,
    existingMap,
    existingOrder,
    whitelist,
    overrides,
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content}\n`, "utf8");
}

// ─── 主逻辑 ──────────────────────────────────────────────────────────────────
const worktreeRoot = process.cwd();
const gitPath = path.join(worktreeRoot, ".git");

// 检测是否在 worktree（.git 是文件而非目录）
const gitStat = fs.statSync(gitPath, { throwIfNoEntry: false });
if (!gitStat || gitStat.isDirectory()) {
  // 不在 worktree，silent exit
  process.exit(0);
}

// 解析当前分支
let branch;
try {
  branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: worktreeRoot,
    encoding: "utf8",
  }).trim();
} catch {
  process.stderr.write("[sync-worktree-env] error: 无法获取当前分支名\n");
  process.exit(1);
}

// 归一化分支名用于 BullMQ prefix（feature/foo → feature-foo，避免 prefix 含斜杠不规范）
const sanitizedBranch = branch.replace(/\//g, "-");

// 反推主仓库根：.git 文件内容 = "gitdir: <main>/.git/worktrees/<name>"，往上两级
const gitFileContent = fs.readFileSync(gitPath, "utf8").trim();
const gitdirMatch = gitFileContent.match(/^gitdir:\s*(.+)$/);
if (!gitdirMatch) {
  process.stderr.write(`[sync-worktree-env] error: 无法解析 .git 文件: ${gitFileContent}\n`);
  process.exit(1);
}
const gitdirPath = gitdirMatch[1].trim(); // <main>/.git/worktrees/<name>
const mainRepoRoot = path.resolve(gitdirPath, "..", "..", ".."); // 往上三级 = main repo root

// 计算端口
const devPort = computePort(branch);
const backendPort = devPort;
const webPort = devPort + 500;

// 计算 BullMQ prefix（使用归一化后的分支名，避免 `/` 带入 Redis key 命名）
const bullmqPrefix = `bull-${sanitizedBranch}`;

// ─── 更新 local-config.json ───────────────────────────────────────────────────
const localConfigPath = path.join(worktreeRoot, "local-config.json");
let localConfig = {
  server: {
    hostname: "localhost",
    enableHttps: false,
  },
};

if (fs.existsSync(localConfigPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(localConfigPath, "utf8"));
    localConfig = existing;
    if (!localConfig.server) localConfig.server = {};
    // 保留 hostname/enableHttps，强制更新端口字段
  } catch {
    // 解析失败，使用默认值
  }
}

localConfig.server.devPort = devPort;
localConfig.server.backendPort = backendPort;
localConfig.server.webPort = webPort;
if (localConfig.server.hostname === undefined) localConfig.server.hostname = "localhost";
if (localConfig.server.enableHttps === undefined) localConfig.server.enableHttps = false;

fs.writeFileSync(localConfigPath, `${JSON.stringify(localConfig, null, 2)}\n`, "utf8");

// ─── 解析主仓库 STORAGE_ROOT ──────────────────────────────────────────────────
let storageRoot = null;
const mainEnvCandidates = [
  path.join(mainRepoRoot, "apps", "backend", ".env"),
  path.join(mainRepoRoot, ".env"),
];

for (const envFile of mainEnvCandidates) {
  if (fs.existsSync(envFile)) {
    const { map } = parseEnvFile(envFile);
    if (map.has("STORAGE_ROOT")) {
      storageRoot = map.get("STORAGE_ROOT");
      // 相对路径以 .env 所在目录为基准（backend 进程 cwd 与 apps/backend/.env 同目录）
      // 早先用 mainRepoRoot 作 base 会让 apps/backend/.env 里的 "./photos" 解析到仓库根，
      // 但 backend 实际数据在 apps/backend/photos，导致 worktree STORAGE_ROOT 指向不存在的目录
      if (!path.isAbsolute(storageRoot)) {
        storageRoot = path.resolve(path.dirname(envFile), storageRoot);
      }
      break;
    }
  }
}

if (!storageRoot) {
  storageRoot = path.join(mainRepoRoot, "photos");
}

// DATABASE_PATH 始终指向主仓库绝对路径
const databasePath = path.join(mainRepoRoot, "apps", "backend", "data", "relight.db");

// ─── 在 worktree 内为 photos 数据目录建符号链接 ───────────────────────────────
// backend 的 thumbnail/original 路由用 process.cwd() 相对解析 thumbnailPath（如
// "photos/thumbnails/<id>.jpg"），不会用 STORAGE_ROOT 拼路径。worktree 启动 backend
// 时 cwd=apps/backend，相对路径会落到 worktree 内不存在的目录上，导致缩略图静默
// 降级为 SVG "缩略图缺失"。建一个指向主仓库的 symlink，让 cwd 相对解析也命中实
// 际数据。
const worktreePhotosLink = path.join(worktreeRoot, "apps", "backend", "photos");
const mainPhotosTarget = path.join(mainRepoRoot, "apps", "backend", "photos");
if (fs.existsSync(mainPhotosTarget)) {
  try {
    const existing = fs.lstatSync(worktreePhotosLink, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) {
      const current = fs.readlinkSync(worktreePhotosLink);
      if (current !== mainPhotosTarget) {
        fs.unlinkSync(worktreePhotosLink);
        fs.symlinkSync(mainPhotosTarget, worktreePhotosLink);
      }
    } else if (!existing) {
      fs.symlinkSync(mainPhotosTarget, worktreePhotosLink);
    }
    // existing 但不是 symlink（如真实目录）— 不动，让用户手动决定
  } catch (e) {
    console.warn(`[sync-worktree-env] photos symlink 创建失败: ${e.message}`);
  }
}

// ─── 写 apps/backend/.env ─────────────────────────────────────────────────────
const backendEnvPath = path.join(worktreeRoot, "apps", "backend", ".env");
const backendWhitelist = [
  "PORT",
  "DATABASE_PATH",
  "STORAGE_ROOT",
  "REDIS_URL",
  "BULLMQ_PREFIX",
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_MODEL",
  "AI_VISION_MODEL",
];
const backendOverrides = new Map([
  ["PORT", String(backendPort)],
  ["DATABASE_PATH", databasePath],
  ["STORAGE_ROOT", storageRoot],
  ["REDIS_URL", "redis://localhost:6379"],
  ["BULLMQ_PREFIX", bullmqPrefix],
  ["AI_BASE_URL", "http://127.0.0.1:8001/v1"],
  ["AI_API_KEY", "qwen-local-key"],
  ["AI_MODEL", "qwen3.6-35b"],
  ["AI_VISION_MODEL", "qwen3.6-35b"],
]);

mergeWriteEnv(backendEnvPath, backendWhitelist, backendOverrides);

// ─── 写 apps/web/.env.local ───────────────────────────────────────────────────
const webEnvPath = path.join(worktreeRoot, "apps", "web", ".env.local");
const webWhitelist = ["PORT", "NEXT_PUBLIC_API_URL"];
const webOverrides = new Map([
  ["PORT", String(webPort)],
  ["NEXT_PUBLIC_API_URL", `http://localhost:${backendPort}`],
]);

mergeWriteEnv(webEnvPath, webWhitelist, webOverrides);

// ─── 打印分配总结 ─────────────────────────────────────────────────────────────
process.stderr.write(
  `✓ sync-worktree-env: backend :${backendPort}  web :${webPort}  prefix=${bullmqPrefix}\n`,
);

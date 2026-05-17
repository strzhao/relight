---
id: 004-placeholder-pages
depends_on:
  - 003-pm2-orchestration
---

# 任务 004 — 报告 / 日志 / 设置 三页面填充

## 目标（一句话）

把 Mac 控制中心 sidebar 的「报告 / 日志 / 设置」三个 placeholder 页面填充真实内容：报告页复用 `/api/daily`，日志页 tail PM2 输出，设置页只读展示 env 配置（敏感字段掩码）。

## 架构上下文

- `apps/mac/Relight/UI/ControlCenter.swift` 第 166-172 行：三个页面当前是 `PlaceholderPage(title:, hint:)`
- 后端 `GET /api/daily?page=1&pageSize=30` 已存在（复用，不新建报告 API）
- PM2 日志实测路径：`~/.pm2/logs/relight-workers-out.log` + `relight-workers-error.log`
- 后端 `apps/backend/src/lib/config.ts` 已集中管理 env 配置（包含 `aiApiKey`）

## 输入契约（依赖 003）

- `localhostOnly` middleware 已 mount 到 `/api/runtime/*`
- `RuntimeStatusViewModel` 已扩展（004 在此基础上再加 `fetchLogs` / `fetchConfig`）
- `config.repoRoot` 可用（但本任务不用，只用于潜在路径计算）

## 输出契约

### 1. 新文件 `apps/backend/src/routes/workers-logs.ts`

```ts
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Hono } from "hono";

const PM2_LOG_DIR = path.join(os.homedir(), ".pm2/logs");

async function tailLines(file: string, n: number): Promise<string[]> {
  // circular buffer 读最后 N 行（不全文件 load）
  const buf: string[] = [];
  try {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      buf.push(line);
      if (buf.length > n) buf.shift();
    }
  } catch {
    return [];
  }
  return buf;
}

export const workersLogsRouter = new Hono().get("/logs", async (c) => {
  const linesParam = Number(c.req.query("lines") ?? 200);
  const lines = Math.min(Math.max(1, linesParam), 1000);
  const [stdout, stderr] = await Promise.all([
    tailLines(path.join(PM2_LOG_DIR, "relight-workers-out.log"), lines),
    tailLines(path.join(PM2_LOG_DIR, "relight-workers-error.log"), lines),
  ]);
  return c.json({ success: true, data: { stdout, stderr } });
});
```

### 2. 新文件 `apps/backend/src/routes/config.ts`

```ts
import { Hono } from "hono";
import { config } from "../lib/config";

function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

export const configRouter = new Hono().get("/", async (c) => {
  return c.json({
    success: true,
    data: {
      storageRoot: config.storageRoot,
      aiBaseUrl: config.aiBaseUrl,
      aiModel: config.aiModel,
      aiVisionModel: config.aiVisionModel,
      redisUrl: config.redisUrl,
      databasePath: config.databasePath,
      bullmqPrefix: config.bullmqPrefix,
      aiApiKey: maskApiKey(config.aiApiKey),
    },
  });
});
```

### 3. `app.ts` 挂载

```ts
app.route("/api/runtime/workers", workersLogsRouter);  // 已挂 /workers 前缀，此 router 加 /logs
app.route("/api/runtime/config", configRouter);
```

### 4. Shared Types

```ts
export type WorkersLogs = { stdout: string[]; stderr: string[] };
export type RuntimeConfig = {
  storageRoot: string;
  aiBaseUrl: string;
  aiModel: string;
  aiVisionModel: string;
  redisUrl: string;
  databasePath: string;
  bullmqPrefix: string;
  aiApiKey: string; // masked
};
```

### 5. Shared Routes

```ts
runtime: {
  // ... 已有
  workersLogs: "/api/runtime/workers/logs",
  config: "/api/runtime/config",
}
```

### 6. Mac App 三个新页面

**`apps/mac/Relight/UI/ReportsPage.swift`**（新文件）：
- 复用 `RelightClient.fetchDaily(page:, pageSize:)`（如不存在则在 viewModel 中新加）
- 列表展示最近 30 天 `DailyPick`，每条 = 日期 + 缩略图 + 标题
- 空数据降级：显示「暂无精选历史」+ 「立即生成」按钮（POST `/api/daily/trigger`，已有端点）

**`apps/mac/Relight/UI/LogsPage.swift`**（新文件）：
- `RuntimeStatusViewModel` 新增 `@Published var logs: WorkersLogs?` + `fetchLogs() async`
- 5s 轮询 fetch（与 status 同节奏，但独立调用）
- 用 `ScrollViewReader` + monospace 字体展示，stdout / stderr 双栏或合并
- `userScrolledUp` flag：用户上滑后暂停 auto-follow；滚回底部恢复

**`apps/mac/Relight/UI/SettingsPage.swift`**（新文件）：
- `RuntimeStatusViewModel` 新增 `fetchConfig() async`
- 进入页面时拉一次，纯展示
- 底部文案：「修改请编辑 `.env`，重启后端 + workers 后生效」（链接到「服务」页）

**`ControlCenter.swift` switch case** 替换：

```swift
case .reports: ReportsPage().environmentObject(viewModel)
case .logs: LogsPage().environmentObject(viewModel)
case .settings: SettingsPage().environmentObject(viewModel)
```

### 7. Xcode pbxproj 注册

按 patterns.md [2026-05-17] 「pbxproj 4 section」流程，给 3 个新 .swift 文件加：
- PBXBuildFile entries × 3
- PBXFileReference entries × 3
- UI Group children entries × 3
- PBXSourcesBuildPhase files entries × 3

## 验收标准

红队 acceptance test：
- `GET /api/runtime/workers/logs?lines=10` → 返回 `{ success: true, data: { stdout: [], stderr: [] } }` 形状
- `GET /api/runtime/config` → aiApiKey 字段命中 `^sk-.{0,3}\*{4}.{4}$` 或 `^\*{4}$` 掩码模式（不含明文 key）
- 非 localhost GET 这两个端点 → 字段是否暴露由 middleware 决定（这两个 endpoint 默认所有人都能拿，但 logs 本身已经是文本，config 已掩码，可接受）

Tier 1.5 真实场景：
1. 报告页：清空 `daily_picks` 表 → 显示「暂无」+ 触发按钮；倒回填数据 → 30 天列表渲染
2. 日志页：手动触发 worker job → ≤3s 在 logs 页见到新日志；滚动到中部 → 不被强制拽回底部；滚回底部 → 恢复 auto-follow
3. 设置页：展示 STORAGE_ROOT / AI_BASE_URL / AI_MODEL 实际值；aiApiKey 显示 `sk-x****abcd` 形态掩码

## 范围控制

- ❌ 设置页**只读**，不实现编辑（编辑要求 restart workers，与 003 reload 语义冲突，留下一轮）
- ❌ 日志页不实现搜索 / 过滤（先看到再说）
- ❌ 报告页不实现图表（折线图 / 趋势）；仅列表 + 简单统计行
- ❌ logrotate 午夜边界不做补救（属已知可接受边界）
- ❌ 不动 web App（`apps/web` 不在本任务范围）

# 项目设计 — Mac 控制中心遗留清理

## 目标

清理上一轮（Mac 控制中心 MVP）留下的 4 个遗留 track。所有改动围绕**已存在**的「Mac 控制中心 + `/api/runtime/status` 后端」架构延展，不引入新基础设施。

## 整体架构原则

1. **后端门户单一化**：所有运行时控制端点统一挂到 `/api/runtime/*`，复用同一 localhost-only middleware
2. **配置只读优先**：设置页第一轮只读 + 掩码敏感字段，编辑功能延后
3. **日志走文件 tail，不走 PM2 程序化 API**：直接读 `~/.pm2/logs/relight-workers-{out,error}.log` 更可靠
4. **Mac App 控件状态由后端真实状态驱动**：按钮 disabled / enabled 来自 `/api/runtime/status` 的 workers.status

## 跨任务设计约束

### 共享 middleware 契约（T2 立约，T3/T4 必须遵守）

文件：`apps/backend/src/lib/middleware/localhost-only.ts`

```ts
export const localhostOnly: MiddlewareHandler<{
  Variables: { isLocalhost: boolean };
}>;
```

行为：
- 只读 `c.env?.incoming?.socket?.remoteAddress`，**完全忽略 X-Forwarded-For 等任何 HTTP 头**（XFF 可被 `curl -H` 伪造）
- 允许 `127.0.0.1` / `::1` / `::ffff:127.0.0.1` 三种形态
- 无 remoteAddress（测试 / `app.request()` 直接调用）→ 视为 localhost
- GET 非 localhost → `c.set("isLocalhost", false)` + next()（由路由层脱敏返回）
- POST 非 localhost → `c.json({ success: false, error: "forbidden", message: "仅本机访问" }, 403)`

### `/api/runtime` 路由分组

| Method | Path | 来源任务 |
|---|---|---|
| GET | `/api/runtime/status` (改造) | T2 |
| POST | `/api/runtime/workers/start` | T3 |
| POST | `/api/runtime/workers/stop` | T3 |
| POST | `/api/runtime/workers/reload` | T3 |
| GET | `/api/runtime/workers/logs?lines=200` | T4 |
| GET | `/api/runtime/config` | T4 |

### REPO_ROOT 定位策略（T3 起共享）

`apps/backend/src/lib/config.ts` 新增：

```ts
repoRoot: process.env.REPO_ROOT ?? path.resolve(process.cwd(), "../..")
```

- dev (`pnpm --filter @relight/backend dev`) cwd = `apps/backend`，`../..` = monorepo 根 ✓
- prod PM2（cwd: `./apps/backend` per ecosystem）`../..` 同样指向 monorepo 根 ✓
- 同时在 `ecosystem.config.cjs` 的 env 注入 `REPO_ROOT: process.cwd()`（运维 override 友好）

### Mac App 共享 ViewModel 扩展

`RuntimeStatusViewModel`（已有 `fetchOnce()` / 5s 轮询）：
- T3 新增 `func controlWorker(_ action: WorkerAction) async throws -> WorkerControlResponse`
- T4 新增 `func fetchLogs(lines: Int) async throws -> WorkersLogs`
- T4 新增 `func fetchConfig() async throws -> RuntimeConfig`

**不新建独立 ViewModel**（避免状态重复 + 并发同步问题）。

### Shared Types（`packages/shared/src/types.ts`）

```ts
// T3
type WorkerAction = "start" | "stop" | "reload";
type WorkerControlResponse = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

// T4
type WorkersLogs = { stdout: string[]; stderr: string[] };

type RuntimeConfig = {
  storageRoot: string;
  aiBaseUrl: string;
  aiModel: string;
  aiVisionModel: string;
  redisUrl: string;
  databasePath: string;
  bullmqPrefix: string;
  aiApiKey: string; // 掩码: sk-****{last4}
};

// RuntimeStatus 改造：非 localhost 时 pid/commit/storageBytes/hostname 为 null
```

## 任务 DAG 概览

```
001 menu-bar-contrast   ─ 独立
002 api-security        ─ 独立，但 003/004 都复用其 middleware
003 pm2-orchestration   ─ depends_on 002
004 placeholder-pages   ─ depends_on 003
```

执行顺序建议：001 → 002 → 003 → 004（线性）。001 / 002 可并行。

## Handoff 策略

每个任务完成后写 `.handoff.md`（≤500 字）：
- 实现摘要
- 文件变更清单
- 下游须知（特别是 T2 → T3：middleware 导出形状；T3 → T4：PM2 二进制 / 日志路径定位策略）
- 偏差说明

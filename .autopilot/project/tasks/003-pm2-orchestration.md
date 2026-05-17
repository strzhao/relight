---
id: 003-pm2-orchestration
depends_on:
  - 002-api-security
---

# 任务 003 — PM2 编排接通：start/stop/reload API + Mac 按钮 wiring

## 目标（一句话）

让 Mac 控制中心「服务」页的「启动/停止/重启」按钮真正能控制 PM2 上的 `relight-workers` 进程，按钮 enable 状态由后端 workers.status 驱动，操作前二次确认。

## 架构上下文

- `ecosystem.config.cjs` 已配置 `relight-workers` PM2 app（cwd=`./apps/backend`, kill_timeout=10000ms）
- `package.json` 已有 `workers:start/stop/reload` 脚本调 PM2
- `apps/mac/Relight/UI/ControlCenter.swift` 第 251-267 行：3 个按钮 `disabled(true)`，无回调
- 上一轮 patterns.md 教训：PM2 reload 会中断长 in-flight job，UI 文案要明确告知

## 输入契约（依赖 002）

- `localhostOnly` middleware 已存在（`apps/backend/src/lib/middleware/localhost-only.ts`）
- middleware 行为：POST 非 localhost → 403

## 输出契约

### 1. 新文件 `apps/backend/src/lib/config.ts` 扩展

```ts
export const config = {
  // ... 现有字段
  repoRoot: process.env.REPO_ROOT ?? path.resolve(process.cwd(), "../.."),
};
```

### 2. `ecosystem.config.cjs` 增加 env 注入

```js
{
  name: "relight-workers",
  // ... 现有
  env: {
    REPO_ROOT: process.cwd(), // 此处 cwd 是 PM2 求值 config 时的 cwd = monorepo 根
  },
}
```

### 3. 新文件 `apps/backend/src/routes/workers-control.ts`

```ts
import { spawn } from "node:child_process";
import { Hono } from "hono";
import { config } from "../lib/config";

type Action = "start" | "stop" | "reload";

async function runPnpm(action: Action) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve) => {
      const child = spawn("pnpm", [`workers:${action}`], {
        cwd: config.repoRoot,
        env: { ...process.env },
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) =>
        resolve({ stdout, stderr, exitCode: code ?? -1 }),
      );
    },
  );
}

export const workersControlRouter = new Hono()
  .post("/start", async (c) => {
    const r = await runPnpm("start");
    return c.json({ success: r.exitCode === 0, ...r }, r.exitCode === 0 ? 200 : 500);
  })
  .post("/stop", async (c) => {
    const r = await runPnpm("stop");
    return c.json({ success: r.exitCode === 0, ...r }, r.exitCode === 0 ? 200 : 500);
  })
  .post("/reload", async (c) => {
    const r = await runPnpm("reload");
    return c.json({ success: r.exitCode === 0, ...r }, r.exitCode === 0 ? 200 : 500);
  });
```

### 4. `app.ts` 挂载

```ts
import { workersControlRouter } from "./routes/workers-control";
app.route("/api/runtime/workers", workersControlRouter);
```

（注意 `localhostOnly` 在 002 中已 mount 到 `/api/runtime/*`，本任务的 POST 端点会自动继承）

### 5. `packages/shared/src/types.ts` 新增

```ts
export type WorkerAction = "start" | "stop" | "reload";
export type WorkerControlResponse = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};
```

### 6. `packages/shared/src/routes.ts` 扩展

```ts
runtime: {
  status: "/api/runtime/status",
  workersStart: "/api/runtime/workers/start",
  workersStop: "/api/runtime/workers/stop",
  workersReload: "/api/runtime/workers/reload",
}
```

### 7. Mac App `ControlCenter.swift` 改造

- `RuntimeStatusViewModel` 增加 `func controlWorker(_ action: WorkerAction) async throws -> WorkerControlResponse`
- `actionBar` 中 3 个按钮：
  - 「启动」按钮：`disabled(viewModel.status?.services.workers.status != .down)` + onTap 触发 `confirmationDialog`
  - 「停止」按钮：`disabled(viewModel.status?.services.workers.status != .running)` + 同上
  - 「重启」按钮：`disabled(viewModel.status?.services.workers.status != .running)` + 同上，文案 "重启会中断当前正在分析的任务，已分析过的不重做"
  - 确认后 `Task { try await viewModel.controlWorker(.start) }`，完成后立即 `await viewModel.fetchOnce()` 刷新状态

## 验收标准

红队 acceptance test：
- mock spawn → 验证三个 POST 端点都正确调 `pnpm workers:{action}` + 正确返回 JSON 结构
- 非 localhost 请求 → 403（由 002 middleware 保证，本任务测试覆盖一次回归）

Tier 1.5 真实场景：
1. `pnpm workers:stop` → Mac App 按「启动」→ 二次确认 → 确认 → 5s 内 `pm2 list` 显示 online + UI 同步
2. workers 运行中 → Mac App 按「停止」→ 二次确认 → 取消 → `pm2 list` 仍 online；再点 → 确认 → stopped
3. workers 运行中 → 记 pid → Mac App 按「重启」→ 确认 → `pm2 list` 中 pid 已变
4. 本机内网 IP `curl -X POST -H "X-Forwarded-For: 127.0.0.1" http://<内网IP>:3000/api/runtime/workers/start` → 403

## 范围控制

- ❌ 不维护本地按钮 disable 状态（完全由 workers.status 派生）
- ❌ 不实现 PM2 进程内 API（用 child_process spawn 简单可靠）
- ❌ 操作失败时不自动重试（直接返回错误，UI 显示 stderr）

---
id: 002-api-security
depends_on: []
---

# 任务 002 — localhostOnly middleware + CORS 收紧 + runtime.ts 字段脱敏

## 目标（一句话）

给 `/api/runtime/*` 加 localhost-only 防线，CORS 从全开收紧到白名单，非 localhost 调用 `/status` 时脱敏 pid/commit/storageBytes/hostname。

## 架构上下文

- `apps/backend/src/app.ts` 第 36 行：`app.use("*", cors())` 全开
- `apps/backend/src/routes/runtime.ts`：当前响应无条件返回 pid / commit / storageBytes（敏感）
- `apps/backend/src/routes/__tests__/runtime.acceptance.test.ts` 第 194-200 行：红队期望 `pid > 0`
- 现有无任何 auth 中间件可复用

## 输入契约

- Hono 4.x 的 `c.env?.incoming?.socket?.remoteAddress` 在 Node adapter 下可用
- `app.request()` 直接调用时**无** real socket，`c.env?.incoming` 为 undefined
- `packages/shared/src/types.ts` 的 `RuntimeStatus` 类型需要更新（pid/commit/storageBytes/hostname 改为 nullable）

## 输出契约

### 1. 新文件 `apps/backend/src/lib/middleware/localhost-only.ts`

```ts
import type { MiddlewareHandler } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    isLocalhost: boolean;
  }
}

export const localhostOnly: MiddlewareHandler = async (c, next) => {
  // ⚠️ 安全铁律：只读 socket remoteAddress，完全忽略 X-Forwarded-For
  // XFF 可被客户端 -H 任意伪造，依赖它会让安全检查失效
  const remoteAddr =
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress ?? "";

  const isLocal =
    remoteAddr === "" || // 无 socket（测试 / app.request()）→ 视为 localhost
    remoteAddr === "127.0.0.1" ||
    remoteAddr === "::1" ||
    remoteAddr === "::ffff:127.0.0.1";

  c.set("isLocalhost", isLocal);

  if (!isLocal && c.req.method !== "GET") {
    return c.json(
      { success: false, error: "forbidden", message: "仅本机访问" },
      403,
    );
  }

  await next();
};
```

### 2. 改造 `apps/backend/src/app.ts`

- CORS 从 `cors()` 改为白名单：
  - 允许 origin: `null`（同源 Mac App 直连）
  - 允许 `http://localhost:*` 和 `http://127.0.0.1:*`（dev web app + curl）
  - 用 `cors({ origin: (origin) => isAllowed(origin) ? origin : null })`
- 在 `/api/runtime/*` 路由 mount 前加 `app.use("/api/runtime/*", localhostOnly)`

### 3. 改造 `apps/backend/src/routes/runtime.ts`

- 在响应组装处读 `c.get("isLocalhost")`
- 非 localhost 时：`pid`, `commit`, `storageBytes`, `hostname`, `repository.storageBytes` 字段设为 `null`
- 保留 status / uptime / queueDepth / pickDate / nextRunAt 等非敏感字段

### 4. Shared Types 同步

`packages/shared/src/types.ts` 的 `RuntimeStatus`：
- `services.api.pid: number | null`
- `services.workers.commit: string | null`
- `repository: { ..., storageBytes: number | null } | null`

## 验收标准（红队测试 + Tier 1.5）

红队 acceptance test（新建或扩展 `runtime.acceptance.test.ts`）：
- 测试 `app.request()` 无 socket → middleware 视为 localhost → pid 等照常返回（兼容现有 `pid > 0` 断言）
- mock `c.env.incoming.socket.remoteAddress` 为 `192.168.1.5` → GET 返回脱敏（pid = null）
- mock 同上 → POST 任意 `/api/runtime/workers/*`（即使路径不存在）路径走 middleware → 返回 403

Tier 1.5 真实场景（已记录在 state.md 验证方案 T2）：
1. 本机 `curl http://127.0.0.1:3000/api/runtime/status` → 200 + pid > 0
2. 本机 `curl -v http://<内网IP>:3000/api/runtime/status` → 200 但 pid = null（脱敏）
3. 本机伪造 XFF：`curl -H "X-Forwarded-For: 127.0.0.1" http://<内网IP>:3000/api/runtime/status` → 仍然脱敏（验证不读 XFF）
4. Mac App 控制中心打开 → 数据完整展示（未误伤）
5. CORS preflight 验证：`curl -X OPTIONS -H "Origin: https://evil.com" -i .../status` → 响应头无 `Access-Control-Allow-Origin: *`

## 范围控制

- ❌ 本轮不做 token-based auth（localhost-only 已足够，公网部署再加）
- ❌ 不改 routes/runtime.ts 内部 probe 逻辑（保留上一轮的 TTL/probeWorkers/probeCron 不变）
- ❌ 不动其它路由（photos, daily, scan 等）的 CORS 行为

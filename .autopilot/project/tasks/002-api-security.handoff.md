# 002-api-security Handoff

**Commits**: `aee4022` (feat) + `5a8551b` (bump 0.7.3)
**完成时间**: 2026-05-17
**状态**: ✅ done

## 实现摘要

给 `/api/runtime/*` 加 localhost-only middleware（只读 socket.remoteAddress，完全弃用 XFF），CORS 从全开收紧到白名单（`http(s)://localhost:*` / `127.0.0.1:*`，echo back 不用 `*`），GET 非 localhost 时 `services.api.pid` / `services.workers.commit` / `repository.storageBytes` 三字段返回 null，POST/PUT/DELETE 非 localhost 直接 403。

## 文件变更

| 文件 | 改动 | 说明 |
|---|---|---|
| `apps/backend/src/lib/middleware/localhost-only.ts` | 新建 +37 | named export `localhostOnly: MiddlewareHandler`；`c.set("isLocalhost", boolean)` |
| `apps/backend/src/app.ts` | +14/-1 | CORS 白名单 `/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/`；`app.use("/api/runtime/*", localhostOnly)` |
| `apps/backend/src/routes/runtime.ts` | +11/-1 | services 显式注解 `RuntimeStatus["services"]`；`!isLocal` 分支清空 3 字段；`repositoryStats()` 返回类型同步改 nullable |
| `packages/shared/src/types.ts` | +2/-2 | `pid: number | null`；`storageBytes: number | null` |
| `apps/backend/src/routes/__tests__/runtime.acceptance.test.ts` | +174 | 7 case A-G：socket 全表 + XFF + IPv6 |

## 下游须知（T3 / T4 必读）

### Middleware 复用

`localhostOnly` 已挂到 `/api/runtime/*`，**所有后续在此前缀下的端点自动被保护**：
- T3 的 `POST /api/runtime/workers/{start,stop,reload}` → 非 localhost POST 自动 403，T3 **不需要**再加保护
- T4 的 `GET /api/runtime/workers/logs` / `GET /api/runtime/config` → 自动 GET 走脱敏（但 `c.get("isLocalhost")` 可用，T4 可根据需要在 handler 内再做敏感数据掩码）

### Shared Types 契约扩展

`RuntimeStatus.services.api.pid` 现为 `number | null`，`repository.storageBytes` 同。`packages/shared` 已 build；任何引用类型的消费者（web admin / Mac App）需重启 / 重 build 看到新形状。

**Mac App 注意**：Swift `RuntimeStatus.Services.ApiService` 当前若 `let pid: Int`，运行时仍工作（Mac App 总是 localhost，pid 永不为 null），但类型契约层不对齐，可考虑后续顺手改 `Int?`。

### REPO_ROOT 定位策略（设计文档承诺，T3 自行实现）

设计文档 ## 跨任务设计约束 中承诺的 `config.repoRoot = process.env.REPO_ROOT ?? path.resolve(process.cwd(), "../..")` **本任务未实现**（不在本任务范围内）。T3 实现 PM2 编排时必须自己在 `apps/backend/src/lib/config.ts` 添加该字段，并同步在 `ecosystem.config.cjs` env 中注入 `REPO_ROOT: process.cwd()`。

## 偏差说明

1. **brief 中提到的 hostname 脱敏**：实际现状 hostname 字段未出现在 `/api/runtime/status` 响应中（只在 Redis worker meta 内存里），本任务未涉及 hostname。设计文档已注明此项纠正
2. **commit 字段已是 `string | null`**：brief 列入 nullable 改动清单，但实际类型已是 nullable，未改动类型，只在脱敏分支保证清空
3. **acceptance test 新增 case 数比预估多**：brief 估 30~50 行，实际红队产出 174 行 7 case（覆盖更全：socket 全表 × method + XFF + IPv6 双形态），范围扩大但都在契约覆盖内

## QA 摘要

- Tier 0 acceptance: 15 passed | 5 skipped（含红队 7 case A-G 全过）
- Tier 1 shared typecheck ✅；backend typecheck 2 unrelated 预存 error（git stash 隔离验证）；biome 4/5 PASS（1 文件 OOM 工具问题）
- Wave 1.5 6 场景全 ✅（启 :4001 临时实例真实 curl 验证：本机完整 / 内网 IP 脱敏 / XFF 不读 / POST 403 字面契约 / CORS 白名单 + 拒绝 evil origin）
- Wave 2 qa-reviewer Section A 6/6 + Section B 无 OWASP 高置信度问题
- 用户审批通过

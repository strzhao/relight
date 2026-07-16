# 发布与运维 (Release & Ops)

> 从 decisions.md 和 patterns.md 拆分 | 父级索引: ../index.md

---

## 架构决策

### [2026-05-05] worktree 环境采用 sync 脚本 + postinstall 钩子，端口算法与插件字节级一致

<!-- tags: worktree, parallel-development, postinstall, port-allocation, bullmq-prefix, design -->

**Choice**: `scripts/sync-worktree-env.mjs` 用与插件字节级一致的哈希算法独立计算端口。BACKEND_PORT = devPort（4001-4999），WEB_PORT = devPort + 500。BullMQ 用 `bull-<branch>` prefix 隔离。

---

### [2026-06-02] macOS App 发布机制：GitHub Release + Homebrew cask tap；私有源码仓库做 brew 分发必须改公开

<!-- tags: release, github-actions, homebrew, cask, tap, xcodebuild, mac-app, distribution, private-repo, public, deployment, design -->

**关键决策**: Homebrew cask 的 `url` 必须匿名可下载，私有仓库 release 资产对匿名请求返回 404。用户选择把 relight 改为 public。

---

## 模式与教训

### [2026-05-07] PM2 reload 中断 in-flight job 是预期行为，配 retry-failed 工具是正确处理

<!-- tags: pm2, supervisor, bullmq, worker, kill-timeout, reload, sigkill -->

**Lesson**: 不要追求"reload 不丢 job"作为硬指标，应该追求"reload + retry-failed = eventual completion"。

---

### [2026-06-14] ESM 中 `__dirname` 不可用，必须用 `import.meta.url` 替代

<!-- tags: esm, __dirname, import.meta.url, fileURLToPath, nodejs -->

**Scenario**: 在 ESM 模块中使用 `__dirname` 抛出 `ReferenceError`。

**Lesson**: 替代模板：
```ts
import { fileURLToPath } from "node:url";
import path from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```

**Evidence**: `plugins/registry.ts` 用 `__dirname` 解析 CLI 路径 → PM2 ESM 模式 → `ReferenceError` → 所有聚类任务 failed。

---

### [2026-05-07] ESM 模块顶层 await 阻塞 vitest `await import()` → 测试 5s 超时

<!-- tags: vitest, esm, top-level-await, dynamic-import, redis, ioredis, worker, bug -->

**Fix**: 任何启动副作用都应 fire-and-forget：`writeWorkerMeta().catch(...)` 而非 `await writeWorkerMeta()`。

---

### [2026-06-02] PM2 app env 必须显式注入 process.env.PATH，否则 boot resurrect 时 spawn 子进程 ENOENT

<!-- tags: pm2, ecosystem, env, path, boot, resurrect, launchd, spawn, enoent, child-process, pnpm, ops, bug -->

**Fix**: 在 ecosystem 条目 `env` 里显式 `PATH: process.env.PATH`。交互式 `pm2 start` 时继承 shell 完整 PATH 看不出问题——只在重启/开机后暴露。

---

### [2026-06-02] headless CI 跑 xcodebuild 两坑：scheme 必须入库 shared + runner 默认 Xcode 太旧

<!-- tags: xcodebuild, ci, github-actions, shared-scheme, xcshareddata, xcode-version, macos-15, setup-xcode, swiftui, mac-app, release, bug -->

**Lesson**: mac App 的 CI 构建：(a) 务必把 scheme 入库为 shared；(b) 别信 runner 默认 Xcode，按 App 用到的 SDK/API 明确 pin Xcode 版本。

---

### [2026-05-19] 客户端硬编码端口反模式：常驻 web 端口冲突 → 走后端 RuntimeConfig 配置化

<!-- tags: port-allocation, web-port, hardcode, configuration, runtime-config, mac-app, openweb, swiftui, env, monorepo, worktree, ops, bug, anti-pattern -->

**正确模式**: 让后端通过 `/api/runtime/config` 暴露所有客户端要用的运行时参数，客户端 fetchConfig 后用，硬编码只作 fallback。端口分配纪律：3000 API / 3601 Web 常驻 / 4001-4999 worktree backend / 4501-5499 worktree web。

---

### [2026-07-16] Next.js 15.5 Turbopack 的 React Client Manifest 损坏（upstream #85883）→ PM2 守护 web 改 webpack，手动 dev 留 turbopack

<!-- tags: turbopack, next.js, pm2, ecosystem, webpack, client-manifest, global-error, buildmanifest-tmp, upstream-bug, dev-server, long-running, ops, bug -->

**Background**: web 首页 500，日志反复 `Could not find the module ".../next/dist/client/components/builtin/global-error.js#default" in the React Client Manifest`（连带 `boundary-components.js#MetadataBoundary`、`segment-explorer-node.js#SegmentViewNode`），伴随 `_buildManifest.js.tmp.XXX ENOENT` 竞态。是 Next.js 15.5.0+ Turbopack 已确认 upstream bug（vercel/next.js#85883）——Turbopack 重建 React Client Manifest 时异常，找不到 next 自身内置模块。常驻 PM2 进程（连跑 11 天）正是受害者。

**Choice**: `ecosystem.config.cjs` 的 `relight-web.args` 去掉 `--turbopack` → PM2 守护走稳定 webpack（不受此 bug 影响）。`apps/web/package.json` 的 `dev` 脚本保留 `--turbopack`，手动 `pnpm dev` 仍享快编译。改 args 必须 `pm2 delete relight-web && pm2 start ecosystem.config.cjs --only relight-web` + `pm2 save`——`pm2 reload` 不重读 ecosystem 的 args 变更；不 `pm2 save` 则开机 resurrect 回退旧 turbopack。

**Lesson**: 「PM2 长期守护的 dev」与「人手动短期跑的 dev」稳定性诉求不同——前者无人值守、崩了不可见，优先稳（webpack）；后者可随时重启、追快（turbopack）。两者用不同入口（ecosystem args vs package.json 脚本）精准隔离即可兼得。排查"manifest 找不到 next 内置模块"先排除缓存（`rm -rf .next` 无效即非单纯缓存）、next 包完整性（`.pnpm/next@*/dist/...` 文件物理存在）、多版本、磁盘/iCloud 干扰 `.tmp`——均正常即 Turbopack bug 本身，切 webpack 验证最快。

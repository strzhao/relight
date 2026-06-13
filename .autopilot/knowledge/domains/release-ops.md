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

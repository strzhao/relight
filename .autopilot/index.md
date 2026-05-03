# Knowledge Index

## Decisions
- [2026-05-01] 技术选型从通用最佳实践调整为用户 workspace 惯例 | tags: tech-stack, backend, orm, conventions, design | → decisions.md
- [2026-05-02] AI 分析质量验收采用纯规则自动化评分，非 AI 评估 AI | tags: ai, evaluation, testing, design | → decisions.md
- [2026-05-03] 队列监控实时推送选用 SSE 而非 WebSocket/轮询 | tags: sse, websocket, monitoring, realtime, design | → decisions.md

## Patterns
- [2026-05-01] pnpm 原生模块构建需在 package.json 中声明 onlyBuiltDependencies | tags: pnpm, native-modules, build | → patterns.md
- [2026-05-01] Vitest workspace 模式需在根级别安装 vitest | tags: vitest, monorepo, testing | → patterns.md
- [2026-05-01] Biome 1.9.4 使用 organizeImports 顶层键，非 assist | tags: biome, linting, config | → patterns.md
- [2026-05-02] BullMQ 重试配置在 Queue.defaultJobOptions 而非 Worker 构造函数 | tags: bullmq, queue, worker, retry | → patterns.md
- [2026-05-03] Hono streamSSE() 实现 BullMQ 队列实时监控推送 | tags: hono, sse, bullmq, monitoring, streaming | → patterns.md
- [2026-05-03] 健康端点系统指标采集采用嵌套 try-catch 降级 | tags: health, api, error-handling, nodejs, filesystem | → patterns.md
- [2026-05-03] 扫描进度 SSE 双数据源模式：DB scan_log + BullMQ job.progress | tags: sse, scan, bullmq, progress, sqlite, hono | → patterns.md
- [2026-05-03] 异步任务并发守护模式：SQLite 事务 + stale 阈值 | tags: concurrency, sqlite, bullmq, transaction, async-job | → patterns.md

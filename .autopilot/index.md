# Knowledge Index

## Decisions
- [2026-05-01] 技术选型从通用最佳实践调整为用户 workspace 惯例 | tags: tech-stack, backend, orm, conventions, design | → decisions.md
- [2026-05-02] AI 分析质量验收采用纯规则自动化评分，非 AI 评估 AI | tags: ai, evaluation, testing, design | → decisions.md
- [2026-05-04] photos 表使用复合 UNIQUE(storage_source_id, file_path) 而非单列 file_path | tags: database, unique-constraint, drizzle, schema-design | → decisions.md
- [2026-05-04] cleanupOrphans 必须在 listFiles 后、第一个提前返回前执行 | tags: backend, scan, architecture, orphan-cleanup, placement | → decisions.md
- [2026-05-04] 全屏照片查看器选择自定义 Lightbox 而非 Radix Dialog | tags: lightbox, radix-ui, dialog, frontend, a11y, design | → decisions.md

## Patterns
- [2026-05-01] pnpm 原生模块构建需在 package.json 中声明 onlyBuiltDependencies | tags: pnpm, native-modules, build | → patterns.md
- [2026-05-01] Vitest workspace 模式需在根级别安装 vitest | tags: vitest, monorepo, testing | → patterns.md
- [2026-05-01] Biome 1.9.4 使用 organizeImports 顶层键，非 assist | tags: biome, linting, config | → patterns.md
- [2026-05-02] BullMQ 重试配置在 Queue.defaultJobOptions 而非 Worker 构造函数 | tags: bullmq, queue, worker, retry | → patterns.md
- [2026-05-03] @tanstack/react-virtual sentinel 必须放在虚拟容器内部而非作为虚拟项 | tags: react, virtual-scroll, tanstack-virtual, frontend | → patterns.md
- [2026-05-04] IntersectionObserver 在 React 中的生命周期管理——避免级联加载循环 | tags: react, intersectionobserver, infinite-scroll, ref, useeffect, cascade | → patterns.md
- [2026-05-04] sharp 处理网络/SMB 挂载路径文件时先 readFile 读入 Buffer | tags: sharp, smb, network-path, seek-error, image-processing | → patterns.md
- [2026-05-04] macOS SMB 挂载持久化 — LaunchAgent 周期保活 + nsmb.conf 调优 | tags: macos, smb, nas, mount, launchagent, shell | → patterns.md
- [2026-05-04] HEIC 文件可能伪装：扩展名 .heic 实际为 JPEG 内容 | tags: heic, jpeg, content-detection, format-disguise, sharp | → patterns.md
- [2026-05-04] DB 与文件系统反向校验时需加安全阀防止存储断连误删 | tags: backend, scan, safety, orphan-cleanup, storage, nas | → patterns.md
- [2026-05-04] Biome a11y 规则豁免应使用 biome.json overrides 而非内联注释 | tags: biome, a11y, linting, config, lightbox | → patterns.md
- [2026-05-04] SSE 进度追踪使用 DB 轮询 + QueueEvents 双向更新模式 | tags: sse, bullmq, queue-events, progress, db-polling, pattern | → patterns.md
- [2026-05-04] Next.js rewrites 不转发 SSE 流，EventSource 必须直连后端 | tags: nextjs, sse, eventsource, proxy, rewrite, cors | → patterns.md

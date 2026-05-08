# Knowledge Index

## Decisions
- [2026-05-06] 视频 AI 分析采用多帧雪碧图 + Whisper 转录 + 视频专属 prompt | tags: video, ai-vision, whisper, sprite, ffmpeg, scene-cut, design, multi-modal | → decisions.md
- [2026-05-01] 技术选型从通用最佳实践调整为用户 workspace 惯例 | tags: tech-stack, backend, orm, conventions, design | → decisions.md
- [2026-05-02] AI 分析质量验收采用纯规则自动化评分，非 AI 评估 AI | tags: ai, evaluation, testing, design | → decisions.md
- [2026-05-04] photos 表使用复合 UNIQUE(storage_source_id, file_path) 而非单列 file_path | tags: database, unique-constraint, drizzle, schema-design | → decisions.md
- [2026-05-04] cleanupOrphans 必须在 listFiles 后、第一个提前返回前执行 | tags: backend, scan, architecture, orphan-cleanup, placement | → decisions.md
- [2026-05-04] 全屏照片查看器选择自定义 Lightbox 而非 Radix Dialog | tags: lightbox, radix-ui, dialog, frontend, a11y, design | → decisions.md
- [2026-05-04] DNG/RAW 使用 dcraw -e 提取嵌入 JPEG 预览而非 RAW 冲印 | tags: raw, dng, dcraw, ai-vision, image-processing, design | → decisions.md
- [2026-05-04] 格式门：AI 分析跳过不支持的格式用 return 而非 throw | tags: backend, bullmq, retry, format-gate, design | → decisions.md
- [2026-05-04] analyze-photo Worker concurrency 匹配 llama-server --parallel 槽位数 | tags: backend, bullmq, worker, concurrency, llama-cpp, performance | → decisions.md
- [2026-05-05] 每日精选采用两阶段 AI 流水线 — 文本评选 + 视觉叙事，最小化图片 token 成本 | tags: ai, daily-selection, cost-optimization, two-stage-pipeline, architecture | → decisions.md
- [2026-05-05] worktree 环境采用 sync 脚本 + postinstall 钩子，端口算法与插件字节级一致 | tags: worktree, parallel-development, postinstall, port-allocation, bullmq-prefix, design | → decisions.md
- [2026-05-05] 历史数据修复优先用一次性 SQL UPDATE 而非双路径 fallback | tags: database, migration, backfill, fallback, sql, design | → decisions.md
- [2026-05-07] 常驻 worker 进程必须把 git commit + uptime 暴露给观测层 | tags: worker, supervisor, observability, deployment, ops, design | → decisions.md

## Patterns
- [2026-05-06] DB file_path 可能是绝对路径时用 path.resolve 而非 path.join | tags: path, file-system, nas, smb, storage, route, bug | → patterns.md
- [2026-05-06] BullMQ Job mock 必须含 log/updateProgress 等接口方法 | tags: bullmq, vitest, mock, job, testing, integration | → patterns.md
- [2026-05-06] 视频 daily-selection 阶段 2 必须读 cover JPEG 而非整视频文件 | tags: video, daily-selection, sharp, oom, cover-frame, ai-vision, performance, design | → patterns.md
- [2026-05-06] Whisper CLI 必须从 outputDir/<stem>.json 文件读，绝不解析 stdout | tags: whisper, cli, child-process, json, stdout, ai, transcribe, bug | → patterns.md
- [2026-05-06] worktree symlink + lint-staged stash 失败 → skip-worktree 隐藏虚假 deletion | tags: worktree, lint-staged, husky, git, symlink, stash | → patterns.md
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
- [2026-05-05] HEIC 检测必须在 sharp resize 之前执行——sharp 预编译 libvips 不含 HEIC 解码 | tags: heic, sharp, image-processing, code-order, bug | → patterns.md
- [2026-05-05] qwen3 在 llama.cpp 上禁用思考模式必须用 chat_template_kwargs，thinking 字段是 vLLM 方言 | tags: qwen3, llama-cpp, thinking-mode, openai-api, ai, performance, bug | → patterns.md
- [2026-05-05] sharp resize 必须显式 withoutEnlargement: true，否则小图被放大反优化 | tags: sharp, image-resize, withoutEnlargement, ai-payload, code-quality, bug | → patterns.md
- [2026-05-04] 扫描收录与 AI 分析使用两层扩展名过滤，分离关注点 | tags: backend, scan, extension-filter, two-layer, separation-of-concerns | → patterns.md
- [2026-05-04] 非 HEIC 图片在 AI 视觉分析前用 sharp 缩小尺寸减少 payload | tags: ai, vision, sharp, image-resize, performance, base64 | → patterns.md
- [2026-05-05] Next.js dev server 不读 .env.local 的 PORT，必须靠包装脚本预注入 | tags: nextjs, dev-server, env-loading, port-binding, dotenv | → patterns.md
- [2026-05-05] pnpm workspace 子进程加载子包依赖时 cwd 必须在子包目录 | tags: pnpm, workspace, dotenv, child-process, node-modules-resolution | → patterns.md
- [2026-05-05] worktree 中 e2e 测试需切到不同端口启动 dev server，主仓库进程不会同步代码 | tags: worktree, e2e, playwright, nextjs, dev-server, port | → patterns.md
- [2026-05-07] ESM 模块顶层 await 阻塞 vitest `await import()` → 测试 5s 超时 | tags: vitest, esm, top-level-await, dynamic-import, redis, ioredis, worker, bug | → patterns.md
- [2026-05-07] PM2 reload 中断 in-flight job 是预期行为，配 retry-failed 工具是正确处理 | tags: pm2, supervisor, bullmq, worker, kill-timeout, reload, sigkill | → patterns.md
- [2026-05-07] xcodebuild ad-hoc 签名打包不能加 CODE_SIGNING_ALLOWED=NO | tags: xcodebuild, mac, code-signing, ad-hoc, hardened-runtime, gatekeeper, archive, bug | → patterns.md
- [2026-05-07] Release+Hardened Runtime+LSUIElement APP 的 stdout 在 terminal 调用时会被吞 | tags: macos, swiftui, hardened-runtime, lsuielement, stdout, release-build, debug-vs-release, code-signing | → patterns.md
- [2026-05-08] macOS App 行为异常先比 binary mtime vs 源码 mtime — DerivedData/build/dist/Applications 三路径独立易错位 | tags: macos, xcode, debug, derived-data, stale-build, swiftui, lsuielement, scene, debugging-pattern, bug | → patterns.md

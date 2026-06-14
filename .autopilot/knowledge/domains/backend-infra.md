# 后端基础设施 (Backend Infrastructure)

> 从 decisions.md 和 patterns.md 拆分 | 父级索引: ../index.md

---

## 架构决策

### [2026-05-04] cleanupOrphans 必须在 listFiles 后、第一个提前返回前执行

<!-- tags: backend, scan, architecture, orphan-cleanup, placement -->

**Choice**: 将 cleanupOrphans 放在 `adapter.listFiles()` 完成后、SHA256 去重之前。放在 try 块末尾会被两个 `return` 跳过。

---

### [2026-05-04] 格式门：AI 分析跳过不支持的格式用 return 而非 throw

<!-- tags: backend, bullmq, retry, format-gate, design -->

**Choice**: 格式门检查放在 AI 分析 Worker 入口，不支持的格式写入占位记录（`aiModel: "skipped"`）后 `return`（非 `throw`）。throw 会触发 BullMQ 重试机制浪费资源。

---

### [2026-05-04] analyze-photo Worker concurrency 匹配 llama-server --parallel 槽位数

<!-- tags: backend, bullmq, worker, concurrency, llama-cpp, performance -->

**Choice**: Worker concurrency 设为 2，直接匹配 llama-server 推理槽位数。

---

### [2026-05-07] 常驻 worker 进程必须把 git commit + uptime 暴露给观测层

<!-- tags: worker, supervisor, observability, deployment, ops, design -->

**Choice**: worker 启动时通过 ioredis 写入 `${prefix}:worker:meta` key（TTL 120s + 60s 心跳续期），value 包含 `{ commit, commitTime, startedAt, pid, hostname }`。

---

### [2026-06-02] 后端 API 纳入 PM2 开机自启：复用现有 resurrect launchd，仅 pm2 save

<!-- tags: pm2, ecosystem, launchd, resurrect, autostart, boot, backend-api, deployment, ops, mac-app, control-center, design -->

**关键洞察**: 用户机器上 `pm2-qwen.plist` 名为 qwen，实际 ProgramArguments 就是通用 `pm2 resurrect`。不需要再跑 `pm2 startup`——只要进程进了 `~/.pm2/dump.pm2`，现有 launchd 开机就会全部 resurrect。

---

## 模式与教训

### [2026-05-04] 扫描收录与 AI 分析使用两层扩展名过滤，分离关注点

<!-- tags: backend, scan, extension-filter, two-layer, separation-of-concerns -->

**Lesson**: `SCAN_EXTENSIONS`（扫描收录层，含所有格式）和 `AI_SUPPORTED_EXTENSIONS`（AI 分析层，仅含视觉模型可处理的格式）两层独立维护。

---

### [2026-05-04] DB 与文件系统反向校验时需加安全阀防止存储断连误删

<!-- tags: backend, scan, safety, orphan-cleanup, storage, nas -->

**Lesson**: 任何基于文件系统列表的反向校验必须加入安全阀：当孤儿比例超过阈值（>80%）且绝对数足够大（>50）时，跳过清理并发出告警。

---

### [2026-05-13] 批量危险脚本（清空/全量入队）必须 `--help` + `--yes` 二次确认

<!-- tags: cli, dangerous-operation, bullmq, queue, safety, dry-run, confirmation, batch-job, bug, ops -->

**Lesson**: 任何"清空 DB / 批量入队 / 全量重跑"的脚本必须：(1) `--help` 显式打印用法；(2) 危险默认值需 `--yes` 二次确认；(3) 打印 dry-run summary；(4) 清空前 JSON 备份。

### [2026-06-14] 扫描定时采用 BullMQ repeatable job 复用现有模式

<!-- tags: scan, cron, bullmq, scheduling, repeatable-job, design -->

**Background**: 扫描（scan-storage）之前完全依赖手动 API 触发，导致照片索引断档（最近一次扫描是 5 月 5 日，6 月新照片全未入库）。

**Choice**: 在 `app.ts` 中新增 `registerScanRepeatableJob()`，为每个启用的存储源注册 BullMQ repeatable job（cron `0 2 * * * Asia/Shanghai`），完全复用 `registerDailyRepeatableJob()` 的代码模式（import queue → add with repeat pattern → jobId 唯一 → index.ts 启动调用 + .catch 错误处理）。

**Alternatives rejected**: (1) 系统 cron / launchd — 引入新的调度层，与现有 BullMQ 基础设施不一致，且难以区分不同 storage source；(2) PM2 cron_restart — PM2 没有内建 cron，需借助 `--cron` 参数或外部脚本；(3) chokidar / fs.watch 文件监控 — NAS SMB 挂载不支持 fsevents，轮询开销大。

**Trade-offs**: 增量扫描依赖 SHA256 去重，每日扫描即使无新文件也需遍历全部文件列表（6549 个 `stat` + hash 比较），凌晨 2 点执行避免与 AI 分析任务（依赖 Qwen 推理槽位）和每日精选（0 点）冲突。

### [2026-06-14] 插件异步任务模式：POST 立即返回 + DB 状态轮询

<!-- tags: plugin, async-task, pattern, api-design, background-job, polling -->

**Background**: 插件执行耗时不确定（餐厅聚类 CLI 需 10-60s），API 不能同步等待。

**Choice**: POST `/api/plugins/:id/run` 立即创建 `plugin_tasks` 记录（status=running），返回 `{ taskId }`。`plugin.run()` 以 fire-and-forget 方式执行，完成后 UPDATE status=done/failed + 写入 result/error。前端轮询 `GET /api/plugins/:id/tasks/:taskId` 直到 status 终态。

**Trade-offs**: 优点：API 响应快、支持历史回溯、多个插件复用同一模式。缺点：轮询有延迟（前端 2s 间隔）、无实时推送（将来可加 SSE）。

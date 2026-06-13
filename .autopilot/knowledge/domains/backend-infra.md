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

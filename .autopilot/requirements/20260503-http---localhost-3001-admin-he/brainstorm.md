# Brainstorm — Health 页面完善与优化

## 目标
`http://localhost:3001/admin/health` 太简单了，继续完善和优化，需要知道当前相关运行的服务对设备的影响，避免设备出问题。

## Q&A 结果

### Q1: 视觉伴侣
**回答**: 不需要，直接讨论功能

### Q2: 设备监控范围
**回答**: 全部都要
- CPU + 内存使用率（系统 CPU 负载、Node 进程 heap/RSS）
- 磁盘空间（存储目录、数据库文件磁盘占用）
- 进程/服务运行状态（PID、启动时长、worker 存活状态）

### Q3: 本地运行的服务
**回答**: 全部四个服务
- 后端 API (Hono :3000)
- Worker 进程 (BullMQ: scan/analyze/daily)
- Redis 服务
- AI 服务 (本地 LLM，如 qwen)

### Q4: 刷新方式
**回答**: 手动刷新（保持现状的 RefreshButton）

### Q5: 实现方案
**回答**: 方案 A — 扩展端点 + 丰富展示

## 选定方案概要

**方案 A：扩展 `/api/admin/health` 端点 + 前端分组展示**

后端改动：
- 扩展 health 端点响应，新增 `system` 和 `disk` 字段
- 使用 `node:os` 获取 CPU 负载、系统/进程内存
- 使用 `process.uptime()` / `process.pid` / `process.version` 获取进程信息
- 使用 `fs.statfs` 或 du 获取磁盘占用

前端改动：
- 重新组织为三个分区：服务组件状态 | 设备资源 | 磁盘存储
- 新增资源使用率进度条/指示器组件
- 保持手动刷新

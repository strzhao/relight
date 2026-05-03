# 需求澄清 Q&A

## 用户目标

优化文件扫描过程的感知体验：
1. Dashboard（`/admin`）存储源卡片的「触发扫描」按钮去掉，将「查看详情」升级为主入口按钮
2. 存储源详情页（`/admin/storage-sources/[id]`）触发扫描后，实时展示扫描进度和文件状态

## Q1: 扫描进度的实时推送方式

**用户选择**: SSE 推送

**原因**: 相比轮询，SSE 实时性更好，项目中已有成熟的 SSE 推送模式（队列监控页面），可复用技术积累。

## Q2: 照片列表的实时更新方式

**用户选择**: 客户端轮询（3 秒间隔）

**原因**: 实现简单，不影响现有分页结构。照片新增不需要毫秒级实时性，3 秒足够。

## Q3: 整体技术方案

**用户选择**: 方案 A — 独立 SSE + 轮询

**具体内容**:
- 后端新增 `GET /api/scan/:id/events` SSE 端点，推送扫描进度
- scan-storage worker 中增加 `job.updateProgress()` 写入增量进度
- Dashboard: 删除 ScanTriggerButton，查看详情改成按钮样式
- detail page: 新增 ScanProgressPanel 客户端组件
- detail page: 照片列表改为客户端轮询自动刷新

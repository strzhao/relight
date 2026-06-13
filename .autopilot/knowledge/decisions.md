# 架构决策日志

> **已拆分** — 具体条目按领域迁移至 `domains/` 目录。
> 本文件保留为索引，指向各领域文件中的决策条目。

## 领域索引

- **[daily-selection](domains/daily-selection.md)** — 每日精选管线：候选池混采、主题去重、fillUp 回填、事件键去重、多条目升级
- **[face-recognition](domains/face-recognition.md)** — 人脸识别：ONNX/SCRFD/ArcFace 选型、语义属性聚类、多原型方案
- **[backend-infra](domains/backend-infra.md)** — 后端基础设施：扫描清理、格式门、Worker 并发、观测暴露、PM2 自启
- **[ai-prompt](domains/ai-prompt.md)** — AI 提示词工程：两阶段流水线、视频分析、narrate 软约束、纯规则评估
- **[image-processing](domains/image-processing.md)** — 图片处理：DNG/RAW、EXIF 解析、GPS 元数据、Satori 合成
- **[frontend](domains/frontend.md)** — 前端：Lightbox、双 tsconfig 拆分
- **[database](domains/database.md)** — 数据库：Schema 设计、迁移策略、技术选型
- **[release-ops](domains/release-ops.md)** — 发布与运维：Worktree 隔离、Homebrew 分发、PM2 部署

## 历史决策时间线

| 日期 | 决策 | 领域文件 |
|------|------|----------|
| 2026-06-02 | macOS App 发布机制 (GitHub Release + Homebrew) | [release-ops](domains/release-ops.md) |
| 2026-06-02 | 后端 API 纳入 PM2 开机自启 | [backend-infra](domains/backend-infra.md) |
| 2026-05-16 | 事件键前置去重替代 prompt 标题软约束 | [daily-selection](domains/daily-selection.md) |
| 2026-05-15 | fillUp 第 5 源触底回填 | [daily-selection](domains/daily-selection.md) |
| 2026-05-15 | narrate prompt 软约束 (recent_titles) | [ai-prompt](domains/ai-prompt.md) |
| 2026-05-15 | 撤销 narrate 命名人物注入 | [ai-prompt](domains/ai-prompt.md) |
| 2026-05-15 | self 标记用 settings.selfPersonId | [face-recognition](domains/face-recognition.md) |
| 2026-05-14 | Apple 多原型方案 (1-5 sub-prototype) | [face-recognition](domains/face-recognition.md) |
| 2026-05-13 | qwen 语义属性 + 临界硬过滤 | [face-recognition](domains/face-recognition.md) |
| 2026-05-12 | ONNX Runtime + SCRFD-500M + ArcFace 选型 | [face-recognition](domains/face-recognition.md) |
| 2026-05-11 | GPS+EXIF meta 14 列 + cluster GPS | [image-processing](domains/image-processing.md) |
| 2026-05-10 | top N 主题去重 + maxN 12 | [daily-selection](domains/daily-selection.md) |
| 2026-05-10 | 20 entries 全展示升级 | [daily-selection](domains/daily-selection.md) |
| 2026-05-10 | apps/web 双 tsconfig 拆分 | [frontend](domains/frontend.md) |
| 2026-05-09 | 4 源平等加权混采 | [daily-selection](domains/daily-selection.md) |
| 2026-05-08 | Satori + Resvg 壁纸合成 | [image-processing](domains/image-processing.md) |
| 2026-05-07 | Worker git commit + uptime 观测 | [backend-infra](domains/backend-infra.md) |
| 2026-05-06 | 视频 AI 多帧雪碧图 + Whisper | [ai-prompt](domains/ai-prompt.md) |
| 2026-05-05 | 两阶段 AI 流水线 | [ai-prompt](domains/ai-prompt.md) |
| 2026-05-05 | worktree sync 脚本 + postinstall | [release-ops](domains/release-ops.md) |
| 2026-05-05 | 历史数据 SQL UPDATE 修复 | [database](domains/database.md) |
| 2026-05-04 | 复合 UNIQUE(storage_source_id, file_path) | [database](domains/database.md) |
| 2026-05-04 | cleanupOrphans 执行位置 | [backend-infra](domains/backend-infra.md) |
| 2026-05-04 | 自定义 Lightbox 选型 | [frontend](domains/frontend.md) |
| 2026-05-04 | DNG/RAW dcraw -e 方案 | [image-processing](domains/image-processing.md) |
| 2026-05-04 | 格式门 return 非 throw | [backend-infra](domains/backend-infra.md) |
| 2026-05-04 | Worker concurrency 匹配 llama-server | [backend-infra](domains/backend-infra.md) |
| 2026-05-04 | EXIF TIFF 轻量解析器 | [image-processing](domains/image-processing.md) |
| 2026-05-02 | AI 纯规则自动化评分 | [ai-prompt](domains/ai-prompt.md) |
| 2026-05-01 | 技术选型调整为 workspace 惯例 | [database](domains/database.md) |

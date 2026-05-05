# 架构决策日志

### [2026-05-04] photos 表使用复合 UNIQUE(storage_source_id, file_path) 而非单列 file_path

<!-- tags: database, unique-constraint, drizzle, schema-design -->

**Background**: photos 表存在 668 组重复记录（同一存储源下相同 file_path 的多条记录）。需要添加 UNIQUE 约束防止后续扫描产生新重复。

**Choice**: 使用复合唯一约束 `UNIQUE(storage_source_id, file_path)` 而非单列 `UNIQUE(file_path)`。

**Alternatives rejected**:
- `UNIQUE(file_path)`: 过于严格——同一文件路径可能出现在多个存储源中（例如本地备份 + NAS 同步），不应阻止这种情况
- 仅靠应用层去重：不可靠，无法防止多 Worker 并发或手动插入导致重复

**Trade-offs**: 复合约束允许不同存储源有相同文件路径，但同一存储源内路径唯一。此约束同时保护了 `existingMap` 覆盖逻辑无法处理的并发场景。

**Evidence**: 清理后 `GROUP BY storage_source_id, file_path HAVING COUNT(*) > 1` 返回 0 行。重复插入测试被 SQLITE_CONSTRAINT 正确拦截。参见 `schema.ts:34-36`。

### [2026-05-01] 技术选型从通用最佳实践调整为用户 workspace 惯例
<!-- tags: tech-stack, backend, orm, conventions, design -->

**Background**: Q&A 阶段用户选择了"方案 A: Turborepo Monorepo (Fastify + Prisma + Prettier)"。在探索用户 workspace 后，发现用户近期项目一致使用 Hono + Drizzle + Biome。

**Choice**: 调整为 Hono (替代 Fastify)、Drizzle (替代 Prisma)、Biome (替代 Prettier)。

**Alternatives rejected**:
- Fastify：用户有 ai-team、raven-team 使用 Hono，无 Fastify 项目
- Prisma：用户 AI 类项目 (ai-team, ai-email) 首选 Drizzle，Prisma 仅用于儿童教育类项目
- Prettier：用户新项目统一用 Biome，减少工具链碎片

**Trade-offs**: 调整后与用户日常编码习惯一致，降低维护心智负担；但与 Q&A 原始记录存在偏差，需要在设计文档中明确标注变更理由。

### [2026-05-02] AI 分析质量验收采用纯规则自动化评分，非 AI 评估 AI
<!-- tags: ai, evaluation, testing, design -->

**Background**: 设计阶段最初考虑用另一个 AI 模型盲评照片分析结果的质量。Plan Reviewer 审查时指出循环验证风险——用 AI 评估 AI 的可靠性无法保证，且每次评估都消耗推理资源。

**Choice**: 改为 5 维度纯规则自动化评分（每维度 20 分，满分 100）：
1. 格式合规 — Zod schema 校验通过
2. 标签准确 — 7 类标签均有覆盖 + 无重复 + 置信度 0-1
3. 描述相关 — 中文字数 ≥50 + 非空有意义
4. 评分合理 — aestheticScore 1-10 + 子维度字段完整
5. 覆盖完整 — 8 个必填字段均有值

**Alternatives rejected**:
- AI 盲评：循环验证风险，不可复现，消耗推理资源
- 人工抽检：人力和时间成本高，不可规模化

**Trade-offs**: 纯规则只能验证格式和结构合规性，无法评估语义质量（如叙事是否生动、标签是否贴切）。语义质量仍需人工抽检或后续引入用户反馈闭环。但当前阶段格式合规是必要前提，且零成本、可复现、可 CI 集成。

### [2026-05-04] EXIF 解析选择轻量自研 TIFF 解析器，非第三方库
<!-- tags: exif, tiff, sharp, dependencies, design -->

**Background**: getMetadata 需要从照片 EXIF 提取 DateTimeOriginal。Sharp 已返回 `.exif` Buffer，但不解析具体 tag 值。需要选择解析方案。

**Choice**: 编写 ~60 行轻量 TIFF 解析器（`parseExifDateTimeOriginal`），直接解析 Sharp 返回的 EXIF Buffer，零额外依赖。

**Alternatives rejected**:
- `exifr`：功能完整但 +500KB，仅需一个日期字段是过度引入
- `exif-reader`：API 简单但未积极维护，且同样增加依赖
- 放弃 EXIF 仅用 mtime：丢失真实拍摄时间，AI 分析线索减少

**Trade-offs**: 自定义解析器仅支持 ASCII 字符串 tag（type=2），不支持 GPS、快门速度等复杂类型。当前够用——仅需 DateTimeOriginal；未来需要更多 EXIF 字段时，可渐进替换为 exifr。所有路径外有 try/catch 兜底，解析失败不阻塞扫描。

### [2026-05-04] cleanupOrphans 必须在 listFiles 后、第一个提前返回前执行

<!-- tags: backend, scan, architecture, orphan-cleanup, placement -->

**Background**: scanStorageWorker 有两个提前返回路径（无新文件 / 元信息全部失败）。如果 cleanupOrphans 放在 try 块末尾，当无新文件时清理永远不会执行。

**Choice**: 将 cleanupOrphans 放在 `adapter.listFiles()` 完成后、SHA256 去重之前。此时 `files` 数组已就绪，且尚未进入任何可能导致提前返回的逻辑。

**Alternatives rejected**:
- 放在 try 块末尾：被两个 `return` 跳过，清理永远不会触发
- 独立 cron/定时任务：需要额外的文件列表 I/O，且与扫描异步可能导致竞态
- 在 listFiles 之前执行：此时没有文件列表，需要额外调用 listFiles

**Trade-offs**: 扫描流程中嵌入清理增加了一次 DB 查询的开销（每个存储源一次 SELECT + 可能的 DELETE），但利用已有的 `files` 数组零额外 I/O。清理失败不阻断扫描（try/catch 包裹）。安全阀（>50 且 >80% 跳过）防止 NAS 断连误删。

**Evidence**: 代码审查确认 `cleanupOrphans` 在第 108 行调用，第一个提前返回在第 138 行。29 个验收测试通过。参见 `scan-storage.ts:108-111`。

### [2026-05-04] 全屏照片查看器选择自定义 Lightbox 而非 Radix Dialog

<!-- tags: lightbox, radix-ui, dialog, frontend, a11y, design -->

**Background**: photos 页面需要大图查看器（Lightbox）— 全屏遮罩、原始尺寸图片、缩放/平移/翻页。需要选择一个对话框基础组件。

**Choice**: 自定义 Lightbox 组件（`components/ui/lightbox/`），使用 Context + Provider 组合式架构，纯 CSS transform 实现缩放/平移。自行实现无障碍（`role="dialog" aria-modal="true"` + 焦点管理 + body scroll lock）。

**Alternatives rejected**:
- Radix Dialog：有 `max-h` 限制，focus trap 行为与全屏图片查看场景冲突（需要图片区域自由接收键盘/滚轮事件），且额外的 Portal 层增加 DOM 复杂度
- 第三方 Lightbox 库（yet-another-react-lightbox 等）：引入额外依赖，定制能力受限，且不支持后端原始图端点

**Trade-offs**: 自行实现增加约 300 行代码（6 个组件文件），但获得完全控制权——缩放范围 0.5x-5x 自由设定、与后端 original 端点直接集成、信息面板按需加载等。需手动处理焦点陷阱（当前已知限制）。

**Evidence**: 6 个 Lightbox 组件文件（index + context + image + controls + info + keys），Biome 豁免 `useSemanticElements` 规则用于 lightbox 目录。QA 设计符合性审查 6/6 维度通过。

### [2026-05-04] DNG/RAW 使用 dcraw -e 提取嵌入 JPEG 预览而非 RAW 冲印

<!-- tags: raw, dng, dcraw, ai-vision, image-processing, design -->

**Background**: 支持 DNG/RAW 格式的 AI 分析，需要将 RAW 数据转为 AI 视觉模型可接受的 JPEG。

**Choice**: 使用 `dcraw -e -c` 提取相机内嵌的 JPEG 预览，而非 `dcraw -w -T` 进行 RAW 冲印。

**Alternatives rejected**:
- RAW 冲印（demosaic + 白平衡 + 色彩空间转换）：需要大量参数调优，像素级处理 <2s/张 但在多张并发时 CPU 压力大，且相机内嵌预览已是制造商精心处理的结果
- sharp/ImageMagick 直接解码 DNG：DNG 嵌入预览使用 lossless JPEG 编码（SOF3），sharp 底层 libvips/ImageMagick 均不支持解码此变体

**Trade-offs**: 嵌入预览分辨率取决于相机设置（通常是全分辨率），质量已足够 AI 分析（美学评分、构图、色彩）。dcraw 无原生 macOS ARM 二进制，需通过 Homebrew 安装（`/opt/homebrew/bin/dcraw`）。

**Evidence**: `dcraw -e -c IMGP5072.DNG` 输出 4928×3264 JPEG (1.4MB)，sharp resize 到 2048px 后 612KB。单张处理 <1s。

### [2026-05-04] 格式门：AI 分析跳过不支持的格式用 return 而非 throw

<!-- tags: backend, bullmq, retry, format-gate, design -->

**Background**: 视频文件（.mp4/.mov 等）入队 AI 分析后因 MIME 类型不合法导致失败，BullMQ 自动重试 3 次浪费资源。需要一个机制快速跳过不支持的格式。

**Choice**: 格式门检查放在 AI 分析 Worker 入口（读取文件之前），不支持的格式写入 `photoAnalyses` 占位记录（`aiModel: "skipped"`）后 `return`（非 `throw`）。

**Alternatives rejected**:
- 在入队前过滤：需要额外查询，且无法防御路径扩展名变更
- `throw` 异常：会触发 BullMQ 重试机制（3 次 exponential backoff），浪费 Worker 资源
- 不写占位记录：下次扫描会重新入队，造成无限循环

**Trade-offs**: 占位记录占用 photoAnalyses 表空间，但提供了幂等性保证。格式判断使用扩展名而非文件内容 magic bytes，极端情况下可能误判（但视频文件扩展名通常可靠）。

**Evidence**: 1123 个视频文件（709 DNG + 414 视频）此前因格式问题反复重试失败。格式门上线后写入 `skipped` 记录，后续扫描不再重复入队。

### [2026-05-04] analyze-photo Worker concurrency 匹配 llama-server --parallel 槽位数

<!-- tags: backend, bullmq, worker, concurrency, llama-cpp, performance -->

**Background**: AI 图片分析速度极慢（~1/min），M4 Max 128GB 资源大部分闲置。llama-server 部署时已配置 `--parallel 2`（2 个推理槽位），但 analyze-photo Worker 使用默认 concurrency=1，一次只处理一张照片。

**Choice**: Worker concurrency 设为 2，直接匹配 llama-server 推理槽位数。

**Alternatives rejected**: 更高并发（4-8）被拒绝，因为 llama-server 只有 2 个 slot，更高的 Worker 并发会导致任务排队在推理服务端，不会增加吞吐量。

**Trade-offs**: concurrency=2 从 1 开始保守，后续如 llama-server --parallel 调高可同步增加。

### [2026-05-05] 每日精选采用两阶段 AI 流水线 — 文本评选 + 视觉叙事，最小化图片 token 成本
<!-- tags: ai, daily-selection, cost-optimization, two-stage-pipeline, architecture -->

**Background**: 每日精选需要 AI 从多张候选照片中选出最佳并生成标题文案。直接将所有照片发送给视觉模型会消耗大量 token（每张照片 base64 可达 300KB+）。

**Choice**: 两阶段流水线：阶段 1 用 `aiClient.chat()` 文本模型比较候选照片已有 AI 分析结论（aestheticScore + emotionalAnalysis + tags），选出胜者（零图片 token）；阶段 2 仅对胜者用 `aiClient.analyzePhoto()` 视觉模型生成怀旧标题和精简文案（只发 1 张图片）。

**Alternatives rejected**: 纯视觉评选（20 张 x 300KB token 成本高、跨图比较不准确）；纯规则评分（缺少 AI 对情感共鸣判断）；本地预筛选（增加规则复杂度，收益不大）。

**Trade-offs**: 阶段 1 准确性依赖已有 AI 分析质量。复用已有结论远优于重新发图。候选上限 20 张控制 prompt 长度。

**Evidence**: prompt 文件 `v2/daily/select/` + `v2/daily/narrate/`，worker 实现 `jobs/daily-selection.ts:99-178`。

### [2026-05-05] worktree 环境采用 sync 脚本 + postinstall 钩子，端口算法与插件字节级一致

<!-- tags: worktree, parallel-development, postinstall, port-allocation, bullmq-prefix, design -->

**Background**: `claude code -w` 创建 worktree 后服务起不来——端口（backend 3000 / web 3001）硬编码撞主仓库、主仓库无 `.env` 让 string-claude-code-plugin 的自动 symlink 找不到东西可链、BullMQ 全用默认 Redis DB 0 导致 worktree workers 抢主仓库任务。

**Choice**: 在 relight 工程内实现 `scripts/sync-worktree-env.mjs`，用与插件 `worktree.mjs:computePort()` **字节级一致** 的哈希算法（`h = (h * 31 + char) >>> 0; 4001 + h % 999`）独立计算端口，**不依赖** 插件的 `local-config.json`。BACKEND_PORT = devPort（4001-4999），WEB_PORT = devPort + 500（4501-5499）。BullMQ 用 `bull-<branch>` prefix 隔离。通过根 `package.json` 的 `postinstall` 钩子触发，`worktree:setup` 提供手动入口修复已有 worktree。

**Alternatives rejected**:
- 修改 string-claude-code-plugin 让它写更多端口字段：plugin 是通用工具，不应嵌入 relight 专属逻辑
- 依赖 plugin 写的 `local-config.json` 提取端口：plugin 在 `pnpm install`（触发 postinstall）**之后** 才写该文件，时序错位会导致 sync 脚本读不到
- Redis DB 编号隔离（0-15）：上限太低，不便扩展，也不如 prefix 可读
- 共享 Redis 队列：worktree workers 会抢主仓库的真实任务，破坏"真实验证"语义

**Trade-offs**: 端口算法重复实现是技术债（如果插件改算法需同步），但插件算法 30 年内不太可能动；prefix 用分支名可读但需归一化（`/` → `-`）。

**Evidence**: 实测 6/6 真实场景通过——主仓库 :3000 + worktree :4363/:4014 三端口共存；Redis 三个独立 prefix `bull` / `bull-main` / `bull-worktree-...`，主仓库 36927 条任务 keys 不被 worktree workers 触碰。Commit f8dc0df。

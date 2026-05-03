# 架构决策日志

### [2026-05-03] 缩略图缓存策略：短 TTL + ETag
<!-- tags: thumbnail, cache, etag, performance -->

**Background**: 缩略图 API 原来 `max-age=86400`（24h），forceRegenerate 重新生成缩略图后浏览器仍使用旧缓存，用户看不到更新。

**Choice**: `max-age` 从 86400 降到 3600（1h），新增基于文件 mtime 的 ETag 头支持条件请求（304 Not Modified）。

**Alternatives rejected**: 
- URL 版本号（`?v=timestamp`）：需要修改所有调用方，侵入性强
- `no-cache`：每个请求都回源，浪费带宽

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

### [2026-05-03] 队列监控实时推送选用 SSE 而非 WebSocket/轮询
<!-- tags: sse, websocket, monitoring, realtime, design -->

**Background**: admin/queues 页面需要实时展示队列状态。评估了三种方案：WebSocket（双向长连接）、纯轮询（5s interval fetch）、SSE（单向推送）。

**Choice**: 选用 SSE (Server-Sent Events)，per-queue 独立 EventSource 连接，3 秒推送一次快照。

**Alternatives rejected**:
- WebSocket：BullMQ 支持 QueueEvents 的 WebSocket 推送，但需要额外服务端库（如 `@bull-board/ws`）且前端需维护双向连接。监控场景只需后端→前端单向数据流，WebSocket 是过度设计。
- 纯轮询：侧边栏 5s 轮询 GET /api/queues 已满足列表更新需求。但详情面板的作业列表需要更低延迟，3s SSE 推送可以让用户感知到"实时"而无需每 3 秒发送 HTTP 请求。
- 混合方案（侧边栏轮询 + SSE 详情面板）：最终选择此方案——侧边栏轻量轮询减少连接数，详情面板 SSE 推送保证实时性。断开时 EventSource 自动重连，无需额外恢复逻辑。

**Trade-offs**: SSE 在多个浏览器 tab 打开时会创建多条连接，当前无连接数限制。后续可添加 `maxConnections` 限制或切换为单条 broadcast SSE 通道。Hono `streamSSE()` 是 HTTP 长连接，某些反向代理可能需要配置禁用缓冲。

### [2026-05-03] AI 分析不再由扫描自动触发，改为外部显式控制
<!-- tags: ai, analysis, scan, trigger, design -->

**Background**: 当前 AI 视觉模型（qwen3.6-35b）分析效果尚不理想，自动触发会产生大量低质量结果并浪费推理资源。用户需要先优化提示词和模型参数，再批量重跑分析。

**Choice**: 移除 scan-storage worker 中的 `analyzeQueue.add()` 调用，AI 分析改由外部显式触发（后续单独设计触发入口）。`ScanJobData.skipAnalysis` 字段保留但不再生效。

**Alternatives rejected**:
- 保留 `skipAnalysis` 标志控制：默认跳过分析需要每次扫描都传参，且 API 设计上"扫描"与"分析"耦合不清晰
- 环境变量开关：只能在部署级别控制，粒度太粗

**Trade-offs**: 完全移除自动触发意味着每次新增照片后需手动触发分析。在分析质量稳定之前这是合理的，但后续需要配套设计批量触发/定时触发机制。

# 架构决策日志

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

### [2026-05-03] 系统 CLI 委托 + sharp 两步转换处理不支持图像格式
<!-- tags: heic, sharp, heif-convert, image-processing, backend, design, thumbnail -->

**Background**: sharp 预编译二进制不含 HEIC/HEIF 解码器，用户上传的 iPhone 照片（.heic）无法生成缩略图，导致照片管理页面展示失败。

**Choice**: 不在 sharp 层解决 HEIC 解码，采用系统 CLI `heif-convert`（libheif）做预处理 → 输出临时 JPEG → sharp 做缩放/编码。运行时检测 CLI 可用性，结果缓存。

**Alternatives rejected**:
- sharp 源码构建 + heif：破坏 pnpm 预编译缓存，CI 环境复杂
- WASM npm 包（heic-convert/heic-decode）：~2MB 包体，大文件性能差，维护不确定
- sharp 直接解码：作为首选路径保留，HEIC 仅在不支持时走两步转换

**Trade-offs**: 依赖系统预装 libheif（macOS `brew install libheif`），生产环境需在 Dockerfile/Dockerfile.prod 中添加 `RUN apt-get install -y libheif`。零新 npm 依赖，快速 C 实现，<30s 超时控制。

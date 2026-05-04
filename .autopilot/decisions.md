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

### [2026-05-04] EXIF 解析选择轻量自研 TIFF 解析器，非第三方库
<!-- tags: exif, tiff, sharp, dependencies, design -->

**Background**: getMetadata 需要从照片 EXIF 提取 DateTimeOriginal。Sharp 已返回 `.exif` Buffer，但不解析具体 tag 值。需要选择解析方案。

**Choice**: 编写 ~60 行轻量 TIFF 解析器（`parseExifDateTimeOriginal`），直接解析 Sharp 返回的 EXIF Buffer，零额外依赖。

**Alternatives rejected**:
- `exifr`：功能完整但 +500KB，仅需一个日期字段是过度引入
- `exif-reader`：API 简单但未积极维护，且同样增加依赖
- 放弃 EXIF 仅用 mtime：丢失真实拍摄时间，AI 分析线索减少

**Trade-offs**: 自定义解析器仅支持 ASCII 字符串 tag（type=2），不支持 GPS、快门速度等复杂类型。当前够用——仅需 DateTimeOriginal；未来需要更多 EXIF 字段时，可渐进替换为 exifr。所有路径外有 try/catch 兜底，解析失败不阻塞扫描。

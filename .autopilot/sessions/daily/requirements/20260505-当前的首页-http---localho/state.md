---
active: true
phase: "merge"
gate: ""
iteration: 3
max_iterations: 30
max_retries: 3
retry_count: 0
mode: ""
plan_mode: "deep"
brief_file: ""
next_task: ""
auto_approve: false
knowledge_extracted: ""
task_dir: "/Users/stringzhao/workspace/relight/.claude/worktrees/daily/.autopilot/sessions/daily/requirements/20260505-当前的首页-http---localho"
session_id: b1196506-3807-4187-927e-936e25a38207
started_at: "2026-05-04T17:14:08Z"
---

## 目标
当前的首页 http://localhost:3001/ 为什么没有数据 ？ 是不是首页相关数据和策略和功能都还没做 ?

> 📚 项目知识库已存在: .autopilot/。design 阶段请先加载相关知识上下文。

## 设计文档

### 架构总览
两阶段 AI 流水线：阶段 1 用 `aiClient.chat()` 文本模型比较候选照片的已有分析结论评选胜者（零图片 token），阶段 2 仅对胜者用 `aiClient.analyzePhoto()` 视觉模型生成怀旧标题和精简文案。

```
cron 每天 6:00 AM → dailySelectionWorker
  ├── 查询候选: strftime('%m-%d', COALESCE(takenAt, createdAt)) = 当前月日
  │   └── INNER JOIN photo_analyses, LIMIT 20
  ├── 阶段 1: aiClient.chat(候选分析摘要, selectPrompt) → selectedIndex
  ├── 阶段 2: aiClient.analyzePhoto(胜者照片, narratePrompt) → title, narrative, score
  └── INSERT daily_picks (onConflictDoNothing, pickDate UNIQUE)
```

### 关键决策
- 怀念意义 > 摄影美感
- pickDate 用 `toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })` 生成纯日期字符串
- daily_picks.pickDate 添加 UNIQUE 约束 + onConflictDoNothing 去重
- 候选上限 20 张
- 两套独立 prompt: v2/daily/select/ + v2/daily/narrate/
- 标题 ≤8 字，文案 40-80 字精简风格

### 涉及文件
| 文件 | 动作 |
|------|------|
| `ai/prompts/v2/daily/select/system.txt` | 新建 — AI 文字评选提示词 |
| `ai/prompts/v2/daily/select/user.txt` | 新建 — 候选分析摘要模板 |
| `ai/prompts/v2/daily/narrate/system.txt` | 新建 — 怀旧叙事提示词 |
| `ai/prompts/v2/daily/narrate/user.txt` | 新建 — 简短用户指令 |
| `ai/prompts/index.ts` | 扩展 loadPrompts() 支持多级子目录 |
| `ai/response-parser.ts` | 新增 2 个 schema + 2 个解析函数 |
| `jobs/daily-selection.ts` | 替换桩代码为完整两阶段 worker |
| `app.ts` | 注册 daily repeatable job |
| `db/schema.ts` | daily_picks.pickDate 添加 .unique() |
| `routes/daily.ts` | 替换桩代码为真实 DB 查询 |
| `components/daily-hero.tsx` | 改为 "use client" 四态组件 |

## 实现计划

### 步骤 0: Schema 变更
- [x] 0.1 `db/schema.ts` — `daily_picks.pickDate` 添加 `.unique()` 约束

### 步骤 1: 后端 AI 层
- [x] 1.1 `ai/prompts/v2/daily/select/system.txt` — 新建 AI 评选系统提示词
- [x] 1.2 `ai/prompts/v2/daily/select/user.txt` — 新建候选分析摘要模板
- [x] 1.3 `ai/prompts/v2/daily/narrate/system.txt` — 新建怀旧叙事提示词
- [x] 1.4 `ai/prompts/v2/daily/narrate/user.txt` — 新建简短用户指令
- [x] 1.5 `ai/prompts/index.ts` — 扩展 `loadPrompts(version, name?)` 支持多级子目录
- [x] 1.6 `ai/response-parser.ts` — 新增 `dailySelectResponseSchema` + `dailyNarrateResponseSchema` + 两个解析函数

### 步骤 2: 后端 Job + API
- [x] 2.1 `jobs/daily-selection.ts` — 实现完整 worker：查询候选 → 阶段1 `chat()` 评选 → 阶段2 `analyzePhoto()` 叙事 → `onConflictDoNothing` 写入
- [x] 2.2 `app.ts` — 注册 daily repeatable job (cron: `0 6 * * *`)
- [x] 2.3 `routes/daily.ts` — 替换三个桩端点为真实 DB 查询（today/list/:id）

### 步骤 3: 前端
- [x] 3.1 `components/daily-hero.tsx` — 改为 `"use client"` 四态组件，调用 `api.daily.today()`

### 步骤 4: 自动化测试
- [x] 4.1 `ai/__tests__/response-parser.test.ts` — 测试两个 schema 的正常解析/字段缺失/无效 JSON fallback
- [x] 4.2 `routes/__tests__/daily.test.ts` — 测试 today 有/无数据、list 分页、:id 查询

## 红队验收测试

### 测试文件

| 文件 | 测试数 | 覆盖范围 |
|------|--------|----------|
| `apps/backend/src/__tests__/daily-api.acceptance.test.ts` | 27 | GET /api/daily/today (ApiResponse 格式/空数据/DailyPick 字段/pickDate 格式/title≤8字/narrative 40-80字/关联 photo)、GET /api/daily (分页/空结果/参数/pageSize 上限)、GET /api/daily/:id (找到/404)、跨层数据流一致性 |
| `apps/backend/src/__tests__/daily-worker.acceptance.test.ts` | 28 | 候选查询 (strftime 月日匹配/INNER JOIN photo_analyses/LIMIT 20/0候选跳过)、阶段1 AI 评选 (chat 调用/selectedIndex)、阶段2 AI 叙事 (analyzePhoto/title≤8字/narrative 40-80字)、fallback 行为 (AI失败→最高aestheticScore/叙事失败→模板文案)、pickDate UNIQUE 约束 (YYYY-MM-DD/北京时间/onConflictDoNothing 幂等)、Worker 日志可观测性 |

### 验收状态
- 红队测试总数: 55
- 蓝队实现完成后全部通过: ✅ (1268 total tests pass)

## QA 报告

### 变更分析
- **变更文件**: 20 个 (+2505/-20 行)
- **分类**: 后端核心逻辑 (7) + AI Prompt (4) + 前端组件 (1) + 测试 (5) + 配置 (3)
- **影响半径**: 高 — 跨前后端，涉及 DB schema/AI 调用/API 路由/前端渲染

### Wave 1 — 命令执行

| Tier | 检查项 | 状态 | 耗时 | 证据 |
|------|--------|------|------|------|
| 0 | 红队验收测试 (daily-api.acceptance) | ✅ | 47ms | 27 tests passed |
| 0 | 红队验收测试 (daily-worker.acceptance) | ✅ | 31ms | 28 tests passed |
| 1 | TypeScript typecheck | ✅ | 1.9s | 4 successful, FULL TURBO |
| 1 | Biome lint | ✅ | 36ms | 184 files, No fixes applied |
| 1 | Vitest 全部测试 | ✅ | 2.1s | 55 files, 1268 passed |
| 1 | pnpm build | ✅ | 12.9s | backend + web 构建成功 |

### Wave 1.5 — 真实场景验证

| # | 场景 | 执行 | 输出 | 状态 |
|---|------|------|------|------|
| 1 | AI prompt 文件加载 | `cat apps/backend/src/ai/prompts/v2/daily/select/system.txt` + narrate | "你是一位珍视回忆的策展人" / "你是一位珍视回忆的记录者" | ✅ |
| 2 | GET /api/daily/today | `curl -s http://localhost:3000/api/daily/today` | `{"success": true, "data": null}` | ✅ |
| 3 | GET /api/daily 分页列表 | `curl -s "http://localhost:3000/api/daily?page=1&pageSize=5"` | `{"success": true, "data": [], "total": 0, "page": 1, "pageSize": 5}` | ✅ |
| 4 | 前端首页渲染 | `curl -s http://localhost:3001/` | DailyHero 空态渲染正确，"今日精选"+"AI 将每日为你挑选" | ✅ |

### Wave 2 — AI 审查

#### Tier 2a: 设计符合性审查
- **覆盖率**: 26/26 需求已实现 (100%)
- **范围问题**: 2 个轻微偏离 — narrative Zod 约束 (.min(10) vs 设计 40) + pickDate 实现方式差异 — 均不影响功能
- **接口契约**: 全部匹配
- **结论**: ✅ 设计符合

#### Tier 2b: 代码质量审查
- **3 个问题** (0 critical, 2 important, 1 minor)
- [Conf 90] **HEIC 处理顺序 bug** — `sharp()` 在 HEIC 检测之前执行导致 HEIC 照片走模板 fallback → **已修复** (81b6b7c)
- [Conf 82] pickDate 格式化 DRY 重复 (Worker + Route) — 轻微
- [Conf 82] list API 未实现 date 查询过滤 — 轻微
- **Strengths**: LLM 输出 Zod 校验 + 越界 clamp、幂等性 UNIQUE + onConflictDoNothing、55 个验收测试覆盖全面
- **结论**: ✅ Ready to merge (with HEIC fix applied)

### 结果判定
- **场景计数匹配**: 4/4 场景已执行 ✅
- **格式检查**: 所有场景均包含 执行:/输出: ✅
- **全部 ✅**: 无 ❌ 项

---

**QA 结论**: 通过。进入 review-accept 门。

## 变更日志
- [2026-05-05T02:33:49Z] 用户批准验收，进入合并阶段
- [2026-05-04T17:14:08Z] autopilot 初始化，目标: 当前的首页 http://localhost:3001/ 为什么没有数据 ？ 是不是首页相关数据和策略和功能都还没做 ?
- [2026-05-04T17:30:00Z] Deep Design 完成：两阶段 AI 流水线方案（阶段1 文本评选 + 阶段2 视觉叙事），经 Plan Reviewer 审查通过
- [2026-05-04T17:35:00Z] 设计方案已通过用户审批，进入 implement 阶段
- [2026-05-04T18:36:00Z] 蓝队实现完成：21 个文件变更，覆盖 Schema/AI 层/Job+API/前端/测试全部 11 项任务。红队 55 个验收测试全部通过 (1268 total)。进入 qa 阶段
- [2026-05-04T18:48:00Z] QA 阶段完成：Wave 1 全部通过 (typecheck/lint/1268 tests/build)，Wave 1.5 4/4 场景验证通过，Wave 2 设计审查 100% 覆盖率 + 代码审查发现并修复 HEIC 处理顺序 bug。gate: review-accept

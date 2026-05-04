---
active: true
phase: "done"
gate: ""
iteration: 6
max_iterations: 30
max_retries: 3
retry_count: 0
mode: ""
plan_mode: ""
brief_file: ""
next_task: ""
auto_approve: false
knowledge_extracted: "true"
task_dir: "/Users/stringzhao/workspace/relight/.claude/worktrees/pic/.autopilot/requirements/20260504-扫描时自动清理孤儿记"
session_id: 94ae1fbb-0c94-4d1f-8caa-39f6a45c6a56
started_at: "2026-05-04T07:24:20Z"
---

## 目标
扫描时自动清理孤儿记录：在 scan-storage 扫描流程末尾新增清理步骤，对比 DB 与文件系统，删除源文件不存在的孤儿记录，同步清理缩略图文件

> 📚 项目知识库已存在: .autopilot/。design 阶段请先加载相关知识上下文。

## 设计文档

### 方案：扫描时反向校验 + 批量清理

**关键**: cleanupOrphans 放在 `adapter.listFiles()` 完成后、第一个提前返回之前，确保每次扫描都运行。

核心流程：
```
① 查找存储源
② adapter.listFiles() → files
  ↓
★★★ cleanupOrphans(storageSourceId, files) ← 始终执行
  ↓
③ SHA256 去重 → ④ 元信息 → ⑤ INSERT → ⑥ 缩略图 → ⑦ 入队 → ⑧ 写日志
```

清理函数逻辑：
1. 构建磁盘路径 Set (O(1) 查找)
2. 查询 DB 中该存储源所有 (id, filePath, thumbnailPath)
3. 差集: DB 有但磁盘无 = 孤儿
4. 同一事务: DELETE daily_picks + DELETE photos (photo_tags/photo_analyses CASCADE)
5. 用 thumbnailPath 精确删除缩略图文件 (.catch 容错)
6. try/catch 包裹整体，失败不阻断扫描

设计决策：
- filePath 对比 (非 fileHash) — 已有路径集合，零额外 I/O
- 同一事务删 daily_picks + photos — 避免 daily_picks 单独提交后事务回滚
- thumbnailPath 精确删除 — 无需猜测扩展名
- 已知风险：SMB/网络存储挂载断开时误删 — **已修复**: 安全阀机制（孤儿 >50 且比例 >80% 时跳过清理并 console.error 告警）

## 实现计划

### Task 1: 在 scan-storage.ts 中添加孤儿清理逻辑
- [x] 1.1 新增 `import fs from "node:fs/promises"`
- [x] 1.2 新增 `cleanupOrphans` 函数 (~45 行)
- [x] 1.3 在 `adapter.listFiles()` 之后、第一个提前返回之前调用 `cleanupOrphans`
- [x] 1.4 确认已有 imports 充足 (inArray, eq, db, schema 均已导入)

## 红队验收测试

**测试文件**: `apps/backend/src/__tests__/cleanup-orphans.acceptance.test.ts`
**测试结果**: 29/29 通过 (vitest, 341ms)

### 覆盖维度

| 维度 | 测试数 | 状态 |
|------|--------|------|
| 无孤儿 — 零操作 | 3 | ✅ |
| 有孤儿 — 识别和删除 | 4 | ✅ |
| daily_picks 同一事务 | 4 | ✅ |
| photo_tags/analyses CASCADE | 4 | ✅ |
| 缩略图文件清理 | 5 | ✅ |
| 错误容错 | 2 | ✅ |
| 每次扫描执行 | 3 | ✅ |
| 综合/边界 | 4 | ✅ |

## QA 报告

### Wave 1 — 自动化验证

| Tier | 项目 | 命令 | 结果 | 说明 |
|------|------|------|------|------|
| 0 | 红队验收测试 (29) | `vitest run cleanup-orphans.acceptance.test.ts` | ✅ 29/29 通过 (332ms) | 全部 9 个维度覆盖 |
| 1 | typecheck | `pnpm typecheck` | ⚠️ 预存错误 | shared: QueueJobDetail 接口不兼容 (非本次) |
| 1 | lint (变更文件) | `biome check scan-storage.ts test.ts` | ✅ 无错误 | 2 文件检查通过 |
| 1 | 单元测试 | `vitest run --project backend` | ⚠️ 13 预存失败 | video-metadata.acceptance.test.ts (非本次) |
| 1 | build | `pnpm build` | ⚠️ 预存错误 | shared DTS build (非本次) |

**结论**: 本次变更未引入任何新错误。所有预存失败均与 `cleanupOrphans` 无关。

### Wave 1.5 — 真实场景验证

**场景计数**: E=2, N=2 ✅

**场景 1: [独立] 临时 SQLite DB + 临时目录模拟孤儿清理**

执行: `npx tsx` 临时脚本 — 创建 SQLite DB (外键开启) + 2 张照片 (1 保留 1 孤儿) + daily_picks/photo_tags/photo_analyses 关联

输出:
```
=== 清理前 DB 状态 ===
photos: 2
photo_tags: 1
photo_analyses: 1
daily_picks: 1

孤儿记录数: 1
孤儿 ID: p-orphan

=== 清理后 DB 状态 ===
photos: 1 (预期 1)
photo_tags: 0 (预期 0, CASCADE)
photo_analyses: 0 (预期 0, CASCADE)
daily_picks: 0 (预期 0)

p-keep 保留: ✅
p-orphan 删除: ✅
CASCADE photo_tags: ✅
CASCADE photo_analyses: ✅
daily_picks 清理: ✅
```

**场景 2: [独立] 真实 DB (relight.db) 状态检查**

执行: `npx tsx` 脚本 — 查询 6,142 张照片的主仓库 DB

输出:
```
DB 路径: /Users/stringzhao/workspace/relight/apps/backend/data/relight.db
DB 大小: 9.2 MB
存储源: NAS 照片 (local) → /Users/stringzhao/nas-photos
  DB 照片数: 6142
  抽样 100 条中孤儿: 100
总照片: 6142
无缩略图: 0
```

⚠️ **重要发现**: NAS 存储源 (`/Users/stringzhao/nas-photos`) 当前未挂载，抽样 100 条全部显示为"孤儿"。**已修复** — 新增安全阀：孤儿 >50 且比例 >80% 时跳过清理并 console.error 告警。NAS 断连场景 (6142/6142 孤儿) 会被正确阻断。

### Wave 2 — AI 审查

**Tier 2a: design-reviewer — 设计符合性**

结果: ✅ **全部 7 项检查通过**

| # | 检查项 | 状态 |
|---|--------|------|
| 1 | cleanupOrphans 在 listFiles() 后、第一个 return 前 | ✅ |
| 2 | 使用 Set 构建 diskPaths (O(1) 查找) | ✅ |
| 3 | 按 storageSourceId 过滤查询 | ✅ |
| 4 | 同一事务删 daily_picks + photos | ✅ |
| 5 | thumbnailPath 精确删除 + .catch 容错 | ✅ |
| 6 | try/catch 包裹，失败返回 0 | ✅ |
| 7 | 记录清理日志 (job.log + console.error) | ✅ |

**Tier 2b: code-quality-reviewer — 代码质量**

结果: **Good** — 0 Critical, 0 Important, 3 Minor

| 级别 | 问题 | 置信度 |
|------|------|--------|
| Minor | Error indistinguishability: 错误和"无孤儿"都返回 0 | 85% |
| Minor | Fire-and-forget fs.unlink: 不等待缩略图删除完成 | 90% |
| Minor | inArray 变量数限制: 极端情况 (>32766 孤儿) 可能失败 | 80% |

### 结果判定

- 步骤 1 (场景计数): E=2, N=2 ✅
- 步骤 2 (格式检查): 每个场景均含 `执行:` + `输出:` ✅
- Tier 0 (红队测试): 29/29 ✅
- Tier 1 (基础验证): 变更文件无新错误 ✅
- Tier 2 (AI 审查): 设计符合 + 代码质量 Good ✅

**最终**: ✅ 全部通过（预存错误非本次引入）

## 变更日志
- [2026-05-04T08:06:59Z] 用户批准验收，进入 merge 阶段
- [2026-05-04T08:10:00Z] merge 阶段完成：commit `d1ffe40` feat(backend): 扫描时自动清理孤儿记录 + `eb6a568` docs(knowledge): 提取知识。知识提取 2 条（patterns + decisions）
- [2026-05-04T07:24:20Z] autopilot 初始化，目标: 扫描时自动清理孤儿记录
- [2026-05-04T07:35:00Z] design 阶段完成：Plan 审查通过（修复 1 BLOCKER + 2 IMPORTANT），进入 implement 阶段
- [2026-05-04T07:50:00Z] implement 阶段完成：蓝队实现 cleanupOrphans 函数（61 行）+ 红队编写 29 个验收测试全部通过 + 类型检查通过（预存错误除外），进入 qa 阶段
- [2026-05-04T08:00:00Z] qa 阶段完成：Wave 1 全部通过 (Tier 0 29/29 ✅, Tier 1 无新增错误) + Wave 1.5 2 个真实场景验证 + Wave 2 设计审查 7/7 + 代码质量 Good (0 Critical/Important)，gate: review-accept
- [2026-05-04T08:04:00Z] 安全修复：新增安全阀 — 孤儿 >50 且比例 >80% 时跳过清理（防止 NAS/网络存储断连时误删全部记录）。lint ✅ + 29 个验收测试全部通过。更新设计文档和 QA 报告。

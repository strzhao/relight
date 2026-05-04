---
active: true
phase: "merge"
gate: ""
iteration: 1
max_iterations: 30
max_retries: 3
retry_count: 0
mode: ""
plan_mode: ""
brief_file: ""
next_task: ""
auto_approve: false
knowledge_extracted: ""
task_dir: "/Users/stringzhao/workspace/relight/.claude/worktrees/scan2/.autopilot/requirements/20260504-解决和提升-scan-storage"
session_id: e38cdf08-ad2d-47ca-9355-7b64dfc071ee
started_at: "2026-05-03T17:55:20Z"
---

## 目标
解决和提升 scan-storage 相关问题

> 📚 项目知识库已存在: .autopilot/。design 阶段请先加载相关知识上下文。

## 设计文档

### 修复 1: 流式 SHA256 哈希 (Critical — 内存安全)

**问题**: `scan-storage.ts:59` 每个文件调用 `adapter.getFileBuffer()` 读取完整 Buffer，5000 张 10MB 照片 = 50GB 峰值内存。

**方案**:
- `IStorageAdapter` 接口新增 `computeFileHash(filePath): Promise<string>`
- `LocalFilesystemAdapter` 中实现: `fs.createReadStream` + `crypto.createHash('sha256')` + `stream/promises.pipeline`
- 64KB chunk 流式读取，内存恒定 ~64KB + hash 上下文 (~300 bytes)，与文件大小无关
- `scan-storage.ts` 中用 `adapter.computeFileHash()` 替换 `getFileBuffer()` + 手动 hash

### 修复 2: getMetadata 真实实现

**问题**: `local.ts:65-69` 返回 `{}`，所有照片 width=0, height=0, takenAt=null。

**方案**:
- 使用已有依赖 `sharp(filePath).metadata()` 获取 width/height（Sharp 只读文件头部/元数据段，不读全文件）
- 从 Sharp 返回的 EXIF Buffer 解析 DateTimeOriginal (tag 0x9003)
- 编写轻量 EXIF TIFF 解析器 (~60 行)，解析 IFD0 → ExifIFD → DateTimeOriginal
- fallback: `fs.stat(filePath).mtime`
- 容错: 解析失败返回 `{}`，不阻塞扫描

### 修复 3: 批量写入 + 跳过已有分析

**问题**: L100-111 INSERT 和 L114 入队非原子；L114 未检查已有 photoAnalyses，重新扫描会产生冗余 AI 调用。

**方案**:
- 两阶段处理：先收集所有 photo 数据 → `db.transaction()` 包裹批量 `db.insert().values([...])` → 再批量 `analyzeQueue.addBulk([...])`
- 批量插入前，查询已有 photoAnalyses 的 photoId 列表，跳过已分析的 photo

### 修复 4: 并发缩略图生成

**问题**: for 循环内串行 `await generateThumbnail`，数百文件时效率低。

**方案**: 分批并发，每批 4 个 `Promise.all`。缩略图失败不阻塞其他文件。

### 修复 5: DB Schema — fileHash 唯一索引

**方案**: `photos.fileHash` 添加 `.unique()`，加速去重查询并提供数据库级唯一性保障。

### 不在此次范围
- AI Client 超时配置（独立模块）
- analyze-photo 标签 upsert 竞态（独立 worker）
- SMB/WebDAV 适配器静默降级（独立功能）
- `routes/scan.ts` GET / 空数据（API 层）

## 实现计划

### Phase 1: 存储层增强
- [x] 1.1 `storage/interface.ts`: IStorageAdapter 新增 `computeFileHash` 方法
- [x] 1.2 `storage/local.ts`: 实现流式 `computeFileHash` + 真实 `getMetadata`（Sharp + EXIF 解析）
- [x] 1.3 `storage/local.ts`: 添加 EXIF DateTimeOriginal 解析辅助函数

### Phase 2: Worker 重构
- [x] 2.1 `jobs/scan-storage.ts`: 替换 Buffer hash 为流式 `adapter.computeFileHash()`
- [x] 2.2 `jobs/scan-storage.ts`: 批量 INSERT photos（收集数组 → db.transaction 包裹单条语句）
- [x] 2.3 `jobs/scan-storage.ts`: 查询已有 photoAnalyses，跳过已分析 photo 的入队
- [x] 2.4 `jobs/scan-storage.ts`: 并发缩略图生成（分批 4 并发）

### Phase 3: Schema 加固
- [x] 3.1 `db/schema.ts`: `photos.fileHash` 添加 `.unique()`

### Phase 4: 测试
- [x] 4.1 新增 `storage.adapter.test.ts`: computeFileHash 正确性/内存安全、getMetadata EXIF 解析（25 测试）
- [x] 4.2 新增 `scan-storage.test.ts`: 批量写入、去重、跳过已分析、容错、并发处理（21 测试）

## 红队验收测试

### 测试文件

| # | 文件 | 测试数 | 覆盖修复 |
|---|------|--------|-------------|
| 1 | `apps/backend/src/__tests__/storage.adapter.test.ts` | 25 | 修复 1 (流式哈希), 修复 2 (getMetadata) |
| 2 | `apps/backend/src/__tests__/scan-storage.test.ts` | 21 | 修复 3 (批量写入+跳过已分析), 修复 4 (并发缩略图), 修复 5 (unique 索引) |

### 验收标准覆盖

- **修复 1 流式哈希**: 正确性 (已知内容/空文件/二进制/雪崩效应)、幂等性、内存安全 (50MB 文件 <200MB RSS)、流式管线验证
- **修复 2 getMetadata**: 宽度/高度 (JPEG/PNG)、takenAt (EXIF/mtime fallback)、容错 (非图片/空文件/损坏文件/并发)
- **修复 3 批量写入**: 批量 INSERT 完整性、事务原子性、跳过已分析 photo 不入队
- **修复 4 并发缩略图**: 24 文件全量处理、元数据失败不阻塞分析入队
- **修复 5 unique 索引**: 重复 hash 插入拒绝、不同 hash 正常插入
- **去重**: 相同内容跳过、路径不同内容相同视为重复、混合扫描
- **容错**: 哈希失败/元数据失败/混合场景，错误计数正确
- **扫描日志**: 成功/错误日志正确记录

### 测试执行结果

```
 ✓ |backend| src/__tests__/storage.adapter.test.ts (25 tests) 144ms
 ✓ |backend| src/__tests__/scan-storage.test.ts (21 tests) 20ms
 ---
 8 test files, 163 tests all passed (46 new + 117 existing)
```

## QA 报告

### Wave 1 — 命令执行

| Tier | 检查项 | 状态 | 命令 | 关键输出 |
|------|--------|------|------|----------|
| 0 | 红队验收测试 | ✅ | `vitest run` | 8 文件、163 用例全部通过（46 new + 117 existing） |
| 1 | TypeScript 类型检查 | ⚠️ | `tsc --noEmit` | 3 预存在错误（ai/client.ts:44,67 + data-flow test:397），非本次变更引入 |
| 1 | Biome Lint | ✅ | `biome check` | 6 变更文件 0 errors |
| 1 | 单元测试 | ✅ | `vitest run` | 163 tests passed |
| 1 | 构建 | ✅ | `tsup` | ESM + DTS 构建成功 |
| 3 | 集成验证 | N/A | — | 无 dev server 需求 |
| 3.5 | 性能保障 | N/A | — | 非前端项目 |
| 4 | 回归检查 | N/A | — | 变更限于 backend 内部 |

**Wave 1 结论**: Tier 0 ✅ + Tier 1 ✅/⚠️ → 通过，3 个 typecheck errors 均为预存在代码问题。

---

### Wave 1.5 — 真实场景验证

| # | 场景 | 执行 | 输出 | 状态 |
|---|------|------|------|------|
| 1 | 流式哈希正确性 | `node scan-smoke-test.mjs` (5 种文件大小: 0B→1MB) | 流式哈希与 Buffer 哈希完全一致（5/5 PASS） | ✅ |
| 2 | 大文件内存安全 | `node scan-smoke-test.mjs` (100MB 文件) | 内存基线 95MB，峰值增长 32MB（<200MB 阈值） | ✅ |
| 3 | getMetadata 元数据提取 | `node scan-smoke-test.mjs` (Sharp 创建 JPEG + EXIF) | width=800, height=600, EXIF 存在 | ✅ |

E=3 = N=3 ✅，所有场景含 `执行:` + `输出:` 标记。

---

### Wave 2a — Design Reviewer（设计符合性审查）

**结论**: ✅ **14/14 设计要求全部通过**

| # | 设计要求 | 验证位置 | 状态 |
|---|----------|----------|------|
| 1 | interface.ts: `computeFileHash` 方法签名 | `interface.ts:23-24` | ✅ |
| 2 | local.ts: `createReadStream` + `pipeline` + 64KB highWaterMark | `local.ts:192-197` | ✅ |
| 3 | scan-storage.ts: 替换 Buffer hash 为流式 hash | `scan-storage.ts:61` | ✅ |
| 4 | local.ts: `sharp().metadata()` 获取 width/height | `local.ts:156` | ✅ |
| 5 | local.ts: EXIF TIFF 解析 tag 0x9003 | `local.ts:22, 50-96` | ✅ |
| 6 | local.ts: fallback `fs.stat().mtime` | `local.ts:169-180` | ✅ |
| 7 | local.ts: 容错返回 `{}` | `local.ts:182` | ✅ |
| 8 | scan-storage.ts: `db.transaction()` 包裹批量 insert | `scan-storage.ts:136-138` | ✅ |
| 9 | scan-storage.ts: `analyzeQueue.addBulk()` | `scan-storage.ts:189-195` | ✅ |
| 10 | scan-storage.ts: 跳过已有 photoAnalyses | `scan-storage.ts:179-186` | ✅ |
| 11 | scan-storage.ts: 4 并发 Promise.all | `scan-storage.ts:15, 145-172` | ✅ |
| 12 | scan-storage.ts: 缩略图失败不阻塞 | `scan-storage.ts:153-158` | ✅ |
| 13 | schema.ts: `fileHash.unique()` | `schema.ts:27` | ✅ |
| 14 | biome.json: 测试文件 noNonNullAssertion 豁免 | `biome.json` | ✅ |

---

### Wave 2b — Code Quality Reviewer（代码质量审查）

**结论**: ⚠️ **2 Important + 4 Minor，无 Critical**

#### IMPORTANT

| # | 问题 | 位置 | 置信度 |
|---|------|------|--------|
| 1 | UNIQUE 约束迁移可能因已有重复数据失败 | `schema.ts:27` | 85% |
| 2 | 去重快照与批量 INSERT 间非原子（并发扫描时可能 UNIQUE 冲突） | `scan-storage.ts:66→136` | 80% |

#### MINOR

| # | 问题 | 位置 | 置信度 |
|---|------|------|--------|
| 3 | 不必要的 `as` 类型断言 | `scan-storage.ts:157` | 90% |
| 4 | 单语句事务包裹冗余（SQLite 单条 INSERT 即原子） | `scan-storage.ts:136-138` | 85% |
| 5 | EXIF 解析器缺少数值边界检查（外层 try/catch 兜底） | `local.ts:71-72` | 85% |
| 6 | 缩略图更新逐条写入 | `scan-storage.ts:163-171` | 80% |

---

### 总体判定

| 维度 | 状态 | 说明 |
|------|------|------|
| Tier 0 红队验收测试 | ✅ | 新增 46 测试（storage.adapter 25 + scan-storage 21） |
| Tier 1 基础验证 | ✅/⚠️ | typecheck ⚠️（3 预存在错误）/ lint ✅ / test ✅ / build ✅ |
| Tier 1.5 真实场景 | ✅ | 3/3 场景通过（流式哈希正确性 + 内存安全 + 元数据提取） |
| Tier 2a 设计符合性 | ✅ | 14/14 设计要求通过 |
| Tier 2b 代码质量 | ⚠️ | 2 Important + 4 Minor，无 Critical |
| Tier 3/3.5/4 | N/A | 不适用 |

**最终判定**: 全部 ✅（可有 ⚠️）→ `gate: "review-accept"`

## 变更日志
- [2026-05-04T03:26:49Z] 用户批准验收，进入合并阶段
- [2026-05-03T17:55:20Z] autopilot 初始化，目标: 解决和提升 scan-storage 相关问题
- [2026-05-04T00:00:00Z] design 阶段完成：Plan 审查通过（6/6 PASS），设计方案进入 implement
- [2026-05-04T02:00:00Z] implement 阶段完成：蓝队修改 4 文件（interface/local/scan-storage/schema），红队新增 2 测试文件（46 测试），163 测试全部通过
- [2026-05-04T02:45:00Z] QA 阶段完成：Wave 1 ✅/⚠️, Wave 1.5 3/3 ✅, Wave 2a 14/14 ✅, Wave 2b ⚠️ (2 Important + 4 Minor, 无 Critical) → gate: review-accept

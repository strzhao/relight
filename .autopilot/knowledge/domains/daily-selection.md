# 每日精选 (Daily Selection)

> 从 decisions.md 和 patterns.md 拆分 | 父级索引: ../index.md

---

## 架构决策

### [2026-05-09] 每日精选改为 4 源平等加权混采 + 久远度温和加成 + 30 天去重 + AI 二次评选关联 members

<!-- tags: daily-selection, candidate-pool, age-weight, dedup, multi-photo, ai-clustering, design, architecture -->

**Background**: 旧每日精选只查"月-日 = 今日"严格匹配 + aestheticScore DESC top 20，痛点：候选池可能为空 / 仅美学评分排序丧失久远感 / 同一张照片可隔几日复选 / 单图无法呈现"一段时光"。

**Choice**: 候选池构造拆成 4 个独立子查询平等加权混采 — 历史上的今天 / 同月份不同日 / 同季节不同月 / 久远随机老照片（>2 年前），每源保底 3 张防挤占，全局按 `aestheticScore × (1 + min(0.6, √yearsAgo × 0.1))` 排序（5 年前 +22%、10 年前 +32%、封顶 1.6）；30 天 photoId 去重。新增"阶段 1.5"：hero 选定后再查同日 ±6h 时间窗候选，让 AI 二次评选 0-8 张 members。

**Lesson**: 当架构有"等比混采"等隐性公平性契约时，单点放宽参数会破坏全局。聚类是质量补丁，不该用扩大候选池来"凑数"——宁缺勿滥。

---

### [2026-05-10] daily-selection top N 主题去重 + maxN 从 20 降到 12（质量优先于数量）

<!-- tags: daily-selection, candidate-pool, theme-dedup, cluster, maxN, quality-over-quantity, dirname-time-window, design -->

**Background**: 每日精选升级到 20 条目展示后，候选池仅按 photoId 去重，无法识别"同主题/同事件但跨 5 秒窗"的重复。实测 top 20 出现 7 组短时差重复，实际只有 12-13 个独立回忆。

**Choice**: 候选池末尾插入 `clusterByDirnameAndTime` 纯函数（dirname + |Δt| ≤60min 闭区间，weightedScore desc + takenAt asc 选代表），同簇非代表 photoId 进入 entry.members。maxN 从 20 降到 12。

**OUT-OF-SCOPE**: 跨 dirname 同主题、Δt>60min 同 dirname、跨年份同地点（留给 GPS+meta 项目）。

---

### [2026-05-10] 每日精选首页从「单 hero + 关联 members」升级为「20 entries 全展示 + 每条目独立系列」

<!-- tags: daily-selection, multi-entries, schema-design, dual-write, daily-pick-entries, ui-redesign, design, architecture -->

**Choice**: 候选池 final 20 张全部持久化为"今日入选条目"，每张走完整 narrate + AI 选 members 流水线；新增 `daily_pick_entries` 子表 + `UNIQUE(daily_pick_id, rank)` 约束保证 job 幂等；`daily_picks` 既有列保留并与 `entries[rank=0]` 双写同源。30 天去重必须 UNION 两张表。

**Trade-offs**: AI 调用 ~80 次（20 narrate + 20 select members），本地 qwen + pLimit(2) 并行下 ~10 分钟。双写同源需红队验收测试守护。

---

### [2026-05-15] candidate-pool 触底回填第 5 源（fillUp）：主路径聚类压缩导致 entries 断崖时启动兜底

<!-- tags: daily-selection, candidate-pool, fillUp, fallback, theme-conflict, primary-candidate-source, type-narrowing, pool1-stability, design -->

**Choice**: 候选池触底回填第 5 源（fillUp），仅在主路径不足时激活。类型拆分 `PrimaryCandidateSource`（4 源内部）vs `CandidateSource`（对外联合）。fillUp 候选独立聚类 + 冲突过滤，pool1 代表绝不参与重选。

**Lesson**: 当架构有"代表稳定性"等隐性契约时，"合并后重选"是诱人但破坏性的优化。fillUp 必须独立聚类 + 冲突过滤 + 追加，不能与已稳定 pool 合并重选。

---

### [2026-05-16] 事件键（dirname::takenAt 同日）前置去重替代 prompt 标题软约束

<!-- tags: daily-selection, candidate-pool, event-key, dedup, title-duplication, rule-based, computeEventKey, getRecentPickedEventKeys, design -->

**Choice**: 撤销 prompt 软约束，改在候选池层面用确定性规则前置去重：`computeEventKey` = `path.posix.dirname(filePath) + "::" + takenAt.slice(0, 10)`。dry-run 对比 9 个备选方案 → 方案 H（dirname AND takenAt 同日）最优。

**Why not prompt**: qwen-vl 视觉模型在 narrate 阶段不受 prompt soft constraint 约束 — 同题材照片会固定输出相同模板标题。规则方案确定性、零额外 AI 调用。

---

## 模式与教训

### [2026-07-02] 每日精选历史回填（backfill-daily-picks）：复用 worker pickDate 覆盖 + fillUp/30 天去重的「全消费」边界

<!-- tags: daily-selection, backfill, cli, pickdate-override, fillup, dedup, design-decision-7, candidate-pool, sequential-backfill, boundary-effect, design -->

**Background**: 定时任务每天北京 00:00 只跑「今天」，服务宕机 / 未开机 / 首次安装未回追导致的某日 dailyPicks 缺失会永久存在。回填所需底层能力其实早已齐备——worker 支持 `job.data.pickDate` 覆盖（`jobs/daily-selection.ts:284-289`），据此构造 pickNow 让 4 源时间窗 / yearsAgo / 30 天去重池全部相对目标日；写库 `onConflictDoUpdate` 幂等；30 天去重窗已对称化（乱序回填安全，见 [[2026-06-02]] 两条）。

**Choice**: 缺口只是「检测缺失日期 + 循环喂给 worker」这一层编排，故新增**纯 CLI** `backfill-daily-picks`（非路由，跟随仓库 `backfill-*` 惯例）。默认进程内顺序同步（复用 `run-daily-selection.ts` 的 `StubJob` + `dailySelectionWorker`），`--enqueue` 可切换 BullMQ 入队。默认跳过已存在日期，`--force` 覆盖；`--from` 默认=最早照片日、`--to`=今日；`--dry-run`/`--yes` 安全闸门防误触大规模回填。run-daily-selection.ts 需加 `isDirectRun` 守卫（与 backfill-thumbnails 同模式），否则 `import { StubJob }` 会触发末尾无条件 main()。

**Lesson（fillUp 全消费 gotcha）**: 回填多日时注意——candidate-pool 的 4 源都有 `strftime('%Y', takenAt) < currentYear` 条件，目标日**当年**的照片走不到 4 源，会触发 fillUp 第 5 源（`aestheticScore ≥ 7.5` + `NOT IN excludeList`）。微型 fixture（几张同年高分照片）下，首日回填经 fillUp 把所有照片消费为 entries，30 天跨表去重（`daily_picks ∪ daily_pick_entries.members`）使后续日期候选池全空 → worker skip → 不落库。这正是设计决策 7「顺序回填边界效应」的极端情形。回填多日要么用足量 fixture（每日多张 / 跨年），要么接受「首日必落库、后续日按 dedup 可能 skip」。

---

### [2026-06-02] 每日精选 30 天去重窗口单向 lt(pickDate, now) 隐含"按日期顺序生成"假设 → 乱序回填时跨天 hero 撞图

<!-- tags: daily-selection, candidate-pool, dedup, getRecentPickedEventKeys, date-window, ordering-assumption, backfill, out-of-order, hero-collision, scheduled-job, bug -->

**修复**: 改为以目标日为中心的对称窗口 `gte(now-30d) AND lte(now+30d) AND ne(now当日)`。凡是"近 N 天去重"的时间窗口，若数据可能乱序写入，单向 `<` 窗口都会漏掉"未来方向"的已有记录。

---

### [2026-06-02] 去重窗口 UTC nowDate 与 pickDate 北京日期跨天错位 → 北京凌晨段 flaky

<!-- tags: timezone, beijing, utc, daily-selection, getRecentPickedEventKeys, pickDate, flaky-test, ci, controlled-experiment, dedup, bug -->

**修复**: 窗口三个日期统一用北京日期，与 pickDate 对齐。凡"按日期去重/比较"的逻辑，写入侧与查询侧必须用同一时区取日期。

---

### [2026-06-12] 弱操作/小概率操作的 UI 降权设计：不用 toast/确认框/强按钮

<!-- tags: ui-design, weak-interaction, manual-override, daily-selection, interaction-design -->

**Lesson**: 弱操作的 UI 强度应与其重要性成正比——极淡文字链接、hover 才微微显现、点击后静默完成，操作失败也静默忽略。强 UI 反向信号：让用户误以为这是高频必需操作。

---

### [2026-06-13] 主实体 UPDATE 关联键后必须同步关联表的派生字段

<!-- tags: api, daily-selection, manual-select, wallpaper, field-sync, data-consistency, bug -->

**Lesson**: 任何对外键引用的"热切换"操作，必须在同一事务/UPDATE 中同步该外键对应的关联表中的派生字段。对外 API 响应中的聚合根字段必须与当前外键所指向的关联行保持一致。

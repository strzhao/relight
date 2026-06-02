# 架构决策日志

### [2026-05-16] 事件键（dirname::takenAt 同日）前置去重替代 prompt 标题软约束

<!-- tags: daily-selection, candidate-pool, event-key, dedup, title-duplication, rule-based, computeEventKey, getRecentPickedEventKeys, design -->

**Background**: 上一轮实施的 narrate prompt {recent_titles} 软约束（`system.txt` 第 6 条 + `user.txt` 注入近期标题）被 qwen-vl 完全忽略 — 8 张伏见稻荷照片横跨 7 天全部生成相同标题"朱红隧道里的旧时"。8 张照片实际来自 2 次独立拍摄事件（2018-04-19 在 105APPLE 目录 + 2018-07-28 在珂珂手机照片目录），但 prompt 无法让 AI 产出不同标题。

**Choice**: 撤销 prompt 软约束，改在候选池层面用确定性规则前置去重：
1. 一对 `(dirname, date(taken_at))` 定义为"事件键" — `computeEventKey` = `path.posix.dirname(filePath) + "::" + takenAt.slice(0, 10)`
2. `getRecentPickedEventKeys(30)` 查询过去 30 天已选照片的 `{ eventKeys, excludeIds }`，一次 DB 调用替代原来的 `getRecentPickedPhotoIds`
3. 4 源 + fillUp 候选在映射为 `EnrichedCandidate` 后加 `filterByEventKey()`，命中已知事件键则跳过
4. NULL taken_at 的候选不受影响（安全兜底）
5. overfetch `K_PER_SOURCE = maxN * 1.5` 补偿过滤损耗（dry-run 实际过滤率 ~27%）

**Why not prompt**: qwen-vl 视觉模型在 narrate 阶段不受 prompt soft constraint 约束 — 同题材照片会固定输出相同模板标题。规则方案是确定性（相同输入必相同输出）、零额外 AI 调用、不依赖模型配合。

**Why this granularity**: dry-run 对比 9 个备选方案（纯 dirname 60/84 误杀灾难、phash 几乎无效、纯 takenAt 跨地点误杀、dirname+takenAt±1d 过宽）→ 方案 H（dirname AND takenAt 同日）最优：8/8 朱红命中 6 张（2 次事件 → 2 张代表），23/84 总排除均为合理同次拍摄去重。

**Result**: 重跑 7 天验证 — "朱红隧道里的旧时"从 8 次（跨 7 天）降至 2 次（仅 05-09 当日不同事件），84 unique photoIds，80 unique event keys，每日期 12 entries 稳定。

### [2026-05-15] candidate-pool 触底回填第 5 源（fillUp）：主路径聚类压缩导致 entries 断崖时启动兜底，pool1 代表 pin 住不替换

<!-- tags: daily-selection, candidate-pool, fillUp, fallback, theme-conflict, primary-candidate-source, type-narrowing, pool1-stability, design -->

**Background**: 过去一周 daily-selection entries 数从 12 张断崖跌到 2 张（2026-05-15 仅 2 个 entry）。直接 SQL 诊断：4 源原始可用照片充足（sameMonth=157、sameSeason=222、agedAll=874，aesthetic ≥7.5 且未在 30 天去重池里 105 张），但 [[2026-05-10] daily-selection top N 主题去重 + maxN 从 20 降到 12] 引入的 `clusterByDirnameAndTime`（dirname+60min + GPS 500m/24h union-find）把高分照片压成 1-2 个簇 — 用户高分照片大量集中在少数几次旅行（伏见稻荷、洪崖洞等 dirname 内成百张高分）。

**Choice**: 候选池触底回填第 5 源（fillUp），仅在主路径不足时激活：
1. **类型拆分**（解决 BLOCKER：新枚举扩散）：抽 `PrimaryCandidateSource = "historyToday" | "sameMonth" | "sameSeason" | "agedRandom"`（4 源内部），`CandidateSource = PrimaryCandidateSource | "fillUp"`（对外联合）；`dedupAndQuotaMerge` 参数签名改 `Record<PrimaryCandidateSource, ...>`，让 fillUp 在类型层面无法误入 quota 路径
2. **触发**：主路径 `clustered.slice(0, maxN)` 得 pool1，`pool1.length >= maxN` 时直接返回（零额外路径）；`pool1.length < maxN` 时启动 fillUp
3. **fillUp 查询**：`aesthetic_score >= 7.5`（硬性下限避免低分污染）+ `NOT IN (excludeIds ∪ pool1.photoId ∪ pool1.clusterSiblingIds)` + `(burst_id IS NULL OR is_burst_representative=1)`，按 `weighted + RANDOM 抖动` desc 取 `needCount * 3` 张（× 3 留给聚类+冲突过滤）
4. **pool1 代表 pin 住**（解决 BLOCKER：重聚类替换代表）：fillUp 候选**独立**跑一次 `clusterByDirnameAndTime` → 对每个簇代表 P 用 `isConflictWithPrimary(P, pool1)` 判定与 pool1 的 dirname+60min 或 GPS 500m+24h 冲突，冲突簇全部丢弃；pool1 代表绝不参与重选
5. **最终池** = `pool1 + 非冲突 fillUp 代表`，按 weighted desc 全局排序截前 maxN
6. console.info 日志 `[fillUp] 主路径仅 N 簇，启动回填，目标补足 K 张`

**Alternatives rejected**:
- **放宽 dirname/GPS 聚类窗口**（如 30min/200m）：会回退 [[2026-05-10] top N 主题去重] 的效果（伏见稻荷 4 张又会混进同日）
- **扩大 K_PER_SOURCE 到 1.5x 或 2x 重跑**：[[2026-05-10]] 已证明会破坏 4 源等比混采契约（plan-reviewer 历史结论）
- **fillUp 与 pool1 合并后重新聚类**（plan-reviewer 第 1 轮发现的 BLOCKER）：pool1 代表会被 fillUp 高分候选按 weightedScore 替换，破坏 pool1 稳定性 → 改为 fillUp 独立聚类 + 冲突过滤模式

**Trade-offs**:
- fillUp 多一次大 SQL 查询（NOT IN 含 30 天 dedup ~50-100 个 id），对 SQLite 可忽略（<10ms）
- 主题冲突判定 O(fillUp × pool1) ≤ 432 次比较，性能 OK
- fillUp 簇与 pool1 不合并意味着 `clusterSiblingIds` 不会跨 pool1/fillUp 共享 — fillUp 簇的 sibling 仅来自 fillUp 池内部
- `needCount * 3` 倍率是经验值；旅行重度用户场景下可能不足，最终接受 N < maxN（不再 K 回退凑数，宁缺勿滥）

**Evidence**: `apps/backend/src/jobs/daily-selection/candidate-pool.ts:398-565` 新增 fillUp 分支；`cluster.ts` 导出 `parseTakenAtMs` 供冲突判定复用；14 个 acceptance 用例（B-3/B-4/B-5/B-6/B-7/B-8 覆盖触发/不触发/排除集/质量下限/上限/pool1 稳定性），contract-checker 13/13 PASS。提交 `ca4a2b5`。

**Lesson**: 当架构有"代表稳定性"等隐性契约时，"合并后重选"是诱人但破坏性的优化。**fillUp 必须独立聚类 + 冲突过滤 + 追加**，不能与已稳定 pool 合并重选。Plan-reviewer 第 1 轮就抓出这个 BLOCKER — 修订设计避免了同 BLOCKER 重现。



### [2026-05-15] narrate prompt 软约束（recent_titles 占位 + 「避免重复标题」准则）：跨日 title 去重，并行无状态，零额外 AI 调用

<!-- tags: daily-selection, narrate-prompt, title-deduplication, soft-constraint, recent-titles, query-recent-titles, ai-prompt-engineering, design -->

**Background**: 过去一周日精选标题反复出现 "朱红隧道里的旧时"（05-10/05-14/05-15 共 4 次，05-10 当天 rank=2/3 同名两张不同照片）。narrate 12 entry 并行调 vision 模型，prompt 无共享上下文，模型对同类题材（朱红/隧道/鸟居）固定输出模板标题。

**Choice**: narrate prompt 软约束（用户明选「最轻」方案，零额外 AI 调用）：
1. `daily-selection.ts` 新增 `queryRecentTitles(daysBack=30): Promise<string>`：扫描 `daily_picks.title` ∪ `daily_pick_entries.title`，过滤 fallback "今日拾光"，截断 30 条/600 字，空集返回 "无"，否则半角逗号拼接
2. `narrate/user.txt` 在「已知元数据」节后插入 `近期已用标题（请避开相同意象/句式）：{recent_titles}`
3. `narrate/system.txt` 创作准则追加第 6 条「**避免重复标题**：参考下方的"近期已用标题"列表，新标题应使用不同的意象、主语、句式；不要落入相同的命名模板（例：已用过"朱红隧道里的旧时"，下次同类题材应换为更具体的画面元素，如"鸟居下的尾绳"）」
4. `processSingleEntry` 签名加 `recentTitles: string` 参数，worker 主流程在阶段 0 末尾查询一次后透传给所有 entry（共享）

**Alternatives rejected**:
- **后处理重 narrate 冲突项**（中等成本）：同日并行 narrate 完成后扫描重复 title，对 rank>0 冲突 entry 用「已用 title 黑名单」重 narrate 1 次。增加 ~1-3 次 AI 调用。用户选最轻方案，本期不做
- **硬约束串行 narrate**（最强约束）：12 张串行 + 每次 narrate 携带"前面已生成 title"全量黑名单。100% 不重复但 30s → 2-3min，体感差
- **post-process 字符串后缀去重**（如改成"·之二"）：换皮重复不解决根本质量问题

**Trade-offs**:
- 并行 narrate 无法看到"同批正在生成的 title"，只能看到"最近 30 天历史 title"；同日内偶发重复（如 05-10 同名两张）仍可能出现 — 已知限制，由后续观察决定是否升级
- recent_titles 600 字符上限 ~ vision prompt 增加 100-200 token，可忽略
- AI 是软约束，遵循度取决于模型；qwen-vl 实测对中文 prompt 配合度尚可，但不能保证 100%

**Evidence**: `daily-selection.ts:25-71` queryRecentTitles + `processSingleEntry` 签名扩展；narrate prompt 2 个文件 +4 行；acceptance test C-9/C-10/C-11/C-12 + D-13/D-14 共 6 个用例验证查询过滤、时间窗、截断、占位符注入。提交 `ca4a2b5`。

**Lesson**: 跨调用上下文（"近期已用 title"）通过 prompt 注入是并行 AI 流水线最便宜的去重路径。系统层无状态、零额外 AI 调用，唯一成本是 prompt token 增量。同批并行内的重复需要 post-process 路径，但应作为下一阶段优化，不强行串行化。



### [2026-05-15] 撤销 narrate 命名人物注入：第二人称「你」呼告体优于硬塞具体称呼

<!-- tags: daily-selection, narrate-prompt, person-injection, second-person, product-tone, reversal, scope-control, ai-prompt-engineering -->

**Background**: commit `6d1f4c0` 将 candidate-pool 的 `peopleNicknames` 数组通过 `{people}` 占位符注入 narrate user prompt，期望文案能写出「妈妈在伏见稻荷的朱红长廊里笑」等具体称呼。真实跑出来的 narrative 出现两类问题：(1) **AI 角色反转** — system prompt 明写「『你』=拍照人不在画面里」「画面里有妈妈时用妈妈指代」，但 AI 把"妈妈"理解为画面外的拍摄者、把画面里的女性当成"你"，输出「**你**站在伏见稻荷…**妈妈**在镜头外…**你**比剪刀手」；(2) **改良 prompt 后角色顺过来了，但失去亲密呼告感** — 「妈妈在朱红长廊里笑得毫无防备」读起来像第三方旁观叙述，丢失"那年今日"的对话亲密感。

**Choice**: 撤销 narrate 阶段的人物注入：
1. `daily-selection.ts`: 删除 `peopleStr` 构造 + `replace("{people}", ...)` 分支。
2. `narrate/system.txt`: 删除整段「画面人物处理」规则（line 11-16）。
3. `narrate/user.txt`: 删除 `- {people}` 占位符行。
4. 删除 `narrate-prompt-injection.acceptance.test.ts`（契约已撤）。
5. **保留** `EnrichedCandidate.peopleNicknames` 字段、`enrichWithPeopleNicknames` 实现、`people-injection.acceptance.test.ts` — 已落库人脸数据无需作废，未来 person-strip UI / 同人物聚类 / 按人筛选仍可复用。

**Lesson**:
- **人称代词的相对性**让 AI 反向解读：「妈妈」在中文里=「我的母亲」，AI 看图+读 prompt 时倾向于把"妈妈"当成画面外的讲述者（拍摄者称自己母亲为妈妈），即使 prompt 显式锚定「画面人物：妈妈」也压不住这层语义。
- **AI prompt 的 system 规则 vs 风格示例冲突时，示例胜出**：旧 system 示例「那天风很大，你还没学会如何体面地告别，只顾着在镜头前揉眼睛」里"你"明显在画面里揉眼睛——与规则 2「『你』不在画面」直接矛盾。AI 优先模仿示例。
- **产品调性**："你"呼告 = 用户在跟过去自己/挚爱说话的亲密对话；具体称呼 = 第三方旁观描述。同样信息密度下前者情感载荷更高。
- **测试通过 ≠ 产品成功**：commit `6d1f4c0` 红蓝队 39 acceptance + qa-reviewer 17/17 全绿，证明数据流和注入逻辑全对——但效果验证（端到端跑一次实际 narrate）才发现产品调性问题。

**Alternatives rejected**:
- **改良 prompt 修正角色反转**（加正反例锚定「画面人物：妈妈 + 画面女性 → 写妈妈不写你」+ 替换有歧义的风格示例）：实测 AI 角色顺过来了，但用户审美反馈"妈妈在朱红长廊"读起来很怪，不如"你站在朱红深处"。问题不在 AI 不听话，在产品调性本身不该用第三人称称呼。
- **保留注入但仅作上下文提示**（不强制称呼出现）：AI 没明确指令时易回到第三人称叙述或角色错位，不可控。
- **完全保留并接受角色反转**：narrative 出现"你/妈妈"语义混乱，比无注入版更差。

**Trade-offs**:
- 一次性把 6d1f4c0 的 narrate 部分回滚，但 `peopleNicknames` 数据 + self 过滤 + selfPersonId settings 全部保留，下个用人物的产品功能（搜索、聚类、UI）不用重做。
- 命名人物覆盖率（7 人 ~2600 张照片）的潜在价值推迟到非 narrate 路径释放。
- decisions.md 的两条原始决策标记为 **Superseded** 而非删除，保留决策演化历史。

**Evidence**:
- 端到端验证：5 张候选撤销注入后 narrate 全部回到「那年五月，**你**怀里的孩子还那么小」「2018年的夏天，**你**染了一头温柔的紫发」「**你**在空旷的地下停车场停下脚步」等呼告体，0/5 出现角色反转。
- 测试: daily-selection 测试套件 80/80 通过（删除注入相关 39 条 + 保留人物字段相关 21 条）。
- 用户审美反馈直接驱动：「改成妈妈反而很怪，不如你」。

---

### [2026-05-11] photos 表加 GPS+EXIF meta 14 列 + cluster GPS 谓词 + narrate prompt 注入坐标

<!-- tags: gps, exif, exifr, schema-migration, cluster, union-find, daily-selection, narrate-prompt, location-awareness, ai-vision, geographical-context -->

**Background**: 前一轮 daily-selection top N 主题去重（dirname+60min 链式）解决了短时差同主题，但 OUT-OF-SCOPE 留下三类：跨 dirname 同地点（朱红跨年同地）、跨时间窗同 dirname（洪崖洞跨午晚）、跨年份同地点。同时 narrate prompt 缺时区+地点，AI 写出的叙事漂浮（"那个春日午后"模板感）。photos 表只持久化 takenAt，丢弃 GPS/设备/镜头等高价值 EXIF。

**Choice**:
1. **schema**: photos 表新增 14 列（latitude/longitude/altitude/gpsImgDirection/offsetTime/cameraMake/cameraModel/lensModel/focalLength/focalLength35mm/iso/exposureTime/fNumber/software）+ 1 列 exif_backfilled_at 幂等标记。全部 nullable。
2. **parser**: 引入 exifr 库（0.5-2.5ms/张，HEIC/RAW 原生支持）替换 local.ts 手写 TIFF 解析。强制 `reviveValues: false` 让 DateTimeOriginal 保持字符串（防 Date 对象进 SQLite 变 `[object Object]`）。
3. **cluster 两步算法**：保留 Step 1 dirname+60min 链式扫描（语义不变），新增 Step 2 GPS pairwise union-find（簇粒度，≤500m + ≤24h），OR 合并跨 dir 同地。单簇情况退化与原算法一致。
4. **narrate prompt**: 注入 {latitude}/{longitude}/{timezone} 三占位符 + 引导文案，AI 自主使用。实测覆盖率 68.9% GPS（4252/6175），AI 直接识别"洪崖洞"（29.56°N/106.57°E）/"苔痕深处禅房"（35.00°N/135.77°E 京都）/杭州（30.13°N/120.21°E）等地标。
5. **回填**: backfill-exif.ts CLI，pLimit(8) 并发 + WHERE exif_backfilled_at IS NULL 幂等。

**Lesson**:
- exifr 默认 `reviveValues: true` 会把 EXIF 日期转 Date 对象——存 SQLite TEXT 列会变 `[object Object]`，**必须显式关闭**。同理 `translateValues: false` 防枚举翻译。
- "凑够数字"的列声明（14 列）建议留出 1 列工程标记位（exif_backfilled_at），用户口径不变但工程更可靠。
- 两步算法（保留 Step 1 + 叠加 Step 2）比"全部重写为 union-find"语义更清晰：单簇退化 == 旧版输出，渐进式增强。
- GPS 注入比"reverse geocode 工程"价值高 — 现代 LLM 能直接从经纬度识别地标（不必引入 nominatim/cities500.txt 等离线数据集）。

**Alternatives rejected**:
- AI relabel 修复 dir（Plan C）：成本高、效果差，user 否决
- 在线 reverse geocode（高德/Nominatim）：6175 张需 200 元或限流，且坐标外泄隐私
- 离线 reverse geocode（cities500.txt）：~50MB 数据集 + 行政区划匹配复杂

**Verification evidence**:
- backfill 实跑：6175 张图片 / GPS 命中 4252 (68.9%) / camera_make 4685 (75.9%) / software 4739 (76.7%)
- 单元测试：geo 20 + exif 19 + cluster-gps 23 + exif-backfill 11 = 73 it 全过
- API 验证：2026-05-10 entries rank 8/9 narrative "洪崖洞的旧梦"/"混凝土的静默" 直接命中地标

### [2026-05-10] daily-selection top N 主题去重 + maxN 从 20 降到 12（质量优先于数量）

<!-- tags: daily-selection, candidate-pool, theme-dedup, cluster, maxN, quality-over-quantity, dirname-time-window, design -->

**Background**: 每日精选升级到 20 条目展示后，候选池仅按 photoId 去重 + bursts 5 秒窗过滤连拍代表，无法识别"同主题/同事件但跨 5 秒窗"的重复。实测 top 20 出现 7 组短时差重复（朱红 4 张/姜黄 3 张/雪桥 23s/河流 4s/京都同秒），实际只有 12-13 个独立回忆。同时用户反馈 maxN=20 让 AI narrate 摊薄，标题"那年 X 的 Y"模板感重，质感参差。

**Choice**: 候选池末尾插入 `clusterByDirnameAndTime` 纯函数（dirname + |Δt| ≤60min 闭区间，weightedScore desc + takenAt asc 选代表），同簇非代表 photoId 进入 entry.members 显示为系列条；同时 maxN 从 20 降到 12（aestheticScore 全部 ≥8.5，AI 调用 -40%，标题更鲜活）。

**OUT-OF-SCOPE**（明确不解决，留给 GPS+meta 项目）：跨 dirname 同主题（如 14年前/珂珂手机 vs DCIM/105APPLE 都是伏见稻荷）、Δt>60min 同 dirname（如同日洪崖洞 1h31min 跨午晚）、跨年份同地点。

**Alternatives rejected**:
- 扩大候选池 K_PER_SOURCE 到 1.5x 重跑：plan-reviewer 指出会破坏 4 源等比混采契约（historyToday 单源吃下更多 quota+contest 槽位），违反 per-source quota 公平性
- AI 二次校准选 hero：成本高且解析飘
- 加 dHash 信号：实测同主题 dHash 差异大（如朱红 4 张 hex 完全不同），命中率不足

**Lesson**: 当架构有"等比混采"等隐性公平性契约时，单点放宽参数会破坏全局。聚类是质量补丁，不该用扩大候选池来"凑数"——宁缺勿滥。



### [2026-05-10] apps/web 拆分双 tsconfig — 生产严格 + 测试松弛，恢复 noUncheckedIndexedAccess

<!-- tags: tsconfig, typescript, strict, noUncheckedIndexedAccess, test-infra, dom-api, monorepo, design -->

**Background**: 根 `tsconfig.json` 开启 `strict: true` + `noUncheckedIndexedAccess: true`（数组/对象索引访问返回 `T | undefined` 强制空检查）。但 `apps/web` 早期 override 关闭了此项 — 因为前端测试用例大量出现 `querySelectorAll(...)[0]` / `Array.from(nodeList).indexOf(node)` 这种 DOM API 索引访问，启严格后每行都需 `!` 非空断言或显式空检查，工程负担过大。问题：override 影响**整个 apps/web 范围**包括生产代码，让组件里的 `videoRefs.current[i]` 等也能裸访问，类型安全被削弱。

**Choice**: 拆分双 tsconfig：
- `apps/web/tsconfig.json` — 生产代码（components/hooks/lib/app/pages），删除 override 继承根 `noUncheckedIndexedAccess: true`，新增 `exclude: ["__tests__/**", "e2e/**"]`
- `apps/web/tsconfig.test.json` — 测试代码（__tests__/e2e/vitest.*），`extends: "./tsconfig.json"` + 仅对自己关闭 `noUncheckedIndexedAccess: false`
- `package.json` typecheck 改为 `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit` 两段验证

**Alternatives rejected**:
- 全 web 包降级（原状）：丢失生产代码索引安全，qa-reviewer 标 BLOCKER
- 给红队测试加 `!` 非空断言：违反红队铁律不准改测试代码
- 给红队测试加 `// @ts-expect-error`：同上违反红队铁律
- TypeScript references / project mode：本项目无独立编译产物，过于重
- 保持单 tsconfig + 测试用 `// @ts-nocheck`：粗粒度禁用所有类型检查，掩盖真实错误

**Trade-offs**: 双 tsc 调用让 typecheck 时间翻倍（本项目 ~3s × 2 = 6s，可接受）。需要维护两个文件的 include/exclude 一致性。Next.js 插件只读 root tsconfig，不影响。

**Evidence**: `apps/web/tsconfig.json` + `apps/web/tsconfig.test.json` + `apps/web/package.json` typecheck script 双段。修复后生产代码 `banner-carousel.tsx` 的所有 `videoRefs.current[i]` 都加了 `?? null` 防御；测试代码 `banner-carousel.acceptance.test.ts` 的 `currentSlides[0]`、`Array.from(slides).indexOf(...)` 等保持简洁。typecheck 双段全绿，5-10 banner 改造合并入 commit `2056055`。

### [2026-05-09] 每日精选改为 4 源平等加权混采 + 久远度温和加成 + 30 天去重 + AI 二次评选关联 members

<!-- tags: daily-selection, candidate-pool, age-weight, dedup, multi-photo, ai-clustering, design, architecture -->

**Background**: 旧每日精选只查"月-日 = 今日"严格匹配 + aestheticScore DESC top 20，痛点：候选池可能为空（用户某月某日没拍过照）/ 仅美学评分排序丧失久远感 / 同一张照片可隔几日复选 / 单图无法呈现"一段时光"。用户诉求是"更多有价值的回忆"+"多张照片有关联（如同一次游玩回顾）"。

**Choice**: 候选池构造拆成 4 个独立子查询平等加权混采 — 历史上的今天 / 同月份不同日 / 同季节不同月 / 久远随机老照片（>2 年前），每源保底 3 张防挤占，全局按 `aestheticScore × (1 + min(0.6, √yearsAgo × 0.1))` 排序（5 年前 +22%、10 年前 +32%、封顶 1.6）；30 天 photoId 去重既覆盖 hero 也覆盖历史 members。新增"阶段 1.5"：hero 选定后再查同日 ±6h 时间窗候选，让 AI 二次评选 0-8 张 members + 每张写一句 12 字 caption；视频 hero 跳过 1.5 退化单图。schema `dailyPicks` 加 `members` JSON 列。

**Alternatives rejected**:
- 单一扩窗（月-日 ±3 天）：方向一致但不够丰富，没有"久远感"维度；
- 严格分层 fallback（先用历史上的今天，空了才用其他）：仪式感强但失去多样性；
- 加权曲线选指数 / 激进 (5 年前 +50%/+100%)：用户明确要"温和"，避免新照片永远选不上；
- 时间窗 + 标签重叠选 members：依赖标签精度，对"游玩"事件聚类弱；
- GPS 同地点：当前 photos 无 GPS 字段，前置改造重；
- 用户反馈点赞/跳过：用户明确本期不做。

**Trade-offs**: AI 调用从每日 2 次增到 3 次（select hero / select members / narrate），token 成本上升约 50%；prompt 上下文长度需要控制（candidate narrative 截断到 80 字，related-pool 上限 20 张）。Members AI 越界 index 必须静默丢弃（不整体 fallback），避免单条坏数据废掉整次 members。视频 hero 不构造关联池，简化视频路径。

**Evidence**: `apps/backend/src/jobs/daily-selection/{candidate-pool,related-pool}.ts` 新建模块；`apps/backend/src/jobs/daily-selection.ts` 重构为三阶段流水线；`v2/daily/members/{system,user}.txt` 新建 prompt；schema dailyPicks 新增 members 列 + 历史行 UPDATE 回填 `[]`；前端 DailyHero 加 `<MemberStrip>` + 「N 年前的今天」标签。提交 `4540f87`，含 110+ 测试（candidate-pool 单测 14 + 集成 6 / related-pool 集成 5 / daily-worker acceptance 28 / multi-photo acceptance 13 / smoke 11 / routes 9）。

### [2026-05-08] 后端图片合成选 Satori + Resvg 流水线而非无头浏览器

<!-- tags: image-composition, satori, resvg, chromium, server-rendering, daily-selection, design -->

**Background**: 每日精选阶段 3 需要把胜出照片 + 标题 + 叙事文案合成一张"杂志版"壁纸图，要求：(a) 视觉与前端 React 版 DailyHero 大致一致；(b) 能按目标屏幕物理像素动态出图，覆盖多分辨率/多屏；(c) 跑在常驻 BullMQ worker 进程里、并能在 API 路由实时合成；(d) 中英混排 + 衬线字体高保真。

**Choice**: `satori`（JSX → SVG，固定模板字体内联）+ `@resvg/resvg-js`（SVG → PNG）+ `sharp`（PNG → mozjpeg JPEG）三段流水线；JSX 模板放在 `apps/backend/src/lib/wallpaper/template.tsx`，字体作为 ttf/otf 资产入仓由 tsup 复制到 dist。

**Alternatives rejected**:
- 无头浏览器（Playwright/Puppeteer + Chromium）：渲染保真度最高且能直接复用前端组件，但 Chromium 二进制约 200MB，cold start 慢，常驻 worker / 容器化部署负担重；命中率不高的多分辨率合成场景下不划算。
- 服务端 Canvas（node-canvas / skia-canvas）：依赖原生模块编译，CJK 字体支持差，复杂排版要手写 + 自己处理 baseline/letter-spacing。

**Trade-offs**:
- 必须接受 Satori CSS 子集：不支持 OKLCH（需预转 hex）、不支持 `clamp()` 等响应式函数（改用按宽度的 `scale = W / 1800` 因子计算固定 px）、box-model 仅 flex。
- 不能直接复用前端 React 组件，得维护一套"印刷版" JSX 模板；视觉一致性靠人工对照 + 后续设计同步。
- 字体以二进制资产入仓 + 构建产物中复制，关注 `import.meta.url` 在 dev/dist 的路径基准（见对应 pattern）。
- 输出尺寸由后端控制，可按目标屏幕物理像素实时合成 + 落盘缓存（`(pickDate, W, H)` 为 key），相比浏览器路径更可控、可幂等。

### [2026-05-06] 视频 AI 分析采用多帧雪碧图 + Whisper 转录 + 视频专属 prompt（而非单帧图片处理或多帧独立分析）

<!-- tags: video, ai-vision, whisper, sprite, ffmpeg, scene-cut, design, multi-modal -->

**Background**: storage adapter 已收录视频格式（.mp4/.mov 等），但 analyze-photo 视频走"格式门 → skipped"路径，DB 中 414 个视频文件仅有占位记录，丧失视频本身的运动感、剪辑节奏、对白等独特价值。

**Choice**: 视频走完整管道：
1. ffmpeg `select='gt(scene,0.3)'` 抽 N=6 关键帧（不足时时间均匀 fallback）
2. 6 帧 768×768 拼成 3×2 雪碧图（首版无文字角标，位置隐式时序）
3. ffmpeg 抽音轨 16kHz mono → 调本地 Whisper CLI 转录
4. 雪碧图 base64 + transcript 注入 v2/video prompt → 一次 vision 调用
5. 输出含通用字段（aestheticScore/tags/composition/...）+ 视频专属字段（videoPacing/motionScore/videoNarrative）

**Alternatives rejected**:
- **单帧 MVP（中点一帧 + 复用图片 prompt）**: 完全失去时序信息，视频的运动/节奏/剪辑感全部丢失
- **多帧独立分析 + 文本聚合**: token 成本 3-5 倍，且视频独立 vision 调用没有跨帧上下文，反而难感知时序
- **多帧 + 音频转录 + 双模型双轨聚合**: 保留作为最终方案，但 Whisper 部署形态需用户决策——选择复用 `martin/scripts/transcribe.py`（mlx 引擎）

**Trade-offs**:
- 单视频分析时长 5-10 倍于图片（whisper 转录 + ffmpeg 抽帧 + vision），但本地推理零成本可接受
- 雪碧图 ≤1MB（768×768×6 帧 quality=85 JPEG），对 qwen-vl 输入合理
- N=6 是兼顾 token 成本和时序覆盖的平衡点；scene-cut 不足时 fallback 时间均匀，对静态视频鲁棒
- 失败降级用占位（aiModel="video-failed:{kind}"），与既有"格式门 return 而非 throw"决策一致

**Evidence**: 端到端验证（5s testsrc + 440Hz 正弦波 fixture）：6 帧抽取 + 70KB 雪碧图 + Whisper 返回 segments；损坏视频（1KB 头）被 ffprobe 拒绝并降级为 video-failed:probe；缩略图自动生成 .jpg（修了之前会变 .mp4 的 bug）。design-reviewer 10/10 全过；code-quality-reviewer 4 个 Important 全部修复。

### [2026-05-05] 历史数据修复优先用一次性 SQL UPDATE 而非双路径 fallback

<!-- tags: database, migration, backfill, fallback, sql, design -->

**Background**: photos 表 6140 张照片中 5736 (93.4%) `taken_at` 为 NULL，导致前端"按年/月/日分组"功能塌缩成单一组。`storage/local.ts:181-185` 已有 `EXIF 失败 → fs.stat mtime` fallback，但增量扫描跳过已存在照片，所以 5736 张是 fallback 逻辑生效之前入库的历史遗留数据。

**Choice**: 写一个独立的一次性迁移脚本 `apps/backend/src/cli/backfill-taken-at.ts`，用 SQL `UPDATE photos SET taken_at = datetime(file_mtime,'unixepoch') WHERE taken_at IS NULL AND file_mtime IS NOT NULL` 直接修复历史数据。幂等可重跑。

**Alternatives rejected**:
- 在前端 groupPhotos 加 fallback `photo.takenAt ?? mtimeToISO(photo.fileMtime)`：需要在 shared types 加 fileMtime 字段，前后端逻辑双改，维护负担重
- 在后端 SQL 排序加嵌套 COALESCE `COALESCE(takenAt, datetime(file_mtime,'unixepoch'), createdAt)`：函数包裹列致索引失效，6140 行勉强可承受但扩到 50K+ 时显著劣化
- 在 scan-storage.ts 增量扫描时回写历史 NULL：需要触发全量重扫，时间成本高

**Trade-offs**: 一次性 UPDATE 不可逆——若 mtime 规则有误（如 NAS 复制刷过 mtime），会写入近似值。但 NULL 对用户毫无价值，"错的近似"也比"全无"好；fileHash 字段不变，可在重新解析 EXIF 时再覆盖。

**Evidence**: dev DB 执行 backfill 后 NULL 计数 5734 → 0，二次执行影响 0 行（幂等性）。前端切换"年/月/日"视图分组功能恢复。比双路径 fallback 方案少改 3 个文件 + 不影响排序索引。

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

### [2026-05-07] 常驻 worker 进程必须把 git commit + uptime 暴露给观测层

<!-- tags: worker, supervisor, observability, deployment, ops, design -->

**Background**: 一次 HEIC 修复事故暴露：常驻 worker（PID 52072）跑了 10 小时旧代码 — 修复 commit (76d244c) 早已合入但 worker 进程没重启加载新代码，导致用户手动 retry 仍失败。运维侧没有任何机制能 1 秒看出"代码版本是不是最新的"。这是分布式系统的"幽灵旧代码"问题。

**Choice**: worker 启动时通过 ioredis 写入 `${prefix}:worker:meta` key（TTL 120s + 60s 心跳续期），value 包含 `{ commit, commitTime, startedAt, pid, hostname }`。`/api/admin/health` 路由新增 `worker` 组件读取该 key，前端可一眼看到"worker 跑的是 commit abc123 (2026-05-06)，uptime 5m"。配合 PM2 supervisor 实现"代码改动 → `pnpm workers:reload` → health 立即反映新 commit"的闭环。

**Alternatives rejected**:
- worker 起 HTTP /health 端口暴露：multi-process 部署端口冲突；不需要给外部访问，只给 API 进程读
- worker 写 SQLite 表：需要 schema 迁移；Redis 已有现成连接
- BullMQ 自带 Queue.getWorkers()：返回 BullMQ 内部 worker 元数据但**不**包含 git commit
- 不设 TTL，shutdown() 主动 DEL：SIGKILL 场景（PM2 kill_timeout 后强杀）下 shutdown() 不执行 → key 永久残留 → 显示"幽灵 healthy"

**Trade-offs**: TTL+心跳引入 60s 检测延迟（worker 真挂了 60-120s 后 key 才过期）。可接受，因为：
1. PM2 SIGTERM 触发的 graceful shutdown 会立即 DEL key，常规重启 0 延迟
2. 真崩溃场景下，多 60s 检测延迟比"幽灵 healthy"风险小得多

**Evidence**: 设计 + 实施记录在 `.autopilot/requirements/20260506-4-都一起优化，确实都/state.md`，commit 6da89f6。配套：失败 job 也加了批量 retry 按钮（POST /api/queues/:name/retry-failed + UI），这是 worker 透明化之外另一个防"运维链路黑盒"的工具。两个能力组合：观察"worker 跑的什么代码" + "失败任务一键重试"。

### [2026-05-10] 每日精选首页从「单 hero + 关联 members」升级为「20 entries 全展示 + 每条目独立系列」

<!-- tags: daily-selection, multi-entries, schema-design, dual-write, daily-pick-entries, ui-redesign, design, architecture -->

**Background**: 上一版做"4 源候选池 + AI 选出 1 张 hero + 1.5 阶段为 hero 选 0-8 张时间窗 members"——单 hero 故事完整，但用户每天只看到 1 个回忆主题，整体回忆感不足。诉求是"候选池 20 张照片都让用户能浏览到"。

**Choice**: 候选池 final 20 张全部持久化为"今日入选条目"，每张走完整 narrate（vision）+ AI 选 members + caption 流水线；新增 `daily_pick_entries(id, daily_pick_id, rank, photo_id, title, narrative, score, members JSON, created_at)` 子表 + `UNIQUE(daily_pick_id, rank)` 约束保证 job 幂等；`daily_picks` 既有列保留并与 `entries[rank=0]` **双写同源**——既不破坏 Mac 壁纸 API 与 magazine composer，也让 30 天去重池可继续按"hero photoId"工作；前端首页改为「左侧大图（当前选中）+ 系列缩略条 + 20 缩略图栅格」+「右侧叙事」，URL `?entry=N` 同步当前焦点（用 `useSearchParams` 读 + `history.replaceState` 写，避 useRouter 在 SSR/test 抛 invariant）。

**Alternatives rejected**:
- 把 entries 加到 `daily_picks` 单表 JSON 列：违反范式 + 查询无法索引 + 旧客户端读到非预期 JSON；
- 完全独立 `daily_top_n` 表与 `daily_picks` 平行：API 层须双查，且失去"primary entry = entries[0]"的简洁约束；
- 仅 narrate 1 张 hero、其它 19 张只展示照片+已有 tags：成本省一半但用户期望"每张都有自己的故事"，体验断层；
- 候选池减小到 5-6 张：违反"用户希望浏览全部候选"的诉求。

**Trade-offs**:
- AI 调用次数 1 hero × 3 调用 → ~80 调用（20 narrate + 20 select members），本地 qwen + pLimit(2) 并行下 ~10 分钟，可接受（每天定时 6:00 跑）；
- DB 体积：每天多 ~20 KB（20 行 JSON members）；
- API 响应体增大约 10× （~14 KB）——前端需要 lazy 缩略图 + 大图首屏 eager 兜 LCP；
- 双写同源（dailyPicks 主字段 = entries[0]）需要在 job 内显式同步，存在漂移风险，已用红队验收测试守护；
- 30 天去重必须 UNION 两张表（entries 各 photo_id + members.photoId），不然 19/20 entry 照片次日仍可被重复入选；
- 类型上 `DailyPick.entries: DailyPickEntry[]` 必填，但 wallpaper composer 等读 DB 行视图的旁路用 `Omit<DailyPick, 'entries'>` 隔离避免被强制构造空数组。

### [2026-05-12] 人脸识别选 ONNX Runtime + SCRFD + ArcFace 纯 Node 本地方案，设计偏离 2.5G → 500M

<!-- tags: face-recognition, onnx, scrfd, arcface, local-inference, privacy, coreml, model-selection, design, architecture -->

**Background**: 拾光要新增人物识别（人脸检测 + embedding + 增量聚类），约束：(1) 中文家庭/个人相册场景，**严格本地零云端**——不调 AWS Rekognition / Face++ / Azure Face；(2) 已有原生模块基础（sharp / better-sqlite3 / heic-decode），愿意再加一个；(3) 与 BullMQ `analyze-photo` 队列友好衔接，新建 `detect-faces` 队列 concurrency=2（CPU 密集，与 analyze-photo concurrency=4 隔离避免抢资源）。候选方案：face-api.js (TF.js) / Python insightface 子进程 / 复用 Qwen-VL / **onnxruntime-node + SCRFD + ArcFace**。

**Choice**: 选 **onnxruntime-node + SCRFD-500M + ArcFace MobileFaceNet**，模型权重共 ~16MB，从 `deepghs/insightface/buffalo_s` 下载到 `apps/backend/assets/models/`（`.gitignore` 排除，`pnpm models:download` 脚本拉取 + sha256 固化）。macOS 启用 CoreML EP（实测 123/144 节点加速）。embedding 512 维 L2-normalized，base64 文本存 SQLite 列。聚类用增量 cosine：每张新脸只与同 storageSourceId 的现有 person centroids 做一次 cosine，threshold 0.5（ArcFace 业界经验），>= 归并 + 增量更新 centroid，否则新建 person。

**Alternatives rejected**:
- **face-api.js (TF.js)**：依赖 `@tensorflow/tfjs-node` 原生模块（~200MB）+ FaceNet 128 维精度比 ArcFace 弱，且 TF.js 与 worker_threads 隔离更难。
- **Python insightface 子进程**：精度最高但 IPC 开销大，且要求用户装 Python + 模型 + 依赖，违反"加一个原生包"约束。已有 Whisper Python 子进程先例但那是离线批处理，不是 per-photo 实时调用。
- **复用 Qwen-VL（现有视觉 AI）**：能描述"有几个人"但无法产生稳定 face embedding，跨照片聚类不可能。
- **SCRFD-2.5G**（原设计选型）：精度更高（WIDER hard 77.9 vs 500M 的 68.5），但**公开 ONNX 镜像（immich-app/buffalo_l, deepghs/insightface, yakhyo/face-reidentification）实测均无 2.5G 变体**——buffalo_l 给的是 10G（16.9MB det + 174MB ResNet50，过重），buffalo_s 给 500M+MBF。500M 对家庭相册足够，未来可手动替换 10G 提升精度。
- **YuNet + MobileFaceNet（OpenCV Zoo Apache-2.0）**：商用 license 友好，但当前是个人相册无商用诉求；保留作为未来商用切换路径文档。

**Trade-offs**:
- License 是 non-commercial research：拾光个人/家庭可接受，CLAUDE.md 明示限制；
- SCRFD-500M 精度比 2.5G 低 ~9 pp（WIDER hard），漏检小脸 / 极端角度时偶有；最小 face bbox 边长 80px 过滤进一步降低 false positive；
- onnxruntime-node 加载模型常驻 ~150MB RSS（per worker），concurrency=2 = ~300MB；ANE / CoreML EP 在 darwin 自动启用，CPU/性能预算可接受；
- 跨 storageSource 不聚类：一个 NAS 一个 person 空间，不会出现"插拔 NAS 后人物错乱"，与 bursts 表设计一致。

**Evidence**: 设计 + 实施记录在 `.autopilot/sessions/who/requirements/20260510-帮我深入调研下相关技/state.md`（autopilot 完整流程：design 审批 → 红蓝队对抗 → QA 2 轮 → 7 BLOCKER 全修），merge commit `62fb4eb`。真实推理验证：CoreML EP 启用日志 `[face] EPs: ["coreml","cpu"]`，detector 端到端跑 640×640 灰图返回 0 face（符合预期），SCRFD ONNX session 加载 ~200ms。

### [2026-05-13] 人脸聚类引入「qwen 语义属性 + 临界硬过滤」+ JSON 字段预留未来扩展

<!-- tags: face-recognition, face-clustering, qwen-vl, semantic-attributes, hybrid-clustering, cosine-threshold, json-schema, schema-version, future-proof, design, architecture -->

**Background**: 拾光人脸识别经过模型升级（buffalo_s → buffalo_l）+ SCRFD tensor 撞车修复 + EXIF rotate + 代表头像 sim 选择等多轮 hotfix 后，仍有「同一人 cosine 0.65 临界值合并不可靠」的问题：buffalo_l ArcFace 在中文家庭/亚洲面孔场景下，临界 [0.55, 0.7) 错合并率高（spot-check person #635b 准确率 2.2%）。根因是 embedding 反映几何特征但不区分语义维度（gender / age），导致父女、母子、同肤色陌生人在临界区间错合。

**Choice**: 不调阈值、不上专用属性模型，而是 **复用现有 llama-server qwen-vl 实例为每张脸打 6 维语义属性**（age_band / gender / hair / glasses / facial_hair / expression），存到 `faces.attributes` JSON 列。聚类改双阈值：cosine ≥ 0.7 直接合并、< 0.55 直接不合并、**[0.55, 0.7) 临界区间用属性硬过滤**（gender 不同或 age_band 跨 2 档以上拒绝合并）。`persons.attribute_summary` 用多数票聚合 person 内所有 face 属性，临界判断时 face 与 person summary 比对。

设计的「未来扩展」要点：
- `schema_version: 1` 字段 + JSON 字符串列：未来加 `is_billboard / accessories / view_angle / text_description` 等无需 DB migration
- 枚举值固定 + `unknown` 兜底：避免 qwen 自由发挥，下游可穷举处理
- 默认开关 `midZoneAttrFilter`：消融实验比对开启 vs 关闭的 persons 数量差，证明硬过滤效果

**Alternatives rejected**:
- **纯调阈值 0.55 → 0.6**：相同人不同表情/角度 cosine 经常落在 0.55-0.65，调高 → 召回率掉
- **加权评分**（cosine 0.7×权重 + 属性匹配 0.3×权重）：调参复杂，"严格硬过滤"用户更可解释（"性别不同就不合并"）
- **独立小模型**（Florence-2 / qwen2-vl-2b）：新增 onnxruntime 会话 + 模型下载，违反"复用现有基础设施"原则。先用 qwen-vl 验证需求覆盖度，性能不够再换
- **独立列**（gender / age_band 各一列）：未来加属性要 migration，且不确定的"未知需求"（人物画像、广告牌过滤、全文检索）字段如何穷举？JSON + schema_version 是更前瞻的选择

**Trade-offs**:
- 每张脸 ~2-3s qwen 调用 → 6175 张全量 ~ 8-10 小时（worker concurrency=2）；500 张验证集先跑
- qwen 失败率不为零：`config.face.attributeRetries` 控制重试，仍失败 `attributes=null` 退化为纯 cosine（不阻塞 face 入库）
- 「严格硬过滤」可能在 qwen 误判 gender 时拆同人。设计选择"宁可漏过滤不误拆"：person 样本 < 2 时不投票、双方有 unknown 不算冲突、attributes=null 退化合并
- 「清空重建」persons / faces 接受丢失用户手动 name / nickname（用户已显式确认）

**Evidence**: 设计 + 实施 + QA 完整记录在 `.autopilot/requirements/20260513-开始实现方案-C-并重跑/state.md`（autopilot：brainstorm 9 决策 → Plan Reviewer PASS → 蓝/红队对抗 → contract-checker 1 修 → QA 89/89 ✅）。merge commit `69e8764`。500 张验收由用户手动跑 `node scripts/rerun-faces.mjs --limit 500 --clear`。

### [2026-05-14] 单 centroid → Apple 多原型方案：每 person 存 1-5 个 sub-prototype，匹配规则 max(cosine)

<!-- tags: face-clustering, multi-prototype, exemplar, apple-photos, cross-age, cross-appearance, kmeans, arcface, centroid, design, architecture -->

**Background**: 拾光经过 Phase 2 quality-aware 三件套（[[人脸增量聚类的「centroid 雪球 + 垃圾桶 cluster」陷阱]]）后单 cluster 纯度达 100%，但**单 centroid 设计是天花板**——同一人 5 岁/20 岁的 ArcFace embedding 在球面上距离很远，centroid 是几何中点不代表任何外观；戴眼镜/口罩/胡子同理。Apple Photos 用 ["a set of canonical exemplars X₀..Xc per person"](https://machinelearning.apple.com/research/recognizing-people-photos)（two-pass clustering: greedy + HAC），Immich 保留全量 embedding 做 k-NN，只有 PhotoPrism 和拾光是单 centroid。

**Choice**: 每 person 存 1-5 个 sub-prototype（K_MAX=5）代表不同"外观模式"。新表 `person_prototypes` 关系型（不进 JSON 列，512 维 base64 ~2.7KB 入 JSON 会撑爆 row）。匹配规则改 `max over i of cosine(new, prototype_i)`。增量规则：找最近 prototype，cosine ≥ 0.88 → running weighted avg 更新；否则未满 K_MAX 就新建一个原型；满了就合并最相似两个再插。merge 接口：source.prototypes 迁到 target，总数 > K_MAX 时 mini-batch k-means 蒸馏。

**保留 persons.centroid_embedding** 作粗筛索引：先 cosine to centroid 快速过滤掉明显不像的 person，再去查 prototypes 表。**保留 quality-aware（LOW face 不进 prototype）+ attribute filter（gender/age_band 硬过滤）**——多原型只在匹配规则上叠加 max，不替代 [[人脸增量聚类的「centroid 雪球 + 垃圾桶 cluster」陷阱]] 的三件套。

**Alternatives rejected**:
- **全量 embedding k-NN（Immich 式）**：1485 person × 平均 3-4 face = 5444 embedding × 512 × 4 bytes = 11MB 内存可接受，但匹配复杂度 O(F) 而非 O(P×K)，大库不扩展
- **JSON 列存 prototypes**：512 维 base64 一个 ~2.7KB × K=5 ~13.5KB/row，drizzle update 整列重写性能差，且不能 partial update 单个原型
- **upper-body embedding（Apple Pass 1 双信号）**：要新模型（DINOv2 或 CLIP 截上半身），引入额外 onnxruntime session + 模型权重下载。先做单 face embedding 多原型，验证收益后再叠 upper-body（P4 future）
- **UI 暴露 sub-prototype 让用户标"小时候"/"戴眼镜"**：本次范围只做底层（P1 基建 + P2 主流程），UI 暴露留 P3 future。schema 已留 `label TEXT NULL` 字段

**Trade-offs**:
- K_MAX=5 是启发式（一个人 3-7 个外观模式合理上限）。回填时 k = clamp(round(memberCount/40), 1, 5)。后续可改 silhouette 自适应
- **自实现 mini-batch k-means（~80 行）**而非 ml-kmeans 依赖：5444 face 规模太小不值得引依赖；cosine 距离需 custom 实现，库内 Euclidean k-means 不能直接用
- 失败兜底：prototype 表读失败/单脸更新失败/k-means 异常 → 退回单 centroid 路径，不阻塞 face 入库
- `manualOverride=true` 的 person 跳过 prototype 蒸馏，保留用户手动状态

**Evidence**: 设计 + 实施 + QA + 真实验收完整记录在 `.autopilot/requirements/20260514-需要，按照苹果的方案/state.md`。verify-prototypes-vs-centroid.ts 在 5444 张已分配 face 上量化对比：新方案 self-consistency 83.5% vs 旧单 centroid 78.7%，净增益 +261 张面孔正确归位，5.9% 真实增益（旧错新对，cosine 0.73-0.84 区间的边缘正例）。merge commit `f66859c`。设计稿初版 `prototypeCoarseFilter=0.70` 在验收时实证错误，见 [[ArcFace 边缘正例 cosine 分布陷阱]]。

### [2026-05-15] 用人物识别优化每日精选：选叙事增强单路径（仅传命名 nickname 数组给 narrate prompt）

<!-- tags: daily-selection, face-recognition, narrate-prompt, person-injection, scope-control, design, superseded -->

> **Superseded by [2026-05-15] 撤销 narrate 命名人物注入** — 真实端到端跑 narrate 验证后发现 AI 角色反转 + 产品调性偏向「你」呼告体，注入逻辑已回滚。`peopleNicknames` 字段与 self 过滤保留。

**Background**: 人脸识别管线（persons + faces 表，SCRFD/ArcFace 聚类，用户已命名 7 个核心家人 nickname）已就绪，但 daily-selection narrate 仍泛化（"那天笑得开心"）。优化路径有 4 条候选：(A) 候选池加权偏向含命名人物的照片，(B) members 选权用人物交集硬排序，(C) narrate prompt 注入"画面里有谁"叙事增强，(D) 新增"故人重逢"候选源。

**Choice**: 仅做 (C) 叙事增强单路径。narrate user.txt 加 `{people}` 占位符，candidate-pool 在 cluster 之后批量 JOIN faces+persons 拿命名 nickname 数组（过滤 self/hidden/未命名）传给 AI，让文案能写"和妈妈、六六笑得开心"。**不动**候选池权重 / members 选择 / 加新源。配套机制：新增 settings.selfPersonId 让用户标"这是我自己"，self 在源头被过滤（视角设定"你"=拍照人不在画面）。

**Alternatives rejected**:
- **(A) 候选池加权**：会让久远 / 风景 / 美学高分照片被人物常出现的近期照片挤掉，破坏 4 源混采的均衡和"久远度优先"产品哲学。
- **(B) members 选权**：当前 members 已交 AI 选（看时间窗 + 主题），加人物硬排序会引入"必须同人物组合才入选"的过严约束，可能让有故事性的不同人物群体被排除。
- **(D) 新增候选源**：基于"出现高频人物 + 30 天未出现"的源需要更多调权和去重逻辑，本次范围内做不深。
- **传更丰富的人物上下文（memberCount / bbox 占比 / 主从）**：信号越多噪声越多。命名 nickname 数组已足够强（妈妈/六六这些中文亲属词 AI 直接懂关系），加 memberCount AI 还要做"亲密度"中间判断，反而绕远路。

**Trade-offs**:
- 立即可见但增益受限于命名覆盖率：当前 7 个命名 person 覆盖约 2600 张照片（约 42% 含脸照片），未命名人物文案仍不动；
- AI 软约束失效风险：system.txt 写"你=拍照人不在画面"但 AI 仍偶尔把"你"映射到画面里的人，prompt 工程后续可继续打磨；
- 候选池本次没加权 → 含命名人物的照片入选概率不变，可能某日精选全是风景/未命名照片（人物增益不可见），需要 (A) 路径补；
- 视频侧暂不动（detect-faces 跳过 mediaType='video'）；
- self 用 settings 单 key（不加 persons.isSelf 列）见下一条决策。

**Evidence**: 真实 AI 验证一次跑出 entry 标题"那年六六的倔强"含命名人物"六六"，narrative 0 处出现 self 称呼"赵桂雄/爸爸"。设计 + 红蓝队对抗（39 acceptance test 全绿）+ contract-checker (22/22 PASS) + qa-reviewer (17/17 PASS) 完整记录在 `.autopilot/sessions/prompt/requirements/20260512-近期新加了人物识别能/state.md`。merge commit `6d1f4c0`。

### [2026-05-15] self 标记用 settings.selfPersonId 单 key，不加 persons.isSelf 列

<!-- tags: settings, schema-design, single-value-pointer, isSelf, persons, design -->

**Background**: 需要标记"哪个 person 是用户本人"（让 narrate 视角设定生效：self 在画面里不传给 AI）。两种存储选择：(A) settings 表新加 key='selfPersonId' value=personId；(B) persons 表加 is_self BOOLEAN 列。

**Choice**: (A) settings 单 key。helper `getSettingValue/setSettingValue/deleteSetting` 三函数无内存缓存（每次 SELECT），persons 路由 GET 接口在 handler 内一次性查 selfPersonId 缓存到闭包，每行派生 isSelf 字段。

**Alternatives rejected**:
- **persons.is_self 列**：self 是全局**单值指针**（最多一个 person），不是 person 本征属性。列设计允许"多 person 同时 is_self=true"成为可能错状态，需要应用层防御（事务、独占约束）。settings 单 key 天然唯一，无并发竞态。
- **缓存到进程内**：写后失效语义复杂（多进程？热重启？），SQLite 单条 SELECT 本身已极快（<1ms），不值得引入缓存层。

**Trade-offs**:
- 无 schema migration、无 schema 漂移、无 fixture 改造（既有 settings 表已存在）；
- 多了一次 SQL（每次 GET 列表 / 详情都查），可忽略；
- 未来扩展：如果要加 isFamily / starred / 候选池加权时，可同模式新增 settings 键（如 `familyPersonIds` JSON 数组），或者那时再加 persons 表列承载多个标记。

**Evidence**: API 契约（PUT/DELETE /api/persons/:id/self 幂等设计，DELETE cleared:boolean 而非 404）+ 21 个 acceptance test 覆盖（settings-helper 6 + persons-self 15）全绿。merge commit `6d1f4c0`。

### [2026-06-02] 后端 API 纳入 PM2 开机自启：复用现有 resurrect launchd，仅 pm2 save，不跑 pm2 startup

<!-- tags: pm2, ecosystem, launchd, resurrect, autostart, boot, backend-api, deployment, ops, mac-app, control-center, design -->

**背景**: mac app 的"开机服务自动就绪"链路从未闭合——`SMAppService` 只让菜单栏 app 本身自启；ControlCenter 按钮调 `/api/runtime/workers/*` 需后端 API 先在跑；而后端 API 此前无任何自启机制（不在 PM2、无 launchd）。

**决策**: 在 `ecosystem.config.cjs` 追加 `relight-api` 条目（与 relight-workers 同构：node + `--import tsx` 直跑 `src/index.ts`），`pm2 start ecosystem.config.cjs` + `pm2 save` 即可。

**关键洞察（命名误导）**: 用户机器上 `~/Library/LaunchAgents/com.stringzhao.pm2-qwen.plist` 名为 qwen，**实际 ProgramArguments 就是通用 `pm2 resurrect`**（RunAtLoad=true，PATH 含 /opt/homebrew/bin + nvm node）。因此**不需要再跑 `pm2 startup`**——只要进程进了 `~/.pm2/dump.pm2`，现有 launchd 开机就会把 qwen + api + workers 全部 resurrect。再装 startup 反而会创建第二个 resurrect launchd → 双重启动冲突 + 需 sudo。

**Trade-offs**:
- 复用 launchd：零冲突、零提权；代价是依赖一个名字有误导性的既有 plist（已在设计文档/知识库标注其真实行为）。
- 非破坏性验收：用 `pm2 delete relight-api && pm2 resurrect` 模拟 boot，绝不 `pm2 kill`（qwen 是用户在用的 31GB AI 服务）。

**Evidence**: `ecosystem.config.cjs` relight-api 条目；6 条 det-machine 谓词全 PASS（P5 delete→resurrect 复活 API 且 qwen pid 3982 未变）；feat commit `102078f`。相关：[[pm2-env-path-boot-resurrect-spawn-enoent]]

### [2026-06-02] macOS App 发布机制：GitHub Release + Homebrew cask tap；私有源码仓库做 brew 分发必须改公开

<!-- tags: release, github-actions, homebrew, cask, tap, xcodebuild, mac-app, distribution, private-repo, public, deployment, design -->

参考 claude-code-buddy 为「拾光」mac App 实现 tag 驱动发布：推送 `vX.Y.Z` → `.github/workflows/release.yml` 在 macOS runner `xcodebuild archive`（Release/arm64/ad-hoc）→ 打包 `Relight-vX.Y.Z.zip` → GitHub Release → job2 下载算 sha256 → 更新 `strzhao/homebrew-relight` tap 的 cask → sync 回 main。relight 用 Xcode 工程（archive 自动产出完整 .app），比 buddy 的 SwiftPM 流程简单；无 CLI 故 cask 去掉 `binary` 行；用户确认仅 arm64。

**关键决策（私有 → 公开）**：buddy 是 public 仓库，relight 原为 **private**。Homebrew cask 的 `url` 必须**匿名可下载**，私有仓库 release 资产对匿名请求返回 **404**（CI job2 的 `curl` 与本地匿名 curl 都 404，但带 auth 的 `gh release download` 能下）。用户选择把 relight 改为 public（`gh repo edit --visibility public --accept-visibility-change-consequences`）而非把资产托管到公开 tap 仓库。改公开后匿名下载 200，brew 全链路打通。

**least-privilege token**：job2 checkout 用默认 `GITHUB_TOKEN`（对本仓库 contents:write，承担 sync-back-to-main），跨仓库推 tap 仅在该步注入 `TAP_GITHUB_TOKEN`；附带收益：GITHUB_TOKEN 的 push 不触发 ci.yml，消除冗余 CI run。建议后续把 TAP token 换成仅限 homebrew-relight 的 fine-grained PAT。

**Evidence**: `.github/workflows/release.yml`、`homebrew/Casks/relight.rb`、tap 仓库 `strzhao/homebrew-relight`；release v0.1.0 资产 sha256 f9f66841…；`brew install --cask relight` → /Applications/Relight.app 0.1.0；commit 7f013da + cask-sync 538f052。相关：[[headless-ci-xcodebuild-shared-scheme-xcode-version]]

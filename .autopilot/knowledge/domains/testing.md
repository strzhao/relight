# 测试 (Testing)

> 从 decisions.md 和 patterns.md 拆分 | 父级索引: ../index.md

---

## 模式与教训

### [2026-07-03] 组件 DOM 迁位致「区域切片」acceptance 测试失效 — 位置无关边界 + 契约演进反转断言

<!-- tags: dom-order, region-slice, acceptance-test, contract-evolution, indexof, migration, red-team, frontend, wallpaper, autopilot, testing -->

**Pattern**: 红队 acceptance 测试常用 `slice(indexOf('testid-a'), indexOf('testid-b', startIdx))` 切一段 DOM 区域断言「a 元素内同时含 X 与 Y」。这隐含 **DOM 顺序假设**（a 在 b 之前）。当组件迁位打破顺序，`endIdx` 变 -1，整条断言 FAIL——不是实现有 bug，是测试绑定了旧布局。本案：`CaptureDateline` 从 masthead（entry-title 之前）迁到 FolioFooter（entry-title 之后），既有 datetime 测试 3 处区域切片全 FAIL。

**Fix / Lesson**:
1. **位置无关更稳健**：从 testid 切到末尾 `html.slice(startIdx)`（前提：该元素是后续末尾），或直接断言元素自身文本。避免「A 在 B 之前」的 indexOf 双端切片——它绑定 DOM 顺序，迁位即脆裂。
2. **契约演进时反转既有断言是合法的**：当 design 合法变更（如「品牌保留」→「品牌删除」），既有 acceptance 测试的 `toContain` 需同步反转为 `not.toContain`。这与「改测试迁就实现 bug」不同——契约本身变了，测试编码的是旧契约。蓝队/编排器可按新契约机械同步既有测试（非红队铁律违反）。
3. 区别于 [[2026-07-02]]：那条是测试意图正确但**过严**（与设计明确决策冲突，需升级用户）；本条是契约**本身演进**，机械反转即可。

---

### [2026-07-02] 红队验收测试可能与设计文档的「明确决策」冲突 — 升级 review-accept，用户授权后放宽对齐设计

<!-- tags: red-team, acceptance-test, design-conflict, review-accept, anti-rationalization, daily-selection, dedup, backfill, autopilot, escalate -->

**Pattern**: 红队测试不仅会有 fixture setup bug（见 [[2026-05-15]]），还可能把设计文档的「单日」场景外推为「多日」并写下与设计**明确决策**冲突的硬断言。本案：设计决策 7 明确承认「顺序回填 30 天去重边界效应」，但红队多日测试硬断言「每日都落库」。读 worker 源码（candidate-pool.ts 的 fillUp + 跨表去重）确证 impl 正确、测试过严后，不能在不改 worker（设计禁止）或改锁定测试（框架禁止）前提下修复。

**Resolution**: (1) 读源码拿运行时证据证 impl 正确（**不凭假设升级**——先验证 fillUp 全消费假设再呈交）；(2) `gate: "review-accept"` 把冲突 + 源码证据呈交用户裁决；(3) 用户选「放宽测试对齐设计」后，保留强断言（exit 0 / 首日必落库 / 升序 / 落库日在目标范围内）、移除与决策冲突的硬断言、注释根因 + 设计决策编号。**关键**：红队铁律「不许改测试」在**用户显式授权 + 对齐设计（非弱化断言遮蔽 bug）**时可破例；同步改 staging 副本防 stop-hook 重合流回滚。

---

### [2026-05-15] 红队 acceptance fixture 自身 bug — anti-rationalization 的边界与处理路径

<!-- tags: vitest, acceptance-test, fixture, red-team, anti-rationalization, autopilot, contract-checker, bug -->

**Pattern**: 红队测试断言正确但 fixture setup 未能构造测试意图所需的场景 → 测试永远 fail，但实现没有 bug。处理路径：(1) 不修红队测试（铁律）；(2) 不修实现去适配错误 fixture；(3) QA 报告诚实记录根因证据；(4) 走 `gate: "review-accept"` 把决策交给用户。

---

### [2026-05-10] vitest fake timer + React 19 createRoot 不兼容 — setup 需 act+flushSync polyfill

<!-- tags: vitest, react-19, fake-timer, create-root, flush-sync, act, scheduler, polyfill, test-infra, bug -->

**Lesson**: React 19 `createRoot` 是 concurrent，commit 走 scheduler 的 setTimeout 调度。`vi.useFakeTimers()` 默认拦截 setTimeout → commit 永不发生。必须在 vitest.setup.ts 加三层 polyfill：`IS_REACT_ACT_ENVIRONMENT=true` + `flushSync` 包 render + `advanceTimersByTime` 内 `act()` 包裹。

---

### [2026-05-10] jsdom 不实现 setPointerCapture + `<img>` 默认 draggable 吞 mousedown — UI 交互必须 e2e

<!-- tags: jsdom, pointer-events, set-pointer-capture, native-drag, img, draggable, e2e, playwright, ui-interaction, bug -->

**Lesson**: 凡是涉及 pointer capture / 触摸 / 拖拽 / native draggable 元素的交互功能，jsdom 单元测试不能替代浏览器验证——必须有 Playwright e2e 把守。

---

### [2026-05-13] vitest `vi.mock` 路径以测试文件位置为基准（不是实现文件）

<!-- tags: vitest, vi-mock, relative-path, hoisted, module-resolution, test-infra, blue-red, bug -->

**Lesson**: 写 `vi.mock(path)` 时路径相对的是测试文件位置，不是被测代码位置。测试文件比实现文件深一级（`__tests__/foo.test.ts` 测 `foo.ts`），mock 路径要在实现的 import 字符串前面多一个 `../`。

---

### [2026-05-17] vitest spawn mock 用 mockImplementation + setImmediate，避免 fixture timing 抢跑

<!-- tags: vitest, vi-mock, child-process, spawn, mockImplementation, setImmediate, fixture, timing, eventEmitter, beforeEach, bug -->

**Fix**: emit schedule 放 `mockImplementation` 内部 + 用 setImmediate（不用 queueMicrotask）。microtask 会在 await 完成前立刻 fire，listener 尚未注册；macrotask 等到当前同步代码段全部跑完。

---

### [2026-05-06] BullMQ Job mock 必须含 log/updateProgress 等接口方法

<!-- tags: bullmq, vitest, mock, job, testing, integration -->

**Lesson**: BullMQ Job 接口包含 `log`、`updateProgress`、`updateData` 等方法，直接传 `{ data, id }` 字面量是不完整的 mock。建议项目内统一一个 `createMockJob` helper。

---

### [2026-05-09] 红队 vi.mock 平铺导出 vs 蓝队 `api` 对象——TDD 契约对齐策略

<!-- tags: vitest, vi-mock, tdd, blue-red, contract-drift, ssr, react, mock-shape, hook-vs-prop, design -->

**Lesson**: vi.mock 的 export 形状一旦写死，被测组件的 import 形状必须 100% 匹配。实现侧应同时提供"对象 API"和"平铺函数"两套导出（兼容层），让蓝队的 `api.xxx()` 和红队 mock 的 `getXxx()` 都能解析。

---

### [2026-06-17] CLI 黑盒 spawnSync 测试的 fixture 不能落 /tmp — CI Linux tmpdir=/tmp 与被测 /tmp 排除逻辑自吞

<!-- tags: vitest, spawn-sync, cli-test, fixture, tmpdir, ci, linux, os-homedir, black-box, path-filter, bug -->

**Background**: backfill-thumbnails CLI 查询故意 `not(like(filePath, "/tmp/%"))` 排除 /tmp 测试残留。测试 fixture 用 `mkdtempSync(os.tmpdir())`：本地 mac tmpdir=`/var/folders/*`（非 /tmp）→ fixture 不被排除 → 测试绿；CI Linux tmpdir=`/tmp` → fixture 落 /tmp → **被自己排除** → total=0 全 14 红。本地全绿 + 无 `.env` 全绿，纯 Linux 特有，极难本地复现。

**Lesson**: 黑盒跑 CLI 的测试，fixture 路径不要用 `os.tmpdir()`——若被测代码有任何 `/tmp` 排除或路径特殊处理，CI Linux（tmpdir=/tmp）会让 fixture 自吞，本地（mac tmpdir=/var/folders）却绿。改用 `os.homedir()`（mac `/Users/*`、CI `/home/runner`，均非 /tmp，且不在仓库工作树里不污染 git）。判断准则：**fixture 路径绝不能命中被测代码的任何路径过滤规则**；当本地/CI tmpdir 不同时，用显式非 /tmp 目录。

---

### [2026-06-17] spawnSync 跑 tsx CLI 用 `node --import tsx`，别依赖 .bin/tsx shell wrapper

<!-- tags: tsx, spawn-sync, cli-test, shell-wrapper, pnpm, symlink, node-import, ci, linux, cross-platform, bug -->

**Background**: `node_modules/.bin/tsx` 在 pnpm 结构下是 `#!/bin/sh` shell wrapper（非 symlink），内部用 `$basedir/node` + 相对路径 `.pnpm/tsx@x/node_modules/tsx/dist/cli.mjs`。`spawnSync(TSX_BIN, [cli])` 让 OS 解析 shell wrapper，CI Linux 下 `$basedir` 解析 pnpm symlink 失败 → exec 找不到 cli.mjs → 子进程 status null → `result.status ?? -1` = exit -1 全崩；本地 mac 碰巧解析成功。

**Lesson**: 黑盒 spawnSync 跑 .ts CLI，用 `spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args])`（node 原生 ESM loader hook），绕过 shell wrapper，无 basedir/shell 依赖，mac/Linux 一致。前提：Node ≥20.6（`--import` 稳定），CI `node-version: 20`（=最新 20.x）满足。诊断 spawnSync 子进程崩溃：先查 `result.status`（null=被 signal 杀/未启动 vs 数字=正常退出），再查 stderr；shell wrapper 崩溃常表现为 status null + 空 stdout。

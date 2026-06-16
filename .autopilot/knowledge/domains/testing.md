# 测试 (Testing)

> 从 decisions.md 和 patterns.md 拆分 | 父级索引: ../index.md

---

## 模式与教训

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

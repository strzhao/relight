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
task_dir: "/Users/stringzhao/workspace/relight/.claude/worktrees/video/.autopilot/sessions/video/requirements/20260506-按-.autopilot-sessions-video"
session_id: 
started_at: "2026-05-06T01:08:52Z"
---

## 目标
按 .autopilot/sessions/video/requirements/20260505-当前的-AI-分析只支持/HANDOFF-EFG.md 的剩余任务清单做完阶段 E、F、G

> 📚 项目知识库已存在: .autopilot/。design 阶段请先加载相关知识上下文。

## 设计文档

完整设计已写入计划文件 `/Users/stringzhao/.claude/plans/velvet-launching-kernighan.md`，已用户审批通过。摘要如下：

**阶段 E — daily-selection 视频路径**
- E1: `daily-selection.ts:78-91` candidateSummaries 加 `[图片]` / `[视频 NN 秒]` 标识；select system.txt 加视频说明
- E2: `daily-selection.ts:148-167` 加 mediaType==='video' 分支，读 thumbnailPath cover JPEG（绕开 sharp 视频解码异常 + OOM）；thumbnailPath null 时 throw 触发已有模板 fallback
- E3: 新建 `prompts/v2/daily/narrate-video/{system,user}.txt`；`daily-selection.ts` 阶段 2 按 mediaType 加载不同 prompt 并替换 `{transcript_excerpt}` `{video_pacing}` 占位

**阶段 F — 前端视频展示**
- F1: `photo-card.tsx` 加视频角标 ▶ + 时长（lucide-react Play + 新 `formatDuration` util）
- F2: `daily-hero.tsx` 加视频 overlay（pointer-events-none 大圆 ▶）
- F3: `photos/[id]/page.tsx` 完整改写为 RSC 拉 photo+analysis，按 mediaType 分支渲染（image→`<img>`，video→`<video controls>` + `<track>` 字幕）；分析区块视频含 transcript 折叠（原生 `<details>`）+ videoPacing badge + motionScore 进度条
- F4: `routes/photos.ts` 加 `/raw` (Range 流) + `/subtitles.vtt` (transcriptSegments → WebVTT)
- F5: `packages/shared/src/routes.ts` 加 `photos.raw` + `photos.subtitles`

**阶段 G — 可观测性 + 文档**
- G1: `apps/backend/src/index.ts` 启动时调 `detectVideoCapability` + `detectWhisperCapability`，console.log 能力状态（fail-soft catch 包裹）
- G2: 项目根 `CLAUDE.md` 加 ffmpeg/Whisper 环境要求 + 回填 CLI 命令 + 数据流视频分支说明

**关键约束**: shared types `mediaType?` 保持可选（向后兼容）；失败用 throw 触发模板 fallback（不抛出 BullMQ）；遵循 `decisions.md` 的 sharp `withoutEnlargement: true` + 格式门规约。

## 实现计划

按依赖顺序执行：

- [ ] G2 CLAUDE.md 更新（环境要求 + 命令 + 数据流）
- [ ] G1 启动日志：`apps/backend/src/index.ts` 加 detectVideoCapability + detectWhisperCapability
- [ ] E1 daily-selection.ts candidateSummaries 加 mediaType 标识 + select system.txt 视频说明
- [ ] E2 daily-selection.ts 阶段 2 视频分支（读 cover JPEG）
- [ ] E3a 新建 prompts/v2/daily/narrate-video/{system,user}.txt
- [ ] E3b daily-selection.ts 阶段 2 prompt 加载 + 占位替换
- [ ] F5 packages/shared/src/routes.ts 加 raw + subtitles
- [ ] F4 routes/photos.ts 加 /raw (Range) + /subtitles.vtt
- [ ] F1a apps/web/lib/format-duration.ts (新)
- [ ] F1b photo-card.tsx 视频角标
- [ ] F2 daily-hero.tsx 视频 overlay
- [ ] F3 photos/[id]/page.tsx 完整改写
- [ ] 红队测试 E daily-selection-video.acceptance.test.ts
- [ ] 红队测试 F1 photo-card-video.acceptance.test.tsx
- [ ] 红队测试 F4 photos-video.acceptance.test.ts (raw + subtitles)

## 红队验收测试

红队已生成三个验收测试文件（基于设计规约，与蓝队实现完全隔离）：

1. `apps/backend/src/jobs/__tests__/daily-selection-video.acceptance.test.ts` (3 场景)
   - winner=video 时 `adapter.getFileBuffer` 不被调用，`fs/promises.readFile` 被调用
   - winner=video 且 thumbnailPath=null 时不抛出异常，且写入 dailyPicks 含非空 title+narrative
   - winner=video 时 `aiClient.analyzePhoto` 第 4 参数 (userPrompt) 含 transcript 文本（占位替换生效）

2. `apps/web/__tests__/photo-card-video.acceptance.test.tsx` (6 场景)
   - mediaType='video' + durationSec=42 → 渲染 `lucide` 图标 + "0:42" 文本
   - mediaType='video' + durationSec=125 → 渲染 "2:05"
   - mediaType='image' / undefined → 不渲染角标

3. `apps/backend/src/routes/__tests__/photos-video.acceptance.test.ts` (6 场景)
   - `/raw` 不带 Range → 200 + Accept-Ranges: bytes
   - `/raw` Range: bytes=0-1023 → 206 + Content-Range: bytes 0-1023/4096 + Content-Length: 1024
   - `/raw` 不存在 photo → 404
   - `/subtitles.vtt` 有 segments → text/vtt + WEBVTT + 含 segment 文本
   - `/subtitles.vtt` 空 segments → 200 + 仅 WEBVTT 头
   - `/subtitles.vtt` 不存在 photo → 404

**测试约定**: backend 用 in-memory better-sqlite3 + drizzle + `vi.mock("../../db")` + Hono `app.request()`；web 用 `react-dom/server.renderToString` + HTML 字符串断言（`@testing-library/react` 未安装）。

## QA 报告

### 轮次 1 (2026-05-06T09:31Z) — ✅ 通过

#### Tier 0: 红队验收测试 ✅
- `apps/backend/src/jobs/__tests__/daily-selection-video.acceptance.test.ts`: 3/3 ✅
- `apps/backend/src/routes/__tests__/photos-video.acceptance.test.ts`: 6/6 ✅
- `apps/web/__tests__/photo-card-video.acceptance.test.tsx`: 6/6 ✅
- 合计: 15/15 通过

> 备注: 红队首轮 mock 不完整 (缺 `job.log`) 和两个错误假设（dailyPicks 无 ai_model 列；mock 5 字节 buffer 非有效 JPEG），均由红队 agent 自身修正（保持 isolation，未读 implementation）。修正属测试设计 bug（基础事实与生产 schema 不符），非断言变更。

#### Tier 1: 基础验证 ✅
- `pnpm typecheck`: ✅ 4/4 packages 通过 (turbo cache hit)
- `pnpm lint`: ✅ 0 errors, 3 warnings (仅 biome-ignore 注释，非阻塞)
- `pnpm build`: ✅ backend tsup + web Next.js + shared tsup 全部成功 (12.5s)
- `pnpm test`: ⚠️ 11 test files / 52 tests 失败 — 但全部为 pre-existing failures（来自 phase A-D），通过 `git stash` 基线回归确认与 E/F/G 无关。本次相关测试（analyze-video-branch, daily.test, 红队 3 个）100% 通过。

#### Tier 1.5: 真实场景验证 ✅

**场景 5 — G1 启动日志能力检测**
执行: `pnpm --filter @relight/backend dev`（tail logs 12s）
输出:
```
[startup] video: ffmpeg=✓ ffprobe=✓ whisper: python=✓ script=✓ → video_analysis_available=true
[relight] 后端服务已启动: http://localhost:4243
```
✅ 启动日志格式符合设计，全部能力检测正常。

**场景 4 — F4 /raw + Range 路由**
执行: 
```
curl -sI -H "Range: bytes=0-1023" http://localhost:4243/api/photos/<id>/raw
curl -sI http://localhost:4243/api/photos/<id>/raw
```
首次执行返回 404（path.join bug —— filePath 为绝对路径时与 rootPath 拼接产生重复前缀）。修复 photos.ts:290 `path.join` → `path.resolve` 后:
```
HTTP/1.1 200 OK + Accept-Ranges: bytes + Content-Length: 2113344
HTTP/1.1 206 Partial Content + Content-Range: bytes 0-1023/2113344 + Content-Length: 1024
```
✅ Range 解析与流式分片正确。

**场景 4b — F4 /subtitles.vtt（无 segments fallback）**
执行: `curl -i http://localhost:4243/api/photos/<id>/subtitles.vtt`
输出: `200 + Content-Type: text/vtt; charset=utf-8 + body="WEBVTT"`
✅ 空 segments 返回最小有效 VTT。

**场景 3 — F3 详情页渲染（image 分支）**
执行: `curl http://localhost:4743/photos/<image-id>`
输出: `200 + 53KB HTML + <img src="...original" alt="IMG_3002.HEIC">`
✅ image 分支正确渲染 `<img>` 而非 `<video>`，无 React 错误。

**场景 1+2 — 视频路径运行时验证 ⚠️ N/A**
当前数据库无 `media_type='video'` 记录（`SELECT COUNT(*)=0`），无法在生产 db 跑 daily-selection 视频路径 + 前端 video 角标验证。视频分支由 15 个红队 acceptance test（含 vi.mock + real sharp 处理）+ 单元测试覆盖。运行时验证留待用户后续扫描视频文件后补做。

#### Tier 2: AI 审查（编排器简化版）

**Tier 2a: 设计符合性** ✅
- E1 candidateSummaries 含 `[图片]` / `[视频 NN 秒]` 标识 — 已在 daily-selection.ts:78-91 实现
- E2 winner=video 分支读 thumbnailPath cover JPEG 并 sharp resize — 已实现，throw 触发已有 fallback
- E3a narrate-video prompt 含 `{transcript_excerpt}` `{video_pacing}` 占位 — 已创建
- E3b 阶段 2 按 mediaType 加载 prompt + 占位替换 — 已实现
- F1-F4 前端组件 + 后端路由全部按设计实现
- G1 启动日志格式与设计一致
- G2 CLAUDE.md 三处更新（环境/命令/数据流）

**Tier 2b: 代码质量** ✅
- 错误处理: video 分支 throw 让现有 catch 捕获，避免 BullMQ 重试风暴 ✅
- 边界: thumbnailPath null / transcript null / videoPacing null 全部默认值替代
- 路径处理: 修复 `path.join` → `path.resolve` 与现有 `/original` 一致
- a11y: `<track>` 用 `kind="captions"` (biome useMediaCaption 规则)
- 性能: 视频读 cover JPEG（最大 2MB）而非整个视频（可达 GB 级），OOM 已绕开

**Tier 3.5: 性能保障** N/A — 项目无 Lighthouse CI / size-limit / Playwright 性能断言。

### 失败 Tier 清单
无（path.join bug 已在 Tier 1.5 期间修复并重测通过）。

## 变更日志
- [2026-05-06T01:08:52Z] autopilot 初始化，目标: 按 .autopilot/sessions/video/requirements/20260505-当前的-AI-分析只支持/HANDOFF-EFG.md 的剩余任务清单做完阶段 E、F、G
- [2026-05-06T01:25:00Z] design 阶段完成: 计划写入 plans/velvet-launching-kernighan.md，用户审批通过；进入 implement 阶段
- [2026-05-06T01:50:00Z] implement 阶段完成: 蓝队完成 13 项任务（8 文件改 + 4 文件新建），typecheck 通过；红队完成 3 个 acceptance test 文件；进入 qa 阶段
- [2026-05-06T09:30:00Z] qa 轮次 1: 红队 mock 不完整 → red team agent 自修复 (job.log + ai_model 列误判 + 5 字节 buffer 误判)。Wave 1.5 真实场景发现 path.join bug → 改为 path.resolve；重测通过。typecheck/lint/15 红队全过；进入 merge 阶段

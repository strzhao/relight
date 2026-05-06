# Handoff — 视频 AI 分析支持（剩余阶段 E/F/G）

> **使用方式**：在新的 claude code 会话中，运行 `/autopilot 继续做视频 AI 分析的剩余 E/F/G 阶段，参考 .autopilot/sessions/video/requirements/20260505-当前的-AI-分析只支持/HANDOFF-EFG.md`

## 上下文

视频 AI 分析功能已完成 4/7 阶段（A 基础设施 + B Schema/契约 + C 扫描/缩略图 + D AI 分析），后端核心管道（扫描 → 分析 → 占位降级）端到端验证通过，已合并到 main。

剩余 E（daily-selection 视频路径）+ F（前端展示）+ G（可观测性 & 文档）。

**完整设计文档**: `/Users/stringzhao/workspace/relight/.autopilot/sessions/video/requirements/20260505-当前的-AI-分析只支持/design.md`（556 行）

## 已完成范围（不要重复做）

### 后端基础设施
- `apps/backend/src/lib/video/` 全部模块（ffmpeg/transcribe/sprite/index）
- `apps/backend/src/ai/prompts/v2/video/{system,user}.txt` 视频专属 prompt
- `apps/backend/src/cli/backfill-media-type.ts` 历史回填 CLI
- `apps/backend/drizzle/0000_flawless_glorian.sql` schema migration

### Schema
- photos 表：mediaType / durationSec / videoCodec / videoFps（已落库）
- photoAnalyses 表：transcript / transcriptSegments / videoPacing / motionScore（已落库）
- packages/shared/types.ts Photo / PhotoAnalysis 已扩展（mediaType 设为可选保持向后兼容）

### 已改造的现有文件
- `apps/backend/src/jobs/analyze-photo.ts` — 加视频分支 `analyzeVideoBranch` + `extractVideoFields` + `writeTagsAndAnalysis` + `upsertVideoPlaceholder`
- `apps/backend/src/storage/local.ts` — getMetadata 视频路径走 ffprobe
- `apps/backend/src/lib/thumbnail.ts` — 视频走 extractFrames，outputName 强制 .jpg
- `apps/backend/src/jobs/scan-storage.ts` — INSERT 时填 mediaType/duration/codec/fps
- `apps/backend/src/lib/config.ts` — 加 video / whisper 配置区
- `.env.example` — 通用占位（默认值在 config.ts 仍指向 martin/）

### 已知约束
- ffmpeg 系统依赖（已在系统 PATH 中：`/opt/homebrew/bin/ffmpeg`）
- whisper 服务复用 `/Users/stringzhao/workspace/martin/scripts/transcribe.py`（mlx 引擎，CLI 模式）
- worker concurrency=4，视频任务慢但不饿死图片
- 失败降级模式：`aiModel="skipped"` (ffmpeg 缺失) / `aiModel="video-failed:{kind}"` (probe/extract/vision 失败) — **绝对不抛异常**避免 BullMQ 重试风暴

---

## 剩余任务清单

### 阶段 E — daily-selection 视频路径

**核心目标**：让视频与图片平等参与"今日拾光"每日精选。

#### E1. 阶段 1 候选摘要含 mediaType
- 文件: `apps/backend/src/jobs/daily-selection.ts:78-91`
- 当前代码：构建 `candidateSummaries` 文本时只含美学评分/情感/标签/描述
- 修改：每个候选加 `[图片]` 或 `[视频 NN 秒]` 标识，让文本评选模型知道候选媒体类型
- v2/daily/select 的 system prompt 加一句："候选可能是 image 或 video，请综合判断；视频候选含运动感和叙事性的优势"

#### E2. 阶段 2 视频路径 — 绕过 OOM
- 文件: `apps/backend/src/jobs/daily-selection.ts:148-167`
- ⚠️ 当前代码在 winner 是视频时**会同时引发 OOM 和 sharp 解码异常**：
  ```ts
  buffer = await adapter.getFileBuffer(fullPath);  // 把整个视频读进内存
  buffer = await sharp(buffer)...;                 // sharp 不支持视频解码
  ```
- 修复方案（设计文档第 9 节）：
  ```ts
  if (winner.photo.mediaType === 'video') {
    if (!winner.photo.thumbnailPath) {
      throw new Error('视频无 cover 缩略图');  // 触发现有模板 fallback (line 192-199)
    }
    const fs = await import('node:fs/promises');
    buffer = await fs.readFile(winner.photo.thumbnailPath);  // 读 cover JPEG
    buffer = await sharp(buffer)
      .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } else if (ext === ".heic" || ext === ".heif") {
    // 现有 heic 路径
  } else {
    // 现有 sharp 路径
  }
  ```

#### E3. 视频专属叙事 prompt
- 新建 `apps/backend/src/ai/prompts/v2/daily/narrate-video/system.txt` + `user.txt`
- user.txt 含占位 `{transcript_excerpt}` `{video_pacing}`
- daily-selection.ts 阶段 2 视频路径改用 `loadPrompts("v2", "daily/narrate-video")` + 注入 `winner.analysis.transcript?.slice(0, 200)`、`videoPacing`

#### 红队验收测试 E
- 新建 `apps/backend/src/jobs/__tests__/daily-selection-video.acceptance.test.ts`
- 验证：
  1. winner.mediaType==='video' 时不调 `adapter.getFileBuffer` (spy 验证)
  2. thumbnailPath null 时触发模板 fallback 不抛异常
  3. transcript 注入到 narrate prompt 占位

---

### 阶段 F — 前端视频展示

**核心目标**：列表能识别视频（▶ 角标 + 时长），详情页可播放（`<video>` + 字幕轨道）。

#### F1. photo-card.tsx 视频角标
- 文件: `apps/web/components/photo-card.tsx:78` 附近的 `<img>`
- 现状: 只 `<img>` 渲染，无视频指示
- 修改:
  - 外层加 `<div className="relative">`
  - mediaType==='video' 时叠加 `<span className="absolute top-2 right-2 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded flex items-center gap-1">`
    - 内含 `<Play className="w-3 h-3" />` (lucide-react) + `{formatDuration(durationSec)}` 如 "0:42"
- 工具函数: `formatDuration(s: number): string` 返回 "M:SS" 格式（s < 3600）或 "H:MM:SS"

#### F2. daily-hero.tsx 视频 overlay
- 文件: `apps/web/components/daily-hero.tsx:99` 附近
- 当 dailyPick.photo.mediaType==='video' 时叠加大尺寸 ▶ 半透明圆形按钮
- 仍展示 cover 帧（不直接 inline 播放，避免首页加载视频）
- 点击进入 `/photos/[id]` 详情页（详情页自动播放）

#### F3. 视频详情页
- 文件: `apps/web/app/photos/[id]/page.tsx`
- 按 mediaType 条件渲染:
  - image → 现有 `<img>` 或 lightbox（保持不变）
  - video → `<video controls preload="metadata" autoPlay={true} src={`${API}/api/photos/${id}/raw`}>`
    - 叠加 `<track kind="subtitles" src={`/api/photos/${id}/subtitles.vtt`}>` (transcriptSegments 非空时)
- 分析区块: mediaType==='video' 时额外渲染:
  - `transcript` 全文（折叠组件 ShadCN Accordion）
  - `videoPacing` 标识（slow/medium/fast 对应 oklch token）
  - `motionScore` 数值条

#### F4. 后端新增路由
- 文件: `apps/backend/src/routes/photos.ts`（新建或扩展现有）
- `GET /api/photos/:id/raw`:
  - 流式返回原视频文件 (Range 支持)
  - Hono 用 `c.body(stream)` + Range header 解析
  - Content-Type 用 `adapter.getMimeType(filePath)`
- `GET /api/photos/:id/subtitles.vtt`:
  - 读 photoAnalyses.transcriptSegments
  - 转 WebVTT 格式: `WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n这是字幕`
  - Content-Type: `text/vtt; charset=utf-8`

#### F5. shared/api-routes.ts 同步
- `packages/shared/src/api-routes.ts` 加 `photos.raw(id)` 和 `photos.subtitles(id)` 常量

#### 红队验收测试 F
- 新建 `apps/web/__tests__/photo-card-video.acceptance.test.tsx` — mediaType='video' 渲染含 Play 图标 + 时长
- 新建 `apps/backend/src/lib/__tests__/thumbnail-video.acceptance.test.ts` — outputName 必须以 `.jpg` 结尾（验证 strict 设计契约）
- raw + subtitles 路由 e2e 测试（Hono testClient）

---

### 阶段 G — 可观测性 + 文档

#### G1. 启动检测能力日志
- 文件: `apps/backend/src/index.ts` 启动入口
- 启动时调:
  ```ts
  const videoCap = await detectVideoCapability();
  const whisperCap = await detectWhisperCapability();
  console.log(
    `[startup] video: ffmpeg=${videoCap.ffmpegOk ? "✓" : "✗"} ffprobe=${videoCap.ffprobeOk ? "✓" : "✗"} ` +
    `whisper: python=${whisperCap.pythonOk ? "✓" : "✗"} script=${whisperCap.scriptOk ? "✓" : "✗"} ` +
    `→ video_analysis_available=${videoCap.available && whisperCap.available}`,
  );
  ```
- 失败不阻塞进程（fail-soft）

#### G2. CLAUDE.md 更新
- 文件: `CLAUDE.md`（项目根级）
- 在「环境要求」区域加：
  - ffmpeg 系统依赖（macOS: `brew install ffmpeg`）
  - Whisper 可选依赖（默认指向 `/Users/stringzhao/workspace/martin/`，可通过 env 覆盖）
- 在「常用命令」加:
  - `pnpm --filter @relight/backend tsx src/cli/backfill-media-type.ts` — 历史视频数据回填
- 在「数据流」图加视频路径分支

---

## 真实验证场景（QA 必跑）

每个场景必须记录 `执行:` 命令 + `输出:` 命令真实输出。

### 场景 E1（串行）— daily 选中视频路径
```bash
# 1. 启动 backend dev + workers
pnpm dev & sleep 8
pnpm --filter @relight/backend workers &

# 2. 触发对一个视频 photoId 的分析（确保 photoAnalyses 有完整记录）
curl -X POST "http://localhost:${BACKEND_PORT}/api/admin/analyze" -H 'content-type: application/json' -d '{"photoIds":["<视频 photoId>"]}'

# 3. 触发 daily-selection（构造候选只含视频或者保证视频被选中）
curl -X POST "http://localhost:${BACKEND_PORT}/api/daily/trigger"

# 4. 验证
sleep 60 && sqlite3 /Users/stringzhao/workspace/relight/apps/backend/data/relight.db \
  "SELECT pick_date, p.media_type, dp.title, dp.narrative FROM daily_picks dp JOIN photos p ON p.id = dp.photo_id ORDER BY pick_date DESC LIMIT 1"
预期: 当胜者是视频时 narrative 体现视频特征（如"镜头从…切到…"），不报错
```

### 场景 F1（独立）— 前端视频列表角标
```bash
pnpm --filter @relight/web dev & sleep 8
# 浏览器打开 http://localhost:${WEB_PORT}/photos
预期: 视频卡片右上角显示 ▶ 图标 + 时长（如 0:42）
```

### 场景 F2（独立）— 视频详情页可播放
```bash
# 浏览器打开 http://localhost:${WEB_PORT}/photos/<视频 id>
预期: <video> 元素可播放，字幕轨道显示 transcript segments，分析区块含 transcript 全文 + videoPacing/motionScore
```

### 场景 F3（独立）— /raw 路由 Range 请求
```bash
curl -i -H "Range: bytes=0-1023" "http://localhost:${BACKEND_PORT}/api/photos/<视频 id>/raw" | head -20
预期: HTTP 206 Partial Content + Content-Range 头 + 1024 bytes body
```

### 场景 G1（独立）— 启动日志能力检测
```bash
pnpm --filter @relight/backend dev 2>&1 | grep '\[startup\]'
预期: 看到 "video: ffmpeg=✓ ffprobe=✓ whisper: python=✓ script=✓ → video_analysis_available=true"
```

---

## 关键约束（不要违反）

1. **shared types Photo.mediaType 是可选**（`mediaType?: MediaType`）以保持向后兼容；前端读取时 `photo.mediaType ?? 'image'`
2. **不修改红队验收测试**（autopilot 铁律）
3. **不修改已完成阶段的代码**（除非有真 bug）
4. **失败不抛异常**（占位记录代替）
5. **commit message 用中文**（项目惯例 conventional commits）
6. 遵循 `.autopilot/decisions.md` 已有决策（特别是"格式门用 return 而非 throw"）

## 推荐执行顺序

1. 阶段 G2 (CLAUDE.md) — 最简单，先做
2. 阶段 G1 (启动日志) — 简单
3. 阶段 E1+E2+E3 (daily-selection) — 中等复杂度，关键路径
4. 阶段 F4 (raw + subtitles 路由) — 必须先于 F3 详情页
5. 阶段 F5 (api-routes 常量) — 与 F4 同步
6. 阶段 F1 (photo-card) — 最简单前端
7. 阶段 F2 (daily-hero) — 与 F1 类似
8. 阶段 F3 (详情页) — 最复杂，依赖 F4
9. 红队补充 + QA 验证

预计 1-2 轮 autopilot 可完成（取决于 sub-agent 速率限制）。

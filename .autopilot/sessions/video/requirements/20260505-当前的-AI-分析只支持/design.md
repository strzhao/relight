# 视频 AI 分析支持

## Context

**问题**：拾光（Relight）目前的 AI 分析只支持图片格式（jpg/png/heic/dng 等）。storage adapter 已经将视频文件（.mp4/.mov/.avi/.mkv/.webm/.m4v）扫描入库（`apps/backend/src/storage/local.ts:24-29`），但 `analyze-photo.ts:75` 的扩展名格式门会拦截视频，写入 `aiModel="skipped"` 占位记录（line 84-92），视频进入 photos 表后再无后续 AI 价值产出。

**目标**：让视频得到与图片同等深度的 AI 分析能力——不只是"看一帧当图片处理"，而是**好好设计**：抽多帧理解时序、ffmpeg 提取音轨经 Whisper 转文字理解对白/音乐，让 vision 模型在含时序+含音频的语境下输出运动感、剪辑节奏、叙事流等视频特有维度。视频与图片平等参与 daily 精选、前端列表、详情页。

**用户决策（Q&A 已完成，详见 `brainstorm.md`）**：
1. **分析深度**：完整版 — 多帧雪碧图 + 音频转录 + 视频专属 prompt
2. **Whisper 部署**：复用本地 `martin/scripts/transcribe.py`（mlx 引擎，CLI 调用，输出 JSON）
3. **抽帧策略**：scene-cut 检测 + 时间均匀兼容（默认 N=6 帧 3×2 雪碧图）
4. **Schema**：复用 photos 表 + `mediaType` 判别字段（不新建 videos 表）
5. **UX**：视频全面参与 daily 精选、列表、详情页

## 整体方案

### 数据流改动

```
storage adapter 扫描 (含视频)
   ↓
[scan-storage] getMetadata 分流：image → sharp ；video → ffprobe (新增)
   ↓
photos 表 INSERT（mediaType + duration/fps/codec）
   ↓
缩略图分流：image → sharp ；video → ffmpeg 单帧 (新增)
   ↓
入队 analyze-photo job (复用同一队列)
   ↓
[analyze-photo] 格式门分流：
   • image  → 现有路径（dcraw/heic/sharp + v2 prompt）
   • video  → 视频路径（新增）：
        ├─ ffmpeg scene-cut + fallback 时间均匀 → 抽 N 帧
        ├─ 帧拼成 3×2 雪碧图 (sharp composite)
        ├─ ffmpeg 提取音轨 → Whisper CLI → transcript JSON
        └─ vision 调用：雪碧图 + transcript 注入到 v2/video prompt
   ↓
解析响应 → photoAnalyses INSERT/UPDATE（含新字段 transcript/videoPacing/motionScore）
   ↓
[daily-selection] 阶段1：候选摘要含 mediaType 标注，文本模型混合评选
   ↓
   阶段2：选中视频时 → 重读 cover 帧 + transcript 摘要 → narrate prompt
   ↓
前端：列表卡片 mediaType==='video' 显示 ▶ + 时长角标；详情页 <video> 播放 + 字幕
```

### 关键技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| ffmpeg 分发 | 系统 ffmpeg（`which ffmpeg` 检测） | 与 dcraw/whisper 现有"假定外部依赖+启动检测"风格一致，避免 ffmpeg-static ~80MB 包体；macOS `brew install ffmpeg` 是标配 |
| Whisper 调用 | `child_process.spawn` 调 `martin/scripts/transcribe.py` | 用户明示复用其本地服务，CLI 接口稳定 |
| 视频帧抽取 | scene-cut（ffmpeg `select='gt(scene,0.3)'`）+ 不足时时间均匀 | 兼顾动态视频和静态视频，N=6 默认（短视频降级） |
| 雪碧图布局 | 3×2 网格，每格 768×768；总图 quality=85 JPEG。**首版不加文字角标**（sharp.composite 不原生支持文字，需 SVG buffer 叠加，实现成本不抵收益）；用左上→右下的位置顺序代表时序，prompt 中明确告知模型 | 雪碧图 ≤1MB；后续若发现模型分辨时序困难再增加 SVG 角标 |
| 缩略图 | 视频取**第一个 scene 帧**（不是中点，更代表主题） | 列表 cover 与详情 cover 一致 |
| Schema | photos 加 `mediaType`/`durationSec`/`videoCodec`/`videoFps`；photoAnalyses 加 `transcript`/`videoPacing`/`motionScore` | 复用而非新建表，nullable 兼容图片 |
| Worker 队列 | 复用 `analyze-photo` 队列（不拆队列） | 实现简单，BullMQ 内置公平调度；视频任务慢但 concurrency=4 不会饿死图片 |
| 队列名保持 | 不改名为 `analyze-media` | 改名牵涉 BullMQ prefix/键迁移，收益不抵成本 |
| 失败降级 | 视频路径任何子步骤失败 → 记 `aiModel="video-failed:{reason}"` 占位（区别于 `skipped`），允许后续重试 | 不抛异常引发重试风暴；保留诊断信息 |

### 关键风险与缓解

| 风险 | 缓解 |
|------|------|
| 系统未装 ffmpeg | 启动时 `which ffmpeg` 检测；缺失时设 `VIDEO_ENABLED=false`，视频任务返回 `aiModel="skipped"` 与 reason `"ffmpeg_missing"`（与现有 skipped 占位结构一致）。日志输出明确指引 `brew install ffmpeg`。 |
| Whisper Python venv 不存在 | 启动时 `fs.access` 检测 `WHISPER_PYTHON`；缺失时设 `WHISPER_ENABLED=false`，视频路径仍跑视觉分析，transcript 字段为 NULL。 |
| 视频文件超大（>2GB）OOM | 不 readFile 整个视频；ffmpeg 流式抽帧到临时目录（`os.tmpdir()`），输出帧文件直接 readFile（每帧 <500KB） |
| 雪碧图太大触发 vision 模型上限 | 单帧 sharp resize 到 768×768，total ≤2MB；雪碧图 quality=85 |
| 视频时长极短 (<3s) 或无场景切换 | 时长 < 3s → 单帧（中点）；scene-cut 不足 N → 时间均匀 fallback |
| photoAnalyses 复用导致旧 prompt 不输出新字段 | 新字段全部 nullable；解析时容错（response-parser 已有 partial merge 模式） |
| Worker concurrency=4 视频长任务阻塞图片 | BullMQ 公平调度；视频单任务 30-90s，4 并发下不会饿死图片任务 |
| daily 阶段 2 选中视频但叙事 prompt 是图片导向 | narrate 时按 mediaType 加载不同子 prompt（`v2/daily/narrate-video/` 新增），或动态注入 transcript 摘要 |

## 设计文档（按模块）

### 1. 视频处理工具层（新建 `apps/backend/src/lib/video/`）

| 文件 | 职责 |
|------|------|
| `apps/backend/src/lib/video/ffmpeg.ts` | 启动时 `which ffmpeg/ffprobe` 检测；导出 `videoCapability: { ffmpegOk, whisperOk }`、`probeVideo()`、`extractFrames()`、`extractAudio()` |
| `apps/backend/src/lib/video/transcribe.ts` | `transcribeAudio(audioPath)` 用 `child_process.spawn` 调 `martin/scripts/transcribe.py`；**注意：脚本将 JSON 写入 `<outputDir>/<stem>.json` 文件**，stdout 只是人类可读的进度日志（"引擎: mlx \| 模型: …"），**绝对不要尝试解析 stdout**。等进程退出（exitCode === 0）后用 `fs.readFile(path.join(outputDir, stem + '.json'))` 读取，再 JSON.parse 得到 `{ text, segments }`。超时 300s。 |
| `apps/backend/src/lib/video/sprite.ts` | `composeSprite(frameBuffers)` 用 sharp composite 拼 3×2/2×2 雪碧图（**首版无角标，时序由位置隐式表示**——左上→右下） |
| `apps/backend/src/lib/video/index.ts` | 高层 API：`analyzeVideoForAI(filePath)` 返回 `{ spriteBuffer, transcript, segments, durationSec, fps, codec, coverFrame }` |

**核心实现要点**：
- `extractFrames`: ffmpeg 命令含 `-vf "select='gt(scene,0.3)',showinfo"` + `-vsync vfr` + `-frames:v N`；标准错误输出（stderr）解析 `showinfo` 行中的 `pts_time` 时间戳，不足 N 时 fallback `-vf "fps=N/duration"` 时间均匀。**返回**：`Buffer[]`（按时间顺序），同时返回 `firstFrameBuffer` 给缩略图复用。
- `extractAudio`: ffmpeg `-vn -acodec pcm_s16le -ar 16000 -ac 1` 输出 wav 到 tmp（whisper 偏好 16k mono）；视频无音轨（`ffprobe` 检测）时跳过
- `transcribeAudio`: 调 `${WHISPER_PYTHON} ${WHISPER_SCRIPT} <wav> --engine ${WHISPER_ENGINE} --model ${WHISPER_MODEL} --language ${WHISPER_LANGUAGE} --output-format json --output-dir <tmp>`。**输出位置：脚本写到 `<tmp>/<basename-without-ext>.json`，stdout 是日志而不是 JSON**。spawn 用法：`stdio: ['ignore','pipe','pipe']`，仅日志可观测；`process.on('close', code => …)` 后再读 JSON 文件。注意 `--language` 实际只接受 `zh|en|auto` 三选（参考 `transcribe.py:129`），其它值会让脚本退出 2。
- 临时文件路径：`os.tmpdir() + /relight-video-${jobId}-${Date.now()}/`，函数退出时 `fs.rm` 清理
- 所有外部命令统一超时（ffmpeg 60s/抽帧 30s/whisper 300s），失败抛 `VideoProcessingError`

### 2. 数据库 Schema 变更（`apps/backend/src/db/schema.ts`）

**photos 表追加列**：
```ts
mediaType: text("media_type", { enum: ["image", "video"] }).notNull().default("image"),
durationSec: real("duration_sec"),  // 视频独有，图片为 NULL
videoCodec: text("video_codec"),    // 'h264'|'hevc'|'av1' 等
videoFps: real("video_fps"),
```

**photoAnalyses 表追加列**：
```ts
transcript: text("transcript"),                                                              // 全文
transcriptSegments: text("transcript_segments", { mode: "json" }).$type<{ start: number; end: number; text: string }[]>(),  // 字幕段
videoPacing: text("video_pacing"),                                                           // 'slow'|'medium'|'fast'
motionScore: real("motion_score"),                                                           // 0-100
```

**Drizzle migration**：
```bash
pnpm --filter backend exec drizzle-kit generate
# → 0006_add_video_support.sql
pnpm db:push  # 应用到现有数据库（默认全部置为 image）
```

**历史数据回填**（一次性 SQL，迁移后立即跑）：
```sql
UPDATE photos SET media_type = 'video'
WHERE LOWER(file_path) GLOB '*.mp4' OR ... GLOB '*.mov' OR ... GLOB '*.avi' OR ... GLOB '*.mkv' OR ... GLOB '*.webm' OR ... GLOB '*.m4v';
```
（参考 decisions.md 2026-05-05 "历史数据 SQL backfill" 决策）

### 3. 共享类型契约（`packages/shared/src/types.ts`）

```ts
// Photo 接口扩展
export interface Photo {
  // ... 现有字段
  mediaType: 'image' | 'video';      // 新增（已有数据迁移后 default 'image'）
  durationSec?: number | null;
  videoCodec?: string | null;
  videoFps?: number | null;
}

// PhotoAnalysis 接口扩展
export interface PhotoAnalysis {
  // ... 现有字段
  transcript?: string | null;
  transcriptSegments?: { start: number; end: number; text: string }[] | null;
  videoPacing?: 'slow' | 'medium' | 'fast' | string | null;
  motionScore?: number | null;
}

// UnifiedPhotoItem 同步加 mediaType + durationSec
```

### 4. 元数据提取（`apps/backend/src/storage/local.ts`）

**接口契约扩展**（先于步骤 14 实现）：`storage/interface.ts` 中 `getMetadata()` 返回类型从 `{ width?, height?, takenAt? }` 扩展为：

```ts
interface FileMetadata {
  width?: number;
  height?: number;
  takenAt?: Date;
  // 视频独有（图片返回值这些字段为 undefined）
  mediaType?: 'image' | 'video';
  durationSec?: number;
  videoCodec?: string;
  videoFps?: number;
}
```

`getMetadata()` 改为分流：
- `path.extname` 是视频扩展名 → 走新增 `getVideoMetadata(filePath)` 调 `ffprobe -v quiet -print_format json -show_format -show_streams` 提取 width/height/duration/fps/codec/creation_time（作为 takenAt fallback），返回 `mediaType: 'video'`
- 否则走现有 sharp 路径，`mediaType` 不显式返回（让 scan-storage 取 default 'image'）

scan-storage 步骤 14 据此扩展 `photoRecords`：

```ts
photoRecords.push({
  // 现有字段...
  mediaType: metadata.mediaType ?? 'image',
  durationSec: metadata.durationSec ?? null,
  videoCodec: metadata.videoCodec ?? null,
  videoFps: metadata.videoFps ?? null,
});
```

### 5. 缩略图（`apps/backend/src/lib/thumbnail.ts`）

⚠️ 现有实现 `outputName = `${photoId}${ext}`` 会让视频缩略图变成 `xxx.mp4`，前端 `<img src="…/.mp4">` 会失败。**必须修改 outputName 逻辑**：

`generateThumbnail()` 改为分流：
- 视频扩展名 → 调用 `extractFrames(filePath, 1, { sceneFirst: true })` 取首场景帧 buffer → sharp resize 400×400 → 写 `${photoId}.jpg`（强制 .jpg 后缀）
- 图片扩展名 → 现有路径，但 outputName 改为统一 `${photoId}.jpg`（HEIC/DNG 也已被 analyze-photo 做 JPEG 转换，缩略图保持一致更简单）；若担心兼容性可仅对视频强制 .jpg、图片保持 ext

旧 thumbnailPath 历史记录（`xxx.heic` 等）留存即可，新生成全部走新逻辑；下次 cleanupOrphans 不影响。

### 6. analyze-photo job（`apps/backend/src/jobs/analyze-photo.ts`）

在格式门（line 75）之前加视频分支：
```ts
if (VIDEO_EXTENSIONS.has(ext)) {
  if (!videoCapability.ffmpegOk) {
    // 写 skipped 占位（reason: ffmpeg_missing），return
  }
  await analyzeVideoBranch(photo, source, job);
  return;
}
// 现有图片路径
```

`analyzeVideoBranch()` 新增（同一文件或拆 `apps/backend/src/jobs/analyze-video.ts`）：
1. `analyzeVideoForAI(fullPath)` → `{ spriteBuffer, transcript, segments, durationSec, fps, codec }`
2. 加载 prompts: `loadPrompts("v2", "video")` → 含 `{transcript_inject}` 占位的 user prompt
3. `userPromptFinal = prompts.user.replace("{transcript}", transcript ?? "(无音轨/转录失败)").replace("{duration}", durationSec.toFixed(1))`
4. `aiClient.analyzePhoto(spriteBase64, "image/jpeg", prompts.system, userPromptFinal)` —— 注意 spriteBuffer 已是 JPEG
5. 解析响应（复用 parseAnalysisResponse + 视频特定字段融合）
6. 写 photoAnalyses（含 transcript/transcriptSegments/videoPacing/motionScore + 通用字段）

**进度上报**：`processing` phase 含 `currentFile` 和细分子步骤（`extracting_frames`/`transcribing`/`analyzing`），写入 job.updateProgress 的扩展字段。

### 7. 视频专属 Prompt（`apps/backend/src/ai/prompts/v2/video/`）

**system.txt**（基于 v2/system.txt 改写）：
- 强调"你正在分析一段视频的关键帧雪碧图（按时间顺序排列，左上→右下编号 01-06）"
- 输出 JSON 含通用字段 + 视频独有字段：
  ```json
  {
    "narrative": "...",
    "aestheticScore": 7.5,
    "tags": [...],
    "composition": {...},
    "colorAnalysis": {...},
    "emotionalAnalysis": {...},
    "usageSuggestions": "...",
    "videoPacing": "medium",
    "motionScore": 65,
    "videoNarrative": "镜头切换从晨光中的窗台，到桌上的咖啡，最终落在书页上..."
  }
  ```

**user.txt**：
```
请分析这段视频的关键帧雪碧图（{frame_count} 帧，按时间顺序）。

视频时长：{duration} 秒
音频转录：
{transcript}

严格按 JSON 格式返回，包裹在 ```json 代码块中。
```

### 8. response-parser 视频字段（`apps/backend/src/ai/response-parser.ts`）

不新建 parser；现有 `parseAnalysisResponse` 已支持额外字段透传（rawResponse 保留）。视频字段从 `parsed` 对象**额外提取**：
```ts
const videoFields = {
  videoPacing: parsed.videoPacing ?? null,
  motionScore: parsed.motionScore ?? null,
  videoNarrative: parsed.videoNarrative ?? null,  // 注入到 narrative
};
```
若 prompt v2 base schema 与 video 不冲突可一次性 merge。

### 9. daily-selection（`apps/backend/src/jobs/daily-selection.ts`）

**阶段 1（评选）**：
- 候选摘要构建（line 78-91）：每个候选加 `mediaType: photo.mediaType, duration: photo.durationSec` 到摘要文本
- v2/daily/select 的 system prompt 加一句"候选可能是 image 或 video，请综合判断"

**阶段 2（叙事）**：
- ⚠️ 现有 `daily-selection.ts:161-167` 直接 `adapter.getFileBuffer(fullPath)` 把整个文件读入内存再扔给 sharp。视频文件可能数 GB，且 sharp 不支持视频解码，**会同时引发 OOM 和解码异常**。必须在 try 块开头先按 mediaType 分流。
- 选中后 `winner.photo.mediaType === 'video'` 时改路径：
  ```ts
  if (winner.photo.mediaType === 'video') {
    if (!winner.photo.thumbnailPath) {
      throw new Error('视频无 cover 缩略图，跳过叙事'); // 触发 fallback 到模板文案
    }
    // 直接读 thumbnailPath（已是 sharp 处理过的 400×400 JPEG）
    // 但叙事需要更高分辨率，重新读首场景帧
    const fs = await import('node:fs/promises');
    buffer = await fs.readFile(winner.photo.thumbnailPath);
    // 此 buffer 已经是 JPEG，仍 sharp resize 到 2048（sharp 处理 JPEG OK）以保持现有路径
    buffer = await sharp(buffer).resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } else if (ext === ".heic" || ext === ".heif") {
    // 现有 heic 路径
  } else {
    // 现有 sharp 路径
  }
  ```
- 加载 `v2/daily/narrate` 时若是视频则改读 `v2/daily/narrate/video.txt` 子 prompt（如果存在）；用 `loadPrompts("v2", "daily/narrate-video")` 加载（路径与现有 `daily/narrate` 平行）
- 把 `winner.analysis.transcript`（前 200 字）和 `videoPacing` 注入 user prompt 占位 `{transcript_excerpt}`/`{video_pacing}`
- 仍然只调一次 vision API（cover 帧 + 上下文文本）

### 10. 前端展示

**`apps/web/components/photo-card.tsx`**（list cover）：
- `<img>`（line 78）外层加 `<div className="relative">`
- 当 `photo.mediaType === 'video'` 时，叠加 `<span className="absolute top-2 right-2 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">`：
  - 内含 ▶ 图标（lucide-react `Play`）+ 时长（`formatDuration(durationSec)` 如 `0:42`）

**`apps/web/components/daily-hero.tsx`**（首页 daily）：
- `<img>`（line 99）当 dailyPick.photo.mediaType === 'video' 时叠加大尺寸 ▶ 半透明圆形按钮 + 点击进入详情自动播放
- 仍展示 cover 帧（不直接 inline 播放，避免首页加载视频）

**`apps/web/app/photos/[id]/page.tsx`**（详情页）：
- 按 mediaType 条件渲染：
  - image → 现有 `<img>` 或 lightbox
  - video → `<video controls preload="metadata" src={`${API}/api/photos/${id}/raw`}>` + 字幕轨道（`<track kind="subtitles" src={`/api/photos/${id}/subtitles.vtt`}>`）
- 分析区块：mediaType === 'video' 时额外显示 `transcript` 全文（折叠组件）+ `videoPacing`/`motionScore` 标识

**新增后端路由**：
- `GET /api/photos/:id/raw` → 流式返回原视频文件（Range 支持，给 `<video>` 用）
- `GET /api/photos/:id/subtitles.vtt` → 把 `transcriptSegments` 转 WebVTT 返回

### 11. 配置（`apps/backend/src/lib/config.ts`）

新增：
```ts
video: {
  enabled: process.env.VIDEO_ENABLED !== "false",      // 默认开
  frameCount: parseInt(process.env.VIDEO_FRAME_COUNT ?? "6", 10),
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",     // PATH lookup
  ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
},
whisper: {
  enabled: process.env.WHISPER_ENABLED !== "false",
  python: process.env.WHISPER_PYTHON ?? "/Users/stringzhao/workspace/martin/.venv/bin/python3",
  script: process.env.WHISPER_SCRIPT ?? "/Users/stringzhao/workspace/martin/scripts/transcribe.py",
  engine: process.env.WHISPER_ENGINE ?? "mlx",
  model: process.env.WHISPER_MODEL ?? "large-v3-turbo",
  language: process.env.WHISPER_LANGUAGE ?? "auto",
},
```

### 12. .env.example 更新

追加示例 `VIDEO_ENABLED`/`WHISPER_PYTHON` 等。

### 13. 启动检测（`apps/backend/src/index.ts` 或 `workers/index.ts`）

启动时调用 `await detectVideoCapability()`，console.log 结果（"ffmpeg ✓ / whisper ✓"）。失败不阻塞进程（fail-soft）。

## 实现计划

按依赖顺序排列。`[ ]` 为未完成。

### 阶段 A：基础设施（无业务逻辑）

- [ ] 1. 写 `apps/backend/src/lib/video/ffmpeg.ts` —— 启动检测 + probeVideo + extractFrames + extractAudio
- [ ] 2. 写 `apps/backend/src/lib/video/transcribe.ts` —— spawn whisper CLI + 解析 JSON
- [ ] 3. 写 `apps/backend/src/lib/video/sprite.ts` —— sharp composite 雪碧图（带角标）
- [ ] 4. 写 `apps/backend/src/lib/video/index.ts` —— `analyzeVideoForAI()` 高层 API
- [ ] 5. `apps/backend/src/lib/config.ts` 新增 `video` 和 `whisper` 配置区
- [ ] 6. `.env.example` 追加示例

### 阶段 B：Schema 与契约

- [ ] 7. `apps/backend/src/db/schema.ts` 加 `photos.mediaType`/`durationSec`/`videoCodec`/`videoFps` + `photoAnalyses.transcript`/`transcriptSegments`/`videoPacing`/`motionScore`
- [ ] 8. 生成 drizzle migration: `pnpm --filter @relight/backend drizzle-kit generate`（drizzle-kit 是 backend 子包的 devDep）
- [ ] 9. 应用 migration: `pnpm db:push`（项目根级别快捷脚本，等价于 `--filter @relight/backend db:push`）
- [ ] 10. 历史数据回填 SQL 脚本（`apps/backend/src/cli/backfill-media-type.ts`）+ 一次性运行
- [ ] 11. `packages/shared/src/types.ts` 同步类型扩展（Photo / PhotoAnalysis / UnifiedPhotoItem）

### 阶段 C：扫描/缩略图集成

- [ ] 12. `apps/backend/src/storage/local.ts` `getMetadata()` 加视频分支（ffprobe）
- [ ] 13. `apps/backend/src/lib/thumbnail.ts` 加视频分支（首场景帧）
- [ ] 14. `apps/backend/src/jobs/scan-storage.ts` 写入 photos 时填 mediaType/duration/codec/fps（line 211-222 区域扩展）

### 阶段 D：AI 分析集成

- [ ] 15. 写 `apps/backend/src/ai/prompts/v2/video/system.txt` + `user.txt`（带 `{transcript}`/`{duration}`/`{frame_count}` 占位）
- [ ] 16. `apps/backend/src/jobs/analyze-photo.ts` 在格式门前插入 `VIDEO_EXTENSIONS` 分支 → 调用 `analyzeVideoBranch()`
- [ ] 17. `analyzeVideoBranch()` 实现：调 `analyzeVideoForAI` → 加载 v2/video prompts → vision call → 解析 → 写库（含视频字段）

### 阶段 E：daily-selection

- [ ] 18. `apps/backend/src/jobs/daily-selection.ts` 阶段 1 候选摘要含 mediaType/duration（line 78-91 区域扩展）
- [ ] 19. 阶段 2：在 `daily-selection.ts:148` 之后按 mediaType 分流。video → `fs.readFile(winner.photo.thumbnailPath)` + sharp resize 到 2048（绕过现有 `adapter.getFileBuffer(fullPath)` + sharp 解码视频的死路径）；thumbnailPath 为 null 时触发现有模板 fallback（line 192-199）
- [ ] 19b. 写 `apps/backend/src/ai/prompts/v2/daily/narrate-video/system.txt` + `user.txt`，含 `{transcript_excerpt}`/`{video_pacing}` 占位；阶段 2 视频路径改用 `loadPrompts("v2", "daily/narrate-video")`

### 阶段 F：前端

- [ ] 20. `apps/web/components/photo-card.tsx` mediaType==='video' 叠加 ▶ + 时长角标
- [ ] 21. `apps/web/components/daily-hero.tsx` 视频 hero 显示 ▶ overlay
- [ ] 22. `apps/web/app/photos/[id]/page.tsx` 视频用 `<video controls>` + WebVTT track 渲染
- [ ] 23. 后端新增 `apps/backend/src/routes/photos.ts` 路由：`GET /:id/raw`（Range 流）+ `GET /:id/subtitles.vtt`
- [ ] 24. `packages/shared/src/api-routes.ts` 同步路由常量

### 阶段 G：可观测性 & 文档

- [ ] 25. `apps/backend/src/index.ts` 启动时调 `detectVideoCapability()` 输出能力表
- [ ] 26. CLAUDE.md 更新：视频依赖（ffmpeg + whisper）、新增脚本入口
- [ ] 27. 知识沉淀（merge 阶段自动）

## 验证方案

### 真实测试场景（Tier 1.5 必跑）

> ⚠️ 必须执行真实视频文件，不能只跑单元测试。

**前置准备**（先在 worktree 内运行）：
```bash
which ffmpeg ffprobe                                                    # 验证依赖
ls /Users/stringzhao/workspace/martin/.venv/bin/python3                 # 验证 whisper
```

**场景 1（独立）— 视频元数据提取**：
```bash
# 准备一个 5-30s 的真实视频（如 STORAGE_ROOT 中已有的 .mp4）
执行: pnpm --filter @relight/backend tsx -e "import('./src/storage/local.ts').then(m => new m.LocalFilesystemAdapter().getMetadata('<test.mp4 绝对路径>').then(console.log))"
预期: { width, height, takenAt, mediaType: 'video', durationSec, videoCodec, videoFps }
```

**场景 2（独立）— 雪碧图生成**：
```bash
执行: pnpm --filter @relight/backend tsx -e "import('./src/lib/video/index.ts').then(m => m.analyzeVideoForAI('<test.mp4>').then(r => { require('fs').writeFileSync('/tmp/sprite.jpg', r.spriteBuffer); console.log({ size: r.spriteBuffer.length, transcript: r.transcript?.slice(0, 100), durationSec: r.durationSec }); }))"
预期: 雪碧图 ≤2MB；transcript 非空（如视频有音轨）；目视检查 /tmp/sprite.jpg 是 3×2 网格
```

**场景 3（串行）— 端到端 analyze-photo job**：
```bash
# 1. 在 worktree 启动 backend dev + workers
执行: pnpm dev & sleep 8                                       # 自动加载 video 配置
执行: pnpm --filter @relight/backend workers &                 # workers 处理队列
# 2. 触发对一个视频 photoId 的分析（用 admin 或 trigger API）
执行: curl -X POST "http://localhost:${BACKEND_PORT}/api/admin/analyze" -H 'content-type: application/json' -d '{"photoIds":["<视频 photoId>"]}'
# 3. 等待完成（~30-90s）
执行: PID="<视频 photoId>"; until [ "$(sqlite3 ./data/relight.db "SELECT ai_model FROM photo_analyses WHERE photo_id='$PID'")" != "skipped" ]; do sleep 5; done
执行: sqlite3 ./data/relight.db "SELECT ai_model, length(transcript), video_pacing, motion_score, length(narrative) FROM photo_analyses WHERE photo_id='$PID'"
预期: ai_model = 'qwen3.6-35b'，transcript 长度 >0（如视频有音轨），video_pacing/motion_score 有值，narrative 含视频时序描述
```

**场景 4（串行）— daily-selection 选中视频路径**：
```bash
# 临时塞个 pickDate 强制让 daily 选择今日，构造候选只含视频
执行: curl -X POST "http://localhost:${BACKEND_PORT}/api/daily/trigger"
执行: sleep 60 && sqlite3 ./data/relight.db "SELECT pick_date, p.media_type, dp.title, dp.narrative FROM daily_picks dp JOIN photos p ON p.id = dp.photo_id ORDER BY pick_date DESC LIMIT 1"
预期: 当胜者是视频时，title 和 narrative 体现视频特征（如"镜头从…切到…"），不报错
```

**场景 5（独立）— 前端列表显示视频角标**：
```bash
执行: pnpm --filter @relight/web dev &
sleep 8
执行: curl -s "http://localhost:${WEB_PORT}/photos" | grep -E "Play|video|时长" | head
# 浏览器打开 http://localhost:${WEB_PORT}/photos 目视确认
预期: 视频卡片右上角显示 ▶ 图标 + 时长（如 0:42）
```

**场景 6（独立）— 视频详情页可播放**：
```bash
# 浏览器打开 http://localhost:${WEB_PORT}/photos/<视频 id>
预期: <video> 元素可播放，字幕轨道显示 transcript segments，分析区块含 transcript 全文
```

**场景 7（独立）— 降级路径：无 ffmpeg**：
```bash
执行: VIDEO_ENABLED=false pnpm --filter @relight/backend tsx src/cli/e2e-verify.ts <视频 photoId>
预期: 写入 photo_analyses.ai_model = 'skipped' 与 reason 'ffmpeg_disabled'，不抛异常
```

**场景 8（串行）— 损坏视频降级**：
```bash
# 准备一个故意损坏的 mp4（截取头部 1KB）
执行: head -c 1024 <真实视频> > /tmp/broken.mp4
# 软链到 STORAGE_ROOT，扫描后取 photoId 触发分析
执行: ln -sf /tmp/broken.mp4 ${STORAGE_ROOT}/broken.mp4
执行: curl -X POST "http://localhost:${BACKEND_PORT}/api/scan/<sourceId>"
执行: BPID=$(sqlite3 ./data/relight.db "SELECT id FROM photos WHERE file_path LIKE '%broken.mp4'")
执行: curl -X POST "http://localhost:${BACKEND_PORT}/api/admin/analyze" -H 'content-type: application/json' -d "{\"photoIds\":[\"$BPID\"]}"
执行: sleep 30 && sqlite3 ./data/relight.db "SELECT ai_model, raw_response FROM photo_analyses WHERE photo_id='$BPID'"
预期: ai_model 为 'video-failed:probe' 或类似，raw_response 含失败 reason；不引发 worker 重试风暴；其他视频分析任务不受影响
```

**场景 9（串行）— 无音轨视频**：
```bash
# 准备一个无音轨视频（ffmpeg -i source.mp4 -an /tmp/noaudio.mp4）
执行: ffmpeg -i <真实视频> -an -t 10 /tmp/noaudio.mp4
执行: ln -sf /tmp/noaudio.mp4 ${STORAGE_ROOT}/noaudio.mp4
# 扫描 + 分析（同场景 8 流程）
执行: NPID=$(sqlite3 ./data/relight.db "SELECT id FROM photos WHERE file_path LIKE '%noaudio.mp4'")
执行: sleep 60 && sqlite3 ./data/relight.db "SELECT ai_model, transcript, video_pacing, length(narrative) FROM photo_analyses WHERE photo_id='$NPID'"
预期: ai_model = 'qwen3.6-35b'，transcript 为 NULL（不是空字符串，明确表示"无音轨"），video_pacing/narrative 有值
```

**场景 10（串行）— 超长视频（>5min）**：
```bash
# 准备 8 分钟视频或截取
执行: ffmpeg -i <长视频> -c copy -t 480 /tmp/long.mp4   # 8min
执行: ln -sf /tmp/long.mp4 ${STORAGE_ROOT}/long.mp4
# 触发分析，记录耗时
执行: LPID=$(sqlite3 ./data/relight.db "SELECT id FROM photos WHERE file_path LIKE '%long.mp4'")
执行: time (curl -X POST "http://localhost:${BACKEND_PORT}/api/admin/analyze" -H 'content-type: application/json' -d "{\"photoIds\":[\"$LPID\"]}" && until [ "$(sqlite3 ./data/relight.db "SELECT ai_model FROM photo_analyses WHERE photo_id='$LPID'")" != "skipped" ]; do sleep 10; done)
预期: 5 分钟内完成（whisper large-v3-turbo + 6 帧抽取 + vision），雪碧图仍为 6 帧（不因视频长而增加）；不发生 OOM
```

### 单元测试（蓝队 + 红队覆盖）

- `apps/backend/src/lib/video/__tests__/sprite.test.ts` — 6 帧 buffer 拼成 3×2 雪碧图，验证尺寸+格式
- `apps/backend/src/lib/video/__tests__/ffmpeg.test.ts` — probe 真实测试视频（git fixture），验证字段
- `apps/backend/src/lib/video/__tests__/transcribe.test.ts` — 用真实小音频跑 whisper（mock python 不可信）
- `apps/backend/src/jobs/__tests__/analyze-photo-video.test.ts` — 视频分支 e2e（真实视频 + 真实 AI 服务，可能较慢，标 `.skip` 或 ENV gate）
- `apps/web/__tests__/photo-card-video.test.tsx` — mediaType='video' 渲染包含 Play 图标和时长

### 命令检查（Tier 0/1）

```bash
pnpm typecheck              # TS 类型检查
pnpm lint                   # Biome
pnpm --filter @relight/backend test  # 单元测试
pnpm db:push                # 验证 schema 不破坏
```

## 关键文件落点（速览）

| 路径 | 改动类型 |
|------|----------|
| `apps/backend/src/lib/video/{ffmpeg,transcribe,sprite,index}.ts` | 新建 |
| `apps/backend/src/db/schema.ts` | 加列 |
| `apps/backend/src/db/migrations/00XX_video_support.sql` | 新建（drizzle 生成） |
| `apps/backend/src/cli/backfill-media-type.ts` | 新建（一次性回填） |
| `apps/backend/src/storage/local.ts` | `getMetadata()` 加分支 |
| `apps/backend/src/lib/thumbnail.ts` | 加视频分支 |
| `apps/backend/src/jobs/scan-storage.ts` | 写库时填 mediaType 等 |
| `apps/backend/src/jobs/analyze-photo.ts` | 加视频分支调用 |
| `apps/backend/src/jobs/daily-selection.ts` | 候选摘要 + 阶段 2 视频路径 |
| `apps/backend/src/ai/prompts/v2/video/{system,user}.txt` | 新建 |
| `apps/backend/src/lib/config.ts` | 加 video / whisper 配置 |
| `apps/backend/src/routes/photos.ts` | 新增 `/raw` `/subtitles.vtt` 路由 |
| `apps/backend/src/index.ts` | 启动检测 |
| `packages/shared/src/types.ts` | Photo / PhotoAnalysis 扩展 |
| `apps/web/components/photo-card.tsx` | 视频角标 |
| `apps/web/components/daily-hero.tsx` | 视频 overlay |
| `apps/web/app/photos/[id]/page.tsx` | 视频详情渲染 |
| `.env.example` | 新增示例 |
| `CLAUDE.md` | 更新视频依赖说明 |

总计：约 18 个改动 + 6 个新建，1 个 schema 迁移。

## 复用的现有工具

- `apps/backend/src/ai/client.ts` `analyzePhoto()` — 雪碧图 base64 直接送进
- `apps/backend/src/ai/prompts/index.ts` `loadPrompts(version, name)` — 直接支持 `loadPrompts("v2", "video")`
- `apps/backend/src/ai/response-parser.ts` `parseAnalysisResponse` — 容错 partial merge 模式已支持额外字段
- `apps/backend/src/storage/local.ts` `computeFileHash` —— 流式 SHA256 已适配视频
- `child_process.execFile` —— `analyze-photo.ts:316` 已有 dcraw spawn 范式可参考
- `sharp.composite()` —— 雪碧图拼接

## Plan 审查记录

- 轮 1（plan-reviewer + 验收场景生成器）：发现 2 个 BLOCKER（whisper CLI 输出方式、daily 阶段 2 OOM 路径）+ 3 个 Important（thumbnail 后缀、getMetadata 契约、雪碧图角标成本）；新增 3 个边界场景（损坏视频、无音轨、超长视频）。
- 轮 2 复审：所有 BLOCKER 与 Important 均已解决，结论 **PASS**。

## 不在范围内（明确排除）

- 视频 AI 分析的二次评估（evaluator.ts 不改，视频沿用图片评估器，必要时后续单独迭代）
- 队列拆分（保持单 `analyze-photo` 队列）
- ffmpeg-static 包打包（需要时再加）
- WebVTT 显示样式定制（用浏览器原生）
- 视频缩略图 GIF 动图（首帧足够）

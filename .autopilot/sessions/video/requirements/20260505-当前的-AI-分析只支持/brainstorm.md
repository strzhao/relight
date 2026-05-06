# Brainstorm — 视频 AI 分析支持

## 目标
当前 AI 分析只支持图片（jpg/png/heic/dng 等），视频文件已被 storage adapter 收录到 photos 表，但被 AI 分析黑名单拦截，留下 `aiModel="skipped"` 占位记录。本次需让视频得到与图片同等深度的 AI 分析能力，"好好设计"——含时序、含音频。

## 关键事实（探索结论）
- storage adapter 已收录 .mp4/.mov/.avi/.mkv/.webm/.m4v
- analyze-photo.ts 用扩展名黑名单拦截视频（DB 中已有 skipped 占位）
- 项目无 ffmpeg 依赖（package.json 无 fluent-ffmpeg / ffmpeg-static）
- thumbnail.ts 仅 sharp 路径，视频缩略图缺失
- prompts 是 v1/v2 多版本结构，可新增 v2/video/
- photos 表无 mediaType / duration / fps / codec 字段
- daily-selection 是两阶段（文本评选 + 视觉叙事），阶段 2 直接读图 base64
- 用户本地有 mlx-whisper 服务：`/Users/stringzhao/workspace/martin/scripts/transcribe.py`（CLI，非 HTTP 服务）

## Q&A 决策

### Q1: 视频 AI 分析的深度边界
**选择：多帧 + 音频转录（完整版）**

含义：
- ffmpeg 抽多帧 + 拼成大图给 vision 看到时序
- ffmpeg 提取音轨 → whisper 转文字 → 注入 prompt 让 vision 看懂"画外音/对白/音乐"
- vision 输出综合美学/运动/节奏/叙事维度的分析

### Q2: Whisper 部署方式
**选择：复用用户已有的 martin/scripts/transcribe.py**

接口规范（已读源码确认）：
```bash
/Users/stringzhao/workspace/martin/.venv/bin/python3 \
  /Users/stringzhao/workspace/martin/scripts/transcribe.py \
  <audio.wav> \
  --engine mlx \
  --model large-v3-turbo \
  --language auto \
  --output-format json \
  --output-dir <tmp_dir>
```

输出：写到 `<tmp_dir>/<stem>.json`，结构：`{ text: string, segments: [{start, end, text}] }`。
**stdout 是人类可读日志，绝对不能解析 stdout 取 JSON——必须等进程退出后从文件读取**。

### Q3: 抽帧策略
**选择：场景检测 + 时间均匀兼容**

算法（N=6 帧）：
1. ffmpeg `select='gt(scene,0.3)'` 检测场景切换 → 取前 N 个时间戳
2. 场景数 < N → fallback 时间均匀（总时长 / N，跳过首尾 5%）
3. 抽出的帧 resize 到 768×768 → 拼成 3×2 雪碧图（首版无角标，时序由位置隐式表示）
4. 雪碧图 quality=85 JPEG，一次性传给 vision

特例：视频时长 < 3s → 单帧（中点）；< 30s → 4 帧 2×2 雪碧图。

### Q4: Schema 设计
**选择：复用 photos 表 + mediaType 判别字段**

不新建 mediaItems / videos 表。前端 Photo 类型加可选字段，视图层按 mediaType 判别渲染。

### Q5: UX 全面接入
**选择：视频与图片平等参与所有用户体验**

- /photos 列表：视频缩略图（首场景帧）+ ▶ 角标 + 时长
- /photos/[id] 详情：原视频 `<video>` 可播放 + 字幕 + 完整分析
- daily-selection：阶段 1 混合评选；阶段 2 选中视频时读 cover 帧 + 注入 transcript

## 推荐方案

**方案 A — 全栈完整接入（已确认）**：
- 复用 photos 表 + mediaType
- ffmpeg 抽帧 + 雪碧图
- Whisper 转录（martin/transcribe.py）
- 新增 v2/video prompt（含 transcript 注入）
- daily-selection 视频参与
- 前端列表 + 详情全面支持

完整设计参见同目录 `design.md`。

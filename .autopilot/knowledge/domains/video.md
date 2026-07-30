# 视频生成（memory-video / 每日视频自动化）

<!-- tags: video, remotion, claude-p, memory-video, daily-video, beat-sync, faststart -->

## claude-p 编排架构（后端零业务逻辑，skill 单一真相源）

[2026-07-30] 每日视频自动化不把 Remotion/选片/叙事重写进后端，而是后端 job spawn `claude -p` 调 memory-video skill，让 claude（带 skill）干全部编排。

- **Lesson**：后端零业务逻辑（只 cron + 主题发现 + spawn + 收产物 + 推送），skill 保持单一真相源（选片/叙事/渲染逻辑只在 skill，不在后端重复）。绕开 Remotion 集成后端的依赖膨胀（+Chromium ~500M）和服务器 chrome/gl 问题。
- **Choice**：后端 spawn 用绝对路径 `claudeCliPath`（PM2 resurrect 时 nvm 不在 PATH），cwd=`videoWorkspacePath`，spawn 前三存在校验（node_modules + render 脚本 + SKILL.md），AbortController 超时 + SIGTERM + 清理 .tmp。运行环境 = mac（gl=angle Metal），PM2 env 注入 CLAUDE_CLI_PATH/HOME/VIDEO_WORKSPACE_PATH。
- **代价**：依赖 claude code CLI + token + 非确定性，但个人项目可接受。

## 主题驱动 vs 时间切片（高质量视频要叙事弧线）

[2026-07-30] 每日视频的素材必须是「有弧线的主题」（一次旅行 / 一个人物的新阶段），不是「时间切片」（当日精选/本周回顾/当日新增）。

- **Lesson**：时间切片素材之间没有内在叙事关系，再强的 LLM 也编不出有说服力的弧线 → 用户明确否定「生成不了高质量内容」。高质量片（重庆旅行/翁雪珂人生弧线）素材本身有骨架（旅行起承转合、人生里程碑），章节暗线叙事是「顺着素材的天然弧线讲」。
- **Choice**：主题发现只挑有弧线的旅行（GPS region + 同地≤5天=单次旅行）+ 人物更新（cos≥0.5 + 按年），没主题当天跳过（不凑不降级，质量优先于出片率）。**每日 = 触发频率，不 = 内容是当天的**（类似苹果 Memories 识别故事时刻）。

## AI 自主选片数（不限上限，只设下限）

[2026-07-31] discovery 给 skill 该旅行**全部照片**（不限 top N），让 AI（claude-p）按旅行丰富度自主决定最终片数（≥20，素材多就做完整 vlog）。

- **Lesson**：写死数量上限（如 top 20）限制 AI 发挥——旅行素材丰富时应做完整 vlog（24-40 张），素材少时少做。AI 判断比硬编码准。
- **Choice**：discovery 只设最小门槛（旅行 ≥20 张才候选，<20 没意义），不设上限；prompt 传素材池（按美学降序），AI 自主选。实测霞浦福建 68 张池 → AI 选 24 张做 3.5 分钟 vlog。

## mp4 必须 faststart（Remotion moov 尾部大文件播放失败）

[2026-07-31] Remotion renderMedia 默认 moov atom 在文件尾部，大文件（>100MB）时 QuickTime 等播放器要读完全文件才能解析 → 卡住/播放失败。

- **Lesson**：短视频（<120MB）侥幸能播，3.5 分钟 vlog（130MB）就失败。ffprobe 能解析（结构正常）但播放器卡——`ffprobe OK ≠ 可播放`。
- **Choice**：render-immersive.mjs 渲染后必须 `ffmpeg -movflags +faststart -c copy out.fs.mp4 && mv`（moov 移到开头，秒级不重编码）。所有产物 faststart。

## beat-sync pulse/breath 在风景 vlog 违和（默认全去）

[2026-07-31] beat-sync 缩放脉冲（pulse 跟 onset 跳动）+ breathe 呼吸振荡（sin 每 1.4s）+ mood 池 breath 动画（sin 来回）在旅行/风景 vlog 下都让用户觉得"跳/变大变小"，违和。

- **Lesson**：pulse/breath 在人像抒情（翁雪珂 night-venice）搭，但风景照不该"跳"。用户对来回振荡的缩放敏感——即使 0.4% breathe 也觉得跳，sin 来回的 breath 动画明显"变大变小"。
- **Choice**：CQ-Immersive 默认 `pulseScale=1`（L1 恒等，无任何振荡），Ken Burns 缩放纯靠 L2 anim 单向缓动（zoom-in/out/diagonal 等）；mood 池去掉 breath（sin 来回）换 diagonal（单向）。beat-sync 镜头边界时长 snap（shotFrames 读 beatmap）保留。人像抒情可选启用 pulse。

## 每张时长要够（看清内容）

[2026-07-31] 每镜时长原 8 拍 ~4.4s 偏短，用户反馈"看不清内容，至少 2x"。

- **Lesson**：风景/细节丰富的照片需要更长停留让用户看清。beat-sync 的 BEATS_PER_SHOT 决定每镜时长，但要同时放宽 MAX_SHOT_SEC（原 7s 会 clamp 截短）。
- **Choice**：BEATS_PER_SHOT 8→16（每镜 ~8.8s），MAX_SHOT_SEC 7→10。旅行 vlog 每张 ~9s 起步。

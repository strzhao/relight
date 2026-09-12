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

## 多分支去重语义必须对称（person 死循环 16 天）

[2026-08-27] 08-06 修死循环只修了 trip 分支，person 分支去重盲区让外婆主题连挂 16 天锁死出片名额——同构分支修 bug 必须逐一对称检查。

- **Lesson**：videoUsages 只在成功路径写，失败主题对它不可见；失败的可见性必须查 videos 本表（status + createdAt）。修「去重失效」类 bug 时，同构分支（trip/person）共享同一语义却各有独立实现——只修先发现的一半，另一半会以同样的方式咬人，且被名额独占机制放大（每天只出 1 片）。
- **Choice**：`loadVideoDedup(themeKind)` helper 双分支共用（completed 永久去重 + failed 7 天冷却，冷却起点=最后一次失败）；`writeFailedVideo` 用 `onConflictDoUpdate + setWhere(status='failed')` 让 failed 行每次失败刷新 errorMsg/createdAt（诊断不再被 onConflictDoNothing 吞掉），completed 行永不污染。

## 脏聚类跳过名单走 settings 标量（displayable 不可用作 skip）

[2026-08-27] 母女混淆聚类（cos≥0.5 分不开）每天被选中每天必败，settings key `video.skipPersonIds`（逗号分隔 personId）在 discovery 循环头 continue 跳过。

- **Lesson**：`displayable` 会被 detect-faces/person-merge 按 memberCount≥displayThreshold **重算写回**，不是可靠的持久 skip 位；且有 /photos 人物条隐藏的副作用。运行时跳过名单放 settings 表标量字符串（复用 selfPersonId scalar 先例），缺失/空=无跳过。
- **Choice**：机制（settings 过滤）+ 数据（运维写 aa17477e）双层；脏聚类在 skill 侧的对抗手段是视觉二次确认选片（08-23 skill 用 qwen vision 逐张确认外婆在场，选出的 16 张是干净的——脏聚类不代表不能出片，是 cos 过滤不够）。

## 超时被杀 ≠ 没渲染（排查必看 workspace out/）

[2026-08-27] 30 分钟超时 SIGTERM 时 mp4 已渲完 130MB 躺在 workspace `out/`，job 却报「mp4 产物缺失」——finalize 拷贝没来得及跑，产物文件名还是 skill 自拟的（`person-xuqunxian-2026.mp4` ≠ 约定 themeKey 名）。

- **Lesson**：失败/超时排查必 `ls -lat <videoWorkspacePath>/out/`——渲染成功但没拷走的 mp4 会躺在那里，可挽救（校验 faststart + ffprobe 后补 writeCompletedVideo）。大素材（137 张成长线）渲染 29min+，30min 硬编码超时太紧。
- **Choice**：超时默认 45min（`config.videoSpawnTimeoutMs`，env `VIDEO_SPAWN_TIMEOUT_MS` 覆盖）；「mp4 产物缺失」err 必附 stdout tail（claude -p 退出码 0 却没出片是常见失败形态，真实回复全在 stdout，不记录=诊断盲区）。

## honeydo 大图生成挂死 = macOS GPU 交互保护（非模型/机器故障）

[2026-09-12] <!-- tags: honeydo, mlx, metal, gpu, 挂死, 交互保护, video-gen -->

- **Scenario**：本地扩散生成（MLX/Metal）在桌面机上时长/分辨率调大后「永远卡在第一步」，小参数却一直能跑
- **Lesson**：根因是 macOS `kIOGPUCommandBufferCallbackErrorImpactingInteractivity`——桌面 GPU 负载重时（多屏 Electron 应用、鸿蒙模拟器曾泄漏 63GB GPU 内存）系统杀/饿死长命令缓冲。三个坑：① 挂死态无任何日志/报错，只能靠 `sample <pid>` 看到卡在 `eval_impl → cond_wait`；② **CPU TIME 冻结 ≠ 挂死的可靠判据**（GPU-bound 时 Python 本来就低 CPU）——正确判据是 ioreg 的 `Renderer Utilization`（91%=我方 kernel 在算；低+Device 高=被别人占）；③ `ioreg` 里出现 `AGXMetalA12` 虚拟渲染器 = 有模拟器在跑
- **Choice**：生成任务排空闲窗口（深夜/锁屏）；分辨率不降档牺牲画质（失败回退静态+次日重试），256p 仅作最低兜底；recipes 纪律（≤5s/短边≥700/基座12步/双锚定/人脸≥1/4）是质量铁律，15s 单条方案本身违反漂移纪律
- **Evidence**：15s/8s/4s 傍晚挂死 vs 上午低负载同参数成功 vs 21:12 空闲窗口 4s 成功；ioreg Alloc 63.5GB→关模拟器后 4GB（核对锚点：2026-09-12）

## Remotion 渲染冷启动 600s 级 + browser-executable 必须显式化

[2026-09-12] <!-- tags: remotion, 冷启动, 超时, wallpaper-overlay -->

- **Lesson**：`npx remotion render` 首跑 bundling + Chrome Headless 冷启动实测可达 600s 级——600s 超时会在生产首跑假超时；浏览器缓存按「cwd 向上最近 package.json」解析，cwd 在子目录工程会 miss 上层缓存触发联网重下（并发进程同卡）
- **Choice**：显式传 `--browser-executable` 指向 workspace 已缓存 shell（零下载、确定性）；renderTextOverlay 超时 900s（契约 v2.1）；README/前置校验列入 Chrome Headless Shell 存在性检查
- **Evidence**：smoke 热跑 1.9s vs 冷跑 600s 级（核对锚点：2026-09-12）

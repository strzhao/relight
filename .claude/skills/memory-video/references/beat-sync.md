# 音乐节拍匹配（缩放脉冲跟拍）

让视频「懂音乐」——画面随节拍呼吸，苹果 Memories 的标志性效果。可选增强，配叙事短片/人物成长线效果提升明显。

## 核心洞察（决定一切）

**用户对 Ken Burns 缩放的感知，远强于对瞬时切换的感知。**

推论：
- 把「切换」卡在节拍上效果有限——切换每 4-5s 才一次，而音乐节拍每 ~0.5s 一次，**切换太稀疏，表达不了密集节拍**。
- 真正的节拍感来自 **缩放本身跟节拍呼吸**：每个强拍画面轻微 zoom 脉冲，叠加到 Ken Burns。脉冲密度跟得上节拍，用户无需注意切换就能感知节奏。

所以本系统重心是「缩放脉冲跟拍」，不是「切换卡拍」。切换对齐是次要增强。

> ⚠️ **默认状态：CQ-Immersive 缩放层恒等**（`pulseScale=1`）。pulse 跳动 + breathe 呼吸振荡（`1+0.004*sin(f*0.15)`，每 ~1.4s 一周期）用户都觉得"跳"→ 全去。Ken Burns 缩放完全由 L2 anim 连续平滑提供（zoom/pan 单向缓动无振荡）。**镜头边界时长 snap（shotFrames 读 beatmap）保留**。人像抒情可选启用 pulse+breathe（`pulseScale=breathe*(1+pulse)`）。

## 三层机制

### 1. onset 检测（analyze-audio.cjs · 零依赖）

ffmpeg 提取 mono float32 PCM（22050Hz）→ 滑窗 RMS 能量包络 → 正向差分（onset strength，只留能量上升沿）→ 自适应阈值（局部均值 + k·std）→ 局部极大 = onset。BPM 用 onset 脉冲序列自相关估计。

```bash
node analyze-audio.cjs public/audio/xxx.mp3 beats-xxx.json [kStd]   # kStd 默认 1.2（越大越严）
```

输出 `beats-{name}.json`：`{ duration, bpm, onsets: [{time, strength}] }` + 每 10s 桶 onset 密度直方图。

**精度**：机械鼓点对照（gen-click.cjs 合成严格 bpm）验证，onset 检测偏差 <0.1s，算法够用。

### 2. 镜头对齐（build-beatmap.cjs）

两种模式：

- **snap（默认，通用）**：cursor 跟随 onset，每镜目标 = N 拍，在 ±窗口内 snap 到 onset。**cursor 跟随不累积 BPM 误差**。strength×近邻 加权选主拍（不选 ghost note）。
- **grid（仅 BPM 极准时）**：纯 BPM 周期。**慎用**——BPM 微误差会累积漂移（实测每镜偏 +0.08s，3 镜后偏 0.34s）。

```bash
node build-beatmap.cjs beats-xxx.json [shotsPerChapter] [snap|grid] [beatsPerShot]
# beatsPerShot：旅行 12（~6.4s 利落）/ 人物 16（~8.5s 抒情，默认）；秒数随配乐 BPM 浮动
# 输出 src/beatmap.json：shotFrames（每镜帧数）+ shotOnsets（每镜强 onset 相对时间，喂给 Shot 算脉冲）
```

### 3. 缩放脉冲（Shot · 节拍感来源）

Shot 用 `useCurrentFrame()` 算当前帧到该镜每个强 onset 的距离，叠加 cos 钟形 zoom 脉冲到 Ken Burns scale：

```tsx
const myOnsets = BEATMAP.shotOnsets?.[index] ?? [];
const tt = f / fps;
let pulse = 0;
const PW = 0.8; // 脉冲总宽（onset 前后各 0.4s，慢呼吸）
for (const ot of myOnsets) {
  const dt = tt - ot;
  if (Math.abs(dt) < PW / 2) pulse += 0.5 * (1 + Math.cos((Math.PI * dt) / (PW / 2))) * 0.012;
}
const sf = scale * breathe * (1 + pulse);
```

CQ-Immersive.tsx 的 `shotFrames()` 读 `BEATMAP.shotFrames[idx]`，Soundtrack src 读 `BEATMAP.audio`（换曲自动切配乐）。

## 关键洞察（避免重蹈弯路）

1. **缩放感知 >> 切换**：节拍感来自缩放脉冲，不是切换卡拍。切换太稀疏（4-5s）表达不了密集节拍（~0.5s）。这是整套系统的设计原点。
2. **snap > grid**：grid 纯周期会因 BPM 微误差累积漂移；snap（cursor 跟随 onset）对 BPM 误差鲁棒。抒情曲 BPM 估不稳（中位数 vs 自相关可差 10bpm），必用 snap。
3. **strength 加权选主拍**：鼓点曲每拍有 kick+snare+ghost 多个 onset（间隔 CV 高），最近邻 snap 会选 ghost note；strength×proximity 加权选主拍。
4. **抒情曲 tempo 弹性（rubato）**：钢琴抒情曲 onset 是乐句重音，间隔 CV ~0.28（非机械周期），固定 grid 必有 ~0.08s 残留偏差。这不是 bug 是音乐在「呼吸」。snap 跟随真实 onset 即可。
5. **fade 软硬**：fade 转场太柔（FT=20=0.66s）会糊掉节拍点（ffmpeg scdet 都检测不到切换边界）。硬切 FT=4 让节拍点可见。但缩放脉冲比硬切更重要。
6. **选曲决定踩拍上限**：鼓点曲（BPM 稳定、onset=主拍）能 12/16 镜头完美踩拍；抒情曲上限 ~8/16。但抒情曲配抒情叙事更搭——**别为踩拍选违和的曲子**（纯鼓配人生弧线就违和）。兼顾叙事+节拍的曲子（轻爵士/民谣带轻鼓点）最优。
7. **pulse 三轴：频率/幅度/曲线**，都偏大会突兀。「一张照片一次呼吸」是直觉好的默认。

## 参数（已验证 · 翁雪珂 night-venice）

| 参数 | 值 | 位置 | 调参方向 |
|------|-----|------|---------|
| pulse 幅度 | 0.012（1.2%）| Shot `*0.012` | 太弱→0.016 / 还强→0.008 |
| pulse 曲线宽 | 0.8s（cos 钟形）| Shot `PW` | 还慢→1.0 / 想脆→0.5 |
| 每镜 pulse 数 | 1（top 强 onset）| build-beatmap `slice(0,1)` | 想密→slice(0,4) |
| snap 窗口 | ±0.15s | build-beatmap `SNAP_WINDOW` | 太严没命中→0.25 |
| snap 选拍 | strength×(0.3+prox) | build-beatmap snap | — |
| 每镜拍数 | 旅行 12（~6.4s）/ 人物 16（~8.5s）| build-beatmap `BEATS_PER_SHOT`（argv[5]，默认 16）| 旅行 vlog 节奏利落起步 12；人物抒情保留 16；想快→8 / 慢→20 |
| 转场 | FT=4（近硬切）| CQ-Immersive | 章节可柔，镜头硬 |

## 工具脚本（video-dryrun）

| 脚本 | 作用 |
|------|------|
| `analyze-audio.cjs [mp3] [outJson] [kStd]` | onset 检测 + BPM + 密度直方图 |
| `build-beatmap.cjs [beatsJson] [shots] [snap\|grid] [beatsPerShot]` | onset → 每镜帧数 + shotOnsets，输出 src/beatmap.json，带踩拍精度自检（<50ms 占比）。beatsPerShot 旅行 12 / 人物 16（默认）|
| `diagnose-beat.cjs [beatsJson]` | 诊断 onset 周期性 / BPM 自相关 / 镜头边界偏差 |
| `gen-click.cjs [bpm] [dur]` | 合成机械鼓点（对照实验，验证算法精度上限）|

## 调参经验（用户反馈迭代轨迹）

从强到弱逐步收，避免一开始就太克制没节拍感：
- **v1**：每 onset +5% exp 尖峰 → 节拍感强，但「变化太多、太强烈、太突兀、完全不搭」
- **v2**：top4 强拍 +2.2% cos 0.34s → 「好很多，但幅度还大、还快、还多」
- **v3**：top1 +1.2% cos 0.8s → 「效果不错」✓

**教训**：pulse 要克制到「一张照片一次轻微呼吸」，而非「每个鼓点猛跳」。幅度 >2% 或频率 >2/镜 就容易喧宾夺主。

## 已验证

翁雪珂 night-venice（抒情钢琴，bpm 112）：每镜 1 次 +1.2% + 0.8s cos 钟形脉冲，缩放跟最强调音呼吸。节拍感清晰、不突兀、搭抒情叙事。

big-drumming（纯鼓，bpm 107，算法验证用）：snap + strength 加权 12/16 镜头完美踩拍（偏差 0ms）。证明算法上限——但纯鼓配抒情叙事违和，仅作强度验证。

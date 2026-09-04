# 效果池 + 章节 mood（动画/切换服从叙事气质）

让镜头效果「服从故事气质」——按章节情绪从效果池选动画+切换，而非全池随机。与 `beat-sync.md`（节拍匹配）正交，可叠加。

## 核心洞察（为什么不全随机）

全池随机会撞**违和组合**：婚礼红伞 × Flip 翻转（人脸瞬时消失）、孕育静思 × Zoom Punch 强推、抒情人像 × Push 3D。技术上都在池里，但效果与叙事冲突。

所以效果要**服从章节气质**——这是 skill 第一铁律「故事核心 > 技巧」在镜头层面的落地。苹果 Memories 也按 mood 选过渡风格（欢快段=快切+slide，抒情段=慢 dissolve）。

## 两层架构

**底层** `src/scenes/effects.ts`（零渲染依赖，任何 composition 复用）：
- `ANIMS`（10 种图片内动画）+ `TRANS`（10 种切换），每个带元数据：`AnimEffect.kind`（触及维度）/ `TransEffect.touches` + `minFt`（切换展开所需最小帧数）
- `ANIM_BY_KEY` / `TRANS_BY_KEY` 查表

**上层** mood 选池：`MOOD_POOLS`（4 档子池）+ `pickEffectsForChapter`（确定性选）。CQ-Immersive 渲染时按章节 mood 调用。

## mood → 子池映射

| mood | 适用 | anim 子池 | trans 子池 | defaultFt |
|------|------|-----------|------------|-----------|
| 静 | 收尾/独处/宁静/回忆 | zoom-in/out, focus, diagonal | fade, blur, iris | 10 |
| 暖 | 温暖/相恋/日常/家庭 | zoom-in, diagonal, rotate, focus | fade, zoom-in, blur, iris | 12 |
| 动 | 热闹/旅行/探索/城市 | pan-h/v, diagonal, zoom-in, rotate | slide-r/u, zoom-in, wipe | 13 |
| 烈 | 高潮/爆发/冲突/仪式 | punch, pan-h, rotate, tilt, diagonal | push-3d, zoom-out, wipe, zoom-in | 13 |

- 弧线通常 **静→暖→动→烈→静**（首尾静，中段递进），呼应「四瓶酒」
- **flip 翻转对人脸违和**（人脸瞬时消失），不进默认池，仅旅行风景主题酌情启用
- key 名以 effects.ts 实际值为准（`focus` 不是 focus-pull；`punch` 不是 zoom-punch）

## 三层 transform 嵌套（最关键，绝不字符串拼接）

一个镜头同时有 beat 脉冲(scale) + anim(zoom/pan/rotate/skew) + trans.enter(scale/translate/clip/rotateY)。CSS transform 字符串顺序敏感（`scale(2) translateX(10)` ≠ `translateX(10) scale(2)`），拼一个字符串会让脉冲放大 anim 位移、anim 的 rotate 扭曲脉冲。

**解决：DOM 嵌套三层 div，各管一类 transform**：

```
L3 trans.enter（最外，clip/scale/translate/rotateY 入场）
 └─ L1 beat pulse（仅 scale(pulseScale)，全局呼吸）
      └─ L2 anim（apply 返回的 transform+filter）
           └─ <Img>
```

**为什么这个顺序**：
- trans.enter 必须最外层包住 pulse——clip(iris/wipe) 要裁最终合成，被 pulse 放大会错位；scale(zoom-cut/push-3d) 嵌脉冲内会双倍缩放；translate(slide) 嵌脉冲内位移被放大
- anim scale 与 pulse scale **累积相乘是期望行为**（等价 beat-sync 的 `sf = scale * breathe * (1+pulse)`，anim scale 充当原 Ken Burns scale 角色）
- 竖图模糊 bg 放 L0 最底层，不进 L3（不被 enter 裁切）
- `willChange` 只加 L1/L2/L3，字幕层不加（防层爆炸）

## pickEffectsForChapter（整章预算）

确定性 + 章内去重 + 互斥：
- 一次算出该章所有 shot 的 pick（非逐 shot），Fisher-Yates 打散（seed=chapterIdx 固定→输出固定，可复现）
- anim/trans 用不同 seed 错位（避免同 shot 的 anim/trans 总是同 index）
- 相邻去重双保险（同章连续镜头不撞同效果，防 flip 连续发晕）
- **focus × blur 互斥**：focus anim 有 blur filter，blur trans 也有 blur filter，叠加过糊——focus 时 trans 跳过 blur

## 无 mood 回退（向后兼容）

`CQChapter.mood?` 可选。**无 mood 时完全回退原 8 方向 Ken Burns + FT=4 fade + beat 脉冲，逐字节等价**：
- `animStyle = mood ? anim.apply(...) : kbFallbackStyle(index,f,dur,sc)`（kbFallbackStyle 抽自原 KBS 逻辑）
- `ft = mood ? max(trans.minFt, defaultFt) : 4`
- 章节首镜 trans 强制 fade（`isChapterFirst` → trans=null，避免章节卡淡出+新图 slide 违和）

老主题（合一/重庆）无 mood 自动走回退，已出片可复现，风格不突变。

## 关键参数

| 参数 | 值 | 位置 | 说明 |
|------|-----|------|------|
| mood 档位 | 静/暖/动/烈 | `MOOD_POOLS` | 4 档子池 |
| 镜头 ft | max(trans.minFt, mood.defaultFt) | `ftOf` | 静10/暖12/动13/烈13，无 mood=4 |
| 章节卡 ft | 4 | `ftOf` | 文字卡硬切边界干净 |
| 三层嵌套 | L3 enter 包 L1 pulse 包 L2 anim | Shot | 绝不字符串拼接 |
| 章内去重 | Fisher-Yates + 相邻 +1 | `pickEffectsForChapter` | seed=chapterIdx |

## 踩坑（实施时盯）

1. **三层 transform 必须嵌套 div，不能拼字符串**——顺序敏感，拼接会让脉冲放大/扭曲 anim
2. **FT 放宽到 10-13 不削弱节拍感**——节拍来源是缩放脉冲（见 beat-sync.md），不是切换；slide/wipe/iris 需 ≥12 帧才展开
3. **bodyFrames 必须用实际 transition ft 之和扣减**——`sumSeq - sum(ftOf)`，用固定 FT 扣会在 mood 版（动态 ft）导致 composition 时长与 TransitionSeries 不匹配
4. **iris 终值横屏漏黑**——16:9 角落距中心 ~62% 对角，78% circle 漏黑，统一用 88% 安全覆盖
5. **flip 不进默认池**——rotateY 80° 翻转对人脸违和（人脸瞬时消失），仅旅行风景主题酌情
6. **focus × blur 过糊**——两层 filter:blur 叠加，pickEffects 加互斥
7. **punch + 竖图 contain**——scale 1.3 会溢出 contain 框，烈档竖图可降终值或禁用

## 已验证

翁雪珂（5 章：少女暖/相恋暖/新婚烈/孕育静/为母暖）+ beat-sync 脉冲三层共存：`CQ-Weng-Mood.mp4`。每章从子池随机 anim×trans，效果服从叙事弧线，节拍感保留。

`FX-MoodMix.mp4`（12 张 3静3暖3动3烈纯展示，无脉冲）用于隔离验证 mood 池差异 + 三层嵌套结构。

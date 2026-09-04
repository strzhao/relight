# 数据契约

## 输入：主题描述
一句话主题（如「重庆 2021 旅行」「赵合一成长线」「2024 年度」）→ 引擎查 relight DB 选片 → 生成下列数据。

## cq-data.ts 结构（Remotion 渲染输入）

### CQ_PHOTOS（照片 + 字幕）
```ts
export type CQShot = { file: string; word: string; caption: string };
export const CQ_PHOTOS: CQShot[] = [
  { file: "themes/trips/chongqing-2021/01.jpg", word: "洪崖洞", caption: "千年传说，在夜色里苏醒" },
  // ...
];
```
- `file`: 相对 `public/` 的路径（如 `themes/trips/<trip>/NN.jpg`）。**该 jpg 必须是原图（`photos.file_path`，多为 HEIC）经 `sips -Z 1920` 转出的高清 JPEG，不是 800px 缩略图**——1080p 下缩略图必糊。原图缺失 hard fail，不降级。
- `word`: 1-3 字情绪锚点（顶部小字，**不是地名**，如「烟火」「对望」「追光」）
- `caption`: 弧线叙事句（底部大字，推进情绪，不描述画面）

### CQ_CHAPTERS（章节暗线）
```ts
export type CQChapter = { name: string; line: string; start: number; mood?: "静" | "暖" | "动" | "烈" };
export const CQ_CHAPTERS: CQChapter[] = [
  { name: "烟火", line: "旅行的温度，从一顿火锅开始", start: 0, mood: "动" },
  { name: "夜", line: "山城的魔幻，在灯火里苏醒", start: 1, mood: "烈" },
  // start = 该章首镜在 CQ_PHOTOS 的 index；mood = 该章情绪档位（可选，决定 anim×trans 子池）
];
```
- `name`: 1-2 字章节名（章节卡大字，如「夜」「城」）
- `line`: 章节暗线（一句情绪主题）
- `mood`（可选）: 章节情绪档位「静/暖/动/烈」，驱动该章镜头的动画+切换效果池（效果服从叙事气质，避免全随机违和组合）。省略 = 走默认 8 方向 Ken Burns + fade（老主题兼容）。映射规则见 `narrative.md`「章节 mood」。
- ~5 章，情绪递进

### 标题/收尾
```ts
export const CQ_TITLE = "重庆";              // 开场大标题
export const CQ_SUBTITLE = "2021 · 山城三日"; // 副标
export const CQ_DATELINE = "2021年5月6–8日";  // 日期地点
export const CQ_END = "洪崖洞 · 立体山城";    // 收尾卡
```

### KICKER / LOC（必填，防误显「重庆」）
```ts
export const CQ_KICKER = "CHINA · CHONGQING"; // 开场标题上方英文 eyebrow
export const CQ_LOC = "重庆 · 2021.05";       // 每镜 word 旁的小字（地点 · 年.月）
```
**必填，不可省略**：省略时老版组件会 fallback 硬编码「中国 · CHONGQING / 重庆 · 2021.05」——非重庆主题（闽海/日本等）曾因此整部片标题眉误显重庆。正确做法：每个主题都按真实地点写这两个字段（如闽海 `"FUJIAN · MINSEA"` / `"霞浦 · 2026.05"`）。

### 配乐
`public/audio/*.mp3`，FreePD CC0（Romance 池）：
- `bgm.mp3` = Nostalgic Piano（温馨怀旧）
- `night-venice.mp3` = Night in Venice（夜景）
- `isolation-waltz.mp3` = Isolation Waltz（怀旧）

选曲匹配主题情绪（旅行夜景→night-venice；温馨日常→nostalgic）。

## 字幕写作原则
1. caption **推进情绪**，不描述画面（"山城的第一口，是滚烫的烟火" > "红油翻滚的火锅"）
2. word 是情绪锚点，不是地名（"烟火"/"对望" > "洪崖洞"/"桥"）
3. 章节暗线**递进**（热闹→魔幻→冷峻→温暖→宁静）
4. 收尾回扣开场（首尾呼应）

## 选片数量
- 旅行短片：~20-24 张（去连拍 + 场景分桶 + 时间序），总时长 ~2 分钟
- 每张 SHOT=150帧（~5s），章节卡 CHAP_F=66（~2.2s）
- 美学≥8.0 通常不够（会漏场景），用**场景分桶**保证覆盖

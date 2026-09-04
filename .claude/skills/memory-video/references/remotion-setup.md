# Remotion 项目结构（video-dryrun）

完整渲染项目在 `relight/.autopilot/runtime/requirements/<task>/video-dryrun/`。新主题换 `cq-data.ts` + 照片资产，复用模板。

## 依赖
```json
{
  "dependencies": {
    "@remotion/bundler": "4.0.429",
    "@remotion/cli": "4.0.429",
    "@remotion/renderer": "4.0.429",
    "@remotion/transitions": "4.0.429",
    "react": "19.2.3", "react-dom": "19.2.3", "remotion": "4.0.429"
  }
}
```
装：`pnpm install --ignore-workspace --dir <project>`（避免被 relight workspace 吞）。esbuild ignored builds 警告无影响，渲染用 `node render.mjs` 绕过 pnpm run 的 deps-check。

## 关键文件
| 文件 | 作用 |
|------|------|
| `src/index.ts` | registerRoot 入口 |
| `src/Root.tsx` | Composition 注册（**id 禁下划线**，用 `CQ-Immersive`） |
| `src/cq-data.ts` | **换主题改这里**：CQ_PHOTOS + CQ_CHAPTERS + 标题 |
| `src/fonts.ts` | ensureFonts：base64 FontFace + delayRender（霞鹜文楷/Fraunces/NotoSerifSC） |
| `src/components.tsx` | KenBurns/BottomShade/Vignette/Letterbox/Grain/FadeUp/TitleCard/EndCard/Typewriter/WordTitle/Soundtrack |
| `src/scenes/CQ-Immersive.tsx` | **章节暗线版主组件**（8方向 Ken Burns + 章节卡 + 弧线字幕） |
| `render-immersive.mjs` | bundle + renderMedia |

## Immersive 模板参数（已验证）
```ts
const FT = 20, TITLE_F = 80, END_F = 84, CHAP_F = 66, FIRST_SHOT = 200, SHOT = 150;
```
- **分辨率**：正式版 composition `width=1920 height=1080`（fps 30）。720p（1280×720）仅 dry-run。`render-immersive.mjs` 用 `selectComposition` 读 Root.tsx 注册值——正式版把 Root.tsx 里 `CQ-Immersive` 的 width/height 改 1920×1080，或 render 时传 `composition: {...comp, width:1920, height:1080}` override。
- 8 方向 Ken Burns（KBS 数组，告别统一 pan）+ `Easing.inOut(Easing.cubic)` 缓动 + 轻微呼吸
- 章节卡：CHAPTER + 章名 + 暗线，spring 入场
- 字幕：霞鹜文楷 38px，paddingBottom 5%，双层 textShadow，spring 弹性，**无装饰线**
- TransitionSeries：章节卡 + 镜头交替，fade + linearTiming

## 资产
- `public/fonts/`: LXGWWenKai-Regular.ttf（24M，霞鹜文楷）/ Fraunces-VariableFont.ttf / Fraunces-Italic / NotoSerifSC-Regular.otf
- `public/audio/`: bgm.mp3 / night-venice.mp3 / isolation-waltz.mp3（Kevin MacLeod CC-BY，早年下自 FreePD——**FreePD.com 已永久关闭**，新曲去 [incompetech.com](https://incompetech.com/music/royalty-free/music.html)，直链 `mp3-royaltyfree/<Name>.mp3`）
- `public/themes/<topic>/`: 照片 NN.jpg —— **必须是原图（`photos.file_path`，HEIC）经 `sips -Z 1920` 转出的高清 JPEG，不是 800px 缩略图**（1080p 下缩略图必糊）。原图缺失则该主题无法渲染，hard fail。

## 渲染
```bash
cd <video-dryrun>
node render-immersive.mjs [outName]   # 输出 out/<outName>.mp4，默认 CQ-Immersive
```
**renderMedia 必须带 `chromiumOptions: { gl: "angle" }` + `concurrency: 4`**——默认 gl=null（swiftshader 纯 CPU 软件渲染）在长期未重启 / WindowServer 占 GPU 的机器会**崩溃卡死**（实测渲染 0 帧卡住，重装 chrome 也救不回）；`gl: "angle"` 走 Metal GPU，1080p 2544 帧 **~36s**，**不用重启电脑**。

720p 仅 dry-run 快速预览。Chrome headless 首次下载 arm64（~90M，缓存复用）。素材方向自适应（横图预裁 / 方竖图 contain+模糊 bg）见 `orientation.md`。

## 预览页
生成 html（每个 video 独立 controls loop，不同步播放——用户逐个确认）。暖色 OKLCH（relight 色板）。

## 踩坑
- composition id 禁下划线（`StyleA_Magazine` 报错 → `StyleA-Magazine`）
- timing 是 `linearTiming`（主包导出），非 `linear`
- 字体 FontFace 用 delayRender 等加载，否则回退系统 serif
- embedding base64（见 relight-db.md）

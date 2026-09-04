# 横竖屏优化（手机照片在 16:9 视频里不切头/不怪）

手机照片多为竖图/方图，硬塞 16:9 横屏 `cover` 会切头/裁主体。这套方案让任意方向的图都好看，且渲染快。

## 判断逻辑（核心）

```
width > height      → 横图：cover 预裁 16:9 对齐脸
否则（方图 w==h + 竖图 h>w）→ contain 全部 + 预生成模糊背景
```

**方图必须归 contain**（cover 裁方图会切头/构图怪）。只有严格横图（w>h）才走 cover。

## A 横图：预裁切对齐脸（convert 阶段，非运行时）

横图在 convert 时用 sharp 按 `faces.bbox` 把图**预裁到 16:9**，脸在画面里。Shot 走 cover 居中（GPU 快）。
- 裁切框 16:9，水平/垂直居中脸中心（clamp 到图内）
- `sharp(src).rotate().extract({left,top,width,height}).resize(1920,1080,{fit:"fill"})`
- **不用运行时 `objectPosition`**——它会触发 Chrome CPU 慢路径（实测 1080p 卡死）

## B 竖/方图：预生成模糊背景（convert 阶段，非运行时）

竖/方图 contain 在 16:9 会左右留白。convert 时预生成两张静态图：
- `NN.jpg`：contain 前景（`resize({height:1080, fit:"inside"})`，宽按比例）
- `NN-bg.jpg`：模糊背景（`resize(1920,1080,{fit:"cover"}) + blur(28) + brightness(0.4)`）

Shot 双 Img（模糊 bg 铺底 + contain 前景带 Ken Burns）。
- **不用运行时 `filter:blur`**——CSS blur 是 headless Chrome 性能毒药（实测每帧几十秒）
- 预生成静态图后渲染和纯 cover 一样快（~36s）

## EXIF orientation（必须，否则竖图变横）

iPhone 照片带 EXIF orientation。**sharp 必须加 `.rotate()`**，否则按传感器原始方向处理（竖图被当横图）。
- relight `detect-faces.ts` 也用 `sharp(buffer).rotate()` 处理（先例）
- HEIC 先 `sips -s format jpeg` 转（macOS sharp 解不了 HEIC），再 `sharp.rotate()`

## C 方向智能判断（输出方向，基于召回照片横竖比）

```
横图(w>h) 占比 ≥ 65% → 横屏 16:9
竖图 占比 ≥ 65%      → 竖屏 9:16
否则                 → 横竖都输出（冗余没关系，让用户选）
```
合一/翁雪珂都横图为主 → 横屏。

## 渲染性能：gl=angle（必做，否则崩溃）

Remotion 默认 `gl=null`（swiftshader 纯 CPU 软件渲染），在**长期未重启 / WindowServer 占 GPU** 的机器上**崩溃卡死**（实测渲染 0 帧卡住，重装 chrome 也救不回）。

**必须** `chromiumOptions: { gl: "angle" }`（走 Metal GPU）+ `concurrency: 4`：
- 修复后 1080p 2544 帧渲染 **~36s**（vs 卡死）
- **不用重启电脑**
- `renderMedia({ ..., concurrency: 4, chromiumOptions: { gl: "angle" } })`

## 工具脚本（video-dryrun）

| 脚本 | 作用 |
|------|------|
| `compute-positions.cjs [person_id] [name]` | 算每张 faceX/faceY + orient（`w>h?"landscape":"portrait"`，方图归 portrait）+ 输出方向判断 |
| `convert-smart-{name}.cjs` | A 预裁横图 + B 预生成竖/方图模糊背景 + EXIF `.rotate()` + HEIC sips 转 |

## Shot 组件（Remotion，方向自适应）

```tsx
const pos = POSITIONS[photo.file] || { orient: "landscape" as const };
const bgFile = photo.file.replace(".jpg", "-bg.jpg");
{pos.orient === "portrait" ? (
  <>
    <Img src={staticFile(bgFile)} style={{ width:"100%", height:"100%", objectFit:"cover", transform:"scale(1.1)" }} />
    <Img src={staticFile(photo.file)} style={{ position:"absolute", inset:0, objectFit:"contain", transform: KenBurns }} />
  </>
) : (
  <Img src={staticFile(photo.file)} style={{ width:"100%", height:"100%", objectFit:"cover", transform: KenBurns }} />
)}
```

## 已验证

翁雪珂 16 张（4 横 cover + 12 竖/方 contain），1080p 渲染 36s，脸不切头 / 方图完整 / 模糊背景协调。

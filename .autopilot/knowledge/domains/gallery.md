# VPS 画廊 + COS 推送（gallery.stringzhao.life）

<!-- tags: gallery, cos, vps, caddy, manifest, 推送式同步, 企微-webhook, 旁路容错 -->

## 企业微信群机器人 webhook 能力边界（不支持视频）

[2026-08-01] 企业微信群机器人 webhook 只支持 text / markdown / image（≤2MB base64）/ news（图文卡跳外链）/ file（需 upload_media，≤20MB）。**不支持 video 类型消息**（群机器人无 video msgtype；「应用消息」API 才有，也要 media_id 且文件受限）。

- **Lesson**：vlog ~119MB 超 file 通道 20MB 上限，群机器人没有 video msgtype。视频只能靠**公网 URL**让群里点开播放。
- **Choice**：每日视频推送不发视频本体，发封面（image）+ 标题 + **公网播放链接**（`gallery.stringzhao.life/#/video/<id>`）。企微硬限制，非代码问题。关联 [[video]]（每日视频自动化推送）。

## VPS 公网画廊推送式架构（复用现有基建，零新容器）

[2026-08-01] 数据在本机 SQLite（dailyPicks/videos），VPS 拿不到 → 用**推送式同步**：本机 daily-selection / daily-video job 完成后，资源传 COS、manifest.json 推 VPS（ssh scp），VPS Caddy 静态站读 manifest 渲染。

- **Lesson**：VPS 纯静态无后端无 DB，本机主动 push（非 pull）。复用 vps-ops 全部现有基建（公有读 COS 桶 `little-bee-assets` + Caddy 反代 + 备案域名 `stringzhao.life` + SSH 免密 + 子账号 AK/SK），**零新增基础设施**。
- **Choice**：Caddy 加一个 server block 托管静态 HTML（root + file_server + `X-Robots-Tag noindex`），零新容器（VPS 内存紧 1.9G 跑 5 容器）。manifest 全量重生成（数据小 ~458 entries 级，无增量状态机）。资源走 COS 公有读直链，key=photoId UUID 不可枚举。关联 [[release-ops]]（vps-ops Caddy/DNS）。

## manifest 放 VPS 同源，不放 COS（防遍历绕过隐蔽保护）

[2026-08-01] 画廊访问保护用「不索引 + 域名不公开 + COS key=UUID 难猜」（无 basic auth）。manifest 若放 COS（固定 key `relight/manifest.json` + 公有读），任何人拼 URL 可拉全量清单（含所有照片 COS 直链），绕过页面入口。

- **Lesson**：公有读桶的**固定 key 对象 = 公开**。manifest 含全量资源 URL，放 COS 等于裸奔（ListBucket 被拒也挡不住已知 key 直接 GET）。
- **Choice**：manifest 放 VPS（Caddy 同源 fetch，受 noindex + 域名不公开隐蔽）。资源放 COS 公有读但 key=UUID 难猜。「保护页面 = 保护清单入口」，单张资源即使桶公有读也猜不到。本机 job 用 child_process ssh/scp 推 manifest（不引 ssh2 依赖）。

## COS 上传容错返回空串不 throw（画廊旁路，不阻塞主流程）

[2026-08-01] gallery 同步是精选/视频主流程的**旁路**（加了给企微/画廊看，失败不应影响本地产物 + 推送）。`uploadFile` 重试 3 次后 **console.warn 返回空串，不 throw**；`syncDayToGallery` / `syncVideoToGallery` 整函数 try/catch，失败 console.warn + job.log。

- **Lesson**：旁路功能失败不能拖垮主流程。与 [[backend-infra]]「格式门 return 非 throw」、[[release-ops]]「PM2 reload in-flight」同构——容错边界用「不 throw + 记录」而非「抛错给上层」。
- **Choice**：`uploadFile` / `uploadBuffer` 返回空串（非 throw）；`sync*` 返回 `Promise<void>`（不暴露成功/失败，`pushManifest` 内部 console.log/warn 自记录）；daily-selection / daily-video 接入点双层 try/catch。COS 凭据命名兼容 `TENCENTCLOUD_*`（vps-ops 真源）/ `COS_*`（relight env 别名）—— config 优先读前者 fallback 后者。

## gallery 视频全屏（方案 B：原生全屏 API + 物理横屏引导）

[2026-08-29] 竖屏沉浸流里 16:9 横屏视频 `contain` 只占 ~26% 屏高、不沉浸。用户知情选原生全屏（接受 iOS 物理转手机），弃 CSS 伪横屏/竖版重渲染/纯排版三案。入口 = 声音按钮下方 `⛶` 圆钮，保留"点视频=切静音"。

- **Lesson**（探针实证，勿信老资料）：Chromium（@playwright/test 1.59.1 内置）`video.webkitEnterFullscreen` 是 **undefined**；`video.requestFullscreen()` 正常派发 `fullscreenchange` 且 **target 是 VIDEO 元素**。老 XWeb 可能只有前缀事件——退出监听必须 `fullscreenchange` + `webkitfullscreenchange` 双挂（restore 幂等靠 lastFullscreenVideo 空守卫）+ video 元素 `webkitendfullscreen`（iOS 原生播放器）。
- **Choice**：探测顺序 `requestFullscreen` 优先（Chromium/XWeb 全程标准事件）、`webkitEnterFullscreen` 仅 iOS WKWebView 兜底（iPhone 无 Element.requestFullscreen）；进全屏先 unmute + 未播则手势内起播，退出恢复 muted + try orientation.unlock；视频 404 用纯 CSS 门 `[data-load-state=error]` 隐藏按钮；双 API 均缺 → 单元内 toast「建议横屏观看」≤3000ms 自动隐藏。验收谓词 FS.PM1-5 见 `apps/gallery/__tests__/gallery-video-fullscreen.e2e.acceptance.test.ts`（PM3 退出断言有毫秒竞态，见 [[testing]]）。

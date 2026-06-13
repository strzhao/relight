# 前端 (Frontend)

> 从 decisions.md 和 patterns.md 拆分 | 父级索引: ../index.md

---

## 架构决策

### [2026-05-04] 全屏照片查看器选择自定义 Lightbox 而非 Radix Dialog

<!-- tags: lightbox, radix-ui, dialog, frontend, a11y, design -->

**Choice**: 自定义 Lightbox 组件（Context + Provider 组合式架构），纯 CSS transform 实现缩放/平移。Radix Dialog 有 max-h 限制，focus trap 行为与全屏图片查看场景冲突。

---

### [2026-05-10] apps/web 拆分双 tsconfig — 生产严格 + 测试松弛，恢复 noUncheckedIndexedAccess

<!-- tags: tsconfig, typescript, strict, noUncheckedIndexedAccess, test-infra, dom-api, monorepo, design -->

**Choice**: 拆分双 tsconfig：`tsconfig.json` 生产代码继承根 strict + exclude 测试目录；`tsconfig.test.json` 仅对测试关闭 noUncheckedIndexedAccess。双 tsc 调用让 typecheck 时间翻倍（~3s×2=6s，可接受）。

---

## 模式与教训

### [2026-05-14] flex item `align-items: center` + 子元素 aspectRatio + max-h-full = 祖先 overflow-hidden 隐式裁剪

<!-- tags: flexbox, css, align-items, aspect-ratio, max-height, overflow-hidden, frontend, daily-hero, bug, layout -->

**Fix**: 把父容器 `align-items: center` 改成 `align-items: stretch`。stretch 给 flex item 明确的 used cross-size，descendant `max-h: 100%` 才能正确解析。修复单行 CSS，根因诊断非常容易绕路。

---

### [2026-05-04] IntersectionObserver 在 React 中的生命周期管理——避免级联加载循环

<!-- tags: react, intersectionobserver, infinite-scroll, ref, useeffect, cascade -->

**Lesson**: IntersectionObserver 应遵循「创建一次、永不重建」原则。回调通过 ref 读取最新状态避免闭包过期；使用 `observerRef` 标记防止重建；仅在组件卸载时 disconnect。

---

### [2026-05-08] IntersectionObserver 监听条件渲染节点必须用 callback ref，不能用 useRef + useEffect

<!-- tags: react, intersectionobserver, callback-ref, conditional-rendering, useeffect, infinite-scroll, bug -->

**Lesson**: 条件渲染或后期挂载的 DOM 节点配 IntersectionObserver 必须用 callback ref 模式。useRef 不触发重渲染，effect 只在 deps 变化时跑——deps 稳定 + ref 节点延迟出现 → observer 永不接入。

---

### [2026-05-09] React SSR `{value} 文本` 在输出 HTML 中插入 `<!-- -->` 注释，破坏文本正则匹配

<!-- tags: react, ssr, render-to-string, comment-marker, regex, jsx, expression-container, test, bug -->

**Fix**: 把整段拼成单一表达式 `{\`${value} 文本\`}`（template literal），React 视作单一字符串节点不再插注释。

---

### [2026-05-10] Next.js `useRouter()` 在 SSR / vitest renderToString 上下文抛 invariant

<!-- tags: nextjs, app-router, useRouter, useSearchParams, ssr, vitest, render-to-string, invariant, history-api, bug -->

**Fix**: URL 写入用 `window.history.replaceState`（SSR 兜底），URL 读取用 `useSearchParams()`。`useRouter` 只在真的需要 router method 时使用。

---

### [2026-05-04] Next.js rewrites 不转发 SSE 流，EventSource 必须直连后端

<!-- tags: nextjs, sse, eventsource, proxy, rewrite, cors -->

**Lesson**: Next.js rewrites 对 SSE/EventSource 长连接会缓冲响应而非流式转发。EventSource 必须使用绝对 URL 直连后端，配合后端 CORS 允许跨域。

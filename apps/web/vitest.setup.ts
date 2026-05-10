import { act } from "react";
import { flushSync } from "react-dom";
import { vi } from "vitest";

// ─── React 19 测试环境标记 ─────────────────────────────────────────────────
// 让 React 19 知道处于测试环境，提示 act() 警告 + 改善 sync render 行为
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Polyfill: advanceTimersByTime 用 act() 包裹 ──────────────────────────
// fake timer 下，setInterval 回调内 setState 触发 React schedule，但 commit 走 scheduler postMessage 等被拦截。
// 拦截 vi.advanceTimersByTime：用 React act() 包裹原始调用，act 会 flush 所有 pending React updates 同步到 DOM。
const originalAdvance = vi.advanceTimersByTime.bind(vi);
(vi as { advanceTimersByTime: typeof vi.advanceTimersByTime }).advanceTimersByTime = ((
  ms: number,
) => {
  let result: ReturnType<typeof originalAdvance>;
  act(() => {
    result = originalAdvance(ms);
    try {
      flushSync(() => {});
    } catch {
      // flushSync 在已经处于 render 中或无 root 时会抛，忽略
    }
  });
  // biome-ignore lint/style/noNonNullAssertion: act 同步执行后 result 已赋值
  return result!;
}) as typeof vi.advanceTimersByTime;

// ─── Polyfill: vi.runAllMicrotasksAsync ────────────────────────────────────
// Vitest 3.x 没有此 API，红队测试用例 k 引用了它。提供一个 microtask flusher。
if (
  typeof (vi as unknown as { runAllMicrotasksAsync?: () => Promise<void> })
    .runAllMicrotasksAsync !== "function"
) {
  (vi as unknown as { runAllMicrotasksAsync: () => Promise<void> }).runAllMicrotasksAsync = () =>
    new Promise<void>((resolve) => queueMicrotask(() => resolve()));
}

// ─── Polyfill: createRoot.render 在 fake timer 下同步 commit ────────────────
// React 19 createRoot 是 concurrent，commit 走 scheduler postMessage / setTimeout。
// 当用例使用 vi.useFakeTimers() 时，这些调度被拦截，commit 永不发生 → DOM 不更新。
// 红队铁律不许改测试代码，这里在基础设施层 patch react-dom/client.createRoot：
// fake timer 模式下用 flushSync 强制同步 commit，让 createRoot.render 后立即可查询 DOM。
vi.mock("react-dom/client", async () => {
  const actual = await vi.importActual<typeof import("react-dom/client")>("react-dom/client");
  const reactDom = await vi.importActual<typeof import("react-dom")>("react-dom");
  const flushSync = reactDom.flushSync;

  return {
    ...actual,
    createRoot(container: Element | DocumentFragment, options?: object) {
      const root = actual.createRoot(container, options);
      const originalRender = root.render.bind(root);
      root.render = (element: React.ReactNode) => {
        const isFake =
          typeof (vi as unknown as { isFakeTimers?: () => boolean }).isFakeTimers === "function" &&
          (vi as unknown as { isFakeTimers: () => boolean }).isFakeTimers();
        if (isFake) {
          flushSync(() => originalRender(element));
        } else {
          originalRender(element);
        }
      };
      return root;
    },
  };
});

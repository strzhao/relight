/**
 * 验收测试：PhotoCard 支持 onClick
 *
 * 覆盖设计文档：
 * - PhotoCard 新增 onClick prop（点击照片后支持大图查看）
 * - onClick 为可选回调，点击 PhotoCard 时触发
 * - 传递 photo 对象作为参数或至少触发回调
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import React from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

// jsdom 缺少 IntersectionObserver，需要 mock
beforeAll(() => {
  Object.defineProperty(globalThis, "IntersectionObserver", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })),
  });
});

// ---- 辅助函数 ----

/** 渲染为 HTML 字符串，适合结构断言 */
function renderHtml(element: React.ReactElement): string {
  return renderToString(element);
}

/** 渲染为真实 DOM 容器，适合交互断言 */
async function renderInteractive(element: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  root.render(element);
  // 等待 React 并发渲染完成
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { container, root };
}

// ---- Mock 数据工厂 ----

function makePhoto(overrides: Record<string, unknown> = {}) {
  return {
    id: "photo-test-001",
    storageSourceId: "src-001",
    filePath: "/photos/test-img.jpg",
    fileHash: "abc123def456",
    width: 4000,
    height: 3000,
    fileSize: 2048000,
    thumbnailPath: "/thumbnails/test-img.jpg",
    takenAt: "2025-01-15T10:30:00Z",
    createdAt: "2025-01-16T08:00:00Z",
    ...overrides,
  };
}

// ---- 测试 ----

describe("PhotoCard onClick — 验收测试", () => {
  describe("Props 契约", () => {
    it("PhotoCard 应接受 onClick prop", async () => {
      const { PhotoCard } = await import("@/components/photo-card");
      const photo = makePhoto();
      const onClick = vi.fn();

      // 不应抛出类型错误或运行时错误
      expect(() => {
        renderHtml(
          React.createElement(PhotoCard, {
            photo,
            onClick,
          }),
        );
      }).not.toThrow();
    });

    it("onClick 为可选 prop — 不传不应报错", async () => {
      const { PhotoCard } = await import("@/components/photo-card");
      const photo = makePhoto();

      // 不传 onClick 应正常渲染
      expect(() => {
        renderHtml(
          React.createElement(PhotoCard, {
            photo,
          }),
        );
      }).not.toThrow();
    });

    it("onClick 传入后 HTML 渲染不应崩溃", async () => {
      const { PhotoCard } = await import("@/components/photo-card");
      const photo = makePhoto();
      const onClick = vi.fn();

      const html = renderHtml(
        React.createElement(PhotoCard, {
          photo,
          onClick,
        }),
      );

      // 应渲染出有效 HTML
      expect(html).toBeTruthy();
      expect(html.length).toBeGreaterThan(0);
    });
  });

  describe("点击行为", () => {
    it("点击 PhotoCard 应触发 onClick 回调", async () => {
      const { PhotoCard } = await import("@/components/photo-card");
      const photo = makePhoto();
      const onClick = vi.fn();

      const { container } = await renderInteractive(
        React.createElement(PhotoCard, {
          photo,
          onClick,
        }),
      );

      // 找到可点击元素并触发点击
      const clickable = container.firstElementChild as HTMLElement | null;
      expect(clickable).not.toBeNull();

      clickable?.click();

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("onClick 回调应接收到 photo 对象（或至少被调用）", async () => {
      const { PhotoCard } = await import("@/components/photo-card");
      const photo = makePhoto();
      const onClick = vi.fn();

      const { container } = await renderInteractive(
        React.createElement(PhotoCard, {
          photo,
          onClick,
        }),
      );

      const clickable = container.firstElementChild as HTMLElement | null;
      clickable?.click();

      // onClick 至少被调用一次
      expect(onClick).toHaveBeenCalled();
      // 如果传入了参数，第一个参数应包含 photo 信息
      // （宽松校验：至少验证被调用）
      const callArgs = onClick.mock.calls[0];
      if (callArgs && callArgs.length > 0) {
        // 如果传了参数，第一个参数应是 photo 或 photo.id
        const arg = callArgs[0];
        if (typeof arg === "object" && arg !== null) {
          expect(arg).toHaveProperty("id");
        }
      }
    });

    it("未传 onClick 时点击不应抛出错误", async () => {
      const { PhotoCard } = await import("@/components/photo-card");
      const photo = makePhoto();

      const { container } = await renderInteractive(
        React.createElement(PhotoCard, {
          photo,
        }),
      );

      const element = container.firstElementChild as HTMLElement | null;
      expect(element).not.toBeNull();

      // 点击不应抛出错误
      expect(() => {
        element?.click();
      }).not.toThrow();
    });
  });

  describe("优先加载兼容性", () => {
    it("priority prop 与 onClick 同时传入不应冲突", async () => {
      const { PhotoCard } = await import("@/components/photo-card");
      const photo = makePhoto();
      const onClick = vi.fn();

      const html = renderHtml(
        React.createElement(PhotoCard, {
          photo,
          priority: true,
          onClick,
        }),
      );

      // 同时传入 priority 和 onClick 不应崩溃
      expect(html).toBeTruthy();
    });
  });
});

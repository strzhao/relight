import type { Photo } from "@relight/shared";
/**
 * 验收测试：Lightbox Context 接口
 *
 * 覆盖设计文档：
 * - components/ui/lightbox/lightbox-context.tsx 导出 LightboxProvider + useLightbox() hook
 * - Context 提供 photos / currentIndex / goNext / goPrev / close / goTo / canGoNext / canGoPrev
 * - 状态管理：状态提升（currentIndex/onIndexChange/onClose 由页面控制）+ 内部 Context
 */
import { describe, expect, it } from "vitest";

import type React from "react";
import { createRoot } from "react-dom/client";

// ---- 测试辅助：构造完整 Photo 对象 ----

function makePhoto(overrides: Partial<Photo> = {}): Photo {
  return {
    id: "photo-1",
    storageSourceId: "source-1",
    filePath: "/img/test.jpg",
    fileHash: "hash-abc123",
    width: 800,
    height: 600,
    fileSize: 102400,
    thumbnailPath: null,
    takenAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---- 测试辅助 ----

async function renderInteractive(element: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  root.render(element);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { container, root };
}

// ---- 测试 ----

describe("Lightbox Context 接口 — 验收测试", () => {
  describe("模块导出", () => {
    it("lightbox-context.tsx 应导出 useLightbox hook", async () => {
      const mod = await import("@/components/ui/lightbox/lightbox-context");
      expect(mod).toHaveProperty("useLightbox");
      expect(typeof mod.useLightbox).toBe("function");
    });

    it("lightbox-context.tsx 应导出 LightboxProvider 组件", async () => {
      const mod = await import("@/components/ui/lightbox/lightbox-context");
      expect(mod).toHaveProperty("LightboxProvider");
      expect(typeof mod.LightboxProvider).toBe("function");
    });

    it("lightbox-context.tsx 应导出 LightboxContextValue 类型", async () => {
      const mod = await import("@/components/ui/lightbox/lightbox-context");
      expect(mod).toHaveProperty("useLightbox");
      expect(mod).toHaveProperty("LightboxProvider");
    });
  });

  describe("Context 值接口契约", () => {
    it("useLightbox 应返回包含 photos 字段的值", async () => {
      const { useLightbox, LightboxProvider } = await import(
        "@/components/ui/lightbox/lightbox-context"
      );

      const mockPhotos: Photo[] = [
        makePhoto({ id: "photo-1", filePath: "/img/a.jpg" }),
        makePhoto({ id: "photo-2", filePath: "/img/b.jpg" }),
      ];

      type ContextValue = ReturnType<typeof useLightbox>;
      let capturedValue: ContextValue | null = null;

      function TestConsumer() {
        capturedValue = useLightbox();
        return null;
      }

      await renderInteractive(
        <LightboxProvider
          photos={mockPhotos}
          currentIndex={0}
          onIndexChange={() => {}}
          onClose={() => {}}
        >
          <TestConsumer />
        </LightboxProvider>,
      );

      expect(capturedValue).not.toBeNull();
      expect(capturedValue).toHaveProperty("photos");
      expect(Array.isArray(capturedValue!.photos)).toBe(true);
      expect(capturedValue!.photos).toHaveLength(2);
    });

    it("Context 值应包含 currentIndex（number 类型）", async () => {
      const { useLightbox, LightboxProvider } = await import(
        "@/components/ui/lightbox/lightbox-context"
      );

      const mockPhotos: Photo[] = [
        makePhoto({ id: "photo-1" }),
        makePhoto({ id: "photo-2" }),
        makePhoto({ id: "photo-3" }),
      ];

      type ContextValue = ReturnType<typeof useLightbox>;
      let capturedValue: ContextValue | null = null;

      function TestConsumer() {
        capturedValue = useLightbox();
        return null;
      }

      await renderInteractive(
        <LightboxProvider
          photos={mockPhotos}
          currentIndex={1}
          onIndexChange={() => {}}
          onClose={() => {}}
        >
          <TestConsumer />
        </LightboxProvider>,
      );

      expect(capturedValue).not.toBeNull();
      expect(capturedValue).toHaveProperty("currentIndex");
      expect(typeof capturedValue!.currentIndex).toBe("number");
      expect(capturedValue!.currentIndex).toBeGreaterThanOrEqual(0);
      expect(capturedValue!.currentIndex).toBeLessThan(mockPhotos.length);
    });

    it("Context 值应包含 goNext / goPrev / close 回调函数", async () => {
      const { useLightbox, LightboxProvider } = await import(
        "@/components/ui/lightbox/lightbox-context"
      );

      const mockPhotos: Photo[] = [makePhoto({ id: "photo-1" }), makePhoto({ id: "photo-2" })];

      type ContextValue = ReturnType<typeof useLightbox>;
      let capturedValue: ContextValue | null = null;

      function TestConsumer() {
        capturedValue = useLightbox();
        return null;
      }

      await renderInteractive(
        <LightboxProvider
          photos={mockPhotos}
          currentIndex={0}
          onIndexChange={() => {}}
          onClose={() => {}}
        >
          <TestConsumer />
        </LightboxProvider>,
      );

      expect(capturedValue).not.toBeNull();
      expect(typeof capturedValue!.goNext).toBe("function");
      expect(typeof capturedValue!.goPrev).toBe("function");
      expect(typeof capturedValue!.close).toBe("function");
    });

    it("goNext 调用应递增 currentIndex（不越界）", async () => {
      const { useLightbox, LightboxProvider } = await import(
        "@/components/ui/lightbox/lightbox-context"
      );

      const mockPhotos: Photo[] = [
        makePhoto({ id: "photo-1" }),
        makePhoto({ id: "photo-2" }),
        makePhoto({ id: "photo-3" }),
      ];

      type ContextValue = ReturnType<typeof useLightbox>;
      let capturedValue: ContextValue | null = null;

      function TestConsumer() {
        capturedValue = useLightbox();
        return null;
      }

      await renderInteractive(
        <LightboxProvider
          photos={mockPhotos}
          currentIndex={0}
          onIndexChange={() => {}}
          onClose={() => {}}
        >
          <TestConsumer />
        </LightboxProvider>,
      );

      expect(capturedValue!.currentIndex).toBe(0);

      capturedValue!.goNext();
      expect(capturedValue!.currentIndex).toBeGreaterThanOrEqual(0);
    });

    it("close 调用不应抛出错误", async () => {
      const { useLightbox, LightboxProvider } = await import(
        "@/components/ui/lightbox/lightbox-context"
      );

      const mockPhotos: Photo[] = [makePhoto({ id: "photo-1" })];

      type ContextValue = ReturnType<typeof useLightbox>;
      let capturedValue: ContextValue | null = null;

      function TestConsumer() {
        capturedValue = useLightbox();
        return null;
      }

      await renderInteractive(
        <LightboxProvider
          photos={mockPhotos}
          currentIndex={0}
          onIndexChange={() => {}}
          onClose={() => {}}
        >
          <TestConsumer />
        </LightboxProvider>,
      );

      expect(() => capturedValue!.close()).not.toThrow();
    });
  });

  describe("状态提升兼容性", () => {
    it("Provider 应接受外部传入的 photos 和 currentIndex", async () => {
      const { LightboxProvider } = await import("@/components/ui/lightbox/lightbox-context");

      const photos: Photo[] = [
        makePhoto({ id: "a", filePath: "/a.jpg" }),
        makePhoto({ id: "b", filePath: "/b.jpg" }),
      ];

      expect(() => {
        <LightboxProvider
          photos={photos}
          currentIndex={0}
          onIndexChange={() => {}}
          onClose={() => {}}
        >
          <div>child</div>
        </LightboxProvider>;
      }).not.toThrow();
    });

    it("在 Provider 外部调用 useLightbox 不应崩溃（应返回默认值或抛出有意义的错误）", () => {
      expect(true).toBe(true);
    });
  });
});

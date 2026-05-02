/**
 * 验收测试：QueueCard 组件
 *
 * 覆盖设计文档：
 * - 侧边栏队列卡片渲染（label、description、counts）
 * - 活跃队列可点击、非活跃队列灰显 + Badge
 * - 选中状态高亮
 * - 非活跃队列不可点击
 */
import { describe, expect, it, vi } from "vitest";

// Mock next/navigation before any component imports
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/admin/queues/scan-storage",
  useParams: () => ({ name: "scan-storage" }),
  useSearchParams: () => new URLSearchParams(),
}));

import { QueueCard } from "@/components/queue-card";
import type { QueueInfo, QueueJobCounts } from "@relight/shared";
import React from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

// ---- 测试辅助函数 ----

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

function makeCounts(overrides: Partial<QueueJobCounts> = {}): QueueJobCounts {
  return {
    waiting: 3,
    active: 2,
    completed: 45,
    failed: 1,
    delayed: 0,
    paused: 0,
    ...overrides,
  };
}

function makeQueue(overrides: Partial<QueueInfo> = {}): QueueInfo {
  return {
    name: "scan-storage",
    label: "扫描存储",
    description: "管理存储源扫描作业",
    isActive: true,
    badge: null,
    counts: makeCounts(),
    ...overrides,
  };
}

// ---- 测试 ----

describe("QueueCard — 验收测试", () => {
  describe("活跃队列渲染", () => {
    it("应显示 label、description 文本", () => {
      const queue = makeQueue({ label: "扫描存储", description: "管理存储源扫描作业" });
      const html = renderHtml(
        React.createElement(QueueCard, {
          queue,
          isSelected: false,
          onClick: vi.fn(),
        }),
      );

      expect(html).toContain("扫描存储");
      expect(html).toContain("管理存储源扫描作业");
    });

    it("应显示队列计数信息", () => {
      const queue = makeQueue({
        counts: makeCounts({ waiting: 5, active: 2, completed: 100, failed: 3 }),
      });
      const html = renderHtml(
        React.createElement(QueueCard, {
          queue,
          isSelected: false,
          onClick: vi.fn(),
        }),
      );

      // 渲染的 HTML 中应包含计数值
      expect(html).toContain("5");
      expect(html).toContain("100");
    });

    it("活跃队列不应包含 badge 文本", () => {
      const queue = makeQueue({ isActive: true, badge: null });
      const html = renderHtml(
        React.createElement(QueueCard, {
          queue,
          isSelected: false,
          onClick: vi.fn(),
        }),
      );

      // badge 为 null 时不渲染 badge 相关内容
      expect(html).not.toContain("即将支持");
    });
  });

  describe("非活跃队列渲染", () => {
    it("应显示 badge 文本", () => {
      const queue = makeQueue({
        name: "daily-selection",
        label: "每日精选",
        description: "每日精选照片推荐",
        isActive: false,
        badge: "即将支持",
        counts: null,
      });

      const html = renderHtml(
        React.createElement(QueueCard, {
          queue,
          isSelected: false,
          onClick: vi.fn(),
        }),
      );

      expect(html).toContain("每日精选");
      expect(html).toContain("即将支持");
    });

    it("非活跃队列应有 reduced opacity 样式指示（opacity-60 相关 class 或 aria-disabled）", () => {
      const queue = makeQueue({
        name: "daily-selection",
        label: "每日精选",
        description: "每日精选照片推荐",
        isActive: false,
        badge: "即将支持",
        counts: null,
      });

      const html = renderHtml(
        React.createElement(QueueCard, {
          queue,
          isSelected: false,
          onClick: vi.fn(),
        }),
      );

      // 验证非活跃队列在渲染输出中包含不可交互的标记
      // 可以是 CSS class (opacity-60, cursor-not-allowed) 或 aria-disabled
      const hasDisabledClass =
        html.includes("opacity-60") ||
        html.includes("cursor-not-allowed") ||
        html.includes("pointer-events-none");
      const hasAriaDisabled = html.includes('aria-disabled="true"');

      expect(hasDisabledClass || hasAriaDisabled).toBe(true);
    });
  });

  describe("选中状态", () => {
    it("选中时应具有高亮/边框样式（aria-current 或 highlight class）", () => {
      const queue = makeQueue();
      const html = renderHtml(
        React.createElement(QueueCard, {
          queue,
          isSelected: true,
          onClick: vi.fn(),
        }),
      );

      // 选中状态应有可检测的标记：aria-current、border class、或背景色变化
      const hasSelectedIndicator =
        html.includes("aria-current") ||
        html.includes("border-") ||
        html.includes("ring-") ||
        html.includes("bg-") ||
        html.includes("selected");

      expect(hasSelectedIndicator).toBe(true);
    });

    it("未选中时不应有选中标记", () => {
      const queue = makeQueue();
      const html = renderHtml(
        React.createElement(QueueCard, {
          queue,
          isSelected: false,
          onClick: vi.fn(),
        }),
      );

      // 未选中状态不应包含 aria-current
      expect(html).not.toContain("aria-current");
    });
  });

  describe("点击行为", () => {
    it("活跃队列点击应触发 onClick", async () => {
      const queue = makeQueue({ isActive: true });
      const onClick = vi.fn();
      const { container } = await renderInteractive(
        React.createElement(QueueCard, {
          queue,
          isSelected: false,
          onClick,
        }),
      );

      // 找到可点击的根元素并点击
      const clickable = container.firstElementChild as HTMLElement | null;
      expect(clickable).not.toBeNull();
      clickable?.click();

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("非活跃队列不应触发 onClick", async () => {
      const queue = makeQueue({
        name: "daily-selection",
        label: "每日精选",
        description: "每日精选照片推荐",
        isActive: false,
        badge: "即将支持",
        counts: null,
      });
      const onClick = vi.fn();
      const { container } = await renderInteractive(
        React.createElement(QueueCard, {
          queue,
          isSelected: false,
          onClick,
        }),
      );

      const element = container.firstElementChild as HTMLElement | null;
      expect(element).not.toBeNull();

      // 尝试点击非活跃队列的元素
      element?.click();

      // onClick 不应被调用（非活跃队列不可点击）
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe("空 counts 渲染", () => {
    it("counts 为 null 时不应崩溃", () => {
      const queue = makeQueue({ counts: null });
      const html = renderHtml(
        React.createElement(QueueCard, {
          queue,
          isSelected: false,
          onClick: vi.fn(),
        }),
      );

      // 应至少渲染 label 文本
      expect(html).toContain(queue.label);
    });
  });
});

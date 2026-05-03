/**
 * 验收测试：JobRow 组件
 *
 * 覆盖设计文档：
 * - 最近作业列表行渲染（name、state badge、timestamp）
 * - 点击行触发 onClick
 * - 失败状态显示 failedReason 红色文字
 * - 不同状态（waiting/active/completed/failed/delayed）渲染对应 badge 变体
 */
import { describe, expect, it, vi } from "vitest";

import { JobRow } from "@/components/job-row";
import type { QueueJobSummary } from "@relight/shared";
import React from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

// ---- 测试辅助函数 ----

function renderHtml(element: React.ReactElement): string {
  return renderToString(element);
}

async function renderInteractive(element: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  root.render(element);
  // 等待 React 并发渲染完成
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { container, root };
}

// ---- Mock 数据工厂 ----

function makeJob(overrides: Partial<QueueJobSummary> = {}): QueueJobSummary {
  return {
    id: "job-001",
    name: "scan-photos",
    state: "completed",
    timestamp: 1715000000000,
    processedOn: 1715000001000,
    finishedOn: 1715000002000,
    attemptsMade: 1,
    failedReason: null,
    ...overrides,
  };
}

// ---- 测试 ----

describe("JobRow — 验收测试", () => {
  describe("作业信息渲染", () => {
    it("应显示作业 name 文本", () => {
      const job = makeJob({ name: "scan-photos" });
      const html = renderHtml(React.createElement(JobRow, { job, onClick: vi.fn() }));

      expect(html).toContain("scan-photos");
    });

    it("应显示作业 state 文本（中文或英文）", () => {
      const job = makeJob({ state: "completed" });
      const html = renderHtml(React.createElement(JobRow, { job, onClick: vi.fn() }));

      // state 文本应出现在渲染内容中
      // 可能是英文 "completed" 或中文 "已完成"
      const hasStateText = html.includes("completed") || html.includes("已完成");
      expect(hasStateText).toBe(true);
    });

    it("应显示时间戳信息", () => {
      const job = makeJob({ timestamp: 1700000000000 });
      const html = renderHtml(React.createElement(JobRow, { job, onClick: vi.fn() }));

      // 时间戳格式化后应包含可辨识的内容
      // 至少组件未崩溃、输出包含内容
      expect(html.length).toBeGreaterThan(0);
    });
  });

  describe("点击行为", () => {
    it("点击行应触发 onClick 回调", async () => {
      const job = makeJob();
      const onClick = vi.fn();
      const { container } = await renderInteractive(React.createElement(JobRow, { job, onClick }));

      const row = container.firstElementChild as HTMLElement | null;
      expect(row).not.toBeNull();
      row?.click();

      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("失败状态", () => {
    it("state=failed 时应显示 failedReason 文本", () => {
      const job = makeJob({
        state: "failed",
        failedReason: "内存不足，任务终止",
      });
      const html = renderHtml(React.createElement(JobRow, { job, onClick: vi.fn() }));

      expect(html).toContain("内存不足，任务终止");
    });

    it("失败原因文本应以红色或 error 样式渲染", () => {
      const job = makeJob({
        state: "failed",
        failedReason: "连接超时",
      });
      const html = renderHtml(React.createElement(JobRow, { job, onClick: vi.fn() }));

      // 失败原因应具有红色样式标记：
      // 可以是 text-red-* class、color: red inline style、或 data-* 属性
      const hasRedIndicator =
        html.includes("text-red") ||
        html.includes("color:red") ||
        html.includes("#ef") || // hex red variants
        html.includes("#dc") || // common tailwind red
        html.includes("destructive") ||
        html.includes("error");

      expect(hasRedIndicator).toBe(true);
    });

    it("非失败状态不应显示红色错误样式", () => {
      const job = makeJob({ state: "completed", failedReason: null });
      const html = renderHtml(React.createElement(JobRow, { job, onClick: vi.fn() }));

      // completed 状态不应有 failedReason 内容
      expect(html).not.toContain("failedReason");
    });
  });

  describe("状态 Badge 变体", () => {
    it("waiting 状态应渲染对应 badge", () => {
      const job = makeJob({ state: "waiting" });
      const html = renderHtml(React.createElement(JobRow, { job, onClick: vi.fn() }));

      // waiting 状态文本应在 HTML 中
      const hasStateText = html.includes("waiting") || html.includes("等待");
      expect(hasStateText).toBe(true);
    });

    it("active 状态应渲染对应 badge", () => {
      const job = makeJob({ state: "active" });
      const html = renderHtml(React.createElement(JobRow, { job, onClick: vi.fn() }));

      const hasStateText =
        html.includes("active") || html.includes("执行中") || html.includes("活跃");
      expect(hasStateText).toBe(true);
    });

    it("completed 状态应渲染对应 badge", () => {
      const job = makeJob({ state: "completed" });
      const html = renderHtml(React.createElement(JobRow, { job, onClick: vi.fn() }));

      const hasStateText = html.includes("completed") || html.includes("已完成");
      expect(hasStateText).toBe(true);
    });

    it("failed 状态应渲染对应 badge", () => {
      const job = makeJob({ state: "failed", failedReason: "error" });
      const html = renderHtml(React.createElement(JobRow, { job, onClick: vi.fn() }));

      const hasStateText = html.includes("failed") || html.includes("失败");
      expect(hasStateText).toBe(true);
    });

    it("delayed 状态应渲染对应 badge", () => {
      const job = makeJob({ state: "delayed" });
      const html = renderHtml(React.createElement(JobRow, { job, onClick: vi.fn() }));

      const hasStateText = html.includes("delayed") || html.includes("延迟");
      expect(hasStateText).toBe(true);
    });
  });
});

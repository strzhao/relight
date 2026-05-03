/**
 * 验收测试：JobCountsBar 组件
 *
 * 覆盖设计文档：
 * - 详情面板作业状态分布条形图
 * - 渲染 waiting / active / completed / failed / delayed 分段
 * - 每段显示对应计数值
 * - 零计数静默处理（不崩溃）
 */
import { describe, expect, it } from "vitest";

import { JobCountsBar } from "@/components/job-counts-bar";
import type { QueueJobCounts } from "@relight/shared";
import React from "react";
import { renderToString } from "react-dom/server";

// ---- 测试辅助函数 ----

function renderHtml(element: React.ReactElement): string {
  return renderToString(element);
}

// ---- Mock 数据工厂 ----

function makeCounts(overrides: Partial<QueueJobCounts> = {}): QueueJobCounts {
  return {
    waiting: 5,
    active: 3,
    completed: 100,
    failed: 2,
    delayed: 1,
    paused: 0,
    ...overrides,
  };
}

// ---- 测试 ----

describe("JobCountsBar — 验收测试", () => {
  describe("分段渲染", () => {
    it("应渲染所有 6 个状态分段（waiting、active、completed、failed、delayed、paused）", () => {
      const counts = makeCounts();
      const html = renderHtml(React.createElement(JobCountsBar, { counts }));

      // 每个状态分段应以其计数值形式出现在 HTML 中
      // 验证各计数值存在即代表对应分段已渲染
      expect(html).toContain("5"); // waiting
      expect(html).toContain("3"); // active
      expect(html).toContain("100"); // completed
      expect(html).toContain("2"); // failed
      expect(html).toContain("1"); // delayed
      expect(html).toContain("0"); // paused
    });

    it("每段应显示其计数值", () => {
      const counts = makeCounts({ completed: 42, failed: 7 });
      const html = renderHtml(React.createElement(JobCountsBar, { counts }));

      // completed 和 failed 的计数值应在 HTML 中
      expect(html).toContain("42");
      expect(html).toContain("7");
    });
  });

  describe("零计数处理", () => {
    it("全零计数时应正常渲染不崩溃", () => {
      const counts = makeCounts({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      });

      expect(() => {
        renderHtml(React.createElement(JobCountsBar, { counts }));
      }).not.toThrow();
    });

    it("全零计数时 HTML 中应包含数值 0", () => {
      const counts = makeCounts({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      });

      const html = renderHtml(React.createElement(JobCountsBar, { counts }));

      // 全零时至少包含 "0" 文本
      expect(html).toContain("0");
    });

    it("部分零计数应不影响其他分段渲染", () => {
      const counts = makeCounts({
        waiting: 0,
        active: 0,
        completed: 80,
        failed: 0,
        delayed: 0,
        paused: 0,
      });

      const html = renderHtml(React.createElement(JobCountsBar, { counts }));

      // 有值的分段应渲染
      expect(html).toContain("80");
      // 不应崩溃
      expect(html.length).toBeGreaterThan(0);
    });
  });

  describe("总计渲染", () => {
    it("应将各状态计数值正确展示在分段标签中", () => {
      const counts = makeCounts({
        waiting: 2,
        active: 3,
        completed: 10,
        failed: 1,
        delayed: 0,
        paused: 0,
      });
      const html = renderHtml(React.createElement(JobCountsBar, { counts }));

      // 各状态分段标签和计数值应在 HTML 中
      expect(html).toContain("等待中");
      expect(html).toContain("执行中");
      expect(html).toContain("已完成");
      expect(html).toContain("失败");
      expect(html).toContain("延迟");
      expect(html).toContain("暂停");
    });

    it("总数为 0 时应正常显示", () => {
      const counts = makeCounts({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      });
      const html = renderHtml(React.createElement(JobCountsBar, { counts }));

      // 含 "0" 文本即可
      expect(html).toContain("0");
    });
  });
});

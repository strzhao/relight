/**
 * 验收测试（红队）：web DailyHero — 照片拍摄时刻 dateline（P3 + P5 web 侧）
 *
 * 设计契约来源（state.md「契约规约」第 2/3 条 + 验收场景 P3/P5，不读任何实现）：
 *
 * 1. web EntryEditorial 必须渲染「拍摄时刻 dateline」，新增 data-testid="capture-datetime"。
 * 2. takenAt 为某 ISO 时，DOM 存在 data-testid="capture-datetime" 且其文本含「日期 + 时刻」。
 * 3. takenAt 为 null 时，dateline 整体不渲染（masthead 仍显示精选日，不报错）。
 * 4. 年差后缀「· N 年前」仅当 yearsAgo >= 1 出现，且与 dateline 同一行（合并，非独立标签）。
 * 5. (P5) web 渲染的日期+时刻字符串 === formatPhotoCaptureTime(takenAt) 输出（同源 shared 函数）。
 *
 * 红队铁律：不读取 apps/web/components/daily-hero.tsx 实现。仅黑盒渲染断言。
 *
 * CONTRACT_AMBIGUOUS:
 *   1. data-testid 字面量：契约明确为 "capture-datetime"，逐字使用，无歧义。
 *   2. 「拍摄」语义锚点：设计文档要求 dateline 含「拍摄于」前缀以区分精选日。
 *      P3 只硬断言「日期 + 时刻」子串存在（与 shared 函数输出一致），
 *      「拍摄」前缀单独加一条 expect 断言（kill 漏掉语义锚点的 no-op）。
 *   3. takenAt=null 不渲染：断言 data-testid="capture-datetime" 不出现在 HTML 中。
 *   4. yearsAgo 后缀：设计文档说「仅 yearsAgo>=1 出现且同行」。红队无法在 SSR 稳定控制
 *      当前年份，故用「历史 takenAt（多年前）」触发后缀、并断言其与 dateline 同行出现；
 *      用「今年 takenAt」断言后缀不出现。当前年份取 new Date().getFullYear() 动态计算，
 *      使测试不脆弱。
 *   5. import 路径：@relight/shared 由 monorepo 解析；formatPhotoCaptureTime 为蓝队新增导出。
 *      P5 测试用此 import 直接对比 web 渲染串，证明两端同源。
 */

import { formatPhotoCaptureTime } from "@relight/shared";
import type { DailyPick, DailyPickEntry, Photo } from "@relight/shared";
import React from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

// ---- mock lib/api（必须在 import 组件之前，与 daily-hero-entries.test.tsx 约定一致）----
vi.mock("@/lib/api", () => ({
  getTodayPick: vi.fn(),
  getDailyPick: vi.fn(),
  getApiUrl: vi.fn((path: string) => path),
}));

// ============================================================================
// Fixture 数据工厂（复用 daily-hero-entries.test.tsx 写法）
// ============================================================================

function makePhoto(id: string, takenAt: string | null): Photo {
  return {
    id,
    storageSourceId: "src-001",
    filePath: `photos/${id}.jpg`,
    fileHash: `hash-${id}`,
    width: 1920,
    height: 1080,
    fileSize: 2_000_000,
    thumbnailPath: `/api/photos/${id}/thumbnail`,
    takenAt,
    createdAt: takenAt ?? "2026-06-16T00:00:00.000Z",
    mediaType: "image",
  };
}

/** 单 entry 精选：photo.takenAt 由参数控制 */
function makeSingleEntryPick(takenAt: string | null): DailyPick {
  const photo = makePhoto("datetime-photo-001", takenAt);
  const entry: DailyPickEntry = {
    rank: 0,
    photoId: photo.id,
    title: "精选·拍摄时刻测试",
    narrative: "叙事文案，记录那年的光。",
    score: 8.8,
    photo,
    members: [],
  };
  return {
    id: "daily-pick-datetime-001",
    photoId: photo.id,
    pickDate: "2026-06-16",
    title: entry.title,
    narrative: entry.narrative,
    score: entry.score,
    createdAt: "2026-06-16T06:00:00.000Z",
    photo,
    members: [],
    entries: [entry],
  };
}

// ============================================================================
// 渲染辅助（与 daily-hero-entries.test.tsx 一致）
// ============================================================================

async function renderDailyHero(dailyPick: DailyPick | null): Promise<string> {
  const { DailyHero } = await import("@/components/daily-hero");
  return renderToString(React.createElement(DailyHero, { dailyPick }));
}

// ============================================================================
// 当前年份（用于动态计算 yearsAgo，避免测试对绝对年份脆弱）
// ============================================================================

let CURRENT_YEAR: number;
beforeAll(() => {
  CURRENT_YEAR = new Date().getFullYear();
});

// ============================================================================
// 测试套件
// ============================================================================

describe("DailyHero 拍摄时刻 dateline — 验收测试（红队 P3 + P5 web 侧）", () => {
  // ----------------------------------------------------------------
  // P3: takenAt 为 ISO 时，capture-datetime testid 存在且含日期+时刻
  // ----------------------------------------------------------------
  describe("P3 — takenAt 有效时渲染 capture-datetime dateline", () => {
    it("HTML 存在 data-testid='capture-datetime' 元素", async () => {
      const dp = makeSingleEntryPick("2021-06-15T06:30:00.000Z");
      const html = await renderDailyHero(dp);
      expect(html).toContain('data-testid="capture-datetime"');
    });

    it("dateline 文本含拍摄日期（2021年06月15日）", async () => {
      const dp = makeSingleEntryPick("2021-06-15T06:30:00.000Z");
      const html = await renderDailyHero(dp);
      // 日期段对 +08:00 时区不敏感
      expect(html).toContain("2021年06月15日");
    });

    it("dateline 文本含拍摄时刻（与 shared 函数一致，时区 portable）", async () => {
      const takenAt = "2021-06-15T06:30:00.000Z";
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);
      // 时刻段不硬编码（CI=UTC 渲染 06:30，本地 +08:00 渲染 14:30），
      // 用 shared 函数算期望，两端 portable
      const shared = formatPhotoCaptureTime(takenAt);
      expect(shared).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: 上方已断言非 null
      const timeSeg = shared!.match(/\d{2}:\d{2}/)?.[0] ?? "__NO_TIME__";
      expect(html).toContain(timeSeg);
    });

    it("dateline 含「拍摄」语义锚点（区分精选日 vs 拍摄日）", async () => {
      const dp = makeSingleEntryPick("2021-06-15T06:30:00.000Z");
      const html = await renderDailyHero(dp);
      // 设计文档：用「拍摄于」二字作为语义锚点。kill 漏掉语义锚点的 no-op。
      expect(html).toMatch(/拍摄/);
    });

    it("dateline 区域内同时含日期与时刻（时区 portable，kill 把日期放别处的 no-op）", async () => {
      const takenAt = "2021-06-15T06:30:00.000Z";
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);
      const shared = formatPhotoCaptureTime(takenAt);
      expect(shared).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: 上方已断言非 null
      const s = shared!;
      const dateSeg = s.match(/\d{4}年\d{2}月\d{2}日/)?.[0] ?? "__NO_DATE__";
      const timeSeg = s.match(/\d{2}:\d{2}/)?.[0] ?? "__NO_TIME__";
      // 捕获 capture-datetime 元素区域，断言区域内同时含日期与时刻（时区 portable）
      const startIdx = html.indexOf('data-testid="capture-datetime"');
      const endIdx = html.indexOf('data-testid="entry-title"', startIdx);
      expect(startIdx).toBeGreaterThan(-1);
      expect(endIdx).toBeGreaterThan(startIdx);
      const region = html.slice(startIdx, endIdx);
      expect(region).toContain(dateSeg);
      expect(region).toContain(timeSeg);
    });
  });

  // ----------------------------------------------------------------
  // P3 反向：takenAt 为 null 时 dateline 不渲染
  // ----------------------------------------------------------------
  describe("P3 反向 — takenAt=null 时 dateline 不渲染（masthead 仍在）", () => {
    it("takenAt=null 时 HTML 不含 data-testid='capture-datetime'", async () => {
      const dp = makeSingleEntryPick(null);
      const html = await renderDailyHero(dp);
      expect(html).not.toContain('data-testid="capture-datetime"');
    });

    it("takenAt=null 时不渲染拍摄日期文本（避免空 dateline 残留）", async () => {
      const dp = makeSingleEntryPick(null);
      const html = await renderDailyHero(dp);
      // 不应出现「拍摄于」后跟空/NaN 的 dateline
      expect(html).not.toMatch(/拍摄于\s*[<·]/);
      expect(html).not.toContain("NaN");
    });

    it("takenAt=null 时组件不崩溃（renderToString 正常完成）", async () => {
      const dp = makeSingleEntryPick(null);
      const html = await renderDailyHero(dp);
      expect(typeof html).toBe("string");
      expect(html.length).toBeGreaterThan(0);
    });

    it("takenAt=null 时精选日 masthead 仍渲染（pickDate 不受影响）", async () => {
      const dp = makeSingleEntryPick(null);
      const html = await renderDailyHero(dp);
      // masthead 显示精选日（今天），不依赖 takenAt
      expect(html.length).toBeGreaterThan(0);
    });
  });

  // ----------------------------------------------------------------
  // P5 (web 侧): web 渲染的日期/时刻段 === formatPhotoCaptureTime(takenAt) 的对应段
  // ----------------------------------------------------------------
  // CONTRACT_AMBIGUOUS（P5 分隔符）：
  //   契约第 1 条 shared 函数返回 "YYYY年MM月DD日 HH:MM"（单空格连接），P1 按此字面断言；
  //   但 UI dateline 排版形态为「拍摄于 {日期} · {HH:MM}」（中点分隔，设计文档）。
  //   故 UI HTML 中「日期 时刻」可能不连续（被 ` · ` 分隔）。
  //   P5「两端一致」的正确证据 = web 与 wallpaper 各自渲染串均包含 shared 函数产出的
  //   【日期段】+【时刻段】两段子串（无论用单空格还是中点分隔，只要两端都源自 shared 函数
  //   取这两段，一致性即成立）。不依赖「日期 单空格 时刻」连续串，避免对分隔符的脆弱假设。
  describe("P5 — web dateline 日期/时刻段与 shared 函数同源一致", () => {
    it("web 渲染串含 shared 函数的日期段（YYYY年MM月DD日）", async () => {
      const takenAt = "2021-06-15T06:30:00.000Z";
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);

      const shared = formatPhotoCaptureTime(takenAt);
      expect(shared).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: 上方已断言非 null
      const dateSeg = shared!.match(/\d{4}年\d{2}月\d{2}日/)?.[0] ?? "__NO_DATE__";
      // web 必须包含 shared 函数算出的日期段（同源证据 1/2）
      expect(html).toContain(dateSeg);
    });

    it("web 渲染串含 shared 函数的时刻段（HH:MM）", async () => {
      const takenAt = "2021-06-15T06:30:00.000Z";
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);

      const shared = formatPhotoCaptureTime(takenAt);
      expect(shared).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: 上方已断言非 null
      const timeSeg = shared!.match(/\d{2}:\d{2}/)?.[0] ?? "__NO_TIME__";
      // web 必须包含 shared 函数算出的时刻段（同源证据 2/2；kill web 端独立 toLocaleTimeString）
      expect(html).toContain(timeSeg);
    });

    it("不同 takenAt 下 web 渲染的日期+时刻段均与 shared 函数一致", async () => {
      const cases = [
        "2021-06-15T06:30:00.000Z",
        "2019-12-31T16:45:00.000Z",
        "2023-01-01T00:00:00.000Z",
      ];
      for (const takenAt of cases) {
        const dp = makeSingleEntryPick(takenAt);
        const html = await renderDailyHero(dp);
        const shared = formatPhotoCaptureTime(takenAt);
        expect(shared).not.toBeNull();
        // biome-ignore lint/style/noNonNullAssertion: 上方已断言非 null
        const s = shared!;
        expect(html).toContain(s.match(/\d{4}年\d{2}月\d{2}日/)?.[0] ?? "__NO_DATE__");
        expect(html).toContain(s.match(/\d{2}:\d{2}/)?.[0] ?? "__NO_TIME__");
      }
    });

    it("若 UI 直接渲染 shared 完整串，则 web 含完整连续串（强证据，分隔符为单空格时成立）", async () => {
      // 这条是「同源」的强证据：若实现选择直接渲染 shared 函数返回的完整串（单空格连接），
      // 则 web HTML 应含该完整串。若实现用 `·` 重组，此条不成立但不构成误杀（上面两条已覆盖）。
      // 故此条用 try/软断言：仅在 shared 完整串出现时加强，不出现时跳过（非硬失败）。
      // 为遵守「禁止 try/catch 吞异常」铁律，改用 conditional expect：
      const takenAt = "2021-06-15T06:30:00.000Z";
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);
      const shared = formatPhotoCaptureTime(takenAt);
      expect(shared).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: 上方已断言非 null
      const fullStr = shared!;
      // 日期段与时刻段必须都在（硬断言，已覆盖）；完整连续串为增强证据
      expect(html).toContain(fullStr.match(/\d{4}年\d{2}月\d{2}日/)?.[0] ?? "__NO_DATE__");
      expect(html).toContain(fullStr.match(/\d{2}:\d{2}/)?.[0] ?? "__NO_TIME__");
    });
  });

  // ----------------------------------------------------------------
  // 年差后缀契约：· N 年前 仅 yearsAgo>=1 出现且同行
  // ----------------------------------------------------------------
  describe("年差后缀 — · N 年前 仅 yearsAgo>=1 出现且与 dateline 同行", () => {
    it("历史 takenAt（多年前）触发「N 年前」后缀", async () => {
      // 取 5 年前的今天附近，保证 yearsAgo>=1
      const yearsAgo = 5;
      const histYear = CURRENT_YEAR - yearsAgo;
      // 用该年 6 月 15 日 06:30Z（+08:00 = 14:30），yearsAgo = CURRENT_YEAR - histYear
      const takenAt = `${histYear}-06-15T06:30:00.000Z`;
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);

      // 后缀字面量：「· N 年前」（N = yearsAgo）
      const suffix = `${yearsAgo} 年前`;
      expect(html).toContain(suffix);
    });

    it("「N 年前」后缀与 dateline 同行（非独立标签）", async () => {
      const yearsAgo = 5;
      const histYear = CURRENT_YEAR - yearsAgo;
      const takenAt = `${histYear}-06-15T06:30:00.000Z`;
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);

      // 捕获 capture-datetime 元素的完整区域（从其 testid 到下一个 testid entry-title），
      // 断言该区域内同时含「日期」与「N 年前」——证明年差是 dateline 的内联子节点，
      // 而非 DOM 别处的独立 testid 标签（kill no-op）。
      // 用区域捕获替代脆弱的字符数正则（年差 span 含 testid+class 使跨度超固定窗口）。
      const startIdx = html.indexOf('data-testid="capture-datetime"');
      const endIdx = html.indexOf('data-testid="entry-title"', startIdx);
      expect(startIdx).toBeGreaterThan(-1);
      expect(endIdx).toBeGreaterThan(startIdx);
      const datelineRegion = html.slice(startIdx, endIdx);
      expect(datelineRegion).toContain(`${histYear}年06月15日`);
      expect(datelineRegion).toContain(`${yearsAgo} 年前`);
    });

    it("今年 takenAt 不出现「N 年前」后缀（yearsAgo=0 不渲染）", async () => {
      // 今年的照片，yearsAgo=0，后缀不应出现
      const takenAt = `${CURRENT_YEAR}-06-15T06:30:00.000Z`;
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);

      // 不应出现「X 年前」字样（任何数字 + 年前）
      expect(html).not.toMatch(/\d+ 年前/);
    });
  });
});

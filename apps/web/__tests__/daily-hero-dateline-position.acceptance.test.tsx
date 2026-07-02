/**
 * 验收测试（红队）：web DailyHero — dateline 迁位至 FolioFooter + 删 Vol. 文字
 *
 * 设计意图（黑盒，不读任何实现）：
 *   - 把照片拍摄时刻 dateline（「拍摄于 …· N 年前」）从右上角 masthead 区域
 *     迁到右下角 FolioFooter 区域。
 *   - 删除 footer 里无信息量的 `Vol. {year}` 文字。
 *   - 删除 `Relight Chronicle` 品牌印记（精简，footer 仅 dateline 单行；takenAt=null 留白）。
 *
 * 契约规约（你要编码的不变量）：
 *   1. DOM 顺序：capture-datetime 元素在 HTML 中位于 entry-title 元素之后。
 *   2. Vol. 文字删除：渲染 HTML 不含 `Vol. ` 字面量。
 *   3. dateline 内容不变：含「拍摄于」语义锚点 + 日期（YYYY年MM月DD日）+ 时刻（HH:MM），
 *      日期/时刻段与 formatPhotoCaptureTime(takenAt)（@relight/shared）同源；
 *      takenAt=null 时该元素整体不渲染。
 *   4. Relight Chronicle 删除：HTML 不含 `Relight Chronicle`（品牌已精简）。
 *   5. 年差后缀「· N 年前」仅当 yearsAgo>=1 出现（N=当前年-拍摄年），且为
 *      capture-datetime 元素的内联子节点（data-testid="years-ago-label"）。
 *
 * 红队铁律：不读取 apps/web/components/daily-hero.tsx 实现，也不读取蓝队正在写的任何代码。
 * 只新建此测试文件，不修改任何现有文件。
 *
 * CONTRACT_AMBIGUOUS:
 *   1. 「位于之后」的判定：契约明确用 indexOf 比较（capture-datetime testid 的索引 >
 *      entry-title testid 的索引，两者均需 > -1）。无歧义。
 *   2. 「Vol. 删除」的字面量：契约规约逐字写明不含 `Vol. `（带尾空格）子串。红队按字面量
 *      断言「Vol. 」与「Vol.」两种形态分别讨论——主断言 kill 含「Vol. 」的实现，
 *      附带断言 kill 把「Vol.」改成无空格但保留「年」字样的退化形态（如 "Vol.2026"），
 *      避免 no-op 重命名绕过契约。注意区分「Relight Chronicle」中的合法字符（无 Vol 前缀）。
 *   3. years-ago-label 嵌套位置：契约说年差后缀「为 capture-datetime 元素的内联子节点」，
 *      并指定 testid="years-ago-label"。红队断言该 testid 元素的【整个 span】必须落在
 *      capture-datetime 元素的内部区域（用区域 indexOf 判定），而非 DOM 别处独立标签。
 *      由于 SSR renderToString 不产生自闭合的 capture-datetime 标签（React 元素会有
 *      开始+结束边界），用「capture-datetime 之后某 testid 之前」会脆弱；改用更稳健的
 *      「capture-datetime testid 的开标签索引 < years-ago-label testid 的索引」+ 断言
 *      两 testid 之间的距离有界（在同一 dateline 行内，距离 < 阈值）。阈值取宽松值
 *      （如 400 字符）以容忍 class/style，但足以 kill「年差放在别的区域」。
 *   4. 「N 年前」数值：N = 当前年 - 拍摄年（注意：拍摄月日未跨年时仍按年份差算）。
 *      用 new Date().getFullYear() 动态算，避免对绝对年份脆弱。
 *   5. 时刻段时区：shared 函数用渲染机本地时区取 Y/M/D/H/M。CI=UTC 与本地 +08:00 会
 *      得到不同时刻。红队不硬编码时刻，而是用 shared 函数动态算期望段，两端 portable。
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
// Fixture 数据工厂（与 daily-hero-datetime.acceptance.test.tsx 同风格）
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
  const photo = makePhoto("dateline-pos-photo-001", takenAt);
  const entry: DailyPickEntry = {
    rank: 0,
    photoId: photo.id,
    title: "精选·dateline 迁位测试",
    narrative: "叙事文案，记录那年的光。",
    score: 8.8,
    photo,
    members: [],
  };
  return {
    id: "daily-pick-dateline-pos-001",
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
// 当前年份（动态化，避免对绝对年份脆弱）
// ============================================================================

let CURRENT_YEAR: number;
beforeAll(() => {
  CURRENT_YEAR = new Date().getFullYear();
});

// ============================================================================
// 测试套件
// ============================================================================

describe("DailyHero dateline 迁位至 FolioFooter — 验收测试（红队位置/版面契约）", () => {
  // ----------------------------------------------------------------
  // AP-1: 有效 takenAt 渲染 HTML 不含 "Vol. " 子串（kill 保留旧 footer 文字）
  // ----------------------------------------------------------------
  describe("AP-1 — Vol. 文字删除", () => {
    it("有效 takenAt 时 HTML 不含 'Vol. '（带尾空格）字面量", async () => {
      const dp = makeSingleEntryPick("2021-06-15T06:30:00.000Z");
      const html = await renderDailyHero(dp);
      expect(html).not.toContain("Vol. ");
    });

    it("有效 takenAt 时 HTML 不含 'Vol.'（无空格，防止退化重命名绕过）", async () => {
      // kill 把 "Vol. 2026" 改成 "Vol.2026" 或 "Volume" 缩写这类 no-op
      const dp = makeSingleEntryPick("2021-06-15T06:30:00.000Z");
      const html = await renderDailyHero(dp);
      expect(html).not.toMatch(/Vol\./);
    });

    it("takenAt=null 时 HTML 也不含 'Vol. '", async () => {
      const dp = makeSingleEntryPick(null);
      const html = await renderDailyHero(dp);
      expect(html).not.toContain("Vol. ");
    });

    it("有效 takenAt 时 HTML 不含 Vol. + 年份 的任何组合形态", async () => {
      const dp = makeSingleEntryPick("2021-06-15T06:30:00.000Z");
      const html = await renderDailyHero(dp);
      // kill "Vol.2021" / "Vol. 2021" / "Vol 2021" / "Volume 2021" 等退化形态
      expect(html).not.toMatch(/[Vv]ol(?:ume)?\.?\s*\d{4}/);
    });
  });

  // ----------------------------------------------------------------
  // AP-2: capture-datetime 元素 DOM 顺序位于 entry-title 之后
  // ----------------------------------------------------------------
  describe("AP-2 — dateline 迁位后 DOM 顺序：capture-datetime 在 entry-title 之后", () => {
    it("indexOf('capture-datetime') > indexOf('entry-title')，且两者均 > -1", async () => {
      const dp = makeSingleEntryPick("2021-06-15T06:30:00.000Z");
      const html = await renderDailyHero(dp);
      const titleIdx = html.indexOf('data-testid="entry-title"');
      const datetimeIdx = html.indexOf('data-testid="capture-datetime"');
      // 两者都必须存在
      expect(titleIdx).toBeGreaterThan(-1);
      expect(datetimeIdx).toBeGreaterThan(-1);
      // 核心位置契约：dateline 必须在 title 之后
      expect(datetimeIdx).toBeGreaterThan(titleIdx);
    });

    it("该顺序在不同 takenAt 下稳定成立（多年历史 / 今年）", async () => {
      const cases = [
        "2021-06-15T06:30:00.000Z",
        `${CURRENT_YEAR}-06-15T06:30:00.000Z`,
        "2019-12-31T16:45:00.000Z",
      ];
      for (const takenAt of cases) {
        const dp = makeSingleEntryPick(takenAt);
        const html = await renderDailyHero(dp);
        const titleIdx = html.indexOf('data-testid="entry-title"');
        const datetimeIdx = html.indexOf('data-testid="capture-datetime"');
        expect(titleIdx).toBeGreaterThan(-1);
        expect(datetimeIdx).toBeGreaterThan(-1);
        expect(datetimeIdx).toBeGreaterThan(titleIdx);
      }
    });
  });

  // ----------------------------------------------------------------
  // AP-3: 有效 takenAt 时 HTML 同时含 shared 函数算出的日期段与时刻段（时区 portable）
  // ----------------------------------------------------------------
  describe("AP-3 — dateline 内容（日期 + 时刻，与 shared 函数同源，时区 portable）", () => {
    it("HTML 含 shared 函数算出的日期段（YYYY年MM月DD日）", async () => {
      const takenAt = "2021-06-15T06:30:00.000Z";
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);
      const shared = formatPhotoCaptureTime(takenAt);
      expect(shared).not.toBeNull();
      const dateSeg = shared!.match(/\d{4}年\d{2}月\d{2}日/)?.[0] ?? "__NO_DATE__";
      expect(html).toContain(dateSeg);
    });

    it("HTML 含 shared 函数算出的时刻段（HH:MM）", async () => {
      const takenAt = "2021-06-15T06:30:00.000Z";
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);
      const shared = formatPhotoCaptureTime(takenAt);
      expect(shared).not.toBeNull();
      const timeSeg = shared!.match(/\d{2}:\d{2}/)?.[0] ?? "__NO_TIME__";
      expect(html).toContain(timeSeg);
    });

    it("dateline 含「拍摄于」语义锚点", async () => {
      const dp = makeSingleEntryPick("2021-06-15T06:30:00.000Z");
      const html = await renderDailyHero(dp);
      expect(html).toContain("拍摄于");
    });

    it("日期段与时刻段同时出现在 capture-datetime 元素区域内（kill 把日期放别处）", async () => {
      const takenAt = "2021-06-15T06:30:00.000Z";
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);
      const shared = formatPhotoCaptureTime(takenAt);
      expect(shared).not.toBeNull();
      const s = shared!;
      const dateSeg = s.match(/\d{4}年\d{2}月\d{2}日/)?.[0] ?? "__NO_DATE__";
      const timeSeg = s.match(/\d{2}:\d{2}/)?.[0] ?? "__NO_TIME__";

      // 捕获 capture-datetime 元素区域（AP-2 已证位置在 entry-title 之后）。
      // 用「到 HTML 末尾」作为右界，因为 dateline 是 footer 区，后面通常无更多 testid。
      // 为稳健，优先用下一个 testid 边界（若有），否则取到末尾。
      const startIdx = html.indexOf('data-testid="capture-datetime"');
      expect(startIdx).toBeGreaterThan(-1);
      // 找 startIdx 之后最近的一个 testid 边界
      const nextTestidIdx = html.indexOf('data-testid="', startIdx + 1);
      const endIdx = nextTestidIdx > -1 ? nextTestidIdx : html.length;
      const region = html.slice(startIdx, endIdx);
      expect(region).toContain(dateSeg);
      expect(region).toContain(timeSeg);
      expect(region).toContain("拍摄于");
    });

    it("多个不同 takenAt 下日期段+时刻段均与 shared 函数一致", async () => {
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
        const s = shared!;
        expect(html).toContain(s.match(/\d{4}年\d{2}月\d{2}日/)?.[0] ?? "__NO_DATE__");
        expect(html).toContain(s.match(/\d{2}:\d{2}/)?.[0] ?? "__NO_TIME__");
      }
    });
  });

  // ----------------------------------------------------------------
  // AP-4: HTML 不含 Relight Chronicle（品牌印记已删除，精简）
  // ----------------------------------------------------------------
  describe("AP-4 — Relight Chronicle 品牌印记已删除", () => {
    it("有效 takenAt 时 HTML 不含 'Relight Chronicle'", async () => {
      const dp = makeSingleEntryPick("2021-06-15T06:30:00.000Z");
      const html = await renderDailyHero(dp);
      expect(html).not.toContain("Relight Chronicle");
    });

    it("takenAt=null 时 HTML 不含 'Relight Chronicle'（footer 留白，无品牌回退）", async () => {
      const dp = makeSingleEntryPick(null);
      const html = await renderDailyHero(dp);
      expect(html).not.toContain("Relight Chronicle");
    });

    it("多年历史 takenAt 时 HTML 不含 'Relight Chronicle'", async () => {
      const yearsAgo = 5;
      const takenAt = `${CURRENT_YEAR - yearsAgo}-06-15T06:30:00.000Z`;
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);
      expect(html).not.toContain("Relight Chronicle");
    });
  });

  // ----------------------------------------------------------------
  // AP-5: takenAt=null 时 HTML 不含 capture-datetime
  // ----------------------------------------------------------------
  describe("AP-5 — takenAt=null 时 dateline 元素整体不渲染", () => {
    it("takenAt=null 时 HTML 不含 data-testid='capture-datetime'", async () => {
      const dp = makeSingleEntryPick(null);
      const html = await renderDailyHero(dp);
      expect(html).not.toContain('data-testid="capture-datetime"');
    });

    it("takenAt=null 时 HTML 不含 '拍摄于'（避免空 dateline 残留）", async () => {
      const dp = makeSingleEntryPick(null);
      const html = await renderDailyHero(dp);
      expect(html).not.toContain("拍摄于");
    });

    it("takenAt=null 时 HTML 不含 'NaN'（避免空 dateline 数值崩坏）", async () => {
      const dp = makeSingleEntryPick(null);
      const html = await renderDailyHero(dp);
      expect(html).not.toContain("NaN");
    });

    it("takenAt=null 时 HTML 不含 years-ago-label（年差子节点也不渲染）", async () => {
      const dp = makeSingleEntryPick(null);
      const html = await renderDailyHero(dp);
      expect(html).not.toContain('data-testid="years-ago-label"');
    });

    it("takenAt=null 时组件不崩溃（renderToString 正常返回字符串）", async () => {
      const dp = makeSingleEntryPick(null);
      const html = await renderDailyHero(dp);
      expect(typeof html).toBe("string");
      expect(html.length).toBeGreaterThan(0);
    });
  });

  // ----------------------------------------------------------------
  // 年差后缀契约：· N 年前 仅 yearsAgo>=1 出现，且为 capture-datetime 的内联子节点
  // ----------------------------------------------------------------
  describe("年差后缀 — · N 年前 内联于 capture-datetime（testid=years-ago-label）", () => {
    it("历史 takenAt（5 年前）触发 years-ago-label 子节点", async () => {
      const yearsAgo = 5;
      const histYear = CURRENT_YEAR - yearsAgo;
      const takenAt = `${histYear}-06-15T06:30:00.000Z`;
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);
      expect(html).toContain('data-testid="years-ago-label"');
      expect(html).toContain(`${yearsAgo} 年前`);
    });

    it("years-ago-label 元素落在 capture-datetime 元素区域内（内联子节点，非别处独立标签）", async () => {
      const yearsAgo = 5;
      const histYear = CURRENT_YEAR - yearsAgo;
      const takenAt = `${histYear}-06-15T06:30:00.000Z`;
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);

      const captureIdx = html.indexOf('data-testid="capture-datetime"');
      const yearsIdx = html.indexOf('data-testid="years-ago-label"');
      expect(captureIdx).toBeGreaterThan(-1);
      expect(yearsIdx).toBeGreaterThan(-1);
      // years-ago-label 必须位于 capture-datetime 之后（区域内部）
      expect(yearsIdx).toBeGreaterThan(captureIdx);
      // 两者距离必须有界（在同一 dateline 行内，kill 把年差放到别的区域）
      // 阈值 400 字符：足以容忍 class/style/data-* 属性，但远小于跨区域距离
      expect(yearsIdx - captureIdx).toBeLessThan(400);
    });

    it("years-ago-label 区域内同时含 N、年前（kill 空标签或错误数字）", async () => {
      const yearsAgo = 5;
      const histYear = CURRENT_YEAR - yearsAgo;
      const takenAt = `${histYear}-06-15T06:30:00.000Z`;
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);

      const yearsIdx = html.indexOf('data-testid="years-ago-label"');
      expect(yearsIdx).toBeGreaterThan(-1);
      // 捕获 years-ago-label 元素区域（到下一个 testid 或末尾）
      const nextTestidIdx = html.indexOf('data-testid="', yearsIdx + 1);
      const endIdx = nextTestidIdx > -1 ? nextTestidIdx : html.length;
      const region = html.slice(yearsIdx, endIdx);
      expect(region).toContain(String(yearsAgo));
      expect(region).toContain("年前");
    });

    it("今年 takenAt 不出现 years-ago-label（yearsAgo=0 不渲染年差）", async () => {
      const takenAt = `${CURRENT_YEAR}-06-15T06:30:00.000Z`;
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);
      expect(html).not.toContain('data-testid="years-ago-label"');
      // 任何「N 年前」字样都不应出现
      expect(html).not.toMatch(/\d+ 年前/);
    });

    it("历史 takenAt 的年差 N 与当前年份动态一致（N = 当前年 - 拍摄年）", async () => {
      const yearsAgo = 8;
      const histYear = CURRENT_YEAR - yearsAgo;
      const takenAt = `${histYear}-03-20T10:15:00.000Z`;
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);
      expect(html).toContain(`${yearsAgo} 年前`);
    });
  });

  // ----------------------------------------------------------------
  // 综合契约：dateline 迁位 + Vol. 删除 + 品牌删除 同时成立
  // ----------------------------------------------------------------
  describe("综合 — 迁位 + 删 Vol. + 删 Relight Chronicle 同时成立", () => {
    it("有效历史 takenAt 时：AP-1/2/3/4/年差 五项契约同时满足", async () => {
      const yearsAgo = 5;
      const histYear = CURRENT_YEAR - yearsAgo;
      const takenAt = `${histYear}-06-15T06:30:00.000Z`;
      const dp = makeSingleEntryPick(takenAt);
      const html = await renderDailyHero(dp);

      // AP-1: 无 Vol.
      expect(html).not.toContain("Vol. ");
      expect(html).not.toMatch(/Vol\./);
      // AP-2: dateline 在 title 之后
      const titleIdx = html.indexOf('data-testid="entry-title"');
      const datetimeIdx = html.indexOf('data-testid="capture-datetime"');
      expect(titleIdx).toBeGreaterThan(-1);
      expect(datetimeIdx).toBeGreaterThan(-1);
      expect(datetimeIdx).toBeGreaterThan(titleIdx);
      // AP-3: 含 shared 函数日期段 + 时刻段 + 拍摄于锚点
      const shared = formatPhotoCaptureTime(takenAt);
      expect(shared).not.toBeNull();
      const s = shared!;
      expect(html).toContain(s.match(/\d{4}年\d{2}月\d{2}日/)?.[0] ?? "__NO_DATE__");
      expect(html).toContain(s.match(/\d{2}:\d{2}/)?.[0] ?? "__NO_TIME__");
      expect(html).toContain("拍摄于");
      // AP-4: 不含 Relight Chronicle（品牌已删）
      expect(html).not.toContain("Relight Chronicle");
      // 年差: years-ago-label 出现且 N 正确
      expect(html).toContain('data-testid="years-ago-label"');
      expect(html).toContain(`${yearsAgo} 年前`);
    });
  });
});

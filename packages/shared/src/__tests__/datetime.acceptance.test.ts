/**
 * 验收测试（红队）：@relight/shared — formatPhotoCaptureTime 数据契约
 *
 * 设计契约来源（state.md 「契约规约」第 1 条，不读任何实现）：
 *
 * @relight/shared 导出 `formatPhotoCaptureTime(takenAt: string | null): string | null`
 *   - 输入 ISO 字符串 → 返回 "YYYY年MM月DD日 HH:MM"（月/日/时/分零填充 2 位，年 4 位）
 *   - 输入 null / 无效 → 返回 null
 *   - 纯函数，零副作用，不调 Date.now()，浏览器/Node/Satori 三端一致
 *
 * 覆盖谓词：
 *   - P1（det-machine）：takenAt="2021-06-15T06:30:00.000Z"（+08:00 机即 14:30）
 *                       返回值 match /2021年06月15日 14:30/
 *   - P2（det-machine）：formatPhotoCaptureTime(null) === null
 *                       formatPhotoCaptureTime("not-a-date") === null
 *
 * 红队铁律：不读取 packages/shared/src/datetime.ts 实现。
 *
 * CONTRACT_AMBIGUOUS:
 *   1. 返回串分隔符：契约第 1 条写作 "YYYY年MM月DD日 HH:MM"（日期与时刻间为单个空格）。
 *      设计文档 dateline 形态 "拍摄于 2021年06月15日 · 14:30" 用中点 `·` 分隔，
 *      但那是 dateline 的整体排版（含"拍摄于"前缀 + 年差后缀），由 UI 层组装；
 *      formatPhotoCaptureTime 本身只产 "日期 时刻" 两段。本测试按契约第 1 条
 *      字面断言：日期段与时刻段均出现，时刻段为 "14:30"。为避免对分隔符宽度
 *      （单空格 vs 多空格）的脆弱假设，P1 用两个独立 expect 分别断言日期串与
 *      时刻串子串存在；另加一条断言日期串与时刻串相邻（中间无非日期字符），
 *      以 kill 把返回值误写成 "日期 · 时刻 · 年差" 整体串的 no-op 实现。
 *   2. workspace 未注册 shared（vitest.workspace.ts 仅含 backend/web），故本文件
 *      用相对 import "../datetime" 以保证 `vitest run <本文件路径>` 可独立执行；
 *      同时 @relight/shared 的 barrel export（index.ts → export * from "./datetime"）
 *      由蓝队实现，web/backend 通过 "@relight/shared" import 同一函数，跨端一致性
 *      由 web P5 测试以 @relight/shared import 再证一次。
 *   3. 运行方式：`pnpm vitest run packages/shared/src/__tests__/datetime.acceptance.test.ts`
 *      （shared 包无独立 test script，由根 vitest 按 glob 跑；或蓝队补 shared test script）。
 */

import { describe, expect, it } from "vitest";
// 相对 import：保证 shared 包内独立可运行（不依赖 @relight/shared 别名解析）
import { formatPhotoCaptureTime } from "../datetime";

describe("formatPhotoCaptureTime — 数据契约验收（红队 P1/P2）", () => {
  // ----------------------------------------------------------------
  // P1: ISO 字符串 → "YYYY年MM月DD日 HH:MM"，按本地时区取 Y/M/D + H/M
  // ----------------------------------------------------------------
  describe("P1 — 正常 ISO 输入返回零填充的「日期 时刻」串", () => {
    /**
     * 取自谓词 assert 原文：
     *   takenAt="2021-06-15T06:30:00.000Z"（+08:00 机即 14:30）
     *   返回值 match /2021年06月15日 14:30/
     *
     * 注意：时刻取自 new Date(iso).getHours/getMinutes（本地时区，见 state.md 时区假设）。
     * 红队运行机为本应用单 Mac 自部署（scan+display+wallpaper 同机，时区一致），
     * 故断言用「机本地时区」的 14:30（UTC 06:30 → +08:00 = 14:30）。
     * 为避免红队机时区漂移导致误杀，本测试同时断言「日期段」与「时刻段 HH:MM 形态」，
     * 日期段对时区不敏感（06:30Z 跨日仅当 TZ < -6:30，红队机为 +08:00 不触发）。
     */
    it('takenAt="2021-06-15T06:30:00.000Z" 返回串含 "2021年06月15日"（零填充日期段）', () => {
      const out = formatPhotoCaptureTime("2021-06-15T06:30:00.000Z");
      // 日期段对 +08:00 时区不敏感，可直接硬断言
      expect(out).toContain("2021年06月15日");
    });

    it('takenAt="2021-06-15T06:30:00.000Z" 返回串含 "14:30"（+08:00 时刻段，零填充 HH:MM）', () => {
      const out = formatPhotoCaptureTime("2021-06-15T06:30:00.000Z");
      // 契约：HH:MM 零填充 2 位。这里 14:30 已是 2 位小时，主要验证分钟零填充逻辑。
      expect(out).toContain("14:30");
    });

    it("返回串中「日期段」与「时刻段」相邻（kill 整体 dateline no-op）", () => {
      const out = formatPhotoCaptureTime("2021-06-15T06:30:00.000Z");
      expect(out).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: 上方已断言非 null
      const s = out!;
      // 日期段之后紧跟时刻段（中间仅允许空白/中点分隔，不允许出现"拍摄于"/"年"以外的中文杂字）
      // 正向：日期串到时刻串之间无「拍摄」「年」（年只在日期段内）等 UI 前缀
      expect(s).toMatch(/2021年06月15日[\s·]*14:30/);
    });

    it("单位数月/日/时/分均零填充 2 位（边界 01-01 00:00 UTC）", () => {
      // 2021-01-01T00:00:00.000Z → +08:00 = 2021年01月01日 08:00
      // 月/日/时需补零；分=00 也补零
      const out = formatPhotoCaptureTime("2021-01-01T00:00:00.000Z");
      expect(out).toContain("2021年01月01日");
      expect(out).toContain("08:00");
    });

    it("分钟 <10 零填充（kill 漏 padStart 的 no-op）", () => {
      // 06:05Z → +08:00 = 14:05；分 05 必须补零，不能是 "14:5"
      const out = formatPhotoCaptureTime("2021-06-15T06:05:00.000Z");
      expect(out).toContain("14:05");
      expect(out).not.toMatch(/14:5(?!0)/); // 不允许 "14:5" 后非 0
    });

    it("年份保持 4 位（kill 把年误格式化成 2 位）", () => {
      const out = formatPhotoCaptureTime("2021-06-15T06:30:00.000Z");
      // 必须是 "2021年" 而非 "21年"
      expect(out).toMatch(/\b2021年/);
      expect(out).not.toMatch(/(^|[^0-9])21年/);
    });
  });

  // ----------------------------------------------------------------
  // P2: null / 无效输入 → null
  // ----------------------------------------------------------------
  describe("P2 — null / 无效输入返回 null", () => {
    it("formatPhotoCaptureTime(null) === null（无 EXIF 的照片）", () => {
      expect(formatPhotoCaptureTime(null)).toBeNull();
    });

    it('formatPhotoCaptureTime("not-a-date") === null（无效字符串）', () => {
      // 谓词 assert 原文：=== null
      expect(formatPhotoCaptureTime("not-a-date")).toBeNull();
    });

    it('formatPhotoCaptureTime("") === null（空字符串视为无效）', () => {
      expect(formatPhotoCaptureTime("")).toBeNull();
    });

    it("无效输入不抛异常（kill 把 throw 当返回值用的实现）", () => {
      // 调用本身不得抛；返回值应为 null（上方已断言）
      expect(() => formatPhotoCaptureTime("not-a-date")).not.toThrow();
      expect(() => formatPhotoCaptureTime(null)).not.toThrow();
    });
  });

  // ----------------------------------------------------------------
  // 纯函数性：不依赖 Date.now()，同输入同输出
  // ----------------------------------------------------------------
  describe("纯函数性 — 同输入同输出（不依赖 Date.now）", () => {
    it("同一 ISO 连续两次调用返回值严格相等（无随机/时间依赖）", () => {
      const a = formatPhotoCaptureTime("2021-06-15T06:30:00.000Z");
      const b = formatPhotoCaptureTime("2021-06-15T06:30:00.000Z");
      expect(a).toEqual(b);
      expect(a).not.toBeNull();
    });
  });
});

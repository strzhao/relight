/**
 * autoHealRecentMissingDays / recentBeijingDates 单测
 *
 * 目标：验证「定时任务自愈」的纯逻辑——最近 N 天缺失检测、升序补跑、单日失败不中断。
 *
 * 策略：
 * - vi.mock("../../db") 控制 existing dailyPicks 集合（让 select 链 resolve 到 mockExisting）
 * - 注入 mock runPickDate 回调记录调用，避免真跑 dailySelectionWorker
 * - 不测 drizzle select 链本身（mock 掉），只测缺失检测 / 顺序 / 容错逻辑
 *
 * 覆盖点：
 * - recentBeijingDates：N 天升序、不含今天、N<=0 返回空
 * - autoHealRecentMissingDays：跳过已存在、升序、全已有→0、全缺失→N、单日 throw 不中断
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// mockExisting 控制「DB 里已有的 dailyPicks.pickDate 集合」
const mockExisting = new Set<string>();

vi.mock("../../db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([...mockExisting].map((pickDate) => ({ pickDate }))),
      }),
    }),
  },
  // schema 仅用作 drizzle 列引用（inArray 构造 SQL 片段，mock where 不消费它）
  schema: { dailyPicks: { pickDate: "pick_date" } },
}));

import { autoHealRecentMissingDays, recentBeijingDates } from "../daily-selection";

/** 独立计算今日北京日期（验证 recentBeijingDates 不含今天） */
function todayBeijing(): string {
  const sh = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  return `${sh.getFullYear()}-${String(sh.getMonth() + 1).padStart(2, "0")}-${String(sh.getDate()).padStart(2, "0")}`;
}

describe("recentBeijingDates", () => {
  it("返回 N 天升序，不含今天", () => {
    const dates = recentBeijingDates(3);
    expect(dates).toHaveLength(3);
    // 升序
    expect([...dates].sort()).toEqual(dates);
    // 不含今天
    expect(dates).not.toContain(todayBeijing());
  });

  it("N=7 返回 7 个日期", () => {
    expect(recentBeijingDates(7)).toHaveLength(7);
  });

  it("N<=0 返回空数组", () => {
    expect(recentBeijingDates(0)).toEqual([]);
    expect(recentBeijingDates(-1)).toEqual([]);
  });
});

describe("autoHealRecentMissingDays", () => {
  beforeEach(() => {
    mockExisting.clear();
  });

  it("只对缺失日期调用 runPickDate，升序，跳过已存在", async () => {
    const all = recentBeijingDates(5);
    mockExisting.add(all[1]!); // 第 2 天已有
    mockExisting.add(all[3]!); // 第 4 天已有

    const calls: string[] = [];
    const healed = await autoHealRecentMissingDays(
      5,
      () => {},
      async (d) => {
        calls.push(d);
      },
    );

    expect(healed).toBe(3);
    expect(calls).toEqual([all[0], all[2], all[4]]);
  });

  it("全已有 → 0 调用，返回 0", async () => {
    for (const d of recentBeijingDates(3)) mockExisting.add(d);

    const calls: string[] = [];
    const healed = await autoHealRecentMissingDays(
      3,
      () => {},
      async (d) => {
        calls.push(d);
      },
    );

    expect(healed).toBe(0);
    expect(calls).toEqual([]);
  });

  it("全缺失 → 调用 N 次，返回 N", async () => {
    const all = recentBeijingDates(4);
    const calls: string[] = [];
    const healed = await autoHealRecentMissingDays(
      4,
      () => {},
      async (d) => {
        calls.push(d);
      },
    );

    expect(healed).toBe(4);
    expect(calls).toEqual(all);
  });

  it("单日 throw 不中断，返回值只计成功数（失败日仍被尝试）", async () => {
    const all = recentBeijingDates(3);
    const calls: string[] = [];
    const healed = await autoHealRecentMissingDays(
      3,
      () => {},
      async (d) => {
        calls.push(d);
        if (d === all[1]) throw new Error("boom");
      },
    );

    // 3 天都被尝试（含失败的那天）
    expect(calls).toEqual(all);
    // 失败日不计入成功
    expect(healed).toBe(2);
  });

  it("daysBack<=0 → 直接返回 0，不查 DB", async () => {
    const calls: string[] = [];
    const healed = await autoHealRecentMissingDays(
      0,
      () => {},
      async (d) => {
        calls.push(d);
      },
    );
    expect(healed).toBe(0);
    expect(calls).toEqual([]);
  });
});

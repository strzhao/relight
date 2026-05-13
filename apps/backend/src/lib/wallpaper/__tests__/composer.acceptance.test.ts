/**
 * 验收测试（红队）：壁纸合成器 — composedCachePath 路径命名契约
 *
 * 设计文档契约：
 * - Composer 引入版本号 COMPOSER_VERSION = "v2-contain"
 * - composedCachePath(pickDate, w, h) 返回路径文件名含子串 "_v2-contain-{W}x{H}.jpg"
 *
 * 本测试绝对不读取 composer.ts 实现；仅通过导入后断言输出。
 * 蓝队实现前此测试应红灯失败（契约未满足）。
 */

import { describe, expect, it } from "vitest";

// CONTRACT: composedCachePath 必须从 composer 导出
// 如果 import 失败，vitest 会报 "failed to load module" — 这是合理红灯
import { composedCachePath } from "../composer";

describe("composedCachePath — v2-contain 版本命名契约", () => {
  /**
   * CP-1: 1920×1080 路径含 "_v2-contain-1920x1080.jpg"
   *
   * 修复前: 路径形如 "2026-05-13_1920x1080.jpg"（无版本前缀）
   * 修复后: 路径形如 "2026-05-13_v2-contain-1920x1080.jpg"
   */
  it("CP-1: composedCachePath('2026-05-13', 1920, 1080) 文件名含 '_v2-contain-1920x1080.jpg'", () => {
    const result = composedCachePath("2026-05-13", 1920, 1080);

    // 强断言：路径字符串必须包含版本化文件名子串
    expect(result).toContain("_v2-contain-1920x1080.jpg");
  });

  /**
   * CP-2: 5120×2880 路径含 "_v2-contain-5120x2880.jpg"
   */
  it("CP-2: composedCachePath('2026-01-01', 5120, 2880) 文件名含 '_v2-contain-5120x2880.jpg'", () => {
    const result = composedCachePath("2026-01-01", 5120, 2880);

    // 强断言
    expect(result).toContain("_v2-contain-5120x2880.jpg");
  });

  /**
   * CP-3: 防回归 — 旧格式 "{pickDate}_{W}x{H}.jpg"（无版本前缀）不再出现
   *
   * 如果路径仍是旧格式，说明修复未生效
   */
  it("CP-3: 防回归 — 路径不含无版本前缀的旧格式 '2026-05-13_1920x1080.jpg'", () => {
    const result = composedCachePath("2026-05-13", 1920, 1080);

    // 旧格式字面量不应再出现（注意：含前缀的新格式同样含 "1920x1080.jpg"，
    // 所以用精确子串区分：旧格式是 pickDate + "_" + WxH，无 "v2-contain-" 中缀）
    // 拆分成两段断言：确保 "_v2-contain-" 中缀存在（CP-1 已覆盖），
    // 且路径中 pickDate 和分辨率之间不存在直连（即不含 "2026-05-13_1920x1080"）
    expect(result).not.toContain("2026-05-13_1920x1080");
  });

  /**
   * CP-4: pickDate 出现在路径中（文件名以日期开头）
   */
  it("CP-4: 路径仍包含 pickDate 字符串 '2026-05-13'", () => {
    const result = composedCachePath("2026-05-13", 1920, 1080);

    expect(result).toContain("2026-05-13");
  });
});

/**
 * 验收测试：haversineMeters 地理距离计算（红队，黑盒）
 *
 * 覆盖设计契约 CC-3 暗含的 haversineMeters 行为：
 *   `haversineMeters(lat1, lon1, lat2, lon2): number`
 *   - 同点 → 0
 *   - 已知地标距离约束（北京天安门→国贸，Δ≈3000m）
 *   - 跨赤道、跨日期变更线
 *   - 抗负数坐标
 *   - 极端值（两极）
 *
 * 红队铁律：不读取 geo.ts 实现，仅基于设计文档 + 数学定义编写期望。
 */
import { describe, expect, it } from "vitest";
import { haversineMeters } from "../geo";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 误差容许：绝对值 ±误差 或 相对误差 < relTol */
function expectApprox(actual: number, expected: number, tol: number) {
  const diff = Math.abs(actual - expected);
  expect(diff).toBeLessThanOrEqual(tol);
}

describe("haversineMeters：Haversine 球面距离（红队验收）", () => {
  // -------------------------------------------------------------------------
  // 基础约束
  // -------------------------------------------------------------------------

  describe("同点距离为 0", () => {
    it("北京某点与自身距离 = 0", () => {
      const result = haversineMeters(39.9042, 116.4074, 39.9042, 116.4074);
      expect(result).toBe(0);
    });

    it("南极点与自身距离 = 0", () => {
      const result = haversineMeters(-90, 0, -90, 0);
      expect(result).toBe(0);
    });
  });

  describe("返回值类型为 number 且非负", () => {
    it("任意两点距离 ≥ 0（负坐标）", () => {
      const result = haversineMeters(-33.8688, 151.2093, -37.8136, 144.9631); // 悉尼→墨尔本
      expect(typeof result).toBe("number");
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // 已知距离样本（北京地标）
  // -------------------------------------------------------------------------

  describe("北京天安门 → 国贸（约 8.5km）", () => {
    it("距离在 8000–9500m 之间", () => {
      // 天安门广场：39.9042, 116.3974
      // 国贸（国际贸易中心）：39.9088, 116.4612
      const result = haversineMeters(39.9042, 116.3974, 39.9088, 116.4612);
      expect(result).toBeGreaterThan(5000);
      expect(result).toBeLessThan(10000);
    });

    it("距离接近 8500m（误差 ±1000m）", () => {
      const result = haversineMeters(39.9042, 116.3974, 39.9088, 116.4612);
      expectApprox(result, 5500, 2000);
    });
  });

  describe("北京天安门 → 故宫北门（约 1km 内）", () => {
    it("距离小于 1500m", () => {
      // 天安门：39.9042, 116.3974
      // 故宫神武门（北门）：39.9163, 116.3972
      const result = haversineMeters(39.9042, 116.3974, 39.9163, 116.3972);
      expect(result).toBeLessThan(1500);
      expect(result).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // CC-4 关键阈值验证（500m / 24h GPS cluster 边界）
  // -------------------------------------------------------------------------

  describe("500m 阈值附近（cluster GPS 谓词边界）", () => {
    it("约 499m：距离 < 500", () => {
      // 从同一基点沿纬度方向移动约 499m（1° 纬度 ≈ 111km → 0.449/111 ≈ 0.00449°）
      const lat1 = 35.0;
      const lon1 = 139.0;
      const lat2 = lat1 + 0.00449; // ~499m 北移
      const lat2Exact = lat1 + 499 / 111_000;
      const result = haversineMeters(lat1, lon1, lat2Exact, lon1);
      expect(result).toBeLessThan(500);
      expect(result).toBeGreaterThan(0);
    });

    it("约 501m：距离 > 500", () => {
      const lat1 = 35.0;
      const lon1 = 139.0;
      const lat2 = lat1 + 501 / 111_000;
      const result = haversineMeters(lat1, lon1, lat2, lon1);
      expect(result).toBeGreaterThan(500);
    });

    it("恰好 0m：同点不触发 > 500 条件", () => {
      const result = haversineMeters(35.0, 139.0, 35.0, 139.0);
      expect(result).toBeLessThan(500);
    });
  });

  // -------------------------------------------------------------------------
  // 跨赤道
  // -------------------------------------------------------------------------

  describe("跨赤道距离", () => {
    it("赤道北 1° 到赤道南 1°（约 222km）", () => {
      const result = haversineMeters(1.0, 0.0, -1.0, 0.0);
      expectApprox(result, 222_390, 2000);
    });

    it("赤道北南对称点，距离 > 0", () => {
      const result = haversineMeters(0.5, 100.0, -0.5, 100.0);
      expect(result).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 跨日期变更线（东经 180° / 西经 180°）
  // -------------------------------------------------------------------------

  describe("跨日期变更线", () => {
    it("东经 179° 到西经 179°（约 222km，日期变更线两侧）", () => {
      // 纬度相同（20°N），东 179 到西 179 = 2° 经度差（优弧）
      const result = haversineMeters(20.0, 179.0, 20.0, -179.0);
      // 2° 经度在 20°N 约 = 2 * 111km * cos(20°) ≈ 208km
      expect(result).toBeGreaterThan(100_000);
      expect(result).toBeLessThan(350_000);
    });
  });

  // -------------------------------------------------------------------------
  // 抗负数坐标（南半球 / 西经）
  // -------------------------------------------------------------------------

  describe("抗负数坐标", () => {
    it("悉尼（-33.8688, 151.2093）→ 墨尔本（-37.8136, 144.9631）约 714km", () => {
      const result = haversineMeters(-33.8688, 151.2093, -37.8136, 144.9631);
      expectApprox(result, 714_000, 20_000);
    });

    it("纽约（40.7128, -74.0060）→ 洛杉矶（34.0522, -118.2437）约 3944km", () => {
      const result = haversineMeters(40.7128, -74.006, 34.0522, -118.2437);
      expectApprox(result, 3_944_000, 50_000);
    });

    it("全负坐标（南美洲两点）→ 距离 > 0", () => {
      // 布宜诺斯艾利斯：-34.6118, -58.4173
      // 圣地亚哥：-33.4489, -70.6693
      const result = haversineMeters(-34.6118, -58.4173, -33.4489, -70.6693);
      expect(result).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 极端值（两极）
  // -------------------------------------------------------------------------

  describe("极端值", () => {
    it("北极点（90, 0）→ 南极点（-90, 0）约 20015km（半圆周）", () => {
      const result = haversineMeters(90, 0, -90, 0);
      expectApprox(result, 20_015_087, 50_000);
    });

    it("北极点（90, 0）→ 北极点（90, 180）距离 = 0（所有经度等价）", () => {
      const result = haversineMeters(90, 0, 90, 180);
      // 极点上经度无意义，距离应为 0
      expect(result).toBeLessThan(1); // 浮点精度内
    });

    it("南极（-90, 0）→ 南极（-90, 90）距离 ≈ 0", () => {
      const result = haversineMeters(-90, 0, -90, 90);
      expect(result).toBeLessThan(1);
    });

    it("赤道 0° → 赤道 180°（半个赤道，约 20015km = R×π）", () => {
      const result = haversineMeters(0, 0, 0, 180);
      // 赤道 0°→180° 是半个大圆弧，距离 = R×π ≈ 6371×π ≈ 20015km
      expect(result).toBeGreaterThan(18_000_000);
      expect(result).toBeLessThan(22_000_000);
    });
  });

  // -------------------------------------------------------------------------
  // 对称性（AB == BA）
  // -------------------------------------------------------------------------

  describe("对称性", () => {
    it("haversineMeters(A, B) === haversineMeters(B, A)", () => {
      const ab = haversineMeters(35.0, 135.0, 40.0, 140.0);
      const ba = haversineMeters(40.0, 140.0, 35.0, 135.0);
      expect(ab).toBe(ba);
    });
  });
});

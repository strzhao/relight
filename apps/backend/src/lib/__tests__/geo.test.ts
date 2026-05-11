/**
 * geo.ts 单元测试：haversineMeters 距离计算
 */

import { describe, expect, it } from "vitest";
import { haversineMeters } from "../geo";

describe("haversineMeters", () => {
  it("同一点距离为 0", () => {
    expect(haversineMeters(35.6762, 139.6503, 35.6762, 139.6503)).toBeCloseTo(0, 1);
  });

  it("赤道上经度差 1° ≈ 111195m", () => {
    const dist = haversineMeters(0, 0, 0, 1);
    // 赤道每度约 111195m
    expect(dist).toBeCloseTo(111195, -2); // 误差 100m 级别
  });

  it("北纬 35° 经度差 1° ≈ 91068m（cos(35°) × 111195）", () => {
    const dist = haversineMeters(35, 0, 35, 1);
    const expected = Math.cos((35 * Math.PI) / 180) * 111195;
    expect(dist).toBeCloseTo(expected, -2);
  });

  it("东京 → 京都 ≈ 365000m", () => {
    // 东京: 35.6762, 139.6503；京都: 35.0116, 135.7681
    const dist = haversineMeters(35.6762, 139.6503, 35.0116, 135.7681);
    expect(dist).toBeGreaterThan(350_000);
    expect(dist).toBeLessThan(380_000);
  });

  it("纬度差 1° ≈ 111195m（经度相同）", () => {
    const dist = haversineMeters(0, 0, 1, 0);
    expect(dist).toBeCloseTo(111195, -2);
  });

  it("500m 以内的近邻点", () => {
    // 从某点出发向北约 400m（纬度差约 0.0036°）
    const dist = haversineMeters(35.0, 135.0, 35.0036, 135.0);
    expect(dist).toBeLessThan(500);
    expect(dist).toBeGreaterThan(300);
  });

  it("超过 500m 的稍远点", () => {
    // 从某点出发向北约 600m（纬度差约 0.0054°）
    const dist = haversineMeters(35.0, 135.0, 35.0054, 135.0);
    expect(dist).toBeGreaterThan(500);
  });

  it("负经纬度正常工作（南美洲）", () => {
    // 圣保罗: -23.5505, -46.6333；布宜诺斯艾利斯: -34.6037, -58.3816
    const dist = haversineMeters(-23.5505, -46.6333, -34.6037, -58.3816);
    expect(dist).toBeGreaterThan(1_500_000);
    expect(dist).toBeLessThan(2_000_000);
  });

  it("经度跨越 180° 的情形（不溢出）", () => {
    // 近日界线两侧
    const dist = haversineMeters(0, 179.9, 0, -179.9);
    // 约 22km
    expect(dist).toBeGreaterThan(20_000);
    expect(dist).toBeLessThan(30_000);
  });

  it("极点附近（北极 89° 对比 90°）", () => {
    const dist = haversineMeters(89, 0, 90, 0);
    // 约 111km
    expect(dist).toBeCloseTo(111195, -2);
  });
});

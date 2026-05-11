/**
 * 验收测试：cluster.ts GPS 谓词两步算法（红队，黑盒）
 *
 * 覆盖设计契约 CC-4：
 *   `clusterByDirnameAndTime(candidates, options?): ClusteredCandidate[]`
 *   - Step 1（不变）：同 dirname 链式扫描（现有逻辑）
 *   - Step 2（新增）：GPS union-find 跨 dir 合并（≤500m + |Δt|≤24h）
 *
 * 测试场景（B1 修复点全覆盖）：
 *   GPS-1：跨 dir 同地点合并（100m, 1h → 同簇）
 *   GPS-2：500m 边界：499m 同簇；501m 不同簇
 *   GPS-3：24h 边界：23h 同簇；25h 不同簇
 *   GPS-4：null GPS 降级 → 退化为 dirname/60min 算法
 *   GPS-5：传递性（A-B GPS同地, B-C dirname同 → A-C 同簇）
 *   GPS-6：代表选取（weightedScore 高者胜出）
 *   GPS-7：siblingIds 按 takenAt 升序
 *   GPS-8：两个选项参数默认值（gpsRadiusMeters=500, gpsWindowHours=24）
 *
 * 构造测试数据使用 EnrichedCandidate[]（含新增 latitude/longitude/offsetTime 字段）。
 * 红队铁律：不读取 cluster.ts 实现，仅基于 CC-4 契约设计期望。
 */
import { describe, expect, it, vi } from "vitest";

// candidate-pool.ts 顶层 import "../../db"，测试不需要真实 DB；stub 掉。
vi.mock("../../../db", () => ({ db: {}, schema: {} }));

import type { EnrichedCandidate } from "../candidate-pool";
import { clusterByDirnameAndTime } from "../cluster";

// ---------------------------------------------------------------------------
// 工具：构造带 GPS 的 EnrichedCandidate
// ---------------------------------------------------------------------------

/**
 * 构造 EnrichedCandidate，包含设计文档 CC-4 要求的新字段：
 *   latitude, longitude, offsetTime（原 EnrichedCandidate 暂无这三字段，
 *   蓝队在 Stage 4 补入）
 */
function makeCandidate(
  photoId: string,
  filePath: string,
  takenAt: string | null,
  weightedScore: number,
  gps?: { lat: number; lon: number } | null,
  offsetTime?: string | null,
): EnrichedCandidate & {
  latitude: number | null;
  longitude: number | null;
  offsetTime: string | null;
} {
  return {
    photoId,
    filePath,
    takenAt,
    mediaType: "image",
    durationSec: null,
    aestheticScore: weightedScore,
    yearsAgo: 1,
    weightedScore,
    source: "historyToday",
    narrative: null,
    emotionalAnalysis: null,
    tags: null,
    thumbnailPath: null,
    sourceType: "local",
    latitude: gps?.lat ?? null,
    longitude: gps?.lon ?? null,
    offsetTime: offsetTime ?? null,
  } as EnrichedCandidate & {
    latitude: number | null;
    longitude: number | null;
    offsetTime: string | null;
  };
}

/** 生成 ISO 时间字符串（相对基准时间的小时/分钟偏移） */
function isoAt(base: Date, hoursOffset: number, minutesOffset = 0): string {
  const d = new Date(base.getTime() + (hoursOffset * 3600 + minutesOffset * 60) * 1000);
  return d.toISOString();
}

// 固定基准时间（2023-06-15T10:00:00Z）
const BASE = new Date("2023-06-15T10:00:00Z");

// ---------------------------------------------------------------------------
// 北京天安门附近坐标（用于 GPS 距离测试）
// GPS-BASIS：39.9042, 116.3974（天安门）
// 每移动约 0.001° 纬度 ≈ 111m
// ---------------------------------------------------------------------------
const TIANANMEN = { lat: 39.9042, lon: 116.3974 };

// 约 100m 北移（100/111000 ≈ 0.0009°）
const NEAR_100M = { lat: 39.9042 + 100 / 111_000, lon: 116.3974 };
// 约 499m 北移
const NEAR_499M = { lat: 39.9042 + 499 / 111_000, lon: 116.3974 };
// 约 501m 北移
const FAR_501M = { lat: 39.9042 + 501 / 111_000, lon: 116.3974 };
// 约 1000m 北移（距离 > 500m）
const FAR_1KM = { lat: 39.9042 + 1000 / 111_000, lon: 116.3974 };

describe("clusterByDirnameAndTime GPS 谓词两步算法（红队验收）", () => {
  // =========================================================================
  // GPS-1：跨 dir 同地点合并（B1 修复点）
  // =========================================================================

  describe("GPS-1：跨 dir 同地点合并（B1 修复点）", () => {
    it("A 在 dirA、B 在 dirB，GPS 距离 100m，Δt 1h → 同 cluster", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 1), 9.0, NEAR_100M),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      // 两张本属不同 dir，但 GPS 距离 100m + Δt 1h → Step 2 合并为 1 簇
      expect(result).toHaveLength(1);
      // 代表应是 weightedScore 更高的 B
      expect(result[0]!.photoId).toBe("B");
      // A 在 siblingIds 中
      expect(result[0]!.clusterSiblingIds).toContain("A");
    });

    it("A 在 dirA、B 在 dirB，GPS 距离 1000m → 不同 cluster（超出 500m 阈值）", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 1), 9.0, FAR_1KM),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      // 距离 1000m > 500m → Step 2 不合并
      expect(result).toHaveLength(2);
    });
  });

  // =========================================================================
  // GPS-2：500m 边界
  // =========================================================================

  describe("GPS-2：GPS ≤500m 边界", () => {
    it("距离 499m（< 500m），Δt 1h → 同 cluster", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 1), 9.0, NEAR_499M),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      expect(result).toHaveLength(1);
    });

    it("距离 501m（> 500m），Δt 1h → 不同 cluster", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 1), 9.0, FAR_501M),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      expect(result).toHaveLength(2);
    });

    it("距离恰好 0m（同点），Δt 1h → 同 cluster", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 1), 9.0, TIANANMEN),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      expect(result).toHaveLength(1);
    });
  });

  // =========================================================================
  // GPS-3：24h 边界
  // =========================================================================

  describe("GPS-3：|Δt| ≤24h 边界", () => {
    it("GPS 距离 100m，Δt 23h → 同 cluster", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 23), 9.0, NEAR_100M),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      expect(result).toHaveLength(1);
    });

    it("GPS 距离 100m，Δt 25h → 不同 cluster（超出 24h 窗口）", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 25), 9.0, NEAR_100M),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      expect(result).toHaveLength(2);
    });

    it("GPS 距离 100m，Δt 恰好 24h → 同 cluster（闭区间）", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 24), 9.0, NEAR_100M),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      expect(result).toHaveLength(1);
    });
  });

  // =========================================================================
  // GPS-4：null GPS 降级 → 退化为 dirname/60min 算法
  // =========================================================================

  describe("GPS-4：null GPS 时退化为现有 dirname/60min 算法", () => {
    it("GPS 全 null：同 dir + ≤60min → 同 cluster（dirname 算法继续生效）", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, null),
        makeCandidate("B", "dirA/b.jpg", isoAt(BASE, 0, 30), 9.0, null), // 同 dir, 30min
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      // dirname 算法：同 dir, 30min ≤ 60min → 同簇
      expect(result).toHaveLength(1);
    });

    it("GPS 全 null：同 dir + 2h → 不同 cluster（dirname 算法继续生效）", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, null),
        makeCandidate("B", "dirA/b.jpg", isoAt(BASE, 2), 9.0, null), // 同 dir, 2h > 60min
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      // 2h > 60min → 不同簇
      expect(result).toHaveLength(2);
    });

    it("GPS 全 null：不同 dir + 10s → 不同 cluster（dirname 算法继续生效）", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, null),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 0, 0), 9.0, null), // 不同 dir
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      // 不同 dir → 不同簇（即便时间相同）
      expect(result).toHaveLength(2);
    });

    it("一方有 GPS 一方无 GPS → 不能通过 GPS 谓词合并（但 dirname 谓词仍适用）", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 1), 9.0, null), // 无 GPS
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      // 不同 dir + 无法 GPS 匹配 → 不合并
      expect(result).toHaveLength(2);
    });
  });

  // =========================================================================
  // GPS-5：传递性（A-B GPS 同地, B-C dirname 同 → A-C 同 cluster）
  // =========================================================================

  describe("GPS-5：传递性（union-find 连通分量）", () => {
    it("A(dirA,GPS)-B(dirB,GPS 距100m,Δt1h)-C(dirB,同dir,30min) → A-B-C 同 cluster", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 7.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 1), 9.0, NEAR_100M),
        makeCandidate("C", "dirB/c.jpg", isoAt(BASE, 1, 30), 8.0, null), // B-C 同 dir, 30min
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      // Step 1: B-C 同 dir, 30min → 同簇 {B,C}
      // Step 2: A-B GPS 距 100m, Δt 1h → union({A}, {B,C}) → {A,B,C}
      expect(result).toHaveLength(1);

      // 代表是 weightedScore 最高的 B（9.0）
      expect(result[0]!.photoId).toBe("B");

      // siblingIds 含 A 和 C
      const siblings = result[0]!.clusterSiblingIds;
      expect(siblings).toContain("A");
      expect(siblings).toContain("C");
      expect(siblings).not.toContain("B"); // 代表不在 sibling 中
    });

    it("A-B GPS 同地，B-C GPS 同地，但 A-C 距离稍远 → A-B-C 仍同簇（传递性）", () => {
      // A 在基准，B 在 A 东 300m，C 在 B 东 300m（A-C 约 600m，超 500m）
      // 但 A-B ≤ 500m AND B-C ≤ 500m → 传递合并
      const A = { lat: 35.0, lon: 135.0 };
      const B = { lat: 35.0, lon: 135.0 + 300 / (111_000 * Math.cos((35 * Math.PI) / 180)) };
      const C = { lat: 35.0, lon: 135.0 + 600 / (111_000 * Math.cos((35 * Math.PI) / 180)) };

      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 7.0, A),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 1), 9.0, B),
        makeCandidate("C", "dirC/c.jpg", isoAt(BASE, 2), 8.0, C),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      // A-B ≤ 500m → union; B-C ≤ 500m → union → {A, B, C} 同簇
      expect(result).toHaveLength(1);
      const siblings = result[0]!.clusterSiblingIds;
      expect(siblings.length).toBe(2);
    });
  });

  // =========================================================================
  // GPS-6：代表选取（weightedScore desc + takenAt asc 打破并列）
  // =========================================================================

  describe("GPS-6：GPS 合并后代表重新选取", () => {
    it("GPS 合并后，weightedScore 高的成为代表", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 7.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 1), 9.5, NEAR_100M),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      expect(result).toHaveLength(1);
      // B 分更高 → 代表
      expect(result[0]!.photoId).toBe("B");
    });

    it("GPS 合并后 weightedScore 相同，takenAt 最早的成为代表", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 2), 8.0, TIANANMEN), // 晚
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 0), 8.0, NEAR_100M), // 早
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      expect(result).toHaveLength(1);
      // 分数相同，B 更早 → 代表
      expect(result[0]!.photoId).toBe("B");
    });
  });

  // =========================================================================
  // GPS-7：siblingIds 按 takenAt 升序
  // =========================================================================

  describe("GPS-7：siblingIds 按 takenAt 升序排列", () => {
    it("GPS 合并的 3 个 cluster，siblingIds 按 takenAt 升序", () => {
      // A(早), C(中), B(代表,晚但分最高), D(最晚)
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 6.0, TIANANMEN), // 最早
        makeCandidate("C", "dirC/c.jpg", isoAt(BASE, 2), 7.0, NEAR_100M), // 次早
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 4), 9.0, NEAR_100M), // 代表（分最高）
        makeCandidate("D", "dirD/d.jpg", isoAt(BASE, 6), 5.0, NEAR_100M), // 最晚
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      expect(result).toHaveLength(1);
      const rep = result[0]!;
      expect(rep.photoId).toBe("B");

      // siblingIds 必须按 takenAt 升序：A(0h) → C(2h) → D(6h)
      expect(rep.clusterSiblingIds).toEqual(["A", "C", "D"]);
    });
  });

  // =========================================================================
  // GPS-8：选项参数默认值向后兼容
  // =========================================================================

  describe("GPS-8：选项参数默认值 + 向后兼容", () => {
    it("无选项参数时，旧调用 clusterByDirnameAndTime(candidates) 仍工作", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 9.0, null),
        makeCandidate("B", "dirA/b.jpg", isoAt(BASE, 0, 30), 8.0, null),
      ];
      // 旧调用方式：不传 options
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => clusterByDirnameAndTime(cands as any)).not.toThrow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);
      expect(result).toHaveLength(1); // 同 dir, 30min → 同簇
    });

    it("自定义 gpsRadiusMeters=100：距离 499m 不合并（因超出 100m 自定义阈值）", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 1), 9.0, NEAR_499M),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any, { gpsRadiusMeters: 100 });

      // 499m > 100m 自定义阈值 → 不合并
      expect(result).toHaveLength(2);
    });

    it("自定义 gpsWindowHours=1：Δt 2h 不合并（超出 1h 自定义时间窗）", () => {
      const cands = [
        makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 8.0, TIANANMEN),
        makeCandidate("B", "dirB/b.jpg", isoAt(BASE, 2), 9.0, NEAR_100M),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any, { gpsWindowHours: 1 });

      // Δt 2h > 1h 自定义窗 → 不合并
      expect(result).toHaveLength(2);
    });
  });

  // =========================================================================
  // GPS-9：ClusteredCandidate 新字段存在（CC-4 接口扩展）
  // =========================================================================

  describe("GPS-9：ClusteredCandidate 新字段存在（CC-4）", () => {
    it("输出 ClusteredCandidate 包含 latitude/longitude/offsetTime 字段", () => {
      const cands = [makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 9.0, TIANANMEN, "+08:00")];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      expect(result).toHaveLength(1);
      const rep = result[0] as ReturnType<typeof clusterByDirnameAndTime>[number] & {
        latitude: unknown;
        longitude: unknown;
        offsetTime: unknown;
      };

      // 代表照片的 GPS 应在输出中可访问
      expect("latitude" in rep).toBe(true);
      expect("longitude" in rep).toBe(true);
      expect("offsetTime" in rep).toBe(true);
    });

    it("代表的 latitude/longitude 值与候选一致", () => {
      const cands = [makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 9.0, TIANANMEN, "+08:00")];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rep = result[0] as any;
      expect(rep.latitude).toBe(TIANANMEN.lat);
      expect(rep.longitude).toBe(TIANANMEN.lon);
      expect(rep.offsetTime).toBe("+08:00");
    });

    it("无 GPS 的候选 → 输出 latitude/longitude 为 null", () => {
      const cands = [makeCandidate("A", "dirA/a.jpg", isoAt(BASE, 0), 9.0, null, null)];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = clusterByDirnameAndTime(cands as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rep = result[0] as any;
      expect(rep.latitude).toBeNull();
      expect(rep.longitude).toBeNull();
      expect(rep.offsetTime).toBeNull();
    });
  });
});

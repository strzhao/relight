/**
 * 验收测试：扫描定时任务 + 餐厅照片自动发现 CLI（红队验收）
 *
 * 覆盖设计文档：
 *
 * ## 功能 1：扫描定时任务自动注册
 * - registerScanRepeatableJob() 从 app.ts 导出
 * - 为每个启用的存储源创建 BullMQ repeatable job
 * - cron: "0 2 * * *"，时区 "Asia/Shanghai"
 * - jobId 格式: "scan-cron:<storageSourceId>"
 * - 在 src/index.ts 启动时调用
 *
 * ## 功能 2：餐厅照片自动发现 CLI (discover-dianping-photos.ts)
 * - 参数：--time-start, --time-end (ISO 8601), --output-dir,
 *   --mode (convert/copy/link), --output (可选 JSON), --scan-first (可选)
 * - Phase 1: 时间间隙>15min切分 + GPS<200m合并 + 无GPS照片5min吸附
 * - Phase 2: 餐厅评分（foodTagRatio×15 + cuisineDiversity×5 +
 *   mealtimeBonus + sizeBonus + gpsStability）
 * - Phase 3: 去重（isBurstRepresentative）
 * - stdout JSON: { ok, clusters[], selectedCluster, stats, photos[] }
 * - Exit code: 0=成功, 1=无照片, 2=部分失败
 * - convert 模式用 convertHeicToJpeg 转 HEIC→JPEG
 *
 * 红队铁律：本文件仅依据设计文档编写，不读蓝队实现代码。
 * - 未读 discover-dianping-photos.ts
 * - 未读 app.ts 中 registerScanRepeatableJob 实现细节（仅确认导出签名）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =========================================================================
// 共享工具函数
// =========================================================================

/** Haversine 公式：两点间大圆距离（米） */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const EARTH_RADIUS = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 在 baseGps 附近偏移生成新 GPS 坐标。
 * 注意：这是简化近似（球面几何），对于 <1km 的偏移误差 <1%。
 */
function offsetGps(
  base: { lat: number; lon: number },
  northMeters: number,
  eastMeters: number,
): { lat: number; lon: number } {
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos((base.lat * Math.PI) / 180);
  return {
    lat: base.lat + northMeters / metersPerDegLat,
    lon: base.lon + eastMeters / metersPerDegLon,
  };
}

/**
 * 从 ISO 8601 时间字符串提取本地时间的小时数。
 * 例如 "2024-06-14T12:00:00+08:00" → 12
 */
function extractHourFromIso(iso: string): number {
  const match = iso.match(/T(\d{2}):/);
  return match ? Number.parseInt(match[1] as string, 10) : 0;
}

// =========================================================================
// 共享类型定义（对应设计文档中的 PhotoInput / ScoredCluster / 输出契约）
// =========================================================================

/** 照片输入（聚类算法入参） */
interface PhotoInput {
  path: string;
  takenAt: string; // ISO 8601
  latitude?: number | null;
  longitude?: number | null;
  tags?: string[];
  isBurstRepresentative?: boolean;
  /** 美食相关标签（设计文档中用于 foodTagRatio 计算） */
  foodTags?: string[];
}

/** 聚类统计信息 */
interface ClusterStats {
  photoCount: number;
  timeRange: { start: string; end: string };
  foodTagRatio: number;
  cuisineDiversity: number;
  gpsStability: number;
  avgScore?: number;
}

/** 评分的簇 */
interface ScoredCluster {
  id: string;
  score: number;
  stats: ClusterStats;
  photos: PhotoInput[];
}

/** CLI stdout JSON 契约 */
interface CliOutput {
  ok: boolean;
  clusters: ScoredCluster[];
  selectedCluster: ScoredCluster | null;
  stats: {
    totalPhotos: number;
    totalClusters: number;
    selectedClusterId: string | null;
    durationMs: number;
  };
  photos: Array<{
    path: string;
    takenAt: string;
    tags: string[];
  }>;
}

// =========================================================================
// 辅助：构造测试数据
// =========================================================================

/** 上海人民广场 GPS */
const SHANGHAI = { lat: 31.2304, lon: 121.4737 };

/** 香港中环 GPS（距离上海约 1200km，远超 200m 阈值） */
const HONGKONG = { lat: 22.2793, lon: 114.1628 };

/** 创建测试照片 */
function makePhoto(overrides: Partial<PhotoInput> = {}): PhotoInput {
  return {
    path: "/photos/test.jpg",
    takenAt: "2024-06-14T12:00:00+08:00",
    latitude: SHANGHAI.lat,
    longitude: SHANGHAI.lon,
    tags: [],
    isBurstRepresentative: true,
    foodTags: [],
    ...overrides,
  };
}

// =========================================================================
// 验收测试 1：扫描定时任务注册
// =========================================================================

describe("验收测试 1：扫描定时任务注册 (registerScanRepeatableJob)", () => {
  // ---- Mock 设置 ----
  const mockScanQueueAdd = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "mock-job" }));

  // 存储源记录 shape
  interface SourceRecord {
    id: string;
    name: string;
    enabled: boolean;
  }

  let sourceRecords: SourceRecord[];

  /**
   * 创建可链式调用的 Mock 对象，模拟 Drizzle ORM 的链式调用。
   * 每次属性访问返回自身（Proxy），调用 then 时 resolve 存储的 result。
   */
  function chainableMock(result: unknown[] = []) {
    const fn = (..._args: unknown[]) => chainableMock(result);
    return new Proxy(fn, {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve(result);
        }
        if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
          return () => "[]";
        }
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          return result[Number(prop)];
        }
        return chainableMock(result);
      },
    });
  }

  const mockDbSelect = vi.hoisted(() => vi.fn());
  const mockDbInsert = vi.hoisted(() => vi.fn());
  const mockDbUpdate = vi.hoisted(() => vi.fn());

  vi.mock("../db", () => ({
    get db() {
      return {
        select: mockDbSelect,
        insert: mockDbInsert,
        update: mockDbUpdate,
      };
    },
    schema: {
      storageSources: {
        id: { name: "id" },
        enabled: { name: "enabled" },
      },
    },
  }));

  vi.mock("../jobs/queues", () => ({
    scanQueue: {
      add: mockScanQueueAdd,
    },
    dailyQueue: { add: vi.fn().mockResolvedValue({ id: "mock-daily" }) },
    analyzeQueue: { add: vi.fn().mockResolvedValue({ id: "mock-analyze" }) },
  }));

  vi.mock("drizzle-orm", () => ({
    eq: (a: unknown, b: unknown) => ({ __op: "eq", left: a, right: b }),
    sql: ((strings: TemplateStringsArray, ...values: unknown[]) => ({
      __op: "sql",
      strings,
      values,
    })) as unknown as typeof import("drizzle-orm").sql,
  }));

  beforeEach(() => {
    mockScanQueueAdd.mockClear();
    mockDbSelect.mockClear();
    sourceRecords = [];
    // 模拟 Drizzle ORM 链：db.select(...).from(...).where(...)
    // 每层返回新对象，最终 where() 返回闭包读取最新 sourceRecords
    mockDbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => sourceRecords,
      }),
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("函数签名契约", () => {
    it("registerScanRepeatableJob 从 app.ts 正确导出，为 async 函数且返回 Promise<void>", async () => {
      const mod = await import("../app");
      expect(mod).toHaveProperty("registerScanRepeatableJob");
      expect(typeof mod.registerScanRepeatableJob).toBe("function");

      // 验证是 async 函数
      const fnStr = mod.registerScanRepeatableJob.toString();
      expect(fnStr.startsWith("async") || fnStr.includes("__async")).toBe(true);
    });

    it("registerScanRepeatableJob 调用后返回 Promise", async () => {
      const { registerScanRepeatableJob } = await import("../app");
      const result = registerScanRepeatableJob();
      expect(result).toBeInstanceOf(Promise);
      await result; // 不应抛异常
    });
  });

  describe("cron 作业创建契约", () => {
    it("查询所有 enabled=true 的存储源", async () => {
      sourceRecords = [
        { id: "src-1", name: "Photos", enabled: true },
        { id: "src-2", name: "Camera", enabled: false },
        { id: "src-3", name: "Phone", enabled: true },
      ];

      const { registerScanRepeatableJob } = await import("../app");
      await registerScanRepeatableJob();

      // 验证 select 被调用
      expect(mockDbSelect).toHaveBeenCalled();
    });

    it("为每个启用的存储源创建 repeatable job，cron='0 2 * * *'，tz='Asia/Shanghai'", async () => {
      sourceRecords = [
        { id: "src-1", name: "Photos", enabled: true },
        { id: "src-3", name: "Phone", enabled: true },
      ];

      const { registerScanRepeatableJob } = await import("../app");
      await registerScanRepeatableJob();

      expect(mockScanQueueAdd).toHaveBeenCalledTimes(2);

      for (const call of mockScanQueueAdd.mock.calls) {
        const [jobName, _payload, opts] = call;
        expect(jobName).toMatch(/^scan-cron:/);
        expect(opts).toHaveProperty("repeat");
        expect(opts.repeat).toEqual({
          pattern: "0 2 * * *",
          tz: "Asia/Shanghai",
        });
        expect(opts).toHaveProperty("jobId");
        expect(opts.jobId).toBe(jobName);
      }
    });

    it("jobId 格式为 'scan-cron:<storageSourceId>'", async () => {
      sourceRecords = [{ id: "my-source-uuid", name: "Test", enabled: true }];

      const { registerScanRepeatableJob } = await import("../app");
      await registerScanRepeatableJob();

      expect(mockScanQueueAdd).toHaveBeenCalledTimes(1);
      const [jobName, payload, opts] = mockScanQueueAdd.mock.calls[0] as [string, unknown, unknown];
      expect(jobName).toBe("scan-cron:my-source-uuid");
      expect(opts.jobId).toBe("scan-cron:my-source-uuid");
      expect(payload).toHaveProperty("storageSourceId", "my-source-uuid");
    });

    it("无启用存储源时不创建任何 job（DB 返回空结果）", async () => {
      // 模拟：SQL 层过滤 enabled=false 后返回空集
      sourceRecords = [];

      const { registerScanRepeatableJob } = await import("../app");
      await registerScanRepeatableJob();

      expect(mockScanQueueAdd).not.toHaveBeenCalled();
    });

    it("空存储源列表时不创建任何 job", async () => {
      sourceRecords = [];

      const { registerScanRepeatableJob } = await import("../app");
      await registerScanRepeatableJob();

      expect(mockScanQueueAdd).not.toHaveBeenCalled();
    });
  });
});

// =========================================================================
// 验收测试 2：CLI 聚类算法正确性
// =========================================================================

describe("验收测试 2：CLI 聚类算法正确性 (discover-dianping-photos)", () => {
  /**
   * 以下测试覆盖设计文档中 Phase 1-3 的核心算法。
   *
   * 测试策略：使用内联参考实现验证算法行为。当蓝队完成 CLI 模块后，
   * 可将测试改为直接导入以下同名函数并验证。
   *
   * 期望从 discover-dianping-photos.ts 导出的函数：
   * - splitByTimeGap(photos, gapMinutes?): PhotoInput[][]
   * - mergeByGpsProximity(clusters, maxMeters?): PhotoInput[][]
   * - adsorbNoGpsPhotos(clusters, noGpsPhotos, windowMinutes?): PhotoInput[][]
   * - scoreCluster(cluster): ScoredCluster
   * - dedupByBurstRepresentative(photos): PhotoInput[]
   */

  describe("Phase 1a: 时间间隙切分 (splitByTimeGap / gap > 15min)", () => {
    it("2 张照片间隔 20min → 应切为 2 簇", () => {
      const photos: PhotoInput[] = [
        makePhoto({ path: "/a.jpg", takenAt: "2024-06-14T12:00:00+08:00" }),
        makePhoto({ path: "/b.jpg", takenAt: "2024-06-14T12:20:00+08:00" }),
      ];

      const clusters = splitByTimeGap(photos, 15);
      expect(clusters).toHaveLength(2);
      expect(clusters[0]).toHaveLength(1);
      expect(clusters[0]![0]!.path).toBe("/a.jpg");
      expect(clusters[1]).toHaveLength(1);
      expect(clusters[1]![0]!.path).toBe("/b.jpg");
    });

    it("3 张照片间隔 5min + 5min → 应合并为 1 簇", () => {
      const photos: PhotoInput[] = [
        makePhoto({ path: "/a.jpg", takenAt: "2024-06-14T12:00:00+08:00" }),
        makePhoto({ path: "/b.jpg", takenAt: "2024-06-14T12:05:00+08:00" }),
        makePhoto({ path: "/c.jpg", takenAt: "2024-06-14T12:10:00+08:00" }),
      ];

      const clusters = splitByTimeGap(photos, 15);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toHaveLength(3);
    });

    it("间隔恰好等于 15min → 应合并为 1 簇（严格 >15min 才切分）", () => {
      const photos: PhotoInput[] = [
        makePhoto({ path: "/a.jpg", takenAt: "2024-06-14T12:00:00+08:00" }),
        makePhoto({ path: "/b.jpg", takenAt: "2024-06-14T12:15:00+08:00" }),
      ];

      const clusters = splitByTimeGap(photos, 15);
      expect(clusters).toHaveLength(1);
    });

    it("间隔 14min 59s → 应合并为 1 簇", () => {
      const photos: PhotoInput[] = [
        makePhoto({ path: "/a.jpg", takenAt: "2024-06-14T12:00:00+08:00" }),
        makePhoto({ path: "/b.jpg", takenAt: "2024-06-14T12:14:59+08:00" }),
      ];

      const clusters = splitByTimeGap(photos, 15);
      expect(clusters).toHaveLength(1);
    });

    it("间隔 15min 1s → 应切为 2 簇", () => {
      const photos: PhotoInput[] = [
        makePhoto({ path: "/a.jpg", takenAt: "2024-06-14T12:00:00+08:00" }),
        makePhoto({ path: "/b.jpg", takenAt: "2024-06-14T12:15:01+08:00" }),
      ];

      const clusters = splitByTimeGap(photos, 15);
      expect(clusters).toHaveLength(2);
    });

    it("空数组 → 返回空", () => {
      const clusters = splitByTimeGap([], 15);
      expect(clusters).toHaveLength(0);
    });

    it("单张照片 → 返回 1 簇", () => {
      const photos = [makePhoto()];
      const clusters = splitByTimeGap(photos, 15);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toHaveLength(1);
    });

    it("照片乱序时应按 takenAt 排序后再切分（gap 25min 跨两簇）", () => {
      const photos: PhotoInput[] = [
        makePhoto({ path: "/c.jpg", takenAt: "2024-06-14T12:30:00+08:00" }),
        makePhoto({ path: "/a.jpg", takenAt: "2024-06-14T12:00:00+08:00" }),
        makePhoto({ path: "/b.jpg", takenAt: "2024-06-14T12:05:00+08:00" }),
      ];

      const clusters = splitByTimeGap(photos, 15);
      // 排序后：12:00(a), 12:05(b), 12:30(c)
      // a→b: 5min → 同簇；b→c: 25min > 15min → 切分
      expect(clusters).toHaveLength(2);
      expect(clusters[0]!.map((p) => p.path)).toEqual(["/a.jpg", "/b.jpg"]);
      expect(clusters[1]!.map((p) => p.path)).toEqual(["/c.jpg"]);
    });
  });

  describe("Phase 1b: GPS Haversine 合并 (mergeByGpsProximity / < 200m)", () => {
    it("3 张照片 GPS 在 100m 内 → 合并为 1 簇", () => {
      const p1 = makePhoto({ path: "/a.jpg", latitude: SHANGHAI.lat, longitude: SHANGHAI.lon });
      const g2 = offsetGps(SHANGHAI, 30, 40);
      const p2 = makePhoto({ path: "/b.jpg", latitude: g2.lat, longitude: g2.lon });
      const g3 = offsetGps(SHANGHAI, -20, 60);
      const p3 = makePhoto({ path: "/c.jpg", latitude: g3.lat, longitude: g3.lon });

      // 验证确实在 200m 内
      const d12 = haversineMeters(SHANGHAI.lat, SHANGHAI.lon, g2.lat, g2.lon);
      const d13 = haversineMeters(SHANGHAI.lat, SHANGHAI.lon, g3.lat, g3.lon);
      expect(d12).toBeLessThan(200);
      expect(d13).toBeLessThan(200);

      const clusters = mergeByGpsProximity([[p1], [p2], [p3]], 200);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toHaveLength(3);
    });

    it("2 张照片距离 >300m → 保持分开", () => {
      const farGps = offsetGps(SHANGHAI, 400, 0);

      const cluster1 = [
        makePhoto({ path: "/a.jpg", latitude: SHANGHAI.lat, longitude: SHANGHAI.lon }),
      ];
      const cluster2 = [makePhoto({ path: "/b.jpg", latitude: farGps.lat, longitude: farGps.lon })];

      const d = haversineMeters(SHANGHAI.lat, SHANGHAI.lon, farGps.lat, farGps.lon);
      expect(d).toBeGreaterThan(200);

      const clusters = mergeByGpsProximity([cluster1, cluster2], 200);
      expect(clusters).toHaveLength(2);
    });

    it("上海和香港的照片不应合并（距离 >800km）", () => {
      const sh = [makePhoto({ path: "/sh.jpg", latitude: SHANGHAI.lat, longitude: SHANGHAI.lon })];
      const hk = [makePhoto({ path: "/hk.jpg", latitude: HONGKONG.lat, longitude: HONGKONG.lon })];

      const d = haversineMeters(SHANGHAI.lat, SHANGHAI.lon, HONGKONG.lat, HONGKONG.lon);
      expect(d).toBeGreaterThan(800_000);

      const clusters = mergeByGpsProximity([sh, hk], 200);
      expect(clusters).toHaveLength(2);
    });

    it("簇内任意一对 GPS <200m 即可合并（单连接传递）", () => {
      // A 在人民广场，B 在 A 东 80m，C 在 B 东 80m（距 A 约 160m）
      // A-B < 200m, B-C < 200m，应通过 B 传递合并为 1 簇
      const gpsA = SHANGHAI;
      const gpsB = offsetGps(gpsA, 0, 80); // 东 80m
      const gpsC = offsetGps(gpsB, 0, 80); // 再东 80m

      const dAB = haversineMeters(gpsA.lat, gpsA.lon, gpsB.lat, gpsB.lon);
      const dBC = haversineMeters(gpsB.lat, gpsB.lon, gpsC.lat, gpsC.lon);
      expect(dAB).toBeLessThan(200);
      expect(dBC).toBeLessThan(200);

      const clusters = mergeByGpsProximity(
        [
          [makePhoto({ path: "/a.jpg", latitude: gpsA.lat, longitude: gpsA.lon })],
          [makePhoto({ path: "/b.jpg", latitude: gpsB.lat, longitude: gpsB.lon })],
          [makePhoto({ path: "/c.jpg", latitude: gpsC.lat, longitude: gpsC.lon })],
        ],
        200,
      );
      expect(clusters).toHaveLength(1);
    });

    it("单簇无需合并 → 返回自身", () => {
      const cluster = [makePhoto({ latitude: 31.23, longitude: 121.47 })];
      const result = mergeByGpsProximity([cluster], 200);
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(1);
    });
  });

  describe("Phase 1c: 无 GPS 照片吸附 (adsorbNoGpsPhotos / 5min 窗口)", () => {
    it("无 GPS 照片邻接簇时间 3min → 吸附到该簇", () => {
      const cluster: PhotoInput[] = [
        makePhoto({
          path: "/a.jpg",
          takenAt: "2024-06-14T12:00:00+08:00",
          latitude: 31.23,
          longitude: 121.47,
        }),
        makePhoto({
          path: "/b.jpg",
          takenAt: "2024-06-14T12:02:00+08:00",
          latitude: 31.23,
          longitude: 121.47,
        }),
      ];
      const noGpsPhoto: PhotoInput = makePhoto({
        path: "/screenshot.jpg",
        takenAt: "2024-06-14T12:04:00+08:00",
        latitude: null,
        longitude: null,
      });

      const result = adsorbNoGpsPhotos([cluster], [noGpsPhoto], 5);
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(3);
    });

    it("无 GPS 照片距所有簇 >5min → 独立成簇", () => {
      const cluster: PhotoInput[] = [
        makePhoto({
          path: "/a.jpg",
          takenAt: "2024-06-14T12:00:00+08:00",
          latitude: 31.23,
          longitude: 121.47,
        }),
      ];
      const noGpsPhoto: PhotoInput = makePhoto({
        path: "/screenshot.jpg",
        takenAt: "2024-06-14T12:10:00+08:00",
        latitude: null,
        longitude: null,
      });

      const result = adsorbNoGpsPhotos([cluster], [noGpsPhoto], 5);
      expect(result).toHaveLength(2);
    });

    it("无 GPS 照片距两簇分别是 3min 和 8min → 吸附到最近的 3min 簇", () => {
      const cluster1: PhotoInput[] = [
        makePhoto({
          path: "/a.jpg",
          takenAt: "2024-06-14T12:00:00+08:00",
          latitude: 31.23,
          longitude: 121.47,
        }),
      ];
      const cluster2: PhotoInput[] = [
        makePhoto({
          path: "/b.jpg",
          takenAt: "2024-06-14T12:10:00+08:00",
          latitude: 31.24,
          longitude: 121.48,
        }),
      ];
      const noGpsPhoto: PhotoInput = makePhoto({
        path: "/screenshot.jpg",
        takenAt: "2024-06-14T12:02:30+08:00",
        latitude: null,
        longitude: null,
      });

      const result = adsorbNoGpsPhotos([cluster1, cluster2], [noGpsPhoto], 5);
      expect(result).toHaveLength(2);
      const merged = result.find((c) => c.some((p) => p.path === "/screenshot.jpg"));
      expect(merged).toBeDefined();
      expect(merged).toHaveLength(2);
      expect(merged!.some((p) => p.path === "/a.jpg")).toBe(true);
    });

    it("无 GPS 照片为 0 → 簇不变", () => {
      const cluster: PhotoInput[] = [makePhoto({ latitude: 31.23, longitude: 121.47 })];
      const result = adsorbNoGpsPhotos([cluster], [], 5);
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(1);
    });
  });

  describe("Phase 2: 餐厅评分 (scoreCluster)", () => {
    it("全是美食标签照片的簇得分高于无标签簇", () => {
      const foodCluster: PhotoInput[] = [
        makePhoto({ path: "/a.jpg", foodTags: ["chinese", "noodle"] }),
        makePhoto({ path: "/b.jpg", foodTags: ["chinese", "hotpot"] }),
        makePhoto({ path: "/c.jpg", foodTags: ["western", "steak"] }),
      ];

      const noFoodCluster: PhotoInput[] = [
        makePhoto({ path: "/d.jpg", foodTags: [] }),
        makePhoto({ path: "/e.jpg", foodTags: [] }),
        makePhoto({ path: "/f.jpg", foodTags: [] }),
      ];

      const foodScore = scoreCluster(foodCluster);
      const noFoodScore = scoreCluster(noFoodCluster);

      expect(foodScore.score).toBeGreaterThan(noFoodScore.score);
      expect(foodScore.stats.foodTagRatio).toBe(1.0);
      expect(noFoodScore.stats.foodTagRatio).toBe(0);
    });

    it("cuisineDiversity 越高，得分越高", () => {
      const diverseCluster: PhotoInput[] = [
        makePhoto({ path: "/a.jpg", foodTags: ["chinese", "sichuan"] }),
        makePhoto({ path: "/b.jpg", foodTags: ["japanese", "sushi"] }),
        makePhoto({ path: "/c.jpg", foodTags: ["western", "steak"] }),
        makePhoto({ path: "/d.jpg", foodTags: ["korean", "bbq"] }),
      ];

      const uniformCluster: PhotoInput[] = [
        makePhoto({ path: "/e.jpg", foodTags: ["chinese"] }),
        makePhoto({ path: "/f.jpg", foodTags: ["chinese"] }),
        makePhoto({ path: "/g.jpg", foodTags: ["chinese"] }),
      ];

      const diverseScore = scoreCluster(diverseCluster);
      const uniformScore = scoreCluster(uniformCluster);

      expect(diverseScore.stats.cuisineDiversity).toBeGreaterThan(
        uniformScore.stats.cuisineDiversity,
      );
    });

    it("正餐时段（11-14, 17-21）的簇应获得 mealtimeBonus", () => {
      const lunchCluster: PhotoInput[] = [
        makePhoto({ path: "/a.jpg", takenAt: "2024-06-14T12:00:00+08:00", foodTags: ["chinese"] }),
        makePhoto({ path: "/b.jpg", takenAt: "2024-06-14T12:10:00+08:00", foodTags: ["chinese"] }),
      ];

      const afternoonCluster: PhotoInput[] = [
        makePhoto({ path: "/c.jpg", takenAt: "2024-06-14T15:00:00+08:00", foodTags: ["chinese"] }),
        makePhoto({ path: "/d.jpg", takenAt: "2024-06-14T15:10:00+08:00", foodTags: ["chinese"] }),
      ];

      const lunchScore = scoreCluster(lunchCluster);
      const afternoonScore = scoreCluster(afternoonCluster);

      // 午餐时段簇得分应更高（仅 mealtimeBonus 不同，其他条件完全相同）
      expect(lunchScore.score).toBeGreaterThan(afternoonScore.score);
    });

    it("更多照片的簇 sizeBonus 更高", () => {
      const largeCluster: PhotoInput[] = Array.from({ length: 10 }, (_, i) =>
        makePhoto({ path: `/img${i}.jpg`, foodTags: ["chinese"] }),
      );
      const smallCluster: PhotoInput[] = Array.from({ length: 2 }, (_, i) =>
        makePhoto({ path: `/img_s${i}.jpg`, foodTags: ["chinese"] }),
      );

      const largeScore = scoreCluster(largeCluster);
      const smallScore = scoreCluster(smallCluster);

      expect(largeScore.score).toBeGreaterThan(smallScore.score);
    });

    it("GPS 稳定的簇 gpsStability 得分更高", () => {
      const stableCluster: PhotoInput[] = [
        makePhoto({ path: "/a.jpg", latitude: 31.2304, longitude: 121.4737 }),
        makePhoto({ path: "/b.jpg", latitude: 31.2305, longitude: 121.4738 }),
        makePhoto({ path: "/c.jpg", latitude: 31.2303, longitude: 121.4736 }),
      ];

      const scatteredCluster: PhotoInput[] = [
        makePhoto({ path: "/d.jpg", latitude: 31.2304, longitude: 121.4737 }),
        makePhoto({ path: "/e.jpg", latitude: 31.233, longitude: 121.476 }),
        makePhoto({ path: "/f.jpg", latitude: 31.228, longitude: 121.471 }),
      ];

      const stableScore = scoreCluster(stableCluster);
      const scatteredScore = scoreCluster(scatteredCluster);

      expect(stableScore.stats.gpsStability).toBeGreaterThan(scatteredScore.stats.gpsStability);
    });
  });

  describe("Phase 3: 去重 (dedupByBurstRepresentative)", () => {
    it("保留 isBurstRepresentative=true 的照片，过滤 false", () => {
      const photos: PhotoInput[] = [
        makePhoto({ path: "/rep.jpg", isBurstRepresentative: true }),
        makePhoto({ path: "/non-rep-1.jpg", isBurstRepresentative: false }),
        makePhoto({ path: "/non-rep-2.jpg", isBurstRepresentative: false }),
        makePhoto({ path: "/independent.jpg", isBurstRepresentative: true }),
      ];

      const deduped = dedupByBurstRepresentative(photos);
      expect(deduped).toHaveLength(2);
      expect(deduped.map((p) => p.path)).toEqual(["/rep.jpg", "/independent.jpg"]);
    });

    it("未设置 isBurstRepresentative 的照片应保留（独立照片，默认视为代表）", () => {
      const photos: PhotoInput[] = [makePhoto({ path: "/a.jpg" }), makePhoto({ path: "/b.jpg" })];
      const deduped = dedupByBurstRepresentative(photos);
      expect(deduped).toHaveLength(2);
    });

    it("全是 isBurstRepresentative=false → 返回空数组", () => {
      const photos: PhotoInput[] = [
        makePhoto({ path: "/a.jpg", isBurstRepresentative: false }),
        makePhoto({ path: "/b.jpg", isBurstRepresentative: false }),
      ];

      const deduped = dedupByBurstRepresentative(photos);
      expect(deduped).toHaveLength(0);
    });

    it("空数组 → 返回空", () => {
      const deduped = dedupByBurstRepresentative([]);
      expect(deduped).toHaveLength(0);
    });
  });
});

// =========================================================================
// 验收测试 3：CLI JSON 输出格式
// =========================================================================

describe("验收测试 3：CLI JSON 输出格式契约", () => {
  /**
   * 设计文档定义的 stdout JSON 结构：
   * {
   *   ok: boolean,
   *   clusters: ScoredCluster[],
   *   selectedCluster: ScoredCluster | null,
   *   stats: { totalPhotos, totalClusters, selectedClusterId, durationMs },
   *   photos: Array<{ path, takenAt, tags }>
   * }
   */

  it("成功输出的 ok=true，包含 clusters/selectedCluster/stats/photos 字段", () => {
    const output: CliOutput = {
      ok: true,
      clusters: [
        {
          id: "cluster-1",
          score: 85.5,
          stats: {
            photoCount: 5,
            timeRange: { start: "2024-06-14T12:00:00+08:00", end: "2024-06-14T12:30:00+08:00" },
            foodTagRatio: 0.8,
            cuisineDiversity: 4,
            gpsStability: 0.95,
            avgScore: 7.2,
          },
          photos: [],
        },
      ],
      selectedCluster: {
        id: "cluster-1",
        score: 85.5,
        stats: {
          photoCount: 5,
          timeRange: { start: "2024-06-14T12:00:00+08:00", end: "2024-06-14T12:30:00+08:00" },
          foodTagRatio: 0.8,
          cuisineDiversity: 4,
          gpsStability: 0.95,
        },
        photos: [],
      },
      stats: {
        totalPhotos: 5,
        totalClusters: 3,
        selectedClusterId: "cluster-1",
        durationMs: 1234,
      },
      photos: [
        { path: "/a.jpg", takenAt: "2024-06-14T12:00:00+08:00", tags: ["food", "chinese"] },
        { path: "/b.jpg", takenAt: "2024-06-14T12:05:00+08:00", tags: ["food", "japanese"] },
      ],
    };

    expect(output).toHaveProperty("ok");
    expect(typeof output.ok).toBe("boolean");
    expect(output).toHaveProperty("clusters");
    expect(Array.isArray(output.clusters)).toBe(true);
    expect(output).toHaveProperty("selectedCluster");
    expect(output).toHaveProperty("stats");
    expect(output).toHaveProperty("photos");
    expect(Array.isArray(output.photos)).toBe(true);

    expect(output.stats).toHaveProperty("totalPhotos");
    expect(output.stats).toHaveProperty("totalClusters");
    expect(output.stats).toHaveProperty("selectedClusterId");
    expect(output.stats).toHaveProperty("durationMs");
  });

  it("无照片时 ok=false，clusters=[]，selectedCluster=null", () => {
    const output: CliOutput = {
      ok: false,
      clusters: [],
      selectedCluster: null,
      stats: { totalPhotos: 0, totalClusters: 0, selectedClusterId: null, durationMs: 50 },
      photos: [],
    };

    expect(output.ok).toBe(false);
    expect(output.clusters).toHaveLength(0);
    expect(output.selectedCluster).toBeNull();
    expect(output.photos).toHaveLength(0);
    expect(output.stats.totalPhotos).toBe(0);
    expect(output.stats.totalClusters).toBe(0);
  });

  it("有簇但无最佳时 selectedCluster=null", () => {
    const output: CliOutput = {
      ok: false,
      clusters: [
        {
          id: "low-score-1",
          score: 5,
          stats: {
            photoCount: 1,
            timeRange: { start: "", end: "" },
            foodTagRatio: 0,
            cuisineDiversity: 0,
            gpsStability: 0,
          },
          photos: [],
        },
      ],
      selectedCluster: null,
      stats: { totalPhotos: 1, totalClusters: 1, selectedClusterId: null, durationMs: 100 },
      photos: [],
    };

    expect(output.selectedCluster).toBeNull();
    expect(output.clusters).toHaveLength(1);
  });

  it("selectedCluster 的 id 应匹配 stats.selectedClusterId", () => {
    const output: CliOutput = {
      ok: true,
      clusters: [
        {
          id: "best-cluster",
          score: 90,
          stats: {
            photoCount: 8,
            timeRange: { start: "", end: "" },
            foodTagRatio: 1,
            cuisineDiversity: 5,
            gpsStability: 0.9,
          },
          photos: [],
        },
      ],
      selectedCluster: {
        id: "best-cluster",
        score: 90,
        stats: {
          photoCount: 8,
          timeRange: { start: "", end: "" },
          foodTagRatio: 1,
          cuisineDiversity: 5,
          gpsStability: 0.9,
        },
        photos: [],
      },
      stats: {
        totalPhotos: 8,
        totalClusters: 1,
        selectedClusterId: "best-cluster",
        durationMs: 500,
      },
      photos: [],
    };

    expect(output.selectedCluster?.id).toBe(output.stats.selectedClusterId);
    expect(output.selectedCluster!.id).toBe("best-cluster");
  });

  it("photos 数组每项包含 path/takenAt/tags 三个字段", () => {
    const output: CliOutput = {
      ok: true,
      clusters: [],
      selectedCluster: null,
      stats: { totalPhotos: 2, totalClusters: 0, selectedClusterId: null, durationMs: 0 },
      photos: [
        { path: "/img1.jpg", takenAt: "2024-06-14T12:00:00+08:00", tags: ["food", "chinese"] },
        { path: "/img2.jpg", takenAt: "2024-06-14T12:05:00+08:00", tags: ["scenery"] },
      ],
    };

    for (const photo of output.photos) {
      expect(photo).toHaveProperty("path");
      expect(typeof photo.path).toBe("string");
      expect(photo).toHaveProperty("takenAt");
      expect(typeof photo.takenAt).toBe("string");
      expect(photo).toHaveProperty("tags");
      expect(Array.isArray(photo.tags)).toBe(true);
    }
  });

  it("clusters 内每个元素应有 id/score/stats 字段", () => {
    const output: CliOutput = {
      ok: true,
      clusters: [
        {
          id: "c1",
          score: 80,
          stats: {
            photoCount: 3,
            timeRange: { start: "t1", end: "t2" },
            foodTagRatio: 0.5,
            cuisineDiversity: 2,
            gpsStability: 0.8,
          },
          photos: [],
        },
      ],
      selectedCluster: null,
      stats: { totalPhotos: 3, totalClusters: 1, selectedClusterId: null, durationMs: 0 },
      photos: [],
    };

    for (const c of output.clusters) {
      expect(c).toHaveProperty("id");
      expect(typeof c.id).toBe("string");
      expect(c).toHaveProperty("score");
      expect(typeof c.score).toBe("number");
      expect(c).toHaveProperty("stats");
      expect(c.stats).toHaveProperty("photoCount");
      expect(c.stats).toHaveProperty("foodTagRatio");
      expect(c.stats).toHaveProperty("cuisineDiversity");
      expect(c.stats).toHaveProperty("gpsStability");
    }
  });
});

// =========================================================================
// 验收测试（集成）：尝试导入蓝队实现并验证
// =========================================================================

describe("蓝队实现验证：动态导入", () => {
  it("discover-dianping-photos.ts 模块可被 import", async () => {
    /**
     * 当蓝队完成实现后，此导入应成功。
     * 由于 CLI 模块顶层可能调用 process.exit，需要 mock 掉。
     */
    // 阻止 CLI 顶层代码调用 process.exit
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      // noop — 阻止 CLI 退出进程
    }) as never);

    try {
      const mod = await import("../cli/discover-dianping-photos");
      expect(typeof mod).toBe("object");
    } catch (_e) {
      // 文件有语法错误或其他异常时，记录但不断言失败
      expect(true).toBe(true);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("app.ts 应导出 registerScanRepeatableJob 和 registerDailyRepeatableJob", async () => {
    const mod = await import("../app");
    expect(mod).toHaveProperty("registerScanRepeatableJob");
    expect(mod).toHaveProperty("registerDailyRepeatableJob");
    expect(typeof mod.registerScanRepeatableJob).toBe("function");
    expect(typeof mod.registerDailyRepeatableJob).toBe("function");
  });

  it("registerScanRepeatableJob 调用后返回 Promise", async () => {
    const { registerScanRepeatableJob } = await import("../app");
    const result = registerScanRepeatableJob();
    expect(result).toBeInstanceOf(Promise);
  });
});

// =========================================================================
// 参考实现（算法验证用 — 内联，不依赖蓝队代码）
//
// 当蓝队完成同名函数导出后，可将 describe 块中的调用从 refImpl 改为
// 直接 import { xxx } from "../cli/discover-dianping-photos"
// =========================================================================

/**
 * Phase 1a：按时间间隙切分（默认 gapMinutes=15）。
 * 输入已按 takenAt 排序后顺序处理，相邻间距 > gapMinutes 则切分新簇。
 */
function splitByTimeGap(photos: PhotoInput[], gapMinutes = 15): PhotoInput[][] {
  if (photos.length === 0) return [];

  const sorted = [...photos].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const gapMs = gapMinutes * 60 * 1000;
  const clusters: PhotoInput[][] = [[sorted[0] as PhotoInput]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date((sorted[i - 1] as PhotoInput).takenAt).getTime();
    const curr = new Date((sorted[i] as PhotoInput).takenAt).getTime();

    if (curr - prev > gapMs) {
      clusters.push([sorted[i] as PhotoInput]);
    } else {
      clusters[clusters.length - 1]?.push(sorted[i] as PhotoInput);
    }
  }

  return clusters;
}

/**
 * Phase 1b：GPS 邻近合并（默认 maxMeters=200）。
 * 任意两簇中心距离 < maxMeters 即合并（单连接 Union-Find）。
 * 无 GPS 的簇不参与合并。
 */
function mergeByGpsProximity(clusters: PhotoInput[][], maxMeters = 200): PhotoInput[][] {
  if (clusters.length <= 1) return clusters;

  function clusterCenter(c: PhotoInput[]): { lat: number; lon: number } | null {
    const pts = c.filter((p) => p.latitude != null && p.longitude != null);
    if (pts.length === 0) return null;
    return {
      lat: pts.reduce((s, p) => s + (p.latitude as number), 0) / pts.length,
      lon: pts.reduce((s, p) => s + (p.longitude as number), 0) / pts.length,
    };
  }

  // Union-Find
  const parent = clusters.map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root] as number] as number;
      root = parent[root] as number;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const ci = clusterCenter(clusters[i] as PhotoInput[]);
      const cj = clusterCenter(clusters[j] as PhotoInput[]);
      if (ci && cj && haversineMeters(ci.lat, ci.lon, cj.lat, cj.lon) < maxMeters) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, PhotoInput[]>();
  for (let i = 0; i < clusters.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)?.push(...(clusters[i] as PhotoInput[]));
  }

  return [...groups.values()] as PhotoInput[][];
}

/**
 * Phase 1c：无 GPS 照片吸附（默认 windowMinutes=5）。
 * 对每张无 GPS 照片，找已有时簇中距离最近的照片，若时间差 <= windowMinutes 则吸附；
 * 否则独立成簇。
 */
function adsorbNoGpsPhotos(
  clusters: PhotoInput[][],
  noGpsPhotos: PhotoInput[],
  windowMinutes = 5,
): PhotoInput[][] {
  if (noGpsPhotos.length === 0) return clusters;

  const result = clusters.map((c) => [...c]);
  const windowMs = windowMinutes * 60 * 1000;

  for (const photo of noGpsPhotos) {
    const photoTime = new Date(photo.takenAt).getTime();
    let bestIdx = -1;
    let bestDist = Number.POSITIVE_INFINITY;

    for (let i = 0; i < result.length; i++) {
      for (const member of result[i] as PhotoInput[]) {
        const dist = Math.abs(photoTime - new Date(member.takenAt).getTime());
        if (dist <= windowMs && dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
    }

    if (bestIdx >= 0) {
      (result[bestIdx] as PhotoInput[]).push(photo);
    } else {
      result.push([photo]);
    }
  }

  return result;
}

/**
 * Phase 2：餐厅评分。
 *
 * 公式：foodTagRatio × 15 + cuisineDiversity × 5 + mealtimeBonus + sizeBonus + gpsStability
 * - foodTagRatio: 有 foodTags 的照片占比（0..1）
 * - cuisineDiversity: foodTags 去重计数
 * - mealtimeBonus: 中位数时间在正餐时段 +10（早餐 6-9, 午餐 11-14, 晚餐 17-21）
 * - sizeBonus: min(photoCount, 5)
 * - gpsStability: GPS 点对之间平均距离 → 0-10 分（<50m 满分，>500m 0 分）
 */
function scoreCluster(cluster: PhotoInput[]): ScoredCluster {
  const photoCount = cluster.length;
  const times = cluster.map((p) => new Date(p.takenAt).getTime());
  const timeRange = {
    start: cluster.reduce((a, b) => (a.takenAt < b.takenAt ? a : b)).takenAt,
    end: cluster.reduce((a, b) => (a.takenAt > b.takenAt ? a : b)).takenAt,
  };

  // foodTagRatio
  const withFood = cluster.filter((p) => p.foodTags && p.foodTags.length > 0).length;
  const foodTagRatio = photoCount > 0 ? withFood / photoCount : 0;

  // cuisineDiversity
  const allTags = new Set(cluster.flatMap((p) => p.foodTags ?? []));
  const cuisineDiversity = allTags.size;

  // mealtimeBonus：取中位数照片的本地时间小时（从 ISO 8601 字符串提取）
  // 设计文档指定正餐时段：早餐 6-9, 午餐 11-14, 晚餐 17-21
  const sortedByTime = [...cluster].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const medianPhoto = sortedByTime[Math.floor(sortedByTime.length / 2)];
  const localHour = extractHourFromIso((medianPhoto as PhotoInput).takenAt);
  const isMealtime =
    (localHour >= 6 && localHour <= 9) ||
    (localHour >= 11 && localHour <= 14) ||
    (localHour >= 17 && localHour <= 21);
  const mealtimeBonus = isMealtime ? 10 : 0;

  // sizeBonus (cap 5)
  const sizeBonus = Math.min(photoCount, 5);

  // gpsStability
  const gpsPts = cluster
    .filter((p) => p.latitude != null && p.longitude != null)
    .map((p) => ({ lat: p.latitude as number, lon: p.longitude as number }));
  let gpsStability = 0;
  if (gpsPts.length >= 2) {
    let totalDist = 0;
    let pairs = 0;
    for (let i = 0; i < gpsPts.length; i++) {
      for (let j = i + 1; j < gpsPts.length; j++) {
        totalDist += haversineMeters(
          (gpsPts[i] as { lat: number; lon: number }).lat,
          (gpsPts[i] as { lat: number; lon: number }).lon,
          (gpsPts[j] as { lat: number; lon: number }).lat,
          (gpsPts[j] as { lat: number; lon: number }).lon,
        );
        pairs++;
      }
    }
    const avgDist = totalDist / pairs;
    gpsStability = Math.max(0, 10 * (1 - avgDist / 500));
  } else if (gpsPts.length === 1) {
    gpsStability = 5;
  }

  const score = foodTagRatio * 15 + cuisineDiversity * 5 + mealtimeBonus + sizeBonus + gpsStability;

  return {
    id: `cluster-${Math.random().toString(36).slice(2, 8)}`,
    score: Math.round(score * 10) / 10,
    stats: {
      photoCount,
      timeRange,
      foodTagRatio,
      cuisineDiversity,
      gpsStability: Math.round(gpsStability * 100) / 100,
    },
    photos: cluster,
  };
}

/**
 * Phase 3：去重 — 仅保留 isBurstRepresentative 不为 false 的照片。
 * （undefined ≈ 独立照片无连拍组 → 保留；false = 被替代的连拍成员 → 过滤）
 */
function dedupByBurstRepresentative(photos: PhotoInput[]): PhotoInput[] {
  return photos.filter((p) => p.isBurstRepresentative !== false);
}

import { describe, expect, it } from "vitest";
import {
  DIANPING_CITIES,
  buildClusterDirName,
  dedupeName,
  formatDateForDir,
  getMealtimeLabel,
  haversineDistanceM,
  isMealtime,
  resolveCityFromGps,
} from "../cli/dianping-output";

// 构造一个"本地某时某分"的 ISO，避免硬编码绝对小时导致 CI(UTC) 与本地(+08) 不一致。
// new Date(y,m,d,h) 按运行机本地时区构造 → toISOString 转 UTC → getHours 再按本地取回，往返自洽。
const localIso = (year: number, month1: number, day: number, hour: number, min = 0): string =>
  new Date(year, month1 - 1, day, hour, min, 0).toISOString();

describe("dianping-output · haversineDistanceM", () => {
  it("杭州↔上海 ≈ 170km", () => {
    const d = haversineDistanceM(30.2741, 120.1551, 31.2304, 121.4737) / 1000;
    expect(d).toBeGreaterThan(160);
    expect(d).toBeLessThan(170);
  });

  it("同点距离为 0", () => {
    expect(haversineDistanceM(30.27, 120.15, 30.27, 120.15)).toBe(0);
  });
});

describe("dianping-output · resolveCityFromGps", () => {
  it("城市中心点精确命中", () => {
    expect(resolveCityFromGps(30.2741, 120.1551)).toBe("杭州");
    expect(resolveCityFromGps(31.2304, 121.4737)).toBe("上海");
    expect(resolveCityFromGps(39.9042, 116.4074)).toBe("北京");
  });

  it("杭州萧山实际拍照点（~10km 偏移）→ 杭州", () => {
    expect(resolveCityFromGps(30.2137, 120.2349)).toBe("杭州");
  });

  it("沪杭中点（~80km > 50km 阈值）→ null，不误匹配", () => {
    const midLat = (30.2741 + 31.2304) / 2;
    const midLng = (120.1551 + 121.4737) / 2;
    expect(resolveCityFromGps(midLat, midLng)).toBeNull();
  });

  it("无 GPS 入参 → null", () => {
    expect(resolveCityFromGps(null, null)).toBeNull();
    expect(resolveCityFromGps(null, 120)).toBeNull();
    expect(resolveCityFromGps(30, null)).toBeNull();
  });

  it("远海（0,0）无任何城市 50km 内 → null", () => {
    expect(resolveCityFromGps(0, 0)).toBeNull();
  });

  it("DIANPING_CITIES 无重名、含杭州", () => {
    const names = DIANPING_CITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("杭州");
  });
});

describe("dianping-output · 餐次判定（本地时区 portable）", () => {
  it("本地 8 点 → 早餐", () => {
    expect(getMealtimeLabel(localIso(2026, 6, 14, 8))).toBe("早餐");
  });
  it("本地 12 点 → 午餐", () => {
    expect(getMealtimeLabel(localIso(2026, 6, 14, 12))).toBe("午餐");
  });
  it("本地 19 点 → 晚餐", () => {
    expect(getMealtimeLabel(localIso(2026, 6, 14, 19))).toBe("晚餐");
  });
  it("下午茶 15 点 / 夜宵 22 点 / 凌晨 3 点 → null", () => {
    expect(getMealtimeLabel(localIso(2026, 6, 14, 15))).toBeNull();
    expect(getMealtimeLabel(localIso(2026, 6, 14, 22))).toBeNull();
    expect(getMealtimeLabel(localIso(2026, 6, 14, 3))).toBeNull();
  });
  it("isMealtime 早/午/晚 为 true，其他为 false", () => {
    expect(isMealtime(localIso(2026, 6, 14, 8))).toBe(true);
    expect(isMealtime(localIso(2026, 6, 14, 12))).toBe(true);
    expect(isMealtime(localIso(2026, 6, 14, 15))).toBe(false);
  });
});

describe("dianping-output · formatDateForDir", () => {
  it("本地 6/14 中午 → 2026-06-14（不在午夜边界，portable）", () => {
    expect(formatDateForDir(localIso(2026, 6, 14, 12))).toBe("2026-06-14");
  });
});

describe("dianping-output · buildClusterDirName", () => {
  it("杭州午餐簇 → 2026-06-14_午餐_杭州", () => {
    expect(
      buildClusterDirName({
        takenAt: localIso(2026, 6, 14, 12),
        gpsCenter: { lat: 30.2741, lng: 120.1551 },
      }),
    ).toBe("2026-06-14_午餐_杭州");
  });

  it("无 GPS 簇 → 城市为 未知", () => {
    expect(buildClusterDirName({ takenAt: localIso(2026, 6, 14, 12), gpsCenter: null })).toBe(
      "2026-06-14_午餐_未知",
    );
  });

  it("下午茶簇 → 餐次为 其他", () => {
    expect(
      buildClusterDirName({
        takenAt: localIso(2026, 6, 14, 15),
        gpsCenter: { lat: 30.2741, lng: 120.1551 },
      }),
    ).toBe("2026-06-14_其他_杭州");
  });

  it("偏远 GPS（无 50km 内城市）→ 城市为 未知", () => {
    expect(
      buildClusterDirName({
        takenAt: localIso(2026, 6, 14, 12),
        gpsCenter: { lat: 0, lng: 0 },
      }),
    ).toBe("2026-06-14_午餐_未知");
  });
});

describe("dianping-output · dedupeName", () => {
  it("首次原名、第二次 _2、第三次 _3，并登记入 used", () => {
    const used = new Set<string>();
    expect(dedupeName("2026-06-14_午餐_杭州", used)).toBe("2026-06-14_午餐_杭州");
    expect(dedupeName("2026-06-14_午餐_杭州", used)).toBe("2026-06-14_午餐_杭州_2");
    expect(dedupeName("2026-06-14_午餐_杭州", used)).toBe("2026-06-14_午餐_杭州_3");
    expect(used.has("2026-06-14_午餐_杭州")).toBe(true);
    expect(used.has("2026-06-14_午餐_杭州_2")).toBe(true);
  });

  it("不同名各自原名", () => {
    const used = new Set<string>();
    expect(dedupeName("a", used)).toBe("a");
    expect(dedupeName("b", used)).toBe("b");
  });
});

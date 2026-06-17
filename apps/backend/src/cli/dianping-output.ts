/**
 * 大众点评聚类输出辅助：城市坐标最近邻 + 簇子目录命名（纯函数，零副作用）
 *
 * 独立模块 —— 不 import CLI 主文件（避免触发其顶层 main()）。CLI 与测试均可直接 import。
 *
 * 时区约定：getMealtimeLabel / formatDateForDir 用 new Date(iso).getHours()/getXXX()
 * 取运行机本地时区，与 packages/shared/src/datetime.ts 的 formatPhotoCaptureTime 同源
 * （单 Mac 自部署，扫描机==显示机时区一致即正确往返）。
 */

import { mkdir, readlink, realpath, symlink } from "node:fs/promises";
import path from "node:path";

// ===== Haversine =====

/** 球面大圆距离（米）—— 从 CLI 迁出，单一来源 */
export function haversineDistanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000; // 地球半径（米）
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ===== 城市表（WGS84 经纬度，与 iPhone 拍照 GPS 一致）=====

export interface CityEntry {
  name: string;
  lat: number;
  lng: number;
}

/**
 * 中国主要城市中心点（直辖市 + 省会 + 计划单列市 + 常见旅行地）。
 * 仅作"哪顿饭在哪个城市"的粗粒度归属，不区分同城多区。
 * 后续可直接往数组追加常去城市。
 */
export const DIANPING_CITIES: readonly CityEntry[] = [
  // 直辖市
  { name: "北京", lat: 39.9042, lng: 116.4074 },
  { name: "上海", lat: 31.2304, lng: 121.4737 },
  { name: "天津", lat: 39.3434, lng: 117.3616 },
  { name: "重庆", lat: 29.563, lng: 106.5516 },
  // 华东
  { name: "杭州", lat: 30.2741, lng: 120.1551 },
  { name: "南京", lat: 32.0603, lng: 118.7969 },
  { name: "宁波", lat: 29.8683, lng: 121.544 },
  { name: "苏州", lat: 31.2989, lng: 120.5853 },
  { name: "无锡", lat: 31.4912, lng: 120.3119 },
  { name: "合肥", lat: 31.8206, lng: 117.2272 },
  { name: "济南", lat: 36.6512, lng: 117.1201 },
  { name: "青岛", lat: 36.0671, lng: 120.3826 },
  { name: "福州", lat: 26.0745, lng: 119.2965 },
  { name: "厦门", lat: 24.4798, lng: 118.0894 },
  { name: "南昌", lat: 28.682, lng: 115.8579 },
  // 华南
  { name: "广州", lat: 23.1291, lng: 113.2644 },
  { name: "深圳", lat: 22.5431, lng: 114.0579 },
  { name: "南宁", lat: 22.817, lng: 108.3669 },
  { name: "海口", lat: 20.044, lng: 110.192 },
  { name: "三亚", lat: 18.2528, lng: 109.5119 },
  // 华中
  { name: "武汉", lat: 30.5928, lng: 114.3055 },
  { name: "长沙", lat: 28.2282, lng: 112.9388 },
  { name: "郑州", lat: 34.7466, lng: 113.6253 },
  // 西南
  { name: "成都", lat: 30.5728, lng: 104.0668 },
  { name: "昆明", lat: 24.8801, lng: 102.8329 },
  { name: "贵阳", lat: 26.647, lng: 106.6302 },
  { name: "拉萨", lat: 29.65, lng: 91.1409 },
  // 华北/东北
  { name: "石家庄", lat: 38.0428, lng: 114.5149 },
  { name: "太原", lat: 37.8706, lng: 112.5489 },
  { name: "呼和浩特", lat: 40.8426, lng: 111.749 },
  { name: "沈阳", lat: 41.8057, lng: 123.4315 },
  { name: "大连", lat: 38.914, lng: 121.6147 },
  { name: "长春", lat: 43.8171, lng: 125.3235 },
  { name: "哈尔滨", lat: 45.8038, lng: 126.535 },
  // 西北
  { name: "西安", lat: 34.3416, lng: 108.9398 },
  { name: "兰州", lat: 36.0617, lng: 103.8318 },
  { name: "西宁", lat: 36.6171, lng: 101.7782 },
  { name: "银川", lat: 38.4872, lng: 106.2309 },
  { name: "乌鲁木齐", lat: 43.8256, lng: 87.6168 },
];

/** 最近邻匹配阈值（公里）：超过则视为"不在任何已知城市附近"，返回 null */
const CITY_MATCH_RADIUS_KM = 50;

/**
 * 由 GPS 坐标解析最近城市名。
 * @returns 城市名（如 "杭州"）；最近城市 >50km 或入参缺失 → null
 */
export function resolveCityFromGps(
  lat: number | null,
  lng: number | null,
  cities: readonly CityEntry[] = DIANPING_CITIES,
): string | null {
  if (lat == null || lng == null) return null;
  let best: { name: string; distKm: number } | null = null;
  for (const c of cities) {
    const distKm = haversineDistanceM(lat, lng, c.lat, c.lng) / 1000;
    if (!best || distKm < best.distKm) best = { name: c.name, distKm };
  }
  if (!best || best.distKm > CITY_MATCH_RADIUS_KM) return null;
  return best.name;
}

// ===== 餐次 / 日期 =====

export type MealtimeLabel = "早餐" | "午餐" | "晚餐";

/** 用餐时段窗口（本地时区小时，半开区间 [start,end)）—— 含早餐 */
export const MEALTIME_WINDOWS: { start: number; end: number; label: MealtimeLabel }[] = [
  { start: 6, end: 10, label: "早餐" },
  { start: 11, end: 14, label: "午餐" },
  { start: 17, end: 21, label: "晚餐" },
];

/**
 * 判定时刻属于哪个用餐时段。
 * @returns 餐次 label；不在任何窗口（如下午茶 15 点 / 夜宵 / 凌晨）→ null
 */
export function getMealtimeLabel(isoStr: string): MealtimeLabel | null {
  const hour = new Date(isoStr).getHours();
  for (const w of MEALTIME_WINDOWS) {
    if (hour >= w.start && hour < w.end) return w.label;
  }
  return null;
}

/**
 * 判定是否正餐时段（早/午/晚 任一）。早餐窗口补齐后，早餐簇也视为正餐。
 */
export function isMealtime(isoStr: string): boolean {
  return getMealtimeLabel(isoStr) !== null;
}

/**
 * 格式化簇代表时刻的本地日期为文件系统安全目录名片段 "YYYY-MM-DD"。
 * 跨 0 点簇请传 timeRange.start（开始日）。
 */
export function formatDateForDir(isoStr: string): string {
  const d = new Date(isoStr);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface ClusterDirNameInput {
  /** 簇代表时刻（通常 timeRange.start）ISO */
  takenAt: string;
  /** 簇 GPS 中心；无定位传 null */
  gpsCenter: { lat: number; lng: number } | null;
}

/**
 * 生成簇子目录名：日期_餐次_城市。
 * 餐次无匹配（下午茶/夜宵）→ "其他"；城市无 GPS 或 50km 内无匹配 → "未知"。
 */
export function buildClusterDirName(input: ClusterDirNameInput): string {
  const date = formatDateForDir(input.takenAt);
  const mealtime = getMealtimeLabel(input.takenAt) ?? "其他";
  const city =
    resolveCityFromGps(input.gpsCenter?.lat ?? null, input.gpsCenter?.lng ?? null) ?? "未知";
  return `${date}_${mealtime}_${city}`;
}

/**
 * 同名子目录去重：若 base 已在 used 中，追加 _2/_3… 直到唯一，并加入 used。
 * @returns 唯一名（已加入 used 集合）
 */
export function dedupeName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  let candidate = `${base}_${n}`;
  while (used.has(candidate)) {
    n++;
    candidate = `${base}_${n}`;
  }
  used.add(candidate);
  return candidate;
}

// ===== Symlink 输出（零拷贝，含 HEIC）=====

/**
 * symlink 原始文件到 outputDir（零拷贝，含 HEIC 不 convert）。
 * target 先 realpath 规范化掉中间 symlink（如 nas-photos → /Volumes/...），再转相对路径——
 * 整个输出目录在卷内移动 symlink 不断，且不依赖 SMB 挂载点路径漂移。
 * 幂等：已存在且 target 一致则复用；同名冲突（不同源同 baseName）追加短 id 后缀避免覆盖。
 * realpath 失败（源不存在/中间链接断）抛错，交由调用方计入 failed，不静默吞掉。
 * @returns 实际创建/复用的 symlink 路径
 */
export async function linkPhotoToDir(
  srcPath: string,
  outputDir: string,
  photoId: string,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const ext = path.extname(srcPath); // 保留原始大小写：basename(suffix) 大小写敏感，须用原 ext 才能正确去除
  const baseName = path.basename(srcPath, ext);
  const outPath = path.join(outputDir, baseName + ext);

  const realSrc = await realpath(srcPath);
  const target = path.relative(outputDir, realSrc);

  // 幂等：已存在且 target 一致则复用，不重复创建
  try {
    if ((await readlink(outPath)) === target) return outPath;
  } catch {
    // outPath 不存在或非 symlink，继续创建
  }

  try {
    await symlink(target, outPath);
    return outPath;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // 同名冲突（不同源同 baseName）：追加短 id 后缀，避免覆盖
    const altPath = path.join(outputDir, `${baseName}_${photoId.slice(0, 6)}${ext}`);
    await symlink(target, altPath);
    return altPath;
  }
}

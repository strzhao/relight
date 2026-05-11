/**
 * 地理工具函数
 */

const EARTH_RADIUS_METERS = 6_371_000; // 地球平均半径（米）

/**
 * Haversine 公式：计算两点间的大圆距离（米）。
 *
 * @param lat1 纬度 1（十进制度）
 * @param lon1 经度 1（十进制度）
 * @param lat2 纬度 2（十进制度）
 * @param lon2 经度 2（十进制度）
 * @returns 距离（米）
 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a = sinDLat * sinDLat + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

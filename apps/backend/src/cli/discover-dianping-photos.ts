import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../lib/config";
import { convertHeicToJpeg, isHeicFile } from "../lib/heic";
import { err } from "./vlog/lib/util";

// ===== Types =====

interface Args {
  timeStart: string;
  timeEnd: string;
  outputDir: string;
  output?: string;
  mode: "convert" | "copy" | "link";
  scanFirst: boolean;
}

interface PhotoRecord {
  id: string;
  filePath: string;
  takenAt: string;
  latitude: number | null;
  longitude: number | null;
  burstId: string | null;
  isBurstRepresentative: boolean | null;
  tags: string[];
}

interface TimeCluster {
  photos: PhotoRecord[];
  timeRange: { start: string; end: string };
}

interface ClusterResult {
  id: number;
  timeRange: { start: string; end: string };
  gpsCenter: { lat: number; lng: number } | null;
  gpsRadiusM: number;
  score: number;
  isSelected: boolean;
  stats: {
    total: number;
    withFoodTags: number;
    withGps: number;
    screenshots: number;
  };
}

interface OutputPhoto {
  path: string;
  outputPath: string;
  takenAt: string;
  tags: string[];
  inCluster: number;
}

interface OutputJson {
  ok: boolean;
  timeWindow: { start: string; end: string };
  clusters: ClusterResult[];
  selectedCluster: number | null;
  stats: {
    totalInWindow: number;
    clustersFound: number;
    selected: number;
    copied: number;
    failed: number;
  };
  photos: OutputPhoto[];
}

// ===== Constants =====

/** 美食相关标签关键词 */
const FOOD_TAG_KEYWORDS = new Set([
  "美食",
  "食物",
  "餐厅",
  "中餐",
  "西餐",
  "日料",
  "韩餐",
  "烧烤",
  "火锅",
  "甜品",
  "饮品",
  "面食",
  "小吃",
  "海鲜",
  "粤菜",
  "川菜",
  "湘菜",
  "鲁菜",
  "苏菜",
  "浙菜",
  "闽菜",
  "徽菜",
  "料理",
  "刺身",
  "寿司",
  "拉面",
  "烤肉",
  "牛排",
  "披萨",
  "汉堡",
  "沙拉",
  "咖啡",
  "奶茶",
  "烘焙",
  "点心",
  "家常菜",
  "私房菜",
  "土菜",
  "农家菜",
  "本帮菜",
  "东北菜",
  "西北菜",
  "云南菜",
  "贵州菜",
  "fusion",
  "融合菜",
  "brunch",
  "早午餐",
  "fine dining",
  "bistro",
  "居酒屋",
  "烧鸟",
  "天妇罗",
  "怀石料理",
  "定食",
  "盖饭",
  "炒饭",
  "炒面",
  "汤面",
  "拌面",
  "凉皮",
  "米线",
  "螺蛳粉",
  "酸辣粉",
]);

/** 截图/非照片关键词 */
const SCREENSHOT_KEYWORDS = new Set([
  "截图",
  "截屏",
  "屏幕截图",
  "screenshot",
  "订单",
  "收据",
  "小票",
  "菜单",
  "二维码",
  "条形码",
  "支付",
]);

/** 用餐时段 (北京时间) */
const MEALTIME_WINDOWS = [
  { start: 11, end: 14, label: "午餐" },
  { start: 17, end: 21, label: "晚餐" },
];

/** 时间间隙切分阈值 (分钟) */
const TIME_GAP_MINUTES = 15;

/** GPS Haversine 聚类阈值 (米) */
const GPS_CLUSTER_RADIUS_M = 200;

/** 无 GPS 照片吸附时间窗口 (分钟) */
const NO_GPS_WINDOW_MINUTES = 15; // 扩大吸附窗口，捕获点菜截图到上菜拍照的间隔（如 11min）

// ===== Arg Parsing =====

function parseArgs(argv: string[]): Args {
  const args: Args = {
    timeStart: "",
    timeEnd: "",
    outputDir: "",
    mode: "convert",
    scanFirst: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--time-start") args.timeStart = argv[++i] ?? "";
    else if (a === "--time-end") args.timeEnd = argv[++i] ?? "";
    else if (a === "--output-dir") args.outputDir = argv[++i] ?? "";
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--mode") {
      const mode = argv[++i];
      if (mode === "convert" || mode === "copy" || mode === "link") {
        args.mode = mode;
      } else {
        err(`无效的 --mode: ${mode}，仅支持 convert/copy/link`);
        process.exit(1);
      }
    } else if (a === "--scan-first") args.scanFirst = true;
  }

  if (!args.timeStart || !args.timeEnd || !args.outputDir) {
    err(
      "用法: tsx src/cli/discover-dianping-photos.ts \\\n" +
        "  --time-start <ISO datetime> \\\n" +
        "  --time-end <ISO datetime> \\\n" +
        "  --output-dir <path> \\\n" +
        "  [--output <json>] [--mode convert|copy|link] [--scan-first]",
    );
    process.exit(1);
  }

  return args;
}

// ===== Haversine Distance =====

function haversineDistanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ===== Tag Parsing =====

function parseTagsFromJson(tagsJson: unknown): string[] {
  if (!tagsJson) return [];
  let parsed: unknown;
  if (typeof tagsJson === "string") {
    try {
      parsed = JSON.parse(tagsJson);
    } catch {
      return [];
    }
  } else {
    parsed = tagsJson;
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((t: unknown) => {
      if (typeof t === "string") return t;
      if (t && typeof t === "object" && "name" in (t as Record<string, unknown>)) {
        return String((t as Record<string, unknown>).name);
      }
      return null;
    })
    .filter((t): t is string => t !== null);
}

function hasFoodTags(tags: string[]): boolean {
  return tags.some((t) => FOOD_TAG_KEYWORDS.has(t));
}

function hasScreenshotTags(tags: string[]): boolean {
  return tags.some((t) => SCREENSHOT_KEYWORDS.has(t));
}

function countCuisineDiversity(tags: string[]): number {
  const cuisineTags = tags.filter((t) => FOOD_TAG_KEYWORDS.has(t));
  return new Set(cuisineTags).size;
}

/** 从 tags 判断是否为截图 */
function isScreenshotFromTags(tags: string[]): boolean {
  return hasScreenshotTags(tags) && !hasFoodTags(tags);
}

/** 判断 takenAt 是否在用餐时段 (北京时间) */
function isMealtime(isoStr: string): boolean {
  const hour = new Date(isoStr).getHours();
  return MEALTIME_WINDOWS.some((w) => hour >= w.start && hour < w.end);
}

// ===== DB Query =====

function openDb(): Database.Database {
  const dbPath = config.databasePath;
  if (!dbPath || dbPath === ":memory:") {
    throw new Error("DATABASE_PATH 未配置或为 :memory:");
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

function queryPhotosInWindow(
  db: Database.Database,
  timeStart: string,
  timeEnd: string,
): PhotoRecord[] {
  const sql = `
    SELECT
      p.id,
      p.file_path AS filePath,
      p.taken_at AS takenAt,
      p.latitude,
      p.longitude,
      p.burst_id AS burstId,
      p.is_burst_representative AS isBurstRepresentative,
      pa.tags AS analysisTags
    FROM photos p
    LEFT JOIN photo_analyses pa ON pa.photo_id = p.id
      AND pa.processed_at = (
        SELECT MAX(pa2.processed_at)
        FROM photo_analyses pa2
        WHERE pa2.photo_id = p.id
      )
    WHERE p.media_type = 'image'
      AND p.taken_at >= ?
      AND p.taken_at < ?
    ORDER BY p.taken_at ASC
  `;

  // DB taken_at 格式为 "YYYY-MM-DD HH:MM:SS"（空格），CLI ISO 8601 有 T 分隔，直接字符串比较会失败
  const toDbFmt = (iso: string): string => {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const p = (n: number) => n.toString().padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    } catch {
      return iso;
    }
  };
  const rows = db.prepare(sql).all(toDbFmt(timeStart), toDbFmt(timeEnd)) as Array<{
    id: string;
    filePath: string;
    takenAt: string;
    latitude: number | null;
    longitude: number | null;
    burstId: string | null;
    isBurstRepresentative: number | null;
    analysisTags: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    filePath: row.filePath,
    takenAt: row.takenAt,
    latitude: row.latitude,
    longitude: row.longitude,
    burstId: row.burstId,
    isBurstRepresentative: row.isBurstRepresentative !== 0,
    tags: parseTagsFromJson(row.analysisTags),
  }));
}

// ===== Phase 1: Spatio-Temporal Clustering =====

function timeGapSegmentation(photos: PhotoRecord[]): TimeCluster[] {
  if (photos.length === 0) return [];

  const first = photos[0] as PhotoRecord;
  const clusters: TimeCluster[] = [];
  let currentCluster: PhotoRecord[] = [first];

  for (let i = 1; i < photos.length; i++) {
    const prev = photos[i - 1] as PhotoRecord;
    const curr = photos[i] as PhotoRecord;
    const prevTime = new Date(prev.takenAt).getTime();
    const currTime = new Date(curr.takenAt).getTime();
    const gapMin = (currTime - prevTime) / (1000 * 60);

    if (gapMin > TIME_GAP_MINUTES) {
      const cFirst = currentCluster[0] as PhotoRecord;
      const cLast = currentCluster[currentCluster.length - 1] as PhotoRecord;
      clusters.push({
        photos: currentCluster,
        timeRange: {
          start: cFirst.takenAt,
          end: cLast.takenAt,
        },
      });
      currentCluster = [curr];
    } else {
      currentCluster.push(curr);
    }
  }

  // Push last cluster
  const cFirst = currentCluster[0] as PhotoRecord;
  const cLast = currentCluster[currentCluster.length - 1] as PhotoRecord;
  clusters.push({
    photos: currentCluster,
    timeRange: {
      start: cFirst.takenAt,
      end: cLast.takenAt,
    },
  });

  return clusters;
}

/** Within a time cluster, apply GPS Haversine clustering (single-linkage, <200m) */
function gpsClusterWithinTimeCluster(
  timeCluster: TimeCluster,
): { gpsPhotos: PhotoRecord[]; noGpsPhotos: PhotoRecord[] }[] {
  const photosWithGps = timeCluster.photos.filter((p) => p.latitude != null && p.longitude != null);
  const photosWithoutGps = timeCluster.photos.filter(
    (p) => p.latitude == null || p.longitude == null,
  );

  if (photosWithGps.length === 0) {
    // All photos have no GPS — keep as one cluster + no-gps photos
    return [{ gpsPhotos: [], noGpsPhotos: photosWithoutGps }];
  }

  // Union-Find for GPS-based clustering
  const n = photosWithGps.length;
  const parent = new Array(n).fill(0).map((_, i) => i);
  const rank = new Array(n).fill(0);

  function find(x: number): number {
    let root = x;
    while ((parent[root] as number) !== root) {
      parent[root] = parent[parent[root] as number] as number;
      root = parent[root] as number;
    }
    return root;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if ((rank[ra] as number) < (rank[rb] as number)) {
      parent[ra] = rb;
    } else if ((rank[ra] as number) > (rank[rb] as number)) {
      parent[rb] = ra;
    } else {
      parent[rb] = ra;
      rank[ra] = (rank[ra] as number) + 1;
    }
  }

  // Check all pairs within GPS_CLUSTER_RADIUS_M
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pi = photosWithGps[i] as PhotoRecord;
      const pj = photosWithGps[j] as PhotoRecord;
      const dist = haversineDistanceM(
        pi.latitude as number,
        pi.longitude as number,
        pj.latitude as number,
        pj.longitude as number,
      );
      if (dist < GPS_CLUSTER_RADIUS_M) {
        union(i, j);
      }
    }
  }

  // Group by root
  const groups = new Map<number, { gpsPhotos: PhotoRecord[]; noGpsPhotos: PhotoRecord[] }>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, { gpsPhotos: [], noGpsPhotos: [] });
    }
    const g = groups.get(root);
    if (g) g.gpsPhotos.push(photosWithGps[i] as PhotoRecord);
  }

  const result = Array.from(groups.values());

  // Assign no-GPS photos to nearest gps cluster by time adjacency (5 min window)
  if (photosWithoutGps.length > 0 && result.length > 0) {
    const firstResult = result[0] as (typeof result)[number];
    for (const noGpsPhoto of photosWithoutGps) {
      const noGpsTime = new Date(noGpsPhoto.takenAt).getTime();
      let bestGroup: { gpsPhotos: PhotoRecord[]; noGpsPhotos: PhotoRecord[] } = firstResult;
      let bestTimeDiff = Number.POSITIVE_INFINITY;

      for (const group of result) {
        for (const gpsPhoto of group.gpsPhotos) {
          const timeDiff = Math.abs(new Date(gpsPhoto.takenAt).getTime() - noGpsTime);
          if (timeDiff < bestTimeDiff) {
            bestTimeDiff = timeDiff;
            bestGroup = group;
          }
        }
      }

      const windowMs = NO_GPS_WINDOW_MINUTES * 60 * 1000;
      if (bestTimeDiff <= windowMs) {
        bestGroup.noGpsPhotos.push(noGpsPhoto);
      } else {
        // Create a new cluster for orphan no-GPS photos
        result.push({ gpsPhotos: [], noGpsPhotos: [noGpsPhoto] });
      }
    }
  }

  return result;
}

/**
 * Merge sub-clusters across time-gap boundaries if their GPS centers are within GPS_CLUSTER_RADIUS_M.
 * This handles the case where a user takes photos at the same restaurant but with >15 min gaps
 * between courses (e.g., waiting for dishes, eating slowly, stepping outside for exterior shot).
 */
function crossTimeGpsMerge(
  subClusters: { gpsPhotos: PhotoRecord[]; noGpsPhotos: PhotoRecord[] }[],
): { gpsPhotos: PhotoRecord[]; noGpsPhotos: PhotoRecord[] }[] {
  if (subClusters.length <= 1) return subClusters;

  const n = subClusters.length;
  const parent = new Array(n).fill(0).map((_, i) => i);

  function find(x: number): number {
    let root = x;
    while ((parent[root] as number) !== root) {
      parent[root] = parent[parent[root] as number] as number;
      root = parent[root] as number;
    }
    return root;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Compute GPS center for each sub-cluster (only from gpsPhotos)
  const centers = subClusters.map((sub) => computeGpsCenter(sub.gpsPhotos));

  // Merge sub-clusters whose GPS centers are within radius
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ci = centers[i];
      const cj = centers[j];
      if (ci && cj) {
        const dist = haversineDistanceM(ci.lat, ci.lng, cj.lat, cj.lng);
        if (dist < GPS_CLUSTER_RADIUS_M) {
          union(i, j);
        }
      }
    }
  }

  // Collect merged groups
  const groups = new Map<number, { gpsPhotos: PhotoRecord[]; noGpsPhotos: PhotoRecord[] }>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, { gpsPhotos: [], noGpsPhotos: [] });
    }
    const g = groups.get(root);
    const sub = subClusters[i] as (typeof subClusters)[number];
    if (g && sub) {
      g.gpsPhotos.push(...sub.gpsPhotos);
      g.noGpsPhotos.push(...sub.noGpsPhotos);
    }
  }

  return Array.from(groups.values());
}

function allPhotosInSubCluster(sub: {
  gpsPhotos: PhotoRecord[];
  noGpsPhotos: PhotoRecord[];
}): PhotoRecord[] {
  return [...sub.gpsPhotos, ...sub.noGpsPhotos].sort(
    (a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime(),
  );
}

// ===== Phase 2: Restaurant Cluster Scoring =====

function computeGpsRadiusM(photos: PhotoRecord[]): number {
  const gpsPhotos = photos.filter((p) => p.latitude != null && p.longitude != null);
  if (gpsPhotos.length < 2) return 0;

  // Centroid
  const avgLat = gpsPhotos.reduce((s, p) => s + (p.latitude as number), 0) / gpsPhotos.length;
  const avgLng = gpsPhotos.reduce((s, p) => s + (p.longitude as number), 0) / gpsPhotos.length;

  // Max distance from centroid
  let maxDist = 0;
  for (const p of gpsPhotos) {
    const d = haversineDistanceM(p.latitude as number, p.longitude as number, avgLat, avgLng);
    if (d > maxDist) maxDist = d;
  }
  return Math.round(maxDist);
}

function computeGpsStabilityVariance(photos: PhotoRecord[]): number {
  const gpsPhotos = photos.filter((p) => p.latitude != null && p.longitude != null);
  if (gpsPhotos.length < 2) return Number.POSITIVE_INFINITY;

  const avgLat = gpsPhotos.reduce((s, p) => s + (p.latitude as number), 0) / gpsPhotos.length;
  const avgLng = gpsPhotos.reduce((s, p) => s + (p.longitude as number), 0) / gpsPhotos.length;

  const varSum = gpsPhotos.reduce((s, p) => {
    const d = haversineDistanceM(p.latitude as number, p.longitude as number, avgLat, avgLng);
    return s + d * d;
  }, 0);
  return varSum / gpsPhotos.length;
}

function scoreCluster(photos: PhotoRecord[]): ClusterResult["score"] {
  const total = photos.length;
  if (total === 0) return 0;

  const withFoodTags = photos.filter((p) => hasFoodTags(p.tags)).length;
  const foodTagRatio = total > 0 ? withFoodTags / total : 0;

  const allTags = photos.flatMap((p) => p.tags);
  const cuisineDiversity = countCuisineDiversity(allTags);

  let mealtimeBonus = 0;
  for (const p of photos) {
    if (isMealtime(p.takenAt)) {
      mealtimeBonus = 3;
      break;
    }
  }

  let sizeBonus = 0;
  if (total >= 3 && total <= 8) sizeBonus = 2;
  else if (total >= 9 && total <= 20) sizeBonus = 3;
  else if (total > 20) sizeBonus = 1;

  let gpsStability = 0;
  const variance = computeGpsStabilityVariance(photos);
  if (variance < 50 * 50) gpsStability = 2;

  return Math.round(
    foodTagRatio * 15 + cuisineDiversity * 5 + mealtimeBonus + sizeBonus + gpsStability,
  );
}

function computeGpsCenter(photos: PhotoRecord[]): { lat: number; lng: number } | null {
  const gpsPhotos = photos.filter((p) => p.latitude != null && p.longitude != null);
  if (gpsPhotos.length === 0) return null;

  const avgLat = gpsPhotos.reduce((s, p) => s + (p.latitude as number), 0) / gpsPhotos.length;
  const avgLng = gpsPhotos.reduce((s, p) => s + (p.longitude as number), 0) / gpsPhotos.length;
  return { lat: Math.round(avgLat * 1000) / 1000, lng: Math.round(avgLng * 1000) / 1000 };
}

// ===== Phase 3: Dedup within Cluster =====

function dedupCluster(photos: PhotoRecord[]): PhotoRecord[] {
  return photos
    .filter((p) => {
      // Skip non-representative burst photos
      if (p.burstId && !p.isBurstRepresentative) return false;
      return true;
    })
    .sort((a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime());
}

// ===== File Operations =====

async function processOnePhoto(
  photo: PhotoRecord,
  outputDir: string,
  mode: "convert" | "copy" | "link",
): Promise<string> {
  const srcPath = photo.filePath;
  const ext = path.extname(srcPath).toLowerCase();
  const baseName = path.basename(srcPath, ext);
  const outExt = ext === ".heic" || ext === ".heif" ? ".jpg" : ext;
  const outName = baseName + outExt;
  const outPath = path.join(outputDir, outName);

  await mkdir(outputDir, { recursive: true });

  if (mode === "link") {
    // Symlink (not available for HEIC→JPG conversion fallback)
    if (isHeicFile(srcPath)) {
      // Fall back to convert for HEIC
      err(`[discover-dianping] link 模式不支持 HEIC，降级为 convert: ${path.basename(srcPath)}`);
      const buf = await readFile(srcPath);
      const jpeg = await convertHeicToJpeg(buf, { quality: 90 });
      await writeFile(outPath, jpeg);
    } else {
      const { symlink } = await import("node:fs/promises");
      await symlink(srcPath, outPath);
    }
  } else if (mode === "copy") {
    if (isHeicFile(srcPath)) {
      err(`[discover-dianping] copy 模式不支持 HEIC，降级为 convert: ${path.basename(srcPath)}`);
      const buf = await readFile(srcPath);
      const jpeg = await convertHeicToJpeg(buf, { quality: 90 });
      await writeFile(outPath, jpeg);
    } else {
      await copyFile(srcPath, outPath);
    }
  } else {
    // convert mode (default)
    if (isHeicFile(srcPath)) {
      const buf = await readFile(srcPath);
      const jpeg = await convertHeicToJpeg(buf, { quality: 90 });
      await writeFile(outPath, jpeg);
    } else {
      await copyFile(srcPath, outPath);
    }
  }

  return outPath;
}

// ===== Main =====

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  err(
    `[discover-dianping] start: window=${args.timeStart} ~ ${args.timeEnd}, ` +
      `output=${args.outputDir}, mode=${args.mode}`,
  );

  // Validate time window
  const startTime = new Date(args.timeStart);
  const endTime = new Date(args.timeEnd);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
    err("无效的时间格式，请使用 ISO 8601 格式，如 2026-06-01T18:00:00+08:00");
    process.exit(1);
  }
  if (startTime >= endTime) {
    err("--time-start 必须早于 --time-end");
    process.exit(1);
  }

  // Phase 0: Optional scan-first
  if (args.scanFirst) {
    err("[discover-dianping] scan-first 模式：触发扫描并等待...");
    try {
      const { scanQueue } = await import("../jobs/queues");
      const db = openDb();
      const sourceRow = db
        .prepare("SELECT id FROM storage_sources WHERE enabled = 1 LIMIT 1")
        .get() as { id: string } | undefined;
      if (!sourceRow) {
        err("[discover-dianping] 没有启用的存储源，跳过 scan-first");
      } else {
        await scanQueue.add(`scan:${sourceRow.id}`, {
          storageSourceId: sourceRow.id,
        });
        // Wait for scan to complete by polling last_scan_at
        const prevScanAt = (
          db.prepare("SELECT last_scan_at FROM storage_sources WHERE id = ?").get(sourceRow.id) as
            | { last_scan_at: string | null }
            | undefined
        )?.last_scan_at;
        err("[discover-dianping] 等待扫描完成 (polling last_scan_at)...");
        const maxWaitMs = 10 * 60 * 1000; // 10 min max
        const pollIntervalMs = 5000;
        const startWait = Date.now();
        let scanDone = false;
        while (Date.now() - startWait < maxWaitMs) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          const row = db
            .prepare("SELECT last_scan_at FROM storage_sources WHERE id = ?")
            .get(sourceRow.id) as { last_scan_at: string | null } | undefined;
          if (row?.last_scan_at && row.last_scan_at !== prevScanAt) {
            scanDone = true;
            break;
          }
        }
        if (scanDone) {
          err("[discover-dianping] 扫描完成");
        } else {
          err("[discover-dianping] 扫描等待超时 (10min)，继续执行");
        }
      }
      db.close();
    } catch (e) {
      err(`[discover-dianping] scan-first 失败: ${(e as Error).message}，继续执行`);
    }
  }

  // Open DB
  const db = openDb();
  let photos: PhotoRecord[];
  try {
    photos = queryPhotosInWindow(db, args.timeStart, args.timeEnd);
  } finally {
    db.close();
  }

  err(`[discover-dianping] 查询到 ${photos.length} 张图片`);

  if (photos.length === 0) {
    const out: OutputJson = {
      ok: true,
      timeWindow: { start: args.timeStart, end: args.timeEnd },
      clusters: [],
      selectedCluster: null,
      stats: {
        totalInWindow: 0,
        clustersFound: 0,
        selected: 0,
        copied: 0,
        failed: 0,
      },
      photos: [],
    };
    const json = JSON.stringify(out, null, 2);
    process.stdout.write(`${json}\n`);
    if (args.output) {
      await writeFile(args.output, json);
      err(`[discover-dianping] wrote ${args.output}`);
    }
    err("[discover-dianping] 时间窗口内无照片，终止");
    process.exit(0);
  }

  // Phase 1: Spatio-temporal clustering
  const timeClusters = timeGapSegmentation(photos);
  err(`[discover-dianping] 时间间隙切分: ${timeClusters.length} 个时间簇`);

  const allSubClusters: { gpsPhotos: PhotoRecord[]; noGpsPhotos: PhotoRecord[] }[] = [];
  for (const tc of timeClusters) {
    const subs = gpsClusterWithinTimeCluster(tc);
    for (const sub of subs) {
      allSubClusters.push(sub);
    }
  }
  err(`[discover-dianping] GPS 聚类后: ${allSubClusters.length} 个簇`);

  // Cross-time GPS merge: re-merge clusters at the same GPS location separated by time gaps
  const mergedClusters = crossTimeGpsMerge(allSubClusters);
  const mergeNote =
    mergedClusters.length < allSubClusters.length
      ? ` (合并了 ${allSubClusters.length - mergedClusters.length} 个)`
      : "";
  err(`[discover-dianping] 跨时间GPS合并后: ${mergedClusters.length} 个簇${mergeNote}`);

  // Phase 2: Score and select best cluster
  const clusterResults: ClusterResult[] = mergedClusters.map((sub, idx) => {
    const allPhotos = allPhotosInSubCluster(sub);
    const deduped = dedupCluster(allPhotos);
    const score = scoreCluster(deduped);
    const gpsCenter = computeGpsCenter(allPhotos);
    const gpsRadiusM = computeGpsRadiusM(allPhotos);

    const withFoodTags = deduped.filter((p) => hasFoodTags(p.tags)).length;
    const withGps = deduped.filter((p) => p.latitude != null && p.longitude != null).length;
    const screenshots = deduped.filter((p) => isScreenshotFromTags(p.tags)).length;

    return {
      id: idx + 1,
      timeRange: {
        start: allPhotos[0]?.takenAt ?? "",
        end: allPhotos[allPhotos.length - 1]?.takenAt ?? "",
      },
      gpsCenter,
      gpsRadiusM,
      score,
      isSelected: false,
      stats: {
        total: deduped.length,
        withFoodTags,
        withGps,
        screenshots,
      },
    };
  });

  // Select best cluster (highest score)
  let bestClusterIdx = -1;
  let bestScore = -1;
  for (let i = 0; i < clusterResults.length; i++) {
    const cr = clusterResults[i] as ClusterResult;
    if (cr.score > bestScore) {
      bestScore = cr.score;
      bestClusterIdx = i;
    }
  }

  if (bestClusterIdx >= 0) {
    (clusterResults[bestClusterIdx] as ClusterResult).isSelected = true;
  }

  // Phase 3: Dedup and prepare selected photos
  let selectedPhotos: PhotoRecord[] = [];
  if (bestClusterIdx >= 0) {
    const bestSub = mergedClusters[bestClusterIdx] as (typeof mergedClusters)[number];
    selectedPhotos = dedupCluster(allPhotosInSubCluster(bestSub));
  }

  err(
    `[discover-dianping] 选中簇 #${bestClusterIdx + 1}: ` +
      `${selectedPhotos.length} 张照片, score=${bestScore}`,
  );

  // File operations
  let copied = 0;
  let failed = 0;
  const outputPhotos: OutputPhoto[] = [];

  for (const photo of selectedPhotos) {
    try {
      const outputPath = await processOnePhoto(photo, args.outputDir, args.mode);
      outputPhotos.push({
        path: photo.filePath,
        outputPath,
        takenAt: photo.takenAt,
        tags: photo.tags,
        inCluster: bestClusterIdx + 1,
      });
      copied++;
    } catch (e) {
      err(
        `[discover-dianping] 处理失败: ${path.basename(photo.filePath)} — ${(e as Error).message}`,
      );
      outputPhotos.push({
        path: photo.filePath,
        outputPath: "",
        takenAt: photo.takenAt,
        tags: photo.tags,
        inCluster: bestClusterIdx + 1,
      });
      failed++;
    }
  }

  const out: OutputJson = {
    ok: true,
    timeWindow: { start: args.timeStart, end: args.timeEnd },
    clusters: clusterResults,
    selectedCluster: bestClusterIdx >= 0 ? bestClusterIdx + 1 : null,
    stats: {
      totalInWindow: photos.length,
      clustersFound: clusterResults.length,
      selected: selectedPhotos.length,
      copied,
      failed,
    },
    photos: outputPhotos,
  };

  const json = JSON.stringify(out, null, 2);
  process.stdout.write(`${json}\n`);
  if (args.output) {
    await writeFile(args.output, json);
    err(`[discover-dianping] wrote ${args.output}`);
  }

  err(
    `[discover-dianping] 完成: ${copied} 复制, ${failed} 失败, ` +
      `${clusterResults.length} 个聚类, 选中簇 #${out.selectedCluster}`,
  );

  if (failed > 0) process.exit(2);
  process.exit(0);
}

main().catch((e) => {
  err("FATAL", (e as Error).stack ?? (e as Error).message);
  process.exit(1);
});

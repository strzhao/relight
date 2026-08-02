/**
 * 验收测试（红队）：buildManifest ManifestPhoto 字段映射 + photoMidCosKey 格式 + mid fallback
 *
 * 设计契约来源（state.md §契约规约）：
 *   ManifestPhoto:
 *     photoId: string        // UUID 非空
 *     rank: number           // >= 1
 *     title: string          // 可空串
 *     narrative: string      // 可空串
 *     thumbnail: string      // COS URL（800px）非空
 *     original: string       // COS URL（mid ~1600px）；上传失败时 === thumbnail
 *     takenAt: string | null // ISO 8601 或 null
 *     width: number          // >= 0（0=未知）
 *     height: number         // >= 0
 *
 *   photoMidCosKey(photoId): string  // == `${prefix}/photos/${photoId}-mid.jpg`
 *     invariant: matches /^relight\/photos\/[a-f0-9-]+-mid\.jpg$/
 *
 * 谓词覆盖（间接，后端本机等价）：
 *   - S9.PM2 后端侧（original 字段 mid URL 生成）
 *   - S9.PM3（mid 失败 fallback original === thumbnail）
 *   - S8.PM1（takenAt=null 字段透传）
 *
 * 红队铁律：本文件仅依据设计文档 + 契约规约编写，不读蓝队实现代码。
 *   - 不读 lib/gallery/manifest.ts
 *   - 用真实 SQLite fixture（项目惯例：better-sqlite3 真实 DB）
 *   - mock cos-nodejs-sdk-v5（buildManifest 不应调 COS）
 *
 * 强断言铁律：buildManifest / photoMidCosKey 未导出 → fail（不 skip）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// Mock：cos-nodejs-sdk-v5（buildManifest 理论上不调 COS）
// ============================================================================
const mockCosPutObject = vi.hoisted(() => vi.fn(async () => ({})));
const mockCosSliceUploadFile = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("cos-nodejs-sdk-v5", () => {
  const S3 = vi.fn(() => ({
    putObject: mockCosPutObject,
    sliceUploadFile: mockCosSliceUploadFile,
    getObjectUrl: vi.fn(),
  }));
  return { default: S3 };
});

// ============================================================================
// Mock：config（注入测试 COS 配置，cosPublicUrl 拼约定 URL）
// ============================================================================
const TEST_COS_BUCKET = "little-bee-assets-1324334992";
const TEST_COS_REGION = "ap-shanghai";
const TEST_COS_PREFIX = "relight";
const TEST_GALLERY_PUBLIC_URL = "https://gallery.stringzhao.life";

vi.mock("../lib/config", () => ({
  config: {
    get port() {
      return 3000;
    },
    get storageRoot() {
      return process.env.STORAGE_ROOT ?? "/tmp/test-storage";
    },
    get databasePath() {
      return process.env.DATABASE_PATH ?? "/tmp/test.db";
    },
    cos: {
      get secretId() {
        return "test-id";
      },
      get secretKey() {
        return "test-key";
      },
      get appid() {
        return "1324334992";
      },
      get region() {
        return TEST_COS_REGION;
      },
      get bucket() {
        return TEST_COS_BUCKET;
      },
      get prefix() {
        return TEST_COS_PREFIX;
      },
    },
    gallery: {
      get vpsHost() {
        return "vps.test";
      },
      get vpsUser() {
        return "ubuntu";
      },
      get vpsPath() {
        return "/home/ubuntu/relight-gallery";
      },
      get publicUrl() {
        return TEST_GALLERY_PUBLIC_URL;
      },
    },
    face: {
      get qualityLowDetectionScore() {
        return 0.65;
      },
    },
  },
}));

// ============================================================================
// 被测模块
// ============================================================================
interface ManifestPhoto {
  photoId: string;
  rank: number;
  title: string;
  narrative: string;
  thumbnail: string;
  original: string;
  takenAt: string | null;
  width: number;
  height: number;
  faceFocus: { x: number; y: number } | null;
}
interface ManifestDay {
  pickDate: string;
  title: string;
  narrative: string;
  wallpaperLandscape: string | null;
  wallpaperPortrait: string | null;
  photos: ManifestPhoto[];
}
interface Manifest {
  generatedAt: string;
  days: ManifestDay[];
  videos: unknown[];
}
type BuildManifest = () => Promise<Manifest>;
type PhotoMidCosKey = (photoId: string) => string;

let buildManifest: BuildManifest | null = null;
let photoMidCosKey: PhotoMidCosKey | null = null;

// ============================================================================
// 真实 SQLite fixture
// ============================================================================
let sqlite: Database.Database;
let dbPath: string;

beforeEach(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `relight-manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  process.env.DATABASE_PATH = dbPath;
  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  setupTestSchema(sqlite);

  try {
    const mod = await import("../lib/gallery/manifest");
    const bm = (mod as { buildManifest?: BuildManifest }).buildManifest;
    const mk = (mod as { photoMidCosKey?: PhotoMidCosKey }).photoMidCosKey;
    if (typeof bm === "function") buildManifest = bm;
    if (typeof mk === "function") photoMidCosKey = mk;
  } catch {
    // 模块不存在 → 保持 null，it 内 fail
  }
});

afterEach(() => {
  try {
    sqlite.close();
  } catch {
    // ignore
  }
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
});

// 强断言前置
function requireBuildManifest(): BuildManifest {
  expect(buildManifest, "蓝队必须导出 buildManifest").toBeTypeOf("function");
  return buildManifest as BuildManifest;
}
function requirePhotoMidCosKey(): PhotoMidCosKey {
  expect(photoMidCosKey, "蓝队必须导出 photoMidCosKey").toBeTypeOf("function");
  return photoMidCosKey as PhotoMidCosKey;
}

// ============================================================================
// fixture 辅助：插入完整一天数据
// ============================================================================
function insertDay(opts: {
  pickDate: string;
  photoIds: Array<{
    id: string;
    rank: number;
    takenAt: string | null;
    width: number;
    height: number;
    midFailed?: boolean;
  }>;
  withWallpaper?: boolean;
}) {
  const { pickDate, photoIds, withWallpaper = true } = opts;
  const srcId = "src-test";
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, ?, 'local', ?, 1)`,
    )
    .run(srcId, "test-src", "/tmp/test-storage");

  const pickId = `pick-${pickDate}`;
  for (const p of photoIds) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size, thumbnail_path, taken_at, created_at, media_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'image')`,
      )
      .run(
        p.id,
        srcId,
        `photos/${p.id}.jpg`,
        `hash-${p.id}`,
        p.width,
        p.height,
        1024,
        `thumb/${p.id}.jpg`,
        p.takenAt,
        `${pickDate}T00:00:00.000Z`,
      );
  }

  const firstPhoto = photoIds[0];
  if (!firstPhoto) throw new Error("insertDay requires at least 1 photo");
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO daily_picks (id, photo_id, pick_date, title, narrative, score, composed_image_path, members, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    )
    .run(
      pickId,
      firstPhoto.id,
      pickDate,
      `${pickDate} 标题`,
      `${pickDate} 叙事`,
      8.5,
      withWallpaper ? `/wallpaper/${pickDate}.jpg` : null,
      `${pickDate}T10:00:00.000Z`,
    );

  for (const p of photoIds) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO daily_pick_entries (id, daily_pick_id, rank, photo_id, title, narrative, score, members, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
      )
      .run(
        `entry-${pickDate}-${p.rank}`,
        pickId,
        p.rank,
        p.id,
        `标题${p.rank}`,
        `叙事${p.rank}`,
        7.5 + p.rank * 0.1,
        `${pickDate}T10:00:00.000Z`,
      );
  }
}

// ============================================================================
// fixture 辅助：插入 faces 行（faceFocus 谓词专用）
// faces 表字段（test-schema.ts line 204+）：id, photo_id, person_id, bbox_x/y/w/h,
//   detection_score, embedding, detected_at, attributes
// ============================================================================
function insertFace(opts: {
  photoId: string;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  detectionScore?: number;
  personId?: string | null;
}) {
  const { photoId, bboxX, bboxY, bboxW, bboxH, detectionScore = 0.9, personId = null } = opts;
  const faceId = `face-${photoId}-${Math.random().toString(36).slice(2, 8)}`;
  sqlite
    .prepare(
      `INSERT INTO faces (id, photo_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h, detection_score, embedding, detected_at, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, NULL)`,
    )
    .run(
      faceId,
      photoId,
      personId,
      bboxX,
      bboxY,
      bboxW,
      bboxH,
      detectionScore,
      `${photoDate(photoId)}T00:00:00.000Z`,
    );
}

// 从 photoId 推日期（仅用于 detected_at 字段填充，无业务含义）
function photoDate(photoId: string): string {
  const m = photoId.match(/(\d{4}-\d{2}-\d{2})/);
  return m?.[1] ?? "2024-07-01";
}

// ============================================================================
// 验收：photoMidCosKey 格式（§契约规约 invariant）
// ============================================================================
describe("photoMidCosKey — 格式 invariant（§契约规约）", () => {
  it("返回值 matches /^relight\\/photos\\/[a-f0-9-]+-mid\\.jpg$/", () => {
    const mk = requirePhotoMidCosKey();
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const key = mk(uuid);
    expect(key).toMatch(/^relight\/photos\/[a-f0-9-]+-mid\.jpg$/);
  });

  it("含 photoId 且后缀为 -mid.jpg", () => {
    const mk = requirePhotoMidCosKey();
    const uuid = "12345678-abcd-ef01-2345-678901234567";
    const key = mk(uuid);
    expect(key).toBe(`relight/photos/${uuid}-mid.jpg`);
    expect(key.endsWith("-mid.jpg")).toBe(true);
  });

  it("与 thumbnail key 同目录平铺（仅后缀 -mid.jpg vs -thumb.jpg）", () => {
    const mk = requirePhotoMidCosKey();
    const uuid = "abcdef12-3456-7890-abcd-ef1234567890";
    const midKey = mk(uuid);
    const thumbKey = `relight/photos/${uuid}-thumb.jpg`;
    // 同 prefix/photos/ 目录
    expect(midKey.startsWith("relight/photos/")).toBe(true);
    expect(thumbKey.startsWith("relight/photos/")).toBe(true);
    // 仅后缀差异
    expect(midKey.replace("-mid.jpg", "-thumb.jpg")).toBe(thumbKey);
  });

  it("多个不同 UUID 生成的 key 互不相同（防 .toString 漏洞）", () => {
    const mk = requirePhotoMidCosKey();
    const a = mk("11111111-1111-1111-1111-111111111111");
    const b = mk("22222222-2222-2222-2222-222222222222");
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// 验收：ManifestPhoto 字段映射（含 takenAt/width/height）
// ============================================================================
describe("buildManifest — ManifestPhoto 字段映射（§契约规约）", () => {
  it("每个 photo 含 photoId/rank/title/narrative/thumbnail/original/takenAt/width/height 全字段", async () => {
    const bm = requireBuildManifest();
    insertDay({
      pickDate: "2024-07-15",
      photoIds: [
        {
          id: "uuid-1-aaaaaaaaaaaaaaaaaaaa",
          rank: 1,
          takenAt: "2024-07-15T10:30:00.000Z",
          width: 4032,
          height: 3024,
        },
      ],
    });

    const manifest = await bm();
    const day = manifest.days.find((d) => d.pickDate === "2024-07-15");
    expect(day, "应找到 2024-07-15 这天").toBeDefined();
    const photo = day?.photos[0];
    if (!photo) throw new Error("photo missing for 2024-07-15");

    // 全字段断言
    expect(photo.photoId).toBe("uuid-1-aaaaaaaaaaaaaaaaaaaa");
    expect(photo.rank).toBe(1);
    expect(typeof photo.title).toBe("string");
    expect(typeof photo.narrative).toBe("string");
    expect(typeof photo.thumbnail).toBe("string");
    expect(photo.thumbnail.length).toBeGreaterThan(0);
    expect(typeof photo.original).toBe("string");
    expect(photo.original.length).toBeGreaterThan(0);
    // takenAt/width/height 是新字段，必须存在
    expect(photo).toHaveProperty("takenAt");
    expect(photo).toHaveProperty("width");
    expect(photo).toHaveProperty("height");
  });

  it("takenAt: ISO 字符串透传（来自 photos.taken_at）", async () => {
    const bm = requireBuildManifest();
    const iso = "2024-07-15T10:30:00.000Z";
    insertDay({
      pickDate: "2024-07-16",
      photoIds: [
        { id: "uuid-2-bbbbbbbbbbbbbbbbbbbb", rank: 1, takenAt: iso, width: 1000, height: 800 },
      ],
    });
    const manifest = await bm();
    const photo = manifest.days.find((d) => d.pickDate === "2024-07-16")?.photos[0];
    expect(photo?.takenAt).toBe(iso);
  });

  it("takenAt: null 透传（缺失场景，S8.PM1 后端侧）", async () => {
    const bm = requireBuildManifest();
    insertDay({
      pickDate: "2024-07-17",
      photoIds: [
        { id: "uuid-3-cccccccccccccccccccc", rank: 1, takenAt: null, width: 1000, height: 800 },
      ],
    });
    const manifest = await bm();
    const photo = manifest.days.find((d) => d.pickDate === "2024-07-17")?.photos[0];
    expect(photo?.takenAt).toBeNull();
  });

  it("width/height 透传（含 width=0/height=0 边界）", async () => {
    const bm = requireBuildManifest();
    insertDay({
      pickDate: "2024-07-18",
      photoIds: [
        {
          id: "uuid-4-dddddddddddddddddddd",
          rank: 1,
          takenAt: "2024-07-18T01:00:00.000Z",
          width: 4032,
          height: 3024,
        },
        { id: "uuid-5-eeeeeeeeeeeeeeeeeeee", rank: 2, takenAt: null, width: 0, height: 0 },
      ],
    });
    const manifest = await bm();
    const day = manifest.days.find((d) => d.pickDate === "2024-07-18");
    const p1 = day?.photos.find((p) => p.rank === 1);
    const p2 = day?.photos.find((p) => p.rank === 2);
    expect(p1?.width).toBe(4032);
    expect(p1?.height).toBe(3024);
    // 边界 0 透传（不报错，前端 fallback 3/4）
    expect(p2?.width).toBe(0);
    expect(p2?.height).toBe(0);
  });

  it("rank >= 1（rank 升序）", async () => {
    const bm = requireBuildManifest();
    insertDay({
      pickDate: "2024-07-19",
      photoIds: [
        { id: "uuid-6-ffffffffffffffffffff", rank: 1, takenAt: null, width: 100, height: 100 },
        { id: "uuid-7-11111111111111111111", rank: 2, takenAt: null, width: 100, height: 100 },
        { id: "uuid-8-22222222222222222222", rank: 3, takenAt: null, width: 100, height: 100 },
      ],
    });
    const manifest = await bm();
    const day = manifest.days.find((d) => d.pickDate === "2024-07-19");
    for (const p of day?.photos ?? []) {
      expect(p.rank).toBeGreaterThanOrEqual(1);
    }
    // 升序
    const ranks = (day?.photos ?? []).map((p) => p.rank);
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
  });
});

// ============================================================================
// 验收：original 字段指向 mid URL（S9.PM2 后端侧）
// ============================================================================
describe("buildManifest — original 字段 mid URL（S9.PM2 后端侧）", () => {
  it("original URL 含 -mid.jpg（mid 成功场景）", async () => {
    const bm = requireBuildManifest();
    insertDay({
      pickDate: "2024-07-20",
      photoIds: [
        { id: "uuid-9-33333333333333333333", rank: 1, takenAt: null, width: 1000, height: 800 },
      ],
    });
    const manifest = await bm();
    const photo = manifest.days.find((d) => d.pickDate === "2024-07-20")?.photos[0];
    expect(photo?.original).toContain("-mid.jpg");
  });

  it("thumbnail URL 含 -thumb.jpg（与 mid 区分）", async () => {
    const bm = requireBuildManifest();
    insertDay({
      pickDate: "2024-07-21",
      photoIds: [
        { id: "uuid-10-44444444444444444444", rank: 1, takenAt: null, width: 1000, height: 800 },
      ],
    });
    const manifest = await bm();
    const photo = manifest.days.find((d) => d.pickDate === "2024-07-21")?.photos[0];
    expect(photo?.thumbnail).toContain("-thumb.jpg");
    // original 是 mid，thumbnail 是 thumb，两者不同（mid 成功场景）
    expect(photo?.original).not.toBe(photo?.thumbnail);
  });
});

// ============================================================================
// 验收：S9.PM3 窄 mutation survival 窗口（plan-reviewer 终审改进建议）
// 蓝队可能写「original 永远 === thumbnail」的 mutation 通过 S9.PM3 E2E（因为 fixture rank18 就是 fallback），
// 这里关闭该窗口：buildManifest 默认（mid 成功）original 必须含 -mid.jpg，不能等于 thumbnail。
// 同时验「mid 缺失」语义的两种合理解读，确保蓝队选其一实现：
//   解读 A：buildManifest 总是输出 mid URL（约定），fallback 在前端/COS 层 —— original 含 -mid.jpg
//   解读 B：buildManifest 感知 mid 缺失输出 thumb URL —— 此时 original 含 -thumb.jpg 且 === thumbnail
// 红队不锁死实现选择，但锁死「不能写死 thumb」的 mutation 窗口。
// ============================================================================
describe("buildManifest — S9.PM3 mutation survival 窗口关闭", () => {
  it("普通 photo（mid 应成功）的 original 必须含 -mid.jpg（防蓝队写死 thumb）", async () => {
    const bm = requireBuildManifest();
    insertDay({
      pickDate: "2024-07-22",
      photoIds: [
        {
          id: "uuid-mut-1-aaaaaaaaaaaaaaaaaa",
          rank: 1,
          takenAt: "2024-07-22T10:00:00.000Z",
          width: 1000,
          height: 800,
        },
        {
          id: "uuid-mut-2-bbbbbbbbbbbbbbbbbbbb",
          rank: 2,
          takenAt: "2024-07-22T11:00:00.000Z",
          width: 1000,
          height: 800,
        },
      ],
    });
    const manifest = await bm();
    const day = manifest.days.find((d) => d.pickDate === "2024-07-22");
    expect(day?.photos.length).toBeGreaterThanOrEqual(2);
    // 每个 photo 的 original 都应含 -mid.jpg（解读 A），不能全部 === thumbnail
    const allMid = day!.photos.every((p) => p.original.includes("-mid.jpg"));
    const allEqualThumb = day!.photos.every((p) => p.original === p.thumbnail);
    // 关闭 mutation 窗口：要么全 mid（解读 A），要么有 thumb fallback 但至少一个 mid（解读 B 混合）
    // 禁止：全部 original === thumbnail（蓝队写死 thumb 的 mutation）
    expect(allEqualThumb, "蓝队不能把 original 写死成 thumbnail（mutation 窗口）").toBe(false);
    // 至少有一个 original 含 -mid.jpg
    const hasAtLeastOneMid = day!.photos.some((p) => p.original.includes("-mid.jpg"));
    expect(hasAtLeastOneMid, "至少一个 photo 的 original 应含 -mid.jpg").toBe(true);
  });

  it("photoMidCosKey(photoId) 与 buildManifest original 的 key 一致（约定防漂移）", async () => {
    const bm = requireBuildManifest();
    const mk = requirePhotoMidCosKey();
    const photoId = "uuid-link-cccccccccccccccccccc";
    insertDay({
      pickDate: "2024-07-23",
      photoIds: [{ id: photoId, rank: 1, takenAt: null, width: 1000, height: 800 }],
    });
    const manifest = await bm();
    const photo = manifest.days.find((d) => d.pickDate === "2024-07-23")?.photos[0];
    // 若 original 是 mid URL（解读 A），它应包含 photoMidCosKey(photoId) 的 key 部分
    if (photo?.original.includes("-mid.jpg")) {
      const expectedKey = mk(photoId);
      // original URL（含 host）应包含 key（不含 host 的相对路径）
      expect(photo.original).toContain(expectedKey);
    }
    // 若是 thumb fallback（解读 B），original 应含 -thumb.jpg
    else {
      expect(photo?.original).toContain("-thumb.jpg");
    }
  });
});

// ============================================================================
// 验收：faceFocus 谓词（S17 后端侧 + faceFocus 聚焦契约）
// 契约来源（state.md §契约规约 ManifestPhoto.faceFocus）：
//   - ManifestPhoto.faceFocus: { x: number; y: number } | null
//   - 来源：faces 表最大面积脸（bboxW*bboxH DESC）中心，按 photo.width/height 归一化
//   - detection_score < config.face.qualityLowDetectionScore（默认 0.65）的脸不参与
//   - width/height=0 或无脸 → null
//   - 钳制 [0.02, 0.98]
// ============================================================================
describe("buildManifest — faceFocus 谓词（§契约规约 ManifestPhoto.faceFocus）", () => {
  it("basic：1 张高质量脸（score=0.9，bbox 居中）→ faceFocus.x/y 在 [0,1] 且约等于 bbox 中心归一化", async () => {
    const bm = requireBuildManifest();
    const photoId = "uuid-ff-basic-aaaaaaaaaaaaaaaaaaaa";
    // photo 2000x1500，脸 bbox 1000,800,200,200 → 中心 (1100, 900) → 归一化 (0.55, 0.6)
    insertDay({
      pickDate: "2024-08-01",
      photoIds: [{ id: photoId, rank: 1, takenAt: null, width: 2000, height: 1500 }],
    });
    insertFace({ photoId, bboxX: 1000, bboxY: 800, bboxW: 200, bboxH: 200, detectionScore: 0.9 });

    const manifest = await bm();
    const photo = manifest.days.find((d) => d.pickDate === "2024-08-01")?.photos[0];
    if (!photo) throw new Error("photo missing");

    expect(photo.faceFocus, "应返回非空 faceFocus").not.toBeNull();
    expect(photo.faceFocus!.x).toBeGreaterThanOrEqual(0);
    expect(photo.faceFocus!.x).toBeLessThanOrEqual(1);
    expect(photo.faceFocus!.y).toBeGreaterThanOrEqual(0);
    expect(photo.faceFocus!.y).toBeLessThanOrEqual(1);
    // 期望 ≈ (1000+200/2)/2000 = 0.55, (800+200/2)/1500 = 0.6
    expect(photo.faceFocus!.x).toBeCloseTo(0.55, 1);
    expect(photo.faceFocus!.y).toBeCloseTo(0.6, 1);
  });

  it("null-no-face：无 faces 行 → faceFocus === null", async () => {
    const bm = requireBuildManifest();
    insertDay({
      pickDate: "2024-08-02",
      photoIds: [
        {
          id: "uuid-ff-noface-bbbbbbbbbbbbbbbbbbbb",
          rank: 1,
          takenAt: null,
          width: 2000,
          height: 1500,
        },
      ],
    });
    const manifest = await bm();
    const photo = manifest.days.find((d) => d.pickDate === "2024-08-02")?.photos[0];
    if (!photo) throw new Error("photo missing");
    expect(photo.faceFocus).toBeNull();
  });

  it("null-low-score：只低质脸（score=0.3 < 0.65）→ faceFocus === null", async () => {
    const bm = requireBuildManifest();
    const photoId = "uuid-ff-lowscore-cccccccccccccccccccc";
    insertDay({
      pickDate: "2024-08-03",
      photoIds: [{ id: photoId, rank: 1, takenAt: null, width: 2000, height: 1500 }],
    });
    insertFace({ photoId, bboxX: 1000, bboxY: 800, bboxW: 200, bboxH: 200, detectionScore: 0.3 });

    const manifest = await bm();
    const photo = manifest.days.find((d) => d.pickDate === "2024-08-03")?.photos[0];
    if (!photo) throw new Error("photo missing");
    expect(photo.faceFocus, "低质脸不应参与 faceFocus 计算").toBeNull();
  });

  it("multi-picks-largest：2 张高质量脸 → faceFocus 对应面积最大者中心", async () => {
    const bm = requireBuildManifest();
    const photoId = "uuid-ff-multi-dddddddddddddddddddd";
    insertDay({
      pickDate: "2024-08-04",
      photoIds: [{ id: photoId, rank: 1, takenAt: null, width: 2000, height: 1500 }],
    });
    // A: bbox 100,100,100,100 = 10000 → 中心 (150, 150)
    // B: bbox 200,200,200,200 = 40000 → 中心 (300, 300) —— 最大
    insertFace({ photoId, bboxX: 100, bboxY: 100, bboxW: 100, bboxH: 100, detectionScore: 0.9 });
    insertFace({ photoId, bboxX: 200, bboxY: 200, bboxW: 200, bboxH: 200, detectionScore: 0.9 });

    const manifest = await bm();
    const photo = manifest.days.find((d) => d.pickDate === "2024-08-04")?.photos[0];
    if (!photo) throw new Error("photo missing");
    expect(photo.faceFocus).not.toBeNull();
    // 期望 ≈ (200+200/2)/2000 = 0.15, (200+200/2)/1500 = 0.2
    expect(photo.faceFocus!.x).toBeCloseTo(0.15, 1);
    expect(photo.faceFocus!.y).toBeCloseTo(0.2, 1);
  });

  it("zero-dim：photo width=0/height=0 + 有脸 → faceFocus === null（防除零）", async () => {
    const bm = requireBuildManifest();
    const photoId = "uuid-ff-zerodim-eeeeeeeeeeeeeeeeeeee";
    insertDay({
      pickDate: "2024-08-05",
      photoIds: [{ id: photoId, rank: 1, takenAt: null, width: 0, height: 0 }],
    });
    insertFace({ photoId, bboxX: 100, bboxY: 100, bboxW: 100, bboxH: 100, detectionScore: 0.9 });

    const manifest = await bm();
    const photo = manifest.days.find((d) => d.pickDate === "2024-08-05")?.photos[0];
    if (!photo) throw new Error("photo missing");
    expect(photo.faceFocus, "width/height=0 应返回 null 防除零").toBeNull();
  });

  it("clamp：脸中心归一化 > 0.98 应钳制到 0.98（边界 [0.02, 0.98]）", async () => {
    const bm = requireBuildManifest();
    const photoId = "uuid-ff-clamp-ffffffffffffffffffff";
    // photo 3072x2304，脸 bbox 贴右上角 2900,0,300,300 → 中心 (3050, 150) → x 归一化 ≈ 0.993 > 0.98
    insertDay({
      pickDate: "2024-08-06",
      photoIds: [{ id: photoId, rank: 1, takenAt: null, width: 3072, height: 2304 }],
    });
    insertFace({ photoId, bboxX: 2900, bboxY: 0, bboxW: 300, bboxH: 300, detectionScore: 0.9 });

    const manifest = await bm();
    const photo = manifest.days.find((d) => d.pickDate === "2024-08-06")?.photos[0];
    if (!photo) throw new Error("photo missing");
    expect(photo.faceFocus).not.toBeNull();
    // 中心 x = (2900+300/2)/3072 = 3050/3072 ≈ 0.9928 > 0.98 → 钳制到 0.98
    expect(
      photo.faceFocus!.x,
      `faceFocus.x=${photo.faceFocus!.x} 应钳制到 0.98`,
    ).toBeLessThanOrEqual(0.98);
    expect(
      photo.faceFocus!.x,
      `faceFocus.x=${photo.faceFocus!.x} 应明显被钳制（< 0.993 原值）`,
    ).toBeLessThan(0.99);
  });
});

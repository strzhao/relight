/**
 * 验收测试：GET /api/daily/:pickDate/wallpaper 路由
 *
 * 覆盖设计文档 §新 API 路由：
 * - W/H 校验 1-8192；只传一个 → 400
 * - 都不传 → 返回默认 5120×2880 合成图（composedImagePath 字段）
 * - 缓存路径：{STORAGE_ROOT}/daily-composed/{pickDate}_{W}x{H}.jpg
 * - ETag (sha256) + Cache-Control: public, max-age=86400, immutable  // per design: max-age=86400
 * - 异常 → 302 重定向到 /api/photos/:photoId/original
 * - pickDate 严格 YYYY-MM-DD 正则校验
 * - 路由注册顺序：先 /:pickDate/wallpaper 再 /:id
 * - /api/daily/today 的 data 包含 composedImageUrl 字段
 *
 * 测试策略：mock db + mock 合成器（vi.mock），隔离路由层逻辑。
 * 合成器未实现时（蓝队待完成），路由相关测试依赖 mock 完成。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// 1. Mock 基础设施（必须在所有 import 前，vi.hoisted 保证）
// ============================================================

/**
 * 创建可链式调用的 Mock 对象，模拟 Drizzle ORM 链式调用。
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
      if (prop === "values") {
        return (...args: unknown[]) => chainableMock(args[0] ? [args[0]] : result);
      }
      if (prop === "set") {
        return (...args: unknown[]) => chainableMock(args[0] ? [args[0]] : result);
      }
      return chainableMock(result);
    },
  });
}

// ---- Mock DB ----

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../db", () => ({
  db: mockDb,
  schema: {
    dailyPicks: {
      id: "dailyPicks.id",
      photoId: "dailyPicks.photo_id",
      pickDate: "dailyPicks.pick_date",
      title: "dailyPicks.title",
      narrative: "dailyPicks.narrative",
      score: "dailyPicks.score",
      composedImagePath: "dailyPicks.composed_image_path",
      createdAt: "dailyPicks.created_at",
    },
    photos: {
      id: "photos.id",
      storageSourceId: "photos.storage_source_id",
      filePath: "photos.file_path",
      fileHash: "photos.file_hash",
      width: "photos.width",
      height: "photos.height",
      fileSize: "photos.file_size",
      thumbnailPath: "photos.thumbnail_path",
      takenAt: "photos.taken_at",
      createdAt: "photos.created_at",
      mediaType: "photos.media_type",
    },
  },
}));

// ---- Mock queues（防止连接 Redis） ----

vi.mock("../jobs/queues", () => ({
  scanQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
  analyzeQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
  dailyQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
}));

// ---- Mock 合成器（默认正常工作） ----

const mockComposeWallpaper = vi.hoisted(() => vi.fn());
const mockComposeAndSave = vi.hoisted(() => vi.fn());

vi.mock("../lib/wallpaper/composer", () => ({
  composeWallpaper: mockComposeWallpaper,
  composeAndSave: mockComposeAndSave,
  // 路由用此函数推导缓存路径，必须暴露真实实现的等价物
  composedCachePath: (pickDate: string, width: number, height: number) =>
    path.join(
      process.env.STORAGE_ROOT ?? os.tmpdir(),
      "daily-composed",
      `${pickDate}_${width}x${height}.jpg`,
    ),
}));

// ---- Import app（在 mock 注册之后） ----

import { createApp } from "../app";

// ============================================================
// 2. 测试夹具
// ============================================================

let tmpDir: string;
let testComposedImagePath: string;

/** 生成最小有效 JPEG buffer（FF D8 FF + 最小 EOI） */
function makeMinimalJpegBuffer(): Buffer {
  // 最小 JPEG：SOI + EOI
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
  ]);
}

/** 生成足够大的 fake JPEG buffer（>50KB） */
function makeLargeJpegBuffer(width = 1280, height = 720): Buffer {
  const size = Math.max(51 * 1024, width * height * 3);
  const buf = Buffer.alloc(size, 0x42);
  // 写入 JPEG 魔数
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 构造 DailyPick mock（含 composedImagePath） */
function makeDailyPick(overrides: Record<string, unknown> = {}) {
  return {
    id: "pick-test-001",
    photoId: "photo-test-001",
    pickDate: "2026-05-08",
    title: "测试·拾光",
    narrative:
      "五年前的今天，阳光洒满小院，你端着相机蹲在花丛间，轻轻按下快门，那一刻风是静的，世界只剩下盛开的蔷薇。",
    score: 8.7,
    composedImagePath: null as string | null,
    createdAt: "2026-05-08T06:00:00.000Z",
    ...overrides,
  };
}

/** 构造 Photo mock */
function makePhoto(overrides: Record<string, unknown> = {}) {
  return {
    id: "photo-test-001",
    storageSourceId: "source-001",
    filePath: "/photos/test.jpg",
    fileHash: "test-hash-001",
    width: 4000,
    height: 3000,
    fileSize: 5242880,
    thumbnailPath: "/thumbnails/test.jpg",
    takenAt: "2021-05-08T10:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    mediaType: "image",
    ...overrides,
  };
}

// ============================================================
// 3. Setup / Teardown
// ============================================================

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relight-wallpaper-route-test-"));

  // 创建 daily-composed 子目录
  const composedDir = path.join(tmpDir, "daily-composed");
  fs.mkdirSync(composedDir, { recursive: true });

  // 写一个测试缓存文件（模拟已合成的合成图）
  testComposedImagePath = path.join(composedDir, "2026-05-08_default.jpg");
  const jpegBuf = makeLargeJpegBuffer(1280, 720);
  fs.writeFileSync(testComposedImagePath, jpegBuf);

  // 设置 STORAGE_ROOT 指向临时目录
  process.env.STORAGE_ROOT = tmpDir;
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
  process.env.STORAGE_ROOT = undefined;
});

beforeEach(() => {
  // 用 resetAllMocks 确保 mockReturnValueOnce 队列在 case 间不会泄漏。
  // clearAllMocks 只清调用历史，不清 once 队列，会导致后置 case 拿到前置 case 残留的返回值。
  vi.resetAllMocks();

  // 默认 DB mock：查询返回空
  mockDb.select.mockReturnValue(chainableMock([]));
  mockDb.insert.mockReturnValue(chainableMock([]));
  mockDb.update.mockReturnValue(chainableMock([]));

  // 默认 composeWallpaper mock：返回大 JPEG buffer
  mockComposeWallpaper.mockResolvedValue(makeLargeJpegBuffer(1280, 720));

  // 默认 composeAndSave mock：写文件 + 返回路径
  mockComposeAndSave.mockImplementation(
    async (opts: {
      pick: { pickDate: string };
      width: number;
      height: number;
      cacheKey: string;
    }) => {
      const composedDir = path.join(tmpDir, "daily-composed");
      fs.mkdirSync(composedDir, { recursive: true });
      const filePath = path.join(
        composedDir,
        `${opts.pick.pickDate}_${opts.cacheKey === "default" ? "default" : `${opts.width}x${opts.height}`}.jpg`,
      );
      const buf = makeLargeJpegBuffer(opts.width, opts.height);
      fs.writeFileSync(filePath, buf);
      return filePath;
    },
  );
});

// ============================================================
// 4. 辅助函数
// ============================================================

function app() {
  return createApp();
}

async function getRequest(path: string) {
  const res = await app().request(path, { method: "GET" });
  return res;
}

/** 解析响应（JSON 或 buffer） */
async function parseResponse(res: Response) {
  const contentType = res.headers.get("Content-Type") ?? "";
  if (contentType.includes("image/")) {
    const arrayBuffer = await res.arrayBuffer();
    return {
      status: res.status,
      body: Buffer.from(arrayBuffer),
      headers: res.headers,
      isImage: true,
    };
  }
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers, isImage: false };
}

// ============================================================
// 5. 测试套件
// ============================================================

describe("GET /api/daily/:pickDate/wallpaper — 验收测试（设计文档 §新 API 路由）", () => {
  // ----------------------------------------------------------
  // AT1: 缓存命中 → 200 + image/jpeg + ETag + Cache-Control
  // ----------------------------------------------------------
  describe("AT1: 缓存命中 → 200 + image/jpeg + 正确响应头", () => {
    it("pickDate 存在 + composedImagePath 非空 + 文件存在 → 200 + image/jpeg", async () => {
      const cacheFile = path.join(tmpDir, "daily-composed", "2026-05-08_1280x720.jpg");
      fs.writeFileSync(cacheFile, makeLargeJpegBuffer(1280, 720));

      const pick = makeDailyPick({ composedImagePath: testComposedImagePath });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await getRequest("/api/daily/2026-05-08/wallpaper?width=1280&height=720");
      const { status, isImage, headers } = await parseResponse(res);

      expect(status).toBe(200);
      expect(isImage).toBe(true);
      expect(headers.get("Cache-Control") ?? "").toContain("max-age=86400");
      expect(headers.get("ETag")).toBeTruthy();
    });

    it("路由应在 /:id 之前注册（/:pickDate/wallpaper 不被 /:id 截断）", async () => {
      const cacheFile = path.join(tmpDir, "daily-composed", "2026-05-08_1280x720.jpg");
      fs.writeFileSync(cacheFile, makeLargeJpegBuffer(1280, 720));

      const pick = makeDailyPick({ composedImagePath: testComposedImagePath });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await getRequest("/api/daily/2026-05-08/wallpaper?width=1280&height=720");
      expect(res.status).toBe(200);
      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).toContain("image/jpeg");
      expect(contentType).not.toContain("application/json");
    });
  });

  // ----------------------------------------------------------
  // AT2: 自定义尺寸 2560×1440
  // ----------------------------------------------------------
  describe("AT2: ?width=2560&height=1440 → 200 + 正确尺寸 JPEG", () => {
    it("传入 width=2560 height=1440，响应为 2560×1440 JPEG（用 sharp metadata 验）", async () => {
      const pick = makeDailyPick({ composedImagePath: testComposedImagePath });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      // 让 composeWallpaper 返回正确尺寸
      const sharp = (await import("sharp")).default;
      const realBuffer = await sharp({
        create: { width: 2560, height: 1440, channels: 3, background: { r: 100, g: 149, b: 237 } },
      })
        .jpeg({ quality: 90 })
        .toBuffer();
      mockComposeWallpaper.mockResolvedValueOnce(realBuffer);
      mockComposeAndSave.mockImplementationOnce(async () => {
        const p = path.join(tmpDir, "daily-composed", "2026-05-08_2560x1440.jpg");
        fs.writeFileSync(p, realBuffer);
        return p;
      });

      const res = await getRequest("/api/daily/2026-05-08/wallpaper?width=2560&height=1440");

      expect(res.status).toBe(200);
      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).toContain("image/jpeg");

      const arrayBuffer = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      const meta = await sharp(buf).metadata();
      expect(meta.width).toBe(2560);
      expect(meta.height).toBe(1440);
    });
  });

  // ----------------------------------------------------------
  // AT3: 重复请求 → 第二次更快 + 内容字节级相同
  // ----------------------------------------------------------
  describe("AT3: 重复请求同 width/height → 缓存命中 + sha256 一致", () => {
    it("第二次请求比第一次快 + 两次内容 sha256 相同", async () => {
      const pick = makeDailyPick({ composedImagePath: testComposedImagePath });

      // 两次 DB 查询都返回相同 pick
      mockDb.select
        .mockReturnValue(chainableMock([pick]))
        .mockReturnValue(chainableMock([makePhoto()]));

      // 预先写缓存文件
      const cacheFile = path.join(tmpDir, "daily-composed", "2026-05-08_1280x720.jpg");
      const expectedContent = makeLargeJpegBuffer(1280, 720);
      fs.writeFileSync(cacheFile, expectedContent);

      const t1Start = Date.now();
      const res1 = await getRequest("/api/daily/2026-05-08/wallpaper?width=1280&height=720");
      const t1Duration = Date.now() - t1Start;

      const t2Start = Date.now();
      const res2 = await getRequest("/api/daily/2026-05-08/wallpaper?width=1280&height=720");
      const t2Duration = Date.now() - t2Start;

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const buf1 = Buffer.from(await res1.arrayBuffer());
      const buf2 = Buffer.from(await res2.arrayBuffer());

      expect(sha256(buf1)).toBe(sha256(buf2));

      // 仅在第一次足够慢时验性能差异，避免 CI 抖动
      if (t1Duration > 100) {
        expect(t2Duration).toBeLessThan(t1Duration * 0.5 + 50);
      }
    });
  });

  // ----------------------------------------------------------
  // AT4: 未知 pickDate → 404
  // ----------------------------------------------------------
  describe("AT4: 未知 pickDate → 404", () => {
    it("DB 中不存在该 pickDate → 404", async () => {
      mockDb.select.mockReturnValue(chainableMock([]));

      const res = await getRequest("/api/daily/2020-01-01/wallpaper?width=1280&height=720");

      expect(res.status).toBe(404);
      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).not.toContain("image/jpeg");
    });
  });

  // ----------------------------------------------------------
  // AT5: 参数越界 width=10000 → 400
  // ----------------------------------------------------------
  describe("AT5: 参数越界 width=10000 → 400", () => {
    it("width=10000（超出 1-8192 范围）→ 400 Bad Request", async () => {
      const pick = makeDailyPick({ composedImagePath: testComposedImagePath });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await getRequest("/api/daily/2026-05-08/wallpaper?width=10000&height=720");
      expect(res.status).toBe(400);
      const body = await res.json().catch(() => null);
      expect(body).toBeTruthy();
    });

    it("height=0（低于 1）→ 400 Bad Request", async () => {
      const res = await getRequest("/api/daily/2026-05-08/wallpaper?width=1280&height=0");
      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------
  // AT6: 只传 width 不传 height → 400
  // ----------------------------------------------------------
  describe("AT6: 只传 width 不传 height → 400", () => {
    it("只传 width=1280 不传 height → 400（设计：二者必须同时传或都不传）", async () => {
      const pick = makeDailyPick({ composedImagePath: testComposedImagePath });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await getRequest("/api/daily/2026-05-08/wallpaper?width=1280");
      expect(res.status).toBe(400);
    });

    it("只传 height=720 不传 width → 400", async () => {
      const res = await getRequest("/api/daily/2026-05-08/wallpaper?height=720");
      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------
  // AT7: pickDate 格式错误 → 400
  // ----------------------------------------------------------
  describe("AT7: pickDate 格式错误 → 400", () => {
    const invalidDates = [
      { value: "2026-13-99", desc: "非法日期（月份超范围）" },
      { value: "invalid-date", desc: "非日期字符串" },
      { value: "20260508", desc: "缺少分隔符" },
    ];

    for (const { value, desc } of invalidDates) {
      it(`${desc}: pickDate="${value}" → 400`, async () => {
        const res = await getRequest(`/api/daily/${value}/wallpaper?width=1280&height=720`);
        expect(res.status).toBe(400);
      });
    }

    it("含路径穿越的 pickDate（如 ../etc）→ 400（安全边界）", async () => {
      const res = await getRequest("/api/daily/..%2Fetc/wallpaper?width=1280&height=720");
      // 不允许 200，且应是格式校验拒绝
      expect(res.status).toBe(400);
    });

    it("pickDate 带时间戳（如 2026-05-08T06:00:00Z）→ 400（非纯日期格式）", async () => {
      const res = await getRequest(
        "/api/daily/2026-05-08T06:00:00Z/wallpaper?width=1280&height=720",
      );
      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------
  // AT8: 合成失败 → 302 重定向到原图
  // ----------------------------------------------------------
  describe("AT8: 合成失败 → 302 重定向到 /api/photos/:photoId/original", () => {
    it("合成器抛错时 → 302 重定向到原图", async () => {
      // 用独立 pickDate + 尺寸，避免命中前面测试遗留的缓存文件
      const pick = makeDailyPick({ pickDate: "2026-08-01", composedImagePath: null });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      mockComposeWallpaper.mockRejectedValueOnce(new Error("模拟合成失败：磁盘已满"));
      mockComposeAndSave.mockRejectedValueOnce(new Error("模拟合成失败：磁盘已满"));

      const res = await getRequest("/api/daily/2026-08-01/wallpaper?width=999&height=555");

      expect(res.status).toBe(302);
      const location = res.headers.get("Location") ?? "";
      expect(location).toContain("/api/photos/");
      expect(location).toContain("/original");
      expect(location).toContain("photo-test-001");
    });

    it("composedImagePath 文件不存在（磁盘丢失）且合成失败 → 302", async () => {
      const pick = makeDailyPick({
        pickDate: "2026-08-02",
        composedImagePath: "/nonexistent/path/does-not-exist.jpg",
      });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      mockComposeWallpaper.mockRejectedValueOnce(new Error("合成失败"));
      mockComposeAndSave.mockRejectedValueOnce(new Error("合成失败"));

      const res = await getRequest("/api/daily/2026-08-02/wallpaper?width=999&height=555");

      expect(res.status).toBe(302);
      const location = res.headers.get("Location") ?? "";
      expect(location).toMatch(/\/api\/photos\/.+\/original/);
    });
  });

  // ----------------------------------------------------------
  // AT9: /api/daily/today 响应包含 composedImageUrl 字段
  // ----------------------------------------------------------
  describe("AT9: /api/daily/today data 包含 composedImageUrl 字段", () => {
    it("有今日精选时 data.composedImageUrl 为 /api/daily/{pickDate}/wallpaper", async () => {
      const pick = makeDailyPick({
        composedImagePath: testComposedImagePath,
      });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await getRequest("/api/daily/today");
      const body = await res.json().catch(() => null);

      expect(res.status).toBe(200);
      expect(body?.success).toBe(true);
      expect(body?.data).not.toBeNull();
      expect(body.data).toHaveProperty("composedImageUrl");
      expect(body.data.composedImageUrl).toBe(`/api/daily/${pick.pickDate}/wallpaper`);
      expect(body.data.composedImageUrl).toMatch(/^\/api\/daily\/\d{4}-\d{2}-\d{2}\/wallpaper$/);
    });

    it("composedImagePath 为 null 时 composedImageUrl 应为 null", async () => {
      const pick = makeDailyPick({ composedImagePath: null });
      mockDb.select.mockReset();
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]))
        .mockReturnValue(chainableMock([]));

      const res = await getRequest("/api/daily/today");
      const body = await res.json().catch(() => null);

      expect(res.status).toBe(200);
      expect(body?.data).not.toBeNull();
      expect(body.data).toHaveProperty("composedImageUrl");
      expect(body.data.composedImageUrl).toBeNull();
    });

    it("无今日精选时 today 返回 data: null（非 404），不含 composedImageUrl", async () => {
      // 重置 mock，确保空结果
      mockDb.select.mockReset();
      mockDb.select.mockReturnValue(chainableMock([]));

      const res = await getRequest("/api/daily/today");
      const body = await res.json().catch(() => null);

      expect(res.status).toBe(200);
      expect(body?.success).toBe(true);
      expect(body?.data).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // 补充：不传 width/height → 使用默认 5120×2880 合成图
  // ----------------------------------------------------------
  describe("不传 width/height → 使用默认合成图", () => {
    it("都不传时应返回 composedImagePath 对应的文件（5120×2880 默认合成图）", async () => {
      const pick = makeDailyPick({ composedImagePath: testComposedImagePath });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await getRequest("/api/daily/2026-05-08/wallpaper");

      expect(res.status).toBe(200);
      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).toContain("image/jpeg");
    });

    it("composedImagePath 为 null 且不传尺寸 → 触发默认尺寸合成或 302", async () => {
      const pick = makeDailyPick({ composedImagePath: null });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await getRequest("/api/daily/2026-05-08/wallpaper");

      // 路由实现后：合成成功 200 或合成失败降级 302，二选一
      expect([200, 302]).toContain(res.status);
    });
  });

  // ----------------------------------------------------------
  // 响应头约定
  // ----------------------------------------------------------
  describe("响应头约定", () => {
    it("成功响应应包含 ETag header（sha256 of 合成图）", async () => {
      const cacheFile = path.join(tmpDir, "daily-composed", "2026-05-08_640x360.jpg");
      fs.writeFileSync(cacheFile, makeLargeJpegBuffer(640, 360));

      const pick = makeDailyPick({ composedImagePath: testComposedImagePath });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await getRequest("/api/daily/2026-05-08/wallpaper?width=640&height=360");

      expect(res.status).toBe(200);
      const etag = res.headers.get("ETag");
      expect(etag).toBeTruthy();
      const etagValue = (etag ?? "").replace(/"/g, "");
      expect(etagValue.length).toBeGreaterThanOrEqual(16);
    });

    it("成功响应应包含 Cache-Control: max-age=86400", async () => {
      const pick = makeDailyPick({ composedImagePath: testComposedImagePath });
      mockDb.select
        .mockReturnValueOnce(chainableMock([pick]))
        .mockReturnValueOnce(chainableMock([makePhoto()]));

      const res = await getRequest("/api/daily/2026-05-08/wallpaper?width=1280&height=720");

      expect(res.status).toBe(200);
      const cacheControl = res.headers.get("Cache-Control") ?? "";
      expect(cacheControl).toContain("max-age=86400");
    });
  });
});

/**
 * 红队验收测试：original / raw 端点 Content-Type 按真实字节（magic byte）判定
 *
 * 【信息隔离铁律】
 * 本文件仅基于设计文档编写，代表「设计应达到的状态」(TDD 红灯)。
 * 不读取、不引用蓝队新写的 routes/photos.ts 实现或 lib/mime.ts 实现。
 *
 * 验收点（每条 ≥1 硬断言）：
 *  P1: .HEIC 扩展名 + JPEG magic byte 的文件 → GET /original → Content-Type 含 image/jpeg
 *  P2: 同文件 → GET /raw → Content-Type 含 image/jpeg
 *  P3: 真 HEIC（ftyp+heic magic byte）→ GET /original → image/jpeg（转码后）
 *  P4: 真 HEIC → GET /raw → image/heic（raw 不转码，预期行为，断言此为正确）
 *  P5: 真 JPG（.jpg + JPEG byte）→ GET /original → image/jpeg（回归不破）
 *
 * 测试架构：
 *  - mock ../db：返回受控 photo 记录（id / filePath / rootPath / storageType）
 *  - mock ../storage：createStorageAdapter 返回受控 adapter，getMimeType 按扩展名（模拟当前 bug 源）
 *      getFileBuffer 返回构造的 magic-byte buffer（original 端点用此）
 *  - mock ../lib/heic：isHeicBuffer / convertHeicToJpeg 按需可控（隔离真实 heic-decode + sharp）
 *  - 真实临时文件落盘：raw 端点用 createReadStream(fullPath) 直接读盘，故必须写真文件；
 *      original 端点用 fs.access(fullPath) 检查存在性，亦需文件存在。
 *  - mock ../jobs/queues：防止连接 Redis。
 *
 * 这样路由内部对 contentType 的判定（sniff vs getMimeType）是黑盒可观测的：
 *  若仍按扩展名 → .HEIC 错配返回 image/heic（红灯）；
 *  若改为 sniff → .HEIC 错配返回 image/jpeg（绿灯）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ============================================================
// 1. 构造 magic-byte buffer（不依赖实现，纯字节常量）
// ============================================================

/** JPEG JFIF 头（FF D8 FF E0 ...）—— 足够 sniff 命中 */
function jpegBytes(minLen = 128): Buffer {
  const head = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0, // SOI + APP0
    0x00,
    0x10, // length
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00, // 'JFIF\0'
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
  ]);
  if (head.length >= minLen) return head;
  return Buffer.concat([head, Buffer.alloc(minLen - head.length, 0)]);
}

/** 真 HEIC magic byte：offset 4-7 = 'ftyp'，8-11 = 'heic' */
function heicBytes(minLen = 128): Buffer {
  const buf = Buffer.alloc(Math.max(32, minLen), 0);
  // offset 0-3 = ftyp box size (placeholder 0x18)
  buf.writeUInt32BE(0x18, 0);
  Buffer.from("ftyp", "ascii").copy(buf, 4);
  Buffer.from("heic", "ascii").copy(buf, 8);
  Buffer.from("mif1", "ascii").copy(buf, 12); // minor brand
  return buf;
}

// ============================================================
// 2. 受控 photo 记录（routes/photos.ts 的 JOIN 投影字段）
//    路由只读 photo.{id, filePath, rootPath, storageType}
// ============================================================

interface PhotoRow {
  id: string;
  filePath: string;
  rootPath: string;
  storageType: string;
}

// 每个测试场景独占一个 rootPath 临时目录，互不污染。
// 这些变量在 mock 工厂里被引用，beforeEach/each it 前重新赋值。
let currentPhoto: PhotoRow;
let currentFileBytes: Buffer;

// ============================================================
// 3. Mock 基础设施
// ============================================================

// ---- Mock DB（chainable，select 返回受控 photo 行） ----
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

vi.mock("../db", () => ({
  db: chainableMock([]),
  // routes/photos.ts 通过 schema.photos / schema.storageSources 引用列；
  // chainable 的 db.select(...).from(...).innerJoin(...).where(...).limit(1)
  // 最终 resolve 到 currentPhoto（由测试动态注入）。
  // 为让路由读到 currentPhoto，我们让 db 的 select 链 resolve 到一个数组。
  // 但 currentPhoto 是动态的 —— 改用 vi.hoisted + 动态读取。
}));

// 更精确：用一个工厂让 db 查询每次 resolve 到 [currentPhoto]。
// 由于 currentPhoto 在测试体里赋值，mock 必须延迟读取 —— 用 getter。
vi.mock("../db", () => {
  const makeProxy = (): unknown =>
    new Proxy(() => {}, {
      apply() {
        return makeProxy();
      },
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve([currentPhotoRef.value]);
        }
        if (prop === Symbol.toPrimitive || prop === "toString") return () => "[]";
        return makeProxy();
      },
    });
  // 共享 ref —— 测试体里 setPhoto() 更新
  return {
    db: makeProxy(),
    schema: new Proxy({}, { get: () => makeProxy() }),
  };
});

// currentPhoto 的动态 ref（绕过模块顶层 const 限制）
const currentPhotoRef = { value: undefined as PhotoRow | undefined };

// ---- Mock storage adapter ----
vi.mock("../storage", () => ({
  createStorageAdapter: (_type: string) => ({
    // getMimeType 按扩展名映射 —— 模拟当前 bug 源（纯扩展名）
    // 设计修复后，路由内部会先 sniff buffer，命中则覆盖此值。
    getMimeType: (filePath: string): string => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".heic" || ext === ".heif") return "image/heic";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".png") return "image/png";
      if (ext === ".webp") return "image/webp";
      if (ext === ".gif") return "image/gif";
      if (ext === ".bmp") return "image/bmp";
      if (ext === ".tiff" || ext === ".tif") return "image/tiff";
      if (ext === ".mp4") return "video/mp4";
      if (ext === ".mov") return "video/quicktime";
      return "application/octet-stream";
    },
    // original 端点：getFileBuffer 返回构造的 magic-byte buffer
    getFileBuffer: async (_filePath: string): Promise<Buffer> => currentFileBytesRef.value,
  }),
}));

// currentFileBytes 的动态 ref
const currentFileBytesRef = { value: Buffer.alloc(0) };

// ---- Mock lib/heic —— 隔离真实 heic-decode + sharp ----
// 真 HEIC 转码链路有自己的测试；此处只需路由层决策正确。
// isHeicBuffer 按真实 magic byte 判定（与 routes 现有哲学一致）。
const heicBrands = new Set(["heic", "heix", "heif", "mif1", "msf1", "hevc", "hevx"]);
vi.mock("../lib/heic", () => ({
  isHeicBuffer: (buf: Buffer): boolean => {
    if (buf.length < 12) return false;
    if (buf.toString("ascii", 4, 8) !== "ftyp") return false;
    return heicBrands.has(buf.toString("ascii", 8, 12).toLowerCase());
  },
  // convertToJpeg 返回 JPEG 字节（模拟转码产物），Content-Type 由路由设为 image/jpeg
  convertHeicToJpeg: async (buffer: Buffer): Promise<Buffer> => {
    // 返回真实 JPEG magic byte，保证响应体头部 = FF D8 FF
    return jpegBytes(Math.max(128, buffer.length));
  },
}));

// ---- Mock queues（防止连接 Redis） ----
vi.mock("../jobs/queues", () => ({
  scanQueue: { add: () => Promise.resolve({ id: "mock" }) },
  analyzeQueue: { add: () => Promise.resolve({ id: "mock" }) },
  dailyQueue: { add: () => Promise.resolve({ id: "mock" }) },
}));

// ============================================================
// 4. 测试工具
// ============================================================

import { createApp } from "../app";

async function app() {
  return createApp();
}

/** 设置一个 photo 场景：写真文件到临时目录，注入 photo 行 + buffer */
function setupPhoto(opts: {
  id: string;
  ext: string; // 文件扩展名（决定 getMimeType 扩展名映射）
  bytes: Buffer; // 真实文件字节（决定 sniff + isHeicBuffer）
}): { dir: string; fullPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relight-ct-"));
  const fileName = `IMG_${opts.id}${opts.ext}`;
  const fullPath = path.join(dir, fileName);
  fs.writeFileSync(fullPath, opts.bytes);

  currentPhotoRef.value = {
    id: opts.id,
    filePath: fileName, // 路由用 path.resolve(rootPath, filePath)
    rootPath: dir,
    storageType: "local",
  };
  currentFileBytesRef.value = opts.bytes;

  return { dir, fullPath };
}

function cleanupDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ============================================================
// 5. 测试
// ============================================================

describe("original / raw Content-Type 按真实字节判定 — 验收测试（P1-P5）", () => {
  const createdDirs: string[] = [];

  afterAll(() => {
    for (const dir of createdDirs) cleanupDir(dir);
  });

  // -----------------------------------------------------------
  // P1: .HEIC 扩展名 + JPEG 字节 → /original → image/jpeg
  // -----------------------------------------------------------
  describe("P1: 错配文件（.HEIC 扩展名 + JPEG 字节）GET /original", () => {
    it("Content-Type 应含 image/jpeg（按 magic byte，非扩展名 image/heic）", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "mismatch-heic-jpeg", ext: ".HEIC", bytes: jpegBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/mismatch-heic-jpeg/original", { method: "GET" });

      expect(res.status).toBe(200);
      const contentType = res.headers.get("Content-Type") ?? "";
      // 核心断言：必须是 image/jpeg，不是 image/heic（否则浏览器裂图）
      expect(contentType).toContain("image/jpeg");
      expect(contentType).not.toContain("image/heic");
    });

    it("响应体头部应为 JPEG magic byte (FF D8 FF)", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "mismatch-body", ext: ".HEIC", bytes: jpegBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/mismatch-body/original", { method: "GET" });
      const buf = Buffer.from(await res.arrayBuffer());

      // 验证响应体确实是 JPEG 字节（FF D8 FF）
      expect(buf.length).toBeGreaterThanOrEqual(3);
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);
      expect(buf[2]).toBe(0xff);
    });
  });

  // -----------------------------------------------------------
  // P2: 同错配文件 → /raw → image/jpeg
  //     raw 端点流式（createReadStream），读真实文件字节
  // -----------------------------------------------------------
  describe("P2: 错配文件（.HEIC 扩展名 + JPEG 字节）GET /raw", () => {
    it("Content-Type 应含 image/jpeg（图片类按 magic byte sniff）", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "mismatch-raw", ext: ".HEIC", bytes: jpegBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/mismatch-raw/raw", { method: "GET" });

      expect(res.status).toBe(200);
      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).toContain("image/jpeg");
      expect(contentType).not.toContain("image/heic");
    });

    it("响应体头部应为 JPEG magic byte（raw 流式不转码，原样 JPEG 字节）", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "mismatch-raw-body", ext: ".HEIC", bytes: jpegBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/mismatch-raw-body/raw", { method: "GET" });
      const buf = Buffer.from(await res.arrayBuffer());

      expect(buf.length).toBeGreaterThanOrEqual(3);
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);
      expect(buf[2]).toBe(0xff);
    });
  });

  // -----------------------------------------------------------
  // P3: 真 HEIC（ftyp+heic magic byte）→ /original → image/jpeg（转码后）
  // -----------------------------------------------------------
  describe("P3: 真 HEIC GET /original → image/jpeg（转码后）", () => {
    it("Content-Type 应为 image/jpeg（HEIC 经 convertHeicToJpeg 转码）", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "real-heic-orig", ext: ".HEIC", bytes: heicBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/real-heic-orig/original", { method: "GET" });

      expect(res.status).toBe(200);
      const contentType = res.headers.get("Content-Type") ?? "";
      // 真 HEIC 经转码后应为 image/jpeg（浏览器可渲染）
      expect(contentType).toContain("image/jpeg");
    });

    it("响应体应为 JPEG 字节（转码产物，头部 FF D8 FF）", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "real-heic-orig-body", ext: ".HEIC", bytes: heicBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/real-heic-orig-body/original", { method: "GET" });
      const buf = Buffer.from(await res.arrayBuffer());

      expect(buf.length).toBeGreaterThanOrEqual(3);
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);
      expect(buf[2]).toBe(0xff);
    });
  });

  // -----------------------------------------------------------
  // P4: 真 HEIC → /raw → image/heic（raw 不转码，预期行为）
  //     这是设计的明确决策：raw 端点流式原样，大图渲染走 original
  // -----------------------------------------------------------
  describe("P4: 真 HEIC GET /raw → image/heic（raw 不转码，预期行为）", () => {
    it("Content-Type 应为 image/heic（raw 流式原样，不转码）", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "real-heic-raw", ext: ".HEIC", bytes: heicBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/real-heic-raw/raw", { method: "GET" });

      expect(res.status).toBe(200);
      const contentType = res.headers.get("Content-Type") ?? "";
      // 断言此为正确行为：raw 不转码，真 HEIC 流式返回 image/heic
      // （大图渲染应走 original 端点的转码路径）
      expect(contentType).toContain("image/heic");
    });

    it("响应体头部应为 HEIC magic byte（ftyp + heic brand，原样未转码）", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "real-heic-raw-body", ext: ".HEIC", bytes: heicBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/real-heic-raw-body/raw", { method: "GET" });
      const buf = Buffer.from(await res.arrayBuffer());

      // offset 4-7 = 'ftyp'
      expect(buf.toString("ascii", 4, 8)).toBe("ftyp");
      // offset 8-12 = brand 'heic'
      expect(buf.toString("ascii", 8, 12)).toBe("heic");
    });
  });

  // -----------------------------------------------------------
  // P5: 真 JPG（.jpg + JPEG byte）→ /original → image/jpeg（回归不破）
  // -----------------------------------------------------------
  describe("P5: 真 JPG GET /original（回归不破）", () => {
    it("Content-Type 应为 image/jpeg（扩展名与字节一致，无错配）", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "real-jpg-orig", ext: ".jpg", bytes: jpegBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/real-jpg-orig/original", { method: "GET" });

      expect(res.status).toBe(200);
      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).toContain("image/jpeg");
    });

    it("真 JPG GET /raw 也应为 image/jpeg", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "real-jpg-raw", ext: ".jpg", bytes: jpegBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/real-jpg-raw/raw", { method: "GET" });

      expect(res.status).toBe(200);
      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType).toContain("image/jpeg");
    });
  });

  // -----------------------------------------------------------
  // 补充契约：路径 / 方法 / DTO 不变（路由仍可访问，非 500）
  // -----------------------------------------------------------
  describe("契约不变：路径 / 方法 / 状态码", () => {
    it("GET /api/photos/:id/original 路由仍存在（非 404 路由未注册）", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "contract-orig", ext: ".jpg", bytes: jpegBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/contract-orig/original", { method: "GET" });
      expect(res.status).toBe(200);
    });

    it("GET /api/photos/:id/raw 路由仍存在（非 404 路由未注册）", async () => {
      const a = await app();
      const { dir } = setupPhoto({ id: "contract-raw", ext: ".jpg", bytes: jpegBytes() });
      createdDirs.push(dir);

      const res = await a.request("/api/photos/contract-raw/raw", { method: "GET" });
      expect(res.status).toBe(200);
    });
  });
});

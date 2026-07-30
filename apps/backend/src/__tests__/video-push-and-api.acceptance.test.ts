/**
 * 验收测试（红队）：视频 API 契约 + 无候选不推送
 *
 * 设计契约来源（state.md ## 契约规约 + ## 验收场景）：
 *
 *   API 契约（src/routes/videos.ts，挂载 app.ts → /api/videos）：
 *     GET /api/videos → 200 { videos: [{id, title, themeKind, themeKey,
 *                                        coverUrl, durationSec, createdAt}] }（createdAt desc）
 *     GET /api/videos/:id/cover → 200 image/jpeg
 *     GET /api/videos/:id/stream →
 *       - 有 Range 头：createReadStream(path,{start,end}) + 206 +
 *         Content-Range: bytes start-end/total + Accept-Ranges: bytes
 *       - 无 Range 头：200 全量 + Accept-Ranges: bytes
 *       - Content-Type: video/mp4, Cache-Control: public max-age=86400 immutable, ETag
 *
 *   推送反向谓词（job 层）：
 *     无候选（discovery 返回 []）→ 不入队/不产 mp4/不推送（webhook 0 次）
 *
 * 覆盖预注册谓词：
 *   8. NO-PUSH-ON-NO-VIDEO（无候选分支）：空 DB 触发 → webhook 0 次
 *  10. API-VIDEO-LIST-AND-STREAM：GET /api/videos 列表 + /:id/stream Range 206 + Content-Range
 *
 * 注：谓词 7（WECOM-PUSH-ON-NEW-VIDEO，成功后推送）与谓词 8 失败分支已由
 *     video-claude-runner-and-persist.acceptance.test.ts 覆盖（该文件有完整真实 DB + worker 环境）。
 *     本文件聚焦 API 契约 + 无候选反向谓词（不依赖 discovery 真实跑，用 mock db 即可）。
 *
 * 红队铁律：
 *   - 不读 routes/videos.ts / jobs/daily-video.ts 实现逻辑（仅 export 签名 + 路由表）
 *   - API 测试：Hono createApp() 直接调（参照 daily-api.acceptance.test.ts）
 *   - stream Range：真实临时 mp4 + mock db.output_path 指向它（验真实 createReadStream）
 *   - 推送 mock：vi.mock("../lib/push/wechat") 计数（参照 daily-push-worker.acceptance.test.ts）
 *
 * 契约假设（标注）：
 *   - videosRouter 挂载于 /api/videos（app.ts 已确认）
 *   - 列表响应 { videos: [...] }（设计文档 API 契约原文）
 *   - stream 解析 Range: bytes=start-end（设计文档 stream 契约原文）
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// ffmpeg 探测（stream 测试需真实 mp4 文件）
// ============================================================================

function ffmpegAvailable(): boolean {
  try {
    return spawnSync("ffmpeg", ["-version"], { encoding: "utf-8", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}
const HAS_FFMPEG = ffmpegAvailable();

// ============================================================================
// mock 链：db / config / wechat / queues
// ============================================================================

// chainable mock（drizzle 链式查询，参照 daily-api.acceptance.test.ts）
function chainableMock(result: unknown[] = []) {
  const fn = () => chainableMock(result);
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

const mockDb = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock("../db", () => ({ db: mockDb, schema: chainableMock([]) }));

vi.mock("../lib/config", () => ({
  config: {
    databasePath: ":memory:",
    storageRoot: "/tmp/relight-none",
    videoWorkspacePath: "/tmp/relight-none",
    claudeCliPath: "/usr/bin/false",
    redisUrl: "redis://localhost:6379",
    bullmqPrefix: "bull-video-api-test",
    ai: { baseUrl: "", apiKey: "", visionModel: "", model: "", promptVersion: "v2" },
    daily: { cronTime: "0 3 * * *", maxCandidates: 20, timezone: "Asia/Shanghai" },
    video: { enabled: true, frameCount: 6, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" },
    dailySelectionConcurrency: 1,
    dailyAutoHealDays: 0,
    dailySelectEnabled: false,
    minAestheticScorePrimary: 7.0,
    face: {},
  },
}));

// mock wechat（捕获推送调用计数 —— 谓词 8 无候选分支用）
const wechatMocks = vi.hoisted(() => ({
  sendWallpaperToWeCom: vi.fn(async () => ({ errcode: 0, errmsg: "ok" })),
  compressForWeCom: vi.fn(async (buf: Buffer) => buf),
  getDailyPushSettings: vi.fn(async () => ({
    webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-token-001",
    enabled: true,
  })),
}));
vi.mock("../lib/push/wechat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push/wechat")>();
  return {
    ...actual,
    sendWallpaperToWeCom: wechatMocks.sendWallpaperToWeCom,
    compressForWeCom: wechatMocks.compressForWeCom,
    getDailyPushSettings: wechatMocks.getDailyPushSettings,
  };
});

// mock queues（app.ts 启动会 import queues，避免 Redis 连接）
vi.mock("../jobs/queues", () => ({
  scanQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  analyzeQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  dailyQueue: { add: vi.fn(async () => ({ id: "mock" })) },
  dailyPushQueue: { add: vi.fn(async () => ({ id: "mock" })) },
}));

// ============================================================================
// 辅助：生成测试 mp4 / jpeg
// ============================================================================

function makeSmallMp8(outPath: string): boolean {
  if (!HAS_FFMPEG) return false;
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1920x1080:rate=24",
      "-frames:v",
      "24",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ],
    { encoding: "utf-8", timeout: 30_000 },
  );
  return r.status === 0 && fs.existsSync(outPath);
}

function makeJpeg(outPath: string): boolean {
  if (!HAS_FFMPEG) return false;
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "color=c=red:s=4x4:d=1", "-frames:v", "1", outPath],
    { encoding: "utf-8", timeout: 10_000 },
  );
  return r.status === 0 && fs.existsSync(outPath);
}

/** mock job */
function makeJob(id: string, data: Record<string, unknown> = {}): unknown {
  return {
    data,
    id,
    name: "daily-video-cron",
    log: () => {},
    updateProgress: () => {},
  };
}

// ============================================================================
// 测试套件
// ============================================================================

describe("视频 API + 无候选不推送 — 验收测试（谓词 8 无候选分支 / 谓词 10）", () => {
  let tmpRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-videoapi-"));
    // db 默认返回空（每个 it 按需覆写）
    mockDb.select.mockReturnValue(chainableMock([]));
    mockDb.insert.mockReturnValue(chainableMock([]));
    mockDb.update.mockReturnValue(chainableMock([]));
  });

  // ==========================================================================
  // 谓词 8（无候选分支）：NO-PUSH-ON-NO-VIDEO
  // ==========================================================================

  describe("NO-PUSH-ON-NO-VIDEO：无候选 → webhook 0 次", () => {
    it("空 DB（discovery 查无候选）→ dailyVideoWorker 不推送", async () => {
      // mockDb.select 默认返回 [] → discovery 查无 photo/person → 返回 []
      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-nocand-001") as never);

      expect(wechatMocks.sendWallpaperToWeCom, "无候选不应触发推送").not.toHaveBeenCalled();
      expect(wechatMocks.sendWallpaperToWeCom.mock.calls.length, "webhook POST 次数应为 0").toBe(0);
    });

    it("无候选时也不应调 compressForWeCom（无封面要压缩）", async () => {
      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-nocand-compress") as never);

      expect(wechatMocks.compressForWeCom, "无候选不应触发压缩").not.toHaveBeenCalled();
    });

    it("无候选时不应写 videos 行（空完成，不产 failed 行也不产 completed 行）", async () => {
      // 监控 insert 是否被调用写 videos
      const { dailyVideoWorker } = await import("../jobs/daily-video");
      await dailyVideoWorker(makeJob("job-nocand-norow") as never);

      // 无候选 → 空完成 → 不应 insert videos 行
      // （mockDb.insert 若被调用说明逻辑错误）
      expect(mockDb.insert, "无候选不应写库").not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 谓词 10：API-VIDEO-LIST-AND-STREAM
  // ==========================================================================

  describe("API-VIDEO-LIST-AND-STREAM：列表 + Range 流式", () => {
    it("GET /api/videos → 200 + 列表 JSON 含 id/title/themeKind/themeKey/createdAt", async () => {
      const videoRow = {
        id: "vid-001",
        title: "重庆·川南 2024",
        themeKind: "trip",
        themeKey: "chongqing-2024",
        coverPath: "/tmp/cover.jpg",
        outputPath: "/tmp/v.mp4",
        durationSec: 60,
        createdAt: "2026-07-30T03:00:00.000Z",
      };
      mockDb.select.mockReturnValue(chainableMock([videoRow]));

      const { createApp } = await import("../app");
      const res = await createApp().request("/api/videos", { method: "GET" });
      expect(res.status, "列表应 200").toBe(200);

      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      expect(body, "应返回 JSON body").not.toBeNull();
      // 契约：{ videos: [...] }（设计文档 API 契约原文）
      const videos = (body?.videos ?? body?.data) as Array<Record<string, unknown>> | undefined;
      expect(videos, "应有 videos 数组").toBeDefined();
      expect(Array.isArray(videos)).toBe(true);
      expect(videos!.length, "至少 1 条").toBeGreaterThanOrEqual(1);

      const v = videos![0]!;
      for (const f of ["id", "title", "themeKind", "themeKey", "createdAt"]) {
        expect(v[f], `列表项应含字段 ${f}`).toBeDefined();
      }
    });

    it("GET /api/videos 空结果 → 200 + videos:[]（无视频时结构化空）", async () => {
      mockDb.select.mockReturnValue(chainableMock([]));

      const { createApp } = await import("../app");
      const res = await createApp().request("/api/videos", { method: "GET" });
      expect(res.status).toBe(200);
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const videos = body?.videos ?? body?.data;
      expect(Array.isArray(videos), "空结果应返回数组").toBe(true);
      expect((videos as unknown[]).length, "空结果 length=0").toBe(0);
    });

    it("GET /api/videos/:id/stream 带 Range: bytes=0-1023 → 206 + Content-Range + Accept-Ranges", async () => {
      expect(HAS_FFMPEG, "ffmpeg 不可用：stream 测试需真实 mp4").toBe(true);
      const mp4Path = path.join(tmpRoot, "stream-test.mp4");
      expect(makeSmallMp8(mp4Path), "应能生成测试 mp4").toBe(true);
      const totalSize = fs.statSync(mp4Path).size;
      expect(totalSize, "测试 mp4 应 > 1024 字节").toBeGreaterThan(1024);

      mockDb.select.mockReturnValue(
        chainableMock([
          {
            id: "vid-stream",
            title: "stream test",
            themeKind: "trip",
            themeKey: "stream-2024",
            outputPath: mp4Path,
            status: "completed",
            coverPath: "/tmp/c.jpg",
            durationSec: 60,
            createdAt: "2026-07-30T03:00:00.000Z",
          },
        ]),
      );

      const { createApp } = await import("../app");
      const res = await createApp().request("/api/videos/vid-stream/stream", {
        method: "GET",
        headers: { Range: "bytes=0-1023" },
      });

      expect(res.status, "带 Range 应返回 206 Partial Content").toBe(206);
      expect(res.headers.get("Content-Type"), "Content-Type 应为 video/mp4").toContain("video/mp4");
      expect(res.headers.get("Accept-Ranges"), "应声明 Accept-Ranges: bytes").toBe("bytes");

      const contentRange = res.headers.get("Content-Range");
      expect(contentRange, "应有 Content-Range 头").not.toBeNull();
      // 契约：Content-Range: bytes 0-1023/<total>
      expect(contentRange!, "Content-Range 格式 bytes start-end/total").toMatch(
        /^bytes 0-1023\/\d+$/,
      );
      expect(contentRange!).toContain(`/${totalSize}`);
    });

    it("GET /api/videos/:id/stream 带 Range → Content-Length = end-start+1（1024）", async () => {
      expect(HAS_FFMPEG, "ffmpeg 不可用").toBe(true);
      const mp4Path = path.join(tmpRoot, "cl-test.mp4");
      expect(makeSmallMp8(mp4Path)).toBe(true);

      mockDb.select.mockReturnValue(
        chainableMock([
          {
            id: "vid-cl",
            title: "cl",
            themeKind: "trip",
            themeKey: "cl-2024",
            outputPath: mp4Path,
            status: "completed",
            coverPath: "/tmp/c.jpg",
            durationSec: 60,
            createdAt: "2026-07-30T03:00:00.000Z",
          },
        ]),
      );

      const { createApp } = await import("../app");
      const res = await createApp().request("/api/videos/vid-cl/stream", {
        method: "GET",
        headers: { Range: "bytes=0-1023" },
      });
      expect(res.status).toBe(206);
      const cl = Number(res.headers.get("Content-Length") ?? "0");
      expect(cl, "Content-Length 应 = 1024（bytes 0-1023 = 1024 字节）").toBe(1024);
    });

    it("GET /api/videos/:id/stream 无 Range 头 → 200 全量 + Accept-Ranges", async () => {
      expect(HAS_FFMPEG, "ffmpeg 不可用").toBe(true);
      const mp4Path = path.join(tmpRoot, "stream-full.mp4");
      expect(makeSmallMp8(mp4Path)).toBe(true);

      mockDb.select.mockReturnValue(
        chainableMock([
          {
            id: "vid-full",
            title: "full",
            themeKind: "trip",
            themeKey: "full-2024",
            outputPath: mp4Path,
            status: "completed",
            coverPath: "/tmp/c.jpg",
            durationSec: 60,
            createdAt: "2026-07-30T03:00:00.000Z",
          },
        ]),
      );

      const { createApp } = await import("../app");
      const res = await createApp().request("/api/videos/vid-full/stream", { method: "GET" });

      expect(res.status, "无 Range 应返回 200 全量").toBe(200);
      expect(res.headers.get("Content-Type"), "Content-Type video/mp4").toContain("video/mp4");
      expect(res.headers.get("Accept-Ranges"), "Accept-Ranges: bytes").toBe("bytes");
      const buf = await res.arrayBuffer();
      expect(buf.byteLength, "全量 body 应 > 0").toBeGreaterThan(0);
    });

    it("GET /api/videos/:id/stream 带 Cache-Control immutable（CDN 友好）", async () => {
      expect(HAS_FFMPEG, "ffmpeg 不可用").toBe(true);
      const mp4Path = path.join(tmpRoot, "cache-test.mp4");
      expect(makeSmallMp8(mp4Path)).toBe(true);

      mockDb.select.mockReturnValue(
        chainableMock([
          {
            id: "vid-cache",
            title: "cache",
            themeKind: "trip",
            themeKey: "cache-2024",
            outputPath: mp4Path,
            status: "completed",
            coverPath: "/tmp/c.jpg",
            durationSec: 60,
            createdAt: "2026-07-30T03:00:00.000Z",
          },
        ]),
      );

      const { createApp } = await import("../app");
      const res = await createApp().request("/api/videos/vid-cache/stream", {
        method: "GET",
        headers: { Range: "bytes=0-511" },
      });
      expect(res.status).toBe(206);
      const cc = res.headers.get("Cache-Control") ?? "";
      // 契约：Cache-Control: public max-age=86400 immutable
      expect(cc, "Cache-Control 应含 public").toContain("public");
      expect(cc, "Cache-Control 应含 immutable").toContain("immutable");
    });

    it("GET /api/videos/:id/stream 带 ETag（缓存命中验证）", async () => {
      expect(HAS_FFMPEG, "ffmpeg 不可用").toBe(true);
      const mp4Path = path.join(tmpRoot, "etag-test.mp4");
      expect(makeSmallMp8(mp4Path)).toBe(true);

      mockDb.select.mockReturnValue(
        chainableMock([
          {
            id: "vid-etag",
            title: "etag",
            themeKind: "trip",
            themeKey: "etag-2024",
            outputPath: mp4Path,
            status: "completed",
            coverPath: "/tmp/c.jpg",
            durationSec: 60,
            createdAt: "2026-07-30T03:00:00.000Z",
          },
        ]),
      );

      const { createApp } = await import("../app");
      const res = await createApp().request("/api/videos/vid-etag/stream", {
        method: "GET",
        headers: { Range: "bytes=0-511" },
      });
      expect(res.status).toBe(206);
      const etag = res.headers.get("ETag");
      expect(etag, "应有 ETag 头（缓存验证用）").not.toBeNull();
      expect(etag!.length, "ETag 非空").toBeGreaterThan(0);
    });

    it("GET /api/videos/:id/cover → 200 image/jpeg", async () => {
      const coverPath = path.join(tmpRoot, "cover.jpg");
      expect(makeJpeg(coverPath), "应能生成测试 jpeg").toBe(true);

      mockDb.select.mockReturnValue(
        chainableMock([
          {
            id: "vid-cover",
            title: "cover",
            themeKind: "trip",
            themeKey: "cover-2024",
            outputPath: "/tmp/v.mp4",
            coverPath,
            durationSec: 60,
            createdAt: "2026-07-30T03:00:00.000Z",
          },
        ]),
      );

      const { createApp } = await import("../app");
      const res = await createApp().request("/api/videos/vid-cover/cover", { method: "GET" });
      expect(res.status, "cover 应 200").toBe(200);
      expect(res.headers.get("Content-Type"), "Content-Type image/jpeg").toContain("image/jpeg");
    });

    it("GET /api/videos/:id/stream 不存在的 id → 4xx（404，非 500）", async () => {
      // db 查无此 video
      mockDb.select.mockReturnValue(chainableMock([]));

      const { createApp } = await import("../app");
      const res = await createApp().request("/api/videos/nonexistent/stream", { method: "GET" });
      expect(res.status, "不存在应 4xx，绝不 500").toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });
});

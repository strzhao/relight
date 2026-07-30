/**
 * 视频 API 路由
 *
 * GET /api/videos              — 视频列表（createdAt desc）
 * GET /api/videos/:id/cover    — 封面图（image/jpeg）
 * GET /api/videos/:id/stream   — mp4 流式播放（Range 解析 → 206/200）
 *
 * streamVideoHandler 为新建 Range 流式实现（wallpaper 是全量 readFile 无 Range，仅参照其 ETag/Cache-Control 头设置）。
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";

export const videosRouter = new Hono()
  /** 视频列表（createdAt desc，仅 completed） */
  .get("/", async (c) => {
    const rows = await db
      .select({
        id: schema.videos.id,
        title: schema.videos.title,
        themeKind: schema.videos.themeKind,
        themeKey: schema.videos.themeKey,
        coverPath: schema.videos.coverPath,
        durationSec: schema.videos.durationSec,
        status: schema.videos.status,
        createdAt: schema.videos.createdAt,
      })
      .from(schema.videos)
      .where(eq(schema.videos.status, "completed"))
      .orderBy(desc(schema.videos.createdAt));

    const videos = rows.map((r) => ({
      id: r.id,
      title: r.title,
      themeKind: r.themeKind,
      themeKey: r.themeKey,
      coverUrl: `/api/videos/${r.id}/cover`,
      durationSec: r.durationSec,
      status: r.status,
      createdAt: r.createdAt,
    }));

    return c.json({ videos });
  })

  /** 封面图（image/jpeg） */
  .get("/:id/cover", async (c) => {
    const id = c.req.param("id");
    const rows = await db
      .select({ coverPath: schema.videos.coverPath, status: schema.videos.status })
      .from(schema.videos)
      .where(eq(schema.videos.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || !row.coverPath) {
      return c.json({ success: false, error: "视频或封面不存在" }, 404);
    }

    try {
      const { readFile } = await import("node:fs/promises");
      const buf = await readFile(row.coverPath);
      const etag = `"${createHash("sha256").update(buf).digest("hex").slice(0, 16)}"`;
      const ifNoneMatch = c.req.header("if-none-match");
      if (ifNoneMatch === etag) {
        return c.newResponse(null, 304);
      }
      return c.newResponse(buf, 200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400, immutable",
        ETag: etag,
      });
    } catch {
      return c.json({ success: false, error: "封面文件读取失败" }, 404);
    }
  })

  /**
   * 视频流式播放（Range 支持）
   *
   * - 解析 Range 头（bytes=start-end）
   * - 有 Range：createReadStream(path,{start,end}) + 206 + Content-Range: bytes start-end/total
   * - 无 Range：200 全量
   * - Content-Type: video/mp4, Accept-Ranges: bytes, Cache-Control, ETag
   */
  .get("/:id/stream", async (c) => {
    const id = c.req.param("id");
    const rows = await db
      .select({
        outputPath: schema.videos.outputPath,
        status: schema.videos.status,
      })
      .from(schema.videos)
      .where(eq(schema.videos.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.status !== "completed" || !row.outputPath) {
      return c.json({ success: false, error: "视频不存在或未完成" }, 404);
    }

    const filePath = row.outputPath;
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(filePath);
    } catch {
      return c.json({ success: false, error: "视频文件不存在" }, 404);
    }
    const total = stats.size;

    // ETag 基于文件路径 + 大小 + mtime（轻量，避免读全文件哈希）
    const etag = `"${id}-${total}-${Math.floor(stats.mtimeMs / 1000)}"`;
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch === etag) {
      return c.newResponse(null, 304);
    }

    const rangeHeader = c.req.header("range");
    const baseHeaders = {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=86400, immutable",
      ETag: etag,
    };

    // 无 Range：200 全量流
    if (!rangeHeader) {
      const stream = createReadStream(filePath);
      stream.on("error", (e) => console.error(`[videos] stream error ${filePath}:`, e));
      // @ts-expect-error Hono newResponse 接受 Readable stream（Node stream 符合 BodyInit）
      return c.newResponse(stream, 200, baseHeaders);
    }

    // 解析 Range: bytes=start-end
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match) {
      return c.newResponse(null, 416, {
        "Content-Range": `bytes */${total}`,
      });
    }

    const startStr = match[1] ?? "";
    const endStr = match[2] ?? "";
    let start: number;
    let end: number;
    if (startStr === "" && endStr !== "") {
      // 后缀形式 bytes=-N（RFC 7233，Safari/iOS seek 末尾常用）：返回最后 N 字节
      const n = Number.parseInt(endStr, 10);
      start = Math.max(0, total - n);
      end = total - 1;
    } else {
      start = startStr ? Number.parseInt(startStr, 10) : 0;
      end = endStr ? Number.parseInt(endStr, 10) : total - 1;
    }

    // 边界修正
    if (start < 0 || start >= total) {
      return c.newResponse(null, 416, {
        "Content-Range": `bytes */${total}`,
      });
    }
    if (end >= total) end = total - 1;
    if (end < start) end = start;

    const chunkSize = end - start + 1;
    const stream = createReadStream(filePath, { start, end });
    stream.on("error", (e) => console.error(`[videos] stream error ${filePath}:`, e));
    // @ts-expect-error Hono newResponse 接受 Readable stream（Node stream 符合 BodyInit）
    return c.newResponse(stream, 206, {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(chunkSize),
    });
  });

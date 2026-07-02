import { createReadStream, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { analyzePhotosSchema, photoQuerySchema } from "@relight/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";
import { analyzeQueue } from "../jobs/queues";
import { convertHeicToJpeg, isHeicBuffer } from "../lib/heic";
import { sniffImageContentType } from "../lib/mime";
import { RAW_EXTENSIONS, extractRawPreview } from "../lib/raw";
import { createStorageAdapter } from "../storage";

/** 把秒数（含小数）格式化为 WebVTT 时间戳 HH:MM:SS.mmm */
function secondsToVtt(s: number): string {
  const safe = Math.max(0, s);
  const totalSeconds = Math.floor(safe);
  const ms = Math.round((safe - totalSeconds) * 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms, 3)}`;
}

export const photosRouter = new Hono()
  /** 照片列表（分页 + 过滤 + 排序） */
  .get("/", async (c) => {
    const query = c.req.query();
    const parsed = photoQuerySchema.safeParse(query);

    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.message }, 400);
    }

    const { page, pageSize, tagId, storageSourceId, sortBy, order, dateFrom, dateTo } = parsed.data;

    // 构建 WHERE 条件（默认只显示非连拍或连拍代表）
    const conditions = [
      sql`(${schema.photos.burstId} IS NULL OR ${schema.photos.isBurstRepresentative} = 1)`,
    ];

    if (storageSourceId) {
      conditions.push(eq(schema.photos.storageSourceId, storageSourceId));
    }

    if (tagId) {
      // 过滤有指定标签的照片
      conditions.push(
        sql`${schema.photos.id} IN (
          SELECT ${schema.photoTags.photoId}
          FROM ${schema.photoTags}
          WHERE ${eq(schema.photoTags.tagId, tagId)}
        )`,
      );
    }

    // 使用 COALESCE(takenAt, createdAt) 作为有效日期列
    const effectiveDate = sql`COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})`;

    if (dateFrom) {
      conditions.push(sql`date(${effectiveDate}) >= ${dateFrom}`);
    }

    if (dateTo) {
      conditions.push(sql`date(${effectiveDate}) <= ${dateTo}`);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // 排序
    const sortColumn =
      sortBy === "takenAt"
        ? effectiveDate
        : sortBy === "fileSize"
          ? schema.photos.fileSize
          : schema.photos.createdAt;

    const orderBy = order === "asc" ? asc(sortColumn) : desc(sortColumn);

    // 查询总数
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.photos)
      .where(where);

    const total = countResult[0]?.count ?? 0;

    // 查询分页数据（LEFT JOIN bursts 取 memberCount → burstSize）
    const offset = (page - 1) * pageSize;
    const rows = await db
      .select({
        photo: schema.photos,
        burstMemberCount: schema.bursts.memberCount,
      })
      .from(schema.photos)
      .leftJoin(schema.bursts, eq(schema.photos.burstId, schema.bursts.id))
      .where(where)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset);

    const photos = rows.map((r) => ({
      ...r.photo,
      burstSize: r.burstMemberCount ?? 1,
    }));

    return c.json({
      success: true,
      data: photos,
      total,
      page,
      pageSize,
    });
  })

  /** 照片详情（JOIN 关联信息） */
  .get("/:id", async (c) => {
    const id = c.req.param("id");

    // 查询照片基本信息
    const photos = await db.select().from(schema.photos).where(eq(schema.photos.id, id));

    const photo = photos[0];
    if (!photo) {
      return c.json({ success: false, error: "照片不存在" }, 404);
    }

    // 查询关联的标签
    const photoTagRows = await db
      .select({
        photoId: schema.photoTags.photoId,
        tagId: schema.photoTags.tagId,
        confidence: schema.photoTags.confidence,
        tagName: schema.tags.name,
        tagCategory: schema.tags.category,
      })
      .from(schema.photoTags)
      .innerJoin(schema.tags, eq(schema.photoTags.tagId, schema.tags.id))
      .where(eq(schema.photoTags.photoId, id));

    // 查询分析记录
    const analyses = await db
      .select()
      .from(schema.photoAnalyses)
      .where(eq(schema.photoAnalyses.photoId, id));

    // 查询存储源
    const sources = await db
      .select()
      .from(schema.storageSources)
      .where(eq(schema.storageSources.id, photo.storageSourceId));

    return c.json({
      success: true,
      data: {
        ...photo,
        tags: photoTagRows,
        analyses,
        storageSource: sources[0] ?? null,
      },
    });
  })

  /** 缩略图 */
  .get("/:id/thumbnail", async (c) => {
    const id = c.req.param("id");

    // 查询照片的缩略图路径
    const photos = await db
      .select({ thumbnailPath: schema.photos.thumbnailPath })
      .from(schema.photos)
      .where(eq(schema.photos.id, id));

    const photo = photos[0];

    if (!photo?.thumbnailPath) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
        <rect fill="#f3f4f6" width="200" height="200"/>
        <text fill="#9ca3af" font-family="system-ui" font-size="14" text-anchor="middle" x="100" y="104">无缩略图</text>
      </svg>`;
      return c.body(svg, 200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      });
    }

    try {
      const stat = await fs.stat(photo.thumbnailPath);
      const buffer = await fs.readFile(photo.thumbnailPath);
      const etag = `"${stat.mtimeMs.toFixed(0)}"`;
      return c.body(buffer, 200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600",
        ETag: etag,
      });
    } catch {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
        <rect fill="#fef2f2" width="200" height="200"/>
        <text fill="#ef4444" font-family="system-ui" font-size="14" text-anchor="middle" x="100" y="104">缩略图缺失</text>
      </svg>`;
      return c.body(svg, 200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      });
    }
  })

  /** 原始文件 */
  .get("/:id/original", async (c) => {
    const id = c.req.param("id");

    // 查询照片基本信息 + 关联的存储源
    const photos = await db
      .select({
        filePath: schema.photos.filePath,
        fileName: schema.photos.filePath,
        storageSourceId: schema.photos.storageSourceId,
        rootPath: schema.storageSources.rootPath,
        storageType: schema.storageSources.type,
      })
      .from(schema.photos)
      .innerJoin(schema.storageSources, eq(schema.photos.storageSourceId, schema.storageSources.id))
      .where(eq(schema.photos.id, id));

    const photo = photos[0];
    if (!photo) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
        <rect fill="#fef2f2" width="200" height="200"/>
        <text fill="#ef4444" font-family="system-ui" font-size="14" text-anchor="middle" x="100" y="104">照片不存在</text>
      </svg>`;
      return c.body(svg, 200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      });
    }

    const fullPath = path.resolve(photo.rootPath, photo.filePath);

    // 检查文件是否存在
    try {
      await fs.access(fullPath);
    } catch {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
        <rect fill="#fef2f2" width="200" height="200"/>
        <text fill="#ef4444" font-family="system-ui" font-size="14" text-anchor="middle" x="100" y="104">文件不存在</text>
      </svg>`;
      return c.body(svg, 200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      });
    }

    try {
      const adapter = createStorageAdapter(photo.storageType);
      let buffer = await adapter.getFileBuffer(fullPath);
      let contentType = sniffImageContentType(buffer, adapter.getMimeType(fullPath));
      const etagBase = `${photo.filePath}`;

      // HEIC 转码为 JPEG（按 magic byte 判断，兼容扩展名错配）
      if (isHeicBuffer(buffer)) {
        buffer = await convertHeicToJpeg(buffer);
        contentType = "image/jpeg";
      }

      // DNG/RAW 提取内嵌 JPEG 预览（浏览器无法渲染 RAW 格式）
      const ext = path.extname(photo.filePath).toLowerCase();
      if (RAW_EXTENSIONS.has(ext)) {
        buffer = await extractRawPreview(fullPath);
        contentType = "image/jpeg";
      }

      return c.body(buffer, 200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
        ETag: `"${Buffer.from(etagBase).toString("base64").slice(0, 32)}"`,
      });
    } catch {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
        <rect fill="#fef2f2" width="200" height="200"/>
        <text fill="#ef4444" font-family="system-ui" font-size="14" text-anchor="middle" x="100" y="104">读取失败</text>
      </svg>`;
      return c.body(svg, 200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      });
    }
  })

  /** 原始流（支持 Range，视频播放用） */
  .get("/:id/raw", async (c) => {
    const id = c.req.param("id");

    const photos = await db
      .select({
        filePath: schema.photos.filePath,
        rootPath: schema.storageSources.rootPath,
        storageType: schema.storageSources.type,
      })
      .from(schema.photos)
      .innerJoin(schema.storageSources, eq(schema.photos.storageSourceId, schema.storageSources.id))
      .where(eq(schema.photos.id, id));

    const photo = photos[0];
    if (!photo) {
      return c.json({ success: false, error: "照片不存在" }, 404);
    }

    const fullPath = path.resolve(photo.rootPath, photo.filePath);

    let total: number;
    try {
      total = statSync(fullPath).size;
    } catch {
      return c.json({ success: false, error: "文件不存在" }, 404);
    }

    const adapter = createStorageAdapter(photo.storageType);
    const extMimeType = adapter.getMimeType(photo.filePath);

    // content-type 修正：图片类按 magic byte 判定（解决 .HEIC 实为 JPEG 等错配裂图）。
    // 视频类保持扩展名（视频字节嗅探不在本 lib 范围，且 Range 流不读全文件）。
    // 读头部 16 字节用 fd 避免读全文件，不影响后续 createReadStream + Range 语义。
    let contentType = extMimeType;
    if (extMimeType.startsWith("image/")) {
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(fullPath, "r");
        const head = Buffer.alloc(16);
        const { bytesRead } = await handle.read(head, 0, 16, 0);
        contentType = sniffImageContentType(head.subarray(0, bytesRead), extMimeType);
      } catch {
        // 头部读取失败时降级到扩展名判定（不阻塞流式响应）
        contentType = extMimeType;
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
    }

    const rangeHeader = c.req.header("Range") ?? c.req.header("range");

    if (rangeHeader) {
      // 解析 "bytes=START-END"
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (match) {
        const startStr = match[1] ?? "";
        const endStr = match[2] ?? "";
        const start = startStr === "" ? 0 : Number.parseInt(startStr, 10);
        const end = endStr === "" ? total - 1 : Number.parseInt(endStr, 10);
        if (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          start >= 0 &&
          end >= start &&
          end < total
        ) {
          const chunkSize = end - start + 1;
          const stream = createReadStream(fullPath, { start, end });
          const webStream = Readable.toWeb(stream) as ReadableStream;
          c.header("Content-Type", contentType);
          c.header("Accept-Ranges", "bytes");
          c.header("Content-Range", `bytes ${start}-${end}/${total}`);
          c.header("Content-Length", String(chunkSize));
          c.status(206);
          return c.body(webStream);
        }
      }
    }

    // 无 Range（或不合法）→ 200 全文件流
    const stream = createReadStream(fullPath);
    const webStream = Readable.toWeb(stream) as ReadableStream;
    c.header("Content-Type", contentType);
    c.header("Accept-Ranges", "bytes");
    c.header("Content-Length", String(total));
    return c.body(webStream);
  })

  /** 字幕（WebVTT），从 photoAnalyses.transcriptSegments 转换 */
  .get("/:id/subtitles.vtt", async (c) => {
    const id = c.req.param("id");

    const photos = await db
      .select({ id: schema.photos.id })
      .from(schema.photos)
      .where(eq(schema.photos.id, id));

    if (!photos[0]) {
      return c.json({ success: false, error: "照片不存在" }, 404);
    }

    const analyses = await db
      .select({ transcriptSegments: schema.photoAnalyses.transcriptSegments })
      .from(schema.photoAnalyses)
      .where(eq(schema.photoAnalyses.photoId, id));

    const segments = analyses[0]?.transcriptSegments ?? null;

    if (!segments || segments.length === 0) {
      return c.body("WEBVTT\n\n", 200, {
        "Content-Type": "text/vtt; charset=utf-8",
      });
    }

    const cues = segments
      .map((seg) => `${secondsToVtt(seg.start)} --> ${secondsToVtt(seg.end)}\n${seg.text}`)
      .join("\n\n");
    const body = `WEBVTT\n\n${cues}\n`;

    return c.body(body, 200, {
      "Content-Type": "text/vtt; charset=utf-8",
    });
  })

  /** 批量触发 AI 分析 */
  .post("/analyze", async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "请求体不能为空" }, 400);
    }

    const parsed = analyzePhotosSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.message }, 400);
    }

    const { photoIds, force } = parsed.data;

    // 验证照片存在
    const existingPhotos = await db
      .select({ id: schema.photos.id })
      .from(schema.photos)
      .where(inArray(schema.photos.id, photoIds));

    const existingIds = new Set(existingPhotos.map((p) => p.id));
    const validIds = photoIds.filter((id) => existingIds.has(id));

    if (validIds.length === 0) {
      return c.json({ success: false, error: "所有照片都不存在" }, 400);
    }

    // 过滤已分析的照片（force=true 时跳过过滤）
    let toAnalyze = validIds;

    if (!force) {
      const analyzed = await db
        .select({ photoId: schema.photoAnalyses.photoId })
        .from(schema.photoAnalyses)
        .where(inArray(schema.photoAnalyses.photoId, validIds));

      const analyzedIds = new Set(analyzed.map((a) => a.photoId));
      toAnalyze = validIds.filter((id) => !analyzedIds.has(id));
    }

    const skippedCount = validIds.length - toAnalyze.length;

    const jobs = toAnalyze.map((photoId) => analyzeQueue.add(`analyze:${photoId}`, { photoId }));
    await Promise.all(jobs);

    return c.json({
      success: true,
      data: { enqueued: toAnalyze.length, skippedCount },
    });
  });

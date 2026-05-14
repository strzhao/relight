/**
 * 人物（人脸聚类组）API。
 *
 * - GET    /api/persons                    列表（默认 displayable=true，按 memberCount desc）
 * - GET    /api/persons/:id                详情（含成员照片 + 全部 face）
 * - PATCH  /api/persons/:id                更新 name / bio
 * - PATCH  /api/persons/:id/representative 设代表 face
 * - POST   /api/persons/:id/merge          合并到另一人
 * - POST   /api/persons/:id/avatar         自定义头像（multipart）
 * - GET    /api/persons/:id/avatar.jpg     头像图片流（custom > avatar > 404）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  mergePersonSchema,
  setPersonRepresentativeSchema,
  updatePersonSchema,
} from "@relight/shared";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";
import { config } from "../lib/config";
import type { FaceAttributes } from "../lib/face/attributes";
import { saveCustomAvatar } from "../lib/face/avatar";
import { centroidWeightFor, qualityOf, updatePersonAttributeSummary } from "../lib/face/clustering";
import { decodeEmbedding, encodeEmbedding } from "../lib/face/embedding-codec";
import { deleteSetting, getSettingValue, setSettingValue } from "../lib/settings";

const SELF_PERSON_ID_KEY = "selfPersonId";

/**
 * 安全 personId 校验：仅允许 `[A-Za-z0-9_-]`，长度 1-128。
 *
 * 这能防 `..` / `/` / `\` / 空字符 / null byte 等路径段污染，
 * 同时兼容 UUID（含连字符）和测试 fixture 短 id（如 `p-1`）。
 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 自定义头像合法 MIME 白名单（B1-2 修复） */
const ALLOWED_AVATAR_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
/** sharp 解析后的 format 白名单（即使 MIME 假装也由真实 format 兜底） */
const ALLOWED_AVATAR_FORMAT = new Set(["jpeg", "png", "webp"]);

/** 把 DB 行转为 API 返回 Person（boolean 字段 cast，timestamp 字段已是 ISO） */
function toApiPerson(row: typeof schema.persons.$inferSelect, selfPersonId: string | null) {
  return {
    id: row.id,
    storageSourceId: row.storageSourceId,
    name: row.name,
    nickname: row.nickname,
    bio: row.bio,
    representativeFaceId: row.representativeFaceId,
    avatarPath: row.avatarPath,
    customAvatarPath: row.customAvatarPath,
    memberCount: row.memberCount,
    manualOverride: row.manualOverride,
    displayable: row.displayable,
    hidden: row.hidden,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isSelf: selfPersonId !== null && row.id === selfPersonId,
  };
}

function toApiFace(row: typeof schema.faces.$inferSelect) {
  return {
    id: row.id,
    photoId: row.photoId,
    personId: row.personId,
    bboxX: row.bboxX,
    bboxY: row.bboxY,
    bboxW: row.bboxW,
    bboxH: row.bboxH,
    detectionScore: row.detectionScore,
    detectedAt: row.detectedAt,
  };
}

export const personsRouter = new Hono()
  /** 列表：?storageSourceId=&displayable=（默认 true） */
  .get("/", async (c) => {
    const storageSourceId = c.req.query("storageSourceId");
    const displayableParam = c.req.query("displayable") ?? "true";
    const displayableTrue = displayableParam !== "false";
    /** hidden 过滤：默认 "false"（仅可见），"true" 只返回已隐藏，"all" 不过滤 */
    const hiddenParam = c.req.query("hidden") ?? "false";

    const conditions = [] as ReturnType<typeof eq>[];
    if (storageSourceId) {
      conditions.push(eq(schema.persons.storageSourceId, storageSourceId));
    }
    conditions.push(eq(schema.persons.displayable, displayableTrue));
    if (hiddenParam !== "all") {
      conditions.push(eq(schema.persons.hidden, hiddenParam === "true"));
    }

    const rows = await db
      .select()
      .from(schema.persons)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(desc(schema.persons.memberCount));

    const selfPersonId = await getSettingValue(SELF_PERSON_ID_KEY);

    return c.json({
      success: true,
      data: rows.map((r) => toApiPerson(r, selfPersonId)),
    });
  })

  /** 详情：含成员 photos + 全部 faces */
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const personRows = await db.select().from(schema.persons).where(eq(schema.persons.id, id));
    const person = personRows[0];
    if (!person) {
      return c.json({ success: false, error: "人物不存在" }, 404);
    }

    const faceRows = await db.select().from(schema.faces).where(eq(schema.faces.personId, id));

    // 拉相关 photos（distinct photoId）
    const photoIds = Array.from(new Set(faceRows.map((f) => f.photoId)));
    let photos: (typeof schema.photos.$inferSelect)[] = [];
    if (photoIds.length > 0) {
      // 简单循环 vs IN：用 IN 数组防 N+1
      const inResults = await Promise.all(
        photoIds.map((pid) => db.select().from(schema.photos).where(eq(schema.photos.id, pid))),
      );
      photos = inResults.flat();
      // 按 takenAt desc，null 视为最早
      photos.sort((a, b) => {
        const ta = a.takenAt ?? a.createdAt;
        const tb = b.takenAt ?? b.createdAt;
        if (!ta && !tb) return 0;
        if (!ta) return 1;
        if (!tb) return -1;
        return tb.localeCompare(ta);
      });
    }

    const selfPersonId = await getSettingValue(SELF_PERSON_ID_KEY);

    return c.json({
      success: true,
      data: {
        ...toApiPerson(person, selfPersonId),
        photos,
        faces: faceRows.map(toApiFace),
      },
    });
  })

  /** 更新 name / bio（"" 或 null 视为清空） */
  .patch("/:id", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "请求体必须是合法 JSON" }, 400);
    }
    const parsed = updatePersonSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.message }, 400);
    }

    const personRows = await db.select().from(schema.persons).where(eq(schema.persons.id, id));
    const person = personRows[0];
    if (!person) {
      return c.json({ success: false, error: "人物不存在" }, 404);
    }

    const update: Partial<typeof schema.persons.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    if ("name" in parsed.data) {
      const v = parsed.data.name;
      update.name = v == null || v === "" ? null : v;
    }
    if ("nickname" in parsed.data) {
      const v = parsed.data.nickname;
      update.nickname = v == null || v === "" ? null : v;
    }
    if ("bio" in parsed.data) {
      const v = parsed.data.bio;
      update.bio = v == null || v === "" ? null : v;
    }
    if ("hidden" in parsed.data && parsed.data.hidden !== undefined) {
      update.hidden = parsed.data.hidden;
    }

    await db.update(schema.persons).set(update).where(eq(schema.persons.id, id));
    const refreshed = (await db.select().from(schema.persons).where(eq(schema.persons.id, id)))[0];
    if (!refreshed) {
      return c.json({ success: false, error: "更新后查询失败" }, 500);
    }
    const selfPersonId = await getSettingValue(SELF_PERSON_ID_KEY);
    return c.json({ success: true, data: toApiPerson(refreshed, selfPersonId) });
  })

  /** 设置代表 face（manualOverride=true，避免后续自动覆盖） */
  .patch("/:id/representative", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "请求体必须是合法 JSON" }, 400);
    }
    const parsed = setPersonRepresentativeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.message }, 400);
    }
    const { faceId } = parsed.data;

    const personRows = await db.select().from(schema.persons).where(eq(schema.persons.id, id));
    const person = personRows[0];
    if (!person) {
      return c.json({ success: false, error: "人物不存在" }, 404);
    }

    // 校验 face 属于本人
    const faceRows = await db
      .select()
      .from(schema.faces)
      .where(and(eq(schema.faces.id, faceId), eq(schema.faces.personId, id)));
    const face = faceRows[0];
    if (!face) {
      return c.json({ success: false, error: "face 不属于该人物" }, 400);
    }

    // 触发头像重新生成（从 face.photoId 读图 → crop bbox）
    let avatarRel: string | null = person.avatarPath;
    try {
      const photoRows = await db
        .select()
        .from(schema.photos)
        .where(eq(schema.photos.id, face.photoId));
      const photo = photoRows[0];
      if (photo) {
        const sourceRows = await db
          .select()
          .from(schema.storageSources)
          .where(eq(schema.storageSources.id, photo.storageSourceId));
        const src = sourceRows[0];
        if (src) {
          const { createStorageAdapter } = await import("../storage");
          const adapter = createStorageAdapter(src.type);
          const buf = await adapter.getFileBuffer(photo.filePath);
          const sharpMod = await import("sharp");
          const meta = await sharpMod.default(buf).metadata();
          if (meta.width && meta.height) {
            const { generateAutoAvatar } = await import("../lib/face/avatar");
            const abs = await generateAutoAvatar(
              buf,
              { x: face.bboxX, y: face.bboxY, w: face.bboxW, h: face.bboxH },
              meta.width,
              meta.height,
              id,
            );
            avatarRel = path.relative(config.storageRoot, abs);
          }
        }
      }
    } catch {
      // 头像重新生成失败不阻塞主操作
    }

    await db
      .update(schema.persons)
      .set({
        representativeFaceId: faceId,
        avatarPath: avatarRel,
        manualOverride: true,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.persons.id, id));

    const refreshed = (await db.select().from(schema.persons).where(eq(schema.persons.id, id)))[0];
    if (!refreshed) {
      return c.json({ success: false, error: "更新后查询失败" }, 500);
    }
    const selfPersonId = await getSettingValue(SELF_PERSON_ID_KEY);
    return c.json({ success: true, data: toApiPerson(refreshed, selfPersonId) });
  })

  /** 合并：把当前 person 的全部 faces 转移到 targetPersonId，删除当前 person */
  .post("/:id/merge", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "请求体必须是合法 JSON" }, 400);
    }
    const parsed = mergePersonSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.message }, 400);
    }
    const { targetPersonId } = parsed.data;
    if (targetPersonId === id) {
      return c.json({ success: false, error: "不能合并到自己" }, 400);
    }

    const sourceRows = await db.select().from(schema.persons).where(eq(schema.persons.id, id));
    const source = sourceRows[0];
    if (!source) {
      return c.json({ success: false, error: "源人物不存在" }, 404);
    }
    const targetRows = await db
      .select()
      .from(schema.persons)
      .where(eq(schema.persons.id, targetPersonId));
    const target = targetRows[0];
    if (!target) {
      return c.json({ success: false, error: "目标人物不存在" }, 404);
    }
    if (source.storageSourceId !== target.storageSourceId) {
      return c.json({ success: false, error: "跨存储源人物不能合并" }, 400);
    }

    // 同步事务（drizzle async tx 在 better-sqlite3 抛错）
    const newCount = source.memberCount + target.memberCount;
    const shouldDisplay = newCount >= config.face.displayThreshold;
    const now = new Date().toISOString();

    db.transaction((tx) => {
      tx.update(schema.faces)
        .set({ personId: targetPersonId })
        .where(eq(schema.faces.personId, id))
        .run();
      tx.update(schema.persons)
        .set({
          memberCount: newCount,
          displayable: shouldDisplay,
          updatedAt: now,
        })
        .where(eq(schema.persons.id, targetPersonId))
        .run();
      tx.delete(schema.persons).where(eq(schema.persons.id, id)).run();
    });

    // 合并后重算 target.centroidEmbedding + attribute_summary（数学/语义一致性）。
    //
    // 升级历史：原版用所有 face 简单等权平均，但 Phase 2 三件套要求 quality-aware：
    // - HIGH 权重 1.0，MED 权重 medQualityCentroidWeight（默认 0.5），LOW 权重 0
    // - 等权平均会让合并后 LOW face 污染 centroid，绕过雪球保护
    //
    // attribute_summary 同步重算（旧版完全不动这个字段，导致多数票脱离实际 face 集合）。
    //
    // 失败不阻塞主合并（下次新脸归并仍能用旧 centroid/summary，偏差有限）。
    try {
      const allFaces = await db
        .select({
          embedding: schema.faces.embedding,
          attributes: schema.faces.attributes,
          bboxW: schema.faces.bboxW,
          bboxH: schema.faces.bboxH,
          detectionScore: schema.faces.detectionScore,
        })
        .from(schema.faces)
        .where(eq(schema.faces.personId, targetPersonId));

      if (allFaces.length > 0) {
        // 1. quality-aware 加权 centroid（与 detect-faces.ts 三件套一致）
        const qConfig = {
          highBboxSize: config.face.qualityHighBboxSize,
          highDetectionScore: config.face.qualityHighDetectionScore,
          lowDetectionScore: config.face.qualityLowDetectionScore,
        };
        const dim = 512;
        const sum = new Float32Array(dim);
        let weightSum = 0;
        for (const f of allFaces) {
          const q = qualityOf(f.detectionScore, f.bboxW, f.bboxH, qConfig);
          const w = centroidWeightFor(q, config.face.medQualityCentroidWeight);
          if (w === 0) continue; // LOW 不拉 centroid，避免污染
          const e = decodeEmbedding(f.embedding);
          for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) + (e[i] ?? 0) * w;
          weightSum += w;
        }

        // 全部 LOW（极端情况：合并的两 cluster 都是低质 face）→ 退化为等权平均
        if (weightSum === 0) {
          for (const f of allFaces) {
            const e = decodeEmbedding(f.embedding);
            for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) + (e[i] ?? 0);
          }
          weightSum = allFaces.length;
        }

        let normSq = 0;
        for (let i = 0; i < dim; i++) {
          const v = (sum[i] ?? 0) / weightSum;
          sum[i] = v;
          normSq += v * v;
        }
        const norm = Math.sqrt(normSq);
        if (norm > 0) {
          for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) / norm;
        }

        // 2. attribute_summary 重算（含 source 合并进来的 face attributes）
        const facesWithAttrs = allFaces.map((f) => ({
          attributes: f.attributes ? (JSON.parse(f.attributes) as FaceAttributes) : null,
        }));
        const newSummary = updatePersonAttributeSummary(facesWithAttrs);

        await db
          .update(schema.persons)
          .set({
            centroidEmbedding: encodeEmbedding(sum),
            attributeSummary: newSummary ? JSON.stringify(newSummary) : null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.persons.id, targetPersonId));
      }
    } catch {
      // 合并已成功；centroid/summary 重算失败不回滚（下次新脸归并仍能工作）
    }

    return c.json({
      success: true,
      data: {
        mergedFromId: id,
        targetPersonId,
        newMemberCount: newCount,
      },
    });
  })

  /** 自定义头像上传：multipart/form-data，field name=avatar，<2MB，image/jpeg|png|webp */
  .post("/:id/avatar", async (c) => {
    const id = c.req.param("id");
    // B1-3 修复：personId 必须是 [A-Za-z0-9_-]{1,128}，防 ../ 等路径段污染落盘路径
    if (!SAFE_ID_RE.test(id)) {
      return c.json({ success: false, error: "personId 格式非法" }, 400);
    }
    const personRows = await db.select().from(schema.persons).where(eq(schema.persons.id, id));
    const person = personRows[0];
    if (!person) {
      return c.json({ success: false, error: "人物不存在" }, 404);
    }

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ success: false, error: "请求体必须是 multipart/form-data" }, 400);
    }

    const file = formData.get("avatar");
    if (!(file instanceof File)) {
      return c.json({ success: false, error: "缺少 avatar 字段" }, 400);
    }
    if (file.size > 2 * 1024 * 1024) {
      return c.json({ success: false, error: "头像文件不能超过 2MB" }, 400);
    }
    // B1-2 修复：MIME 白名单（前置过滤；下方 sharp metadata format 二次兜底）
    if (file.type && !ALLOWED_AVATAR_MIME.has(file.type)) {
      return c.json(
        { success: false, error: `头像格式必须是 image/jpeg|png|webp，收到 ${file.type}` },
        400,
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());

    // B1-2 修复：sharp metadata 验证真实 format（防 MIME 伪装的 SVG/TIFF 等）
    try {
      const sharpMod = await import("sharp");
      const meta = await sharpMod.default(buf, { failOn: "error" }).metadata();
      if (!meta.format || !ALLOWED_AVATAR_FORMAT.has(meta.format)) {
        return c.json(
          { success: false, error: `头像真实格式必须是 jpeg/png/webp，收到 ${meta.format}` },
          400,
        );
      }
    } catch (err) {
      return c.json({ success: false, error: `头像不是合法图片: ${(err as Error).message}` }, 400);
    }

    let relPath: string;
    try {
      relPath = await saveCustomAvatar(buf, id);
    } catch (err) {
      return c.json({ success: false, error: `头像保存失败: ${(err as Error).message}` }, 400);
    }

    await db
      .update(schema.persons)
      .set({ customAvatarPath: relPath, updatedAt: new Date().toISOString() })
      .where(eq(schema.persons.id, id));

    return c.json({ success: true, data: { customAvatarPath: relPath } });
  })

  /** 头像 GET：custom 优先 → auto → 404 */
  .get("/:id/avatar.jpg", async (c) => {
    const id = c.req.param("id");
    // B1-3 修复：personId 安全字符校验（与上传端点对齐）
    if (!SAFE_ID_RE.test(id)) {
      return c.json({ success: false, error: "personId 格式非法" }, 400);
    }
    const personRows = await db.select().from(schema.persons).where(eq(schema.persons.id, id));
    const person = personRows[0];
    if (!person) {
      return c.json({ success: false, error: "人物不存在" }, 404);
    }
    const candidate = person.customAvatarPath ?? person.avatarPath;
    if (!candidate) {
      return c.json({ success: false, error: "暂无头像" }, 404);
    }
    // B1-1 修复：path traversal 防护
    // 1) 拒绝绝对路径（DB 写入应是相对路径，绝对路径意味着越权）
    // 2) resolve 后必须落在 STORAGE_ROOT/.persons/avatars/ 子树下
    if (path.isAbsolute(candidate)) {
      return c.json({ success: false, error: "头像路径非法（绝对路径）" }, 403);
    }
    const safeRoot = path.resolve(config.storageRoot, ".persons", "avatars");
    const abs = path.resolve(config.storageRoot, candidate);
    if (abs !== safeRoot && !abs.startsWith(safeRoot + path.sep)) {
      return c.json({ success: false, error: "头像路径越界" }, 403);
    }
    try {
      const data = await fs.promises.readFile(abs);
      c.header("Content-Type", "image/jpeg");
      c.header("Cache-Control", "private, max-age=300");
      return c.body(new Uint8Array(data));
    } catch {
      return c.json({ success: false, error: "头像文件已丢失" }, 404);
    }
  })

  /** 设为"我自己"：写 settings.selfPersonId = :id（覆盖原值，全局单值指针） */
  .put("/:id/self", async (c) => {
    const id = c.req.param("id");
    const personRows = await db.select().from(schema.persons).where(eq(schema.persons.id, id));
    if (!personRows[0]) {
      return c.json({ success: false, error: "人物不存在" }, 404);
    }
    await setSettingValue(SELF_PERSON_ID_KEY, id);
    return c.json({ success: true, data: { personId: id, isSelf: true } });
  })

  /** 取消"我自己"：仅当 settings.selfPersonId === :id 时删除（幂等） */
  .delete("/:id/self", async (c) => {
    const id = c.req.param("id");
    const personRows = await db.select().from(schema.persons).where(eq(schema.persons.id, id));
    if (!personRows[0]) {
      return c.json({ success: false, error: "人物不存在" }, 404);
    }
    const current = await getSettingValue(SELF_PERSON_ID_KEY);
    if (current === id) {
      await deleteSetting(SELF_PERSON_ID_KEY);
      return c.json({ success: true, data: { cleared: true } });
    }
    return c.json({ success: true, data: { cleared: false } });
  });

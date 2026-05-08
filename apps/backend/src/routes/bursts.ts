/**
 * 连拍组 API 路由
 *
 * GET  /api/bursts/:id/members      — 返回组内全部照片（按 takenAt 升序）
 * PATCH /api/bursts/:id/representative — 设置代表照片（置 manualOverride=true）
 */
import { setRepresentativeSchema } from "@relight/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";

export const burstsRouter = new Hono()
  /** 获取连拍组成员列表（按拍摄时间升序） */
  .get("/:id/members", async (c) => {
    const burstId = c.req.param("id");

    // 校验 burst 是否存在
    const bursts = await db.select().from(schema.bursts).where(eq(schema.bursts.id, burstId));

    const burst = bursts[0];
    if (!burst) {
      return c.json({ success: false, error: "连拍组不存在" }, 404);
    }

    // 查询所有成员（含 burstSize = memberCount）
    const members = await db
      .select()
      .from(schema.photos)
      .where(eq(schema.photos.burstId, burstId))
      .orderBy(asc(sql`COALESCE(${schema.photos.takenAt}, ${schema.photos.createdAt})`));

    const membersWithSize = members.map((m) => ({
      ...m,
      burstSize: burst.memberCount,
    }));

    return c.json({
      success: true,
      data: membersWithSize,
      burst: {
        id: burst.id,
        representativePhotoId: burst.representativePhotoId,
        memberCount: burst.memberCount,
        manualOverride: burst.manualOverride,
        createdAt: burst.createdAt,
      },
    });
  })

  /** 设置连拍代表照片，同时置 manualOverride=true 防止 AI 分析后自动覆盖 */
  .patch("/:id/representative", async (c) => {
    const burstId = c.req.param("id");

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "请求体不能为空" }, 400);
    }

    const parsed = setRepresentativeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.message }, 400);
    }

    const { photoId } = parsed.data;

    // 校验 burst 存在
    const bursts = await db.select().from(schema.bursts).where(eq(schema.bursts.id, burstId));

    const burst = bursts[0];
    if (!burst) {
      return c.json({ success: false, error: "连拍组不存在" }, 404);
    }

    // 校验 photoId 属于该连拍组
    const targetPhotos = await db
      .select({ id: schema.photos.id })
      .from(schema.photos)
      .where(and(eq(schema.photos.id, photoId), eq(schema.photos.burstId, burstId)));

    if (targetPhotos.length === 0) {
      return c.json({ success: false, error: "照片不属于该连拍组" }, 400);
    }

    // 三步 UPDATE 包进同步事务，规避并发 PATCH 时的"短暂无代表/双代表"窗口
    // 注意：better-sqlite3 transaction 严格同步，必须用 drizzle 的 .run() 同步 API（不能 await async）
    db.transaction((tx) => {
      tx.update(schema.photos)
        .set({ isBurstRepresentative: false })
        .where(eq(schema.photos.burstId, burstId))
        .run();

      tx.update(schema.photos)
        .set({ isBurstRepresentative: true })
        .where(eq(schema.photos.id, photoId))
        .run();

      tx.update(schema.bursts)
        .set({
          representativePhotoId: photoId,
          manualOverride: true,
        })
        .where(eq(schema.bursts.id, burstId))
        .run();
    });

    return c.json({
      success: true,
      data: { burstId, representativePhotoId: photoId, manualOverride: true },
    });
  });

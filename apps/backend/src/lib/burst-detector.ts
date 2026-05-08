/**
 * 连拍检测器
 *
 * 识别策略：时间窗口（≤3 秒）+ dHash 汉明距离（≤10）双重确认
 * 数据持久化：写 bursts 表 + 更新 photos.burst_id/is_burst_representative
 */
import fs from "node:fs/promises";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { dHash, hammingDistance } from "./phash";

/** 连拍时间窗口（秒），同一窗口内的相邻帧认为是连拍 */
const BURST_TIME_WINDOW_SECONDS = 3;

/** dHash 汉明距离阈值（≤ 此值认为画面相似） */
const BURST_HASH_THRESHOLD = 10;

/** 扩展查询时间范围（±秒），用于跨批次合并 */
const CONTEXT_TIME_RANGE_SECONDS = 60;

interface DetectBurstsOptions {
  storageSourceId: string;
  /** 本批次新扫描的照片 ID 列表 */
  photoIds: string[];
}

interface DetectBurstsResult {
  /** 新创建的连拍组数量 */
  newBurstsCount: number;
  /** 更新的连拍组数量（合并了新成员） */
  updatedBurstsCount: number;
  /** 归入连拍组的照片数量 */
  assignedPhotosCount: number;
}

/**
 * Union-Find（并查集）实现，用于将相邻连拍照片聚类
 */
class UnionFind {
  private parent: Map<string, string> = new Map();

  find(id: string): string {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      return id;
    }
    const parent = this.parent.get(id) ?? id;
    if (parent !== id) {
      const root = this.find(parent);
      this.parent.set(id, root);
      return root;
    }
    return id;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      this.parent.set(ra, rb);
    }
  }

  /** 返回 root → 成员列表 的映射 */
  groups(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const members = groups.get(root) ?? [];
      members.push(id);
      groups.set(root, members);
    }
    return groups;
  }
}

/**
 * 检测连拍并写入数据库。
 *
 * 流程：
 * 1. 查找本批 photoIds + ±60s 时间窗口内的已有照片（保证跨批次合并）
 * 2. 按 takenAt 排序，遍历相邻对做双重判断（时间 ≤3s && hamming ≤10）
 * 3. Union-Find 聚类，剔除 1 成员组
 * 4. 对每个新组：写 bursts 行 + 批量更新 photos
 * 5. 已有 burst 的组：检查是否需要合并新成员
 */
export async function detectBursts(options: DetectBurstsOptions): Promise<DetectBurstsResult> {
  const { storageSourceId, photoIds } = options;
  let newBurstsCount = 0;
  let updatedBurstsCount = 0;
  let assignedPhotosCount = 0;

  if (photoIds.length === 0) {
    return { newBurstsCount, updatedBurstsCount, assignedPhotosCount };
  }

  // 1. 查询本批照片，取出 takenAt 范围
  const batchPhotos = await db
    .select({
      id: schema.photos.id,
      takenAt: schema.photos.takenAt,
      fileSize: schema.photos.fileSize,
      phash: schema.photos.phash,
      thumbnailPath: schema.photos.thumbnailPath,
      burstId: schema.photos.burstId,
    })
    .from(schema.photos)
    .where(
      and(eq(schema.photos.storageSourceId, storageSourceId), inArray(schema.photos.id, photoIds)),
    );

  // 过滤出有 takenAt 的照片
  const batchWithTime = batchPhotos.filter((p) => p.takenAt != null);
  if (batchWithTime.length === 0) {
    return { newBurstsCount, updatedBurstsCount, assignedPhotosCount };
  }

  // 计算 takenAt 范围
  const takenAts = batchWithTime.map((p) => new Date(p.takenAt ?? "").getTime());
  const minTime = Math.min(...takenAts);
  const maxTime = Math.max(...takenAts);

  const rangeStart = new Date(minTime - CONTEXT_TIME_RANGE_SECONDS * 1000).toISOString();
  const rangeEnd = new Date(maxTime + CONTEXT_TIME_RANGE_SECONDS * 1000).toISOString();

  // 2. 查找时间范围内该存储源所有照片（含已有 burst 的）
  const contextPhotos = await db
    .select({
      id: schema.photos.id,
      takenAt: schema.photos.takenAt,
      fileSize: schema.photos.fileSize,
      phash: schema.photos.phash,
      thumbnailPath: schema.photos.thumbnailPath,
      burstId: schema.photos.burstId,
    })
    .from(schema.photos)
    .where(
      and(
        eq(schema.photos.storageSourceId, storageSourceId),
        sql`${schema.photos.takenAt} IS NOT NULL`,
        gte(schema.photos.takenAt, rangeStart),
        lte(schema.photos.takenAt, rangeEnd),
      ),
    );

  // 3. 为缺少 phash 的照片计算 phash（从缩略图读取）
  const photosNeedingHash = contextPhotos.filter((p) => !p.phash && p.thumbnailPath);
  if (photosNeedingHash.length > 0) {
    for (const photo of photosNeedingHash) {
      try {
        const buf = await fs.readFile(photo.thumbnailPath ?? "");
        const hash = await dHash(buf);
        await db.update(schema.photos).set({ phash: hash }).where(eq(schema.photos.id, photo.id));
        photo.phash = hash;
      } catch (err) {
        // phash 计算失败：跳过，不影响其他照片
        console.warn(
          `[burst-detector] phash 计算失败 (${photo.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 4. 仅保留有 takenAt 和 phash 的照片，按 takenAt 排序
  const eligible = contextPhotos
    .filter((p) => p.takenAt != null && p.phash != null)
    .sort((a, b) => new Date(a.takenAt ?? "").getTime() - new Date(b.takenAt ?? "").getTime());

  if (eligible.length < 2) {
    return { newBurstsCount, updatedBurstsCount, assignedPhotosCount };
  }

  // 5. Union-Find 聚类：遍历相邻对，双重判断
  const uf = new UnionFind();
  // 初始化所有节点
  for (const p of eligible) {
    uf.find(p.id);
  }

  for (let i = 0; i < eligible.length - 1; i++) {
    const a = eligible[i];
    const b = eligible[i + 1];
    if (!a || !b) continue;

    const deltaMs = Math.abs(
      new Date(b.takenAt ?? "").getTime() - new Date(a.takenAt ?? "").getTime(),
    );
    const deltaSec = deltaMs / 1000;

    if (deltaSec > BURST_TIME_WINDOW_SECONDS) {
      continue; // 时间间隔过大
    }

    const dist = hammingDistance(a.phash ?? "", b.phash ?? "");
    if (dist > BURST_HASH_THRESHOLD) {
      continue; // 画面差异过大
    }

    uf.union(a.id, b.id);
  }

  // 6. 提取有效组（≥2 成员）
  const groups = uf.groups();
  const validGroups: string[][] = [];
  for (const [, members] of groups) {
    if (members.length >= 2) {
      validGroups.push(members);
    }
  }

  if (validGroups.length === 0) {
    return { newBurstsCount, updatedBurstsCount, assignedPhotosCount };
  }

  // 构建 id → photo 的快速查找映射
  const photoMap = new Map(eligible.map((p) => [p.id, p]));

  // 7. 处理每个有效组
  const now = new Date().toISOString();

  for (const members of validGroups) {
    // 检查成员中是否已有 burstId（某些成员可能已属于已有的组）
    const existingBurstIds = new Set<string>();
    for (const memberId of members) {
      const photo = photoMap.get(memberId);
      if (photo?.burstId) {
        existingBurstIds.add(photo.burstId);
      }
    }

    let burstId: string;

    if (existingBurstIds.size === 0) {
      // 全新连拍组
      burstId = crypto.randomUUID();

      // 选初始代表：fileSize 最大的
      let repId = members[0] ?? "";
      let maxSize = photoMap.get(repId)?.fileSize ?? 0;
      for (const memberId of members) {
        const size = photoMap.get(memberId)?.fileSize ?? 0;
        if (size > maxSize) {
          maxSize = size;
          repId = memberId;
        }
      }

      await db.insert(schema.bursts).values({
        id: burstId,
        storageSourceId,
        representativePhotoId: repId || null,
        memberCount: members.length,
        manualOverride: false,
        createdAt: now,
      });

      newBurstsCount++;
    } else if (existingBurstIds.size === 1) {
      // 合并新成员到已有组
      burstId = [...existingBurstIds][0] ?? "";
      if (!burstId) continue;

      // 更新 memberCount
      const existingBurst = await db
        .select()
        .from(schema.bursts)
        .where(eq(schema.bursts.id, burstId));

      if (existingBurst[0]) {
        await db
          .update(schema.bursts)
          .set({ memberCount: members.length })
          .where(eq(schema.bursts.id, burstId));
        updatedBurstsCount++;
      }
    } else {
      // 多个现有 burst 需要合并：取第一个 burst，其余合并入它
      // 保留 manualOverride=true 的 burst 优先
      const allBursts = await db
        .select()
        .from(schema.bursts)
        .where(inArray(schema.bursts.id, [...existingBurstIds]));

      const manualBurst = allBursts.find((b) => b.manualOverride);
      const primaryBurst = manualBurst ?? allBursts[0];
      if (!primaryBurst) continue;

      burstId = primaryBurst.id;

      // 将所有成员重定向到主 burst
      const otherBurstIds = allBursts.map((b) => b.id).filter((id) => id !== burstId);
      if (otherBurstIds.length > 0) {
        await db
          .update(schema.photos)
          .set({ burstId })
          .where(inArray(schema.photos.burstId, otherBurstIds));
        await db.delete(schema.bursts).where(inArray(schema.bursts.id, otherBurstIds));
      }

      await db
        .update(schema.bursts)
        .set({ memberCount: members.length })
        .where(eq(schema.bursts.id, burstId));
      updatedBurstsCount++;
    }

    // 8. 批量更新 photos：设置 burst_id + is_burst_representative
    // 先确定代表：已有代表则保留，否则取 fileSize 最大
    const burstRows = await db.select().from(schema.bursts).where(eq(schema.bursts.id, burstId));

    const currentRepId = burstRows[0]?.representativePhotoId;

    // 更新所有成员的 burst_id，重置 is_burst_representative
    await db
      .update(schema.photos)
      .set({ burstId, isBurstRepresentative: false })
      .where(inArray(schema.photos.id, members));

    // 设置代表
    const repId =
      currentRepId && members.includes(currentRepId) ? currentRepId : (members[0] ?? "");
    if (repId) {
      await db
        .update(schema.photos)
        .set({ isBurstRepresentative: true })
        .where(eq(schema.photos.id, repId));

      // 确保 burst 表里记录了代表 ID
      await db
        .update(schema.bursts)
        .set({ representativePhotoId: repId })
        .where(eq(schema.bursts.id, burstId));
    }

    assignedPhotosCount += members.length;
  }

  return { newBurstsCount, updatedBurstsCount, assignedPhotosCount };
}

/**
 * detect-faces Worker：照片 analyze 完成后入队，跑人脸检测 + embedding + 增量聚类。
 *
 * 流程：
 * 1. 读 photo + storageSource，校验 mediaType=image
 * 2. fs.access 检查模型文件存在；缺失 → warn + return（不抛错，prod 部署模型缺失保护）
 * 3. 读图 buffer，sharp metadata 拿 width/height
 * 4. detectFaces → DetectedFace[]（已过滤小脸 + NMS）
 * 5. 对每张脸：
 *    a. alignFace + embedFace → L2-normalized 512 维 embedding
 *    b. 写 face 行（含 base64 embedding，personId 暂为 null）
 *    c. 同 storageSource 拉 persons centroids → assignToPerson
 *    d. 命中 → UPDATE faces.personId + persons memberCount/centroid（同步事务）
 *    e. 未命中 → 新建 person（centroid=本 embedding，memberCount=1）+ UPDATE face
 *    f. memberCount >= threshold → displayable=true
 * 6. 自动选最佳代表（manualOverride=false 时，分数最高那张），生成头像
 *
 * 设计要点：
 * - 不在模块顶层 import face/* 模块（避免 dev 启动时强制要求 ONNX runtime）
 * - 模型缺失降级 = 不阻断主流程
 * - 同步事务包合并/校准操作（drizzle async transaction 在 better-sqlite3 抛错）
 * - 只处理 image，video 跳过（视频暂不识别）
 */
import * as path from "node:path";
import type { Job } from "bullmq";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { encodeEmbedding } from "../lib/face/embedding-codec";
import { modelFileExists } from "../lib/face/session";
import { createStorageAdapter } from "../storage";

interface DetectFacesJobData {
  photoId: string;
}

export async function detectFacesWorker(job: Job<DetectFacesJobData>): Promise<void> {
  const { photoId } = job.data;
  job.log(`[detect-faces] 开始: photoId=${photoId}`);

  // 1. 读 photo
  const photoRows = await db.select().from(schema.photos).where(eq(schema.photos.id, photoId));
  const photo = photoRows[0];
  if (!photo) {
    job.log(`[detect-faces] 照片不存在，跳过: ${photoId}`);
    return;
  }

  // 仅处理 image
  if (photo.mediaType !== "image") {
    job.log(`[detect-faces] 非 image (${photo.mediaType})，跳过`);
    return;
  }

  // 2. 模型存在性检查（缺失降级，不阻塞）
  const [scrfdOk, arcfaceOk] = await Promise.all([
    modelFileExists("scrfd"),
    modelFileExists("arcface"),
  ]);
  if (!scrfdOk || !arcfaceOk) {
    console.warn(
      `[detect-faces] 模型文件缺失 (scrfd=${scrfdOk}, arcface=${arcfaceOk})；请运行 \`pnpm models:download\`。本次跳过。`,
    );
    job.log(`[detect-faces] 模型缺失，跳过 photoId=${photoId}`);
    return;
  }

  // 3. 读 storage + 文件
  const sourceRows = await db
    .select()
    .from(schema.storageSources)
    .where(eq(schema.storageSources.id, photo.storageSourceId));
  const source = sourceRows[0];
  if (!source) {
    job.log(`[detect-faces] storageSource 不存在: ${photo.storageSourceId}`);
    return;
  }

  const adapter = createStorageAdapter(source.type);
  // patterns.md：网络/SMB 挂载先 readFile 入 buffer 再传 sharp
  let buffer = await adapter.getFileBuffer(photo.filePath);

  // HEIC 解码：macOS sharp libvips 默认不支持 HEIC，必须先经 heic-decode 转 JPEG
  const { isHeicFile, isHeicBuffer, convertHeicToJpeg } = await import("../lib/heic");
  if (isHeicFile(photo.filePath) || isHeicBuffer(buffer)) {
    try {
      buffer = await convertHeicToJpeg(buffer);
    } catch (err) {
      job.log(`[detect-faces] HEIC 解码失败，跳过: ${(err as Error).message}`);
      return;
    }
  }

  // sharp 解析 metadata
  const sharpMod = await import("sharp");
  const sharp = sharpMod.default;
  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(buffer).metadata();
  } catch (err) {
    job.log(`[detect-faces] sharp metadata 失败: ${(err as Error).message}`);
    return;
  }
  const imageWidth = meta.width;
  const imageHeight = meta.height;
  if (!imageWidth || !imageHeight) {
    job.log("[detect-faces] 无法获取图片尺寸，跳过");
    return;
  }

  // 4. 检测人脸（动态 import 避免顶层 ONNX 加载）
  const { detectFaces } = await import("../lib/face/detector");
  let detected: Awaited<ReturnType<typeof detectFaces>>;
  try {
    detected = await detectFaces(buffer, imageWidth, imageHeight);
  } catch (err) {
    job.log(`[detect-faces] 检测失败: ${(err as Error).message}`);
    throw err; // 让 BullMQ 重试
  }
  job.log(`[detect-faces] 检测到 ${detected.length} 张脸`);
  if (detected.length === 0) return;

  const { alignFace } = await import("../lib/face/aligner");
  const { embedFace } = await import("../lib/face/embedder");
  const { assignToPerson, updateCentroid } = await import("../lib/face/clustering");
  const { decodeEmbedding } = await import("../lib/face/embedding-codec");
  const { generateAutoAvatar } = await import("../lib/face/avatar");

  // 5. 处理每张脸
  for (const det of detected) {
    let embedding: Float32Array;
    try {
      const aligned = await alignFace(
        buffer,
        { x: det.x, y: det.y, w: det.w, h: det.h },
        imageWidth,
        imageHeight,
      );
      embedding = await embedFace(aligned);
    } catch (err) {
      job.log(`[detect-faces] 单张脸 embedding 失败（已跳过该脸）: ${(err as Error).message}`);
      continue;
    }

    const now = new Date().toISOString();
    const faceId = crypto.randomUUID();

    // 5a. 写 face 行（personId 暂 null）
    await db.insert(schema.faces).values({
      id: faceId,
      photoId,
      personId: null,
      bboxX: det.x,
      bboxY: det.y,
      bboxW: det.w,
      bboxH: det.h,
      detectionScore: det.score,
      embedding: encodeEmbedding(embedding),
      detectedAt: now,
    });

    // 5b. 拉同 storageSource 的 person centroids
    const personsRows = await db
      .select()
      .from(schema.persons)
      .where(eq(schema.persons.storageSourceId, photo.storageSourceId));

    const candidates = personsRows.map((p) => ({
      id: p.id,
      memberCount: p.memberCount,
      centroid: decodeEmbedding(p.centroidEmbedding),
    }));

    const result = assignToPerson(embedding, candidates, config.face.clusteringThreshold);
    job.log(
      `[detect-faces] face=${faceId} bestSim=${result.bestSim.toFixed(3)} → ${result.matchedPersonId ?? "(new)"}`,
    );

    if (result.matchedPersonId) {
      // 5c. 归并到现有 person
      const matched = personsRows.find((p) => p.id === result.matchedPersonId);
      if (!matched) continue;
      const newCentroid = updateCentroid(
        decodeEmbedding(matched.centroidEmbedding),
        matched.memberCount,
        embedding,
      );
      const newCount = matched.memberCount + 1;
      const shouldDisplay = newCount >= config.face.displayThreshold;

      // 同步事务（drizzle async tx 在 better-sqlite3 抛错）
      // 单脸事务失败不影响后续脸（B1-4 修复：避免 SQLite busy / FK 等异常导致整批中断）
      try {
        db.transaction((tx) => {
          tx.update(schema.faces)
            .set({ personId: matched.id })
            .where(eq(schema.faces.id, faceId))
            .run();
          tx.update(schema.persons)
            .set({
              centroidEmbedding: encodeEmbedding(newCentroid),
              memberCount: newCount,
              displayable: shouldDisplay,
              updatedAt: now,
            })
            .where(eq(schema.persons.id, matched.id))
            .run();
        });
      } catch (err) {
        job.log(`[detect-faces] 归并事务失败（已跳过该脸）: ${(err as Error).message}`);
        continue;
      }

      // 5f. 自动选代表 + 重新生成头像（manualOverride=false 时）
      if (!matched.manualOverride) {
        await maybeUpdateRepresentativeAndAvatar(matched.id, source.id, buffer, job);
      }
    } else {
      // 5e. 新建 person
      const newPersonId = crypto.randomUUID();
      const initDisplayable = 1 >= config.face.displayThreshold;
      // 单脸事务失败不影响后续脸（B1-4 修复）
      try {
        db.transaction((tx) => {
          tx.insert(schema.persons)
            .values({
              id: newPersonId,
              storageSourceId: photo.storageSourceId,
              name: null,
              bio: null,
              representativeFaceId: faceId,
              avatarPath: null,
              customAvatarPath: null,
              centroidEmbedding: encodeEmbedding(embedding),
              memberCount: 1,
              manualOverride: false,
              displayable: initDisplayable,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          tx.update(schema.faces)
            .set({ personId: newPersonId })
            .where(eq(schema.faces.id, faceId))
            .run();
        });
      } catch (err) {
        job.log(`[detect-faces] 新建 person 事务失败（已跳过该脸）: ${(err as Error).message}`);
        continue;
      }

      // 生成初始头像
      try {
        const avatarAbs = await generateAutoAvatar(
          buffer,
          { x: det.x, y: det.y, w: det.w, h: det.h },
          imageWidth,
          imageHeight,
          newPersonId,
        );
        const avatarRel = path.relative(config.storageRoot, avatarAbs);
        await db
          .update(schema.persons)
          .set({ avatarPath: avatarRel, updatedAt: new Date().toISOString() })
          .where(eq(schema.persons.id, newPersonId));
      } catch (err) {
        job.log(`[detect-faces] 头像生成失败（已忽略）: ${(err as Error).message}`);
      }
    }
  }

  job.log(`[detect-faces] 完成: ${detected.length} 张脸`);
}

/**
 * 自动校准代表 face：选 person 内 detectionScore 最高的 face 为代表，并重新生成头像。
 *
 * 仅在 manualOverride=false 时调用。
 */
async function maybeUpdateRepresentativeAndAvatar(
  personId: string,
  storageSourceId: string,
  _currentImageBuffer: Buffer,
  job: Job<DetectFacesJobData>,
): Promise<void> {
  try {
    // 找出该 person 下所有 face，按 detectionScore desc
    const faceRows = await db
      .select()
      .from(schema.faces)
      .where(eq(schema.faces.personId, personId));
    if (faceRows.length === 0) return;

    let bestFace = faceRows[0];
    if (!bestFace) return;
    for (const f of faceRows) {
      if ((f.detectionScore ?? 0) > (bestFace?.detectionScore ?? 0)) {
        bestFace = f;
      }
    }
    if (!bestFace) return;

    const personRows = await db
      .select()
      .from(schema.persons)
      .where(eq(schema.persons.id, personId));
    const person = personRows[0];
    if (!person) return;

    if (person.representativeFaceId === bestFace.id) {
      // 代表不变，不重新生成头像
      return;
    }

    // 拉代表 face 对应的 photo（可能不是当前正在处理的 photo）
    const repPhotoRows = await db
      .select()
      .from(schema.photos)
      .where(and(eq(schema.photos.id, bestFace.photoId)));
    const repPhoto = repPhotoRows[0];
    if (!repPhoto) return;

    const sourceRows = await db
      .select()
      .from(schema.storageSources)
      .where(eq(schema.storageSources.id, storageSourceId));
    const src = sourceRows[0];
    if (!src) return;

    const adapter = createStorageAdapter(src.type);
    let repBuffer: Buffer;
    try {
      repBuffer = await adapter.getFileBuffer(repPhoto.filePath);
    } catch (err) {
      job.log(`[detect-faces] 代表照片读取失败（保留旧头像）: ${(err as Error).message}`);
      return;
    }

    // HEIC 解码（与主流程同）
    const { isHeicFile, isHeicBuffer, convertHeicToJpeg } = await import("../lib/heic");
    if (isHeicFile(repPhoto.filePath) || isHeicBuffer(repBuffer)) {
      try {
        repBuffer = await convertHeicToJpeg(repBuffer);
      } catch (err) {
        job.log(`[detect-faces] 代表 HEIC 解码失败（保留旧头像）: ${(err as Error).message}`);
        return;
      }
    }

    const sharpMod = await import("sharp");
    const meta = await sharpMod.default(repBuffer).metadata();
    if (!meta.width || !meta.height) return;

    const { generateAutoAvatar } = await import("../lib/face/avatar");
    const avatarAbs = await generateAutoAvatar(
      repBuffer,
      {
        x: bestFace.bboxX,
        y: bestFace.bboxY,
        w: bestFace.bboxW,
        h: bestFace.bboxH,
      },
      meta.width,
      meta.height,
      personId,
    );
    const avatarRel = path.relative(config.storageRoot, avatarAbs);

    await db
      .update(schema.persons)
      .set({
        representativeFaceId: bestFace.id,
        avatarPath: avatarRel,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.persons.id, personId));
    job.log(`[detect-faces] 代表已校准: person=${personId} → face=${bestFace.id}`);
  } catch (err) {
    job.log(`[detect-faces] 代表校准失败（已忽略）: ${(err as Error).message ?? String(err)}`);
  }
}

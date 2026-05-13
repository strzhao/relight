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
 *    b. 写 face 行（含 base64 embedding，personId 暂为 null，attributes 暂为 null）
 *    b'. cropFaceToJpeg → analyzeFaceAttributes → UPDATE faces SET attributes（方案 C）
 *    c. 同 storageSource 拉 persons centroids（含 attribute_summary）→ assignToPersonWithAttrFilter
 *    d. 命中 → UPDATE faces.personId + persons memberCount/centroid（同步事务）
 *       + 重新计算 attribute_summary（重查 person 内所有 face）
 *    e. 未命中 → 新建 person（centroid=本 embedding，memberCount=1）+ UPDATE face
 *       + 初始化 attribute_summary（若有 attributes）
 *    f. memberCount >= threshold → displayable=true
 * 6. 自动选最佳代表（manualOverride=false 时，分数最高那张），生成头像
 *
 * 设计要点：
 * - 不在模块顶层 import face/* 模块（避免 dev 启动时强制要求 ONNX runtime）
 * - 模型缺失降级 = 不阻断主流程
 * - 同步事务包合并/校准操作（drizzle async transaction 在 better-sqlite3 抛错）
 * - 只处理 image，video 跳过（视频暂不识别）
 * - attributeAnalysisEnabled=false 时属性分析跳过，退化为纯 cosine
 */
import * as path from "node:path";
import type { Job } from "bullmq";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import type { FaceAttributes } from "../lib/face/attributes";
import type { PersonAttributeSummary } from "../lib/face/clustering";
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

  const sharpMod = await import("sharp");
  const sharp = sharpMod.default;

  // 应用 EXIF orientation。iPhone JPEG 常见物理像素横向 + orientation=6 标"顺时针 90°"，
  // viewer/thumbnail 显示时会自动旋转为竖向，但 sharp 默认不旋转 raw pixel。
  // 不旋转 → detector 在横向图里检测竖向人脸 → 大量漏检 + bbox 与 thumbnail 错位。
  try {
    buffer = await sharp(buffer, { failOn: "none" }).rotate().toBuffer();
  } catch (err) {
    job.log(`[detect-faces] EXIF rotate 失败: ${(err as Error).message}`);
    return;
  }

  // sharp 解析 metadata（拿 rotate 后的真实尺寸）
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
  const {
    assignToPersonWithAttrFilter,
    updateCentroidWeighted,
    updatePersonAttributeSummary,
    qualityOf,
    centroidWeightFor,
    clusterConfigForQuality,
  } = await import("../lib/face/clustering");
  const { decodeEmbedding } = await import("../lib/face/embedding-codec");
  const { generateAutoAvatar } = await import("../lib/face/avatar");
  const { cropFaceToJpeg } = await import("../lib/face/crop");
  const { analyzeFaceAttributes } = await import("../lib/face/attributes");

  const clusterConfig = {
    mergeThreshold: config.face.clusteringMergeThreshold,
    minThreshold: config.face.clusteringMinThreshold,
    midZoneFilter: config.face.midZoneAttrFilter,
  };
  const qualityConfig = {
    highBboxSize: config.face.qualityHighBboxSize,
    highDetectionScore: config.face.qualityHighDetectionScore,
    lowDetectionScore: config.face.qualityLowDetectionScore,
  };

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

    // 5b. 写 face 行（personId 暂 null，attributes 暂 null）
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
      attributes: null,
    });

    // 5b'. 方案 C：裁剪人脸 → 分析属性 → 写回 faces.attributes
    let faceAttributes: FaceAttributes | null = null;
    if (config.face.attributeAnalysisEnabled) {
      try {
        const faceCrop = await cropFaceToJpeg(
          buffer,
          { x: det.x, y: det.y, w: det.w, h: det.h },
          imageWidth,
          imageHeight,
        );
        faceAttributes = await analyzeFaceAttributes(faceCrop);
        if (faceAttributes) {
          await db
            .update(schema.faces)
            .set({ attributes: JSON.stringify(faceAttributes) })
            .where(eq(schema.faces.id, faceId));
          job.log(
            `[detect-faces] 属性分析完成: face=${faceId} gender=${faceAttributes.gender} age=${faceAttributes.age_band}`,
          );
        } else {
          job.log(`[detect-faces] 属性分析返回 null（已忽略）: face=${faceId}`);
        }
      } catch (err) {
        job.log(`[detect-faces] 属性分析异常（已忽略）: ${(err as Error).message}`);
      }
    }

    // 5c. 拉同 storageSource 的 person centroids（含 attribute_summary）
    const personsRows = await db
      .select()
      .from(schema.persons)
      .where(eq(schema.persons.storageSourceId, photo.storageSourceId));

    const candidates = personsRows.map((p) => {
      let parsedSummary: PersonAttributeSummary | null = null;
      if (p.attributeSummary) {
        try {
          parsedSummary = JSON.parse(p.attributeSummary) as PersonAttributeSummary;
        } catch {
          parsedSummary = null;
        }
      }
      return {
        id: p.id,
        memberCount: p.memberCount,
        centroid: decodeEmbedding(p.centroidEmbedding),
        attribute_summary: parsedSummary,
      };
    });

    // Quality-aware：LOW face 用更严阈值，避免污染大 cluster（patterns.md 雪球陷阱）
    const quality = qualityOf(det.score, det.w, det.h, qualityConfig);
    const effectiveConfig = clusterConfigForQuality(clusterConfig, quality);
    const result = assignToPersonWithAttrFilter(
      embedding,
      faceAttributes,
      candidates,
      effectiveConfig,
    );
    const centroidWeight = centroidWeightFor(quality, config.face.medQualityCentroidWeight);
    job.log(
      `[detect-faces] face=${faceId} quality=${quality} weight=${centroidWeight} bestSim=${result.bestSim.toFixed(3)} rejectedByAttr=${result.rejectedByAttr} → ${result.matchedPersonId ?? "(new)"}`,
    );

    if (result.matchedPersonId) {
      // 5d. 归并到现有 person
      const matched = personsRows.find((p) => p.id === result.matchedPersonId);
      if (!matched) continue;
      // Quality-aware：HIGH 全权重，MED 折半，LOW 完全不拉 centroid（避免雪球污染）
      const newCentroid = updateCentroidWeighted(
        decodeEmbedding(matched.centroidEmbedding),
        matched.memberCount, // 用 memberCount 作为旧权重和的近似（简化，避免新增 weightSum 列）
        embedding,
        centroidWeight,
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

      // 重算 attribute_summary（重查该 person 所有 face 的 attributes）
      try {
        const allFaceRows = await db
          .select({ attributes: schema.faces.attributes })
          .from(schema.faces)
          .where(eq(schema.faces.personId, matched.id));

        const facesWithAttr = allFaceRows.map((f) => {
          let parsed: FaceAttributes | null = null;
          if (f.attributes) {
            try {
              parsed = JSON.parse(f.attributes) as FaceAttributes;
            } catch {
              parsed = null;
            }
          }
          return { attributes: parsed };
        });

        const newSummary = updatePersonAttributeSummary(facesWithAttr);
        await db
          .update(schema.persons)
          .set({
            attributeSummary: newSummary ? JSON.stringify(newSummary) : null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.persons.id, matched.id));
      } catch (err) {
        job.log(`[detect-faces] attribute_summary 重算失败（已忽略）: ${(err as Error).message}`);
      }

      // 5f. 自动选代表 + 重新生成头像（manualOverride=false 时）
      if (!matched.manualOverride) {
        await maybeUpdateRepresentativeAndAvatar(matched.id, source.id, buffer, job);
      }
    } else {
      // 5e. 新建 person
      const newPersonId = crypto.randomUUID();
      const initDisplayable = 1 >= config.face.displayThreshold;

      // 新 person 的初始 attribute_summary
      let initSummary: PersonAttributeSummary | null = null;
      if (faceAttributes) {
        initSummary = updatePersonAttributeSummary([{ attributes: faceAttributes }]);
      }

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
              attributeSummary: initSummary ? JSON.stringify(initSummary) : null,
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
 * 自动校准代表 face：选 person 内**离 centroid 最近**（cosine sim 最高）的 face 为代表。
 *
 * 之前用 detectionScore 最高 → 误检的广告牌人脸 score 高时会被选为代表，与 person
 * 其他真人脸不像。改用 sim 后选的是 person 的"原型脸"，最能代表整体特征。
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
    const faceRows = await db
      .select()
      .from(schema.faces)
      .where(eq(schema.faces.personId, personId));
    if (faceRows.length === 0) return;

    const personRowsTmp = await db
      .select()
      .from(schema.persons)
      .where(eq(schema.persons.id, personId));
    const personTmp = personRowsTmp[0];
    if (!personTmp) return;

    const { decodeEmbedding } = await import("../lib/face/embedding-codec");
    const centroid = decodeEmbedding(personTmp.centroidEmbedding);
    function cosineSim(a: Float32Array, b: Float32Array): number {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        const ai = a[i] ?? 0;
        const bi = b[i] ?? 0;
        dot += ai * bi;
        na += ai * ai;
        nb += bi * bi;
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }
    let bestFace = faceRows[0];
    let bestSim = Number.NEGATIVE_INFINITY;
    for (const f of faceRows) {
      const emb = decodeEmbedding(f.embedding);
      const sim = cosineSim(emb, centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestFace = f;
      }
    }
    if (!bestFace) return;
    job.log(
      `[detect-faces] 代表选择 person=${personId} bestFace=${bestFace.id} sim=${bestSim.toFixed(3)}`,
    );

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
    // 应用 EXIF orientation（与主流程一致，否则头像截取会按 raw pixel 方向取错位置）
    try {
      repBuffer = await sharpMod.default(repBuffer, { failOn: "none" }).rotate().toBuffer();
    } catch (err) {
      job.log(`[detect-faces] 代表 EXIF rotate 失败: ${(err as Error).message}`);
      return;
    }
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

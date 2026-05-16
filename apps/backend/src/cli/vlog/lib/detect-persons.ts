/**
 * detectPersonsInMedia：对图片或视频做人脸识别，返回 persons 匹配结果。
 *
 * 设计要点（架构决策 1）：
 * - 视频帧 face **不入 faces 表，零侵入**
 * - 从 DB 只 **读** persons.centroidEmbedding + personPrototypes，不写任何数据
 * - 匹配命中后只输出聚合结果（personId + name + frameCount + confidence）
 *
 * 失败容错：
 * - ONNX session 加载失败 → status:"model_unavailable"
 * - DB 查询失败 → status:"db_unavailable"
 * - 视频抽帧失败 → persons:[]（抽帧 error 不往上抛）
 * - matchByPrototypes 未命中阈值 → 该 face 不计入任何 person
 */
import fs from "node:fs/promises";
import { inArray } from "drizzle-orm";
import { db, schema } from "../../../db";
import { config } from "../../../lib/config";
import { decodeEmbedding } from "../../../lib/face/embedding-codec";
import { matchByPrototypes } from "../../../lib/face/prototypes";
import type { Prototype } from "../../../lib/face/prototypes";

export interface PersonsResult {
  persons: Array<{
    personId: string;
    name: string;
    frameCount: number;
    confidence: number;
  }>;
  status: "ok" | "no_faces" | "model_unavailable" | "db_unavailable";
}

export interface DetectPersonsOpts {
  storageSourceId?: string;
  sceneTimes?: number[];
}

type PersonCandidate = {
  person: {
    id: string;
    name: string | null;
    centroidEmbedding: string;
    attributeSummary: string | null;
  };
  prototypes: Prototype[];
};

/**
 * 从 DB 读取 persons 的 centroid + prototypes，用于匹配。
 * 只读不写。
 */
async function loadPersonsForMatching(storageSourceId?: string): Promise<PersonCandidate[]> {
  const { eq } = await import("drizzle-orm");

  const personsRows = storageSourceId
    ? await db
        .select()
        .from(schema.persons)
        .where(eq(schema.persons.storageSourceId, storageSourceId))
    : await db.select().from(schema.persons);

  if (personsRows.length === 0) return [];

  const personIds = personsRows.map((p) => p.id);
  const allPrototypeRows =
    personIds.length > 0
      ? await db
          .select()
          .from(schema.personPrototypes)
          .where(inArray(schema.personPrototypes.personId, personIds))
      : [];

  const prototypesByPerson = new Map<string, Prototype[]>();
  for (const row of allPrototypeRows) {
    const arr = prototypesByPerson.get(row.personId) ?? [];
    arr.push({
      id: row.id,
      personId: row.personId,
      embedding: decodeEmbedding(row.embedding),
      weightSum: row.weightSum,
      memberCount: row.memberCount,
    });
    prototypesByPerson.set(row.personId, arr);
  }

  return personsRows.map((p) => ({
    person: {
      id: p.id,
      name: p.name ?? "",
      centroidEmbedding: p.centroidEmbedding,
      attributeSummary: p.attributeSummary,
    },
    prototypes: prototypesByPerson.get(p.id) ?? [],
  }));
}

/** 聚合多帧人物匹配结果：同一 personId 累计 frameCount，confidence 取 mean */
function aggregatePersonHits(
  hits: Array<{ personId: string; name: string; score: number }>,
): PersonsResult["persons"] {
  const byId = new Map<
    string,
    { personId: string; name: string; totalScore: number; frameCount: number }
  >();
  for (const h of hits) {
    const existing = byId.get(h.personId);
    if (existing) {
      existing.totalScore += h.score;
      existing.frameCount += 1;
    } else {
      byId.set(h.personId, {
        personId: h.personId,
        name: h.name,
        totalScore: h.score,
        frameCount: 1,
      });
    }
  }
  return Array.from(byId.values()).map((v) => ({
    personId: v.personId,
    name: v.name,
    frameCount: v.frameCount,
    confidence: v.totalScore / v.frameCount,
  }));
}

/**
 * 对一个图片 buffer 跑 face detect + embed + match，返回命中的 person hits。
 */
async function detectAndMatchBuffer(
  buffer: Buffer,
  imageWidth: number,
  imageHeight: number,
  candidates: PersonCandidate[],
): Promise<Array<{ personId: string; name: string; score: number }>> {
  const { detectFaces } = await import("../../../lib/face/detector");
  const { alignFace } = await import("../../../lib/face/aligner");
  const { embedFace } = await import("../../../lib/face/embedder");

  const protoMatchConfig = {
    mergeThreshold: config.face.clusteringMergeThreshold,
    minThreshold: config.face.clusteringMinThreshold,
    midZoneFilter: config.face.midZoneAttrFilter,
    prototypeCoarseFilter: config.face.prototypeCoarseFilter,
  };

  let detected: Awaited<ReturnType<typeof detectFaces>>;
  try {
    detected = await detectFaces(buffer, imageWidth, imageHeight);
  } catch {
    return [];
  }

  const hits: Array<{ personId: string; name: string; score: number }> = [];
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
    } catch {
      continue;
    }

    const result = matchByPrototypes(embedding, candidates, null, protoMatchConfig);
    if (result.matchedPersonId) {
      const matchedCandidate = candidates.find((c) => c.person.id === result.matchedPersonId);
      if (matchedCandidate) {
        hits.push({
          personId: result.matchedPersonId,
          name: matchedCandidate.person.name ?? "",
          score: result.score,
        });
      }
    }
  }
  return hits;
}

/**
 * 对图片文件做人脸识别。
 */
async function detectInImage(
  filePath: string,
  candidates: PersonCandidate[],
): Promise<PersonsResult> {
  const sharp = (await import("sharp")).default;
  const { isHeicFile, isHeicBuffer, convertHeicToJpeg } = await import("../../../lib/heic");

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    return { persons: [], status: "no_faces" };
  }

  // HEIC → JPEG
  if (isHeicFile(filePath) || isHeicBuffer(buffer)) {
    try {
      buffer = await convertHeicToJpeg(buffer);
    } catch {
      return { persons: [], status: "no_faces" };
    }
  }

  // 应用 EXIF orientation（iPhone 常见）
  try {
    buffer = await sharp(buffer, { failOn: "none" }).rotate().toBuffer();
  } catch {
    return { persons: [], status: "no_faces" };
  }

  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    return { persons: [], status: "no_faces" };
  }
  if (!meta.width || !meta.height) return { persons: [], status: "no_faces" };

  const hits = await detectAndMatchBuffer(buffer, meta.width, meta.height, candidates);
  if (hits.length === 0 && candidates.length === 0) {
    return { persons: [], status: "no_faces" };
  }
  const persons = aggregatePersonHits(hits);
  return { persons, status: persons.length > 0 ? "ok" : "no_faces" };
}

/**
 * 对视频文件做人脸识别：extractFrames → 每帧 detect+embed → 跨帧聚合。
 */
async function detectInVideo(
  filePath: string,
  sceneTimes: number[] | undefined,
  candidates: PersonCandidate[],
): Promise<PersonsResult> {
  const sharp = (await import("sharp")).default;
  const { extractFrames } = await import("../../../lib/video/ffmpeg");

  // 抽帧：复用 sceneTimes（manifest 已有数据）
  let frames: Buffer[];
  try {
    // extractFrames 内部会做 scene cut + uniform fallback
    // count 优先用 sceneTimes 长度，最小 3 帧
    const count = sceneTimes && sceneTimes.length > 0 ? Math.max(3, sceneTimes.length) : 6;
    frames = await extractFrames(filePath, count);
  } catch {
    // 抽帧失败 → 该视频 persons:[] 但不往上抛
    return { persons: [], status: "no_faces" };
  }

  const allHits: Array<{ personId: string; name: string; score: number }> = [];

  for (const frameBuf of frames) {
    let meta: { width?: number; height?: number };
    try {
      meta = await sharp(frameBuf).metadata();
    } catch {
      continue;
    }
    if (!meta.width || !meta.height) continue;

    const hits = await detectAndMatchBuffer(frameBuf, meta.width, meta.height, candidates);
    allHits.push(...hits);
  }

  const persons = aggregatePersonHits(allHits);
  return { persons, status: persons.length > 0 ? "ok" : "no_faces" };
}

/**
 * 主入口：对 image 或 video 文件做人脸识别，返回 PersonsResult。
 */
export async function detectPersonsInMedia(
  filePath: string,
  mediaType: "image" | "video",
  opts: DetectPersonsOpts,
): Promise<PersonsResult> {
  // 检查模型是否存在
  const { modelFileExists } = await import("../../../lib/face/session");
  const [scrfdOk, arcfaceOk] = await Promise.all([
    modelFileExists("scrfd"),
    modelFileExists("arcface"),
  ]);
  if (!scrfdOk || !arcfaceOk) {
    return { persons: [], status: "model_unavailable" };
  }

  // 从 DB 加载 person 数据（只读）
  let candidates: PersonCandidate[];
  try {
    candidates = await loadPersonsForMatching(opts.storageSourceId);
  } catch {
    return { persons: [], status: "db_unavailable" };
  }

  // 无任何 person 数据时，直接返回 no_faces（不跑 ONNX 浪费资源）
  if (candidates.length === 0) {
    return { persons: [], status: "no_faces" };
  }

  if (mediaType === "image") {
    return detectInImage(filePath, candidates);
  }
  return detectInVideo(filePath, opts.sceneTimes, candidates);
}

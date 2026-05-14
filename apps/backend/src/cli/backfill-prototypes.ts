/**
 * 人物原型批量回填脚本
 *
 * 背景：person_prototypes 表为多原型聚类新增，历史 person 没有原型数据。
 * 本脚本对每个 person 的所有 face embedding 跑 mini-batch k-means，
 * 将结果写入 person_prototypes 表。
 *
 * 用法：
 *   pnpm --filter @relight/backend tsx src/cli/backfill-prototypes.ts
 *   pnpm --filter @relight/backend tsx src/cli/backfill-prototypes.ts --force
 *
 * 幂等：
 *   - 默认仅处理 person_prototypes 表中没有行的 person
 *   - --force 时先删除再重建所有 person 的原型
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray, notInArray } from "drizzle-orm";
import pLimit from "p-limit";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { qualityOf } from "../lib/face/clustering";
import { decodeEmbedding, encodeEmbedding } from "../lib/face/embedding-codec";
import { miniBatchKmeansCosine } from "../lib/face/prototypes";

const backendRoot = (() => {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath && path.isAbsolute(dbPath)) {
    return path.resolve(dbPath, "../../");
  }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "../../");
})();
process.chdir(backendRoot);
console.log(`[backfill-prototypes] 工作目录: ${backendRoot}`);

const isForce = process.argv.includes("--force");
const CONCURRENCY = 4;

const qualityConfig = {
  highBboxSize: config.face.qualityHighBboxSize,
  highDetectionScore: config.face.qualityHighDetectionScore,
  lowDetectionScore: config.face.qualityLowDetectionScore,
};

interface ProcessResult {
  status: "ok" | "skipped" | "failed";
  personId: string;
  reason?: string;
}

async function processPerson(personRow: {
  id: string;
  centroidEmbedding: string;
  memberCount: number;
}): Promise<ProcessResult> {
  const personId = personRow.id;

  // 拉该 person 的所有 face
  const faceRows = await db
    .select({
      embedding: schema.faces.embedding,
      bboxW: schema.faces.bboxW,
      bboxH: schema.faces.bboxH,
      detectionScore: schema.faces.detectionScore,
    })
    .from(schema.faces)
    .where(eq(schema.faces.personId, personId));

  if (isForce) {
    // 先删旧原型
    await db.delete(schema.personPrototypes).where(eq(schema.personPrototypes.personId, personId));
  }

  const now = new Date().toISOString();

  // 过滤 LOW quality face
  const goodFaces: Array<{ embedding: Float32Array; weight: number }> = [];
  for (const f of faceRows) {
    const q = qualityOf(f.detectionScore, f.bboxW, f.bboxH, qualityConfig);
    if (q === "low") continue;
    const w = q === "high" ? 1.0 : config.face.medQualityCentroidWeight;
    try {
      const emb = decodeEmbedding(f.embedding);
      goodFaces.push({ embedding: emb, weight: w });
    } catch {
      // 跳过解码失败的脸
    }
  }

  const maxPerPerson = config.face.prototypeMaxPerPerson;
  const maxIters = config.face.prototypeKmeansMaxIters;

  if (goodFaces.length === 0) {
    // fallback：用 centroid 作为唯一原型
    try {
      const centroidEmb = decodeEmbedding(personRow.centroidEmbedding);
      await db.insert(schema.personPrototypes).values({
        id: crypto.randomUUID(),
        personId,
        embedding: encodeEmbedding(centroidEmb),
        weightSum: personRow.memberCount,
        memberCount: personRow.memberCount,
        label: null,
        createdAt: now,
        updatedAt: now,
      });
      return { status: "ok", personId };
    } catch (err) {
      return {
        status: "failed",
        personId,
        reason: `fallback 原型写入失败: ${(err as Error).message}`,
      };
    }
  }

  // k = clamp(round(memberCount / 40), 1, maxPerPerson)
  const k = Math.max(1, Math.min(maxPerPerson, Math.round(personRow.memberCount / 40)));

  const embeddings = goodFaces.map((f) => f.embedding);
  const weights = goodFaces.map((f) => f.weight);

  let clusters: Array<{ centroid: Float32Array; weightSum: number; memberCount: number }>;
  try {
    clusters = miniBatchKmeansCosine(embeddings, weights, k, maxIters);
  } catch (err) {
    return { status: "failed", personId, reason: `k-means 失败: ${(err as Error).message}` };
  }

  // INSERT 每个 cluster 为一行 person_prototypes
  try {
    for (const cluster of clusters) {
      await db.insert(schema.personPrototypes).values({
        id: crypto.randomUUID(),
        personId,
        embedding: encodeEmbedding(cluster.centroid),
        weightSum: cluster.weightSum,
        memberCount: cluster.memberCount,
        label: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch (err) {
    return { status: "failed", personId, reason: `原型写入失败: ${(err as Error).message}` };
  }

  return { status: "ok", personId };
}

async function main() {
  console.log(`[backfill-prototypes] 模式: ${isForce ? "--force（重建所有原型）" : "仅回填缺失"}`);

  // 获取所有 person
  const allPersons = await db
    .select({
      id: schema.persons.id,
      centroidEmbedding: schema.persons.centroidEmbedding,
      memberCount: schema.persons.memberCount,
    })
    .from(schema.persons);

  let targetPersons: typeof allPersons;

  if (isForce) {
    targetPersons = allPersons;
  } else {
    // 只处理 person_prototypes 表中没行的 person
    const personIdsWithProtos = await db
      .selectDistinct({ personId: schema.personPrototypes.personId })
      .from(schema.personPrototypes);

    const withProtoSet = new Set(personIdsWithProtos.map((r) => r.personId));
    targetPersons = allPersons.filter((p) => !withProtoSet.has(p.id));
  }

  console.log(`[backfill-prototypes] 待处理: ${targetPersons.length} 个 person`);
  if (targetPersons.length === 0) {
    console.log("[backfill-prototypes] 没有需要处理的人物，退出");
    return;
  }

  const limit = pLimit(CONCURRENCY);
  const startedAt = Date.now();
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let done = 0;

  const tasks = targetPersons.map((personRow) =>
    limit(async () => {
      const r = await processPerson(personRow);
      done++;
      if (r.status === "ok") ok++;
      else if (r.status === "skipped") skipped++;
      else {
        failed++;
        console.warn(`[backfill-prototypes] FAIL ${r.personId.slice(0, 8)}: ${r.reason}`);
      }
      if (done % 50 === 0 || done === targetPersons.length) {
        const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(
          `[backfill-prototypes] 进度 ${done}/${targetPersons.length} | ok=${ok} skip=${skipped} fail=${failed} | ${sec}s`,
        );
      }
    }),
  );

  await Promise.all(tasks);

  console.log("\n[backfill-prototypes] ====== 回填完成 ======");
  console.log(`成功 ok=${ok}，跳过 skip=${skipped}，失败 fail=${failed}`);
  console.log(`耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-prototypes] 致命错误:", err);
    process.exit(1);
  });

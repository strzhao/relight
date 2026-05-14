/**
 * 人物头像批量回填脚本
 *
 * 背景：commit 9751aef 的 Phase 1 离线 recluster-quality.mjs 重建了 1520 个 person，
 * 但只写了 centroidEmbedding + memberCount + person_id，没设 representative_face_id
 * 也没生成 avatar_path。导致 /api/persons/:id/avatar.jpg 全部 404，UI 头像变「?」灰圆。
 *
 * 本脚本复用 detect-faces.ts 的 maybeUpdateRepresentativeAndAvatar 核心逻辑：
 *   - 对每个 person 内所有 face，按 cosine sim 离 centroid 最近的选为代表
 *   - 读代表 face 所在 photo（含 HEIC 解码 + EXIF rotate）
 *   - sharp crop bbox + resize 256 落盘到 .persons/avatars/auto/{personId}.jpg
 *   - UPDATE persons SET representative_face_id + avatar_path
 *
 * 用法：
 *   pnpm --filter @relight/backend tsx src/cli/backfill-person-avatars.ts
 *   pnpm --filter @relight/backend tsx src/cli/backfill-person-avatars.ts --force
 *
 * 幂等：
 *   - 默认仅处理 avatar_path 和 custom_avatar_path 都为 NULL 的 person
 *   - --force 时重算所有非 manualOverride 的 person（保留 customAvatar）
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import pLimit from "p-limit";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { generateAutoAvatar } from "../lib/face/avatar";
import { decodeEmbedding } from "../lib/face/embedding-codec";
import { createStorageAdapter } from "../storage";

const backendRoot = (() => {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath && path.isAbsolute(dbPath)) {
    return path.resolve(dbPath, "../../");
  }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "../../");
})();
process.chdir(backendRoot);
console.log(`[backfill-avatars] 工作目录: ${backendRoot}`);

const isForce = process.argv.includes("--force");
const CONCURRENCY = 4;

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
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

interface ProcessResult {
  status: "ok" | "skipped" | "failed";
  personId: string;
  reason?: string;
}

async function processPerson(personId: string): Promise<ProcessResult> {
  const personRows = await db.select().from(schema.persons).where(eq(schema.persons.id, personId));
  const person = personRows[0];
  if (!person) return { status: "skipped", personId, reason: "person 不存在" };

  if (!isForce && (person.avatarPath || person.customAvatarPath)) {
    return { status: "skipped", personId, reason: "已有头像" };
  }
  if (isForce && person.manualOverride) {
    return { status: "skipped", personId, reason: "manualOverride=true" };
  }

  // 1. 找 person 内所有 face
  const faces = await db.select().from(schema.faces).where(eq(schema.faces.personId, personId));
  if (faces.length === 0) return { status: "skipped", personId, reason: "无 face" };

  // 2. 解 centroid，按 cosine sim 选最佳代表
  let centroid: Float32Array;
  try {
    centroid = decodeEmbedding(person.centroidEmbedding);
  } catch (err) {
    return { status: "failed", personId, reason: `centroid 解码失败: ${(err as Error).message}` };
  }

  let bestFace = faces[0];
  let bestSim = Number.NEGATIVE_INFINITY;
  for (const f of faces) {
    try {
      const emb = decodeEmbedding(f.embedding);
      const sim = cosineSim(emb, centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestFace = f;
      }
    } catch {
      // 单脸 embedding 解码失败跳过
    }
  }
  if (!bestFace) return { status: "failed", personId, reason: "未能选出代表 face" };

  // 3. 拉代表 face 的 photo + storageSource
  const photoRows = await db
    .select()
    .from(schema.photos)
    .where(eq(schema.photos.id, bestFace.photoId));
  const photo = photoRows[0];
  if (!photo) return { status: "failed", personId, reason: "代表 photo 不存在" };

  const srcRows = await db
    .select()
    .from(schema.storageSources)
    .where(eq(schema.storageSources.id, photo.storageSourceId));
  const src = srcRows[0];
  if (!src) return { status: "failed", personId, reason: "storageSource 不存在" };

  // 4. 读 buffer，HEIC 解码 + EXIF rotate
  const adapter = createStorageAdapter(src.type);
  let buffer: Buffer;
  try {
    buffer = await adapter.getFileBuffer(photo.filePath);
  } catch (err) {
    return { status: "failed", personId, reason: `读图失败: ${(err as Error).message}` };
  }

  const { isHeicFile, isHeicBuffer, convertHeicToJpeg } = await import("../lib/heic");
  if (isHeicFile(photo.filePath) || isHeicBuffer(buffer)) {
    try {
      buffer = await convertHeicToJpeg(buffer);
    } catch (err) {
      return { status: "failed", personId, reason: `HEIC 解码失败: ${(err as Error).message}` };
    }
  }

  const sharpMod = await import("sharp");
  try {
    buffer = await sharpMod.default(buffer, { failOn: "none" }).rotate().toBuffer();
  } catch (err) {
    return { status: "failed", personId, reason: `EXIF rotate 失败: ${(err as Error).message}` };
  }
  const meta = await sharpMod.default(buffer).metadata();
  if (!meta.width || !meta.height) {
    return { status: "failed", personId, reason: "metadata 缺 width/height" };
  }

  // 5. 生成头像
  let avatarRel: string;
  try {
    const abs = await generateAutoAvatar(
      buffer,
      { x: bestFace.bboxX, y: bestFace.bboxY, w: bestFace.bboxW, h: bestFace.bboxH },
      meta.width,
      meta.height,
      personId,
    );
    avatarRel = path.relative(config.storageRoot, abs);
  } catch (err) {
    return { status: "failed", personId, reason: `生成头像失败: ${(err as Error).message}` };
  }

  // 6. UPDATE persons
  await db
    .update(schema.persons)
    .set({
      representativeFaceId: bestFace.id,
      avatarPath: avatarRel,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.persons.id, personId));

  return { status: "ok", personId };
}

async function main() {
  console.log(
    `[backfill-avatars] 模式: ${isForce ? "--force（重算所有非 manualOverride）" : "仅回填缺失"}`,
  );

  const whereClause = isForce
    ? eq(schema.persons.manualOverride, false)
    : and(isNull(schema.persons.avatarPath), isNull(schema.persons.customAvatarPath));

  const personIds = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(whereClause);

  console.log(`[backfill-avatars] 待处理: ${personIds.length} 个 person`);
  if (personIds.length === 0) {
    console.log("[backfill-avatars] 没有需要处理的人物，退出");
    return;
  }

  const limit = pLimit(CONCURRENCY);
  const startedAt = Date.now();
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let done = 0;

  const tasks = personIds.map((row) =>
    limit(async () => {
      const r = await processPerson(row.id);
      done++;
      if (r.status === "ok") ok++;
      else if (r.status === "skipped") skipped++;
      else {
        failed++;
        console.warn(`[backfill-avatars] FAIL ${r.personId.slice(0, 8)}: ${r.reason}`);
      }
      if (done % 50 === 0 || done === personIds.length) {
        const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(
          `[backfill-avatars] 进度 ${done}/${personIds.length} | ok=${ok} skip=${skipped} fail=${failed} | ${sec}s`,
        );
      }
    }),
  );
  await Promise.all(tasks);

  console.log("\n[backfill-avatars] ====== 回填完成 ======");
  console.log(`成功 ok=${ok}，跳过 skip=${skipped}，失败 fail=${failed}`);
  console.log(`耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-avatars] 致命错误:", err);
    process.exit(1);
  });

/**
 * rerun-faces.mjs — 清空并重跑人脸识别流水线（方案 C 验收用）
 *
 * 参数：
 *   --limit N    只选最早 N 张照片（按 taken_at ASC），默认全量
 *   --clear      清空 persons/faces 表 + 备份名字/昵称到 JSON
 *
 * 用法：
 *   cd apps/backend && node scripts/rerun-faces.mjs --limit 500 --clear
 *   cd apps/backend && node scripts/rerun-faces.mjs --clear
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Queue } from "bullmq";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
rerun-faces.mjs — 清空并重跑人脸识别流水线（方案 C 验收用）

参数：
  --limit N    只选最早 N 张照片（按 taken_at ASC），默认全量
  --clear      清空 persons/faces 表 + 备份名字/昵称到 JSON
  --yes        全量重跑（无 --limit）必须显式确认，防止误触发
  --help, -h   显示本帮助

用法：
  node scripts/rerun-faces.mjs --limit 500 --clear      # 500 张验证
  node scripts/rerun-faces.mjs --clear --yes            # 全量重跑（需 --yes）
`);
  process.exit(0);
}

const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1], 10) : null;
const shouldClear = args.includes("--clear");
const fullRunConfirmed = args.includes("--yes");

if (limit === null && !fullRunConfirmed) {
  console.error(
    "[rerun-faces] ❌ 全量重跑需 --yes 显式确认（防止误触发）。用 --limit N 跑部分，或 --yes 跑全量。",
  );
  process.exit(1);
}

const dbPath = process.env.DATABASE_PATH ?? "./data/relight.db";
const storageRoot = process.env.STORAGE_ROOT ?? "./photos";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const bullmqPrefix = process.env.BULLMQ_PREFIX ?? "bull";

console.log(`[rerun-faces] 配置: dbPath=${dbPath} limit=${limit ?? "全量"} clear=${shouldClear}`);

const db = new Database(dbPath);

if (shouldClear) {
  // 备份 persons 名字/昵称（即便用户接受丢失，留个 trace）
  const backupDir = join(storageRoot, ".backup");
  mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = join(backupDir, `persons-${timestamp}.json`);

  const namedPersons = db
    .prepare(
      "SELECT id, name, nickname FROM persons WHERE name IS NOT NULL OR nickname IS NOT NULL",
    )
    .all();

  writeFileSync(backupPath, JSON.stringify(namedPersons, null, 2), "utf8");
  console.log(`[rerun-faces] 备份 ${namedPersons.length} 条命名 person → ${backupPath}`);

  // 清空 faces + persons
  db.prepare("DELETE FROM faces").run();
  db.prepare("DELETE FROM persons").run();
  console.log("[rerun-faces] 已清空 faces + persons 表");

  // 删除头像文件（photos/avatars/ 目录，如果存在）
  const avatarDir = join(storageRoot, "avatars");
  try {
    const files = await readdir(avatarDir);
    let removedCount = 0;
    for (const f of files) {
      try {
        await unlink(join(avatarDir, f));
        removedCount++;
      } catch {
        // 忽略单文件删除失败
      }
    }
    console.log(`[rerun-faces] 已删除 ${removedCount} 个头像文件（${avatarDir}）`);
  } catch {
    console.log(`[rerun-faces] avatarDir ${avatarDir} 不存在或无头像，跳过`);
  }
}

// 选取照片（按 taken_at ASC 排序，确保 500 张验证集时间跨度均匀）
let photoRows;
if (limit !== null && !Number.isNaN(limit) && limit > 0) {
  photoRows = db
    .prepare("SELECT id FROM photos WHERE media_type = 'image' ORDER BY taken_at ASC LIMIT ?")
    .all(limit);
} else {
  photoRows = db
    .prepare("SELECT id FROM photos WHERE media_type = 'image' ORDER BY taken_at ASC")
    .all();
}

console.log(`[rerun-faces] 共 ${photoRows.length} 张照片待入队`);

if (photoRows.length === 0) {
  console.log("[rerun-faces] 无照片，退出");
  db.close();
  process.exit(0);
}

// 入队（BullMQ）
const detectFacesQueue = new Queue("detect-faces", {
  connection: { url: redisUrl },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  },
  prefix: bullmqPrefix,
});

let queued = 0;
let skipped = 0;
const batchSize = 100;

for (let i = 0; i < photoRows.length; i++) {
  const row = photoRows[i];
  try {
    await detectFacesQueue.add(row.id, { photoId: row.id }, { jobId: row.id });
    queued++;
  } catch (err) {
    console.warn(`[rerun-faces] 入队失败 photoId=${row.id}: ${err.message}`);
    skipped++;
  }

  if ((i + 1) % batchSize === 0) {
    console.log(
      `[rerun-faces] 已入队 ${i + 1}/${photoRows.length}（成功 ${queued} / 跳过 ${skipped}）`,
    );
  }
}

console.log(`[rerun-faces] 完成！总计 ${photoRows.length} 张 → 入队 ${queued} / 跳过 ${skipped}`);
console.log("[rerun-faces] 提示：worker 进程须在运行中，可通过 pnpm dev 或 pm2 start 启动");

await detectFacesQueue.close();
db.close();

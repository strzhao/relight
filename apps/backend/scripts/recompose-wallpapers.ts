/**
 * 一次性运维脚本：重合成并补传画廊缺失的壁纸对象（2026-08-30 QA auto-fix 场景 12.P2）
 *
 * 背景：manifest 按约定 key 无条件拼壁纸 URL，但 39 个历史日（05-08~06-17 + 06-26）竖版本地
 * 从未合成、07-31 横版本地丢失 → COS 404 死链。本脚本拉线上 manifest → HEAD 找 404 →
 * 从 DB（dailyPicks + entries[0] + photos）确定性重合成（与 daily-selection 阶段 3 同参数）
 * → uploadFile 传 COS → 复核 200。幂等：已 200 的不碰。
 */
import { asc, eq } from "drizzle-orm";
import { db, schema } from "/Users/stringzhao/workspace/relight/apps/backend/src/db/index.ts";
import { config } from "/Users/stringzhao/workspace/relight/apps/backend/src/lib/config.ts";
import { uploadFile } from "/Users/stringzhao/workspace/relight/apps/backend/src/lib/cos/upload.ts";
import {
  wallpaperLandscapeCosKey,
  wallpaperPortraitCosKey,
} from "/Users/stringzhao/workspace/relight/apps/backend/src/lib/gallery/manifest.ts";
import { composeAndSave } from "/Users/stringzhao/workspace/relight/apps/backend/src/lib/wallpaper/composer.ts";

const MANIFEST_URL = "https://gallery.stringzhao.life/manifest.json";

interface Target {
  date: string;
  kind: "portrait" | "landscape";
}

async function collectTargets(): Promise<Target[]> {
  const m = (await (await fetch(MANIFEST_URL)).json()) as {
    days?: { pickDate: string; wallpaperPortrait: string; wallpaperLandscape: string }[];
  };
  const targets: Target[] = [];
  let idx = 0;
  const items: { date: string; kind: "portrait" | "landscape"; url: string }[] = [];
  for (const d of m.days ?? []) {
    if (d.wallpaperPortrait)
      items.push({ date: d.pickDate, kind: "portrait", url: d.wallpaperPortrait });
    if (d.wallpaperLandscape)
      items.push({ date: d.pickDate, kind: "landscape", url: d.wallpaperLandscape });
  }
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (idx < items.length) {
        const it = items[idx++];
        try {
          const r = await fetch(it.url, { method: "HEAD", signal: AbortSignal.timeout(10000) });
          if (r.status !== 200) targets.push({ date: it.date, kind: it.kind });
        } catch {
          targets.push({ date: it.date, kind: it.kind });
        }
      }
    }),
  );
  return targets.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

async function recomputeOne(t: Target): Promise<"ok" | string> {
  // 1. 当日 pick + entries[0]（title/narrative/members）+ hero photo —— 与 daily-selection 阶段 3 同构
  const pickRows = await db
    .select()
    .from(schema.dailyPicks)
    .where(eq(schema.dailyPicks.pickDate, t.date))
    .limit(1);
  const pickRow = pickRows[0];
  if (!pickRow) return `dailyPicks ${t.date} 不存在`;

  const entryRows = await db
    .select()
    .from(schema.dailyPickEntries)
    .where(eq(schema.dailyPickEntries.dailyPickId, pickRow.id))
    .orderBy(asc(schema.dailyPickEntries.rank))
    .limit(1);
  const primary = entryRows[0];
  // legacy 回退：多次条目系统上线前的历史日（如 2026-05-08）无 entries，
  // hero/members 直接取 dailyPicks 主记录（entries[0] 同步写主记录的旧契约）
  const heroPhotoId = primary?.photoId ?? pickRow.photoId;
  const members = primary?.members ?? pickRow.members ?? [];

  const photoRows = await db
    .select()
    .from(schema.photos)
    .where(eq(schema.photos.id, heroPhotoId))
    .limit(1);
  const heroPhoto = photoRows[0];
  if (!heroPhoto) return `hero photoId=${heroPhotoId} 不在 photos 表`;

  // 2. 合成（portrait 默认 cacheKey=1290x2796；landscape cacheKey=default，5120×2880）
  const pick = { ...pickRow, composedImageUrl: null, members };
  const localPath =
    t.kind === "portrait"
      ? await composeAndSave({ pick, photo: heroPhoto, width: 1290, height: 2796 })
      : await composeAndSave({
          pick,
          photo: heroPhoto,
          width: 5120,
          height: 2880,
          cacheKey: "default",
        });

  // 3. 上传（uploadFile 容错契约：失败返回空串不 throw）
  const cosKey =
    t.kind === "portrait" ? wallpaperPortraitCosKey(t.date) : wallpaperLandscapeCosKey(t.date);
  const uploaded = await uploadFile(localPath, cosKey, "image/jpeg");
  if (!uploaded) return `uploadFile 返回空串（${cosKey}）`;
  return "ok";
}

async function main() {
  console.log("=".repeat(72));
  console.log("  壁纸重合成补传（一次性运维，幂等）");
  console.log(`  COS: ${config.cos.bucket} / ${config.cos.region}`);
  console.log("=".repeat(72));

  const targets = await collectTargets();
  console.log(
    `\n缺失目标: ${targets.length} 个（portrait=${targets.filter((t) => t.kind === "portrait").length}, landscape=${targets.filter((t) => t.kind === "landscape").length}）`,
  );

  const results: { t: Target; status: string }[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t) continue;
    const start = Date.now();
    try {
      const status = await recomputeOne(t);
      results.push({ t, status });
      const mark = status === "ok" ? "✅" : "⚠️";
      console.log(
        `  [${i + 1}/${targets.length}] ${t.date} ${t.kind} ${mark} ${status} (${((Date.now() - start) / 1000).toFixed(1)}s)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ t, status: `throw: ${msg}` });
      console.log(`  [${i + 1}/${targets.length}] ${t.date} ${t.kind} ❌ ${msg}`);
    }
  }

  // 复核：全部目标重新 HEAD
  console.log("\n复核 HEAD:");
  let stillBad = 0;
  for (const r of results) {
    const url =
      r.t.kind === "portrait"
        ? `https://${config.cos.bucket}.cos.${config.cos.region}.myqcloud.com/${wallpaperPortraitCosKey(r.t.date)}`
        : `https://${config.cos.bucket}.cos.${config.cos.region}.myqcloud.com/${wallpaperLandscapeCosKey(r.t.date)}`;
    try {
      const resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10000) });
      if (resp.status !== 200) {
        stillBad++;
        console.log(`  ❌ ${r.t.date} ${r.t.kind} → ${resp.status}`);
      }
    } catch (e) {
      stillBad++;
      console.log(`  ❌ ${r.t.date} ${r.t.kind} → ${(e as Error).message}`);
    }
  }
  const ok = results.filter((r) => r.status === "ok").length;
  console.log(`\n结果: 合成上传成功 ${ok}/${results.length}，复核仍 404: ${stillBad}`);
  const failed = results.filter((r) => r.status !== "ok");
  if (failed.length) {
    console.log("失败清单:");
    for (const f of failed) console.log(`  - ${f.t.date} ${f.t.kind}: ${f.status}`);
  }
  process.exit(stillBad > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});

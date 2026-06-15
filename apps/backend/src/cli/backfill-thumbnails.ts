import path from "node:path";
import { type SQL, and, eq, isNull, like, not } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { generateThumbnail } from "../lib/thumbnail";

/** 缩略图并发生成批大小（与 scan-storage 一致） */
const THUMBNAIL_CONCURRENCY = 4;

export interface BackfillOptions {
  /** 仅列出待补救照片，不生成缩略图、不写 DB */
  dryRun?: boolean;
  /** 限量处理的照片数（默认全部） */
  limit?: number;
  /** 按媒体类型过滤：image | video（默认全部） */
  mediaType?: "image" | "video";
}

export interface BackfillSampleItem {
  id: string;
  filePath: string;
  outputPath: string | null;
  ok: boolean;
}

export interface BackfillStats {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

export interface BackfillResult {
  ok: boolean;
  dryRun: boolean;
  stats: BackfillStats;
  sample: BackfillSampleItem[];
}

/**
 * 缩略图补救核心逻辑（可测纯函数）。
 *
 * 查询 thumbnail_path IS NULL 且非 /tmp 测试文件的照片，逐张生成缩略图并 UPDATE。
 * 失败不中断，记录到 stats.failed。幂等：WHERE thumbnail_path IS NULL。
 *
 * @returns BackfillResult — stats 含 total/success/failed/skipped，sample 取前若干条
 */
export async function backfillThumbnails(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const { dryRun = false, limit, mediaType } = opts;

  // 构建查询条件：thumbnail_path IS NULL + 非 /tmp 测试文件 + 可选 mediaType
  const conditions: SQL[] = [
    isNull(schema.photos.thumbnailPath),
    not(like(schema.photos.filePath, "/tmp/%")),
  ];
  if (mediaType) {
    conditions.push(eq(schema.photos.mediaType, mediaType));
  }

  const photos = await db
    .select({
      id: schema.photos.id,
      filePath: schema.photos.filePath,
      mediaType: schema.photos.mediaType,
    })
    .from(schema.photos)
    .where(and(...conditions));

  const limited = limit && limit > 0 ? photos.slice(0, limit) : photos;

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      stats: { total: photos.length, success: 0, failed: 0, skipped: limited.length },
      sample: limited.slice(0, 10).map((p) => ({
        id: p.id,
        filePath: p.filePath,
        outputPath: null,
        ok: false,
      })),
    };
  }

  const thumbnailDir = path.join(config.storageRoot, "thumbnails");
  let success = 0;
  let failed = 0;
  const sample: BackfillSampleItem[] = [];
  const sampleMax = 10;

  // 分批并发（THUMBNAIL_CONCURRENCY=4），与 scan-storage 模式一致
  for (let i = 0; i < limited.length; i += THUMBNAIL_CONCURRENCY) {
    const batch = limited.slice(i, i + THUMBNAIL_CONCURRENCY);

    const results = await Promise.all(
      batch.map(async (photo) => {
        try {
          const thumbnailPath = await generateThumbnail(photo.filePath, thumbnailDir, photo.id);
          await db
            .update(schema.photos)
            .set({ thumbnailPath })
            .where(eq(schema.photos.id, photo.id));
          return { photo, thumbnailPath, ok: true };
        } catch (err) {
          return {
            photo,
            thumbnailPath: null,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    for (const r of results) {
      if (r.ok) {
        success++;
      } else {
        failed++;
      }
      // 收集前 sampleMax 条作为样本（含成功与失败）
      if (sample.length < sampleMax) {
        sample.push({
          id: r.photo.id,
          filePath: r.photo.filePath,
          outputPath: r.thumbnailPath,
          ok: r.ok,
        });
      }
      // stdout 逐条进度
      const status = r.ok ? "✅" : "❌";
      const basename = path.basename(r.photo.filePath);
      const detail = r.ok ? "" : `: ${(r as { error?: string }).error ?? ""}`;
      console.log(`  ${status} ${basename}${detail}`);
    }
  }

  // stats.total = 待补救总数（不受 limit 影响）；skipped = 因 limit 未处理的数
  const total = photos.length;
  const skipped = photos.length - limited.length;
  return {
    ok: failed === 0,
    dryRun: false,
    stats: { total, success, failed, skipped },
    sample,
  };
}

/** 根据结果决定退出码：0 全成功 / 1 无待补救(total=0) / 2 部分失败 */
function exitCodeFor(result: BackfillResult): number {
  if (result.dryRun) {
    return result.stats.total > 0 ? 0 : 1;
  }
  if (result.stats.total === 0) return 1;
  if (result.stats.failed > 0) return 2;
  return 0;
}

/**
 * 缩略图补救 CLI
 *
 * 用法:
 *   npx tsx src/cli/backfill-thumbnails.ts                       # 全量补救
 *   npx tsx src/cli/backfill-thumbnails.ts --dry-run             # 只列出待补救
 *   npx tsx src/cli/backfill-thumbnails.ts --limit 5             # 限量
 *   npx tsx src/cli/backfill-thumbnails.ts --media-type image    # 仅图片
 *   npx tsx src/cli/backfill-thumbnails.ts --media-type video    # 仅视频
 *
 * 退出码: 0 全成功 / 1 无待补救(total=0) / 2 部分失败
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 简单参数解析（无需 commander，保持 CLI 轻量）
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;
  const mediaIdx = args.indexOf("--media-type");
  const mediaArg = mediaIdx >= 0 ? args[mediaIdx + 1] : undefined;
  const mediaType = mediaArg === "image" || mediaArg === "video" ? mediaArg : undefined;

  if (limit !== undefined && (Number.isNaN(limit) || limit <= 0)) {
    console.error("--limit 必须是正整数");
    process.exit(2);
  }
  if (mediaIdx >= 0 && !mediaType) {
    console.error("--media-type 必须是 image 或 video");
    process.exit(2);
  }

  console.log("=".repeat(50));
  console.log("  缩略图补救工具 (backfill-thumbnails)");
  console.log(
    `  模式: ${dryRun ? "dry-run (仅列出)" : "执行"}${limit ? ` | limit=${limit}` : ""}${mediaType ? ` | mediaType=${mediaType}` : ""}`,
  );
  console.log("=".repeat(50));

  const result = await backfillThumbnails({ dryRun, limit, mediaType });

  const { stats, dryRun: isDryRun } = result;
  console.log(`\n${"=".repeat(50)}`);
  if (isDryRun) {
    console.log(`  dry-run: 共 ${stats.total} 张待补救`);
  } else {
    const processed = stats.success + stats.failed;
    const skipNote = stats.skipped > 0 ? ` (跳过 ${stats.skipped})` : "";
    console.log(
      `  完成: 待补救 ${stats.total}, 处理 ${processed}${skipNote}, 成功 ${stats.success}, 失败 ${stats.failed}`,
    );
  }
  console.log("=".repeat(50));

  // 结尾输出 JSON（机器可读契约）
  console.log(JSON.stringify(result));

  process.exit(exitCodeFor(result));
}

export default main;

// 仅在直接运行时执行 main()，import 时不触发（防止测试/复用纯函数时误执行）
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("backfill-thumbnails.ts") ||
    process.argv[1].endsWith("backfill-thumbnails.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("补救失败:", err);
    process.exit(2);
  });
}

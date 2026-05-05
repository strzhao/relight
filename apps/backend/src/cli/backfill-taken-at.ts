import Database from "better-sqlite3";
import { config } from "../lib/config";

/**
 * 回填历史照片的 taken_at 字段
 *
 * 背景：6140 张照片中约 5736 张（93.4%）因增量扫描跳过已存在照片而遗留了 NULL taken_at。
 * storage/local.ts 已有 EXIF 失败 → fs.stat mtime 的 fallback，但历史数据未受益。
 *
 * 修复：一次性 SQL UPDATE，用 file_mtime 填充 taken_at（精度秒，不影响索引）。
 * 幂等性：WHERE taken_at IS NULL AND file_mtime IS NOT NULL，重复执行影响行数 = 0。
 *
 * @param db - better-sqlite3 数据库实例（支持参数注入，便于测试）
 * @returns { changedCount: number } 影响行数
 */
export function backfillTakenAt(db: Database.Database): { changedCount: number } {
  const result = db
    .prepare(
      `
    UPDATE photos
    SET taken_at = datetime(file_mtime, 'unixepoch')
    WHERE taken_at IS NULL AND file_mtime IS NOT NULL
  `,
    )
    .run();

  return { changedCount: result.changes };
}

/**
 * CLI 入口
 *
 * 用法: npx tsx src/cli/backfill-taken-at.ts
 */
async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  taken_at 历史数据回填工具");
  console.log("=".repeat(60));

  const sqlite = new Database(config.databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  try {
    // 执行前统计
    const beforeRow = sqlite
      .prepare("SELECT COUNT(*) as count FROM photos WHERE taken_at IS NULL")
      .get() as { count: number };
    const beforeCount = beforeRow.count;

    const totalRow = sqlite.prepare("SELECT COUNT(*) as count FROM photos").get() as {
      count: number;
    };
    const totalCount = totalRow.count;

    console.log(`\n总照片数: ${totalCount}`);
    console.log(`执行前 taken_at 为 NULL: ${beforeCount} 张`);

    if (beforeCount === 0) {
      console.log("\n没有需要回填的照片，幂等检查通过。");
      console.log("=".repeat(60));
      return;
    }

    // 抽样修复前的数据（最多 3 条）
    const samples = sqlite
      .prepare(
        `
      SELECT id, file_path, file_mtime, taken_at
      FROM photos
      WHERE taken_at IS NULL AND file_mtime IS NOT NULL
      LIMIT 3
    `,
      )
      .all() as Array<{
      id: string;
      file_path: string;
      file_mtime: number;
      taken_at: string | null;
    }>;

    if (samples.length > 0) {
      console.log("\n抽样（修复前）:");
      for (const s of samples) {
        const fileName = s.file_path.split("/").pop() ?? s.id;
        console.log(`  ${fileName}: takenAt=NULL, fileMtime=${s.file_mtime}`);
      }
    }

    // 执行回填（使用导出函数）
    console.log("\n执行回填 SQL...");
    const { changedCount } = backfillTakenAt(sqlite);

    console.log(`影响行数: ${changedCount}`);

    // 执行后统计
    const afterRow = sqlite
      .prepare("SELECT COUNT(*) as count FROM photos WHERE taken_at IS NULL")
      .get() as { count: number };
    const afterCount = afterRow.count;

    console.log(`执行后 taken_at 为 NULL: ${afterCount} 张`);

    // 抽样修复后的数据
    if (samples.length > 0) {
      const ids = samples.map((s) => s.id);
      const placeholders = ids.map(() => "?").join(", ");
      const afterSamples = sqlite
        .prepare(`SELECT id, file_path, taken_at FROM photos WHERE id IN (${placeholders})`)
        .all(...ids) as Array<{ id: string; file_path: string; taken_at: string | null }>;

      if (afterSamples.length > 0) {
        console.log("\n抽样（修复后）:");
        for (const s of afterSamples) {
          const fileName = s.file_path.split("/").pop() ?? s.id;
          console.log(`  ${fileName}: takenAt=${s.taken_at}`);
        }
      }
    }

    console.log(`\n${"=".repeat(60)}`);
    if (afterCount === 0) {
      console.log(`  回填完成: ${changedCount} 张照片已填充 taken_at ✅`);
    } else {
      console.log(
        `  回填完成: ${changedCount} 张已填充，仍有 ${afterCount} 张无 file_mtime（无法回填）`,
      );
    }
    console.log("=".repeat(60));
  } finally {
    sqlite.close();
  }
}

// 仅在直接运行时执行 main()，import 时不触发（防止测试环境误执行）
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("backfill-taken-at.ts") ||
    process.argv[1].endsWith("backfill-taken-at.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("回填失败:", err);
    process.exit(1);
  });
}

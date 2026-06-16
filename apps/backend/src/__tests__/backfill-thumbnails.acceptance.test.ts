/**
 * 验收测试（红队）：补救缺失缩略图 CLI (backfill-thumbnails.ts)
 *
 * 设计文档契约（逐字一致）：
 *   - stdout 结尾输出 JSON `{ ok, stats:{total,success,failed,skipped}, sample[] }`
 *   - exit code: 0=全成功 / 1=无待补救(total=0) / 2=部分失败
 *   - 参数：--dry-run（只列出，不生成/不写DB）、--limit N、--media-type image|video
 *   - 幂等：WHERE thumbnail_path IS NULL AND file_path NOT LIKE '/tmp/%'
 *   - 复用 lib/thumbnail.ts 的 generateThumbnail
 *   - thumbnailDir = path.join(config.storageRoot, "thumbnails")
 *
 * 覆盖验收点：
 *   1. CLI 输出契约（--dry-run JSON 结构、dry-run 不生成文件）
 *   2. 退出码契约（0/1/2）
 *   3. --limit 契约
 *   4. --media-type 过滤
 *   5. 幂等契约（跑两次后 total=0）
 *
 * 红队铁律：本文件仅依据设计文档编写，不读蓝队实现代码。
 *   - 未读 apps/backend/src/cli/backfill-thumbnails.ts
 *   - 通过 spawnSync 跑 tsx，黑盒验证 stdout/exit code/副作用（缩略图文件 + DB 写入）
 *
 * 隔离策略：每个测试用例用独立的临时目录（os.tmpdir + unique subdir），
 *   通过 env 注入 DATABASE_PATH + STORAGE_ROOT，完全不触碰真实 data/relight.db。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// 常量
// ============================================================================

/** backend 工程根 = apps/backend（node --import tsx 的 cwd + CLI 源文件定位） */
const BACKEND_ROOT = path.resolve(__dirname, "../..");
/** 被测 CLI 源文件 */
const CLI_PATH = path.join(BACKEND_ROOT, "src/cli/backfill-thumbnails.ts");

// ============================================================================
// 临时环境工厂 — 每个测试套件独立隔离
// ============================================================================

interface TestEnv {
  /** 临时根目录（含 db + storage） */
  tmpRoot: string;
  /** SQLite 数据库文件路径 */
  dbPath: string;
  /** storageRoot（缩略图落在其下 thumbnails/） */
  storageRoot: string;
  /** thumbnails 目录 */
  thumbnailsDir: string;
  /** 原始图片 fixture 目录（模拟存储源根） */
  photosDir: string;
}

/**
 * 创建一个完全隔离的测试环境。
 * 目录布局：
 *   <tmpRoot>/
 *     test.db               ← SQLite 文件（隔离，不污染真实 data/relight.db）
 *     storage/
 *       thumbnails/         ← 缩略图输出目录（config.storageRoot/thumbnails）
 *       photos/             ← 原始图片 fixture
 */
function createTestEnv(prefix: string): TestEnv {
  // 避开 /tmp：被测 CLI 查询排除 /tmp/% 路径照片（防测试残留污染真实补救），而 CI Linux 的
  // os.tmpdir()=/tmp 会使本测试 fixture 落在 /tmp 下、被自己排除（total=0，全红）。
  // 改用 home 目录（mac /Users/*、CI /home/runner，均非 /tmp，且不在仓库工作树里）。
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), `.relight-test-thumb-${prefix}-`));
  const dbPath = path.join(tmpRoot, "test.db");
  const storageRoot = path.join(tmpRoot, "storage");
  const thumbnailsDir = path.join(storageRoot, "thumbnails");
  const photosDir = path.join(storageRoot, "photos");

  fs.mkdirSync(thumbnailsDir, { recursive: true });
  fs.mkdirSync(photosDir, { recursive: true });

  // 初始化 DB schema + 默认存储源
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES ('src-test', '测试存储源', 'local', ?, 1)`,
    )
    .run(photosDir);
  sqlite.close();

  return { tmpRoot, dbPath, storageRoot, thumbnailsDir, photosDir };
}

/** 递归删除临时目录 */
function cleanupTestEnv(env: TestEnv): void {
  try {
    fs.rmSync(env.tmpRoot, { recursive: true, force: true });
  } catch {
    // 忽略——某些平台文件句柄延迟释放
  }
}

// ============================================================================
// 辅助：生成真实可解码的小尺寸 JPEG fixture（sharp 编码，~1KB）
// ============================================================================

/**
 * 生成一张真实的 JPEG 图片到指定路径。
 * 用于让 generateThumbnail（内部用 sharp）能真正成功处理。
 */
async function makeJpegFixture(
  filePath: string,
  color: { r: number; g: number; b: number },
): Promise<void> {
  // 200x150 小图，纯色 + SVG overlay 让 sharp 有真实内容处理
  const svg = `<svg width="200" height="150" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgb(${color.r},${color.g},${color.b})"/>
    <text x="10" y="80" font-size="40" fill="white">TEST</text>
  </svg>`;
  const buf = Buffer.from(svg);
  await sharp(buf).jpeg({ quality: 80 }).toFile(filePath);
}

// ============================================================================
// 辅助：插入 photos 行（thumbnail_path IS NULL 表示待补救）
// ============================================================================

let _photoSeq = 0;

function insertPhotoRow(
  dbPath: string,
  opts: {
    filePath: string;
    mediaType?: "image" | "video";
    thumbnailPath?: string | null;
  },
): string {
  _photoSeq++;
  const id = `photo-thumb-${process.pid}-${_photoSeq}`;
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO photos (id, storage_source_id, file_path, file_hash, width, height, file_size,
                         thumbnail_path, taken_at, created_at, media_type)
     VALUES (?, 'src-test', ?, ?, 0, 0, 0, ?, NULL, ?, ?)`,
  ).run(
    id,
    opts.filePath,
    `hash-${_photoSeq}-${Math.random().toString(36).slice(2)}`,
    opts.thumbnailPath ?? null,
    new Date().toISOString(),
    opts.mediaType ?? "image",
  );
  db.close();
  return id;
}

/** 读取 photos 表所有行的 thumbnail_path */
function readThumbnailPaths(dbPath: string): Map<string, string | null> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT id, thumbnail_path FROM photos").all() as Array<{
    id: string;
    thumbnail_path: string | null;
  }>;
  db.close();
  return new Map(rows.map((r) => [r.id, r.thumbnail_path]));
}

// ============================================================================
// 辅助：运行被测 CLI（spawnSync tsx）
// ============================================================================

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 从 stdout 末尾解析出的 JSON 对象（解析失败时为 null） */
  json: ParsedCliOutput | null;
}

/** CLI stdout JSON 契约结构 */
interface ParsedCliOutput {
  ok: boolean;
  stats: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
  };
  sample: Array<{
    photoId?: string;
    filePath?: string;
    outputPath?: string;
    error?: string;
    [k: string]: unknown;
  }>;
}

/**
 * 提取 stdout 末尾的 JSON 对象。
 *
 * CLI 在末尾输出一行 JSON（前缀可能有日志/横幅）。
 * 策略：从末尾向前按行扫描，对每个以 `{` 起始的行尝试 JSON.parse，
 *       成功且结构匹配契约即返回。这样能正确处理 JSON 内部嵌套 `{}`。
 */
function extractTrailingJson(stdout: string): ParsedCliOutput | null {
  const lines = stdout.split("\n");
  // 从后向前找第一个能解析为合法契约 JSON 的行
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        parsed &&
        typeof parsed === "object" &&
        "ok" in parsed &&
        "stats" in parsed &&
        "sample" in parsed
      ) {
        return parsed as ParsedCliOutput;
      }
    } catch {
      // 继续向前找
    }
  }
  return null;
}

/** 运行 CLI，注入隔离 env（DATABASE_PATH + STORAGE_ROOT 指向临时目录） */
function runCli(env: TestEnv, args: string[]): CliRunResult {
  const childEnv = {
    ...process.env,
    DATABASE_PATH: env.dbPath,
    STORAGE_ROOT: env.storageRoot,
    // 关闭 AI / 视频处理等无关 side effect
    AI_BASE_URL: "http://127.0.0.1:65535/v1",
    FORCE_COLOR: "0",
  };

  // 用 node 原生 --import tsx loader 跑 CLI（绕过 .bin/tsx shell wrapper）。
  // shell wrapper（#!/bin/sh）在 pnpm symlink 结构下用 $basedir 解析 cli.mjs，
  // Linux CI 的 spawnSync 执行它时 basedir 解析失败 → 子进程崩溃（status null → exit -1）。
  // 改用 process.execPath + --import tsx，node 直接加载 tsx loader 跑 .ts CLI，
  // 无 shell wrapper 依赖，跨平台可靠（mac/Linux 一致）。
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: BACKEND_ROOT,
    encoding: "utf-8",
    timeout: 60_000,
    env: childEnv,
  });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    json: extractTrailingJson(result.stdout ?? ""),
  };
}

// ============================================================================
// 测试套件
// ============================================================================

describe("backfill-thumbnails CLI — 验收测试（红队，黑盒 spawnSync）", () => {
  let env: TestEnv;

  beforeAll(() => {
    _photoSeq = 0;
  });

  // 每个测试用例独立环境，避免互相污染
  beforeEach(() => {
    env = createTestEnv("single");
  });

  afterEach(() => {
    cleanupTestEnv(env);
  });

  // --------------------------------------------------------------------------
  // 验收点 1：CLI 输出契约 + dry-run 不生成文件
  // --------------------------------------------------------------------------

  describe("验收点 1：CLI 输出契约（stdout JSON 结构）", () => {
    it("--dry-run 模式 stdout 结尾含合法 JSON，结构为 {ok, stats:{total,success,failed,skipped}, sample[]}", async () => {
      // 准备：2 张待补救 image
      const f1 = path.join(env.photosDir, "a.jpg");
      const f2 = path.join(env.photosDir, "b.jpg");
      await makeJpegFixture(f1, { r: 200, g: 100, b: 50 });
      await makeJpegFixture(f2, { r: 50, g: 100, b: 200 });
      insertPhotoRow(env.dbPath, { filePath: f1, mediaType: "image" });
      insertPhotoRow(env.dbPath, { filePath: f2, mediaType: "image" });

      const res = runCli(env, ["--dry-run"]);

      // 必须 exit 0（dry-run 是只读探查，不区分有无待补救都应正常返回）
      // 注：设计文档只规定 exit 1=无待补救，dry-run 无待补救也应 exit 1；
      // 但有待补救时 dry-run 不应 exit 2。这里断言非 exit 2。
      expect(res.exitCode, `dry-run 不应 exit 2（部分失败）。stderr: ${res.stderr}`).not.toBe(2);

      // stdout 末尾必须是合法 JSON，且结构正确
      expect(res.json, `stdout 末尾应含合法 JSON。stdout: ${res.stdout}`).not.toBeNull();
      const json = res.json as ParsedCliOutput;

      expect(typeof json.ok).toBe("boolean");
      expect(json.stats).toBeDefined();
      expect(typeof json.stats.total).toBe("number");
      expect(typeof json.stats.success).toBe("number");
      expect(typeof json.stats.failed).toBe("number");
      expect(typeof json.stats.skipped).toBe("number");
      expect(Array.isArray(json.sample)).toBe(true);

      // dry-run 模式下 total 应 = 2（识别到 2 张待补救）
      expect(json.stats.total, "dry-run 应识别到 2 张待补救").toBe(2);
    });

    it("--dry-run 时 success=0 且不生成任何缩略图文件（dry-run 契约）", async () => {
      const f1 = path.join(env.photosDir, "dry.jpg");
      await makeJpegFixture(f1, { r: 120, g: 120, b: 120 });
      insertPhotoRow(env.dbPath, { filePath: f1, mediaType: "image" });

      const filesBefore = fs.existsSync(env.thumbnailsDir)
        ? fs.readdirSync(env.thumbnailsDir).length
        : 0;

      const res = runCli(env, ["--dry-run"]);
      expect(res.json).not.toBeNull();
      const json = res.json as ParsedCliOutput;

      // dry-run 不应实际生成 → success=0
      expect(json.stats.success, "dry-run 模式 success 必须为 0").toBe(0);

      // thumbnails 目录不应新增文件
      const filesAfter = fs.readdirSync(env.thumbnailsDir).length;
      expect(filesAfter, "dry-run 不应在 thumbnails 目录生成文件").toBe(filesBefore);

      // DB 中 thumbnail_path 仍应为 NULL（dry-run 不写 DB）
      const rows = readThumbnailPaths(env.dbPath);
      for (const tp of rows.values()) {
        expect(tp, "dry-run 后 DB 中 thumbnail_path 仍应为 NULL").toBeNull();
      }
    });

    it("非 dry-run（真实补救）输出 JSON 中 sample 数组每项含 outputPath 字段名（契约一致）", async () => {
      const f1 = path.join(env.photosDir, "real.jpg");
      await makeJpegFixture(f1, { r: 80, g: 160, b: 200 });
      insertPhotoRow(env.dbPath, { filePath: f1, mediaType: "image" });

      const res = runCli(env, []);
      expect(res.json).not.toBeNull();
      const json = res.json as ParsedCliOutput;

      // 真实补救成功后 success >= 1
      expect(json.stats.success, "真实补救至少成功 1 张").toBeGreaterThanOrEqual(1);

      // sample 至少 1 项，且每项含 outputPath 字段（跨系统数据流契约）
      expect(json.sample.length, "sample 应至少 1 项").toBeGreaterThanOrEqual(1);
      const sampleItem = json.sample[0] as Record<string, unknown>;
      expect(sampleItem, "sample[].outputPath 字段名必须存在（契约一致）").toHaveProperty(
        "outputPath",
      );
      expect(typeof sampleItem.outputPath).toBe("string");
    });
  });

  // --------------------------------------------------------------------------
  // 验收点 2：退出码契约（0/1/2）
  // --------------------------------------------------------------------------

  describe("验收点 2：退出码契约（0/1/2）", () => {
    it("无待补救（DB 中所有 thumbnail_path 已有值 或 0 行照片）时 exit 1", () => {
      // 空表：0 张照片 → 无待补救
      const res = runCli(env, []);
      expect(res.exitCode, "0 张照片（无待补救）应 exit 1").toBe(1);
      expect(res.json).not.toBeNull();
      expect((res.json as ParsedCliOutput).stats.total).toBe(0);
    });

    it("所有照片 thumbnail_path 均已非 NULL 时 exit 1（无待补救）", async () => {
      const f1 = path.join(env.photosDir, "already.jpg");
      await makeJpegFixture(f1, { r: 10, g: 20, b: 30 });
      // 已有 thumbnail_path，不需要补救
      insertPhotoRow(env.dbPath, {
        filePath: f1,
        mediaType: "image",
        thumbnailPath: "/some/existing/thumb.jpg",
      });

      const res = runCli(env, []);
      expect(res.exitCode, "所有 thumbnail_path 已有值应 exit 1（无待补救）").toBe(1);
      expect((res.json as ParsedCliOutput).stats.total).toBe(0);
    });

    it("有待补救且全部成功时 exit 0", async () => {
      const f1 = path.join(env.photosDir, "ok1.jpg");
      const f2 = path.join(env.photosDir, "ok2.jpg");
      await makeJpegFixture(f1, { r: 200, g: 50, b: 50 });
      await makeJpegFixture(f2, { r: 50, g: 200, b: 50 });
      insertPhotoRow(env.dbPath, { filePath: f1, mediaType: "image" });
      insertPhotoRow(env.dbPath, { filePath: f2, mediaType: "image" });

      const res = runCli(env, []);
      expect(res.exitCode, "有待补救且全成功应 exit 0").toBe(0);
      const json = res.json as ParsedCliOutput;
      expect(json.stats.total).toBe(2);
      expect(json.stats.success).toBe(2);
      expect(json.stats.failed).toBe(0);
    });

    it("部分失败（文件不存在/损坏）时 exit 2", async () => {
      // 1 张正常 + 1 张文件路径不存在（generateThumbnail 会抛错）
      const f1 = path.join(env.photosDir, "good.jpg");
      await makeJpegFixture(f1, { r: 100, g: 100, b: 100 });
      insertPhotoRow(env.dbPath, { filePath: f1, mediaType: "image" });

      // 这张照片的 filePath 指向不存在的文件
      insertPhotoRow(env.dbPath, {
        filePath: path.join(env.photosDir, "does-not-exist.jpg"),
        mediaType: "image",
      });

      const res = runCli(env, []);
      expect(res.exitCode, "部分失败应 exit 2").toBe(2);
      const json = res.json as ParsedCliOutput;
      expect(json.stats.total).toBe(2);
      expect(json.stats.success).toBe(1);
      expect(json.stats.failed).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 验收点 3：--limit 契约
  // --------------------------------------------------------------------------

  describe("验收点 3：--limit 契约", () => {
    it("--limit N 时实际处理（success + failed）的照片数 ≤ N，且未处理的照片 thumbnail_path 仍为 NULL（留待下次）", async () => {
      // 5 张待补救，--limit 2
      const insertedIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const f = path.join(env.photosDir, `limit-${i}.jpg`);
        await makeJpegFixture(f, { r: i * 40, g: 100, b: 200 });
        insertedIds.push(insertPhotoRow(env.dbPath, { filePath: f, mediaType: "image" }));
      }

      const res = runCli(env, ["--limit", "2"]);
      const json = res.json as ParsedCliOutput;

      // 核心契约：本次实际处理（success + failed）≤ limit
      const processed = json.stats.success + json.stats.failed;
      expect(processed, `--limit 2 时实际处理数（${processed}）应 ≤ 2`).toBeLessThanOrEqual(2);

      // 副作用契约：5 张里只处理了 ≤2 张，剩余 ≥3 张 thumbnail_path 仍 NULL（留待下次补救）
      // —— 这证明 --limit 是"限量处理"而非"标记跳过"
      const rows = readThumbnailPaths(env.dbPath);
      const stillNull = [...rows.values()].filter((tp) => tp === null).length;
      expect(
        stillNull,
        "5 张待补救、limit 2 后，应至少有 3 张 thumbnail_path 仍为 NULL（留待下次）",
      ).toBeGreaterThanOrEqual(3);
    });

    it("--limit 大于待补救数时，处理全部待补救（不报错）", async () => {
      const f1 = path.join(env.photosDir, "l1.jpg");
      await makeJpegFixture(f1, { r: 50, g: 50, b: 50 });
      insertPhotoRow(env.dbPath, { filePath: f1, mediaType: "image" });

      const res = runCli(env, ["--limit", "100"]);
      expect(res.exitCode, "limit 超过待补救数应 exit 0").toBe(0);
      expect((res.json as ParsedCliOutput).stats.success).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 验收点 4：--media-type 过滤
  // --------------------------------------------------------------------------

  describe("验收点 4：--media-type 过滤", () => {
    it("--media-type image 只处理 image，不含 video", async () => {
      // 2 image + 1 video，全部 thumbnail_path IS NULL
      const fi1 = path.join(env.photosDir, "img1.jpg");
      const fi2 = path.join(env.photosDir, "img2.jpg");
      await makeJpegFixture(fi1, { r: 200, g: 100, b: 100 });
      await makeJpegFixture(fi2, { r: 100, g: 200, b: 100 });

      // video 行：filePath 指向不存在的 .mp4（我们只验证过滤行为，不实际生成视频缩略图）
      const fv = path.join(env.photosDir, "clip.mp4");

      insertPhotoRow(env.dbPath, { filePath: fi1, mediaType: "image" });
      insertPhotoRow(env.dbPath, { filePath: fi2, mediaType: "image" });
      insertPhotoRow(env.dbPath, { filePath: fv, mediaType: "video" });

      // 只跑 image：video 不应被触及（即使 mp4 文件不存在也不应计入 failed）
      const res = runCli(env, ["--media-type", "image", "--limit", "10"]);
      const json = res.json as ParsedCliOutput;

      expect(res.exitCode, "image 全部成功应 exit 0").toBe(0);
      // 只处理 2 张 image，video 被过滤掉
      expect(json.stats.total, "--media-type image 时 total 应只含 image（=2）").toBe(2);
      expect(json.stats.success).toBe(2);
    });

    it("不传 --media-type 时 image + video 都在候选中（默认无过滤）", async () => {
      const fi = path.join(env.photosDir, "img.jpg");
      await makeJpegFixture(fi, { r: 100, g: 100, b: 100 });
      insertPhotoRow(env.dbPath, { filePath: fi, mediaType: "image" });
      insertPhotoRow(env.dbPath, {
        filePath: path.join(env.photosDir, "clip.mp4"),
        mediaType: "video",
      });

      const res = runCli(env, []);
      const json = res.json as ParsedCliOutput;

      // 默认无过滤：image + video 都进候选 = total 2
      expect(json.stats.total, "默认应处理 image + video（total=2）").toBe(2);
      // image 成功，video 因文件不存在失败 → exit 2
      expect(res.exitCode).toBe(2);
      expect(json.stats.success).toBe(1);
      expect(json.stats.failed).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 验收点 5：幂等契约
  // --------------------------------------------------------------------------

  describe("验收点 5：幂等契约 — 跑两次后第二次 total=0（exit 1）", () => {
    it("第一次补救成功后，第二次跑 total=0 且 exit 1", async () => {
      const f1 = path.join(env.photosDir, "idem1.jpg");
      const f2 = path.join(env.photosDir, "idem2.jpg");
      const f3 = path.join(env.photosDir, "idem3.jpg");
      await makeJpegFixture(f1, { r: 200, g: 50, b: 50 });
      await makeJpegFixture(f2, { r: 50, g: 200, b: 50 });
      await makeJpegFixture(f3, { r: 50, g: 50, b: 200 });

      insertPhotoRow(env.dbPath, { filePath: f1, mediaType: "image" });
      insertPhotoRow(env.dbPath, { filePath: f2, mediaType: "image" });
      insertPhotoRow(env.dbPath, { filePath: f3, mediaType: "image" });

      // 第一次跑：3 张全部补救
      const first = runCli(env, []);
      expect(first.exitCode, "第一次应 exit 0").toBe(0);
      expect((first.json as ParsedCliOutput).stats.success).toBe(3);

      // DB 中 thumbnail_path 现在应全部非 NULL
      const rowsAfterFirst = readThumbnailPaths(env.dbPath);
      for (const [id, tp] of rowsAfterFirst) {
        expect(tp, `第一次补救后 ${id} 的 thumbnail_path 应非 NULL`).not.toBeNull();
      }

      // 第二次跑：应识别 0 张待补救 → exit 1
      const second = runCli(env, []);
      expect(second.exitCode, "第二次跑（无待补救）应 exit 1").toBe(1);
      expect((second.json as ParsedCliOutput).stats.total).toBe(0);
    });

    it("幂等：重复执行不会重复生成缩略图文件（thumbnails 目录文件数不变）", async () => {
      const f1 = path.join(env.photosDir, "idem-file.jpg");
      await makeJpegFixture(f1, { r: 150, g: 150, b: 150 });
      insertPhotoRow(env.dbPath, { filePath: f1, mediaType: "image" });

      runCli(env, []);
      const filesAfterFirst = fs.readdirSync(env.thumbnailsDir).length;
      expect(filesAfterFirst, "第一次应生成 1 个缩略图文件").toBe(1);

      runCli(env, []);
      const filesAfterSecond = fs.readdirSync(env.thumbnailsDir).length;
      expect(filesAfterSecond, "第二次跑不应新增缩略图文件").toBe(filesAfterFirst);
    });
  });

  // --------------------------------------------------------------------------
  // 验收点（边界）：/tmp/ 路径排除契约
  // --------------------------------------------------------------------------

  describe("边界契约：file_path LIKE '/tmp/%' 被排除", () => {
    it("filePath 在 /tmp/ 下的照片即使 thumbnail_path IS NULL 也不被补救", async () => {
      // 正常照片
      const f1 = path.join(env.photosDir, "normal.jpg");
      await makeJpegFixture(f1, { r: 100, g: 100, b: 100 });
      insertPhotoRow(env.dbPath, { filePath: f1, mediaType: "image" });

      // /tmp/ 路径照片（应被排除）
      insertPhotoRow(env.dbPath, {
        filePath: "/tmp/should-be-excluded.jpg",
        mediaType: "image",
      });

      const res = runCli(env, []);
      const json = res.json as ParsedCliOutput;

      // 只有 1 张（normal）被处理，/tmp/ 那张被排除
      expect(json.stats.total, "/tmp/ 路径应被排除，total=1").toBe(1);
      expect(json.stats.success).toBe(1);
      expect(res.exitCode).toBe(0);
    });
  });
});

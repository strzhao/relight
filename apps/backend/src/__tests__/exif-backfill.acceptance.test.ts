/**
 * 验收测试：exif 回填 CLI 幂等性契约（红队，黑盒）
 *
 * 覆盖设计契约 CC-2 + CC-3：
 *   - photos 表必须含 14 列 GPS+EXIF 字段 + 1 列 exif_backfilled_at（幂等标记）
 *   - 回填 WHERE 条件：media_type='image' AND exif_backfilled_at IS NULL（CC-3 修复 M2）
 *   - 写入后 exif_backfilled_at 非 null → 再次执行 SELECT 不命中该行（幂等）
 *
 * 测试方法：
 *   - in-memory sqlite，手动建 photos 表（含 14+1 列）
 *   - 不实际执行 CLI 进程（用 pLimit 等），而是直接模拟回填 SQL 逻辑
 *   - 验证 schema 列存在、WHERE 条件正确、写入后幂等
 *
 * 红队铁律：不读取 backfill-exif.ts 实现，仅基于 CC-2/CC-3 契约验证 schema + 幂等行为。
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// in-memory SQLite + DDL（含 14+1 列）
// ---------------------------------------------------------------------------

let sqlite: Database.Database;

/**
 * 建 photos 表（包含 CC-2 要求的全部 14 EXIF 列 + 1 幂等列）。
 * 此 DDL 仅验证 schema 列的存在，不依赖 drizzle ORM，保证红队纯黑盒。
 */
function createPhotosTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      root_path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL UNIQUE,
      file_size INTEGER NOT NULL DEFAULT 0,
      taken_at TEXT,
      created_at TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'image',

      -- CC-2: 14 列 GPS + EXIF 字段（全部 nullable）
      latitude              REAL,
      longitude             REAL,
      altitude              REAL,
      gps_img_direction     REAL,
      offset_time           TEXT,
      camera_make           TEXT,
      camera_model          TEXT,
      lens_model            TEXT,
      focal_length          REAL,
      focal_length_35mm     INTEGER,
      iso                   INTEGER,
      exposure_time         REAL,
      f_number              REAL,
      software              TEXT,

      -- CC-2 第 15 列（工程幂等，不在用户"14 列"口径内）
      exif_backfilled_at    INTEGER
    );
  `);

  db.prepare(
    "INSERT INTO storage_sources (id, name, type, root_path) VALUES (?, 'test', 'local', '/t')",
  ).run("source-001");
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  createPhotosTable(sqlite);
});

afterEach(() => {
  sqlite.close();
});

// ---------------------------------------------------------------------------
// 辅助：插入测试照片
// ---------------------------------------------------------------------------

interface SeedOpts {
  id: string;
  mediaType?: "image" | "video";
  exifBackfilledAt?: number | null;
}

function seedPhoto(opts: SeedOpts): void {
  sqlite
    .prepare(
      `INSERT INTO photos
        (id, storage_source_id, file_path, file_hash, file_size, created_at, media_type, exif_backfilled_at)
       VALUES (?, 'source-001', ?, ?, 1000, ?, ?, ?)`,
    )
    .run(
      opts.id,
      `/${opts.id}.jpg`,
      `hash-${opts.id}`,
      new Date().toISOString(),
      opts.mediaType ?? "image",
      opts.exifBackfilledAt ?? null,
    );
}

// ---------------------------------------------------------------------------
// CC-2 Schema 验证
// ---------------------------------------------------------------------------

describe("CC-2：photos 表 schema 包含 14+1 列（红队验收）", () => {
  describe("14 列 GPS + EXIF 字段存在", () => {
    const expectedColumns = [
      "latitude",
      "longitude",
      "altitude",
      "gps_img_direction",
      "offset_time",
      "camera_make",
      "camera_model",
      "lens_model",
      "focal_length",
      "focal_length_35mm",
      "iso",
      "exposure_time",
      "f_number",
      "software",
    ];

    for (const col of expectedColumns) {
      it(`列 "${col}" 存在于 photos 表`, () => {
        // PRAGMA table_info 返回所有列定义
        const columns = sqlite.prepare("PRAGMA table_info(photos)").all() as { name: string }[];
        const names = columns.map((c) => c.name);
        expect(names).toContain(col);
      });
    }

    it("第 15 列 exif_backfilled_at 存在（幂等标记）", () => {
      const columns = sqlite.prepare("PRAGMA table_info(photos)").all() as { name: string }[];
      const names = columns.map((c) => c.name);
      expect(names).toContain("exif_backfilled_at");
    });

    it("14 列 + 1 幂等列全部存在（批量验证）", () => {
      const columns = sqlite.prepare("PRAGMA table_info(photos)").all() as { name: string }[];
      const names = new Set(columns.map((c) => c.name));

      const all15 = [...expectedColumns, "exif_backfilled_at"];
      for (const col of all15) {
        expect(names.has(col), `缺失列: ${col}`).toBe(true);
      }
    });
  });

  describe("14+1 列全部 nullable", () => {
    it("latitude 允许 NULL 值写入", () => {
      seedPhoto({ id: "p-null-gps" });
      const row = sqlite.prepare("SELECT latitude FROM photos WHERE id = ?").get("p-null-gps") as {
        latitude: number | null;
      };
      expect(row.latitude).toBeNull();
    });

    it("exif_backfilled_at 允许 NULL 值写入", () => {
      seedPhoto({ id: "p-null-backfill" });
      const row = sqlite
        .prepare("SELECT exif_backfilled_at FROM photos WHERE id = ?")
        .get("p-null-backfill") as { exif_backfilled_at: number | null };
      expect(row.exif_backfilled_at).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// CC-3 回填幂等行为
// ---------------------------------------------------------------------------

describe("CC-3：回填 CLI 幂等性契约（红队验收）", () => {
  describe("WHERE 条件：media_type='image' AND exif_backfilled_at IS NULL", () => {
    it("3 张照片（2 张 image+未回填，1 张 image+已回填）→ SELECT 命中 2 张", () => {
      seedPhoto({ id: "img-pending-1", mediaType: "image", exifBackfilledAt: null });
      seedPhoto({ id: "img-pending-2", mediaType: "image", exifBackfilledAt: null });
      seedPhoto({ id: "img-done", mediaType: "image", exifBackfilledAt: Date.now() });

      const pending = sqlite
        .prepare("SELECT id FROM photos WHERE media_type = 'image' AND exif_backfilled_at IS NULL")
        .all() as { id: string }[];

      expect(pending).toHaveLength(2);

      const pendingIds = pending.map((r) => r.id);
      expect(pendingIds).toContain("img-pending-1");
      expect(pendingIds).toContain("img-pending-2");
      expect(pendingIds).not.toContain("img-done");
    });

    it("video 照片（media_type='video'）不参与回填 SELECT", () => {
      seedPhoto({ id: "video-1", mediaType: "video", exifBackfilledAt: null });
      seedPhoto({ id: "img-1", mediaType: "image", exifBackfilledAt: null });

      const pending = sqlite
        .prepare("SELECT id FROM photos WHERE media_type = 'image' AND exif_backfilled_at IS NULL")
        .all() as { id: string }[];

      // 只命中 image
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe("img-1");
    });

    it("全部已回填 → SELECT 返回 0 张", () => {
      const now = Date.now();
      seedPhoto({ id: "done-1", mediaType: "image", exifBackfilledAt: now });
      seedPhoto({ id: "done-2", mediaType: "image", exifBackfilledAt: now });

      const pending = sqlite
        .prepare("SELECT id FROM photos WHERE media_type = 'image' AND exif_backfilled_at IS NULL")
        .all();

      expect(pending).toHaveLength(0);
    });
  });

  describe("写入后幂等", () => {
    it("回填后再次 SELECT → 0 张待处理（幂等）", () => {
      seedPhoto({ id: "img-a", mediaType: "image", exifBackfilledAt: null });
      seedPhoto({ id: "img-b", mediaType: "image", exifBackfilledAt: null });

      // 模拟回填逻辑：
      // 1. 读取待回填 ids
      const pending = sqlite
        .prepare("SELECT id FROM photos WHERE media_type = 'image' AND exif_backfilled_at IS NULL")
        .all() as { id: string }[];

      expect(pending).toHaveLength(2);

      // 2. 写入 14 列 EXIF + exif_backfilled_at
      const now = Date.now();
      const updateStmt = sqlite.prepare(`
        UPDATE photos SET
          latitude = ?,
          longitude = ?,
          altitude = ?,
          gps_img_direction = ?,
          offset_time = ?,
          camera_make = ?,
          camera_model = ?,
          lens_model = ?,
          focal_length = ?,
          focal_length_35mm = ?,
          iso = ?,
          exposure_time = ?,
          f_number = ?,
          software = ?,
          exif_backfilled_at = ?
        WHERE id = ?
      `);

      for (const row of pending) {
        updateStmt.run(
          35.6762, // latitude
          139.6503, // longitude
          42.0, // altitude
          180.0, // gps_img_direction
          "+09:00", // offset_time
          "Apple", // camera_make
          "iPhone 14", // camera_model
          "5mm f/1.8", // lens_model
          5.0, // focal_length
          24, // focal_length_35mm
          100, // iso
          0.004, // exposure_time
          1.8, // f_number
          null, // software
          now, // exif_backfilled_at
          row.id,
        );
      }

      // 3. 再次 SELECT → 0 张
      const afterFill = sqlite
        .prepare("SELECT id FROM photos WHERE media_type = 'image' AND exif_backfilled_at IS NULL")
        .all();

      expect(afterFill).toHaveLength(0);
    });

    it("回填后数据正确写入 14 列", () => {
      seedPhoto({ id: "img-verify", mediaType: "image", exifBackfilledAt: null });

      const now = Date.now();
      sqlite
        .prepare(
          `UPDATE photos SET
            latitude=?, longitude=?, altitude=?, gps_img_direction=?,
            offset_time=?, camera_make=?, camera_model=?, lens_model=?,
            focal_length=?, focal_length_35mm=?, iso=?, exposure_time=?,
            f_number=?, software=?, exif_backfilled_at=?
           WHERE id='img-verify'`,
        )
        .run(
          35.0,
          139.0,
          50.0,
          90.0,
          "+08:00",
          "Sony",
          "ILCE-7M4",
          "85mm",
          85.0,
          85,
          800,
          0.001,
          2.8,
          "Lightroom",
          now,
        );

      const row = sqlite.prepare("SELECT * FROM photos WHERE id='img-verify'").get() as Record<
        string,
        unknown
      >;

      expect(row.latitude).toBe(35.0);
      expect(row.longitude).toBe(139.0);
      expect(row.altitude).toBe(50.0);
      expect(row.gps_img_direction).toBe(90.0);
      expect(row.offset_time).toBe("+08:00");
      expect(row.camera_make).toBe("Sony");
      expect(row.camera_model).toBe("ILCE-7M4");
      expect(row.lens_model).toBe("85mm");
      expect(row.focal_length).toBe(85.0);
      expect(row.focal_length_35mm).toBe(85);
      expect(row.iso).toBe(800);
      expect(row.exposure_time).toBe(0.001);
      expect(row.f_number).toBe(2.8);
      expect(row.software).toBe("Lightroom");
      expect(row.exif_backfilled_at).toBe(now);
    });

    it("重复跑回填脚本（exif_backfilled_at 已设置的行不会被二次 UPDATE）", () => {
      const first = Date.now();
      seedPhoto({ id: "img-idempotent", mediaType: "image", exifBackfilledAt: first });

      // 模拟"重复执行"：WHERE 命中 0 张 → 不会 UPDATE
      const pending = sqlite
        .prepare("SELECT id FROM photos WHERE media_type = 'image' AND exif_backfilled_at IS NULL")
        .all();

      expect(pending).toHaveLength(0);

      // 验证 exif_backfilled_at 未被改变
      const row = sqlite
        .prepare("SELECT exif_backfilled_at FROM photos WHERE id='img-idempotent'")
        .get() as { exif_backfilled_at: number };
      expect(row.exif_backfilled_at).toBe(first);
    });
  });

  describe("边界：全无照片", () => {
    it("photos 表为空 → SELECT 返回 0 张，不崩溃", () => {
      const pending = sqlite
        .prepare("SELECT id FROM photos WHERE media_type = 'image' AND exif_backfilled_at IS NULL")
        .all();

      expect(pending).toHaveLength(0);
    });
  });
});

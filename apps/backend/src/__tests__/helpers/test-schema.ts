import type Database from "better-sqlite3";

/**
 * 共享测试用 DDL — 与 db/schema.ts 保持同步。
 *
 * 历史教训：每个 test file 各自维护硬编码 DDL，schema 演进时（视频/连拍/合成壁纸/
 * 多照片关联回忆等多次扩列）测试 DDL 集体漂移，导致 SqliteError: no such column。
 * 本 helper 让所有需要真实 SQLite 的测试用同一份 DDL，schema.ts 加列时只改这里。
 *
 * 包含表：storage_sources / bursts / photos / tags / photo_tags / photo_analyses /
 *        daily_picks / daily_pick_entries / scan_logs / analyze_batches / analyze_batch_jobs / settings
 */
export interface SetupOptions {
  /**
   * 当 true 时把 storage_sources.status 建为 NOT NULL DEFAULT 'unknown'（比 prod schema 严格）。
   * 仅 storage-reachability-flow 测试需要此约束，其它测试用默认（与 prod schema 一致 nullable）。
   */
  strictStorageStatus?: boolean;
}

export function setupTestSchema(sqlite: Database.Database, opts: SetupOptions = {}): void {
  const statusCol = opts.strictStorageStatus
    ? "status TEXT NOT NULL DEFAULT 'unknown'"
    : "status TEXT";
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS storage_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      root_path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_scan_at TEXT,
      ${statusCol},
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS bursts (
      id TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
      representative_photo_id TEXT,
      member_count INTEGER NOT NULL DEFAULT 0,
      manual_override INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL UNIQUE,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0,
      thumbnail_path TEXT,
      taken_at TEXT,
      file_mtime INTEGER,
      created_at TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'image',
      duration_sec REAL,
      video_codec TEXT,
      video_fps REAL,
      burst_id TEXT,
      is_burst_representative INTEGER NOT NULL DEFAULT 0,
      phash TEXT,
      UNIQUE(storage_source_id, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_photos_created_at ON photos(created_at);
    CREATE INDEX IF NOT EXISTS idx_photos_burst_id ON photos(burst_id);
    CREATE INDEX IF NOT EXISTS idx_photos_taken_burst ON photos(storage_source_id, taken_at);

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photo_tags (
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      confidence REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (photo_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS photo_analyses (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      ai_model TEXT NOT NULL,
      narrative TEXT,
      aesthetic_score REAL,
      tags TEXT,
      composition TEXT,
      color_analysis TEXT,
      emotional_analysis TEXT,
      usage_suggestions TEXT,
      prompt_version TEXT,
      raw_response TEXT NOT NULL DEFAULT '',
      processed_at TEXT NOT NULL,
      transcript TEXT,
      transcript_segments TEXT,
      video_pacing TEXT,
      motion_score REAL
    );
    CREATE INDEX IF NOT EXISTS idx_photo_analyses_photo_id_processed_at
      ON photo_analyses(photo_id, processed_at);

    CREATE TABLE IF NOT EXISTS daily_picks (
      id TEXT PRIMARY KEY,
      photo_id TEXT NOT NULL REFERENCES photos(id),
      pick_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      composed_image_path TEXT,
      members TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_pick_entries (
      id TEXT PRIMARY KEY,
      daily_pick_id TEXT NOT NULL REFERENCES daily_picks(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL,
      photo_id TEXT NOT NULL REFERENCES photos(id),
      title TEXT NOT NULL,
      narrative TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      members TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(daily_pick_id, rank)
    );
    CREATE INDEX IF NOT EXISTS idx_dpe_pick_rank ON daily_pick_entries(daily_pick_id, rank);

    CREATE TABLE IF NOT EXISTS scan_logs (
      id TEXT PRIMARY KEY,
      storage_source_id TEXT NOT NULL REFERENCES storage_sources(id),
      job_id TEXT,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS analyze_batches (
      id TEXT PRIMARY KEY,
      filter_json TEXT NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS analyze_batch_jobs (
      job_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES analyze_batches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

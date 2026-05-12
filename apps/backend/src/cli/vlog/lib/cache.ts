import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const DEFAULT_DB =
  process.env.VLOG_CACHE_DB ?? path.join(os.homedir(), ".cache", "vlog-cli", "cache.db");

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  const dir = path.dirname(DEFAULT_DB);
  fs.mkdirSync(dir, { recursive: true });
  const conn = new Database(DEFAULT_DB);
  conn.pragma("journal_mode = WAL");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS analysis_cache (
      cache_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_cache_kind ON analysis_cache(kind);
  `);
  _db = conn;
  return conn;
}

export function cacheGet<T>(key: string): T | null {
  const row = db()
    .prepare("SELECT payload_json FROM analysis_cache WHERE cache_key = ?")
    .get(key) as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as T;
  } catch {
    return null;
  }
}

export function cachePut(
  key: string,
  kind: "image" | "video" | "transcript",
  value: unknown,
): void {
  const json = JSON.stringify(value);
  db()
    .prepare(
      "INSERT OR REPLACE INTO analysis_cache (cache_key, kind, payload_json, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(key, kind, json, Date.now());
}

export function cachePath(): string {
  return DEFAULT_DB;
}

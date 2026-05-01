import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** 存储源 */
export const storageSources = sqliteTable("storage_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", { enum: ["local", "smb", "webdav"] })
    .notNull()
    .default("local"),
  rootPath: text("root_path").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastScanAt: text("last_scan_at"),
});

/** 照片 */
export const photos = sqliteTable("photos", {
  id: text("id").primaryKey(),
  storageSourceId: text("storage_source_id")
    .notNull()
    .references(() => storageSources.id),
  filePath: text("file_path").notNull(),
  fileHash: text("file_hash").notNull(),
  width: integer("width").notNull().default(0),
  height: integer("height").notNull().default(0),
  fileSize: integer("file_size").notNull().default(0),
  thumbnailPath: text("thumbnail_path"),
  takenAt: text("taken_at"),
  createdAt: text("created_at").notNull(),
});

/** 标签 */
export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  category: text("category", {
    enum: ["scene", "emotion", "people", "color", "event", "object", "style"],
  }).notNull(),
  createdAt: text("created_at").notNull(),
});

/** 照片-标签关联 */
export const photoTags = sqliteTable("photo_tags", {
  photoId: text("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  tagId: text("tag_id")
    .notNull()
    .references(() => tags.id, { onDelete: "cascade" }),
  confidence: real("confidence").notNull().default(0),
});

/** AI 分析记录 */
export const photoAnalyses = sqliteTable("photo_analyses", {
  id: text("id").primaryKey(),
  photoId: text("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  aiModel: text("ai_model").notNull(),
  rawResponse: text("raw_response").notNull(),
  processedAt: text("processed_at").notNull(),
});

/** 每日精选 */
export const dailyPicks = sqliteTable("daily_picks", {
  id: text("id").primaryKey(),
  photoId: text("photo_id")
    .notNull()
    .references(() => photos.id),
  pickDate: text("pick_date").notNull(),
  title: text("title").notNull(),
  narrative: text("narrative").notNull(),
  score: real("score").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

/** 扫描日志 */
export const scanLogs = sqliteTable("scan_logs", {
  id: text("id").primaryKey(),
  storageSourceId: text("storage_source_id")
    .notNull()
    .references(() => storageSources.id),
  scannedCount: integer("scanned_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

/** 设置 (key-value) */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

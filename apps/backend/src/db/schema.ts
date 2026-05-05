import { relations } from "drizzle-orm";
import { integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/** 存储源 */
export const storageSources = sqliteTable("storage_sources", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  type: text("type", { enum: ["local", "smb", "webdav"] })
    .notNull()
    .default("local"),
  rootPath: text("root_path").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastScanAt: text("last_scan_at"),
  status: text("status"),
  lastError: text("last_error"),
});

/** 照片 */
export const photos = sqliteTable(
  "photos",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    storageSourceId: text("storage_source_id")
      .notNull()
      .references(() => storageSources.id),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash").notNull().unique(),
    width: integer("width").notNull().default(0),
    height: integer("height").notNull().default(0),
    fileSize: integer("file_size").notNull().default(0),
    thumbnailPath: text("thumbnail_path"),
    takenAt: text("taken_at"),
    fileMtime: integer("file_mtime"),
    createdAt: text("created_at").notNull(),
    // 视频支持（nullable，图片保持 NULL 或 'image' 默认）
    mediaType: text("media_type", { enum: ["image", "video"] })
      .notNull()
      .default("image"),
    durationSec: real("duration_sec"),
    videoCodec: text("video_codec"),
    videoFps: real("video_fps"),
  },
  (t) => ({
    unq_storage_file: unique().on(t.storageSourceId, t.filePath),
  }),
);

/** 标签 */
export const tags = sqliteTable("tags", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().unique(),
  category: text("category", {
    enum: ["scene", "emotion", "people", "color", "event", "object", "style"],
  }).notNull(),
  createdAt: text("created_at").notNull(),
});

/** 照片-标签关联（复合主键） */
export const photoTags = sqliteTable(
  "photo_tags",
  {
    photoId: text("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    confidence: real("confidence").notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.photoId, table.tagId] }),
  }),
);

/** AI 分析记录 */
export const photoAnalyses = sqliteTable("photo_analyses", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  photoId: text("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  aiModel: text("ai_model").notNull(),
  narrative: text("narrative"),
  aestheticScore: real("aesthetic_score"),
  tags: text("tags", { mode: "json" }).$type<
    { name: string; category: string; confidence: number }[]
  >(),
  composition: text("composition", { mode: "json" }).$type<{
    type: string;
    score: number;
    description: string;
  }>(),
  colorAnalysis: text("color_analysis", { mode: "json" }).$type<{
    palette: string[];
    dominant: string;
    mood: string;
  }>(),
  emotionalAnalysis: text("emotional_analysis", { mode: "json" }).$type<{
    primary: string;
    secondary: string;
    intensity: number;
  }>(),
  usageSuggestions: text("usage_suggestions"),
  promptVersion: text("prompt_version"),
  rawResponse: text("raw_response").notNull(),
  processedAt: text("processed_at").notNull(),
  // 视频专属字段（nullable，图片分析时为 NULL）
  transcript: text("transcript"),
  transcriptSegments: text("transcript_segments", { mode: "json" }).$type<
    { start: number; end: number; text: string }[]
  >(),
  videoPacing: text("video_pacing"),
  motionScore: real("motion_score"),
});

/** 每日精选 */
export const dailyPicks = sqliteTable("daily_picks", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  photoId: text("photo_id")
    .notNull()
    .references(() => photos.id),
  pickDate: text("pick_date").notNull().unique(),
  title: text("title").notNull(),
  narrative: text("narrative").notNull(),
  score: real("score").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

/** 扫描日志 */
export const scanLogs = sqliteTable("scan_logs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  storageSourceId: text("storage_source_id")
    .notNull()
    .references(() => storageSources.id),
  jobId: text("job_id"),
  scannedCount: integer("scanned_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

/** 批量分析批次 — 追踪批量分析整体进度 */
export const analyzeBatches = sqliteTable("analyze_batches", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  filterJson: text("filter_json").notNull(),
  totalCount: integer("total_count").notNull().default(0),
  completedCount: integer("completed_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

/** 批量分析作业映射 (jobId -> batchId) */
export const analyzeBatchJobs = sqliteTable("analyze_batch_jobs", {
  jobId: text("job_id").primaryKey(),
  batchId: text("batch_id")
    .notNull()
    .references(() => analyzeBatches.id, { onDelete: "cascade" }),
});

/** 设置 (key-value) */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ===== Drizzle Relations =====

export const storageSourcesRelations = relations(storageSources, ({ many }) => ({
  photos: many(photos),
  scanLogs: many(scanLogs),
}));

export const photosRelations = relations(photos, ({ one, many }) => ({
  storageSource: one(storageSources, {
    fields: [photos.storageSourceId],
    references: [storageSources.id],
  }),
  photoTags: many(photoTags),
  analyses: many(photoAnalyses),
  dailyPicks: many(dailyPicks),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  photoTags: many(photoTags),
}));

export const photoTagsRelations = relations(photoTags, ({ one }) => ({
  photo: one(photos, {
    fields: [photoTags.photoId],
    references: [photos.id],
  }),
  tag: one(tags, {
    fields: [photoTags.tagId],
    references: [tags.id],
  }),
}));

export const photoAnalysesRelations = relations(photoAnalyses, ({ one }) => ({
  photo: one(photos, {
    fields: [photoAnalyses.photoId],
    references: [photos.id],
  }),
}));

export const dailyPicksRelations = relations(dailyPicks, ({ one }) => ({
  photo: one(photos, {
    fields: [dailyPicks.photoId],
    references: [photos.id],
  }),
}));

export const scanLogsRelations = relations(scanLogs, ({ one }) => ({
  storageSource: one(storageSources, {
    fields: [scanLogs.storageSourceId],
    references: [storageSources.id],
  }),
}));

export const analyzeBatchesRelations = relations(analyzeBatches, ({ many }) => ({
  jobs: many(analyzeBatchJobs),
}));

export const analyzeBatchJobsRelations = relations(analyzeBatchJobs, ({ one }) => ({
  batch: one(analyzeBatches, {
    fields: [analyzeBatchJobs.batchId],
    references: [analyzeBatches.id],
  }),
}));

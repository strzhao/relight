CREATE TABLE `analyze_batch_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `analyze_batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `analyze_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`filter_json` text NOT NULL,
	`total_count` integer DEFAULT 0 NOT NULL,
	`completed_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `daily_picks` (
	`id` text PRIMARY KEY NOT NULL,
	`photo_id` text NOT NULL,
	`pick_date` text NOT NULL,
	`title` text NOT NULL,
	`narrative` text NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_picks_pick_date_unique` ON `daily_picks` (`pick_date`);--> statement-breakpoint
CREATE TABLE `photo_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`photo_id` text NOT NULL,
	`ai_model` text NOT NULL,
	`narrative` text,
	`aesthetic_score` real,
	`tags` text,
	`composition` text,
	`color_analysis` text,
	`emotional_analysis` text,
	`usage_suggestions` text,
	`prompt_version` text,
	`raw_response` text NOT NULL,
	`processed_at` text NOT NULL,
	`transcript` text,
	`transcript_segments` text,
	`video_pacing` text,
	`motion_score` real,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `photo_tags` (
	`photo_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`photo_id`, `tag_id`),
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`storage_source_id` text NOT NULL,
	`file_path` text NOT NULL,
	`file_hash` text NOT NULL,
	`width` integer DEFAULT 0 NOT NULL,
	`height` integer DEFAULT 0 NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`thumbnail_path` text,
	`taken_at` text,
	`file_mtime` integer,
	`created_at` text NOT NULL,
	`media_type` text DEFAULT 'image' NOT NULL,
	`duration_sec` real,
	`video_codec` text,
	`video_fps` real,
	FOREIGN KEY (`storage_source_id`) REFERENCES `storage_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photos_file_hash_unique` ON `photos` (`file_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `photos_storage_source_id_file_path_unique` ON `photos` (`storage_source_id`,`file_path`);--> statement-breakpoint
CREATE TABLE `scan_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`storage_source_id` text NOT NULL,
	`job_id` text,
	`scanned_count` integer DEFAULT 0 NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`storage_source_id`) REFERENCES `storage_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'local' NOT NULL,
	`root_path` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_scan_at` text,
	`status` text,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);
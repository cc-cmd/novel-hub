CREATE TABLE `chapter` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`novel_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`title` text NOT NULL,
	`file_path` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`content_hash` text,
	`file_missing` integer DEFAULT false NOT NULL,
	`warning` text,
	`mtime_ms` real,
	`size_bytes` integer,
	FOREIGN KEY (`novel_id`) REFERENCES `novel`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chapter_novel_id_seq_unique` ON `chapter` (`novel_id`,`seq`);--> statement-breakpoint
CREATE TABLE `library_root` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_root_path_unique` ON `library_root` (`path`);--> statement-breakpoint
CREATE TABLE `novel` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`dir_path` text NOT NULL,
	`chapter_subdir` text DEFAULT '' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`dir_missing` integer DEFAULT false NOT NULL,
	`root_removed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `novel_dir_path_unique` ON `novel` (`dir_path`);--> statement-breakpoint
CREATE TABLE `novel_platform` (
	`novel_id` integer NOT NULL,
	`platform_id` integer NOT NULL,
	`book_url` text,
	PRIMARY KEY(`novel_id`, `platform_id`),
	FOREIGN KEY (`novel_id`) REFERENCES `novel`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_id`) REFERENCES `platform`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `platform` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`builtin` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_name_unique` ON `platform` (`name`);--> statement-breakpoint
CREATE TABLE `publication` (
	`chapter_id` integer NOT NULL,
	`platform_id` integer NOT NULL,
	`status` text DEFAULT 'unpublished' NOT NULL,
	`published_at` integer,
	`platform_url` text,
	`published_hash` text,
	PRIMARY KEY(`chapter_id`, `platform_id`),
	FOREIGN KEY (`chapter_id`) REFERENCES `chapter`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_id`) REFERENCES `platform`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scan_issue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`novel_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`novel_id`) REFERENCES `novel`(`id`) ON UPDATE no action ON DELETE no action
);

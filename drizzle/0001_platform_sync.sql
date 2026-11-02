ALTER TABLE `novel_platform` ADD `book_id` text;--> statement-breakpoint
ALTER TABLE `novel_platform` ADD `last_synced_at` integer;--> statement-breakpoint
ALTER TABLE `novel_platform` ADD `last_sync_error` text;--> statement-breakpoint
ALTER TABLE `platform` ADD `cookie` text;--> statement-breakpoint
ALTER TABLE `platform` ADD `csrf_token` text;--> statement-breakpoint
ALTER TABLE `publication` ADD `platform_item_id` text;--> statement-breakpoint
ALTER TABLE `publication` ADD `platform_word_count` integer;--> statement-breakpoint
ALTER TABLE `publication` ADD `synced_at` integer;
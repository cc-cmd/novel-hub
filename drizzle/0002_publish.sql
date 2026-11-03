ALTER TABLE `novel_platform` ADD `volumes` text;--> statement-breakpoint
ALTER TABLE `platform` ADD `use_ai` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform` ADD `daily_word_limit` integer DEFAULT 20000 NOT NULL;--> statement-breakpoint
ALTER TABLE `publication` ADD `submitted_at` integer;--> statement-breakpoint
ALTER TABLE `publication` ADD `quota_words` integer;
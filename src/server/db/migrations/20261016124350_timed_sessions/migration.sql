CREATE TABLE `score_estimates` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`section` text NOT NULL,
	`at` integer NOT NULL,
	`ability` real NOT NULL,
	`standard_error` real NOT NULL,
	`score` integer NOT NULL,
	`low` integer NOT NULL,
	`high` integer NOT NULL,
	`calibrated` integer NOT NULL,
	`rated_responses` integer NOT NULL,
	CONSTRAINT `fk_score_estimates_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `served_questions` ADD `served_elapsed_ms` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `time_limit_ms` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `elapsed_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `clock_saved_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `interrupted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `holder` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `ended_by` text;--> statement-breakpoint
CREATE INDEX `score_estimates_profile` ON `score_estimates` (`profile_id`,`section`,`at`);
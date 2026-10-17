CREATE TABLE `daily_notes` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`day` text NOT NULL,
	`note` text NOT NULL,
	`written_at` integer NOT NULL,
	CONSTRAINT `fk_daily_notes_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `plan_items` (
	`id` text PRIMARY KEY,
	`version_id` text NOT NULL,
	`day` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`item` text NOT NULL,
	`minutes` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	CONSTRAINT `fk_plan_items_version_id_plan_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `plan_versions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `plan_settings` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`test_date` text,
	`target_total` integer,
	`weekly_minutes` integer NOT NULL,
	`days_off` text NOT NULL,
	`diagnostic_skipped` integer NOT NULL,
	`set_at` integer NOT NULL,
	CONSTRAINT `fk_plan_settings_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `plan_versions` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`version` integer NOT NULL,
	`built_at` integer NOT NULL,
	`from_day` text NOT NULL,
	`basis` text NOT NULL,
	`inputs` text NOT NULL,
	`outline` text NOT NULL,
	CONSTRAINT `fk_plan_versions_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `profile_days` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`time_zone` text NOT NULL,
	`rollover_hour` integer NOT NULL,
	`from` integer NOT NULL,
	`set_at` integer NOT NULL,
	CONSTRAINT `fk_profile_days_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `plan_item_id` text;--> statement-breakpoint
CREATE INDEX `daily_notes_profile_day` ON `daily_notes` (`profile_id`,`day`);--> statement-breakpoint
CREATE INDEX `plan_items_version` ON `plan_items` (`version_id`,`day`);--> statement-breakpoint
CREATE INDEX `plan_settings_profile` ON `plan_settings` (`profile_id`,`set_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `plan_versions_profile_version` ON `plan_versions` (`profile_id`,`version`);--> statement-breakpoint
CREATE INDEX `profile_days_profile` ON `profile_days` (`profile_id`,`from`);--> statement-breakpoint
CREATE INDEX `sessions_plan_item` ON `sessions` (`plan_item_id`);
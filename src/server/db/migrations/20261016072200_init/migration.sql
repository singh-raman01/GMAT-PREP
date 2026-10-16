CREATE TABLE `profile_unlocks` (
	`token_hash` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	CONSTRAINT `fk_profile_unlocks_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`name_key` text NOT NULL UNIQUE,
	`pin_hash` text,
	`time_zone` text NOT NULL,
	`rollover_hour` integer DEFAULT 4 NOT NULL,
	`failed_pin_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `taxonomy_versions` (
	`version` integer NOT NULL,
	`file_hash` text NOT NULL,
	`loaded_at` integer NOT NULL,
	CONSTRAINT `taxonomy_versions_pk` PRIMARY KEY(`version`, `file_hash`)
);

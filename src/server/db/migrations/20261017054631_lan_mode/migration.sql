CREATE TABLE `devices` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`paired_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `lan_mode` (
	`id` integer PRIMARY KEY,
	`on` integer NOT NULL,
	`changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token` ON `devices` (`token_hash`);
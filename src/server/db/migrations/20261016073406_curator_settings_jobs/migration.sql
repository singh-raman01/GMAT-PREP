CREATE TABLE `curator_access` (
	`id` integer PRIMARY KEY,
	`passphrase_hash` text NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`set_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `curator_unlocks` (
	`token_hash` text PRIMARY KEY,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`params` text NOT NULL,
	`status` text NOT NULL,
	`checkpoint` text,
	`steps_done` integer DEFAULT 0 NOT NULL,
	`steps_total` integer,
	`note` text,
	`result` text,
	`spend_cap` real NOT NULL,
	`spend` real DEFAULT 0 NOT NULL,
	`claimant` text,
	`heartbeat_at` integer,
	`requested` text,
	`resume_at` integer,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY,
	`job_id` text,
	`task` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`tokens_in` integer NOT NULL,
	`tokens_out` integer NOT NULL,
	`tokens_estimated` integer NOT NULL,
	`cost` real NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_llm_calls_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_revision` ON `jobs` (`revision`);--> statement-breakpoint
CREATE INDEX `llm_calls_job` ON `llm_calls` (`job_id`);
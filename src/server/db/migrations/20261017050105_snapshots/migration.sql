CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`file` text,
	`taken_at` integer NOT NULL,
	`day` text NOT NULL,
	`size` integer,
	`sha256` text,
	`status` text NOT NULL,
	`error` text,
	`removed_at` integer
);
--> statement-breakpoint
CREATE INDEX `snapshots_taken` ON `snapshots` (`taken_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `snapshots_file` ON `snapshots` (`file`);
CREATE TABLE `datasets` (
	`id` text PRIMARY KEY,
	`columns` text NOT NULL,
	`rows` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `stimuli` ADD `dataset_id` text REFERENCES datasets(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `stimuli` ADD `chart_spec` text;--> statement-breakpoint
ALTER TABLE `stimuli` ADD `figure` text;--> statement-breakpoint
ALTER TABLE `stimuli` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `stimuli` ADD `position` integer;--> statement-breakpoint
ALTER TABLE `stimuli` ADD `title` text;--> statement-breakpoint
CREATE INDEX `stimuli_parent` ON `stimuli` (`parent_id`);
CREATE TABLE `stimuli` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`normalized_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `questions` ADD `stimulus_id` text REFERENCES stimuli(id) ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX `questions_stimulus` ON `questions` (`stimulus_id`);--> statement-breakpoint
CREATE INDEX `stimuli_hash` ON `stimuli` (`normalized_hash`);
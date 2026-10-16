CREATE TABLE `approaches` (
	`id` text PRIMARY KEY,
	`question_id` text NOT NULL,
	`position` integer NOT NULL,
	`strategy` text NOT NULL,
	`steps` text NOT NULL,
	`expected_seconds` integer NOT NULL,
	`valid_when` text NOT NULL,
	`author` text NOT NULL,
	`answer` text,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_approaches_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `golden_questions` (
	`question_id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`set_name` text NOT NULL,
	`number` integer NOT NULL,
	`page` integer NOT NULL,
	`expected` text NOT NULL,
	`approved_at` integer NOT NULL,
	CONSTRAINT `fk_golden_questions_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_golden_questions_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `key_overrides` (
	`id` text PRIMARY KEY,
	`part_id` text NOT NULL,
	`previous_key` text,
	`new_key` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_key_overrides_part_id_parts_id_fk` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `option_notes` (
	`part_id` text NOT NULL,
	`position` integer NOT NULL,
	`trap_note` text NOT NULL,
	`mistake_type` text NOT NULL,
	`trap_pattern` text,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `option_notes_pk` PRIMARY KEY(`part_id`, `position`),
	CONSTRAINT `fk_option_notes_part_id_parts_id_fk` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `solver_runs` (
	`question_id` text NOT NULL,
	`run` integer NOT NULL,
	`answer` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `solver_runs_pk` PRIMARY KEY(`question_id`, `run`),
	CONSTRAINT `fk_solver_runs_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `questions` ADD `primary_skill` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `secondary_skills` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `difficulty_estimate` real;--> statement-breakpoint
ALTER TABLE `questions` ADD `tags_model` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `tags_prompt_version` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `tagged_at` integer;--> statement-breakpoint
ALTER TABLE `questions` ADD `difficulty_seed` real;--> statement-breakpoint
ALTER TABLE `questions` ADD `difficulty_basis` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `link_reasons` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `related_question_id` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `enrichment` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `reserve` integer;--> statement-breakpoint
ALTER TABLE `questions` ADD `reserve_decided_at` integer;--> statement-breakpoint
CREATE INDEX `approaches_question` ON `approaches` (`question_id`);--> statement-breakpoint
CREATE INDEX `key_overrides_part` ON `key_overrides` (`part_id`);--> statement-breakpoint
CREATE INDEX `questions_enrichment` ON `questions` (`enrichment`);
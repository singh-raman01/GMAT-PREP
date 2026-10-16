CREATE TABLE `generation_batches` (
	`id` text PRIMARY KEY,
	`number` integer NOT NULL UNIQUE,
	`question_type` text NOT NULL,
	`skill` text NOT NULL,
	`band` text NOT NULL,
	`count` integer NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`job_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_generation_batches_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `statement_predicates` (
	`part_id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`dataset_id` text,
	`predicate` text,
	`second` text,
	`result` text,
	`second_result` text,
	`approximate` integer DEFAULT false NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_statement_predicates_part_id_parts_id_fk` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_statement_predicates_dataset_id_datasets_id_fk` FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `questions` ADD `batch_id` text REFERENCES generation_batches(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `questions` ADD `batch_item` integer;--> statement-breakpoint
CREATE INDEX `questions_batch` ON `questions` (`batch_id`);
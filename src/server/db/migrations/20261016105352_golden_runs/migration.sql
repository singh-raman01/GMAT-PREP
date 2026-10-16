CREATE TABLE `golden_run_readings` (
	`run_id` text NOT NULL,
	`page` integer NOT NULL,
	`role` text NOT NULL,
	`group_name` text NOT NULL,
	`items` text NOT NULL,
	CONSTRAINT `golden_run_readings_pk` PRIMARY KEY(`run_id`, `page`, `role`, `group_name`),
	CONSTRAINT `fk_golden_run_readings_run_id_golden_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `golden_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `golden_run_tags` (
	`run_id` text NOT NULL,
	`question_id` text NOT NULL,
	`primary_skill` text,
	`secondary_skills` text NOT NULL,
	CONSTRAINT `golden_run_tags_pk` PRIMARY KEY(`run_id`, `question_id`),
	CONSTRAINT `fk_golden_run_tags_run_id_golden_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `golden_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `golden_runs` (
	`id` text PRIMARY KEY,
	`job_id` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`report` text,
	CONSTRAINT `fk_golden_runs_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE SET NULL
);

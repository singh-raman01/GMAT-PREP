CREATE TABLE `retry_skips` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`question_id` text NOT NULL,
	`step` integer NOT NULL,
	`note` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_retry_skips_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_retry_skips_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `retry_skips_profile` ON `retry_skips` (`profile_id`);
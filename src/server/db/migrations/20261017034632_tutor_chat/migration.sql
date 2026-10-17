CREATE TABLE `problem_reports` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`question_id` text NOT NULL,
	`text` text NOT NULL,
	`review_item_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_problem_reports_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_problem_reports_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_problem_reports_review_item_id_review_items_id_fk` FOREIGN KEY (`review_item_id`) REFERENCES `review_items`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `tutor_messages` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`question_id` text NOT NULL,
	`message` text NOT NULL,
	`message_key` text NOT NULL,
	`reply` text NOT NULL,
	`reused_from` text,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`tokens_in` integer NOT NULL,
	`tokens_out` integer NOT NULL,
	`cost` real NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_tutor_messages_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tutor_messages_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `problem_reports_question` ON `problem_reports` (`question_id`);--> statement-breakpoint
CREATE INDEX `problem_reports_profile` ON `problem_reports` (`profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tutor_messages_profile_question` ON `tutor_messages` (`profile_id`,`question_id`,`created_at`);
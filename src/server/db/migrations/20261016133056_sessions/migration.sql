CREATE TABLE `bookmarks` (
	`profile_id` text NOT NULL,
	`question_id` text NOT NULL,
	`session_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `bookmarks_pk` PRIMARY KEY(`profile_id`, `question_id`),
	CONSTRAINT `fk_bookmarks_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_bookmarks_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_bookmarks_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `difficulty` (
	`question_id` text PRIMARY KEY,
	`value` real NOT NULL,
	`rated_responses` integer NOT NULL,
	CONSTRAINT `fk_difficulty_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `responses` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`session_id` text NOT NULL,
	`question_id` text NOT NULL,
	`seq` integer NOT NULL,
	`selection` text NOT NULL,
	`time_spent_ms` integer NOT NULL,
	`guessed` integer NOT NULL,
	`kind` text NOT NULL,
	`supersedes` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_responses_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_responses_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_responses_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `served_questions` (
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`question_id` text NOT NULL,
	`served_at` integer NOT NULL,
	CONSTRAINT `served_questions_pk` PRIMARY KEY(`session_id`, `position`),
	CONSTRAINT `fk_served_questions_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_served_questions_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`timed` integer NOT NULL,
	`config` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT `fk_sessions_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `questions` ADD `released_at` integer;--> statement-breakpoint
ALTER TABLE `questions` ADD `merged_into` text;--> statement-breakpoint
CREATE UNIQUE INDEX `responses_session_seq` ON `responses` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `responses_profile_question` ON `responses` (`profile_id`,`question_id`);--> statement-breakpoint
CREATE INDEX `served_questions_question` ON `served_questions` (`question_id`);--> statement-breakpoint
CREATE INDEX `sessions_profile` ON `sessions` (`profile_id`,`status`);
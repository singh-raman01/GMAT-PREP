CREATE TABLE `lesson_views` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`lesson_id` text NOT NULL,
	`kind` text NOT NULL,
	`part` text NOT NULL,
	`plan_item_id` text,
	`viewed_at` integer NOT NULL,
	CONSTRAINT `fk_lesson_views_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_lesson_views_lesson_id_lessons_id_fk` FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`basis` text NOT NULL,
	`content` text NOT NULL,
	`words` integer NOT NULL,
	`methods_words` integer NOT NULL,
	`examples` text NOT NULL,
	`checks` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`job_id` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `lesson_views_profile` ON `lesson_views` (`profile_id`,`viewed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `lessons_subject_version` ON `lessons` (`subject_kind`,`subject_id`,`version`);
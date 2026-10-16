CREATE TABLE `official_scores` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`taken_on` text NOT NULL,
	`kind` text NOT NULL,
	`total` integer NOT NULL,
	`quant` integer NOT NULL,
	`verbal` integer NOT NULL,
	`di` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_official_scores_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `paper_marks` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`book_id` text NOT NULL,
	`first_page` integer,
	`last_page` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_paper_marks_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_paper_marks_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `official_scores_profile` ON `official_scores` (`profile_id`);--> statement-breakpoint
CREATE INDEX `paper_marks_profile` ON `paper_marks` (`profile_id`);
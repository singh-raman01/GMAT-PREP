CREATE TABLE `book_skips` (
	`book_id` text NOT NULL,
	`set_name` text NOT NULL,
	`number` integer NOT NULL,
	`page` integer NOT NULL,
	`reason` text NOT NULL,
	CONSTRAINT `book_skips_pk` PRIMARY KEY(`book_id`, `set_name`, `number`),
	CONSTRAINT `fk_book_skips_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `options` (
	`part_id` text NOT NULL,
	`position` integer NOT NULL,
	`label` text NOT NULL,
	`text` text NOT NULL,
	CONSTRAINT `options_pk` PRIMARY KEY(`part_id`, `position`),
	CONSTRAINT `fk_options_part_id_parts_id_fk` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `page_readings` (
	`book_id` text NOT NULL,
	`page` integer NOT NULL,
	`role` text NOT NULL,
	`group_name` text NOT NULL,
	`items` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `page_readings_pk` PRIMARY KEY(`book_id`, `page`, `role`, `group_name`),
	CONSTRAINT `fk_page_readings_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `parts` (
	`id` text PRIMARY KEY,
	`question_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`prompt` text,
	`key` text,
	`key_basis` text,
	CONSTRAINT `fk_parts_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY,
	`section` text NOT NULL,
	`question_type` text NOT NULL,
	`stem` text NOT NULL,
	`status` text NOT NULL,
	`normalized_text` text NOT NULL,
	`normalized_hash` text NOT NULL,
	`book_label` text,
	`taxonomy_version` integer NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_items` (
	`id` text PRIMARY KEY,
	`question_id` text,
	`book_id` text,
	`page` integer,
	`reasons` text NOT NULL,
	`related_question_id` text,
	`status` text NOT NULL,
	`decision` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	CONSTRAINT `fk_review_items_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_review_items_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_review_items_related_question_id_questions_id_fk` FOREIGN KEY (`related_question_id`) REFERENCES `questions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY,
	`question_id` text NOT NULL,
	`book_id` text NOT NULL,
	`set_name` text NOT NULL,
	`number` integer NOT NULL,
	`page` integer NOT NULL,
	`book_key` text,
	`explanation` text,
	`book_label` text,
	`merged` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_sources_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_sources_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `books` ADD `run_cap` real;--> statement-breakpoint
CREATE UNIQUE INDEX `parts_question_position` ON `parts` (`question_id`,`position`);--> statement-breakpoint
CREATE INDEX `questions_hash` ON `questions` (`normalized_hash`);--> statement-breakpoint
CREATE INDEX `questions_status` ON `questions` (`status`);--> statement-breakpoint
CREATE INDEX `review_items_status` ON `review_items` (`status`);--> statement-breakpoint
CREATE INDEX `review_items_question` ON `review_items` (`question_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_items_page` ON `review_items` (`book_id`,`page`);--> statement-breakpoint
CREATE UNIQUE INDEX `sources_book_item` ON `sources` (`book_id`,`set_name`,`number`);--> statement-breakpoint
CREATE INDEX `sources_question` ON `sources` (`question_id`);
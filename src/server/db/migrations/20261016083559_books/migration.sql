CREATE TABLE `book_map_proposals` (
	`id` text PRIMARY KEY,
	`book_id` text NOT NULL,
	`ranges` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_book_map_proposals_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `book_maps` (
	`book_id` text NOT NULL,
	`version` integer NOT NULL,
	`ranges` text NOT NULL,
	`confirmed_at` integer NOT NULL,
	CONSTRAINT `book_maps_pk` PRIMARY KEY(`book_id`, `version`),
	CONSTRAINT `fk_book_maps_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `book_pages` (
	`book_id` text NOT NULL,
	`number` integer NOT NULL,
	`text` text NOT NULL,
	`has_text` integer NOT NULL,
	`route` text NOT NULL,
	`survey` text,
	CONSTRAINT `book_pages_pk` PRIMARY KEY(`book_id`, `number`),
	CONSTRAINT `fk_book_pages_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `books` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`edition` text NOT NULL,
	`official` integer NOT NULL,
	`file_hash` text NOT NULL UNIQUE,
	`file_size` integer NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`page_count` integer,
	`text_pages` integer,
	`scanned_route` text,
	`preview` text,
	`job_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_books_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `book_map_proposals_book` ON `book_map_proposals` (`book_id`);
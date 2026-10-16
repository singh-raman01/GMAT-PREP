ALTER TABLE `book_skips` ADD `map_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `explanation_answer` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `map_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_book_skips` (
	`book_id` text NOT NULL,
	`set_name` text NOT NULL,
	`number` integer NOT NULL,
	`page` integer NOT NULL,
	`reason` text NOT NULL,
	`map_version` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `book_skips_pk` PRIMARY KEY(`book_id`, `page`, `number`),
	CONSTRAINT `fk_book_skips_book_id_books_id_fk` FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_book_skips`(`book_id`, `set_name`, `number`, `page`, `reason`) SELECT `book_id`, `set_name`, `number`, `page`, `reason` FROM `book_skips`;--> statement-breakpoint
DROP TABLE `book_skips`;--> statement-breakpoint
ALTER TABLE `__new_book_skips` RENAME TO `book_skips`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `sources_book_item`;--> statement-breakpoint
CREATE UNIQUE INDEX `sources_book_page_item` ON `sources` (`book_id`,`page`,`number`);
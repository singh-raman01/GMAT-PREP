CREATE TABLE `bank_version` (
	`id` integer PRIMARY KEY,
	`version` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `bank_version` (`id`, `version`) VALUES (1, 0);--> statement-breakpoint
CREATE TRIGGER `bank_version_questions_insert` AFTER INSERT ON `questions` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_questions_update` AFTER UPDATE ON `questions` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_questions_delete` AFTER DELETE ON `questions` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_parts_insert` AFTER INSERT ON `parts` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_parts_update` AFTER UPDATE ON `parts` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_parts_delete` AFTER DELETE ON `parts` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_options_insert` AFTER INSERT ON `options` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_options_update` AFTER UPDATE ON `options` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_options_delete` AFTER DELETE ON `options` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_option_notes_insert` AFTER INSERT ON `option_notes` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_option_notes_update` AFTER UPDATE ON `option_notes` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_option_notes_delete` AFTER DELETE ON `option_notes` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_sources_insert` AFTER INSERT ON `sources` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_sources_update` AFTER UPDATE ON `sources` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_sources_delete` AFTER DELETE ON `sources` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_books_insert` AFTER INSERT ON `books` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_books_update` AFTER UPDATE ON `books` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;--> statement-breakpoint
CREATE TRIGGER `bank_version_books_delete` AFTER DELETE ON `books` BEGIN UPDATE `bank_version` SET `version` = `version` + 1 WHERE `id` = 1; END;

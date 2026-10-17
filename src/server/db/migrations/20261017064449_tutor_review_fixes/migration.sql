ALTER TABLE `review_items` ADD `kind` text DEFAULT 'check' NOT NULL;--> statement-breakpoint
ALTER TABLE `tutor_messages` ADD `answer_key` text;--> statement-breakpoint
ALTER TABLE `tutor_messages` ADD `repeats` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tutor_messages` ADD `asked_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `tutor_messages_profile_question`;--> statement-breakpoint
CREATE INDEX `llm_calls_task` ON `llm_calls` (`task`,`created_at`);--> statement-breakpoint
CREATE INDEX `tutor_messages_asked` ON `tutor_messages` (`profile_id`,`question_id`,`asked_at`);--> statement-breakpoint
UPDATE `review_items` SET `kind` = 'report' WHERE EXISTS (SELECT 1 FROM json_each(`review_items`.`reasons`) WHERE json_extract(json_each.value, '$.code') = 'problem-report');--> statement-breakpoint
UPDATE `tutor_messages` SET `asked_at` = `created_at`;--> statement-breakpoint
UPDATE `review_items` SET `status` = 'decided', `decided_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000, `decision` = (SELECT CASE WHEN `questions`.`merged_into` IS NULL THEN 'withdrawn' ELSE 'merged' END FROM `questions` WHERE `questions`.`id` = `review_items`.`question_id`) WHERE `status` = 'open' AND `question_id` IN (SELECT `id` FROM `questions` WHERE `status` = 'withdrawn');
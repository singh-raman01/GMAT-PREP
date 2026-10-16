CREATE TABLE `mistake_labels` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`response_id` text NOT NULL,
	`part` integer NOT NULL,
	`mistake_type` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_mistake_labels_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_mistake_labels_response_id_responses_id_fk` FOREIGN KEY (`response_id`) REFERENCES `responses`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `mistake_labels_profile` ON `mistake_labels` (`profile_id`);
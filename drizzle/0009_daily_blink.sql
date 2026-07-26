ALTER TABLE `categories` ADD `target_type` text DEFAULT 'monthly' NOT NULL;--> statement-breakpoint
ALTER TABLE `categories` ADD `target_date` text;
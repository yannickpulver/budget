ALTER TABLE `categories` ADD `hidden_from` text;--> statement-breakpoint
UPDATE `categories` SET `hidden_from` = '0000-01' WHERE `hidden` = 1;--> statement-breakpoint
ALTER TABLE `categories` DROP COLUMN `hidden`;

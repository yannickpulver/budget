CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`count` integer NOT NULL,
	`committed_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);

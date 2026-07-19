CREATE TABLE `payee_icons` (
	`payee` text PRIMARY KEY NOT NULL,
	`domain` text,
	`status` text NOT NULL,
	`fetched_at` text NOT NULL
);

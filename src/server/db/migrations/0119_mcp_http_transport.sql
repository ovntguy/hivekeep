ALTER TABLE `mcp_servers` ADD `transport` text DEFAULT 'stdio' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `url` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `headers` text;

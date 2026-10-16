ALTER TABLE "oauth_clients" DROP CONSTRAINT "oauth_clients_type_chk";--> statement-breakpoint
ALTER TABLE "oauth_clients" DROP CONSTRAINT "oauth_clients_scope_allowlist_chk";--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "operator" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_type_chk" CHECK ("oauth_clients"."client_type" in ('public'::text, 'confidential'::text));--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_scope_allowlist_chk" CHECK ("oauth_clients"."allowed_scopes" <@ ARRAY['openid'::text, 'profile'::text, 'email'::text]::text[]);
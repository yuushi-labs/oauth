CREATE TABLE "oauth_social_claims" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"provider_email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_owner_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_social_claims_provider_chk" CHECK ("oauth_social_claims"."provider" in ('google'::text, 'github'::text, 'discord'::text))
);
--> statement-breakpoint
ALTER TABLE "oauth_social_claims" ADD CONSTRAINT "oauth_social_claims_email_owner_id_users_id_fk" FOREIGN KEY ("email_owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_social_claims_expires_at_idx" ON "oauth_social_claims" USING btree ("expires_at");
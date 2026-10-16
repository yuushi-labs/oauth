CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"client_type" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"allowed_scopes" text[] DEFAULT ARRAY['openid']::text[] NOT NULL,
	"web_origins" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"secret_ciphertext" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "oauth_clients_type_chk" CHECK ("oauth_clients"."client_type" in ('public', 'confidential')),
	CONSTRAINT "oauth_clients_openid_required_chk" CHECK ('openid' = ANY("oauth_clients"."allowed_scopes")),
	CONSTRAINT "oauth_clients_scope_allowlist_chk" CHECK ("oauth_clients"."allowed_scopes" <@ ARRAY['openid', 'profile', 'email']::text[]),
	CONSTRAINT "oauth_clients_secret_type_chk" CHECK (("oauth_clients"."client_type" = 'public' AND "oauth_clients"."secret_ciphertext" IS NULL) OR ("oauth_clients"."client_type" = 'confidential' AND "oauth_clients"."secret_ciphertext" IS NOT NULL)),
	CONSTRAINT "oauth_clients_active_revoked_chk" CHECK (NOT "oauth_clients"."active" OR "oauth_clients"."revoked_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "oidc_artifacts" (
	"model" text NOT NULL,
	"id_hash" text NOT NULL,
	"payload_ciphertext" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_artifacts_pk" PRIMARY KEY("model","id_hash")
);
--> statement-breakpoint
CREATE TABLE "oidc_user_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "oidc_user_grants" ADD CONSTRAINT "oidc_user_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_user_grants" ADD CONSTRAINT "oidc_user_grants_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_clients_active_idx" ON "oauth_clients" USING btree ("active");--> statement-breakpoint
CREATE INDEX "oidc_artifacts_expiry_idx" ON "oidc_artifacts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_user_grants_user_client_uniq" ON "oidc_user_grants" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "oidc_user_grants_user_idx" ON "oidc_user_grants" USING btree ("user_id","revoked_at");
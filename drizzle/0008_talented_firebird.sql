CREATE TABLE "oidc_user_subjects" (
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_user_subjects_pk" PRIMARY KEY("user_id","client_id"),
	CONSTRAINT "oidc_user_subjects_subject_unique" UNIQUE("subject")
);
--> statement-breakpoint
ALTER TABLE "oidc_user_subjects" ADD CONSTRAINT "oidc_user_subjects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_user_subjects" ADD CONSTRAINT "oidc_user_subjects_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
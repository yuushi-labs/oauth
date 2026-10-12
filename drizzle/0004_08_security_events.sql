CREATE TABLE "security_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"event_type" text NOT NULL,
	"ip" text,
	"ip_masked" text,
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_events_event_type_created_at_idx" ON "security_events" USING btree ("event_type", "created_at");--> statement-breakpoint
CREATE INDEX "security_events_user_id_created_at_idx" ON "security_events" USING btree ("user_id", "created_at");

ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_target_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ALTER COLUMN "actor_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "actor_username" text;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "target_username" text;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
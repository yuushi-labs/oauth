ALTER TABLE "oidc_artifacts" ADD COLUMN "grant_id_hash" text;--> statement-breakpoint
ALTER TABLE "oidc_artifacts" ADD COLUMN "uid_hash" text;--> statement-breakpoint
ALTER TABLE "oidc_artifacts" ADD COLUMN "user_code_hash" text;--> statement-breakpoint
CREATE INDEX "oidc_artifacts_grant_idx" ON "oidc_artifacts" USING btree ("model","grant_id_hash");--> statement-breakpoint
CREATE INDEX "oidc_artifacts_uid_idx" ON "oidc_artifacts" USING btree ("model","uid_hash");--> statement-breakpoint
CREATE INDEX "oidc_artifacts_user_code_idx" ON "oidc_artifacts" USING btree ("model","user_code_hash");
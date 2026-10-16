ALTER TABLE "rate_limit_hits" RENAME COLUMN "count" TO "failed_count";
--> statement-breakpoint
ALTER TABLE "rate_limit_hits" ALTER COLUMN "failed_count" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "rate_limit_hits" ADD COLUMN "generation" bigint DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE "rate_limit_reservations" (
	"reservation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"generation" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rate_limit_reservations" ADD CONSTRAINT "rate_limit_reservations_key_rate_limit_hits_key_fk" FOREIGN KEY ("key") REFERENCES "rate_limit_hits"("key") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "rate_limit_reservations_key_generation_idx" ON "rate_limit_reservations" USING btree ("key", "generation");
--> statement-breakpoint
CREATE INDEX "rate_limit_reservations_expires_at_idx" ON "rate_limit_reservations" USING btree ("expires_at");

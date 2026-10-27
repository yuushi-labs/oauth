ALTER TABLE "user_preferences" ALTER COLUMN "timezone" SET DEFAULT 'Asia/Tokyo';--> statement-breakpoint
UPDATE "user_preferences" SET "timezone" = 'Asia/Tokyo' WHERE "timezone" = 'UTC';
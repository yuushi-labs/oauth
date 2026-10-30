ALTER TABLE "roles" DROP CONSTRAINT "roles_name_unique";--> statement-breakpoint
INSERT INTO "roles" ("id", "name", "description") VALUES
  ('role_user', 'user', '一般ユーザー'),
  ('role_moderator', 'moderator', 'モデレーター（将来拡張）'),
  ('role_admin', 'admin', '管理者'),
  ('role_superadmin', 'superadmin', '最上位管理者（将来拡張）')
ON CONFLICT ("id") DO UPDATE SET "name" = excluded."name", "description" = excluded."description";--> statement-breakpoint
UPDATE "users" SET "role_id" = CASE "role_id"
  WHEN 'user' THEN 'role_user'
  WHEN 'moderator' THEN 'role_moderator'
  WHEN 'admin' THEN 'role_admin'
  WHEN 'superadmin' THEN 'role_superadmin'
  ELSE "role_id" END
WHERE "role_id" IN ('user', 'moderator', 'admin', 'superadmin');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission", "created_at")
SELECT CASE rp."role_id"
         WHEN 'user' THEN 'role_user'
         WHEN 'moderator' THEN 'role_moderator'
         WHEN 'admin' THEN 'role_admin'
         WHEN 'superadmin' THEN 'role_superadmin'
         ELSE rp."role_id" END,
       rp."permission", rp."created_at"
  FROM "role_permissions" rp
 WHERE rp."role_id" IN ('user', 'moderator', 'admin', 'superadmin')
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "role_permissions" WHERE "role_id" IN ('user', 'moderator', 'admin', 'superadmin');--> statement-breakpoint
DELETE FROM "roles" WHERE "id" IN ('user', 'moderator', 'admin', 'superadmin');--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_name_unique" UNIQUE ("name");

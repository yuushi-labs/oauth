-- メール送受信による認証を廃止したため、確認メール待ちで停止している既存ユーザーを有効化する。
-- 新規登録は即時 active / email_verified = true で作られる（D-40-01）。過去に pending_email で
-- 止まったままのユーザーは確認手段が無くなるため、ここで一度だけ有効化する。
-- 停止・削除済みのユーザーは変更しない。
UPDATE "users"
   SET "email_verified" = true,
       "status" = 'active',
       "updated_at" = now()
 WHERE "status" = 'pending_email'
   AND "email_verified" = false;

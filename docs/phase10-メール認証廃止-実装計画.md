# Phase 10 — メール送受信による認証の廃止（実装計画）

## 背景

メールの送受信が利用できなくなり、以下がすべて機能しなくなった。

- 登録直後の確認メール（`email_verified` が true にならず、`pending_email` のまま停止）
- パスワード再設定（`/forgot-password` → `/reset-password`）
- メールアドレス変更の確認リンク
- メール確認による退会

ユーザー要望は次の 3 点。

1. メールによる認証を**サイトからは廃止**する（**内部実装は残置**して復旧可能にする）
2. 「パスワードをお忘れですか？」を押したら **Discord（`@yuushi_2024`）へ連絡するモーダル**を出す。メール認証は行わない
3. 本人確認は**パスワード入力・Passkey・2FA** に限定する（メールは本人確認手段に使わない）

## 決定事項（D-40-xx）

| ID | 論点 | 決定 | 理由 |
|---|---|---|---|
| D-40-01 | 登録後の有効化 | **登録は確認メールを送らず即時有効化**する（`email_verified = true` / `status = 'active'`）。`register` はセッションを発行しない（従来どおり） | 確認メールが届かない以上、`pending_email` で止める意味が無い。ログインは別 API のまま維持する |
| D-40-02 | ログイン時の email 確認 | **`email_verified` を判定しない**（403 `EMAIL_NOT_VERIFIED` の分岐を削除）。OAuth の「検証済み email が無ければ登録しない」（§11.2 / D-31-08）は**維持**する | メールは本人確認に使わない。OAuth provider が返す `verified` は外部サービス側の保証であり、これまでどおり採用する |
| D-40-03 | パスワード忘れ | ログイン画面の導線を**Discord 連絡モーダル**に差し替える。連絡先は `NEXT_PUBLIC_SUPPORT_DISCORD`（既定 `@yuushi_2024`）。本人確認のうえ運営が対応する | メール経由のセルフサービス復旧を提供できないため（§54 / §55 の手動復旧フローに相当） |
| D-40-04 | メール系 UI の廃止 | `/forgot-password`・`/reset-password`・`/verify-email`・`/email-change/confirm`・`/account/delete/confirm` の**画面を削除**し 404 にする。`/settings/security` のメール変更カード、`/settings/account` の「メール確認による退会」も削除。本人確認はパスワード / 2FA / Passkey のみ | メールを本人確認・復旧手段にしない方針を UI でも徹底する |
| D-40-05 | 内部実装の残置 | API / lib（`verify-email`、`email/change/confirm`、`account/delete/confirm`、`password/forgot`・`reset`、`resend-verification`、メール送信テンプレート）は**残置**する。画面へ転送する GET ハンドラのみ撤去し、POST のトークン消費ロジックは保持する | メール復旧時に再有効化できるようにする。ただし UI からの導線が無いため到達不能 |
| D-40-06 | OIDC の `email_verified` | **既知の制約として許容**する。`email` scope と `email_verified: true` claim は据え置く。メール所有確認の手段が無くなったため、`email_verified` は「メール所有の証明」ではなく「**`users.email` を本人がアカウント識別子として設定した値**」を意味する。`email` scope を要求する RP は同意画面で明示的に共有に同意する必要がある（§69.5） | `email` scope を落とすと自作サービスの連携が壊れる（ユーザー要望「サイトからはなくすだけ」を超える）。外部 RP がメール一致で自動連携する設計かどうかは本リポジトリの外の関心事で、本システムが保証できるのは上記の意味まで。**メールを復旧したら `email_verified` の所有確認を戻すこと**（本計画の差分を戻す） |

## 実装内容

- `src/config/app.ts` — `SUPPORT_DISCORD`（`NEXT_PUBLIC_SUPPORT_DISCORD`、既定 `@yuushi_2024`）を追加
- `src/messages/ja.ts` — `auth.registerDone`（登録完了文言）と、忘れダイアログ用の `auth.forgotDialogTitle` / `forgotDialogBody` / `forgotDialogHint` を追加
- `src/app/api/auth/register/route.ts` — `email_verified: true` / `status: 'active'` で作成。応答文言は `m('auth.registerDone')`
- `src/app/api/auth/login/route.ts` — 403 `EMAIL_NOT_VERIFIED` 分岐を削除
- `src/app/api/auth/2fa/setup`・`passkey/register/options`・`passkey/login/verify`・`password/set` — `email_verified` のゲートを削除
- `src/app/auth-form.tsx` — 登録後は `/login?registered=1` へ遷移し `auth.registerDone` を表示（`register` はセッションを発行しないため `/` では認証ガードで弾かれる）。忘れダイアログを追加（`supportDiscord` / `registered` をサーバ側で解決して props で受ける・BUG-11）
- `src/app/{login,register}/page.tsx` — `supportDiscord={SUPPORT_DISCORD}` を渡す
- `src/components/settings/{account-delete-panel,security-overview}.tsx` / `src/app/settings/{account,security}/page.tsx` — メール系の本人確認・変更 UI を削除
- `src/middleware.ts` — `no-store` 対象から廃止画面を外す（`/login`・`/register`・`/settings` のみ）
- `drizzle/0024_email_auth_removal.sql` — 既存の `pending_email` ユーザーを一度だけ有効化する（データ修復 migration）

## DoD

- [x] 登録が確認メールを送らず即時 `active` / `email_verified = true` になる（`register-duplicate` / `auth-journey`）
- [x] 未確認 email でもログインできる（`auth` / `deleted-account-login`）
- [x] 未確認 email でも 2FA setup / Passkey 登録ができる（`2fa` / `webauthn-register`）
- [x] 廃止画面（`/forgot-password`・`/reset-password`・`/verify-email`・`/email-change/confirm`）が 404（`app-server` e2e）
- [x] パスワード忘れの導線が Discord モーダルになる（`auth-form.tsx`）
- [x] メール確認による退会・メール変更は UI から消え、内部実装のみ残る（`account-deletion-flow` / `auth-email-url`）
- [x] `pnpm lint` / `pnpm typecheck` / `pnpm test` green
- [x] `pnpm db:verify-migrations`（up / down / 往復 / restore）green

## 補足

- メール送信の内部実装（`src/lib/auth/email/*`）とトークン系 API は残置している。復旧する場合は、画面の再作成と `email_verified` ゲートの再有効化が必要（本計画の差分を戻す）。
- `security_events` の `email_verified` / `email_changed` / `account_deletion_requested` などのイベント種別は変更しない（残置実装が記録しうるため）。

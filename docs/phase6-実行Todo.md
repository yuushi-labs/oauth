# Phase 6 実行 Todo — Passkey / WebAuthn

> 計画: `docs/phase6-passkey-webauthn-実装計画.md`（v1.0 / D-34-01〜D-34-16）
> 正本: `実装Todo.md` の P6 セクションを、実装単位まで展開した実行用チェックリスト
> 状態: **完了（2026-10-25）**。全チェック済み。
> 進め方: **上から順に**。各タスクは「実装 → テスト green → チェック」で閉じる。
> ★ は DoD 直結。**先に落ちるテストを書いてから実装する**（R1 / R2 / R5 の対策）。

---

## 0. 事前準備

- [x] `pnpm install` が通ることを確認
- [x] `pnpm lint && pnpm typecheck && pnpm test` が green であることを確認（**Phase 6 着手前のベースライン**。Phase 5 完了状態）
- [x] `pnpm db:verify-migrations` が green（最新は `0017`）
- [x] `.env` に `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ALLOWED_ORIGINS` を用意（**dev = `localhost` / `http://localhost:3000`**）
- [x] ブランチを切る（例: `feat/phase6-passkey-webauthn`）
- [x] **実機の Passkey を用意**（手動確認用。Touch ID / Windows Hello / セキュリティキー）
- [x] `@simplewebauthn/*` のバージョンを確認（`14.0.3` / `14.0.0`。Node ≥20 必須＝本リポジトリは v24）

---

## 1. P6-A: 基盤

### P6-A-01 — `@simplewebauthn` の導入（0.3h）

- [x] `package.json` の `dependencies` に `"@simplewebauthn/server": "^14.0.3"` を追加
- [x] `package.json` の `dependencies` に `"@simplewebauthn/browser": "^14.0.0"` を追加
- [x] `pnpm install`
- [x] `pnpm typecheck` が通る
- [x] 完了条件: `import { generateRegistrationOptions } from '@simplewebauthn/server'` の型が解決する
- [x] **自作の WebAuthn 検証を書いていない**ことを確認（D-34-03 / §67）

### P6-A-02 — migration と schema（1.2h）

- [x] `drizzle/0018_passkey.sql` を作成（計画 §6.1 の SQL をそのまま）
- [x] `src/lib/db/schema.ts` に `webauthnCredentials` / `webauthnChallenges` を追加（計画 §6.3）
- [x] `bigint('sign_count', { mode: 'number' })` を**明示**
- [x] `jsonb('transports').$type<string[]>()` を**明示**
- [x] `src/lib/util/id.ts` の `ID_PREFIXES` に **`wac`**（credential）/ **`wch`**（challenge）を追加（D-22）
- [x] `scripts/verify-migrations.ts` に期待値 5 件を追加（計画 §6.4）
- [x] `pnpm db:generate` を実行し、生成差分が無い（= 手書き SQL と一致する）ことを確認
- [x] `pnpm db:migrate` が通る
- [x] `pnpm db:verify-migrations` が green（up / down / 往復 / restore）
- [x] 完了条件: `pnpm db:verify-migrations` green

### P6-A-03★ — WebAuthn 設定と許可リスト検証（1.2h）

- [x] `src/test/unit/passkey-config.test.ts` を**先に**書く
  - [x] dev（`NODE_ENV=development`）で `rpID='localhost'` / `allowedOrigins=['http://localhost:3000']` が解決される
  - [x] prod で `WEBAUTHN_RP_ID` 未設定 → throw
  - [x] prod で `rpID === 'localhost'` → throw
  - [x] prod で許可 origin に `localhost` → throw
  - [x] 許可 origin が絶対 URL でない → throw
  - [x] 各 origin の host が `rpID` と一致または `rpID` を末尾に持たない → throw
  - [x] `resolveWebauthnConfig` が **request / headers を受け取らない**（引数に無い）
- [x] `src/lib/env.ts` の zod に `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ALLOWED_ORIGINS` を追加（dev/test 既定値・prod 必須）
- [x] `src/lib/auth/passkey/config.ts` を実装（`resolveWebauthnConfig` / `getWebauthnConfig`）
- [x] `src/test/setup.ts` にテスト既定値を注入
- [x] 完了条件: `passkey-config.test.ts` green。`config.ts` が `request` / `headers` を参照していない

### P6-A-04 — クエリ層（1.4h）

- [x] `src/test/integration/webauthn-queries.test.ts` を**先に**書く（実 DB）
  - [x] `advanceSignCount` が `newCounter > 0` で単調増加のみ進める（同じ値・小さい値は 0 行）
  - [x] `advanceSignCount` が `newCounter === 0` で `last_used_at` のみ更新する（D-34-06）
  - [x] `bigint` の往復で型が数値
  - [x] `deleteCredential` が owner 以外を削除しない（0 行）
  - [x] `findCredentialByCredentialId` が削除済み user の credential を返さない
  - [x] `jsonb` の `transports` が `string[]` で往復する
- [x] `src/lib/db/queries/webauthn.ts` を実装
  - [x] `insertCredential` / `listCredentialsByUser` / `countCredentialsByUser`
  - [x] `findCredentialByIdForUser` / `findCredentialByCredentialId` / `deleteCredential`
  - [x] `advanceSignCount`（2 経路・**単文 UPDATE**）
  - [x] `insertChallenge`
- [x] **read → 判定 → write になっていないことを目視レビュー**（R2）
- [x] 完了条件: 統合テスト green

### P6-A-05★ — challenge の 1 回限り消費（1.0h）

- [x] `src/test/unit/passkey-challenge.test.ts` を**先に**書く
  - [x] `issueChallenge` が `wch_` の id と 32 バイト base64url challenge を返す
  - [x] 同じ challenge を 2 回 `consumeChallenge` → 2 回目は `null`
  - [x] 期限切れ（`vi.setSystemTime` で 6 分進める）→ `null`
  - [x] `type` 不一致 → `null`
  - [x] 他人の `user_id` の challenge → `null`
- [x] `src/lib/auth/passkey/challenge.ts` を実装
  - [x] `CHALLENGE_TTL_MS = 5 * 60 * 1000`
  - [x] `issueChallenge`（`generateChallenge()` ＋ insert）
  - [x] `consumeChallenge`（**単文 UPDATE の更新行数 = 1**・D-34-05）
- [x] 完了条件: `passkey-challenge.test.ts` green。`consumeChallenge` が単文 SQL

### P6-A-06 — WebAuthn ラッパ（2.0h）

- [x] `src/test/unit/passkey-registration.test.ts` を**先に**書く
  - [x] options の `rp.id === config.rpID` / `rp.name === config.rpName`
  - [x] **`user.id` が固定**（2 回呼んでも同じ `user.id` が base64url で入る・R4）
  - [x] `excludeCredentials` に既存 credential が入る
  - [x] `authenticatorSelection.residentKey === 'preferred'` / `userVerification === 'preferred'`
  - [x] `attestation === 'none'`
- [x] `src/test/unit/passkey-authentication.test.ts` を**先に**書く
  - [x] credential を渡さないと `allowCredentials` が空
  - [x] credential を渡すと `{ id, transports }` が入る
  - [x] `userVerification === 'preferred'`
- [x] `src/lib/auth/passkey/registration.ts` を実装（`generatePasskeyRegistrationOptions` / `verifyPasskeyRegistration`）
- [x] `src/lib/auth/passkey/authentication.ts` を実装（`generatePasskeyAuthenticationOptions` / `verifyPasskeyAuthentication`）
- [x] `requireUserVerification: false` を明示（D-34-04）
- [x] 検証失敗は `ApiError('INVALID_CODE', ...)` に丸める
- [x] 完了条件: 両テスト green

### P6-A-07★ — `webauthn-mock.ts`（実鍵で署名・1.5h）

- [x] `src/test/helpers/webauthn-mock.ts` を作成
  - [x] **P-256 の鍵ペア**を生成する（`node:crypto` の `generateKeyPairSync('ec', { namedCurve: 'P-256' })`）
  - [x] `clientDataJSON`（`type` / `challenge` / `origin`）を**仕様どおり**組み立てる
  - [x] `authenticatorData`（`rpIdHash` = SHA-256(rpID) / flags / signCount / attestedCredentialData）を組み立てる
  - [x] `attestationObject`（`fmt: 'none'`）を CBOR で組み立てる
  - [x] `signature` を実鍵で署名する
  - [x] **`@simplewebauthn/server` の `verifyRegistrationResponse` / `verifyAuthenticationResponse` を単体で通す**ことを最初に確認する（R5）
  - [x] `origin` / `rpID` / `challenge` / `signCount` を**わざと外せる**オプションを付ける
- [x] 完了条件: mock が作った応答が `verify*` を通る。`origin` / `rpID` を外すと throw する
- [x] **このタスクが green にならないと実 HTTP テストが書けない**。最優先で潰す

### P6-A-08 — 検証スキーマ・redaction・prefix（0.3h）

- [x] `src/lib/validate/passkey.ts` を作成（計画 §7.3.6）
- [x] `src/lib/util/logger.ts` の `SENSITIVE_KEYS` に追加（D-34-14）: `credentialId` / `publicKey` / `attestationObject` / `authenticatorData` / `clientDataJSON` / `signature` / `challenge`
- [x] `src/test/security/log-redaction.test.ts` に上記のケースを追加
- [x] `src/test/unit/oauth-client-boundary.test.ts` の `SERVER_ONLY_MODULES` に `@/lib/auth/passkey/config` / `@/lib/db/queries/webauthn` を追加（BUG-11）
- [x] 完了条件: `log-redaction.test.ts` と `oauth-client-boundary.test.ts` green

---

## 2. P6-B: API とフロー

### P6-B-01 — `POST /passkey/register/options`（1.0h）

- [x] `src/test/security/webauthn-register.test.ts` を**先に**書き始める（options 部分）
  - [x] 再認証なし → 401 `REAUTH_REQUIRED`
  - [x] 未確認 email → 403 `EMAIL_NOT_VERIFIED`
  - [x] 成功 → `options` と `challenge_id` が返る
- [x] `src/app/api/auth/passkey/register/options/route.ts` を実装
  - [x] `withAuthPipeline({ requireAuth: true, requireReauth: true })`
  - [x] `email_verified` / `status === 'active'` チェック（D-34-02）
  - [x] `passkeyIp(ip)` のレート制限
  - [x] `issueChallenge(registration, user.id)`
- [x] 完了条件: options 部分 green

### P6-B-02 — `POST /passkey/register/verify`（1.4h）

- [x] `webauthn-register.test.ts` に verify のケースを追加
  - [x] 正しい応答 → credential が保存される（`public_key` が base64url）
  - [x] 同じ credential の二重登録 → 400
  - [x] `security_events` に `passkey_added` が記録される
  - [x] 通知メールが送られる（best-effort。失敗しても 200）
  - [x] `device_name` 未指定なら UA から導出される
- [x] `src/app/api/auth/passkey/register/verify/route.ts` を実装
  - [x] `consumeChallenge(challenge_id, 'registration', user.id)` → 失敗は 400
  - [x] `verifyPasskeyRegistration` → `insertCredential`
  - [x] `recordSecurityEvent('passkey_added', ...)` ＋ 通知
- [x] 完了条件: `webauthn-register.test.ts` green

### P6-B-03 — `POST /passkey/login/options`（0.8h）

- [x] `src/test/security/webauthn-login.test.ts` を**先に**書き始める（options 部分）
  - [x] **セッション無しで 200** が返る
  - [x] `options.allowCredentials` が**空**（discoverable）
  - [x] `challenge_id` が返る
- [x] `src/app/api/auth/passkey/login/options/route.ts` を実装
  - [x] `withAuthPipeline({ requireAuth: false })`（D-34-07）
  - [x] `passkeyIp(ip)` のレート制限
  - [x] `issueChallenge(authentication, null)`
- [x] 完了条件: options 部分 green

### P6-B-04★ — `POST /passkey/login/verify`（1.8h）

- [x] `webauthn-login.test.ts` に verify のケースを追加
  - [x] 正しい応答 → 200 ＋ **新しいセッション Cookie**（D-34-07）
  - [x] 同じ `challenge_id` の 2 回目 → 400 `INVALID_CODE`
  - [x] 削除済み credential → 400
  - [x] suspended / deleted user → 403 `ACCOUNT_SUSPENDED`
  - [x] `sign_count` 後退 → 400（`webauthn-signcount` で詳細化）
  - [x] `security_events` に `login_success`（`method='passkey'`）
- [x] `src/app/api/auth/passkey/login/verify/route.ts` を実装
  - [x] `consumeChallenge(challenge_id, 'authentication', null)`
  - [x] `findCredentialByCredentialId` → user の状態再確認
  - [x] `verifyPasskeyAuthentication` → **`advanceSignCount`（atomic）**
  - [x] `createSession` ＋ `setSessionCookie` ＋ `setAnonCookie`
  - [x] `recordSecurityEvent` ＋ 新規デバイス通知
- [x] 完了条件: `webauthn-login.test.ts` green

### P6-B-05 — `GET /passkey`（0.6h）

- [x] `webauthn-register.test.ts`（または専用ケース）に一覧のテストを追加
  - [x] `id` / `device_name` / `created_at` / `last_used_at` が返る
  - [x] **`credential_id` / `public_key` が返らない**（§45）
- [x] `src/app/api/auth/passkey/route.ts` を実装（`withAuthPipeline({ requireAuth: true })`）
- [x] `settingsUser(user.id)` のレート制限
- [x] 完了条件: green

### P6-B-06 — `DELETE /passkey/{id}`（1.4h）

- [x] `src/test/security/passkey-reauth.test.ts` を**先に**書く（削除部分）
  - [x] 再認証なし → 401 `REAUTH_REQUIRED`
  - [x] 再認証あり（パスワード＋コード）→ 削除 ＋ `passkey_removed` ＋ 通知
  - [x] **最後のログイン手段**（PW 無し・Passkey 1 件・TOTP 無効）→ 409 `LAST_LOGIN_METHOD`
  - [x] 他人の credential → 404 `INVALID_TOKEN`
  - [x] 存在しない id → 404
- [x] `src/app/api/auth/passkey/[id]/route.ts` を実装
  - [x] `requireStrongReauth({ user, session, body })`（D-34-08）
  - [x] 最後のログイン手段チェック（`LAST_LOGIN_METHOD`）
  - [x] `deleteCredential(id, user.id)`（owner 確認・§49）
  - [x] `recordSecurityEvent('passkey_removed', ...)` ＋ 通知
- [x] 完了条件: 削除部分 green

### P6-B-07 — `POST /reauth/passkey/options`（0.8h）

- [x] `passkey-reauth.test.ts` に再認証 options のケースを追加
  - [x] 自分の credential が `allowCredentials` に入る
  - [x] 未認証 → 401 `SESSION_EXPIRED`
- [x] `src/app/api/auth/reauth/passkey/options/route.ts` を実装
  - [x] `withAuthPipeline({ requireAuth: true })`
  - [x] `settingsUser(user.id)` のレート制限
  - [x] `issueChallenge(authentication, user.id)`（**user_id 付き**・D-34-12）
- [x] 完了条件: green

### P6-B-08★ — 強い再認証への Passkey 差し込み（1.5h）

- [x] `src/test/unit/strong-reauth.test.ts` を更新
  - [x] 入力を `{ user, session, body }` に変更
  - [x] `availableStrongReauthMethods(user)` が Passkey 有りで `['password', 'passkey']`、無しで `['password']`
  - [x] `passkeyVerifier` を足すと Passkey の assertion で通る（Phase 5 の布石を実証）
  - [x] Passkey 検証失敗 ＋ 再認証未了 → 401 `REAUTH_REQUIRED`
- [x] `src/lib/auth/strong-reauth.ts` を変更
  - [x] `StrongReauthInput` を `{ user, session, body }` に
  - [x] `readCode(body)` / `readPasskeyAssertion(body)` を追加
  - [x] `passkeyVerifier` を実装（`consumeChallenge` → `verifyPasskeyAuthentication` → `advanceSignCount`）
  - [x] `verifiers = [passwordAndCodeVerifier, passkeyVerifier]`
  - [x] `availableStrongReauthMethods` を**非同期化**（`countCredentialsByUser`）
- [x] `src/app/api/auth/2fa/disable/route.ts` を `requireStrongReauth({ user, session, body })` に小改修（**判定ロジックは不変**）
- [x] `src/app/api/auth/2fa/recovery-codes/regenerate/route.ts` も同様
- [x] `src/app/api/auth/2fa/route.ts`（`GET`）の `strong_reauth_methods` を `await` に更新
- [x] `src/app/settings/security/page.tsx` の `availableStrongReauthMethods` 呼び出しを `await` に更新
- [x] 完了条件: `strong-reauth.test.ts` green。**2FA の既存テストが green のまま**

### P6-B-09 — 通知メール（0.6h）

- [x] `src/lib/auth/email/deliver.ts` の `EmailKind` に `passkey_change` を追加（D-34-15）
- [x] `src/lib/auth/notifications.ts` に `notifyPasskeyChange` を追加（`sendChangeNotificationEmail` を使う）
  - [x] 本文に **credential ID / 公開鍵 / 署名を入れない**
- [x] `register/verify` / `DELETE` から呼ぶ
- [x] 完了条件: 追加・削除で通知が飛ぶ（best-effort）

### P6-B-10 — challenge の掃除（0.4h）

- [x] `scripts/purge-expired.ts` に `webauthn_challenges` のジョブを追加（D-34-16）
  - [x] `expires_at < now()` または消費後 1 日経過を削除
- [x] `src/test/integration/purge-expired.test.ts` に期待値を追加
- [x] 完了条件: `purge-expired.test.ts` green

---

## 3. P6-C: セキュリティテスト

### P6-C-01★ — challenge 再利用（1.2h）

- [x] `src/test/security/webauthn-challenge-reuse.test.ts` を作成
  - [x] 同じ `challenge_id` で `login/verify` を **2 回**送る → 2 回目 400 `INVALID_CODE`
  - [x] 同じ `challenge_id` で `register/verify` を **2 回**送る → 2 回目 400
  - [x] 期限切れの `challenge_id` → 400
- [x] 完了条件: green（**DoD 直結**）

### P6-C-02★ — origin 不一致（1.0h）

- [x] `src/test/security/webauthn-origin.test.ts` を作成
  - [x] `clientDataJSON.origin` を許可外にして `login/verify` → 400
  - [x] **`Origin` ヘッダを偽装**しても通らない（config を使っているため）
  - [x] 許可リストに複数 origin があるとき、いずれかなら通る
- [x] 完了条件: green（**DoD 直結**）

### P6-C-03★ — rpID 不一致（0.8h）

- [x] `src/test/security/webauthn-rpid.test.ts` を作成
  - [x] `authenticatorData.rpIdHash` を別 rpID のハッシュにして `login/verify` → 400
  - [x] `register/verify` でも同様
- [x] 完了条件: green（**DoD 直結**）

### P6-C-04★ — sign_count（1.2h）

- [x] `src/test/security/webauthn-signcount.test.ts` を作成
  - [x] 保存値より小さい `signCount` → 400
  - [x] 同じ `signCount`（>0）→ 400
  - [x] `newCounter === 0`（カウンタ非対応）→ **200**（`last_used_at` のみ更新・D-34-06）
  - [x] 正常に増える `signCount` → 200 で `sign_count` が更新される
  - [x] **並行送信**（`Promise.all` で 2 本）→ 成功 1 件のみ（atomic 更新）
- [x] 完了条件: green（**DoD 直結**）

### P6-C-05★ — 削除済み credential（0.8h）

- [x] `src/test/security/webauthn-deleted.test.ts` を作成
  - [x] Passkey を削除 → 同じ credential で `login/verify` → 400
  - [x] 削除済み **user** の credential で `login/verify` → 400 / 403
- [x] 完了条件: green（**DoD 直結**）

### P6-C-06 — 再認証と最後の手段（1.0h）

- [x] `passkey-reauth.test.ts` を仕上げる（P6-B-06 で作成済み）
  - [x] Passkey での再認証が `requireStrongReauth` を通る
  - [x] **2FA の無効化が Passkey で通る**（D-34-11）
  - [x] 最後のログイン手段の削除が 409
- [x] 完了条件: green

### P6-C-07 — 既存テストへの追記（0.4h）

- [x] `src/test/security/rate-limit.test.ts` に `RATE_LIMITS.passkey`（30/300_000）を追加
- [x] `src/test/security/security-events-coverage.test.ts` に `passkey/**` ルートの `recordSecurityEvent` を追加
- [x] `src/test/integration/purge-expired.test.ts`（P6-B-10 で追加済み）を再確認
- [x] **静的検査**を追加（計画 §11.3）
  - [x] `passkey/config` / `db/queries/webauthn` がクライアントから import されていない
  - [x] `config.ts` が `request` / `headers` を参照していない
  - [x] `public_key` / `credential_id` を返す応答が無い
- [x] 完了条件: 全 green

---

## 4. P6-D: UI

### P6-D-01 — Passkey パネル（1.6h）

- [x] `src/components/settings/passkey-panel.tsx` を作成
  - [x] 未登録: 「Passkey はまだ登録されていません」＋「Passkey を追加」
  - [x] 登録済み: 一覧（`device_name` / 追加日時 / 最終使用 / 同期バッジ）＋「追加」
  - [x] 削除ボタン → `StrongReauthDialog`
  - [x] **最後のログイン手段**なら削除ボタンを無効化し理由を出す
  - [x] `startRegistration`（`@simplewebauthn/browser`）で Ceremony
- [x] `src/components/settings/security-overview.tsx` の Passkey カードを差し替え。`passkeys` prop を追加
- [x] `src/app/settings/security/page.tsx` で一覧を取得して渡す
- [x] 完了条件: 登録 → 一覧 → 削除が画面で動く

### P6-D-02 — ログインの Passkey ボタン（1.4h）

- [x] `src/components/auth/passkey-login-button.tsx` を作成
  - [x] `startAuthentication`（`@simplewebauthn/browser`）で Ceremony
  - [x] `login/options` → `startAuthentication` → `login/verify` → トップへ
  - [x] 失敗は「パスキーでログインできませんでした。別の方法をお試しください。」
  - [x] `navigator.credentials` 非対応なら `notSupported` を出す
- [x] `src/app/auth-form.tsx` に `passkeyEnabled` 分岐を追加（**サーバ側で判定して props で渡す**・BUG-11）
- [x] `src/app/login/page.tsx` から `passkeyEnabled` を渡す
- [x] 完了条件: Passkey でログインできる

### P6-D-03 — 強い再認証ダイアログの Passkey タブ（1.2h）

- [x] `src/components/settings/strong-reauth-passkey-tab.tsx` を作成
  - [x] `reauth/passkey/options` → `startAuthentication`
  - [x] 本体 API へ `{ passkey, challenge_id }` を送る
- [x] `src/components/settings/strong-reauth-dialog.tsx` に `strong_reauth_methods` でタブを出し分け
  - [x] `'passkey'` が含まれるときだけ Passkey タブ
  - [x] パスワードタブは Phase 5 のまま
- [x] 完了条件: Passkey タブで 2FA 無効化・Passkey 削除が通る

### P6-D-04 — 文言（0.3h）

- [x] `src/messages/ja.ts` に `passkey` セクションを追加（計画 §12.4）
- [x] 完了条件: `pnpm typecheck` green

### P6-D-05 — 後始末（0.5h）

- [x] `security.passkeyCount` / `security.notAvailable` の未使用文言を整理
- [x] `security-overview.tsx` の Passkey カードのコメントを更新
- [x] 完了条件: `pnpm lint` / `pnpm typecheck` green

---

## 5. 統合と仕上げ

- [x] `pnpm lint`（0 errors）
- [x] `pnpm typecheck`
- [x] `pnpm test`（全 green。新規 **13** ファイル＋既存追記）
- [x] `pnpm test:e2e`（OIDC の回帰）
- [x] `pnpm build`
- [x] `pnpm db:verify-migrations`（0018 の up/down/往復）
- [x] 計画 §14.4 の**実機手動確認 9 項目**を実施
- [x] 計画 §14.1〜14.3 の DoD をすべてチェック
- [x] `実装Todo.md` の P6 セクションを更新（新規ファイル **18**・テスト **13**・migration **0018**・工数 **30.4h**。P6-A-01a/b/c は D-34-01 に統合）
- [x] `README.md` に Phase 6 の実装詳細を追記（Phase 4 / 5 と同じ体裁）
- [x] `AGENTS.md` の「現在の到達点」を更新（M6 完了へ）
- [x] PR を作成（タイトル例: `Phase 6: Passkey / WebAuthn`）

---

## 6. 見積もり合計

| 区分 | 工数 |
|---|---|
| P6-A 基盤 | 8.9h |
| P6-B API / フロー | 10.3h |
| P6-C セキュリティテスト | 6.2h |
| P6-D UI | 5.0h |
| **合計** | **30.4h（約 4 日）** |

> 計画 `docs/phase6-passkey-webauthn-実装計画.md` §13 の実装見積もりと同値（**30.4h**）。本書は §13 のタスクを実装順に並べ直したもので、「統合と仕上げ」は各タスクの完了条件に含める（別枠にしない）。
> 計画 `実装計画.md` §15 の「2〜3 日」を**上回る**。増えた主因は **`webauthn-mock.ts`（実鍵署名・1.5h）**、**許可リスト検証 config（1.2h）**、**challenge の 1 回限り消費と atomic sign_count（2.4h）**、**強い再認証への差し込み（1.5h）**。

---

## 7. 進捗メモ（実装時に追記する）

| 日付 | タスク | 状態 | メモ |
|---|---|---|---|
| — | — | — | 未着手 |

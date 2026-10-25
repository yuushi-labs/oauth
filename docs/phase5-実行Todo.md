# Phase 5 実行 Todo — TOTP 2FA + Recovery Codes

> 計画: `docs/phase5-totp-2fa-実装計画.md`（v1.1）
> 正本: `実装Todo.md` の P5 セクションを、実装単位まで展開した実行用チェックリスト
> 状態: **完了（2026-10-24）**
> 進め方: **上から順に**。各タスクは「実装 → テスト green → チェック」で閉じる。
> ★ は DoD 直結。**先に落ちるテストを書いてから実装する**（R1 / R2 の対策）。

---

## 0. 事前準備

- [x] `pnpm install` が通ることを確認（現状の green を確認）
- [x] `pnpm lint && pnpm typecheck && pnpm test` が green であることを確認（**Phase 5 着手前のベースライン**）
- [x] `.env` に `TOTP_ENCRYPTION_KEY`（Base64 32 バイト）があることを確認。無ければ `pnpm secrets:gen`
- [x] ブランチを切る（例: `feat/phase5-totp-2fa`）
- [x] 認証アプリを手元に用意（手動確認用。Google Authenticator / 1Password 等）

---

## 1. P5-A: 基盤

### P5-A-01 — `otpauth` / `qrcode` の導入（0.3h）

- [x] `package.json` の `dependencies` に `"otpauth": "^9.5.2"` と `"qrcode": "^1.5.4"` を追加
- [x] `package.json` の `devDependencies` に `"@types/qrcode": "^1.5.6"` を追加
- [x] `pnpm install`
- [x] `pnpm typecheck` が通る
- [x] 完了条件: `import * as OTPAuth from 'otpauth'` / `import QRCode from 'qrcode'` の型が解決する

### P5-A-02 — migration と schema（1.0h）

- [x] `drizzle/0017_totp.sql` を作成（計画 §6.1 の SQL をそのまま）
- [x] `src/lib/db/schema.ts` に `totp` / `recoveryCodes` を追加（計画 §6.3）
- [x] `bigint('last_used_counter', { mode: 'number' })` を**明示**（R9）
- [x] `scripts/verify-migrations.ts` に期待値 4 件を追加（計画 §6.4）
- [x] `pnpm db:generate` を実行し、生成差分が無い（= 手書き SQL と一致する）ことを確認
- [x] `pnpm db:migrate` が通る
- [x] `pnpm db:verify-migrations` が green（up / down / 往復 / restore）
- [x] 完了条件: `pnpm db:verify-migrations` green

### P5-A-03 — AES-256-GCM 暗号化（0.8h）

- [x] `src/test/unit/totp-crypto.test.ts` を**先に**書く（往復 / nonce ランダム / 改竄で throw / 形式不正で throw）
- [x] `src/lib/auth/totp-crypto.ts` を実装（`encryptTotpSecret` / `decryptTotpSecret`）
- [x] 形式は `v1.<nonce>.<tag>.<ct>`（base64url）。`oidc/crypto.ts` と揃える
- [x] 鍵は `getEnv().TOTP_ENCRYPTION_KEY` から読む（引数で受けない）
- [x] 復号失敗は `ApiError('INTERNAL_ERROR')` に丸める（理由を返さない）
- [x] 完了条件: `totp-crypto.test.ts` green

### P5-A-04★ — TOTP 本体（1.5h）

- [x] `src/test/unit/totp.test.ts` を**先に**書く
  - [x] secret 生成の形式（base32）
  - [x] `otpauth://` URI の構造（issuer / label / digits=6 / period=30 / algorithm=SHA1）
  - [x] **window ±1 の境界**: 30 秒前 OK / 現在 OK / 30 秒後 OK / 60 秒前 NG
  - [x] `delta` から一致 counter が正しく決まる（`counter + delta`）
- [x] `src/lib/auth/totp.ts` を実装
  - [x] `TOTP_DIGITS = 6` / `TOTP_PERIOD_SECONDS = 30` / `TOTP_WINDOW = 1`
  - [x] `generateTotpSecret()` → `{ base32, encrypted }`
  - [x] `buildOtpauthUri()`（issuer = `APP_NAME`、label = username）
  - [x] `verifyAndConsumeTotp()`（**単文 UPDATE の更新行数で判定**・D-33-04）
- [x] `src/lib/db/queries/totp.ts` を実装
  - [x] `getTotp(userId)` / `upsertTotpPending(userId, encrypted)` / `enableTotp(userId)` / `deleteTotp(userId)`
  - [x] `consumeTotpCounter(userId, counter): Promise<number>`（**更新行数を返す**）
- [x] **read → 判定 → write になっていないことを目視レビュー**（R1）
- [x] 完了条件: `totp.test.ts` green。`consumeTotpCounter` が単文 SQL

### P5-A-05 — リカバリーコード（0.8h）

- [x] `src/test/unit/recovery-codes.test.ts` を**先に**書く
  - [x] 10 個生成される / 全て異なる
  - [x] 形式が `XXXXX-XXXXX-XXXXX-XXXXX`
  - [x] 正規化: 小文字・空白・ハイフン無しでも同じ値になる
  - [x] `hashRecoveryCode` が決定的（同じ入力 → 同じ hash）
- [x] `src/lib/auth/recovery-codes.ts` を実装
  - [x] `RECOVERY_CODE_COUNT = 10` / `RECOVERY_CODE_LOW_THRESHOLD = 3`
  - [x] `generateRecoveryCodes()`（`randomBytes(20)` → base32 → 整形）
  - [x] `normalizeRecoveryCode()` / `hashRecoveryCode()`（SHA-256）
  - [x] `consumeRecoveryCode(userId, input): Promise<boolean>`（**単文 UPDATE の更新行数**）
- [x] `src/lib/db/queries/recovery-codes.ts` を実装
  - [x] `insertRecoveryCodes(userId, hashes)` / `consumeRecoveryCodeByHash` / `countUnusedRecoveryCodes` / `deleteAllRecoveryCodes`
- [x] 完了条件: `recovery-codes.test.ts` green

### P5-A-06 — QR（`qrcode` ラッパ）（0.4h）

- [x] `src/test/unit/totp-qr.test.ts` を**先に**書く
  - [x] `otpauthUriToSvg` が `<svg` を含む文字列を返す（Promise を await）
  - [x] 同じ URI で決定的な出力
  - [x] `qrcode` に渡す引数が正しい（`type: 'svg'` / `errorCorrectionLevel: 'M'`）
  - [x] `qrcode` が throw したら `INTERNAL_ERROR` に丸まる
- [x] `src/lib/auth/totp-qr.ts` を実装（`QRCode.toString(uri, { type: 'svg', ... })` の**薄いラッパ**）
  - [x] 外部通信なし（**Google Chart API 等を使わない**）
  - [x] 戻り値は SVG 文字列（`data:` URI 化は呼び出し側）
- [x] 完了条件: `totp-qr.test.ts` green

---

## 2. P5-B: API とフロー

### P5-B-01 — クエリ層の仕上げ（1.0h）

- [x] `src/test/integration/` に `totp-queries.test.ts` を追加（実 DB）
  - [x] `consumeTotpCounter` が **2 回目に 0 行**を返す（同じ counter）
  - [x] 古い counter（単調減少）は 0 行
  - [x] `bigint` の往復で型が数値（R9）
  - [x] `consumeRecoveryCodeByHash` が 2 回目に 0 行
- [x] 完了条件: 統合テスト green

### P5-B-02 — 検証とエラーコード（0.4h）

- [x] `src/lib/validate/totp.ts` を作成（計画 §7.3.5）
- [x] `src/lib/errors.ts` の **3 か所**に `TOTP_REQUIRED`（403）/ `TOTP_ALREADY_ENABLED`（409）/ `EMAIL_NOT_VERIFIED`（403）を追加
- [x] `src/messages/ja.ts` の `errors` に既定メッセージを追加（`ERROR_CODES` のループテストが拾う）
- [x] 完了条件: `errors.test.ts` green

### P5-B-03 — ログ redaction（0.3h）

- [x] `src/test/security/log-redaction.test.ts` に `secret` / `secretEncrypted` / `otpauthUri` / `recoveryCodes` / `recoveryCode` のケースを追加
- [x] `src/lib/util/logger.ts` の `SENSITIVE_KEYS` を更新（D-33-20）
- [x] 完了条件: `log-redaction.test.ts` green

### P5-B-04 — `SessionData.totpPending`（0.5h）

- [x] `src/lib/auth/session.ts` の `SessionData` に `totpPending: boolean` を追加
- [x] `createSessionInternal` の戻り（`totpPending: false`）と `getSession` の SELECT に反映
- [x] **既存フィクスチャ 7 ファイル**に `totpPending: false` を追加
  - [x] `new-device-notification.test.ts` / `account-linking.test.ts` / `session-management.test.ts` / `csrf.test.ts` / `security-events-read.test.ts` / `social-confirm-link.test.ts` / `theme-preferences.test.ts`
- [x] 完了条件: `pnpm typecheck` と `pnpm test` が green（R5 の一括対応）

### P5-B-05★ — 保留セッションの封じ込め（1.2h）

- [x] `src/test/security/2fa-pending-session.test.ts` を**先に**書く
  - [x] 保留セッションで `GET /api/auth/security/events` → 403 `TOTP_REQUIRED`
  - [x] 保留セッションで `POST /api/auth/oauth/link` → 403 `TOTP_REQUIRED`
  - [x] 保留セッションで `POST /api/auth/logout` → **成功**
  - [x] 保留セッションで `GET /api/auth/csrf` / `GET /api/auth/me` → **成功**
- [x] `src/lib/auth/pipeline.ts` の `PipelineOptions` に `denyTotpPending?: boolean` を追加（**既定 true**）
- [x] `runCorePipeline` に判定を実装（`session.totpPending && options.denyTotpPending !== false` → 403）
- [x] `src/lib/api/utils.ts` の型を素通し
- [x] `src/app/settings/layout.tsx` に同じ判定（画面でも弾く）
- [x] 完了条件: `2fa-pending-session.test.ts` green

### P5-B-06★ — OIDC の保留セッション遮断（0.3h）

- [x] `src/lib/oidc/session.ts` の SQL に `totp_pending = false` を追加（D-33-09）
- [x] OIDC の既存テスト／E2E が green のままであることを確認
- [x] 完了条件: `pnpm test:e2e` green

### P5-B-07 — `GET /2fa` と `POST /2fa/setup`（1.0h）

- [x] `src/test/security/2fa.test.ts` を**先に**書き始める（setup 部分）
  - [x] 未確認 email で setup → 403 `EMAIL_NOT_VERIFIED`
  - [x] 有効化済みで setup → 409 `TOTP_ALREADY_ENABLED`
  - [x] setup 成功 → `secret` / `otpauth_uri` / `qr_svg` が返る
  - [x] `GET /2fa` が `{ enabled, recovery_codes_remaining }` を返す
- [x] `src/app/api/auth/2fa/route.ts`（GET）を実装
- [x] `src/app/api/auth/2fa/setup/route.ts`（POST）を実装
  - [x] `withAuthPipeline({ requireAuth: true })`
  - [x] `twoFactor` のレート制限
  - [x] `email_verified` チェック
- [x] 完了条件: `2fa.test.ts`（setup 部分）green

### P5-B-08 — `POST /2fa/verify`（1.2h）

- [x] `2fa.test.ts` に verify のケースを追加
  - [x] 正しいコード → `enabled: true` ＋ `recovery_codes` が **10 個**
  - [x] 誤ったコード → 400 `INVALID_CODE`（`enabled` は false のまま）
  - [x] 有効化で `security_events` に `2fa_enabled` が記録される
  - [x] 通知メールが送られる（best-effort。失敗しても 200）
- [x] `src/app/api/auth/2fa/verify/route.ts` を実装
  - [x] `verifyAndConsumeTotp` → `enableTotp` → リカバリーコード 10 個を保存（**同一トランザクション**）
  - [x] 平文 10 個を応答に含める（この 1 回のみ）
- [x] 完了条件: `2fa.test.ts`（verify 部分）green

### P5-B-09★ — `POST /2fa/challenge/verify`（1.0h）

- [x] `src/test/security/recovery-code-reuse.test.ts` を**先に**書く
  - [x] TOTP コードで昇格 → `totp_pending` が false になる
  - [x] リカバリーコードで昇格できる
  - [x] 同じリカバリーコードの 2 回目 → 400 `INVALID_CODE`
  - [x] 残数が減り、<3 で警告フラグが返る
- [x] `src/app/api/auth/2fa/challenge/verify/route.ts` を実装
  - [x] `denyTotpPending: false` を**明示**（ホワイトリスト）
  - [x] 6 桁の数字 → TOTP / それ以外 → リカバリーコード
  - [x] 失敗は一律 `INVALID_CODE`
  - [x] 成功で `markSessionTotpVerified(session.id)` ＋ `login_success`（method 付き）
  - [x] 成功時に**新規デバイス通知**を送る（保留段階では送らない・§8.7）
  - [x] 失敗で `login_failed`（scope=2fa）
- [x] `src/lib/auth/session.ts` に `markSessionTotpVerified` を追加
- [x] 完了条件: `recovery-code-reuse.test.ts` green

### P5-B-10★ — 強い再認証の共通入口（1.0h）

- [x] `src/test/unit/strong-reauth.test.ts` を**先に**書く
  - [x] `availableStrongReauthMethods(user)` が Phase 5 で `['password']` を返す
  - [x] 再認証未了 → `REAUTH_REQUIRED`（401）
  - [x] 再認証済み ＋ コード誤り → `INVALID_CODE`（400）
  - [x] **検証器配列の拡張点**: テスト用の 2 つ目の検証器を足すと通る（Phase 6 の布石・D-33-24）
- [x] `src/lib/auth/strong-reauth.ts` を実装
  - [x] `StrongReauthMethod` 型 / `availableStrongReauthMethods` / `requireStrongReauth`
  - [x] `passwordAndCodeVerifier`（`checkReauth` → TOTP or リカバリーコード）
  - [x] **判定順は「再認証 → コード」**。両方通ってから本体処理（R14 / T23）
  - [x] 検証器は配列で持ち、`passkeyVerifier` を足せる形にする
- [x] `GET /2fa` の応答に `strong_reauth_methods` を含める
- [x] 完了条件: `strong-reauth.test.ts` green

### P5-B-11 — `POST /2fa/disable`（強い再認証）（0.8h）

- [x] `src/test/security/2fa-disable-reauth.test.ts` を**先に**書く
  - [x] 再認証なし → 401 `REAUTH_REQUIRED`
  - [x] 再認証ありでも**コード誤りなら無効化されない**（400 `INVALID_CODE`）
  - [x] **失敗時にコードが消費されない**（T23）
  - [x] コード正しければ無効化 ＋ `2fa_disabled` ＋ 通知
  - [x] **リカバリーコードでも無効化できる**
- [x] `src/app/api/auth/2fa/disable/route.ts` を実装（`requireStrongReauth`）
- [x] 完了条件: `2fa-disable-reauth.test.ts` green

### P5-B-12 — `POST /2fa/recovery-codes/regenerate`（0.6h）

- [x] 再生成で**旧コードが無効**になることをテスト
- [x] `src/app/api/auth/2fa/recovery-codes/regenerate/route.ts` を実装（`requireStrongReauth`）
- [x] 完了条件: 旧コードで昇格できない・新コードでできる

### P5-B-13★ — ログインの 2 段階化（1.0h）

- [x] `2fa.test.ts` に login のケースを追加
  - [x] 2FA 無効 → 応答が**完全に従来どおり**（R7）
  - [x] 2FA 有効 → `{ twoFactorRequired: true }` ＋ セッションが `totp_pending = true`
  - [x] 保留セッション発行時は `login_success` を**記録しない**
  - [x] 保留セッション発行時は**新規デバイス通知を送らない**
- [x] `src/app/api/auth/login/route.ts` を変更（2FA 有効分岐）
- [x] 完了条件: `2fa.test.ts`（login 部分）green

---

## 3. P5-B2: 未確認 email と再送

> **必ず P5-B2-01 と P5-B2-02 をセットで実装する**。片方だけ入れると未確認ユーザーが締め出される（R12 / T19）。

### P5-B2-01★ — 未確認 email のログイン遮断（0.8h）

- [x] `src/test/security/email-unverified-login.test.ts` を**先に**書く
  - [x] 未確認（`status='pending_email'`）でログイン → **403 `EMAIL_NOT_VERIFIED`**
  - [x] **セッションが 1 件も発行されない**
  - [x] 応答の `data` に `email` と `resend_available: true`
  - [x] `security_events` に `login_failed`（`metadata.reason = 'email_unverified'`）
  - [x] **確認済みユーザーは従来どおり 200**
- [x] `src/app/api/auth/login/route.ts` を変更
  - [x] 停止/削除の判定の**後**、2FA 分岐の**前**に未確認判定を入れる
  - [x] `failResponse` ではなく `NextResponse.json` で `data` を足す（§8.7）
  - [x] レート制限の失敗予約を「成功」として確定する
  - [x] **既存コメント「`pending_email` は残す（…ログイン状態が要るため）」を更新**
- [x] 完了条件: `email-unverified-login.test.ts` green

### P5-B2-02★ — 未認証でも再送できるようにする（1.0h）

- [x] `src/test/security/resend-unauthenticated.test.ts` を**先に**書く
  - [x] **セッション無し**で `POST /api/auth/resend-verification { email }` → 200
  - [x] 存在しない email / 確認済み / 停止中 / 削除済み → **同じ 200・同じ本文**
  - [x] 未確認ユーザーにだけトークンが発行され、メールが送られる
  - [x] `resendEmail(email)` の 5/1h と `resend.ip` の 10/1h が効く
  - [x] **既存の認証済み経路（`body.email` 無し ＋ セッションあり）も動く**（後方互換）
- [x] `src/app/api/auth/resend-verification/route.ts` を変更
  - [x] `requireAuth: false` に変更
  - [x] `body.email` を対象にする。無ければ `session.user` を対象にする（後方互換）
  - [x] 応答は常に同一（列挙対策・§46）
- [x] `src/lib/auth/rate-limit-keys.ts` に `resendEmail(email)` を追加
- [x] `src/messages/ja.ts` にエラーコード `EMAIL_NOT_VERIFIED` の既定メッセージを追加
- [x] 完了条件: `resend-unauthenticated.test.ts` green

### P5-B2-03 — 検証スキーマ（0.4h）

- [x] `src/lib/validate/resend.ts` を作成（`{ email, captchaToken? }`）
- [x] `RATE_LIMITS.resend.email` の値が §4.3（5回/1時間）と一致することを確認
- [x] 完了条件: `pnpm typecheck` green

### P5-B2-04 — 既存テストの期待値反転（0.4h）

- [x] `src/test/security/deleted-account-login.test.ts:132` の
      `'email 未認証（pending_email）は確認メール再送のためログインできる'` を
      **`'email 未認証は 403 で止まる'`** に改名し、期待値を **403 `EMAIL_NOT_VERIFIED`** にする（§5.2）
- [x] `grep -rn "pending_email" src/test/` で**他に未確認ログインを期待するテストが無い**ことを確認（実装前調査では 1 件のみ）
- [x] 完了条件: `deleted-account-login.test.ts` green

---

## 4. P5-C: セキュリティテスト

### P5-C-01★ — 並行 replay（1.2h）

- [x] `src/test/security/2fa-concurrent-replay.test.ts` を作成
  - [x] 正しいコードを取得（`TOTP.generate` で固定時刻から生成）
  - [x] `Promise.all` で `2fa/challenge/verify` を **2 並行**送信
  - [x] **成功が 1 件・他方が 400 `INVALID_CODE`**
  - [x] 同じコードの 3 回目（逐次）も 400
  - [x] 古い counter のコード（1 つ前のウィンドウ）を後から送ると 400（R2 / T13）
- [x] 完了条件: green（**DoD 直結**）

### P5-C-02 — 総当たり（0.8h）

- [x] `src/test/security/2fa-bruteforce.test.ts` を作成
  - [x] 誤コードを 10 回送る → 11 回目が **429**
  - [x] `rate_limited` が `security_events` に記録される
  - [x] `vi.setSystemTime` で 5 分進めると回復する
- [x] 完了条件: green

### P5-C-03 — secret 漏洩（0.6h）

- [x] `src/test/security/2fa-secret-leak.test.ts` を作成
  - [x] `setup` 以外の応答に `secret` が含まれない
  - [x] `verify` / `regenerate` 以外の応答にリカバリーコードが含まれない
  - [x] `security_events.metadata` に secret / コードが無い
  - [x] ログ出力（`logger.info` の引数）に secret が無い
- [x] 完了条件: green

### P5-C-04 — 無効化の再認証（0.6h）

- [x] `2fa-disable-reauth.test.ts` を仕上げる（P5-B-11 で作成済み）
  - [x] **T22**: セッション窃取だけ（パスワード無し）では無効化できない
  - [x] **T23**: コード誤りの失敗でコードが消費されない
- [x] 完了条件: green

### P5-C-05 — 既存テストへの追記（0.4h）

- [x] `src/test/security/rate-limit.test.ts` に `RATE_LIMITS.twoFactor`（10/300_000）と `RATE_LIMITS.resend.email` を追加
- [x] `src/test/security/security-events-coverage.test.ts` に `2fa/**` ルートの `recordSecurityEvent` を追加
- [x] `security-events-coverage.test.ts` の **`resend-verification` の期待値を更新**（`user.id` が無い場合は `null`）
- [x] `src/test/security/log-redaction.test.ts`（P5-B-03 で追加済み）を再確認
- [x] **静的検査**を追加（計画 §11.3）
  - [x] `denyTotpPending: false` が 5 経路のみ
  - [x] `secret` を返すのは `2fa/setup` のみ
  - [x] `otpauth` / `qrcode` / `totp-crypto` がクライアントから import されていない
  - [x] `login/route.ts` に `emailVerified` の判定がある
  - [x] `resend-verification/route.ts` が `requireAuth: false`
- [x] 完了条件: 全 green

### P5-C-06 — 未確認ログイン（0.6h）

- [x] `src/test/security/email-unverified-login.test.ts` を仕上げる（P5-B2-01 で作成済み）
  - [x] セッション非発行を **DB で確認**（`sessions` テーブルを引く）
  - [x] `login_failed` の metadata が `{ reason: 'email_unverified' }`
  - [x] レート制限が**消費されない**（パスワードは正しいため）
- [x] 完了条件: green

### P5-C-07 — 未認証再送の列挙・スパム耐性（0.8h）

- [x] `src/test/security/resend-unauthenticated.test.ts` を仕上げる（P5-B2-02 で作成済み）
  - [x] 存在しない / 確認済み / 停止中 / 削除済み の **4 通りで応答が完全一致**
  - [x] 未確認にだけトークン行が増える
  - [x] 6 回目の再送が 429
  - [x] `src/test/security/enumeration.test.ts` に再送ケースを追加
- [x] 完了条件: green

---

## 5. P5-D: UI

### P5-D-01 — 2FA パネル（1.5h）

- [x] `src/components/settings/two-factor-panel.tsx` を作成
  - [x] 無効: 「2FA を有効にする」
  - [x] setup 中: QR（`qr_svg` を `dangerouslySetInnerHTML` で挿入。**サーバ生成 SVG のみ**）＋ シークレット手入力 ＋ 6 桁入力
  - [x] 有効: 残数 ＋ 「再生成」/「無効にする」
  - [x] 残数 <3: 警告表示
- [x] `src/components/settings/security-overview.tsx` の 2FA カードを差し替え
- [x] `security.notAvailable` の文言を削除（使われなくなる）
- [x] 無効化・再生成は **`StrongReauthDialog`** を使う（**既存の `ReauthDialog` は流用しない**・D-33-23）
- [x] 完了条件: 画面で setup → 有効化が動く

### P5-D-02 — リカバリーコード表示（0.8h）

- [x] `src/components/settings/recovery-codes-display.tsx` を作成
  - [x] 10 個を `grid-cols-2` で表示
  - [x] コピー / 印刷 / テキスト保存
  - [x] **「保存しました」チェックを入れるまで閉じられない**
  - [x] 「1 度しか表示されません」を明示
- [x] 完了条件: チェックまで閉じない

### P5-D-03 — 強い再認証ダイアログ（0.8h）

- [x] `src/components/settings/strong-reauth-dialog.tsx` を作成
  - [x] `strong_reauth_methods`（Phase 5 は `['password']`）で出し分け
  - [x] パスワード欄 ＋ コード欄（6 桁 or リカバリーコード）を 1 画面で
  - [x] **401 `REAUTH_REQUIRED`** → `POST /api/auth/reauth`（既存）にパスワードを送り、成功後に同じリクエストを再送（コード欄は保持）
  - [x] **400 `INVALID_CODE`** → コード欄をクリアして再入力
  - [x] **Phase 6 の布石**: Passkey タブを足せる構造にする（Phase 5 では出さない）
- [x] 完了条件: 無効化・再生成が画面で通る

### P5-D-04 — ログインの 2 段階 UI（1.0h）

- [x] `src/components/auth/totp-login-step.tsx` を作成（`TotpChallengeForm` を接続）
- [x] `src/app/auth-form.tsx` に `twoFactorRequired` 分岐を追加
- [x] `src/app/login/page.tsx` から**サーバ側で判定した props** を渡す（BUG-11 の再発防止）
- [x] 「リカバリーコードを使う」切り替え（`inputMode` を `text` に）
- [x] 「別のアカウントでログイン」（`logout` → `/login`）
- [x] 完了条件: ログインが 2 段階で通る

### P5-D-05 — 未確認 email の案内（0.8h）

- [x] `src/components/auth/email-unverified-notice.tsx` を作成（計画 §12.4）
  - [x] 見出し **「メールアドレスの確認が必要です」**
  - [x] email を **prefill 済み・読み取り専用**で表示（403 応答の `data.email`）
  - [x] 「確認メールを再送する」→ `POST /api/auth/resend-verification { email }`
  - [x] 再送後「確認メールを送信しました」/ 429 で `resendTooMany`
  - [x] `aria-live="polite"` で読み上げる
  - [x] 「別のアカウントでログイン」でフォームを初期状態へ
  - [x] **`data.email` が無ければ表示しない**（従来のエラー表示にフォールバック）
- [x] `src/app/auth-form.tsx` に `emailNotVerified` 分岐を追加（**サーバ側で判定して props で渡す**）
- [x] 完了条件: 未確認ログインで案内が出て再送できる

### P5-D-06 — 文言（0.2h）

- [x] `src/messages/ja.ts` に `twoFactor` セクションを追加（計画 §12.5。`strongReauth*` / `emailNotVerified*` を含む）
- [x] `security.twoFactor` の既存キーとの整合を確認
- [x] 完了条件: `pnpm typecheck` green

---

## 6. 統合と仕上げ

- [x] `pnpm lint`（0 errors）
- [x] `pnpm typecheck`
- [x] `pnpm test`（全 green。新規 **14** ファイル＋既存追記）
- [x] `pnpm test:e2e`（OIDC の回帰）
- [x] `pnpm build`
- [x] `pnpm db:verify-migrations`
- [x] 計画 §14.4 の**実機手動確認 11 項目**を実施（2026-10-24。§14.4 の表を参照。QR は SVG→PNG→OpenCV デコードで実検証、9・10 は実ブラウザ＋API、他は実 HTTP ハーネス）
- [x] 計画 §14.1〜14.3 の DoD をすべてチェック
- [x] `実装Todo.md` の P5 セクションを更新（`2fa/challenge` の表記修正・ファイル数 21・テスト 14・工数を含む）
- [x] **`実装Todo.md` に `resend-verification` の認可変更（D-33-22）を Phase 5 の項目として明記**
- [x] `README.md` に Phase 5 の実装詳細を追記（Phase 4 と同じ体裁）
- [x] `AGENTS.md` の「現在の到達点」を更新（M5 完了へ）
- [x] PR を作成（[#11](https://github.com/yuushi2024/oauth/pull/11) `Phase 5: TOTP 2FA + Recovery Codes（テスト・静的検査・§14.4 完了と発見欠陥の修正）`）

---

## 7. 見積もり合計

| 区分 | 工数 |
|---|---|
| P5-A 基盤 | 4.8h |
| P5-B API / フロー | 10.3h |
| P5-B2 未確認 email / 再送 | 2.6h |
| P5-C セキュリティテスト | 5.0h |
| P5-D UI | 5.1h |
| 統合と仕上げ | 1.0h |
| **合計** | **28.8h（約 4 日）** |

> 計画 `docs/phase5-totp-2fa-実装計画.md` §13 の見積もりは実装 **27.8h**。本書はそれに「統合と仕上げ」1.0h を足した **28.8h** を実行工数とする。
> v1.0 の 22.0h から増えた内訳は **P5-B2（未確認 email の遮断と再送・2.6h）**、**P5-B-10（強い再認証の共通入口・1.0h）**、**P5-C-04〜07（無効化再認証・新規テスト・2.4h）**、**P5-D-03/05（新規画面・1.6h）**、**P5-A-01/A-06（`qrcode` 追加・0.3h）**。

---

## 8. 進捗メモ（実装時に追記する）

| 日付 | タスク | 状態 | メモ |
|---|---|---|---|
| 2026-10-24 | P5-A-01〜A-06 | 完了 | `otpauth` / `qrcode` 導入、migration `0017`、`totp-crypto` / `totp` / `totp-qr` / `recovery-codes` |
| 2026-10-24 | P5-B-01〜B-13 | 完了 | API 6 本 ＋ 保留セッション封じ込め（`denyTotpPending`）＋ 強い再認証 |
| 2026-10-24 | P5-B2-01〜B2-04 | 完了 | 未確認ログイン 403 `EMAIL_NOT_VERIFIED`、未認証再送、期待値反転 |
| 2026-10-24 | P5-C-01〜C-07 | 完了 | 新規 14 テストファイル。静的検査 `2fa-static-checks.test.ts` を追加 |
| 2026-10-24 | P5-D-01〜D-06 | 完了 | `two-factor-panel` / `recovery-codes-display` / `strong-reauth-dialog` / `totp-login-step` / `email-unverified-notice` |
| 2026-10-24 | 統合 | 完了 | lint 0 errors / typecheck / test 88 files 618 tests / e2e 9 files 51 tests / build / db:verify-migrations green |
| 2026-10-24 | §14.4 実機手動確認 11 項目 | 完了 | QR は SVG→PNG→OpenCV デコードで実検証。9・10 は実ブラウザ＋API。他は実 HTTP ハーネス |
| 2026-10-24 | PR 作成 | 完了 | [#11](https://github.com/yuushi2024/oauth/pull/11) |

**実装で見つけた欠陥**:
- `INVALID_CODE` の HTTP status が 401 になっていた（仕様 §8.8 は 400）→ `ERROR_STATUS` を修正。
- 2FA 有効化（`setup` → `verify`）が `enabled=false` の保留行に対してコード検証できず、`POST /2fa/verify` が常に 400 で失敗していた → `verifyAndConsumeTotp` / `consumeTotpCounter` に `allowPending` を追加し、`verify` ルートから渡す。
- `new-device-notification.test.ts` の DB モックが `select()` を持たず、login の `findTotpByUserId` 追加で落ちた → モックを更新。
- `resend-unauthenticated.test.ts` が共有 IP のレート制限カウンタを持ち越して 6 回目が 429 にならなかった → `beforeEach` でレート制限行を全消去。
- **重複登録（email / username の一意制約違反）が 500 になっていた**（§14.4 の実機確認中に発見）。Drizzle 0.45 は driver エラーを `DrizzleQueryError` で包むため SQLSTATE は `err.cause.code` に入るが、`register` ルートは `err.code` しか見ておらず `23505` を捕捉できなかった。`src/lib/db/sql-state.ts` の `isUniqueViolation` を新設して修正（`rate-limit.ts` の私有 `getSqlState` も同 helper に集約）。これにより**成功時と同一の 200 を返す**列挙対策が実際に機能する（`register-duplicate.test.ts`）。
- **応答文言に `-email` が混入していた**（`register` の成功時のみ「確認-email を送信しました」、`password/forgot`、`email/change`）。`src/messages/ja.ts` の正典（「確認メールを送信しました」「変更通知メールを送信しました」）と不一致だったため修正。`register` では**重複経路（正しい文言）と成功経路（誤った文言）で応答が異なり、列挙オラクルになっていた**。テスト側の同文字列 3 箇所も同時に修正。

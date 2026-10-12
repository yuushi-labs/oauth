# Phase 1 監査レポート — メール/パスワード認証

**監査日時**: 2026-10-10  
**対象**: `oauth` プロジェクト Phase 1（メール/パスワード認証）  
**基準**: `実装Todo.md` / `実装計画.md` v1.4 / `超本格アカウント・認証システム仕様書 v1.1.md`  
**判定基準**: 実際のコード・DBスキーマ・マイグレーション・テスト・設定を読んで判定

---

## 総合判定

🟠 **Phase 1 部分実装**

### 判定理由
- **実装済み**: Argon2id、パスワード強度、HIBP、メールトークン、セッション基盤、Cookie属性、CSRF基盤（Route Handlerのみ）、再認証、セキュリティイベント、主要エンドポイント14本
- **未実装・不足**: Server Action CSRF保護、Session rotateのreplaced_by、Email change confirmのemail_verified/旧メール通知、Account deleteの連携無効化、Redisレート制限、全Security/Integration/E2Eテスト、負荷テスト実測
- **テスト基盤**: unitのみ（9ファイル/76テスト）、security/integration/e2e未整備

---

## Phase 1-A: パスワード基盤

| タスクID | 判定 | 根拠ファイル・関数 | 根拠 | 不足要件 |
|---|---|---|---|---|
| P1-A-01 | ✅ | `src/lib/auth/password.ts:17-44`<br>`hashPassword()`<br>`verifyPassword()`<br>`needsRehash()` | `@node-rs/argon2` 使用、デフォルト `m=19456,t=2,p=1`、環境変数 `ARGON2_M/T/P` で設定化、Argon2id(Algorithm=2) | なし |
| P1-A-02 | ❌ | - | 負荷テスト実測の記録なし（コード・ドキュメントにメモなし） | 256MiB未満・100ms前後を実測・記録 |
| P1-A-03 | ✅ | `password.ts:21-27`<br>`verifyPassword()`<br>`needsRehash():32-44` | verify実装、rehash判定（m/t/p比較）実装 | なし |
| P1-A-04 | ✅ | `src/lib/auth/strength.ts:116-119`<br>`src/lib/validate/password.ts:10-14` | `strongPasswordSchema` = `passwordSchema` + 弱いPW拒否<br>8-128文字、Unicode/スペース許可、空白のみ拒否、`WEAK_PASSWORDS` 114件 | なし |
| P1-A-05 | ✅ | `src/lib/auth/breached.ts:17-48`<br>`checkBreached()` | SHA-1先頭5桁送信、k-anonymity、timeout 1500ms、fail-open、`BREACH_CHECK_FAIL_OPEN` 制御 | なし |
| P1-A-05a | ✅ | `breached.ts:45`<br>`env.BREACH_CHECK_FAIL_OPEN` | 環境変数でfail-open制御（既定true） | なし |
| P1-A-05b | ✅ | `register/route.ts:42-44`<br>`reset/route.ts:42-44` | fail-open時に `breach_check_fail_open` イベント記録 | なし |
| P1-A-06 | ⚠️ | `src/test/unit/validate.test.ts:47-66` | 長さ境界/Unicode/スペース/空白のみテストあり | **security/breached.test.ts 3ケース未実装**、hash形式/salt一意性/128文字OK/129文字NG 単体テスト不足 |
| P1-A-06a | ❌ | `src/test/unit/breached.test.ts` 存在せず | テストファイルなし | 3ケース: ①通常=漏洩検出 ②漏洩PW=拒否 ③timeout=fail-open許可 |

---

## Phase 1-B: メールトークン

| タスクID | 判定 | 根拠ファイル・関数 | 根拠 | 不足要件 |
|---|---|---|---|---|
| P1-B-01 | ✅ | `tokens/generate.ts:4-9`<br>`generateToken()`<br>`hashToken()` | 32bytes(256bit) random、SHA-256 hash保存、`tok_` prefix、`ID_PREFIXES`追加済み | なし |
| P1-B-02 | ✅ | `drizzle/0003_05_tokens.sql` | `email_verification_tokens`(30分) / `password_reset_tokens`(60分) / `email_change_requests`(30分)、purpose列、used_at、FK、index | なし |
| P1-B-03 | ✅ | `tokens/verify.ts:9-16`<br>`verifyAndConsumeToken()` | purposeで流用防止、used_at同トランザクションで設定、期限チェック | なし |
| P1-B-04 | ✅ | `queries/tokens.ts:32-38/60-66/88-93`<br>`invalidate*Tokens()` | 発行時に同一ユーザー未使用トークンを `usedAt` 更新で失効 | なし |
| P1-B-05 | ✅ | `email/templates.ts`<br>`email/send.ts`<br>`messages/ja.ts` | 6種テンプレ、Resend接続、文面・エラー集約 | なし |
| P1-B-06 | ❌ | `src/test/security/token-reuse.test.ts` 等 存在せず | テストファイルなし | token再利用失敗 / 期限切れ / purpose流用不可 テスト未実装 |

---

## Phase 1-C: セッション / CSRF / レート制限基盤

| タスクID | 判定 | 根拠ファイル・関数 | 根拠 | 不足要件 |
|---|---|---|---|---|
| P1-C-01 | ✅ | `cookie.ts:5-8/14-23`<br>`setSessionCookie()`<br>`setAnonCookie()` | `__Host-auth_session` / `__Host-auth_anon`、HttpOnly/Secure/SameSite=Lax/Path=/ Domainなし | なし |
| P1-C-02 | ⚠️ | `session.ts`<br>`createSession()`/`getSession()`/`rotateSession()`/`revokeSession()`/`revokeAllSessions()`/`setReauthVerified()` | 基本CRUD実装、HMAC-SHA256 hash保存、絶対期限90日、ip_hash/ip_masked/device_name/reauth_verified_at/totp_pending | **rotate() で replaced_by 未設定**、`getSession()` が `ip: ''` 空文字返却 |
| P1-C-03 | ✅ | `drizzle/0002_04_sessions.sql` | 全列: absolute_expires_at 90日、replaced_by、revoke_reason、ip_hash/ip_masked、device_name、ip_country、reauth_verified_at、totp_pending、passkey_pending、index、FK | なし |
| P1-C-04 | ⚠️ | `csrf.ts:62-122`<br>`withAuthPipeline()` | HMAC token、Origin検証、共通パイプライン（Origin→CSRF→認証→再認証→認可→入力検証→処理）実装 | **Server Action用ラッパー未実装**、Route Handlerのみ |
| P1-C-04a | ❌ | - | Server Action から呼ぶ共通関数なし | Route Handler と Server Action 双方から同一検証関数を呼ぶ必要 |
| P1-C-04b | ❌ | - | Server Action 実装なし | 「Server Action だから CSRF 不要」にならない仕組みなし |
| P1-C-04c | ❌ | - | OAuth コールバック未実装（Phase 4） | 例外経路の明示なし |
| P1-C-05 | ✅ | `reauth.ts:6-14`<br>`reauth/route.ts`<br>`checkReauth()` | 5分猶予、REAUTH_REQUIRED、session.reauthVerifiedAt 更新 | なし |
| P1-C-06 | ⚠️ | `rate-limit.ts`<br>`RateLimiter.check()` | PGフォールバック実装、固定窓、onConflictDoUpdate | **Redis未実装**、**race conditionあり（atomic性なし）**、oauth/2fa/passkey/settings キー欠落 |
| P1-C-07 | ⚠️ | `config/rate-limits.ts` | register/login/forgot/resend のみ定義 | oauth-start/callback、2fa、passkey、settings キー欠落 |
| P1-C-08 | ⚠️ | `middleware.ts` | X-Content-Type-Options/Referrer-Policy/X-Frame-Options、CORS許可リスト（同一Originのみ） | HSTS/CSP/Permissions-Policy欠落、粗いIP制限なし |
| P1-C-09 | ✅ | `security-events.ts`<br>`drizzle/0004_08_security_events.sql` | 17種 EventType（仕様16種＋breach_check_fail_open）、DB保存、index、FK SET NULL | なし |
| P1-C-09a | ✅ | `logger.ts:31-35`<br>`SENSITIVE_KEYS` | `code`/`state`/`nonce`/`codeverifier` キー追加済み | なし |
| P1-C-09b | ✅ | `logger.ts:37-39`<br>`SENSITIVE_TEXT_PATTERNS` | URL中の `?code=` `&state=` `&nonce=` `&code_verifier=` を値ごと `***` 置換 | なし |

---

## Phase 1-D: エンドポイント（全14本）

### 詳細評価表

| # | Endpoint | 存在 | 認証 | email_verified | reauth | CSRF | RateLimit | Zod | TX | SecEvent | Enum対策 | Session処理 | Token処理 | 判定 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | POST /api/auth/register | ✅ | 不要 | - | 不要 | ✅ | ✅ (IP) | ✅ | ✅ | register | ✅ 統一msg | 新規作成 | verify発行 | ✅ |
| 2 | POST /api/auth/login | ✅ | 不要 | 不要(D-01) | 不要 | ✅ | ✅ (3種) | ✅ | ✅ | login_s/f | ✅ 統一msg | **必ず新規作成** | - | ✅ |
| 3 | POST /api/auth/logout | ✅ | 必須 | - | 不要 | ✅ | - | - | ✅ | logout | - | 現行revoke+Cookie削除 | - | ✅ |
| 4 | GET /api/auth/me | ✅ | 不要* | - | 不要 | - | - | - | - | - | - | session確認 | - | ✅ |
| 5 | POST /api/auth/verify-email | ✅ | 不要 | 結果true | 不要 | ✅ | - | ✅ | ✅ | email_verified | ✅ 統一msg | - | token消費 | ✅ |
| 6 | POST /api/auth/resend-verification | ✅ | 必須 | falseのみ | 不要 | ✅ | ✅ (user/IP) | - | ✅ | - | ✅ 統一msg | - | token再発行(旧失効) | ✅ |
| 7 | POST /api/auth/password/forgot | ✅ | 不要 | - | 不要 | ✅ | ✅ (email/IP) | ✅ | ✅ | - | ✅ 同一msg | - | reset発行 | ✅ |
| 8 | POST /api/auth/password/reset | ✅ | 不要 | - | 不要 | ✅ | - | ✅ | ✅ | password_reset | ✅ 統一msg | **全revoke(現行含む)** | token消費 | ⚠️ |
| 9 | POST /api/auth/password/change | ✅ | 必須 | - | ✅ | ✅ | - | ✅ | ✅ | password_changed | - | 他revoke(現行含む) | - | ⚠️ |
| 10 | PUT /api/auth/password/set | ✅ | 必須 | ✅ | ✅ | ✅ | - | ✅ | ✅ | password_changed | - | 全revoke | - | ✅ |
| 11 | POST /api/auth/reauth | ✅ | 必須 | - | - | ✅ | - | ✅ | ✅ | - | - | reauth_verified_at更新 | - | ✅ |
| 12 | POST /api/auth/email/change | ✅ | 必須 | - | ✅ | ✅ | - | ✅ | ✅ | - | - | - | change発行 | ✅ |
| 13 | POST /api/auth/email/change/confirm | ✅ | 不要 | 結果true | 不要 | ✅ | - | ✅ | ✅ | email_changed | - | - | token消費 | ⚠️ |
| 14 | DELETE /api/auth/account | ✅ | 必須 | - | ✅ | ✅ | - | - | ✅ | account_deleted | - | 全revoke | - | ⚠️ |

### 主な不足詳細

| Endpoint | 不足内容 | 仕様参照 |
|---|---|---|
| password/reset | **旧メールへ通知なし**（`sendChangeNotificationEmail` 呼び出しなし） | §15「ユーザーへ通知」 |
| password/change | 現行セッション含む全revoke（D-03準拠だが仕様は「他セッション」のみ） | §8 / D-03 |
| email/change/confirm | **`emailVerified: true` 設定なし**、**旧メールへ通知なし**、**`oldEmailNotifiedAt` 未更新** | §14 / D-07 |
| account/delete | **`accounts`/`webauthn_credentials`/`totp`/`recovery_codes` 無効化なし**（`softDeleteUser` のみ） | §24 |

---

## DB / Migration 監査

| Migration | ファイル | 状態 | 確認事項 |
|---|---|---|---|
| 01 roles | `0000_01_roles.sql` | ✅ | 4役割 seed 済み |
| 02 users | `0001_02_users.sql` | ✅ | partial unique index 2本、通常UNIQUEなし、CHECK制約2本、role_id FK |
| 03 sessions | `0002_04_sessions.sql` | ✅ | 全列、session_hash UNIQUE、user_id FK cascade、index 4本 |
| 04 tokens | `0003_05_tokens.sql` | ✅ | 3テーブル、purpose、used_at、FK cascade、index 各2本 |
| 05 security_events | `0004_08_security_events.sql` | ✅ | 17種対応、user_id FK SET NULL、index 2本 |
| 06 rate_limit | `0005_10_rate_limit.sql` | ✅ | key PK、count、window_expires_at、index |

### 実DB確認結果（docker exec psql）
- 全8テーブル存在確認済み
- `users`: partial unique index 正常、通常UNIQUE 0件、CHECK制約 2件
- `sessions`: 全列・UNIQUE・FK・index 正常
- `*_tokens`: 3テーブルとも purpose/used_at/FK/index 正常
- `security_events`: event_type/user_id index、FK SET NULL
- `rate_limit_hits`: key PK、window_expires_at index

### 問題点
- `drizzle-kit migrate` が `_journal.json` を更新しない（手動適用が必要だった）
- meta に 0000/0001 のみ記録、0002-0005 が未記録

---

## テスト監査

### 現状のテスト構成

```
src/test/
└── unit/                    # 9ファイル / 76テスト ✅ 全green
    ├── id.test.ts
    ├── crypto.test.ts
    ├── ip.test.ts
    ├── time.test.ts
    ├── logger.test.ts
    ├── validate.test.ts
    ├── errors.test.ts
    ├── env.test.ts
    └── schema.test.ts
```

### 不在テストディレクトリ・ファイル

| カテゴリ | ディレクトリ | 期待ファイル（実装Todo.md DoD準拠） | 状態 |
|---|---|---|---|
| Unit (追加) | `src/test/unit/` | `breached.test.ts` (3ケース)、`password.test.ts` (hash/salt/rehash) | ❌ 未作成 |
| Security | `src/test/security/` | `uniq.test.ts`、`breached.test.ts`、**`csrf.test.ts`**、**`session-fixation.test.ts`**、**`token-reuse.test.ts`**、**`enumeration.test.ts`**、**`rate-limit.test.ts`**、**`session-attr.test.ts`**、**`log-redaction.test.ts`** | ❌ ディレクトリ自体未存在 |
| Integration | `src/test/integration/` | `security-events.test.ts`、`status.test.ts` 等 | ❌ ディレクトリ自体未存在 |
| E2E | `src/test/e2e/` | `login.spec.ts`、`register.spec.ts`、`theme.spec.ts`、`sessions.spec.ts`、`email-change.spec.ts`、`account-delete.spec.ts` | ❌ ディレクトリ自体未存在 |

### package.json scripts 状態

| Script | 定義 | 実行可能 |
|---|---|---|
| `pnpm test` / `pnpm test:unit` | ✅ `"vitest run"` / `"vitest run src/test/unit"` | ✅ 76 tests passed |
| `pnpm test:integration` | ❌ 未定義 | - |
| `pnpm test:security` | ❌ 未定義 | - |
| `pnpm test:e2e` | ❌ 未定義 | - |

---

## 実行コマンド結果

```bash
$ pnpm lint
# 0 errors, 9 warnings (security/detect-object-injection 等)

$ pnpm typecheck
# green (0 errors)

$ pnpm test
# 9 test files, 76 tests passed

$ pnpm build
# ✓ Compiled successfully in 8.9s
# 18 routes generated (14 auth API routes + static)

$ pnpm test:integration
# 未定義 (package.json に script なし)

$ pnpm test:security
# 未定義 (package.json に script なし)

$ pnpm test:e2e
# 未定義 (package.json に script なし)
```

---

## Phase 1 DoD 判定（実装Todo.md 基準）

| DoD 項目 | 判定 | 根拠 |
|---|---|---|
| 仕様64章「アカウント」7項目が全て動く | ⚠️ 部分達成 | email確認・PWリセット・ログイン・登録・ログアウト・PW変更は動く。**アカウント削除が不完全**（連携/Passkey/2FA無効化なし） |
| `src/test/security/uniq.test.ts` green | ❌ 未達 | ファイル未存在 |
| `src/test/unit/breached.test.ts` 3ケース green | ❌ 未達 | ファイル未存在 |
| `src/test/security/csrf.test.ts` Route Handler & Server Action 双方 green | ❌ 未達 | Server Action実装なし、テストファイル未存在 |
| `src/test/security/{session-fixation,token-reuse,enumeration,rate-limit,session-attr}.test.ts` green | ❌ 未達 | 全ファイル未存在 |
| セッションCookie HttpOnly/Secure/SameSite=Lax/__Host- 全部付き、**生トークンDBに存在しない** | ✅ 達成 | `cookie.ts` 属性正しい、`session.ts` session_hash(HMAC)保存のみ |
| `src/test/unit/log-redaction.test.ts` PW/token/session 1件も出ない | ✅ 達成 | `logger.test.ts:81-99` で検証済み（※security配下ではないが単体テストで達成） |

---

## 未達項目詳細（重要度順）

### Critical
1. **Server Action CSRF 保護未実装** (P1-C-04a/b)
   - Route Handler のみ保護、Server Action 用共通ラッパーなし
   - `lib/auth/csrf.ts` の `withAuthPipeline` が `NextRequest` 前提

2. **Session rotate で `replaced_by` 未設定**
   - `session.ts:124-132` `rotateSession()` が旧sessionの `replaced_by` を更新しない
   - セッション追跡・固定攻撃検知に必要

3. **Email change confirm で `email_verified=true` 未設定 / 旧メール通知なし**
   - `email/change/confirm/route.ts:26` `updateUser` に `emailVerified: true` なし
   - `sendChangeNotificationEmail` 呼び出しなし、旧メール通知なし
   - `oldEmailNotifiedAt` 更新なし

4. **Account delete で連携/Passkey/2FA 無効化なし**
   - `account/route.ts:18` `softDeleteUser` のみ、`accounts`/`webauthn_credentials`/`totp`/`recovery_codes` への処理なし
   - §24「OAuth連携無効化・Passkey無効化」未実装

5. **Security test 全未実装**
   - 実装Todo.md DoD の7ファイルすべて未作成

6. **Integration/E2E test 基盤なし**
   - `src/test/integration/`、`src/test/e2e/` ディレクトリ自体未存在

### High
7. **Redis レート制限未実装**（PGフォールバックのみ、race conditionあり）
   - `rate-limit.ts` が PG のみ、`onConflictDoUpdate` で競合可能
   - Redis 実装・Luaスクリプトまたはトランザクションで atomic 化必要

8. **Rate limit 設定不足**
   - `config/rate-limits.ts` に oauth/2fa/passkey/settings キー欠落

9. **Argo2id 負荷テスト実測記録なし** (P1-A-02)
   - メモリ/時間実測の記録なし

10. **drizzle-kit migrate meta journal 更新問題**
    - 手動SQL適用が必要だった

### Medium
11. **Middleware セキュリティヘッダー不完全**
    - HSTS/CSP/Permissions-Policy欠落（Phase 2対応予定）

12. **`getSession()` が `ip: ''` 空文字返却**
    - DBに `ip_hash` と `ip_masked` のみ、`ip` 列なし

13. **Token test (reuse/expiry) 未実装** (P1-B-06)

14. **Breached test 3ケース未実装** (P1-A-06a)

### Low
15. **Password reset 時の旧メール通知未実装**

16. **`oldEmailNotifiedAt` 未使用**

---

## Phase 1を完全完了にするために必要な作業

1. **P1-C-04a/b**: Server Action 用 CSRF 共通検証ラッパー実装（`lib/auth/csrf.ts` に Server Action 対応関数追加、`action` 用アダプタ作成）
2. **P1-C-02**: `rotateSession()` で `replaced_by` 設定追加（旧session ID を新sessionの `replaced_by` に記録）
3. **P1-D-13**: `email/change/confirm/route.ts` で `emailVerified: true` 設定、旧メールへ `sendChangeNotificationEmail` 送信、 `oldEmailNotifiedAt` 更新
4. **P1-D-14**: `softDeleteUser` 拡張または `deleteUser` 別関数で `accounts`/`webauthn_credentials`/`totp`/`recovery_codes` 無効化（status更新やdeleted_at設定）
5. **P1-A-06a**: `src/test/unit/breached.test.ts` 作成（3ケース: 通常応答=漏洩検出 / 漏洩PW検出=拒否 / timeout=エラー=fail-open許可）
6. **P1-B-06**: `src/test/security/token-reuse.test.ts` / `token-expiry.test.ts` 作成
7. **P1-C-06**: Redis レート制限実装（Upstash REST または ioredis）、race condition 対策（Luaスクリプトまたはトランザクション）
8. **P1-C-07**: `config/rate-limits.ts` に oauth/2fa/passkey/settings キー追加
9. **P1-A-02**: Argon2id 負荷テスト実施・記録（スクリプト作成・実行、256MiB未満・100ms前後確認）
10. **Security tests**: `src/test/security/` 作成、以下7ファイル実装
    - `uniq.test.ts`: 大文字小文字違い重複不可 / 論理削除済み再利用可 / partial index で二重登録拒否
    - `csrf.test.ts`: Route Handler & Server Action 双方でパイプライン通過、Origin偽装・token欠落が 403
    - `session-fixation.test.ts`: ログイン前後で session ID 変化、前session拒否
    - `token-reuse.test.ts`: token再利用失敗 / 期限切れ / purpose流用不可
    - `enumeration.test.ts`: 登録/ログイン/リセットで存在有無を区別しない統一メッセージ
    - `rate-limit.test.ts`: 各キーで閾値超過時 429、ウィンドウリセット後復帰
    - `session-attr.test.ts`: Cookie属性確認 / DBにhashのみ / 生token不存在
11. **Integration tests**: `src/test/integration/` 作成、DB・API統合テスト
12. **E2E tests**: `src/test/e2e/` 作成、Playwright設定、register→verify→login→password-change→logout / register→email-change→reset→delete フロー
13. **package.json**: `test:integration` / `test:security` / `test:e2e` scripts 追加
14. **drizzle-kit migrate**: meta journal 更新問題の調査・修正（`breakpoints: true` 設定確認等）

---

## 変更禁止の確認

**今回、コード・設定・DB・テスト・ドキュメントは一切変更していない。** 監査・確認のみ実施。
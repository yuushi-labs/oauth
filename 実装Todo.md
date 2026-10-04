# 実装Todo — 超本格アカウント・認証システム

| 項目 | 内容 |
|---|---|
| 正規典 | `超本格アカウント・認証システム仕様書 v1.0.md`（全68章） |
| 計画 | `実装計画.md` v1.1（フェーズ分解・DoD・決定事項） |
| 本Todo | 計画15章のチェックボックスを**実行可能な粒度**へ展開したもの。進捗は本ファイルで管理する |
| 作成 | 2026-10-04 |

## このファイルの使い方

- `[ ]` 未着手 / `[x]` 完了 / `⏸` ブロック中 / `⚠` 仕様書の要確認事項あり
- タスクID（`P0-01` 等）をIssue/PR名に使う（例: `P1-D-04 login 実装`）
- **前フェーズのDoDが全チェックされるまで次フェーズに進まない**（計画3章）
- 仕様の変更・削除.Lock された決定事項（下記9章）は無断で弱めない（仕様67章）

---

## 0. 今すぐ着手する5件（Phase 0 入口）

- [ ] **P0-01** Next.js 15 (App Router / TS strict / Tailwind v4) スキャフォールド + `pnpm lint && pnpm typecheck && pnpm test` が green
- [ ] **P0-03** docker-compose で PostgreSQL 16 (`db:5432`) + `drizzle-kit` 設定
- [ ] **P0-04** `.env.example` / `.gitignore`（`.env*`, `*.pem`）／**実値のsecretは作らない**
- [ ] **P0-05** `src/lib/env.ts`（zodで起動時検証・fail fast）
- [ ] **P0-06** Drizzle schema + migration 02（`users` に partial unique index 2本・通常 UNIQUE を付けない）

---

## 1. マイルストーン状況

| MS | フェーズ | 完了条件（要約） | 状態 |
|---|---|---|---|
| M0 土台 | Phase 0 | lint/typecheck/test/db green、dev起動 | [ ] 未着手 |
| M1 メール認証 | Phase 1 | アカウント7項目＋一意制約＋セッション＋CSRF＋レート制限 | [ ] 未着手 |
| M2 基盤 | Phase 2 | セキュリティ11項目＋ヘッダー/CORS | [ ] 未着手 |
| M3 UI | Phase 3 | UI 6項目＋セッション一覧/個別/全ログアウト | [ ] 未着手 |
| M4 ソーシャル | Phase 4 | Google/GitHub/Discord ログイン＋紐付け＋解除 | [ ] 未着手 |
| M5 2FA | Phase 5 | TOTP＋Recovery Codes＋atomic 1回限り | [ ] 未着手 |
| M6 Passkey | Phase 6 | Passkey 登録/ログイン/削除＋Level3検証 | [ ] 未着手 |
| M7 管理者 | Phase 7 | RBAC＋監査ログ＋secret非露出 | [ ] 未着手 |
| M8 完成 | Phase 8-9 | §48 テスト全件 green＋CI green＋バックアップ/監視 | [ ] 未着手 |

**システム完成 = M8 達成**（＝仕様64章の完成条件。Appleのみ C-01 で除外）

---

## 2. Phase 0 — プロジェクト土台（0.5〜1日）

### 2.1 スキャフォールド / 設定

- [ ] **P0-01** `package.json` / `tsconfig.json`(strict) / `next.config.ts` / ESLint+Prettier 設定
- [ ] **P0-02** Next.js 15 (App Router, TS, Tailwind v4) スキャフォールド
- [ ] **P0-03** PostgreSQL 16 を docker-compose で用意（`db:5432`）＋ `drizzle.config.ts`
- [ ] **P0-04** `.env.example`（実値はGitに無し）/ `.gitignore`（`.env*`, `*.pem`）
- [ ] **P0-05** `src/lib/env.ts`（zodで起動時検証・fail fast）／**DoD: 欠落/不正で起動時に明示エラー**

### 2.2 DB / 共通基盤

- [ ] **P0-06** `src/lib/db/{schema.ts,client.ts}`（Drizzle）
  - [ ] **P0-06a** `users.username`/`users.email` に **partial unique index**（`lower(...)` WHERE `deleted_at IS NULL`）
  - [ ] **P0-06b** 通常の UNIQUE 制約を **付けない**（論理削除済み email/username の再利用を妨げるため・計画7.1）
  - [ ] **P0-06c** `CHECK (status <> 'active' OR email_verified = true)`
  - [ ] **P0-06d** migration 作成順序 01→10（計画7.11）、02 に「UNIQUE を付ける」ALTER を含めない
- [ ] **P0-07** `src/lib/util/{id.ts,time.ts,crypto.ts,ip.ts,logger.ts}` ＋ 単体テスト
  - [ ] **P0-07a** `id.ts` は `ulid()` + prefix（`usr_`/`ses_`/`acc_`/`evt_`、§59）
  - [ ] **P0-07b** `logger.ts` は secret redaction 付き（§45）
- [ ] **P0-08** `src/lib/errors.ts`（§58 統一応答形式＋code Enum）
- [ ] **P0-09** `src/lib/validate/*`（zod: email/username/password/…）

### 2.3 UI 土台

- [ ] **P0-10** `src/app/layout.tsx` + `globals.css`（CSS変数 light/dark、FOUC防止の同期インラインscript）
- [ ] **P0-11** `pnpm lint && pnpm typecheck && pnpm test` が通る

**DoD（Phase 0）**
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm db:migrate && pnpm dev` が **全て green**
- [ ] migration 02 に partial unique index が含まれ、`username`/`email` に UNIQUE が **無い**ことをスキーマ差分で確認（★）

---

## 3. Phase 1 — メール/パスワード認証（3〜4日）

### 3-A パスワード基盤

- [ ] **P1-A-01** `lib/auth/password.ts`: Argon2id（`m=19456,t=2,p=1` 起步、**値は設定化**）／OWASP 最低水準以上
- [ ] **P1-A-02** 負荷テストで **256MiB 未満・100ms 前後** を実測して記録（★）
- [ ] **P1-A-03** verify（`argon2.verify`）＋ rehash 判定（パラメータ更新時）
- [ ] **P1-A-04** `lib/auth/strength.ts`: 長さ **8文字以上**（C-02・上限128+・ASCII限定しない・スペース許可）、NG表現/脆弱PW候補のみ拒否、zod `refine` 化。**定期変更強制はしない**
- [ ] **P1-A-05** `lib/auth/breached.ts`: HIBP k-anonymity（SHA-1 の先頭5桁のみ送信）、timeout/エラー時は **fail-open（許可）**
  - [ ] **P1-A-05a** 挙動は `BREACH_CHECK_FAIL_OPEN`（既定 true）で管理
  - [ ] **P1-A-05b** fail-open した事実を `security_events` に記録（検知可能に）
- [ ] **P1-A-06** 単体テスト: hash形式 / salt一意性 / Unicode・スペース・128+文字長OK / breached 3ケース
  - [ ] **P1-A-06a** ①通常応答=漏洩を検出 ②漏洩PW検出=拒否 ③timeout=fail-open で許可

### 3-B メールトークン

- [ ] **P1-B-01** `lib/auth/tokens/{generate,hash,verify}.ts`（256bit・hash保存・TTL・1回限り）
- [ ] **P1-B-02** `email_verification_tokens`(30分) / `password_reset_tokens`(60分) マイグレーション
- [ ] **P1-B-03** `purpose` 列で流用防止（verification token を reset に使用不可）／`used_at` と同トランザクションで invalidate
- [ ] **P1-B-04** 発行時に同一ユーザーの未使用トークンを失効（再発行によるコスト増・無制限化防止・★）
- [ ] **P1-B-05** `lib/auth/email/{send,templates}.ts` ＋ Resend 接続 ＋ 6種テンプレ
- [ ] **P1-B-06** テスト: token 再利用失敗 / 期限切れ / purpose 流用不可

### 3-C セッション / CSRF / レート制限基盤

- [ ] **P1-C-01** `lib/auth/cookie.ts`: `__Host-auth_session` / `__Host-auth_anon`（HttpOnly/Secure/SameSite=Lax/Path=/Domainなし）
- [ ] **P1-C-02** `lib/auth/session.ts`: create/get/**rotate**/touch/revoke/revokeAll、`session_hash`=HMAC-SHA256(pepper, token)
- [ ] **P1-C-03** `sessions` マイグレーション（`absolute_expires_at` 90日 / `replaced_by` / `revoke_reason` / `ip_hash`+`ip_masked` / `device_name` / `reauth_verified_at` / `totp_pending`）
- [ ] **P1-C-04** `lib/auth/csrf.ts`: HMAC token ＋ Origin検証 ＋ **共通パイプライン**（Origin→CSRF→認証→再認証→認可→入力検証→処理）
  - [ ] **P1-C-04a** **Route Handler と Server Action の双方から同一の検証関数**を呼ぶ（一方でのみ検証する経路を残さない・★）
  - [ ] **P1-C-04b** 「Server Action だから CSRF 不要」にならないこと（自動付与が落ちてもサーバ側で拒否）
  - [ ] **P1-C-04c** 例外は OAuth コールバック等（GET 必須経路）のみ。`state`＋OIDC `nonce` で担保（★）
- [ ] **P1-C-05** `lib/auth/reauth.ts`（`POST /api/auth/reauth`、猶予 **5分**、`REAUTH_REQUIRED`）
- [ ] **P1-C-06** `lib/auth/rate-limit.ts`: Redis ＋ **PG フォールバック**（D-05）、キー設計は計画8.6
- [ ] **P1-C-07** `config/rate-limits.ts` に制限値を集約（コード散在禁止・§56）
- [ ] **P1-C-08** `middleware.ts`: セキュリティヘッダー / CORS許可リスト / 粗いIP制限
- [ ] **P1-C-09** `security_events` マイグレーション ＋ `lib/auth/security-events.ts`（**16種** EventType Enum・§21）

### 3-D エンドポイント（作成順）

- [ ] **P1-D-01** `POST /api/auth/register`（8文字以上＋breached、username/email一意は partial unique index に委譲、23505捕捉→§46統一メッセージ、`status=pending_email`、確認メール、レート制限、CSRF）
- [ ] **P1-D-02** `POST /api/auth/login`（email/username 受理、統一メッセージ、Argon2 verify、**必ず新セッション発行**、レート3種キー、`login_success`/`login_failed`）
- [ ] **P1-D-03** `POST /api/auth/logout`（現行revoke＋Cookie削除）
- [ ] **P1-D-04** `GET /api/auth/me`
- [ ] **P1-D-05** `POST /api/auth/verify-email`（token照合→`email_verified=true`→`status=active`、通知）
- [ ] **P1-D-06** `POST /api/auth/resend-verification`（§4.3上限: email 5/時, ip 10/時）
- [ ] **P1-D-07** `POST /api/auth/password/forgot`（**存在有無を返さない**、リセットメール、レート制限）
- [ ] **P1-D-08** `POST /api/auth/password/reset`（token無効化＋**全セッションrevoke（現行含む）**＋通知）
- [ ] **P1-D-09** `POST /api/auth/password/change`（**再認証必須**、旧PW検証、`password_changed_at` 更新、他セッションrevoke、通知）
- [ ] **P1-D-10** `PUT /api/auth/password/set`（パスワード未設定状態の初回設定・**再認証必須**・email検証済のみ／D-02）
- [ ] **P1-D-11** `POST /api/auth/reauth`
- [ ] **P1-D-12** 統合テスト: 登録→メール確認→ログイン→PW変更→ログアウト の一連フロー

**DoD（Phase 1）**
- [ ] 仕様64章「アカウント」7項目が全て動く（email確認・PWリセット含む）
- [ ] `test/security/uniq.test.ts` green: ①大文字小文字違いで重複登録不可 ②論理削除済み email/username は再登録可 ③二重登録は partial unique index で拒否
- [ ] `test/unit/breached.test.ts` の3ケース green
- [ ] `test/security/csrf.test.ts`: Route Handler と Server Action の双方でパイプライン通過、Origin偽装・token欠落が 403
- [ ] `test/security/{session-fixation,token-reuse,enumeration,rate-limit,session-attr}.test.ts` green
- [ ] セッションCookie に `HttpOnly/Secure/SameSite=Lax/__Host-` が全部付き、**生トークンがDBに存在しない**
- [ ] `test/unit/log-redaction.test.ts`: ログにPW/token/session が1件も出力されない

---

## 4. Phase 2 — セキュリティ基盤強化（1.5日）

- [ ] **P2-01** `next.config.ts` に5種ヘッダー（HSTS/CSP/X-Content-Type-Options/Referrer-Policy/Permissions-Policy）
  - [ ] **P2-01a** CSP は `script-src 'self' 'nonce-...'` 方針（★）
  - [ ] **P2-01b** `Strict-Transport-Security: max-age=63072000; includeSubDomains`（production のみ）
  - [ ] **P2-01c** `referrer-policy: strict-origin-when-cross-origin` / `frame-ancestors 'none'` / `nosniff`
- [ ] **P2-02** HTTPS リダイレクト強制
- [ ] **P2-03** CORS 許可リスト（**ワイルドカード禁止**、`credentials:true` との併用禁止／§47）
- [ ] **P2-04** `rate-limit.ts` を計画8.6の全キー（表11行 / **13キー**）へ拡張
- [ ] **P2-05** 段階的対応: 5回failed→CAPTCHA hook（**Turnstile interface のみ**用意、実接続は Phase 9／★）
- [ ] **P2-06** `scripts/purge-expired.ts`（期限切れ token/session の cron 削除）
- [ ] **P2-07** 全認証カバレッジが `security_events` に書込むことのテスト
- [ ] **P2-08** テスト: `headers.test.ts` / `cors.test.ts` / `injection.test.ts`(XSS/SQLi) / `idor.test.ts`

**DoD（Phase 2）**
- [ ] 全 endpoint（Route Handler / Server Action 双方）にパイプライン・レート制限・ヘッダーが適用済み
- [ ] `test/security/**` の Phase 2 分が green
- [ ] 仕様48章「Web」カテゴリ完了

---

## 5. Phase 3 — UI / テーマ / 通知 / デバイス管理（3〜4日）

### 5-A 共通UI + テーマ（§39-42）

- [ ] **P3-A-01** shadcn/ui 導入（button, input, label, card, dialog, toast, tabs, alert）
- [ ] **P3-A-02** `components/theme/*`: ThemeProvider / ThemeToggle / **system 購読（§41）** / FOUC防止
- [ ] **P3-A-03** `globals.css` CSS変数（`--bg --fg --card --border --primary --muted-fg --danger --success --warning --ring --disabled-bg`）
- [ ] **P3-A-04** コントラスト検証（dark でも 4.5:1 以上）／状態は **色＋アイコン＋テキスト**（§42）
- [ ] **P3-A-05** `settings/appearance`（system/light/dark の3択）＋ `PATCH /api/auth/preferences`
- [ ] **P3-A-06** テーマ同期: 未ログイン=localStorage、ログイン済=`user_preferences.theme` 優先、**既定 `system`**（§40）
- [ ] **P3-A-07** `matchMedia('(prefers-color-scheme: dark)')` の change 購読（リロード不要で切替・§41）
- [ ] **P3-A-08** レスポンシブ 375/768/1024/1440 でログイン〜設定を操作可能（§43）
- [ ] **P3-A-09** アクセシビリティ: 全フォームに label/`autocomplete`、エラーは `aria-live=polite`、フォーカスリング視認可、WCAG AA 目標

### 5-B 認証画面

- [ ] **P3-B-01** `/register`（PW meter、**8文字**表記、breached エラー表示）
- [ ] **P3-B-02** `/login`（email/username 切替、社会ログインボタンは **registry から自動生成**、passkey ボタン、2FA入力UI、メッセージ統一）
- [ ] **P3-B-03** `/verify-email`（GETで状態変更しない＝UI表示→auto POST／§25）
- [ ] **P3-B-04** `/forgot-password`（常に同一メッセージ）
- [ ] **P3-B-05** `/reset-password`（token＋新PW＋PW meter）
- [ ] **P3-B-06** 未ログイン時の `settings/*` はサーバ側ガードで `/login` へ（§49）

### 5-C セッション/デバイス管理（§19, 38）

- [ ] **P3-C-01** `GET /api/auth/sessions`（現在を先頭、device / ip_masked / last_seen）
- [ ] **P3-C-02** `DELETE /api/auth/sessions/{id}`（**owner 確認で IDOR 防止**）
- [ ] **P3-C-03** `POST /api/auth/logout-all`（再認証必須）＋通知メール
- [ ] **P3-C-04** `settings/sessions` カードUI（現在デバイス表示、個別/全ログアウト）
- [ ] **P3-C-05** `util/device.ts`（`ua-parser-js`）で `device_name` 生成（例: `Chrome on Windows`）

### 5-D 通知メール（§18, 44）

- [ ] **P3-D-01** 新規デバイスログイン通知（デバイス名、**masked IP** `203.0.113.xxx`、地域、日時）
- [ ] **P3-D-02** 変更系通知（PW変更 / email変更 / Passkey追加削除 / 連携追加解除 / 全ログアウト）
- [ ] **P3-D-03** `settings/security` 一覧（§37 レイアウト：PW最終変更・email+認証済・2FA・passkey数・連携・デバイス・全ログアウト・最近のセキュリティイベント）
- [ ] **P3-D-04** `GET /api/auth/security/events`（自イベント、直近N件、読み取り専用GET）
- [ ] **P3-D-05** 文面の一元化（`messages/ja.ts`）、HTML+text/plain 併記、**ログにメール本文/token を出さない**（`token=` も redaction・★）

**DoD（Phase 3）**
- [ ] 仕様64章「セッション」「UI」カテゴリ完了
- [ ] `test/e2e/{login,register,theme,sessions}.spec.ts` green（モバイル viewport 含む）

---

## 6. Phase 4 — OAuth（2〜3日）: Google / GitHub / Discord（Apple 除外 C-01）

### 6-A プロバイダー接続

- [ ] **P4-A-01** `lib/auth/oauth/registry.ts`（型: provider定義、検証関数、**1エントリ追加で有効化**／UIも registry から自動生成）
- [ ] **P4-A-02** Google（OIDC、`openid-client`、nonce検証、iss/aud/exp/alg(RS256固定)/signature）
- [ ] **P4-A-03** GitHub（OAuth2、**`/user/emails` で `verified && primary` を採用**、nullなら signup 不可／D-10）
- [ ] **P4-A-04** Discord（OAuth2、`identify email` scope、`verified=true` のみ採用／D-11）
- [ ] **P4-A-05** `env.ts` に各 credential（`secret` は env、**Front へ露出しない**）
- [ ] **P4-A-06** `accounts` マイグレーション（`UNIQUE(provider, provider_account_id)`、refresh token 列を持たない／D-06）

### 6-B フロー

- [ ] **P4-B-01** `GET /api/auth/oauth/{provider}`（未登録は404、`state`=base64url(32B random)、`nonce`、`code_verifier`(S256) を anonCookie/Redis へ TTL10分・1回限り、scope最小）
- [ ] **P4-B-02** `redirect_uri` は env 駆動の**登録済みURL完全一致**（DB保存の任意URL禁止／§62）
- [ ] **P4-B-03** `GET /api/auth/oauth/{provider}/callback` — 計画12.2 の判定フローを**全実装**
  - [ ] **P4-B-03a** state 不一致/期限切れ → `INVALID_STATE`（`login_failed` 記録）
  - [ ] **P4-B-03b** token exchange 成功後に `state` を消費（**認可コード再利用防止**・★）
  - [ ] **P4-B-03c** `status` が suspended/deleted → 403
  - [ ] **P4-B-03d** **セッションローテーション**（callback後も必ず新セッション）
  - [ ] **P4-B-03e** 新規デバイスなら通知メール
- [ ] **P4-B-04** レート制限: `oauth-start` / `oauth-callback`

### 6-C 連携（account linking）

- [ ] **P4-C-01** **email一致での自動統合を禁止**（§11）→ ログイン誘導 → `POST /api/auth/oauth/link`（**再認証必須**）
- [ ] **P4-C-02** `DELETE /api/auth/accounts/{id}`（再認証必須、**最後の認証手段なら削除拒否**・★、通知）
- [ ] **P4-C-03** `settings/connected-accounts` 一覧/追加/解除UI
- [ ] **P4-C-04** 連携追加/削除の通知メール

**DoD（Phase 4）**
- [ ] 仕様64章「ソーシャルログイン」（3 provider ＋ 紐付け/解除、Apple除く）完了
- [ ] `test/security/{oauth-state,oauth-pkce,oauth-nonce,oauth-redirect,oauth-replay,account-linking}.test.ts` green

---

## 7. Phase 5 — TOTP 2FA ＋ Recovery Codes（2〜3日）

### 7-A 秘密鍵管理（§13.1）

- [ ] **P5-A-01** `util/crypto.ts`: AES-256-GCM（envelope key、`TOTP_ENCRYPTION_KEY` は env/Secret Manager、**DBに無し**）
- [ ] **P5-A-02** `lib/auth/totp.ts`（`otpauth`、6桁、drift ±1、**同一timestep再利用拒否** via `last_used_counter`）
- [ ] **P5-A-03** **`last_used_counter` の更新を atomic に**（D-16）
  - [ ] **P5-A-03a** `UPDATE ... WHERE last_used_counter < :c` の更新件数で判定、または `SELECT ... FOR UPDATE`
  - [ ] **P5-A-03b** **read → 判定 → write の素の2段書きは禁止**
- [ ] **P5-A-04** `test/security/2fa-concurrent-replay.test.ts`: 同一TOTPコードを2並行送信 → **成功1件のみ**・他方 `INVALID_CODE`

### 7-B フロー

- [ ] **P5-B-01** `POST /api/auth/2fa/setup`（再認証必須、secret＋QR `otpauth://`、`enabled=false`）
- [ ] **P5-B-02** `POST /api/auth/2fa/verify`（検証成功で enabled、**backup codes 10個をこの時のみ表示**／以後再取得不可）
- [ ] **P5-B-03** ログイン時 `totp_pending=true` のセッション発行 → `/login` の2FA入力UI → `2fa/challenge(/verify)` で昇格
- [ ] **P5-B-04** `recovery_codes`: hash保存・1回限り・使用即無効化・**残数<3で再生成を促す**（§13.2）
- [ ] **P5-B-05** `POST /api/auth/2fa/disable`（**再認証必須**＋TOTP/recovery、secret削除、`2fa_disabled`、通知）
- [ ] **P5-B-06** `POST /api/auth/2fa/recovery-codes/regenerate`（再認証必須、既存無効→新10個）
- [ ] **P5-B-07** レート制限: 2FA入力 **10/5分**（総当たり対策）

**DoD（Phase 5）**
- [ ] 仕様64章「高度な認証」TOTP / Recovery Codes 完了
- [ ] `test/security/{2fa-bruteforce,2fa-disable-reauth,recovery-code-reuse,2fa-concurrent-replay}.test.ts` green
- [ ] 同一TOTPコードの並行送信で成功1件のみ（atomic 更新）をテストで固定
- [ ] ログ/管理画面/API応答に **TOTP secret が1件も現れない**

---

## 8. Phase 6 — Passkey / WebAuthn（2〜3日）

### 8-A 基盤

- [ ] **P6-A-01** `@simplewebauthn/server` 導入（rpID=host、rpName、origin を dev/prod で切替）
- [ ] **P6-A-02** `webauthn_credentials` マイグレーション（credential_id UNIQUE, public_key, sign_count, transports, aaguid, device_name, backed_up）
- [ ] **P6-A-03** challenge 保存（**TTL 5分・1回限り**・★）

### 8-B 登録（再認証必須）

- [ ] **P6-B-01** `POST /api/auth/passkey/register/options`（rpID=host、`userVerification=preferred`）
- [ ] **P6-B-02** `POST /api/auth/passkey/register/verify`（origin / rpIDHash / signature / flags 検証、**公開鍵のみ保存**、通知、`passkey_added`）
- [ ] **P6-B-03** `GET /api/auth/passkey`（device_name, created_at, last_used_at）
- [ ] **P6-B-04** `DELETE /api/auth/passkey/{id}`（**再認証必須**、最後のpasskeyなら PW/2FA 残存チェック、通知）

### 8-C ログイン

- [ ] **P6-C-01** `POST /api/auth/passkey/login/options`（discoverable 対応、`allowCredentials`）
- [ ] **P6-C-02** `POST /api/auth/passkey/login/verify`（検証、sign_count 更新、last_used_at 更新、**新セッション発行**）
- [ ] **P6-C-03** UI: ログインボタンの passkey、`settings/security` の passkey 管理カード

**DoD（Phase 6）**
- [ ] 仕様64章「Passkey」完了
- [ ] `test/security/{webauthn-challenge-reuse,webauthn-origin,webauthn-rpid,webauthn-signcount,webauthn-deleted}.test.ts` green

---

## 9. Phase 7 — 管理者 / RBAC / 監査（1.5〜2日）

- [ ] **P7-01** `roles` マイグレーション ＋ seed（user/moderator/admin/superadmin）
- [ ] **P7-02** `requireRole()` ガード（**server-side のみ**、§49/§50）
- [ ] **P7-03** 管理者ポリシー（§51）: **2FA必須**、Passkey推奨、セッション短め(8h)、再認証、管理操作ログ
- [ ] **P7-04** `admin_audit_logs` マイグレーション ＋ `lib/auth/audit.ts`（**5種**アクション: `admin_user_viewed` / `admin_user_suspended` / `admin_user_unsuspended` / `admin_session_revoked` / `admin_account_deleted`）
- [ ] **P7-05** `GET /api/admin/users`（requireRole(admin)、**PW/TOTP secret は絶対に返さない**・★）
- [ ] **P7-06** `POST /api/admin/users/{id}/suspend` / `unsuspend`（監査ログ、対象session全revoke）
- [ ] **P7-07** `POST /api/admin/users/{id}/sessions/revoke`（`admin_session_revoked`）
- [ ] **P7-08** `GET /api/admin/audit-logs`（requireRole(admin)以上、`admin_audit_logs` のみ）
- [ ] **P7-09** 一般ユーザーから監査ログを遮断（API遮断＋可能ならDBロール分離）

**DoD（Phase 7）**
- [ ] `test/security/{rbac,admin,audit-access}.test.ts` green
- [ ] 管理者APIが secret を一切返さないことをテストで固定

---

## 10. Phase 8 — リスク検知 ＋ テスト完成（1.5〜2日）

- [ ] **P8-01** `lib/auth/risk.ts`: 新規デバイス、短時間多数地域、異常速度（geo距離/時間）、大量試行（`failed_logins` 集計）
- [ ] **P8-02** リスクスコア → **3段階**（追加認証要求 / メール通知 / セッション保留）★
- [ ] **P8-03** `test/security/risk.test.ts`
- [ ] **P8-04** `test/security/**` で仕様48章の全カテゴリを充足（下記11章の表）
- [ ] **P8-05** E2E: Playwright（登録→確認→ログイン→2FA→passkey→設定→削除まで通し）
- [ ] **P8-06** `pnpm test` / `pnpm test:e2e` / `pnpm test:security` が全て green
- [ ] **P8-07** テスト基盤: fixtures（通常/未検証/suspended/PW無し/admin）、oauth-mock（`jose` で署名したID token）、webauthn-mock、totp、fake rate-limit store、fake timers（時間依存テストの flaky 防止・★）

**DoD（Phase 8）**
- [ ] 仕様48章チェックリストに1:1で green テストが対応

---

## 11. Phase 9 — 運用デプロイ（1日）

- [ ] **P9-01** 本番構成: HTTPS enforced、Nginx/Cloudflare、env/secret 管理（Secret Manager or sealed env）
- [ ] **P9-02** CI（GitHub Actions）: lint / typecheck / test / db-check / **`gitleaks`（secret混入検出）** / `npm audit` ★
- [ ] **P9-03** バックアップ: 認証データ日次・暗号化保管 ＋ **復元テスト手順書**（§53）
- [ ] **P9-04** 監視: ログのsecret検知、異常ログイン集計、`security_events` アラート（login系5xx/分 > 閾値）★
- [ ] **P9-05** ドキュメント: 運用ランブック（suspend / 復旧 / キーローテ）、**§54-55 の手動復旧フロー**（メール喪失時・弱い本人確認は禁止）
- [ ] **P9-06** 定期Job: `purge-expired`（token/session）、`security_events` **保持180日**パージ
- [ ] **P9-07** SPF/DKIM/DMARC 設定・text/plain 併記（メール到達性）

**DoD（Phase 9）**
- [ ] 本番相当環境で `pnpm build` → smoke test 成功
- [ ] CI green
- [ ] バックアップ復元テストを **1回実施済み**

---

## 12. セキュリティテストトラッカー（仕様48章 → ファイル）

| 仕様 | テストファイル | 主要ケース | 状態 |
|---|---|---|---|
| 認証 | `test/security/auth.test.ts` | 正PW/誤PW/存在しないemail/未認証email/session期限切れ/logout後のAPI拒否 | [ ] |
| 一意制約(§3.1/§24) | `uniq.test.ts` | 大文字小文字違いで重複不可／論理削除済みは再利用可／partial index で二重登録拒否 | [ ] |
| パスワード | `password.test.ts` | 7文字拒否/8文字OK/128+OK/Unicode+スペース/reset token再利用拒否 | [ ] |
| 漏洩PW(§5.2) | `test/unit/breached.test.ts` | ①漏洩検出 ②漏洩PW拒否 ③timeout=**fail-open で許可** | [ ] |
| OAuth | `oauth-state/nonce/pkce/redirect/replay/account-linking.test.ts` | state改ざん/code再利用/PKCE不一致/redirect_uri改ざん/nonce改ざん/未登録provider/**email一致自動統合の拒否** | [ ] |
| セッション | `session.test.ts` | Cookie属性/fixation(前後でID変化)/logout-all後の旧Cookie拒否/DBはhash保存 | [ ] |
| Web | `web.test.ts` | XSS/CSRF（Origin偽装・token欠落・**Route Handler と Server Action 双方**）/SQLi/Open Redirect/Clickjacking/CORS(`*`拒否)/Header不足 | [ ] |
| 2FA | `2fa.test.ts` | TOTP誤入力/総当たり(recovery code再利用)/無効化時の再認証 | [ ] |
| 2FA 並行(D-16) | `2fa-concurrent-replay.test.ts` | 同一TOTP 2並行送信 → 成功1件・他方拒否 | [ ] |
| Passkey | `webauthn-*.test.ts` | challenge再利用/origin不一致/rpID不一致/削除済みcredential拒否/sign_count更新 | [ ] |
| RBAC/管理者 | `rbac.test.ts` / `admin.test.ts` / `audit-access.test.ts` / `idor.test.ts` | 権限判定/secret非露出/監査遮断/他者リソース参照拒否 | [ ] |
| リスク検知(§57) | `risk.test.ts` | 新規デバイス/地域移動/大量試行 | [ ] |
| ログ秘匿(§45) | `test/unit/log-redaction.test.ts` | PW/hash/client secret/token/TOTP secret/session token が出ない | [ ] |
| その他単体 | `id.test.ts` / `time.test.ts` / `ip-mask.test.ts` / `crypto.test.ts` / `notify-events.test.ts` | prefix付きULID/UTC/203.0.113.xxx/AES-GCM/通知イベント | [ ] |
| E2E | `test/e2e/{login,register,theme,sessions,email-change,account-delete}.spec.ts` | 画面フロー（モバイル viewport） | [ ] |

---

## 13. PR ごとの DoD チェックリスト（計画20.3・全PRで必須）

- [ ] 新規/変更 API（Route Handler / Server Action **双方**）に §8.4 パイプライン・レート制限・`require*`ガードが適用済み（**「Server Action だから CSRF 不要」になっていないか**）
- [ ] 秘密情報（PW/token/secret/session）をログ・API応答・`metadata` に漏らしていない（§45）
- [ ] 認可をサーバー側で行っている（IDOR なし、§49）
- [ ] 該当操作の `security_events` 記録がある（§21）
- [ ] 新テーブル/列に制約・index・マイグレーションがある（**一意性は partial index の要否も確認**）
- [ ] 新規 mutation は POST/PUT/PATCH/DELETE（**GET で状態変更しない**、§25）
- [ ] TOTP/recovery code など「1回限り」の値は **atomic 更新**（read-then-write していないか、D-16）
- [ ] エラーが §58 統一形式で、詳細を漏らしていない
- [ ] `pnpm lint && pnpm typecheck && pnpm test` が green

---

## 14. ロックされた決定事項（変更不可・要遵守）

| ID | 決定 | 影響タスク |
|---|---|---|
| C-01 | **Apple を除外**（Google/GitHub/Discord の3つのみ） | P4-A-01, P6-C-03, 画面・メール・テストから Apple を削除 |
| C-02 | パスワード最低長 **8文字**（上限128+、ASCII限定しない、スペース許可） | P1-A-04, P3-B-01 |
| D-01 | メール未認証でもログイン可（メール必須操作のみ `email_verified` 要求） | P1-D-02 |
| D-02 | `PUT /api/auth/password/set` を新設（PW未設定→初回設定） | P1-D-10 |
| D-03 | PW変更/リセット後は**全セッション revoke（現行含む）**。オプトアウト無し | P1-D-08, P1-D-09 |
| D-04 | username/email は **case-insensitive 一意**（partial unique index のみ） | P0-06a/b |
| D-05 | Redis 不在時は **PG フォールバック**（D-05） | P1-C-06, P2-04 |
| D-06 | OAuth の access/refresh token は **DBに保存しない**（scope最小・`offline_access` 不使用） | P4-A-06 |
| D-07 | email変更は `email_change_requests` に pending 保持。`status` は不変 | P1-D-*, §14 |
| D-10/D-11 | GitHub は `/user/emails` の verified&&primary、Discord は `verified=true` のみ採用 | P4-A-03/04 |
| D-13 | `security_events.ip` は生IP保持（**表示のみ mask**）、保持180日 | P2-06, P9-06 |
| D-14 | 再認証の猶予 **5分** | P1-C-05 |
| D-16 | TOTP `last_used_counter` は **atomic 更新**（read-then-write 禁止） | P5-A-03, P7(§13.2 analog) |
| D-17 | HIBP timeout は **fail-open**（`BREACH_CHECK_FAIL_OPEN`） | P1-A-05 |

---

## 15. 禁止事項（仕様62/67章・レビューで必ず確認）

- [ ] パスワード平文/Base64 保存、SHA-256 のみで保存 ← 禁止
- [ ] 自作暗号・自作Argon2・自作JWT検証・自作OAuth state・自作WebAuthn検証 ← 禁止（標準ライブラリ使用）
- [ ] session token を localStorage へ保存 ← 禁止（`__Host-` Cookie + サーバセッション）
- [ ] OAuth client secret を Frontend へ配置 ← 禁止
- [ ] access token / password hash / TOTP secret をログ出力 ← 禁止
- [ ] 任意 redirect URL、OAuth state の固定値、**PKCE なし OAuth** ← 禁止
- [ ] メール確認トークンの無期限化、**パスワードリセットトークンの再利用** ← 禁止
- [ ] 管理者権限を Frontend だけで制御 ← 禁止（サーバ側 `requireRole`）
- [ ] SQL 文字列連結 ← 禁止（Drizzle のパラメータ化 API のみ）
- [ ] 秘密鍵 / `.env` を Git へ commit ← 禁止（`.gitignore` + `gitleaks` CI）
- [ ] 「ユーザー名と生年月日だけで復旧」などの弱い本人確認 ← 禁止（§55）

---

## 16. MVP対象外 / 将来バックログ

- [ ] Apple OAuth（C-01 で除外。必要になれば registry に1エントリ追加で再開可）
- [ ] `role_permissions` テーブル（将来拡張用定義。MVPでは未使用）
- [ ] `trusted_devices` テーブル（将来拡張。MVPでは作成しない）
- [ ] moderator / superadmin の権限付与・判定・テスト（MVPは user/admin のみ）
- [ ] avatar 画像アップロード（MVPは URL のみ／D-08）
- [ ] Turnstile の実接続（Phase 2 は interface のみ、接続は Phase 9）
- [ ] Google の `offline_access` / refresh token 運用（D-06 で不採用）
- [ ] 高度な risk-based authentication の追加段階

---

## 17. 進捗ログ

| 日付 | 完了タスク | 備考 / ブロッカー |
|---|---|---|
| 2026-10-04 | （Todo 起票） | 実装未着手。Phase 0 P0-01 から着手 |
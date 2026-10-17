# 実装Todo — 超本格アカウント・認証システム

| 項目 | 内容 |
|---|---|
| 正規典 | `超本格アカウント・認証システム仕様書 v1.3.md`（全69章） |
| 計画 | `実装計画.md` v1.6（フェーズ分解・DoD・決定事項） |
| 本Todo | 計画15章のチェックボックスを**実行可能な粒度**へ展開したもの。進捗は本ファイルで管理する |
| 作成 | 2026-10-04 |

## このファイルの使い方

- `[ ]` 未着手 / `[x]` 完了 / `⏸` ブロック中 / `⚠` 仕様書の要確認事項あり
- タスクID（`P0-01` 等）をIssue/PR名に使う（例: `P1-D-04 login 実装`）
- **前フェーズのDoDが全チェックされるまで次フェーズに進まない**（計画3章）
- 仕様の変更・削除。ロックされた決定事項（下記14章）は無断で弱めない（仕様67章）
- テストファイルのパスはすべて `src/test/**`（計画 D-18）に統一する

---

## 0. Phase 0 着手時に最初におこなった5件（完了済み）

- [x] **P0-01** Next.js 15 (App Router / TS strict / Tailwind v4) スキャフォールド + `pnpm lint && pnpm typecheck && pnpm test` が green
- [x] **P0-03** docker-compose で PostgreSQL 16 (`db:5432`) + `drizzle-kit` 設定
- [x] **P0-04** `.env.example` / `.gitignore`（`.env*`, `*.pem`）／**実値のsecretは作らない**
- [x] **P0-05** `src/lib/env.ts`（zodで起動時検証・fail fast）
- [x] **P0-06** Drizzle schema + migration 02（`users` に partial unique index 2本・通常 UNIQUE を付けない）

> Phase 1着手時の初期案内。現在はM0〜M2を達成し、次の実装候補はM2.5（詳細計画のGate Aを先に実施）です。

---

## 1. マイルストーン状況

| MS | フェーズ | 完了条件（要約） | 状態 |
|---|---|---|---|
| M0 土台 | Phase 0 | lint/typecheck/test/db green、dev起動、partial unique index 確認、通常UNIQUE なし確認 | **[x] 達成（2026-10-04）** |
| M1 メール認証 | Phase 1 | アカウント7項目（email確認・PWリセット・**アカウント削除**含む）＋一意制約＋セッションハッシュ/Cookie属性＋CSRF（Route Handler & Server Action 双方）＋レート制限＋session fixation テスト | **[x] 達成（2026-10-10）** |
| M2 基盤 | Phase 2 | §64のPhase 2担当分（HTTPS／Security Headers／CORS/CSRF／Web攻撃対策） | **[x] 達成（2026-10-12）** |
| M2.5 認証元 | Phase 2.5 | §69 OIDC Provider + Authorization Code/PKCE + scope/consent + first-party RP相互運用 | **[x] 達成（2026-10-17）** — 29/29 タスク完了。DoD 6 項のうち 5 項を達成、6 項目（本番公開）は Phase 9 運用 DoD へ繰り越し。残るは「本番公開の運用確認」と「multi-process adapter 一致性の実測」の 2 点のみ。`docs/phase2.5-実装計画.md` §5.1 / `docs/phase2.5-closeout-実行Todo.md` |
| M2.6 管理コンソール | Phase 2.6 | ログイン後の画面遷移＋OIDC/OAuth 2.0 アプリのセルフサービス作成・編集・secret 管理・接続テスト | **[x] 達成（2026-10-17）** — P26-A-01〜G-02 の全 33 タスク完了（PR #4 → `c82cd1c`）。DoD 4 項すべて達成。仕様書 v1.3 の §69.4-2 と整合。`docs/phase2.6-oidc-client-console-実装計画.md` |
| M3 UI | Phase 3 | §64「UI」6項目＋セッション一覧/個別/全ログアウト | [ ] 未着手 |
| M4 ソーシャル | Phase 4 | Google/GitHub/Discord ログイン＋紐付け＋解除 | [ ] 未着手 |
| M5 2FA | Phase 5 | TOTP＋Recovery Codes＋atomic 1回限り | [ ] 未着手 |
| M6 Passkey | Phase 6 | Passkey 登録/ログイン/削除＋Level3検証 | [ ] 未着手 |
| M7 管理者 | Phase 7 | RBAC＋監査ログ＋secret非露出 | [ ] 未着手 |
| M8 完成 | Phase 8-9 | §48 テスト全件 green＋CI green＋バックアップ/監視 | [ ] 未着手 |

**システム完成 = M8 達成**（＝仕様64章の完成条件。Appleのみ C-01 で除外）

---

## 2. Phase 0 — プロジェクト土台（0.5〜1日）

### 2.1 スキャフォールド / 設定

- [x] **P0-01** `package.json` / `tsconfig.json`(strict) / `next.config.ts` / ESLint+Prettier 設定
- [x] **P0-02** Next.js 15 (App Router, TS, Tailwind v4) スキャフォールド
- [x] **P0-03** PostgreSQL 16 を docker-compose で用意（`db:5432`）＋ `drizzle.config.ts`
- [x] **P0-04** `.env.example`（実値はGitに無し）/ `.gitignore`（`.env*`, `*.pem`）
- [x] **P0-05** `src/lib/env.ts`（zodで起動時検証・fail fast）／**DoD: 欠落/不正で起動時に明示エラー**

### 2.2 DB / 共通基盤

- [x] **P0-06** `src/lib/db/{schema.ts,client.ts}`（Drizzle）
  - [x] **P0-06a** `users.username`/`users.email` に **partial unique index**（`lower(...)` WHERE `deleted_at IS NULL`）
  - [x] **P0-06b** 通常の UNIQUE 制約を **付けない**（論理削除済み email/username の再利用を妨げるため・計画7.1）
  - [x] **P0-06c** `CHECK (status <> 'active' OR email_verified = true)`
  - [x] **P0-06d** migration 作成順序 01→10（計画7.11）、02 に「UNIQUE を付ける」ALTER を含めない
- [x] **P0-07** `src/lib/util/{id.ts,time.ts,crypto.ts,ip.ts,logger.ts}` ＋ 単体テスト
  - [x] **P0-07a** `id.ts` は `ulid()` + prefix（`usr_`/`ses_`/`acc_`/`evt_`、§59）
  - [x] **P0-07b** `logger.ts` は secret redaction 付き（§45）
- [x] **P0-08** `src/lib/errors.ts`（§58 統一応答形式＋code Enum）
- [x] **P0-09** `src/lib/validate/*`（zod: email/username/password/…）

### 2.3 UI 土台

- [x] **P0-10** `src/app/layout.tsx` + `globals.css`（CSS変数 light/dark、FOUC防止の同期インラインscript）
- [x] **P0-11** `pnpm lint && pnpm typecheck && pnpm test` が通る

**DoD（Phase 0）**
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm db:migrate && pnpm dev` が **全て green**
- [x] migration 02 に partial unique index が含まれ、`username`/`email` に UNIQUE が **無い**ことをスキーマ差分で確認（★）

証跡: `docs/phase0-設計.md` §12.1 / `README.md`「Phase 0 実装詳細」（2026-10-04 実施）

---

## 3. Phase 1 — メール/パスワード認証（3〜4日）

### 3-A パスワード基盤

- [x] **P1-A-01** `lib/auth/password.ts`: Argon2id（`m=19456,t=2,p=1` 起步、**値は設定化**）／OWASP 最低水準以上
- [x] **P1-A-02** 負荷テストで **256MiB 未満・100ms 前後** を実測して記録（★）
- [x] **P1-A-03** verify（`argon2.verify`）＋ rehash 判定（パラメータ更新時）
- [x] **P1-A-04** `lib/auth/strength.ts`: 長さ **8文字以上・128文字以下**（C-02・ASCII限定しない・スペース許可）、NG表現/脆弱PW候補のみ拒否、zod `refine` 化。**129文字以上は拒否**。**定期変更強制はしない**
- [x] **P1-A-05** `lib/auth/breached.ts`: HIBP k-anonymity（SHA-1 の先頭5桁のみ送信）、timeout/エラー時は **fail-open（許可）**
  - [x] **P1-A-05a** 挙動は `BREACH_CHECK_FAIL_OPEN`（既定 true）で管理
  - [x] **P1-A-05b** fail-open した事実を `security_events` に記録（検知可能に）
- [x] **P1-A-06** 単体テスト: hash形式 / salt一意性 / Unicode・スペース・128文字OK・129文字NG / breached 3ケース
  - [x] **P1-A-06a** ①通常応答=漏洩を検出 ②漏洩PW検出=拒否 ③timeout=fail-open で許可

### 3-B メールトークン

- [x] **P1-B-01** `lib/auth/tokens/{generate,hash,verify}.ts`（256bit・hash保存・TTL・1回限り）／`id` prefix は `tok_` を `util/id.ts` の `ID_PREFIXES` に追加（D-25）
- [x] **P1-B-02** `email_verification_tokens`(30分) / `password_reset_tokens`(60分) / `email_change_requests`(30分) マイグレーション
- [x] **P1-B-03** `purpose` 列で流用防止（verification token を reset に使用不可）／`used_at` と同トランザクションで invalidate
- [x] **P1-B-04** 発行時に同一ユーザーの未使用トークンを失効（再発行によるコスト増・無制限化防止・★）
- [x] **P1-B-05** `lib/auth/email/{send,templates}.ts` ＋ Resend 接続 ＋ 6種テンプレ ＋ `messages/ja.ts` を新設（メール文面と既定エラーメッセージをここに集約。Phase 3-D で UI 文言へ拡張する）
- [x] **P1-B-06** テスト: token 再利用失敗 / 期限切れ / purpose 流用不可

### 3-C セッション / CSRF / レート制限基盤

- [x] **P1-C-01** `lib/auth/cookie.ts`: `__Host-auth_session` / `__Host-auth_anon`（HttpOnly/Secure/SameSite=Lax/Path=/Domainなし）
- [x] **P1-C-02** `lib/auth/session.ts`: create/get/**rotate**/touch/revoke/revokeAll、`session_hash`=HMAC-SHA256(pepper, token)
- [x] **P1-C-03** `sessions` マイグレーション（`absolute_expires_at` 90日 / `replaced_by` / `revoke_reason` / `ip_hash`+`ip_masked` / `device_name` / `reauth_verified_at` / `totp_pending`）
- [x] **P1-C-04** `lib/auth/csrf.ts`: HMAC token ＋ Origin検証 ＋ **共通パイプライン**（Origin→CSRF→認証→再認証→認可→入力検証→処理）
  - [x] **P1-C-04a** **Route Handler と Server Action の双方から同一の検証関数**を呼ぶ（一方でのみ検証する経路を残さない・★）
  - [x] **P1-C-04b** 「Server Action だから CSRF 不要」にならないこと（自動付与が落ちてもサーバ側で拒否）
  - [x] **P1-C-04c** 例外は OAuth コールバック等（GET 必須経路）のみ。`state`＋OIDC `nonce` で担保（★）
- [x] **P1-C-05** `lib/auth/reauth.ts`（`POST /api/auth/reauth`、猶予 **5分**、`REAUTH_REQUIRED`）
- [x] **P1-C-06** `lib/auth/rate-limit.ts`: Phase 1時点のRedis＋PG案（D-05）。Phase 2でPostgreSQL正本の予約方式に更新
- [x] **P1-C-07** `config/rate-limits.ts` に制限値を集約（コード散在禁止・§56）
- [x] **P1-C-08** `middleware.ts`: セキュリティヘッダー / CORS許可リスト / 粗いIP制限
- [x] **P1-C-09** `security_events` マイグレーション ＋ `lib/auth/security-events.ts`（**16種** EventType Enum・§21）
  - [x] **P1-C-09a** `util/logger.ts` の redact キー・redact 対象パラメータへ **`code` / `state` / `nonce` / `code_verifier`** を追加（§12.4／★）。**Phase 0 で `src/lib/util/logger.ts` 自体は実装済み**で、`password` / `token` / `secret` / `access_token` / `refresh_token` 等および URL 中の `token=` / `code_verifier=` を redact している。OAuth 固有の `code` / `state` / `nonce` / `code_verifier` キー追加と OAuth フローへの配線は **Phase 1-C（キー追加）→ Phase 4-A（配線）** で行う
  - [x] **P1-C-09b** redact 対象はキー一致・URL 内パラメータ一致の両方（`?code=` `&state=` `&nonce=` `&code_verifier=` の値ごと `***` 置換）。**ログ・エラーメッセージ・監査ログ・`security_events.metadata`・例外オブジェクト出力のいずれにも出さない**（§12.4 / 17.2.1／★）

### 3-D エンドポイント（作成順）

- [x] **P1-D-01** `POST /api/auth/register`（**8〜128文字**＋breached、username/email一意は partial unique index に委譲、23505捕捉→§46統一メッセージ、`status=pending_email`、確認メール、レート制限、CSRF）
- [x] **P1-D-02** `POST /api/auth/login`（email/username 受理、統一メッセージ、Argon2 verify、**必ず新セッション発行**、レート3種キー、`login_success`/`login_failed`）
- [x] **P1-D-03** `POST /api/auth/logout`（現行revoke＋Cookie削除）
- [x] **P1-D-04** `GET /api/auth/me`
- [x] **P1-D-05** `POST /api/auth/verify-email`（token照合→`email_verified=true`→`status=active`、通知）
- [x] **P1-D-06** `POST /api/auth/resend-verification`（§4.3上限: email 5/時, ip 10/時）
- [x] **P1-D-07** `POST /api/auth/password/forgot`（**存在有無を返さない**、リセットメール、レート制限）
- [x] **P1-D-08** `POST /api/auth/password/reset`（token無効化＋**全セッションrevoke（現行含む）**＋通知）
- [x] **P1-D-09** `POST /api/auth/password/change`（**再認証必須**、旧PW検証、`password_changed_at` 更新、他セッションrevoke、通知）
- [x] **P1-D-10** `PUT /api/auth/password/set`（パスワード未設定状態の初回設定・**再認証必須**・email検証済のみ／D-02）
- [x] **P1-D-11** `POST /api/auth/reauth`
- [x] **P1-D-12** `POST /api/auth/email/change`（**再認証必須**、`email_change_requests` に pending 発行、`users.email`/`status` は不変＝D-07、確認メール送信）
- [x] **P1-D-13** `POST /api/auth/email/change/confirm`（token→`users.email` 反映＋`email_verified=true`→**旧メールへ変更通知**、`email_changed` イベント）
- [x] **P1-D-14** `DELETE /api/auth/account`（**再認証必須**、論理削除 `deleted_at`＋`status=deleted`、全session / 連携 / passkey 無効化、`account_deleted` イベント、§24）
- [x] **P1-D-15** 統合テスト: 登録→メール確認→ログイン→PW変更→ログアウト の一連フロー
- [x] **P1-D-16** 統合テスト: 登録→email変更→PWリセット→アカウント削除 の一連フロー（§14 / §24）

**DoD（Phase 1）**
- [x] 仕様64章「アカウント」7項目が全て動く（email確認・PWリセット・**アカウント削除**含む）
- [x] `src/test/security/uniq.test.ts` green: ①大文字小文字違いで重複登録不可 ②論理削除済み email/username は再登録可 ③二重登録は partial unique index で拒否
- [x] `src/test/unit/breached.test.ts` の3ケース green
- [x] `src/test/security/csrf.test.ts`: Route Handler と Server Action の双方でパイプライン通過、Origin偽装・token欠落が 403
- [x] `src/test/security/{session-fixation,token-reuse,enumeration,rate-limit,session-attr}.test.ts` green
- [x] セッションCookie に `HttpOnly/Secure/SameSite=Lax/__Host-` が全部付き、**生トークンがDBに存在しない**
- [x] `src/test/unit/log-redaction.test.ts`: ログにPW/token/session が1件も出力されない

---

## 4. Phase 2 — セキュリティ基盤強化（設計書 `docs/phase2-設計.md` v1.10 に準拠）

- [x] **P2-01** `next.config.ts` の静的ヘッダー + middlewareのnonce CSP（nonceはリクエスト毎、`x-nonce`で伝達。CSP重複禁止）
  - [x] **P2-01a** CSP nonce: script-src / frame-ancestors / base-uri / form-action等
  - [x] **P2-01b** HSTS 2年 + includeSubDomains（productionのみ）
  - [x] **P2-01c** nosniff / strict-origin-when-cross-origin / Permissions-Policy
- [x] **P2-02** HTTPSリダイレクトと許可Host検証。信頼プロキシ未設定時は転送ヘッダーを信頼しない
- [x] **P2-03** CORS`ALLOWED_ORIGINS`とCSRF`CSRF_TRUSTED_ORIGINS`を分離。Origin/Referer厳密一致、欠落/null/不正URL拒否
- [x] **P2-04** §8.6全13キー、HMAC化、PostgreSQL atomic limiter、ログイン失敗枠の予約/確定/release/成功リセット
- [x] **P2-05** 各キーのsoft limit後にCAPTCHA hook（Turnstile実providerはPhase 9、本番で未設定時は安全拒否）
- [x] **P2-06** 期限切れ予約、rate_limit_hits、email verification/password reset/email change tokens、sessionsを削除（security_eventsは対象外）
- [x] **P2-07** 認証イベントの記録カバレッジテスト
- [x] **P2-08** Web攻撃・IDORのVitestはgreen。開発用React Refresh向け`unsafe-eval`をdevelopment限定で許可。2026-10-12に実ブラウザでCSP nonce一致・Console違反なしを確認
- [x] **P2-09** 共通pipelineのmutationをHTTP methodで判定。Route Handler/Server Actionで同一Origin/CSRF検証を利用
- [x] **P2-10** `getClientIp()`を信頼proxy設定対応に変更。既定`TRUSTED_PROXY_HOPS=0`、左端XFFを無条件に信用しない
- [x] **P2-11** Phase 0のトップページを認証入口へ置換。`/login`・`/register`最小フォーム、認証後トップ、ログアウト、匿名CSRF bootstrapとcookie照合を実装

**DoD（Phase 2）**
- [x] middleware/next.configのHTTP保護、Route Handler/Server Action共通pipeline、全Phase 2対象ルートのレート制限が設計書に一致
- [x] CAPTCHA hookの開発時Noop / 本番未設定・provider未接続時のfail-closedを単体テストで確認。期限切れデータ削除はTEMPテーブルのPostgreSQL統合テストで確認
- [x] Vitestセキュリティテストgreenと実ブラウザCSP検証green（nonce一致・Console違反なし、2026-10-12）
- [x] 仕様48章「Web」のPhase 2担当項目完了

---

## 4.5 Phase 2.5 — 自作サービス向けOAuth 2.0 / OIDC Provider

詳細タスク・Gate・セキュリティDoDは [`docs/phase2.5-実装計画.md`](docs/phase2.5-実装計画.md) を正とする。

> **状態（2026-10-17 達成）**: **29/29 タスク完了**。2026-10-13 に 26/29 だった残 3 件を本日解消した。P25-E-01 は実 HTTP 負荷計測（`pnpm oidc:load`）で許可数が設定値と厳密一致することを確認して値を維持（`docs/phase2.5-load-test.md`）、P25-E-04 は up/down/往復/restore の検証で往復差分なしを確認（`docs/phase2.5-migration.md`、migration 0012 は不可逆である旨を明記）、P25-E-05 は Go の `coreos/go-oidc3` を 2 つ目の RP として追加し独立スタックでの相互運用を確認（`docs/phase2.5-interop.md`）。DoD 判定は `docs/phase2.5-実装計画.md` §5.1。残るは「本番公開（Phase 9 運用 DoD）」と「multi-process adapter 一致性の実測」の 2 点。

- [x] **P25-A** `oidc-provider`候補のNext.js統合Spike、PostgreSQL adapter/token storage評価、threat model Gate A → `docs/phase2.5-gate-a.md`・`phase2.5-threat-model.md`
  - [x] **P25-A-01** MIT / Node 22 互換 / advisory 0件を評価記録（`docs/phase2.5-gate-a.md` §1）
  - [x] **P25-A-02** custom Node server 統合・実HTTP Spike を `src/test/e2e/oidc-flow.test.ts` で実施
  - [x] **P25-A-03** 保存対象・原子1回消費を記録。raw token 保管なしを integration テストで固定
  - [x] **P25-A-04** fallback 不要と判定。運用構成と interaction UI の信頼境界を文書化
  - [x] **P25-A-05** threat model 作成・Gate A 承認（条件: client secret ハッシュ化と multi-process 実測 → 両方完了）
- [x] **P25-B** first-party client registry、scope allowlist、hashed secret、grant/token/code永続化、operator CLI、監査イベント
  - [x] **P25-B-01** ✅ `token_endpoint_auth_method` 列を追加し client type と CHECK で紐付け。secret は `hmac-sha256:` ダイジェストのみ保存し `compareClientSecret` をハッシュ比較に override（migration `0011`/`0012`）
  - [x] **P25-B-02** ✅ `oidc_artifacts` に全モデルを保存、id は HMAC のみ・payload は AES-GCM、原子1回消費（integration テストで8並列→1回のみ成功）
  - [x] **P25-B-03** ✅ `src/lib/oidc/scopes.ts` に型安全 helper を追加し provider 設定・CLI・authorize 検証・DB CHECK を単一ソース化
  - [x] **P25-B-04** ✅ CLI に `update`（name/operator/scope/redirect/origin）を追加。secret は一度だけ表示しハッシュ保存
  - [x] **P25-B-05** ✅ `oidc_token_failed` / `oidc_token_revoked` / `oidc_account_blocked` / `oidc_client_updated` を追加。`error_description` は redact 後。`recordSecurityEvent` は `SecurityEventType` 必須化
- [x] **P25-C** OIDC discovery/JWKS、Authorization Code + PKCE S256、ID Token/UserInfo/revoke、禁止grant拒否
  - [x] **P25-C-01** ✅ issuer固定・RS256・kid必須・無効機能すべて無効・起動時鍵検証
  - [x] **P25-C-02** ✅ `exactAuthorizationRequest()` が provider 到達前に全検証（E2E で10種の拒否ケースを確認）
  - [x] **P25-C-03** ✅ TTL 300s・原子1回消費・client/grant 失効の再検証
  - [x] **P25-C-04** ✅ `client_secret_basic`/`none` のみ・PKCE S256 を confidential にも必須化
  - [x] **P25-C-05** ✅ ID Token の RS256 署名・iss/aud/nonce/auth_time/sub を E2E で検証
  - [x] **P25-C-06** ✅ UserInfo の scope 別 claim 絞り込みと confirmed email のみを E2E で確認
  - [x] **P25-C-07** ✅ `adapter.find` が token/code/grant/session 参照時に account 状態を確認（停止後は UserInfo 401）
  - [x] **P25-C-08** ✅ 未対応 grant/resource 指定・未知 scope・未登録 redirect への redirect 禁止を E2E で確認
- [x] **P25-D** 既存session連携、scope同意UI、grant確認・取消し、アカウント停止連携
  - [x] **P25-D-01** ✅ 既存 `/login`・CSRF・rate limit・セッション作成を再利用、`returnTo` は interaction のみ許可
  - [x] **P25-D-02** ✅ `oauth_clients.operator`（migration `0010`）と claim 単位の日本語開示
  - [x] **P25-D-03** ✅ DB scopes を provider grant の実効 scope で書き込み乖離を解消
  - [x] **P25-D-04** ✅ 設定画面に operator・許可 scope・最終利用・個別取消し。失効 client の grant も取り消せる
  - [x] **P25-D-05** ✅ `oidc_account_blocked` を記録し、アカウント削除時に OIDC grant を破棄
- [ ] **P25-E** protocol security tests、DB並行性テスト、実RPとの相互運用E2E、RFC 9700レビュー
  - [ ] **P25-E-01** 🟡 `RATE_LIMITS.oidc` 5種（authorize/interaction/token/userinfo/revoke）を適用済み。**負荷検証による値の確定が未了**
  - [x] **P25-E-02** ✅ no-store / no-referrer / CSP+frame 拒否 / CORS 既定 deny・origin 完全一致。本番 `DEBUG=oidc-provider:*` を起動拒否。ヘッダを security テストで固定
  - [ ] **P25-E-03** ✅ OIDC 統制の unit/security/integration/e2e を追加（scope allowlist、account state、events、grants、secret hash、transport）。**全項目網羅**
  - [ ] **P25-E-04** 🟡 同時 token 交換の一回のみ成功・account 状態・grant 失効は integration で確認。**migration up/down/restore と multi-process 実測が未了**
  - [ ] **P25-E-05** 🟡 自前 RP による実通信 E2E は完了（`pnpm test:e2e`）。**複数 RP での相互運用が未了**
  - [x] **P25-E-06** ✅ `docs/phase2.5-review.md` に安全設定レビュー・依存監査（`oidc-provider` advisory 0件）・相互運用・セキュリティレビュー結果を記録

**DoD（M2.5）**: 仕様書§69.8および`docs/phase2.5-実装計画.md` §5を全件満たす。本番有効化はPhase 9運用DoD後のみ。

**着手順（2026-10-13 監査より）**
1. P25-A-01 / A-05 — Spike と threat model の記録作成、Gate A 相当の承認（secret 方針の確定を含む）
2. B-01/B-04 の secret 方針決定（`oidc-provider` が平文比較を要求する制約を確認して hashed 保存へ移行可否を判断）、E-01（負荷検証）
3. P25-E-03 残り（protocol 試験）→ P25-E-04 → P25-E-05 → P25-E-06

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
- [ ] **P3-D-05** `messages/ja.ts` へ UI 文言（ログイン/登録/設定画面）を追加して一元化を完了（Phase 1-B でメール文面＋エラーメッセージは作成済み）、HTML+text/plain 併記、**ログにメール本文/token を出さない**（`token=` も redaction・★）

**DoD（Phase 3）**
- [ ] 仕様64章「セッション」「UI」カテゴリ完了
- [ ] `src/test/e2e/{login,register,theme,sessions}.spec.ts` green（モバイル viewport 含む）

---

## 6. Phase 4 — OAuth（2〜3日）: Google / GitHub / Discord（Apple 除外 C-01）

### 6-A プロバイダー接続

- [ ] **P4-A-01** `lib/auth/oauth/registry.ts`（型: provider定義、検証関数、**1エントリ追加で有効化**／UIも registry から自動生成）
- [ ] **P4-A-02** Google（OIDC、`openid-client`、nonce検証、iss/aud/exp/alg(RS256固定)/signature）
- [ ] **P4-A-03** GitHub（OAuth2、**`/user/emails` で `verified && primary` を採用**、nullなら signup 不可／D-10）
- [ ] **P4-A-04** Discord（OAuth2、`identify email` scope、`verified=true` のみ採用／D-11）
- [ ] **P4-A-05** `env.ts` に各 credential（`secret` は env、**Front へ露出しない**）。`client_id` / `client_secret` / `redirect_uri` は provider ごとに**明示設定**（実行環境からの自動導出はしない）
- [ ] **P4-A-06** `accounts` マイグレーション（`UNIQUE(provider, provider_account_id)`、refresh token 列を持たない／D-06）
- [ ] **P4-A-07** **OAuth 機密値の redact 配線を完了**（Phase 1-C の P1-C-09a で追加したキーを使う／§12.4／★）
  - [ ] `code` / `state` / `nonce` / `code_verifier` / `access_token` / `refresh_token` / `id_token` / `client_secret` をログ・API 応答・例外出力へ出さない
  - [ ] `security_events.metadata` には `provider` / `error` / `state_present` 等の**真偽値・文脈のみ**（生値なし）
  - [ ] 通知・セキュリティ通知メールにも認証フローの値を載せない（§18）
  - [ ] テスト: `src/test/unit/log-redaction.test.ts` に OAuth 機密値のケースを追加

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
- [ ] `src/test/security/{oauth-state,oauth-pkce,oauth-nonce,oauth-redirect,oauth-replay,account-linking}.test.ts` green

---

## 7. Phase 5 — TOTP 2FA ＋ Recovery Codes（2〜3日）

### 7-A 秘密鍵管理（§13.1）

- [ ] **P5-A-01** `util/crypto.ts`: AES-256-GCM（envelope key、`TOTP_ENCRYPTION_KEY` は env/Secret Manager、**DBに無し**）
- [ ] **P5-A-02** `lib/auth/totp.ts`（`otpauth`、6桁、drift ±1、**同一timestep再利用拒否** via `last_used_counter`）
- [ ] **P5-A-03** **`last_used_counter` の更新を atomic に**（D-16）
  - [ ] **P5-A-03a** `UPDATE ... WHERE last_used_counter < :c` の更新件数で判定、または `SELECT ... FOR UPDATE`
  - [ ] **P5-A-03b** **read → 判定 → write の素の2段書きは禁止**
- [ ] **P5-A-04** `src/test/security/2fa-concurrent-replay.test.ts`: 同一TOTPコードを2並行送信 → **成功1件のみ**・他方 `INVALID_CODE`

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
- [ ] `src/test/security/{2fa-bruteforce,2fa-disable-reauth,recovery-code-reuse,2fa-concurrent-replay}.test.ts` green
- [ ] 同一TOTPコードの並行送信で成功1件のみ（atomic 更新）をテストで固定
- [ ] ログ/管理画面/API応答に **TOTP secret が1件も現れない**

---

## 8. Phase 6 — Passkey / WebAuthn（2〜3日）

### 8-A 基盤

- [ ] **P6-A-01** `@simplewebauthn/server` 導入
  - [ ] **P6-A-01a** `rpID` / `rpName` / `origin` は **実行環境（`process.env` や request host）から自動導出せず、環境ごとの明示設定として管理する**（下記 P6-A-01b）
  - [ ] **P6-A-01b** `env.ts` に `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ORIGIN`（または `WEBAUTHN_ALLOWED_ORIGINS` の配列）を**検証付きで**定義し、dev / prod で**別値を固定して設定する**。値が未設定・空・`localhost` と prod で同一、などの状態を `env.ts` の zod 検証で起動時に落とす（fail fast）
  - [ ] **P6-A-01c** 検証は許可リスト方式（`origin` ∈ 許可リスト、`rpID` = 許可リストの各 origin の host と一致）で行い、request の `Origin` / `Host` ヘッダを無条件に信頼しない
  - [ ] 本番ドメインは Phase 9 のドメイン確定時に合わせて固定する（本書ではドメイン自体を確定しない）
- [ ] **P6-A-02** `webauthn_credentials` マイグレーション（credential_id UNIQUE, public_key, sign_count, transports, aaguid, device_name, backed_up）
- [ ] **P6-A-03** challenge 保存（**TTL 5分・1回限り**・★）

### 8-B 登録（再認証必須）

- [ ] **P6-B-01** `POST /api/auth/passkey/register/options`（`rpID` は明示設定値、`userVerification=preferred`）
- [ ] **P6-B-02** `POST /api/auth/passkey/register/verify`（origin / rpIDHash / signature / flags 検証、**公開鍵のみ保存**、通知、`passkey_added`）
- [ ] **P6-B-03** `GET /api/auth/passkey`（device_name, created_at, last_used_at）
- [ ] **P6-B-04** `DELETE /api/auth/passkey/{id}`（**再認証必須**、最後のpasskeyなら PW/2FA 残存チェック、通知）

### 8-C ログイン

- [ ] **P6-C-01** `POST /api/auth/passkey/login/options`（discoverable 対応、`allowCredentials`）
- [ ] **P6-C-02** `POST /api/auth/passkey/login/verify`（検証、sign_count 更新、last_used_at 更新、**新セッション発行**）
- [ ] **P6-C-03** UI: ログインボタンの passkey、`settings/security` の passkey 管理カード

**DoD（Phase 6）**
- [ ] 仕様64章「Passkey」完了
- [ ] `src/test/security/{webauthn-challenge-reuse,webauthn-origin,webauthn-rpid,webauthn-signcount,webauthn-deleted}.test.ts` green

---

## 9. Phase 7 — 管理者 / RBAC / 監査（1.5〜2日）

- [x] **P7-01a** `roles` マイグレーション ＋ seed（user/moderator/admin/superadmin）— **Phase 0 で完了**（`drizzle/0000_01_roles.sql` / `pnpm seed`）
- [ ] **P7-01b** `role_permissions` テーブル追加（将来拡張用。MVPでは使用しない＝D-19）
- [ ] **P7-02** `requireRole()` ガード（**server-side のみ**、§49/§50）
- [ ] **P7-03** 管理者ポリシー（§51）: **2FA必須**、Passkey推奨、セッション短め(8h)、再認証、管理操作ログ
- [ ] **P7-04** `admin_audit_logs` マイグレーション ＋ `lib/auth/audit.ts`（**5種**アクション: `admin_user_viewed` / `admin_user_suspended` / `admin_user_unsuspended` / `admin_session_revoked` / `admin_account_deleted`）
- [ ] **P7-05** `GET /api/admin/users`（requireRole(admin)、**PW/TOTP secret は絶対に返さない**・★）
- [ ] **P7-06** `POST /api/admin/users/{id}/suspend` / `unsuspend`（監査ログ、対象session全revoke）
- [ ] **P7-07** `POST /api/admin/users/{id}/sessions/revoke`（`admin_session_revoked`）
- [ ] **P7-07b** `POST /api/admin/users/{id}/delete`（`admin_account_deleted`、§61）
- [ ] **P7-08** `GET /api/admin/audit-logs`（requireRole(admin)以上、`admin_audit_logs` のみ）
- [ ] **P7-09** 一般ユーザーから監査ログを遮断（API遮断＋可能ならDBロール分離）

**DoD（Phase 7）**
- [ ] `src/test/security/{rbac,admin,audit-access}.test.ts` green
- [ ] 管理者APIが secret を一切返さないことをテストで固定

---

## 10. Phase 8 — リスク検知 ＋ テスト完成（1.5〜2日）

- [ ] **P8-01** `lib/auth/risk.ts`: 新規デバイス、短時間多数地域、異常速度（geo距離/時間）、大量試行（`failed_logins` 集計）
- [ ] **P8-02** リスクスコア → **3段階**（追加認証要求 / メール通知 / セッション保留）★
- [ ] **P8-03** `src/test/security/risk.test.ts`
- [ ] **P8-04** `src/test/security/**` で仕様48章の全カテゴリを充足（下記11章の表）
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
- [ ] **P9-08** **認証token 付き URL のログ漏洩対策**（計画 §17.2.1／★）
  - [ ] **P9-08a** reverse proxy / Web サーバーの **access log** で、`/verify-email`・`/reset-password`・`/api/auth/oauth/*` の query string を記録しない（または `token=` / `code=` / `state=` / `nonce=` / `code_verifier=` を `***` に置換）
  - [ ] **P9-08b** **error log**（`$request` / `$request_uri` を含む形式）にも同じ redaction を適用
  - [ ] **P9-08c** **tracing / APM / RUM** で認証URLの query が送信されないことを確認（属性除外 or 難読化）
  - [ ] **P9-08d** CDN / ホスティング基盤（Cloudflare 等）のログで query string を保存しないことを確認
  - [ ] **P9-08e** アプリ側 `logger.ts` が認証token 付き URL を平文出力しないことをテストで確認
  - [ ] **P9-08f** ログからトークンが検出された場合の対応手順（無効化・ユーザー通知・ログ削除）をランブックへ追記
  - [ ] ※ **token を URL query に載せること自体は禁止しない**（§4.1 / §15 の仕様）。本タスクが禁止するのは「token が URL に存在することを前提にログ経由で漏洩させること」のみ

**DoD（Phase 9）**
- [ ] 本番相当環境で `pnpm build` → smoke test 成功
- [ ] CI green
- [ ] バックアップ復元テストを **1回実施済み**
- [ ] **ログ設定セキュリティチェック**: 本番デプロイ**前**に access log / error log / tracing / APM / CDN の各設定が「認証token を含む query を平文保存しない」ことを確認し、**テストリクエストのログ実物**で検証済み（設定画面のスクリーンショットでの代替は不可）。確認結果をデプロイ記録へ残す（★・計画 §17.2.1）

---

## 12. セキュリティテストトラッカー（仕様48章 → ファイル）

> パスはすべて `src/test/**`（計画 D-18）。`§48「Web」` は `web.test.ts` 1ファイルに集約し、
> XSS / CSRF / SQLi / Open Redirect / Clickjacking / CORS / Security Header を describe で分ける（計画 16章）。

| 仕様 | テストファイル | 主要ケース | 状態 |
|---|---|---|---|
| 認証 | `src/test/security/auth.test.ts` | 正PW/誤PW/存在しないemail/未認証email/session期限切れ/logout後のAPI拒否 | [ ] |
| 一意制約(§3.1/§24) | `src/test/security/uniq.test.ts` | 大文字小文字違いで重複不可／論理削除済みは再利用可／partial index で二重登録拒否 | [ ] |
| パスワード | `src/test/security/password.test.ts` | 7文字拒否/8文字OK/**128文字OK/129文字拒否**/Unicode+スペース/空白のみ拒否/reset token再利用拒否 | [ ] |
| 漏洩PW(§5.2) | `src/test/unit/breached.test.ts` | ①漏洩検出 ②漏洩PW拒否 ③timeout=**fail-open で許可** | [ ] |
| OAuth | `src/test/security/oauth-{state,nonce,pkce,redirect,replay,account-linking}.test.ts` | state改ざん/code再利用/PKCE不一致/redirect_uri改ざん/nonce改ざん/未登録provider/**email一致自動統合の拒否** | [ ] |
| セッション | `src/test/security/session.test.ts` | Cookie属性/fixation(前後でID変化)/logout-all後の旧Cookie拒否/DBはhash保存 | [ ] |
| Web | `src/test/security/web.test.ts` | XSS/CSRF（Origin偽装・token欠落・**Route Handler と Server Action 双方**）/SQLi/Open Redirect/Clickjacking/CORS(`*`拒否)/Header不足 | [ ] |
| 2FA | `src/test/security/2fa.test.ts` | TOTP誤入力/総当たり(recovery code再利用)/無効化時の再認証 | [ ] |
| 2FA 並行(D-16) | `src/test/security/2fa-concurrent-replay.test.ts` | 同一TOTP 2並行送信 → 成功1件・他方拒否 | [ ] |
| Passkey | `src/test/security/webauthn-*.test.ts` | challenge再利用/origin不一致/rpID不一致/削除済みcredential拒否/sign_count更新 | [ ] |
| RBAC/管理者 | `src/test/security/{rbac,admin,audit-access,idor}.test.ts` | 権限判定/secret非露出/監査遮断/他者リソース参照拒否 | [ ] |
| リスク検知(§57) | `src/test/security/risk.test.ts` | 新規デバイス/地域移動/大量試行 | [ ] |
| ログ秘匿(§45) | `src/test/unit/log-redaction.test.ts` | PW/hash/client secret/token/TOTP secret/session token が出ない | [ ] |
| その他単体 | `src/test/unit/{id,time,ip,crypto,notify-events}.test.ts` | prefix付きULID(26文字)/UTC/203.0.113.xxx/AES-GCM/通知イベント | [ ] |
| E2E | `src/test/e2e/{login,register,theme,sessions,email-change,account-delete}.spec.ts` | 画面フロー（モバイル viewport） | [ ] |

> `src/test/unit/` の `id` / `time` / `ip` / `crypto` / `logger` / `env` / `schema` / `validate` は **Phase 0 で作成済み**（9ファイル）。`log-redaction` / `password` / `breached` / `notify-events` は各フェーズで追加する。
> `crypto.test.ts` は Phase 0 で hash/HMAC/pepper を、Phase 5 で AES-256-GCM をカバーする。

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
| C-02 | パスワード **最小8文字・最大128文字**（129字以上は拒否・ASCII限定しない・スペース許可） | P1-A-04, P3-B-01 |
| D-01 | メール未認証でもログイン可（メール必須操作のみ `email_verified` 要求） | P1-D-02 |
| D-02 | `PUT /api/auth/password/set` を新設（PW未設定→初回設定） | P1-D-10 |
| D-03 | PW変更/リセット後は**全セッション revoke（現行含む）**。オプトアウト無し | P1-D-08, P1-D-09 |
| D-04 | username/email は **case-insensitive 一意**（partial unique index のみ。通常UNIQUEは付けない） | P0-06a/b |
| D-05 | Phase 2のレート制限正本は **PostgreSQL**。Redisは予約方式同等の原子性を実装するまで認証判定に使わない | P2-04 |
| D-06 | OAuth の access/refresh token は **DBに保存しない**（scope最小・`offline_access` 不使用） | P4-A-06 |
| D-07 | email変更は `email_change_requests` に pending 保持。`status` は不変 | P1-B-02, P1-D-12, P1-D-13 |
| D-08 | avatar は **URL のみ**（画像アップロードは MVP 対象外） | P3-A-*, MVP対象外 |
| D-09 | 2FA 有効化は **2段**（`setup` で secret 発行 → `verify` で TOTP 検証して `enabled=true`）。backup codes は `verify` 成功時にのみ表示 | P5-B-01, P5-B-02 |
| D-10/D-11 | GitHub は `/user/emails` の verified&&primary、Discord は `verified=true` のみ採用 | P4-A-03/04 |
| D-12 | `device_name` は OS名＋ブラウザ名＋fallback（`ua-parser-js`） | P3-C-05 |
| D-13 | `security_events.ip` は生IP保持（**表示のみ mask**）、保持180日 | P2-06, P9-06 |
| D-14 | 再認証の猶予 **5分** | P1-C-05 |
| D-15 | テーマ既定値は **`system`** | P0-10, P3-A-02/06 |
| D-16 | TOTP `last_used_counter` は **atomic 更新**（read-then-write 禁止） | P5-A-03, P7(§13.2 analog) |
| D-17 | HIBP timeout は **fail-open**（`BREACH_CHECK_FAIL_OPEN`、既定 true） | P1-A-05 |
| D-18 | テスト配置は **`src/test/**` に統一** | 全テストタスク |
| D-19 | `roles` の seed は Phase 0 で実施済み。`role_permissions` は将来拡張（MVPでは作らない） | P0-06, P7-01 |
| D-22 | ID は `prefix_` + **ULID 26文字**（旧「21文字」表記は誤記） | P0-07a |
| D-25 | トークンテーブルの `id` prefix は **`tok_`**（`evt_` は `security_events` 専用）。Phase 1-B で `ID_PREFIXES` に追加 | P1-B-01 |
| D-26 | WebAuthn の `rpID` / `rpName` / `origin` は **環境ごとの明示設定**（実行環境・request host から自動導出しない）。検証は許可リスト方式。dev/prod で同一値を放置しない | P6-A-01a/b/c |
| D-27 | 認証token 付き URL は **仕様どおり query string を使う**。禁止するのは「token が URL に存在することを前提にログへ平文記録すること」のみ | P9-08, P1-C-09b |

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
| 2026-10-04 | （Todo 起票） | 実装着手。Phase 0 P0-01 から着手 |
| 2026-10-04 | **Phase 0 完了（M0 達成）** — P0-01〜P0-11 および DoD 2項目 | 証跡: `docs/phase0-設計.md` §12.1 / `README.md`「Phase 0 実装詳細」。docker 権限不足の環境では `sg docker -c "docker compose ..."` を使用 |
| 2026-10-04 | ドキュメント整合修正 | 仕様書を v1.1 へ（Apple除外・PW 8〜128文字・§30 応答形式・§4.1 URL・§22/§63 注記）、`実装計画.md` を v1.3 へ（ULID 26文字・role_id default 削除・テストパス `src/test/**` 統一ほか）、本 Todo の DoD チェックと不足タスク（P1-D-12〜16）を反映。**コード変更なし** |
| 2026-10-04 | セキュリティ運用要件の明記（`実装計画.md` v1.4） | OAuth 機密値 redaction（README 新設節 / 計画 12.4 拡張、P1-C-09a・P1-C-09b・P4-A-07 を追加）、認証token 付き URL のログ漏洩対策（P9-08a〜f と DoD を追加。error log / tracing / APM も対象。**token を URL に載せること自体は禁止しない**＝D-27）、Resend をメール送信のみに限定（計画 2.1 / 5章 / README）、Passkey の rpID・origin を環境別明示設定化（D-26、P6-A-01a〜c）。**コード変更なし** |
| 2026-10-10 | **Phase 1 完了（M1 達成）** — P1-A-01〜P1-D-16 および DoD 7項目 | 全セキュリティテスト（9ファイル・40テスト）green、Argon2idベンチマーク61.79ms/19MB、migration履歴修復（`drizzle.__drizzle_migrations` 6レコード）、`pnpm db:migrate` 正常動作、lint/typecheck/test/build 全green |
| 2026-10-12 | **Phase 2 完了（M2 達成）** — P2-01〜P2-11 および DoD 4項目 | commit `61a231b`。HTTPS/Host検証、CSP nonce、Origin/CSRF分離、PostgreSQLレート制限＋予約枠、CAPTCHA hook、期限切れ削除、`getClientIp()` の信頼proxy境界。証跡: `docs/phase2-設計.md` / 進捗ログ P2-08 の実ブラウザCSP検証 |
| 2026-10-13 | **Phase 2.5 進捗の実地監査（.progress のみ、コード変更なし）** — 29タスクを完了7・一部15・未着手7に分類 | OIDC Provider 本体実装（discovery/JWKS、AuthCode+PKCE、ID Token/UserInfo/revoke、client registry、CLI、consent UI、grant設定画面）は存在。**未達は Gate A 記録（P25-A-01/02/05）と OIDC 自動テスト（P25-E-03/04/05/06）、および機能ギャップ 6件**（停止アカウントの既発行tokenが UserInfo を通過、token失敗/revoke イベント不在、operator 項目なし、scope allowlist の型が未使用、secret 方針が未確定、grant scope の乖離）。反映先: `docs/phase2.5-実装計画.md` §0・§4.5、M2.5 マイルストーン行。全OIDCコードは未コミット（作業ツリー）のため commit 対象は未決 |
| 2026-10-13 | **Phase 2.5 ギャップ改修** — 完了 7→13、一部 15→9 | ①[C-07/D-05] `adapter.find` が AccessToken/AuthorizationCode/Grant/Session 参照時にユーザー状態（active/email_verified/deleted_at）を確認（停止・削除アカウントの既発行 token が UserInfo を通過する欠陥を修正）②[B-05] `oidc_token_failed`/`oidc_token_revoked`/`oidc_account_blocked` を追加し `src/lib/oidc/events.ts` で provider のエラー・失効イベントから記録、`recordSecurityEvent` を `SecurityEventType` 必須化 ③[D-05] アカウント削除時に OIDC grant を破棄、`/oauth2/interaction/` にレート制限追加 ④[B-03] scope allowlist を `src/lib/oidc/scopes.ts` に一元化 ⑤[D-02] `oauth_clients.operator` 追加（migration `0010_oidc_operator.sql`）と CLI/consent/設定画面への反映 ⑥[D-03] DB scopes を provider grant の実効 scope で書き込み乖離を解消。**テストは OIDC 統制の unit/security 4ファイル16件を追加し green**。副次的に `email_change_notification_failed` が未登録 event type だったバグと、CHECK 定義が migration でバインド変数になるバグを検出 |
| 2026-10-13 | **Phase 2.5 残タスク実装（M2.5 到達目前）** — 完了 13→26 | ①[B-01/B-04] client secret を可逆暗号化→`hmac-sha256:` ダイジェスト保存へ移行（`compareClientSecret` をハッシュ比較に override）、`token_endpoint_auth_method` 列追加、`secret_ciphertext` 列削除（migration `0011`/`0012`）、CLI に `update` コマンド追加 ②[E-05] 実HTTP E2E `src/test/e2e/oidc-flow.test.ts`（8テスト）— `scripts/server.ts` から `createOidcHandler()` を抽出して再利用 ③[A-01〜A-05] Spike/threat model を `docs/phase2.5-gate-a.md`・`phase2.5-threat-model.md` に記録 ④[E-06] 安全設定レビュー・依存監査（`oidc-provider` advisory 0件）・相互運用レポートを `docs/phase2.5-review.md` に記録 ⑤[E-04] integration テスト `src/test/integration/oidc-persistence.test.ts`（8並列 token 交換の一回のみ成功、account 状態、grant 失効、secret 非保存）⑥[E-03] unit/security テスト追加。**E2E 作成で本体実装の欠陥 4 件を検出・修正**: grant の `accountId` 未設定（`new provider.Grant({accountId, clientId})` へ）、ID Token の `sub` が raw user id（`findAccount` の `accountId` を client 毎の opaque subject に変更）、`auth_time` 欠落（login 結果の `ts` と claims 登録を修正）、opaque subject を考慮していない account 状態判定。テストは 35ファイル 213件 green、lint/typecheck/build green、migration 適用済み。残件は P25-E-01（負荷検証）/ E-04（migration up/down・multi-process 実測）/ E-05（複数RP）の 3 件 |

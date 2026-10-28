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
| M3 UI | Phase 3 | §64「UI」6項目＋セッション一覧/個別/全ログアウト | **[x] 達成（2026-10-17）** — 3-A〜3-D 全タスク完了。DoD は §64「UI」「セッション」全項目 green。残るのは**実ブラウザ viewport / スクリーンリーダー実機検証のみ**（Phase 8-B へ引継ぎ）。計画 `docs/phase3-ui-theme-notification-実装計画.md`、欠陥是正 `docs/bugfix-BUG1-7-修正計画.md` |
| M4 ソーシャル | Phase 4 | Google/GitHub/Discord ログイン＋紐付け＋解除 | [x] 実装完了 2026-10-18（Phase 4-B で連携確認画面を追加。実 provider 疎通のみ未実施） |
| M5 2FA | Phase 5 | TOTP＋Recovery Codes＋atomic 1回限り | [ ] 未着手 |
| M6 Passkey | Phase 6 | Passkey 登録/ログイン/削除＋Level3検証 | [ ] 未着手 |
| M7 管理者 | Phase 7 | RBAC＋監査ログ＋secret非露出 | [x] 実装完了 2026-10-27（P7-A-01〜P7-C-04。UI はスコープ外・§34） |
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
  - [x] **P5 で変更**: 未確認 email（`email_verified=false`）は **403 `EMAIL_NOT_VERIFIED`** で止め、セッションを発行しない（計画 D-33-21 / §8.7）。`pending_email` の `status` は残す
- [x] **P1-D-03** `POST /api/auth/logout`（現行revoke＋Cookie削除）
- [x] **P1-D-04** `GET /api/auth/me`
- [x] **P1-D-05** `POST /api/auth/verify-email`（token照合→`email_verified=true`→`status=active`、通知）
- [x] **P1-D-06** `POST /api/auth/resend-verification`（§4.3上限: email 5/時, ip 10/時）
  - [x] **P5 で変更**: **`requireAuth: false`** にし、`body.email` で対象を決める（未確認ユーザーがログインせずに再送できるようにする。計画 D-33-22）。応答は常に同一（§46）
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

> **詳細計画**: `docs/phase3-ui-theme-notification-実装計画.md`（工数 35.5h / 4〜5日。§2.3 の既存バグ 7 件は 2026-10-17 に是正済み）
> **DoD の `*.spec.ts` は `*.test.ts` に読み替える**（Playwright 未導入・D-30-01）

### 5-A 共通UI + テーマ（§39-42）

- [ ] **P3-A-01** ~~shadcn/ui 導入（button, input, label, card, dialog, toast, tabs, alert）~~ ✅ 2026-10-17: 既存 CSS 変数へ手書きで `src/components/ui/*` 8種＋`components.json`（CLI 未実行・D-30-02）
- [ ] **P3-A-02** ~~`components/theme/*`~~ ✅ 2026-10-17: ThemeProvider（server>localStorage>system・matchMedia 購読・cleanup）／ThemeToggle（3択）／theme-script（server 値を静的埋め込み）
- [x] **P3-A-03** `globals.css` CSS変数（`--bg --fg --card --border --primary --muted-fg --danger --success --warning --ring --disabled-bg` ＋ **`--primary-fg` / `--border-strong`**）。★2026-10-17 は BUG-3/4 の是正分のみ実施（Phase 3-A の完成ではない）
- [ ] **P3-A-04** ~~コントラスト検証／状態は色＋アイコン＋テキスト~~ ✅ 2026-10-17: `src/test/unit/theme-contrast.test.ts`（26 値の閾値）、Alert/Badge/PW meter/セッションバッジに適用
- [ ] **P3-A-05** ~~`settings/appearance`＋`PATCH /api/auth/preferences`~~ ✅ 2026-10-17: migration `0014_user_preferences.sql`、`GET/PATCH /api/auth/preferences`、3択フォーム（選択＝保存・失敗ロールバック）
- [ ] **P3-A-06** ~~テーマ同期~~ ✅ 2026-10-17: `src/lib/theme/resolver.ts`（純関数）+ `server-preference`、login/logout 往復を確認
- [ ] **P3-A-07** ~~matchMedia change 購読~~ ✅ 2026-10-17: `system` のときのみ購読・light/dark では OS 無視
- [ ] **P3-A-08** ~~レスポンシブ~~ ✅ 2026-10-17: 固定幅 px を持ち込まない、sm/md ブレークポイント使用。**実ブラウザ viewport 検証は Phase 8-B**
- [ ] **P3-A-09** ~~アクセシビリティ~~ ✅ 2026-10-17: Label/autocomplete/aria-live/フォーカスリング、role=progressbar・role=alert

### 5-B 認証画面

- [ ] **P3-B-01** ~~`/register`~~ ✅ 2026-10-17: PW meter（5段階・色＋アイコン＋テキスト）、8〜128 表記、breached 表示
- [x] **P3-B-02** ~~`/login`~~ ✅ 2026-10-17: 1入力欄維持（API契約と列挙対策を不変に）、統一メッセージ、PW meter、ThemeToggle。`lib/auth/oauth/registry.ts`（型＋空エントリ）と `LoginButtons`（registry 駆動・0件なら非表示）を追加し、社会/passkey/2FA は Phase 4/5/6 でエントリ追加＝ボタン自動表示
- [ ] **P3-B-03** ~~`/verify-email`~~ ✅ 2026-10-17: auto POST を useRef で 1 回だけ実行（§25）、再送信 UI
- [x] **P3-B-04** ~~`/forgot-password`~~ ✅ 2026-10-17: 常に同一メッセージ（§46）、文言一元化、`api/client` 経由、`no-store`
- [x] **P3-B-05** ~~`/reset-password`~~ ✅ 2026-10-17: token を画面に出さない（§45）、PW meter 付き、`INVALID_TOKEN` は既定文言のみ、`no-store`
- [ ] **P3-B-06** ~~未ログイン時の `settings/*` サーバ側ガード~~ ✅ 2026-10-17: 既存 `requireSettingsUser` が新規 4 ページへ適用（307→/login を実測）
- [x] **P3-B-11★** `/email-change/confirm` 画面 ＋ `GET` 303 リダイレクト（BUG-2・2026-10-17 完了。UI の見た目の整えは Phase 3-A に任せる）

### 5-C セッション/デバイス管理（§19, 38）

- [ ] **P3-C-01** ~~`GET /api/auth/sessions`~~ ✅ 2026-10-17: 現在を先頭、7項目のみ返却（生IP/user_agent/session_hash は返さない）
- [ ] **P3-C-02** ~~`DELETE /api/auth/sessions/{id}`~~ ✅ 2026-10-17: owner 確認・他人は 404・現行は Cookie 削除。IDOR テスト green
- [ ] **P3-C-03** ~~`POST /api/auth/logout-all`~~ ✅ 2026-10-17: 再認証必須（401 REAUTH_REQUIRED を実測）・通知メール（失敗非致命）
- [ ] **P3-C-04** ~~`settings/sessions` カードUI~~ ✅ 2026-10-17: §38 カード・現在バッジ・個別/全ログアウト・再認証ダイアログ
- [ ] **P3-C-05** ~~`util/device.ts`~~ ✅ 2026-10-17: `deriveDeviceName`/`deriveOsLabel`（120文字・制御文字制限）、`createSession` に配線。`Chrome on Windows` を実測

### 5-D 通知メール（§18, 44）

- [ ] **P3-D-01** ~~新規デバイスログイン通知~~ ✅ 2026-10-17: `(ip_hash, device_name)` 一致判定、`security_notification` 文面（地域は値があるときのみ）、本文に秘密値なしをテストで固定
- [ ] **P3-D-02** ~~変更系通知~~ ✅ 2026-10-17: 全ログアウト分を追加。Passkey/連携は Phase 6/4 で同テンプレ再利用
- [ ] **P3-D-03** ~~`settings/security` 一覧~~ ✅ 2026-10-17: §37 の 8 カード。2FA/Passkey/連携は如实表示し導線なし（D-30-16）
- [ ] **P3-D-04** ~~`GET /api/auth/security/events`~~ ✅ 2026-10-17: 本人限定・許可列のみ・limit 既定10/上限50・読み取り専用
- [ ] **P3-D-05** ~~`messages/ja.ts` へ UI 文言~~ ✅ 2026-10-17: `m()`（型安全なドット参照）＋`errorMessage()` を追加し UI 文言を ui.* に集約

**DoD（Phase 3）— 2026-10-17 判定**

§64「セッション」6項目
- [x] 複数端末対応（2 セッションで一覧が 2 件以上=e2e で実証）
- [x] セッション一覧（`GET /api/auth/sessions`・`current` 先頭・`ip_masked` のみ）
- [x] 個別ログアウト（`DELETE`・他人は 404）
- [x] 全端末ログアウト（`POST /logout-all`・**再認証必須**＝401 を実証）
- [x] セッション失効（`revoked_at`/`revoke_reason` 記録）
- [x] セッションローテーション（既存維持・回帰 green）

§64「UI」6項目
- [x] Light / Dark / System の 3 択（`/settings/appearance`・既定 `system`）
- [x] OS テーマ変更へのリアルタイム追従（`matchMedia` change 購読・リロード不要）
- [x] PC 対応（固定幅 px を持ち込まない＝静的チェック green）
- [x] スマホ対応（**静的チェック＋SSR の viewport meta まで。実ブラウザ viewport は Phase 8-B**）
- [x] OIDC 同意画面も dark に追従（BUG-5 で対応済み）

その他
- [x] 新規 6 API が契約どおり（IDOR・CSRF・再認証込み）
- [x] 新規デバイス通知・全ログアウト通知が秘密情報を含まない
- [x] `messages/ja.ts` へ UI 文言を集約（`m()` は型安全なドット参照）
- [x] `pnpm lint`(0 errors) / `typecheck` / `test`(57 files / 359 tests) / `build` が green
- [ ] **実ブラウザ viewport / スクリーンリーダー実機検証** — Phase 8-B（Playwright 導入時）に引継ぎ

**実ブラウザ検証で報告された欠陥の是正（2026-10-17）**

- [x] **BUG-8** テーマ初期化 script の `nonce` で hydration mismatch 警告（**Phase 0/2 由来の潜在バグ**。ブラウザが nonce を `getAttribute()` で隠すため React が「server値 vs 空文字」を比較して誤検出する。DOM と CSP は正しく、警告のみ問題）
  → `script` 要素に `suppressHydrationWarning` を付与。併せて **CSP ヘッダと script の nonce が一致すること**を e2e で固定（一致しないとインライン script が実行されない）
- [x] **BUG-9** `/favicon.ico` が 404（コンソールエラー）
  → `src/app/favicon.ico` を追加。Next が `/favicon.ico` に 200 + icon link を配信
- [x] **BUG-10（副次）** RootLayout が毎リクエストで `findUserById` を実行していた（theme 取得のためだけに 3 回の DB 往復）
  → `sessions.user_id` が `ON DELETE CASCADE` なので有効なセッション = user 存在が保証される。`findUserById` を削除し 2 往復に削減

**ユーザー報告の3件の是正（2026-10-27）**

- [x] **BUG-17** メールアドレスを変更できない（画面が無い）。`/settings/security` に `EmailChangePanel` を追加し、`POST /api/auth/email/change`（再認証必須）へ送信する導線を新設。`REAUTH_REQUIRED` は `ReauthDialog` で本人確認後に 1 度だけ再試行する
- [x] **BUG-18** タイムゾーンが既定 `UTC` で、日本利用者に不親切。既定を **`Asia/Tokyo`** に変更（`DEFAULT_TIME_ZONE` / `user_preferences.timezone` の DB default / migration `0020`）。`/settings/appearance` に `TimezoneForm` を追加し、手動選択に加えてブラウザのタイムゾーンを採用する導線も用意した。IP からの国判定は行わない（外部サービス依存を持ち込まないため。ブラウザ設定で代替する）
- [x] **BUG-19** ログイン画面のテーマ切替ボタンのラベルが縦書きになる。`ThemeToggle` に `whitespace-nowrap` / `shrink-0` を付与し、ヘッダーを `flex-wrap` にして折り返しを許容（認証系ページへ一貫適用）

**セキュリティ監査（PR #28 の新規機能への攻撃試験・2026-10-27）**

- [x] **SEC-1（高）** メール変更の確定（`POST /api/auth/email/change/confirm`）で、新アドレスが既存アカウントのものだと `users_email_lower_uniq` 違反が未処理の 500 になっていた。①列挙オラクル（500=登録済み / 200=空き）②Drizzle の失敗クエリがバインド値をログへ展開し、衝突相手のアドレスと（別経路では）argon2 ハッシュが平文で残る ③一度きりのトークンを消費してしまい利用者がやり直せない。**修正**: 消費前に `findUserByLowerEmail` で衝突を検査し 409 `EMAIL_CONFLICT` を返す（トークンは未消費のまま）。競合の保険として更新の unique 違反も 409 に正規化
- [x] **SEC-2（中）** `POST /api/auth/email/change` にレート制限が無く、任意の第三者アドレスへ変更確認メールを無制限に送れた（メール爆撃・踏み台）。**修正**: 利用者単位 5 回/時・IP 単位 10 回/時（`RATE_LIMITS.emailChange`）を課し、超過時は `rate_limited` を記録（§4.3 / §18。resend と同値）
- [x] **SEC-3（中）** 失敗した DB クエリのバインド値（argon2 パスワードハッシュ）が `logger` の redaction をすり抜けて error ログに平文で出ていた。**修正**: `SENSITIVE_TEXT_PATTERNS` に argon2 ハッシュのパターンを追加（`redactText` を捕捉グループ無しパターンにも対応）
- 攻撃試験で**防御を確認**（脆弱性なし）: CSRF（トークン欠如/Origin 偽装）、再認証の要否、厳格スキーマ（追加キー/`__proto__` を 400）、XSS/SQLi ペイロード（`emailSchema` が 400）、トークン目的混同（`email_change` を `password_reset` に流用不可）、トークン再利用（2 回目は 400）、Host ヘッダ注入（リダイレクトは固定 URL）、`user_preferences` の追加キー拒否、Cookie フラグ（HttpOnly/SameSite=Lax/Secure）、CSP


**Phase 3 着手前に完了した欠陥是正（2026-10-17 / `docs/bugfix-BUG1-7-修正計画.md`）**
- [x] BUG-1 パスワードリセットのメール内 URL（`/password/reset` → `/reset-password`）＋画面
- [x] BUG-2 email 変更確認のメール内 URL（GET 303 ＋画面）
- [x] BUG-3 `--primary-fg` 追加で dark のボタン対比を AA 準拠に（`text-white` 全廃）
- [x] BUG-4 `--border-strong` 追加で入力欄・ボタンの境界を 3:1 以上に
- [x] BUG-5 OIDC 同意画面の dark 対応（CSP は style-src のみ緩和）
- [x] BUG-6 メール送信の best-effort 化 ＋ `security_notification_failed` ＋ テスト用 transport seam
- [x] BUG-7 実 HTTP で Next を起動するテスト基盤（`src/test/helpers/app-server.ts`）
- [x] 検証: `pnpm lint`(0 errors) / `typecheck` / `test`(49 files / 297 tests) / `build` すべて green

---

## 6. Phase 4 — OAuth（2〜3日）: Google / GitHub / Discord（Apple 除外 C-01）

> **詳細計画**: `docs/phase4-oauth-social-login-実装計画.md`（v1.1 / 決定事項 D-31-01〜D-31-18）
> **credential**: 2026-10-17 に 3 provider の client ID / client secret を取得し `.env` に記入済み
> **残作業**: 実ブラウザでの手動疎通確認 11 手順（`docs/phase4-oauth-social-login-実装計画.md` §9）のみ未実施。自動テスト・e2e は green

### 6-A プロバイダー接続

- [x] **P4-A-01** `lib/auth/oauth/registry.ts`（型: provider定義、検証関数、**1エントリ追加で有効化**／UIも registry から自動生成）
- [x] **P4-A-02** Google（OIDC、`openid-client`、nonce検証、iss/aud/exp/alg(RS256固定)/signature）
- [x] **P4-A-03** GitHub（OAuth2、**`/user/emails` で `verified && primary` を採用**、nullなら signup 不可／D-10）
- [x] **P4-A-04** Discord（OAuth2、`identify email` scope、`verified=true` のみ採用／D-11）
- [x] **P4-A-05** `env.ts` に各 credential（`secret` は env、**Front へ露出しない**）。`client_id` / `client_secret` / `redirect_uri` は provider ごとに**明示設定**（実行環境からの自動導出はしない）
- [x] **P4-A-06** `accounts` マイグレーション（`UNIQUE(provider, provider_account_id)`、refresh token 列を持たない／D-06）
- [x] **P4-A-07** **OAuth 機密値の redact 配線を完了**（Phase 1-C の P1-C-09a で追加したキーを使う／§12.4／★）
  - [x] `code` / `state` / `nonce` / `code_verifier` / `access_token` / `refresh_token` / `id_token` / `client_secret` をログ・API 応答・例外出力へ出さない
  - [x] `security_events.metadata` には `provider` / `error` / `state_present` 等の**真偽値・文脈のみ**（生値なし）
  - [x] 通知・セキュリティ通知メールにも認証フローの値を載せない（§18）
  - [x] テスト: `src/test/security/log-redaction.test.ts` に OAuth 機密値のケースを追加

### 6-B フロー

- [x] **P4-B-01** `GET /api/auth/oauth/{provider}`（未登録は404、`state`=base64url(32B random)、`nonce`、`code_verifier`(S256) を anonCookie/Redis へ TTL10分・1回限り、scope最小）
- [x] **P4-B-02** `redirect_uri` は env 駆動の**登録済みURL完全一致**（DB保存の任意URL禁止／§62）
- [x] **P4-B-03** `GET /api/auth/oauth/{provider}/callback` — 計画12.2 の判定フローを**全実装**
  - [x] **P4-B-03a** state 不一致/期限切れ → `INVALID_STATE`（`login_failed` 記録）
  - [x] **P4-B-03b** token exchange 成功後に `state` を消費（**認可コード再利用防止**・★）
  - [x] **P4-B-03c** `status` が suspended/deleted → 403
  - [x] **P4-B-03d** **セッションローテーション**（callback後も必ず新セッション）
  - [x] **P4-B-03e** 新規デバイスなら通知メール
- [x] **P4-B-04** レート制限: `oauth-start` / `oauth-callback`

### 6-C 連携（account linking）

- [x] **P4-C-01** **email一致での自動統合を禁止**（§11）→ ログイン誘導 → `POST /api/auth/oauth/link`（**再認証必須**）
- [x] **P4-C-02** `DELETE /api/auth/accounts/{id}`（再認証必須、**最後の認証手段なら削除拒否**・★、通知）
- [x] **P4-C-03** `settings/connected-accounts` 一覧/追加/解除UI
- [x] **P4-C-04** 連携追加/削除の通知メール

**DoD（Phase 4）**
- [x] 仕様64章「ソーシャルログイン」（3 provider ＋ 紐付け/解除、Apple除く）完了
- [x] `src/test/security/{oauth-state,oauth-pkce,oauth-nonce,account-linking}.test.ts` green
- [x] 認可コードが 2 回使えない（replay 固定・`oauth-state.test.ts` / `oauth-nonce.test.ts`）
- [x] link で他人の SNS アカウントを乗っ取れない（`oauth-login-flow.test.ts` の T1〜T5）
- [x] 未検証 email・`email: null` で自動登録されない
- [x] `pnpm lint`（0 errors）/ `typecheck` / `test`（65 files / 446 tests）/ `build` green
- [ ] **実ブラウザでの手動疎通確認 11 手順**（`docs/phase4-oauth-social-login-実装計画.md` §9）— 実 OAuth アカウントが必要なため保留

**BUG-12 の是正（2026-10-18）**: 実ブラウザで Google ログインを試すと callback が `403 CSRF_FAILED` になり、外部連携が成立しなかった。provider から戻る top-level GET の参照元は **provider 自身**なので、アプリ自身のオリジン判定に必ず失敗していた。**callback では `Origin` / `Referer` を検証しない**ことに改め、CSRF は `state`（1 回限り消費）＋ PKCE で担保する。

**BUG-11 の是正（2026-10-18）**: `/login` で hydration mismatch が発生。`AuthForm`（`use client`）が `LoginButtons` を import していたため、サーバー専用モジュールがクライアントバンドルに取り込まれ、ブラウザ側で社会ログインボタンが 0 件になっていた（Phase 3 は registry が空で露見せず）。`LoginButtons` を**サーバーページから `ReactNode` として渡す**ように変更し、`src/test/unit/oauth-client-boundary.test.ts` で再発防止する。

---

## 6-B. Phase 4-B — ソーシャル連携の確認画面（2026-10-18 / 実装完了）

> **詳細計画**: `docs/phase4b-social-link-実装計画.md`（v1.1 / 決定事項 D-32-01〜D-32-17）

Phase 4 の本体内で未だった 2 点（BUG-12 後の実ブラウザ検証で判明）を解消。

### 6-B-1 解消した問題

| # | 問題 | 対応 |
|---|---|---|
| 1 | **Google / GitHub でログインすると `link_required` に飛ばされ、連携が完了できない** | callback で停止せず**確認画面**を出すように変更。画面で「新規登録」または「password でログインして連携」を選べる |
| 2 | **Discord の新規登録で username が `___` になった** | username 生成規則を修正（表示名を ASCII 化 → 無効なら email ローカル部 → 無効なら `user_` + hash8） |

### 6-B-2 乗っ取り防御（緩めていない）

- **email 一致のみでは絶対に連携しない**（§11 の維持）。連携には `email_owner_id` の **password 証明**が必須
- **別アカウントの password ではログインできるが、連携しない**（サーバー側で `email_ownerId === user.id` を照合）
- claim は **10 分・1 回限り**、token は **Cookie のみ**（URL に載せない・DB には SHA-256）
- 完了時にも `(provider, provider_account_id)` を再確認（TOCTOU 対策）

### 6-B-3 追加したもの

| 種別 | 内容 |
|---|---|
| migration | `0016_known_justin_hammer.sql` = `oauth_social_claims` |
| lib | `auth/oauth/social-claim.ts` / `auth/oauth/username.ts` |
| API | `POST /api/auth/oauth/social-login`（signup / password）、`POST /api/auth/oauth/social-login/cancel` |
| 画面 | `/login/social-confirm` ＋ `SocialConfirmForm`。**メールアドレスとパスワードの 2 欄**（email は明示入力させる） |
| CSRF | **callback が claim と anon Cookie を 1 つの応答に**書き出し、確認画面が読み取る（D-32-20）。クライアントに `/api/auth/csrf` を叩かせない |
| claim 消費 | **peek → 検証 → 成功確定直前で消費**（D-32-19）。password 誤りでも claim を失わない |
| パージ | `scripts/purge-expired.ts` に `social claim` ジョブを追加 |

**BUG-15 の是正（2026-10-18）**: 実ブラウザで「403 → 400、内部的には連携済み」という症状が出た。原因は (1) claim を password 検証前に消費していた、(2) CSRF トークンをクライアント再取得に依存させていた、の 2 つ。どちらも解消し、実 HTTP で再現・修正を確認した。

**DoD**: 仕様 §9・§11・§49 に対応。`pnpm lint`（0 errors）/ `typecheck` / `test`（**68 files / 482 tests**）/ `build` すべて green。
**残作業**: 実ブラウザでの 3 provider 通し（既存の §9 の 11 手順）。

---

## 7. Phase 5 — TOTP 2FA ＋ Recovery Codes（3〜4日）**完了**

> **詳細設計**: `docs/phase5-totp-2fa-実装計画.md`（v1.1 / D-33-01〜D-33-25）
> **実行手順**: `docs/phase5-実行Todo.md`
> 以下は概要。実装単位の分解・完了条件・テスト一覧は上記 2 文書を正とする。
> **v1.1 で追加された 3 要件**: (1) 無効化・再生成は「パスワード＋現在のコード」の**強い再認証**（D-33-23〜25）、(2) **`qrcode` を採用**（D-33-02 を反転）、(3) **未確認 email はログインを 403 で止め、未認証でも再送できる**（D-33-21 / D-33-22）。
> **既存仕様の変更**: 未確認ログインを許可していた `deleted-account-login.test.ts` の期待値を反転（計画 §5.2）。
>
> **完了 (2026-10-24)**: API 6 本（`GET /2fa` / `setup` / `verify` / `disable` / `recovery-codes/regenerate` / `challenge/verify`）＋ UI（`two-factor-panel` / `recovery-codes-display` / `strong-reauth-dialog` / `totp-login-step` / `email-unverified-notice`）を実装。
> **`challenge` 単体の API は作らない**（保留セッションは `login` が発行する）。`resend-verification` は D-33-22 で `requireAuth: false` に変更。
> テスト: 新規 **14 ファイル** ＋ 既存追記。`pnpm lint`（0 errors）/ `typecheck` / `test`（**87 files / 614 tests**）green。

### 7-A 秘密鍵管理（§13.1）

- [x] **P5-A-01** `src/lib/auth/totp-crypto.ts`（新設）: AES-256-GCM（envelope key、`TOTP_ENCRYPTION_KEY` は env/Secret Manager、**DBに無し**）。`util/crypto.ts` は無変更（計画 §7.1 の差分参照）
- [x] **P5-A-02** `lib/auth/totp.ts`（`otpauth`、6桁、drift ±1、**同一timestep再利用拒否** via `last_used_counter`）
- [x] **P5-A-03** **`last_used_counter` の更新を atomic に**（D-16）
  - [x] **P5-A-03a** `UPDATE ... WHERE last_used_counter < :c` の更新件数で判定（`SELECT ... FOR UPDATE` は採らない・計画 D-33-04）
  - [x] **P5-A-03b** **read → 判定 → write の素の2段書きは禁止**
- [x] **P5-A-04** `src/test/security/2fa-concurrent-replay.test.ts`: 同一TOTPコードを2並行送信 → **成功1件のみ**・他方 `INVALID_CODE`
- [x] **P5-A-05** `lib/auth/totp-qr.ts`: QR は **`qrcode`**（`^1.5.4`）でサーバ側 SVG 生成（**`otpauth` のみ追加、の旧方針は撤回**。計画 D-33-02）
- [x] **P5-A-06** 依存追加: `otpauth@^9.5.2` ＋ **`qrcode@^1.5.4`**（dependencies）／`@types/qrcode`（devDependencies）

### 7-B フロー

- [x] **P5-B-01** `POST /api/auth/2fa/setup`（secret＋QR `otpauth://`、`enabled=false`、`email_verified` 必須）
- [x] **P5-B-02** `POST /api/auth/2fa/verify`（検証成功で enabled、**backup codes 10個をこの時のみ表示**／以後再取得不可）
- [x] **P5-B-03** ログイン時 `totp_pending=true` のセッション発行 → `/login` の2FA入力UI → `POST /api/auth/2fa/challenge/verify` で昇格（**`challenge` 単体の開始 API は作らない**。保留セッションは login が発行する。計画 §7.1 / §8.7）
- [x] **P5-B-04** `recovery_codes`: hash保存・1回限り・使用即無効化・**残数<3で再生成を促す**（§13.2）
- [x] **P5-B-05** `POST /api/auth/2fa/disable`（**強い再認証**: パスワード＋現在のコード、secret削除、`2fa_disabled`、通知。計画 D-33-23）
- [x] **P5-B-06** `POST /api/auth/2fa/recovery-codes/regenerate`（**強い再認証**必須、既存無効→新10個）
- [x] **P5-B-07** レート制限: 2FA入力 **10/5分**（総当たり対策）
- [x] **P5-B-08** `src/lib/auth/strong-reauth.ts`（新設）: 無効化・再生成の**共通入口**（検証器配列。Phase 6 が Passkey を 1 件足すだけ・計画 D-33-24）

### 7-B2 未確認 email と再送（v1.1 追加）

- [x] **P5-B2-01** `POST /api/auth/login`: **未確認 email は 403 `EMAIL_NOT_VERIFIED`**（セッション非発行）。応答に `{ email, resend_available: true }`（計画 D-33-21）
- [x] **P5-B2-02** `POST /api/auth/resend-verification`: **`requireAuth: false` 化**し `body.email` で対象を決める。応答は常に同一（列挙対策）。`resendEmail` 5/1h ＋ `resend.ip` 10/1h（計画 D-33-22）
- [x] **P5-B2-03** `/login` に `EmailUnverifiedNotice`（「メールアドレスの確認が必要です」＋再送ボタン）
- [x] **P5-B2-04** `deleted-account-login.test.ts` の**期待値を反転**（未確認ログイン 200 → 403。計画 §5.2）

**DoD（Phase 5）**
- [x] 仕様64章「高度な認証」TOTP / Recovery Codes 完了
- [x] `src/test/security/{2fa-bruteforce,2fa-disable-reauth,recovery-code-reuse,2fa-concurrent-replay,2fa-pending-session,2fa-secret-leak,email-unverified-login,resend-unauthenticated}.test.ts` green
- [x] 同一TOTPコードの並行送信で成功1件のみ（atomic 更新）をテストで固定
- [x] ログ/管理画面/API応答に **TOTP secret が1件も現れない**
- [x] **未確認 email のログインが 403 で止まり、セッションが発行されない**（`email-unverified-login.test.ts`）
- [x] **未確認ユーザーがログインせずに確認メールを再送できる**（`resend-unauthenticated.test.ts`。締め出されない）
- [x] **2FA 無効化・再生成に「パスワード＋コード」が必要**（`2fa-disable-reauth.test.ts`）

---

## 8. Phase 6 — Passkey / WebAuthn（完了・実績 30.4h）

> 実装計画: `docs/phase6-passkey-webauthn-実装計画.md`（v1 / D-34-01〜D-34-16）
> 実行チェックリスト: `docs/phase6-実行Todo.md`
> 決定事項: `D-34-01`〜`D-34-16`（`docs/phase6-passkey-webauthn-実装計画.md` §17）
> 実績: 新規ファイル **18**・テスト **13** ファイル（既存追記含む）・migration **0018**・工数 **30.4h**

### 8-A 基盤

- [x] **P6-A-01** `@simplewebauthn/server` 導入
  - [x] **P6-A-01a** `rpID` / `rpName` / `origin` は **実行環境（`process.env` や request host）から自動導出せず、環境ごとの明示設定として管理する**（`src/lib/auth/passkey/config.ts`）
  - [x] **P6-A-01b** `env.ts` に `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ALLOWED_ORIGINS` を**検証付きで**定義し、dev / prod で**別値を固定**。未設定・空・prod で `localhost` などの状態を起動時に落とす（fail fast）
  - [x] **P6-A-01c** 検証は許可リスト方式（`origin` ∈ 許可リスト、`rpID` = 各 origin の host と一致／サフィックス）。request の `Origin` / `Host` ヘッダを信頼しない（`resolveWebauthnConfig` は request を受け取らない）
- [x] **P6-A-02** `webauthn_credentials` / `webauthn_challenges` マイグレーション（`drizzle/0018_passkey.sql`、credential_id UNIQUE, public_key, sign_count, transports, aaguid, device_name, backed_up）
- [x] **P6-A-03** challenge 保存（**TTL 5分・1回限り**・★、`src/lib/auth/passkey/challenge.ts`）

### 8-B 登録（再認証必須）

- [x] **P6-B-01** `POST /api/auth/passkey/register/options`（`rpID` は明示設定値、`userVerification=preferred`）
- [x] **P6-B-02** `POST /api/auth/passkey/register/verify`（origin / rpIDHash / signature / flags 検証、**公開鍵のみ保存**、通知、`passkey_added`）
- [x] **P6-B-03** `GET /api/auth/passkey`（device_name, created_at, last_used_at）
- [x] **P6-B-04** `DELETE /api/auth/passkey/{id}`（**再認証必須**、最後のpasskeyなら PW/2FA 残存チェック、通知）

### 8-C ログイン

- [x] **P6-C-01** `POST /api/auth/passkey/login/options`（discoverable 対応、`allowCredentials`）
- [x] **P6-C-02** `POST /api/auth/passkey/login/verify`（検証、sign_count 更新、last_used_at 更新、**新セッション発行**）
- [x] **P6-C-03** UI: ログインボタンの passkey（`PasskeyLoginButton`）、`settings/security` の passkey 管理カード（`PasskeyPanel`）

### 8-D 強い再認証への差し込み（D-34-11）

- [x] **P6-D-01** `POST /api/auth/reauth/passkey/options`（再認証用 challenge 発行・D-34-12）
- [x] **P6-D-02** `strong-reauth.ts` に `passkeyVerifier` を追加（判定順: パスワード＋コード → Passkey）
- [x] **P6-D-03** `StrongReauthDialog` の Passkey タブ（`strong_reauth_methods` に出し分け）
- [x] **P6-D-04** 2FA 無効化・リカバリーコード再生成が Passkey でも通る（`passkeyDeleteSchema`）

**DoD（Phase 6）**
- [x] 仕様64章「Passkey」完了
- [x] `src/test/security/{webauthn-challenge-reuse,webauthn-origin,webauthn-rpid,webauthn-signcount,webauthn-deleted}.test.ts` green
- [x] `src/test/security/{webauthn-register,webauthn-login,passkey-reauth}.test.ts` green
- [x] `src/test/unit/{passkey-config,passkey-registration,passkey-authentication,passkey-challenge,strong-reauth,webauthn-mock}.test.ts` green
- [x] `src/test/integration/{webauthn-queries,purge-expired}.test.ts` green
- [x] `pnpm lint`（0 errors） / `pnpm typecheck` / `pnpm build` / `pnpm db:verify-migrations`（0018 up/down/往復/restore）

---

## 9. Phase 7 — 管理者 / RBAC / 監査（1.5〜2日）

- [x] **P7-01a** `roles` マイグレーション ＋ seed（user/moderator/admin/superadmin）— **Phase 0 で完了**（`drizzle/0000_01_roles.sql` / `pnpm seed`）
- [x] **P7-01b** `role_permissions` テーブル追加（将来拡張用。MVPでは使用しない＝D-19）
- [x] **P7-02** `requireRole()` ガード（**server-side のみ**、§49/§50）
- [x] **P7-03** 管理者ポリシー（§51）: **2FA必須**、Passkey推奨、セッション短め(8h)、再認証、管理操作ログ
- [x] **P7-04** `admin_audit_logs` マイグレーション ＋ `lib/auth/audit.ts`（**5種**アクション: `admin_user_viewed` / `admin_user_suspended` / `admin_user_unsuspended` / `admin_session_revoked` / `admin_account_deleted`）
- [x] **P7-05** `GET /api/admin/users`（requireRole(admin)、**PW/TOTP secret は絶対に返さない**・★）
- [x] **P7-06** `POST /api/admin/users/{id}/suspend` / `unsuspend`（監査ログ、対象session全revoke）
- [x] **P7-07** `POST /api/admin/users/{id}/sessions/revoke`（`admin_session_revoked`）
- [x] **P7-07b** `POST /api/admin/users/{id}/delete`（`admin_account_deleted`、§61）
- [x] **P7-08** `GET /api/admin/audit-logs`（requireRole(admin)以上、`admin_audit_logs` のみ）
- [x] **P7-09** 一般ユーザーから監査ログを遮断（API遮断＋可能ならDBロール分離）

**DoD（Phase 7）**
- [x] `src/test/security/{rbac,admin,audit-access}.test.ts` green
- [x] 管理者APIが secret を一切返さないことをテストで固定

---

## 10. Phase 8 — リスク検知 ＋ テスト完成（1.5〜2日）

> 計画: `docs/phase8-risk-tests-実装計画.md`（v1.0 / D-38-01〜D-38-07）
> 実行: `docs/phase8-実行Todo.md`（実装単位のチェックリスト）
> 状態: **実装着手前（設計）**

- [ ] **P8-01** `lib/auth/risk.ts`: 新規デバイス、短時間多数地域、異常速度（geo距離/時間）、大量試行（`failed_logins` 集計）
  - 注: 「短時間多数地域」は外部 geo-IP を持ち込まず、短期間の複数 `ip_hash` で代理する（D-38-01）。`sessions.ip_country` は常に `null`
- [ ] **P8-02** リスクスコア → **3段階**（追加認証要求 / メール通知 / セッション保留）★
  - 注: 重み・閾値は `src/config/risk.ts` に集約（D-38-02）。既定は `RISK_ENFORCEMENT='notify'`（通知のみ・挙動不変・D-38-03）
- [ ] **P8-03** `src/test/security/risk.test.ts`
- [ ] **P8-04** `src/test/security/**` で仕様48章の全カテゴリを充足（下記11章の表）
  - 正規ファイル名を新設: `auth.test.ts` / `session.test.ts` / `oauth-redirect.test.ts` / `oauth-replay.test.ts`（D-38-05）
- [ ] **P8-05** E2E: 登録→確認→ログイン→2FA→passkey→設定→削除まで通し（`src/test/e2e/auth-journey.test.ts`）
  - 注: Playwright は導入せず、既存の vitest ＋ 実 HTTP（`startTestAppServer`）方式（D-38-04）
- [ ] **P8-06** `pnpm test` / `pnpm test:e2e` / `pnpm test:security` が全て green
- [ ] **P8-07** テスト基盤: fixtures（通常/未検証/suspended/PW無し/admin）、oauth-mock（`jose` で署名したID token）、webauthn-mock、totp、fake rate-limit store、fake timers（時間依存テストの flaky 防止・★）
  - 注: 集約先は `src/test/helpers/{fixtures,rate-limit,totp}.ts`（D-38-06）

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
  - [x] `security_events` 180日パージ ジョブを `scripts/purge-expired.ts` に追加（`security event`）
  - [x] 論理削除ユーザーの保持期間（30日）経過後**物理削除**（`deleted user` ジョブ。CASCADE で本人データ削除、`security_events` / `oauth_clients` / `admin_audit_logs` は SET NULL で匿名化保持）
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
| 認証 | `src/test/security/auth.test.ts` | 正PW/誤PW/存在しないemail/未認証email/session期限切れ/logout後のAPI拒否 | [ ] **新設（Phase 8）** |
| 一意制約(§3.1/§24) | `src/test/security/uniq.test.ts` | 大文字小文字違いで重複不可／論理削除済みは再利用可／partial index で二重登録拒否 | [x] |
| パスワード | `src/test/unit/password.test.ts` | 7文字拒否/8文字OK/**128文字OK/129文字拒否**/Unicode+スペース/空白のみ拒否/reset token再利用拒否 | [x] |
| 漏洩PW(§5.2) | `src/test/unit/breached.test.ts` | ①漏洩検出 ②漏洩PW拒否 ③timeout=**fail-open で許可** | [x] |
| OAuth | `src/test/security/oauth-{state,nonce,pkce,redirect,replay,account-linking}.test.ts` | state改ざん/code再利用/PKCE不一致/redirect_uri改ざん/nonce改ざん/未登録provider/**email一致自動統合の拒否** | [ ] `redirect`/`replay` は**新設（Phase 8）**、他は [x] |
| セッション | `src/test/security/session.test.ts` | Cookie属性/fixation(前後でID変化)/logout-all後の旧Cookie拒否/DBはhash保存 | [ ] **新設（Phase 8・`session-attr`/`session-management` を包含）** |
| Web | `src/test/security/web.test.ts` | XSS/CSRF（Origin偽装・token欠落・**Route Handler と Server Action 双方**）/SQLi/Open Redirect/Clickjacking/CORS(`*`拒否)/Header不足 | [x] |
| 2FA | `src/test/security/2fa.test.ts` | TOTP誤入力/総当たり(recovery code再利用)/無効化時の再認証 | [x] |
| 2FA 並行(D-16) | `src/test/security/2fa-concurrent-replay.test.ts` | 同一TOTP 2並行送信 → 成功1件・他方拒否 | [x] |
| Passkey | `src/test/security/webauthn-*.test.ts` | challenge再利用/origin不一致/rpID不一致/削除済みcredential拒否/sign_count更新 | [x] |
| RBAC/管理者 | `src/test/security/{rbac,admin,audit-access,idor}.test.ts` | 権限判定/secret非露出/監査遮断/他者リソース参照拒否 | [x] |
| リスク検知(§57) | `src/test/security/risk.test.ts` | 新規デバイス/複数IP/大量試行/自動化UA/3段階写像 | [ ] **新設（Phase 8）** |
| ログ秘匿(§45) | `src/test/security/log-redaction.test.ts` | PW/hash/client secret/token/TOTP secret/session token が出ない | [x] |
| 通知イベント(§18) | `src/test/unit/notify-events.test.ts` | 変更系9種の通知が漏れなく発火/本文に秘密が無い | [ ] **新設（Phase 8）** |
| その他単体 | `src/test/unit/{id,time,ip,crypto}.test.ts` | prefix付きULID(26文字)/UTC/203.0.113.xxx/AES-GCM | [x] |
| E2E | `src/test/e2e/auth-journey.test.ts` | 登録→確認→ログイン→2FA→Passkey→設定→削除の通し（`startTestAppServer` 方式・D-38-04） | [ ] **新設（Phase 8）** |

> `src/test/unit/` の `id` / `time` / `ip` / `crypto` / `logger` / `env` / `schema` / `validate` は **Phase 0 で作成済み**（9ファイル）。`password` / `breached` は各フェーズで追加済み。`notify-events`（§18）は Phase 8 で追加する。
> `crypto.test.ts` は Phase 0 で hash/HMAC/pepper を、Phase 5 で AES-256-GCM をカバーする。
> ログ秘匿（§45）の実ファイルは `src/test/security/log-redaction.test.ts`（`unit/log-redaction.test.ts` ではない）。

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
| D-01 | **【Phase 5 で改訂】メール未認証はログイン不可**（403 `EMAIL_NOT_VERIFIED`）。未確認でも確認メールの再送はできる（未認証の `resend-verification`）。旧: 「メール未認証でもログイン可」 | P1-D-02, **P5-B2-01, P5-B2-02**（計画 D-33-21 / D-33-22） |
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
| 2026-10-24 | **Phase 5 設計書の改訂（v1.1・設計のみ、コード変更なし）** | ユーザー指示 3 件を反映。①無効化・再生成を「パスワード＋現在のコード」の**強い再認証**に（計画 D-33-23〜25。`strong-reauth.ts` を新設し Phase 6 の Passkey を検証器 1 件で差し込む）②**`qrcode` を採用**（D-33-02 を反転）③**未確認 email はログインを 403 `EMAIL_NOT_VERIFIED` で止め、未認証でも再送できる**（D-33-21 / D-33-22）。**D-01 を改訂**（「メール未認証でもログイン可」→「不可」）。`deleted-account-login.test.ts` の期待値反転を §5.2 に明記。工数 21.0h → 27.8h。反映先: `docs/phase5-totp-2fa-実装計画.md` v1.1 / `docs/phase5-実行Todo.md` / 本 Todo の §7・D-01・P1-D-02・P1-D-06 |
| 2026-10-27 | **ユーザー報告の3件を是正（BUG-17〜19）** | ①メールアドレス変更 UI（`/settings/security`、再認証必須・確認リンク確定方式）②タイムゾーン既定を `Asia/Tokyo` へ（DB default / migration `0020` / 外観ページに `TimezoneForm`＋ブラウザ設定採用。IP 国判定は外部依存を持ち込まないため不採用）③ログイン画面のテーマ切替ラベルの縦書きを解消（`whitespace-nowrap` ＋ ヘッダー `flex-wrap`）。テスト 115 ファイル / 790 件 green、typecheck 0 error |
| 2026-10-27 | **セキュリティ監査（PR #28 の新規機能へ実攻撃）** — SEC-1〜3 を修正 | 稼働サーバ（Postgres 16）へ攻撃試験を実施。**SEC-1（高）**: email 変更確定で既存アドレス指定時に unique 違反が未処理 500 → 列挙オラクル・PII/argon2 のログ漏洩・トークン消費。消費前の衝突検査で 409 `EMAIL_CONFLICT`（トークン温存）＋ unique 違反の正規化。**SEC-2（中）**: email 変更要求にレート制限なし（15/15 が 200）→ 利用者 5/時・IP 10/時を追加。**SEC-3（中）**: 失敗クエリのバインド値（argon2 ハッシュ）が error ログに平文 → redaction パターン追加。防御確認: CSRF/再認証/厳格スキーマ/XSS・SQLi/目的混同/トークン再利用/Host 注入/Cookie フラグ/CSP。テスト 116 ファイル / 795 件 green、typecheck 0 error |
| 2026-10-28 | **Phase 7.6: アカウント削除フロー＋アカウント保護イベント（M7.6 達成）** | §8・§21・§24 の実装ギャップを解消。①セルフサービス退会を**メール確認**でも可能に（`POST /api/auth/account/delete/request` → 303 転送のみの GET → `/account/delete/confirm` の POST で確定。§25・D-37-04）②削除の副作用（論理削除・全セッション・全トークン・**Passkey**・OIDC grant 失効・`account_deleted` 記録・通知）を `src/lib/auth/account-deletion.ts` の `performAccountDeletion` に集約（D-37-01）③管理 API の論理削除に**Passkey 失効が漏れていた** §24 違反を同ヘルパへの集約で解消④削除は強い再認証（パスワード＋コード / Passkey）またはメール確認を必須（D-37-02）⑤再要求で旧トークン無効化・消費は単文 UPDATE（D-37-05・D-16）⑥確認メールに利用者 5/時・IP 10/時のレート制限（D-37-06）。migration `0022_tan_oracle.sql`（`account_deletion_requests`）。新規テスト 6 件（`account-deletion-flow`）。テスト 119 ファイル / 812 件 green、typecheck 0 error、lint 0 warning、migration up/down/往復/restore 成功 |
| 2026-10-28 | **Phase 8 の実装計画と実行 Todo を作成（設計のみ・コード変更なし）** | 次フェーズ（M8: リスク検知＋テスト完成）の計画 `docs/phase8-risk-tests-実装計画.md`（D-38-01〜D-38-07）と実行チェックリスト `docs/phase8-実行Todo.md` を起票。**D-38-01**: §57 の「短時間多数地域」は外部 geo-IP を持ち込まず短期間の複数 `ip_hash` で代理（`sessions.ip_country` は常に null）。**D-38-02/03**: スコア→3段階アクションを `src/config/risk.ts` に集約し、既定 `RISK_ENFORCEMENT='notify'` で挙動不変・段階強化可。**D-38-04**: E2E は Playwright を導入せず既存の vitest＋実 HTTP 方式を維持。**D-38-05**: §48 の正規ファイル名（`auth`/`session`/`oauth-redirect`/`oauth-replay`）を新設しトラッカーを 1:1 化。**D-38-06**: テスト基盤を `src/test/helpers/{fixtures,rate-limit,totp}.ts` に集約・fake timers 必須化。**D-38-07**: リスクイベントは `login_risk`（metadata は `level`/`signals` のみ）。migration 不要。§12 トラッカーを実ファイル名で更新 |

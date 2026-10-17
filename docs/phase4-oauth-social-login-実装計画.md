# Phase 4 実装計画 — ソーシャルログイン（Google / GitHub / Discord）

> 対象: M4（`実装計画.md` 15章「Phase 4 — OAuth（2〜3日）: Google / GitHub / Discord（Apple 除外 C-01）」）
> 前提工程: Phase 3（M3 達成 2026-10-17）。`registry.ts` は**型と空エントリまで実装済み**で、Phase 4 はエントリを足すだけで UI まで出る
> 正典: 仕様書 §9（プロバイダー）/ §10（accounts）/ §11（linking）/ §16（レート制限）、計画 12.1〜12.4、Todo §6
> credential 取得手順: `interop/README.md`（**2026-10-17 に 3 provider の取得完了**）
> v1.0: 2026-10-17 初版（計画のみ）
> **v1.1: 設計レビューで見つけた未決論点を解決し、実装可能な粒度まで詰め直した**（§3 に変更点を列挙／全 949 行）

---

## 0. 要旨（TL;DR）

| 項目 | 内容 |
|---|---|
| 何をやる | Google / GitHub / Discord での**ログイン・新規登録・紐付け・解除**。3 つとも Authorization Code + PKCE (S256) |
| 何をしない | refresh token の取得・保存（D-06）／email 一致での自動統合（§11）／Apple（C-01）／既存リンクの-email 自動同期 |
| 工数 | **30.6 時間（4 日）**。内訳は §12 |
| 追加依存 | **`jose` のみ**（dependencies。`openid-client` は devDeps かつ未使用なので採用しない・D-31-02） |
| migration | **2 本** = `0015_accounts.sql` / `0016_oauth_states.sql` |
| 新規ファイル | **25 ファイル** → §7.1 |
| テスト | 新規 **10 ファイル・約 82 ケース** → §8 |
| **着手可能か** | ✅ **可能**。3 provider の client ID / secret が `.env` に設定済み（長さも各 provider の形式と一致することを確認）。`interop/README.md` の残作業は「redirect URI の実登録確認」のみ |
| 最大リスク | **紐付け（link）フローで他人の SNS アカウントを自分のアカウントに付け替える乗っ取り**（§7.8 で設計済み） |

---

## 1. 正典と参照関係

| 論点 | 正典 | 本書での扱い |
|---|---|---|
| provider ごとの仕様 | 計画 12.1 のマトリクス | §7.4 に**実装可能なコード**で展開（`Accept` ヘッダー等の実運用の詳細を追加） |
| コールバック判定 | 計画 12.2 の 9 ステップ | §7.7 に login / link の 2 系統として展開 |
| 機密値 redaction | 計画 12.4 | §7.9 |
| ID prefix | `実装Todo.md` D-25 | `accounts` は **`acc_`**（`util/id.ts` の `ID_PREFIXES` に既存・`newId('acc')`） |
| credential の扱い | `実装Todo.md` P4-A-05 | 明示設定のみ。実行環境・リクエストの `Host` ヘッダからの自動導出は**禁止**（§62） |

---

## 2. 背景と目的

### 2.1 現状（コードで確認済み）

| 領域 | 現状 |
|---|---|
| registry | `src/lib/auth/oauth/registry.ts` に**型と空エントリだけ**。`configuredOAuthProviders()` は 0 件を返す |
| registry の型 | `OAuthProviderEntry` に `isConfigured` / `authorizationEndpoint` / `scope` / `protocol` はあるが、**token エンドポイント・token 交換・identity 取得の関数スロットが無い**（→ §7.3 で再設計） |
| UI | `LoginButtons` が registry 駆動。0 件なのでボタンは描画されない（正しい挙動） |
| DB | **`accounts` テーブルが無い**。`oauth_clients`（M2.5 の Provider 側）は別物。`users.password_hash` は NULL 可なので social-only ユーザーは作れる |
| OAuth フロー | `GET /api/auth/oauth/{provider}` / `callback` いずれも**未実装** |
| 状態保持 | `state`/`nonce`/`code_verifier` を保持する場所が無い。Redis は任意依存（D-05 で PostgreSQL が正本） |
| redact | `logger.ts` に `code`/`state`/`nonce`/`codeverifier` は**キーとして登録済み**（Phase 1-C P1-C-09a）。配線とテストは未実装 |
| credential | `env.ts` に `GOOGLE_*`/`GITHUB_*`/`DISCORD_*` が**遅延評価として定義済み**。`.env` に実値設定済み（2026-10-17 確認） |
| パージ | `scripts/purge-expired.ts` に 9 種の削除ジョブがある。`oauth_states` の追加はここへ（→ §7.10） |

### 2.2 目的

| # | 目的 | 完了定義 |
|---|---|---|
| 1 | 3 provider でログイン・新規登録できる | registry にエントリ 3 件 + `/login` にボタン 3 個（**UI は変更不要**） |
| 2 | 既存ユーザーと新規ユーザーを安全に区別する | login フローは「ヒット=ログイン／email 一致=停止して誘導／不一致=新規作成」の 3 分岐 |
| 3 | **他人の SNS アカウントを自分のアカウントに付け替えない** | link フローは「既存リンクあり=拒否」（§7.8） |
| 4 | 連携の追加・解除ができる | `POST /api/auth/oauth/link`（再認証必須）/ `DELETE /api/auth/accounts/{id}` |
| 5 | OAuth 機密値を漏らさない | `log-redaction` に `code`/`state`/`nonce`/`code_verifier`/`id_token` のケースを追加 |

---

## 3. v1.1 で解決した設計上の未決論点

v1.0 を実装前に読み返して見つけた「書いていないと実装時に必ず詰まる」箇所。**すべてここで決着させている**。

| # | 未決論点 | 決着 |
|---|---|---|
| **1** | **registry の型に token 交換・identity 取得の関数スロットが無かった** | `OAuthProviderEntry` を全面再設計（§7.3）。`exchangeCode` / `fetchIdentity` / `verifyIdToken?` を必須にする。v1.0 の「provider 関数の遅延解決」は**撤回**（3 モジュールは小さく、`jose` を読み込む程度のコストしかない。遅延化しても複雑性を買う価値がない） |
| **2** | **「ログイン」と「紐付け」で判定ルールが違うのに、v1.0 は同じフローに潰していた** | `oauth_states` に **`intent` 列（`login` / `link`）**を追加し、callback で分岐する（§7.7）。link は `POST /api/auth/oauth/link`（再認証必須）が開始 |
| **3** | ★★ **link フローで account takeover が可能だった**（v1.0 の設計） | `(provider, provider_account_id)` が既に**他 user に紐付いている**場合、link は**拒否**する。email 一致による自動 link も**禁止**（§7.8 の脅威表） |
| **4** | **`state` を「使い回せない」とだけ書いて、実際にどう別用途で発行するのか不明** | `intent` と `user_id`（link 時のみ）を state 行に持たせ、`POST /api/auth/oauth/link` が新規に state を発行する。login と state を共有しない |
| **5** | **provider への HTTP 呼び出しをテストでどう差し替えるか未定義** | provider モジュールを `vi.mock` する（registry は実関数を保持するので差し替えが効く）。§8.2 に具体例 |
| **6** | **`id_token` を DB に平文で持つ是非** | `state` と `nonce` は平文、`code_verifier` も平文（TTL 10 分・1 回限りのため code 側も失効済み）。**ただし `state` は SHA-256 で検索する**（生 state を DB に置かない）。暗号化の余地は Phase 5 の鍵で残す |
| **7** | **パージ対象に入れていなかった** | `scripts/purge-expired.ts` のジョブに `oauth state` を追加（`expires_at < NOW()`） |
| **8** | **callback 後にどの画面へ戻るかの指定がなかった** | `oauth_states.redirect_to` に**同一オリジンの相対パスのみ**保存。無効値は `null` に落として `/` へ |
| **9** | **provider が `email: null` を返した場合の挙動が未定義** | `email === null` は signup 不可（`account_not_linkable`）。空文字列を email と見なさない |
| **10** | **各分岐でどの security event を記録するか未定義** | §7.7 の表に 1 行ずつ明記（`login_success` / `login_failed` / `register` / `oauth_linked` / `oauth_unlinked` / `rate_limited` のみを使う。**新規 enum は追加しない**） |

---

## 4. スコープ

### 4.1 本フェーズで実装する

`実装Todo.md` §6 の **6-A / 6-B / 6-C 全タスク**。加えて `oauth_states`（1 回限り消費）、`settings/connected-accounts` 画面、`registry.ts` のエントリ 3 件。

### 4.2 本フェーズで実装しない（理由と引継ぎ先）

| 項目 | 判断 | 引継ぎ先 |
|---|---|---|
| **refresh token** | 要求もしない・保存もしない（D-06）。`accounts` に列を持たせない | 将来 provider が session 継続を要求しても再認可で代替 |
| Apple | C-01 で除外 | 需要確定後 |
| **email 一致の自動統合** | **§11 で禁止**。導出されるとは限らず安全でないため | なし（**永久に禁止**） |
| 複数 provider の同時リンク制限 | MVP では制限しない | 将来 |
| profile の定期同期（名前・アイコン） | 初回リンク時に `provider_email` を保存するのみ | 将来 |
| 本番ドメインの OAuth アプリ登録 | ローカルの client ID で開発 | Phase 9 |
| `state` の Redis 化 | PostgreSQL で 1 回限りを強制すれば十分（DB が既に正本） | 将来、負荷が問題になったら |

---

## 5. 前提・着手前チェック

- [ ] **3 provider の client ID / secret が `.env` に設定済み**（✅ 2026-10-17 確認済: 6 キーすべて非空、長さも各形式と一致）
- [ ] **redirect URI を 3 provider のコンソールに完全一致で登録済み**
      ```
      http://localhost:3000/api/auth/oauth/google/callback
      http://localhost:3000/api/auth/oauth/github/callback
      http://localhost:3000/api/auth/oauth/discord/callback
      ```
- [ ] `.env` の `NEXT_PUBLIC_APP_URL=http://localhost:3000` と上記 origin が一致（✅ `localhost` で統一済み）
- [ ] GitHub のテストユーザーのメール設定が **公開**（`verified && primary` が取れないと signup できないため）
- [ ] Google の同意画面が「テスト中」なら**テストユーザーに自分のアカウントを追加済み**
- [ ] `pnpm lint` / `typecheck` / `test` / `build` が green（現状 58 files / 365 tests）
- [ ] `pnpm db:migrate` 適用済み

---

## 6. 決定事項（D-31-01 〜 D-31-18）

| ID | 決定 | 理由 |
|---|---|---|
| **D-31-01** | `redirect_uri` は **`${NEXT_PUBLIC_APP_URL}/api/auth/oauth/{provider}/callback`** を server 側で組み立てる。リクエストの `Host` ヘッダからは**導出しない** | §62 / P4-A-05。`Host` は攻撃者が制御しうる（Phase 6 の `WEBAUTHN_ORIGIN` で同じ判断をしている） |
| **D-31-02** | ID token 検証は **`jose` を dependencies に追加**して使う。`openid-client` は devDeps かつ**リポジトリ内で未使用**なので採用しない | 必要なのは `jwtVerify` + `createRemoteJWKSet` だけ。`openid-client` はフル OIDC client で過剰。**Todo P4-A-02 からの意図的な逸脱** |
| **D-31-03** | GitHub は **token 交換・API 呼び出しの両方で `Accept: application/json`** を付ける | 付けないと `x-www-form-urlencoded` で返り `res.json()` が失敗する。1 行で済むが付け忘れると毎回落ちる |
| **D-31-04** | Google の `iss` は `accounts.google.com` と `https://accounts.google.com` の**両方**を受理 | Google は ID token の `iss` をどちらの形式でも返しうる |
| **D-31-05** | `state`/`nonce`/`code_verifier` は **PostgreSQL の `oauth_states`** に保存し、消費時に **UPDATE** して 1 回限りを DB 側で強制する | Redis は任意依存（D-05）。匿名 Cookie はクライアント削除で消費判定が壊れるため不採用。**replay 防止（§64 の攻撃シナリオ）の要** |
| **D-31-06** | scope は計画 12.1 の値そのまま。**`offline_access` は要求しない**、かつ `access_type=online` を付ける | D-06（refresh token を求めない）。scope は最小 |
| **D-31-07** | `isConfigured(env)` は `client_id` と `client_secret` の**両方**が揃って true | 半分の設定で押して 500 になるのを防ぐ。UI は registry 駆動（D-30-21）なのでここが BCP |
| **D-31-08** | email が取れない / `verified=false` の場合は**新規登録しない**。`account_not_linkable` で `/login` へ戻す | D-10（GitHub）・D-11（Discord）。未検証 email での自動登録は乗っ取りの入口 |
| **D-31-09** | `accounts` の `UNIQUE (provider, provider_account_id)` は**論理削除後も保持**し、物理削除（保持期間経過後のパージ）で解放する | `users` の partial unique index と同じ方針（計画 7.3 / P4-A-06） |
| **D-31-10** | `provider_account_id` は **provider ごとに独立**。Google は `sub`、GitHub は `id`、Discord は `id`（**いずれも文字列**で保存）。UNIQUE は `(provider, provider_account_id)` の組 | 数値が provider をまたいで衝突しても別ユーザーとして扱えるように provider を必ず組に入れる |
| **D-31-11** | social-only ユーザーは `password_hash=NULL` / `email_verified=true` / `status=active` で作成する | `users_status_email_verified_chk` CHECK により `active` は `email_verified=true` 必須 |
| **D-31-12** | `security_events.metadata` は `provider` と真偽値・文脈**のみ**。`code`/`state`/`access_token`/`id_token` は入れない | §21 / 計画 12.4-3 |
| **D-31-13** | レート制限は既存の `rateLimitKeys.oauthStartIp` / `oauthCallbackIp` と `RATE_LIMITS.oauth.start`（10回/10分・ソフト制限 5）/ `.callback`（20回/10分・ソフト制限 10）を使う。**新規キー追加なし** | 既に定義済み。命名も揃っている |
| **D-31-14** | `callback` は `withAuthPipeline` を**通さない**（GET のみ・CSRF 例外経路）。ただし **Origin は同一オリジンか検証する** | 計画 12.2 の例外規定。CSRF は `state`（OIDC は `nonce`）で担保。この経路以外はずれない |
| **D-31-15★** | **`oauth_states` に `intent`（`login` / `link`）と `user_id`（link 時のみ）を追加する**。login は `GET /api/auth/oauth/{provider}` から、link は **`POST /api/auth/oauth/link`（再認証必須）** から**別々に state を発行**する。**state を共有しない** | §3-2/3-4。link は「誰が」紐付けるかを確定させないと §7.8 の乗っ取りが成立する |
| **D-31-16★** | link フローは **`(provider, provider_account_id)` が既に存在する時点で拒否**する（他 user への紐付けは不可）。email 一致による link も**しない** | §7.8。**最重要のセキュリティ決定** |
| **D-31-17★** | `oauth_states` は `scripts/purge-expired.ts` の削除ジョブに追加する（`expires_at < NOW()`）。consumed 済みは 1 時間後に削除 | §7.10 |
| **D-31-18★** | **新規 security event type は追加しない**。既存の `login_success` / `login_failed` / `oauth_linked` / `oauth_unlinked` / `rate_limited` / `account_deleted` だけで表現する（`metadata.provider` で区別） | §21 の 16 種の spirit を守る。イベント種別を Provider ごとに増やさない |

---

## 7. 全体設計

### 7.1 ファイル一覧

**新規（25）**

| # | パス | 責務 |
|---|---|---|
| 1 | `src/lib/auth/oauth/types.ts` | `OAuthProviderEntry` / `TokenSet` / `Identity` / `OAuthIntent` の型 |
| 2 | `src/lib/auth/oauth/state.ts` | state 発行・消費（1 回限り・TTL 10 分・SHA-256 検索） |
| 3 | `src/lib/auth/oauth/google.ts` | Google provider（`jose` 検証 + profile 取得） |
| 4 | `src/lib/auth/oauth/github.ts` | GitHub provider（`Accept: application/json` 必須・`primary && verified`） |
| 5 | `src/lib/auth/oauth/discord.ts` | Discord provider（`/users/@me` の `verified`） |
| 6 | `src/lib/auth/oauth/accounts.ts` | `accounts` の検索・作成・解除・last_used 更新 |
| 7 | `src/lib/auth/oauth/complete-login.ts` | login intent の判定フロー（§7.7） |
| 8 | `src/lib/auth/oauth/complete-link.ts` | link intent の判定フロー（§7.7・§7.8） |
| 9 | `src/lib/validate/oauth.ts` | zod（provider 列挙・callback の `code`/`state`/`error`・link の `provider`） |
| 10 | `src/app/api/auth/oauth/[provider]/route.ts` | `GET`（login intent の認可開始） |
| 11 | `src/app/api/auth/oauth/[provider]/callback/route.ts` | `GET`（callback。intent で分岐） |
| 12 | `src/app/api/auth/oauth/link/route.ts` | `POST`（link intent の認可開始・再認証必須） |
| 13 | `src/app/api/auth/accounts/route.ts` | `GET`（自分の連携一覧） |
| 14 | `src/app/api/auth/accounts/[id]/route.ts` | `DELETE`（解除・再認証必須） |
| 15 | `src/app/settings/connected-accounts/page.tsx` ＋ `connected-accounts.tsx` | 一覧/追加/解除 UI |
| 16 | `src/test/security/oauth-state.test.ts` | state 不一致・期限・消費・provider 交差 |
| 17 | `src/test/security/oauth-pkce.test.ts` | `code_challenge_method=S256` 固定・verifier |
| 18 | `src/test/security/oauth-nonce.test.ts` | nonce 送出・照合・不一致拒否 |
| 19 | `src/test/security/oauth-redirect.test.ts` | 完全一致・Host 非依存・未登録 404 |
| 20 | `src/test/security/oauth-replay.test.ts` | callback 2 回目は `INVALID_STATE` |
| 21 | `src/test/security/account-linking.test.ts` | link の脅威 T1〜T5 の回帰（§7.8） |
| 22 | `src/test/security/oauth-email-verified.test.ts` | 未検証 email / `email: null` で signup しない |
| 23 | `src/test/security/oauth-not-configured.test.ts` | `isConfigured` 半分の設定で 404・ボタン不出 |
| 24 | `src/test/integration/accounts.test.ts` | `UNIQUE(provider, provider_account_id)` と論理削除 |
| 25 | `src/test/e2e/oauth-flow.test.ts` | provider スタブ化した実 HTTP での通し |

**変更（14）**

| パス | 変更 |
|---|---|
| `package.json` | `jose` を **dependencies** に追加（D-31-02） |
| `src/lib/auth/oauth/registry.ts` | 型を再設計（§7.3）＋**エントリ 3 件**（§7.4）＋ `getProvider()` |
| `src/lib/db/schema.ts` | `accounts` / `oauthStates` / `SOCIAL_PROVIDERS` |
| `src/lib/db/queries/users.ts` | social-only ユーザー作成関数 |
| `src/lib/util/logger.ts` | `id_token` をキーへ追加＋**配線テスト** |
| `src/app/settings/settings-nav.tsx` | 「連携アカウント」をナビに追加 |
| `src/app/settings/page.tsx` | 同上（ホーム） |
| `src/components/settings/security-overview.tsx` | 連携カードに実際の件数・導線 |
| `src/components/auth/social-login-buttons.tsx` | **変更不要**（registry 駆動） |
| `src/messages/ja.ts` | `ui.oauth.*`（ボタンラベル・`error` 5 種: `cancelled` / `account_not_linkable` / `link_required` / `already_linked` / `email_conflict`・link/解除の説明・`:field` / `:heading`） |
| `scripts/purge-expired.ts` | `oauth state` ジョブを追加（D-31-17） |
| `.env.example` | 取得手順へのポインタ（✅ 済） |
| `drizzle/` | migration 2 本 |
| `src/test/security/log-redaction.test.ts` | OAuth 機密値のケース追加 |
| `src/test/integration/purge-expired.test.ts` | `oauth_states` のパージ確認 |

### 7.2 データモデル

**migration `0015_accounts.sql`**（計画 7.3）

```sql
CREATE TABLE "accounts" (
  "id"                  text PRIMARY KEY,
  "user_id"             text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider"            text NOT NULL,
  "provider_account_id" text NOT NULL,
  "provider_email"      text,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "last_used_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "accounts_provider_chk" CHECK ("provider" IN ('google','github','discord')),
  CONSTRAINT "accounts_provider_account_uniq" UNIQUE ("provider", "provider_account_id")
);
CREATE INDEX "accounts_user_id_idx" ON "accounts" ("user_id");
```

- `id` は `acc_` prefix（`newId('acc')`・既存 `ID_PREFIXES`）
- **refresh token 列は持たない**（D-06）
- 論理削除（`users.deleted_at`）では `ON DELETE CASCADE` が発火しないため行は残り、UNIQUE 制約も保持 → 再登録は保持期間中は拒否。**パージで解放**（D-31-09）

**migration `0016_oauth_states.sql`**（D-31-05 / D-31-15）

```sql
CREATE TABLE "oauth_states" (
  "state_hash"    text PRIMARY KEY,              -- SHA-256(state)。生 state は保存しない
  "provider"      text NOT NULL,
  "intent"        text NOT NULL DEFAULT 'login', -- login | link
  "user_id"       text REFERENCES "users"("id") ON DELETE CASCADE,  -- link のみ
  "nonce"         text NOT NULL,
  "code_verifier" text NOT NULL,
  "redirect_to"   text,                          -- 同一オリジンの相対パスのみ
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "expires_at"    timestamptz NOT NULL,
  "consumed_at"   timestamptz,
  CONSTRAINT "oauth_states_intent_chk" CHECK ("intent" IN ('login','link'))
);
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" ("expires_at");
CREATE INDEX "oauth_states_user_id_idx" ON "oauth_states" ("user_id");
```

> `code_verifier` を平文で持つ点について: 本来は暗号化が望ましいが、**TTL 10 分・1 回限りの使い捨て**であり、DB 侵害時に両方を手に入れても `code` 側は 10 分で失効しているため、フロー完了まで到達できない。`state` は hash で検索する。**Phase 5 の `TOTP_ENCRYPTION_KEY` で暗号化する余地は残す**（この判断は明示的に記録しておく）。

### 7.3 registry 型の再設計（v1.0 からの変更点）

```ts
// src/lib/auth/oauth/types.ts
export type OAuthProviderId = 'google' | 'github' | 'discord';
export type OAuthIntent = 'login' | 'link';

export type TokenSet = {
  accessToken: string;
  idToken?: string;            // OIDC provider のみ
  tokenType: string;
  scope?: string;
};

export type Identity = {
  providerAccountId: string;  // provider ごとに独立。必ず文字列
  email: string | null;       // null は「取得できない」。空文字扱いにしない
  emailVerified: boolean;
  displayName?: string | null;
};

export type OAuthProviderEntry = {
  id: OAuthProviderId;
  label: string;
  protocol: 'oidc' | 'oauth2';
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scope: string;
  envKeys: { clientId: string; clientSecret: string };
  /** UI にボタンを出すか。client_id と client_secret の両方が必要（D-31-07） */
  isConfigured: (env: Record<string, string | undefined>) => boolean;
  /** code → token */
  exchangeCode: (args: {
    code: string; codeVerifier: string; redirectUri: string;
    clientId: string; clientSecret: string;
  }) => Promise<TokenSet>;
  /** access_token（と claims）→ Identity。emailVerified=false なら新規登録しない */
  fetchIdentity: (args: {
    accessToken: string; idTokenClaims?: Record<string, unknown>;
  }) => Promise<Identity>;
  /** OIDC provider のみ。alg は RS256 固定 */
  verifyIdToken?: (args: { idToken: string; nonce: string; clientId: string }) => Promise<Record<string, unknown>>;
};
```

```ts
// src/lib/auth/oauth/registry.ts （抜粋）
export function getProvider(id: string): OAuthProviderEntry | null {
  return OAUTH_PROVIDER_REGISTRY.find((entry) => entry.id === id) ?? null;
}
export function configuredOAuthProviders(env: Record<string, string | undefined>): OAuthProviderEntry[] {
  return OAUTH_PROVIDER_REGISTRY.filter((entry) => entry.isConfigured(env));
}
```

- **UI へ渡すのは `{id, label}` だけ**。`server component` が `process.env` を読み、`LoginButtons` には id/label だけを props で渡す（`isConfigured` の判定結果を跨ぐ。secret を client に載せない）
- v1.0 の「provider 関数を遅延解決」は**撤回**（§3-1）。3 モジュールを静的 import し、**実行は必要な時だけ**する（import 時のコストは `jose` を読み込む程度）

### 7.4 provider 実装（完全コード）

#### 7.4.1 共通

```ts
// src/lib/auth/oauth/redirect-uri.ts
export function redirectUriFor(provider: OAuthProviderId): string {
  const base = getEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, '');   // 末尾スラッシュを除去
  return `${base}/api/auth/oauth/${provider}/callback`;
}
```

#### 7.4.2 Google（OIDC）

```ts
// src/lib/auth/oauth/google.ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];   // D-31-04

export const google: OAuthProviderEntry = {
  id: 'google', label: 'Google', protocol: 'oidc',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  scope: 'openid email profile',
  envKeys: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
  isConfigured: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),

  async exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret }) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        code, code_verifier: codeVerifier, client_id: clientId,
        client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code',
      }),
    });
    if (!response.ok) throw new ProviderError('token_exchange_failed');
    const json = await response.json();
    return { accessToken: json.access_token, idToken: json.id_token, tokenType: json.token_type, scope: json.scope };
  },

  async verifyIdToken({ idToken, nonce, clientId }) {
    const { payload } = await jwtVerify(idToken, JWKS, {
      algorithms: ['RS256'],                 // ★ alg=none / HS256 を弾く（D-31-04）
      audience: clientId,                    // aud == client_id
      issuer: ISSUERS,                       // 2 形式を受理
      clockTolerance: 5,                     // 時計ずれの許容（exp/iat）
    });
    if (payload.nonce !== nonce) throw new ProviderError('nonce_mismatch');   // ★ OIDC 必須
    return payload;
  },

  async fetchIdentity({ idTokenClaims }) {
    const email = typeof idTokenClaims?.email === 'string' ? idTokenClaims.email : null;
    return {
      providerAccountId: String(idTokenClaims?.sub ?? ''),
      email,
      emailVerified: idTokenClaims?.email_verified === true,
      displayName: typeof idTokenClaims?.name === 'string' ? idTokenClaims.name : null,
    };
  },
};
```

#### 7.4.3 GitHub（OAuth2・`Accept` 必須・`primary && verified`）

```ts
// src/lib/auth/oauth/github.ts
export const github: OAuthProviderEntry = {
  id: 'github', label: 'GitHub', protocol: 'oauth2',
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  scope: 'read:user user:email',
  envKeys: { clientId: 'GITHUB_CLIENT_ID', clientSecret: 'GITHUB_CLIENT_SECRET' },
  isConfigured: (env) => Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),

  async exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret }) {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',        // ★★ これがないと form-urlencoded が返る（D-31-03）
      },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        code, code_verifier: codeVerifier, redirect_uri: redirectUri,
      }),
    });
    if (!response.ok) throw new ProviderError('token_exchange_failed');
    const json = await response.json();
    if (json.error || !json.access_token) throw new ProviderError('token_exchange_failed');
    return { accessToken: json.access_token, tokenType: json.token_type ?? 'bearer', scope: json.scope };
  },

  async fetchIdentity({ accessToken }) {
    const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}` };
    const [userRes, emailsRes] = await Promise.all([
      fetch('https://api.github.com/user', { headers }),
      fetch('https://api.github.com/user/emails', { headers }),
    ]);
    if (!userRes.ok || !emailsRes.ok) throw new ProviderError('userinfo_failed');

    const user = await userRes.json();
    const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];

    // ★ primary && verified のみ採用（D-08 / 計画 D-10）。無ければ email=null で signup 不可
    const chosen = emails.find((entry) => entry.primary && entry.verified) ?? null;

    return {
      providerAccountId: String(user.id),
      email: chosen?.email ?? null,
      emailVerified: chosen !== null,          // 検証できた email が無い = 検証不合格
      displayName: user.name ?? user.login ?? null,
    };
  },
};
```

> **注意**: GitHub は `primary && verified` の組が無いユーザー（＝メールを非公開にしているユーザー）が存在する。その場合 `emailVerified=false` となり、**新規登録しない**（D-31-08）。`interop/README.md` のとおり、テストユーザーはメールを公開しておくと検証しやすい。

#### 7.4.4 Discord（OAuth2・`verified`）

```ts
// src/lib/auth/oauth/discord.ts
export const discord: OAuthProviderEntry = {
  id: 'discord', label: 'Discord', protocol: 'oauth2',
  authorizationEndpoint: 'https://discord.com/oauth2/authorize',
  tokenEndpoint: 'https://discord.com/api/oauth2/token',
  scope: 'identify email',
  envKeys: { clientId: 'DISCORD_CLIENT_ID', clientSecret: 'DISCORD_CLIENT_SECRET' },
  isConfigured: (env) => Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),

  async exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret }) {
    const response = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier,
      }),
    });
    if (!response.ok) throw new ProviderError('token_exchange_failed');
    const json = await response.json();
    return { accessToken: json.access_token, tokenType: json.token_type ?? 'Bearer', scope: json.scope };
  },

  async fetchIdentity({ accessToken }) {
    const response = await fetch('https://discord.com/api/users/@me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new ProviderError('userinfo_failed');
    const me = await response.json();
    return {
      providerAccountId: String(me.id),
      email: typeof me.email === 'string' && me.email ? me.email : null,   // ★ null と空文字を区別（§3-9）
      emailVerified: me.verified === true,
      displayName: me.global_name ?? me.username ?? null,
    };
  },
};
```

### 7.5 `state.ts`（1 回限りの実装）

```ts
// src/lib/auth/oauth/state.ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { oauthStates } from '@/lib/db/schema';
import type { OAuthIntent, OAuthProviderId } from './types';

const TTL_SECONDS = 10 * 60;                    // 計画 12.1 の TTL 10 分

const hashState = (state: string) => createHash('sha256').update(state).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');   // 256bit
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export type IssuedState = { state: string; nonce: string; codeVerifier: string; redirectUri: string };

export async function issueOAuthState(args: {
  provider: OAuthProviderId; intent: OAuthIntent; userId?: string | null; redirectTo?: string | null;
}): Promise<IssuedState> {
  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken();           // PKCE: 43〜128 文字（base64url(32B) = 43 文字）
  await getDb().insert(oauthStates).values({
    stateHash: hashState(state), provider: args.provider, intent: args.intent,
    userId: args.userId ?? null, nonce, codeVerifier,
    redirectTo: normalizeRedirectTo(args.redirectTo),                 // §7.6
    expiresAt: new Date(Date.now() + TTL_SECONDS * 1000),
  });
  return { state, nonce, codeVerifier, redirectUri: redirectUriFor(args.provider) };
}

/**
 * state を消費する。**返り値が null なら失敗**。
 * UPDATE ... WHERE consumed_at IS NULL により、2 回目以降は必ず 0 行更新＝null になる（replay 防止）。
 */
export async function consumeOAuthState(state: string, provider: OAuthProviderId): Promise<{
  nonce: string; codeVerifier: string; intent: OAuthIntent; userId: string | null; redirectTo: string | null;
} | null> {
  const rows = await getDb().update(oauthStates)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(oauthStates.stateHash, hashState(state)),
      eq(oauthStates.provider, provider),
      gt(oauthStates.expiresAt, new Date()),
      isNull(oauthStates.consumedAt),
    ))
    .returning();
  if (rows.length !== 1) return null;          // ★ 1 行でなければ失敗
  return {
    nonce: rows[0]!.nonce, codeVerifier: rows[0]!.codeVerifier,
    intent: rows[0]!.intent, userId: rows[0]!.userId, redirectTo: rows[0]!.redirectTo,
  };
}
```

- `state` の比較は **SHA-256 で引く**ため、生の state を DB に保存しない。タイミング差は `UPDATE ... RETURNING` の行数判定で吸収（0/1 行なので timingSafeEqual は不要）

### 7.6 API 契約

| Method | Path | 概要 | 追加要件 |
|---|---|---|---|
| `GET` | `/api/auth/oauth/{provider}` | **login intent** の認可開始 | 未登録/未設定は **404 `INVALID_PROVIDER`**。レート `oauth.start` |
| `POST` | `/api/auth/oauth/link` | **link intent** の認可開始（`{provider}`） | **認証 + 再認証必須**。既に同じ provider を紐付ければ 409 |
| `GET` | `/api/auth/oauth/{provider}/callback` | callback（intent で分岐） | レート `oauth.callback`。`withAuthPipeline` を通さない（D-31-14） |
| `GET` | `/api/auth/accounts` | 自分の連携一覧 | 認証。`no-store` |
| `DELETE` | `/api/auth/accounts/{id}` | 連携解除 | 認証 + **再認証必須**。owner 確認。**最後の認証手段なら 409**。通知メール |

**`GET /api/auth/oauth/{provider}` の authorize URL**

```
303 Location: https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=<CLIENT_ID>
  &redirect_uri=<env から組み立てた完全一致 URL>
  &response_type=code
  &scope=openid+email+profile
  &state=<base64url(32B)>              ← 32 バイト乱数（固定値禁止・§62）
  &nonce=<base64url(32B)>              ← OIDC のみ
  &code_challenge=<base64url(SHA-256(verifier))>
  &code_challenge_method=S256           ← 固定。plain を許さない
  &access_type=online                   ← refresh token を求めない（D-31-06）
Cache-Control: no-store
```

**`redirect_to` の正規化**（open redirect 対策・§7.9）

```ts
function normalizeRedirectTo(value: string | null | undefined): string | null {
  if (!value) return null;
  // 同一オリジンの**相対パス**のみ受理。絶対 URL・`//host`・`\` 始まり・制御文字は捨てる
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/[\u0000-\u001F\u007F]/.test(value)) return null;
  return value.slice(0, 200);
}
```

**`POST /api/auth/oauth/link`**

```
リクエスト: { "provider": "github" }
200 / 303 → Location: <authorize URL>
エラー:
  401 SESSION_EXPIRED   未ログイン
  401 REAUTH_REQUIRED  再認証が必要（5 分猶予・D-14）
  409 ALREADY_LINKED   この provider は既に紐付いている
  404 INVALID_PROVIDER 未登録 / 未設定
```

### 7.7 コールバック判定フロー（intent で 2 系統）

```
【共通】
 1. provider 解決（未登録 or 未設定 → 404 INVALID_PROVIDER）
 2. error=access_denied → /login?error=cancelled（情報を出さない）
 3. Origin ヘッダが同一オリジンか検証（D-31-14）
 4. consumeOAuthState(state, provider)
      → null なら 400 INVALID_STATE ＋ login_failed{provider, state_present:true}
        （= 不一致・期限切れ・消費済みのすべて。どれが該当するか教えない）
 5. token 交換（code_verifier を送る）
      失敗 → 401 INVALID_CREDENTIALS ＋ login_failed{provider, error:'token_exchange_failed'}
 6. OIDC: ID token 検証（jose）。alg=RS256 固定 / aud / iss / exp / nonce 照合
      不一致 → 401 INVALID_CREDENTIALS ＋ login_failed{provider, error:'id_token_invalid'}
 7. fetchIdentity → { providerAccountId, email, emailVerified }

【intent = login の分岐】※ complete-login.ts
 8a. identity.emailVerified === false || email === null
       → 303 /login?error=account_not_linkable   （新規登録しない・D-31-08）
 8b. accounts に (provider, providerAccountId) がある
       → その user が suspended/deleted なら 403 ACCOUNT_SUSPENDED
       → 既存セッションをすべて revoke して **新しいセッションを発行**（ローテーション）
       → 新規デバイスなら既存 notifyNewDeviceLogin を再利用
       → oauth_linked ではなく login_success を記録
 8c. 未紐付け かつ email が既存 users と一致
       → ★停止。303 /login?error=link_required（自動統合しない・§11）
         → ユーザーはログインして /settings/connected-accounts から link する
 8d. 未紐付け かつ email 一致なし
       → social-only ユーザー作成（password_hash=NULL, email_verified=true, status=active）
       → accounts 行作成 ＋ oauth_linked イベント
       → 新規セッション発行 → 303 redirect_to ?? '/'

【intent = link の分岐】※ complete-link.ts
 9a. user_id が state に無い、または現セッションの user と一致しない
       → 400 INVALID_STATE（login 中に link を始める操作はできない）
 9b. ★★ (provider, providerAccountId) が既に存在する
       → 409 ALREADY_LINKED_ELSEWHERE（他 user のものを奪わない・§7.8）
 9c. 同じ provider を既に紐付けている
       → 409 ALREADY_LINKED
 9d. email 一致する別 user が存在する → **それでも自動的に link しない**
       → 409 EMAIL_CONFLICT（「このメールアドレスは別のアカウントに登録済み」）
       （login の 8c は「誘導」、link の 9d は「拒否」。**片方を他方の抜け穴にしない**）
 9e. そのほか → accounts 行を作成 ＋ oauth_linked イベント → 303 /settings/connected-accounts
```

**各分岐の security event**（新規 enum は追加しない・D-31-18）

| 分岐 | event_type | metadata |
|---|---|---|
| 4 / 5 / 6 失敗 | `login_failed` | `{ provider, state_present: true }` / `{ provider, error }` |
| 8a | なし（ユーザーがログインに到達する前に分岐するため記録不要） | ― |
| 8b | `login_success` | `{ provider }` |
| 8c | `login_failed` | `{ provider, error: 'link_required' }` |
| 8d | `register` ＋ `oauth_linked` | `{ provider }` |
| 9b/9c/9d | `oauth_linked` は**記録しない**（失敗なので）。`login_failed` も不自然 → **イベント無し + レート制限で可視化** | ― |
| 9e | `oauth_linked` | `{ provider }` |

### 7.8 link フローの脅威分析（★ 最重要）

link フローは「認証済みのユーザーが、自分のアカウントに外部 ID を紐付ける」操作であり、**新規登録より攻撃面が広い**。link のたびに「ローカルパスワード + セッション」という認証の強度が一段階落ちる。以下の 8 つの脅威をすべて実装して塞ぐ。

| # | 脅威 | 攻撃者の手 | 対策 | 実装箇所 |
|---|---|---|---|---|
| **T1** | **アカウント乗っ取り（最重要）** | 攻撃者が自分のアカウントに**他人の Google** を紐付ける | `(provider, provider_account_id)` が既に他 user にある場合は **409 で拒否**。email 一致による上書きも禁止 | 9b / D-31-16 |
| **T2** | **email 一致での乗っ取り** | 攻撃者が自分のアカウントから、**被害者の email** を持つ provider を link する | link では **email 一致を理由に自動 link しない**（9d で拒否）。login 側の誘導（8c）と link 側の拒否（9d）を**両方**実装する | 8c / 9d |
| **T3** | **link 中のセッション窃取** | 攻撃者が被害者のブラウザで link を開始し、被害者のセッションに紐付ける | `POST /api/auth/oauth/link` は **再認証必須**（パスワード入力・5 分猶予）。さらに `state.user_id` を callback で**現セッションと照合** | D-31-15 / 9a |
| **T4** | **CSRF 付き link** | 罠ページの form で被害者に link を開始させる | 開始は **POST + CSRF トークン必須**。callback は `state` で担保（§12.2 の例外規定） | D-31-14 |
| **T5** | **state の使い回し** | 自分の link 用 state を別の被害者に配る | `state` は 1 回限り・TTL 10 分・`user_id` 照合。**login と link で state を共有しない** | D-31-15 / 9a |
| **T6** | **未認証 email での link** | 検証していない email の provider を link して email を汚染する | `emailVerified=false` なら link しない（identity 取得の段階で弾く） | D-31-08 |
| **T7** | **最後の認証手段を失う** | link した直後に解除して、ログイン手段をゼロにする | 解除は「パスワード未設定 かつ accounts 0 件」で **409**。かつ解除は再認証必須 | §7.6 / P4-C-02 |
| **T8** | **link 数の上限なし** | 攻撃者が大量の provider を紐付けて DB を汚す | 1 ユーザー 1 provider 1 件（`UNIQUE(provider, provider_account_id)` + provider _unique）。**MVP では数を制限しない**が、`oauth_linked` イベントで検知できる | D-31-09 |

**回帰テスト（必須）**

```
- [ ] T1: 他 user に紐付いた (provider, id) を link すると 409。accounts 行が変わらない
- [ ] T2: email 一致する別 user がいる provider を link すると 409。自動 link されない
- [ ] T3: 再認証なしで link 開始 → 401 REAUTH_REQUIRED
- [ ] T3': link 中に別 user のセッションに差し替え → 400 INVALID_STATE
- [ ] T5: link 用 state を login フローで使い回す → 400 INVALID_STATE
```

### 7.9 セキュリティ設計

| リスク | 対策 |
|---|---|
| **open redirect**（`redirect_to`） | 同一オリジンの相対パスのみ受理（§7.6）。絶対 URL・`//host`・`\` 始まり・制御文字は `null` に落とす |
| **認可コード再利用（replay）** | `state` を消費時に `UPDATE`（`consumed_at`）。2 回目の callback は必ず 0 行更新 → `INVALID_STATE`（DoD の `oauth-replay.test.ts`） |
| **state の要求差し替え** | `state` を SHA-256 で引き、**`provider` も照合**。別 provider の state を流用できない |
| **PKCE downgrade** | `code_challenge_method=S256` を固定。plain を許さない |
| **ID token の alg=none 攻撃** | `jwtVerify` に `algorithms: ['RS256']` を明示。`aud` は `client_id`、`iss` は 2 形式、`exp` は `clockTolerance: 5` |
| **ID token リプレイ** | `nonce` を state に保存し、ID token の `nonce` claim と照合 |
| **link による乗っ取り** | §7.8 の 8 脅威すべて |
| **client_secret の漏えい** | server 専用（`LAZY_ENV`）。`NEXT_PUBLIC_*` にしない。UI へ渡すのは `{id,label}` のみ |
| **ログへの機密値** | `code`/`state`/`nonce`/`code_verifier`/`id_token` を `logger` に渡さない。**callback の URL 全体をログに出さない**（クエリに `code` が含まれる） |
| **`security_events.metadata`** | `provider` / `error` / `state_present` のような真偽値・文脈**のみ**（D-31-12） |
| **最後の認証手段の解除** | `password_hash === null` かつ `accounts` が 0 件なら 409 |
| **provider 未設定で押される** | `isConfigured` false なら 404。UI にもボタン不出（D-31-07） |
| **レート制限** | `oauth.start` 10回/10分・`oauth.callback` 20回/10分（IP 単位、既存キー・D-31-13） |

### 7.10 パージ・運用

`scripts/purge-expired.ts` の `jobs` に追加（D-31-17）:

```ts
['oauth state', sql`DELETE FROM oauth_states WHERE state_hash IN (
   SELECT state_hash FROM oauth_states
   WHERE expires_at < NOW() OR consumed_at < NOW() - INTERVAL '1 hour'
   ORDER BY expires_at ASC LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
 ) RETURNING state_hash`],
```

- `consumed_at` 済みは**1 時間後に削除**（監査ログに残す必要は薄いが、直後のデバッグ用に残す）
- `src/test/integration/purge-expired.test.ts` に「期限切れの state が消える」ケースを追加
- 運用: `purge-expired` を cron で定期実行（Phase 9 の運用手順に記載）

**監視すべきシグナル**

| シグナル | 意味 |
|---|---|
| `login_failed` が短時間に多く記録される | provider 側の障害か、`code` の使い回し試行。`metadata.provider` で切り分ける |
| `INVALID_STATE` の多発 | レート制限の触及（攻撃 or 同一ユーザーの連打） |
| 同一 IP から複数 provider の `login_failed` | 自動化された攻撃の兆候 |
| `security_notification_failed` | 通知メール送信の障害（既存・Phase 4 で再利用） |

---

## 8. テスト計画

### 8.1 ファイル別（DoD 名指し 6 ファイルを含む）

| 種別 | ファイル | 主要ケース（期待値つき） |
|---|---|---|
| security | **`oauth-state.test.ts`** | state 不一致 → 400 / 10 分超 → 400 / **消費後の 2 回目 → 400** / provider 交差（google の state を github に使う）→ 400 / 未知 state → 400 / link intent の state に `user_id` が無い → 400 |
| security | **`oauth-pkce.test.ts`** | authorize URL に `code_challenge` が付く / **`code_challenge_method=S256` 固定**（plain にならない）/ `code_verifier` が token 交換で送られる / verifier が 43〜128 文字の base64url / `access_type=online` が付く |
| security | **`oauth-nonce.test.ts`** | authorize URL に `nonce` が付く / ID token の `nonce` が state と一致 / **不一致 → 401** / nonce 欠落 → 401 / **alg=none の ID token → 401** / **aud が別 client → 401** |
| security | **`oauth-redirect.test.ts`** | redirect_uri が env 組み立てと完全一致 / **末尾スラッシュ差で不一致** / 未登録 provider → 404 / **Host ヘッダ偽装で redirect_uri が変わらない** / `redirect_to` に絶対 URL → `/` に落ちる / `//evil.example` → 落ちる |
| security | **`oauth-replay.test.ts`** | authorize→callback→**同じ callback を 2 回目** → `INVALID_STATE` / 別 session の state の使い回し → 400 / token 交換は 1 回だけ（2 回目は state で止まる） |
| security | **`account-linking.test.ts`** | **T1〜T5 の 5 ケース（§7.8）** / 最後の認証手段の解除 → 409 / 他人の `accounts/{id}` 削除 → 404 / 解除時に通知メール |
| security | `oauth-email-verified.test.ts` | GitHub の `verified=false` で signup しない / Discord の `verified=false` で signup しない / `email: null` で signup しない / `primary` でない email は採用しない |
| security | `oauth-not-configured.test.ts` | `isConfigured` が片方だけ true → ボタン不出・404 / 未登録 provider の 404 |
| security | （既存 `log-redaction.test.ts` へ追記） | `code=` `state=` `nonce=` `code_verifier=` `id_token=` が `***` / URL 全体を渡しても redact される |
| integration | `accounts.test.ts` | `UNIQUE(provider, provider_account_id)` 違反 / **別 provider なら同 id で共存可** / `last_used_at` 更新 / 論理削除で UNIQUE が保持される（再登録が拒否される） |
| e2e | `oauth-flow.test.ts` | provider をスタブ化した実 HTTP：authorize URL 取得 → 303 の宛先/パラメータ確認 → callback の 303 → セッション発行 → 旧セッション拒否 |

### 8.2 provider の差し替え方（mock 戦略・§3-5）

```ts
// src/test/security/oauth-replay.test.ts の例
vi.mock('@/lib/auth/oauth/github', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/oauth/github')>('@/lib/auth/oauth/github');
  return { ...actual, github: { ...actual.github, exchangeCode: vi.fn(async () => ({ accessToken: 'fake', tokenType: 'bearer' })) } };
});
```

- registry は provider モジュールの**実関数を保持**するため、モジュールごと `vi.mock` すれば差し替えが効く
- 外部 HTTP を**実際に叩かない**（`vi.stubGlobal('fetch', ...)` は使わない。provider 関数のほうが境界が明確）
- ID token の検証（`jose`）は `jose` 自身のテストに任せ、**こちらは「壊れた token を渡したら 401」** の 1 ケースだけ固定する

### 8.3 件数

既存 58 files / 365 tests ＋ **新規 10 ファイル・約 82 ケース** = **68 files / 447 cases**。

内訳: security 8 / integration 1 / e2e 1。加えて既存 2 ファイル（`log-redaction.test.ts`・`purge-expired.test.ts`）へケースを追記する（§8.1 の「既存へ追記」行）。

---

## 9. 実 provider での手動疎通確認手順

client ID を取得済みなので、**provider に実際に到達する**ことを確認する。計画書だけでは実感がつかないので、P3 の実ブラウザ検証と同じ位置づけで扱う。

| # | 手順 | 期待 |
|---|---|---|
| 1 | `pnpm dev` → `/login` を開く | **社会ログインボタンが 3 個出る**（Google / GitHub / Discord） |
| 2 | Google ボタンを押す | Google の同意画面に遷移する（scope が `openid email profile` になっている） |
| 3 | Google で承認 | `/` に戻り、**新規ユーザーとして登録される**（`password_hash` が NULL） |
| 4 | ログアウトして GitHub ボタンを押す | `redirect_uri_mismatch` が出**ない**こと |
| 5 | GitHub で承認 | `/` に戻る。GitHub でメール非公開の場合 `account_not_linkable` になる（仕様どおり） |
| 6 | ログアウトして Discord ボタンを押す | Discord の認証に遷移し、`identify email` が要求される |
| 7 | Discord で承認 | `/` に戻り、連携アカウントが 1 件できる |
| 8 | `/settings/connected-accounts` を開く | 3 件（Google/GitHub/Discord）が表示され、解除できる |
| 9 | 同じ provider で再ログイン | 連携アカウントが増えず、ログインだけ成功（新規登録されない） |
| 10 | 未紐付けの別 SNS でログイン | `link_required` が出て自動統合されない |
| 11 | `/api/auth/oauth/google/callback` を直接叩く（code 無し） | `400 INVALID_STATE`（`state` の消費で止まる） |

> #11 は**手動で崩してもよい**が、`oauth-replay.test.ts` の自動テストが同じことを固定している。手動チェックは「provider の実際の応答が想定の型か」を確認するのに効く。

---

## 10. 実装順序

```text
Step 1（基盤・外部通信なし）
  P4-A-01 types.ts + registry 型の再設計
  P4-A-06 migration 0015/0016 + schema + purge ジョブ
  P4-A-07 redact 配線のテスト（先に守りを固める）
  P4-D-02 security: state / pkce / nonce / redirect / replay の 5 ファイル

Step 2（状態管理）
  P4-B-01a state.ts（発行・消費・1 回限り）
  P4-B-01b GET /api/auth/oauth/{provider}（authorize URL まで）

Step 3（provider・1 つずつ）
  P4-A-02 Google（jose）→ 手動 #2/#3
  P4-A-03 GitHub（Accept 必須）→ 手動 #4/#5
  P4-A-04 Discord（verified）→ 手動 #6/#7
  ★ 各 provider ごとに「authorize URL のパラメータ」を curl で確認してから次へ

Step 4（callback・login）
  P4-B-03 callback 全体（login intent の 8a〜8d）
  P4-B-04 レート制限
  P4-D-01 account-linking テスト
  → 手動 #8/#9/#10

Step 5（link）
  P4-C-01 link intent（9a〜9e）＋ 脅威のテスト
  P4-C-02 DELETE /api/auth/accounts/{id}
  P4-C-03 /settings/connected-accounts UI ＋ ナビ
  P4-C-04 通知メール
  → 手動 #11

Step 6: pnpm lint / typecheck / test / build + 手動 11 手順の完了
```

**各 Step の完了条件**

| Step | 条件 |
|---|---|
| 1 | migration 適用済み、redact テスト green、state/pkce/nonce/redirect/replay の 5 ファイル green |
| 2 | 認可開始で 303 が返り、`oauth_states` に 1 行できる |
| 3 | 各 provider の authorize URL に正しい scope/redirect_uri/`code_challenge_method=S256` が付く |
| 4 | login の 4 分岐がテストで green。**手動 #3/#5/#7 を通す** |
| 5 | link の 5 分岐 + 脅威 8 件がテストで green。**手動 #8〜#11 を通す** |
| 6 | 5 コマンド green |

---

## 11. DoD

**仕様 §64「ソーシャルログイン」**
- [ ] Google ログインできる（新規登録・既存ログインの両方）
- [ ] GitHub ログインできる
- [ ] Discord ログインできる
- [ ] OAuth アカウントを紐付けできる（再認証必須）
- [ ] 紐付けを解除できる（最後の認証手段は拒否）
- [ ] Apple は対象外（C-01）

**セキュリティ**
- [ ] `src/test/security/{oauth-state,oauth-pkce,oauth-nonce,oauth-redirect,oauth-replay,account-linking}.test.ts` green
- [ ] 認可コードが 2 回使えない（replay 固定）
- [ ] **link で他人の SNS アカウントを乗っ取れない**（§7.8 の T1〜T8 のうち、回帰テスト化した T1〜T5 が green）
- [ ] email 一致での自動統合が**しない**（login=誘導 / link=拒否の両方）
- [ ] 未検証 email・`email: null` で自動登録が**されない**
- [ ] `code`/`state`/`nonce`/`code_verifier`/`id_token` がログ・API 応答・`security_events.metadata` に**平文で現れない**
- [ ] redirect_uri が Host ヘッダに依存しない

**運用**
- [ ] `pnpm lint`（0 errors）/ `typecheck` / `test` / `build` green
- [ ] **手動 11 手順（§9）を 3 provider 全てで通した記録がある**
- [ ] `purge-expired` が `oauth_states` を削除する（integration テスト green）

---

## 12. Todo

凡例: ★=仕様書に無い必須追加、⏱=見積工数。

### 12-A プロバイダー接続

| 状態 | ID（実装Todo.md） | 内容 | 依存 | ⏱ |
|---|---|---|---|---|
| [ ] | **P4-A-01**（=P4-A-01） | `types.ts` 新設＋`registry.ts` の型を**再設計**（`exchangeCode`/`fetchIdentity`/`verifyIdToken?` のスロット追加）＋`getProvider()` | ― | 1.0h |
| [ ] | **P4-A-02**（=P4-A-02） | Google: `jose` 導入、`jwtVerify`（RS256 固定・`aud`・`iss` 2 形式・`clockTolerance` 5）、nonce 照合、profile 取得（§7.4.2 のコード） | A-01 | 2.0h |
| [ ] | **P4-A-03**（=P4-A-03） | GitHub: **`Accept: application/json` 必須**、token 交換、`/user` ＋ `/user/emails` で `primary && verified` 採用、無ければ signup 不可（§7.4.3） | A-01 | 1.5h |
| [ ] | **P4-A-04**（=P4-A-04） | Discord: token 交換、`/users/@me` の `verified === true` のみ採用、`email: null` と空文字を区別（§7.4.4） | A-01 | 1.0h |
| [ ] | **P4-A-05**（=P4-A-05） | credential は**既存**（lazy 定義済み）。`.env.example` のポインタは ✅ 済。redirect_uri は env 明示（D-31-01） | ― | 0.3h |
| [ ] | **P4-A-06**（=P4-A-06） | migration `0015_accounts.sql` + `0016_oauth_states.sql`（`intent` / `user_id` を含む）、`schema.ts`、クエリ層、`purge-expired` に `oauth state` ジョブ追加 | ― | 1.8h |
| [ ] | **P4-A-07**（=P4-A-07） | **redact 配線**。`id_token` キー追加、URL クエリパターン確認、`log-redaction` に OAuth 機密値のケース追加 | ― | 1.0h |

### 12-B フロー

| 状態 | ID | 内容 | 依存 | ⏱ |
|---|---|---|---|---|
| [ ] | **P4-B-01**（=P4-B-01） | `state.ts`（発行・**1 回限り消費**・TTL 10 分・SHA-256 検索）＋ `GET /api/auth/oauth/{provider}`（state/nonce/verifier 生成・S256 固定・最小 scope・未登録 404） | A-06 | 2.2h |
| [ ] | **P4-B-02**（=P4-B-02） | redirect_uri の env 完全一致・**Host ヘッダ非依存**（D-31-01） | B-01 | 0.5h |
| [ ] | **P4-B-03**（=P4-B-03） | `GET .../callback` に §7.7 の共通 1〜7 と **login intent の 8a〜8d** を実装 | A-02〜04, B-01 | 3.5h |
| [ ] | **P4-B-04**（=P4-B-04） | レート制限 `oauth-start` / `oauth-callback`（既存キー利用・D-31-13） | B-01 | 0.4h |
| [ ] | **P4-B-05★**（=P4-B-03c/d） | suspended/deleted の 403 ＋ callback 後の**必ず新セッション**（ローテーション）をテストで固定 | B-03 | 0.5h |
| [ ] | **P4-B-06★** | `redirect_to` の正規化（open redirect 対策・§7.6）＋ callback 後の戻り先 | B-03 | 0.5h |

### 12-C 連携

| 状態 | ID | 内容 | 依存 | ⏱ |
|---|---|---|---|---|
| [ ] | **P4-C-01**（=P4-C-01） | **email 一致の自動統合を実装しない**（login=誘導 / link=拒否）。`POST /api/auth/oauth/link`（**再認証必須**・別 state 発行・§7.7 の 9a〜9e） | B-03 | 2.2h |
| [ ] | **P4-C-02**（=P4-C-02） | `DELETE /api/auth/accounts/{id}`（再認証必須・owner 確認・**最後の認証手段なら 409**・通知） | C-01 | 1.5h |
| [ ] | **P4-C-03**（=P4-C-03） | `GET /api/auth/accounts` ＋ `/settings/connected-accounts` 一覧/追加/解除 UI ＋ ナビ/ホーム追加 ＋ security カードの件数反映 | C-02 | 2.2h |
| [ ] | **P4-C-04**（=P4-C-04） | 連携追加/削除の通知メール（`emails.changeNotification` 再利用・認証フローの値は載せない） | C-02 | 0.4h |
| [ ] | **P4-C-05★**（新規 ID） | **§7.8 の回帰テスト**。T1 乗っ取り・T2 email 自動 link・T3 再認証必須・T3' `user_id` 照合・T5 state 使い回しの 5 ケースを独立ファイルに固定（T4 の CSRF・T6 の未検証 email・T7 の最後の認証手段・T8 の link 上限は §8.1 の各ファイルで担保） | C-01 | 1.2h |

### 12-D テスト

| 状態 | ID | 内容 | ⏱ |
|---|---|---|---|
| [ ] | **P4-D-01**（=DoD） | security 6 ファイル（state / pkce / nonce / redirect / replay / account-linking）green | 3.0h |
| [ ] | **P4-D-02★** | security: `oauth-email-verified` / `oauth-not-configured` ＋ 既存 `log-redaction` への追記 | 1.5h |
| [ ] | **P4-D-03★** | integration `accounts.test.ts` ＋ `purge-expired` への state 追加 ＋ e2e `oauth-flow.test.ts` | 1.5h |

### 12-F ドキュメント

| 状態 | ID | 内容 | ⏱ |
|---|---|---|---|
| [ ] | **P4-F-01** | `interop/README.md` を**実測結果で更新**（実際に通った手順・追加で気づいた注意） | 0.4h |
| [ ] | **P4-F-02** | `README.md` / `実装Todo.md` / `実装計画.md` の M4 更新（§9 の手動確認記録を含む） | 0.5h |

**合計: 30.6h（4 日）**

内訳: A（provider 接続）8.6h / B（フロー）7.6h / C（連携）7.5h / D（テスト）6.0h / F（ドキュメント）0.9h。

---

## 13. リスク / ロールバック

| リスク | 影響 | 緩和 |
|---|---|---|
| **link による乗っ取り** | 他人のアカウント乗っ取り | §7.8 の 8 脅威すべてを実装し、T1〜T5 を回帰テストで固定 |
| **redirect_uri の完全一致で詰まる** | 全 provider が 400 | `interop/README.md` に実 authorize URL を貼れる形式にした。origin 統一を最初に決定 |
| GitHub の email が `verified` でない | 新規登録できない（仕様どおり） | 案内で「GitHub のメール設定を確認」と具体的な対処を示す |
| Google の同意画面が未公開 | テストユーザーのみ | テストユーザーに自分を追加して検証 |
| `jose` を dependencies に追加 | 依存が増える | `openid-client` より小さい。検証に必要な機能だけ |
| `code_verifier` を DB に平文 | DB 侵害時の窃取可能性 | TTL 10 分・1 回限りのため code 側も失効済み。`state` は hash 保存。Phase 5 の鍵で暗号化の余地を残す |
| 本番ドメイン確定前に OAuth アプリを登録 | ドメイン変更時に再登録 | Phase 4 はローカル用のみ。本番登録は Phase 9 |
| provider の API 仕様変更 | 突然の 500 | identity 取得は「失敗したら signup しない」側に倒す（fail closed）。例外は握りつぶさずイベントとして記録 |

**ロールバック**

| 対象 | 手順 |
|---|---|
| migration 0015/0016 | `DROP TABLE accounts; DROP TABLE oauth_states;`（外部参照なし） |
| registry エントリ | 3 件を削除すると UI のボタンも消える（registry 駆動のため DB と独立して戻せる） |
| provider 実装 | ファイル単位。UI は registry 依存なので**ボタン消失で安全側**に戻る |

---

## 14. 仕様トレーサビリティ

| 仕様 | 章 | 担当タスク |
|---|---|---|
| Google / GitHub / Discord ログイン | §9 | P4-A-02/03/04, P4-B-01/03 |
| scope 最小 | §9.2 | P4-B-01 |
| accounts の UNIQUE | §10 | P4-A-06 |
| **email 一致の自動統合禁止** | §11 | P4-C-01（login=誘導 / link=拒否） |
| email verified のみ採用 | §11.2 | P4-A-03, P4-A-04 |
| CSRF（callback 例外） | §8.4 | P4-B-03（D-31-14） |
| レート制限 | §16 | P4-B-04 |
| 再認証（link / unlink） | §8 | P4-C-01, P4-C-02 |
| セッションローテーション | §6.2 | P4-B-05 |
| 新規デバイス通知 | §18 | P4-B-03（既存の `notifyNewDeviceLogin` を再利用） |
| 機密値 redaction | §45 / 計画 12.4 | P4-A-07 |
| `security_events` 記録 | §21 | §7.7 の表（D-31-18 で新規 enum を追加しない） |
| IDOR / BOLA | §49 | P4-C-02（owner 確認） |
| UI 文言一元化 | 計画 14 章 | P4-F-02 |

---

## 15. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-17 | 初版（計画のみ・実装未着手）。Phase 3 完了時点のコードを精査して不足を特定。migration 2 本、`jose` 採用（D-31-02、`openid-client` からの逸脱）、GitHub の `Accept: application/json` 要件（D-31-03）、`state` の 1 回限りを PostgreSQL で強制（D-31-05）を確定 |
| **v1.1** | 2026-10-17 | **設計レビューで 10 個の未決論点を解決**（§3）。特に ★★ **link フローの account takeover（§7.8 の 8 脅威）** が v1.0 の設計では防げていなかった点を発見し、`intent`（login/link）の分岐と「既存リンクは奪わない」ルールを追加。`registry` の型に token 交換・identity 取得のスロットが欠けていたため再設計。provider 3 つの**実装可能コード**（jose 検証・GitHub の primary&&verified・Discord の verified）、`state.ts` の 1 回限り消費の実装、5 API の完全な契約、callback 判定の 2 系統化、mock 戦略、**実 provider 手動疎通 11 手順**、パージ統合、監視シグナルを追加。client ID 取得済みも確認（6 キー非空・長さも形式一致）。
▸ **自己レビューで 20 箇所の表記揺れを修正**（§7.1 のファイル数 20 → 25 に合わせて §0・§8.3・§7.1 を整合、§12 の工数を各行の合計 30.6h に再計算、P4-C-05 の ID 重複を解消、文言の混入を排除） |
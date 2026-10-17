# Phase 4 実装計画 — ソーシャルログイン（Google / GitHub / Discord）

> 対象: M4（`実装計画.md` 15章「Phase 4 — OAuth（2〜3日）: Google / GitHub / Discord（Apple 除外 C-01）」）
> 前提工程: Phase 3（M3 達成 2026-10-17）。`lib/auth/oauth/registry.ts` は**型と空エントリまで実装済み**で、Phase 4 はエントリを足すだけで UI まで出る
> 正典: 仕様書 §9（プロバイダー）/ §10（accounts）/ §11（linking）/ §16（レート制限）、計画 12.1〜12.4、Todo §6
> 初版作成日: 2026-10-17 / 状態: **計画のみ・実装は未着手**
> client ID / client secret の**取得手順**は `interop/README.md` に まとめてある（Phase 4-A-05 の実作業の一部）

---

## 0. 要旨（TL;DR）

| 項目 | 内容 |
|---|---|
| 何をやる | Google / GitHub / Discord での**ログイン・新規登録・紐付け・解除**。3  Tujuan とも Authorization Code + PKCE (S256) |
| 何をしない | **refresh token の取得・保存**（D-06）／email 一致での自動統合（§11 禁止）／Apple（C-01 で除外） |
| 工数 | **約 30 時間（3.5〜4 日）**。内訳は §10 |
| 追加依存 | **`jose` のみ**（ID token 検証。`openid-client` は devDeps かつ未使用のため採用しない・D-31-02） |
| migration | **2 本** = `0015_accounts.sql` / `0016_oauth_states.sql` |
| 新規ファイル | 18 ファイル（API 5 / ライブラリ 8 / テスト 5）→ §6.1 |
| テスト | 新規 **10 ファイル・約 70 ケース**（DoD は 6 security ファイルを名指し指定）→ §7 |
| **着手の前提** | **client ID / secret の取得が 4 ステップ必要**（Google コンソール・GitHub・Discord ポータル）。`interop/README.md` の手順が未実施だと認証フローの実測検証ができない |
| 最大リスク | GitHub の `email_verified` が取れない user's 扱い（D-10）と、`redirect_uri` の完全一致（末尾スラッシュ 1 文字で 400） |

---

## 1. 正典と参照関係

| 論点 | 正典 | 本書での扱い |
|---|---|---|
| provider ごとの仕様 | 計画 12.1 のマトリクス | §6.3 に実装可能な粒度で展開（`accept` ヘッダー等の実装上の注意点を追加） |
| コールバック判定 | 計画 12.2 の 9 ステップ | §6.5 にそのまま実装可能な形で展開 |
| 機密値 redaction | 計画 12.4 | §6.6 で Phase 1-C が追加済みのキーを使う |
| ID prefix | `実装Todo.md` D-25 | `accounts` の prefix は **`acc_`**（`util/id.ts` の `ID_PREFIXES` に既存） |
| credential の扱い | `実装Todo.md` P4-A-05 | **明示設定のみ**。実行環境からの自動導出（request host からの redirect 組み立て）は**禁止**（§62） |

---

## 2. 背景と目的

### 2.1 現状（コードで確認済み）

| 領域 | 現状 |
|---|---|
| registry | `src/lib/auth/oauth/registry.ts` に**型と空エントリだけ**存在。`configuredOAuthProviders()` は 0 件を返す |
| UI | `LoginButtons` が registry 駆動。0 件なので**社会ログインボタンは描画されない**（正しい挙動） |
| DB | **`accounts` テーブルが無い**。`oauth_clients`（M2.5 の Provider 側）は別物。`users.password_hash` は NULL 可なので social-only ユーザーは作れる |
| OAuth フロー | `GET /api/auth/oauth/{provider}` / `callback` いずれも**未実装** |
| 状態保持 | `state`/`nonce`/`code_verifier` を保持する場所が無い（`redis` は任意依存、D-05 で PostgreSQL が正本） |
| redact キー | `logger.ts` に `code`/`state`/`nonce`/`codeverifier` は**登録済み**（Phase 1-C P1-C-09a）。ただし**配線とテストが無い** |
| credential | `env.ts` に `GOOGLE_*`/`GITHUB_*`/`DISCORD_*` が**遅延評価（lazy）として既に定義済み** |

### 2.2 目的

| # | 目的 | 完了定義 |
|---|---|---|
| 1 | 3 provider でログイン・新規登録できる | registry にエントリ 3 件を入れて配線 + `/login` にボタン 3 個 |
| 2 | 既存ユーザーと新規ユーザーを安全に区別する | `accounts` 検索で分岐（ヒット=ログイン／email 一致=**停止して誘導**／不一致=新規作成） |
| 3 | 連携の追加・解除ができる | `POST /api/auth/oauth/link`（再認証必須）/ `DELETE /api/auth/accounts/{id}` |
| 4 | OAuth 機密値を漏らさない | `log-redaction` に `code`/`state`/`nonce`/`code_verifier`/`id_token` のケースを追加 |

---

## 3. スコープ

### 3.1 本フェーズで実装する

`実装Todo.md` §6 の **6-A / 6-B / 6-C 全タスク**。加えて:
- `oauth_states` テーブル（`state` の 1 回限り消費）
- `settings/connected-accounts` 画面（一覧/追加/解除）
- `registry.ts` へのエントリ 3 件（`interop/README.md` の手順が前提）

### 3.2 本フェーズで実装しない（理由と引継ぎ先）

| 項目 | 判断 | 引継ぎ先 |
|---|---|---|
| **refresh token** | 要求もしない・保存もしない（D-06）。`accounts` に列を持たせない | 将来 provider が session 継続を要求しても再認可で代替 |
| Apple | C-01 で除外 | 将来（需要が確定してから） |
| email 一致の自動統合 | **§11 で禁止**。導出する確立な安全でないため | なし（永久に禁止） |
| 複数 provider の同時リンク制限 | MVP では**制限しない**（`accounts` は user に何件でも紐づく） | 将来 |
| 既存 provider からの claim 取り込み（profile 更新） | 初回リンク時に `provider_email` を保存するのみ | 将来（プロフィール同期） |
| 運用（ドメイン確定・本番 OAuth アプリ登録） | ローカルの client ID で開発 | Phase 9 |

---

## 4. 前提・着手前チェック

**client ID の取得が済んでいることが最上位の前提**（`interop/README.md`）。未取得なら 6-B の実測検証が一切できない。

- [ ] `interop/README.md` の手順で **3 provider の client ID / client secret を取得済み**
- [ ] `.env` に以下 entered（**実値は commit しない**。`.gitignore` は `.env*` 済み）
  ```
  GOOGLE_CLIENT_ID=...            GOOGLE_CLIENT_SECRET=...
  GITHUB_CLIENT_ID=...            GITHUB_CLIENT_SECRET=...
  DISCORD_CLIENT_ID=...           DISCORD_CLIENT_SECRET=...
  ```
- [ ] 3 provider すべてで、redirect URI に**完全一致**で登録済み
      （`http://localhost:3000/api/auth/oauth/{google|github|discord}/callback`）
- [ ] `NEXT_PUBLIC_APP_URL` が `http://localhost:3000` で、登録した URI の origin と一致
- [ ] `pnpm lint` / `typecheck` / `test` / `build` が green（現状 58 files / 365 tests）
- [ ] `pnpm db:migrate` が適用済み

---

## 5. 決定事項（D-31-01 〜 D-31-14）

| ID | 決定 | 理由 |
|---|---|---|
| **D-31-01** | `redirect_uri` は **`${NEXT_PUBLIC_APP_URL}/api/auth/oauth/{provider}/callback`** を server 側で組み立て、env の `NEXT_PUBLIC_APP_URL` を**明示設定**する。request の Host ヘッダからは導出しない | §62 / P4-A-05。Host ヘッダは攻撃者が制御しうる（Phase 6 の `WEBAUTHN_ORIGIN` で同じ判断をしている） |
| **D-31-02** | **ID token 検証は `jose` を使う**（`dependencies` に追加）。`openid-client` は **devDependencies かつリポジトリ内で未使用**なので採用しない | 必要なのは `jwtVerify` + `createRemoteJWKSet` だけで、`openid-client` はフル-featured OIDC client で過剰。todo の「`openid-client`」からの**意図的な逸脱**であり、理由は上 |
| **D-31-03** | GitHub の token エンドポイントは **`Accept: application/json` を必ず付ける**（token 交換・API 呼び出しの両方） | 付けないと `application/x-www-form-urlencoded` で返り、`res.json()` のパースで失敗する。**ヘッダー 1 行で済むが、付け忘れると毎回落ちる**

| **D-31-04** | Google の `iss` は `accounts.google.com` と `https://accounts.google.com` の**両方**を受理する | Google は ID token の `iss` をどちらの形式でも返しうる（公式ドキュメント上の相違） |
| **D-31-05** | `state` / `nonce` / `code_verifier` は **PostgreSQL の `oauth_states` に保存**（TTL 10 分・1 回限り・消費時に `consumed_at` を更新） | Redis は任意依存（D-05 で PostgreSQL が正本）。匿名 Cookie はクライアント削除で消費済み判定が壊れるため採らない。**1 回限り（replay 防止）を DB で強制する** |
| **D-31-06** | `scope` は計画 12.1 の値をそのまま使う（`openid email profile` / `read:user user:email` / `identify email`）。**`offline_access` を要求しない** | D-06。scope は最小（D-06 / §56） |
| **D-31-07** | registry の `isConfigured(env)` は `client_id` と `client_secret` の**両方**が揃って初めて true。1 つでも欠けたらボタンを隠す | 半分の設定で押して 500 になるのを防ぐ。UI は registry から生成されるため（D-30-21）ここが BCP |
| **D-31-08** | email が取れない / `verified=false` の場合は**新規登録しない**（signup 不可）。`ACCOUNT_LINK_REQUIRED` 相当の案内を出して `/login` へ戻す | D-10（GitHub）・D-11（Discord）。未検証 email でアカウントを作ると乗っ取りの入口になる |
| **D-31-09** | `accounts` の `UNIQUE (provider, provider_account_id)` は**論理削除後も保持**し、物理削除（保持期間経過後のパージ）で制約を解放する | `users` の partial unique index と同じ方針（計画 7.3 / P4-A-06） |
| **D-31-10** | `provider_account_id` は **provider 各异**。Google は `sub`（数字文字列）、GitHub は `id`（数値）、Discord は `id`（数値）。**いずれも文字列に変換して保存**し、`UNIQUE` は `(provider, provider_account_id)` の組で行う | provider をまたいで数値が衝突しても別ユーザーとして扱えるように provider を必ず組に入れる |
| **D-31-11** | social-only ユーザー（`password_hash` が NULL）は `status=active` で作れる。**`email_verified=true` を必ず付ける**（`users_status_email_verified_chk` CHECK 制約のため必須） | CHECK 制約違反を防ぐ。email 検証済みを「provider が検証した」根拠として扱う（§11.2） |
| **D-31-12** | 新規ユーザー作成・連携完了は必ず `recordSecurityEvent('oauth_linked')`。**`metadata` は `provider` と真偽値だけ**を入れ、`code`/`state`/`access_token` は入れない | §21 / 計画 12.4-3 |
| **D-31-13** | レート制限は既存の `rateLimitKeys.oauthStartIp` / `oauthCallbackIp` と `RATE_LIMITS.oauth.start` / `.callback` を使う（**新規キー追加なし**） | 既に定義済み（`config/rate-limits.ts`）。命名も揃っている |
| **D-31-14** | `callback` は `withAuthPipeline` を**通さない**（GET のみ・CSRF 例外経路）。ただし **Origin は検証する**（同一オリジンからの遷移であることを確認） | 計画 12.2 の CSRF 例外規定。`state` + `nonce` で CSRF を担保する |

---

## 6. 全体設計

### 6.1 ファイル一覧

**新規（18）**

| # | パス | 責務 |
|---|---|---|
| 1 | `src/lib/auth/oauth/state.ts` | `state`/`nonce`/`code_verifier` の発行・消費（1 回限り・TTL 10 分） |
| 2 | `src/lib/auth/oauth/google.ts` | authorize URL 生成 / token 交換 / ID token 検証 / profile 取得 |
| 3 | `src/lib/auth/oauth/github.ts` | 同上（`/user/emails` 追加呼び出し・`Accept: application/json`・D-31-03） |
| 4 | `src/lib/auth/oauth/discord.ts` | 同上（`/users/@me` の `verified`） |
| 5 | `src/lib/auth/oauth/accounts.ts` | `accounts` の CRUD・検索・upsert |
| 6 | `src/lib/auth/oauth/complete-login.ts` | 12.2 の判定フロー（ヒット/誘導/新規作成） |
| 7 | `src/lib/validate/oauth.ts` | zod（provider 列挙・callback の `code`/`state`/`error`） |
| 8 | `src/app/api/auth/oauth/[provider]/route.ts` | `GET`（認可開始） |
| 9 | `src/app/api/auth/oauth/[provider]/callback/route.ts` | `GET`（コールバック） |
| 10 | `src/app/api/auth/oauth/link/route.ts` | `POST`（連携・再認証必須） |
| 11 | `src/app/api/auth/accounts/[id]/route.ts` | `DELETE`（解除・再認証必須） |
| 12 | `src/app/settings/connected-accounts/page.tsx` ＋ `connected-accounts.tsx` | 一覧/追加/解除 UI |
| 13 | `src/test/security/oauth-state.test.ts` | state 不一致・期限・消費 |
| 14 | `src/test/security/oauth-pkce.test.ts` | `code_challenge_method=S256` 固定・verifier の secret 性 |
| 15 | `src/test/security/oauth-nonce.test.ts` | nonce 送出・ID token 照合・不一致拒否 |
| 16 | `src/test/security/oauth-redirect.test.ts` | redirect_uri 完全一致・未登録 provider 404 |
| 17 | `src/test/security/oauth-replay.test.ts` | callback 2 回目は `INVALID_STATE` |
| 18 | `src/test/security/account-linking.test.ts` | email 一致自動統合の禁止・最後の手段の解除拒否 |

**変更（12）**

| パス | 変更 |
|---|---|
| `package.json` | `jose` を **dependencies** に追加（D-31-02） |
| `src/lib/auth/oauth/registry.ts` | **エントリ 3 件**（§6.3）+ `verify()` 関数への参照を追加 |
| `src/lib/db/schema.ts` | `accounts` / `oauthStates` テーブル、`SOCIAL_PROVIDERS`、`ACCOUNT_PROVIDERS` を追加 |
| `src/lib/db/schema.ts`（同） | `SECURITY_EVENT_TYPES` は既存（`oauth_linked` / `oauth_unlinked` がある）→ **追加不要** |
| `src/lib/db/queries/users.ts` | social-only ユーザー作成関数（`password_hash: null`, `email_verified: true`） |
| `src/lib/util/logger.ts` | パターンへ `id_token` を追加（キーは既存）。`code`/`state`/`nonce`/`codeverifier` の**配線テスト**を追加 |
| `src/app/settings/settings-nav.tsx` | 「連携アカウント」をナビに追加 |
| `src/app/settings/page.tsx` | 同上（ホーム） |
| `src/components/auth/social-login-buttons.tsx` | registry 驱动のため変更不要（**1 エントリ追加で自動で増える**） |
| `src/components/settings/security-overview.tsx` | 連携カードの「未連携」を実際の件数表示に |
| `src/messages/ja.ts` | OAuth 関連 UI 文言（`ui.oauth.*`） |
| `.env.example` | credential 3 provider のコメント追記（取得手順へのポインタ） |

### 6.2 データモデル

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

- `id` は `acc_` prefix（`util/id.ts` の `ID_PREFIXES` 既存・D-25）。`newId('acc')` を使う
- **refresh token 列を持たない**（D-06）
- 論理削除（`users.deleted_at`）では `ON DELETE CASCADE` が発火しないため `accounts` 行は残る。同 既存の UNIQUE 制約も保持 → 再登録は保持期間中は拒否。**パージ（保持期間経過後）で解放**（D-31-09）

**migration `0016_oauth_states.sql`**（D-31-05）

```sql
CREATE TABLE "oauth_states" (
  "state_hash"    text PRIMARY KEY,          -- SHA-256(state)。生 state は保存しない
  "provider"      text NOT NULL,
  "nonce"         text NOT NULL,
  "code_verifier" text NOT NULL,             -- secret。DB に平文で持つのは避けたいが
  "redirect_to"   text,                      --  login 後に戻るパス（同一オリジンのみ受理）
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "expires_at"    timestamptz NOT NULL,
  "consumed_at"   timestamptz
);
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" ("expires_at");
```

> `code_verifier` を平文で持つ点について: 本来は暗号化が望ましいが、TTL 10 分・1 回限りの使い捨てであり、DB 侵害時に code 側と組わせても何もできない（code も 10 分で失効する）。**それでも state は hash で保存**し、code_verifier は secret として扱う。Phase 5 の `TOTP_ENCRYPTION_KEY` で暗号化する余地は残す。

**パージ**: `expires_at < now()` の行は既存の期限切れ削除ジョブ（`scripts/`、`purge-expired`）に含める。

### 6.3 provider 仕様と registry 実装

| | Google | GitHub | Discord |
|---|---|---|---|
| 方式 | OIDC | OAuth2 | OAuth2 |
| authorize | `https://accounts.google.com/o/oauth2/v2/auth` | `https://github.com/login/oauth/authorize` | `https://discord.com/oauth2/authorize` |
| token | `https://oauth2.googleapis.com/token` | `https://github.com/login/oauth/access_token` | `https://discord.com/api/oauth2/token` |
| userinfo | ID token claims | `GET https://api.github.com/user` ＋ `GET /user/emails` | `GET https://discord.com/api/users/@me` |
| scope | `openid email profile` | `read:user user:email` | `identify email` |
| 必須ヘッダー | — | **`Accept: application/json`（token・API 両方）** | `Authorization: Bearer <access_token>` |
| ID token 検証 | `jose` の `jwtVerify` + `createRemoteJWKSet`。`iss`/`aud`/`exp`/`nonce`/**`alg=RS256` 固定**（D-31-04） | — | — |
| `provider_account_id` | `sub` | `id` | `id` |
| email 採用 | ID token の `email` ＋ `email_verified=true` | `/user/emails` の **`primary && verified`**（無ければ signup 不可・D-10） | `/users/@me` の `verified === true`（D-11） |
| `nonce` | **必須** | 不要 | 不要 |

**registry へのエントリ（実装時に埋める）**

```ts
// src/lib/auth/oauth/registry.ts
export const OAUTH_PROVIDER_REGISTRY: readonly OAuthProviderEntry[] = [
  {
    id: 'google',
    label: 'Google',
    isConfigured: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile',
    protocol: 'oidc',
  },
  // github / discord も同形（scope・endpoint のみ異なる）
] as const;
```

- `verifyIdentity` などの関数への参照は**関数gift の中心で-import せず**、`getProvider(id)` で遅延解決する（3 provider すべてを常に読み込まない）
- **UI は変更不要**: `LoginButtons` が registry から自動生成する（D-30-21 / D-31-07）

### 6.4 API 契約

| Method | Path | 概要 | 追加要件 |
|---|---|---|---|
| `GET` | `/api/auth/oauth/{provider}` | 認可開始。`state`/`nonce`/`code_verifier` を発行し 303 で provider の authorize URL へ | 未登録 provider は **404 `INVALID_PROVIDER`**。レート制限 `oauth.start` |
| `GET` | `/api/auth/oauth/{provider}/callback` | 12.2 の判定フロー | レート制限 `oauth.callback`。**`withAuthPipeline` を通さない**（D-31-14） |
| `POST` | `/api/auth/oauth/link` | 連携（email 一致で止まった用户的救済経路） | **再認証必須**。`state` は**新しい state を使い回す**（使い回しは不可） |
| `DELETE` | `/api/auth/accounts/{id}` | 連携解除 | **再認証必須**。**最後の認証手段なら 409 で拒否**（P4-C-02）。通知メール |
| `GET` | `/api/auth/accounts` | 自分の連携一覧 | 認証。`no-store` |

**`GET /api/auth/oauth/{provider}` の応答**

```
303 Location: https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=<GOOGLE_CLIENT_ID>
  &redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fauth%2Foauth%2Fgoogle%2Fcallback
  &response_type=code
  &scope=openid+email+profile
  &state=<base64url(32B)>
  &nonce=<base64url(32B)>
  &code_challenge=<S256(verifier)>
  &code_challenge_method=S256          ← 固定（§62）
  &access_type=online                   ← refresh token を求めない（D-06）
Cache-Control: no-store
```

**`GET .../callback` の分岐**（計画 12.2 の実装形）

| 状況 | 応答 |
|---|---|
| provider 未登録 | `404 INVALID_PROVIDER` |
| `error=access_denied` | `303 /login?error=cancelled`（情報漏洩なし） |
| `state` 不一致 / 期限切れ / 消費済み | `400 INVALID_STATE` ＋ `login_failed` イベント |
| token 交換失敗 / ID token 検証失敗 | `401 INVALID_CREDENTIALS` ＋ `login_failed` |
| email 検証不合格 | `303 /login?error=account_not_linkable`（新規登録しない・D-31-08） |
| `accounts` ヒット | その user で**新セッション**発行（ローテーション）→ `303 /` |
| email 一致する別 user が存在 | **停止**。`303 /login?error=link_required`（自動統合しない） |
| 未登録 | 新規作成（`password_hash=NULL`, `email_verified=true`, `status=active`）→ `303 /` |
| `status` が suspended/deleted | `403 ACCOUNT_SUSPENDED` |

### 6.5 コールバック判定フロー（12.2 の実装手順）

```ts
// 1. provider 解決
const entry = getProvider(providerParam);           // 見つからなければ 404
if (!entry.isConfigured(process.env)) return fail(INVALID_PROVIDER, 404);

// 2. ユーザーキャンセルは情報漏洩 없이 login へ
if (search.error === 'access_denied') return redirect('/login?error=cancelled');

// 3. state の検証と【消費】 ← ここが replay 対策の要
const consumed = await consumeOAuthState(search.state, entry.id);
//    - SHA-256(state) で引く
//    - provider 一致 / expires_at > now / consumed_at IS NULL を満たす行だけを UPDATE する
//    - 返り値が 1 行更新でなければ INVALID_STATE（= 2 回目は必ず失敗する）

// 4. token 交換（code_verifier を本文に含める）
const token = await entry.exchangeCode({ code, codeVerifier, redirectUri });

// 5. OIDC: ID token 検証（Google のみ）
const claims = await verifyGoogleIdToken(token.idToken, {
  expectedNonce: consumed.nonce,
  clientId: env.GOOGLE_CLIENT_ID,
});

// 6. email 取得と検証（provider ごとの規則）
const identity = await entry.fetchIdentity(token.accessToken, claims);
//    → { providerAccountId, email, emailVerified }
//    → emailVerified が false なら D-31-08 で signup しない

// 7. accounts 検索と分岐
const link = await findAccountByProvider(entry.id, identity.providerAccountId);
if (link) {
  user = await findUserById(link.userId);           // 8. status チェック
  if (user.status !== 'active') return fail(ACCOUNT_SUSPENDED, 403);
  //    ローテーション: 既存セッションを revoke して必ず作り直す
} else if (await findUserByLowerEmail(identity.email)) {
  return redirect('/login?error=link_required');     // ★自動統合しない（§11）
} else {
  user = await createSocialOnlyUser({ ...identity });
  await linkAccount(user.id, entry.id, identity);   // → oauth_linked イベント
}

// 9. セッション発行（新規デバイスなら通知）
const { token: sessionToken, session } = await createSession(user.id, request);
await setSessionCookie(sessionToken);
return redirect('/');
```

**CSRF 例外経路について（D-31-14）**

- `callback` は provider からの redirect なので GET となり、`X-CSRF-Token` は付かない。CSRF は `state`（OIDC は加えて `nonce`）で担保する（計画 12.2 の例外規定）
- ただし **Origin ヘッダが同一オリジンであること**は検証する（ブラウザからの遷移であることの確認。`ALLOWED_ORIGINS` と照合）
- この経路**以外**は §8.4 のパイプラインから逸脱しない

### 6.6 セキュリティ設計

| リスク | 対策 |
|---|---|
| **open redirect**（`redirect_to` の悪用） | `state` に stored する `redirect_to` は**同一オリジンの相対パスのみ**受理。絶対 URL・`//host`・`\` 始まりは `null` に落とす |
| **認可コード再利用（replay）** | `state` を**消費時に UPDATE**（`consumed_at`）。2 回目の callback は必ず 1 行更新できない → `INVALID_STATE` |
| **state 不整合（CSRF / リクエスト差し替え）** | `state` を SHA-256 で引き、**`provider` も照合**。別 provider の state を流用できない |
| **PKCE downgrade** | `code_challenge_method=S256` を**固定**。plain を許さない |
| **ID token の alg |Alg=none 攻撃** | `jose` に `algorithms: ['RS256']` を明示。`jose` は既定で `none` を拒否するが**明示する**（D-31-04） |
| **ID token リプレイ** | `nonce` を state に保存し、ID token の `nonce` claim と照合。一致しなければ拒否 |
| **email の一致による自動統合（§11）** | **実装しない**。一致したら必ず `link_required` で止める。テストで固定 |
| **未検証 email での自動登録** | provider の verified フラグを必須（D-31-08） |
| **client_secret の漏えい** | server 専用（`LAZY_ENV`）。`NEXT_PUBLIC_*` にしない。registry の `isConfigured` にも渡さない |
| **ログへの機密値** | `code`/`state`/`nonce`/`code_verifier`/`id_token` を `logger` に渡さない。URL 全体をログに載せない（クエリに `code` が含まれるため） |
| **`security_events.metadata`** | `provider` / `error` / `state_present` のような真偽値・文脈**のみ**（D-31-12） |
| **最後の認証手段の解除** | `password_hash === null` かつ `accounts` が 0 件なら 409 で拒否（P4-C-02） |
| **_provider 未設定で押される** | `isConfigured` が false なら 404（`INVALID_PROVIDER`）。UI にもボタン不出（D-31-07） |

---

## 7. テスト計画

| 種別 | ファイル | 主要ケース（DoD の 6 ファイルはすべて含む） |
|---|---|---|
| security | **`oauth-state.test.ts`** | state 不一致で 400 / 期限切れ（10 分超）で 400 / **消費後の 2 回目は 400** / provider 交差での拒否 / 不明な state は 400 |
| security | **`oauth-pkce.test.ts`** | authorize URL に `code_challenge` と **`code_challenge_method=S256`** が付く / `plain` が付かない / `code_verifier` が callback で送られる / verifier が 32〜128 文字の base64url |
| security | **`oauth-nonce.test.ts`** | authorize URL に `nonce` が付く / ID token の nonce が state と一致 / **不一致なら拒否** / nonce 欠落なら拒否 |
| security | **`oauth-redirect.test.ts`** | redirect_uri が env 組み立てと完全一致（**末尾スラッシュ差も不一致**）/ 未登録 provider は 404 / **Host ヘッダ偽装で redirect_uri が変わらない**（D-31-01） |
| security | **`oauth-replay.test.ts`** | authorize→callback を 2 回，后者 1 回目 code → 2 回目は `INVALID_STATE` / 別 session の state の使い回し |
| security | **`account-linking.test.ts`** | **email 一致で自動統合しない**（`link_required`）/ link は再認証必須 / 最後の認証手段の解除は 409 / 他人の `accounts/{id}` は 404 / 解除時に通知メール |
| security | `oauth-redirect-uri-host.test.ts` | Host ヘッダ注入で open redirect が起きない |
| security | `oauth-email-verified.test.ts` | GitHub の `verified=false` で signup しない / Discord の `verified=false` で signup しない / primary でない email は採用しない |
| security | （既存 `log-redaction.test.ts` へ追記） | `code=` `state=` `nonce=` `code_verifier=` `id_token=` が `***` になる / URL 全体を渡しても redacted |
| integration | `accounts.test.ts` | UNIQUE(provider, provider_account_id) 违反 / 別 provider なら同 id で共存可 / `last_used_at` 更新 |
| e2e | `oauth-flow.test.ts` | 実 HTTP で authorize URL まで → callback まで（provider をスタブ化）。**実 provider に対する e2e は credential 取得後に手動 or CI secret** |

**総数目標**: 既存 58 files / 365 tests ＋ **新規 10 ファイル・約 70 ケース** = 68 files / 435 cases。

---

## 8. 実装順序

```text
Step 1（基盤・外部依存なし）
  P4-A-01 registry エントリ 3 件（isConfigured のみ先に埋める）
  P4-A-06 migration 0015 accounts + 0016 oauth_states + schema
  P4-A-07 redact 配線のテスト追加（先に守りを固める）

Step 2（状態管理）
  P4-B-01a oauth_states の発行・消費（1 回限り）
  P4-B-01b GET /api/auth/oauth/{provider}

Step 3（provider 実装）
  P4-A-02 Google（jose）→ P4-A-03 GitHub → P4-A-04 Discord
  ★ 3 つ目ごとに手動で 1 回ずつ実フローを通す（interop/README.md の手順）

Step 4（コールバック）
  P4-B-03 callback 全体（12.2 の 9 ステップ）
  P4-B-04 レート制限
  P4-D テスト 6 ファイル

Step 5（連携）
  P4-C-01〜04 link / unlink / 通知 / UI
  P4-F ドキュメント

Step 6: pnpm lint / typecheck / test / build / 実フローの通し確認
```

**各 Step の完了条件**

| Step | 条件 |
|---|---|
| 1 | migration 適用済み、redact テスト green |
| 2 | 認可開始で 303 が返り、`oauth_states` に 1 行できる |
| 3 | 各 provider で **authorize URL に正しい scope/redirect_uri が付く**（実際の到達までは不要） |
| 4 | callback の各分岐が security テストで green。**手動で 1 回通る**（`interop/README.md`） |
| 5 | 紐付け・解除が実ブラウザで成立 |
| 6 | 5 コマンド green |

---

## 9. DoD

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
- [ ] email 一致での自動統合が**しない**（§11）
- [ ] 未検証 email で自動登録が**されない**（D-10/D-11）
- [ ] `code`/`state`/`nonce`/`code_verifier`/`id_token` がログ・API 応答・`security_events.metadata` に**平文で現れない**
- [ ] redirect_uri が Host ヘッダに依存しない（D-31-01）

**運用**
- [ ] `pnpm lint`（0 errors）/ `typecheck` / `test` / `build` green
- [ ] `interop/README.md` の手順で 3 provider の実フローを 1 回ずつ通した記録がある

---

## 10. Todo

凡例: ★=仕様書に無い必須追加、⏱=見積工数。

### 10-A プロバイダー接続

| 状態 | ID（実装Todo.md） | 内容 | 依存 | ⏱ |
|---|---|---|---|---|
| [ ] | **P4-A-01**（=P4-A-01） | `registry.ts` にエントリ 3 件（`isConfigured` / endpoint / scope / protocol）。**`verifyIdentity` の遅延解決口を用意** | ― | 0.5h |
| [ ] | **P4-A-02**（=P4-A-02） | Google: `jose` 導入、`jwtVerify` + `createRemoteJWKSet`、`iss`(2 形式)/`aud`/`exp`/`nonce`/`alg=RS256` 検証、profile 取得 | A-01 | 2.0h |
| [ ] | **P4-A-03**（=P4-A-03） | GitHub: `Accept: application/json` 必須（D-31-03）、`/user/emails` で `primary && verified` を採用、無ければ signup 不可（D-10） | A-01 | 1.5h |
| [ ] | **P4-A-04**（=P4-A-04） | Discord: `/users/@me` の `verified === true` のみ採用（D-11） | A-01 | 1.0h |
| [ ] | **P4-A-05**（=P4-A-05） | `env.ts` の credential は**既存**（lazy 定義済み）。`.env.example` に取得手順へのポインタを追記。**redirect_uri は env 明示**（D-31-01） | ― | 0.5h |
| [ ] | **P4-A-06**（=P4-A-06） | migration `0015_accounts.sql` + `0016_oauth_states.sql`、`schema.ts`、クエリ層 | ― | 1.5h |
| [ ] | **P4-A-07**（=P4-A-07） | **redact 配線**。`id_token` キーを追加、URL クエリパターン確認、`log-redaction` に OAuth 機密値のケースを追加 | ― | 1.0h |

### 10-B フロー

| 状態 | ID | 内容 | 依存 | ⏱ |
|---|---|---|---|---|
| [ ] | **P4-B-01**（=P4-B-01） | `state.ts`（発行・消費・1 回限り・TTL 10 分）+ `GET /api/auth/oauth/{provider}`（state/nonce/verifier 生成・S256 固定・最小 scope・未登録 404） | A-06 | 2.0h |
| [ ] | **P4-B-02**（=P4-B-02） | redirect_uri の env 完全一致・**Host ヘッダ非依存**（D-31-01） | B-01 | 0.5h |
| [ ] | **P4-B-03**（=P4-B-03） | `GET .../callback` に計画 12.2 の 9 ステップを**全実装**（state 消費 / token 交換 / ID token 検証 / email 検証 / 分岐 / suspended 403 / **セッションローテーション** / 新規デバイス通知） | A-02〜04, B-01 | 3.5h |
| [ ] | **P4-B-04**（=P4-B-04） | レート制限 `oauth-start` / `oauth-callback`（既存キー利用・D-31-13） | B-01 | 0.5h |
| [ ] | **P4-B-05★**（=P4-B-03c/d） | suspended/deleted の 403 ＋ callback 後の**必ず新セッション**（ローテーション）を明示的にテストで固定 | B-03 | 0.5h |

### 10-C 連携

| 状態 | ID | 内容 | 依存 | ⏱ |
|---|---|---|---|---|
| [ ] | **P4-C-01**（=P4-C-01） | **email 一致の自動統合を実装しない**（一致 → `link_required` で停止）。`POST /api/auth/oauth/link`（**再認証必須**、state の使い回しは禁止） | B-03 | 2.0h |
| [ ] | **P4-C-02**（=P4-C-02） | `DELETE /api/auth/accounts/{id}`（再認証必須・owner 確認・**最後の認証手段なら 409**・通知） | C-01 | 1.5h |
| [ ] | **P4-C-03**（=P4-C-03） | `GET /api/auth/accounts` ＋ `/settings/connected-accounts` 一覧/追加/解除 UI ＋ ナビ/ホームに追加 | C-02 | 2.0h |
| [ ] | **P4-C-04**（=P4-C-04） | 連携追加/削除の通知メール（`emails.changeNotification` 再利用・認証フローの値は載せない） | C-02 | 0.5h |

### 10-D テスト

| 状態 | ID | 内容 | ⏱ |
|---|---|---|---|
| [ ] | **P4-D-01**（=DoD） | security 6 ファイル（state / pkce / nonce / redirect / replay / account-linking）green | 3.0h |
| [ ] | **P4-D-02★** | security: `oauth-email-verified` / `oauth-redirect-uri-host` ＋ 既存 `log-redaction` への追記 | 1.5h |
| [ ] | **P4-D-03★** | integration `accounts.test.ts` ＋ e2e `oauth-flow.test.ts`（provider をスタブ化した実 HTTP） | 1.5h |

### 10-F ドキュメント

| 状态 | ID | 内容 | ⏱ |
|---|---|---|---|
| [ ] | **P4-F-01** | `interop/README.md`（client ID 取得手順・詰まりどころ）を**実測で更新** | 0.5h |
| [ ] | **P4-F-02** | `README.md` / `実装Todo.md` / `実装計画.md` の M4 更新 | 0.5h |

**合計: 約 30.0h（3.5〜4 日）**

---

## 11. リスク / ロールバック

| リスク | 影響 | 緩和 |
|---|---|---|
| **redirect_uri の完全一致で詰まる**（末尾スラッシュ、`localhost` vs `127.0.0.1`、ポート） | 全 provider が 400 | `interop/README.md` に**実際の authorize URL をそのまま貼れる**形式にする。`NEXT_PUBLIC_APP_URL` と登録 URI の origin を一致させる |
| **GitHub の email が `verified` でない**（非公開メール設定の user） | 新規登録できない（仕様どおり） | 案内文で「GitHub のメール設定を確認してください」と**具体的な対処**を示す |
| Google の同意画面が未公開 | テスト用户的みログイン可能 | 検証時は自分の Google アカウントを追加してから使う |
| GitHub の client secret は**生成時に一度しか見えない** | 取り損なうと再生成 | `interop/README.md` に強調 |
| `jose` を dependencies に追加すると依存が増える | — | `openid-client`（フル-featured）より小さい。**検証に必要な機能だけ**に絞れる |
| `code_verifier` を DB に平文で持つ | DB 侵害時に窃取可能性 | TTL 10 分・1 回限りのため code 側も失効済み。**state は hash 保存**。暗号化は Phase 5 の鍵を使えるので余地を残す |
| 本番ドメイン確定前に OAuth アプリを登録してしまう | ドメイン変更時に再登録が必要 | Phase 4 は**ローカル用**の client ID のみを取得する。本番登録は **Phase 9** |

**ロールバック**

| 対象 | 手順 |
|---|---|
| migration 0015/0016 | `DROP TABLE accounts; DROP TABLE oauth_states;`（外部参照なし） |
| registry エントリ | 3 件を削除すると UI のボタンも消える（registry 駆動のため DB と独立して戻せる） |
| provider 実装 | ファイル単位。UI は registry 依存なので**ボタン消失で安全側**に戻る |

---

## 12. 仕様トレーサビリティ

| 仕様 | 章 | 担当タスク |
|---|---|---|
| Google / GitHub / Discord ログイン | §9 | P4-A-02/03/04, P4-B-01/03 |
| provider ごとの scope 最小 | §9.2 | P4-B-01（`RATE_LIMITS` ではなく scope） |
| accounts の UNIQUE | §10 | P4-A-06 |
| **email 一致の自動統合禁止** | §11 | P4-C-01 |
| email verified のみ採用 | §11.2 | P4-A-03, P4-A-04 |
| CSRF（callback 例外） | §8.4 | P4-B-03（D-31-14） |
| レート制限 | §16 | P4-B-04 |
| 再認証（link / unlink） | §8 | P4-C-01, P4-C-02 |
| セッションローテーション | §6.2 | P4-B-05 |
| 新規デバイス通知 | §18 | P4-B-03（既存 `notifyNewDeviceLogin` を再利用） |
| 機密値 redaction | §45 / 計画 12.4 | P4-A-07 |
| `security_events` 記録 | §21 | P4-B-03, P4-C-02 |
| UI 文言一元化 | 計画 14 章 | P4-F-02 |

---

## 13. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-17 | 初版（計画のみ・実装未着手）。Phase 3 完了時点のコード（registry の型・空エントリ、`env.ts` の lazy credential、`logger.ts` の redact キー、Phase 1-C で说一句の `openid-client` が devDeps かつ未使用）を精査して不足を特定。`accounts` / `oauth_states` 2 本の migration、`jose` 採用（D-31-02、`openid-client` からの逸脱）、GitHub の `Accept: application/json` 要件（D-31-03）、`state` の 1 回限りを PostgreSQL で強制する設計（D-31-05）を確定。DoD 名指し 6 ファイルを用意 |
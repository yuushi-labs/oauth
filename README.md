# oauth — 超本格アカウント・認証システム

メールアドレス認証 / パスワード認証 / 自作サービス向けOAuth 2.0・OIDC Provider（実装中）/ ソーシャルログイン（Google・GitHub・Discord、Phase 4）/ Passkey / TOTP 2FA / セッション管理 / デバイス管理 / セキュリティログ / テーマ設定を統合する認証システムです。

「ユーザーが操作できる便利さ」と「認証情報が漏洩・盗難された場合の被害を最小化すること」の両立を目標に、**失敗時・攻撃時・復旧時まで含めて**設計しています。

## 参照ドキュメント

| ドキュメント | 内容 |
|---|---|
| `超本格アカウント・認証システム仕様書 v1.2.md` | 仕様書の正規典（全69章） |
| `実装計画.md` v1.6 | フェーズ分解・DoD・決定事項（C-xx / D-xx） |
| `実装Todo.md` | タスク一覧（進捗は同ファイルのチェックボックスで管理） |
| `docs/phase0-設計.md` | Phase 0 の設計ドキュメント（実装前に作成） |
| `docs/phase2.5-実装計画.md` | 自作サービス向けOAuth 2.0 / OIDC Providerの詳細計画と実装状況 |
| `docs/phase2.5-gate-a.md` | Gate A（統合Spike・adapter評価・統合判断） |
| `docs/phase2.5-threat-model.md` | OIDC Providerの脅威モデル |
| `docs/phase2.5-review.md` | セキュリティレビュー・依存監査・相互運用レポート |
| `.env.example` | 環境変数の定義 |

## 技術スタック

| レイヤ | 採用 |
|---|---|
| ランタイム | Node.js 22 LTS |
| フレームワーク | Next.js 15（App Router / Server Actions 併用） |
| 言語 | TypeScript 5.x（`strict` + `noUncheckedIndexedAccess`） |
| バリデーション | Zod |
| DB | PostgreSQL 16 |
| ORM | Drizzle ORM + drizzle-kit |
| UI | Tailwind CSS v4（CSS変数 + `data-theme`） |
| テスト | Vitest（unit / integration / security）、Playwright（e2e） |
| レート制限ストア | PostgreSQL（Phase 2の正本。Redisは予約方式の同等性を実装するまで未使用） |
| OAuth/OIDC Provider | `oidc-provider` 9.x（Node HTTP custom server、PostgreSQL adapter） |
| セッション | 自前（サーバーサイドセッション。HttpOnly Cookie + PostgreSQL。**Resend は担当しない**） |
| メール | Resend（送信のみ） |
| パッケージマネージャ | pnpm |

> **Resend = メール送信のみ**。認証セッションは「HttpOnly Cookie（`__Host-auth_session`）＋ PostgreSQL の `sessions` テーブル ＋ HMAC ハッシュ」という**アプリケーション側のサーバーサイドセッション管理**で実装する。Resend はセッション管理サービスではない（`実装計画.md` 5章 / 7.4 / 8.3）。

## 前提条件

- Node.js 22 以上
- pnpm 11 以上
- Docker / Docker Compose（ローカル PostgreSQL の実行）
- GitHub CLI（`gh`）— リポジトリ操作時のみ

## セットアップ

```bash
# 1. 依存関係
pnpm install

# 2. 環境変数（.env を生成。値は標準出力に出しません）
pnpm secrets:gen

# 3. データベース起動
docker compose up -d

# 4. マイグレーション適用と roles の投入
pnpm db:migrate
pnpm seed

# 5. 開発サーバー
pnpm dev            # http://localhost:3000
```

## 自作サービスからOIDCログイン

M2.5のProviderは`OIDC_ISSUER`が設定されているときだけ有効になります。開発時は次の手順で署名鍵・暗号鍵を生成し、`.env`へ設定してからマイグレーションを適用します。

```bash
pnpm oidc:keygen                 # 表示された値を安全に保管し、OIDC_*へ設定
pnpm db:migrate
pnpm oidc:client add --name "My Service" --operator "My Service株式会社" --type confidential --redirect-uri "https://service.example/callback" --scope openid,profile,email
pnpm dev
```

`OIDC_ISSUER`は`NEXT_PUBLIC_APP_URL`と同じ固定originにします。登録後はclient IDとDiscovery URL (`/.well-known/openid-configuration`) をRPへ設定し、Authorization Code + PKCE `S256`で接続します。confidential secretは生成時に一度だけ表示し、RPのサーバー側secret storeへ保存してください。ブラウザpublic clientには`--type public --web-origin https://service.example`を指定します。CORSは登録したoriginだけ許可します。`--operator`（運営者名、必須）は同意画面と接続済みサービスの一覧に表示されます。client secret は平文ではなく HMAC ダイジェストのみ保存され、生成時に一度だけ表示されます。許可 scope や redirect URI の変更は `pnpm oidc:client update --client-id <id> [--scope ...] [--add-redirect-uri ...]` で行います（scope を広げても既存の同意は変わらないため、新 scope は再同意時にのみ付与されます）。

Providerは`pnpm dev` / `pnpm start`のcustom Node server経由で動作します。TLSをreverse proxyで終端する本番環境では、proxyがHostと`X-Forwarded-Proto`を上書きし、信頼proxy hopを環境変数へ明示してください。署名鍵をrotationするときは新しいprivate JWKと旧public JWKを同時に`OIDC_JWKS_JSON`へ渡し、旧鍵は発行済みID Tokenの有効期限を過ぎるまで残します。`OIDC_ADAPTER_ENCRYPTION_KEY`を変更すると暗号化されたclient secretとProvider stateを復号できなくなるため、データ移行と同時に行ってください。`oidc-provider` v9 は logger 注入に非対応（`debug` のみ）のため、本番では `DEBUG` が `oidc-provider` 名前空間を有効にしていると起動時に失敗します。アカウント停止・削除時はadapter がaccess token/grantの解決を拒否し、interactionでは遮断イベントを記録します。

docker へ権限が無い環境では、执行用户在 `docker` グループへ追加してください（`sudo usermod -aG docker $USER` → 再ログイン）。現在のシェルだけで済ませる場合は `sg docker -c "docker compose up -d"` のように実行できます。

## コマンド

| コマンド | 内容 | 状態 |
|---|---|---|
| `pnpm dev` | 開発サーバー | 実装済 |
| `pnpm build` / `pnpm start` | 本番ビルド / 起動 | 実装済 |
| `pnpm lint` | ESLint（`eslint-config-next` + `eslint-plugin-security`） | 実装済 |
| `pnpm typecheck` | `tsc --noEmit` | 実装済 |
| `pnpm test` / `pnpm test:unit` | Vitest（unit） | 実装済 |
| `pnpm test:security` | セキュリティテスト | **実装済・green** |
| `pnpm test:integration` | PostgreSQL統合テスト | **実装済・green** |
| `pnpm test:e2e` | OIDC の実HTTP E2E（`vitest run src/test/e2e`） | **実装済・green** |
| `pnpm db:migrate` | マイグレーション適用 | 実装済 |
| `pnpm db:studio` | Drizzle Studio | 実装済 |
| `pnpm seed` | `roles` の投入（idempotent） | 実装済 |
| `pnpm secrets:gen` | 開発用シークレット生成（`.env` へ） | 実装済 |
| `pnpm oidc:keygen` | OIDC署名鍵とadapter暗号鍵を生成（値を一度だけ表示） | 実装済 |
| `pnpm oidc:client add ...` | 事前登録clientを追加（confidential secretは一度だけ表示） | 実装済 |
| `pnpm oidc:client update --client-id <id> ...` | client の名称・運営者・許可scope・redirect URI・CORS origin を変更 | 実装済 |
| `pnpm oidc:client rotate-secret ...` / `revoke ...` | confidential secretのrotation / client失効 | 実装済 |

## ディレクトリ構成

```text
oauth/
├─ compose.yaml              # ローカル PostgreSQL 16
├─ drizzle/                  # マイグレーション SQL（generated）
│  ├─ 0000_01_roles.sql
│  ├─ 0001_02_users.sql
│  ├─ 0002_04_sessions.sql
│  ├─ 0003_05_tokens.sql
│  ├─ 0004_08_security_events.sql
│  ├─ 0005_10_rate_limit.sql
│  └─ 0006_phase2_security.sql
├─ drizzle.config.ts
├─ docs/phase0-設計.md       # フェーズごとの設計ドキュメント
├─ messages/                 # UI文言・メール文面（Phase 1-B で追加）
│  └─ ja.ts
├─ scripts/
│  ├─ generate-secrets.ts    # pnpm secrets:gen
│  └─ seed.ts                # pnpm seed
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx          # テーマ初期適用（FOUC 防止）
│  │  ├─ page.tsx            # ログイン後トップ（未ログインは/loginへ）
│  │  ├─ login/page.tsx      # ログイン
│  │  ├─ register/page.tsx   # 登録
│  │  ├─ globals.css         # CSS変数 light/dark
│  │  └─ api/
│  │     └─ auth/
│  │        ├─ csrf/route.ts
│  │        ├─ register/route.ts
│  │        ├─ login/route.ts
│  │        ├─ logout/route.ts
│  │        ├─ me/route.ts
│  │        ├─ verify-email/route.ts
│  │        ├─ resend-verification/route.ts
│  │        ├─ password/{forgot,reset,change,set}/route.ts
│  │        ├─ reauth/route.ts
│  │        ├─ email/change/route.ts
│  │        ├─ email/change/confirm/route.ts
│  │        └─ account/route.ts
│  ├─ lib/
│  │  ├─ env.ts              # zod による起動時検証（fail fast）
│  │  ├─ errors.ts           # §58 応答形式 + error code Enum
│  │  ├─ db/{schema,client}.ts
│  │  │  └─ queries/{users,sessions,tokens,security-events}.ts
│  │  ├─ util/{id,time,crypto,ip,logger}.ts
│  │  ├─ validate/{email,username,password}.ts
│  │  ├─ auth/
│  │  │  ├─ password.ts      # Argon2id パスワードハッシュ
│  │  │  ├─ strength.ts       # NG ワードリスト
│  │  │  ├─ breached.ts       # HIBP 漏洩パスワード検査（fail-open）
│  │  │  ├─ session.ts        # セッション生成・取得・無効化
│  │  │  ├─ cookie.ts         # __Host-auth_session / __Host-auth_anon
│  │  │  ├─ csrf.ts           # CSRF 共通パイプライン
│  │  │  ├─ rate-limit.ts     # PostgreSQL正本のレート制限・予約方式
│  │  │  ├─ security-events.ts # security_events 記録
│  │  │  ├─ reauth.ts         # 再認証（5分犹予）
│  │  │  ├─ tokens/           # トークン生成・ハッシュ・検証
│  │  │  └─ email/            # メール送信（Resend）
│  │  └─ api/utils.ts         # 共通パイプライン・エラー処理
│  ├─ config/rate-limits.ts   # レート制限設定
│  ├─ emails/                 # React Email テンプレート（6種）
│  └─ test/unit/             # 純関数の単体テスト
├─ next.config.ts / postcss.config.mjs / eslint.config.mjs / vitest.config.mts
└─ .env.example / .env（local のみ・commit 禁止）
```

## 環境変数

| 変数 | 必須 | 用途 | 導入フェーズ |
|---|---|---|---|
| `DATABASE_URL` | 必須 | PostgreSQL 接続先 | Phase 0 |
| `SESSION_PEPPER` | 必須（32文字以上） | セッション token の HMAC 鍵 | Phase 0（定義）/ Phase 1-C（使用） |
| `TOKEN_PEPPER` | 必須（32文字以上） | メールトークンの hash salt | Phase 0（定義）/ Phase 1-B |
| `IP_HASH_PEPPER` | 必須（32文字以上） | IP の HMAC 鍵 | Phase 0（定義）/ Phase 1-C |
| `CSRF_SECRET` | 必須（32文字以上） | CSRF token の HMAC 鍵 | Phase 0（定義）/ Phase 1-C |
| `TOTP_ENCRYPTION_KEY` | 必須（Base64 32B） | TOTP 秘密鍵の AES-256-GCM 暗号化 | Phase 0（定義）/ Phase 5 |
| `NEXT_PUBLIC_APP_NAME` | 任意（既定 `oauth`） | 画面タイトル、ヘッダー、メールに表示するアプリ名 | Phase 2 |
| `NEXT_PUBLIC_APP_URL` | 必須（URL） | アプリ基準 URL | Phase 0 |
| `OIDC_ISSUER` | OIDC有効化時必須 | 固定issuer origin。`NEXT_PUBLIC_APP_URL`と同一origin | Phase 2.5 |
| `OIDC_JWKS_JSON` | OIDC有効化時必須 | RS256 private JWK 1個 + rotation期間中に保持する旧public JWK | Phase 2.5 |
| `OIDC_ADAPTER_ENCRYPTION_KEY` | OIDC有効化時必須（Base64 32B） | client secretとOIDC code/token/interactionをAES-256-GCM暗号化し、ID検索にHMAC | Phase 2.5 |
| `RATE_LIMIT_SECRET` | 任意（32文字以上。未設定時は `TOKEN_PEPPER`） | レート制限キーのHMAC | Phase 2 |
| `ALLOWED_ORIGINS` | 任意 | CORS許可Origin（既定はアプリOrigin） | Phase 2 |
| `CSRF_TRUSTED_ORIGINS` | 任意 | 状態変更要求の信頼Origin（既定はアプリOrigin） | Phase 2 |
| `ALLOWED_HOSTS` | 任意 | HTTPS redirectで許可するHost | Phase 2 |
| `TRUSTED_PROXY_HOPS` | 任意（既定 `0`） | 信頼するproxy hop数。0では転送ヘッダーを信頼しない | Phase 2 / Phase 9で環境設定 |
| `TRUSTED_PROXY_HEADER` | 任意 | 信頼proxyが設定するクライアントIP header | Phase 2 / Phase 9で環境設定 |
| `REDIS_URL` | 任意 | Redis接続先（Phase 2の認証レート制限では未使用） | 将来拡張 |
| `HIBP_TIMEOUT_MS` | 任意（既定 1500） | 漏洩パスワード検査のタイムアウト | Phase 1-A |
| `BREACH_CHECK_FAIL_OPEN` | 任意（既定 true） | HIBP 障害時に登録を許可するか | Phase 1-A |
| `RESEND_API_KEY` / `EMAIL_FROM` | 遅延評価 | メール送信 | Phase 1-B |
| `GOOGLE_*` / `GITHUB_*` / `DISCORD_*` | 遅延評価 | OAuth 資格情報（Apple は除外: C-01） | Phase 4 |
| `TURNSTILE_SECRET_KEY` | 遅延評価 | CAPTCHA。Phase 2では未設定時500、secret設定済みでprovider未接続なら503 | Phase 2 / Phase 9（実接続） |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ORIGIN` | 遅延評価 | Passkey の rpID / rpName / origin。**環境ごとに別値を明示設定**（host からの自動導出はしない） | Phase 6 |
| `NODE_ENV` | 任意（既定 `development`） | 実行モード | Phase 0 |
| `POSTGRES_USER` / `POSTGRES_DB` / `POSTGRES_PASSWORD` | ローカル専用 | `compose.yaml` が参照（アプリ側では参照しない） | Phase 0 |

「必須」は `src/lib/env.ts` が**起動時に検証し、欠落・長さ不足があれば fail fast**します。「遅延評価」は参照した時点で未設定なら throw します（Phase 0 ではまだ参照しません）。

## セキュリティ上の注意

- **`.env` / `*.pem` は commit しない**（`.gitignore` 済み、実値ではなく `pnpm secrets:gen` で生成）。本番の secret は Secret Manager 等から注入する（仕様52章）
- 認証ロジックは自前実装し、暗号・プロトコル層のみ標準ライブラリへ委譲する（自作暗号・自作 Argon2・自作 OAuth state・自作 WebAuthn 検証は禁止／仕様67章）
- 認可は**サーバー側でのみ**判定する。フロントの表示制御はセキュリティ境界にしない（仕様49章）
- 状態変更は POST/PUT/PATCH/DELETE で行い、GET では状態を変更しない（仕様25章）
- すべての mutating endpoint は共通の検証パイプラインを通す（Origin → CSRF → 認証 → 再認証 → 認可 → 入力検証）。Route Handler と Server Action の**双方**で同じ検証を行う（Phase 1-C）
- パスワード・token・secret をログ・API 応答・`security_events.metadata` に出さない（`src/lib/util/logger.ts` が redaction）
- 確定済みの変更点: **Apple 除外**（C-01）、**パスワード 8〜128文字**（C-02）

### ログの redaction 要件（Phase 0 実装済み と Phase 4 実装待ちの区別）

**redaction 対象として必ず扱う値**:

| 区分 | 値 |
|---|---|
| メール/セッション系（Phase 0 で実装済み） | `password` / `password_hash` / `token` / `session_token` / `csrf_token` / `authorization` / `secret` / `totp_secret` / `recovery_code` / `access_token` / `refresh_token`、および URL 中の `token=` / `code_verifier=` / `password=` / `secret=` |
| **OAuth 機密値（Phase 1-C でキー追加 → Phase 4-A で配線。現時点では未実装）** | `code` / `state` / `nonce` / `code_verifier` / `id_token` / `client_secret` ＋ OAuth 資格情報のその他の secret |

- 上記の OAuth 機密値（特に **`code` / `state` / `nonce` / `code_verifier`**）は、**アプリ内ログ・エラーメッセージ・監査ログ（`admin_audit_logs`）・`security_events.metadata`・例外オブジェクトの出力**のいずれにも**平文で記録しない**（`実装計画.md` 12.4 / 17.2.1）
- 「短命だから記録してよい」は理由にならない。認可コード `code` は `code_verifier` と組ませれば token 交換を完了でき、`state` はログイン CSRF、`nonce` は ID token リプレイに直結する
- `security_events.metadata` には `provider` / `error` / `state_present: true` のような**真偽値・文脈のみ**を記録し、機密値の生値は入れない
- **現状（Phase 0）**: `src/lib/util/logger.ts` は上の「メール/セッション系」のみを redact している。OAuth フローは未実装のため `code` / `state` / `nonce` / `code_verifier` の redact キー自体が無い。**Phase 1-C でキー追加、Phase 4-A で OAuth フローへ配線する**（キー追加的任务は `実装Todo.md` P1-C-09a / P4-A-05）

## 実装状況

| MS | フェーズ | 内容 | 状態 |
|---|---|---|---|
| M0 | Phase 0 | プロジェクト土台 | **完了** |
| M1 | Phase 1 | メール/パスワード認証（登録・ログイン・確認・リセット・セッション・CSRF・レート制限） | **完了** |
| M2 | Phase 2 | Webセキュリティ・CSRF・レート制限・期限切れデータ削除 | **完了（2026-10-12）** |
| M2.5 | Phase 2.5 | 自作サービス向けOAuth 2.0 / OIDC Provider、scope・同意管理・client registry | **実装中** |
| M3 | Phase 3 | UI / テーマ / 通知メール / デバイス管理 | 未着手 |
| M4 | Phase 4 | OAuth（Google・GitHub・Discord）と紐付け | 未着手 |
| M5 | Phase 5 | TOTP 2FA + Recovery Codes | 未着手 |
| M6 | Phase 6 | Passkey / WebAuthn | 未着手 |
| M7 | Phase 7 | 管理者 / RBAC / 監査ログ | 未着手 |
| M8 | Phase 8-9 | リスク検知 / セキュリティテスト完成 / 運用デプロイ | 未着手 |

進捗の正本は `実装Todo.md` のチェックボックスです。

---

## Phase 0 実装詳細（2026-10-04）

### 何を作ったか

| 領域 | 内容 |
|---|---|
| プロジェクト設定 | `package.json`（scripts 一式）、`tsconfig.json`（strict + `noUncheckedIndexedAccess`）、`next.config.ts`、`postcss.config.mjs`、`eslint.config.mjs`（flat config + `eslint-plugin-security`）、`.prettierrc`、`.gitignore`、`pnpm-workspace.yaml`（`allowBuilds` で esbuild を許可） |
| DB | `compose.yaml`（postgres:16-alpine、`127.0.0.1:5432` のみ公開、healthcheck、名前付き volume）、`drizzle.config.ts`、`src/lib/db/schema.ts`、`src/lib/db/client.ts`、`scripts/seed.ts` |
| マイグレーション | `drizzle/0000_01_roles.sql`、`drizzle/0001_02_users.sql`（生成済み・適用済み） |
| 共通ライブラリ | `src/lib/env.ts`、`src/lib/errors.ts`、`src/lib/util/{id,time,crypto,ip,logger}.ts`、`src/lib/validate/{email,username,password}.ts` |
| UI 土台 | `src/app/layout.tsx`（テーマの同期インライン script）、`src/app/page.tsx`、`src/app/globals.css`（light/dark の CSS変数 + `@theme inline`） |
| テスト | `src/test/unit/*.test.ts` 9ファイル / 76 テスト |
| ドキュメント | `docs/phase0-設計.md`（実装前に作成）、本 README |

### DB 設計（要ログイン）

`users` は**部分唯一インデックスだけで** username / email の一意性を担保します。通常の UNIQUE 制約は付けません。

```sql
CREATE UNIQUE INDEX users_username_lower_uniq
  ON public.users USING btree (lower(username)) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX users_email_lower_uniq
  ON public.users USING btree (lower(email))    WHERE (deleted_at IS NULL);
```

- 理由: 通常の UNIQUE を付けると論理削除済み行が同値行を含み、**論理削除済み email / username の再利用**（仕様24章と3.1章）を妨げる。索引を `deleted_at IS NULL` で部分的にすることで、現役同士は大文字小文字を区別せず一意、論理削除済みは再利用可能になる
- 最終判定は DB の一意違反（SQLSTATE 23505）に委譲する。アプリ層の事前 `SELECT` は参考用途で、检查と登録の間の TOCTOU は作らない（仕様27章）
- 付随する CHECK 制約: `users_status_chk`（status は 4値のみ）、`users_status_email_verified_chk`（`active` にするには `email_verified = true` が必要）
- `users.role_id` は `roles.id` への外部キー。既定 `role_user` はアプリ層で指定し、`pnpm seed` で 4役割（user / moderator / admin / superadmin）を投入する。`role_permissions` は将来拡張のため MVP では作らない

### 動作確認済み（DoD の証跡）

```text
pnpm lint       → 0 errors（warning 9 件: 型付き Record 参照に対する detect-object-injection 等）
pnpm typecheck  → green
pnpm test       → 9 files / 76 tests passed
pnpm db:migrate → migrations applied successfully
pnpm seed       → seeded roles: role_user, role_moderator, role_admin, role_superadmin
pnpm dev        → http://localhost:3000 が 200
pnpm build      → ✓ Generating static pages
```

DB 実測:

```text
-- pg_indexes（users）
users_pkey                 UNIQUE (id)
users_username_lower_uniq  UNIQUE btree (lower(username)) WHERE (deleted_at IS NULL)
users_email_lower_uniq     UNIQUE btree (lower(email))    WHERE (deleted_at IS NULL)
users_role_id_idx / users_deleted_at_idx

-- pg_constraint で contype='u'（users） → 0 rows（通常 UNIQUE が無いことの証跡）
-- pg_constraint で contype='c'（users） → users_status_chk / users_status_email_verified_chk
```

挙動確認（トランザクション内で実行し Rollback）:

- `Yuushi` と `yuushi` の同時登録 → `duplicate key value violates unique constraint "users_username_lower_uniq"`
- 論理削除（`deleted_at` を設定）した後の同 email / 同 username の再登録 → 成功
- `status='active'` かつ `email_verified=false` → `violates check constraint "users_status_email_verified_chk"`
- 未知の `status` → `violates check constraint "users_status_chk"`

### セキュリティ関連の実装

| 項目 | 実装 |
|---|---|
| ID 生成 | `usr_` / `ses_` / `acc_` / `evt_` + ULID（26文字）。不正 prefix は throw |
| 乱数 / hash | Node 標準 `crypto` のみ（`randomBytes`、`sha256`、`sha1`、`hmac`、`timingSafeEqual`）。自作暗号は無い |
| IP | 表示用マスク `203.0.113.xxx`（IPv6 は前半のみ）／保存用は pepper 付き HMAC |
| ログ | 秘密情報のキーを `***` に置換し、URL 中の `token=` / `code_verifier=` / `password=` / `secret=` も redact |
| パスワード検証 | Phase 0 は**形式のみ**（8〜128文字・空白のみ拒否）。NG ワード・漏洩パスワード検査・Argon2id は Phase 1-A |
| メール | ログに本文・URL を出さない（redaction に `token=` を含む） |
| テーマ | `data-theme` を同期インライン script で描画前に適用（FOUC 防止。既定は `system`） |

### 既知の制約・注意点

- Turnstile実provider接続とproxy環境ごとの信頼設定はPhase 9で行う。Phase 2では本番で未設定/未接続を拒否し、`TRUSTED_PROXY_HOPS=0`を既定値とする。
- `lint` はwarning 21件（既存箇所を含む）で、errorは0件。warningはビルドを止めない
- Docker 権限が無い環境では `sg docker -c "docker compose ..."` のようにグループを明示する必要がある
- `docker compose` の DB は `127.0.0.1:5432` にのみバインドしている。外部公開しないこと

### 次のステップ（Phase 3）

1. UI基盤、テーマ切替、通知、デバイス管理

---

## Phase 1 実装詳細（2026-10-10）

### 何を作ったか

| 領域 | 内容 |
|---|---|
| パスワード基盤 | `src/lib/auth/password.ts`（Argon2id `m=19456,t=2,p=1`）、`strength.ts`（8〜128文字・Unicode/スペース許可・空白のみ拒否）、`breached.ts`（HIBP k-anonymity・fail-open） |
| メールトークン | `tokens/{generate,hash,verify}.ts`（256bit・SHA-256 hash・TTL・1回限り・`purpose` 流用防止）、`email/{send,templates}.ts` + Resend 6種テンプレ |
| セッション | `cookie.ts`（`__Host-auth_session` / `__Host-auth_anon` HttpOnly/Secure/SameSite=Lax）、`session.ts`（create/get/**rotate**/touch/revoke/revokeAll・HMAC-SHA256）、マイグレーション（`absolute_expires_at` 90日・`replaced_by`・`revoke_reason`・`ip_hash`/`ip_masked`・`device_name`・`reauth_verified_at`・`totp_pending`） |
| CSRF | 共通パイプライン（Origin→CSRF→認証→再認証→認可→入力検証）、**Route Handler と Server Action の双方から同一検証関数**、OAuth コールバックのみ `state`+`nonce` で例外 |
| レート制限 | PostgreSQL正本（`rate_limit_hits`）、`config/rate-limits.ts` に全13キー、HMAC識別子、ログイン失敗枠予約、CAPTCHA hook |
| セキュリティイベント | 16種 Enum、全認証フローで記録、`logger.ts` に OAuth 機密値（`code`/`state`/`nonce`/`code_verifier` 等）の redact キー追加 |
| エンドポイント | register / login / logout / me / verify-email / resend / forgot / reset / change / set / reauth / email/change / email/change/confirm / account（DELETE） |
| テスト | **セキュリティテスト 9ファイル・40テスト全 green**、単体テスト 13+8、Argon2idベンチマーク 61.79ms / 19MB |

### 監査指摘項目の対応状況

| 指摘 | 対応 | ファイル |
|---|---|---|
| `rotateSession()` に `replaced_by` 未設定 | トランザクション内で設定 | `src/lib/auth/session.ts` |
| email変更確認で `emailVerified: true` 未設定 / 旧メール通知なし | `emailVerified=true`・`oldEmailNotifiedAt` 設定・旧メール通知実装 | `src/app/api/auth/email/change/confirm/route.ts` |
| アカウント削除でトークン失効なし | `invalidateAllUserTokens()` 実装（Phase 1 token テーブル対応） | `src/app/api/auth/account/route.ts` |
| CSRF が Server Action 経路で未検証 | 共通パイプライン抽出・双方アダプタ実装 | `src/lib/auth/pipeline.ts`、`src/lib/auth/csrf.ts`、`src/lib/api/utils.ts` |
| レート制限の保存先 | PostgreSQLを正本とし、失敗試行予約をserializable transactionで管理 | `src/lib/auth/rate-limit.ts` |
| 列挙攻撃対策（username/email） | 23505 違反を統一メッセージに変換 | `src/app/api/auth/register/route.ts` |

### マイグレーション履歴の修復

drizzle-kit 0.31.11 の migration table 名変更（`public._drizzle_migrations` → `drizzle.__drizzle_migrations`）により履歴が分断されていた問題を修正：

- `drizzle/meta/_journal.json` に全6件のマイグレーションを記録（01_roles〜05_10_rate_limit）
- `drizzle.__drizzle_migrations` に正しい SHA-256 ハッシュとタイムスタンプで 6 レコードを挿入
- `pnpm db:migrate` が fresh DB と既存 DB の両方で正常動作することを確認

### 動作確認済み（DoD の証跡）

```text
pnpm lint            → 0 errors
pnpm typecheck       → green
pnpm test            → 13 files / 124 tests passed（unit + security + integration）
pnpm test:security   → 9 files / 40 tests passed
pnpm test:integration → 6 files / 38 tests passed
pnpm db:migrate      → migrations applied successfully（fresh / existing 両方）
pnpm build           → ✓ Generating static pages
```

### Phase 2 の実装と確認

- セキュリティヘッダー、CSP nonce、HTTPS/Host検証、CORS/CSRF信頼境界、13キーのPostgreSQLレート制限を実装。
- CAPTCHA hookと期限切れデータ削除を実装し、CAPTCHA単体テストとTEMPテーブルを使うPostgreSQL統合テストを確認。
- `実装Todo.md` のP2-01〜P2-11とPhase 2 DoDを完了。設計・検証記録は [`docs/phase2-設計.md`](docs/phase2-設計.md) を参照。

---

## 改訂履歴

| 版 | 日付 | 変更 |
|---|---|---|
| v1.0 | 2026-10-04 | 初版作成。Phase 0（プロジェクト土台）を実装。設計ドキュメント `docs/phase0-設計.md` を先に作成してから実装 |
| v1.1 | 2026-10-04 | 他ドキュメントとの整合修正（**実装変更なし**）。参照する仕様書を v1.1 へ・実装計画を v1.3 へ更新、検証リンクの `src/test/**` 統一、C-02 を「8〜128文字」に明記、`TURNSTILE_SECRET_KEY` の導入フェーズと `NODE_ENV` / `POSTGRES_*` を環境変数表へ追記 |
| v1.2 | 2026-10-04 | セキュリティ運用要件の明記（**実装変更なし**）。<br>①「ログの redaction 要件」節を新設。OAuth 機密値（`code` / `state` / `nonce` / `code_verifier` / `access_token` / `refresh_token` / `id_token` / `client_secret`）を redact 対象として列挙し、**ログ・エラーメッセージ・監査ログ・`security_events.metadata`・例外オブジェクト出力に平文で記録しない**旨を明記。**Phase 0 で実装済みの範囲**（メール/セッション系のみ。OAuth キーは未実装＝Phase 1-C キー追加 / Phase 4-A 配線）と分離<br>②技術スタックに「セッション＝自前（Resend は担当しない）」「メール＝Resend（送信のみ）」を分離明記<br>③`WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ORIGIN` を環境変数表へ追加（環境ごとに明示設定・host 自動導出なし） |

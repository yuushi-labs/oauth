# oauth — 超本格アカウント・認証システム

メールアドレス認証 / パスワード認証 / ソーシャルログイン（Google・GitHub・Discord）/ Passkey / TOTP 2FA / セッション管理 / デバイス管理 / セキュリティログ / テーマ設定を統合した認証システムです。

「ユーザーが操作できる便利さ」と「認証情報が漏洩・盗難された場合の被害を最小化すること」の両立を目標に、**失敗時・攻撃時・復旧時まで含めて**設計しています。

## 参照ドキュメント

| ドキュメント | 内容 |
|---|---|
| `超本格アカウント・認証システム仕様書 v1.0.md` | 仕様書の正規典（全68章） |
| `実装計画.md` | フェーズ分解・DoD・決定事項（C-xx / D-xx） |
| `実装Todo.md` | タスク一覧（進捗は同ファイルのチェックボックスで管理） |
| `docs/phase0-設計.md` | Phase 0 の設計ドキュメント（実装前に作成） |
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
| レート制限キャッシュ | Redis（未設定時は PostgreSQL へフォールバック） |
| メール | Resend |
| パッケージマネージャ | pnpm |

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

docker へ権限が無い環境では、执行用户在 `docker` グループへ追加してください（`sudo usermod -aG docker $USER` → 再ログイン）。現在のシェルだけで済ませる場合は `sg docker -c "docker compose up -d"` のように実行できます。

## コマンド

| コマンド | 内容 | 状態 |
|---|---|---|
| `pnpm dev` | 開発サーバー | 実装済 |
| `pnpm build` / `pnpm start` | 本番ビルド / 起動 | 実装済 |
| `pnpm lint` | ESLint（`eslint-config-next` + `eslint-plugin-security`） | 実装済 |
| `pnpm typecheck` | `tsc --noEmit` | 実装済 |
| `pnpm test` / `pnpm test:unit` | Vitest | 実装済（unit のみ） |
| `pnpm db:generate --name=<NN_name>` | マイグレーション生成 | 実装済 |
| `pnpm db:migrate` | マイグレーション適用 | 実装済 |
| `pnpm db:studio` | Drizzle Studio | 実装済 |
| `pnpm seed` | `roles` の投入（idempotent） | 実装済 |
| `pnpm secrets:gen` | 開発用シークレット生成（`.env` へ） | 実装済 |
| `pnpm test:integration` / `test:security` / `test:e2e` | 各テスト | Phase 1 以降で追加 |

## ディレクトリ構成

```text
oauth/
├─ compose.yaml              # ローカル PostgreSQL 16
├─ drizzle/                  # マイグレーション SQL（generated）
├─ drizzle.config.ts
├─ docs/phase0-設計.md       # フェーズごとの設計ドキュメント
├─ messages/                 # UI文言・メール文面（Phase 1-B で追加）
├─ scripts/
│  ├─ generate-secrets.ts    # pnpm secrets:gen
│  └─ seed.ts                # pnpm seed
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx          # テーマ初期適用（FOUC 防止）
│  │  ├─ page.tsx            # 土台確認用（Phase 1 でログイン導線へ）
│  │  └─ globals.css         # CSS変数 light/dark
│  ├─ lib/
│  │  ├─ env.ts              # zod による起動時検証（fail fast）
│  │  ├─ errors.ts           # §58 応答形式 + error code Enum
│  │  ├─ db/{schema,client}.ts
│  │  ├─ util/{id,time,crypto,ip,logger}.ts
│  │  └─ validate/{email,username,password}.ts
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
| `NEXT_PUBLIC_APP_URL` | 必須（URL） | アプリ基準 URL | Phase 0 |
| `REDIS_URL` | 任意 | レート制限用 Redis。未設定なら PostgreSQL へフォールバック | Phase 1-C |
| `HIBP_TIMEOUT_MS` | 任意（既定 1500） | 漏洩パスワード検査のタイムアウト | Phase 1-A |
| `BREACH_CHECK_FAIL_OPEN` | 任意（既定 true） | HIBP 障害時に登録を許可するか | Phase 1-A |
| `RESEND_API_KEY` / `EMAIL_FROM` | 遅延評価 | メール送信 | Phase 1-B |
| `GOOGLE_*` / `GITHUB_*` / `DISCORD_*` | 遅延評価 | OAuth 資格情報（Apple は除外: C-01） | Phase 4 |
| `TURNSTILE_SECRET_KEY` | 遅延評価 | CAPTCHA | Phase 9 |

「必須」は `src/lib/env.ts` が**起動時に検証し、欠落・長さ不足があれば fail fast**します。「遅延評価」は参照した時点で未設定なら throw します（Phase 0 ではまだ参照しません）。

## セキュリティ上の注意

- **`.env` / `*.pem` は commit しない**（`.gitignore` 済み、実値ではなく `pnpm secrets:gen` で生成）。本番の secret は Secret Manager 等から注入する（仕様52章）
- 認証ロジックは自前実装し、暗号・プロトコル層のみ標準ライブラリへ委譲する（自作暗号・自作 Argon2・自作 OAuth state・自作 WebAuthn 検証は禁止／仕様67章）
- 認可は**サーバー側でのみ**判定する。フロントの表示制御はセキュリティ境界にしない（仕様49章）
- 状態変更は POST/PUT/PATCH/DELETE で行い、GET では状態を変更しない（仕様25章）
- すべての mutating endpoint は共通の検証パイプラインを通す（Origin → CSRF → 認証 → 再認証 → 認可 → 入力検証）。Route Handler と Server Action の**双方**で同じ検証を行う（Phase 1-C）
- パスワード・token・secret をログ・API 応答・`security_events.metadata` に出さない（`src/lib/util/logger.ts` が redaction）
- 確定済みの変更点: **Apple 除外**（C-01）、**パスワード最低8文字**（C-02）

## 実装状況

| MS | フェーズ | 内容 | 状態 |
|---|---|---|---|
| M0 | Phase 0 | プロジェクト土台 | **完了** |
| M1 | Phase 1 | メール/パスワード認証（登録・ログイン・確認・リセット・セッション・CSRF・レート制限） | 未着手 |
| M2 | Phase 2 | セキュリティヘッダー・CORS・HTTPS 強制 | 未着手 |
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

- **セキュリティヘッダー / CSP nonce は未実装**（Phase 2）。現状 `layout.tsx` のテーマ script は静的文字列だが、CSP 導入時に nonce を header と紐付ける必要がある
- `lint` の warning 9 件は、型安全な `Record` 参照などに対する静的解析の指摘。エラーではない
- Docker 権限が無い環境では `sg docker -c "docker compose ..."` のようにグループを明示する必要がある
- `docker compose` の DB は `127.0.0.1:5432` にのみバインドしている。外部公開しないこと

### 次のステップ（Phase 1）

1. Argon2id（`@node-rs/argon2`、`m=19456,t=2,p=1` 起步で負荷テスト）、`strength.ts`、HIBP k-anonymity（timeout は fail-open）
2. メールトークン（256bit・hash 保存・1回限り）と Resend 連携
3. セッション Cookie（`__Host-auth_session` / `__Host-auth_anon`）、CSRF 共通パイプライン、レート制限（Redis + PostgreSQL フォールバック）、`security_events`
4. エンドポイント: register / login / logout / me / verify-email / resend / forgot / reset / change / set / reauth
5. テスト: `uniq` / `session-fixation` / `token-reuse` / `enumeration` / `rate-limit` / `csrf` / `session-attr`

## 改訂履歴

| 版 | 日付 | 変更 |
|---|---|---|
| v1.0 | 2026-10-04 | 初版作成。Phase 0（プロジェクト土台）を実装。設計ドキュメント `docs/phase0-設計.md` を先に作成してから実装 |
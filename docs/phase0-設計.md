# Phase 0 設計ドキュメント（プロジェクト土台） v1.2

> 本ドキュメントは**実装より先に**作成したものです。対象工程は `実装計画.md` v1.4 の 15章「Phase 0 — プロジェクト土台」および `実装Todo.md` の P0-01〜P0-11 に対応します。
> 作成日: 2026-10-04 / 状態: 実装済み

---

## 1. 目的と範囲

### 1.1 目的

認証システム（仕様書 全68章）の土台を作り、**後続の全フェーズが迷わず拡張できる状態**にする。具体的には以下を満たす。

- ローカルで `pnpm install` から `pnpm dev` まで一連で通る
- 環境変数の検証（fail fast）、型チェック、単体テストがすべて green になる
- DB スキーマの初期形（roles / users）がマイグレーションで実際に適用され、**一意性制約の方針が SQL として正しいことが証明**されている
- セキュリティ要件を弱める変更が将来フェーズへ持ち越されないよう、基盤の段階で固定しておく

### 1.2 今回やらないこと（対象外）

| 項目 | 担当フェーズ |
|---|---|
| 登録 / ログイン / メール確認 / パスワードリセット等のエンドポイント | Phase 1 |
| Argon2id / password strength / HIBP 漏洩パスワード検査 | Phase 1-A |
| セッション Cookie / CSRF / レート制限 | Phase 1-C |
| セキュリティヘッダー / CORS / CSP | Phase 2 |
| shadcn/ui / テーマ切替 UI / 通知メール | Phase 1・3 |
| OAuth（Google/GitHub/Discord） | Phase 4 |
| TOTP / Passkey / 管理者機能 | Phase 5・6・7 |
| CI / gitleaks / 監視 / バックアップ | Phase 9 |

### 1.3 DoD（Phase 0 完了条件）

```
pnpm lint && pnpm typecheck && pnpm test && pnpm db:migrate && pnpm dev  が全て green
```

さらに以下を確認済みであること：

- migration 02（users）に partial unique index が含まれる
- `users` の `username` / `email` に**通常の UNIQUE 制約が存在しない**

---

## 2. 前提・制約

### 2.1 技術スタック（確定）

| レイヤ | 採用 |
|---|---|
| ランタイム | Node.js 22 LTS（実測 v22.23.1） |
| パッケージマネージャ | pnpm（実測 11.13.1） |
| フレームワーク | Next.js 15（App Router） |
| 言語 | TypeScript 5.x `strict` ＋ `noUncheckedIndexedAccess` |
| バリデーション | Zod |
| DB | PostgreSQL 16 |
| ORM | Drizzle ORM + drizzle-kit |
| UI | Tailwind CSS v4 |
| テスト | Vitest（unit のみ。integration/security/e2e は各フェーズで追加） |
| レート制限キャッシュ | Redis（本フェーズでは未導入。Phase 1-C で追加、不在時は PG フォールバック＝D-05） |

### 2.2 ロック済み決定事項（本フェーズで変更してはいけない）

| ID | 決定 | 本フェーズでの具体化 |
|---|---|---|
| C-01 | Apple を除外 | Phase 0 では provider 関連を一切作らない |
| C-02 | パスワード最低長 **8文字** | `validate/password.ts` の zod スキーマで固定（上限 128文字、ASCII 限定しない、スペース許可） |
| D-04 | username/email は **case-insensitive 一意**。partial unique index のみで担保 | §4 の SQL |
| D-05 | Redis 不在時は PG フォールバック | Phase 0 では Redis を使わない。`REDIS_URL` は任意扱い |
| D-13 | IP は生値を保持・**表示のみマスク** | `util/ip.ts` は `maskIp()` を提供（保存は Phase 1-C） |
| D-15 | テーマ既定値は `system` | `globals.css` と FOUC 防止 script で既定を `system` にする |
| 仕様62/67 | 自作暗号・自作 Argon2 などは禁止 | `util/crypto.ts` は Node 標準 `crypto` のみを使用 |

---

## 3. 作成ファイル一覧

### 3.1 ルート設定

| パス | 責務 | ポイント |
|---|---|---|
| `package.json` | 依存とスクリプト | name `oauth` / private。`packageManager` で pnpm を固定 |
| `tsconfig.json` | TS 設定 | `strict` + `noUncheckedIndexedAccess`、paths `@/*` → `src/*` |
| `next.config.ts` | Next 設定 | **最小のみ**。セキュリティヘッダーは Phase 2（P2-01）で追加するため今は入れない |
| `postcss.config.mjs` | PostCSS | Tailwind v4 は `@tailwindcss/postcss` を使う |
| `eslint.config.mjs` | Lint | flat config（`.eslintrc` は作らない）。`eslint-config-next` + `eslint-plugin-security`（§62 違反の機械的検出） |
| `.prettierrc` | 整形 | 2スペース、semi true、singleQuote true、printWidth 100 |
| `.gitignore` | 除外 | `.env*`（ただし `!.env.example`）、`*.pem`、`node_modules/`、`.next/`、`coverage/`、`*.tsbuildinfo` |
| `.env.example` | 変数定義 | 計画17.1 に準拠。**実値は入れない** |
| `compose.yaml` | ローカル DB | `postgres:16-alpine`、`localhost:5432`、healthcheck 付き |
| `drizzle.config.ts` | migration | `dialect: postgresql`、`schema: src/lib/db/schema.ts`、`out: drizzle` |
| `vitest.config.mts` | テスト | `include: src/test/**/*.test.ts`、`environment: node`、`@` alias |
| `README.md` | ドキュメント | Phase 0 実装後に作成 |

### 3.2 `src/`

| パス | 責務 |
|---|---|
| `src/app/layout.tsx` | `<html lang="ja">`、`<head>` にテーマ初期適用の同期インライン script、`globals.css` を import |
| `src/app/page.tsx` | 土台確認用の最小ページ（Phase 1 でログイン導線へ置換） |
| `src/app/globals.css` | CSS変数 + `[data-theme="dark"]` + Tailwind v4 の `@theme inline` |
| `src/lib/env.ts` | 環境変数の zod 検証（必須／任意／遅延評価の3区分） |
| `src/lib/errors.ts` | §58 の API 応答形式と error code Enum |
| `src/lib/db/schema.ts` | `roles` / `users` の定義 |
| `src/lib/db/client.ts` | `pg` Pool の単一インスタンス |
| `src/lib/util/id.ts` | prefix + ULID の ID 生成 |
| `src/lib/util/time.ts` | UTC 前提の時刻ヘルパ |
| `src/lib/util/crypto.ts` | 乱数・hash・HMAC・定数時間比較・pepper 生成 |
| `src/lib/util/ip.ts` | IP マスクと pepper 付き hash |
| `src/lib/util/logger.ts` | 構造化ログ + 秘密情報の redaction |
| `src/lib/validate/{email,username,password}.ts` | zod スキーマ（**形式のみ**。NGワード/HIBP は Phase 1-A） |
| `src/lib/validate/index.ts` | スキーマの再エクスポート |
| `src/test/unit/*.test.ts` | 純関数の単体テスト |
| `scripts/generate-secrets.ts` | 開発用シークレットの生成（`pnpm secrets:gen`） |
| `scripts/seed.ts` | `roles` の4行を idempotent に upsert |

### 3.3 依存（Phase 0 で導入）

- **dependencies**: `next@^15`, `react@^19`, `react-dom@^19`, `drizzle-orm`, `pg`, `zod@^3.25`, `ulid`, `dotenv`
- **devDependencies**: `typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `@types/pg`, `tailwindcss@^4`, `@tailwindcss/postcss`, `drizzle-kit`, `vitest`, `tsx`, `eslint@^9`, `eslint-config-next`, `eslint-plugin-security`, `prettier`

**今回入れないもの**（各フェーズで追加する）: `@node-rs/argon2`（1-A）、`resend`（1-B）、`ua-parser-js`（3-C）、`openid-client`（4-A）、`otpauth`/`qrcode`（5-A）、`@simplewebauthn/server`（6-A）、`@playwright/test`（8-B）、Redis クライアント（1-C）、`@react-email/components`（1-B）。

- `zod` は **v3 に固定**する。v4 では `z.string().email()` が非推奨になり書き方が変わるため、計画の想定 API を安定させる。

---

## 4. DB 設計

### 4.1 今回作るテーブル（2つのみ）

```text
roles
├─ id          text PK           -- 'role_user' 等の固定 slug
├─ name        text NOT NULL     -- UNIQUE
├─ description text
└─ created_at  timestamptz NOT NULL default now()

users
├─ id                  text PK                          -- 'usr_' + ULID(26)
├─ username            text NOT NULL
├─ email               text NOT NULL
├─ email_verified      boolean NOT NULL default false
├─ password_hash       text                             -- NULL 可（ソーシャル専用）
├─ password_changed_at timestamptz
├─ display_name        text
├─ avatar_url          text
├─ status              text NOT NULL default 'pending_email'
├─ role_id             text NOT NULL REFERENCES roles(id)
├─ created_at          timestamptz NOT NULL default now()
├─ updated_at          timestamptz NOT NULL default now()
└─ deleted_at          timestamptz
```

- `role_permissions` は **作らない**。計画7.2/16章のとおり将来拡張用で、MVP では使用しない（Phase 7 で追加）
- `users.role_id` の既定はアプリ層で `role_user` を指定する（DB の default は付けない。存在しない role_id を弾くため）
- `status` は `pending_email` / `active` / `suspended` / `deleted`（§23）
- `pnpm seed` は `roles` に4行（user / moderator / admin / superadmin）を idempotent に投入する。`moderator` / `superadmin` は**定義のみ**で、権限付与・判定は Phase 7 で行う（D-19）

### 4.2 一意性制約の方針（D-04・★最重要）

```sql
CREATE UNIQUE INDEX users_username_lower_uniq
  ON users (lower(username)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_email_lower_uniq
  ON users (lower(email))    WHERE deleted_at IS NULL;

ALTER TABLE users ADD CONSTRAINT users_status_chk
  CHECK (status IN ('pending_email', 'active', 'suspended', 'deleted'));
ALTER TABLE users ADD CONSTRAINT users_status_email_verified_chk
  CHECK (status <> 'active' OR email_verified = true);
```

理由:
- **通常の UNIQUE を付けない**。付けると、論理削除済み行が同値行を含み、論理削除済み email / username の再利用（§24 と §3.1 の組み合わせ）を妨げる
- `lower()` により**現役同士は大文字小文字を区別せず一意**。アプリ層の事前チェックは参考用途とし、最終判定は DB の一意違反（SQLSTATE 23505）に委譲する（検査と登録の間の TOCTOU 回避／§27）
- CHECK により、**メール未認証のまま `active` へ遷移できない**／`status` にtypoが混入しない（§23）

Drizzle での表現:

```ts
(t) => [
  uniqueIndex('users_username_lower_uniq')
    .on(sql`lower(${t.username})`)
    .where(sql`${t.deletedAt} is null`),
  uniqueIndex('users_email_lower_uniq')
    .on(sql`lower(${t.email})`)
    .where(sql`${t.deletedAt} is null`),
  check('users_status_chk', sql`${t.status} in ('pending_email', 'active', 'suspended', 'deleted')`),
  check('users_status_email_verified_chk', sql`${t.status} <> 'active' or ${t.emailVerified} = true`),
]
```

### 4.3 マイグレーション戦略

- 作成順序は計画7.11 に準拠する。本次は **01 roles / 02 users のみ**作る
- 残りは各フェーズで追加: 03 accounts(4-A) / 04 sessions(1-C) / 05 tokens(1-B) / 06 webauthn(6-A) / 07 totp(5-A) / 08 security_events・admin_audit_logs(1-C) / 09 user_preferences(3-A) / 10 rate_limit_hits・failed_logins(1-C)
- 命名: `drizzle-kit generate --name=01_roles`（`roles` だけの一時 schema を `--schema` で指定して生成）→ `--name=02_users` → 生成物は `0000_01_roles.sql`, `0001_02_users.sql`。**接頭数字は論理順序（7.11）と一致**している
- **migration 02 に「username/email に UNIQUE を付ける」ALTER を含めない。** 含めると Phase 1 以降で論理削除済み行と衝突する

---

## 5. 環境変数戦略

`src/lib/env.ts` は zod で**起動時**に検証し、fail fast する（計画17.1）。ただし全変数を必須にすると Phase 0 の `pnpm dev` が Resend / OAuth の実キー無しで起動できなくなるため、3区分に分ける。

| 区分 | 変数 | 挙動 |
|---|---|---|
| 必須（起動時に検証） | `DATABASE_URL`, `SESSION_PEPPER`, `TOKEN_PEPPER`, `IP_HASH_PEPPER`, `CSRF_SECRET`, `TOTP_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL` | 欠落 / 長さ不足なら起動時に throw |
| 任意（既定値あり） | `REDIS_URL`, `HIBP_TIMEOUT_MS`(既定 1500), `BREACH_CHECK_FAIL_OPEN`(既定 true), `NODE_ENV` | 未設定なら既定値 |
| 遅延評価（使用時にのみ throw） | `RESEND_API_KEY`, `EMAIL_FROM`, `GOOGLE_CLIENT_*`, `GITHUB_CLIENT_*`, `DISCORD_CLIENT_*`, `TURNSTILE_SECRET_KEY` | getter 経由で参照した時点で検証。Phase 0 では誰も参照しない |

- 暗号関連キーの検証: pepper 系は **32バイト以上**、`TOTP_ENCRYPTION_KEY` は **Base64 で32バイト**
- 実値は Git に置かない（§52）。開発用は `pnpm secrets:gen` が `.env` に生成する
- `.env` を読み込む対象は Next（`.env`）と、`dotenv/config` を使う drizzle-kit / scripts

---

## 6. `errors.ts` の契約

§58 に基づく。**内部例外の message は呼び出し元へ伝播させない**（§45）。

成功:

```json
{ "success": true, "data": {} }
```

エラー:

```json
{ "success": false, "error": { "code": "INVALID_CREDENTIALS", "message": "認証情報が正しくありません。" } }
```

code Enum（計画9.1 に加えて Phase 2/4 で必要な code を追加したもの）:

```
INVALID_CREDENTIALS / EMAIL_TAKEN / RATE_LIMITED / REAUTH_REQUIRED / INVALID_TOKEN
SESSION_EXPIRED / ACCOUNT_SUSPENDED / VALIDATION_ERROR / INTERNAL_ERROR
CSRF_FAILED / INVALID_PROVIDER / INVALID_STATE / INVALID_CODE
```

- `EMAIL_TAKEN` は内部では使うが、API 応答では列挙攻撃防止のため `VALIDATION_ERROR` に寄せる（§46）
- メッセージ文言は `messages/ja.ts` に集約する（Phase 1-B で導入。Phase 0 は `errors.ts` 内の既定文言を日本語で持つ）

---

## 7. util 仕様

| ファイル | 仕様 |
|---|---|
| `id.ts` | `newId('usr')` → `usr_01J...`（ULID 26文字）。§59。prefix は `usr`/`ses`/`acc`/`evt` のみ許可し、規格外の値を渡したら throw |
| `time.ts` | DB は UTC（§60）。`nowUtc()` は `new Date()`、保存は `timestamptz`。表示変換は Phase 3 で確定 |
| `crypto.ts` | `randomToken(bytes)`（`base64url`）、`sha256Hex()`、`hmacSha256(key, value)`、`timingSafeEqualStr()`、`generatePepper()`、`generateTotpKeyBase64()`。**Node 標準 `crypto` のみ使用**（自作暗号禁止） |
| `ip.ts` | `maskIp('203.0.113.45')` → `203.0.113.xxx`、IPv6 は前半のみ保持。`hashIp(ip, pepper)` は HMAC-SHA256（§20） |
| `logger.ts` | JSON 行出力。`password` / `password_hash` / `token` / `secret` / `access_token` / `refresh_token` / `totp_secret` / `recovery_code` / `session_token` / `csrf_token` / `authorization` をキーで redact、加えて URL 中の `token=` 値を redact（§45） |

---

## 8. validate の範囲

Phase 0 では**形式のみ**を定義する（長さ・文字種・型）。

- `email`: 標準的なメールアドレス形式。保存は小文字正規化（Phase 1 で利用）
- `username`: 3〜32文字、使用可能文字に制限を置く。大文字小文字の一意判定は DB の partial unique index に委譲（アプリ層のチェックは参考用途）
- `password`: **8〜128文字**（C-02）。ASCII 限定しない・スペース許可。**NGワード判定・HIBP 漏洩チェック・Argon2 は Phase 1-A で追加する**

決定の理由: C-02 は「**8〜128文字**」を上限128文字・文字種無制限という形で固定する。8文字より短いテストは Phase 1-A の `password.test.ts`（7文字拒否・129文字拒否）で行う。

---

## 9. UI / テーマの土台

- CSS変数を `:root`（light）と `[data-theme="dark"]` に定義（§39-42）
- 変数: `--bg --fg --card --border --primary --muted-fg --danger --success --warning --ring --disabled-bg`
- Tailwind v4 の `@theme inline` で CSS 変数をユーティリティに束縛し、テーマ切替時に**再レンダリングを発生させない**
- `layout.tsx` の `<head>` に**同期インライン script**を置き、ページ描画前に `data-theme` を適用して FOUC を防ぐ（§42 の前提）
- ThemeProvider / トグル UI / `matchMedia` 購読（§41）は **Phase 3-A**。Phase 0 は「変数定義と初期適用」に限定する

---

## 10. テスト方針

| ディレクトリ | 対象 | 実行 |
|---|---|---|
| `src/test/unit/` | 純関数（id / time / ip / crypto / logger / validate / errors） | `pnpm test:unit` |
| `src/test/integration/` | DB・Redis 相互作用 | Phase 1 で追加 |
| `src/test/security/` | 仕様48章の攻撃シナリオ | Phase 1 以降 |
| `src/test/e2e/` | Playwright | Phase 8-B |

**配置は `src/test/**` に統一する。** 計画6章のディレクトリ構成が `src/test/**`、chapters 10/16 が `test/security/...` と記述しており表記が揺れていたため、6章（ディレクトリ構成）を正とした。この不一致を D-18 として記録する。
**適用結果**: `実装計画.md` v1.4 / `実装Todo.md` のテストパス表記はすべて `src/test/**` に統一済み（`実装計画.md` 10章・15章・16章、`実装Todo.md` 全章）。新規記述でも `test/**` は使わない。

Phase 0 のテスト対象（`src/test/unit/` 配下に **9ファイル**作成）:

- `id.test.ts` — prefix が付く／**ULID 26文字**／不正 prefix で throw／一意性
- `crypto.test.ts` — 乱数の長さ/base64url/hash の hex 64文字/HMAC の一致と不一致/定数時間比較
- `ip.test.ts` — IPv4 マスクが `203.0.113.xxx`／IPv6 の扱い／`::1` と IPv4 の別挙動/hash の安定性
- `time.test.ts` — UTC で保存される形式
- `logger.test.ts` — secret キーが `***` になる／`token=` が伏せられる／通常キーは残る
- `validate.test.ts` — 7文字拒否 / 8文字OK / **128文字OK・129文字NG** / Unicode・スペース許可 / email・username の境界
- `errors.test.ts` — 成功/エラー形状、code Enum、詳細を漏らさない
- `env.test.ts` — 必須欠落・長さ不足で fail fast／任意値の既定値／遅延評価
- `schema.test.ts` — partial unique index・CHECK 制約・role_id に DB default が無いこと

---

## 11. Git / GitHub 手順

1. `.gitignore` を作成してから `git init`
2. **private** リポジトリとして `oauth` を作成（§52: 秘密情報を公開リポジトリへ置かない）
3. 初期コミット → `git push -u origin main`
4. `.env` / `*.pem` / `node_modules` / `.next` はステージしない。ステージ前に `git status` で確認する
5. `gitleaks` による CI 検査は Phase 9

---

## 12. 検証手順

```
pnpm install
pnpm secrets:gen
docker compose up -d
drizzle-kit generate --dialect=postgresql --schema=<roles のみの一時 schema> --name=01_roles
pnpm db:generate --name=02_users
pnpm db:migrate
pnpm seed
pnpm lint && pnpm typecheck && pnpm test
pnpm dev            # http://localhost:3000 が 200
```

index / 制約の実測（ホストに psql がないためコンテナ内 psql を使用）:

```
docker compose exec -T db psql -U app -d app -c "\d users"
docker compose exec -T db psql -U app -d app -c "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='users';"
docker compose exec -T db psql -U app -d app -c "SELECT conname, contype FROM pg_constraint WHERE conrelid='users'::regclass AND contype='u';"
docker compose exec -T db psql -U app -d app -c "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='users'::regclass AND contype='c';"
```

期待結果:

1. `users_username_lower_uniq` と `users_email_lower_uniq` が `WHERE (deleted_at IS NULL)` 付きで存在する
2. `contype='u'` の結果が **0件**
3. `users_status_email_verified_chk` と `users_status_chk` が CHECK 制約として存在する
4. `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm dev` がすべて green

### 12.1 実施結果（2026-10-04）

| 項目 | 結果 |
|---|---|
| `pnpm lint` | 0 errors / 9 warnings（型付き `Record` 参照に対する `security/detect-object-injection` と、テスト内の動的 `RegExp`） |
| `pnpm typecheck` | green |
| `pnpm test` | 9 files / 76 tests passed |
| `pnpm db:migrate` | migrations applied successfully |
| `pnpm seed` | role_user / role_moderator / role_admin / role_superadmin を投入 |
| `pnpm dev` | `GET / → 200` |
| `pnpm build` | 静的ページ生成成功 |
| `pg_indexes`（users） | `users_pkey` / `users_username_lower_uniq`（`lower(username) WHERE (deleted_at IS NULL)`）/ `users_email_lower_uniq`（`lower(email) WHERE (deleted_at IS NULL)`）/ `users_role_id_idx` / `users_deleted_at_idx` |
| `pg_constraint` contype='u'（users） | **0 rows**（通常 UNIQUE が無いことの証跡） |
| `pg_constraint` contype='c'（users） | `users_status_chk` / `users_status_email_verified_chk` |
| 挙動確認 | ①`Yuushi`/`yuushi` の重複は `users_username_lower_uniq` で拒否 ②論理削除後は同 email/username を再利用可 ③`active` + `email_verified=false` は CHECK で拒否 ④未知の `status` は CHECK で拒否 |

---

## 13. リスクと代替

| リスク | 対処 |
|---|---|
| docker デーモンに権限がない | ユーザーが `docker` グループへ追加する（`sudo usermod -aG docker $USER` 後に再ログイン、または `sudo setfacl -m u:<user>:rw /var/run/docker.sock`）。Docker 本体が入っていない場合のみ `apt-get install docker.io docker-compose-v2` |
| `docker compose` プラグインが無い | `docker-compose` (v1) にフォールバック。`compose.yaml` は両方で読める形式にする |
| registry 到達不可 | 2回再試行→失敗したら停止して報告。**依存を手続きで代替しない** |
| `gh` 未認証 | 停止してユーザーに対応依頼。トークンを文件中へ書かない |
| マイグレーションファイル名の接頭数字 | drizzle-kit は `0000_01_roles.sql` 形式。**論理順序（7.11）が一致**していれば許容 |

---

## 14. 実装中に確定した追加事項（計画の明示に無いが必要なもの）

| ID | 内容 | 理由 |
|---|---|---|
| D-18 | テスト配置を `src/test/**` に統一（6章を正とした。`実装計画.md` v1.4 / `実装Todo.md` の表記も本決定へ追随済み） | ディレクトリ構成との整合 |
| D-19 | `scripts/seed.ts` を Phase 0 に置く（`roles` の4行を upsert） | `users.role_id` の FK 整合。役割付与・判定は Phase 7 |
| D-20 | `zod` を v3 に固定 | v4 で `z.string().email()` が非推奨となり記述が揺れるため |
| D-21 | `env.ts` を必須／任意／遅延評価の3区分にする | Phase 0 で Resend / OAuth の実キー無しに `pnpm dev` を起動できるようにするため |
| D-22 | ID は `prefix_` + ULID（**26文字**）。計画8.1章の旧「21文字」表記は誤記（`実装計画.md` v1.4 で 26文字へ修正済み） | `ulid()` の実出力と一致させる |
| D-23 | `users` に `users_status_chk`（status の値域 CHECK）を追加 | §23 の4値以外が混入しないようにするため。計画の CHECK 例には無いが Phase 0 の防御として追加 |
| D-24 | マイグレーション 01 の生成に `roles` のみの一時 schema を `--schema` で渡す | `roles` と `users` を計画どおり別 migration に分けるため（FK 順） |
| D-25 | トークンテーブルの `id` prefix は `tok_`（`evt_` は `security_events` 専用）。Phase 1-B で `util/id.ts` の `ID_PREFIXES` に追加する | Phase 0 の 4 prefix と衝突させず、ID の取り違えを防ぐ（計画 8.2） |

---

## 改訂履歴

| 版 | 日付 | 変更 |
|---|---|---|
| v1.0 | 2026-10-04 | 初版作成。Phase 0 の実装方針（ファイル構成・DB設計・マイグレーション戦略・env 戦略・検証手順・リスク）を確定 |
| v1.1 | 2026-10-04 | 実装着手時の差分を反映（`next-env.d.ts` の扱い、`role_id` の既定はアプリ層、`@theme inline` の採用、ULID は26文字、`users_status_chk` 追加、migration 01/02 の生成方法、検証結果の記録） |
| v1.2 | 2026-10-04 | 他ドキュメントとの整合修正（**実装変更なし**）。`vitest.config.ts` → `vitest.config.mts`、ULID の 21/26 表記揺れを解消、Phase 0 のテスト対象を実際の 9ファイル（`env` / `schema` を含む）に更新、`README.md` の参照先を修正、`実装計画.md` の版数参照を追随、D-25（トークン `id` の `tok_` prefix）を追記、D-18/D-22 の適用結果を現状に更新 |
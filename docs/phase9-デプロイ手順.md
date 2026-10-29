# デプロイ手順（ほぼ初期状態のサーバーから本番稼働まで）

> 対象: 「超本格アカウント・認証システム」（本リポジトリ）を **まっさらな Linux サーバー**へ
> 本番デプロイする手順。リポジトリの clone から、PostgreSQL のインストール、環境変数の生成、
> migration、ビルド、systemd 常駐、Nginx + TLS、定期ジョブまでを 1 本にまとめる。
>
> 関連: `docs/phase9-運用ランブック.md`（運用中の手順）/ `docs/phase9-バックアップ復元手順.md`（§53）/
> `deploy/nginx/oauth.conf`・`deploy/cloudflare.md`・`deploy/log-security-checklist.md`（ログ漏洩対策・§17.2.1）/
> `.env.example`（環境変数の正本）
>
> 想定 OS: **Ubuntu 22.04 / 24.04 LTS**（Debian 系）。RHEL 系はパッケージコマンドを読み替える。
> 想定構成: 単一ホストに「アプリ（Next.js custom server）＋ PostgreSQL 16 ＋ Nginx（TLS 終端）」。
> DB を別ホストにする場合は §4・§6 の接続先を読み替える。

---

## 0. 全体像

```
インターネット
    │  HTTPS (443)
    ▼
┌───────────────────────────────────────────────┐
│ Nginx（TLS 終端 / HSTS / query を含まないログ）│
│   proxy_pass → 127.0.0.1:3000                  │
└───────────────────────────────────────────────┘
    │  HTTP (localhost)
    ▼
┌───────────────────────────────────────────────┐
│ oauth アプリ（systemd 常駐・Node 24）          │
│   Next.js 15 + oidc-provider（1 プロセス）     │
└───────────────────────────────────────────────┘
    │  TCP 5432 (localhost)
    ▼
┌───────────────────────────────────────────────┐
│ PostgreSQL 16                                  │
└───────────────────────────────────────────────┘
```

- アプリは `scripts/server.ts`（custom Node server）で **Next.js と OIDC Provider を 1 プロセス**で起動する。
- 既定で `0.0.0.0:3000` を listen する（`PORT` / `HOSTNAME` で変更可）。本手順では Nginx から
  `127.0.0.1:3000` へ転送する。
- **`NODE_ENV=production` が必須**。これが無いと Cookie が `__Host-` にならず、HSTS も付かず、
  CAPTCHA も fail-closed にならない（開発モードの挙動になる）。

作業はすべて **root もしくは sudo 可能なユーザー**で行う。アプリ本体は専用ユーザー `oauth` で動かす。

---

## 1. 前提（サーバー要件）

| 項目       | 目安                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| OS         | Ubuntu 22.04 / 24.04 LTS（x86_64 / arm64）                                              |
| CPU        | 2 vCPU 以上                                                                             |
| メモリ     | 2 GB 以上（Argon2id のため。`ARGON2_M=65536` = 64 MiB/ハッシュ）                        |
| ディスク   | 20 GB 以上（バックアップ・ログ・`.next` を含む）                                        |
| Node.js    | **22 以上**（本手順は 24 LTS を導入）                                                   |
| pnpm       | **11.13.1**（`package.json` の `packageManager`。corepack で固定）                      |
| PostgreSQL | **16**                                                                                  |
| その他     | `git` / `curl` / `build-essential`（ネイティブモジュール `@node-rs/argon2` のビルド用） |
| ドメイン   | 例 `auth.example.com`（A/AAAA レコードをこのサーバーへ向ける）                          |
| ポート     | 443 / 80 を公開。**3000 と 5432 は公開しない**                                          |

> `@node-rs/argon2` は prebuilt バイナリを配布しているが、環境によってはビルドが必要。
> `build-essential` と `python3` を入れておくと安全。

---

## 2. OS の初期設定

```bash
# パッケージ更新
sudo apt-get update && sudo apt-get -y upgrade

# 基本ツール（git / curl / ビルドチェーン / TLS / firewall）
sudo apt-get -y install \
  git curl ca-certificates gnupg build-essential python3 \
  ufw fail2ban

# タイムゾーン（ログ・cron のため UTC か運用 TZ に統一する）
sudo timedatectl set-timezone Asia/Tokyo   # 例。UTC でもよい

# ホスト名（任意）
sudo hostnamectl set-hostname auth
```

### 2.1 ファイアウォール（ufw）

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# 3000 / 5432 は「開けない」。Nginx と DB はローカル専用にする。
sudo ufw enable
sudo ufw status verbose
```

---

## 3. Node.js 24 と pnpm のインストール

```bash
# NodeSource から Node.js 24 を導入
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get -y install nodejs
node -v      # v24.x.x であること
npm -v

# pnpm をグローバル導入する（systemd から全ユーザーで使える実体を作る）
sudo npm install -g pnpm@11.13.1
pnpm -v      # 11.13.1 であること
which pnpm   # /usr/local/bin/pnpm（このパスを §10 の ExecStart に使う）
```

> **corepack ではなく npm グローバル導入を推奨する。** corepack の shim は
> 「初回実行時にユーザー単位のキャッシュ（`~/.cache/node/corepack`）へ pnpm を取得する」方式のため、
> systemd の `User=oauth` で動かすときにキャッシュが無く失敗しやすい。
> corepack を使う場合は、事前に `sudo -u oauth -H corepack prepare pnpm@11.13.1 --activate` を
> 実行してキャッシュを作るか、`COREPACK_ENABLE_DOWNLOAD_PROMPT=0` を環境へ設定する。

---

## 4. PostgreSQL 16 のインストールと初期設定

```bash
# PostgreSQL 公式リポジトリ（Ubuntu 標準より新しい 16 を入れる）
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
sudo sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
  https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list'
sudo apt-get update
sudo apt-get -y install postgresql-16 postgresql-client-16

# 常駐確認
sudo systemctl enable --now postgresql
sudo systemctl status postgresql --no-pager
psql --version      # psql (PostgreSQL) 16.x
```

> **`pg_dump` / `pg_restore` / `createdb` / `dropdb` が必要**（バックアップ・復元・復元テストで使う）。
> `postgresql-client-16` を入れると PATH に入る。

### 4.1 DB とアプリ用ロールを作成

平文パスワードは環境変数経由で渡し、シェル履歴に残さない。

```bash
# 強いパスワードを生成（メモしておく。後で DATABASE_URL に使う）
DB_PASSWORD="$(openssl rand -base64 24)"

sudo -u postgres psql <<SQL
CREATE ROLE app LOGIN PASSWORD '${DB_PASSWORD}';
CREATE DATABASE app OWNER app ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
SQL

# 接続確認（localhost 経由）
PGPASSWORD="${DB_PASSWORD}" psql -h 127.0.0.1 -U app -d app -c 'SELECT current_database(), current_user;'
```

- DB は **外部公開しない**。`postgresql.conf` の `listen_addresses` は既定（localhost）のままでよい。
- アプリは `DATABASE_URL` で接続する。migration もこのユーザーで流す（テーブル作成権限が要る）。
- スキーマは `public`。`search_path` の既定で問題ない。

### 4.2 （任意）PostgreSQL の調整

同時接続数・メモリに応じて `/etc/postgresql/16/main/postgresql.conf` を調整する。
小規模なら既定で足りる。変更したら `sudo systemctl restart postgresql`。

---

## 5. アプリ用ユーザーとリポジトリの配置

```bash
# アプリを動かす専用ユーザー（ログイン不可・ホームは /srv/oauth）
sudo useradd --system --create-home --home-dir /srv/oauth --shell /usr/sbin/nologin oauth

# アプリ用ディレクトリ
sudo -u oauth mkdir -p /srv/oauth/app
sudo -u oauth git clone https://github.com/yuushi2024/oauth.git /srv/oauth/app
cd /srv/oauth/app
git --no-pager log --oneline -1
```

> リポジトリは **private**。clone に認証が要る場合は deploy key かトークンを使う。
> 例: `sudo -u oauth git clone https://<TOKEN>@github.com/yuushi2024/oauth.git /srv/oauth/app`
> （トークンはシェル履歴に残さない。`~/.git-credentials` 等の管理は運用ポリシーに従う）

以降のコマンドは **すべて `oauth` ユーザーで `/srv/oauth/app` を作業ディレクトリとして**実行する。

```bash
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm install --frozen-lockfile'
```

> `pnpm install` は `postinstall` で `esbuild` / `unrs-resolver` のネイティブバイナリを取得する
> （`pnpm-workspace.yaml` の `allowBuilds`）。失敗する場合は `build-essential` の有無を確認する。

> **`--prod` を使わないこと。** 本アプリは `pnpm start` = `node --import tsx scripts/server.ts start`
> で TypeScript を実行時に解決するため、`tsx`（devDependency）が**本番でも必要**。
> `pnpm install --prod` や `NODE_ENV=production` を付けた `--prod` 相当の導入をすると `tsx` が
> 入らず起動に失敗する。`pnpm install --frozen-lockfile` で devDependency を含めて導入する。

---

## 6. 環境変数（`.env`）の作成

本番の値は **Secret Manager 等から注入**するのが原則（仕様 52 章）。本手順では
「サーバー上の `/srv/oauth/app/.env`（権限 600、`oauth` 所有）」に置く方式で説明する。

### 6.1 自動生成できる値

`pnpm secrets:gen` は未設定の必須シークレットを生成して `.env` を作成/追記する（値は標準出力に出さない）。

```bash
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm secrets:gen'
sudo -u oauth -H bash -lc 'chmod 600 /srv/oauth/app/.env'
```

生成される項目（Base64 32 バイト or 32 文字以上の乱数）:

| 変数                    | 用途                                | ローテ影響                               |
| ----------------------- | ----------------------------------- | ---------------------------------------- |
| `SESSION_PEPPER`        | セッショントークンの HMAC           | 変更で全セッション無効（全員再ログイン） |
| `TOKEN_PEPPER`          | 各種トークンの HMAC                 | 変更で未使用トークン失効                 |
| `IP_HASH_PEPPER`        | 生 IP のハッシュ化（§45）           | 変更で過去の IP ハッシュと非連続         |
| `CSRF_SECRET`           | CSRF トークン署名                   | 変更で進行中フォーム再取得               |
| `TOTP_ENCRYPTION_KEY`   | TOTP secret の暗号化（AES-256-GCM） | 変更には**再暗号化が必要**               |
| `BACKUP_ENCRYPTION_KEY` | バックアップ暗号化                  | 旧鍵は旧バックアップが不要になるまで保管 |

> **鍵は絶対にコミットしない・チャットへ貼らない。** バックアップ（§13）や Secret Manager に退避する。

### 6.2 手動で設定する値（`.env` を編集）

```bash
sudo -u oauth -H bash -lc 'nano /srv/oauth/app/.env'   # エディタは任意
```

必ず見直す項目（`.env.example` が正本）:

```dotenv
# --- 実行モード（必須。これが無いと本番の安全側挙動にならない） ---
# systemd の Environment でも設定する（§10）。プロセス環境が最終的な正になる。
NODE_ENV=production

# --- アプリ（必須） ---
NEXT_PUBLIC_APP_NAME=oauth
NEXT_PUBLIC_APP_URL=https://auth.example.com      # ← 本番ドメイン（https）

# --- DB（必須） ---
DATABASE_URL=postgresql://app:<DB_PASSWORD>@127.0.0.1:5432/app

# --- リバースプロキシ（Nginx の背後で必須級） ---
TRUSTED_PROXY_HOPS=1                              # Nginx 1 段
TRUSTED_PROXY_HEADER=x-forwarded-for              # Nginx が設定するヘッダ
ALLOWED_HOSTS=auth.example.com                    # HTTPS リダイレクトで許可する Host

# --- OIDC Provider（自作サービスへ OIDC を提供する場合。§7 で鍵生成） ---
OIDC_ISSUER=https://auth.example.com              # 本番は https 必須（= NEXT_PUBLIC_APP_URL の origin）
# OIDC_JWKS_JSON=...                              # §7 の出力をそのまま貼る（引用符なし）
# OIDC_ADAPTER_ENCRYPTION_KEY=...                 # §7 の出力

# --- Passkey / WebAuthn（本番では必須。未設定だと Passkey 無効） ---
WEBAUTHN_RP_ID=auth.example.com                   # ポートを含めない登録可能ドメイン
WEBAUTHN_RP_NAME=oauth
WEBAUTHN_ALLOWED_ORIGINS=https://auth.example.com

# --- メール（Phase 1-B。登録確認・再設定で必須） ---
RESEND_API_KEY=re_xxxxxxxx
EMAIL_FROM=no-reply@auth.example.com

# --- ソーシャルログイン（使う provider のみ。interop/README.md 参照） ---
GOOGLE_CLIENT_ID=...      / GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...      / GITHUB_CLIENT_SECRET=...
DISCORD_CLIENT_ID=...     / DISCORD_CLIENT_SECRET=...

# --- Bot 対策（任意。有効化すると CAPTCHA 要求時に fail-closed） ---
TURNSTILE_SECRET_KEY=...
CAPTCHA_TIMEOUT_MS=3000

# --- Redis（任意。未設定ならレート制限は PostgreSQL にフォールバック・D-05） ---
REDIS_URL=
```

#### 環境変数の意味と落とし穴

| 変数                                                                 | 必須/任意              | 説明                                                                                                   |
| -------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                                           | **必須**               | `production` にする。Cookie の `__Host-` 化・HSTS・CAPTCHA fail-closed・OIDC の https 強制はこれが前提 |
| `NEXT_PUBLIC_APP_URL`                                                | **必須**               | 絶対 URL。ソーシャルログインの redirect URI の origin と**完全一致**させる                             |
| `DATABASE_URL`                                                       | **必須**               | PostgreSQL 接続文字列                                                                                  |
| `SESSION_PEPPER` / `TOKEN_PEPPER` / `IP_HASH_PEPPER` / `CSRF_SECRET` | **必須**               | 32 文字以上。起動時に検証され、不足なら fail fast                                                      |
| `TOTP_ENCRYPTION_KEY`                                                | **必須**               | Base64 32 バイト。起動時に検証                                                                         |
| `TRUSTED_PROXY_HOPS`                                                 | 推奨                   | Nginx 1 段なら `1`。`0` だと転送ヘッダを信頼せず、HTTPS 判定が誤る                                     |
| `TRUSTED_PROXY_HEADER`                                               | 推奨                   | クライアント IP を取るヘッダ（Nginx なら `x-forwarded-for`、Cloudflare なら `cf-connecting-ip`）       |
| `ALLOWED_HOSTS`                                                      | 推奨                   | HTTPS リダイレクトで許可する Host。`NEXT_PUBLIC_APP_URL` の host は自動許可                            |
| `OIDC_ISSUER`                                                        | OIDC 使用時必須        | 本番は `https`。`NEXT_PUBLIC_APP_URL` と同一 origin にする                                             |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ALLOWED_ORIGINS`                        | Passkey 使用時必須     | 本番で未設定だと Passkey 無効。`rpID` は origin の登録可能ドメインであること                           |
| `RESEND_API_KEY` / `EMAIL_FROM`                                      | メール使用時必須       | 参照時に未設定なら throw（遅延評価）                                                                   |
| `TURNSTILE_SECRET_KEY`                                               | 任意                   | 設定すると本番で CAPTCHA を検証。未設定でも起動はする（要求時に 500 で fail-closed）                   |
| `BACKUP_ENCRYPTION_KEY`                                              | バックアップ使用時必須 | 未設定だと `pnpm backup` が失敗（平文で保存しない）                                                    |

> **`DEBUG` を本番で設定しない。** `oidc-provider` の名前空間を含む `DEBUG` を有効にすると
> redaction されないログが出るため、起動時に失敗する。

> `NODE_ENV=production` では **`NEXT_PUBLIC_APP_URL` が `https`** であること、`OIDC_ISSUER` が
> `https` であることを各 module が検証する。`http` のまま起動すると throw する。

---

## 7. OIDC 署名鍵・暗号鍵の生成（OIDC Provider を使う場合）

```bash
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm oidc:keygen'
```

出力は 2 行（＋注記）:

```
OIDC_ADAPTER_ENCRYPTION_KEY=<base64-32-byte-key>
OIDC_JWKS_JSON={"keys":[{"kty":"RSA",...,"d":"...","kid":"...","use":"sig","alg":"RS256"}]}
```

- 2 行をそのまま `.env` へ追記する。**`OIDC_JWKS_JSON` は引用符で囲まない**（JSON に余計な空白を入れない）。
- `OIDC_ADAPTER_ENCRYPTION_KEY` は client secret と Provider state の DB 暗号化に使う。
  **変更すると復号できなくなる**ため、変更時はデータ移行と同時に行う。
- 署名鍵をローテーションするときは、新しい private JWK と**旧 public JWK を併記**して
  `OIDC_JWKS_JSON` に入れる（JWKS は複数鍵を持てる）。`private` 鍵は常に 1 つだけ。

> OIDC を使わない場合、`OIDC_ISSUER` を未設定にすれば OIDC エンドポイントは起動しない
> （アプリ本体は動く）。

---

## 8. Migration と初期データ

```bash
cd /srv/oauth/app   # oauth ユーザーで

# スキーマ適用（drizzle-kit migrate。up のみ）
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm db:migrate'

# roles の投入（user / moderator / admin / superadmin の 4 行）
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm seed'

# 任意: migration の可逆性・復元まで検証する（一時 DB を作って削除する）
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm db:verify-migrations'
```

- `pnpm db:migrate` は `DATABASE_URL` に対して適用する。`drizzle/` 配下の migration が正本（up のみ）。
- `pnpm seed` は `roles` を upsert する。**登録ユーザーは既定で `role_user`** になるため必須。
- アプリは起動時に **スキーマ未適用を検出して fail fast** する（`SchemaOutOfDateError`）。
  `pnpm db:migrate` を忘れると起動時に不足テーブル名が表示される。

---

## 9. ビルド

```bash
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm build'
```

- `next build` が成功すると `.next/` に本番ビルドが出る。
- `NODE_ENV=production` で実行される（`.env` から読む）。型・CSP・env の検証も兼ねる。
- 失敗する場合は env（必須項目）の不足が多い。§6 を見直す。

---

## 10. systemd で常駐させる

### 10.1 unit ファイル

`/etc/systemd/system/oauth.service`:

```ini
[Unit]
Description=oauth (Next.js + OIDC Provider)
Documentation=https://github.com/yuushi2024/oauth
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=oauth
Group=oauth
WorkingDirectory=/srv/oauth/app

# .env は dotenv が読む。NODE_ENV はここでも明示する（.env と二重で持ってよい）
Environment=NODE_ENV=production
# Nginx から 127.0.0.1 へ転送するため、localhost のみ listen する
Environment=HOSTNAME=127.0.0.1
Environment=PORT=3000

# pnpm start = `node --import tsx scripts/server.ts start`
ExecStart=/usr/local/bin/pnpm start
Restart=always
RestartSec=3
# 終了時の猶予
TimeoutStopSec=20
KillSignal=SIGTERM

# ハードニング
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/srv/oauth/app/.next /srv/oauth/app/backups /var/log/oauth
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

> **`HOSTNAME` の注意**: systemd はサービスに `HOSTNAME` を設定することがある。アプリの
> custom server は `process.env.HOSTNAME` を listen アドレスに使うため、`Environment=HOSTNAME=127.0.0.1`
> を明示して **外部に直接公開しない**（Nginx 経由のみにする）。
>
> `pnpm` のパスは `which pnpm` で確認する（corepack shim なら `/usr/local/bin/pnpm`）。

### 10.2 ログディレクトリと起動

```bash
sudo mkdir -p /var/log/oauth /srv/oauth/app/backups
sudo chown -R oauth:oauth /var/log/oauth /srv/oauth/app/backups

sudo systemctl daemon-reload
sudo systemctl enable --now oauth
sudo systemctl status oauth --no-pager

# 起動ログ（"Ready on http://127.0.0.1:3000" が出れば OK）
sudo journalctl -u oauth -n 50 --no-pager
```

### 10.3 ヘルスチェック

```bash
curl -s http://127.0.0.1:3000/api/health
# {"status":"ok"}   が返れば DB 接続も含めて正常（DB 不通なら 503 {"status":"unavailable"}）
```

`/api/health` は認証不要の liveness / readiness。LB・監視・デプロイの疎通確認に使う。

---

## 11. Nginx（TLS 終端 + ログ漏洩対策）

### 11.1 インストールと証明書

```bash
sudo apt-get -y install nginx
# Let's Encrypt（certbot）
sudo apt-get -y install certbot python3-certbot-nginx

# ドメインの A/AAAA がこのサーバーを向いていることを確認してから取得
sudo certbot --nginx -d auth.example.com --redirect --agree-tos -m admin@example.com --no-eff-email
```

> certbot は 80/443 を使う。ufw で両方開いていること（§2.1）。

### 11.2 サイト設定

リポジトリ同梱の雛形 `deploy/nginx/oauth.conf` をベースにする。**認証トークン付き URL の
query を access log に残さない** log_format（`$uri` ベース）と、`X-Forwarded-Proto` の付与が
含まれている。`server_name` / 証明書パスを自分の環境に合わせて編集する。

```bash
sudo cp /srv/oauth/app/deploy/nginx/oauth.conf /etc/nginx/sites-available/oauth.conf
sudo nano /etc/nginx/sites-available/oauth.conf   # server_name / ssl_certificate を修正
sudo ln -sf /etc/nginx/sites-available/oauth.conf /etc/nginx/sites-enabled/oauth.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

`deploy/nginx/oauth.conf` の要点:

- `log_format oauth_safe` は `$request` ではなく `$request_method` + **query を含まない `$uri`**
  （`$safe_uri` map で認証系パスは値を落とす）を記録する。
- `proxy_set_header X-Forwarded-Proto $scheme;` を付与する。これと `TRUSTED_PROXY_HOPS=1` の
  組み合わせでアプリが HTTPS と判定する。
- `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` を付与（`TRUSTED_PROXY_HEADER=x-forwarded-for` と対応）。

> Cloudflare を前段に置く場合は `deploy/cloudflare.md` に従い、Logpush / Analytics で
> query string を保存しない設定にする。`TRUSTED_PROXY_HEADER` は `cf-connecting-ip` にする。

### 11.3 公開確認

```bash
curl -sI https://auth.example.com/api/health
# HTTP/2 200 / strict-transport-security が付いていること

curl -s https://auth.example.com/.well-known/openid-configuration | head   # OIDC 使用時
```

---

## 12. ログ漏洩対策の実地確認（§17.2.1・必須）

デプロイ直後に、認証トークン付き URL が**どの層のログにも平文で残らない**ことを実物で確認する。

```bash
KNOWN_VALUE="CHECK-$(date +%s)"
curl -s "https://auth.example.com/verify-email?token=${KNOWN_VALUE}" -o /dev/null
curl -s "https://auth.example.com/reset-password?token=${KNOWN_VALUE}" -o /dev/null
curl -s "https://auth.example.com/api/auth/oauth/google/callback?code=${KNOWN_VALUE}&state=${KNOWN_VALUE}" -o /dev/null

# Nginx access log に値が無いことを確認（query は出ない設計）
sudo grep -r "${KNOWN_VALUE}" /var/log/nginx/ || echo "OK: nginx ログに値なし"

# アプリのログを「行番号だけ」で走査（値は出力しない）
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm logs:scan /var/log/oauth/app.log'
```

`deploy/log-security-checklist.md` の全層（Nginx / CDN / tracing / APM / error tracking / アプリ）を
確認し、**記録欄へ結果を残す**。不合格時の対応も同ファイルに記載している。

---

## 13. バックアップ

手順の詳細は `docs/phase9-バックアップ復元手順.md`。最低限:

```bash
# 手動で 1 回取得（既定 ./backups、保持 30 日）
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm backup --out /srv/oauth/app/backups --keep 30'
ls -l /srv/oauth/app/backups    # backup-<ISO8601>.dump.enc（権限 600）

# 復元テスト（別 DB へ。本番 DB へ流さないこと）
sudo -u postgres createdb -O app app_restore_test
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm restore \
  --file /srv/oauth/app/backups/<最新>.dump.enc \
  --database postgresql://app:<DB_PASSWORD>@127.0.0.1:5432/app_restore_test'
sudo -u postgres psql -d app_restore_test -c 'SELECT count(*) FROM users;'
sudo -u postgres dropdb app_restore_test
```

- `BACKUP_ENCRYPTION_KEY` 未設定だと `pnpm backup` は失敗する（平文保存を禁止・D-39-03）。
- `BACKUP_ENCRYPTION_KEY` はバックアップとは**別の場所**（Secret Manager / 別ホスト）へ退避する。
  鍵が無いとバックアップは復号できない。
- 復元テストは**四半期ごと**＋スキーマ変更時に実施し、`docs/phase9-バックアップ復元手順.md` の記録欄へ残す。

---

## 14. 定期ジョブ（cron）

`oauth` ユーザーの crontab（`sudo -u oauth crontab -e`）:

```cron
# 期限切れデータの削除（§52）
0 3 * * *   cd /srv/oauth/app && /usr/local/bin/pnpm purge   >> /var/log/oauth/purge.log 2>&1

# バックアップ（§53）
15 3 * * *  cd /srv/oauth/app && /usr/local/bin/pnpm backup --out /srv/oauth/app/backups >> /var/log/oauth/backup.log 2>&1

# アラート判定（5 分ごと。構造化ログを監視基盤が拾う）
*/5 * * * * cd /srv/oauth/app && /usr/local/bin/pnpm alert:check >> /var/log/oauth/alert.log 2>&1

# ログの secret 検知（1 日 1 回）
0 4 * * *   cd /srv/oauth/app && /usr/local/bin/pnpm logs:scan /var/log/oauth/app.log >> /var/log/oauth/logscan.log 2>&1
```

> `pnpm alert:check` は閾値超過のみを 1 行 JSON で出力する（外部 SaaS へは送らない・D-39-05）。
> 監視基盤（journald / Loki / CloudWatch 等）で `"alert":` を拾って通知する。
> `pnpm purge` は 180 日を超えた `security_events` と論理削除後 30 日のユーザーを物理削除する。

---

## 15. 最初の管理者ユーザーの作成

1. ブラウザで `https://auth.example.com/register` から通常登録し、メール確認を完了する
   （`RESEND_API_KEY` / `EMAIL_FROM` と SPF/DKIM/DMARC が正しくないとメールが届かない）。
2. そのユーザーへ管理者 role を付与する:

```bash
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm admin:grant admin@example.com --role admin'
```

- CLI は trusted operator として全 role を付与できる（`--actor` 省略時は監査ログには記録せず
  `security_events` にのみ記録する旨の警告が出る）。
- 管理 API を使う前に**そのユーザーは 2 段階認証（TOTP）を有効化する必要がある**（§51）。
- メール到達性（SPF / DKIM / DMARC）は `docs/phase9-運用ランブック.md` §6 を参照。

---

## 16. 更新（デプロイ）とロールバック

### 16.1 更新手順

```bash
cd /srv/oauth/app
sudo -u oauth git fetch --all --tags
sudo -u oauth git checkout <tag or main>
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm install --frozen-lockfile'
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm db:migrate'
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm build'
sudo systemctl restart oauth
curl -s http://127.0.0.1:3000/api/health
```

- migration は **up のみ**（down は無い）。破壊的変更を含む場合は先にバックアップを取る。
- 起動時にスキーマ未適用を検出したら `SchemaOutOfDateError` で fail fast する（ログに不足テーブルが出る）。

### 16.2 ロールバック

```bash
cd /srv/oauth/app
sudo -u oauth git checkout <previous-tag-or-commit>
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm install --frozen-lockfile && pnpm build'
sudo systemctl restart oauth
```

- **migration を巻き戻す必要がある場合**はバックアップから復元する（`docs/phase9-バックアップ復元手順.md`）。
  復元は別 DB へ流して確認してから切り替えるのが安全。

---

## 17. トラブルシューティング

| 症状                                               | 原因の候補                                       | 対処                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 起動直後に落ちる（`環境変数の検証に失敗しました`） | 必須 env の欠落・長さ不足                        | `.env` を確認（§6）。pepper は 32 文字以上、`TOTP_ENCRYPTION_KEY` は Base64 32 バイト                 |
| `データベースのスキーマがコードより古いです`       | migration 未適用                                 | `pnpm db:migrate` → `pnpm seed`                                                                       |
| `/api/health` が 503                               | DB 接続不可                                      | `DATABASE_URL`・PostgreSQL の起動・ufw/接続権限を確認                                                 |
| `OIDC_ISSUER must use HTTPS in production`         | `OIDC_ISSUER` が http                            | `https://auth.example.com` にする                                                                     |
| `DEBUG must not enable oidc-provider namespaces`   | `DEBUG` に `oidc-provider` を含めた              | 本番の `DEBUG` から外す                                                                               |
| Cookie が保存されない / ログインが維持されない     | `NODE_ENV` が production でない、HTTPS でない    | `NODE_ENV=production` と TLS 終端・`TRUSTED_PROXY_HOPS` を確認                                        |
| リダイレクトループ                                 | `TRUSTED_PROXY_HOPS=0` で HTTPS 判定できていない | `TRUSTED_PROXY_HOPS=1` と Nginx の `X-Forwarded-Proto` を確認                                         |
| 429 が多い                                         | レート制限                                       | `security_events` の `rate_limited` を確認。正規トラフィックなら `src/config/rate-limits.ts` を見直す |
| Passkey が使えない                                 | `WEBAUTHN_*` 未設定                              | 本番では `WEBAUTHN_RP_ID` / `WEBAUTHN_ALLOWED_ORIGINS` が必須                                         |
| `pnpm backup` が失敗                               | `BACKUP_ENCRYPTION_KEY` 未設定                   | §6 で鍵を注入（平文では保存しない）                                                                   |
| `pg_dump exited with …`                            | `pg_dump` が PATH に無い / 権限不足              | `postgresql-client-16` を導入。`DATABASE_URL` の権限を確認                                            |
| メールが届かない                                   | SPF/DKIM/DMARC 未設定                            | `docs/phase9-運用ランブック.md` §6 を実施                                                             |

ログの確認:

```bash
sudo journalctl -u oauth -n 200 --no-pager
sudo tail -f /var/log/nginx/oauth_access.log
```

---

## 18. デプロイ完了チェックリスト

- [ ] `NODE_ENV=production` / `NEXT_PUBLIC_APP_URL`（https）/ 必須 pepper 類 / `TOTP_ENCRYPTION_KEY` を設定した
- [ ] `TRUSTED_PROXY_HOPS` / `TRUSTED_PROXY_HEADER` / `ALLOWED_HOSTS` を実構成に合わせた
- [ ] `pnpm db:migrate` と `pnpm seed` を実行した（`roles` が 4 行）
- [ ] `pnpm build` が成功し、systemd で `oauth` が起動している
- [ ] `https://<domain>/api/health` が 200 を返す
- [ ] Nginx が TLS 終端し、HSTS が付与されている
- [ ] 3000 / 5432 が外部に公開されていない（ufw 確認）
- [ ] ログ漏洩対策の実地確認を `deploy/log-security-checklist.md` に記録した
- [ ] `pnpm backup` → 別 DB への復元テストを 1 回実施した
- [ ] cron（`purge` / `backup` / `alert:check` / `logs:scan`）を登録した
- [ ] 最初の管理者を作成し、TOTP を有効化した
- [ ] バックアップ暗号鍵を別の場所（Secret Manager 等）へ退避した
- [ ] ソーシャルログインを使う場合、各 provider に本番 redirect URI を登録した
      （`https://<domain>/api/auth/oauth/<provider>/callback`。`interop/README.md` 参照）

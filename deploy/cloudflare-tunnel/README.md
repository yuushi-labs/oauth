# Cloudflare Tunnel でデプロイする手順

> 対象: 「超本格アカウント・認証システム」（本リポジトリ）を **Cloudflare Tunnel** 経由で公開する手順。
> Nginx も証明書取得もポート開放も不要で、サーバー側の待受ポートを一切インターネットへ晒さずに
> HTTPS で公開できる。
>
> 自動化: **`install.sh`**（このフォルダ）が本手順をほぼ自動で実行する。
> 手動で進めたい場合・処理内容を確認したい場合は本書を読む。
>
> 関連: `docs/phase9-デプロイ手順.md`（Nginx 方式のデプロイ手順）/ `deploy/cloudflare.md`（Cloudflare のログ漏洩対策）/
> `docs/phase9-運用ランブック.md`（運用）/ `docs/phase9-バックアップ復元手順.md`（§53）

---

## クイックスタート

リモート管理トンネル（推奨）で、アプリ導入から公開までを 1 コマンドで行う。

```bash
# Cloudflare ダッシュボードでトンネルを作成し、トークンを控えてから実行する（§2-A）
sudo CF_TUNNEL_TOKEN='eyJ...' GITHUB_TOKEN='<repo 読み取りトークン>' \
  ./install.sh --oidc
```

- root でなければ自動で `sudo` を再実行する（引数・環境変数は保持）。
- 導入済みのソフトはスキップする（idempotent）。再実行しても安全。
- 何をするか先に確認したい場合: `./install.sh --help`（root 不要）。

手順の意味を理解したい場合は §1 以降を読む。

---

## 0. この方式の特徴

| 項目       | Nginx + certbot 方式     | **Cloudflare Tunnel 方式**               |
| ---------- | ------------------------ | ---------------------------------------- |
| 待受ポート | 80 / 443 を公開          | **公開不要**（外向き接続のみ）           |
| TLS 証明書 | certbot で取得・更新     | **Cloudflare が自動管理**                |
| DNS        | サーバーの A/AAAA を公開 | Cloudflare がトンネルへ CNAME を作成     |
| 攻撃面     | 80/443 が直接到達可能    | **到達経路が無い**（外向きトンネルのみ） |
| 固定 IP    | 必要                     | **不要**（動的 IP・NAT 背後でも可）      |
| 追加ソフト | Nginx / certbot          | `cloudflared` のみ                       |

```
インターネット
    │  HTTPS (443) ← Cloudflare のエッジが終端
    ▼
┌──────────────────────────────────────────────┐
│ Cloudflare（TLS 終端 / WAF / DDoS 緩和）      │
│   X-Forwarded-Proto: https / CF-Connecting-IP │
└──────────────────────────────────────────────┘
    │  cloudflared からの外向きトンネル（QUIC/443）
    ▼
┌──────────────────────────────────────────────┐
│ cloudflared（サーバー常駐・外向き接続のみ）    │
│   ingress: http://127.0.0.1:3000              │
└──────────────────────────────────────────────┘
    │  HTTP (localhost)
    ▼
┌──────────────────────────────────────────────┐
│ oauth アプリ（systemd 常駐・127.0.0.1:3000）  │
└──────────────────────────────────────────────┘
    │  TCP 5432 (localhost)
    ▼
┌──────────────────────────────────────────────┐
│ PostgreSQL 16                                  │
└──────────────────────────────────────────────┘
```

**重要な前提**: アプリは `NODE_ENV=production` で動かし、Cloudflare が付与する
`X-Forwarded-Proto` を信頼して「HTTPS でアクセスされた」と判定させる必要がある。
これは `TRUSTED_PROXY_HOPS=1` と `TRUSTED_PROXY_HEADER=cf-connecting-ip` の設定で満たす。

---

## 1. 前提

| 項目                  | 要件                                                               |
| --------------------- | ------------------------------------------------------------------ |
| OS                    | Ubuntu 22.04 / 24.04 LTS、または Debian 12 / 13（systemd 前提）    |
| 権限                  | **root**（`install.sh` は sudo を自動で再実行する）                |
| Cloudflare アカウント | 対象ドメインの DNS を Cloudflare で管理していること                |
| ドメイン              | 例 `auth.example.com`（**ホスト名は変更しない**）                  |
| その他                | 外向き 443（QUIC/UDP 7844 も可）が通ること。**内向きの開放は不要** |

> ドメインのネームサーバーが Cloudflare に向いている必要がある（Cloudflare が DNS を管理するため）。

### 1.1 プライベートリポジトリの取得

このリポジトリは **PRIVATE** である。`install.sh` は `git clone` するため、次のどちらかを用意する。

| 方法                      | 渡し方                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GitHub トークン（簡単）   | `sudo GITHUB_TOKEN=<token> ./install.sh ...`（`repo` 読み取り権限でよい。clone 後に remote からトークンを除去する）     |
| デプロイキー（SSH・推奨） | 対象リポジトリに read-only の deploy key を登録し、`REPO_URL=git@github.com:yuushi2024/oauth.git sudo ./install.sh ...` |

> どちらも無い場合、`install.sh` は `GIT_TERMINAL_PROMPT=0` により**ハングせず失敗**し、対処方法を表示する。

---

## 2. トンネルの 2 方式

`cloudflared` のトンネルには 2 通りある。本フォルダの `install.sh` は両方に対応する。

### A. リモート管理トンネル（推奨・トークン方式）

Cloudflare ダッシュボードでトンネルを作成し、**トークン**だけをサーバーへ渡す方式。
ルーティング（どのホスト名をどのサービスへ）はダッシュボード側で管理する。

1. Cloudflare ダッシュボード → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**
2. **Cloudflared** を選択 → トンネル名を入力（例 `oauth`）
3. 表示される **トークン**（`eyJ...` で始まる長い文字列）を控える
4. **Public Hostname** タブで公開ホスト名を追加する
   - **Subdomain / Domain**: `auth.example.com`
   - **Service**: `HTTP` → `localhost:3000`
   - 追加の **HTTP Settings** は既定でよい（`httpHostHeader` は空のままでよい。理由は §6）
5. サーバーで:

```bash
sudo cloudflared service install <TUNNEL_TOKEN>
```

これで `cloudflared` が systemd サービスとして登録され、起動する。

### B. ローカル管理トンネル（証明書 + config.yml 方式）

サーバー側でトンネルを作成し、`config.yml` で ingress を定義する方式。

```bash
# ブラウザで Cloudflare にログイン（表示された URL を開く）
cloudflared tunnel login

# トンネル作成（名前は自由。ホスト名とは別物）
cloudflared tunnel create oauth

# DNS ルートを作成（auth.example.com → トンネル）
cloudflared tunnel route dns oauth auth.example.com

# 設定ファイルを設置（本フォルダの config.yml.example を参照）
sudo mkdir -p /etc/cloudflared
sudo cp config.yml.example /etc/cloudflared/config.yml
sudo cp ~/.cloudflared/<TUNNEL_UUID>.json /etc/cloudflared/
sudo sed -i "s/<TUNNEL_UUID>/$(cloudflared tunnel list -o json | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["id"])')/" /etc/cloudflared/config.yml

# サービスとして常駐
sudo cloudflared service install
sudo systemctl restart cloudflared
```

`config.yml.example` の中身（本フォルダ同梱）:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: auth.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

> `ingress` の最後は必ず `service: http_status:404` にする（マッチしないホストを明示的に拒否）。

---

## 3. アプリ本体の導入

`install.sh` は §3〜§5 を自動で行う。手動の場合:

```bash
# 専用ユーザー（ログイン不可）
sudo useradd --system --create-home --home-dir /srv/oauth --shell /usr/sbin/nologin oauth

# リポジトリ（PRIVATE のためトークンかデプロイキーが必要。§1.1 参照）
sudo -u oauth mkdir -p /srv/oauth/app
sudo -u oauth git clone https://x-access-token:$GITHUB_TOKEN@github.com/yuushi2024/oauth.git /srv/oauth/app
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && git remote set-url origin https://github.com/yuushi2024/oauth.git'

# 依存関係（tsx が本番でも必要なので --prod は使わない）
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm install --frozen-lockfile'

# シークレット生成（.env を 600 で作成）
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm secrets:gen'

# OIDC を使う場合のみ署名鍵・暗号鍵を生成
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm oidc:keygen'

# migration と roles 投入
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm db:migrate && pnpm seed'

# ビルド
sudo -u oauth -H bash -lc 'cd /srv/oauth/app && pnpm build'
```

Node.js / pnpm / PostgreSQL 16 の導入は `docs/phase9-デプロイ手順.md` §3〜§4 と同じ。
`install.sh` はこれらも「未導入なら導入、導入済みならスキップ」で処理する。

---

## 4. 環境変数（Tunnel 方式の要点）

`.env` は `docs/phase9-デプロイ手順.md` §6 とほぼ同じだが、**Tunnel 方式では以下が異なる**。

```dotenv
NODE_ENV=production
NEXT_PUBLIC_APP_URL=https://auth.example.com      # 公開ホスト名
OIDC_ISSUER=https://auth.example.com              # OIDC を使う場合（同一 origin）

# --- Cloudflare Tunnel の背後であることをアプリへ伝える（重要） ---
TRUSTED_PROXY_HOPS=1                              # Cloudflare エッジを 1 段として信頼
TRUSTED_PROXY_HEADER=cf-connecting-ip             # Cloudflare が付けるクライアント IP
ALLOWED_HOSTS=auth.example.com                    # HTTPS リダイレクトで許可する Host

# --- Passkey / WebAuthn（本番は必須） ---
WEBAUTHN_RP_ID=auth.example.com                   # ポートを含めない登録可能ドメイン
WEBAUTHN_ALLOWED_ORIGINS=https://auth.example.com
```

**なぜこれが必要か**: アプリは「HTTPS かどうか」を `X-Forwarded-Proto` から判定する。
Cloudflare のエッジはこのヘッダを付与するので、`TRUSTED_PROXY_HOPS=1` を設定すると
アプリはリクエストを HTTPS と認識し、`__Host-` Cookie・HSTS・OIDC の https 要件を満たせる。
`TRUSTED_PROXY_HOPS=0` のままだと HTTPS 判定に失敗し、リダイレクトループや Cookie 不保存が起きる。

> `TRUSTED_PROXY_HEADER=cf-connecting-ip` は「クライアント IP の取得元」を指定する。
> Cloudflare を必ず経由する Tunnel 方式では `cf-connecting-ip` が正しい（生 IP をログへ残さず、
> `IP_HASH_PEPPER` でハッシュ化して保存する設計・§45）。

---

## 5. systemd（アプリ）

`docs/phase9-デプロイ手順.md` §10 と同じ。Tunnel 方式では **`HOSTNAME=127.0.0.1`** にして
外部から直接 3000 へ到達できないようにする（到達経路は Tunnel だけにする）。

```ini
[Service]
Environment=NODE_ENV=production
Environment=HOSTNAME=127.0.0.1
Environment=PORT=3000
ExecStart=/usr/local/bin/pnpm start
```

`/etc/systemd/system/oauth.service` の全文は `docs/phase9-デプロイ手順.md` §10.1 を参照。

---

## 6. Cloudflare 側の設定（ログ漏洩対策・§17.2.1）

`deploy/cloudflare.md` の内容がそのまま当てはまる。要点:

- **Logpush / Analytics で query string を保存しない**（`ClientRequestPath` のみ使う、または
  `ClientRequestURI` を送らない）。認証トークン付き URL（`/verify-email?token=` 等）を守る。
- **WAF / Managed Rules** を有効化。Turnstile はアプリ側で siteverify する。
- 公開ホスト名の **HTTP Settings で `httpHostHeader` を空のままにする**。
  ここで `auth.example.com` を設定すると、アプリが受け取る Host が `localhost:3000` のままになり、
  OIDC の `validOidcRequestOrigin`（Host と `OIDC_ISSUER` の host 一致を要求）が失敗する。
  **空のままだと元の Host がそのまま渡り、OIDC が正しく動く。**

> 実地確認は `deploy/log-security-checklist.md` を使う。`curl` で `KNOWN-VALUE` を付け、
> Logpush / Analytics / アプリログのどこにも値が出ないことを確認し、記録欄へ残す。

---

## 7. 動作確認

```bash
# 1. アプリのローカル疎通（Tunnel を介さない）
curl -s http://127.0.0.1:3000/api/health
# {"status":"ok"}

# 2. Tunnel の状態
sudo systemctl status cloudflared --no-pager
sudo journalctl -u cloudflared -n 50 --no-pager

# 3. 公開ホスト名経由
curl -sI https://auth.example.com/api/health
# HTTP/2 200 が返れば成功

# 4. OIDC を使う場合
curl -s https://auth.example.com/.well-known/openid-configuration | head
```

うまくいかないときは §9 のトラブルシューティングを見る。

---

## 8. 定期ジョブ・バックアップ

`docs/phase9-運用ランブック.md` の cron（purge / backup / alert:check / logs:scan）と
`docs/phase9-バックアップ復元手順.md` の手順をそのまま使う。Tunnel 方式でもアプリ側は同じ。

---

## 9. トラブルシューティング

| 症状                                               | 原因の候補                             | 対処                                                                                                                 |
| -------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `https://auth.example.com` が 502 / 1033           | cloudflared は動くが origin に届かない | `curl http://127.0.0.1:3000/api/health` を確認。アプリが 127.0.0.1:3000 で listen しているか（`HOSTNAME=127.0.0.1`） |
| リダイレクトループ                                 | `TRUSTED_PROXY_HOPS=0`                 | `TRUSTED_PROXY_HOPS=1` にする（§4）                                                                                  |
| ログインが維持されない / Cookie が付かない         | HTTPS 判定失敗                         | 同上。`NODE_ENV=production` も確認                                                                                   |
| OIDC で 400 `Invalid OIDC request origin`          | `httpHostHeader` を設定してしまった    | Cloudflare の公開ホスト名 HTTP Settings の `httpHostHeader` を**空**にする（§6）                                     |
| OIDC で `OIDC_ISSUER must use HTTPS in production` | `OIDC_ISSUER` が http                  | `https://auth.example.com` にする                                                                                    |
| cloudflared が起動しない                           | トークン不正 / トンネル未作成          | `sudo journalctl -u cloudflared -n 100`。ダッシュボードでトークンを再取得                                            |
| 名前解決できない                                   | DNS が Cloudflare 管理でない           | ネームサーバーを Cloudflare に向け、公開ホスト名を追加する                                                           |
| 403 が Cloudflare から返る                         | WAF / Bot Fight Mode                   | WAF イベントを確認。正規トラフィックならルールを調整                                                                 |

ログ:

```bash
sudo journalctl -u oauth -n 200 --no-pager
sudo journalctl -u cloudflared -n 200 --no-pager
```

---

## 10. 完了チェックリスト

- [ ] Cloudflare でトンネルを作成し、公開ホスト名（`auth.example.com` → `http://localhost:3000`）を追加した
- [ ] `httpHostHeader` を**空**のままにした（OIDC のため）
- [ ] `cloudflared` が systemd サービスとして稼働している
- [ ] アプリが `NODE_ENV=production` / `HOSTNAME=127.0.0.1` で稼働している
- [ ] `TRUSTED_PROXY_HOPS=1` / `TRUSTED_PROXY_HEADER=cf-connecting-ip` / `ALLOWED_HOSTS` を設定した
- [ ] `WEBAUTHN_RP_ID` / `WEBAUTHN_ALLOWED_ORIGINS` を公開ホスト名に合わせた
- [ ] `https://auth.example.com/api/health` が 200 を返す
- [ ] ポート 3000 / 5432 / 80 / 443 が**内向きに公開されていない**（Tunnel のみ）
- [ ] `deploy/log-security-checklist.md` の実地確認を記録した
- [ ] `pnpm backup` → 別 DB への復元テストを 1 回実施した
- [ ] cron（purge / backup / alert:check / logs:scan）を登録した
- [ ] 最初の管理者を作成し、TOTP を有効化した

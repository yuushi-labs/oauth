#!/usr/bin/env bash
#
# Cloudflare Tunnel 方式で「超本格アカウント・認証システム」をデプロイする自動化スクリプト。
#
# 特徴:
#   - root 以外で実行されたら自動で sudo で再実行する
#   - Node.js / pnpm / git / curl / PostgreSQL 16 / cloudflared を「無ければ入れる・あればスキップ」
#   - 専用ユーザー oauth を作成し、アプリをそのユーザーで動かす
#   - サーバー自身のホスト名は変更しない（公開ホスト名だけを Cloudflare 側で扱う）
#   - 外向きトンネルのみ。内向きポート（80/443/3000/5432）は公開しない
#
# 使い方:
#   # リモート管理トンネル（推奨）。トークンは Cloudflare ダッシュボードで取得する。
#   sudo CF_TUNNEL_TOKEN='eyJ...' ./install.sh
#
#   # ドメインだけ変えたい場合（既定 auth.example.com）
#   sudo CF_TUNNEL_TOKEN='eyJ...' DOMAIN=auth.mydomain.com ./install.sh
#
#   # OIDC Provider も有効化する（署名鍵・暗号鍵を生成して .env へ入れる）
#   sudo CF_TUNNEL_TOKEN='eyJ...' ./install.sh --oidc
#
#   # トークンを後で入れる（まずアプリだけ入れて、あとで cloudflared を設定する）
#   sudo ./install.sh --no-tunnel
#
# 再実行しても安全（idempotent）。既存の .env のシークレットは保持する。
#
set -euo pipefail

# sudo で再実行するときに引数を失わないよう、元の引数を控えておく
ORIG_ARGS=("$@")

# --help は root 権限が無くても読めるように、ここで先に処理する。
for a in "$@"; do
  case "$a" in
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

# ---------------------------------------------------------------------------
# root でなければ sudo で再実行する
#
# 設定の既定値を適用する「前」に行う。ここでは利用者が明示した環境変数だけが
# 存在するので、それをそのまま引き継げばよい。
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    echo "root 権限が必要です。sudo で再実行します..."
    # `sudo -E` は sudoers の env_reset で弾かれることがあるため、
    # 引き継ぎたい変数のうち「設定済みのもの」だけを明示的に渡す。
    FORWARD=()
    for v in DOMAIN REPO_URL REPO_BRANCH APP_USER APP_DIR APP_PORT APP_HOST \
             DB_NAME DB_USER DB_HOST DB_PORT PNPM_VERSION NODE_MAJOR \
             CF_TUNNEL_TOKEN GITHUB_TOKEN; do
      if [ -n "${!v:-}" ]; then FORWARD+=("${v}=${!v}"); fi
    done
    exec sudo env "${FORWARD[@]}" bash "$0" "${ORIG_ARGS[@]}"
  fi
  echo "エラー: root で実行してください（sudo が見つかりません）。" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 設定（環境変数で上書き可能）
# ---------------------------------------------------------------------------
DOMAIN="${DOMAIN:-auth.example.com}"            # 公開ホスト名（変更するのはここだけ）
REPO_URL="${REPO_URL:-https://github.com/yuushi2024/oauth.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
APP_USER="${APP_USER:-oauth}"
APP_DIR="${APP_DIR:-/srv/oauth/app}"
APP_PORT="${APP_PORT:-3000}"
APP_HOST="${APP_HOST:-127.0.0.1}"               # Tunnel からだけ到達できるよう localhost 固定
DB_NAME="${DB_NAME:-app}"
DB_USER="${DB_USER:-app}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
PNPM_VERSION="${PNPM_VERSION:-11.13.1}"
NODE_MAJOR="${NODE_MAJOR:-24}"
# pnpm / node のあるディレクトリ。pnpm 導入後に実際の場所へ更新する（§3）。
APP_BIN_DIR="${APP_BIN_DIR:-/usr/local/bin}"
CF_TUNNEL_TOKEN="${CF_TUNNEL_TOKEN:-}"
SETUP_OIDC=0
SETUP_TUNNEL=1
LOG_DIR="/var/log/oauth"
SECRET_DIR="/etc/oauth"
DB_PASSWORD_FILE="${SECRET_DIR}/db-password"
ENV_FILE="${APP_DIR}/.env"

# ---------------------------------------------------------------------------
# 引数
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --oidc) SETUP_OIDC=1 ;;
    --no-tunnel) SETUP_TUNNEL=0 ;;
    --token=*) CF_TUNNEL_TOKEN="${1#*=}" ;;
    --domain=*) DOMAIN="${1#*=}" ;;
    *) echo "不明な引数: $1（--help 参照）" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# ヘルパ
# ---------------------------------------------------------------------------
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m警告:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mエラー:\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# アプリ用ユーザーとしてコマンドを実行する。
# -H で HOME をそのユーザーのものにし、PATH を明示する（login shell が
# npm グローバルの bin を PATH から落とす環境でも pnpm / node を見つけられるように）。
as_app() {
  sudo -u "$APP_USER" -H env PATH="${APP_BIN_DIR}:/usr/local/bin:/usr/bin:/bin" bash -lc "$1"
}

# .env の KEY を VALUE に設定（無ければ追記）。値は Python で安全に書き込む。
set_env() {
  local key="$1" val="$2"
  [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
  KEY="$key" VAL="$val" FILE="$ENV_FILE" python3 - <<'PY'
import os, re
f, k, v = os.environ['FILE'], os.environ['KEY'], os.environ['VAL']
try:
    lines = open(f, encoding='utf-8').read().splitlines()
except FileNotFoundError:
    lines = []
out, done = [], False
for line in lines:
    if re.match(rf'^{re.escape(k)}=', line):
        out.append(f'{k}={v}'); done = True
    else:
        out.append(line)
if not done:
    out.append(f'{k}={v}')
open(f, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PY
}

# ---------------------------------------------------------------------------
# OS / パッケージマネージャの判定
# ---------------------------------------------------------------------------
if [ -f /etc/os-release ]; then . /etc/os-release; fi
OS_ID="${ID:-unknown}"
PKG=""
if have apt-get; then PKG=apt
elif have dnf; then PKG=dnf
elif have yum; then PKG=yum
else die "対応していないパッケージマネージャです（apt / dnf / yum のいずれかが必要）。"
fi
log "OS: ${PRETTY_NAME:-$OS_ID} / パッケージマネージャ: $PKG"

# 対話プロンプトを出さない（Debian の needrestart 等）
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

pkg_install() {
  case "$PKG" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" ;;
    dnf) dnf install -y "$@" ;;
    yum) yum install -y "$@" ;;
  esac
}
pkg_update() {
  case "$PKG" in
    apt) apt-get update -y ;;
    dnf) dnf -y makecache ;;
    yum) yum -y makecache ;;
  esac
}

# ---------------------------------------------------------------------------
# 1. 基本ツール（git / curl / ca-certificates / ビルドチェーン）
# ---------------------------------------------------------------------------
log "基本ツールを確認します（無ければ導入）"
pkg_has() {
  case "$PKG" in
    apt) dpkg -s "$1" >/dev/null 2>&1 ;;
    dnf|yum) rpm -q "$1" >/dev/null 2>&1 ;;
  esac
}
MISSING=()
for c in git curl; do have "$c" || MISSING+=("$c"); done
pkg_has ca-certificates || MISSING+=(ca-certificates)
# ネイティブモジュール（@node-rs/argon2 / esbuild）のビルド用
case "$PKG" in
  apt) have gcc || MISSING+=(build-essential); have python3 || MISSING+=(python3) ;;
  dnf|yum) have gcc || MISSING+=(gcc-c++ make); have python3 || MISSING+=(python3) ;;
esac
# curl が無いと後続の取得ができないので、先に apt/dnf で入れる
if [ "${#MISSING[@]}" -gt 0 ]; then
  log "導入: ${MISSING[*]}"
  pkg_update
  pkg_install "${MISSING[@]}"
else
  log "基本ツールは揃っています（スキップ）"
fi
have git || die "git の導入に失敗しました。"
have curl || die "curl の導入に失敗しました。"

# ---------------------------------------------------------------------------
# 2. Node.js（>= 22。既定は 24 系）
# ---------------------------------------------------------------------------
need_node=1
if have node; then
  NODE_VER="$(node -v | sed 's/^v//')"
  NODE_CUR_MAJOR="${NODE_VER%%.*}"
  if [ "${NODE_CUR_MAJOR:-0}" -ge 22 ] 2>/dev/null; then
    log "Node.js v${NODE_VER} は要件（>=22）を満たします（スキップ）"
    need_node=0
  else
    warn "Node.js v${NODE_VER} は古いため ${NODE_MAJOR} 系へ更新します"
  fi
fi
if [ "$need_node" -eq 1 ]; then
  log "Node.js ${NODE_MAJOR} を導入します"
  case "$PKG" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      pkg_install nodejs
      ;;
    dnf|yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      pkg_install nodejs
      ;;
  esac
fi
have node || die "Node.js の導入に失敗しました。"
log "node: $(node -v)"

# ---------------------------------------------------------------------------
# 3. pnpm（指定バージョン。corepack ではなく npm グローバル導入＝systemd で安全）
# ---------------------------------------------------------------------------
if have pnpm && [ "$(pnpm -v 2>/dev/null)" = "$PNPM_VERSION" ]; then
  log "pnpm ${PNPM_VERSION} は導入済みです（スキップ）"
else
  log "pnpm ${PNPM_VERSION} を導入します"
  npm install -g "pnpm@${PNPM_VERSION}"
fi
PNPM_BIN="$(command -v pnpm)"
# systemd / as_app は PATH が最小なので、実在する bin ディレクトリを控えて明示的に渡す。
APP_BIN_DIR="$(dirname "$PNPM_BIN")"
log "pnpm: ${PNPM_BIN} ($(pnpm -v))"

# ---------------------------------------------------------------------------
# 4. PostgreSQL 16
# ---------------------------------------------------------------------------
need_pg=1
if have psql; then
  PG_VER="$(psql --version | grep -oE '[0-9]+' | head -1)"
  if [ "${PG_VER:-0}" -ge 16 ] 2>/dev/null; then
    log "PostgreSQL ${PG_VER} は導入済みです（スキップ）"
    need_pg=0
  else
    warn "PostgreSQL ${PG_VER} は古いため 16 を導入します"
  fi
fi
if [ "$need_pg" -eq 1 ]; then
  log "PostgreSQL 16 を導入します"
  case "$PKG" in
    apt)
      install -d /usr/share/postgresql-common/pgdg
      curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc
      . /etc/os-release
      echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list
      pkg_update
      pkg_install postgresql-16 postgresql-client-16
      ;;
    dnf|yum)
      RHEL_MAJOR="$(rpm -E '%{rhel}' 2>/dev/null || echo 9)"
      pkg_install "https://download.postgresql.org/pub/repos/yum/reporpms/EL-${RHEL_MAJOR}-x86_64/pgdg-redhat-repo-latest.noarch.rpm" || true
      dnf -qy module disable postgresql || true
      pkg_install postgresql16-server postgresql16
      /usr/pgsql-16/bin/postgresql-16-setup initdb || true
      ;;
  esac
fi
have psql || die "psql が見つかりません。PostgreSQL の導入に失敗しました。"

# サービスの起動（Debian は postgresql、RHEL は postgresql-16）
if systemctl list-unit-files --type=service 2>/dev/null | grep -q '^postgresql\.service'; then
  systemctl enable --now postgresql
elif systemctl list-unit-files --type=service 2>/dev/null | grep -q '^postgresql-16\.service'; then
  systemctl enable --now postgresql-16
fi

# ---------------------------------------------------------------------------
# 5. DB とロールの作成（idempotent）
# ---------------------------------------------------------------------------
install -d -m 0750 "$SECRET_DIR"
if [ -f "$DB_PASSWORD_FILE" ]; then
  DB_PASSWORD="$(cat "$DB_PASSWORD_FILE")"
  log "既存の DB パスワードを使用します"
else
  # URL に埋め込むため URL 安全な hex にする（base64 は / + = を含み DATABASE_URL を壊す）
  DB_PASSWORD="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '%s' "$DB_PASSWORD" > "$DB_PASSWORD_FILE"
  chmod 600 "$DB_PASSWORD_FILE"
  log "DB パスワードを生成しました: $DB_PASSWORD_FILE"
fi

psql_admin() { sudo -u postgres psql -v ON_ERROR_STOP=1 -tAc "$1"; }

if [ "$(psql_admin "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'")" = "1" ]; then
  psql_admin "ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}'" >/dev/null
  log "ロール ${DB_USER} は存在します（パスワードを同期）"
else
  psql_admin "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}'" >/dev/null
  log "ロール ${DB_USER} を作成しました"
fi
if [ "$(psql_admin "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")" = "1" ]; then
  log "データベース ${DB_NAME} は存在します（スキップ）"
else
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
    "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0" >/dev/null
  log "データベース ${DB_NAME} を作成しました"
fi

# ---------------------------------------------------------------------------
# 6. 専用ユーザーの作成
# ---------------------------------------------------------------------------
if id "$APP_USER" >/dev/null 2>&1; then
  log "ユーザー ${APP_USER} は存在します（スキップ）"
else
  useradd --system --create-home --home-dir "/srv/${APP_USER}" --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null \
    || useradd --system --create-home --home-dir "/srv/${APP_USER}" --shell /sbin/nologin "$APP_USER"
  log "ユーザー ${APP_USER} を作成しました"
fi

# ---------------------------------------------------------------------------
# 7. リポジトリの取得と依存関係
# ---------------------------------------------------------------------------
install -d -o "$APP_USER" -g "$APP_USER" "/srv/${APP_USER}"

# プライベートリポジトリ用の clone URL を組み立てる。
# GITHUB_TOKEN があれば HTTPS に埋め込む（clone 後に remote をきれいな URL へ戻す）。
# 無ければ SSH（デプロイキー）を期待する。どちらも無い場合に備え、対話プロンプトは無効化する。
CLONE_URL="$REPO_URL"
NEEDS_TOKEN_STRIP=0
if [ -n "${GITHUB_TOKEN:-}" ]; then
  case "$REPO_URL" in
    https://github.com/*)
      CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL#https://github.com/}"
      NEEDS_TOKEN_STRIP=1
      ;;
  esac
fi

export GIT_TERMINAL_PROMPT=0   # 認証が要るならハングせず失敗させる

if [ -d "${APP_DIR}/.git" ]; then
  log "リポジトリは取得済みです。更新します"
  as_app "cd '${APP_DIR}' && git fetch --all --prune && git checkout '${REPO_BRANCH}' && git pull --ff-only origin '${REPO_BRANCH}'" \
    || warn "リポジトリの更新に失敗しました（ローカル変更がある可能性）。手動で確認してください。"
else
  install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
  log "リポジトリを clone します: ${REPO_URL}"
  if ! as_app "git clone --branch '${REPO_BRANCH}' '${CLONE_URL}' '${APP_DIR}'"; then
    die "clone に失敗しました。リポジトリは PRIVATE です。次のいずれかを行ってください:
    A) GITHUB_TOKEN を渡して再実行:  sudo GITHUB_TOKEN=<token> ./install.sh ...
    B) デプロイキー（SSH）を使う:      REPO_URL=git@github.com:yuushi2024/oauth.git sudo ./install.sh ..."
  fi
  # トークンを .git/config に残さない
  if [ "$NEEDS_TOKEN_STRIP" -eq 1 ]; then
    as_app "cd '${APP_DIR}' && git remote set-url origin '${REPO_URL}'"
  fi
fi

log "依存関係を導入します（--prod は使わない: tsx が本番でも必要）"
as_app "cd '${APP_DIR}' && pnpm install --frozen-lockfile"

# ---------------------------------------------------------------------------
# 8. 環境変数（.env）
# ---------------------------------------------------------------------------
log "シークレットを生成します（既存値は保持）"
as_app "cd '${APP_DIR}' && pnpm secrets:gen"

log ".env に本番設定を書き込みます"
set_env NODE_ENV production
set_env NEXT_PUBLIC_APP_NAME oauth
set_env NEXT_PUBLIC_APP_URL "https://${DOMAIN}"
set_env DATABASE_URL "postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
# Cloudflare Tunnel の背後であることをアプリへ伝える（HTTPS 判定とクライアント IP）
set_env TRUSTED_PROXY_HOPS 1
set_env TRUSTED_PROXY_HEADER cf-connecting-ip
set_env ALLOWED_HOSTS "${DOMAIN}"
# Passkey / WebAuthn（本番は必須）
set_env WEBAUTHN_RP_ID "${DOMAIN}"
set_env WEBAUTHN_RP_NAME oauth
set_env WEBAUTHN_ALLOWED_ORIGINS "https://${DOMAIN}"

# OIDC Provider を有効化する場合
if [ "$SETUP_OIDC" -eq 1 ]; then
  set_env OIDC_ISSUER "https://${DOMAIN}"
  if grep -q '^OIDC_JWKS_JSON=' "$ENV_FILE" 2>/dev/null; then
    log "OIDC 鍵は既に .env にあります（スキップ）"
  else
    log "OIDC 署名鍵・暗号鍵を生成します"
    OIDC_OUT="$(as_app "cd '${APP_DIR}' && pnpm oidc:keygen" || true)"
    KEY_VAL="$(printf '%s\n' "$OIDC_OUT" | sed -n 's/^OIDC_ADAPTER_ENCRYPTION_KEY=//p' | head -1)"
    JWKS_VAL="$(printf '%s\n' "$OIDC_OUT" | sed -n 's/^OIDC_JWKS_JSON=//p' | head -1)"
    if [ -n "$KEY_VAL" ] && [ -n "$JWKS_VAL" ]; then
      # 既存キーがあっても重複しないよう set_env で上書きする
      set_env OIDC_ADAPTER_ENCRYPTION_KEY "$KEY_VAL"
      set_env OIDC_JWKS_JSON "$JWKS_VAL"
      log "OIDC 鍵を .env へ書き込みました"
    else
      warn "OIDC 鍵の生成出力を解釈できませんでした。次のコマンドを実行して手動で .env へ追記してください:"
      warn "  sudo -u ${APP_USER} -H bash -lc 'cd ${APP_DIR} && pnpm oidc:keygen'"
      warn "  → 出力の OIDC_ADAPTER_ENCRYPTION_KEY=... と OIDC_JWKS_JSON=... の 2 行を ${ENV_FILE} に追加"
    fi
  fi
fi

chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------------------
# 9. migration と初期データ、ビルド
# ---------------------------------------------------------------------------
log "migration を適用します"
as_app "cd '${APP_DIR}' && pnpm db:migrate"
log "roles を投入します"
as_app "cd '${APP_DIR}' && pnpm seed"
log "ビルドします"
as_app "cd '${APP_DIR}' && pnpm build"

# ---------------------------------------------------------------------------
# 10. systemd（アプリ）
# ---------------------------------------------------------------------------
install -d -o "$APP_USER" -g "$APP_USER" "$LOG_DIR"
install -d -o "$APP_USER" -g "$APP_USER" "${APP_DIR}/backups"

log "systemd ユニットを作成します: /etc/systemd/system/oauth.service"
cat > /etc/systemd/system/oauth.service <<EOF
[Unit]
Description=oauth (Next.js + OIDC Provider)
Documentation=${REPO_URL}
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}

Environment=NODE_ENV=production
# Tunnel からだけ到達できるよう localhost のみ listen する（内向きポートは公開しない）
Environment=HOSTNAME=${APP_HOST}
Environment=PORT=${APP_PORT}

ExecStart=${PNPM_BIN} start
Restart=always
RestartSec=3
TimeoutStopSec=20
KillSignal=SIGTERM

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${APP_DIR}/.next ${APP_DIR}/backups ${LOG_DIR}
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable oauth >/dev/null 2>&1 || true
systemctl restart oauth

# ---------------------------------------------------------------------------
# 11. cloudflared
# ---------------------------------------------------------------------------
if [ "$SETUP_TUNNEL" -eq 1 ]; then
  if have cloudflared; then
    log "cloudflared は導入済みです（スキップ）: $(cloudflared --version 2>/dev/null | head -1)"
  else
    log "cloudflared を導入します"
    case "$PKG" in
      apt)
        curl -fsSL -o /tmp/cloudflared.deb \
          https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
        dpkg -i /tmp/cloudflared.deb || apt-get -f install -y
        rm -f /tmp/cloudflared.deb
        ;;
      dnf|yum)
        curl -fsSL -o /tmp/cloudflared.rpm \
          https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm
        rpm -ivh --replacepkgs /tmp/cloudflared.rpm || true
        rm -f /tmp/cloudflared.rpm
        ;;
    esac
  fi

  if [ -n "$CF_TUNNEL_TOKEN" ]; then
    log "リモート管理トンネルを登録します（トークン方式）"
    # 既存サービスがあれば作り直す
    systemctl stop cloudflared >/dev/null 2>&1 || true
    cloudflared service install "$CF_TUNNEL_TOKEN"
    systemctl enable cloudflared >/dev/null 2>&1 || true
    systemctl restart cloudflared
    log "cloudflared サービスを起動しました"
  elif [ -f /etc/cloudflared/config.yml ]; then
    log "ローカル管理トンネル（/etc/cloudflared/config.yml）を登録します"
    cloudflared service install
    systemctl enable cloudflared >/dev/null 2>&1 || true
    systemctl restart cloudflared
    log "cloudflared サービスを起動しました"
  else
    warn "トンネルが未設定です。次のいずれかを行ってください:"
    warn "  A) ダッシュボードでトンネルを作成し、sudo cloudflared service install <TOKEN> を実行"
    warn "  B) cloudflared tunnel login → create → route dns → /etc/cloudflared/config.yml を配置して"
    warn "     sudo cloudflared service install"
    warn "詳細は deploy/cloudflare-tunnel/README.md を参照。"
  fi
fi

# ---------------------------------------------------------------------------
# 12. 動作確認
# ---------------------------------------------------------------------------
log "アプリの起動を待ちます..."
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://${APP_HOST}:${APP_PORT}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done

echo
echo "==================== 結果 ===================="
if [ "$ok" -eq 1 ]; then
  echo "アプリ: 正常（http://${APP_HOST}:${APP_PORT}/api/health）"
  curl -fsS "http://${APP_HOST}:${APP_PORT}/api/health"; echo
else
  echo "アプリ: 起動を確認できませんでした。ログを確認してください:"
  echo "  sudo journalctl -u oauth -n 100 --no-pager"
fi
if [ "$SETUP_TUNNEL" -eq 1 ] && systemctl is-active --quiet cloudflared 2>/dev/null; then
  echo "cloudflared: 稼働中"
else
  echo "cloudflared: 未設定または停止中"
fi
echo
echo "公開 URL: https://${DOMAIN}"
echo "アプリのログ:      sudo journalctl -u oauth -n 200 --no-pager"
echo "cloudflared ログ:  sudo journalctl -u cloudflared -n 200 --no-pager"
echo
echo "次の作業:"
echo "  1. ブラウザで https://${DOMAIN}/register から最初のユーザーを登録し、メール確認を完了する"
echo "     （メールを使うには .env の RESEND_API_KEY / EMAIL_FROM を設定して再起動）"
echo "  2. 管理者を付与: sudo -u ${APP_USER} -H bash -lc 'cd ${APP_DIR} && pnpm admin:grant <email> --role admin'"
echo "  3. ログ漏洩対策の実地確認: deploy/log-security-checklist.md"
echo "  4. cron 登録: docs/phase9-運用ランブック.md §1"
echo "  5. 内向きポート（80/443/${APP_PORT}/5432）を公開していないことを確認する"
echo "============================================="

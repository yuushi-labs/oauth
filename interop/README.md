# ソーシャルログインの client ID / client secret 取得手順

> 対象: `docs/phase4-oauth-social-login-実装計画.md`（Phase 4）の前提作業
> 目的: Google / GitHub / Discord の OAuth アプリを作成し、**client ID と client secret を取得して `.env` に記入する**
> ここまで済ませていないと、Phase 4 の**実フローの疎通確認が一切できません**（provider への到達・callback・email 取得を実測できない）

---

## 0. 全体像

```text
① 各 provider のコンソールで OAuth アプリを作る
        ↓
② Client ID と Client Secret が発行される（GitHub は secret が一度しか見えない）
        ↓
③ リダイレクトURI を登録する（完全一致。末尾スラッシュも大事）
        ↓
④ .env に記入する（git には入らない）
        ↓
⑤ /login のボタンが現れる（registry 駆動。自動）
        ↓
⑥ 疎通確認（下の「確認コマンド」）
```

### 先に決めておくこと：redirect URI

**3 provider 共通で、この文字列を完全一致で登録します。**

| 環境 | 登録する URI |
|---|---|
| ローカル開発 | `http://localhost:3000/api/auth/oauth/google/callback` |
| | `http://localhost:3000/api/auth/oauth/github/callback` |
| | `http://localhost:3000/api/auth/oauth/discord/callback` |
| 本番（Phase 9） | `https://<本番ドメイン>/api/auth/oauth/<provider>/callback` |

**3 つとも、この文字列以外を "Authorized redirect URI" に入れてはいけません。**
許可リストに登録された URI 以外への code 発行は provider 側で拒否されます。

> ### ⚠️ いちばん多い詰まりどころ
>
> | 症状 | 原因 |
> |---|---|
> | `redirect_uri_mismatch` | 末尾に `/` が違う、ポートが違う、`localhost` と `127.0.0.1` が混在 |
> | 登録_URI_が見つからない | 登録-Adress は `localhost`、`.env` の `NEXT_PUBLIC_APP_URL` は `127.0.0.1` など **origin がずれている** |
>
> **対策**: 本プロジェクトは redirect URI を実行環境から**自動生成しません**（`NEXT_PUBLIC_APP_URL` から明示的に組み立てます）。
> つまり **`.env` の `NEXT_PUBLIC_APP_URL` と、provider に登録した URI の origin を必ず一致させてください。**
> どれを使うかは最初に決めて、それを全 provider で統一するのが一番確実です。

---

## 1. Google

方式は OIDC（ID Token で `email` / `email_verified` が取れる）。

### 手順

1. <https://console.cloud.google.com/> にログイン
2. 画面上部のプロジェクト選択で、**OAuth 用のプロジェクトを選ぶ**（無いなら新規作成）
3. 左メニュー **「API とサービス」→「OAuth 同意画面」**
   - 利用数据类型：**外部**（自分のアカウントで検証するだけなら「内部」 Glue でも可）
   - アプリ名・サポートメール・開発者メールアドレスを入力して保存
   - **Scopes** は `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `openid` を追加
     （または Step 6 のスコープは自動来这里に追加される場合あり。`auth/userinfo.email` が一番重要）
4. 左メニュー **「認証情報」→「認証情報を作成」→「OAuth クライアント ID」**
5. アプリケーションタイプ：**「ウェブアプリケーション」**を選ぶ（**「Other platforms」ではない方**）
6. 名前を入力（例: `oauth-dev`）
7. **「承認済みリダイレクト URI」**に以下を追加:
   ```
   http://localhost:3000/api/auth/oauth/google/callback
   ```
8. **作成**を押すと、**クライアント ID** と **クライアントシークレット**が表示される → 控えておく（シークレットはこの画面で以後再表示できない場合があるため）
9. 同意画面が「テスト中」の状態だと、**テストユーザーに追加した Google アカウントだけ**ログインできる。
   検証時は **「テストユーザーを追加」** で自分のアカウントを追加する

### 取得的値

```
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxx
```

### 補足

- `access_type=online` を付けるので **refresh token は出让されない**（設計 D-06）
- 本番で公開する場合は「公開アプリ」にする＝レビュー必須。**Phase 4 では公開しない**（テストモードで十分）
- ID Token の署名は `RS256` 固定。検証は `jose` で行う（`jose` の JWK Set URL: `https://www.googleapis.com/oauth2/v3/certs`）

---

## 2. GitHub

方式は OAuth2（ID Token は無い）。**email は `/user/emails` を別途叩く必要がある**。

### 手順

1. GitHub にログイン → <https://github.com/settings/developers> を開く
2. **「OAuth Apps」** を選択（OAuth Apps と GitHub Apps は別物。**OAuth Apps** を使う）
3. **「New OAuth App」** を押す（2 回目以降は「Update existing OAuth App」）
4. 入力:
   - Application name: `oauth-dev`（画面に表示されるだけなので何でもよい）
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL:
     ```
     http://localhost:3000/api/auth/oauth/github/callback
     ```
5. **「Create OAuth App」** を押す
6. 遷移後の画面に **「Generate a new client secret」** ボタンがある → 押すと
   **Client secret が表示される（この画面を離れると二度と表示されない）** → **今すぐ控えておく**
7. 登録情報の上部に **Client ID** が表示されている（`.apps.github.com` で終わる）

### 取得した値

```
GITHUB_CLIENT_ID=Iv1.1234567890abcdef
GITHUB_CLIENT_SECRET=（32文字の16進風）
```

### ⚠️ GitHub 固有の注意

| 項目 | 内容 |
|---|---|
| client secret は 1 回しか見えない | 見落とした場合は「Generate a new client secret」で再生成（古いのは無効化） |
| token / API の Accept ヘッダー | 実装側で **`Accept: application/json`** を必ず付ける。付けないと `form-urlencoded` で返りパースに失敗する（計画 D-31-03） |
| email が取れない user がいる | GitHub のメールが**非公開**の場合、`/user/emails` に `verified: true` 何も出てこないことがある。その場合は新規登録できない（設計 D-10）。テストユーザーのメール設定は公開にしておくと検証しやすい |
| primary でない email | `primary && verified` の組だけ採用する（複数 email に primary が無い場合もある） |

---

## 3. Discord

方式は OAuth2（ID Token は無い）。`/users/@me` の `verified` フラグで判定する。

### 手順

1. <https://discord.com/developers/applications> を開く
2. **「New Application」** を押す → 名前を入力 → **Create**
3. 左メニュー **「OAuth2」→「Redirects」** を開く
4. **「Add Redirect」** を押して追加:
   ```
   http://localhost:3000/api/auth/oauth/discord/callback
   ```
5. 「General Information」ページ（または OAuth2 のページ内）に
   **「APPLICATION ID」** と **「CLIENT SECRET」** があるので控えておく
   - 「Client Secret」は **「Reset Secret」** で再発行できる（GitHub と違っていつでも再取得できる）
6. 「OAuth2 → URL Generator」で authorize URL を作ってもよいが、**このプロジェクトでは server 側で組み立てるので不要**

### 取得した値

```
DISCORD_CLIENT_ID=123456789012345678
DISCORD_CLIENT_SECRET=（ランダム文字列）
```

### Discord 固有の注意

| 項目 | 内容 |
|---|---|
| bot の導入は不要 | Discord Bot の作成は不要。"OAuth2" のみ使う |
| scope | `identify email` の2つ。`guilds` 等の広い scope は要求しない（最小権限・設計 D-06） |
| token エンドポイント | `POST https://discord.com/api/oauth2/token`。client_id / client_secret は本文 form で送る |
| userinfo | `GET https://discord.com/api/users/@me` に `Authorization: Bearer <access_token>`。`verified: true` のみ採用（設計 D-11） |

---

## 4. `.env` への記入

**`.env` は `.gitignore` 済み**（`.env*` パターン）。実値は commit しない。

```bash
# .env の末尾に追記
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx

GITHUB_CLIENT_ID=Iv1.xxxx
GITHUB_CLIENT_SECRET=xxxx

DISCORD_CLIENT_ID=123456789
DISCORD_CLIENT_SECRET=xxxx

# redirect URI の origin。↑の3つの登録 URI と一致させること
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

`.env.example` にも同じキーをコメント付きで残しています（値は空）。

### 確認コマンド

```bash
# 3つ揃っているか（空文字でないことだけ確認）
grep -E 'GOOGLE_CLIENT_ID|GITHUB_CLIENT_ID|DISCORD_CLIENT_ID' .env | grep -v '=$'

# サーバを起動
pnpm dev
```

`pnpm dev` 後に `/login` を開くと、**registry が `isConfigured` を判定して社会ログインボタンが自動で現れます**（手動で UI を触る必要はありません）。
1 つでも credential が欠けている provider のボタンは出ません。

---

## 5. 取得後につまずきやすい点

### 5.1 ボタンが出ない

- `.env` を**編集して dev サーバを再起動**したか（`.env` は起動時に読み込まれる）
- `isConfigured` は **client_id と client_secret の両方**が揃って true になる（片方では出ない）
- registry のエントリがまだ 0 件ならボタンは出ない（**Phase 4-A-01 の実装が必要**。この手順書はその前に読むもの）

### 5.2 `redirect_uri_mismatch`

- provider のコンソールを再確認
- `.env` の `NEXT_PUBLIC_APP_URL` と登録 URI の origin が一致しているか（`localhost` と `127.0.0.1` は別扱い）
- 末尾の `/` が が一致 しているか

### 5.3 `state` エラー

- callback の有効時間（TTL 10 分）を超えていた
- 同じ authorize URL を 2 回踏んだ（`state` は 1 回限りで消費される）

→ 設計通り（仕様 §11 / 計画 12.4）。**使い回しはできない**。

### 5.4 `error=account_not_linkable`

- その provider で**検証済み（`verified`）の email が取得できなかった**
- GitHub: メール設定が非公開になっている場合に多い
- → **新しい user として自動登録しないのは仕様どおりの挙動**（既存アカウントへの `link` 誘導に回す）

---

## 関連ドキュメント

- 実装計画: `docs/phase4-oauth-social-login-実装計画.md`
- 全体計画: `実装計画.md`（§9 プロバイダー、§10 accounts、§11 linking、§12 詳細）
- Provider 側の OIDC（自作アプリ向け）: `docs/phase2.5-実装計画.md` ← **本手順書とは別物**
  - 本手順書: **Google/GitHub/Discord を「使う」**（利用者としてログインする）
  - `docs/phase2.5-*: 本アプリが「認証元になる」**（自作サービスを登録して ログインを受ける）
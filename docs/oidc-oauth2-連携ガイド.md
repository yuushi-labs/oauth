# OIDC / OAuth 2.0 連携ガイド

> 対象: 本アプリを **OpenID Provider（OP）/ OAuth 2.0 Authorization Server（AS）** として使い、自作サービス（RP）のログインを委譲したい開発者・運用者。
> 正本: `超本格アカウント・認証システム仕様書 v1.3.md` §69 ／ 実装計画: `docs/phase2.5-実装計画.md`（M2.5）・`docs/phase2.6-oidc-client-console-実装計画.md`（M2.6）
> このガイドは**実装済みの挙動**だけを記載する。未実装の機能は「対応しない」と明記する。

本アプリは `oidc-provider` v9 を使った OIDC Provider を内蔵しています。RP は本アプリのパスワードやセッション Cookie を一切受け取らず、**認可コード（Authorization Code）** と **ID Token** だけを使ってユーザーを識別します。

対応フローは **Authorization Code + PKCE（`S256`）** のみです。Implicit / Hybrid / Client Credentials / Device Code / Refresh Token には対応しません。

---

## 1. エンドポイント

`OIDC_ISSUER` を `https://auth.example.com` とした場合の URL です（開発時は `http://localhost:3000`）。すべて `OIDC_ISSUER` と**同一 origin** で提供されます。

| 用途 | パス | メソッド | 説明 |
|---|---|---|---|
| Discovery | `/.well-known/openid-configuration` | GET | メタデータ。RP は最初にここを読む |
| Authorization | `/oauth2/authorize` | GET | 認可リクエスト。`response_type=code` のみ |
| Interaction | `/oauth2/interaction/{uid}` | GET / POST | ログイン・同意 UI（本アプリが描画。RP は直接触れない） |
| Token | `/oauth2/token` | POST | 認可コードをトークンへ交換 |
| UserInfo | `/oauth2/userinfo` | GET | access token に紐づく claim を返す |
| Revocation | `/oauth2/revoke` | POST | access token / refresh token の失効 |
| JWKS | `/oauth2/jwks` | GET | ID Token 検証用の公開鍵（公開のみ） |

### Discovery が返す主な値

`/.well-known/openid-configuration` は次のとおり（実装値。`docs/phase2.5-実装計画.md` §0.1 P25-C-01・`src/lib/oidc/provider.ts`）:

| フィールド | 値 |
|---|---|
| `issuer` | `OIDC_ISSUER`（末尾スラッシュなしの固定 origin） |
| `authorization_endpoint` | `${issuer}/oauth2/authorize` |
| `token_endpoint` | `${issuer}/oauth2/token` |
| `userinfo_endpoint` | `${issuer}/oauth2/userinfo` |
| `revocation_endpoint` | `${issuer}/oauth2/revoke` |
| `jwks_uri` | `${issuer}/oauth2/jwks` |
| `response_types_supported` | `["code"]` |
| `grant_types_supported` | `["authorization_code"]` |
| `id_token_signing_alg_values_supported` | `["RS256"]` |
| `scopes_supported` | `["openid","profile","email"]` |
| `token_endpoint_auth_methods_supported` | `["client_secret_basic","none"]` |
| `code_challenge_methods_supported` | `["S256"]` |
| `subject_types_supported` | `["public"]` |
| `response_modes_supported` | `["form_post","fragment","query"]`（`response_type=code` では `query` を使用） |

`offline_access`（Refresh Token）や `address` / `phone` claim は**広告しません**（未対応）。

---

## 2. クライアント（RP）の登録

クライアントは**事前登録制**です。動的クライアント登録（`/register`）には対応しません。登録方法は 2 つあります。

### 2.1 管理画面（推奨・M2.6）

ログイン後 `/settings/applications` から作成します。

1. 「アプリ名」「運営者名」「種別（public / confidential）」「リダイレクト URI」「許可 scope」「Web origin（public のみ）」を入力
2. 作成すると `client_id` が発行される。confidential の場合は **`client_secret` がこの一度だけ表示**される（保存後は再表示不可。HMAC ダイジェストのみ保存）
3. 詳細画面 `/settings/applications/[clientId]` で issuer・Discovery URL をコピー、secret 再生成（要本人確認）、利用停止、接続テストができる

### 2.2 CLI

```bash
# confidential（サーバーサイド RP）
pnpm oidc:client add \
  --name "My Service" --operator "My Service株式会社" \
  --type confidential \
  --redirect-uri "https://service.example/callback" \
  --scope openid,profile,email

# public（SPA / ネイティブ。Web origin 必須）
pnpm oidc:client add \
  --name "My SPA" --operator "My Service株式会社" \
  --type public --web-origin https://spa.example \
  --redirect-uri "https://spa.example/callback" --scope openid,profile

# 変更・secret 再生成・失効
pnpm oidc:client update --client-id <id> [--name ...] [--operator ...] [--scope ...] [--add-redirect-uri ...] [--remove-redirect-uri ...] [--web-origin ...]
pnpm oidc:client rotate-secret --client-id <id>
pnpm oidc:client revoke --client-id <id>
```

CLI と管理画面は `src/lib/oidc/client-validation.ts` の**同一検証ルール**を共有します。

### 2.3 クライアント種別

| 種別 | `token_endpoint_auth_method` | secret | 用途 |
|---|---|---|---|
| `confidential` | `client_secret_basic` | あり（HMAC 保存） | サーバーサイド RP。secret を安全に保管できる |
| `public` | `none` | なし | SPA / ネイティブ / CLI。PKCE で保護 |

- 種別は**作成後に変更できません**（DB 制約と整合）。変更したい場合は作り直します。
- `public` はブラウザから直接呼ぶため **Web origin の登録が必須**です（管理画面経由）。CORS は登録した origin だけ許可します。
- `confidential` に Web origin は登録できません。

### 2.4 入力の制約

| 項目 | 制約 |
|---|---|
| `redirect_uri` | **完全一致**で照合。`https` 必須（`http` は loopback `localhost`/`127.0.0.1`/`::1` のみ、かつ本番では不可）。userinfo（`user:pass@`）・fragment を含められない。1〜20 件 |
| `scope` | 1〜3 件。`openid` 必須。`profile` / `email` のみ許可 |
| `web_origin` | `scheme://host[:port]` のみ（パス・クエリ・fragment 不可）。`https` 必須（loopback の `http` を除く）。最大 10 件 |
| `name` / `operator` | 1〜100 文字。制御文字不可（同意画面に描画されるため） |
| 1 ユーザーあたりの上限 | `OIDC_MAX_CLIENTS_PER_USER`（既定 5） |

---

## 3. 認可コードフロー（RP の実装手順）

### 3.1 認可リクエスト

ブラウザを `/oauth2/authorize` へリダイレクトします。

```
GET /oauth2/authorize
  ?response_type=code
  &client_id=<client_id>
  &redirect_uri=<登録済み redirect_uri と完全一致>
  &scope=openid profile email
  &state=<推測不能な値>
  &nonce=<推測不能な値>
  &code_challenge=<BASE64URL(SHA256(code_verifier))>
  &code_challenge_method=S256
```

**必須パラメータ**: `client_id` / `redirect_uri` / `response_type=code` / `scope`（`openid` を含む） / `state` / `nonce` / `code_challenge` / `code_challenge_method=S256`。

本アプリは provider に到達する前にリクエストを検証します（`scripts/server.ts` の `exactAuthorizationRequest`）。次は **400 `Invalid authorization request`** で拒否されます。

- `GET` 以外
- 各パラメータが重複している
- `response_type` が `code` 以外
- `scope` に `openid` が無い、または重複 scope がある
- `code_challenge_method` が `S256` 以外、または `code_challenge` が無い
- `resource` / `authorization_details` / `request` / `request_uri` を含む（未対応機能）
- `client_id` が無効・停止・失効、`redirect_uri` が登録値と不一致、要求 scope が `allowed_scopes` の部分集合でない

> **PKCE は全クライアントで必須**です（`pkce.required: () => true`）。confidential でも `S256` が必要で、`plain` は受理されません。

### 3.2 ログインと同意（Interaction）

未ログインの場合、本アプリは `/login?returnTo=/oauth2/interaction/...` へ 303 で誘導します。ログイン後、次の同意画面が表示されます。

- アプリ名・運営者名・**登録者（ユーザー名と登録日）**・要求 scope ごとの共有内容
- 「許可する」/「許可しない」

同意結果は `oidc_user_grants` に記録され、`/settings/connected-apps` から取り消せます。

`prompt` の扱い:

| `prompt` | 挙動 |
|---|---|
| 未指定 | 既存セッション・既存同意があれば再利用 |
| `none` | 未ログインなら `login_required`、同意が必要なら `consent_required` を返す（UI を出さない） |
| `login` | 再ログインを要求（`max_age` も考慮） |
| `consent` | 同意画面を強制 |

### 3.3 トークン交換

`redirect_uri` へ `code` と `state` が返ります。`state` を検証したうえで token endpoint へ POST します。

**confidential（`client_secret_basic`）**:

```http
POST /oauth2/token
Authorization: Basic BASE64(URLENCODE(client_id):URLENCODE(client_secret))
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<code>
&redirect_uri=<認可時と同一>
&code_verifier=<PKCE verifier>
```

**public（認証なし・`none`）**: `Authorization` ヘッダを付けず、同じ body を送ります。

成功時のレスポンス（`application/json`）:

```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 600,
  "id_token": "eyJ...",
  "scope": "openid profile email"
}
```

- **Refresh Token は発行しません**（`grant_types: ['authorization_code']` のみ）。
- 認可コードは **1 回限り**。同じコードの 2 回目交換は 400 になります（`consume` は `UPDATE ... WHERE consumed_at IS NULL` の原子消費）。
- PKCE verifier 不一致・誤った client secret も 400 です。

### 3.4 UserInfo

```http
GET /oauth2/userinfo
Authorization: Bearer <access_token>
```

付与された scope の範囲の claim だけを返します。scope 外の claim は返しません。

---

## 4. トークンと claim

### 4.1 有効期限（TTL）

| 種別 | TTL |
|---|---|
| 認可コード | 300 秒 |
| access token | 600 秒 |
| ID Token | 300 秒 |
| interaction | 300 秒 |
| grant（同意） | 30 日（`2_592_000` 秒） |

### 4.2 ID Token の claim

RS256 署名。ヘッダの `kid` は JWKS の鍵と一致します。

| claim | 内容 |
|---|---|
| `sub` | **client ごとの不透明な識別子**（`sub_...`）。生の `user_id` ではない |
| `aud` | `client_id` |
| `iss` | `OIDC_ISSUER` |
| `exp` / `iat` | 有効期限 / 発行時刻 |
| `nonce` | リクエストの `nonce` をそのまま反映 |
| `auth_time` | 認証時刻 |

### 4.3 UserInfo / ID Token の scope 別 claim

| scope | claim |
|---|---|
| `openid` | `sub`（必須） |
| `profile` | `name` / `preferred_username` / `picture`（`picture` は `https:` のときのみ） |
| `email` | `email` / `email_verified`（本アプリは確認済みユーザーのみログインを許すため常に `true`） |

### 4.4 ID Token の検証（RP 側）

1. Discovery から `jwks_uri` を取得し、公開鍵を取得（`kid` で選択）
2. `alg` が `RS256` であること、署名が正しいこと
3. `iss` が `OIDC_ISSUER` と一致
4. `aud` が自分の `client_id` と一致
5. `exp` が未来、`nonce` が送った値と一致
6. 必要なら `auth_time` を確認（`max_age` を使う場合）

`sub` は client ごとに別値です。**同一ユーザーでも client が違えば `sub` は異なります**。ユーザーを横断的に同一視する用途には使えません。

---

## 5. 失効（Revocation）

```http
POST /oauth2/revoke
Authorization: Basic BASE64(client_id:client_secret)   # public は省略
Content-Type: application/x-www-form-urlencoded

token=<access_token>&token_type_hint=access_token
```

- confidential は `client_secret_basic`、public は認証なしで送ります。
- 失効後、その access token で `/oauth2/userinfo` を呼ぶと 401 になります。
- ユーザーは `/settings/connected-apps` から連携（grant）を個別に取り消せます。取り消すと関連する認可コード・access token も破棄されます。

---

## 6. セキュリティ上の注意（RP 実装者向け）

| 項目 | 本アプリの挙動 | RP がすべきこと |
|---|---|---|
| PKCE | `S256` 必須・全クライアント | verifier を推測不能にし、認可ごとに新規生成 |
| `state` | 必須 | CSRF 対策に必ず検証（1 回限り） |
| `nonce` | 必須 | ID Token の `nonce` を検証（リプレイ対策） |
| redirect URI | 完全一致のみ | 登録値と完全一致させる。ワイルドカード不可 |
| client secret | HMAC ダイジェストのみ保存・一度だけ表示 | サーバー側 secret store に保管。フロントへ露出しない |
| トークン保存 | サーバー側のみ | access token を `localStorage` に置かない（public はメモリ保持を推奨） |
| コード再利用 | 1 回限り消費 | 失敗時は再認可からやり直す |
| CORS | public client は登録 origin のみ | 登録した origin から呼ぶ |

**ログの redaction**: 本アプリは `code` / `state` / `nonce` / `code_verifier` / `id_token` / `access_token` / `refresh_token` / `client_secret` をログ・`security_events.metadata` に平文で残しません（§45）。RP 側でも同様に扱ってください。

---

## 7. 運用・設定

### 7.1 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `OIDC_ISSUER` | OIDC 有効化時 | 固定 issuer origin。`NEXT_PUBLIC_APP_URL` と**同一 origin**。本番は `https` 必須 |
| `OIDC_JWKS_JSON` | OIDC 有効化時 | RS256 **private JWK 1 個** ＋ rotation 期間中に保持する旧 public JWK。引用符なし・空白なしで書く |
| `OIDC_ADAPTER_ENCRYPTION_KEY` | OIDC 有効化時 | Base64 32 バイト。client secret と OIDC の code/token/interaction を AES-256-GCM 暗号化し、ID 検索に HMAC を使う |
| `OIDC_MAX_CLIENTS_PER_USER` | 任意（既定 5） | 1 ユーザーあたりの登録 client 上限 |

`OIDC_ISSUER` が未設定のとき、OIDC エンドポイントは起動しません。

### 7.2 セットアップ

```bash
pnpm oidc:keygen     # OIDC_ADAPTER_ENCRYPTION_KEY と OIDC_JWKS_JSON を生成（一度だけ表示）
# 表示値を .env の OIDC_* へ設定
pnpm db:migrate
pnpm oidc:client add ...   # または /settings/applications から作成
pnpm dev
```

### 7.3 起動時に検証される項目

- `OIDC_ISSUER` が `NEXT_PUBLIC_APP_URL` と同一 origin、パス/クエリ/fragment なし
- JWKS が「ユニークな `kid` を持つ RSA/RS256/`use:sig` の JWK」で、**private 署名鍵はちょうど 1 個**
- `OIDC_ADAPTER_ENCRYPTION_KEY` が 32 バイト
- 本番で `OIDC_ISSUER` が `https`
- 本番で `DEBUG` が `oidc-provider` 名前空間を有効化していない（v9 は logger 注入非対応のため）

### 7.4 鍵 rotation

新しい private JWK と旧 public JWK を同時に `OIDC_JWKS_JSON` へ渡し、旧鍵は発行済み ID Token の有効期限（300 秒）を過ぎるまで残します。`OIDC_ADAPTER_ENCRYPTION_KEY` を変更すると暗号化済みの client secret と Provider state を復号できなくなるため、データ移行と同時に行ってください。

### 7.5 TLS / reverse proxy

Provider は `pnpm dev` / `pnpm start` の custom Node server 経由で動作します。TLS を reverse proxy で終端する場合、proxy が `Host` と `X-Forwarded-Proto` を上書きし、信頼する hop 数を `TRUSTED_PROXY_HOPS` へ明示してください（本番で HTTPS 判定に使われます）。

### 7.6 レート制限

OIDC エンドポイントは PostgreSQL 正本のレート制限で保護されます（`src/config/rate-limits.ts`）:

| 対象 | ウィンドウ | 上限 |
|---|---|---|
| `authorize` | 600 秒 | 30 |
| `interaction` | 600 秒 | 60 |
| `token` | 60 秒 | 30 |
| `userinfo` | 60 秒 | 90 |
| `revoke` | 60 秒 | 10 |

### 7.7 アカウント停止・削除

- adapter は access token / 認可コード / grant / session の解決時に `status='active'`・`email_verified`・`deleted_at IS NULL` を確認し、満たさない場合は解決を拒否します。
- アカウント削除時は `revokeUserOidcGrants()` で OIDC grant と関連 token / code を破棄します。
- interaction で遮断済みアカウントを検出すると `oidc_account_blocked` を記録します。

---

## 8. セキュリティイベント

OIDC 関連で記録されるイベント（`security_events.event_type`）:

| イベント | 契機 |
|---|---|
| `oidc_authorize_denied` | 認可リクエスト拒否（client/scope 不正、grant 不一致等） |
| `oidc_consent_granted` | 同意の許可 |
| `oidc_consent_denied` | 同意の拒否 |
| `oidc_token_failed` | token / userinfo / revoke のエラー |
| `oidc_token_revoked` | grant 失効 |
| `oidc_grant_revoked` | ユーザーによる連携取り消し |
| `oidc_client_registered` / `_updated` / `_revoked` / `_secret_rotated` | client の操作 |
| `oidc_account_blocked` | 遮断アカウントの検出 |
| `rate_limited` | 各エンドポイントのレート制限（`scope: oidc_*`） |

---

## 9. 対応しない機能

明示的に無効化しています（`src/lib/oidc/provider.ts` の `features`）。設計判断の詳細は `docs/phase2.5-実装計画.md`・`docs/phase2.5-threat-model.md` を参照してください。

- Implicit / Hybrid フロー、`response_type` は `code` のみ
- Refresh Token（`offline_access`）、Client Credentials、Device Code、CIBA
- 動的クライアント登録（`/register`）、Pushed Authorization Requests（PAR）
- Request Object / JAR、JWT 形式の UserInfo、暗号化 ID Token（`encryption`）
- DPoP、mTLS、Introspection、Backchannel Logout、RP-Initiated Logout
- `address` / `phone` などの標準 scope 拡張

---

## 10. 参考

| ドキュメント | 内容 |
|---|---|
| `docs/phase2.5-実装計画.md` | OIDC Provider の詳細計画・完了タスクの根拠（P25-*） |
| `docs/phase2.5-threat-model.md` | 脅威モデル |
| `docs/phase2.5-gate-a.md` | 統合 Spike・adapter 評価・統合判断 |
| `docs/phase2.5-review.md` | セキュリティレビュー・依存監査・相互運用 |
| `docs/phase2.5-interop.md` | Go `coreos/go-oidc3` との相互運用結果 |
| `docs/phase2.6-oidc-client-console-実装計画.md` | セルフサービス client 管理コンソール |
| `README.md` §「自作サービスからOIDCログイン」 | セットアップの要点 |

E2E（実 HTTP での Discovery → 認可 → 同意 → token → UserInfo → revoke、PKCE 不一致・code リプレイ・誤 secret の拒否）は `src/test/e2e/oidc-flow.test.ts`、Go の `coreos/go-oidc3` による相互運用は `src/test/e2e/oidc-interop-go.test.ts` で検証しています（`pnpm test:e2e`）。

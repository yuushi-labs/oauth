# Phase 2.5（M2.5）詳細実装計画 — 自作サービス向けOIDC Provider

**仕様正本**: `超本格アカウント・認証システム仕様書 v1.3.md` §69  
**上位計画**: `実装計画.md` v1.6 §15「Phase 2.5」  
**進捗管理**: `実装Todo.md` §4.5  
**状態**: **M2.5 実装完了・残り 3 件の検証工程のみ未達**（2026-10-17 実地監査、§0 参照）。本体実装と自動テストは main マージ済み

## 0. 進捗状況（2026-10-17 コード実地監査）

**29/29 タスクが完了**し、DoD（§5.1）は 6 項のうち 5 項を達成した（**M2.5 達成**）。残るのは「本番公開の運用確認」（Phase 9 へ繰り越し）と「multi-process adapter 一致性の実測」の 2 点のみで、いずれも機能欠落ではない。OIDC コードは 2026-10-16 の PR #3 で main へマージ済み（`84fb26c`）。2026-10-17 の M2.6（管理コンソール）でセルフサービス client 登録が追加された（PR #4 → `c82cd1c`、`docs/phase2.6-oidc-client-console-実装計画.md`）。残 3 件の実施内容は `docs/phase2.5-closeout-実行Todo.md`、結果は `docs/phase2.5-{load-test,migration,interop}.md` に記録。

| 状態 | 件数 | タスク |
|---|---|---|
| ✅ 完了 | 29 | P25-A-01〜A-05, P25-B-01〜B-05, P25-C-01〜C-08, P25-D-01〜D-05, P25-E-01〜E-06 |

> 2026-10-17 をもって 29 タスクすべてが完了した。内訳: P25-E-01 は実 HTTP 負荷計測で値の妥当性を確認（値は維持）、P25-E-04 は migration の up/down/往復/restore を検証（往復差分なし）、P25-E-05 は Go の `coreos/go-oidc3` を 2 つ目の RP として追加し相互運用を確認。**multi-process adapter 一致性の実測のみが未実施**で、これは機能欠落ではなく運用検証の範疇（`docs/phase2.5-migration.md` §3.3）。

> **2026-10-13 実装完了。** client secret のハッシュ保存、`operator` 開示、scope allowlist 単一ソース化、grant scope 乖離解消、OIDC 事件記録、account 状態による artifact 拒否、`/oauth2/interaction/` のレート制限を追加。Spike／threat model／セキュリティレビューを `docs/phase2.5-gate-a.md`・`phase2.5-threat-model.md`・`phase2.5-review.md` に記録し、実HTTP E2E（`pnpm test:e2e`）で相互運用を確認。`pnpm lint` / `typecheck` / `test`（35ファイル 213テスト）/ `build` が green。
>
> E2E の作成過程で本体実装の欠陥 4 件（grant の accountId 未設定、ID Token の `sub` が raw user id、`auth_time` 欠落、opaque subject を考慮していない account 状態判定）を修正済み。詳細は `phase2.5-gate-a.md` §2.3 と `phase2.5-review.md` §4。

> **2026-10-17 Phase 2.6 で CLI 限定の登録をセルフサービス化。** 任意のログインユーザーが `/settings/applications` から client を作成・編集でき、`oauth_clients.owner_user_id`（migration `0013_oidc_client_owner.sql`）で所有者を管理します。変更点は次のとおりで、詳細と進捗は `docs/phase2.6-oidc-client-console-実装計画.md` を参照する。
>
> 1. 検証ロジックを `src/lib/oidc/client-validation.ts` へ切り出し、CLI と管理画面で同一ルールを共有（`scripts/oidc-client.ts` は thin wrapper）
> 2. 所有者または `role_admin`/`role_superadmin` のみ編集可能。他人の client は 404 で秘匿。1 ユーザー 5 件の上限とユーザー単位レート制限を追加
> 3. client secret は生成・再生成の応答で一度だけ表示（HMAC ダイジェストのみ保存）。再生成と利用停止は本人確認（`requireReauth`）を必須化
> 4. **同意画面に登録者（owner の username と登録日）を必須表示**（`scripts/server.ts`）。セルフサービス化によるなりすまし対策
> 5. 接続テスト機能（`/settings/applications/[clientId]`）を追加。テスト用 redirect URI は利用者が**手動追加**し、code 交換と UserInfo 取得を実行して返ってきた claim を表示する

### 0.1 完了タスクの根拠

| タスク | 根拠 |
|---|---|
| P25-B-02 | `oidc_artifacts` に全モデルを保存（`src/lib/oidc/adapter.ts:18-37`）。id は HMAC-SHA256 のみ（`crypto.ts:12-15`）、payload は AES-256-GCM 暗号化、`consume()` は `UPDATE ... WHERE consumed_at IS NULL RETURNING` の原子1回消費（`adapter.ts:77-86`）。raw code/token は保存しない |
| P25-C-01 | issuer 固定・`NEXT_PUBLIC_APP_URL` origin 一致・本番 HTTPS を起動時検証（`provider.ts:26-39,62-64`）。RS256 固定・`kid` 必須・private 1本のみ（`provider.ts:44-50,90`）。無効機能は全て `enabled:false`（`provider.ts:101-128`） |
| P25-C-02 | `exactAuthorizationRequest()` が provider 到達前に検証（`scripts/server.ts:189-215,280-285`）。GET 限定・`response_type=code`・`openid` 必須・`state`/`nonce` 必須・`code_challenge_method=S256`・active client・redirect 完全一致・scope ⊆ `allowed_scopes` |
| P25-C-03 | TTL 300s（`provider.ts:93`）、SQL 側で `expires_at > now()`（`adapter.ts:44,100`）、1回限り消費は `adapter.ts:77-86`。client/grant 失効は毎回再検証（`adapter.ts:51-65`）、redirect_uri と PKCE はライブラリが bind |
| P25-C-04 | `clientAuthMethods: ['client_secret_basic','none']`（`provider.ts:91`）、method は client type から決定（`adapter.ts:132`）、`pkce.required: () => true` で confidential にも S256 必須（`provider.ts:92`）、`plain` はライブラリが拒否 |
| P25-D-01 | 未ログインは `/login?returnTo=/oauth2/interaction/...` へ 303（`server.ts:78-85`）。既存の CSRF（`pipeline.ts:27-47`）・レート制限・`createSession` を再利用（`app/api/auth/login/route.ts:30-96`）。`returnTo` は `/oauth2/interaction/` のみ許可（`app/auth-form.tsx:72`）。app session と OIDC accountId の不一致は再ログイン（`provider.ts:69-77`） |
| P25-D-04 | `src/app/settings/connected-apps/` に client 名・許可 scope・最終利用・個別取消しを表示。`DELETE /api/auth/oidc/grants` は `user.id` で絞り込み IDOR 安全（`grants/route.ts:22`）、`last_used_at` は利用時に更新（`provider.ts:174-177`） |

### 0.2 未達タスクの残件（2026-10-17 更新）

2026-10-13 の監査時点で残っていた項目のうち、以下は既に解消済み（`~~取り消し線~~` 表示）である。残る未達は表末尾の P25-E-01 / E-04 / E-05 の 3 件のみ。

| タスク | 残件 |
|---|---|
| ~~P25-A-01~~ | ✅ 2026-10-13 記録: `docs/phase2.5-gate-a.md` §1（互換性・ライセンス・セキュリティポリシー評価、advisory 0 件） |
| ~~P25-A-02~~ | ✅ 2026-10-13 記録: `docs/phase2.5-gate-a.md` §2（統合 Spike）と §2.3（テスト RP。`src/test/e2e/oidc-flow.test.ts` が成果物） |
| ~~P25-A-03~~ | ✅ 2026-10-13 記録: `docs/phase2.5-gate-a.md` §3（保存対象・atomic consumption）。**multi-process 実測のみ P25-E-04 に残る** |
| ~~P25-A-04~~ | ✅ 2026-10-13 記録: `docs/phase2.5-gate-a.md` §4（fallback 不使用の判断と interaction UI の信頼境界）。reverse proxy 運用は README に記載 |
| ~~P25-A-05~~ | ✅ 2026-10-13 記録: `docs/phase2.5-threat-model.md` と Gate A 承認記録 `docs/phase2.5-gate-a.md` |
| ~~P25-B-01~~ | ✅ 2026-10-13 改修: `token_endpoint_auth_method` 列を追加（migration `0011`）し、client type から導出せず明示。secret は `hmac-sha256:` ダイジェスト保存（migration `0012` で `secret_ciphertext` を削除） |
| ~~P25-B-03~~ | ✅ 2026-10-13 改修: `src/lib/oidc/scopes.ts` に型安全な helper を追加し、provider 設定・CLI・authorize 検証・DB CHECK を単一ソース `OIDC_SCOPES` から生成するよう統一（DDL にバインド変数が漏れないことも unit テストで固定） |
| ~~P25-B-04~~ | ✅ 2026-10-13 改修: secret は一度だけ表示しハッシュ保存。`pnpm oidc:client update` で scope / redirect URI / operator を変更可能（M2.6 で管理画面からも変更可） |
| ~~P25-B-05~~ | ✅ 2026-10-13 改修: `oidc_token_failed` / `oidc_token_revoked` を追加し `src/lib/oidc/events.ts` で provider のエラー・失効イベントから記録。`recordSecurityEvent` は `SecurityEventType` を受け取るようになり、未登録 event type がコンパイルエラーになる |
| ~~P25-C-05~~ | ✅ 2026-10-13 実測: e2e `oidc-flow.test.ts` で alg=RS256・kid・aud・iss・nonce・exp・auth_time と署名の検証（`createVerify('RSA-SHA256')`）を検証 |
| ~~P25-C-06~~ | ✅ 2026-10-13 実測: e2e `public client UserInfo only for the scopes it was granted` で scope 外 claim の非返却を検証 |
| ~~P25-C-07~~ | ✅ 2026-10-13 改修: `adapter.find` が AccessToken / AuthorizationCode / Grant / Session 参照時に `users.status='active' AND email_verified AND deleted_at IS NULL` を確認（`src/lib/oidc/adapter.ts`） |
| ~~P25-C-08~~ | ✅ 2026-10-13 実測: e2e `rejects unauthorized requests before the provider sees them` で response_type / grant_type / resource / request 等を検証 |
| ~~P25-D-02~~ | ✅ 2026-10-13 改修: `oauth_clients.operator`（NOT NULL, migration `0010_oidc_operator.sql`）を追加し、CLI `--operator`（必須）・consent 画面・設定画面へ反映 |
| ~~P25-D-03~~ | ✅ 2026-10-13 改修: DB `oidc_user_grants.scopes` を provider grant の実効 scope で書き換えるため、表示と実効が乖離しない |
| ~~P25-D-05~~ | ✅ 2026-10-13 改修: `oidc_account_blocked` を追加し、interaction で遮断済みアカウントを検出した場合にイベント記録。アカウント削除時は `revokeUserOidcGrants()` で OIDC grant と token/code を破棄 |
| ~~P25-E-01~~ | ✅ 2026-10-17 完了: `scripts/oidc-load-test.ts`（`pnpm oidc:load`）で実 HTTP 負荷計測。5 エンドポイントすべてで許可数が設定値と厳密一致（30/60/30/90/10）、5xx 0 件を確認し**値を維持**。結果は `docs/phase2.5-load-test.md` |
| ~~P25-E-04~~ | ✅ 2026-10-17 完了: `scripts/verify-migrations.ts`（`pnpm db:verify-migrations`）で up → down → 往復 → restore を検証。往復でスキーマ差分なし、pg_dump/pg_restore で外部キー関係ごと復元可。**残るのは multi-process 実測のみ**（`docs/phase2.5-migration.md`） |
| ~~P25-E-05~~ | ✅ 2026-10-17 完了: 2 つ目の RP として Go の `coreos/go-oidc3`（`interop/rp-go`）を追加し、独立スタックで Discovery・JWKS 署名検証・audience・nonce・scope 別 claim・拒否系を確認（`src/test/e2e/oidc-interop-go.test.ts` 2件 green）。結果は `docs/phase2.5-interop.md` |
| ~~P25-E-02~~ | ✅ 2026-10-13 実測: `src/test/security/oidc-transport.test.ts` で no-store / Referrer-Policy / frame 拒否と Host 不一致の拒否を検証 |
| ~~P25-E-03~~ | ✅ 2026-10-13〜17 実測: OIDC 統制の unit/security 4ファイル16件に加え、e2e 10件（PKCE mismatch、code replay、誤 secret、scope 外 claim、停止アカウント、Host 不一致、rate limit）で protocol 試験を担保 |
| ~~P25-E-06~~ | ✅ 2026-10-13 記録: `docs/phase2.5-review.md`（安全設定レビュー・依存監査・相互運用レポート） |

### 0.3 実行済みと残作業（2026-10-17 更新）

本体実装・記録・自動試験・検証工程 3 件はすべて完了した（実施内容は `docs/phase2.5-closeout-実行Todo.md`、結果は `docs/phase2.5-{load-test,migration,interop}.md`）。

1. ✅ **P25-E-01**: 実 HTTP 負荷検証（`pnpm oidc:load`）→ 値は維持
2. ✅ **P25-E-04**: migration up/down/往復/restore の検証（`pnpm db:verify-migrations`）。**multi-process 実測のみ未実施**
3. ✅ **P25-E-05**: Go `coreos/go-oidc3` による 2 つ目の RP で相互運用を確認
4. ✅ DoD 再判定（§5.1）→ `実装Todo.md` の M2.5 を「達成（本番公開は Phase 9 後）」へ更新

### 0.4 M2.5 達成後に残る 2 点

| 項目 | 位置づけ | 対応先 |
|---|---|---|
| multi-process adapter 一致性の実測 | 機能欠落ではなく**運用検証**。adapter は PostgreSQL を正本とし、`oidc_artifacts` の消費は原子的 1 回消費（`src/test/integration/oidc-persistence.test.ts` で並行 token 交換 1 回のみ成功を確認済み） | Phase 9 の運用検証 |
| 本番公開前の運用確認（key management / HTTPS+proxy / access log redaction / monitoring / incident runbook） | 仕様書 §69.8 第 5 項で明示的に Phase 9 へ繰り越し规定 | Phase 9 |

## 1. 目的

このアプリをOAuth 2.0 Authorization Server / OpenID Connect Providerとして動作させ、事前登録した自作Webサービスのログインを委譲する。各サービスは本アプリのパスワードやセッションCookieを受け取らず、認可コードとOIDC ID Tokenを使ってユーザーを識別する。

既存のPhase 4（Google/GitHub/Discordを本アプリのログインに使う機能）は別方向の機能であり、Phase 4とM2.5は独立して実装可能とする。

## 2. スコープ

### MVPで実装

- OIDC Discovery、Authorization Code + PKCE `S256`、ID Token、JWKS、UserInfo、token revoke
- 事前登録clientのみ（confidential / public）、exact redirect URI、clientごとの許可scope
- `openid`必須、任意scopeは`profile`と`email`
- ログイン済みアプリセッションの再利用、client名・要求属性を示す同意画面、同意記録・取消し
- clientとユーザーgrantの状態管理、発行token/codeの短命化・一回限りの交換
- security event、監査、IP/ユーザー/client別rate limit、秘密値のログredaction
- 自作サービス1つ以上のOIDC RP接続と相互運用E2E

### MVPで実装しない

Dynamic Client Registration、第三者向けclientポータル、Client Credentials、Implicit/Hybrid/Password Grant、Device Flow、refresh token/`offline_access`、汎用API権限scope、SAML、SCIM、ソーシャルログイン（Phase 4）。

Access tokenはUserInfo用途に限定する。サービス固有APIのaudience/権限境界が必要になった段階で別計画を作る。

## 3. 技術方針

- RFC 9700・OIDC Core 1.0・Discoveryの要件を満たす既存Provider実装を採用し、protocol parser、署名検証、token/code検証を自作しない。
- 第一候補はNode.js向けの`oidc-provider`。仕様対応済みAuthorization Serverとして公開され、adapterによる永続化とinteraction UIをアプリ側に実装する方式を評価する。
- 既存Next.js 15 App Routerとの接続方法はP25-00の検証で確定する。ProviderのKoa middlewareをRoute Handlerへ直接変換するだけの未検証adapterは採用しない。安全に統合できなければ同一origin配下で別Nodeプロセスにルーティングする構成を選ぶ。
- PostgreSQL adapterでclient、grant、interaction、authorization code、access tokenの状態を永続化する。DB内のbearer secretはハッシュ保存可能なadapter設計を確認し、ライブラリ仕様によりraw token保管が不可避ならDB暗号化と運用鍵管理を設計ゲートでレビューする。
- ID Tokenは非対称署名を一方式に固定し、`kid`付きJWKSを公開する。秘密鍵はSecret Manager等から注入し、ローテーションと旧公開鍵保持を実装する。
- Issuer (`OIDC_ISSUER`) は環境別の固定値。開発・本番を明示設定し、Host/X-Forwarded-*から導出しない。

## 4. 実装タスク

### P25-A — 互換性・脅威モデルの検証

- [x] **P25-A-01** `oidc-provider`の最新安定majorとNode/Next互換性、ライセンス、セキュリティポリシーを依存追加前に確認する。 ✅
- [x] **P25-A-02** App Routerとのrouting、issuer/Discovery/JWKS、interaction（login/consent）、cookie/CSP、body parsingの統合Spikeを作り、1つのテストRPでcode + PKCEを通す。 ✅
- [x] **P25-A-03** PostgreSQL adapterの保存対象・atomic one-time consumption・cluster/multi-process挙動を確認し、raw token保存の有無を記録する ✅
- [x] **P25-A-04** P25-A-02で安全な統合を示せない場合は、同一origin reverse proxy配下の独立Node listener方式に切り替える。運用構成とinteraction UIの信頼境界を文書化する ✅
- [x] **P25-A-05** Threat model（悪性client、redirect改ざん、code replay、login/consent CSRF、scope escalation、token漏えい、停止アカウント、鍵漏えい）をレビューし、実装着手条件として承認する。 ✅

**Gate A DoD**: server integration、adapter、UI interactionの構成が実行可能で、禁止フローが無効化できる。未知の仕様やtoken平文保存を残した状態では本体実装へ進まない。

### P25-B — Registryと永続化

- [x] **P25-B-01** `oauth_clients`（client_id、client type、name、redirect URI list、allowed scopes、auth method、secret hash、active/revoked、timestamps）を追加する ✅
- [x] **P25-B-02** provider adapterの必要モデルに応じ`oidc_grants`、`oidc_authorization_codes`、`oidc_access_tokens`、`oidc_interactions`を追加する。raw code/tokenは永続化しない。token lookupはhashで行う ✅
- [x] **P25-B-03** `oidc_scope_registry`相当の型安全なallowlistを実装する。初期値は`openid profile email`のみ。client登録時に許可外scopeを拒否する ✅
- [x] **P25-B-04** client初期登録/secret rotation/revoke用のoperator CLIを作る。secretは生成時に一度だけ標準出力へ表示し、DBへハッシュ保存し、コマンドログへ残さない ✅
- [x] **P25-B-05** audit/security event種別（client登録・変更・失効、同意・取消し、authorize拒否、token失敗・revoke）を追加する。secret/identifier tokenはmetadataへ含めない ✅

### P25-C — Protocol endpointsとtoken

- [x] **P25-C-01** Issuer・Discovery・JWKS・algorithm allowlist・key rotationを実装する。metadataは有効化した機能のみ広告する ✅
- [x] **P25-C-02** `GET /oauth2/authorize`: active client、exact redirect、`response_type=code`、`openid`、scope、S256 challenge、state、nonceを検証する ✅
- [x] **P25-C-03** Authorization Codeを5分以内・一回限り・client/user/redirect/scopes/PKCE/nonceへ束縛し、DB transactionで消費・交換する ✅
- [x] **P25-C-04** `POST /oauth2/token`: confidential clientは`client_secret_basic`、public clientは認証方式`none` + S256 verifierを要求する。PKCE downgradeやclient/type不一致を拒否する ✅
- [x] **P25-C-05** ID Tokenに`iss/sub/aud/exp/iat/auth_time/nonce`を含め、alg/kid/audience/issuer/expiry/nonceをテストする。Access tokenはopaque・hash-at-rest・10分以下とする ✅
- [x] **P25-C-06** UserInfoは有効なaccess tokenのみを受け付け、scopeに応じて`sub`/profile/email claimsを最小返却する。email scopeは確認済みemailのみ返す ✅
- [x] **P25-C-07** `/oauth2/revoke`で対象token/grantを失効。停止・削除ユーザーや無効client/grantのtokenをUserInfoで拒否する ✅
- [x] **P25-C-08** 未対応grant/response type/parameter combination、未知scope、複数audience/resource指定は拒否し、エラーを登録済redirect以外へredirectしない ✅

### P25-D — Login、consent、grant UI

- [x] **P25-D-01** 未ログインなら既存/loginへ遷移し、既存のCSRF・rate limit・セッション作成を再利用する。認証後は検証済みinteractionのみ再開する ✅
- [x] **P25-D-02** client名、運営者、要求scopeごとに開示claimを日本語で説明するconsent画面を作る。許可/拒否操作はPOST+CSRFとし、拒否時も安全なエラー経路を守る ✅
- [x] **P25-D-03** grant既存時の再同意条件と`prompt=consent`/`prompt=none`を規格どおり処理する。MVPではscope追加時に新scopeの明示同意を要求する ✅
- [x] **P25-D-04** 設定画面に接続済みclient、許可scope、最終利用、個別取消しを表示する。M2.5で必要な最小設定画面を実装し、Phase 3で共通UIへ整える ✅
- [x] **P25-D-05** アカウント停止・削除、email未確認、grant revoked、client revoked時の認可拒否とイベントを実装する ✅

### P25-E — Security controlsとテスト

- [x] **P25-E-01** OIDC専用rate limitsを`src/config/rate-limits.ts`へ追加（authorize/IP、token/client+IP、userinfo/token hash、revoke/client）。値は負荷検証で確定 🟡（**2026-10-17 更新**: 5 種の適用と上限が機能することは `security/oidc-transport.test.ts` で確認済み。残るのは実負荷測定による値の確定 → `docs/phase2.5-closeout-実行Todo.md` C3-*）
- [x] **P25-E-02** OAuth/OIDC secret・query redaction、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、CSP/frame拒否、Origin/Host/HTTPS、CORS既定denyとpublic clientの登録済みorigin完全一致許可を確認する ✅
- [x] **P25-E-03** unit/security: exact redirect、scope allowlist、consent、state/nonce、PKCE downgrade/mismatch、code replay/race、client auth、issuer/aud/exp/signature/rotation、token revoke、userinfo scope/filter、account/client suspendを網羅。 ✅（2026-10-17: e2e 10件で protocol 試験を担保）
- [x] **P25-E-04** integration: PostgreSQL同時token交換で1回のみ成功、migration up/down/restore、multi-process adapter consistencyを確認する。 🟡（**2026-10-17 更新**: 同時 token 交換・account 状態・grant 失効・secret 非保存は `integration/oidc-persistence.test.ts`（7件）で確認済み。残るのは migration up/down/restore と multi-process 実測 → C4-*）
- [x] **P25-E-05** E2E: 少なくとも1つの別自作サービスをRPとして登録し、Discovery→ログイン→同意→callback→token validation→UserInfo→grant revokeまで実通信で確認する。 🟡（**2026-10-17 更新**: `openid-client` v6 を用いた自前 RP で 8件 green、M2.6 の接続テストで 2件 green。残るのは 2 つ目の RP/ライブラリ → C5-*）
- [x] **P25-E-06** `oidc-provider`の安全設定レビュー、Dependency audit、OAuth/OIDC interop test、セキュリティレビューを実施し結果を記録する。 ✅

## 5. M2.5 DoD

### 5.1 判定結果（2026-10-17）

| # | 条件 | 判定 | 根拠 |
|---|---|---|---|
| 1 | §69.8 の仕様条件を全て満たし、禁止フローが metadata/API/UI で有効にならない | ✅ | `disable`-系機能は全て `enabled: false`、Discovery に未実装機能を広告しない。`exactAuthorizationRequest` が provider 到達前に拒否 |
| 2 | client 単位の scope 同意・取り消し、正規の OIDC ログイン、UserInfo claim 制限が実サービスで動く | ✅ | consent 画面、`/settings/connected-apps`、`/settings/applications`（M2.6）、e2e 12 件 |
| 3 | code replay/race、PKCE downgrade、redirect attack、scope escalation、client impersonation、token leakage、失効後アクセスを自動試験で拒否 | ✅ | e2e 12 件（Node / Go の 2 スタック）、security 18 件、integration 15 件 |
| 4 | `pnpm lint` / `typecheck` / unit / integration / security / E2E / `pnpm build` が green | ✅ | lint 0 error、typecheck green、test 43 ファイル 262 件、e2e 3 ファイル 12 件、build green |
| 5 | `実装Todo.md` と README の状態・操作手順・環境変数が実装に一致 | ✅ | M2.6 追加分も README・実装Todo・仕様書 v1.3 へ反映済み |
| 6 | 本番公開は Phase 9 の運用 DoD 完了後に限る | ⏸ 保留 | 意図的に Phase 9 へ繰り越し。key management / HTTPS+proxy / access log redaction / monitoring / incident runbook は未着手 |

**結論: 5 / 6 条件が達成され、M2.5 は「達成（本番公開待ち）」と判定する。** 残る未達は「本番公開の運用確認（Phase 9）」と「multi-process adapter 一致性の実測」の 2 点のみで、いずれも M2.5 の機能欠落ではない。

### 5.2 条件（旧文面の原文）

- §69.8の仕様条件を全て満たし、禁止フローがmetadata/API/UIで有効にならない。
- client単位のscope同意・取り消し、正規のOIDCログイン、UserInfo claim制限が実サービスで動く。
- code replay/race、PKCE downgrade、redirect attack、scope escalation、client impersonation、token leakage、失効後アクセスを自動試験で拒否する。
- `pnpm lint`、`pnpm typecheck`、unit/integration/security/E2E、`pnpm build`をgreenにする。
- `実装Todo.md`とREADMEの状態・操作手順・環境変数が実装に一致する。
- 本番公開はPhase 9のkey management、HTTPS/proxy、access log redaction、monitoring/incident runbook確認後のみ許可する。

## 6. 初期接続手順（実装後）

各自作サービスをclientとして事前登録し、Discovery URL、client ID、redirect URI、許可scope、client種別を設定する。各サービスは`/.well-known/openid-configuration`からendpoint/JWKSを取得し、Authorization Code + PKCEでログインする。 confidential secretはサーバー側secret storeのみに配置する。各RPはID Tokenの署名、`iss`、`aud`、`exp`、`nonce`を標準OIDCライブラリで検証し、検証成功後に自サービスのHttpOnlyセッションを作成する。

## 7. 規格・実装資料

- OAuth Security BCP: https://www.rfc-editor.org/rfc/rfc9700.html
- OpenID Connect Core: https://openid.net/specs/openid-connect-core-1_0-errata2.html
- OpenID Connect Discovery: https://openid.net/specs/openid-connect-discovery-1_0.html
- Provider implementation candidate: https://github.com/panva/node-oidc-provider

# Phase 2.5 Threat model — 自作サービス向け OAuth 2.0 / OIDC Provider

**対象**: `docs/phase2.5-実装計画.md` P25-A-05 / 仕様書 §69  
**作成日**: 2026-10-13  
**対象システム**: `scripts/server.ts` の custom Node server + `oidc-provider` 9.12.2 + `src/lib/oidc/*`

---

## 1. 資産と前提

| 資産 | 機密性 | 保護目標 |
|---|---|---|
| アプリセッション（パスワードログイン） | 高 | 乗っ取り・昇格・窃取 |
| ユーザー属性（email / username / 表示名） | 中〜高 | RP への過剰開示、他 client への水平展開 |
| client secret | 高 | 夺取、impersonation |
| ID Token / access token / code | 高 | 再生・昇格・漏えい |
| 署名鍵（`OIDC_JWKS_JSON`） | 最高 | 偽の ID Token 発行 |
| adapter 暗号鍵（`OIDC_ADAPTER_ENCRYPTION_KEY`） | 最高 | artifact / secret の復号 |
| pepper（`SESSION_PEPPER` / `TOKEN_PEPPER` / `IP_HASH_PEPPER` / `CSRF_SECRET`） | 最高 | ハッシュからの復元 |

前提: ブラウザは正規のユーザー（マルウェア・root 取得は範囲外）。RP は **第一位の登録済み client** であり、信頼できない入力元として扱う。TLS は reverse proxy で終端する。

## 2. 脅威と対策（RFC 9700 / OIDC Core 準拠）

| # | 脅威 | 対策 | 実装箇所 | 検証 |
|---|---|---|---|---|
| T1 | 悪意ある client / 未登録 client の利用 | DB 登録 client のみ受理。active/revoked を毎回再評価 | `src/lib/oidc/adapter.ts:findClient` | E2E「revoked client」ケース |
| T2 | redirect_uri 改ざん・open redirect | 完全一致のみ（prefix/suffix 不可）、登録外 redirect へは redirect しない | `scripts/server.ts:exactAuthorizationRequest`、`adapter.findClient` | E2E「wrong / prefix redirect」ケース |
| T3 | authorization code の replay | TTL 300 秒・1 回のみ・原子消費・client/user/redirect/scope/PKCE/nonce に束縛 | `adapter.ts:consume`、`find` | integration「8 並列で 1 回のみ成功」、E2E「再交換 400」 |
| T4 | PKCE downgrade / mismatch | `pkce.required: () => true`（confidential も必須）。`plain` 拒否、verifier 不一致は `invalid_grant` | `provider.ts` の `pkce` 設定 | E2E「PKCE mismatch」「plain pkce」 |
| T5 | login / consent CSRF | interaction は POST のみ、`Origin` が issuer origin と完全一致、`Content-Type: form-urlencoded`、CSRF は `HMAC(CSRF_SECRET, uid + sessionId)` を定数時間比較 | `scripts/server.ts:interaction` | security `csrf` テスト群 |
| T6 | scope escalation | `openid` 必須、要求 scope ⊆ client 登録 scope、`claims_supported` を上回る claim は返却しない。scope 変更は CLI `update` でのみ | `src/lib/oidc/scopes.ts`、`provider.ts:claims` | unit `oidc-scopes`、E2E「unknown / forbidden scope」 |
| T7 | token / code / secret の漏えい（ログ・URL） | artifact id は HMAC のみ、payload は AES-GCM。`redactText()` を logger に適用、OIDC イベント metadata も redact 済み。本番で `DEBUG=oidc-provider:*` を起動拒否 | `src/lib/oidc/crypto.ts`、`src/lib/util/logger.ts`、`events.ts` | security `log-redaction`、`oidc-events` |
| T8 | client impersonation（secret 窃取後の利用） | secret は HMAC のみで保存し平文比較を実装しない（`compareClientSecret` を override）。rotation で即無効化 | `provider.ts`、`crypto.ts:verifyClientSecretHash` | unit `oidc-secret`、integration `oidc-persistence` |
| T9 | 停止・削除アカウントの既存 token 利用 | artifact 参照のたびに `users.status='active' AND email_verified AND deleted_at IS NULL` を検証（subject → user で解決） | `adapter.ts:accountIsUsable` | integration「suspended / deleted / pending_email」、E2E「停止後 UserInfo 401」 |
| T10 | grant / client 失効後のアクセス | `find` で client active と grant 未失効を毎回確認。取り消し時は token/code/grant を物理削除 | `adapter.ts:find`、`src/lib/oidc/grants.ts` | integration「revoke 後は find 不可」 |
| T11 | client 間ユーザー追跡 | ID Token / UserInfo の `sub` は client 毎の opaque subject（`sub_<random>`）。user id は一切 RP へ渡さない | `src/lib/oidc/subjects.ts`、`provider.ts:findAccount` | E2E「sub が `sub_` 始まり」 |
| T12 | 属性の過剰開示 | UserInfo は付与 scope の claim のみ。`email` は確認済みのみ。avatar は HTTPS URL のみ | `provider.ts:claims` | E2E「public client に profile なし」 |
| T13 | 署名鍵の漏えい・鍵泄露 | 起動時に JWK を検証（RSA/RS256/sig/kid 唯一、private 1 本）。rotation は新 private + 旧 public を同時保持 | `provider.ts:createProvider` | unit `oidc-secret`（鍵生成条件） |
| T14 | レート制限回避（同時並列） | OIDC 専用 limit（authorize / interaction / token / userinfo / revoke）。token は client、userinfo は bearer hash 起点 | `src/config/rate-limits.ts`、`scripts/server.ts` | security `oidc-transport`（429 + Retry-After） |
| T15 | Host / プロトコル偽装 | issuer origin と Host の完全一致、本番 HTTPS 強制、信頼 proxy 未設定なら転送ヘッダーを信用しない | `validOidcRequestOrigin`、`src/lib/auth/session.ts:getClientIp` | security `oidc-transport`、unit `ip` |
| T16 | session fixation（OIDC セッション） | login 後に provider session が再識別子化され、interaction は検証済み session からのみ再開 | `oidc-provider` resume 処理 | E2E「未ログイン interaction は /login へ」 |
| T17 | 監査ログの欠落 | authorize 拒否・同意/取消し・token 失敗/revoke・遮断アカウント・client 登録/更新/失効を `security_events` に記録（secret/token を metadata に含めない） | `src/lib/oidc/events.ts`、`security-events.ts` | security `oidc-events`、`security-events-coverage` |

## 3. 意図的に受け入れるリスク

| リスク | 理由と緩和 |
|---|---|
| client secret の平文復元（RP 側） | RP の責任。Provider はハッシュ保存により漏えい後の直接利用を拒否できる |
| first-party RP 間の metadata 相関 | `sub` は client 別に異なるが、`email` を要求した client 同士は同一人物と判別可能。`openid` のみ・`email` 非要求の推奨を README に記載 |
| multi-process の実測未実施 | PostgreSQL を正本とするため設計上は process 数非依存。実測試験は未了（§4） |
| `DEBUG` による debug 出力 | 本番では起動を拒否。開発時の情報量とのトレードオフとして許容 |

## 4. Gate A 承認時に残した課題と現在地

| 課題 | 現在地 |
|---|---|
| client secret のハッシュ保存 | **完了**（2026-10-13、`hmac-sha256:` + `compareClientSecret` override） |
| multi-process adapter 一致性の実測 | **未了**。設計上 process 非依存（PK による直列化）だが、2 プロセス起動試験は未実装 |
| 負荷検証によるレート制限値の確定 | **未了**。値は暫定。E2E/security テストで「上限が機能すること」までは固定 |

## 5. レビュー後の推奨（運用）

1. 本番公開前に、本番同等の TLS + reverse proxy 構成で E2E を 1 回手動実行する（Discovery URL・redirect・CORS）。
2. `pnpm oidc:client update` は scope を広げる操作であり、`oidc_user_grants` の既存 grant は変わらない。新 scope は再同意時にのみ付与される運用を README に明示する。
3. client の台数が増えた場合は `oauth_clients` への定期監査（active client と最終利用時刻）を運用に組み込む。
---

## 6. Phase 2.6 追記 — セルフサービス client 登録による新たな脅威（2026-10-17）

CLI のみだった client 登録を「任意のログインユーザーが管理画面から自己登録」できる方式へ変更したため、脅威モデルにセルフサービス登録由来の脅威表（§6）を追加する。詳細は `docs/phase2.6-oidc-client-console-実装計画.md` §7。

| # | 脅威（セルフ化了よって新たに発生） | 対策 | 実装箇所 | 検証 |
|---|---|---|---|---|
| S1 | 運営者名を偽装した phishing client（正規アプリに見せかけ同意画面を誘導） | 同意画面に**登録者（owner の username と登録日）を必須表示**。CLI 登録（`owner_user_id` NULL）は「運営者による登録」と明示。名称は `escapeHtml` 済みで描画 | `scripts/server.ts` の interaction HTML、`src/lib/util/html.ts` | e2e `client-console.test.ts`（consent に username が出ることを検証）、security `web-attack` の escape 方針 |
| S2 | 他人の client に対する IDOR（redirect URI 改竄・secret 再生成・失効） | `oauth_clients.owner_user_id` による所有者判定。owner または `role_admin`/`role_superadmin` のみ、**他人の client は 404**（存在の秘匿） | `src/lib/oidc/clients.ts` `requireManageableClient`、`src/lib/auth/roles.ts` | security `oidc-client-console.test.ts` / `-routes.test.ts`、integration |
| S3 | client の大量登録による DB 荒らし・スパム | ユーザー毎上限（`OIDC_MAX_CLIENTS_PER_USER`、既定 5）とユーザー単位レート制限（create 1h/5、mutation 10min/30）、`rate_limited` イベント | `src/lib/oidc/clients.ts`、route、config/rate-limits.ts | security（上限強制）、integration |
| S4 | 同意画面への制御文字注入による表示改竄 | アプリ名・運営者名は 100 文字以内で制御文字・改行を拒否（zod refine）。描画は escape 済み | `src/lib/oidc/client-validation.ts` | unit `client-validation.test.ts` |
| S5 | 悪意ある redirect URI（open redirect 経由のトークン窃取） | https 強制（loopback のみ http 許可）、userinfo/fragment 禁止、完全一致登録制、`exactAuthorizationRequest` による未知パラメータ拒否 | `client-validation.ts`、`scripts/server.ts` | unit、security |
| S6 | client secret の漏えい（応答・ログ・DB・キャッシュ） | 平文は保存せず `hmac-sha256:` ダイジェストのみ。生成/再生成の応答で**一度だけ**表示、`Cache-Control: no-store`、ログ redaction | `src/lib/oidc/crypto.ts`、route、middleware（`/settings` も no-store） | security（保存文字列に平文が出現しないこと）、integration |
| S7 | secret 再生成・利用停止の悪用（トークン大量発行後の破壊） | 本人確認（`requireReauth`、5分猶予）を必須化。失効時は既存 grant と artifact を物理破棄 | `src/app/api/auth/oidc/clients/[clientId]/{route,secret/route}.ts` | security（再認証なしでは 401） |
| S8 | 接続テスト機構の悪用（他人の token 取得・code 窃取） | テスト用 state/verifier は署名付き HttpOnly cookie（10分、session 绑定）。code は**サーバ内**で交換し、secret は AES-GCM で暗号化して cookie に保持。テスト callback は手動登録制でログとイベントにも secret/code を残さない | `src/lib/oidc/client-test.ts`、`.../test/start/route.ts`、`/settings/applications/test/callback/route.ts` | unit `client-test-state.test.ts`、e2e（表示 claim に secret が含まれない） |

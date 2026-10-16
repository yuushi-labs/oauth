# Phase 2.5 セキュリティレビュー / 依存監査 / 相互運用レポート

**対象**: `docs/phase2.5-実装計画.md` P25-E-06（＋ E-01 の値の根拠）  
**実施日**: 2026-10-13  
**実施方法**: コードレビュー、`pnpm audit`、`pnpm lint` / `typecheck` / `test` / `build`、実 HTTP E2E

---

## 1. `oidc-provider` の安全設定レビュー

### 1.1 有効化している機能

| 機能 | 設定 | 根拠 |
|---|---|---|
| response type | `['code']` | Implicit / Hybrid を禁止 |
| grant type | `['authorization_code']` | password / refresh / device / client_credentials を禁止 |
| scopes | `['openid','profile','email']` | 汎用 API 権限を付与しない |
| claims | `openid: [sub, auth_time]`, `profile: [name, preferred_username, picture]`, `email: [email, email_verified]` | 上記以外の claim は出力されない |
| ID Token alg | `['RS256']` | 対称 alg を禁止 |
| client auth | `['client_secret_basic','none']` | `client_secret_post` / `private_key_jwt` / `none` 混在を禁止 |
| PKCE | `required: () => true` | confidential client でも S256 必須 |
| subject type | `['public']` | pairwise は MVP 対象外 |
| TTL | AuthCode 300s / AccessToken 600s / IdToken 300s / Interaction 300s / Grant 30d | 短命化 |
| routes | authorize / token / userinfo / revoke / jwks のみ | discovery は `/.well-known/openid-configuration` |

### 1.2 無効化している機能（すべて `enabled: false`）

devInteractions, dPoP, backchannelLogout, ciba, mTLS, attestClientAuth, clientIdMetadataDocument, clientCredentials, deviceFlow, encryption, fapi, rpInitiatedLogout, introspection, jwtIntrospection, jwtResponseModes, pushedAuthorizationRequests, registration, registrationManagement, richAuthorizationRequests, resourceIndicators, requestObjects, rpMetadataChoices, jwtUserinfo, webMessageResponseMode, openid4vci

→ **有効なのは revocation のみ**。metadata は有効機能のみを広告するため、RP が推測した grant を試しても route が存在しない。

### 1.3 起動時バリデーション（fail fast）

- `OIDC_ISSUER` は `NEXT_PUBLIC_APP_URL` と同一 origin（path / query / fragment 禁止）、本番は HTTPS 必須
- `OIDC_JWKS_JSON`: RSA/RS256/sig のみ、`kid` 必須かつ重複不可、private key は厳密に 1 本（`createPrivateKey` で検証）
- `OIDC_ADAPTER_ENCRYPTION_KEY`: base64 で 32 バイト
- 本番で `DEBUG` が `oidc-provider` 名前空間を有効化している場合は起動拒否（v9 は logger 注入に非対応で debug 経由のログは redact されないため）

## 2. 依存監査（`pnpm audit`, 2026-10-13）

| advisory | 深刻度 | 経路 | 直接依存か | 判定 |
|---|---|---|---|---|
| `esbuild <=0.24.2` | moderate | `drizzle-kit > @esbuild-kit/core-utils > esbuild` | devDependency のみ | **受理**。ビルド時のみに入り、本番 bundles には含まれない。drizzle-kit 更新時に解消予定 |
| `postcss <8.5.23` 系（3 件） | moderate / high ×2 | `next > postcss` | 次世代 framework の推移依存 | **受理**。Next.js 側の更新で解消。CSS 変換のみに影響し、OIDC 経路には無関係 |
| `braces <=3.0.3` | high | `eslint-config-next > micromatch > braces` | lint 時のみ | **受理**。実行時コードには入らない |

**`oidc-provider` / `openid-client` / `drizzle-orm` / `pg` / `next` 本体への直接 advisory は 0 件。**

`openid-client@6.8.8` は E2E の RP 検証用に devDependency として追加した（`generateKeyPairSync` による署名検証と並行して、標準ライブラリとしての相互運用性確認に使う）。

## 3. 相互運用テスト（実通信）

`src/test/e2e/oidc-flow.test.ts`（実 HTTP、Node の http server、`Authorization Code + PKCE S256`）:

| # | 項目 | 結果 |
|---|---|---|
| 1 | Discovery が有効 endpoint / RS256 / code のみ / scope 3種のみを広告 | green |
| 2 | JWKS が公開鍵のみ・`kid` 付与・private 非開示 | green |
| 3 | login → consent → callback → token → ID Token（署名検証）→ UserInfo → revoke の一連 | green |
| 4 | code replay で 400 `invalid_grant` | green |
| 5 | revoke 後の UserInfo が 401 | green |
| 6 | PKCE verifier 不一致で 400、誤った client secret で 401 | green |
| 7 | redirect 改ざん / prefix redirect / Implicit / plain PKCE / nonce 欠落 / state 欠落 / 未知 scope / offline_access / resource 指定 / 未登録 client をすべて 400（redirect しない）で拒否 | green |
| 8 | 未ログイン時は `/login?returnTo=` へ 303 し、interaction を再開しない | green |
| 9 | public client の UserInfo に profile 系 claim が出ない | green |
| 10 | アカウント停止後は既存 access token の UserInfo が 401 | green |

`src/test/security/oidc-transport.test.ts`: no-store / Pragma / Referrer-Policy / nosniff / X-Frame-Options / CSP frame-ancestors が OIDC 全 endpoint に出ること、Host 不一致で 400、authorize / token / interaction のレート制限が 429 + `Retry-After` を返すこと。

## 4. コードレビューで検出した問題と対応

| 発見 | 影響 | 対応 |
|---|---|---|
| `new provider.Grant(userId, clientId)` が誤ったシグネチャで `accountId` が未設定 | consent 後に `accountId mismatch` で全ログインが失敗 | `new provider.Grant({ accountId, clientId })` に修正（Gate A §2.3） |
| ID Token の `sub` が raw user id だった | client 間で同一ユーザーだと判明する（トラッキング） | `findAccount` の `accountId` を client 毎の opaque subject に変更 |
| `auth_time` が ID Token に含まれない | spec §69 の要求未達 | login 結果のフィールドを `ts` に修正 + `claims` に `auth_time` を追加 |
| `adapter.find` のユーザー状態判定が opaque subject を解決していなかった | 停止アカウントが既存 token を継続利用できた | `users.id` または `oidc_user_subjects.subject` の双方で解決するよう修正 |
| client secret が可逆暗号化（AES-GCM）だった | DB と鍵の漏洩時に secret が平文に戻る | `hmac-sha256:` ダイジェスト保存へ移行、`compareClientSecret` をハッシュ比較に override、`secret_ciphertext` 列を削除 |
| `recordSecurityEvent` の第 1 引数が `string` | event type の取り忘れが検出できない（`email_change_notification_failed` が未登録だった） | `SecurityEventType` に必須化 |
| `oauth_clients` の CHECK 定義が migration で `$1` プレースホルダになっていた | migration が適用不能 | 定数からの `sql.raw` 生成に変更し、inlinable であることを unit テストで固定 |
| `/oauth2/interaction/` が未保護 | interaction 経路にレート制限なし | `RATE_LIMITS.oidc.interaction` を追加（60/10分） |

## 5. 品質ゲート結果

| コマンド | 結果 |
|---|---|
| `pnpm lint` | 0 error（warning 33 件は既存の `no-explicit-any` 以外の残存分） |
| `pnpm typecheck` | green |
| `pnpm test`（unit / security / integration / e2e） | **35 ファイル 213 テスト green** |
| `pnpm build` | green |
| `pnpm db:migrate` | green（`0010_operator` 〜 `0012_secret_column_drop` 適用済み） |

> テストは DB を共有するため `fileParallelism: false`（直列実行）で実行する。並列実行では E2E と integration が `oidc_artifacts` を競合して削除し、flaky になる。

## 6. 残存リスクと次回以降

1. **multi-process adapter 一致性の実測**（P25-E-04 の一部）が未実施。設計上は PostgreSQL を正本とするため process 非依存だが、2 プロセス起動試験を追加する。
2. **レート制限値の負荷検証**（P25-E-01）が未実施。値は暫定。
3. **RP 側の実装ずれ**: 本 Gate の E2E は自前 RP（Node + fetch）で実施している。複数 RP（フレームワーク別 2 種以上）での相互運用は未実施。
4. 本番公開は Phase 9 の運用 DoD（HTTPS / proxy / access log redaction / monitoring）完了後に限る。
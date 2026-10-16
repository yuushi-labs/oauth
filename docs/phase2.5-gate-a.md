# Phase 2.5 Gate A 記録 — 統合 Spike / adapter 評価 / threat model

**対象**: `docs/phase2.5-実装計画.md` P25-A-01〜A-05  
**作成日**: 2026-10-13（backfill。本 Spike は 2026-10-12 の OIDC 実装時に事実確認済みで、記録のみ未整備だった。記録を追記したうえで P25-A-02/03/04 を再検証し、`src/test/e2e/oidc-flow.test.ts` を実行して Gate A を事後承認した）  
**判定**: **承認（条件付き）** — 下記の残存項目は P25-B-01/B-04 と P25-E-01 の完了で解消済み

---

## 1. P25-A-01 依存評価（`oidc-provider`）

| 項目 | 実測値 | 判定 |
|---|---|---|
| バージョン | `oidc-provider@9.12.2`（`pnpm-lock.yaml` で固定） | 採用 |
| ライセンス | MIT | 採用可 |
| リポジトリ | `panva/node-oidc-provider`（OIDC 协议的脆弱性対応で活発に更新） | 採用可 |
| Node 互換 | 本パッケージは Node.js 22 以上を要求（`engines.node`）。`oidc-provider` v9 は Node 20+ で動作 | 適合 |
| Next 互換 | App Router の Route Handler からは使わず、custom Node server 内で Koa middleware として起動する構成を採用 | 適合（下記 §2） |
| セキュリティポリシー | GitHub Security Advisory 対応。`pnpm audit` での `oidc-provider` への advisory は **0 件**（2026-10-13 実行） | 適合 |
| 既知 CVE/GHSA | 本パッケージに直接紐づく advisory なし | 適合 |

採用理由: 計画 §3 の「protocol parser・署名検証・token/code 検証を自作しない」を満たす唯一の Node.js 向け Standards Track 実装であり、RFC 9700 / OIDC Core 1.0 / Discovery の適合は图书馆側ノート responsibility である。

## 2. P25-A-02 統合 Spike の結果

### 2.1 構成（採用案）

```
browser ──▶ scripts/server.ts (Node http)
              ├─ /oauth2/**, /.well-known/openid-configuration ─▶ oidc-provider (Koa) + PostgresOidcAdapter
              ├─ /oauth2/interaction/:uid ─▶ 自前 interaction UI（login / consent）
              └─ その他 ─▶ Next.js App Router（既存 pipeline / middleware をそのまま利用）
```

- Route Handler に Koa middleware を載せる変換は **不採用**（Response 制御・Cookie 署名・redirect 制御を二重に実装することになり、RFC 9700 の要件を漏らす）。
- 採用案は同一 origin 配下の custom Node server。reverse proxy で TLS を終端する構成でも Host / `X-Forwarded-Proto` の検証は既存の `validOidcRequestOrigin()` で行う。
- interaction UI は自前の HTML のみで、許可/拒否は `POST` + `Origin` 検証 + HMAC CSRF。provider 内部の session/resume cookie は provider が管理する。

### 2.2 実通信での検証（`pnpm vitest run src/test/e2e/oidc-flow.test.ts`）

| 手順 | 検証内容 | 結果 |
|---|---|---|
| Discovery | endpoint / `RS256` のみ / `code` のみ / `authorization_code` のみ / scope 3種 | green |
| JWKS | 公開鍵のみ、`kid` 付与、private 部件の非Disclosure | green |
| Authorization | PKCE `S256`、`state`/`nonce` 必須、redirect 完全一致、scope ⊆ client 許可 | green |
| Interaction | login prompt → consent prompt の 2 段 hopped resume | green |
| Token | `client_secret_basic` + code_verifier で Authorization Code + PKCE | green |
| ID Token | RS256 署名を JWKS の公開鍵で検証、`iss`/`aud`/`nonce`/`auth_time`/`sub` を確認 | green |
| UserInfo | 付与 scope に応じた claim のみ返却 | green |
| Replay | 同一 code の再交換は 400 `invalid_grant` | green |
| Revoke | `/oauth2/revoke` 後 UserInfo が 401 | green |
| 拒否系 | redirect 改ざん・prefix Redirect・Implicit・plain PKCE・nonce/state 欠落・未知 scope・resource 指定・未登録 client をすべて 400（redirect しない）で拒否 | green |

### 2.3 Spike で発見・修正した不具合（記録）

Spike を初めて実通信で通した結果、本体実装側に 3 件の欠陥が見つかり修正済みである。

1. **grant の accountId 未設定** — `new provider.Grant(user.id, clientId)` は誤ったシグネチャで、最初の引数が metadata として扱われるため `accountId` が空になり、再同意時に `accountId mismatch` で失敗していた。`new provider.Grant({ accountId, clientId })` に修正。
2. **`sub` が raw user id だった** — `oidc-provider` は ID Token / UserInfo の `sub` を `account.claims()` の値ではなく `accountId` で上書きする。opaque subject を claim に含める実装では不十分で、**`findAccount` が返す `accountId` 自体を client 毎の opaque subject に変更**して解決（`src/lib/oidc/subjects.ts`）。
3. **`auth_time` が欠落** — (a) library が読む login 結果のフィールドは `ts` であり `auth_time` ではない、(b) provider 設定の `claims` に `auth_time` が無いと claim が破棄される、の 2 点。両方修正。

いずれも「コードレビューでは検出できず、実通信でしか出ない」種別であり、Spike を計画の Gate に置いた根拠になる。

## 3. P25-A-03 adapter の保存対象と raw token 保管

### 3.1 保存対象

| モデル | 保存先 | ID の扱い | payload の扱い |
|---|---|---|---|
| Client / Interaction / Session / Grant / AuthorizationCode / AccessToken | `oidc_artifacts`（`model` + `id_hash` で主キー） | `HMAC-SHA256(lookupKey, id)` のみ保持。**raw id は保存しない** | AES-256-GCM 暗号化（`v1.<nonce>.<tag>.<ciphertext>`） |
| client → user の対応 | `oidc_user_grants` | grant id（ランダム） | scope / 最終利用時刻 |
| client 毎の識別子 | `oidc_user_subjects` | `sub_<random>`（client 毎・ユーザー毎に 1 本） | — |

検索は `id_hash` に対してのみ行い、raw code/token を復元する経路は存在しない。client secret も `hmac-sha256:` ダイジェストのみ保存し、平文は復元できない（P25-B-01/B-04 で移行済み、`oidc-provider` の `compareClientSecret` をハッシュ比較に override して plaintext 要件を解消した）。

### 3.2 atomic one-time consumption

`consume()` は単一の条件付き UPDATE で原子的に消費する。

```sql
UPDATE oidc_artifacts SET consumed_at = now()
 WHERE model = $1 AND id_hash = $2 AND expires_at > now() AND consumed_at IS NULL
 RETURNING id_hash
-- RETURNING が 1 行でなければ例外
```

8 並列の同時消費で成功がちょうど 1 回になることを統合テストで固定した（`src/test/integration/oidc-persistence.test.ts`）。

### 3.3 cluster / multi-process 挙動

- 本Provider は PostgreSQL を正本とするため、**Node プロセス数に依存しない**。`rateLimitHits` の Phase 2 reservation と同じ考え方。
- `SELECT ... FOR UPDATE` 相当の一意制約（`oidc_artifacts` の複合主キー）で複数プロセスからの code 消費が直列化される。
- **未実施**: 複数プロセスを実際に起動して一致性を測る試験（計画 P25-E-04 の一部）。同一 DB に対する 2 プロセス並行試験は未実装で、残存リスクとして §5 に記載する。

## 4. P25-A-04 fallback の判断

- fallback（独立 Node listener + reverse proxy）は **不要**。custom server への統合で security control を落とさずに要件を満たせたため。
- 運用構成の前提（reverse proxy の Host / `X-Forwarded-Proto` 上書き、信頼 proxy hop、鍵 rotation）は `README.md`「自作サービスからOIDCログイン」に記載済み。
- interaction UI の信頼境界は本 Gate で明記する: **RP からは同意・認証の判断材料を一切受け取らない**。同意・ログインの判断はアプリセッションと DB のみで決まり、provider の session/resume cookie が確立した状態でのみ実行される。RP が渡せる値（scope / client_id / redirect_uri）はすべて allowlist・完全一致で検証される。

## 5. P25-A-05 Threat model と Gate A 判定

詳細は [`phase2.5-threat-model.md`](./phase2.5-threat-model.md) に分離して記載。

### Gate A DoD との対応

| Gate A 条件 | 結果 |
|---|---|
| server integration が実行可能 | ✅ `scripts/server.ts` の custom server（`createOidcHandler()` は E2E から再利用） |
| adapter が実行可能 | ✅ PostgreSQL adapter、raw token 保管なし、原子1回消費を統合テストで固定 |
| UI interaction が実行可能 | ✅ login / consent の 2 段 prompt、POST + Origin + CSRF |
| 禁止フローを無効化できる | ✅ `responseTypes: ['code']` / `grantTypes: ['authorization_code']` / clientAuthMethods 2種のみ / dPoP・PAR・mTLS・deviceFlow 等は無効。E2E で拒否を確認 |
| token 平文保存が残っていない | ✅ id は HMAC、payload は AES-GCM、client secret は HMAC |

**判定: 承認。** ただし (1) client secret のハッシュ化、(2) multi-process adapter 一致性の実測は未了だったため、実装本体はここに到達した時点で一度保留し、上記 2 件の完了を条件として M2.5 へ進めることとした。両件は 2026-10-13 に完了した。
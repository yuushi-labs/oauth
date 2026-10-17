# P25-E-05 結果 — 複数 RP での相互運用

**実施日**: 2026-10-17
**対象**: `src/test/e2e/oidc-interop-go.test.ts`（2 件 green）
**手段**: `interop/rp-go`（Go / `coreos/go-oidc3`）を RP として実装し、既存の Node e2e と同じ provider に対して実 HTTP で認可フローを実行する

---

## 1. なぜ 2 つ目の RP が必要か

`src/test/e2e/oidc-flow.test.ts` は Node の `openid-client` v6 を RP として使う。同じ実装同士での整合しか分からないため、`coreos/go-oidc3`（Go）を 2 つ目の RP として追加し、**独立したスタックが Discovery・JWKS 検証・audience・nonce をどう解釈するか**を確認する。

| RP | ライブラリ | 検証対象 |
|---|---|---|
| Node | `openid-client` v6 | 既存の主系 E2E（8 件） |
| Go | `coreos/go-oidc3` v3.21.0 | 本テスト（2 件） |

---

## 2. Go RP の実装

`interop/rp-go/main.go` は次の手順を実行し、検証済み claim を JSON で stdout に出す。

1. `oidc.NewProvider(ctx, issuer)` — Discovery を取得し、endpoint を確定
2. `oauth2.Config.Exchange()` で code を token に交換（client secret は `client_secret_basic`）
3. `provider.Verifier(&oidc.Config{ClientID})` で **ID Token の署名（JWKS）・issuer・audience・有効期限を検証**
4. `provider.UserInfo()` で userinfo を取得し claim をデコード
5. ID Token に nonce が一致することを確認（一致しなければ非ゼロ終了）

いずれも検証に失敗した場合は非ゼロ終了するため、**テスト側の assertion へ到達しないこと自体が検証結果**になる。

### 2.1 実行環境

Go ツールチェーンはリポジトリに同梱せず、`GO_BINARY` で解決する。CI では Go が用意されている場合のみこのテストが実行される（無ければ skip し、stderr に理由を記す）。

```bash
# ローカルでの実行例
go build -o /tmp/rp-go ./interop/rp-go
GO_BINARY=go GO_RP_BINARY=/tmp/rp-go pnpm vitest run src/test/e2e/oidc-interop-go.test.ts
```

---

## 3. 検証結果

### 3.1 正常系（`completes the login and exposes verified claims to an independent OIDC stack`）

Go RP が実測した値:

| 項目 | 期待 | 実測 |
|---|---|---|
| `iss`（Discovery から） | issuer と一致 | ✅ 一致 |
| `aud`（ID Token） | client ID と一致 | ✅ 一致 |
| `sub`（ID Token / userinfo） | client ごとの不透明 ID（`sub_` 始まり、raw user ID を含まない） | ✅ 一致 |
| `nonce`（ID Token） | 認可リクエストの nonce と一致 | ✅ 一致 |
| `auth_time` / `exp` | 数値 / 現在より後・5 分以内 | ✅ 条件を満たす |
| access token TTL | 600 秒以下 | ✅ 599 秒 |
| `email` / `email_verified`（userinfo） | 登録済みメール / true | ✅ 一致 |
| `preferred_username` / `name`（userinfo） | username | ✅ 一致 |

**観測された仕様上の挙動**: ID Token には `iss/sub/aud/exp/iat/auth_time/nonce` のみが含まれ、`profile`・`email` の claim は **UserInfo から返る**。これは §69.5 が定める「scope に応じて UserInfo で返す」設計そのもので、Go RP からの検証でも同じ挙動であることを確認した（Node RP と同じ）。

### 3.2 拒否系（`rejects a tampered code and a wrong client secret`）

| ケース | 結果 |
|---|---|
| 誤った client secret で exchange | ✅ 非ゼロ終了（`invalid_client`） |
| 使わない／使い切った code で exchange | ✅ 非ゼロ終了（`invalid_grant`） |

---

## 4. 判定

**M2.5 §69.8「主要な RP ライブラリとの相互運用 E2E」を満たす。** Node と Go という独立した 2 スタックが、Discovery・署名検証・audience・nonce・scope 別の claim 開示・拒否系のすべてで同じ結果を得た。

### 残存リスク・次段階

1. 本テストは `openid-client` と `go-oidc3` の 2 種のみ。Java（`openid4java` / Spring Security）等、RP の流派をもう 1 種加える場合は CI に当該ツールチェーンを導入する必要がある
2. Go テストは「ツールチェーンがあれば実行、なければ skip」であるため、**CI が Go を導入しないと常時 skip される**。M2.5 DoD として恒久的に green させるには CI 側にも Go を用意する必要がある（Phase 9 の CI 整備時に対応）

---

## 5. 対応するタスク

- [x] P25-E-05: 2 つ目の RP（Go / `coreos/go-oidc3`）での相互運用 E2E

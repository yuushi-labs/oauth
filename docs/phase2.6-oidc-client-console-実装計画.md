# Phase 2.6 実装計画 — ログイン後画面と OIDC/OAuth 2.0 アプリ管理コンソール

> 対象: M2.5 で実装した OIDC Provider の client 登録を **CLI のみ** から **ログイン後の画面（セルフサービス）** へ拡張し、あわせてログイン後の画面遷導（設定ナビ）を整備する。
> 前提工程: Phase 2.5（M2.5、PR #3 で main マージ済）。本書は実装前に作成した計画であり、進捗はチェックボックスで管理する。
> 初版作成日: 2026-10-16 / 状態: 実装中

---

## 1. 背景と目的

### 1.1 現状の課題

| 課題 | 現状 |
|---|---|
| client 登録の接点 | `pnpm oidc:client`（CLI）のみ。サーバ管理者しか登録できない |
| 検証ロジックの埋没 | redirect URI / web origin / scope の検証が `scripts/oidc-client.ts` 内にあり、Web から再利用できない |
| 画面遷移 | ログイン後の `/` から `/settings/connected-apps` へのリンクが 1 本のみ。`/settings` のインデックスも共通ナビも layout も無い |
| 接続可否の確認 | redirect URI・secret が正しいかを CLI からは確認できない（実ログインが必要なため） |

### 1.2 目的

1. ログイン後ページから設定画面へ遷移できるようにする（共通ナビ＋設定ホーム）
2. その画面で OIDC/OAuth 2.0 アプリ（client）を**利用者が自分で**作成・編集できるようにする
3. redirect URI・scope・web origin・secret を画面で確認・更新できるようにする
4. **redirect URI と secret を使って実際に接続し、返ってくるユーザー情報（claim）を画面で確認**できるようにする（接続テスト）

---

## 2. 決定事項

| ID | 決定 | 理由 |
|---|---|---|
| D-26-01 | client 登録は**任意のログインユーザーのセルフサービス**（active ＋ email_verified） | 利用者が自分で連携アプリを作れるようにするため |
| D-26-02 | `oauth_clients.owner_user_id` を追加し、編集は**所有者 or admin/superadmin のみ**。他人の client は 404 | セルフ规模化での IDOR 防止。所有者が消えた場合は `SET NULL` で残す |
| D-26-03 | 1 ユーザーあたりの client 上限は `OIDC_MAX_CLIENTS_PER_USER`（既定 5） | 大量登録・スパム抑止 |
| D-26-04 | `client_type`（public/confidential）は**作成時のみ変更不可** | `token_endpoint_auth_method` と `secret_hash` の DB CHECK 制約と整合させるため。変更は作り直しで対応 |
| D-26-05 | secret 再生成・client 失効は**再認証必須**（`requireReauth`、5 分猶予） | 高Impact 操作の犯行抑止。既存の `POST /api/auth/reauth` を再利用 |
| D-26-06 | **接続テスト用 redirect URI は利用者が手動で追加する**（自動登録しない）。詳細画面に推奨 URI の提示とコピーボトンを置く | 登録内容をユーザーが把握したうえで追加する運用にする |
| D-26-07 | consent 画面（`/oauth2/interaction/*`）に**登録者（owner の username と作成日）を必須表示**する | セルフサービス化により運営者名のなりすまし余地が生じるため、利用者が判断できる情報を必ず開示する |
| D-26-08 | 接続テストは同一オリジンの callback（`${NEXT_PUBLIC_APP_URL}/settings/applications/test/callback`）＋ PKCE S256。code / verifier / secret は**サーバ内のみ**で扱い、ログ・セキュリティイベントに出さない | 追加ポートやローカル 常駐 listener を避けつつ、実フローを検証できる |
| D-26-09 | client の読み取りは adapter が毎回 DB から行う（静的/メモリキャッシュなし）のため、**編集は即時反映**。ただしテストで実証する | 反映延迟の悬念を排除する |
| D-26-10 | client 関連 API は `withAuthPipeline`（Origin → CSRF → セッション）＋ ユーザー単位レート制限を適用 | 既存 API 規約の維持 |

---

## 3. 画面構成

```
/                                        ログイン後のハブ（アカウント情報＋設定メニューへの導線）
/settings                                設定ホーム（layout のサーバ側ガードで未ログインは /login?returnTo=）
/settings/account                        アカウント情報
/settings/connected-apps                 接続済みサービス（既存・layout でナビ表示）
/settings/applications                   アプリ一覧 ＋ 新規作成フォーム      ← 新規
/settings/applications/[clientId]        詳細・編集・secret 再生成・失効・接続テスト  ← 新規
/settings/applications/test/callback     接続テストの受信 callback（GET）    ← 新規
```

### 3.1 共通ナビ（`src/app/settings/layout.tsx`）

- サーバ側でセッション検証。未ログインは `redirect('/login?returnTo=<path>')`
- `<SettingsNav>`: アカウント / 接続済みサービス / アプリケーション。`aria-current="page"` で現在地を明示
- `middleware.ts` に `/settings` 配下の `Cache-Control: no-store` を追加

### 3.2 アプリ作成フォーム（`/settings/applications`）

| 項目 | 制約 |
|---|---|
| アプリ名 | 必須・1〜100 文字・制御文字/改行禁止 |
| 運営者名 | 必須・1〜100 文字・制御文字/改行禁止（consent 画面に表示される） |
| 種別 | public / confidential（**作成時のみ**選択可） |
| リダイレクト URI | 1 件以上。https 必須（localhost / 127.0.0.1 / [::1] のみ http 許可）、userinfo・password・fragment 禁止 |
| 許可 scope | `openid` 必ず 포함、`profile` / `email` から複数選択、allowlist 外は不可 |
| Web origin | public のみ。origin 完全一致（path・query・fragment なし）、confidential では指定不可 |

作成時、**client secret はこの 1 回だけ**表示する（`hmac-sha256:` ダイジェストのみ保存）。

### 3.3 詳細・編集（`/settings/applications/[clientId]`）

- 名前 / 運営者 / redirect URI（複数追加・削除）/ scope / web origin を編集可能。**種別は readonly 表示**
- ワンクリックコピー: issuer / Discovery URL / client_id
- secret 再生成（再認証）→ 新 secret を 1 回だけ表示
- 失効（再認証）→ `active=false` ＋既存 grant / token を破棄（不可逆）
- 接続テスト:
  1. 推奨 callback URI（`${NEXT_PUBLIC_APP_URL}/settings/applications/test/callback`）をコピーし、利用者が redirect URI へ**手動追加**する
  2. 「接続テスト」→ 303 で `/oauth2/authorize` へ（同一ブラウザの既存セッションで同意）
  3. callback で code を受領 → state 検証 → **サーバ内で** token 交換 → userinfo 取得
  4. 返ってきた claim を表で提示（`sub` / `name` / `preferred_username` / `email` / `email_verified`）

---

## 4. データモデル変更

`oauth_clients` に以下を追加（migration `0013_*`）。

| カラム | 型 | 内容 |
|---|---|---|
| `owner_user_id` | `text` NULL REFERENCES `users(id) ON DELETE SET NULL` | 登録者。CLI 登録は NULL |
| `oauth_clients_owner_user_id_idx` | index | owner での一覧取得用 |

`client_type` 制約により `secret_hash` と `token_endpoint_auth_method` の組み合わせは DB CHECK で担保済み（変更しない）。

---

## 5. ライブラリ層

| ファイル | 責務 |
|---|---|
| `src/lib/oidc/client-validation.ts`（新規） | `validateRedirectUri` / `validateWebOrigin` / `parseClientInput`（zod）。CLI から移植した検証を単一正本化 |
| `src/lib/oidc/clients.ts`（新規） | `createOidcClient` / `updateOidcClient` / `rotateOidcClientSecret` / `revokeOidcClient` / `listOidcClientsForUser` / `findOidcClientForUser`。zod 検証 → DB → `recordSecurityEvent` → 失効時は既存 `revokeUserOidcGrantsForClient` / `purgeOidcGrantArtifacts` 再利用 |
| `src/lib/auth/roles.ts`（新規） | `canManageAnyOidcClient` / `canManageOidcClient(user, client)` |
| `src/lib/oidc/client-test.ts`（新規） | 接続テストの state/verifier 発行・検証、token 交換、userinfo 取得 |
| `scripts/oidc-client.ts`（既存） | 上記 `client-validation` / `clients` を使う thin wrapper へリファクタ（CLI の入出力は不変） |

---

## 6. API

| Method | Path | 概要 | 追加要件 |
|---|---|---|---|
| GET | `/api/auth/oidc/clients` | 自分の client 一覧（接続中ユーザー数・最終利用を JOIN） | 認証 |
| POST | `/api/auth/oidc/clients` | 作成。`{ clientId, clientSecret? }` を返す（secret は 1 回のみ） | 認証・レート制限・上限チェック |
| PATCH | `/api/auth/oidc/clients/[clientId]` | 名前 / 運営者 / redirect URI / scope / web origin 更新 | 認証・所有者確認 |
| POST | `/api/auth/oidc/clients/[clientId]/secret` | secret 再生成 | 認証・所有者確認・**再認証** |
| DELETE | `/api/auth/oidc/clients/[clientId]` | 失効＋既存 grant / token 破棄 | 認証・所有者確認・**再認証** |
| POST | `/api/auth/oidc/clients/[clientId]/test/start` | 接続テスト開始（authorize URL へ 303） | 認証・所有者確認 |
| GET | `/api/auth/oidc/clients/[clientId]/test/callback` | code 交換 → userinfo 取得 | 認証・state 検証 |

レート制限は `RATE_LIMITS.oidcClients`（create: 1h/5、mutation: 10min/30）を追加し、`rateLimitKeys.oidcClientUser(userId)` を使用。

---

## 7. セキュリティ設計（セルフサービス固有のリスクと対策）

| リスク | 対策 |
|---|---|
| 運営者名によるなりすまし | consent 画面に登録者（username・作成日）を**必ず表示**（D-26-07）。`escapeHtml` 済みの描画を維持 |
| フィッシング用のアプリ名 | 制御文字・改行を validation で禁止。consent HTML は既存どおり escape |
| open redirect / リダイレクト悪用 | https 強制（loopback のみ http 可）、完全一致登録制、`resource` / `request` 等の未知パラメータは `scripts/server.ts` の `exactAuthorizationRequest` が既に拒否 |
| 大量登録 | ユーザー毎上限 5、レート制限、`rate_limited` イベント記録 |
| secret の漏えい | 平文は保存しない（HMAC ダイジェスト）。生成/再生成の応答のみ、1 回表示、`no-store`、ログ redact テストで担保 |
| IDOR | 全操作で所有者（または admin）を確認。他人の client は 404 で存在を秘匿 |
| CSRF / クロスオリジン | 既存の `withAuthPipeline`（Origin + `X-CSRF-Token`）を全 mutation に適用 |
| キャッシュ漏えい | `/settings` 配下を `Cache-Control: no-store` |
| テスト用 code の漏えい | code / verifier / secret はサーバ内のみで処理。callback 応答には claim のみ含める |

---

## 8. テスト計画

| 種別 | 内容 |
|---|---|
| unit | `client-validation.test.ts`: redirect URI / web origin / scope / 名前・運営者文字種の表駆動テスト。`roles.test.ts` |
| security | 未ログイン 401、他人の client での作成・更新・失効・secret 再生成が 404（IDOR）、CSRF・Origin 違反の拒否、secret が API 応答・DB・ログに残らない、`<script>` を入れたアプリ名が同意画面で無害、レート制限 |
| integration | client CRUD、所有者制約、secret のハッシュ保存、失効で grant / artifact 破棄、**編集が次の token 交換へ即時反映**（D-26-09 の実証）、上限 5 の強制 |
| e2e | 画面 → client 作成 → 接続テスト → userinfo claim 表示（既存 `pnpm test:e2e` ハーネスに追加） |

---

## 9. DoD

- [x] `pnpm lint` / `pnpm typecheck` / `pnpm test`（43ファイル 262件）/ `pnpm test:e2e`（12件）/ `pnpm build` がすべて green（M2.5 closeout で Go 相互運用 e2e が加わった後の最終確認。2026-10-17）
- [x] 画面から client を作成し、redirect URI と secret で userinfo の claim を確認できる（開発サーバで smoke 実行済み・e2e でも実証）
- [x] secret の平文が DB・ログ・セキュリティイベントに残らないことをレビューで確認（`secret_hash` は `hmac-sha256:` のみ・一覧/詳細ページに平文は出ない）
- [x] 他人の client へアクセスできないことをテストで実証（security 2ファイル 17件 / integration 7件）

---

## 10. Todo

### 10-A 基盤

- [x] **P26-A-01** `src/lib/oidc/client-validation.ts`（redirect URI / web origin / client 入力の zod 検証）
- [x] **P26-A-02** `src/lib/oidc/clients.ts`（CRUD / secret 再生成 / 失効、一覧取得）
- [x] **P26-A-03** `src/lib/auth/roles.ts`（`canManageAnyOidcClient` / `canManageOidcClient`）
- [x] **P26-A-04** `scripts/oidc-client.ts` を上記へ委譲する thin wrapper にリファクタ（CLI 挙動不変）
- [x] **P26-A-05** `src/lib/db/schema.ts` に `ownerUserId` 追加 ＋ migration `0013_*` 生成・適用
- [x] **P26-A-06** `src/lib/env.ts` に `OIDC_MAX_CLIENTS_PER_USER`（既定 5）／`.env.example` 追記
- [x] **P26-A-07** `RATE_LIMITS.oidcClients` と `rateLimitKeys.oidcClientUser` を追加

### 10-B API

- [x] **P26-B-01** `GET/POST /api/auth/oidc/clients`
- [x] **P26-B-02** `PATCH/DELETE /api/auth/oidc/clients/[clientId]`
- [x] **P26-B-03** `POST /api/auth/oidc/clients/[clientId]/secret`（再認証）
- [x] **P26-B-04** `src/lib/oidc/client-test.ts`（state/verifier 発行・検証、token 交換、userinfo）
- [x] **P26-B-05** 接続テストの start / callback エンドポイント

### 10-C 画面

- [x] **P26-C-01** `src/app/settings/layout.tsx`（サーバ側ガード＋`SettingsNav`）／`middleware.ts` の no-store 追加
- [x] **P26-C-02** `/settings`（設定ホーム）と `/settings/account`（`/` から移設）、`/` をハブ化
- [x] **P26-C-03** `/settings/applications` 一覧＋新規作成フォーム
- [x] **P26-C-04** `/settings/applications/[clientId]` 詳細・編集（コピーボタン、種別 readonly）
- [x] **P26-C-05** secret 1 回表示ダイアログ＋再生成・失効（再認証ダイアログ）
- [x] **P26-C-06** 接続テスト UI（推奨 URI のコピー・追加誘導 → テスト実行 → claim 表）
- [x] **P26-C-07** `messages/ja.ts` へ UI 文言を追加（一元化）

### 10-D 同意画面

- [x] **P26-D-01** `scripts/server.ts` の consent HTML に登録者（owner username・作成日）を表示。`oauth_clients.owner_user_id` 取得（`owner_user_id` が NULL の CLI 登録は「運営者による登録」を表示）

### 10-E テスト

- [x] **P26-E-01** unit: `client-validation.test.ts`（11件）/ `roles.test.ts`（2件）/ `client-test-state.test.ts`（7件）green
- [x] **P26-E-02** security: `oidc-client-console.test.ts`（8件: 所有者境界・IDOR・secret は HMAC のみ・上限）/ `oidc-client-console-routes.test.ts`（9件: 404 秘匿・再認証必須・CSRF/Origin 拒否・テスト URI 未登録と secret 未入力の拒否・no-store）green
- [x] **P26-E-03** integration: `oidc-client-console.test.ts` 7件 green（CRUD・所有者/管理者境界・secret ローテーション・失効時の artifact 破棄・adapter 経由の即時反映・上限強制・一覧メタデータ）
- [x] **P26-E-04** e2e: `client-console.test.ts` 2件 green（実HTTP で authorize → consent → code 交換 → userinfo claim 取得。consent に登録者が出ることも実証。誤った secret は拒否）

### 10-F ドキュメント

- [x] **P26-F-01** `README.md`（管理画面・接続テストの手順、テスト用 callback URI の手動追加）
- [x] **P26-F-02** `実装Todo.md` へ M2.6 を追記
- [x] **P26-F-03** `docs/phase2.5-実装計画.md` / `phase2.5-threat-model.md` へ本フェーズの影響を反映

### 10-G 最終確認

- [x] **P26-G-01** `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm build` green
- [x] **P26-G-02** secret 平文が DB・ログ・イベントに残らないことのレビュー確認

---

## 11. 実装中に発見・修正した欠陥（既存コード）

| 欠陥 | 影響 | 修正 |
|---|---|---|
| `RateLimiter.finishFailedAttempt` が SERIALIZABLE の一時競合（SQLSTATE 40001）を再試行せず、`POST /api/auth/login` が **500** を返していた | ログイン不能（管理画面を含む全機能が利用不可） | `src/lib/auth/rate-limit.ts`：予約/確定の双方を `runSerializable` で再試行（40001/40P01、5回・指数バックオフ+jitter）に変更。あわせて分離レベルを predicate lock の レンジロック競合を決めない `repeatable read` に変更（行ロック `FOR UPDATE` は維持）。回帰テストを `src/test/integration/rate-limit.test.ts` に追加 |
| API の想定外エラーが `normalizeError` に落ち、原因がどこにも残らない | 障害調査が不可能 | `src/lib/api/utils.ts` の `handleApiError` で `ApiError` 以外のみ `logger.error` に記録（クライアントには返さない） |


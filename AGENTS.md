# AGENTS.md — リポジトリ固有の知識

## プロジェクト

「超本格アカウント・認証システム」。Next.js 15 (App Router) + TypeScript strict + Drizzle ORM + PostgreSQL 16 +
Tailwind v4。自作サービス向け OIDC Provider も同梱（`oidc-provider`）。

正典（優先順位の高い順）:
1. `超本格アカウント・認証システム仕様書 v1.3.md`（全 69 章）
2. `実装計画.md` v1.6（フェーズ分解・DoD・決定事項 C-xx / D-xx）
3. `実装Todo.md`（進捗の正本。チェックボックス）
4. `docs/phase*-*.md`（フェーズごとの実装レベル詳細。最新フェーズが最も具体的）

## コマンド

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（`vitest run`）
- `pnpm test:unit` / `test:security` / `test:integration` / `test:e2e`
- `pnpm dev`（`node --import tsx scripts/server.ts dev`。Next + OIDC を 1 プロセスで起動）
- `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:verify-migrations`
- `pnpm seed`（roles）/ `pnpm secrets:gen`（`.env` 生成）

テストは `fileParallelism: false`、`src/test/**` に集約（D-18）。テストは実際の PostgreSQL を使うものが多い。
`src/test/setup.ts` が必須環境変数（pepper 類 + `TOTP_ENCRYPTION_KEY`）を注入する。

## 構成の要点

- `src/lib/env.ts` — zod で起動時 fail fast。`TOTP_ENCRYPTION_KEY` は **Base64 32 バイト**必須（既に検証済み）。
- `src/lib/errors.ts` — `ERROR_CODES` / `ERROR_STATUS` / 既定メッセージ。新コードは 3 か所すべてに足す。
- `src/lib/api/utils.ts` + `src/lib/auth/pipeline.ts` — 全 API の共通パイプライン
  （Origin → CSRF → session → user → body → reauth → handler）。新 API は必ず `withAuthPipeline` を通す。
- `src/lib/auth/session.ts` — サーバサイドセッション。`SessionData` 型は pipeline / reauth / tests が依存。
  変更時は `src/test/security/*` の SessionData フィクスチャ（7 ファイル）を確認する。
- `src/lib/auth/rate-limit.ts` — PostgreSQL が唯一の正本（D-05）。`src/config/rate-limits.ts` に値、
  `src/lib/auth/rate-limit-keys.ts` にキー生成を集約（コード散在禁止）。
- `src/lib/db/schema.ts` — 全テーブル。migration は `drizzle/`（up のみ）。最新は `0016`。
- `scripts/server.ts` — OIDC interaction UI（login / consent）を素の HTML で描画。CSP は script 禁止。
- `src/lib/util/logger.ts` — secret redaction。機密キーは `SENSITIVE_KEYS` に追加する。
- `src/messages/ja.ts` — UI 文言・メール文面の一元管理（D-30-18）。`m('a.b.c')` で型安全に引く。

## 決定事項の慣習

- フェーズごとに `D-<phase>-<n>` を採番する（Phase 3 = D-30-xx、Phase 4 = D-31-xx、Phase 4-B = D-32-xx、
  **Phase 5 = D-33-xx**）。`実装計画.md` §9 の D-01〜D-27 は全フェーズ共通のロック済み決定。
- 仕様と実装が食い違ったら「実装を仕様に寄せる」か「仕様に制約を明記して緩和する」かを必ず文書化する。

## 注意（過去に踏んだ地雷）

- `cookies()`（Next の request scope）は **Route Handler を直接呼ぶテストで 500 になる**。
  Cookie の読みは `request.cookies`、書きは `Set-Cookie` ヘッダを使う（Phase 4-B D-32-17 / BUG-15）。
- Server Component の描画中は Cookie を**変更できない**。発行は Route Handler で行う（BUG-15）。
- `process.env` を読むモジュール（OAuth registry 等）をクライアントコンポーネントから import すると
  hydration mismatch になる（BUG-11）。サーバ側で読んで props で渡す。
- OAuth callback では `Origin` / `Referer` を検証しない（provider からの top-level GET のため必ず 403 になる。
  CSRF は `state` 1 回限り消費 + PKCE で担保。BUG-12）。
- 一意性は **partial unique index**（`deleted_at IS NULL`）のみ。通常 UNIQUE は付けない（D-04）。
- 「1 回限り」の値（token / state / claim）は **`UPDATE ... WHERE <未消費>` の更新行数**で消費する。
  read → 判定 → write の 2 段書きは禁止（D-16）。

## 現在の到達点（2026-10-25 時点）

M0〜M6 完了（Phase 0 / 1 / 2 / 2.5 / 2.6 / 3 / 4 / 4-B / 5 / **6**）。**次は Phase 7（M7）: 管理者 / RBAC / 監査**。
Phase 6 の計画は `docs/phase6-passkey-webauthn-実装計画.md`（D-34-01〜D-34-16）。

Phase 6 の要点:
- `src/lib/auth/passkey/config.ts` — `rpID` / `rpName` / 許可 origin を**環境変数から明示解決**する。
  **request / headers を受け取らない**（Host 偽装での検証迂回を防ぐ・D-34-01）。`isPasskeyEnabled()` は
  設定不備でも throw せず `false`（ログイン画面を壊さない）。
- `src/lib/auth/passkey/challenge.ts` — challenge は TTL 5 分・**単文 UPDATE の更新行数で 1 回限り消費**（D-34-05 / D-16）。
- `src/lib/auth/passkey/registration.ts` / `authentication.ts` — 検証は `@simplewebauthn/server` に委譲（自作禁止・D-34-03）。
  challenge は**文字列のまま渡さず** `isoBase64URL.toBuffer()` でバイト列に変換して渡す（文字列渡しは UTF-8 再エンコードで値が変わる）。
- `src/lib/db/queries/webauthn.ts` — `advanceSignCount` は単文 UPDATE。`newCounter === 0` は `last_used_at` のみ更新（D-34-06）。
- `src/lib/auth/strong-reauth.ts` — 検証器配列は「パスワード＋コード → Passkey」の順（D-34-11）。
  `strong_reauth_methods` は Passkey を 1 件以上持つときだけ `['password','passkey']`。
- UI は `PasskeyPanel`（登録・一覧・削除）／`PasskeyLoginButton`（`/login`）／`StrongReauthDialog` の Passkey タブ。
  Passkey の有無は**サーバ側で判定して props で渡す**（BUG-11）。
- ログの `SENSITIVE_KEYS` に `credentialid` / `publickey` / `challenge` / `signature` 等を追加済み。

Phase 5 で得た知見（次フェーズでも効くもの）:
- 2FA 有効化（`setup` → `verify`）は `enabled=false` の保留行に対してコード検証する。
  `consumeTotpCounter` / `verifyAndConsumeTotp` の `allowPending` を忘れると `verify` が常に 400 になる。
- `totp_pending = true` の保留セッションは既定で全 API を 403 `TOTP_REQUIRED`。例外を作るのは
  `challenge/verify` / `logout` / `logout-all` / `csrf` / `me` の 5 経路だけで、`2fa-static-checks.test.ts` が固定する。
- 無効化・再生成は「強い再認証（パスワード＋コード）」。判定順は**再認証 → コード**で、失敗時にコードを消費しない。
  検証器は `src/lib/auth/strong-reauth.ts` の配列に足す（Phase 6 の Passkey は 1 件足すだけ）。
- 未確認 email は 403 `EMAIL_NOT_VERIFIED` でログインさせない（D-33-21）。再送は未認証の
  `POST /api/auth/resend-verification`（`requireAuth: false`・応答は常に同一・D-33-22）。
- 2FA 系のレート制限キーは `rateLimitKeys.twoFactorUser`、値は `RATE_LIMITS.twoFactor`（10/5 分）。
- **Drizzle は driver エラーを `DrizzleQueryError` で包む**ので SQLSTATE は `err.cause.code` にある。
  `err.code` だけを見ると `23505`（一意制約違反）を取り逃し、重複登録が 500 になる。
  `src/lib/db/sql-state.ts` の `getSqlState` / `isUniqueViolation` を使う。
- **応答文言は `src/messages/ja.ts` が正典**。ルートに直書きした文言が正典とずれると、
  成功経路と重複経路で応答が割れ、それ自体が列挙オラクルになる（§46）。`register-duplicate.test.ts` が固定する。
- 保留セッションの封じ込めのソース走査は **`denyTotpPending: false` の 4 経路**
  （`challenge/verify` / `logout` / `logout-all` / `me`）。`csrf` は許可経路だが `withAuthPipeline` を通らないため
  `false` を書かない（D-33-26）。「許可経路 5 つ」と「コード上の `false` 4 つ」は一致しない。

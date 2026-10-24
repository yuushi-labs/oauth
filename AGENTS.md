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

## 現在の到達点（2026-10-24 時点）

M0〜M4 完了（Phase 0 / 1 / 2 / 2.5 / 2.6 / 3 / 4 / 4-B）。**次は Phase 5（M5）: TOTP 2FA + Recovery Codes**。
計画は `docs/phase5-totp-2fa-実装計画.md`、実行タスクは `docs/phase5-実行Todo.md`（いずれも実装前の設計）。

# バグ修正計画 — Phase 3 着手前の一括是正（BUG-1〜BUG-7）

> 対象: `docs/phase3-ui-theme-notification-実装計画.md` §2.3 で特定した既存バグ 7 件
> 作成日: 2026-10-17 / 状態: **修正中**
> 方針: Phase 3 の UI 実装に着手する前に、**既存コードの欠陥を単独で是正し、テストで固定する**。UI 改造（shadcn/ui 化・テーマ切替 UI）と混在させない（差分レビューを小さく保つため）
> 影響する正典: 仕様書 §4.1 / §14 / §15 / §42 / §18 / §45 / §46、計画 15章 Phase 3、Todo §2.3

---

## 1. 要旨

| # | バグ | 深刻度 | 利用者影響 | 修正の性質 |
|---|---|---|---|---|
| BUG-1 | パスワードリセットのメール内 URL が存在しないルートを指す（404） | **Critical** | **パスワードをリセットできない** | URL 修正 ＋ `/reset-password` 画面を新設 |
| BUG-2 | email 変更確認のメール内 URL に GET ハンドラが無い（405） | **Critical** | **メールアドレスを変更できない** | GET（303 リダイレクト）追加 ＋ `/email-change/confirm` 画面を新設 |
| BUG-3 | dark でボタンのコントラスト 2.54:1（WCAG AA 失敗） | High | dark 用户在按钮难読 | `--primary-fg` 追加、`text-white` 全廃 |
| BUG-4 | 入力欄・ボタンの境界 1.41:1（WCAG 1.4.11 失敗） | Medium | フォームの境界が判別しにくい | `--border-strong` 追加 |
| BUG-5 | OIDC 同意画面がライト専用（テーマ非対応） | Medium | dark 設定で同意画面が白飛び | インライン style ＋ CSP の style のみ緩和 |
| BUG-6 | メール送信が try/catch 外 → 送信失敗で 500 | High | 登録/リセット/再送が**ブラウザエラー**になる | best-effort 化 ＋ 検知イベント ＋ テスト用 seam |
| BUG-7 | Next の Route Handler を実 HTTP でテストする基盤が無い | Medium（品質） | 検証の弱さ | `startServer` 共通ヘルパー ＋ 実証テスト |

**修正順序**: BUG-6（seam）→ BUG-1/2（リンク死）→ BUG-3/4（トークン）→ BUG-5（同意画面）→ BUG-7（基盤）→ 全体回帰

---

## 2. 各バグの根本原因と修正方針

### BUG-1 — パスワードリセットのリンクが 404

**根本原因**: Phase 1 で API を先に実装し、URL 文字列を API パス（`/api/auth/verify-email`）または**存在しない画面パス**（`/password/reset`）でハードコードした。Phase 0 設計のルート表（`/reset-password`）と実装が不一致のまま Phase 1 のテストは通過していた（URL 内容を検証していないため）。

**証拠**: `src/app/api/auth/password/forgot/route.ts:73` の `const url = .../password/reset?token=` ／ `src/app/` に `password/` ディレクトリが存在しない。

**修正**:
1. URL を **`${NEXT_PUBLIC_APP_URL}/reset-password?token=${raw}`** に変更
2. `src/app/reset-password/page.tsx` ＋ `reset-password-form.tsx` を新設（Server Component が token を読み、Client Component が **POST** で確定）
3. **GET では状態変更しない**（§25）。ページ表示は GET、確定は `POST /api/auth/password/reset`
4. `middleware.ts` に `/reset-password` の `Cache-Control: no-store` を追加（token を含む URL のキャッシュ禁止）
5. UI は token を**画面に表示しない**（`INVALID_TOKEN` は既定文言のみ）

**API 互換性**: `POST /api/auth/password/reset` は**変更しない**（既存クライアント互換）。画面は既存の `{token, password, password_confirm}` を送る。

### BUG-2 — email 変更確認のリンクが 405

**根本原因**: `email/change/route.ts:37` が確認 URL を API パス（`/api/auth/email/change/confirm`）に指したが、当該 route には POST しか無い。メールクライアントは GET で開くため 405。

**証拠**: `src/app/api/auth/email/change/confirm/route.ts:19` に `export async function POST` のみ。

**修正**:
1. 同 route に **`GET`** を追加し、**303** で `/email-change/confirm?token=` へリダイレクト（`verify-email/route.ts:16-21` と同じ方式）
2. `src/app/email-change/confirm/page.tsx` ＋ `email-change-form.tsx` を新設（`verify-email-form.tsx` と同じ構成）
3. `no-store` 追加
4. POST 成功後の「旧メールアドレスへの通知」は既存実装のまま維持（`confirm/route.ts:47-68`）

### BUG-3 / BUG-4 — コントラスト不足

**根本原因**: Phase 0 の CSS 変数は「テキスト用途」だけ考量され、**前景色（`--primary-fg`）と非テキスト境界（3:1 基準）**のトークンが存在しない。ボタンだけ `text-white` を直書きしていた。

**証拠**: `--border`(`#d1d5db`) on `--card`(`#f9fafb`) = **1.41:1**（light）/ 1.72:1（dark）。`#ffffff` on `--primary`(`#60a5fa`) = **2.54:1**（dark）。

**修正**: `globals.css` に次を追加し、`@theme inline` にマッピングする。**採用値は事前実測済み**（本文 ≥4.5:1、非テキスト ≥3:1 を満たす）。

| 変数 | light | dark | 用途 | 実測 |
|---|---|---|---|---|
| `--primary-fg` | `#ffffff` | `#0b0f19` | `bg-primary` の前景 | 6.70:1 / 7.53:1 |
| `--border-strong` | `#6b7280` | `#6b7280` | 入力欄・ボタンの境界 | 4.63:1 on card / 3.67:1 on card |
| `--danger-soft` / `--success-soft` / `--warning-soft` | `#fef2f2` / `#f0fdf4` / `#fefce8` | `#2a1416` / `#12241a` / `#2a2010` | 将来 alert 背景（Phase 3-A） | 4.79〜5.91 / 6.27〜9.58 |
| `--hover` / `--disabled-fg` | `#f3f4f6` / `#4b5563` | `#1f2937` / `#9ca3af` | 将来 hover/disabled | 16.12 / 6.10 |

**適用範囲（今回）**: `src/app/auth-form.tsx` と `src/app/verify-email-form.tsx` の **2 ファイルのみ**（Phase 3 で components/ui ocrystalsになる）。`text-white` は**全 2 箇所**を `text-primary-fg` に置換。input の `border-border` は `border-border-strong` に。カード枠は `--border` のまま（見た目維持）。

### BUG-5 — OIDC 同意画面のテーマ非対応

**根本原因**: `scripts/server.ts` は Next の React ツリーを迂回し、`/oauth2/*` と同意画面を**素の HTML 文字列**で返す（M2.5 の設計）。`globals.css` も `ThemeProvider` も通らない。

**証拠**: `scripts/server.ts:209` の consent HTML（インライン style なし、`color-scheme` 指定なし）。CSP は `scripts/server.ts:31` で `style-src 'self'`。

**修正**:
1. 同意/エラーページに最小のインライン `<style>`（`:root{color-scheme:light dark}` ＋ `prefers-color-scheme: dark` ブロック）
2. `send()` の CSP を `style-src 'self' 'unsafe-inline'` に変更。**`script-src 'none'` と `default-src 'none'` は維持**（インライン script は導入しない）
3. 同意画面内にテーマ切替 UI は出さない（OS 追従のみ。切替 UI は Phase 9 の Next 化ときに入れる）
4. 既存テスト（`client-console.test.ts`）の期待値を更新

**リスク評価**: `style-src` に `unsafe-inline` を足すのは CSS インジェクションの余地を生むが、`script-src 'none'` が維持されるため**スクリプト実行には繋がらない**。`escapeHtml` で全値を escape 済み（`scripts/server.ts:35`）。

### BUG-6 — メール送信が 500 になる

**根本原因**: `register` / `resend-verification` / `password/forgot` / `email/change` が `await sendXxx()` を **try/catch の外**で呼ぶ。`RESEND_API_KEY` 未設定時に `requireLazyEnv` が throw（`src/lib/env.ts:109-115`）し、`normalizeError` が 500 にマップする。

**証拠**: `register/route.ts:89` / `resend-verification/route.ts:77` / `password/forgot/route.ts:74` / `email/change/route.ts:37`。

**修正**:
1. `src/lib/auth/email/send.ts` に **transport seam** を追加（`setEmailTransport` / 既定は Resend）— テスト差し替え用（D-30-25）
2. `SECURITY_EVENT_TYPES` に **`security_notification_failed`** を追加（text 列なので migration 不要）
3. `src/lib/auth/email/deliver.ts` に `deliverEmailSafely()` を追加（例外を握り、イベント記録、boolean を返す）
4. 4 ルートのメール送信を `deliverEmailSafely` に置き換え

**列挙攻撃対策の維持（重要）**:
- メール送信が失敗しても**応答メッセージは成功時と完全に同一**にする。別の文言にすると「この email は新規登録された」と判明する（§46）
- 失敗は `security_notification_failed` イベントで**運用側で検知**できるようにする
- 既存の `enumeration.test.ts` のアサーション（23505 で成功メッセージ合成 / 同一メッセージ）が**引き続き green** であることを DoD に含める

**副次的な効果**: seam により、実 HTTP テストで「登録 → メモリ内メールから token 抽出 → 確認」まで通せるようになる（BUG-7 の前提）。

### BUG-7 — 実 HTTP テスト基盤が無い

**根本原因**: 既存 e2e 3 ファイルは `createOidcHandler` を直接使い OIDC のみを実 HTTP で叩いている。Next の Route Handler に対しては `vi.mock` ベースの直接呼び出ししかなく、Cookie / 303 / `Set-Cookie` / `no-store` を検証できていない。

**証拠**: `src/test/e2e/*.test.ts`（`httpRequest` の対象は `/oauth2/*` のみ）／`src/test/security/enumeration.test.ts`（`POST(request)` を直接呼ぶ）

**修正**: `src/test/helpers/app-server.ts` に `startTestAppServer()` を追加（`scripts/server.ts:365` の `startServer` を再利用）。BUG-1/2 の URL 修正と BUG-6 の seam を使って**「登録 → メール内 URL を確認 → 画面を開く」**を実 HTTP で実証する e2e を 1 本追加する。

**制約**: `vitest.config.mts` は `fileParallelism: false` / `testTimeout: 30s` / `hookTimeout: 60s`。Next dev の初期コンパイルが hookTimeout を超える場合は **`dev: false`（`pnpm build` 済み）に切替**する。どちらでも通らない場合は BUG-7 を「ヘルパー提供のみ（実証は Phase 8-B）」に縮め、その旨を plan に記録する。

---

## 3. テスト計画（各修正の固定先）

| バグ | テスト | 種別 | 期待 |
|---|---|---|---|
| BUG-1 | `auth-email-url.test.ts`（新規） | security | forgot のメモリ内メール URL が `/reset-password?token=`。`/password/reset` を含まない。reset POST が成功し `password_reset` イベントと全セッション revoke が発生 | 
| BUG-1 | `web.test.ts`（追記） | security | `/reset-password` が `no-store` |
| BUG-2 | `auth-email-url.test.ts`（新規） | security | `GET /api/auth/email/change/confirm?token=x` が **303** で `/email-change/confirm?token=x`。GET では `users.email` が**変更されない**（§25） |
| BUG-3/4 | `theme-contrast.test.ts`（新規） | unit | `--primary-fg`/`--border-strong` を含む 13 ペア×2 テーマ = 26 値が閾値を満たす。`src` 内の `text-white` が **0 件** |
| BUG-5 | `oidc-consent-theme.test.ts`（新規） | security | 同意 HTML に `prefers-color-scheme` の dark ブロックがある。CSP に `style-src 'self' 'unsafe-inline'` かつ `script-src 'none'` が含まれる |
| BUG-6 | `email-delivery.test.ts`（新規） | security | transport が失敗しても `POST /api/auth/register` が **200 ＋ 成功時と同一メッセージ**。`security_notification_failed` が記録される。`forgot` も同一。既存 `enumeration.test.ts` は green のまま |
| BUG-6 | `email-transport.test.ts`（新規） | unit | `setEmailTransport` で差し替えでき、`restore` で Resend に戻せる。送信成功が outbox に記録される |
| BUG-7 | `app-server.test.ts`（新規） | e2e | `startTestAppServer()` で `GET /login` が 200。`GET /reset-password?token=x` が 200 |

---

## 4. 修正後の検証コマンド

```bash
pnpm typecheck
pnpm lint
pnpm test:unit          # theme-contrast / email-transport
pnpm test:security      # auth-email-url / email-delivery / oidc-consent-theme / web / enumeration
pnpm test:e2e           # app-server（BUG-7 実証）
pnpm test               # 全件
pnpm build
```

**DoD**:
- [ ] BUG-1〜BUG-7 の修正テストがすべて green
- [ ] 既存 43 ファイル 262 ケースが**全て green**（回帰なし）
- [ ] `pnpm lint` / `typecheck` / `test` / `test:e2e` / `build` が green
- [ ] `src` 内の `text-white` が 0 件（BUG-3）
- [ ] `enumeration.test.ts` の列挙対策アサーションが green（BUG-6 の安全網）

---

## 5. 実施記録

| 日付 | バグ | 実施内容 | テスト |
|---|---|---|---|
| 2026-10-17 | BUG-6 | `send.ts` に transport seam（`setEmailTransport`）を追加。新規 `src/lib/auth/email/deliver.ts` の `deliverEmailSafely()` を追加し、`register` / `resend-verification` / `password/forgot` / `email/change` の 4 ルートのメール送信を best-effort 化。`SECURITY_EVENT_TYPES` に `security_notification_failed` を追加 | `src/test/unit/email-transport.test.ts`（5件）、`src/test/security/auth-email-url.test.ts`（送信失敗でも 200・同一メッセージ） |
| 2026-10-17 | BUG-1 | `password/forgot/route.ts` の URL を `/reset-password?token=` に修正。`/reset-password`（page + form）を新設。`middleware.ts` の no-store 対象に追加 | `auth-email-url.test.ts`（URL が `/reset-password` かつ `/password/reset` を含まない、未知メールでも同一応答）、`e2e/app-server.test.ts`（実 HTTP で 200） |
| 2026-10-17 | BUG-2 | `email/change/confirm/route.ts` に **GET（303 転送）**を追加。`/email-change/confirm`（page + form）を新設。`no-store` 追加 | `auth-email-url.test.ts`（303 と転送先）、`no-store-token-urls.test.ts`、`e2e/app-server.test.ts` |
| 2026-10-17 | BUG-3/4 | `globals.css` に `--primary-fg` / `--border-strong` / `--*-soft` / `--hover` / `--disabled-fg` を追加し `@theme inline` にマッピング。`text-white` を**全 2 箇所**廃して `text-primary-fg` に。入力欄・ボタン・リンクの境界を `border-border-strong` へ（カード枠は `border-border` のまま） | `src/test/unit/theme-contrast.test.ts`（8件・26 値の閾値） |
| 2026-10-17 | BUG-5 | `scripts/server.ts` に `OIDC_PAGE_STYLE` と `themedPage()` を追加し、同意画面 ＋ エラーページ 11 箇所を統一。CSP を `style-src 'self' 'unsafe-inline'` に（`default-src 'none'` は維持 = script-src は none） | `src/test/security/consent-theme.test.ts`（3件・実 HTTP で同意画面を取得） |
| 2026-10-17 | BUG-7 | `src/test/helpers/app-server.ts` に `startTestAppServer()` を追加（`startServer` を再利用）。`src/test/e2e/app-server.test.ts` で実証 | `app-server.test.ts`（5件・`/login` `/reset-password` `/email-change/confirm` `/forgot-password` 200 と 303） |

### 検証結果（2026-10-17）

| コマンド | 結果 |
|---|---|
| `pnpm lint` | **0 errors** / 53 warnings（従来 21。新規テストの検証用警告を含む） |
| `pnpm typecheck` | green |
| `pnpm test` | **49 files / 297 tests green**（修正前 43 files / 262 tests。**+6 files / +35 tests**、既存テストの回帰ゼロ） |
| `pnpm build` | 成功。新規ルート `/reset-password` `/forgot-password` `/email-change/confirm` が出力される |
| 手動（dev サーバ） | 未実施。BUG-1/2 の実メール受信は Resend の実キーが必要なため本章では自動テストまで |

### 実施中に判明した補足事項

1. **同意画面のテストは handler を 1 回だけ作る必要がある**。`createOidcHandler(provider)` は `provider.callback()` を包むため、リクエストごとに作ると応答が返らない（ハングする）。既存 e2e と同じパターンで修正。
2. **Cookie 名は `NODE_ENV` で変わる**（`auth_session` / `__Host-auth_session`）。テスト側の CookieJar 生成で取り違えると同意画面が `/login` へ 303 し、Next を載せていないテストサーバーでは応答が返らずハングする。
3. **`app.prepare()` は `.env` を読んで `process.env` を書き戻す**。そのため `OIDC_ISSUER` を `delete` しても無効化できず、テスト origin と一致させる必要がある（`startTestAppServer({ oidc: true })`）。
4. **`reset-password` の確定後は CSRF トークンを破棄**する必要がある（サーバが全セッションを破棄するため）。画面側では `setCsrfToken('')` で対応済み。

---

## 6. 残件・Phase 3 への引継ぎ

| 残件 | 引継ぎ先 |
|---|---|
| `/reset-password` と `/email-change/confirm` は**最低限のフォーム**。PW meter・shadcn UI・文言一元化は未適用 | Phase 3 P3-B-05 / P3-B-11 |
| `--*-soft` / `--hover` / `--disabled-fg` は**トークン定義のみ**。alert/hover での使用は未適用 | Phase 3 P3-A-03/04 |
| 同意画面のテーマ切替 UI（現在は OS 追従のみ） | Phase 9 |
| 実ブラウザ viewport / スクリーンリーダー実機検証 | Phase 8-B |
| geo-IP（`ip_country`）による地域表示 | Phase 8/9 |
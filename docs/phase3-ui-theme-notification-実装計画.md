# Phase 3 実装計画 — 共通UI / テーマ / 認証画面 / セッション・デバイス管理 / 通知メール

> 対象: M3（`実装計画.md` 15章「Phase 3 — UI / テーマ / 通知 / デバイス管理（3〜4日）」）
> 前提工程: Phase 2.6（M2.6 達成 2026-10-17 / PR #4 → `c82cd1c`）
> 正典の優先順位: 仕様書 `超本格アカウント・認証システム仕様書 v1.3.md` → 計画 `実装計画.md` → 進捗 `実装Todo.md` → **本書（実装レベルの詳細）**
> 初版: 2026-10-17（計画のみ・**実装は未着手**）
> v1.1: 実測で**トークンの不備 2 件**を発見 → `--primary-fg` / `--border-strong` を新設（D-30-23）。API 契約・コード骨格・wireframe・工数・ロールバックを追加
> v1.2: コード読み込みで**既存バグ 5 件**（リセットメールのリンク死・email 変更確認の 405・dark コントラスト・非テキストコントラスト・同意画面のテーマ非対応）と**メール送信の非保護**を発見。テスト基盤（`startServer` エクスポートあり／Route Handler 直接呼び出しが既存パターン）の実態を反映

---

## 0. 要旨（TL;DR）

| 項目 | 内容 |
|---|---|
| 何をやる | 現状は「API は揃っているが画面が無い」状態。**画面（11 ルート新規 / 4 ルート改修）・テーマ機能・デバイス管理・通知メール**を載せて §64 の「UI」「セッション」を完成させる |
| なぜやる | §64「UI」6項目と「セッション」6項目が未充足。**DoD 未達なら Phase 4 へ進めない**（計画 3章） |
| 工数 | **約 35.5 時間（4〜5 日）**。内訳は §20（v1.1 の 31h から欠陥是正分 +4.5h） |
| 追加依存 | `class-variance-authority` / `clsx` / `tailwind-merge` / `lucide-react` / `ua-parser-js` / `@radix-ui/react-{dialog,label,tabs}`（7 パッケージ。shadcn CLI は使わない・D-30-02） |
| migration | **1 本のみ** = `0014_09_user_preferences.sql`（既存テーブルへの変更は無し） |
| 新規ファイル | **38 ファイル**（アプリ 29 / ライブラリ 9）→ §6.1 |
| テスト | 新規 **13 ファイル・約 95 ケース** ＋ 既存 4 ファイルへの追記 → §16 |
| **既存バグ** | **7 件を Phase 3 着手前に是正済み**（§2.3 / `docs/bugfix-BUG1-7-修正計画.md`）。うち BUG-1 はパスワードリセットが**一切完了できない**欠陥だった |
| 最大リスク | 実ブラウザ viewport 検証が Playwright 未導入でできない（D-30-01）。**Phase 8-B に明示的に引継ぐ** |
| 着手して最初に潰すバグ | `--primary-fg` 未定義による **dark で AA 失敗（2.54:1）**、`--border` の **1.41:1**（§6.5） |

---

## 1. 正典と参照関係

| 論点 | 正典 | 本書での扱い |
|---|---|---|
| 要件の存在 | 仕様書 §4/§18/§19/§20/§21/§25/§37〜§46/§49/§58/§60 | §21 にトレーサビリティ表で紐づけ |
| フェーズ順序・DoD | `実装計画.md` 3章 / 15章 | 本書は実装レベルの詳細に閉じ、DoD の解釈だけを §18 で確定 |
| 進捗チェックボックス | `実装Todo.md` §5（P3-A-01〜P3-D-05） | §20 の細分 ID は必ず紐づけ。**対応表は §19** |
| CSS変数名・viewport 幅・コントラスト比 | 仕様書には**記載が無い**。`実装計画.md` 13.2 が正 | §6.5 で**実測値を確定**して固定する |
| メール内 URL | 仕様書 §4.1 の例 `https://example.com/verify-email?token=...` ＋ 計画 13.1 のルート表 | §2.3-1/2 の欠陥として是正（**実装が仕様と不一致**） |
| テスト配置 | `実装Todo.md` D-18（`src/test/**`） | §16 で既存 4 ディレクトリ構成を維持 |

---

## 2. 背景と目的

### 2.1 現状（コードで確認済みの不足）

| 領域 | 現状 | 証拠 |
|---|---|---|
| 共通UI | CSS 変数と `@theme inline` はあるがコンポーネントライブラリ無し。フォームは `fetch` + `useState` の手書き、クラスは utilities 直書き | `src/app/globals.css`, `src/app/auth-form.tsx:1-135` |
| テーマ | `data-theme` を描画前に適用する同期インライン script（localStorage 読み・既定 `system`）と light/dark 変数は Phase 0 で実装済。**ThemeProvider・切替 UI・`matchMedia` 購読・サーバ保存先が未実装**。`user_preferences` テーブル自体が無い | `src/app/layout.tsx:14-24`, `schema.ts` に `userPreferences` なし |
| 認証画面 | `/login` `/register` `/verify-email` のみ（`find src/app -name page.tsx` で 9 ファイル）。`/forgot-password` `/reset-password` `/settings/password` の画面が無い | `src/app/**/page.tsx` 一覧 |
| セッション | `revokeSession`/`revokeAllSessions` はあるが **`deviceName` は `'Unknown device'` 固定**、`GET /api/auth/sessions`・`DELETE /api/auth/sessions/{id}`・`POST /api/auth/logout-all` が無く、ユーザー別取得クエリも無い | `src/lib/auth/session.ts:67,138`, `src/lib/db/queries/sessions.ts` |
| 通知メール | Resend 送信と 6 種テンプレは完成済み。**トリガーは PW変更・email変更のみ**。新規デバイス判定ロジックは無し | `src/lib/auth/email/templates.ts:35-57` |
| 設定画面 | `/settings`・`account`・`connected-apps`・`applications` のみ。`security`・`sessions`・`appearance` が無い。ナビは 3 項目の固定配列、ハブ（`src/app/page.tsx:12-16`）も 3 項目固定 | `settings-nav.tsx:5-9`, `page.tsx:12-16` |
| 文言一元化 | `messages/ja.ts` にエラー・認証・メール文面と `ui.settings`/`ui.applications`。**ログイン/登録/検証画面の文言はコンポーネント内ハードコード** | `auth-form.tsx:52,58,113-121` |
| `no-store` | middleware が `/login` `/register` `/settings` `/api` に付与。**`/verify-email` `/forgot-password` `/reset-password` は無い** | `src/middleware.ts:132-136` |

### 2.2 目的（各々に完了定義を付ける）

| # | 目的 | 完了定義 |
|---|---|---|
| 1 | §64「UI」6 項目を満たす | PC/スマホ/Light/Dark/System/OS テーマ変更へのリアルタイム追従が §18 のチェックで全て green |
| 2 | §64「セッション」6 項目を満たす | 複数端末/一覧/個別ログアウト/全端末ログアウト/失効/ローテーションが API テストと画面の両方で確認できる |
| 3 | 認証画面を §25/§42/§43/§44/§46 に従って完成させる | 6 画面が存在し、`src/test/e2e/login-register.test.ts` が green |
| 4 | §18 の通知メールを送る | 新規デバイス通知・全ログアウト通知が送信され、秘密情報を含まないことをテストで固定 |
| 5 | 文言を `messages/ja.ts` に一元化（Phase 1-B の引継ぎ解消） | 新規/改修コンポーネントに日本語リテラル 0（レビュー P3-G-02） |
| 6 | ~~§2.3 の既存バグ 5 件を是正する~~ | **2026-10-17 完了**。6 ファイル 35 ケースを追加し 49 files / 297 tests green（`docs/bugfix-BUG1-7-修正計画.md`） |

### 2.3 既存バグ 7 件（★ 調査成果 / **2026-10-17 修正済み**）

いずれも**既存コードを読み込んだ結果、仕様と実装が食い違っていた**箇所。Phase 3 着手前の独立作業として是正し、テストで固定した（計画と実施記録は `docs/bugfix-BUG1-7-修正計画.md`）。

| # | バグ | 証拠 | 影響 | 是正 |
|---|---|---|---|---|
| **BUG-1** ✅ | **パスワードリセットメールのリンクが 404** | `src/app/api/auth/password/forgot/route.ts:73` は `${APP_URL}/password/reset?token=` を生成するが、`src/app/` に **`password/` ディレクトリが存在しない**（ルートは `/reset-password`） | **リセットが一切完了できない**（利用者はメール内のリンクを開けない）。§15・§64「パスワードリセット可能」が未充足 | **P3-B-12★**: URL を `/reset-password?token=` に修正 ＋ 画面の GET が 303 で `/api/auth/password/reset` 相当へ誘導しない（POST で確定する設計は §9.5 の通り） |
| **BUG-2** ✅ | **email 変更確認メールのリンクが 405** | `src/app/api/auth/email/change/route.ts:37` は `${APP_URL}/api/auth/email/change/confirm?token=` を生成するが、同 route には **`POST` しか無く GET が無い**（`email/change/confirm/route.ts:19`） | メールクライアントは GET で開く → **405 Method Not Allowed**。§14 の email 変更が完了できない | **P3-B-11★**: `GET` を 303 で `/email-change/confirm?token=` へ（`verify-email` と同じ方式・§25）+ 画面を新設 |
| **BUG-3** ✅ | **dark でボタンのコントラストが AA 失敗** | 現行ボタン class は `bg-primary ... text-white`（`auth-form.tsx:120`, `verify-email-form.tsx:71`）。`#ffffff` on `--primary`(`#60a5fa`) = **2.54:1** | WCAG 1.4.3 違反。§42「ダークモードでも可読性を確保」違反 | **D-30-23 / P3-A-03**: `--primary-fg` を新設（light `#ffffff` / dark `#0b0f19`）し、`text-white` を全廃（該当は 2 箇所のみ） |
| **BUG-4** ✅ | **非テキスト境界のコントラストが 3:1 未満** | `--border`(`#d1d5db`) on `--card`(`#f9fafb`) = **1.41:1**（dark で 1.72:1） | WCAG 1.4.11 違反。入力欄・ボタンの境界が判別しにくい | **P3-A-03**: `--border-strong`(`#6b7280`) を新設し、**入力欄・ボタンの境界だけ**に適用（カード枠は `--border` のまま見た目を維持） |
| **BUG-5** ✅ | **OIDC 同意画面がライト専用** | `scripts/server.ts:209` が素の HTML 文字列を生成（Next の React・`globals.css`・`ThemeProvider` を経由しない） | dark 設定の OS でも同意画面で白飛びする。§64「Dark」の例外 発生 | **P3-A-15★**: 同意/エラー HTML に最小のインライン `<style>`（`prefers-color-scheme` メディアクエリ＋`color-scheme`）を追加。CSP は `style-src 'self'` なので**インライン style は `default-src 'none'`+`style-src 'self'` に阻まれる** → `send()` の CSP に `'unsafe-inline'` を限定追加する（`scripts/server.ts:31`） |

**付随して是正する堅牢性の欠陥**

| # | 欠陥 | 証拠 | 是正 |
|---|---|---|---|
| **BUG-6** ✅ | **メール送信が非保護**。`RESEND_API_KEY` 未設定で `requireLazyEnv` が throw し、`register`/`resend-verification`/`password/forgot`/`email/change` が **500** になる（`register/route.ts:89`, `forgot/route.ts:74` は try/catch の外） | 同上 | **P3-B-13★**: try/catch で包み `security_notification_failed` を記録。**応答は列挙安全のため成功時と同一メッセージのまま**（失敗時は同じ文言＋UI は常に再送導線を出す。別文言にすると account 作成済みと判明する） |
| **BUG-7 ✅（テスト基盤・完了）** | 修正前は Next の Route Handler を実 HTTP で叩ける infrastructure が未使用。既存 e2e 3 ファイルは OIDC プロバイダ（`createOidcHandler`）のみ。security/integration は Route Handler を関数として直接呼び出し＋`vi.mock` | `src/test/e2e/*.test.ts`, `src/test/security/enumeration.test.ts` | **D-30-28**: `startServer`（`scripts/server.ts:365-394` で export 済み）が Next を hosting できることを利用し、e2e で実 HTTP を成立させる（§16.1） |

---

## 3. スコープ

### 3.1 本フェーズで実装する

`実装Todo.md` §5 の 3-A〜3-D 全部 ＋ 付随タスク（§21 の 21-A〜21-G）。§2.3 の欠陥是正 7 件は**別作业で完了済み**。

### 3.2 本フェーズで実装しない（理由と引継ぎ先）

| 項目 | 判断 | 引継ぎ先 |
|---|---|---|
| 社会ログインボタンの実体（Google/GitHub/Discord） | `lib/auth/oauth/registry.ts` の**型と空エントリだけ**用意。UI は registry から自動生成 | Phase 4（P4-B-01）でエントリ追加＝ボタン追加 |
| Passkey ボタン / 2FA 認証の実動作 | registry 空の間は**非表示**。`TotpChallengeForm` の器だけ先行 | Phase 5 / Phase 6 |
| §37 の 2FA / Passkey / 連携カードの機能 | 「無効」「0 件」「未連携」の**如实表示**。導線は出さない | Phase 4 / 5 / 6 |
| §18 の「新 IP / 地域からのログイン」通知（2 番目） | 新規デバイス通知に統合（IP 単独判定は精度が低い） | Phase 8（リスク検知） |
| geo-IP 解決による `ip_country` 充填 | 外部依存を持ち込まず、**値があるときだけ表示** | Phase 8 / 9 |
| Playwright（実ブラウザ viewport / スクリーンリーダー実機） | 既存 vitest ハーネスで代替（D-30-01） | Phase 8-B |
| 同意画面の Next 化（React 化・共通レイアウト化） | 最小のインライン style で dark 対応だけ（BUG-5） | Phase 9（運用/ドメイン確定時） |
| i18n（英訳等） | `messages/ja.ts` に構造を作るが実文言は ja のみ | 将来拡張 |

---

## 4. 前提・着手前チェック

**前フェーズの DoD が全チェックされるまで進まない**（計画 3章）。

```bash
pnpm lint                 # error 0（M2.6 時点 warning 21 件は許容）
pnpm typecheck            # 0 errors
pnpm test                 # 全 green
pnpm test:e2e             # 全 green
pnpm db:migrate           # 適用済み・失敗 0
pnpm db:verify-migrations # 適用順の整合
pnpm build                # 成功
```

- [ ] 上記 7 コマンドがすべて green（**warning 残置可、error 0**）
- [ ] `curl -s -o /dev/null -w '%{http_code}' localhost:3000/login` が `200`
- [ ] `curl -s -o /dev/null -w '%{http_code}' -I localhost:3000/settings` が `302`（未ログインで `/login` へ）
- [ ] **再現確認**: 実環境で forgot を叩き、メール内 URL が `http://localhost:3000/password/reset?token=...` を指していることを確認（＝BUG-1 の再現）
- [ ] `psql $DATABASE_URL -c "\d user_preferences"` が**エラー**（テーブルが無い＝P3-A-05a で作る）
- [ ] `pnpm ls ua-parser-js` が**空**
- [ ] `実装Todo.md` §1 の M2.5 / M2.6 が `[x] 達成`、M3 が `[ ] 未着手`
- [ ] `RESEND_API_KEY` が設定済み or BUG-6 の再現手順（未設定で register が 500）を把握

---

## 5. 決定事項

### 5.1 D-30-01 〜 D-30-28

| ID | 決定 | 理由 |
|---|---|---|
| D-30-01 | **テスト基盤は既存 vitest ハーネスを継続**。`実装Todo.md` §5 DoD の `*.spec.ts` は **`.test.ts` に読み替えて満たす**。Playwright は Phase 8-B のまま | 依存追加・ブラウザ取得・CI 整備を Phase 3 に持ち込まない。DoD の spirit（ログイン/登録/テーマ/セッションの動作確認）は維持する |
| D-30-02 | **shadcn/ui は CLI を使わず、既存 CSS 変数へ手書き**で `src/components/ui/*` を作る。shadcn 標準の `--background/--foreground` 命名は**持ち込まない** | `globals.css` とテーマ script を正本として 1 本化できる。命名が二重化しない |
| D-30-03 | テーマの優先順位は **`user_preferences.theme`（ログイン済） > `localStorage['theme']` > `system`**。変更時は localStorage と preferences の**両方**へ書く。不正値は `system` にフォールバック（D-15） | §40「ログイン後はユーザー設定とローカル設定を適切に統合」の実装。ログアウト後も前回の選択が効く |
| D-30-04 | FOUC 防止 script は Server Component が `user_preferences.theme` を読み、**enum 検証後に静的リテラル**として `<head>` に埋め込む。ユーザー入力を補間しない（既存の CSP nonce はそのまま使う） | ログイン直後の初回描画からテーマ確定。§45 にも合う |
| D-30-05 | テーマ切替の副作用は `document.documentElement.dataset.theme` の更新のみ。状態表現は**色＋アイコン＋テキスト**、コントラストは §6.5 の実測値で固定 | §42 / 計画 13.2 |
| D-30-06 | `user_preferences` を **migration `0014_09_user_preferences.sql`** で作成（計画 7.11 の順序 09）。`theme` は CHECK で 3 値のみ | §40 / §60。`drizzle/0013_*` の次 |
| D-30-07 | `GET/PATCH /api/auth/preferences` は `theme`/`language`/`timezone` を受ける（UI は theme のみ）。PATCH は `withAuthPipeline` ＋ zod enum ＋ `rateLimitKeys.settingsUser`（120/min） | 計画 11.2 #17 |
| D-30-08 | `GET /api/auth/sessions` の返却は **`id`/`device_name`/`os`/`ip_masked`/`last_seen_at`/`created_at`/`current`** のみ。`session_hash`/`csrf_secret`/**生IP**/`ip_hash`/`user_agent` は返さない | §20 / §45 / §49 |
| D-30-09 | 個別ログアウトは `DELETE /api/auth/sessions/{id}`（§25 により GET では変更しない）。`WHERE id = ? AND user_id = ?` で所有者確認、**他人は 404**（`failResponse('NOT_FOUND', …, 404)`＝M2.6 の `oidc/clients/[clientId]/route.ts:26` と同じ書式）。現行セッションなら Cookie も削除し `/login` へ | M2.6 と同じ IDOR 方針に揃える |
| D-30-10 | 全ログアウトは `POST /api/auth/logout-all`。**再認証必須**（`requireReauth: true`）、現行を含む全件 revoke（`revokeReason='logout_all'` は既存 `REVOKE_REASONS` に含む）、`session_revoked` イベント、変更系通知メール。**メール失敗は結果を失敗にしない** | §8 / §18 / D-03 |
| D-30-11 | `device_name` は `src/lib/util/device.ts` の `deriveDeviceName(ua)`（`ua-parser-js`、D-12）。`Chrome on Windows` / `iPhone` / `その他のデバイス`。**最大 120 文字**・制御文字除去 | §19 の例。メール本文と画面の両方に出る |
| D-30-12 | 既存セッションの `'Unknown device'` は**backfill しない**。UI 側で `その他のデバイス` に正規表示 | 移行スクリプト＋結果検証の工数を回避 |
| D-30-13 | 新規デバイス通知の判定は、**同一ユーザーの他の有効セッション**（`revoked_at IS NULL` かつ `expires_at > now` かつ `absolute_expires_at > now`）のうち **`(ip_hash, device_name)` が一致 0 件**。セッション insert 直後・`login_success` の前で実行 | 家庭内 IP 切替だけで通知が連打されないように 2 要素で判定 |
| D-30-14 | 通知メールには**デバイス名 / `ip_masked` / 日時 / 地域（`ip_country` があるときだけ）**のみ。PW・token・TOTP・passkey・session token は**絶対に出さない**。送信失敗は `security_notification_failed` で検知可能にする | §18 / §45。`event_type` は text 列なので enum 追加は migration 不要 |
| D-30-15 | `GET /api/auth/security/events` は**本人宛のみ**・直近 N 件（既定 10・上限 50）。返すのは `event_type`/`ip_masked`/`created_at`/**許可キーのみ**の metadata。`ip`（生）・`user_agent`・metadata 全体は返さない。**読み取り専用 GET** | 計画 11.2 #18（★）/ §25 / §37 |
| D-30-16 | §37 の一覧で未実装領域（2FA / Passkey / 連携）は如实表示し**導線を出すな**。OIDC client（既存 M2.6）と連携アカウントは別カードで併記 | 誤誘導を避ける。§37 は「まとめて表示」が要件なので項目は並べる |
| D-30-17 | 日時表示は §38 の `2026/10/03 20:30` 形式。`formatLocalDateTime(date, timeZone)`（`Intl.DateTimeFormat`・locale `ja`）で整形、**不正 timeZone は UTC にフォールバック**。SSR と client で同結果（server が props で timeZone を渡す） | §60 |
| D-30-18 | `messages/ja.ts` に UI 文言を追加して一元化。**イベント種別 → 表示名**のマッピングも同ファイルに置き、`settings/security` と通知メールで同じ語彙を使う。既存 `errors`/`emails`/`ui.settings`/`ui.applications` は変更しない | 計画 14 章の引継ぎ（Phase 1-B → Phase 3-D で完了） |
| D-30-19 | 未ログインの `settings/*` は**既存 `requireSettingsUser`**（`src/app/settings/layout.tsx:11-18`）が全ページへ効く。新規ページで個別ガードを書かない | §49。認可はサーバ側 |
| D-30-20 | **パスワード変更 UI を本フェーズに最小実装として含める**（`/settings/password`）。既存 `POST /api/auth/password/change`（`requireReauth: true`・`password/change/route.ts:26`）と再認証を再利用 | §37 の「[変更]」が指す先が無く是正。否则 セキュリティ画面が読み取り専用になる |
| D-30-21 | ログイン画面の社会ログイン / passkey / 2FA ボタンは **`lib/auth/oauth/registry.ts`（型＋空エントリ）**から生成。エントリ 0 件なら**領域ごと描画しない** | 計画 P4-A-01「1エントリ追加で有効化／UI も registry から自動生成」を Phase 3 から形に |
| D-30-22 | 画面からの通信は `src/lib/api/client.ts` に一元化（CSRF トークンのモジュールキャッシュ・JSON 送信・`{success,data,error}` 解釈・統一エラー表示）。403 `CSRF_FAILED` は 1 回だけ再取得して再試行（無限ループ禁止）。**ログイン/ログアウトでキャッシュを破棄** | 計画 13.1「全 mutation は同一 fetcher ラッパー」。Phase 1 で 3 箇所重複していた取得を 1 化 |
| D-30-23 | **`--primary-fg` を新設**し `text-white` を全廃（dark 2.54:1 = AA 失敗・BUG-3）。**`--border-strong`** を新設し**入力欄・ボタンの境界だけ**に適用（BUG-4） | 実測で判明した既存不備の是正。§42 |
| **D-30-24** | **メール内 URL を仕様と一致させる**。`password/forgot` → `/reset-password`（BUG-1）。`email/change` は GET 303 リダイレクト＋`/email-change/confirm` 画面を新設（BUG-2）。`register`/`resend` の `/api/auth/verify-email` 方式は**既に 303 で `/verify-email` へ落とすため据え置き** | 仕様 §4.1/§15 の URL と実装の不整合。UI を作ると必ず踏む |
| **D-30-25** | **メール送信に transport seam を入れる**。`src/lib/auth/email/send.ts` に `setEmailTransport()` を追加し、既定は Resend。テストは `src/test/helpers/email.ts` の memory transport に差し替える。既存の `vi.mock('@/lib/auth/email/templates')` パターンと**併用**する（テンプレート文面のテストは mock、送信成功/失敗のテストは seam） | BUG-6。実 HTTP e2e で register/forgot を叩くために必須（現状は 500 になる） |
| **D-30-26** | 同意画面（`scripts/server.ts`）は**最小のインライン style** で `prefers-color-scheme` に追従させる。`send()` の CSP に `style-src 'self' 'unsafe-inline'` を**この画面だけ**許可する | BUG-5。Next 化は Phase 9 へ |
| **D-30-27** | **メール送信は best-effort とし、応答メッセージは成功時と同一に保つ**。失敗時は `security_notification_failed` を記録し、UI は常に再送導線を出す | BUG-6 の対処。**別文言にすると「このアカウントは新規作成された」と Bermuda にONY され account 存在が漏れる**（§46 / enumeration.test.ts と同じ考え方） |
| **D-30-28** | **e2e は `startServer()` を使う**。`scripts/server.ts:365` で export 済みの関数が Next を hosting できるため、Next の Route Handler を実 HTTP で叩ける。既存 e2e（OIDC のみ）をこの形に統一し、**サーバ起動はファイル内 1 回**に集約（`fileParallelism:false` ななのでコストは逐次に分割される） | BUG-7。security/integration は従来どおり Route Handler を直接呼び出す（速い） |

### 5.2 却下した代替案（なぜ採らなかったか）

| 論点 | 却下した案 | 却下理由 |
|---|---|---|
| D-30-01 | Phase 3 で `@playwright/test` を導入 | ブラウザ取得・CI 整備・flaky 対処の工数が見積の 40%。375px の操作性は静的チェック＋手動で十分な段階 |
| D-30-02 | shadcn CLI (`init` / `add`) | 既存 `globals.css` とテーマ script を書き換える。FOUC 防止ロジックと CLI の token 命名がぶつかる |
| D-30-03 | テーマを Cookie に保存する（サーバ midleware なしで完結） | §40 が明示的に「ログイン済は `user_preferences.theme`」と規定。Cookie は上限 4KB・改ざん容易でユーザ設定の正本にならない |
| D-30-06 | `users` テーブルに `theme` 列を追加 | §40・計画 7.9 は独立した `user_preferences` を規定。`language`/`timezone` の拡張余地を潰すことになる |
| D-30-13 | 直前のセッション 1 件と IP だけで判定 | モバイルなど同一 device_name でも IP が変わるケースで通知が連打される。`ip_hash` + `device_name` の 2 要素が安定する |
| D-30-13' | 通知にGeo 情報（地域）を必須で入れる | geo-IP の外部依存が増える。`ip_country` があるときだけ表示（D-30-14）で要件の意図を保つ |
| D-30-24' | forgot の URL を API に直して `/api/auth/password/reset` を GET で開く | §25 は GET で状態変更を禁じる。GET 303 → 画面 → POST の 3 段にする |
| D-30-27' | メール失敗を 502 で返す | 同一 email の再登録は 23505 で成功メッセージを返すため、**失敗時だけ別の status/文言になると account 作成済みと判明する**（列挙攻撃の経路） |
| D-30-28' | e2e で Route Handler を直接関数呼び出し | Cookie/CookieJar/redirect を再現できない。実 HTTP で初めて確認できるもの（303、`no-store`、`Set-Cookie`）を失う |
| D-30-28'' | `pnpm dev` を child process で spawn | ポート衝突・起動待ち・ログノイズ。`startServer()` なら同一プロセスで完結する |

---

## 6. 全体設計

### 6.1 ファイル一覧

**新規（38 ファイル）**

| # | パス | 責務 | 見積 |
|---|---|---|---|
| 1 | `src/lib/cn.ts` | `twMerge(clsx(...))` | 3 |
| 2 | `src/lib/api/client.ts` | CSRF キャッシュ＋fetch ラッパー＋エラー解釈 | 90 |
| 3 | `src/lib/theme/resolver.ts` | テーマ純関数（testable） | 45 |
| 4 | `src/lib/theme/server-preference.ts` | Server Component から user's theme 取得 | 25 |
| 5 | `src/lib/util/device.ts` | `deriveDeviceName` / `deriveOsLabel` | 70 |
| 6 | `src/lib/util/datetime.ts` | `formatLocalDateTime` / TZ 検証 | 35 |
| 7 | `src/lib/auth/notifications.ts` | 新規デバイス判定＋通知送信 | 80 |
| 8 | `src/lib/auth/oauth/registry.ts` | 社会 provider 型＋空エントリ | 45 |
| 9 | `src/lib/validate/preferences.ts` | zod（theme/language/timezone） | 20 |
| 10 | `src/lib/db/queries/user-preferences.ts` | get / upsert | 40 |
| 11 | `src/components/ui/button.tsx` | cva variants | 45 |
| 12 | `src/components/ui/input.tsx` | `aria-invalid`/`aria-describedby` | 30 |
| 13 | `src/components/ui/label.tsx` | Radix Label | 15 |
| 14 | `src/components/ui/card.tsx` | Card 一式 | 35 |
| 15 | `src/components/ui/alert.tsx` | 状態＝色＋アイコン＋テキスト | 45 |
| 16 | `src/components/ui/dialog.tsx` | Radix Dialog（再認証/確認/1回のみ表示） | 70 |
| 17 | `src/components/ui/tabs.tsx` | Radix Tabs | 40 |
| 18 | `src/components/ui/toast.tsx` | `role=status` + `aria-live=polite` | 70 |
| 19 | `src/components/theme/theme-provider.tsx` | provider（server > localStorage > system） | 110 |
| 20 | `src/components/theme/theme-toggle.tsx` | 3 択 segmented | 80 |
| 21 | `src/components/theme/theme-script.ts` | FOUC script 文字列生成（server から呼ぶ） | 35 |
| 22 | `src/components/auth/password-strength.tsx` | PW meter（5 段階） | 90 |
| 23 | `src/components/auth/reauth-dialog.tsx` | 再認証ダイアログ（5 分猶予・D-14） | 90 |
| 24 | `src/components/auth/totp-challenge-form.tsx` | 6 桁入力（Phase 5 接続用） | 80 |
| 25 | `src/components/auth/resend-notice.tsx` | 再送信ボタン＋429 表示（verify/forgot で共用） | 60 |
| 26 | `src/components/settings/session-list.tsx` | §38 カード UI | 160 |
| 27 | `src/components/settings/security-events.tsx` | イベント一覧 | 70 |
| 28 | `src/components/settings/theme-form.tsx` | 3 択フォーム | 70 |
| 29 | `src/app/api/auth/preferences/route.ts` | GET / PATCH | 70 |
| 30 | `src/app/api/auth/sessions/route.ts` | GET 一覧 | 60 |
| 31 | `src/app/api/auth/sessions/[id]/route.ts` | DELETE 個別失効 | 70 |
| 32 | `src/app/api/auth/logout-all/route.ts` | POST 全失効 | 70 |
| 33 | `src/app/api/auth/security/events/route.ts` | GET イベント一覧 | 55 |
| 34 | `src/app/settings/{appearance,sessions,security,password}/page.tsx` | 4 画面 | 260 |
| 35 | `src/app/{forgot-password,reset-password}/page.tsx` | 2 画面 | 150 |
| 36 | `src/app/email-change/confirm/page.tsx` ＋ `email-change-form.tsx` | email 変更確認（BUG-2） | 90 |
| 37 | `src/test/helpers/email.ts` | memory email transport（D-30-25） | 45 |
| 38 | `components.json` | shadcn 互換設定（CLI は実行しない） | 20 |

**変更（18 ファイル）**

| パス | 変更内容 |
|---|---|
| `src/app/globals.css` | `--primary-fg` / `--border-strong` / `--*-soft` / `--hover` / `--disabled-fg` 追加・`@theme inline` マッピング（BUG-3/4・§6.5） |
| `src/app/layout.tsx` | theme script を `theme-script.ts` へ置換、`ThemeProvider` でラップ、`html lang`/`suppressHydrationWarning` は現状維持 |
| `src/app/auth-form.tsx` | `components/ui` ＋ `api/client` ＋ `messages` へ移行（§10.2 に分解手順） |
| `src/app/verify-email-form.tsx` | 同上＋ auto POST 1 回化＋再送信 |
| `src/app/login/page.tsx` / `register/page.tsx` | 文面一元化、`ThemeToggle` 配置、ログイン済リダイレクト |
| `src/app/page.tsx` | ハブの `destinations`（`page.tsx:12-16`）に security/sessions/appearance を追加 |
| `src/app/settings/settings-nav.tsx` / `settings/page.tsx` | ナビ・ホームに 3 項目追加 |
| `src/lib/auth/session.ts` | `deviceName` を `deriveDeviceName()` に置換（`createSessionInternal` と `getSession` の 2 箇所） |
| `src/lib/db/queries/sessions.ts` | `listActiveSessionsByUser` / `findOwnedSession` |
| `src/lib/db/queries/security-events.ts` | `listRecentSecurityEventsByUser` |
| `src/lib/db/schema.ts` | `userPreferences` 追加 ＋ `SECURITY_EVENT_TYPES` に 2 種 |
| `src/app/api/auth/login/route.ts` | 新規デバイス通知の接続 |
| `src/app/api/auth/register/route.ts` | メール送信を best-effort 化（BUG-6）＋ URL 据え置き（303 方式） |
| `src/app/api/auth/resend-verification/route.ts` | メール送信を best-effort 化（BUG-6） |
| `src/app/api/auth/password/forgot/route.ts` | URL を `/reset-password` へ（BUG-1）＋ 送信 best-effort |
| `src/app/api/auth/email/change/confirm/route.ts` | `GET` を 303 で `/email-change/confirm` へ追加（BUG-2） |
| `src/lib/auth/email/send.ts` | transport seam（D-30-25） |
| `src/messages/ja.ts` | UI 文言一式（§15） |
| `src/messages/ja.ts`（同ファイル） | `emails.securityNotification`/`changeNotification` 拡張 |
| `scripts/server.ts` | 同意画面の dark 対応＋CSP に style-inline（D-30-26/BUG-5） |
| `src/middleware.ts` | 3 ルートの `no-store` 追加 |
| `package.json` / `pnpm-lock.yaml` | 依存 7 |

### 6.2 データモデル

**migration `0014_09_user_preferences.sql`（完全版）**

```sql
CREATE TABLE "user_preferences" (
  "user_id"    text PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "theme"      text NOT NULL DEFAULT 'system',
  "language"   text NOT NULL DEFAULT 'ja',
  "timezone"   text NOT NULL DEFAULT 'UTC',
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_preferences_theme_chk" CHECK ("theme" IN ('system','light','dark'))
);
COMMENT ON TABLE "user_preferences" IS '§40 テーマ / §60 タイムゾーン設定。行が無い場合は既定値を使う';
```

- **backfill しない**（行が無い = 既定値。`GET` は既定を返し、`PATCH` で初めて行が作られる）
- 生成: `pnpm db:generate` → レビュー → `pnpm db:migrate` → `pnpm db:verify-migrations`
- **ロールバック**: `DROP TABLE user_preferences;`（他テーブルから参照されないので可逆）
- 既存テーブル（`sessions`/`users`/`security_events`）は**スキーマ変更なし**

```ts
export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  theme: text('theme').notNull().default('system'),
  language: text('language').notNull().default('ja'),
  timezone: text('timezone').notNull().default('UTC'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('user_preferences_theme_chk', sql`${table.theme} in ('system', 'light', 'dark')`),
]);
export type UserPreferences = typeof userPreferences.$inferSelect;
```

**`SECURITY_EVENT_TYPES` への追加（migration 不要・text 列）**

```ts
'new_device_login',             // 新規デバイスからのログインで通知を送った
'security_notification_failed', // 通知/確認メールの送信に失敗した（D-30-14 / BUG-6 の検知点）
```

**既存セッションの `device_name`**: backfill しない（D-30-12）。UI で正規表示する。

### 6.3 API 契約（新規 6 エンドポイント）

すべて `withAuthPipeline` を通す（Origin → CSRF → 認証 →［再認証］→ 認可 → 入力検証）。GET は読み取り専用（§25）。エラーは `{ success:false, error:{ code, message } }`（§58）。

#### (1) `GET /api/auth/preferences`

```jsonc
// 200（行が無い場合。Cache-Control: no-store）
{ "success": true, "data": { "theme": "system", "language": "ja", "timezone": "UTC" } }
```

| 状況 | status | code |
|---|---|---|
| 未ログイン | 401 | `SESSION_EXPIRED` |
| レート超過 | 429 | `RATE_LIMITED`（`Retry-After` 付き） |

#### (2) `PATCH /api/auth/preferences`

```jsonc
// リクエスト（POST/PUT/PATCH/DELETE のみ body を parse する）
{ "theme": "dark" }                       // theme / language / timezone のいずれか 1 つ以上
// 200
{ "success": true, "data": { "theme": "dark", "language": "ja", "timezone": "UTC" } }
```

| 状況 | status | code |
|---|---|---|
| 未ログイン | 401 | `SESSION_EXPIRED` |
| Origin 不正 / CSRF 欠落・不一致 | 403 | `CSRF_FAILED` |
| `theme: "neon"` / 未知キー | 400 | `VALIDATION_ERROR` |
| レート超過 | 429 | `RATE_LIMITED` |

```ts
// src/lib/db/queries/user-preferences.ts
export async function upsertUserPreferences(userId: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
  const db = getDb();
  const [row] = await db.insert(userPreferences)
    .values({ userId, ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { ...patch, updatedAt: new Date() } })
    .returning();
  return row!;
}
```

#### (3) `GET /api/auth/sessions`

```jsonc
// 200
{ "success": true, "data": { "sessions": [
  { "id": "ses_01J...", "device_name": "Chrome on Windows", "os": "Windows 11",
    "ip_masked": "203.0.113.xxx", "last_seen_at": "2026-10-03T20:30:00.000Z",
    "created_at": "2026-09-30T09:12:00.000Z", "current": true },
  { "id": "ses_01K...", "device_name": "iPhone", "os": "iOS 18",
    "ip_masked": "198.51.100.xxx", "last_seen_at": "2026-10-02T18:20:00.000Z",
    "created_at": "2026-09-28T12:00:00.000Z", "current": false }
]}}
```

- 並び順は**サーバ側**で `current` を先頭、以降 `last_seen_at DESC`
- `os` は `deriveOsLabel(ua)`。判定不能なら `null`
- **返さない**: `session_hash`/`csrf_secret`/`ip`（生）/`ip_hash`/`user_agent`/`revoke_reason`

#### (4) `DELETE /api/auth/sessions/{id}`

| 状況 | status | code / 挙動 |
|---|---|---|
| 成功（別セッション） | 200 | `{ success:true, data:{ revoked:true, wasCurrent:false } }` ＋ `session_revoked` |
| 成功（**現行**セッション） | 200 | ＋ **Cookie 削除**。クライアントは `/login` へ |
| 他人 / 存在しない / 失効済み | **404** | `NOT_FOUND`（存在を秘匿） |
| 未ログイン / CSRF 違反 | 401 / 403 | `SESSION_EXPIRED` / `CSRF_FAILED` |

#### (5) `POST /api/auth/logout-all`

| 状況 | status | code / 挙動 |
|---|---|---|
| 成功（5 分以内の再認証済み） | 200 | 全 revoke（`logout_all`）、`session_revoked`、変更系通知、Cookie 削除 |
| 再認証が必要/期限切れ | 401 | `REAUTH_REQUIRED` |
| CSRF 違反 | 403 | `CSRF_FAILED` |
| メール失敗 | **200 のまま** | `security_notification_failed` を記録 |

#### (6) `GET /api/auth/security/events`

```jsonc
// クエリ: ?limit=10（既定10・上限50。1 未満や不正は 10 に丸める）
{ "success": true, "data": { "events": [
  { "event_type": "login_success", "ip_masked": "203.0.113.xxx",
    "created_at": "2026-10-03T20:30:00.000Z", "metadata": { "device": "Chrome on Windows" } }
]}}
```

- SQL では **`event_type, ip_masked, created_at, metadata` の 4 列だけ**を取得（`ip`・`user_agent` は SELECT しない）
- `metadata` は許可キーのみを通す（`device`/`provider`/`scope`/`state_present`/`notified`/`kind`/`scope_of_limit` ほか）

### 6.4 共通クエリ（新規）

```ts
// src/lib/db/queries/sessions.ts に追加
export async function listActiveSessionsByUser(userId: string): Promise<Session[]> {
  const db = getDb(); const now = new Date();
  return db.select().from(sessions).where(and(
    eq(sessions.userId, userId), isNull(sessions.revokedAt),
    gt(sessions.expiresAt, now), gt(sessions.absoluteExpiresAt, now),
  )).orderBy(desc(sessions.lastSeenAt));
}

export async function findOwnedSession(id: string, userId: string): Promise<Session | null> {
  const db = getDb();
  const [row] = await db.select().from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .limit(1);
  return row ?? null;
}

// src/lib/db/queries/security-events.ts に追加
export async function listRecentSecurityEventsByUser(userId: string, limit: number) {
  const db = getDb();
  return db.select({
    eventType: securityEvents.eventType, ipMasked: securityEvents.ipMasked,
    createdAt: securityEvents.createdAt, metadata: securityEvents.metadata,
  }).from(securityEvents).where(eq(securityEvents.userId, userId))
    .orderBy(desc(securityEvents.createdAt)).limit(limit);
}
```

- 既存 index `sessions_user_id_idx` / `security_events_user_id_created_at_idx` が対応済み（`schema.ts`）。新規 index は不要

### 6.5 テーマトークン（**実測済み**）

現行 `globals.css` の 11 変数を WCAG 相対輝度式で実測した結果:

| ペア | light | dark | 判定（本文 4.5:1） |
|---|---|---|---|
| `--fg` on `--bg` | 17.74:1 | 15.47:1 | ✅ |
| `--fg` on `--card` | 16.98:1 | 14.33:1 | ✅ |
| `--muted-fg` on `--card` | 7.23:1 | 6.99:1 | ✅ |
| `--muted-fg` on `--bg` | 7.56:1 | 7.54:1 | ✅ |
| `--danger` on `--bg` | 6.47:1 | 6.92:1 | ✅ |
| `--success` on `--bg` | 5.02:1 | 10.99:1 | ✅ |
| `--warning` on `--bg` | 5.02:1 | 11.47:1 | ✅ |
| `--ring` on `--bg` | 5.17:1 | 10.62:1 | ✅（非テキスト 3:1 も満たす） |
| `--primary` on `--bg` | 6.70:1 | 7.53:1 | ✅ |
| **`--border` on `--card`** | **1.41:1** | **1.72:1** | ❌ **非テキスト 3:1 失敗（BUG-4）** |
| **`#ffffff` on `--primary`（現行ボタン）** | 6.70:1 | **2.54:1** | ❌ **dark で AA 失敗（BUG-3）** |

**⇒ 追加する変数（採用値と実測）**

| 変数 | light | dark | 用途 | 実測 |
|---|---|---|---|---|
| `--primary-fg` | `#ffffff` | `#0b0f19` | `bg-primary` の前景（`text-white` を全廃） | 6.70:1 / 7.53:1 ✅ |
| `--border-strong` | `#6b7280` | `#6b7280` | 入力欄・ボタンの境界のみ（カード枠は `--border` のまま） | 4.63:1 on card / 3.67:1 on card ✅ |
| `--danger-soft` | `#fef2f2` | `#2a1416` | alert 背景 | 5.91:1 / 6.27:1 ✅ |
| `--success-soft` | `#f0fdf4` | `#12241a` | alert 背景 | 4.79:1 / 9.32:1 ✅ |
| `--warning-soft` | `#fefce8` | `#2a2010` | alert 背景 | 4.86:1 / 9.58:1 ✅ |
| `--hover` | `#f3f4f6` | `#1f2937` | hover 背景 | 前景 16.12:1 / 11.86:1 ✅ |
| `--disabled-fg` | `#4b5563` | `#9ca3af` | disabled ラベル | 6.10:1 / 5.78:1 ✅（WCAG は disabled を除外するが可読性優先で採用） |

- `@theme inline` に `--primary-fg` / `--border-strong` / `--*-soft` / `--hover` / `--disabled-fg` をマッピング
- **検証は unit テストで固定**（`src/test/unit/theme-contrast.test.ts`、§16.2 に実装コード）: **13 ペア × light/dark = 26 値**。本文系 9 ペアは ≥4.5、非テキスト系（`--ring`,`--border-strong`）は ≥3.0
- **`text-white` は 2 箇所のみ**（`auth-form.tsx:120`, `verify-email-form.tsx:71`）。⇒ `text-[--primary-fg]`（Tailwind v4 では `text-primary-fg`）に置換する

---

## 7. テーマ実装（3-A 中核）

### 7.1 `src/lib/theme/resolver.ts`（純関数・ブラウザ依存なし）

```ts
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'theme';
export const DEFAULT_THEME: ThemePreference = 'system';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'] as const;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}
export function normalizeTheme(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : DEFAULT_THEME;
}
export function resolveEffectiveTheme(pref: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (pref === 'system') return prefersDark ? 'dark' : 'light';
  return pref;   // 明示選択は OS 設定を無視する（§39）
}
```

> `matchMedia` / `localStorage` は**このファイルに書かない**。node 環境で unit テストが動くため。

### 7.2 `ThemeProvider` の状態機械

```tsx
'use client';
export function ThemeProvider({ initialPreference, authenticated, children }: Props) {
  const [preference, setPreference] = useState<ThemePreference>(normalizeTheme(initialPreference));

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = resolveEffectiveTheme(preference, mq.matches);
    };
    apply();
    if (preference !== 'system') return;          // light/dark は OS 設定を無視（§39）
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);   // ★ cleanup 必須（リーク防止）
  }, [preference]);

  async function update(next: ThemePreference) { /* §7.3 */ }
  return <ThemeContext.Provider value={{ preference, update }}>{children}</ThemeContext.Provider>;
}
```

**`preference` は localStorage より server 値を優先して初期化する**（D-30-03）。初期値の決定は `ThemeProvider` の props（Server Component から渡す）で行い、クライアントで localStorage を読むのは hydration 後のみ（hydration mismatch 回避。`layout.tsx:29` の `suppressHydrationWarning` は現状維持）。

### 7.3 保存フロー（`update`）

1. optimistic に `setPreference(next)` ＋ `localStorage.setItem('theme', next)`
2. `authenticated` なら `apiClient.patch('/api/auth/preferences', { theme: next })`
3. 失敗時: 直前の値へロールバック ＋ toast（`role="alert"`）
4. 未ログインなら localStorage のみ（Step 2 を飛ばす）

### 7.4 FOUC 防止 script（D-30-04）

`src/app/layout.tsx`（**Server Component**）で `pref` を読み、`buildThemeInitScript(pref)` を `<head>` の同期 script に出力する。**現行 `layout.tsx:14-24` の仕様を包含する**:

1. 例外を握る（`try/catch`）
2. 優先順位: **server 値 → `localStorage['theme']` → `system`**
3. `prefers-color-scheme` を読んで **`document.documentElement.dataset.theme`** に `dark`/`light` を設定
4. 失敗時は `light` にフォールバック
5. **ユーザー入力を補間しない**（`pref` は enum 検証済みなので 3 値のみが埋め込まれる）
6. nonce は既存どおり middleware の `x-nonce` を使う（`layout.tsx:26`）

### 7.5 テーマの検証 5 点

| # | 検証 | 自動/手動 | 期待 |
|---|---|---|---|
| 1 | FOUC なし | 手動 | JS 無効で `/settings/appearance` を開く → dark 設定なら dark 描画 |
| 2 | OS テーマ変更へリロードなしで追従 | 手動 | `system` で OS light↔dark → UI が即時変化（§41） |
| 3 | 明示選択は OS 設定を無視 | 手動 | `light` で OS dark に → **変わらない**（§39） |
| 4 | ログイン/ログアウトで復元 | 手動 | dark → ログアウト → ログイン → server の dark が優先 |
| 5 | 壊れた localStorage に耐える | 手動＋unit | `localStorage.theme='neon'` → `system` で動作 |

### 7.6 同意画面（`scripts/server.ts`）の dark 対応（BUG-5 / D-30-26）

```ts
// scripts/server.ts の同意/エラーページに注入する最小スタイル
const THEME_STYLE = `<style>
  :root { color-scheme: light dark; }
  body { background:#f8fafc; color:#0f172a; }
  @media (prefers-color-scheme: dark) {
    body { background:#0b0f19; color:#e5e7eb; }
    button { background:#1d4ed8; color:#ffffff; border-color:#1d4ed8; }
    button[value="deny"] { background:#374151; }
  }
  a { color:#1d4ed8; } @media (prefers-color-scheme: dark) { a { color:#93c5fd; } }
</style>`;
```

- 承認フロー中はこのページの theme 切替 UI を**出さない**（Phase 3 のスコープ外。OS に追従させるだけで §64 の Dark を満たす）
- `send()`（`scripts/server.ts:23-33`）の CSP は現在 `style-src 'self'`。インライン style を入れるため **`style-src 'self' 'unsafe-inline'`** に変更が必要。`script-src` は現状どおり `'none'` のまま（**インライン script は入れない**）
- 回帰: `src/test/e2e/oidc-flow.test.ts` の consent テスト（`client-console.test.ts:60` 付近）が同意 HTML を検証しているため、**期待文字列の更新が必要**（§17 に明記）

---

## 8. 共通UI基盤

### 8.1 依存と設定

```jsonc
// components.json（新規。shadcn 互換。CLI は実行しない）
{ "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york", "rsc": true, "tsx": true,
  "tailwind": { "config": "", "css": "src/app/globals.css", "baseColor": "neutral",
                "cssVariables": true, "prefix": "" },
  "aliases": { "components": "@/components", "ui": "@/components/ui",
               "utils": "@/lib/cn", "lib": "@/lib" } }
```

- 追加バージョンは `pnpm add class-variance-authority clsx tailwind-merge lucide-react ua-parser-js @radix-ui/react-dialog @radix-ui/react-label @radix-ui/react-tabs`。**React 19 対応の最新版**を指定し、lockfile を更新

### 8.2 `components/ui` の props 契約

| コンポーネント | variant / props | 備考 |
|---|---|---|
| `Button` | variant: `default`/`secondary`/`outline`/`ghost`/`destructive`/`link`、size: `sm`/`md`/`lg`/`icon` | **`focus-visible:ring-2 ring-ring` 必須**。前景は **`text-primary-fg`**（`text-white` 禁止・D-30-23）。境界は `border-border-strong` |
| `Input` | ネイティブ属性 + `invalid?: boolean` | `aria-invalid` / `aria-describedby` を自動付与。境界 `border-border-strong` |
| `Label` | Radix Label | `htmlFor` 必須運用 |
| `Card` | `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter` | 枠は `border-border`（見た目を維持）。内部の input のみ `border-border-strong` |
| `Alert` | variant: `info`/`success`/`warning`/`danger`、size: `sm`/`default` | **構造を「色＋アイコン＋テキスト」で固定**（§8.3） |
| `Dialog` | Radix。`open`/`onOpenChange`/`title`/`description`/`footer` | 破壊的操作は `destructive`。フォーカストラップは Radix に任せる |
| `Tabs` | Radix。`defaultValue`/`value`/`onValueChange` | `/settings/security` のセクション分け |
| `Toast` | `variant`/`title`/`description`/`duration` | `role="status"` + `aria-live="polite"`。エラーだけ `role="alert"` |

**クラス設計の一例（Button default）** — 実装時にこの形を `components/ui/button.tsx` の 1 箇所に集約し、ページ側で utility を直書きしない:

```tsx
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'focus-visible:ring-offset-2 disabled:pointer-events-none disabled:bg-disabled-bg disabled:text-disabled-fg',
  { variants: {
      variant: {
        default:     'bg-primary text-primary-fg hover:opacity-90',
        secondary:   'bg-card text-fg border border-border hover:bg-hover',
        outline:     'border border-border-strong bg-transparent text-fg hover:bg-hover',
        ghost:       'bg-transparent text-fg hover:bg-hover',
        destructive: 'bg-danger text-primary-fg hover:opacity-90',
        link:        'bg-transparent text-primary underline underline-offset-4',
      },
      size: { sm: 'h-8 px-3', md: 'h-10 px-4', lg: 'h-12 px-6', icon: 'h-10 w-10' },
  }, defaultVariants: { variant: 'default', size: 'md' } });
```

> `destructive` の前景は `--primary-fg` ではなく **白固定**でも良いが、light/dark 両方 designed に固定値を使う：**light `#ffffff` / dark `#ffffff`**（`--danger` は両テーマで 4.5:1 以上のため `--danger-fg` は作らない）。**この判断は §6.5 の実測で `--danger` の contrast -watch から導出する**。

### 8.3 `Alert` の状態表現（§42 準拠の構造）

```tsx
<Alert variant="danger">
  <AlertIcon aria-hidden />            {/* TriangleAlert / Info / CircleCheck / ShieldAlert */}
  <AlertBody>
    <AlertTitle>変更できません</AlertTitle>
    <AlertDescription>最後の認証手段は削除できません。</AlertDescription>
  </AlertBody>
</Alert>
```

**色だけに状態を伝えない**（§42）。この 4 要素構造（アイコン＋タイトル＋説明）を `danger`/`success`/`warning`/`info` の 4 variant で固定し、PW meter・バッジ・テーマ選択肢・セッションの現在バッジも同じ 3 要素セットで構成する。

---

## 9. 認証画面（3-B）

### 9.1 通信クライアント `src/lib/api/client.ts`（D-30-22）

```ts
let cachedCsrf: string | null = null;
export function resetCsrfCache(): void { cachedCsrf = null; }   // ログイン/ログアウトで呼ぶ

async function csrf(): Promise<string> {
  if (cachedCsrf) return cachedCsrf;
  const res = await fetch('/api/auth/csrf', { cache: 'no-store' });
  const body = await res.json();                       // { success, data:{ csrfToken } }
  if (!body?.success || !body.data?.csrfToken) throw new ApiClientError('CSRF_FAILED');
  cachedCsrf = body.data.csrfToken; return cachedCsrf;
}

export async function apiClient<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const send = async () => {
    if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = await csrf();  // ★自動付与
    return fetch(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  let res = await send();
  if (res.status === 403) {                 // CSRF 失効 → 1 回だけ再取得して再試行（無限ループ禁止）
    resetCsrfCache();
    res = await send();
  }
  const body = await res.json();
  if (!res.ok || !body?.success) throw new ApiClientError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message);
  return body.data as T;
}
```

- CSRF トークンは**モジュール変数のみ**。localStorage/sessionStorage に保存しない
- `GET /api/auth/csrf` は**セッション Cookie から導出**されるため、ログイン/ログアウトではキャッシュを破棄する（`resetCsrfCache()`）

### 9.2 PW meter

| 要素 | 内容 |
|---|---|
| 判定の正本 | `src/lib/validate/password.ts` の `passwordSchema`（8〜128 文字・NG 表現）。**server 側の判定は変えない**。UI は同じ境界を `minLength={8} maxLength={128}` に付ける |
| 5 段階 | `veryWeak`/`weak`/`fair`/`good`/`strong`。根拠: 長さ（8/12/16）、文字種 2〜3 種、`strength.ts` の `WEAK_PASSWORDS` 含有 |
| 表示 | **色＋アイコン＋テキスト**。progressbar は `role="progressbar"` + `aria-valuenow` + `aria-valuetext="強い"` |
| 常時表示 | 「8 文字以上 128 文字以下で入力してください」＋「他のサービスと使い回さないでください」 |
| breached | `register`/`password/reset` は漏洩判定で **`VALIDATION_ERROR`(400) ＋「このパスワードは漏洩している可能性があります」**。UI はそのまま表示。**新しいエラーコードは追加しない**。HIBP 障害時は fail-open（D-17） |

### 9.3 `/login`

```text
┌─────────────────────────────────────┐
│  oauth                    [テーマ切替] │  ← ThemeToggle（未ログインでも可）
│  メールアドレスとパスワードで…      │
├─────────────────────────────────────┤
│ ログイン                              │  ← 既存 auth-form.tsx を components/ui へ移行（§10.2）
│ 識別子                                │
│ ┌────────────────────────────────┐ │
│ │ メールアドレスまたはユーザー名   │ │  autocomplete="username"
│ └────────────────────────────────┘ │
│ パスワード                            │
│ ┌────────────────────────────────┐ │
│ │ ●●●●●●●●                       │ │  autocomplete="current-password"
│ └────────────────────────────────┘ │
│ [ログイン]（送信中は disabled + aria-busy）
│ ⚠ 認証情報が正しくありません。        │  ← role="alert"、常に同一文言（§46）
│ パスワードをお忘れですか？            │
│ アカウントをお持ちでないですか？ 新規登録
│ [Google で続行] [GitHub で続行]      │  ← registry 由来。0 件なら**この区ごと出ない**
│ [Passkey でログイン]                 │  ← 〃
└─────────────────────────────────────┘
```

| 要件 | 実装 |
|---|---|
| 識別子は単一入力欄 | `email_or_username` を維持。**トグルで 2 欄にしない**（API 契約と列挙対策を不変にする） |
| 2FA 入力 | `TotpChallengeForm` を `totp_pending` 時に表示（`inputMode="numeric"` `autoComplete="one-time-code"` `maxLength={6}`、Enter で送信）。**Phase 3 では API 未接続**なので registry 空の間は表示されない |
| `returnTo` | `/oauth2/interaction/` で始まる場合のみ許可（`auth-form.tsx:76` の既存仕様を維持）、それ以外は `/` |
| 失敗時 | `INVALID_CREDENTIALS` の既定文言のみ。`RATE_LIMITED` は 429 として案内 |
| ログイン済みアクセス | `/login` `/register` にアクセス時、**`returnTo` があればそこへ、無ければ `/` へ server リダイレクト**（OIDC 同意訪問を壊さない） |

### 9.4 `/verify-email`（GET で状態変更しない）

```text
┌─────────────────────────────────────┐
│ メールアドレスの確認                  │
│ 登録を完了するには下のボタンを押して… │
│ ⚠ 確認リンクにトークンがありません     │  ← token 欠落時
│ [メールアドレスを確認する]            │  ← auto POST は 1 回だけ（useRef ガード）
│ [確認メールを再送]                    │  ← 429 は残り時間を toast で
│ ✓ 確認メールを送信しました。…          │  ← role="status"
└─────────────────────────────────────┘
```

- メール内 URL は `/api/auth/verify-email?token=` → **GET が 303 で `/verify-email` へ落ちる**（`verify-email/route.ts:16-21`）。この方式は §25 適合済みなので**据え置き**（D-30-24）
- **auto POST は `useEffect` + `useRef` ガードで 1 回だけ**。StrictMode の二重実行と再レンダによる重複 POST を防ぐ
- 再送信は `POST /api/auth/resend-verification`（email 5/時・ip 10/時、§4.3）
- `no-store` 追加（P3-B-08）

### 9.5 `/forgot-password` / `/reset-password`（BUG-1 の是正を含む）

```text
/forgot-password                          /reset-password?token=…
┌───────────────────────────┐             ┌───────────────────────────┐
│ パスワードの再設定          │             │ 新しいパスワード            │
│ 登録したメールアドレスを… │             │ ┌───────────────────────┐ │
│ ┌───────────────────────┐ │             │ │ ●●●●●●●●  強 ✔       │ │
│ │ you@example.com       │ │             │ └───────────────────────┘ │
│ └───────────────────────┘ │             │ 新パスワード（確認）        │
│ [再設定メールを送信]        │             │ ┌───────────────────────┐ │
│ ✓ 登録メールアドレスなら    │ ← 常に同一  │ │ ●●●●●●●●              │ │
│   再設定メールを送信しました  │    メッセージ└───────────────────────┘ │
└───────────────────────────┘             │ [パスワードを変更]          │
                                          └───────────────────────────┘
```

| 画面 | 要件 |
|---|---|
| forgot | **成否で同一メッセージ**「登録メールアドレスなら再設定メールを送信しました」。**応答時間を揃える**（送出の有無で大きく遅れない）。レート制限 429 は別表示で可 |
| reset | `?token=` は UI 上に**表示しない**。PW meter ＋ 2 欄。成功後は `/login?returnTo=/` へ。`INVALID_TOKEN` は既定文言のみで原因を言わない |
| **URL 是正（BUG-1）** | `forgot/route.ts:73` の `/password/reset?token=` を **`/reset-password?token=`** に変更。**GET は状態変更しない**ので、`/reset-password` 画面は token を読むだけで、確定は画面内の POST で行う |
| 共通 | token を含む URL を外部に送らない（`Referrer-Policy: strict-origin-when-cross-origin` は middleware と next.config が設定済み）。`no-store` 追加 |

### 9.6 `/settings/password`（D-30-20）

- 旧 PW（`current-password`）＋ 新 PW ＋ 確認（`new-password`）＋ PW meter
- `POST /api/auth/password/change` は `requireReauth: true`（`password/change/route.ts:26`）。5 分以内の `reauth_verified_at` で通る
- `REAUTH_REQUIRED`（401）を受けたら `ReauthDialog` でパスワード入力 → `POST /api/auth/reauth` → 元のリトライ
- 成功時: 「他のデバイスからもログアウトされました」の toast（サーバ側で全セッション revoke される副作用を明示）

### 9.7 `/email-change/confirm`（BUG-2 の是正）

```text
┌─────────────────────────────────────┐
│ メールアドレスの変更確認               │
│ 新しいアドレスの確認を完了してください  │
│ [メールアドレス変更を確定する]         │  ← POST /api/auth/email/change/confirm
│ ⚠ 確認リンクにトークンがありません     │
└─────────────────────────────────────┘
```

- `email/change/confirm/route.ts` に **`GET` を追加**し、303 で `/email-change/confirm?token=` へ（`verify-email` と同じ方式・§25）
- 画面は `verify-email-form.tsx` と同じ構成を再利用（`email-change-form.tsx`）
- 通知: 確定後は既存実装が**旧メールアドレスへ**通知する（`email/change/confirm/route.ts:54`）— 変更しない

---

## 10. セッション / デバイス管理（3-C）

### 10.1 `src/lib/util/device.ts`

```ts
import { UAParser } from 'ua-parser-js';

const MAX_DEVICE_NAME = 120;
const FALLBACK = 'その他のデバイス';
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

const clean = (value: string): string => CONTROL_CHARS.replace(value ?? '', '').slice(0, 512);
const truncate = (value: string): string => (value.length <= MAX_DEVICE_NAME ? value : value.slice(0, MAX_DEVICE_NAME));

export function deriveDeviceName(userAgent: string): string {
  const ua = clean(userAgent);
  if (!ua.trim()) return FALLBACK;
  const r = new UAParser(ua).getResult();

  // §19 の例: iPhone / Chrome on Windows / Firefox on Linux
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (r.device.model) {
    const s = [r.os.name, String(r.device.model)].filter(Boolean).join(' ');
    if (s) return truncate(s);                 // 例: Android 14 Pixel 8
  }
  if (!r.browser.name && !r.os.name) return FALLBACK;
  return truncate([r.browser.name ?? 'ブラウザ不明', r.os.name ? `on ${r.os.name}` : '']
    .filter(Boolean).join(' '));
}

export function deriveOsLabel(userAgent: string): string | null {
  const r = new UAParser(clean(userAgent)).getResult();
  if (!r.os.name) return null;
  return r.os.version ? `${r.os.name} ${r.os.version}` : r.os.name;
}
```

**表驱动テストの期待値**

| 入力（UA 断片） | `deriveDeviceName` | `deriveOsLabel` |
|---|---|---|
| Windows NT 10.0 + Chrome | `Chrome on Windows` | `Windows 10` |
| X11 Linux + Firefox | `Firefox on Linux` | `Linux` |
| Android 14 + Pixel 8 + Chrome | `Android 14 Pixel 8` | `Android 14` |
| iPhone / iOS 18 | `iPhone` | `iOS 18.0` |
| iPad / iOS 18 | `iPad` | `iOS 18.0` |
| `''` / `'   '` | `その他のデバイス` | `null` |
| `'curl/8.4.0'`（ブラウザ無し） | `その他のデバイス` | `null` |
| 制御文字混在（`"Chrome\u0007 on Windows"`） | 制御文字除去後に判定 | 同左 |
| 200 文字の UA | **120 文字以下** | ― |

### 10.2 セッション API の実装方針

| API | 要点 |
|---|---|
| `GET /api/auth/sessions` | `withAuthPipeline(request,{requireAuth:true})` → `listActiveSessionsByUser(user.id)` → `current = (row.id === session.id)` で**サーバ側ソート** → D-30-08 の 7 項目のみマップ → `handleSuccess`＋`no-store` |
| `DELETE /api/auth/sessions/{id]` | `findOwnedSession(id,user.id)` が null → `failResponse('NOT_FOUND','セッションが見つかりません',404)`。あれば `revokeSession(id,'logout')`（既存）＋ `recordSecurityEvent('session_revoked',…)`。**現行なら `clearSessionCookie()` も**呼び `{ revoked:true, wasCurrent:true }` |
| `POST /api/auth/logout-all` | `{requireAuth:true, requireReauth:true}` → `revokeAllSessions(user.id,'logout_all')`（既存 `REVOKE_REASONS` に含む）→ `session_revoked` → `sendChangeNotificationEmail(...)` を **try/catch で包む**（失敗時は `security_notification_failed`＋200 のまま）→ `clearSessionCookie()` |

**現行セッション判定**: `current` フラグをサーバで付けて返す。**クライアントで `document.cookie` は読まない**（HttpOnly Cookie・XSS 耐性）。

### 10.3 `/settings/sessions` 画面（§38）

```text
┌ ログイン中のデバイス ──────────────────────────────┐
│ 現在のセッション                                      │
│ ┌────────────────────────────────────────────────┐ │
│ │ 🖥  Chrome on Windows        [現在のセッション]    │ │
│ │     Windows 10 ・ 203.0.113.xxx                  │ │
│ │     最終アクセス: 2026/10/03 20:30                 │ │
│ │     ログイン日時:   2026/09/30 09:12                 │ │
│ │                              [ログアウト]          │ │
│ └────────────────────────────────────────────────┘ │
│ その他のデバイス                                      │
│ ┌────────────────────────────────────────────────┐ │
│ │ 📱 iPhone                    198.51.100.xxx      │ │
│ │     iOS 18.0 ・ 最終アクセス: 2026/10/02 18:20     │ │
│ │     ログイン日時: 2026/09/28 12:00                 │ │
│ │                              [ログアウト]          │ │
│ └────────────────────────────────────────────────┘ │
│ ⚠ [すべてのデバイスからログアウト]                    │  ← destructive・再認証
└──────────────────────────────────────────────────────┘
```

| 要件 | 実装 |
|---|---|
| 日時表示 | `<time dateTime={iso}>2026/10/03 20:30</time>`（D-30-17） |
| IP | `ip_masked` のみ（生 IP は API にも無い・D-30-08） |
| 個別ログアウト | 確認 Dialog → `DELETE /api/auth/sessions/{id}` → `router.refresh()` → toast。現行だった場合は `/login` へ |
| 全ログアウト | destructive Dialog → `POST /api/auth/logout-all`。`REAUTH_REQUIRED` なら `ReauthDialog` → 成功後 `/login` |
| 現在セッション | `current:true` の行にバッジ＋**ラベル＋アイコン＋太線**（色のみにしない・§42） |
| 空状態 | 1 セッションのみ（「他のデバイスはありません」）／0 件（「セッションが見つかりません。ログインし直してください」） |
| 未ログイン | `/login` へ（既存 `requireSettingsUser`・D-30-19）。layout の `no-store` が効く |

---

## 11. 通知メール（3-D）

### 11.1 送信マトリクス

| 通知 | トリガー | 現状 | 本フェーズ |
|---|---|---|---|
| メール確認 / 再送 | 登録 / 再送 | ✅ | 文言統一＋**送信 best-effort 化（BUG-6）** |
| パスワードリセット | forgot | ✅（**リンクは 404・BUG-1**） | URL 是正＋best-effort |
| email 変更 | 変更/確認 | ✅（**確認リンクは 405・BUG-2**） | GET 303＋画面新設＋best-effort |
| **新規デバイスログイン** | 新規デバイス判定 | ❌ | **新規実装**（P3-D-01a〜c） |
| 変更系（PW変更 / email変更 / 2FA / passkey / 連携） | 各操作 | PW変更・email変更のみ ✅ | **全ログアウトを追加**。passkey/連携は Phase 6/4 で同テンプレ再利用 |
| アカウント削除 | 削除 | ✅ | ― |

### 11.2 新規デバイス通知の実装

```ts
// src/lib/auth/notifications.ts
export async function notifyNewDeviceLogin(params: {
  userId: string; userEmail: string; deviceName: string;
  ipMasked: string | null; ipCountry: string | null; occurredAt: Date;
  ip: string; userAgent: string;            // security_events 記録用（logger には出さない）
}): Promise<void> {
  try {
    await sendSecurityNotificationEmail(params.userEmail, {
      device: params.deviceName,
      ip: params.ipMasked ?? '不明',
      region: params.ipCountry,                                    // null なら本文に行を出さない
      time: formatUtc(params.occurredAt),
    });
    await recordSecurityEvent('new_device_login', params.userId, params.ip, params.userAgent,
      { device: params.deviceName, notified: true });              // 許可キーのみ（§45）
  } catch {
    await recordSecurityEvent('security_notification_failed', params.userId, params.ip, params.userAgent,
      { kind: 'new_device_login' });                              // 真偽値・文脈のみ
    logger.error('security notification failed', { kind: 'new_device_login' });  // 本文・token を出さない
  }
}
```

**`POST /api/auth/login` への接続位置**（`src/app/api/auth/login/route.ts:98-105` 付近）

```ts
const { token, session } = await createSession(user.id, request);      // 既存
await setSessionCookie(token); await setAnonCookie(session.csrfSecret);

// ▼ 追加（insert 直後・login_success 前）
if (await isFirstSessionFromDevice(user.id, session.id)) {
  await notifyNewDeviceLogin({ userId: user.id, userEmail: user.email,
    deviceName: session.deviceName, ipMasked: session.ipMasked, ipCountry: null,
    occurredAt: new Date(), ip, userAgent: request.headers.get('user-agent') ?? '' });
}
await recordSecurityEvent('login_success', user.id, ip, ua);          // 既存
```

| 判定 | 実装 |
|---|---|
| `isFirstSessionFromDevice(userId, newSessionId)` | `listActiveSessionsByUser(userId)` のうち **`id !== newSessionId`** かつ **`ipHash` 同値** かつ **`deviceName` 同値** の行が 0 件 |
| 失敗時 | caller（login）が握る。**ログインの応答は 200 のまま** |
| 冪等 | 判定は insert 直後の 1 経路のみで呼ぶ（rotated session では呼ばない） |

### 11.3 通知文面（`escapeHtml` 経路を維持して拡張）

```text
件名: oauth: 新しいログインを検知しました
HTML 本文（骨子）:
  <p>アカウントへの新しいログインがありました。</p>
  <div> デバイス: Chrome on Windows
         IPアドレス: 203.0.113.xxx
         地域: 東京都, 日本        ← ip_country があるときだけ行を出す
         日時: 2026-10-03T20:30:00Z
  </div>
  <p>心当たりがない場合は、パスワードを変更し、すべてのデバイスからログアウトしてください。</p>
text/plain: 同内容（Resend に text も渡す。src/lib/auth/email/send.ts:29-30）
```

- 既存 `messages.emails.securityNotification` / `changeNotification` に `region` と `ignoreAdvice` を追加（§15）
- **地域が null のときは行そのものを出さない**（「不明」と書かない）
- 変更系（全ログアウト）の `change` 値は `すべてのデバイスからログアウト`
- 既存の `emailLayout`（`src/lib/auth/email/layout.ts`）は `color-scheme: light` 固定。**メールは OS 依存にしない**（日本語・固定レイアウト維持）ので変更しない

### 11.4 文面の安全（★ 必須）

| 禁止 | 対策 | テスト |
|---|---|---|
| PW / token / TOTP / passkey / session token を本文に載せない | テンプレの引数に token 系を渡さない（型で排除） | `notification-leak.test.ts` |
| ログにメール本文/URL を出さない | 既存の `token=` redaction を持つ `logger` を使う。**本文を logger に渡さない** | 既存 `log-redaction.test.ts` へ追記 |
| HTML エスケープ | 既存 `escapeHtml()` を維持。`deviceName` は 120 文字・制御文字除去済み | `device.test.ts` |
| 通知失敗でログイン/登録を失敗させない | try/catch ＋ `security_notification_failed` ＋ **列挙安全の同一メッセージ維持**（D-30-27） | `notification-leak.test.ts` |

---

## 12. 設定画面

### 12.1 `/settings/security`（§37 レイアウト）

```text
┌ セキュリティ ──────────────────────────────────────┐
│ パスワード                                            │
│ 最終変更: 2026/09/30 09:12                 [変更]      │  ← /settings/password
│ メールアドレス                                        │
│ you@example.com            [✓ 認証済み]                │  ← email_verified バッジ
│ 2段階認証                                            │
│ 無効                                   （Phase 5 で追加）│  ← 導線なし（D-30-16）
│ Passkey                                              │
│ 0 件                                  （Phase 6 で追加） │
│ 連携アカウント                                        │
│ 未連携（Google / GitHub / Discord）   （Phase 4 で追加） │
│ OIDC / OAuth 2.0 クライアント                         │
│ 登録済みクライアントの一覧 →                        │  ← 既存 M2.6 への導線（別カード）
│ ログイン中のデバイス                                  │
│ Chrome on Windows ・ 203.0.113.xxx ・ 現在            │  ← 先頭 3 件＋「すべて見る」
│ [すべてのデバイスからログアウト]                       │  ← destructive・再認証
│ 最近のセキュリティイベント                            │
│ ・新しいログイン            203.0.113.xxx  10/03 20:30 │
│ ・パスワードを変更           203.0.113.xxx  09/30 09:12 │
│ ・ログインに失敗             198.51.100.xxx  09/29 22:03│
│                    （直近10件・表示のみ・操作なし）     │
└──────────────────────────────────────────────────────┘
```

| カード | データ取得 | 状態 |
|---|---|---|
| パスワード | `users.password_changed_at`（無ければ `created_at`）＋ `[変更]` | ✅（D-30-20） |
| メールアドレス | `users.email` + `emailVerified`。未認証なら「未確認」＋再送ボタン | ✅ |
| 2 段階認証 | テーブルが無いので「無効」固定 | 表示のみ（Phase 5） |
| Passkey | 同「0 件」 | 表示のみ（Phase 6） |
| 連携アカウント | `accounts` テーブルが無いので「未連携」 | 表示のみ（Phase 4） |
| デバイス | `GET /api/auth/sessions` の先頭 3 件 | ✅ |
| 全ログアウト | `POST /api/auth/logout-all` | ✅ |
| 最近のイベント | `GET /api/auth/security/events?limit=10` | ✅ |

- **操作しない**一覧は読み取り専用 GET（§25）。行クリックで何も起こらないこと
- イベント表示名は `messages.ui.security.eventLabels` の `Record<SecurityEventType, string>`。**未定義の種別は `eventType` をそのまま表示**（Enum 追加で壊れない）

### 12.2 `/settings/appearance`

```text
┌ 外観 ───────────────────────────────────────────────┐
│ テーマ                                                 │
│ ○ システムに追従                                      │  ← 既定（§39/§40）
│ ○ ライト                                              │
│ ○ ダーク                                              │
│ 現在の設定: システムに追従（現在はダークテーマで描画されています）│  ← 色＋アイコン＋テキスト
└──────────────────────────────────────────────────────┘
```

| 要件 | 実装 |
|---|---|
| 3 択 | `fieldset` + `legend` + radio（native の role に任せる）。`aria-describedby` で説明文を紐づけ |
| 即時反映 | 選択で `ThemeProvider.update()` → `data-theme` 更新 → `PATCH /api/auth/preferences`。**保存ボタンは設けない**（選択＝保存で 1 選択 1 API） |
| 失敗時 | 直前の値へロールバック ＋ toast（`role="alert"`） |
| 現在の解決結果 | 「現在の設定: ダーク（システムに追従中）」のように**設定値（希望）と実際に適用中の結果を分けて**表示（§39 の 3 択と見た目のずれを可視化） |
| 未ログイン | このルートは `/settings/*` なので認証必須。ログイン前の切替はヘッダー/ログイン画面の `ThemeToggle` |

---

## 13. アクセシビリティ / レスポンシブ

### 13.1 a11y チェックリスト（実装 ↔ 検証）

| 項目 | 実装 | 検証方法 |
|---|---|---|
| 全フォームに `label` | `Label` + `htmlFor`。placeholder を label 代用にしない | e2e で SSR HTML に `<label for=` |
| `autocomplete` | `username`/`current-password`/`new-password`/`one-time-code`/`email` | e2e で `autocomplete="..."` の存在 |
| エラー | `role="alert"` + `aria-live="polite"`、`aria-describedby` で input と紐づけ | 手動（読み上げ）＋チェックリスト |
| 成功 | `role="status"` + `aria-live="polite"` | 同上 |
| フォーカス | `:focus-visible`（既存 globals.css）＋ Dialog は Radix のトラップ | キーボードのみで 1 経路を完走 |
| コントラスト | §6.5 の 26 値（unit テストで固定） | `pnpm vitest run src/test/unit/theme-contrast.test.ts` |
| 色のみ禁止 | 状態は色＋アイコン＋テキスト（§8.3） | レビュー＋4 variant の目視 |
| motion | `prefers-reduced-motion` 既存維持。Dialog アニメは尊重 | 手動（OS 設定） |
| 見出し | 画面は `h1` 1 個、カードは `h2` | レビュー |
| `<time>` | 日時は `<time dateTime={iso}>` で機械可読値を併記 | レビュー |

### 13.2 レスポンシブ（375 / 768 / 1024 / 1440）

| 幅 | 期待 |
|---|---|
| 375 | ログイン/設定フォームが**横スクロール無し**。セッションチェックは 1 カラム。ボタン幅は親いっぱい |
| 768 | セッションチェックは 1〜2 カラム（Tailwind `sm:`） |
| 1024 | 設定は 2 カラム（`md:grid-cols-2`）、ナビは横並び |
| 1440 | `max-w-*` で読み幅を制限（`settings/layout.tsx:22` の `max-w-3xl` を継承） |

- **新規 CSS / クラスで固定幅 px を持ち込まない**（`w-[Npx]` / `min-w-[Npx]` 禁止）。Tailwind の `sm:`/`md:`/`lg:`/`xl:` のみ
- 静的チェック（P3-A-09）: `grep -rn "\[[0-9]\+px\]" src/app src/components` で新規該当 0
- 実ブラウザ viewport は Phase 8-B（P3-G-03 の手動チェックリストで代替）

---

## 14. メッセージ一元化（`src/messages/ja.ts`）

既存 `errors` / `auth` / `emails` / `ui.settings` / `ui.applications` は**変更しない**。以下を追加。

| キー | 値 |
|---|---|
| `ui.common.appName` | `${APP_NAME}`（config から） |
| `ui.common.save`/`cancel`/`copy`/`copied`/`loading`/`close` | 保存 / キャンセル / コピー / コピーしました / 読み込み中… / 閉じる |
| `ui.theme.title`/`system`/`light`/`dark`/`description`/`current`/`following` | テーマ / システムに追従 / ライト / ダーク / 端末の設定に合わせます / 現在の設定 / システムに追従中 |
| `ui.auth.loginTitle`/`registerTitle`/`identifierLabel`/`identifierHint`/`passwordLabel`/`confirmPasswordLabel`/`submitLogin`/`submitRegister`/`forgotLink`/`noAccountPrompt`/`hasAccountPrompt`/`loginRequired` | ログイン / アカウント登録 / メールアドレスまたはユーザー名 / どちらでも入力できます / パスワード / パスワード（確認） / ログイン / 登録する / パスワードをお忘れですか？ / アカウントをお持ちでないですか？ / すでにアカウントをお持ちですか？ / ログインが必要です |
| `ui.auth.verifyTitle`/`verifyDescription`/`verifyAction`/`resendAction`/`verifiedMessage` | メールアドレスの確認 / 登録を完了するには下のボタンを押してください / メールアドレスを確認する / 確認メールを再送する / 確認メールを送信しました。メールに記載されたリンクから登録を完了してください。 |
| `ui.auth.forgotTitle`/`forgotDescription`/`forgotAction`/`forgotSent` | パスワードの再設定 / 登録したメールアドレスを入力してください / 再設定メールを送信 / 登録メールアドレスなら再設定メールを送信しました |
| `ui.auth.resetTitle`/`resetDescription`/`resetAction`/`resetDone` | 新しいパスワード / 新しいパスワードを入力してください / パスワードを変更する / パスワードを変更しました。新しいパスワードでログインしてください。 |
| `ui.auth.emailChangeTitle`/`emailChangeDescription`/`emailChangeAction`/`emailChangeDone` | メールアドレスの変更確認 / 新しいメールアドレスの確認を完了してください / メールアドレス変更を確定する / メールアドレスを変更しました。 |
| `ui.pwStrength.guide`/`veryWeak`/`weak`/`fair`/`good`/`strong`/`reusedWarning`/`mismatch` | 8 文字以上 128 文字以下で入力してください / 非常に弱い / 弱い / 普通 / 強い / 非常に強い / 他のサービスと使い回さないでください / パスワードが一致しません |
| `ui.sessions.title`/`currentBadge`/`lastSeen`/`createdAt`/`signOut`/`signOutAll`/`signOutAllConfirm`/`signOutAllResult`/`emptyOthers`/`signedOut` | ログイン中のデバイス / 現在のセッション / 最終アクセス / ログイン日時 / ログアウト / すべてのデバイスからログアウト / すべてのデバイスからログアウトしますか？ / すべてのデバイスからログアウトしました / 他のデバイスはありません / ログアウトしました |
| `ui.security.title`/`passwordChangedAt`/`email`/`emailVerified`/`emailUnverified`/`twoFactor`/`passkey`/`linkedAccounts`/`devices`/`recentEvents`/`changePassword` | セキュリティ / 最終変更 / メールアドレス / 認証済み / 未確認 / 2段階認証 / Passkey / 連携アカウント / ログイン中のデバイス / 最近のセキュリティイベント / パスワードを変更 |
| `ui.security.eventLabels.{…}` | `Record<SecurityEventType, string>`: `login_success: 新しいログイン` / `login_failed: ログインに失敗` / `register: アカウント登録` / `logout: ログアウト` / `password_changed: パスワードを変更` / `password_reset: パスワードをリセット` / `email_changed: メールアドレスを変更` / `email_verified: メールアドレスを確認` / `new_device_login: 新しいデバイスからログイン` / `session_revoked: セッションを無効化` / `account_deleted: アカウントを削除` / …（全 33 種を網羅。**未定義は `eventType` をそのまま表示**） |
| `ui.preferences.themeTitle`/`timezone` | 外観 / タイムゾーン |
| `emails.securityNotification.region`/`ignoreAdvice` | 地域 / 心当たりがない場合は、パスワードを変更し、すべてのデバイスからログアウトしてください。 |
| `emails.changeNotification.logoutAll`/`ignoreAdvice` | すべてのデバイスからログアウト / 心当たりがない場合は速やかにパスワードを変更してください。 |

**ルール**: 既存 `auth.*`（API 成功メッセージ）と UI 文言を**混ぜない**（API は `data.message`、UI は `ui.*`）。エラーメッセージは `errors.*`（`ERROR_CODES` と 1 対 1）で `normalizeError` の既定文言と一致させる。

---

## 15. テスト基盤の実装詳細（D-30-28 / BUG-7）

### 15.1 e2e で実 HTTP を成立させる（既存パターン）

`scripts/server.ts:365` で **export 済みの `startServer({ dev, port, hostname })`** が Next を hosting できる（OIDC handler → Next の順で fallback）。既存 e2e 3 ファイルは `createOidcHandler` を直接使って OIDC のみを実 HTTP で叩いている。

```ts
// src/test/helpers/app-server.ts（新規・3 ファイルで共有）
import { startServer } from '../../../scripts/server';

export async function startTestAppServer(): Promise<{ origin: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  process.env.NEXT_PUBLIC_APP_URL = origin;
  process.env.CSRF_TRUSTED_ORIGINS = origin;
  process.env.ALLOWED_ORIGINS = origin;
  resetEnvCache();
  const { server } = await startServer({ dev: true, port, hostname: '127.0.0.1' });
  return { origin, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}
```

- **サーバ起動はファイル内 `beforeAll` の 1 回だけ**。`fileParallelism: false` なのでコストは逐次（3 ファイル × 起動時間）
- Cookie は既存 `CookieJar`（`helpers/http.ts:16-58`）を使う。`set-cookie` の複数取得は `headers.getSetCookie()` で既存実装済み
- **高速化**: ページ SSR（`/login` 等）は 1 ファイルにまとめ、API 中心の検証は `security`/`integration` の直接呼び出しで行う（§16.3/§16.4）

### 15.2 メール送信 seam（D-30-25）

```ts
// src/lib/auth/email/send.ts に追加
export type EmailTransport = { send(params: EmailParams): Promise<void> };
let override: EmailTransport | null = null;
export function setEmailTransport(next: EmailTransport | null): void { override = next; }

export async function sendEmail(params: EmailParams): Promise<void> {
  if (override) return override.send(params);      // テストはここを差し替える
  ... 既存の Resend 実装 ...
}
```

```ts
// src/test/helpers/email.ts（新規）
import { setEmailTransport, type EmailParams } from '@/lib/auth/email/send';

export type CapturedEmail = EmailParams & { tokenFromUrl?: string };

export function useMemoryEmail(): { outbox: CapturedEmail[]; failNext: (error: Error) => void } {
  const outbox: CapturedEmail[] = [];
  let failure: Error | null = null;
  setEmailTransport({
    async send(params) {
      if (failure) { const e = failure; failure = null; throw e; }   // 1 回だけ失敗させる
      const match = /[?&]token=([^&"'\s]+)/.exec(params.html + ' ' + params.text);
      outbox.push({ ...params, tokenFromUrl: match ? decodeURIComponent(match[1]) : undefined });
    },
  });
  return { outbox, failNext: (error) => { failure = error; } };
}
export function restoreResendEmail(): void { setEmailTransport(null); }
```

- **トークン抽出**ができるので、e2e で「登録 → メモリ内メールから token を取り出す → `/verify-email` の POST → `email_verified=true`」まで実 HTTP で完走できる（現状は `RESEND_API_KEY` 未設定で 500 になるため成立しない）
- 既存の `vi.mock('@/lib/auth/email/templates')`（`enumeration.test.ts:37-40`）は**文面テスト用に残す**。送信成否のテストは seam を使う（§16.4 で両方を使い分ける）

### 15.3 コントラスト計算のテスト実装（§6.5 の固定）

```ts
// src/test/unit/theme-contrast.test.ts の核心
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseTokens(css: string, selector: string): Record<string, string> {
  const block = new RegExp(`${selector.replace(/[[\]']/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  return Object.fromEntries([...(block?.[1] ?? '').matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)]
    .map((m) => [m[1]!, m[2]!]));
}
const relLum = (hex: string) => { const [r,g,b] = [1,3,5].map((i) => parseInt(hex.slice(i, i+2), 16) / 255)
  .map((c) => (c <= 0.03928 ? c/12.92 : ((c+0.055)/1.055) ** 2.4));
  return 0.2126*r! + 0.7152*g! + 0.0722*b!; };
function contrast(a: string, b: string): number {
  const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
const light = parseTokens(css, ':root');
const dark  = parseTokens(css, "[data-theme='dark']");

const TEXT_PAIRS: [string, string][] = [ ['--fg','--bg'], ['--fg','--card'], ['--muted-fg','--card'],
  ['--muted-fg','--bg'], ['--danger','--bg'], ['--success','--bg'], ['--warning','--bg'],
  ['--primary','--bg'], ['--primary-fg','--primary'] ];
const NON_TEXT_PAIRS: [string, string][] = [ ['--ring','--bg'], ['--border-strong','--card'] ];

for (const tokens of [light, dark]) {
  for (const [a, b] of TEXT_PAIRS) expect(contrast(tokens[a]!, tokens[b]!)).toBeGreaterThanOrEqual(4.5);
  for (const [a, b] of NON_TEXT_PAIRS) expect(contrast(tokens[a]!, tokens[b]!)).toBeGreaterThanOrEqual(3);
  // soft 系
  for (const [fg, bg] of [['--danger','--danger-soft'], ['--success','--success-soft'], ['--warning','--warning-soft']] as const)
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
}
```

### 15.4 DB の隔離

既存 `cleanupTestRows({ emails, usernames, clientIds })`（`helpers/http.ts:89-99`）は `users` を削除するだけで、**`sessions` / `*_tokens` / `user_preferences` は FK の `ON DELETE CASCADE` で同時に消える**。よって Phase 3 のテストで**ヘルパーの変更は不要**。`afterAll` で同じ email/username を渡す。

---

## 16. テスト計画（ファイル別）

| 種別 | ファイル | 主要ケース（期待値つき） |
|---|---|---|
| unit | `theme-resolver.test.ts`（新規） | `normalizeTheme('dark')='dark'`; `('neon')='system'`; `(null)='system'`; `resolveEffectiveTheme('system',true)='dark'`; `('system',false)='light'`; `('light',true)='light'`（**OS 無視**）; `('dark',false)='dark'`（**OS 無視**）; `THEME_STORAGE_KEY==='theme'`; `DEFAULT_THEME==='system'` |
| unit | `theme-contrast.test.ts`（新規） | §15.3 の 26 値（13 ペア×2）。本文系 ≥4.5、非テキスト ≥3.0。**現行の `--border` on `--card` が 3 未満であることをコメントで記録し、`--border-strong` 使用箇所 switched 済みであることを固定** |
| unit | `device.test.ts`（新規） | §10.1 の表 9 ケース＋120 文字切り詰め＋制御文字除去＋空入力 |
| unit | `datetime.test.ts`（新規） | `'2026-10-03T20:30:00Z'+UTC → '2026/10/03 20:30'`; `+Asia/Tokyo → '2026/10/04 05:30'`; 不正 TZ `'Mars/Phobos'` → **例外を出さず UTC にフォールバック**; `null` TZ → UTC |
| unit | `preferences-schema.test.ts`（新規） | `theme:'dark'` 通過; `'neon'` → zod error; `timezone:'Asia/Tokyo'` 通過; `''` → error; 既定 `ja`; 未知キー → error（strict） |
| integration | `user-preferences.test.ts`（新規） | 行無し → 既定（`system`/`ja`/`UTC`）; upsert で作成; 2 回目は **UPDATE**（行数不変）; `theme:'neon'` は **CHECK 制約で失敗**; `updated_at` が進む |
| integration | `sessions-management.test.ts`（新規） | `listActiveSessionsByUser` が **revoked/期限切れ/absolute 期限切れを除外**; `last_seen_at` 降順; `findOwnedSession` が他人 ID で `null`; 失効済みで `null`; `revokeAllSessions` が他ユーザーに影響しない; `revokeReason='logout_all'` で記録 |
| security | `session-idor.test.ts`（新規） | 他人の `ses_` で DELETE → **404 NOT_FOUND**、対象セッションが **revoke されていない**ことまで確認; 未ログイン → 401; CSRF 欠落 → 403; 期限切れ ID → 404 |
| security | `logout-all-reauth.test.ts`（新規） | 再認証なし → **401 REAUTH_REQUIRED** かつ `revokeAllSessions` 未実行; `reauth_verified_at` 5 分以内 → 200・全失効・`logout_all`・`session_revoked`; 5 分超 → 401; CSRF 違反 → 403; **完了後は旧 Cookie で API が 401** |
| security | `theme-preferences.test.ts`（新規） | 未ログイン PATCH → 401; **他人の preferences を変更できない**（自分の userId 固定）; `theme:'neon'` → 400; Origin 不正 → 403; CSRF 欠落 → 403; GET に `no-store` |
| security | `notification-leak.test.ts`（新規） | 通知本文に `password`/`token`/`session_hash`/`totp`/`code` が**含まれない**; **通知失敗で login が 200 のまま**で `security_notification_failed` 記録; 新規デバイス通知が初回だけ、2 回目（同一 ip_hash+device_name）は**送信されない**; **BUG-6**: メール送信失敗で register が**同一メッセージの 200**を返し `security_notification_failed` が記録される |
| security | `security-events-read.test.ts`（新規） | 他人イベントが返らない; 応答に**生 `ip` がない**; `metadata` は許可キーのみ; `limit=100` → **50 に丸める**; `limit=0`/不正 → 既定 10; **GET が行を追加しない**（件数不変） |
| security | **既存** `web.test.ts`（追記） | `/forgot-password`・`/reset-password`・`/verify-email`・`/email-change/confirm` が `no-store`; `/verify-email` の **GET が状態変更しない**（`email_verified` が false のまま） |
| e2e（実HTTP） | `login-register.test.ts`（新規） | `GET /login` 200＋`<label for=`＋`autocomplete="username"`/`current-password`; `GET /register` 200＋`minlength="8"` `maxlength="128"`; **登録 → メモリ内メールから token 抽出 → `POST /api/auth/verify-email` → `email_verified=true`**; `POST /password/forgot` で**既知/未知で同一メッセージ**; **BUG-1**: メモリ内メールの URL が `/reset-password?token=`（`/password/reset` でない）; 壊れた CSRF で 403; 429 で `Retry-After` |
| e2e（実HTTP） | `theme-settings.test.ts`（新規） | `GET /` の HTML に **FOUC script（inline、nonce 付き）**が含まれる; ログイン済みで `/settings/appearance` が server の theme を描画; `GET/PATCH /api/auth/preferences` の往復; **未ログインの `/settings/*` が 302 → `/login`**; `GET /settings/security` も 302 |
| e2e（実HTTP） | `sessions.test.ts`（新規） | 2 セッション（別 UA・別 CookieJar）でログイン → `GET /api/auth/sessions` が 2 件・`current` が先頭; 他人の ID で DELETE → 404; 自分の ID で DELETE → 200 後その Cookie で API が 401; `logout-all`（再認証 token 取得後）→ 200 後**両方**の旧 Cookie が 401; `session_revoked` が記録 |
| e2e（実HTTP） | **同意画面**（既存 `client-console.test.ts` の期待値を更新・BUG-5） | 同意 HTML に `prefers-color-scheme` の dark ブロックが含まれる; CSP に `style-src 'self' 'unsafe-inline'`; `script-src` は `'none'` のまま（**インライン script を入れない**） |

**総数目標**: 既存 43 ファイル 262 ケース（M2.6 時点）＋ **新規 13 ファイル・約 95 ケース** = 56 ファイル・約 357 ケース。

---

## 17. 影響を受ける既存テスト（回帰リスク）

| 既存ファイル | 影響 | 対応 |
|---|---|---|
| `src/test/e2e/client-console.test.ts` | 同意 HTML を検証（`client-console.test.ts:60` 付近）。BUG-5 で HTML に `<style>` が混入し、CSP が緩やかになる | **期待値を更新**。`script-src 'none'` を維持していることを確認するテストを追加 |
| `src/test/security/web.test.ts` | CSP/`no-store`/ヘッダの検証。同意画面の CSP 変更と middleware の `no-store` 追加に反応 | 期待値に 3 ルートの `no-store` と同意画面の CSP を追記 |
| `src/test/security/enumeration.test.ts` | `register` のメール呼び出しは `vi.mock` 済み（影響なし）。ただし **BUG-6 で try/catch を入れると mock が投げる場合は同じ文言の 200** になる | 既存 200  기대を維持。新規ケースで「送信失敗でも同一メッセージ」を固定 |
| `src/test/e2e/oidc-flow.test.ts` / `oidc-interop-go.test.ts` | `startServer` の export を使う形に変わる可能性（現状は `createOidcHandler` 直呼び） | 起動方法を変えないなら無影響。変える場合は 2 ファイルのみ再確認 |
| `src/test/security/session-attr.test.ts` / `idor.test.ts` | `device_name` の生成元が変わる（`'Unknown device'` 固定 → `deriveDeviceName`） | 既存アサーションが device_name を検証していれば期待値更新 |
| `src/test/unit/schema.test.ts` | `userPreferences` 追加で schema のスナップショット的検証があれば更新 | テーブル一覧の検証なら 1 行追加 |
| `src/test/unit/env.test.ts` | 新規 env 変数を追加しない（D-30-07 で `RATE_LIMITS` 既存キーを使う） | 無影響 |
| `src/lib/auth/session.ts` の変更 | `createSession` の `deviceName` が変わるため、**OIDC adapter が session を読む経路に影響の可能性**（`src/lib/oidc/*`） | `pnpm test:integration` と `test:e2e` を必ず通す |

---

## 18. 実装順序（Day 1〜5）

**並列 2 本線**: ①UI 基盤＋テーマ、②セッション API。合流して設定画面→認証画面→通知→テスト。

```text
Day 1（基盤＋欠陥是正の足場）
  AM: P3-A-01a 依存追加 → P3-A-01b components/ui → P3-A-01c api/client.ts
  PM: P3-A-01d★ email transport seam → P3-A-05a migration+schema+queries → P3-A-05b preferences API
      ‖ P3-C-01a queries → P3-C-05a device.ts → P3-C-05b session.ts 配線
  夕: コミット①（基盤）

Day 2（テーマ＋BUG3/4/5 は正）
  AM: P3-A-02a resolver → P3-A-02b provider → P3-A-02c script+layout → P3-A-02d toggle
  PM: P3-A-03 tokens（BUG3/4）→ P3-A-04 コントラストテスト → P3-A-05c appearance
      ‖ P3-A-15★ 同意画面の dark 対応（BUG5）
      ‖ P3-C-01b GET sessions → P3-C-02 DELETE → P3-C-03 logout-all
  夕: コミット②（テーマ＋セッション API）。pnpm test:unit green

Day 3（画面＋通知）
  AM: P3-C-04 settings/sessions → P3-C-06 datetime → P3-D-04 security/events
  PM: P3-D-01a〜c 新規デバイス通知 → P3-D-02a/b テンプレ拡張
  夕: P3-D-03 settings/security → P3-D-05 messages → コミット③

Day 4（認証画面＋BUG1/2/6 は正）
  AM: P3-B-01〜06 認証画面 → P3-B-07 password → P3-B-08 no-store
  PM: P3-B-09 meter → P3-B-10 login済 → P3-B-11★ email-change/confirm（BUG2）
      → P3-B-12★ forgot URL（BUG1）→ P3-B-13★ メール best-effort（BUG6）
  夕: コミット④（認証画面＋欠陥是正）

Day 5（テスト＋仕上げ）
  AM: P3-E-01〜04 テスト（既存 17 の回帰確認込み）
  PM: P3-F-01〜03 ドキュメント → P3-G-01〜03 最終確認
  夕: コミット⑤（DoD）
```

| ブロッカー | なし（registry は空エントリで足すだけ） |
|---|---|
| 直列の要 | resolver → provider → appearance → 認証画面の見た目。device.ts → 通知判定 → 表示 |
| コミット粒度 | 5 コミット（基盤 / テーマ＋API / 通知＋設定 / 認証画面＋欠陥是正 / テスト＋DoD） |

---

## 19. `実装Todo.md` §5 との ID 対応

| 実装Todo.md | 本書（§20） | 本書で増える細分 |
|---|---|---|
| P3-A-01 shadcn 導入 | P3-A-01a/b | +P3-A-01c（api/client・★） |
| P3-A-02 ThemeProvider | P3-A-02a/b/c/d | +P3-A-15（同意画面 dark・★） |
| P3-A-03 CSS 変数 | P3-A-03 | —（BUG3/4 の是正を含む） |
| P3-A-04 コントラスト/状態 | P3-A-04 | — |
| P3-A-05 appearance + PATCH | P3-A-05a/b/c | +P3-A-08（ヘッダー配置・★） |
| P3-A-06 テーマ同期 | P3-A-06 | — |
| P3-A-07 matchMedia | P3-A-07 | — |
| P3-A-08 レスポンシブ | P3-A-09 | —（番号ずれを本書で解消） |
| P3-A-09 アクセシビリティ | P3-A-10 | — |
| P3-B-01 /register | P3-B-01 | +P3-B-09（meter 共通・★） |
| P3-B-02 /login | P3-B-02a/b/c | +P3-B-10（ログイン済リダイレクト・★） |
| P3-B-03 /verify-email | P3-B-03 | — |
| P3-B-04 /forgot-password | P3-B-04 | +P3-B-12（URL 是正・★） |
| P3-B-05 /reset-password | P3-B-05 | — |
| P3-B-06 settings ガード | P3-B-06 | — |
| —（本書のみ） | P3-B-07 / P3-B-08 / P3-B-11 / P3-B-13 | ★password 画面・no-store・email-change/confirm・best-effort |
| P3-C-01 GET sessions | P3-C-01a/b | — |
| P3-C-02 DELETE | P3-C-02 | — |
| P3-C-03 logout-all | P3-C-03 | — |
| P3-C-04 settings/sessions | P3-C-04 | +P3-C-06（datetime・★） |
| P3-C-05 device.ts | P3-C-05a/b | — |
| P3-D-01 新規デバイス通知 | P3-D-01a/b/c | — |
| P3-D-02 変更系通知 | P3-D-02a/b | — |
| P3-D-03 settings/security | P3-D-03 | — |
| P3-D-04 security/events | P3-D-04 | — |
| P3-D-05 messages 一元化 | P3-D-05 | +P3-D-06（ログ漏えいテスト・★） |
| —（本書のみ） | P3-E-01〜04 / P3-F-01〜03 / P3-G-01〜03 | テスト・ドキュメント・最終確認 |

---

## 20. DoD

**仕様 §64「セッション」**
- [ ] 複数端末対応（2 セッションで一覧が 2 件になるテストがある）
- [ ] セッション一覧（`GET /api/auth/sessions`、`current` 先頭、`ip_masked` のみ）
- [ ] 個別ログアウト（`DELETE`、他人は 404）
- [ ] 全端末ログアウト（`POST /logout-all`、**再認証必須**）
- [ ] セッション失効（`revoked_at`/`revoke_reason` 記録）
- [ ] セッションローテーション（既存維持、regression green）

**仕様 §64「UI」**
- [ ] PC 対応（1440 で操作可）
- [ ] スマホ対応（375 で操作可。**実ブラウザ viewport は Phase 8-B**）
- [ ] Light / Dark / System の 3 択（`/settings/appearance`、既定 `system`）
- [ ] OS テーマ変更への**リアルタイム追従**（`matchMedia` change 購読・リロード不要）
- [ ] **同意画面（OIDC）も dark に追従**（BUG-5）

**画面・API**
- [ ] 11 画面が仕様どおり動作（`§25` GET で状態変更しない／`§46` 統一メッセージ／`§42` 色＋アイコン＋テキスト／`§43` 375〜1440）
- [ ] 新規 6 API が契約どおり（IDOR・CSRF・再認証込み）
- [ ] 新規デバイス通知と全ログアウト通知が送信され、秘密情報を含まない
- [ ] `messages/ja.ts` に UI 文言を集約し、コンポーネント内リテラル 0

**欠陥是正（§2.3 / 2026-10-17 完了）**
- [ ] **BUG-1**: forgot メールの URL が `/reset-password?token=`（`/password/reset` ではない）
- [ ] **BUG-2**: email 変更確認メールを開くと `/email-change/confirm` に 303 し、POST で確定できる
- [ ] **BUG-3**: dark でボタンのコントラスト ≥4.5:1（`text-white` 0 件）
- [ ] **BUG-4**: 入力欄・ボタンの境界 ≥3:1（`--border-strong`）
- [ ] **BUG-5**: 同意画面が dark に追従し、`script-src 'none'` を維持
- [ ] **BUG-6**: メール送信失敗で register/forgot が 500 にならず、**列挙安全な同一メッセージ**を返す
- [ ] **BUG-7**: e2e で Next の Route Handler を実 HTTP で叩ける（`startServer` 共有ヘルパー）

**品質**
- [ ] コントラスト 26 値が unit テストで固定（本文 ≥4.5、非テキスト ≥3.0）
- [ ] `pnpm lint` / `typecheck` / `test` / `test:e2e` / `build` が **全て green**
- [ ] 秘密値（PW / token / session_hash / TOTP / client secret）が UI・API 応答・DB・ログ・メール本文に残らない（レビュー P3-G-02）
- [ ] §17 の回帰リスク 7 項目をすべて確認
- [ ] `実装Todo.md` / `README.md` / `実装計画.md` の DoD 表記が D-30-01（`.spec.ts`→`.test.ts`）に揃っている

---

## 21. Todo

凡例: ★=仕様書に無い必須追加、‖=他タスクと並列可、⏱=見積工数。

### 21-A 基盤（依存・ツール）— 2.5h

| 状態 | ID（実装Todo.md） | 内容 | 依存 | ⏱ | 完了条件（検証コマンド） |
|---|---|---|---|---|---|
| [ ] | **P3-A-01a**（=P3-A-01） | 依存 7 パッケージ追加。`components.json` 作成。**CLI は実行しない** | ― | 0.5h | `pnpm typecheck` green、`git diff --stat src/app/globals.css` が空 |
| [ ] | **P3-A-01b**（=P3-A-01） | `src/lib/cn.ts` ＋ `components/ui/{button,input,label,card,alert,dialog,tabs,toast}.tsx`（§8.2） | A-01a | 1.0h | `pnpm lint` green。`grep -rn "text-white" src` が 0 件 |
| [ ] | **P3-A-01c**★ | `src/lib/api/client.ts`（§9.1、`resetCsrfCache` 含む） | A-01a | 0.5h | `pnpm typecheck` green |
| [ ] | **P3-A-01d**★ | メール transport seam（`send.ts` に `setEmailTransport` ＋ `src/test/helpers/email.ts`）（D-30-25） | ― | 0.5h | `pnpm vitest run src/test/security/notification-leak` で outbox に ↓ |

### 21-B テーマ（3-A）— 5.0h

| 状態 | ID | 内容 | 依存 | ⏱ | 完了条件（検証コマンド） |
|---|---|---|---|---|---|
| [ ] | **P3-A-02a**（=P3-A-02） | `src/lib/theme/resolver.ts`（§7.1） | ― | 0.3h | `pnpm vitest run src/test/unit/theme-resolver` → 10 passing |
| [ ] | **P3-A-02b**（=P3-A-02） | `theme-provider.tsx`（§7.2・cleanup 必須） | A-02a | 0.7h | 手動検証 5 点の 2/3/4 が通る |
| [ ] | **P3-A-02c**（=P3-A-02） | `theme-script.ts` ＋ `layout.tsx` 差し替え（D-30-04） | A-02a, A-05a | 0.4h | JS 無効で dark 設定なら dark 描画 |
| [ ] | **P3-A-02d**（=P3-A-02） | `theme-toggle.tsx`（3 択 segmented、現在値・色＋アイコン＋テキスト） | A-02b | 0.4h | 3 択が切替できる |
| [ ] | **P3-A-03**（=P3-A-03） | `globals.css` に `--primary-fg`/`--border-strong`/`--*-soft`/`--hover`/`--disabled-fg` 追加・`@theme inline` マッピング（**BUG3/4**・§6.5） | ― | 0.5h | `pnpm vitest run src/test/unit/theme-contrast` → 26 値 green |
| [ ] | **P3-A-04**（=P3-A-04） | 状態表現（色＋アイコン＋テキスト）を alert/meter/バッジ/セッションに適用 | A-03 | 0.4h | レビュー＋4 variant の目視 |
| [ ] | **P3-A-05a**（=P3-A-05） | `user_preferences` migration `0014_09_user_preferences.sql` ＋ `schema.ts` ＋ `queries/user-preferences.ts` | ― | 0.5h | `pnpm db:migrate && pnpm db:verify-migrations` green、CHECK 違反が失敗 |
| [ ] | **P3-A-05b**（=P3-A-05） | `GET/PATCH /api/auth/preferences`（§6.3(1)(2)） | A-05a, A-01c | 0.4h | `pnpm vitest run src/test/security/theme-preferences` green |
| [ ] | **P3-A-05c**（=P3-A-05） | `/settings/appearance`（3 択・即時反映・ロールバック）（§12.2） | A-05b, A-02b | 0.5h | 切替が 1 リクエストで保存される |
| [ ] | **P3-A-06**（=P3-A-06） | テーマ同期の検証（server > localStorage > system、両方保存、ログイン往復） | A-02c, A-05c | 0.3h | §7.5 の 1/4/5 が通る |
| [ ] | **P3-A-07**（=P3-A-07） | `matchMedia` change 購読（`system` のみ・cleanup・`light/dark` は OS 無視） | A-02b | 0.3h | §7.5 の 2/3 が通る |
| [ ] | **P3-A-08**★（=P3-A-05） | ヘッダー/ログイン画面に `ThemeToggle` 配置（未ログインでも可） | A-02d | 0.2h | ログイン画面から切替できる |
| [ ] | **P3-A-09**（=P3-A-08） | レスポンシブ確認（375/768/1024/1440、固定幅 px の静的チェック） | A-05c, C-04 | 0.3h | `grep -rn "\[[0-9]\+px\]" src/app src/components` の新規該当 0 |
| [ ] | **P3-A-10**（=P3-A-09） | アクセシビリティ（label/autocomplete/aria-live/フォーカス、WCAG AA 目標） | A-01b | 0.3h | §13.1 のチェックリストを満たす |
| [ ] | **P3-A-15**★ | OIDC 同意画面の dark 対応＋CSP に `style-src 'self' 'unsafe-inline'`（**BUG5**・D-30-26） | ― | 0.5h | `pnpm test:e2e` の同意テスト green、`script-src 'none'` 維持 |

### 21-C 認証画面（3-B）— 6.5h

| 状態 | ID | 内容 | 依存 | ⏱ | 完了条件（検証コマンド） |
|---|---|---|---|---|---|
| [ ] | **P3-B-01**（=P3-B-01） | `/register` 改修（PW meter、8〜128 表記、breached 表示、components/ui 化、文言一元化） | A-01b/c, B-09 | 1.0h | `pnpm vitest run src/test/e2e/login-register` の SSR アサーション green |
| [ ] | **P3-B-02a**★（=P3-B-02） | `lib/auth/oauth/registry.ts`（provider 型＋**空エントリ**、D-30-21） | ― | 0.3h | registry から UI が生成され、0 件なら非表示 |
| [ ] | **P3-B-02b**★（=P3-B-02） | `TotpChallengeForm`（`inputMode=numeric`/`one-time-code`/6 桁、Phase 5 接続用） | A-01b | 0.3h | 6 桁入力と Enter 送信が動く |
| [ ] | **P3-B-02c**（=P3-B-02） | `/login` 改修（1 入力欄、文言一元化、統一メッセージ、`returnTo` 制約、多重送信防止、`ThemeToggle`） | B-02a, A-01c | 0.8h | §9.3 の wireframe 一致 |
| [ ] | **P3-B-03**（=P3-B-03） | `/verify-email` 改修（auto POST 1 回だけ、再送信 UI、`no-store`） | A-01c, B-08 | 0.5h | `web.test.ts` の「GET が状態変更しない」green |
| [ ] | **P3-B-04**（=P3-B-04） | `/forgot-password` 新規（同一メッセージ、応答時間揃え、429 案内、`no-store`） | A-01c, B-08 | 0.5h | e2e で既知/未知が同一 |
| [ ] | **P3-B-05**（=P3-B-05） | `/reset-password` 新規（token 非表示、PW meter、成功導線、`no-store`） | A-01c, B-09, B-08 | 0.5h | §9.5 一致 |
| [ ] | **P3-B-06**（=P3-B-06） | 未ログイン `settings/*` のサーバ側ガード**適用確認**（新規ページでガード漏れをレビュー） | 21-D | 0.2h | 4 新規設定ページがすべて `/login` へ |
| [ ] | **P3-B-07**★ | `/settings/password` 新規（最小フォーム・再認証ダイアログ・他セッション revoke 案内）（D-30-20） | A-01b/c, B-02c | 0.8h | PW 変更が通り、`REAUTH_REQUIRED` 時に再認証が起動 |
| [ ] | **P3-B-08**★（=P3-B-08） | `middleware.ts` に `/verify-email` `/forgot-password` `/reset-password` `/email-change/confirm` の `no-store` | ― | 0.1h | 4 ルートの応答に `no-store` |
| [ ] | **P3-B-09**★（=P3-B-01） | PW meter 共通コンポーネント（`messages.ui.pwStrength`、5 段階、`progressbar` ロール） | A-03, D-05 | 0.6h | 5 段階・色＋アイコン＋テキストを目視 |
| [ ] | **P3-B-10**★（=P3-B-02） | ログイン済みで `/login` `/register` へ来た場合の server リダイレクト（`returnTo` 優先） | ― | 0.2h | 同意フロー（`/oauth2/interaction/`）を壊さない |
| [ ] | **P3-B-11**★ | `/email-change/confirm` 画面＋`GET` 303 リダイレクト（**BUG2**・D-30-24） | A-01b/c | 0.6h | メール内 URL を開くと画面が出て POST で確定できる |
| [ ] | **P3-B-12**★ | `password/forgot/route.ts:73` の URL を `/reset-password?token=` に修正（**BUG1**） | B-05 | 0.1h | e2e でメモリ内メールの URL が `/reset-password` |
| [ ] | **P3-B-13**★ | メール送信を best-effort 化（`register`/`resend`/`forgot`/`email-change`）＋ `security_notification_failed` 記録（**BUG6**・D-30-27） | A-01d | 0.7h | `notification-leak.test.ts` で「送信失敗でも 200＋同一メッセージ」 |

### 21-D セッション / デバイス（3-C）— 6.0h

| 状態 | ID | 内容 | 依存 | ⏱ | 完了条件（検証コマンド） |
|---|---|---|---|---|---|
| [ ] | **P3-C-01a**★（=P3-C-01） | `queries/sessions.ts` に `listActiveSessionsByUser`/`findOwnedSession`（§6.4） | ― | 0.3h | `pnpm vitest run src/test/integration/sessions-management` green |
| [ ] | **P3-C-01b**（=P3-C-01） | `GET /api/auth/sessions`（現在を先頭、D-30-08 の 7 項目、`no-store`）（§6.3(3)） | C-01a | 0.4h | `sessions.test.ts` の 1 ケース green |
| [ ] | **P3-C-02**（=P3-C-02） | `DELETE /api/auth/sessions/[id]`（所有者確認・404・`session_revoked`・現行は Cookie 削除）（D-30-09） | C-01a | 0.5h | `session-idor.test.ts` green |
| [ ] | **P3-C-03**（=P3-C-03） | `POST /api/auth/logout-all`（**再認証必須**、全 revoke、`logout_all`、イベント、通知、失敗非致命）（D-30-10） | C-01a, D-02b | 0.5h | `logout-all-reauth.test.ts` green |
| [ ] | **P3-C-04**（=P3-C-04） | `/settings/sessions`（§38 カード、`current` バッジ、個別/全ログアウト、空状態、`<time>`） | C-01b/c/d, A-01b | 1.0h | §10.3 の wireframe 一致 |
| [ ] | **P3-C-05a**（=P3-C-05） | `src/lib/util/device.ts`（`ua-parser-js`、§10.1） | A-01a | 0.4h | `pnpm vitest run src/test/unit/device` → 9 passing |
| [ ] | **P3-C-05b**（=P3-C-05） | `session.ts` の `deviceName` を `deriveDeviceName` に置換（create/getSession 2 箇所） | C-05a | 0.2h | 新規セッションの device_name が UA から生成 |
| [ ] | **P3-C-06**★（=P3-C-04） | `src/lib/util/datetime.ts`（`formatLocalDateTime`、不正 TZ フォールバック）（D-30-17） | ― | 0.3h | `pnpm vitest run src/test/unit/datetime` → 4 passing |

### 21-E 通知メールとセキュリティ設定（3-D）— 5.0h

| 状態 | ID | 内容 | 依存 | ⏱ | 完了条件（検証コマンド） |
|---|---|---|---|---|---|
| [ ] | **P3-D-01a**★（=P3-D-01） | `SECURITY_EVENT_TYPES` に `new_device_login`/`security_notification_failed` 追加（migration 不要） | ― | 0.1h | `pnpm typecheck` green |
| [ ] | **P3-D-01b**★（=P3-D-01） | `src/lib/auth/notifications.ts`（判定＋送信＋失敗握る）（§11.2） | C-05b, D-01a, A-01d | 0.7h | `notification-leak.test.ts` green |
| [ ] | **P3-D-01c**★（=P3-D-01） | `POST /api/auth/login` に通知を接続（insert 後・`login_success` 前、失敗非致命的）（D-30-13） | D-01b | 0.3h | 初回だけ通知、2 回目は出ない |
| [ ] | **P3-D-02a**（=P3-D-02） | `messages.emails.securityNotification` 拡張（`region` 任意・`ignoreAdvice`） | D-05 | 0.3h | 地域 null で行が出ない |
| [ ] | **P3-D-02b**（=P3-D-02） | `messages.emails.changeNotification` 拡張（全ログアウト表示・PW 誘導） | D-05 | 0.2h | logout-all で通知が出る |
| [ ] | **P3-D-03**（=P3-D-03） | `/settings/security`（§37 の 8 カード、認証済みバッジ、未実装如实表示、イベント一覧）（§12.1） | C-01b, C-03, D-04, D-05 | 1.3h | §12.1 の wireframe 一致 |
| [ ] | **P3-D-04**（=P3-D-04） | `GET /api/auth/security/events` ＋ `listRecentSecurityEventsByUser`（本人限定・許可列のみ・limit 既定10/上限50）（D-30-15） | ― | 0.5h | `security-events-read.test.ts` green |
| [ ] | **P3-D-05**（=P3-D-05） | `messages/ja.ts` へ UI 文言一式追加（§14）、イベント表示名マッピング | ― | 1.0h | `grep -rnP "[\x{3040}-\x{30ff}\x{4e00}-\x{9fff}]" src/app src/components` で新規リテラル 0 |
| [ ] | **P3-D-06**★（=P3-D-05） | 通知本文/URL をログに出さないことの確認とテスト（`log-redaction.test.ts` 追記） | D-01b | 0.3h | `token=` redact テスト green |

### 21-F テスト — 6.0h

| 状態 | ID | 内容 | 依存 | ⏱ | 完了条件（検証コマンド） |
|---|---|---|---|---|---|
| [ ] | **P3-E-01** | unit: `theme-resolver`/`theme-contrast`/`device`/`datetime`/`preferences-schema`（約 35 ケース） | 21-B, C-05a, C-06 | 1.3h | `pnpm test:unit` green |
| [ ] | **P3-E-02** | integration: `user-preferences`/`sessions-management`（約 16 ケース） | A-05a, C-01a | 0.8h | `pnpm test:integration` green |
| [ ] | **P3-E-03** | security: `session-idor`/`logout-all-reauth`/`theme-preferences`/`notification-leak`/`security-events-read` ＋ `web.test.ts` 追記（約 26 ケース） | 21-C, 21-D, 21-E | 2.0h | `pnpm test:security` green |
| [ ] | **P3-E-04** | e2e（実HTTP・`startServer` 共有）: `login-register`/`theme-settings`/`sessions`（約 18 ケース、`.test.ts` 名・D-30-01/28）＋ 同意テストの期待値更新 | 21-C, 21-D, A-15 | 1.9h | `pnpm test:e2e` green |

### 21-G ドキュメント / 最終確認 — 2.5h

| 状態 | ID | 内容 | 依存 | ⏱ | 完了条件（検証コマンド） |
|---|---|---|---|---|---|
| [ ] | **P3-F-01** | `実装Todo.md` §5 の DoD 表記を `.test.ts` に読み替え、M3 に行と本計画リンクを追加、§19 の ID 差分を反映 | ― | 0.4h | 3 文書の DoD 表記が一致 |
| [ ] | **P3-F-02** | `実装計画.md` 15章 Phase 3 と §19 マイルストーン M3 を本計画に同期 | ― | 0.3h | `実装計画.md` が矛盾しない |
| [ ] | **P3-F-03** | `README.md`（実装状況 M3、Phase 3 実装詳細、手動チェックリスト、§2.3 の欠陥是正記録） | ― | 0.5h | README が更新される |
| [ ] | **P3-G-01** | `pnpm lint`/`typecheck`/`test`/`test:e2e`/`build` green | 全部 | 0.6h | 5 コマンド green |
| [ ] | **P3-G-02** | 秘密値（PW/token/session_hash/TOTP/client secret）が UI・API 応答・DB・ログ・メール本文に残らないことのレビュー | 全部 | 0.4h | レビュー記録 |
| [ ] | **P3-G-03** | §17 の回帰リスク 7 項目 ＋ 手動チェックリスト（375/768/1024/1440、キーボード-only、light/dark、OS 追従、`aria-live`、同意画面 dark） | 全部 | 0.3h | チェックリスト完了 |

**合計: 約 35.5h（4〜5 日）**（21-A 2.5 + 21-B 5.0 + 21-C 6.5 + 21-D 6.0 + 21-E 5.0 + 21-F 6.0 + 21-G 2.5）

> 見積 3〜4 日（計画 15章）に対して **+1〜1.5 日**。増分の内訳は §2.3 の欠陥是正（BUG1/2/6・約 2.0h）とテスト基盤の実 HTTP 化（D-30-28・約 1.0h）、_TASK 表の粒度细化（約 1.5h）。**Phase 4 の着手前にこの 1〜1.5 日を unattractive には削れない**ため、Phase 3 は 5 日確保して着手する。

---

## 22. リスク / ロールバック / 将来への引継ぎ

### 22.1 リスク

| リスク | 影響 | 緩和 |
|---|---|---|
| Playwright 未導入 → 実ブラウザ viewport / スクリーンリーダー実機検証不可 | §64「スマホ対応」の証跡が弱まる | 静的チェック＋手動チェックリスト（§21-G-03）。**Phase 8-B に明示的に引継ぐ** |
| e2e で `startServer(dev)` は起動が重い | `test:e2e` が遅くなる | 1 ファイル内 1 回起動。API 中心は直接呼び出し（security/integration）に寄せる |
| メール送信 best-effort 化で**列挙攻撃の回帰** | アカウント存在の漏えい | **成功時と同一メッセージを厳守**（D-30-27）。`enumeration.test.ts` の既存アサーションを必ず通す |
| 同意画面の CSP を緩くする（`style-src` に `unsafe-inline`） | XSS 耐性の低下 | **`script-src 'none'` は維持**。style だけ許可。`default-src 'none'` も維持 |
| `ip_country` 未充填 → 通知に地域が出ない | §18 の 2 番要件が未充足に見える | 値があるときだけ表示（D-30-14）。geo-IP は Phase 8/9 |
| 既存セッションの `device_name` が `Unknown device` | 表示ゆれ | UI で `その他のデバイス` に正規表示（D-30-12）。backfill しない |
| 手書き `components/ui` が将来 shadcn CLI と二重化 | 保守負担 | token は `globals.css` 一本化（D-30-02）。shadcn 化しても token 名を変えない |
| `messages/ja.ts` の肥大化 | 文言散在の再発 | `ui.*` に機能ごとに集約。コンポーネントリテラル 0 をレビュー（P3-G-02） |
| 工数が 5 日へ膨らむ | Phase 4 の遅延 | §21-G-03 を削るのではなく、`/settings/password`（P3-B-07）と同意画面（BUG-5）が**省略可能性の高いタスク**。順序は「BUG1/2/6 → セッション API → テーマ → 設定画面 → 認証画面」で**価値の高い順に削れる** |

### 22.2 ロールバック計画

| 対象 | 手順 |
|---|---|
| migration `0014` | `DROP TABLE user_preferences;`（他テーブルから参照されないので可逆） |
| テーマ | 変更は `data-theme` と CSS 変数のみ。`globals.css` と `layout.tsx` の script を revert すれば元に戻る |
| 通知 | 通知は try/catch で非致命。`SECURITY_EVENT_TYPES` の 2 追加を revert するだけ |
| メール URL 是正（BUG1/2） | 変更は route 内の URL 文字列 1 行＋ GET handler 追加。revert で元に戻る（壊れたリンクに戻るが正しい） |
| 一覧画面 | 新規ルートは削除するだけ。既存画面の改修は git revert |

### 22.3 将来フェーズへの引継ぎメモ

- **Phase 4**: `oauth/registry.ts` にエントリを足すだけで `/login` の社会ログインボタンが増える。連携追加/削除の通知は `emails.changeNotification` を再利用
- **Phase 5**: `TotpChallengeForm` に `POST /api/auth/2fa/challenge` を接続。`/settings/security` の 2FA カードが有効表示に
- **Phase 6**: passkey ボタン（registry に passkey エントリ）と `webauthn_credentials` カード
- **Phase 7**: `admin_audit_logs` は一般ユーザーから参照不可のまま。Phase 3 で `security_events` を本人限定にしたことで責務が分離
- **Phase 8/9**: Playwright（viewport/実機）、geo-IP（`ip_country` 充填）、§18-2 の新 IP/地域検知、同意画面の Next 化

---

## 23. 仕様トレーサビリティ

| 仕様 | 章 | 担当タスク |
|---|---|---|
| Light / Dark / System | §39 | P3-A-03/05/06/07/10、**P3-A-15（同意画面）** |
| OS テーマ変更のリアルタイム追従 | §41 | P3-A-07 |
| テーマ保存（localStorage / user_preferences） | §40 | P3-A-05a/b/c/06 |
| ダークモード可読性・色のみ禁止 | §42 | **P3-A-03（BUG3）**、P3-A-04/10 |
| レスポンシブ（375/768/1024/1440） | §43 | P3-A-09、P3-G-03 |
| 認証メール（統一・心当たりない案内） | §44 | P3-B-01/04/05、P3-D-02a/02b |
| メール確認フロー（30分・1回限り） | §4 | P3-B-03、**P3-B-13** |
| メール変更フロー | §14 | **P3-B-11（BUG2）** |
| パスワードリセット | §15 | **P3-B-12（BUG1）**、P3-B-05 |
| 情報漏洩防止（ログ） | §45 | P3-D-06、P3-G-02 |
| エラーメッセージ統一（列挙対策） | §46 | P3-B-02c/04/05、**P3-B-13** |
| 認可はサーバ側（IDOR/BOLA） | §49 | P3-B-06、P3-C-02、P3-D-04 |
| API 応答形式 | §58 | 新規 6 API すべて |
| タイムゾーン | §60 | P3-C-06、P3-D-03 |
| ログイン中のデバイス・個別/全ログアウト | §19 | P3-C-01b/02/03/04 |
| IP マスク | §20 | P3-C-01b、P3-D-01b |
| セキュリティログ（本人イベントのみ） | §21 | P3-D-04 |
| GET で状態変更しない | §25 | P3-B-03/04/05/11、P3-C-02、P3-D-04 |
| セキュリティ設定レイアウト | §37 | P3-D-03 |
| デバイス管理画面（カード・現在明示） | §38 | P3-C-04 |
| 通知メール 10 種 | §18 | P3-D-01b/01c/02a/02b（passkey/連携は Phase 6/4 で同テンプレ） |
| セッション 6 項目 | §64 | P3-C-01b/02/03 |
| PC / スマホ対応 | §64 | P3-A-09、P3-G-03 |

---

## 24. 手動テストスクリプト（P3-G-03）

| # | 手順 | 期待 |
|---|---|---|
| 1 | dev 起動 → JS 無効化 → dark 設定の user で `/settings/appearance` | dark で描画（FOUC なし）。light なら light |
| 2 | `system` にして OS のテーマを light→dark | リロードなしで追従 |
| 3 | `light` にして OS を dark に | **変わらない** |
| 4 | `dark` → ログアウト → `/login` で切替 → ログイン | dark で復元（server 値優先） |
| 5 | devtools で `localStorage.theme='neon'` にしてリロード | `system` として無害に動作 |
| 6 | 2 ブラウザ（別 UA）でログイン → `/settings/sessions` | 2 枚のカード、`current` バッジが片方だけ |
| 7 | 片方を「ログアウト」 | その Cookie で API が 401 |
| 8 | 全ログアウト（再認証なし） | `REAUTH_REQUIRED` → 再認証ダイアログ → 成功 → 両方ログアウト |
| 9 | 新規 UA の初回ログイン | 新規デバイス通知（デバイス名・masked IP・日時、地域行なし） |
| 10 | 同じ UA・同じ IP で再ログイン | **通知が出ない** |
| 11 | `/settings/security` | §37 の 8 カード、認証済みバッジ、イベント 10 件 |
| 12 | `/forgot-password` に登録済み/未登録メール | **同一メッセージ**。リンクの path が `/reset-password` |
| 13 | `/reset-password` に壊れた token | 既定文言のみ（原因を出さない） |
| 14 | `/email-change/confirm` にトークン付き URL を開く | 画面が出て POST で確定できる |
| 15 | OIDC 同意画面を dark OS で開く | 背景が暗色。`script-src 'none'` が維持されている |
| 16 | `RESEND_API_KEY` を外した状態で `/register` | **500 にならず**、成功時と同一メッセージ |
| 17 | 375px で `/settings/sessions` | 横スクロール無し、ボタン操作可 |
| 18 | キーボードのみで `/login` → 送信 → エラー表示 | フォーカスリング見える、`aria-live` で読み上げ |

---

## 25. 付録

### 25.1 コマンド

```bash
pnpm dev / build / lint / typecheck / test / test:e2e
pnpm db:generate / db:migrate / db:verify-migrations
pnpm test:unit / test:security / test:integration
# コントラスト検証のみ
pnpm vitest run src/test/unit/theme-contrast.test.ts
# 単発
pnpm vitest run src/test/security/session-idor.test.ts
```

### 25.2 既存ファイル索引（本フェーズで触るもの）

| 目的 | パス:行 |
|---|---|
| テーマ script（現行） | `src/app/layout.tsx:14-24`（CSP nonce は `:26`） |
| CSS 変数（現行 11 個） | `src/app/globals.css:3-27` |
| `no-store` 付与（現行） | `src/middleware.ts:132-136` |
| サーバ側ガード | `src/app/settings/layout.tsx:11-18`（幅制限は `:22`） |
| deviceName 固定 | `src/lib/auth/session.ts:67,138` |
| CSRF トークン取得 | `src/app/api/auth/csrf/route.ts` |
| パイプライン | `src/lib/auth/pipeline.ts`, `src/lib/api/utils.ts` |
| 404 の書式（M2.6 事例） | `src/app/api/auth/oidc/clients/[clientId]/route.ts:26` |
| register のメール（非保護） | `src/app/api/auth/register/route.ts:89` |
| forgot の壊れた URL | `src/app/api/auth/password/forgot/route.ts:73` |
| email 変更の壊れた URL | `src/app/api/auth/email/change/route.ts:37` |
| email 変更 confirm（GET 無し） | `src/app/api/auth/email/change/confirm/route.ts:19` |
| login のセッション発行 | `src/app/api/auth/login/route.ts:98-105` |
| 通知テンプレ | `src/lib/auth/email/templates.ts:35-57` |
| メール送信 | `src/lib/auth/email/send.ts:9-34` |
| 文言 | `src/messages/ja.ts` |
| セキュリティイベント型 | `src/lib/db/schema.ts:186-224` |
| セッション列定義 | `src/lib/db/schema.ts:91-133` |
| 同意画面の HTML/CSP | `scripts/server.ts:23-33, 209` |
| サーバ起動（export 済み） | `scripts/server.ts:365-394` |
| テストの DB 隔離 | `src/test/helpers/http.ts:89-99` |
| テスト env | `src/test/setup.ts` |

---

## 26. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-17 | 初版（計画のみ・実装未着手）。M2.6 完了時点のコード精査で不足を特定。既存資産（テーマ script・`globals.css`・`requireSettingsUser`・`withAuthPipeline`・6種メールテンプレ）の再利用方針を確定 |
| v1.1 | 2026-10-17 | **実測でトークンの不備 2 件**（`--border` on `--card` が非テキスト 3:1 失敗、dark で `#ffffff` on `--primary` が 2.54:1 で AA 失敗）→ `--primary-fg` / `--border-strong` を新設（D-30-23）。API 契約（リクエスト/レスポンス/ステータスタブ）、コード骨格、画面 wireframe、メッセージキー表、テストケース期待値、実装順序、ロールバック、手動テストスクリプトを追加 |
| v1.2 | 2026-10-17 | **コード精査で既存バグ 5 件を追加発見**: BUG-1 リセットメールのリンク 404、BUG-2 email 変更確認の 405、BUG-3/4 コントラスト（v1.1）、BUG-5 同意画面のテーマ非対応。加えて **BUG-6**（メール送信が非保護で 500）と **BUG-7**（Next Route Handler の実 HTTP テスト基盤が未使用）を明示。D-30-24〜D-30-28 を追加、却下代替案 10 件、影響を受ける既存テスト 7 件、実装Todo ID 対応表、工数を 31h→35.5h に修正、テスト実装詳細（`startServer` 共有ヘルパー・email transport seam・コントラスト計算コード）を追加 |
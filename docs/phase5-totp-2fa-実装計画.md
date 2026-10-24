# Phase 5 実装計画 — TOTP 2FA + Recovery Codes

> 対象: M5（`実装計画.md` v1.6 §15「Phase 5 — TOTP 2FA + Recovery Codes（2〜3日）」）
> 前提工程: Phase 4-B（M4 実装完了 2026-10-18）
> 正典の優先順位: 仕様書 `超本格アカウント・認証システム仕様書 v1.3.md` → 計画 `実装計画.md` → 進捗 `実装Todo.md` → **本書（実装レベルの詳細）**
> 初版: 2026-10-24（**計画のみ・実装は未着手**）
> 状態: **設計レビュー待ち**

---

## 0. 要旨（TL;DR）

| 項目 | 内容 |
|---|---|
| 何をやる | 仕様 §13（TOTP 二段階認証 / バックアップコード）と §33（2FA API）、§64「高度な認証」の TOTP / Recovery Codes を実装する |
| なぜやる | §64「高度な認証」の 3 項目のうち Passkey（Phase 6）と並ぶ 2 項目が未充足。**DoD 未達なら Phase 6 へ進めない**（計画 3 章） |
| 工数 | **約 27.8 時間（約 4 日）**。内訳は §13 |
| 追加依存 | **`otpauth@^9.5.2`** と **`qrcode@^1.5.4`**（dependencies。`@types/qrcode` は devDependencies・D-33-02） |
| migration | **1 本のみ** = `0017_totp.sql`（`totp` / `recovery_codes` の 2 テーブルを新規作成。既存テーブルは変更しない） |
| 新規ファイル | **21 ファイル**（migration 1 / ライブラリ 5 / クエリ 2 / 検証 2 / API 6 / 画面 5）→ §7.1 |
| テスト | 新規 **14 ファイル** ＋ 既存 7 ファイルへの追記・**1 ファイルの期待値反転** → §11 |
| 既存仕様の変更 | **未確認 email のログインを 403 で止める**（D-33-21）。`deleted-account-login.test.ts` の期待値を反転 → §5.2 |
| 最大リスク | **同一 TOTP コードの並行送信（race condition）**。atomic 更新を外すと 2 件とも成功しうる（D-16 / §48「回避試行」） |
| セキュリティの核 | (1) secret は **AES-256-GCM で暗号化**して保存（鍵は DB に無い・§13.1）、(2) `last_used_counter` は **atomic 更新**（D-16）、(3) 2FA 入力は **10/5分**でレート制限（§16）、(4) 無効化・再生成は **パスワード＋コードの強い再認証**（D-33-23） |
| 追加要件（v1.1） | **未確認 email のログインを 403 で止め、その場で確認メールを再送できるようにする**（D-33-21 / D-33-22）。**`resend-verification` を未認証でも呼べるようにする**必要がある（`register` はセッションを発行しないため） |

---

## 1. 正典と参照関係

| 文書 | 章 | 本書での扱い |
|---|---|---|
| 仕様書 v1.3 | §13.1 TOTP 秘密鍵 | 暗号化保存。鍵は Secret Manager / 環境変数（`TOTP_ENCRYPTION_KEY`） |
| 仕様書 v1.3 | §13.2 バックアップコード | 10 個・各 1 回のみ・ハッシュ保存・使用即無効化 |
| 仕様書 v1.3 | §33 2FA API | `setup` / `verify` / `disable` / `recovery-codes/regenerate` |
| 仕様書 v1.3 | §8 重要操作の再認証 | 2FA 設定変更・無効化は再認証必須 |
| 仕様書 v1.3 | §18 ログイン通知 | 2FA 変更の通知メール |
| 仕様書 v1.3 | §21 セキュリティログ | `2fa_enabled` / `2fa_disabled` |
| 仕様書 v1.3 | §45 情報漏洩防止 | TOTP secret / recovery code をログ・API 応答に出さない |
| 仕様書 v1.3 | §56 レートリミット | `2fa` を独立制御 |
| 仕様書 v1.3 | §64 完成条件 | 「高度な認証」TOTP / Recovery Codes |
| 仕様書 v1.3 | **§4.1 登録直後** | `email_verified = false`。**未確認のまま使わせない**（D-33-21） |
| 仕様書 v1.3 | **§4.3 メール再送信** | 未認証ユーザーは再送できる。**同一アカウント 5 回/1 時間**（D-33-22） |
| 仕様書 v1.3 | **§46 列挙攻撃の防止** | 再送 API の応答を**完全に同一**にする |
| 実装計画 v1.6 | §11.4 2FA エンドポイント（23〜28） | API 契約の正 |
| 実装計画 v1.6 | §8.6 レート制限 | `rl:2fa:user:{user_id}` = 10/5分（soft 3） |
| 実装計画 v1.6 | D-09 | 2 段有効化（setup → verify） |
| 実装計画 v1.6 | D-16 | `last_used_counter` の atomic 更新 |
| `docs/phase3-...実装計画.md` | §22.3 | `TotpChallengeForm` の器は作成済み。Phase 5 で API 接続する |

---

## 2. 背景と目的

### 2.1 現状（コードで確認済み・2026-10-24 実地調査）

| 領域 | 現状 | 根拠 |
|---|---|---|
| セッションの 2FA 保留列 | **既にある**。`sessions.totp_pending`（boolean, default false）が Phase 1-C で作成済み | `drizzle/0002_04_sessions.sql`, `src/lib/db/schema.ts:113` |
| `SessionData` 型 | `totpPending` を**持たない**（`createSessionInternal` が DB に false を入れるだけ） | `src/lib/auth/session.ts:11-24, 90` |
| 2FA 入力 UI | **器だけある**。`TotpChallengeForm`（6 桁・`inputMode=numeric`・`autoComplete=one-time-code`）が `verifyEndpoint` 未指定なら送信しない | `src/components/auth/totp-challenge-form.tsx` |
| レート制限キー | **既にある**。`rateLimitKeys.twoFactorUser(userId)` = `rl:2fa:user:{id}` | `src/lib/auth/rate-limit-keys.ts:47` |
| レート制限値 | **既にある**。`RATE_LIMITS.twoFactor = { window: 300_000, limit: 10, softLimit: 3 }` | `src/config/rate-limits.ts:21` |
| 暗号化鍵 | **既にある**。`TOTP_ENCRYPTION_KEY`（Base64 32 バイト）を `env.ts` が fail fast 検証。`generateTotpEncryptionKey()` も実装済み | `src/lib/env.ts`, `src/lib/util/crypto.ts:38-40` |
| 暗号化関数 | `util/crypto.ts` に **AES-256-GCM は無い**（HMAC / SHA / random のみ）。`oidc/crypto.ts` に AES-GCM があるが `OIDC_ADAPTER_ENCRYPTION_KEY` を使う別系統 | `src/lib/util/crypto.ts`, `src/lib/oidc/crypto.ts` |
| TOTP ライブラリ | **未導入**（`package.json` に `otpauth` なし） | `package.json` |
| 2FA API | **未実装**。`src/app/api/auth/` に `2fa/` ディレクトリが無い | `ls src/app/api/auth/` |
| 2FA の DB テーブル | **無い**（`totp` / `recovery_codes` とも未作成。最新 migration は `0016`） | `drizzle/` |
| `security_events` の型 | `2fa_enabled` / `2fa_disabled` は**定義済み**。失敗系・再生成の型は無い | `src/lib/db/schema.ts:243-244` |
| セキュリティ設定画面 | §37 の 2FA カードは「無効」「この機能は Phase 5 以降で利用できます」の**如实表示のみ**（導線なし） | `src/components/settings/security-overview.tsx:88-106` |
| OIDC のセッション判定 | `currentOidcAppSession` は `totp_pending` を**見ていない**（2FA 未完了でも OIDC 認可が通る穴になる） | `src/lib/oidc/session.ts:19-33` |
| 通知メール | 変更通知の汎用テンプレート `sendChangeNotificationEmail` と best-effort 送信 `deliverEmailSafely` が**再利用可能** | `src/lib/auth/email/templates.ts`, `src/lib/auth/email/deliver.ts` |

**結論**: 「入れる場所」は既に用意されている（列・キー・値・鍵・UI の器）。足すのは **(1) 2 テーブル、(2) 暗号化関数、(3) TOTP ラッパ、(4) API、(5) 画面接続、(6) 保留セッションの封じ込め**。

### 2.2 目的（各々に完了定義を付ける）

| # | 目的 | 完了定義 |
|---|---|---|
| 1 | 利用者が TOTP を**有効化**できる（§13.1 / D-09） | `/settings/security` から setup → QR をアプリで読み取り → 6 桁入力で有効化。**この時だけ**リカバリーコード 10 個が表示される |
| 2 | 有効化後は**ログインが 2 段階**になる | パスワード成功 → 保留セッション（`totp_pending=true`）→ 6 桁入力 → 昇格。保留中は**他の認証済み操作が一切できない** |
| 3 | 端末を失ってもログインできる（§13.2） | リカバリーコードで昇格できる。使用したコードは**即座に無効化**され、1 回限り |
| 4 | 2FA を安全に**無効化・再生成**できる（§8 / §33） | **パスワード ＋ 現在のコード**の強い再認証（D-33-23）。片方だけでは通らない。**失敗時は何も変更しない** |
| 5 | **同じ 6 桁コードの並行送信で成功が 1 件だけ**（D-16 / §48） | `src/test/security/2fa-concurrent-replay.test.ts` で 2 並行 → 成功 1・他方 `INVALID_CODE` |
| 6 | 総当たりが現実的でない（§16） | 2FA 入力は 10/5分。超過で 429、`rate_limited` を記録 |
| 7 | secret が漏れない（§13.1 / §45） | DB には暗号文のみ。ログ・API 応答・`security_events.metadata` に平文 secret / コードが出ない（テストで固定） |
| 8 | **未確認 email のまま使えない**（§4.1・D-33-21） | 未確認ログインは **403 `EMAIL_NOT_VERIFIED`**。**セッションを発行しない**。画面に「メールアドレスの確認が必要です」を出す |
| 9 | **未確認でも確認メールを再送できる**（§4.3・D-33-22） | ログイン画面から**ログインせずに**再送できる。応答は常に同一（列挙対策）。5回/1時間で制限 |
| 10 | **Phase 6 の Passkey を無変更で差し込める**（D-33-24） | `strong-reauth.ts` に検証器を 1 つ足すだけで `disable` / `regenerate` が Passkey 対応になる。`strong_reauth_methods` で UI が出し分ける |

---

## 3. スコープ

### 3.1 本フェーズで実装する

- 2FA の DB テーブル（`totp` / `recovery_codes`）と migration `0017_totp.sql`
- secret の AES-256-GCM 暗号化（`src/lib/auth/totp-crypto.ts` を新設）
- TOTP ラッパ `src/lib/auth/totp.ts`（`otpauth`。6 桁・±1 ウィンドウ・**atomic カウンタ消費**）
- QR 生成（`qrcode` で**サーバ側**に SVG 文字列を作る・D-33-02）
- リカバリーコードの生成・ハッシュ保存・1 回限り消費
- API 6 本（`GET /2fa` / `setup` / `verify` / `disable` / `recovery-codes/regenerate` / `challenge/verify`）
- ログインの 2 段階化（保留セッションの発行・昇格・**保留セッションの封じ込め**）
- 保留セッションを締め出すガード（共通パイプライン + OIDC セッション判定 + 画面）
- **「強い再認証」の共通入口**（`src/lib/auth/strong-reauth.ts`。Phase 5 はパスワード＋コード、Phase 6 が Passkey を追加・D-33-24）
- `/settings/security` の 2FA カードを実動作に（setup / QR / コード表示 / 無効化 / 再生成）
- `/login` の 2FA 入力ステップ（既存 `TotpChallengeForm` を接続）
- **未確認 email のログイン遮断（403 `EMAIL_NOT_VERIFIED`）＋ ログイン画面からの確認メール再送**（D-33-21 / D-33-22）
- 通知メール（有効化 / 無効化 / 再生成）と `security_events` 記録

### 3.2 本フェーズで実装しない（理由と引継ぎ先）

| 項目 | 理由 | 引継ぎ先 |
|---|---|---|
| Passkey / WebAuthn | 別フェーズ。`§64` の「Passkey」は Phase 6 | Phase 6 |
| 再認証手段としての **Passkey** | Phase 6。**ただし Phase 5 で「強い再認証」の共通入口（`strong-reauth.ts`）を作り、Phase 6 は検証器を 1 つ足すだけにする**（D-33-24） | Phase 6（`docs/phase6-*`） |
| 管理者の 2FA 必須化（§51） | 管理者ロールの運用は Phase 7 | Phase 7 |
| `trusted_devices`（2FA スキップ） | 計画で「将来拡張」 | 未定（MVP 対象外） |
| パスキー/2FA を併用した復旧フロー（§54） | サポート経由の復旧は MVP 対象外 | 未定 |
| SMS / メール OTP | §13 は TOTP のみを要求 | 対象外 |

> **掃除ジョブについて**: `recovery_codes` は user 削除で CASCADE される。使用済みコードを即削除する必要は無い（`used_at` で判別でき、監査にも残す）。`totp` も同様。**したがって `purge-expired` への追加は不要**（§3.2 の判断として明記。追加するなら「削除ユーザーの残骸」のみで、CASCADE が既に担う）。

---

## 4. 前提・着手前チェック

| # | 確認事項 | 状態 |
|---|---|---|
| 1 | `TOTP_ENCRYPTION_KEY` が `.env` / Secret Manager にある（Base64 32 バイト） | ✅ `env.ts` が起動時に検証。`pnpm secrets:gen` が生成。テストは `setup.ts` が注入 |
| 2 | `sessions.totp_pending` 列が既にある | ✅ migration `0002` |
| 3 | 2FA レート制限キーと値が既にある | ✅ `rateLimitKeys.twoFactorUser` / `RATE_LIMITS.twoFactor` |
| 4 | `security_events` に `2fa_enabled` / `2fa_disabled` がある | ✅ `SECURITY_EVENT_TYPES` |
| 5 | 再認証の共通ガードがある | ✅ `checkReauth` + `withAuthPipeline({ requireReauth: true })` |
| 6 | 変更通知メールのテンプレートがある | ✅ `sendChangeNotificationEmail` + `deliverEmailSafely` |
| 7 | 実 HTTP テスト基盤がある | ✅ `src/test/helpers/app-server.ts`（BUG-7） |
| 8 | `otpauth` / `qrcode` のバージョンを固定する | 要対応（`otpauth@^9.5.2`・`qrcode@^1.5.4` を dependencies に追加。`@types/qrcode` も devDependencies に） |
| 9 | 2FA 有効化にメール確認を要求するか | **要求する**（D-33-06。未確認 email では 2FA を有効化できない） |
| 10 | 未確認 email のログインをどう扱うか | **403 `EMAIL_NOT_VERIFIED` で止める**（D-33-21）。**既存テストの期待値を反転する**（§5.2） |
| 11 | 未確認ユーザーの再送経路があるか | **無い。新設する**（D-33-22）。`register` はセッションを発行せず、現行の `resend-verification` は `requireAuth: true` のため、**このままだと未確認ユーザーが締め出される** |

---

## 5. 決定事項（D-33-01 〜 D-33-25）

> 全フェーズ共通のロック済み決定（D-01〜D-27）は再掲しない。ここには Phase 5 で新たに固定する事項のみを書く。

| ID | 決定 | 理由 |
|---|---|---|
| **D-33-01** | TOTP ライブラリは **`otpauth`**（`^9.5.2`）。RFC 6238 の HMAC 計算・base32・`otpauth://` URI 生成を委譲する | 計画 §4 の「標準ライブラリを使い、暗号/プロトコル層は自作しない」。**自作 TOTP は禁止**（§67）。`otpauth` は MIT・依存ゼロ・Node/Deno/Bun/ブラウザ対応 |
| **D-33-02** | QR は **`qrcode`**（`^1.5.4`・MIT・依存あり）で **サーバ側で SVG 文字列**を生成し、応答に含める。入力は `otpauth` の `toString()` が返す URI | ユーザー承認（2026-10-24）。自前実装は QR 仕様の正しさを保証しづらく、**読み取れない事故**の risk が高い。`qrcode` は実績があり、SVG を文字列で返せる。**secret を外部サービスに送らない**方針は維持（Google Chart API 等は禁止・§45） |
| **D-33-03★** | secret は **AES-256-GCM**（`TOTP_ENCRYPTION_KEY`）で暗号化して `totp.secret_encrypted` に保存する。**nonce は 12 バイト・毎回ランダム**、形式は `v1.<nonce>.<tag>.<ciphertext>`（base64url） | §13.1「DB 保存時に暗号化、鍵は DB 内に保存しない」。既存 `oidc/crypto.ts` と**同じ形式**にそろえ、鍵だけ分離する（OIDC の鍵と TOTP の鍵を共有しない） |
| **D-33-04★** | `last_used_counter` の更新は **1 文の原子的 UPDATE**（`UPDATE totp SET last_used_counter = $c WHERE user_id = $id AND enabled = true AND last_used_counter < $c`）で行い、**更新行数 = 1 のときだけ成功**とする。read → 判定 → write の 2 段書きは**禁止** | D-16 / 計画 §5-A。同一コードの並行送信で両方が通過するのを防ぐ。行ロックを取る `SELECT ... FOR UPDATE` 方式はトランザクション保持時間が伸びるため、単文 UPDATE を採る |
| **D-33-05★** | TOTP 検証は **6 桁・period 30 秒・window ±1**（合計 3 ステップ）。**一致したステップの counter を消費**する。window を広げない（±1 で十分・ブルートフォース面を増やさない） | §13「6 桁」。±1 は時計ずれの許容。**一致した counter のみ**を消費対象にする（±1 の全 counter を消費すると正当な次コードを無効化してしまう） |
| **D-33-06** | 2FA 有効化は **`email_verified = true` のユーザーだけ**許可する。未確認なら 403 `EMAIL_NOT_VERIFIED` | メールが確認できていないアカウントに 2FA を付けても、復旧経路（リカバリーコード再発行の通知）が機能しない。§48「email 未認証」テストと整合 |
| **D-33-21★** | **email 未確認（`email_verified = false`）のログインは成功させない**。403 `EMAIL_NOT_VERIFIED` を返し、応答に `{ email, resend_available: true }` を含める。**このとき通常セッションは発行しない**（保留セッションも発行しない） | ユーザー指示（2026-10-24）。未確認のまま使わせない。**既存の `deleted-account-login.test.ts` の「未認証でもログインできる」前提を反転する**（§5.2 に影響を明記） |
| **D-33-22★** | **`resend-verification` を未認証でも呼べるようにする**。`requireAuth: false` にし、body の `{ email }` で対象を決める。応答は**常に同一メッセージ**（列挙対策）。レート制限は既存の `resend.user` / `resend.ip` に加え、**未認証経路用のキー**を新設する | D-33-06 / D-33-21 の帰結。**`register` はセッションを発行しない**（実装確認済み）ため、未確認ユーザーが再送するには認証不要の経路が要る。これを用意しないと**未確認ユーザーが締め出される**（ログイン不可＋再送不可）。§4.3 の再送要件を満たす |
| **D-33-07★** | ログインで 2FA が有効な場合、**パスワード成功時に「保留セッション」を発行**する（`totp_pending = true`）。保留セッションでは **`totp_pending = false` に昇格するまで、2FA 関連 API 以外の認証済み操作をすべて拒否**する | 保留セッションを通常セッションと同格に扱うと、**パスワードだけで 2FA を素通り**できる。封じ込めはパイプライン層で行う（D-33-08） |
| **D-33-08★** | 封じ込めは `runCorePipeline` に **`denyTotpPending`（既定 true）** を追加して行う。保留セッションは 403 `TOTP_REQUIRED` になる。例外は `2fa/challenge` / `2fa/challenge/verify` / `logout` / `csrf` / `me` のみ（ホワイトリスト方式） | 各ルートで個別にチェックすると**新規ルート追加時に漏れる**。共通パイプラインに既定で入れる（fail closed）。ホワイトリストは「2FA を完了するのに必要な操作」＋「安全に抜ける操作」だけ |
| **D-33-09★** | OIDC の `currentOidcAppSession` は **`totp_pending = false` のセッションだけ**を認証済みとみなす | 保留セッションで OIDC 認可を通すと、パスワードだけで RP にログインできてしまう（D-33-07 の穴）。SQL の WHERE に 1 条件足す |
| **D-33-10** | 昇格（`challenge/verify`）は **同じセッション行を更新**する（`totp_pending = false`）。**新しいセッションを発行しない** | 保留セッションは「本人確認の途中」であり、ログインではない。ローテーションは通常ログインで既に済んでいる。昇格でセッション ID を変えると CSRF トークンも変わり、UI の再取得が必要になる（複雑化に見合わない） |
| **D-33-11** | リカバリーコードは **10 個・各 20 文字（base32 風・`XXXXX-XXXXX` 形式の 2 ブロック）**。DB には **SHA-256 のみ**保存する。**1 個ずつ atomic に消費**する | §13.2「10 個・1 回のみ・ハッシュ化」。コードは高エントロピー（32 バイト base32 → 表示用に整形）なので SHA-256 で十分（password のような低速ハッシュは不要。総当たりはレート制限で抑える） |
| **D-33-12** | リカバリーコードの消費も **`UPDATE ... WHERE used_at IS NULL` の更新行数 = 1** で判定する | 2 回目以降は 0 行更新。1 回限りを DB で強制する（D-16 と同じ考え方） |
| **D-33-13** | 残数が **3 未満**になったら、設定画面とログイン後の通知で再生成を促す。API 応答に **残数（`remaining`）** を含める | §13.2 / 計画 P5-B-04。残数は secret ではないので返してよい |
| **D-33-14★** | 無効化（`disable`）は **「強い再認証」を必須**とする。成功で `totp` 行と `recovery_codes` を**削除**し、`2fa_disabled` を記録、通知を送る | §33「無効化には再認証を要求」。ただし**セッション窃取だけ**で外せてはいけないため、単なるパスワード再認証では不十分。下の D-33-23 で「強い再認証」の内容を定義する |
| **D-33-15** | 再生成（`recovery-codes/regenerate`）は **再認証必須**。既存を全削除して新しい 10 個を返す（**この時だけ表示**） | 計画 P5-B-06。古いコードを無効化しないと、漏れたコードが生き残る |
| **D-33-16** | `setup` は **既存の未確認 secret を上書き**する（再 setup 可）。**有効化済みの場合は 409** で拒否する | 途中で離脱した利用者がやり直せるようにする。有効化済みの secret を setup で差し替えると、**2FA を実質無効化**できてしまう（コード不要で secret を交換 → 攻撃者が自分のアプリに登録）ので禁止 |
| **D-33-17** | 2FA 入力のレート制限は **`rateLimitKeys.twoFactorUser(userId)` の 1 キー**（10/5分・soft 3）。失敗時に予約を確定する | §16 / §8.6。既存のキー・値をそのまま使う（新キーを作らない）。soft limit 超過で CAPTCHA hook を呼ぶかは **Phase 5 では呼ばない**（2FA 画面に CAPTCHA を出す UX は過剰。Phase 9 で再検討） |
| **D-33-18** | `security_events` の**新規 type を追加しない**。有効化 = `2fa_enabled`、無効化 = `2fa_disabled`、昇格失敗 = `login_failed`（`metadata.scope = '2fa'`）、リカバリーコード再生成 = `2fa_enabled`（`metadata.reason = 'regenerated'`）とする | D-31-18 / D-32-15 の踏襲。**列挙を増やすとダッシュボード・テスト・文言の同時更新が必要**になる。既存型 + metadata で表現できる |
| **D-33-19** | TOTP の issuer 名は **`APP_NAME`**（`NEXT_PUBLIC_APP_NAME`）、label は **username** とする。`otpauth://totp/<issuer>:<username>?secret=...&issuer=<issuer>&algorithm=SHA1&digits=6&period=30` | §13 の例（Google Authenticator）。`APP_NAME` は既存の一元管理（`src/config/app.ts`）。**username は ASCII とは限らない**ため URI エンコードを `otpauth` に任せる |
| **D-33-20★** | ログの redaction に **`secret` / `secretEncrypted` / `otpauthUri` / `recoveryCodes` / `recoveryCode` / `code`** を追加する（`code` は既に登録済み） | §45。`SENSITIVE_KEYS` に無いキー名で secret をログに渡すと**素通りする**。実装と同時に `logger.ts` を更新し、テストで固定する |
| **D-33-23★** | **2FA の無効化・リカバリーコード再生成**に要求する「強い再認証」は、次の**いずれか**とする。<br>**(A) パスワード ＋ 現在の TOTP コードまたはリカバリーコード**（Phase 5 で実装する唯一の経路）<br>**(B) Passkey 認証**（Phase 6 で追加。Phase 5 では未提供） | ユーザー指示（2026-10-24）。**(A)** は「知っているもの（パスワード）＋ 持っているもの（コード）」の 2 要素で、セッション窃取者が単独では突破できない。**(B)** の Passkey は所持＋生体で**単独でも強い**ため、コードを重ねて要求しない（UX を損なう）。§8 が挙げる再認証 3 手段のうち、Phase 5 はパスワード＋コードを実装し、Passkey は Phase 6 が同じ入口に差し込む |
| **D-33-24★** | 「強い再認証」は **`src/lib/auth/strong-reauth.ts`** の 1 関数（`requireStrongReauth`）に閉じ込め、**検証器（verifier）の配列**として実装する。Phase 5 の配列は `[passwordAndCodeVerifier]` の 1 件。Phase 6 が `passkeyVerifier` を足すだけで、**API ルートは無変更** | D-33-23 の (A)/(B) を if 文で各ルートに書くと、Phase 6 で 3 ルートを書き換えることになる。**入口を 1 つに固定**すれば、Phase 6 は「検証器を 1 つ追加」で済む。Passkey の有無で UI を出し分けるため、`/api/auth/2fa` の応答に `strong_reauth_methods: ['password']`（Phase 6 で `+ 'passkey'`）を含める |
| **D-33-25** | Phase 5 の `strong_reauth_methods` は **`['password']` 固定**。`POST /api/auth/2fa/disable` と `.../regenerate` は **`{ code }` を必須**とし、**`requireStrongReauth` に再認証判定を委ねる**（ルート側で `requireReauth: true` を**重ねない**）。**再認証が無ければ 401 `REAUTH_REQUIRED`、`code` が誤りなら 400 `INVALID_CODE`** | D-33-23(A)。既存の `checkReauth`（5 分の猶予）を `requireStrongReauth` の**内側で**呼ぶ。判定点を 1 つに保つため、パイプラインの `requireReauth` と二重に課さない（順序は「再認証 → コード」で、**再認証が無ければコードを消費しない**・R14） |

### 5.1 却下した代替案（なぜ採らなかったか）

| 代替案 | 却下理由 |
|---|---|
| ~~QR を `qrcode` パッケージで生成~~ | **当初は却下したが v1.1 で採用に反転**（D-33-02）。依存を 1 つ増やすより自前 SVG を優先する判断だったが、**QR の正しさの担保を優先**し `qrcode`（SVG 出力）を使う |
| QR を Google Chart API 等の外部 URL で生成 | **secret が第三者に送られる**。§45 / §13.1 に反する。絶対に禁止 |
| TOTP 検証を `SELECT ... FOR UPDATE` で行う | トランザクション保持時間が伸び、高負荷時にロック待ちが出る。**単文 UPDATE の更新行数**で判定するほうが短く、同じ原子性が得られる |
| `last_used_counter` に「最後に使った counter」を保存し、`<=` で拒否 | 時計ずれの許容（±1）で**古い counter が新しい counter を上書き**しうる。`<` の単調増加でのみ判定する |
| 保留セッションを別テーブル（`2fa_pending_sessions`）に分離 | `sessions.totp_pending` が既にあり、セッションの寿命・失効・一覧の仕組みを二重実装することになる。1 列で足りる |
| 昇格時にセッションをローテーション | CSRF トークンが変わり UI 再取得が必要。保留セッションは既にログイン後のセッションなので固定攻撃の対象にならない（ログイン時に既に新規発行済み） |
| リカバリーコードを Argon2id で保存 | 32 バイトのランダム値であり辞書攻撃が成立しない。Argon2id は verify コストが高く、10 個 × ログイン試行で CPU を浪費する（DoS 面）。SHA-256 + レート制限で十分 |
| 2FA 有効化に管理者承認を挟む | MVP の範囲外。§33 は利用者自身の操作を前提にしている |
| 未確認ユーザーをログインさせ、確認バナーから再送させる | **採用しない**（D-33-21）。ログインを許すと、未確認のままアプリを使い続けられ、§4.1「登録直後は `email_verified = false`」の意味が薄れる。**ログイン時に 403 で止め、その場で再送させる**ほうが意図が明確 |
| 無効化の再認証を「パスワードのみ」にする | **採用しない**（D-33-23）。セッションを窃取した攻撃者はパスワードを知らないとは限らない（同一端末のキーロガー等）。**コードも要求**すれば、窃取セッションだけでは外せない |
| 無効化に「コードのみ」を要求しパスワードを省く | **採用しない**。コードは端末にあり、端末ごと窃取されうる。**パスワード（記憶）＋コード（所持）**の 2 要素にする |

### 5.2 既存仕様を変更する決定（影響の明示）

D-33-21（未確認ログインの拒否）と D-33-22（未認証の再送）は、**Phase 5 より前に確定した挙動を変更する**。実装前に影響を確認すること。

| 対象 | 現状 | Phase 5 後 | 対応 |
|---|---|---|---|
| `src/test/security/deleted-account-login.test.ts:132` | `it('email 未認証（pending_email）は確認メール再送のためログインできる')` — **200 を期待** | 未確認は **403 `EMAIL_NOT_VERIFIED`** | **テストを反転**し、テスト名を「email 未認証は 403 で止まり、再送できる」に変える。**§11.2 に追記** |
| `src/app/api/auth/login/route.ts:92` のコメント | 「`pending_email` は残す（確認メールを再送するにはログイン状態が要るため）」 | ログイン状態に依存しなくなる（再送は未認証で呼べる） | コメントを更新する。`pending_email` の `status` は**残す**（§23 の意味は変わらない） |
| `src/app/api/auth/resend-verification/route.ts` | `requireAuth: true`。`user.id` で対象を決める | **`requireAuth: false`** ＋ `body.email` で対象を決める | ルートを書き換え。**`security_events` の記録対象**が変わる（`user.id` が無い場合は `null` ＋ `metadata.email_hash`）→ `security-events-coverage.test.ts` を更新 |
| `src/app/verify-email-form.tsx` の `resend()` | 認証済みセッションが前提 | セッション無しで呼べる | **変更不要**（`apiClient.post` は CSRF トークンを anon cookie から取れる）。ただし**メールアドレスの入力欄**が要るため、ログイン画面側に別コンポーネントを作る（§12.4） |
| §48「email 未認証」テスト項目 | 未認証の扱いが未指定 | **403 で止まること**を検証する | 新しいテストを §11.1 に追加 |

> **`register` はセッションを発行しない**（`createSession` を呼んでいないことを実装で確認済み）。したがって D-33-21 を入れないと、**登録直後のユーザーが完全に締め出される**。D-33-21 と D-33-22 は**必ずセットで**実装する。

---

## 6. データモデル

### 6.1 migration `drizzle/0017_totp.sql`

**新規 2 テーブルのみ。既存テーブルの変更は無い**（`sessions.totp_pending` は既にある）。

```sql
CREATE TABLE "totp" (
  "user_id" text PRIMARY KEY NOT NULL,
  "secret_encrypted" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "last_used_counter" bigint DEFAULT -1 NOT NULL,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "totp" ADD CONSTRAINT "totp_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "code_hash" text NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_codes_code_hash_uniq" ON "recovery_codes" USING btree ("code_hash");
--> statement-breakpoint
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes" USING btree ("user_id");
```

### 6.2 設計上の判断

| 論点 | 決定 | 理由 |
|---|---|---|
| `totp` の主キー | **`user_id` を主キー**にする（`id` を別に持たない） | 1 ユーザー 1 行。仕様 §22 の `totp` も `user_id` を先頭に持つ。別 ID を持つと「どの行が正か」を一意制約で守る必要が出る |
| `enabled` と `confirmed_at` | **両方持つ**。`enabled=true` のとき `confirmed_at` は非 NULL（アプリ層で保証。CHECK は付けない） | §22 の追記（`confirmed_at`）。CHECK 制約を足すと migration の down 生成が複雑になる（`scripts/verify-migrations.ts` が up/down を往復検証する）。**アプリ層で不変条件を守る**方針は既存コードと一致 |
| `last_used_counter` | **`bigint`、既定 `-1`**。未使用を `-1` で表す | TOTP counter は Unix epoch / 30 秒 で約 5,800 万（2026 年時点）なので `integer` でも足りるが、`bigint` にして桁あふれを考えない。**`-1` で「まだ 1 度も使っていない」**を表現し、`last_used_counter < c` が常に成立する |
| `recovery_codes.code_hash` | **UNIQUE**。SHA-256 hex（64 文字） | コードは 32 バイトのランダム値なので衝突は実質起きないが、UNIQUE があると「同じコードの重複発行」を DB が弾く（乱数が壊れたときの最後の砦） |
| 使用済みコードの保持 | **削除しない**（`used_at` を立てる） | 監査と「残数」計算の両方に要る。残数 = `count(*) WHERE used_at IS NULL` |
| `user_id` の索引 | `recovery_codes_user_id_idx` | 残数計算と全削除（再生成・無効化）が user 単位。10 行程度だが、user 削除時の CASCADE 走査にも効く |

### 6.3 `src/lib/db/schema.ts` への追加

```ts
export const totp = pgTable('totp', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  secretEncrypted: text('secret_encrypted').notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  lastUsedCounter: bigint('last_used_counter', { mode: 'number' }).default(-1).notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const recoveryCodes = pgTable('recovery_codes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('recovery_codes_code_hash_uniq').on(table.codeHash),
  index('recovery_codes_user_id_idx').on(table.userId),
]);

export type Totp = typeof totp.$inferSelect;
export type RecoveryCode = typeof recoveryCodes.$inferSelect;
```

> `bigint({ mode: 'number' })` を使う理由: drizzle の既定は `bigint` を **文字列**で返す。counter は `number` として比較・加算するので `mode: 'number'` を明示する（値域は安全整数内）。

### 6.4 `scripts/verify-migrations.ts` への期待値追加

```ts
['totp テーブルが存在する（migration 0017）', afterUp.tables.includes('totp')],
['recovery_codes テーブルが存在する（migration 0017）', afterUp.tables.includes('recovery_codes')],
['totp.last_used_counter 列がある', (afterUp.columns.totp ?? []).includes('last_used_counter')],
['recovery_codes に code_hash の unique index がある',
  Object.values(afterUp.indexes).flat().includes('recovery_codes_code_hash_uniq')],
```

> **down の確認**: `verify-migrations.ts` は全 migration を逆順に roll back してテーブル残存ゼロを確認する。`0017` の down は `DROP TABLE recovery_codes; DROP TABLE totp;`（FK の向きから `recovery_codes` を先に落とす必要はないが、依存が無いので順序は任意）。スクリプトが自動生成できる単純な形にしておく。

---

## 7. 実装設計

### 7.1 新規ファイル一覧（21）

| # | パス | 種別 | 内容 |
|---|---|---|---|
| 1 | `drizzle/0017_totp.sql` | migration | §6.1 |
| 2 | `src/lib/auth/totp-crypto.ts` | ライブラリ | secret の AES-256-GCM 暗号化 / 復号（`v1.nonce.tag.ct`） |
| 3 | `src/lib/auth/totp.ts` | ライブラリ | `generateTotpSecret` / `buildOtpauthUri` / `verifyAndConsumeTotp`（atomic） |
| 4 | `src/lib/auth/totp-qr.ts` | ライブラリ | `otpauth://` URI → SVG 文字列（`qrcode` の薄いラッパ） |
| 5 | `src/lib/auth/recovery-codes.ts` | ライブラリ | 生成 / ハッシュ / atomic 消費 / 残数 |
| 6 | `src/lib/auth/strong-reauth.ts` | ライブラリ | **「強い再認証」の共通入口**（検証器配列。Phase 5 はパスワード＋コード・D-33-24） |
| 7 | `src/lib/db/queries/totp.ts` | クエリ | `totp` の upsert / 取得 / 削除 / **atomic counter 更新** |
| 8 | `src/lib/db/queries/recovery-codes.ts` | クエリ | 一括 insert / atomic 消費 / 残数 / 全削除 |
| 9 | `src/lib/validate/totp.ts` | 検証 | zod スキーマ（code 6 桁 / recovery code / disable 入力） |
| 10 | `src/app/api/auth/2fa/route.ts` | API | `GET` 2FA 状態（有効/無効・残数・`strong_reauth_methods`） |
| 11 | `src/app/api/auth/2fa/setup/route.ts` | API | `POST` secret 発行 + QR |
| 12 | `src/app/api/auth/2fa/verify/route.ts` | API | `POST` 有効化 + リカバリーコード 10 個を返す |
| 13 | `src/app/api/auth/2fa/disable/route.ts` | API | `POST` 無効化（強い再認証） |
| 14 | `src/app/api/auth/2fa/recovery-codes/regenerate/route.ts` | API | `POST` 再生成（強い再認証） |
| 15 | `src/app/api/auth/2fa/challenge/verify/route.ts` | API | `POST` 保留セッションの昇格 |
| 16 | `src/components/settings/two-factor-panel.tsx` | 画面 | 2FA カード（有効化ウィザード / 無効化 / 再生成） |
| 17 | `src/components/settings/recovery-codes-display.tsx` | 画面 | コード 10 個の表示（印刷/コピー・**1 回限り**） |
| 18 | `src/components/settings/strong-reauth-dialog.tsx` | 画面 | **強い再認証ダイアログ**（パスワード＋コード。Phase 6 で Passkey タブを足す） |
| 19 | `src/components/auth/totp-login-step.tsx` | 画面 | `/login` の 2FA 入力ステップ |
| 20 | `src/components/auth/email-unverified-notice.tsx` | 画面 | **未確認 email の案内 ＋ 確認メール再送**（D-33-21 / D-33-22） |
| 21 | `src/lib/validate/resend.ts` | 検証 | 未認証再送の zod スキーマ（`{ email }`） |

> **`challenge`（保留セッションを作る API）は作らない**。保留セッションはログイン API が発行する（D-33-07）。計画書の `2fa/challenge(/verify)` のうち **`verify` のみ実装**し、`challenge` はログインに内包する（§8.7 で明記）。`実装Todo.md` の表記を更新する。

> **計画からの意図的な差分（P5-A-01）**: `実装Todo.md` は暗号化を `util/crypto.ts` に置く想定だが、本書は **`src/lib/auth/totp-crypto.ts` を新設**する。理由: `util/crypto.ts` は現状「pepper を引数で受ける純粋なユーティリティ」であり（`src/test/unit/crypto.test.ts` が引数だけで検証している）、`getEnv()` を読む暗号化を混ぜると**純粋性が壊れ、既存テストの前提も変わる**。鍵の解決は `auth/` 層に閉じ込める。`util/crypto.ts` は無変更。

### 7.2 変更する既存ファイル

| # | パス | 変更 |
|---|---|---|
| 1 | `package.json` | `otpauth@^9.5.2` / `qrcode@^1.5.4` を dependencies、`@types/qrcode` を devDependencies に追加 |
| 2 | `src/lib/db/schema.ts` | `totp` / `recoveryCodes` テーブル定義（§6.3） |
| 3 | `src/lib/util/logger.ts` | `SENSITIVE_KEYS` に `secret` / `secretEncrypted` / `otpauthUri` / `recoveryCodes` / `recoveryCode` を追加（D-33-20） |
| 4 | `src/lib/errors.ts` | `ERROR_CODES` に `TOTP_REQUIRED`（403）/ `TOTP_ALREADY_ENABLED`（409）/ `EMAIL_NOT_VERIFIED`（403）を追加（**3 か所すべて**: `ERROR_CODES` / `ERROR_STATUS` / 既定メッセージ） |
| 5 | `src/lib/auth/session.ts` | `SessionData` に `totpPending: boolean` を追加。`createSessionInternal` の戻りと `getSession` の SELECT に反映 |
| 6 | `src/lib/auth/pipeline.ts` | `PipelineOptions` に `denyTotpPending?: boolean`（既定 true）を追加し、判定を `runCorePipeline` に実装（D-33-08） |
| 7 | `src/lib/api/utils.ts` | `withAuthPipeline` の options を素通し（型のみ） |
| 8 | `src/lib/oidc/session.ts` | `currentOidcAppSession` の SQL に `totp_pending = false` を追加（D-33-09） |
| 9 | `src/app/api/auth/login/route.ts` | **未確認 email は 403 `EMAIL_NOT_VERIFIED` で止める**（D-33-21・既存コメントも更新）。2FA 有効時は `totp_pending=true` のセッションを発行し `{ twoFactorRequired: true }` を返す |
| 10 | `src/app/api/auth/resend-verification/route.ts` | **`requireAuth: false` に変更**し `body.email` で対象を決める（D-33-22・§5.2） |
| 11 | `src/lib/auth/rate-limit-keys.ts` | 未認証再送用の `resendEmail(email)` キーを追加（D-33-22） |
| 12 | `src/components/settings/security-overview.tsx` | 2FA カードを「無効（導線なし）」から `<TwoFactorPanel />` に差し替え |
| 13 | `src/app/login/page.tsx` + `src/app/auth-form.tsx` | `twoFactorRequired` のとき `TotpLoginStep`、`emailNotVerified` のとき `EmailUnverifiedNotice` を描画（**サーバ側で判定して props で渡す**。BUG-11 の再発防止） |
| 14 | `scripts/verify-migrations.ts` | §6.4 の期待値追加 |
| 15 | `src/messages/ja.ts` | `security.twoFactor*` / `twoFactor.*` / `auth.emailNotVerified*` / `errors.TOTP_REQUIRED` 等の文言追加 |

> **`src/lib/auth/reauth.ts` は変更しない**（パスワード再認証のまま。§3.2）。「強い再認証」は `strong-reauth.ts` が `checkReauth` を**内側で呼ぶ**（既存の猶予ロジックを再利用）。

### 7.3 モジュール仕様

#### 7.3.1 `src/lib/auth/totp-crypto.ts`

```ts
/** secret を AES-256-GCM で暗号化する。鍵は env の TOTP_ENCRYPTION_KEY（Base64 32B）。 */
export function encryptTotpSecret(plaintext: string): string;
/** v1.<nonce>.<tag>.<ct> を復号する。改竄・形式不正は throw。 */
export function decryptTotpSecret(payload: string): string;
```

- 形式は `oidc/crypto.ts` と同一（`v1` + base64url）。**鍵は引数で受け取らず `getEnv()` から読む**（呼び出し側が鍵を持ち回らない）。
- `createCipheriv('aes-256-gcm', key, nonce)` / nonce は `randomBytes(12)`。
- 復号失敗（`tag` 不一致）は **`ApiError('INTERNAL_ERROR')` に丸める**。理由を利用者に返さない（§45）。

#### 7.3.2 `src/lib/auth/totp.ts`

```ts
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW = 1;

export function generateTotpSecret(): { base32: string; encrypted: string };
export function buildOtpauthUri(args: { issuer: string; label: string; secretBase32: string }): string;

/**
 * コードを検証し、成功したら counter を **atomic に消費**する。
 * 消費に失敗（= 既に使われた counter）なら invalid を返す。
 */
export async function verifyAndConsumeTotp(args: {
  userId: string;
  code: string;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'replayed' }>;
```

- `verifyAndConsumeTotp` の流れ（**この順序が肝**）:
  1. `totp` 行を取得（`enabled = true`）。無ければ `invalid`。
  2. `decryptTotpSecret` で base32 secret を得る。
  3. `TOTP.validate({ token: code, secret, digits: 6, window: 1 })` → **delta**（`-1 | 0 | 1`）または `null`。
  4. `null` なら `invalid`。
  5. **一致した counter を計算**: `counter = TOTP.counter({ period: 30, timestamp }) + delta`。
  6. **atomic 更新**: `UPDATE totp SET last_used_counter = $counter, updated_at = now() WHERE user_id = $id AND enabled = true AND last_used_counter < $counter`。
  7. 更新行数が **1 → ok**、**0 → `replayed`**（同じ counter を誰かが既に消費した）。

> **delta の意味**: `otpauth` の `validate` は「見つかった counter が基準 counter からどれだけずれていたか」を返す（`-1` は 30 秒前、`0` は現在、`1` は 30 秒後）。**基準 counter + delta** が「実際に一致した counter」。これを消費する（D-33-05）。

> **なぜ「現在の counter」ではなく「一致した counter」を消費するか**: 利用者が前のウィンドウのコードを入力した場合（時計ずれ）、現在の counter を消費すると**次の正当なコードも無効化**してしまう。一致した counter を消費すれば、次のウィンドウのコードは `last_used_counter < c` を満たし通る。

#### 7.3.3 `src/lib/auth/totp-qr.ts`

```ts
/** otpauth:// URI を SVG 文字列にする。外部通信なし。 */
export async function otpauthUriToSvg(
  uri: string,
  options?: { size?: number; margin?: number },
): Promise<string>;
```

- **実装**: `qrcode` の `toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin, width })` を呼ぶだけの**薄いラッパ**。自前の QR 実装はしない（D-33-02）。
- **非同期**: `qrcode` の SVG 出力は Promise を返す。呼び出し側（`setup` ルート）は `await` する。
- **`errorCorrectionLevel: 'M'`**（15% 復元）を明示。`otpauth://` URI は 150〜250 文字程度で、余裕を持って収まる。
- **失敗時**: `qrcode` が throw したら `ApiError('INTERNAL_ERROR')` に丸める（QR の生成失敗を利用者に詳細に返さない）。
- **`secret` を含む URI を渡すが、外部に送らない**（`qrcode` はローカル計算のみ）。ログにも出さない（D-33-20）。
- **テストで固定する**: 生成 SVG に `<svg` が含まれること、既知 URI から決定的な出力が得られること（`qrcode` 自体の正しさはパッケージのテストに委ね、**こちらは「URI を正しく渡しているか」だけ**を検証する）。

> **代替案（却下）**: 自前の QR 実装（当初 D-33-02 で予定）。QR 仕様の完全実装は誤りが混入しやすく、**読み取れない事故**が利用者に直撃する。`qrcode`（MIT・実績あり）に委ねる。

#### 7.3.4 `src/lib/auth/recovery-codes.ts`

```ts
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LOW_THRESHOLD = 3;

/** 10 個の平文コードを生成する（表示用。保存はしない）。 */
export function generateRecoveryCodes(): string[];
/** コードを正規化する（大文字化・ハイフン除去）。 */
export function normalizeRecoveryCode(input: string): string;
export function hashRecoveryCode(normalized: string): string;
/** 1 個を atomic に消費する。成功したら true。 */
export async function consumeRecoveryCode(userId: string, input: string): Promise<boolean>;
```

- **生成**: 各コードは `randomBytes(20)` → base32（パディング無し・32 文字）→ 先頭 20 文字を `XXXXX-XXXXX-XXXXX-XXXXX` の 4 ブロックに整形。**160 bit のエントロピー**で、総当たりは非現実的。
- **正規化**: 入力は大文字小文字・ハイフン・空白のゆらぎを許す（利用者が手入力するため）。`toUpperCase().replace(/[^A-Z0-9]/g, '')`。
- **ハッシュ**: `sha256Hex(normalized)`（既存関数）。**pepper は掛けない**理由: コードは高エントロピーで、pepper を掛けると「pepper を失うと全コードが使えなくなる」運用リスクだけが増える。
- **消費**: `UPDATE recovery_codes SET used_at = now() WHERE user_id = $id AND code_hash = $hash AND used_at IS NULL` → 更新行数 = 1 で成功（D-33-12）。
- **残数**: `SELECT count(*) FROM recovery_codes WHERE user_id = $id AND used_at IS NULL`。

#### 7.3.5 `src/lib/validate/totp.ts`

```ts
export const totpCodeSchema = z.string().regex(/^\d{6}$/, '6 桁の数字を入力してください');
export const recoveryCodeSchema = z.string().min(10).max(64);   // 正規化前に受ける
export const totpDisableSchema = z.object({
  code: z.string().min(6).max(64),   // TOTP 6 桁 or リカバリーコード
}).strict();
```

> **`code` を 1 フィールドにする理由**: UI は 6 桁入力欄 1 つ。利用者がリカバリーコードを入れる導線（「コードを入力」リンク）で同じ欄を使う。サーバは「6 桁の数字なら TOTP、それ以外ならリカバリーコード」と**自動判別**する（両方試す）。フィールドを分けると UI が複雑になる。

#### 7.3.6 `src/lib/auth/strong-reauth.ts`（D-33-23 / D-33-24）

```ts
/** 強い再認証で使える手段（Phase 5 は 'password' のみ。Phase 6 が 'passkey' を足す）。 */
export type StrongReauthMethod = 'password' | 'passkey';

/** UI が出し分けに使う。Phase 5 の戻り値は ['password'] 固定。 */
export function availableStrongReauthMethods(user: User): StrongReauthMethod[];

/**
 * 強い再認証を要求する。検証器を順に試し、**1 つでも通れば成功**。
 * どれも通らなければ ApiError('REAUTH_REQUIRED') / ApiError('INVALID_CODE') を投げる。
 */
export async function requireStrongReauth(args: {
  user: User;
  session: SessionData;
  code: string;
}): Promise<{ method: StrongReauthMethod }>;
```

- **検証器の配列**で実装する（Phase 5 は 1 件）:

```ts
type StrongReauthVerifier = (args: {
  user: User; session: SessionData; code: string;
}) => Promise<boolean>;

const verifiers: StrongReauthVerifier[] = [passwordAndCodeVerifier];
```

- **`passwordAndCodeVerifier`** の流れ:
  1. **パスワード（再認証）**: `checkReauth(session)` を呼ぶ（既存の 5 分猶予。無ければ `REAUTH_REQUIRED`）。
  2. **コード**: `code` が 6 桁の数字なら `verifyAndConsumeTotp()`、それ以外なら `consumeRecoveryCode()`。**どちらかが通れば成功**。
  3. 両方失敗なら `INVALID_CODE`。
- **`code` の検証は「消費」を伴う**（リカバリーコードは 1 回限り・TOTP は counter 消費）。**無効化・再生成の成功時だけ消費される**よう、**検証に成功した後で**本体処理を行う（§8.5 / §8.6 の順序）。
- **Phase 6 の差し込み方**: `passkeyVerifier` を配列に足すだけ。`requireStrongReauth` のシグネチャは変えない。`availableStrongReauthMethods` が `['password', 'passkey']` を返すようになり、UI が Passkey タブを出す。
- **`REAUTH_REQUIRED` と `INVALID_CODE` の使い分け**: パスワード再認証が未了なら **401 `REAUTH_REQUIRED`**（UI はパスワード欄を出す）、再認証済みでコードが違うなら **400 `INVALID_CODE`**（UI はコード欄を出す）。この区別で UI の出し分けが決まる。

#### 7.3.7 `src/lib/validate/resend.ts`（D-33-22）

```ts
export const resendVerificationSchema = z.object({
  email: emailSchema,
  captchaToken: z.string().optional(),
}).strict();
```

- **応答は常に同一**（`{ message: '確認メールを送信しました' }`）。**存在しない email でも 200** を返す（列挙対策・§46）。
- 存在する**未確認**ユーザーにだけ実際に送る。**確認済み**ユーザーには送らない（既に確認済みなので不要。ただし応答は同じ）。
- `suspended` / `deleted` には**送らない**（応答は同じ）。

---

## 8. API 契約

全 API は **`withAuthPipeline` を通す**（Origin → CSRF → session → user → body → reauth → handler）。
エラーは §58 の統一形式（`{ success: false, error: { code, message } }`）。応答は `Cache-Control: no-store`。

### 8.1 `GET /api/auth/2fa` — 状態取得

| 項目 | 値 |
|---|---|
| 認可 | `requireAuth: true` |
| レート制限 | `settings`（`rateLimitKeys.settingsUser`） |
| 保留セッション | **拒否**（`denyTotpPending: true` 既定） |

```json
{ "success": true, "data": { "enabled": true, "recovery_codes_remaining": 7, "strong_reauth_methods": ["password"] } }
```

- **`strong_reauth_methods`** は、無効化・再生成のダイアログが出す**手段**（D-33-24）。Phase 5 は `['password']` 固定。Phase 6 で `'passkey'` が加わる。

### 8.2 `POST /api/auth/2fa/setup` — secret 発行

| 項目 | 値 |
|---|---|
| 認可 | `requireAuth: true` |
| 前提 | `email_verified = true`（D-33-06。未確認は 403 `EMAIL_NOT_VERIFIED`） |
| 既に有効化済み | 409 `TOTP_ALREADY_ENABLED`（D-33-16） |
| レート制限 | `twoFactor`（`rateLimitKeys.twoFactorUser`） |

```json
{
  "success": true,
  "data": {
    "secret": "JBSWY3DPEHPK3PXP",
    "otpauth_uri": "otpauth://totp/MyApp:alice?secret=...&issuer=MyApp&algorithm=SHA1&digits=6&period=30",
    "qr_svg": "<svg ...>...</svg>"
  }
}
```

- 実装: `generateTotpSecret()` → `encryptTotpSecret()` → `upsertTotpPending(userId, encrypted)`（`enabled=false`）。
- **`secret` を返すのはこの 1 回だけ**（再 setup で上書きされるため、応答を保存し損ねたらやり直す）。

### 8.3 `POST /api/auth/2fa/verify` — 有効化

| 項目 | 値 |
|---|---|
| 認可 | `requireAuth: true` |
| body | `{ "code": "123456" }` |
| レート制限 | `twoFactor` |

```json
{ "success": true, "data": { "enabled": true, "recovery_codes": ["A1B2C-...", "..."] } }
```

- 実装: `verifyAndConsumeTotp()` → 成功したら `enableTotp(userId)`（`enabled=true, confirmed_at=now()`）→ `generateRecoveryCodes()` を **ハッシュして保存**し、**平文 10 個を応答に含める（この 1 回のみ）** → `recordSecurityEvent('2fa_enabled')` → 通知メール（best-effort）。
- **`enabled=true` にするのとリカバリーコード保存は同一トランザクション**にする（片方だけ成功すると復旧不能になる）。

### 8.4 `POST /api/auth/2fa/challenge/verify` — 保留セッションの昇格

| 項目 | 値 |
|---|---|
| 認可 | `requireAuth: true` |
| **保留セッション** | **許可**（`denyTotpPending: false`。この API が昇格させる） |
| body | `{ "code": "123456" }`（TOTP 6 桁 or リカバリーコード） |
| レート制限 | `twoFactor` |

```json
{ "success": true, "data": { "verified": true } }
```

- 実装:
  1. `session.totpPending === false` なら 400（既に昇格済み。冪等に 200 を返してもよいが、**二重送信の検知**のため 400 にする）。
  2. `code` が 6 桁の数字 → `verifyAndConsumeTotp()`。
  3. それ以外 → `consumeRecoveryCode()`。成功したら `recovery_codes_remaining` を返し、**3 未満なら警告フラグ**を返す。
  4. どちらも失敗 → **`INVALID_CODE`（400）に統一**。「TOTP が違う」「リカバリーコードが違う」を**区別しない**（§45 / 列挙対策）。
  5. 成功 → `markSessionTotpVerified(session.id)`（`totp_pending = false`）→ `recordSecurityEvent('login_success', ..., { method: 'totp' | 'recovery_code' })`。
  6. 失敗 → `recordSecurityEvent('login_failed', ..., { scope: '2fa' })`。

### 8.5 `POST /api/auth/2fa/disable` — 無効化

| 項目 | 値 |
|---|---|
| 認可 | `requireAuth: true` |
| 強い再認証 | **必須**（`requireStrongReauth`。Phase 5 はパスワード再認証 ＋ コード・D-33-23） |
| body | `{ "code": "123456" }`（TOTP またはリカバリーコード） |
| レート制限 | `twoFactor` |

```json
{ "success": true, "data": { "enabled": false } }
```

- **処理順（この順序を守る・D-33-25）**:
  1. `requireStrongReauth({ user, session, code })`。ここで **`REAUTH_REQUIRED`（401）または `INVALID_CODE`（400）** に落ちる。
  2. 成功したら `deleteTotp(userId)` ＋ `deleteAllRecoveryCodes(userId)`。
  3. `recordSecurityEvent('2fa_disabled')` ＋ 通知メール（best-effort）。
- **コード検証に失敗したら何も変更しない**（D-33-14）。検証で消費したコードは**戻さない**（消費済みでよい。失敗の連打はレート制限が抑える）。

### 8.6 `POST /api/auth/2fa/recovery-codes/regenerate` — 再生成

| 項目 | 値 |
|---|---|
| 認可 | `requireAuth: true` |
| 強い再認証 | **必須**（`requireStrongReauth`・D-33-23） |
| body | `{ "code": "123456" }`（**現在のコードを要求する**） |
| レート制限 | `twoFactor` |

```json
{ "success": true, "data": { "recovery_codes": ["...", "..."] } }
```

- **処理順**: `requireStrongReauth` → 既存を全削除 → 新 10 個を保存 → 平文を返す → `recordSecurityEvent('2fa_enabled', ..., { reason: 'regenerated' })` → 通知メール。
- **TOTP は有効のまま**（無効化はしない）。コードだけ入れ替える。

### 8.7 ログインの変更（`POST /api/auth/login`）

**2 つの分岐を足す。順序は「停止/削除 → 未確認 email → 2FA」**（停止・削除の判定は現行どおり先）。

#### (1) 未確認 email（D-33-21）

`email_verified = false`（`status = 'pending_email'`）なら、**セッションを発行せず** 403 を返す:

```json
{ "success": false, "error": { "code": "EMAIL_NOT_VERIFIED", "message": "メールアドレスの確認が必要です。" } }
```

- 応答の `data` に **`resend_available: true` と `email`** を含める必要があるため、§58 の統一形式に**追加フィールドを持たせる**。実装は `failResponse` ではなく `NextResponse.json` を直接使う:
  `{ success: false, error: {...}, data: { email, resend_available: true } }`
- **`login_failed` を記録する**（パスワードは正しいがログイン未完了）。`metadata: { reason: 'email_unverified' }`。
- **レート制限の失敗予約は「成功」として確定する**（パスワードは正しいので、誤入力のカウントを消費させない）。
- 画面は `EmailUnverifiedNotice` を出し、**同じ email を prefill して**再送ボタンを押させる（§12.4）。

#### (2) 2FA 有効（D-33-07）

`email_verified = true` かつ 2FA 有効なら、保留セッション（`totp_pending = true`）を発行する:

```json
{ "success": true, "data": { "twoFactorRequired": true } }
```

- **`reauth_verified_at` は立てない**（2FA 完了前は再認証済みとみなさない）。
- 応答は **`login_success` を記録しない**（まだログイン完了ではない）。`login_success` は昇格時に記録する。
- **新規デバイス通知は昇格後に送る**（保留段階では送らない。2FA 未完了の端末を「新規デバイス」として通知すると誤解を招く）。→ `challenge/verify` の成功時に `isFirstSessionFromDevice` / `notifyNewDeviceLogin` を呼ぶ。
- **列挙対策**: 2FA 有効/無効で応答が変わるが、これは**パスワード認証成功後**の情報であり、列挙には使えない（攻撃者はパスワードを知っている必要がある）。未確認 email の分岐も同様。

#### (3) 2FA 無効・確認済み

**現行の応答を完全に維持する**（`{ message: 'ログインしました' }`）。既存テストを壊さない（R7）。

### 8.8 エラーコード一覧（Phase 5 で使う）

| コード | HTTP | 発生条件 |
|---|---|---|
| `INVALID_CODE` | 400 | TOTP / リカバリーコード不一致（**区別しない**）。`disable` / `regenerate` のコード誤りもこれ |
| `TOTP_REQUIRED` | 403 | 保留セッションで 2FA 以外の認証済み操作を呼んだ（D-33-08） |
| `TOTP_ALREADY_ENABLED` | 409 | 有効化済みで `setup` を呼んだ（D-33-16） |
| `EMAIL_NOT_VERIFIED` | 403 | **未確認 email でログインした**（D-33-21）／未確認 email で `setup` を呼んだ（D-33-06） |
| `REAUTH_REQUIRED` | 401 | 強い再認証のパスワードが未了（`disable` / `regenerate`・D-33-25） |
| `RATE_LIMITED` | 429 | 既存（2FA 入力 10/5分・再送） |
| `CSRF_FAILED` | 403 | 既存（全 POST） |

> `TOTP_REQUIRED` / `TOTP_ALREADY_ENABLED` / `EMAIL_NOT_VERIFIED` は `src/lib/errors.ts` の **3 か所**（`ERROR_CODES` / `ERROR_STATUS` / 既定メッセージ）に追加する。`errors.test.ts` が全 `ERROR_CODES` の既定メッセージを走査するので、追加漏れはテストで落ちる。

### 8.9 `POST /api/auth/resend-verification` — 確認メール再送（未認証対応・D-33-22）

| 項目 | 値 |
|---|---|
| 認可 | **`requireAuth: false`**（未認証でも呼べる。§5.2） |
| body | `{ "email": "alice@example.com" }`（`captchaToken` は任意） |
| レート制限 | `resend.ip`（既存）＋ **`resendEmail(email)`（新設）** |
| 保留セッション | **許可**（`requireAuth: false` なので保留セッションでも通る） |

```json
{ "success": true, "data": { "message": "確認メールを送信しました" } }
```

- **応答は常に同一**（存在しない email / 確認済み / 停止中 / 削除済みでも同じ 200）。列挙対策（§46）。
- 実際に送るのは **`status = 'pending_email'` かつ `email_verified = false`** のときだけ。
- **認証済みセッションからの呼び出し（旧経路）も壊さない**: `body.email` が無く `session.user` がある場合は、その user を対象にする（後方互換）。
- `security_events` は **`captcha_challenged` / `rate_limited`** のみ記録（成功は記録しない。列挙の材料を残さない）。`user.id` が確定できる場合のみ `user_id` を入れる。

---

## 9. フロー設計

### 9.1 有効化（setup → verify）

```text
/settings/security
   │  利用者が「2FA を有効にする」を押す
   ▼
POST /api/auth/2fa/setup          （requireAuth / email_verified 必須）
   │  ├─ 既に enabled → 409 TOTP_ALREADY_ENABLED
   │  ├─ secret 生成 → AES-256-GCM で暗号化 → totp 行を upsert（enabled=false）
   │  └─ { secret, otpauth_uri, qr_svg } を返す
   ▼
TwoFactorPanel: QR を表示 ＋「シークレットを手入力」も用意（カメラが無い端末向け）
   │  利用者が認証アプリで読み取り、6 桁を入力
   ▼
POST /api/auth/2fa/verify         （body: { code }）
   │  ├─ verifyAndConsumeTotp()（atomic）
   │  ├─ 失敗 → 400 INVALID_CODE（画面はコード欄をクリアして再入力）
   │  ├─ 成功 → enabled=true, confirmed_at=now()
   │  │        ＋ recovery_codes 10 個を保存（同一トランザクション）
   │  │        ＋ security_events: 2fa_enabled
   │  │        ＋ 通知メール（best-effort）
   │  └─ { enabled: true, recovery_codes: [10 個] }
   ▼
RecoveryCodesDisplay: 10 個を表示（コピー / 印刷 / ダウンロード）
   │  「保存しました」チェックを入れないと閉じられない（消えると復旧不能のため）
   ▼
/settings/security の 2FA カードが「有効」になる
```

### 9.2 ログイン（2 段階）

```text
/login
   │  メール + パスワード
   ▼
POST /api/auth/login
   │  ├─ 停止/削除 → 403 ACCOUNT_SUSPENDED（現行どおり）
   │  ├─ 未確認 email → 403 EMAIL_NOT_VERIFIED
   │  │     ＋ data: { email, resend_available: true }
   │  │     ＋ login_failed(reason=email_unverified)
   │  │     ＋ セッションは発行しない
   │  │     → 画面は EmailUnverifiedNotice（再送ボタン）へ
   │  ├─ 2FA 無効 → 従来どおりセッション発行（totp_pending=false）→ 200
   │  └─ 2FA 有効 → セッション発行（totp_pending=true, reauth_verified_at=null）
   │                ＋ login_success は記録しない
   │                ＋ 新規デバイス通知も保留
   │                → 200 { twoFactorRequired: true }
   ▼
/login（クライアント）: AuthForm が TotpLoginStep を描画
   │  6 桁 or リカバリーコードを入力
   ▼
POST /api/auth/2fa/challenge/verify   （denyTotpPending: false）
   │  ├─ 6 桁 → verifyAndConsumeTotp()（atomic・replay 拒否）
   │  ├─ それ以外 → consumeRecoveryCode()（atomic・1 回限り）
   │  ├─ 失敗 → 400 INVALID_CODE ＋ security_events: login_failed(scope=2fa)
   │  │          ＋ レート制限を 1 消費（10/5分）
   │  └─ 成功 → totp_pending=false ＋ login_success(method=...)
   │           ＋ 新規デバイスなら通知（ここで初めて送る）
   │           ＋ リカバリー使用時は残数を返す（<3 で警告）
   ▼
トップへリダイレクト（認証済み）
```

### 9.2b 未確認 email（D-33-21 / D-33-22）

```text
/login（メール + パスワード）
   │  パスワードは正しいが email 未確認
   ▼
403 EMAIL_NOT_VERIFIED ＋ { email, resend_available: true }
   ▼
EmailUnverifiedNotice: 「メールアドレスの確認が必要です」
   │  email は prefill 済み（打ち直させない）
   │  「確認メールを再送する」を押す
   ▼
POST /api/auth/resend-verification   （requireAuth: false・body: { email }）
   │  ├─ 存在しない / 確認済み / 停止中 → 200（同一メッセージ。列挙対策）
   │  ├─ 未確認 → トークン再発行 → 確認メール送信
   │  └─ レート制限: resendEmail(email) 5/1h ＋ resend.ip 10/1h
   ▼
「確認メールを送信しました」＋ /verify-email への導線
   │  利用者がメールのリンクを開く → /verify-email?token=... → POST で確定
   ▼
/login に戻ってログインし直す（email_verified = true になったため通る）
```

### 9.3 無効化・再生成（強い再認証・D-33-23）

```text
/settings/security（2FA カード「有効」）
   │  「無効にする」/「リカバリーコードを再生成」
   ▼
StrongReauthDialog（新規・strong-reauth-dialog.tsx）
   │  出す手段は GET /api/auth/2fa の strong_reauth_methods（Phase 5 は ['password']）
   │  パスワード欄 ＋ コード欄（6 桁 or リカバリーコード）を 1 画面で要求
   ▼
POST /api/auth/2fa/disable  or  /2fa/recovery-codes/regenerate
   │  body: { code }（パスワードは別途 reauth で先に通す）
   │
   ├─ (1) パスワード再認証が未了 → 401 REAUTH_REQUIRED
   │        → UI はパスワード欄を強調し、POST /api/auth/reauth（既存）へ
   │        → 成功で session.reauth_verified_at = now()（5 分）
   │        → そのまま同じリクエストを再送（コード欄は保持）
   │
   ├─ (2) 再認証済み・コード誤り → 400 INVALID_CODE
   │        → UI はコード欄をクリアして再入力
   │
   └─ (3) 両方通る → requireStrongReauth が { method: 'password' } を返す
            ├─ disable: totp 行 + recovery_codes を削除
            ├─ regenerate: recovery_codes を全削除 → 新 10 個を保存・返す
            ├─ security_events: 2fa_disabled / 2fa_enabled(reason=regenerated)
            └─ 通知メール
   ▼
カードが「無効」/ 新しいコードが表示される
```

> **Phase 6 での差分**: `strong_reauth_methods` に `'passkey'` が加わり、`StrongReauthDialog` が Passkey タブを出す。**API ルートは無変更**（D-33-24）。Passkey で通した場合は `code` を要求しない（`requireStrongReauth` が Passkey 検証器で成功する）。

### 9.4 保留セッションの封じ込め（D-33-08 の詳細）

```text
runCorePipeline(deps, { requireAuth: true }, handler)
   │
   ├─ session = await getSession(token)
   ├─ if (!session) → 401 SESSION_EXPIRED
   ├─ if (session.totpPending && options.denyTotpPending !== false)   ← ★ 追加
   │      → 403 TOTP_REQUIRED
   ├─ user = await findUserById(session.userId)
   ├─ requireReauth → checkReauth(session)
   └─ handler(...)
```

- **既定で拒否**（`denyTotpPending` の既定は `true`）。許可するのは次の 6 経路のみ:

| 経路 | 理由 |
|---|---|
| `POST /api/auth/2fa/challenge/verify` | 昇格そのもの |
| `POST /api/auth/logout` | 保留状態から**抜けられる**必要がある（共有端末対策） |
| `POST /api/auth/logout-all` | 同上 |
| `GET /api/auth/csrf` | POST に必要な CSRF トークンの取得（副作用なし） |
| `GET /api/auth/me` | 画面が「保留中」を判定するために読む（secret を返さない） |
| `POST /api/auth/resend-verification` | `requireAuth: false` のため `denyTotpPending` の判定対象外（未認証でも呼べる・D-33-22） |

- これ以外の認証済み操作（設定変更、セッション一覧、OIDC クライアント操作、`settings/*` 画面）は **403**。
- **`settings/layout.tsx` のサーバ側ガードにも同じ判定を入れる**（画面遷移でも弾く。API だけだと画面が表示されてから 403 が連発して混乱する）。

> **注意**: `denyTotpPending` を `false` にするのは上記のうち **`requireAuth: true` の 5 経路のみ**（`challenge/verify` / `logout` / `logout-all` / `csrf` / `me`）。**他の API で明示的に `false` を渡してはいけない**（テストで「`false` を渡すルートはホワイトリストのみ」を静的に検査する。§11.3）。`resend-verification` は `requireAuth: false` なので、そもそも判定に入らない。

---

## 10. セキュリティ設計（脅威モデル）

仕様 §48「2FA」の 4 項目（TOTP 誤入力 / 回避試行 / リカバリーコード再利用 / 無効化時の再認証）に、Phase 5 で新たに生じる脅威を足して整理する。

| # | 脅威 | 攻撃シナリオ | 対策 | 検証 |
|---|---|---|---|---|
| T1 | TOTP 誤入力 | 利用者が桁を間違える | 失敗は 400 `INVALID_CODE`。コード欄をクリアして再入力を促す。レート制限は 10/5分なので誤入力では即ロックされない | `2fa.test.ts` |
| T2 | TOTP 総当たり | 6 桁 = 100 万通りを総当たり | `rateLimitKeys.twoFactorUser` で 10/5分。1 ウィンドウ（30 秒）内に有効なコードは 3 個（±1）しかないため、10 回/5分では成功率は無視できる | `2fa-bruteforce.test.ts` |
| T3 | 同一コードの並行送信（race） | 正しいコードを取得し、同時に 2 リクエスト送って両方成功させる（セッション 2 本を取る） | `last_used_counter` を単文 UPDATE の更新行数で消費（D-33-04）。2 本目は 0 行更新 → `INVALID_CODE` | `2fa-concurrent-replay.test.ts` |
| T4 | リカバリーコード再利用 | 使用済みコードをもう一度使う | `UPDATE ... WHERE used_at IS NULL` の更新行数 = 1 でのみ成功（D-33-12） | `recovery-code-reuse.test.ts` |
| T5 | リカバリーコード総当たり | コード空間を総当たり | 各コードは 160 bit。仮に短くても 2FA と同じレート制限を共有する | `2fa-bruteforce.test.ts` |
| T6 | 2FA 無効化によるダウングレード | セッションを窃取した攻撃者が 2FA を外す | 再認証必須 ＋ 現在のコード必須（D-33-14）。セッション窃取だけでは外せない | `2fa-disable-reauth.test.ts` |
| T7 | `setup` による secret 差し替え | 攻撃者が `setup` を呼んで自分のアプリに secret を登録し、2FA を乗っ取る | 有効化済みなら 409（D-33-16）。無効化にはコードが要るので、`setup` で上書きできない | `2fa.test.ts` |
| T8 | 保留セッションの素通り | パスワードだけで保留セッションを取得し、設定変更や OIDC 認可を通す | パイプラインで既定拒否（D-33-08）＋ OIDC の SQL に `totp_pending = false`（D-33-09） | `2fa-pending-session.test.ts` |
| T9 | secret の漏洩（DB） | DB ダンプから secret を読む | AES-256-GCM。鍵は DB に無い（env / Secret Manager・§13.1） | `totp-crypto.test.ts` |
| T10 | secret の漏洩（ログ / API 応答） | secret / コードがログ・応答・metadata に出る | `logger.ts` の `SENSITIVE_KEYS` に追加（D-33-20）。API は `setup` のときだけ secret を返す。`metadata` にコードを入れない | `2fa-secret-leak.test.ts` |
| T11 | リカバリーコードの奪取（XSS / 中間者） | 画面に表示されたコードを窃取 | コード表示は 1 回だけ、`Cache-Control: no-store`。CSP は既存（Phase 2）。コードを API で再取得できない | `2fa-secret-leak.test.ts` |
| T12 | 時計ずれによる締め出し | 端末の時計がずれてコードが合わない | window ±1（前後 30 秒）。それ以上ずれると合わないが、リカバリーコードで復旧できる | `totp.test.ts` |
| T13 | `last_used_counter` の巻き戻し | ±1 の許容を使い、古い counter で新しい counter を上書きして replay 可能にする | `last_used_counter < c` の単調増加のみ許可（D-33-04）。古い counter は 0 行更新 | `2fa-concurrent-replay.test.ts` |
| T14 | 2FA 完了前の `login_success` 記録 | 監査ログが「ログイン成功」を早く記録し、2FA 未完了を見落とす | 保留セッション発行時は `login_success` を記録しない。昇格時に記録する（§8.7） | `2fa.test.ts` |
| T15 | CSRF | 罠ページから `disable` / `regenerate` を叩く | 全 POST が共通パイプラインの CSRF 検証を通る（§25）。2FA だから例外にしない | 既存 `csrf.test.ts` ＋ 2FA の 3 テスト |
| T16 | 列挙（2FA 有効/無効） | `/login` の応答差で「2FA を使っているアカウント」を特定 | 応答差はパスワード認証成功後にのみ現れる。パスワードを知らない攻撃者には見えない（§8.7） | `login` の既存テスト |
| T17 | `email_verified` 前の 2FA 有効化 | メール未確認のアカウントに 2FA を付ける（復旧不能） | `setup` で `email_verified = true` を要求（D-33-06） | `2fa.test.ts` |
| T18 | **未確認 email のまま使い続ける** | 他人のメールで登録し、確認せずに使う | 未確認はログインさせない（403 `EMAIL_NOT_VERIFIED`・D-33-21）。**セッションを発行しない** | `email-unverified-login.test.ts` |
| T19 | **未確認ユーザーの締め出し（可用性）** | ログイン不可にした結果、再送もできず復帰不能になる | `resend-verification` を `requireAuth: false` にする（D-33-22）。**`register` がセッションを発行しない**ため必須 | `resend-unauthenticated.test.ts` |
| T20 | **再送 API による列挙** | 再送の応答差で「登録済みメール」を特定 | 応答を**完全に同一**にする（存在しない/確認済み/停止中/削除済みでも同じ 200・§46） | `resend-unauthenticated.test.ts` |
| T21 | **再送 API の悪用（スパム / メール爆弾）** | 他人のメールに確認メールを大量送信 | `resendEmail(email)` 5/1h ＋ `resend.ip` 10/1h の 2 重制限（D-33-22）。CAPTCHA hook も既存どおり | `resend-unauthenticated.test.ts` |
| T22 | **セッション窃取だけで 2FA を外す** | 窃取したセッションで `disable` を呼び、2FA を無効化する | **パスワード ＋ 現在のコード**の強い再認証（D-33-23）。窃取セッションだけでは通らない | `2fa-disable-reauth.test.ts` |
| T23 | **コードの消費タイミング誤り** | `disable` の失敗時にもコードを消費し、正規のコードを失わせる | **検証成功後にのみ本体処理**（§8.5 の順序）。失敗時は DB を変更しない | `2fa-disable-reauth.test.ts` |
| T24 | **未確認 email の情報漏洩** | 403 応答の `data.email` から登録済みメールを確認 | `data.email` は**パスワード認証成功後にのみ**返る。攻撃者はパスワードを知る必要がある（§8.7） | `email-unverified-login.test.ts` |

### 10.1 §45（情報漏洩防止）のチェック

- TOTP secret / リカバリーコードを `security_events.metadata` に入れない（`method` / `scope` / `reason` / `remaining` のみ）。
- 通知メール本文にコード・secret を入れない（既存の `sendChangeNotificationEmail` は「変更があった」旨のみ）。
- `src/lib/util/logger.ts` の `SENSITIVE_KEYS` を更新する（D-33-20）。
- API 応答の secret は `setup` のみ、コードは `verify` / `regenerate` のみ。どちらも `no-store`。

---

## 11. テスト設計

### 11.1 新規テストファイル（14）

| # | パス | 種別 | 主なケース |
|---|---|---|---|
| 1 | `src/test/unit/totp.test.ts` | unit | secret 生成の形式 / `otpauth://` URI の構造 / window ±1 の境界（30 秒前・現在・30 秒後は成功、60 秒前は失敗）/ `delta` から counter が正しく決まる |
| 2 | `src/test/unit/totp-crypto.test.ts` | unit | 暗号化 → 復号の往復 / 同じ平文で暗号文が毎回変わる（nonce がランダム）/ 改竄（tag 書換）で throw / 形式不正で throw |
| 3 | `src/test/unit/totp-qr.test.ts` | unit | `otpauthUriToSvg` が `<svg` を含む文字列を返す / 同じ URI で決定的 / **`qrcode` に渡す引数が正しい**（`type: 'svg'` / 誤り訂正 M）/ 失敗時に `INTERNAL_ERROR` に丸まる |
| 4 | `src/test/unit/recovery-codes.test.ts` | unit | 10 個生成 / 形式（`XXXXX-XXXXX-XXXXX-XXXXX`）/ 全て異なる / 正規化（小文字・空白・ハイフン無しでも同じ）/ ハッシュが決定的 |
| 5 | `src/test/unit/strong-reauth.test.ts` | unit | `availableStrongReauthMethods` が Phase 5 で `['password']` / 再認証未了で `REAUTH_REQUIRED` / 再認証済み＋コード誤りで `INVALID_CODE` / **検証器配列の拡張点**（テスト用の 2 つ目の検証器を足すと通る） |
| 6 | `src/test/security/2fa.test.ts` | security | setup → verify → 有効化の一連 / 未確認 email は 403 / 有効化済み setup は 409 / 誤コードは 400 / `login_success` は昇格時のみ / 状態取得の残数と `strong_reauth_methods` |
| 7 | `src/test/security/2fa-concurrent-replay.test.ts` | security | ★ 同一コードを 2 並行送信 → 成功 1・他方 400 `INVALID_CODE`（D-16 の核） |
| 8 | `src/test/security/2fa-bruteforce.test.ts` | security | 10 回失敗で 11 回目が 429 / `rate_limited` が記録される / ウィンドウ経過で回復 |
| 9 | `src/test/security/2fa-disable-reauth.test.ts` | security | **再認証なし → 401 `REAUTH_REQUIRED`** / 再認証ありでもコード誤り → 400 `INVALID_CODE` で**無効化されない** / **失敗時にコードが消費されない**（T23）/ 両方通れば無効化＋`2fa_disabled`＋通知 / **リカバリーコードでも無効化できる** |
| 10 | `src/test/security/recovery-code-reuse.test.ts` | security | 1 回目成功・2 回目失敗 / 使用済みは残数から減る / 残数 <3 で警告フラグ |
| 11 | `src/test/security/2fa-pending-session.test.ts` | security | 保留セッションで `settings` / `sessions` / `oauth/link` が 403 `TOTP_REQUIRED` / `logout`・`csrf`・`me` は通る / OIDC 認可が通らない（D-33-09） |
| 12 | `src/test/security/2fa-secret-leak.test.ts` | security | 応答・ログ・`metadata` に secret / コードが出ない / `logger.redact` が新キーを伏せる |
| 13 | `src/test/security/email-unverified-login.test.ts` | security | **未確認ログインが 403 `EMAIL_NOT_VERIFIED`** でセッションが発行されない / 応答に `resend_available` と `email` / `login_failed(reason=email_unverified)` が記録される / **確認済みは従来どおり 200** |
| 14 | `src/test/security/resend-unauthenticated.test.ts` | security | **未認証で再送できる** / 存在しない email・確認済み・停止中でも**同じ 200** / 未確認にだけ送信される / `resendEmail` 5/1h と `resend.ip` 10/1h が効く / `pending_email` 以外にトークンを発行しない |

> ファイル数は **14**。§0 は要旨のため簡略化している。

### 11.2 既存テストへの追記・**期待値の反転**

| パス | 対応 |
|---|---|
| `src/test/security/deleted-account-login.test.ts` | **反転**: `'email 未認証（pending_email）は確認メール再送のためログインできる'`（200 期待）を **403 `EMAIL_NOT_VERIFIED` 期待**に変え、テスト名を「email 未認証は 403 で止まる」に変更（§5.2） |
| `src/test/security/log-redaction.test.ts` | `secret` / `secretEncrypted` / `otpauthUri` / `recoveryCodes` / `recoveryCode` を伏せる |
| `src/test/unit/errors.test.ts` | 新コード 3 つが `ERROR_CODES` にあり、既定メッセージを持つ（既存のループが自動で拾う） |
| `src/test/security/rate-limit.test.ts` | `RATE_LIMITS.twoFactor`（10/300_000）と `RATE_LIMITS.resend.email`（新設なら値） |
| `src/test/security/session-management.test.ts` ほか SessionData フィクスチャ 7 ファイル | `totpPending: false` を足す（型追加のため必須） |
| `src/test/security/security-events-coverage.test.ts` | `2fa/**` のルートが `recordSecurityEvent` を呼ぶこと。**`resend-verification` の記録対象が変わる**（`user.id` が無い場合は `null`）ため期待値を更新 |
| `src/test/security/enumeration.test.ts` | 再送 API の列挙耐性ケースを追加（既存の login/register と並べる） |

### 11.3 静的な検査（回帰防止）

| 検査 | 内容 |
|---|---|
| `denyTotpPending: false` の使用箇所 | `2fa/challenge/verify` / `logout` / `logout-all` / `csrf` / `me` の **5 つだけ**であることをソース走査で固定（新ルートが抜け穴を作るのを防ぐ） |
| TOTP secret の応答 | `secret` を含む JSON を返すルートが `2fa/setup` だけであること |
| クライアントバンドル | `otpauth` / `qrcode` / `totp-crypto` がクライアントコンポーネントから import されていないこと（BUG-11 の再発防止。`oauth-client-boundary.test.ts` と同じ方式）。**`qrcode` はサーバ専用**（`setup` ルートでのみ使う） |
| **未確認ログインの遮断** | `login/route.ts` に `emailVerified` の判定があること（将来の改修で抜けないよう固定） |
| **再送の認可** | `resend-verification/route.ts` が `requireAuth: false` であること |

### 11.4 テストの実装方式

- 既存の `src/test/helpers/app-server.ts`（実 HTTP）を使う。`cookies()` を直接呼ぶテストは 500 になるため、`request.cookies` / `Set-Cookie` で扱う（BUG-15 / D-32-17）。
- 時刻依存（window・counter）は `vi.useFakeTimers()` + `vi.setSystemTime()` で固定する（`実装Todo.md` P8-07 の「fake timers で flaky 防止」を Phase 5 で先取り）。
- 並行テスト（#6）は `Promise.all` で 2 リクエストを同時に投げ、成功数が 1 であることを数える。DB の行ロックが効くので `fileParallelism: false` と併用する。

---

## 12. UI 設計

### 12.1 `/settings/security` の 2FA カード

| 状態 | 表示 | 操作 |
|---|---|---|
| 無効 | 「無効」＋説明（§13） | 「2FA を有効にする」 |
| setup 中（未確認） | QR ＋ シークレット（手入力用）＋ 6 桁入力 | 「有効化」/「キャンセル」 |
| 有効 | 「有効」＋ リカバリーコード残数（`n 件`） | 「リカバリーコードを再生成」/「無効にする」 |
| 有効＋残数 <3 | 「有効」＋警告色で「残り n 件。再生成してください」 | 同上 |

- 既存の `security-overview.tsx` の 2FA カードを `<TwoFactorPanel />` に差し替える（`notAvailable` の文言を削除）。
- 無効化・再生成は **`StrongReauthDialog`**（パスワード ＋ コード・D-33-23）を使う（§9.3）。**既存の `ReauthDialog`（パスワードのみ）は流用しない**（コード欄が無いため）。`ReauthDialog` は他の用途（メール変更等）で残す。

### 12.2 リカバリーコード表示（`RecoveryCodesDisplay`）

- 10 個を 1 画面に全部表示（`grid-cols-2`）。コピー / 印刷 / テキスト保存。
- 「保存しました」チェックを入れるまで閉じられない（閉じたら二度と表示できないため）。
- 「このコードは 1 度しか表示されません」を明示。

### 12.3 `/login` の 2 段階 UI

- `AuthForm` の成功応答が `twoFactorRequired: true` なら、同じページ内で `TotpLoginStep` に切り替える（`TotpChallengeForm` を接続）。
- 「リカバリーコードを使う」リンクで同じ入力欄を切り替え（`inputMode` を `text` に）。
- 戻る導線（「別のアカウントでログイン」= `logout` を呼んで `/login` に戻る）。

### 12.4 未確認 email の案内（`EmailUnverifiedNotice`・D-33-21 / D-33-22）

`/login` で 403 `EMAIL_NOT_VERIFIED` を受けたとき、`AuthForm` のエラー表示の代わりにこのコンポーネントを出す。

| 要素 | 内容 |
|---|---|
| 見出し | **「メールアドレスの確認が必要です」**（ユーザー指示の文言をそのまま使う） |
| 本文 | 「`{email}` に確認メールを送信しました。メール内のリンクから登録を完了してください。」 |
| email | **prefill 済み・読み取り専用**（打ち直させない。403 応答の `data.email` をそのまま使う） |
| ボタン | 「確認メールを再送する」→ `POST /api/auth/resend-verification { email }` |
| 再送後 | 「確認メールを送信しました」＋（`resendTooMany` なら）「再送信できる回数を超過しました」 |
| 補助リンク | 「別のアカウントでログイン」（フォームを初期状態に戻す） |

- **`data.email` が無い場合は表示しない**（古いサーバとの互換。この場合だけ通常のエラー表示にフォールバック）。
- 再送は **1 画面で完結**させる（`/verify-email` に飛ばさない。あのページはトークン前提のため）。
- `resend_available` が `false` / 未定義なら再送ボタンを**出さない**（将来の互換用）。
- **`aria-live="polite"`** で再送結果を読み上げる（`VerifyEmailForm` と同じ方針）。

### 12.5 文言（`src/messages/ja.ts`）

```ts
twoFactor: {
  title: '2 段階認証',
  enabled: '有効',
  disabled: '無効',
  enable: '2FA を有効にする',
  disable: '無効にする',
  setupInstruction: '認証アプリで QR コードを読み取り、表示された 6 桁を入力してください。',
  manualSecret: 'QR コードを読み取れない場合は、このシークレットを手入力してください。',
  codeLabel: '認証コード（6 桁）',
  verify: '有効化',
  recoveryCodesTitle: 'リカバリーコード',
  recoveryCodesWarning: 'このコードは 1 度しか表示されません。安全な場所に保存してください。',
  recoveryCodesRemaining: '残り {count} 件',
  recoveryCodesLow: 'リカバリーコードの残りが少なくなっています。再生成してください。',
  regenerate: 'リカバリーコードを再生成',
  savedConfirm: '安全な場所に保存しました',
  useRecoveryCode: 'リカバリーコードを使う',
  useTotpCode: '認証アプリのコードを使う',
  challengeTitle: '2 段階認証',
  challengeInstruction: '認証アプリに表示された 6 桁のコードを入力してください。',
  // 強い再認証（D-33-23）
  strongReauthTitle: '本人確認',
  strongReauthInstruction: '無効化・再生成には、パスワードと現在のコードが必要です。',
  strongReauthPassword: 'パスワード',
  strongReauthCode: '現在のコード（6 桁またはリカバリーコード）',
  strongReauthSubmit: '実行する',
  // 未確認 email（D-33-21 / D-33-22）
  emailNotVerifiedTitle: 'メールアドレスの確認が必要です',
  emailNotVerifiedBody: '{email} に確認メールを送信しました。メール内のリンクから登録を完了してください。',
  emailNotVerifiedResend: '確認メールを再送する',
  emailNotVerifiedBack: '別のアカウントでログイン',
},
```

---

## 13. タスク分解と工数

`実装Todo.md` の P5-A-01 / P5-A-02 を起点に、実装順に分解する。★ は DoD 直結。

### 13.1 P5-A: 基盤（4.8h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P5-A-01 | `package.json` に `otpauth` / `qrcode`（＋`@types/qrcode`）を追加 | — | 0.3h | `pnpm install` が通り、型が解決する |
| P5-A-02 | `drizzle/0017_totp.sql` ＋ `schema.ts` ＋ `verify-migrations.ts` 期待値 | — | 1.0h | `pnpm db:migrate` と `pnpm db:verify-migrations` が green |
| P5-A-03 | `src/lib/auth/totp-crypto.ts`（AES-256-GCM） | — | 0.8h | `totp-crypto.test.ts` green |
| P5-A-04 | `src/lib/auth/totp.ts`（生成 / URI / atomic 消費） | A-01, A-03 | 1.5h | `totp.test.ts` green。atomic 更新が単文 SQL |
| P5-A-05 | `src/lib/auth/recovery-codes.ts` | — | 0.8h | `recovery-codes.test.ts` green |
| P5-A-06 | `src/lib/auth/totp-qr.ts`（`qrcode` の薄いラッパ） | A-01 | 0.4h | `totp-qr.test.ts` green（SVG が返る・引数が正しい） |

### 13.2 P5-B: API とフロー（10.3h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P5-B-01 | `src/lib/db/queries/{totp,recovery-codes}.ts` | A-02 | 1.0h | 各クエリが統合テストで動く（atomic 消費含む） |
| P5-B-02 | `src/lib/validate/totp.ts` ＋ `errors.ts` に 3 コード | — | 0.4h | `errors.test.ts` green |
| P5-B-03 | `logger.ts` の redaction 追加 | — | 0.3h | `log-redaction.test.ts` green |
| P5-B-04 | `SessionData.totpPending` ＋ `getSession` SELECT | — | 0.5h | 型が通り、既存フィクスチャ 7 ファイルを更新 |
| P5-B-05★ | `pipeline.ts` の `denyTotpPending` ＋ `settings/layout.tsx` の判定 | B-04 | 1.2h | `2fa-pending-session.test.ts` green |
| P5-B-06★ | `oidc/session.ts` に `totp_pending = false` | B-04 | 0.3h | OIDC 認可が保留セッションを通さない |
| P5-B-07 | `GET /2fa` / `POST /2fa/setup` | B-01, B-02 | 1.0h | `2fa.test.ts`（setup 部分）green。`strong_reauth_methods` を返す |
| P5-B-08 | `POST /2fa/verify`（＋リカバリーコード発行を同一 Tx） | B-07 | 1.2h | `2fa.test.ts`（verify 部分）green |
| P5-B-09★ | `POST /2fa/challenge/verify`（TOTP / リカバリー両対応） | B-08 | 1.0h | `recovery-code-reuse.test.ts` green |
| P5-B-10★ | `src/lib/auth/strong-reauth.ts`（検証器配列・D-33-24） | B-01 | 1.0h | `strong-reauth.test.ts` green |
| P5-B-11 | `POST /2fa/disable`（強い再認証） | B-09, B-10 | 0.8h | `2fa-disable-reauth.test.ts` green |
| P5-B-12 | `POST /2fa/recovery-codes/regenerate`（強い再認証） | B-11 | 0.6h | 再生成で旧コードが無効 |
| P5-B-13★ | `login` の 2 段階化（保留セッション発行） | B-05 | 1.0h | `2fa.test.ts`（login 部分）green |

### 13.3 P5-B2: 未確認 email と再送（2.6h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P5-B2-01★ | `login` に未確認分岐（403 `EMAIL_NOT_VERIFIED` ＋ `data.email` / `resend_available`） | B-13 | 0.8h | `email-unverified-login.test.ts` green。セッションを発行しない |
| P5-B2-02★ | `resend-verification` を `requireAuth: false` 化 ＋ `resendEmail` キー新設 | B2-01 | 1.0h | `resend-unauthenticated.test.ts` green。既存の認証済み経路も壊さない |
| P5-B2-03 | `validate/resend.ts` ＋ `rate-limit-keys.ts` 追記 | — | 0.4h | 型が通る |
| P5-B2-04 | `deleted-account-login.test.ts` の**期待値反転**（§5.2） | B2-01 | 0.4h | 403 期待に変更し green |

### 13.4 P5-C: セキュリティテスト（5.0h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P5-C-01★ | `2fa-concurrent-replay.test.ts`（2 並行 → 成功 1） | B-08 | 1.2h | green（DoD 直結） |
| P5-C-02 | `2fa-bruteforce.test.ts`（10/5分） | B-09 | 0.8h | green |
| P5-C-03 | `2fa-secret-leak.test.ts` | B-08 | 0.6h | green |
| P5-C-04 | `2fa-disable-reauth.test.ts`（T22 / T23 含む） | B-11 | 0.6h | green |
| P5-C-05 | `rate-limit.test.ts` / `security-events-coverage.test.ts` への追記 | C-01 | 0.4h | green |
| P5-C-06 | `email-unverified-login.test.ts` | B2-01 | 0.6h | green |
| P5-C-07 | `resend-unauthenticated.test.ts`（列挙耐性・スパム耐性） | B2-02 | 0.8h | green |

### 13.5 P5-D: UI（5.1h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P5-D-01 | `TwoFactorPanel` ＋ `security-overview.tsx` 差し替え | B-08 | 1.5h | setup → QR → 有効化が画面で動く |
| P5-D-02 | `RecoveryCodesDisplay`（保存チェック付き） | D-01 | 0.8h | 10 個が表示され、チェックまで閉じない |
| P5-D-03 | `StrongReauthDialog`（パスワード ＋ コード） | B-11 | 0.8h | 無効化・再生成が画面で通る |
| P5-D-04 | `TotpLoginStep` ＋ `auth-form.tsx` / `login/page.tsx` 接続 | B-13 | 1.0h | ログインが 2 段階で通る |
| P5-D-05 | `EmailUnverifiedNotice`（案内 ＋ 再送） | B2-02 | 0.8h | 未確認ログインで案内が出て再送できる |
| P5-D-06 | `messages/ja.ts` の文言追加 | — | 0.2h | 型安全に引ける |

### 13.6 合計

| 区分 | 工数 |
|---|---|
| P5-A 基盤 | 4.8h |
| P5-B API / フロー | 10.3h |
| P5-B2 未確認 email / 再送 | 2.6h |
| P5-C セキュリティテスト | 5.0h |
| P5-D UI | 5.1h |
| **合計** | **27.8h（約 4 日）** |

> 計画 `実装計画.md` §15 の見積もり「2〜3 日」を**上回る**。理由は **P5-B2（未確認 email の遮断と再送）が当初計画に無かった追加要件**であること、および `qrcode` 追加と強い再認証の共通入口（Phase 6 の布石）を含むこと。**計画側の見積もりを 4 日に更新することを推奨**（§17 改訂履歴）。

---

## 14. 完了定義（DoD）

計画 `実装計画.md` §15 の Phase 5 DoD を、確認可能な形に展開する。**すべて green で M5 達成**。

### 14.1 機能

- [ ] 利用者が `/settings/security` から TOTP を有効化できる（setup → QR → verify）
- [ ] 有効化時にリカバリーコード 10 個が**表示され**、DB にはハッシュのみ保存される
- [ ] 2FA 有効ユーザーのログインが 2 段階になる（パスワード → 保留セッション → 昇格）
- [ ] リカバリーコードで昇格でき、**使用したコードは即無効**になる
- [ ] 無効化・再生成が**パスワード ＋ 現在のコード**でできる（D-33-23）
- [ ] 残数 <3 で再生成を促す表示が出る
- [ ] **未確認 email のログインが 403 `EMAIL_NOT_VERIFIED` で止まり**、その場で確認メールを再送できる（D-33-21 / D-33-22）
- [ ] **未確認 email のユーザーが、ログインせずに確認メールを再送できる**（締め出されない）

### 14.2 セキュリティ（§48 / §64）

- [ ] **同一 TOTP コードの並行送信で成功が 1 件のみ**（`2fa-concurrent-replay.test.ts`）
- [ ] 2FA 無効化に**パスワード ＋ コード**が必要（`2fa-disable-reauth.test.ts`）
- [ ] **無効化の失敗時にコードが消費されない**（T23）
- [ ] リカバリーコードが 1 回限り（`recovery-code-reuse.test.ts`）
- [ ] 2FA 入力が 10/5分で制限される（`2fa-bruteforce.test.ts`）
- [ ] TOTP secret がログ / 管理画面 / API 応答に 1 件も現れない（`2fa-secret-leak.test.ts`）
- [ ] 保留セッションが他の認証済み操作を通さない（`2fa-pending-session.test.ts`）
- [ ] DB に平文 secret が無い（`totp-crypto.test.ts` ＋ `2fa.test.ts`）
- [ ] **未確認ログインでセッションが発行されない**（`email-unverified-login.test.ts`）
- [ ] **再送 API の応答が、存在しない / 確認済み / 停止中 / 削除済みで同一**（列挙耐性・`resend-unauthenticated.test.ts`）
- [ ] **再送 API に 2 重のレート制限**（`resendEmail` 5/1h ＋ `resend.ip` 10/1h）

### 14.3 品質ゲート（各 PR）

- [ ] `pnpm lint`（0 errors）
- [ ] `pnpm typecheck`
- [ ] `pnpm test`（既存 482 + Phase 5 の新規が green）
- [ ] `pnpm build`
- [ ] `pnpm db:verify-migrations`（0017 の up/down/往復）
- [ ] §20.3 の DoD チェックリスト（計画書）を全項目確認
  - 新規 API が `withAuthPipeline` / レート制限 / `require*` ガードを通っているか
  - 秘密情報がログ・応答・metadata に漏れていないか（§45）
  - 認可をサーバー側で行っているか（§49）
  - `security_events` へ記録しているか
  - 新テーブル/列に制約・index・migration があるか
  - mutation が POST/PUT/PATCH/DELETE か（§25）
  - **「1 回限り」の値が atomic 更新か（read-then-write していないか）**
  - エラーが統一形式（§58）か

### 14.4 実機での手動確認（実装後に実施）

1. 認証アプリ（Google Authenticator / 1Password 等）で QR を読み取り、有効化できる
2. ログアウト → ログイン → 6 桁入力で入れる
3. リカバリーコード 1 個で入れる → 同じコードで入れない
4. 残数が減る。3 未満で警告が出る
5. 無効化（**パスワード ＋ コード**）→ 次回ログインが 1 段階に戻る
6. 再生成 → 古いコードで入れない、新しいコードで入れる
7. **時計を 30 秒進めた端末でも入れる**（window ±1）
8. 保留セッション中に `/settings/security` を直接開くと弾かれる
9. **未確認のユーザーでログイン → 「メールアドレスの確認が必要です」が出る → 再送ボタンが押せる → メールが届く**（D-33-21 / D-33-22）
10. **未確認のユーザーがログアウト状態（セッション無し）でも、ログイン画面から再送できる**（締め出されない）
11. **無効化ダイアログで、まずコードを誤って入力 → エラーになり、2FA は有効のまま**（T23）

---

## 15. リスクと対策

| # | リスク | 影響 | 確率 | 対策 |
|---|---|---|---|---|
| R1 | **atomic 更新の実装ミス**（read → 判定 → write にしてしまう） | 並行 replay が成立。DoD 未達 | 中 | D-33-04 を単文 SQL で固定。`2fa-concurrent-replay.test.ts` を**最初に**書く（TDD） |
| R2 | `otpauth` の `validate` の `delta` の意味を取り違える | 誤った counter を消費し、正当なコードを弾く | 中 | `totp.test.ts` で ±1 の境界を 3 パターン固定。`delta` を counter に足す式をテストで明示 |
| R3 | QR 生成の引数ミス（`type: 'svg'` 忘れ・誤り訂正レベル違い） | アプリが読み取れない | 低 | `qrcode` に委譲（D-33-02）。`totp-qr.test.ts` で「`qrcode` に渡す引数」を検証し、生成 SVG に `<svg` が含まれることを確認 |
| R4 | 保留セッションの封じ込め漏れ（新ルート追加時） | 2FA 素通りの穴 | 中 | パイプラインで**既定拒否**（fail closed）。`denyTotpPending: false` の使用箇所を**静的検査**で固定 |
| R5 | `SessionData` への型追加で既存テストが大量に落ちる | 作業が止まる | 高 | フィクスチャ 7 ファイルへの `totpPending: false` 追加を **P5-B-04 で一括**してから進む |
| R6 | リカバリーコード表示後に利用者が保存し忘れる | 復旧不能 | 中 | 「保存しました」チェックを必須にする（§12.2）。再生成の導線を常に出す |
| R7 | `login` の応答変更で既存テストが壊れる | 手戻り | 中 | **2FA 無効時は応答を完全に不変**にする。`twoFactorRequired` は 2FA 有効時のみ足す |
| R8 | OIDC の `totp_pending` 追加で OIDC E2E が落ちる | 手戻り | 低 | OIDC のテストフィクスチャは `totp_pending=false` を既定にする。E2E（`pnpm test:e2e`）を Phase 5 でも回す |
| R9 | `bigint` の型（文字列 vs 数値）で比較が壊れる | atomic 判定が常に偽/真 | 中 | `bigint({ mode: 'number' })` を明示（§6.3）。統合テストで counter の往復を確認 |
| R10 | メール送信失敗で有効化が失敗する | 有効化できない | 低 | 通知は `deliverEmailSafely`（best-effort）。失敗しても 200 を返し `security_notification_failed` を記録（既存方針） |
| R11★ | **未確認ログインの遮断で既存テストが落ちる**（`deleted-account-login.test.ts` の反転忘れ） | CI が赤。仕様の二重定義 | 高 | §5.2 に影響を明記。**P5-B2-04 でテストを反転**する。実装前に「未確認でログインを期待するテストが他に無いか」を `grep` で確認済み（該当は 1 件） |
| R12★ | **未確認ユーザーが締め出される**（再送経路の作り忘れ） | 登録したのに使えない。サポート問い合わせ | 中 | `register` がセッションを発行しないことを確認済み。**D-33-21 と D-33-22 を必ず同時に実装**（片方だけ入れない）。§14.4 の手動確認 9・10 で検証 |
| R13 | 再送 API の開放でスパム / メール爆弾 | 送信コスト・評判 | 中 | `resendEmail(email)` 5/1h ＋ `resend.ip` 10/1h の 2 重制限。CAPTCHA hook も既存どおり。`resend-unauthenticated.test.ts` で固定 |
| R14 | 強い再認証の順序ミス（コードを先に消費してから再認証で落ちる） | 正規のコードを失う | 中 | `requireStrongReauth` が**再認証 → コード**の順に判定し、**両方通ってから**本体処理（§8.5）。T23 のテストで固定 |
| R15 | Phase 6 で `strong-reauth.ts` の入口が合わない | Passkey 追加時に手戻り | 低 | 検証器配列を最初から採用（D-33-24）。`strong-reauth.test.ts` で「2 つ目の検証器を足すと通る」ことを検証 |

---

## 16. 仕様トレーサビリティ

| 仕様 | 章 | 担当タスク | テスト |
|---|---|---|---|
| TOTP（6 桁・認証アプリ） | §13.1 | P5-A-04, P5-B-07, P5-B-08 | `totp.test.ts`, `2fa.test.ts` |
| secret の暗号化（鍵は DB に無い） | §13.1 | P5-A-03 | `totp-crypto.test.ts` |
| バックアップコード 10 個・1 回限り・ハッシュ | §13.2 | P5-A-05, P5-B-08, P5-B-09 | `recovery-codes.test.ts`, `recovery-code-reuse.test.ts` |
| 2FA API 4 本（setup/verify/disable/regenerate） | §33 | P5-B-07〜B-12 | `2fa.test.ts` |
| 2FA 無効化時の再認証 | §8 / §33 | P5-B-10, P5-B-11 | `2fa-disable-reauth.test.ts` |
| 2FA 変更の通知 | §18 | P5-B-08, B-11, B-12 | `2fa.test.ts` |
| `security_events`: 2fa_enabled / 2fa_disabled | §21 | P5-B-08, B-11 | `security-events-coverage.test.ts` |
| 機密値の redaction | §45 | P5-B-03 | `log-redaction.test.ts`, `2fa-secret-leak.test.ts` |
| レート制限（2FA 独立制御） | §16 / §56 | P5-B-09 | `2fa-bruteforce.test.ts`, `rate-limit.test.ts` |
| 同一コードの並行実行で成功 1 件 | D-16 / §48 | P5-A-04, P5-C-01 | `2fa-concurrent-replay.test.ts` |
| CSRF（状態変更は POST + トークン） | §25 | 全 API（共通パイプライン） | `csrf.test.ts` |
| 完了条件「高度な認証」TOTP / Recovery Codes | §64 | 全体 | DoD §14 |
| **登録直後は `email_verified = false`** | §4.1 | P5-B2-01 | `email-unverified-login.test.ts` |
| **未認証ユーザーは確認メールを再送できる** | §4.3 | P5-B2-02 | `resend-unauthenticated.test.ts` |
| **email 未認証のログイン扱い** | §48 | P5-B2-01 | `email-unverified-login.test.ts`, `deleted-account-login.test.ts` |
| **再送 API のレート制限（5回/1時間）** | §4.3 | P5-B2-02 | `resend-unauthenticated.test.ts`, `rate-limit.test.ts` |
| **列挙攻撃の防止（同一応答）** | §46 | P5-B2-02 | `enumeration.test.ts`, `resend-unauthenticated.test.ts` |
| **再認証（§8 の 3 手段のうちパスワード＋コード）** | §8 | P5-B-10, P5-B-11 | `strong-reauth.test.ts`, `2fa-disable-reauth.test.ts` |

---

## 17. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-24 | 初版（**設計のみ・実装は未着手**）。`実装計画.md` §15 と仕様 §13 / §33 / §64 に基づき、DB・API・フロー・脅威・テスト・UI・工数を確定。D-33-01〜D-33-20 を新規採番 |
| v1.1 | 2026-10-24 | **ユーザー指示 3 件を反映**（実装前）。<br>①**ログインの認証手段**（D-33-23〜D-33-25）: 無効化・再生成に「パスワード ＋ 現在のコード」の**強い再認証**を要求。`strong-reauth.ts` を新設し、Phase 6 の Passkey を検証器 1 個の追加で差し込めるようにした（`strong_reauth_methods` を API 応答に追加）。<br>②**`qrcode` の追加を承認**（D-33-02 を反転）: QR は自前 SVG から `qrcode@^1.5.4` の SVG 出力に変更。`@types/qrcode` を devDependencies に。<br>③**未確認 email の扱い**（D-33-21 / D-33-22）: 未確認ログインを 403 `EMAIL_NOT_VERIFIED` で止め、ログイン画面に「メールアドレスの確認が必要です」＋再送を出す。**`resend-verification` を未認証でも呼べるようにする**（`register` がセッションを発行しないため、これが無いと締め出される）。<br>**既存仕様の変更**: `deleted-account-login.test.ts` の期待値を反転（§5.2）。**工数**: 21.0h → **27.8h**（§13.6） |

---

## 18. 次フェーズへの引継ぎメモ

- **Phase 6（Passkey）**: `sessions.passkey_pending` は既にある。Phase 5 で作った `denyTotpPending` と同じ形で **`denyPasskeyPending`** を足せる（両方が true のときは「TOTP 完了後に Passkey」の順序を決める必要がある。**Phase 6 の設計時に確定**）。
- **Phase 6（再認証の拡張）**: Phase 5 で作った **`src/lib/auth/strong-reauth.ts` の検証器配列に `passkeyVerifier` を 1 つ足すだけ**で、無効化・再生成が Passkey でも通る（D-33-24）。`availableStrongReauthMethods` が `['password', 'passkey']` を返すようにし、`StrongReauthDialog` に Passkey タブを足す。**API ルート（`disable` / `regenerate`）は無変更**。`reauth` API 自体の `method` 拡張は Phase 6 で行う。
- **Phase 7（管理者）**: §51 の「管理者は 2FA 必須」は、Phase 5 の `GET /api/auth/2fa` を使って**ログイン時に強制**できる。`users.role_id` と組み合わせる。
- **Phase 9**: 2FA 画面の CAPTCHA（soft limit 超過時）は Phase 5 では入れていない。負荷検証（`pnpm oidc:load`）と同時に検討する。
- **共通パイプライン**: `denyTotpPending` の追加で `PipelineOptions` が増えた。Phase 6 で `denyPasskeyPending` を足すときは、**既定を fail closed** にする（同じ原則）。
- **未確認 email の扱い**: Phase 5 で「未確認はログイン不可＋未認証で再送可」にした。**Phase 6 の Passkey 登録も同じ前提**（`email_verified = true` を要求する）にそろえること。social-only ユーザー（`createSocialUser`）は `identity.emailVerified` を確認しているため、既に整合している。
- **`実装Todo.md` の更新**: §7.1 のとおり `2fa/challenge` は作らず `challenge/verify` のみ実装するため、`実装Todo.md` の P5-B-03 の表記を「`2fa/challenge/verify` で昇格」に直す。テストファイル数は **14**、新規ファイル数は **21**、工数は **27.8h** に合わせる。**`resend-verification` の認可変更（D-33-22）は `実装Todo.md` の P4 完了項目にも影響する**ため、Phase 5 のタスクとして明記する。

# Phase 6 実装計画 — Passkey / WebAuthn

> 対象: M6（`実装計画.md` v1.6 §15「Phase 6 — Passkey / WebAuthn（2〜3日）」）
> 前提工程: Phase 5（M5 TOTP 2FA + Recovery Codes）
> 正典の優先順位: 仕様書 `超本格アカウント・認証システム仕様書 v1.3.md` → 計画 `実装計画.md` → 進捗 `実装Todo.md` → **本書（実装レベルの詳細）**
> 初版: 2026-10-24（**計画のみ・実装は未着手**）
> 状態: **設計レビュー待ち**
> 実行手順: `docs/phase6-実行Todo.md`

---

## 0. 要旨（TL;DR）

| 項目 | 内容 |
|---|---|
| 何をやる | 仕様 §12（Passkey / WebAuthn）、§32（Passkey API）、§8（再認証手段の Passkey）、§64「高度な認証」の **Passkey** を実装する。これで §64「高度な認証」3 項目（TOTP / Recovery Codes / Passkey）が揃う |
| なぜやる | §64 の「高度な認証」最後の 1 項目。**DoD 未達なら Phase 7 へ進めない**（計画 3 章） |
| 工数 | **約 30.4 時間（約 4 日）**。内訳は §13 |
| 追加依存 | **`@simplewebauthn/server@^14.0.3`**（dependencies・サーバ検証）、**`@simplewebauthn/browser@^14.0.0`**（dependencies・クライアントの `navigator.credentials` ラッパ）。**自作 WebAuthn 検証は禁止**（§67 / 計画 §4） |
| migration | **1 本のみ** = `0018_passkey.sql`（`webauthn_credentials` / `webauthn_challenges` の 2 テーブルを新規作成。既存テーブルは変更しない） |
| 新規ファイル | **18 ファイル**（migration 1 / ライブラリ 4 / クエリ 1 / 検証 1 / API 7 / 画面 3 / テスト支援 1）→ §7.1 |
| テスト | 新規 **13 ファイル** ＋ 既存 6 ファイルへの追記 → §11 |
| 既存仕様の変更 | **無し**（Phase 5 の挙動は不変）。Phase 5 が残した「強い再認証」の検証器配列に **Passkey を 1 件足す**だけ（D-34-11）。Phase 5 §18 が想定した `denyPasskeyPending` は**追加しない**（D-34-09 で理由を明記） |
| 最大リスク | **WebAuthn の検証（origin / rpIDHash / signature / flags / sign_count）を正しく行うこと**。`@simplewebauthn/server` に委譲するが、**渡す `expectedOrigin` / `expectedRPID` / `challenge` の組み立てを誤ると全検証が素通り or 全滅する**（§10 R1） |
| セキュリティの核 | (1) `rpID` / `origin` は**環境ごとの明示設定**で許可リスト検証（D-26 / D-34-01）、(2) challenge は **DB 保存・TTL 5 分・1 回限り**（atomic 消費・D-16）、(3) `sign_count` は **atomic 更新**（クローン検知・D-34-06）、(4) 登録・削除は**再認証必須**（§8）、(5) 公開鍵のみ保存し**秘密鍵はサーバに送らない**（§12） |
| 前提（Phase 5 の成果を再利用） | `sessions.passkey_pending` は既にある（**Phase 6 では使わない**・D-34-09）。`RATE_LIMITS.passkey` / `rateLimitKeys.passkeyIp` は既にある。`security_events` に `passkey_added` / `passkey_removed` は既にある。`strong-reauth.ts` の検証器配列に Passkey を足す（D-34-11） |

---

## 1. 正典と参照関係

| 文書 | 章 | 本書での扱い |
|---|---|---|
| 仕様書 v1.3 | §12 Passkey / WebAuthn | 複数登録・登録情報の列・**公開鍵のみ保存**・Level 3 準拠 |
| 仕様書 v1.3 | §32 Passkey API | 6 本のエンドポイント（register options/verify・login options/verify・GET・DELETE） |
| 仕様書 v1.3 | §8 重要操作の再認証 | 再認証 3 手段（パスワード / Passkey / TOTP）。**Passkey 削除は再認証必須** |
| 仕様書 v1.3 | §18 ログイン通知 | **Passkey 追加 / 削除**の通知メール |
| 仕様書 v1.3 | §21 セキュリティログ | `passkey_added` / `passkey_removed`（**既に `SECURITY_EVENT_TYPES` に定義済み**） |
| 仕様書 v1.3 | §25 CSRF | Passkey 操作は POST/PUT/PATCH/DELETE。共通パイプラインを通す |
| 仕様書 v1.3 | §35 ログイン画面 | 「[パスキーでログイン]」ボタン |
| 仕様書 v1.3 | §37 セキュリティ設定画面 | 「Passkey 登録数」カード |
| 仕様書 v1.3 | §45 情報漏洩防止 | 公開鍵以外（秘密鍵・challenge・署名）をログ・応答に出さない |
| 仕様書 v1.3 | §48 セキュリティテスト | Passkey: challenge 再利用 / origin mismatch / RP ID mismatch / credential 削除後の認証 / sign counter 処理 |
| 仕様書 v1.3 | §51 管理者アカウント | 管理者は 2FA 必須・**Passkey 推奨**（Phase 7 で運用） |
| 仕様書 v1.3 | §56 レートリミット | `rl:passkey:ip:{ip}` = 30/5分（soft 10） |
| 仕様書 v1.3 | §64 完成条件 | 「高度な認証」Passkey |
| 仕様書 v1.3 | §67 自作禁止 | **自作 WebAuthn 検証は禁止**。`@simplewebauthn/server` を使う |
| 実装計画 v1.6 | §11.5 Passkey エンドポイント（29〜34） | API 契約の正 |
| 実装計画 v1.6 | §7.6 `webauthn_credentials` | テーブル列の正 |
| 実装計画 v1.6 | §8.6 レート制限 | `rl:passkey:ip:{ip}` = 30/5分（soft 10） |
| 実装計画 v1.6 | §15 Phase 6 / 6-A-1 | `rpID` / `rpName` / `origin` は**環境ごとの明示設定**（D-26） |
| 実装計画 v1.6 | D-26 | 許可リスト方式。request の `Origin` / `Host` を無条件に信頼しない |
| `docs/phase5-totp-2fa-実装計画.md` | §18 引継ぎメモ | `strong-reauth.ts` に検証器を 1 つ足す・`reauth` API の method 拡張は Phase 6 |

---

## 2. 背景と目的

### 2.1 現状（コードで確認済み・2026-10-24 実地調査）

| 領域 | 現状 | 根拠 |
|---|---|---|
| `sessions.passkey_pending` 列 | **既にある**（`text` nullable、Phase 1-C で作成） | `drizzle/0002_04_sessions.sql`, `src/lib/db/schema.ts:114` |
| `passkey_pending` の利用 | **どこからも書かれない**（未使用） | `grep -rn "passkeyPending" src/` は schema とテストフィクスチャのみ |
| Passkey の DB テーブル | **無い**（`webauthn_credentials` / `webauthn_challenges` とも未作成。最新 migration は `0017`） | `drizzle/` |
| WebAuthn ライブラリ | **未導入**（`package.json` に `@simplewebauthn/*` なし） | `package.json` |
| Passkey API | **未実装**。`src/app/api/auth/` に `passkey/` ディレクトリが無い | `ls src/app/api/auth/` |
| レート制限キー | **既にある**。`rateLimitKeys.passkeyIp(ip)` = `rl:passkey:ip:{ip}` | `src/lib/auth/rate-limit-keys.ts:48` |
| レート制限値 | **既にある**。`RATE_LIMITS.passkey = { window: 300_000, limit: 30, softLimit: 10 }` | `src/config/rate-limits.ts:22` |
| `security_events` の型 | `passkey_added` / `passkey_removed` は**定義済み** | `src/lib/db/schema.ts:309-310` |
| 強い再認証の入口 | **既にある**。`requireStrongReauth` / `availableStrongReauthMethods` は検証器配列（Phase 5・D-33-24） | `src/lib/auth/strong-reauth.ts` |
| `StrongReauthMethod` 型 | **既に `'passkey'` を含む**（Phase 5 が前方互換で用意） | `src/lib/auth/strong-reauth.ts:7` |
| 再認証の共通ガード | **既にある**。`checkReauth`（5 分猶予）＋ `withAuthPipeline({ requireReauth: true })` | `src/lib/auth/reauth.ts`, `src/lib/auth/pipeline.ts` |
| セキュリティ設定画面 | §37 の Passkey カードは「{count} 件」「この機能はPhase 5 以降で利用できます」の**如实表示のみ**（導線なし） | `src/components/settings/security-overview.tsx:89-104` |
| ログイン画面 | Passkey ボタンは**未接続**（`LoginButtons` は social registry のみ） | `src/app/auth-form.tsx` |
| env の WebAuthn 変数 | **未定義**（`env.ts` の zod スキーマに無い）。計画 §17.1 に `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ORIGIN` / `WEBAUTHN_ALLOWED_ORIGINS` の記載はある | `src/lib/env.ts`, `実装計画.md:1202` |
| 変更通知メール | 汎用 `sendChangeNotificationEmail` ＋ best-effort `deliverEmailSafely` が**再利用可能** | `src/lib/auth/email/templates.ts`, `src/lib/auth/email/deliver.ts` |
| 実 HTTP テスト基盤 | **ある**。`src/test/helpers/app-server.ts`（BUG-7） | `src/test/helpers/` |
| クライアント境界の回帰防止 | **ある**。`src/test/unit/oauth-client-boundary.test.ts` が `process.env` 参照とサーバ専用 import を静的検査（BUG-11） | `src/test/unit/oauth-client-boundary.test.ts` |

**結論**: 「入れる場所」は既に用意されている（列・キー・値・イベント型・再認証の入口・通知）。足すのは **(1) 2 テーブル、(2) WebAuthn ライブラリの薄いラッパ、(3) challenge の 1 回限り消費、(4) API 6 本（＋再認証用 1 本）、(5) 画面接続、(6) `rpID`/`origin` の環境別明示設定と許可リスト検証**。

### 2.2 目的（各々に完了定義を付ける）

| # | 目的 | 完了定義 |
|---|---|---|
| 1 | 利用者が Passkey を**複数登録**できる（§12） | `/settings/security` から登録でき、デバイス名・作成日時・最終使用日時が一覧に出る。**公開鍵のみ**が DB に入る |
| 2 | **パスワード無しでログイン**できる（§35 / §64） | `/login` の「[パスキーでログイン]」から、discoverable credential でもログインできる。**新セッション**が発行される |
| 3 | Passkey を**削除**できる（§8 / §32） | 削除は**再認証必須**。**最後のログイン手段**になる削除は 409 で拒否（`LAST_LOGIN_METHOD`） |
| 4 | **challenge が 1 回限り**（§48） | 同じ challenge を 2 回送ると 2 回目は 400 `INVALID_CODE`（atomic 消費・D-16） |
| 5 | **origin / rpID の不一致を拒否**（§48 / D-26） | 許可リスト外の origin・rpID の応答は 400。request の `Origin`/`Host` を信頼しない |
| 6 | **sign_count の後退を拒否**（§48） | `sign_count` が保存値より小さい（クローン疑い）応答は 400。更新は **atomic**（D-34-06） |
| 7 | **削除済み credential では認証できない**（§48） | 削除後に同じ credential で認証 → 400 `INVALID_CODE` |
| 8 | 公開鍵以外が漏れない（§12 / §45） | ログ・API 応答・`security_events.metadata` に秘密鍵・challenge・署名が出ない（テストで固定） |
| 9 | **強い再認証が Passkey でも通る**（§8 / D-34-11） | `strong-reauth.ts` に検証器を 1 件足すだけで、2FA 無効化・再生成・Passkey 削除が Passkey でも通る。**2FA の API ルートは無変更** |
| 10 | Passkey 追加・削除が**通知され記録される**（§18 / §21） | `passkey_added` / `passkey_removed` を `security_events` に記録し、変更通知メールを送る（best-effort） |
| 11 | 総当たり・列挙が現実的でない（§16） | `rl:passkey:ip:{ip}` = 30/5分。超過で 429、`rate_limited` を記録 |
| 12 | **Phase 7 の管理者要件に接続できる**（§51） | `GET /api/auth/passkey` で登録数が取れる。管理者の「2FA 必須・Passkey 推奨」判定はこの API を使う（Phase 7） |

---

## 3. スコープ

### 3.1 本フェーズで実装する

- Passkey の DB テーブル（`webauthn_credentials` / `webauthn_challenges`）と migration `0018_passkey.sql`
- `rpID` / `rpName` / 許可 origin の**環境別明示設定**と許可リスト検証（`src/lib/auth/passkey/config.ts`）
- WebAuthn 登録（options / verify）と認証（options / verify）のラッパ（`@simplewebauthn/server`）
- challenge の DB 保存と **1 回限りの atomic 消費**（TTL 5 分）
- `sign_count` の **atomic 更新**と後退拒否（クローン検知）
- API 7 本（`register/options` / `register/verify` / `login/options` / `login/verify` / `GET` / `DELETE {id}` / `reauth/passkey/options`）
- **「強い再認証」への Passkey 差し込み**（`strong-reauth.ts` に検証器 1 件・D-34-11）
- `/login` の「[パスキーでログイン]」ボタンと Ceremony クライアント
- `/settings/security` の Passkey カードを実動作に（一覧 / 登録 / 削除）
- `StrongReauthDialog` に Passkey タブを追加（`strong_reauth_methods` に `'passkey'` が含まれるときだけ）
- 通知メール（追加 / 削除）と `security_events` 記録

### 3.2 本フェーズで実装しない（理由と引継ぎ先）

| 項目 | 理由 | 引継ぎ先 |
|---|---|---|
| 管理者の「2FA 必須・Passkey 推奨」の**強制**（§51） | 管理者ロールの運用は Phase 7 | Phase 7 |
| Passkey を**第 2 要素**として使うモード（パスワード → Passkey） | §35 は Passkey を**トップレベルのログイン手段**として提示している。所持＋生体/PIN で単独の多要素になり、TOTP と重ねる必要が無い（D-34-09）。**`sessions.passkey_pending` は使わない** | 未定（必要になったら別途） |
| 条件付き UI（autofill / conditional mediation） | UX 拡張。§35 の要件ではない | 未定（MVP 対象外） |
| Passkey の**名前変更** | §32 に無い（`device_name` は登録時に付ける） | 未定 |
| アカウント復旧フロー（§54 / §55） | サポート経由の復旧は MVP 対象外 | 未定 |
| attestation の**検証（`fmt` の真正性確認）** | `attestationType: 'none'` を使う（§12 は attestation を要求しない）。`aaguid` は記録するが MDS 照合はしない | 未定 |
| Backup Eligibility / BE フラグの**ポリシー適用** | `backed_up` を記録するのみ。`residentKey: 'preferred'` で同期 passkey を許容 | 未定 |

> **掃除ジョブについて**: `webauthn_challenges` は TTL 5 分。`scripts/purge-expired.ts` に **1 ジョブ追加**する（`expires_at < now()` または消費後 1 日経過を削除・D-31-17 と同じ方針）。`webauthn_credentials` は user 削除で CASCADE されるため追加不要。

---

## 4. 前提・着手前チェック

| # | 確認事項 | 状態 |
|---|---|---|
| 1 | `sessions.passkey_pending` 列が既にある | ✅ migration `0002`（**Phase 6 では使わない**・D-34-09） |
| 2 | Passkey のレート制限キーと値が既にある | ✅ `rateLimitKeys.passkeyIp` / `RATE_LIMITS.passkey` |
| 3 | `security_events` に `passkey_added` / `passkey_removed` がある | ✅ `SECURITY_EVENT_TYPES` |
| 4 | 再認証の共通ガードがある | ✅ `checkReauth` + `withAuthPipeline({ requireReauth: true })` |
| 5 | 変更通知メールのテンプレートがある | ✅ `sendChangeNotificationEmail` + `deliverEmailSafely` |
| 6 | 実 HTTP テスト基盤がある | ✅ `src/test/helpers/app-server.ts` |
| 7 | クライアント境界の静的検査がある | ✅ `src/test/unit/oauth-client-boundary.test.ts`（**Phase 6 で Passkey の項目を追加**） |
| 8 | `@simplewebauthn/*` のバージョンを固定する | 要対応（`@simplewebauthn/server@^14.0.3` / `@simplewebauthn/browser@^14.0.0` を dependencies に追加。Node ≥20 必須＝本リポジトリは v24 で充足） |
| 9 | WebAuthn の env 変数を定義する | 要対応（`WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ALLOWED_ORIGINS` を `env.ts` に**検証付き**で追加・D-34-01） |
| 10 | dev / prod で `rpID` / `origin` が別値か | 要対応（**dev = `localhost` / prod = 本番ドメイン**。Phase 9 のドメイン確定時に固定。**本書ではドメインを確定しない**） |
| 11 | Passkey 登録にメール確認を要求するか | **要求する**（D-34-02。Phase 5 D-33-06 と同じ前提にそろえる） |
| 12 | Passkey ログインにメール確認を要求するか | **要求する**（`email_verified = true` のみログイン可・Phase 5 D-33-21 と整合） |
| 13 | `webauthn-mock` の作り方 | 要設計（**実鍵（P-256）で署名した有効な応答**を作る。スタブでは実検証を通せない・§11.4） |

---

## 5. 決定事項（D-34-01 〜 D-34-16）

> 全フェーズ共通のロック済み決定（D-01〜D-27）は再掲しない。ここには Phase 6 で新たに固定する事項のみを書く。

| ID | 決定 | 理由 |
|---|---|---|
| **D-34-01★** | WebAuthn の `rpID` / `rpName` / 許可 origin は **環境ごとの明示設定**（`WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ALLOWED_ORIGINS`）とし、`env.ts` の zod で**起動時に fail fast 検証**する。検証は**許可リスト方式**（`origin` ∈ 許可リスト、`rpID` は各 origin の host と一致またはその登録可能ドメインのサフィックス）。**request の `Origin` / `Host` ヘッダを無条件に信頼しない** | D-26 / 計画 6-A-1。`process.env` や request host から自動導出すると、**Host ヘッダ偽装で origin 検証を迂回**できる。dev（`localhost`）と prod（本番ドメイン）で**別値を固定**し、同一値の放置を zod で落とす |
| **D-34-02** | Passkey の**登録**は `email_verified = true` かつ `status = 'active'` のユーザーだけ許可する。未確認は 403 `EMAIL_NOT_VERIFIED` | Phase 5 D-33-06 と同じ前提。復旧通知（Passkey 追加メール）が機能しないアカウントに Passkey を付けさせない |
| **D-34-03★** | WebAuthn の検証は **`@simplewebauthn/server` に完全委譲**する。`generateRegistrationOptions` / `verifyRegistrationResponse` / `generateAuthenticationOptions` / `verifyAuthenticationResponse` を**薄くラップ**するだけ。**自作の署名検証・CBOR/COSE パースは禁止** | §67 / 計画 §4「自作 WebAuthn 検証は禁止」。Level 3 の検証（flags・rpIdHash・COSE・attestation）は自作すると必ず穴が出る |
| **D-34-04★** | 登録は **`attestationType: 'none'`**、`authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }`。認証は **`userVerification: 'preferred'`**（discoverable 対応のため `allowCredentials` は空も許容） | §12 は attestation を要求しない。`preferred` は同期 passkey（iCloud / Google Password Manager）を許容しつつ、対応端末では生体/PIN を促す。`required` にすると非対応端末で登録不能になる |
| **D-34-05★** | challenge は **DB（`webauthn_challenges`）に保存**し、**TTL 5 分・1 回限り**。消費は **`UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()` の更新行数 = 1** で判定する（read → 判定 → write の 2 段書き禁止） | §48「challenge 再利用」/ D-16。セッションや署名 Cookie に challenge を持つ方式は、**同じ challenge の 2 回送信を DB で弾けない**。単文 UPDATE で 1 回限りを保証する |
| **D-34-06★** | `sign_count` は**保存値より小さい応答を拒否**し（クローン検知・`@simplewebauthn/server` が実施）、更新は **atomic**（`UPDATE ... SET sign_count = $new, last_used_at = now() WHERE credential_id = $cid AND user_id = $uid AND sign_count < $new`）の更新行数で判定する。ただし **`newCounter === 0` は「カウンタ非対応の authenticator」として後退判定の対象外**とし、`last_used_at` のみ更新する | §48「sign counter 処理」。プラットフォーム passkey は `sign_count` を増やさない（常に 0）ため、単純な単調増加必須にすると**正規のログインが全滅**する。challenge の 1 回限り（D-34-05）と併用して replay を防ぐ |
| **D-34-07★** | ログイン（`login/verify`）は**新セッションを発行**する（`createSession`）。`login/options` は**未認証で呼べる**（discoverable 対応のため `user_id` を持たない challenge を発行する）。認証後に credential → user を解決し、`status = 'active'` / `email_verified = true` / `deleted_at IS NULL` を再確認する | §32 / 計画 §11.5 #32。Passkey は**単独のログイン手段**であり、パスワードログインと同じくセッション固定攻撃対策として**常に新規セッション**を発行する（Phase 1 の D-03 と同じ原則） |
| **D-34-08★** | **登録・削除は再認証必須**。登録は `requireStrongReauth`（パスワード＋コード、または Passkey）を通す。削除も `requireStrongReauth` を通す。**最後のログイン手段**（`password_hash IS NULL` かつ Passkey 1 件かつ TOTP 無効）になる削除は **409 `LAST_LOGIN_METHOD`** で拒否する | §8「Passkey 削除は再認証」/ 計画 §11.5 #34。既存の `DELETE /api/auth/accounts/{id}` の判定（`LAST_LOGIN_METHOD`）と同じ形にそろえ、**締め出しを防ぐ** |
| **D-34-09★** | Passkey は**第 2 要素ではなく独立したログイン手段**として実装する。したがって **`denyPasskeyPending` を追加せず、`sessions.passkey_pending` も使わない**。TOTP 有効ユーザーがパスワードでログインした場合は Phase 5 どおり **TOTP 昇格**を要求する（Passkey ログインは TOTP を要求しない） | Phase 5 §18 は `denyPasskeyPending` を想定したが、Passkey ログインは**完了時点でフルセッション**を発行するため「保留」状態が存在しない。TOTP と Passkey は**どちらも第 2 要素の代替**であり、Passkey（所持＋生体/PIN）は単独で多要素。**両方を要求すると UX を損なう**（D-33-23 が Passkey 単独を強い手段と認めているのと同じ判断） |
| **D-34-10** | `device_name` は登録時に**クライアント申告値**（`body.device_name`）を既定とし、未指定なら `deriveDeviceName(userAgent)`（既存 `src/lib/util/device.ts`）を使う。長さは `MAX_DEVICE_NAME` に切り詰め、制御文字を除去する | §12「device_name」。既存の device 命名と一貫させ、通知・一覧の見た目を揃える |
| **D-34-11★** | **「強い再認証」に Passkey を差し込む**。`strong-reauth.ts` の入力に `body`（`{ code?, passkey? }`）を受け取れるようにし、検証器配列を `[passwordAndCodeVerifier, passkeyVerifier]` にする。`availableStrongReauthMethods(user)` は Passkey を 1 件以上持つとき `['password', 'passkey']` を返す。**`passkeyVerifier` は `reauth/passkey/options` が発行した challenge に対する assertion を検証する** | D-33-24 の約束（Phase 6 は検証器を 1 つ足すだけ）。2FA の `disable` / `regenerate` ルートは**判定ロジックを書き換えない**（body をそのまま `requireStrongReauth` に渡す形へ小改修のみ） |
| **D-34-12** | `POST /api/auth/reauth/passkey/options` を新設し、**再認証用の Passkey challenge** を発行する。`POST /api/auth/reauth`（パスワード）は**変更しない**。Passkey の再認証は `requireStrongReauth` の `passkeyVerifier` が完結させる（`reauthVerifiedAt` を経由しない） | §8 の再認証 3 手段のうち Passkey を満たす。パスワード再認証の 5 分猶予（`reauthVerifiedAt`）と Passkey 検証は**別系統**にしておくほうが、二重計上や順序の混乱が無い |
| **D-34-13** | `security_events` の**新規 type を追加しない**。Passkey 追加 = `passkey_added`、削除 = `passkey_removed`、認証失敗 = `login_failed`（`metadata.scope = 'passkey'`）とする | D-31-18 / D-32-15 / D-33-18 の踏襲。列挙を増やすとダッシュボード・テスト・文言の同時更新が必要になる |
| **D-34-14** | ログの redaction に **`credentialId` / `publicKey` / `attestationObject` / `authenticatorData` / `clientDataJSON` / `signature` / `challenge`** を追加する（`challenge` は既に `code` 等と同様に機密扱い） | §45。`SENSITIVE_KEYS` に無いキー名で WebAuthn の値をログに渡すと**素通りする**。実装と同時に `logger.ts` を更新し、テストで固定する |
| **D-34-15** | 通知メールは **`passkey_change`** の `EmailKind` を新設し、`sendChangeNotificationEmail` で「Passkey を追加/削除しました・日時・masked IP」を送る。**credential ID・公開鍵・署名は本文に入れない** | §18 / §45。既存 `notifyAccountChange` は OAuth provider 専用（`action: 'link' \| 'unlink'`）なので流用しない |
| **D-34-16** | `webauthn_challenges` の掃除ジョブを `scripts/purge-expired.ts` に追加する（`expires_at < now()` または消費後 1 日経過を削除） | 既存の token / state と同じ方針（D-31-17）。放置すると challenge 行が無制限に増える |

### 5.1 却下した代替案（なぜ採らなかったか）

| 代替案 | 却下理由 |
|---|---|
| `rpID` / `origin` を request の `Host` / `Origin` ヘッダから導出 | D-26 が**明示的に禁止**。`Host` 偽装で origin 検証を迂回できる（§48「origin mismatch」の穴） |
| challenge を署名 Cookie / セッション列に持つ | **同じ challenge の 2 回送信を DB で弾けない**（§48「challenge 再利用」）。単文 UPDATE で 1 回限りを保証できない |
| challenge を Redis（TTL 付き）に置く | D-05「レート制限の正本は PostgreSQL。Redis は予約方式と同等の原子性を実装するまで認証判定の正本にしない」に反する。DB で 1 回限りを保証する |
| `SELECT ... FOR UPDATE` で challenge を消費 | トランザクション保持時間が伸びる。**単文 UPDATE の更新行数**で足りる（D-33-04 と同じ判断） |
| `sign_count` の**厳密な単調増加**を常に要求 | プラットフォーム passkey は `sign_count` を増やさない（常に 0）。要求すると**正規ログインが全滅**する。`newCounter === 0` を例外にし、challenge 1 回限りと併用する（D-34-06） |
| Passkey を**第 2 要素**（パスワード → Passkey）にする | §35 は Passkey を**トップレベルのログイン手段**として提示。所持＋生体/PIN で単独の多要素になり、パスワードを前置する必要が無い（D-34-09） |
| `denyPasskeyPending` を追加する | Passkey ログインは完了時にフルセッションを発行し「保留」状態が無い。`passkey_pending` 列を使う設計上の必然が無い（D-34-09） |
| 登録を**再認証不要**にする | §8「Passkey 削除は再認証」に加え、**登録も**セッション窃取者が勝手に自分の Passkey を足せると乗っ取りに使える。両方に再認証を課す（D-34-08） |
| attestation を `direct` にして検証する | §12 は attestation を要求しない。`direct` はプライバシーを損ない、`fmt` ごとの検証実装が必要になる。`none` を採る（D-34-04） |
| クライアントで `navigator.credentials` を**手書き**する | `@simplewebauthn/browser` が base64url 変換・`parseCreationOptionsFromJSON` 等の面倒を吸収する。自作は禁止（§67） |
| `device_name` をサーバで常に UA から導出 | 利用者が「MacBook の Touch ID」等の**分かりやすい名前**を付けられるほうが一覧の価値が高い。申告値を優先（D-34-10） |

### 5.2 既存仕様を変更する決定（影響の明示）

**Phase 6 は Phase 5 までの確定挙動を変更しない。** ただし次の 2 点は**既存ファイルに手を入れる**ため、影響を確認すること。

| 対象 | 現状 | Phase 6 後 | 対応 |
|---|---|---|---|
| `src/lib/auth/strong-reauth.ts` の `requireStrongReauth` 入力 | `{ user, session, code }`（Phase 5） | `{ user, session, body }`（`body.code` / `body.passkey` を検証器が読む） | 2FA の `disable` / `regenerate` ルートは `code` ではなく **`body` を渡す**小改修。`strong-reauth.test.ts` の呼び出しも更新 |
| `src/app/api/auth/reauth/route.ts` | パスワードのみ（Phase 1） | **変更しない**（Passkey 再認証は `reauth/passkey/options` ＋ `requireStrongReauth` が担う） | 変更不要。ただし `StrongReauthDialog` は Passkey タブで `reauth/passkey/options` を呼ぶ |
| `scripts/purge-expired.ts` | token / state / artifact 等を掃除 | `webauthn_challenges` の掃除を**追加** | 1 ジョブ追加（D-34-16）。`purge-expired.test.ts` に期待値を追加 |
| `src/lib/auth/email/deliver.ts` | `EmailKind` 7 種 | `passkey_change` を追加（8 種） | `EmailKind` を 1 つ足す（D-34-15） |
| `src/lib/env.ts` | WebAuthn 変数なし | `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ALLOWED_ORIGINS` を追加 | zod に追加（dev/test は既定値、prod は必須・D-34-01） |
| `src/test/unit/oauth-client-boundary.test.ts` | OAuth のサーバ専用 import を検査 | **Passkey の項目を追加**（`@/lib/auth/passkey/config` 等をクライアントから import しない） | 検査リストに追加（BUG-11 の再発防止） |

---

## 6. データモデル

### 6.1 migration `drizzle/0018_passkey.sql`

**新規 2 テーブルのみ。既存テーブルの変更は無い**（`sessions.passkey_pending` は既にあるが使わない・D-34-09）。

```sql
CREATE TABLE "webauthn_credentials" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "credential_id" text NOT NULL,
  "public_key" text NOT NULL,
  "sign_count" bigint DEFAULT 0 NOT NULL,
  "transports" jsonb,
  "aaguid" text,
  "device_name" text,
  "backed_up" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_uniq" ON "webauthn_credentials" USING btree ("credential_id");
--> statement-breakpoint
CREATE INDEX "webauthn_credentials_user_id_idx" ON "webauthn_credentials" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text,
  "type" text NOT NULL,
  "challenge" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_at_idx" ON "webauthn_challenges" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "webauthn_challenges_user_id_idx" ON "webauthn_challenges" USING btree ("user_id");
```

### 6.2 設計上の判断

| 論点 | 決定 | 理由 |
|---|---|---|
| `webauthn_credentials` の主キー | **`id`（`wac_` + ULID）を別に持ち、`credential_id` に UNIQUE** | `credential_id` は base64url で可変長・外部由来。主キーにすると URL のパス（`DELETE /passkey/{id}`）に外部値を露出する。**内部 ID で参照**し、`credential_id` は照合キーに限定する |
| `public_key` の型 | **`text`（base64url）** | §22 / §7.6 は `bytea/text` を許容。`@simplewebauthn/server` は `Uint8Array` を扱うので、**境界で base64url に変換**する（`isoBase64URL`）。`bytea` にすると Drizzle の型とドライバの往復が増える |
| `transports` | **`jsonb`（`string[]`）** | §12 / §7.6 は `text[] or json`。`jsonb` は Drizzle で `$type<string[]>()` として型付けでき、`excludeCredentials` にそのまま渡せる |
| `sign_count` | **`bigint({ mode: 'number' })`、既定 0** | カウンタは `number` で比較する。`bigint` を文字列で返す既定を避ける（Phase 5 R9 と同じ） |
| `aaguid` / `backed_up` | **両方持つ**（`aaguid` は text、`backed_up` は boolean 既定 false） | §12 の登録情報＋§22 の追記。`aaguid` は監査・将来の MDS 照合に使う。`backed_up` は同期 passkey の識別（§22 の追記） |
| `last_used_at` | **nullable**（登録直後は NULL） | §37 の一覧は「最終使用」を出す。登録直後に「未使用」を表現する |
| `webauthn_challenges.user_id` | **nullable**（discoverable ログインは user 未確定） | §32 の login options は**未認証**で呼べる。登録・再認証の challenge は `user_id` を入れて**他人の challenge を消費できない**ようにする |
| `webauthn_challenges.type` | **`'registration' \| 'authentication'`**（CHECK は付けずアプリ層で保証） | 用途の取り違え（登録 challenge を認証に使う）を防ぐ。CHECK を付けると migration の down 生成が複雑になる（Phase 5 §6.2 と同じ判断） |
| `challenge` の保存 | **平文の base64url を保存**（ハッシュ化しない） | challenge は**サーバが生成した使い捨ての乱数**であり、DB が漏れても既に消費済み/期限切れで無価値。ハッシュ化すると検証時に総当たり照合が必要になり、`expectedChallenge`（文字列一致）に渡せない |
| 消費の判定 | **`UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()` の更新行数 = 1** | D-16 / D-34-05。1 回限りを DB で強制する |
| 削除済み credential | **行を物理削除**（`used_at` のようなフラグを持たない） | §48「credential 削除後の認証」。削除後に同じ credential で認証すると、行が無いので 400 になる。監査は `security_events` の `passkey_removed` に残る |

### 6.3 `src/lib/db/schema.ts` への追加

```ts
export const webauthnCredentials = pgTable('webauthn_credentials', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull(),
  publicKey: text('public_key').notNull(),
  signCount: bigint('sign_count', { mode: 'number' }).default(0).notNull(),
  transports: jsonb('transports').$type<string[]>(),
  aaguid: text('aaguid'),
  deviceName: text('device_name'),
  backedUp: boolean('backed_up').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('webauthn_credentials_credential_id_uniq').on(table.credentialId),
  index('webauthn_credentials_user_id_idx').on(table.userId),
]);

export const webauthnChallenges = pgTable('webauthn_challenges', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  challenge: text('challenge').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('webauthn_challenges_expires_at_idx').on(table.expiresAt),
  index('webauthn_challenges_user_id_idx').on(table.userId),
]);

export type WebauthnCredential = typeof webauthnCredentials.$inferSelect;
export type WebauthnChallenge = typeof webauthnChallenges.$inferSelect;
```

> `bigint({ mode: 'number' })` と `jsonb().$type<string[]>()` を明示する理由は Phase 5 §6.3 と同じ（型の往復を確定させる）。`ID_PREFIXES` に **`wac_`（credential）/ `wch_`（challenge）** を追加する（D-22 の `prefix_` + ULID）。

### 6.4 `scripts/verify-migrations.ts` への期待値追加

```ts
['webauthn_credentials テーブルが存在する（migration 0018）', afterUp.tables.includes('webauthn_credentials')],
['webauthn_challenges テーブルが存在する（migration 0018）', afterUp.tables.includes('webauthn_challenges')],
['webauthn_credentials に credential_id の unique index がある',
  Object.values(afterUp.indexes).flat().includes('webauthn_credentials_credential_id_uniq')],
['webauthn_credentials.sign_count 列がある', (afterUp.columns.webauthn_credentials ?? []).includes('sign_count')],
['webauthn_challenges に expires_at の index がある',
  Object.values(afterUp.indexes).flat().includes('webauthn_challenges_expires_at_idx')],
```

> **down の確認**: `0018` の down は `DROP TABLE webauthn_challenges; DROP TABLE webauthn_credentials;`。依存が無いので順序は任意。スクリプトが自動生成できる単純な形にしておく（Phase 5 §6.4 と同じ）。

---

## 7. 実装設計

### 7.1 新規ファイル一覧（18）

| # | パス | 種別 | 内容 |
|---|---|---|---|
| 1 | `drizzle/0018_passkey.sql` | migration | §6.1 |
| 2 | `src/lib/auth/passkey/config.ts` | 設定 | `rpID` / `rpName` / 許可 origin の解決と**許可リスト検証**（D-34-01） |
| 3 | `src/lib/auth/passkey/registration.ts` | ライブラリ | `generatePasskeyRegistrationOptions` / `verifyPasskeyRegistration`（`@simplewebauthn/server` の薄いラッパ） |
| 4 | `src/lib/auth/passkey/authentication.ts` | ライブラリ | `generatePasskeyAuthenticationOptions` / `verifyPasskeyAuthentication` |
| 5 | `src/lib/auth/passkey/challenge.ts` | ライブラリ | challenge の発行（DB insert）と **1 回限りの atomic 消費**（D-34-05） |
| 6 | `src/lib/db/queries/webauthn.ts` | クエリ | credentials の CRUD ＋ **atomic sign_count 更新** ＋ challenge の CRUD |
| 7 | `src/lib/validate/passkey.ts` | 検証 | zod スキーマ（登録/認証の応答、`device_name`、削除） |
| 8 | `src/app/api/auth/passkey/register/options/route.ts` | API | `POST` 登録 options（**再認証必須**） |
| 9 | `src/app/api/auth/passkey/register/verify/route.ts` | API | `POST` 登録検証・保存・通知・`passkey_added` |
| 10 | `src/app/api/auth/passkey/login/options/route.ts` | API | `POST` ログイン options（**未認証で呼べる**・discoverable） |
| 11 | `src/app/api/auth/passkey/login/verify/route.ts` | API | `POST` ログイン検証・**新セッション発行**・`sign_count` 更新・`last_used_at` 更新 |
| 12 | `src/app/api/auth/passkey/route.ts` | API | `GET` 一覧（`device_name` / `created_at` / `last_used_at`） |
| 13 | `src/app/api/auth/passkey/[id]/route.ts` | API | `DELETE`（**再認証必須**・最後のログイン手段チェック） |
| 14 | `src/app/api/auth/reauth/passkey/options/route.ts` | API | `POST` 再認証用 Passkey challenge の発行（D-34-12） |
| 15 | `src/components/auth/passkey-login-button.tsx` | 画面 | `/login` の「[パスキーでログイン]」と Ceremony |
| 16 | `src/components/settings/passkey-panel.tsx` | 画面 | 登録 / 一覧 / 削除のカード |
| 17 | `src/components/settings/strong-reauth-passkey-tab.tsx` | 画面 | `StrongReauthDialog` の Passkey タブ（D-34-11） |
| 18 | `src/test/helpers/webauthn-mock.ts` | テスト支援 | **実鍵（P-256）で署名した有効な** attestation / assertion を生成（§11.4） |

> **`messages/ja.ts` の `passkey` ブロックは「変更する既存ファイル」に計上**（§7.2 #18）。新規ファイルは上表の **18 件**。

> **`challenge`（保留セッション）を作らない**: Passkey は保留状態を持たない（D-34-09）。`passkey_pending` 列も使わない。

### 7.2 変更する既存ファイル

| # | パス | 変更 |
|---|---|---|
| 1 | `package.json` | `@simplewebauthn/server@^14.0.3` / `@simplewebauthn/browser@^14.0.0` を dependencies に追加 |
| 2 | `src/lib/db/schema.ts` | `webauthnCredentials` / `webauthnChallenges` テーブル定義（§6.3）。`ID_PREFIXES` に `wac` / `wch` |
| 3 | `src/lib/env.ts` | `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ALLOWED_ORIGINS` を zod に追加（dev/test 既定値・prod 必須・D-34-01） |
| 4 | `src/lib/util/logger.ts` | `SENSITIVE_KEYS` に `credentialId` / `publicKey` / `attestationObject` / `authenticatorData` / `clientDataJSON` / `signature` / `challenge` を追加（D-34-14） |
| 5 | `src/lib/auth/strong-reauth.ts` | 入力を `{ user, session, body }` に変更し、検証器配列に `passkeyVerifier` を追加。`availableStrongReauthMethods` を Passkey 有無で出し分け（D-34-11） |
| 6 | `src/app/api/auth/2fa/disable/route.ts` | `requireStrongReauth({ user, session, body })` へ小改修（**判定ロジックは不変**） |
| 7 | `src/app/api/auth/2fa/recovery-codes/regenerate/route.ts` | 同上 |
| 8 | `src/lib/auth/email/deliver.ts` | `EmailKind` に `passkey_change` を追加（D-34-15） |
| 9 | `src/components/settings/security-overview.tsx` | Passkey カードを「如实表示」から `<PasskeyPanel />` に差し替え。`passkeys` prop を追加 |
| 10 | `src/app/settings/security/page.tsx` | Passkey 一覧を取得して `passkeys` を渡す |
| 11 | `src/components/settings/strong-reauth-dialog.tsx` | `strong_reauth_methods` に `'passkey'` があれば Passkey タブを描画（Phase 5 の布石を接続） |
| 12 | `src/app/auth-form.tsx` | `passkeyEnabled`（サーバ側判定）のとき `<PasskeyLoginButton />` を描画 |
| 13 | `src/app/login/page.tsx` | `passkeyEnabled` を**サーバ側で判定**して props で渡す（BUG-11 の再発防止） |
| 14 | `scripts/purge-expired.ts` | `webauthn_challenges` の掃除ジョブを追加（D-34-16） |
| 15 | `scripts/verify-migrations.ts` | §6.4 の期待値追加 |
| 16 | `src/test/setup.ts` | `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ALLOWED_ORIGINS` のテスト既定値を注入 |
| 17 | `src/test/unit/oauth-client-boundary.test.ts` | Passkey のサーバ専用モジュールを検査対象に追加（BUG-11 の再発防止） |
| 18 | `src/messages/ja.ts` | `passkey.*` / `errors.*` の文言追加（§12.4） |

### 7.3 モジュール仕様

#### 7.3.1 `src/lib/auth/passkey/config.ts`

```ts
/** 許可リスト検証済みの WebAuthn 設定（起動時 fail fast・D-34-01）。 */
export type WebauthnConfig = {
  rpID: string;          // 例: 'example.com'（prod）/ 'localhost'（dev）
  rpName: string;        // 例: APP_NAME
  allowedOrigins: string[]; // 例: ['https://example.com']
};

/** env から解決する。テストのために env を引数で受ける（getEnv に依存しない）。 */
export function resolveWebauthnConfig(env: {
  NODE_ENV: string;
  WEBAUTHN_RP_ID?: string;
  WEBAUTHN_RP_NAME?: string;
  WEBAUTHN_ALLOWED_ORIGINS?: string;
}): WebauthnConfig;

export function getWebauthnConfig(): WebauthnConfig; // getEnv() を包む
```

- **fail fast の条件**（`env.ts` の zod refine と `resolveWebauthnConfig` の両方で検査）:
  1. `NODE_ENV === 'production'` で `WEBAUTHN_RP_ID` / `WEBAUTHN_ALLOWED_ORIGINS` が未設定・空 → throw。
  2. `NODE_ENV === 'production'` で `rpID === 'localhost'` または許可 origin に `localhost` を含む → throw。
  3. `WEBAUTHN_ALLOWED_ORIGINS` の各要素が**絶対 URL**（`https://`。dev/test のみ `http://localhost` を許容）でない → throw。
  4. 各 origin の host が `rpID` と**一致または `rpID` を末尾に持つ**（WebAuthn の rpID は origin の登録可能ドメインサフィックスでなければならない）→ 違反は throw。
- **`rpID` は `host` のポートを含めない**（WebAuthn の仕様）。dev は `localhost`、prod は登録可能ドメイン。
- **許可リスト検証は `@simplewebauthn/server` に `expectedOrigin: allowedOrigins`（配列）/ `expectedRPID: rpID` を渡すことで行う**。自前で `Origin` ヘッダを読んで比較しない（D-34-01）。
- **`WEBAUTHN_RP_NAME`** の既定は `APP_NAME`（`src/config/app.ts`）。

> **本番ドメインは確定しない**（計画 6-A-1 / §3.2）。Phase 9 のドメイン確定時に `.env` / Secret Manager へ固定する。

#### 7.3.2 `src/lib/auth/passkey/registration.ts`

```ts
import type { AuthenticatorTransportFuture, PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

/** 登録 options を作る（§32 #29）。既存 credential を excludeCredentials に入れて二重登録を防ぐ。 */
export async function generatePasskeyRegistrationOptions(args: {
  user: { id: string; username: string; displayName?: string | null };
  existingCredentialIds: string[];
  config: WebauthnConfig;
}): Promise<PublicKeyCredentialCreationOptionsJSON>;

/** 登録応答を検証する（§32 #30）。origin / rpID / challenge / flags / attestation を検証。 */
export async function verifyPasskeyRegistration(args: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  config: WebauthnConfig;
}): Promise<{
  credentialId: string;      // base64url
  publicKey: string;         // base64url
  signCount: number;
  transports: string[] | null;
  aaguid: string | null;
  backedUp: boolean;
}>;
```

- **`generatePasskeyRegistrationOptions`**:
  - `rpName: config.rpName` / `rpID: config.rpID` / `userName: user.username`。
  - **`userID` は `user.id` の bytes**（`isoUint8Array.fromUTF8String(user.id)`）。`userID` を省略すると毎回ランダムになり、同じユーザーの passkey が別ユーザー扱いになる（**必ず固定する**）。
  - `excludeCredentials: existingCredentialIds.map((id) => ({ id }))`。
  - `authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }`。
  - `attestationType: 'none'`。
- **`verifyPasskeyRegistration`**:
  - `verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: config.allowedOrigins, expectedRPID: config.rpID, requireUserVerification: false })`。
    - **`requireUserVerification: false`**: `userVerification: 'preferred'` で登録するため、UV フラグは**必須にしない**（`true` にすると UV 非対応のセキュリティキーで登録できない）。
  - `verified !== true` は `ApiError('INVALID_CODE', 'パスキーの登録を検証できませんでした', 400)`。
  - `registrationInfo` から `credential.id` / `credential.publicKey`（`isoBase64URL.fromBuffer`）/ `counter` / `credentialDeviceType` / `credentialBackedUp` / `aaguid` を取り出す。
  - `transports` は `response.response.transports`（あれば）。

#### 7.3.3 `src/lib/auth/passkey/authentication.ts`

```ts
/** ログイン options（§32 #31）。user が分かる場合は allowCredentials を入れる。discoverable は空。 */
export async function generatePasskeyAuthenticationOptions(args: {
  credentials?: { credentialId: string; transports: string[] | null }[];
  config: WebauthnConfig;
}): Promise<PublicKeyCredentialRequestOptionsJSON>;

/** ログイン応答を検証する（§32 #32）。 */
export async function verifyPasskeyAuthentication(args: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  storedCredential: { credentialId: string; publicKey: string; signCount: number; transports: string[] | null };
  config: WebauthnConfig;
}): Promise<{ newCounter: number; backedUp: boolean }>;
```

- **`generatePasskeyAuthenticationOptions`**:
  - `rpID: config.rpID` / `userVerification: 'preferred'`。
  - `allowCredentials`: 渡された credential を `{ id, transports }` に変換して入れる。**渡されなければ空配列**（= discoverable credential を許容）。
- **`verifyPasskeyAuthentication`**:
  - `verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: config.allowedOrigins, expectedRPID: config.rpID, credential: { id, publicKey: isoBase64URL.toBuffer(publicKey), counter: signCount, transports }, requireUserVerification: false })`。
  - **`@simplewebauthn/server` が `sign_count` の後退を検知して throw する**（`counter <= credential.counter` かつ どちらかが 0 でない）。throw は `ApiError('INVALID_CODE', ...)` に丸める（D-34-06）。
  - 戻り `authenticationInfo.newCounter` を返す。呼び出し側（`login/verify`）が **atomic 更新**（D-34-06）を行う。

#### 7.3.4 `src/lib/auth/passkey/challenge.ts`

```ts
export const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 分（D-34-05）

/** challenge を発行し、DB に保存する。戻り値の `challenge` を options に渡す。 */
export async function issueChallenge(args: {
  userId: string | null;
  type: 'registration' | 'authentication';
}): Promise<{ id: string; challenge: string }>;

/**
 * challenge を **1 回限り**で消費する（D-34-05）。
 * 一致・未消費・期限内のときだけ保存された `challenge` を返す。それ以外は null。
 */
export async function consumeChallenge(args: {
  id: string;                       // クライアントが返す challenge_id（wch_...）
  type: 'registration' | 'authentication';
  userId: string | null;
}): Promise<{ challenge: string; userId: string | null } | null>;
```

- **`issueChallenge`**: `@simplewebauthn/server` の `generateChallenge()` で 32 バイトの base64url challenge を作り、`webauthn_challenges` に `{ id: newId('wch'), userId, type, challenge, expiresAt: now + 5min }` を insert する。**`id` を `challenge_id` としてクライアントへ返す**（`challenge` 文字列は options に含まれる）。
- **`consumeChallenge`**: **単文 UPDATE**（D-16 と同じ形）。`id`（内部 ID）で引くのは、**検証前の `clientDataJSON` を信用せずに**対象行を特定するため（§8.3 の注意参照）:

```sql
UPDATE webauthn_challenges
SET consumed_at = now()
WHERE id = $1 AND type = $2
  AND consumed_at IS NULL AND expires_at > now()
  AND (user_id = $3 OR user_id IS NULL)
RETURNING challenge, user_id
```

  - 更新行数 **1 → 消費成功**（戻り値の `challenge` を `expectedChallenge` に渡す）、**0 → 失敗**（再利用・期限切れ・type 不一致・他人の challenge）。
  - **`user_id` の照合**: 登録・再認証の challenge は `user_id` を入れるので、**他人の challenge を消費できない**。ログイン（discoverable）は `user_id IS NULL` を許容する。
- **challenge は応答に含めてよい**（クライアントの `navigator.credentials` に必要）。**ログには出さない**（D-34-14）。

#### 7.3.5 `src/lib/db/queries/webauthn.ts`

```ts
export async function insertCredential(data: {
  id: string; userId: string; credentialId: string; publicKey: string;
  signCount: number; transports: string[] | null; aaguid: string | null;
  deviceName: string | null; backedUp: boolean;
}): Promise<void>;

export async function listCredentialsByUser(userId: string): Promise<WebauthnCredential[]>;
export async function countCredentialsByUser(userId: string): Promise<number>;
export async function findCredentialByIdForUser(id: string, userId: string): Promise<WebauthnCredential | null>;
export async function findCredentialByCredentialId(credentialId: string): Promise<WebauthnCredential | null>;
export async function deleteCredential(id: string, userId: string): Promise<boolean>;

/** sign_count を atomic に進める（D-34-06）。戻り値は「進めたか」。 */
export async function advanceSignCount(args: {
  credentialId: string; userId: string; newCounter: number;
}): Promise<boolean>;

// challenge の insert / 取得（消費は challenge.ts の単文 UPDATE）
export async function insertChallenge(data: { ... }): Promise<void>;
```

- **`advanceSignCount`** は 2 経路に分ける（D-34-06）:
  - `newCounter === 0`（カウンタ非対応）: `UPDATE ... SET last_used_at = now() WHERE credential_id = $1 AND user_id = $2` の更新行数 = 1 を返す（**後退判定をしない**）。
  - `newCounter > 0`: `UPDATE ... SET sign_count = $3, last_used_at = now() WHERE credential_id = $1 AND user_id = $2 AND sign_count < $3` の更新行数 = 1 を返す（**単調増加のみ**）。
- **`deleteCredential`** は `WHERE id = $1 AND user_id = $2` で owner 確認（IDOR 防止・§49）。戻り値は更新行数 = 1。
- **`findCredentialByCredentialId`** はログイン時に credential → user を解決する。**`deleted_at IS NULL` の user を JOIN して確認**する（削除済みユーザーの credential でログインさせない）。

#### 7.3.6 `src/lib/validate/passkey.ts`

```ts
/** 登録・認証の応答（@simplewebauthn/browser の戻りをそのまま受ける）。中身の検証はライブラリに委ねる。 */
export const registrationResponseSchema = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  response: z.object({
    clientDataJSON: z.string().min(1),
    attestationObject: z.string().min(1),
    transports: z.array(z.string()).optional(),
  }),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().optional(),
}).strict();

export const authenticationResponseSchema = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  response: z.object({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().optional(),
  }),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().optional(),
}).strict();

export const registerVerifySchema = z.object({
  response: registrationResponseSchema,
  device_name: z.string().max(120).optional(),
}).strict();

export const loginVerifySchema = z.object({
  response: authenticationResponseSchema,
}).strict();
```

> **中身の暗号学的検証はスキーマでやらない**。zod は**形**（必須キー・型）だけを検査し、`@simplewebauthn/server` が署名・challenge・origin を検証する（D-34-03）。

#### 7.3.7 `src/lib/auth/strong-reauth.ts`（Phase 5 からの差分）

```ts
export type StrongReauthMethod = 'password' | 'passkey';   // 既存

export function availableStrongReauthMethods(user: User): StrongReauthMethod[];
// Phase 6: Passkey を 1 件以上持つなら ['password', 'passkey']、無ければ ['password']

type StrongReauthInput = { user: User; session: SessionData; body: unknown };

const passwordAndCodeVerifier: StrongReauthVerifier = async ({ user, session, body }) => {
  checkReauth(session);                       // 5 分猶予（無ければ REAUTH_REQUIRED）
  const code = readCode(body);                // body.code
  if (!code) return false;                    // 2FA 有効なら必須
  return TOTP_CODE_PATTERN.test(code)
    ? (await verifyAndConsumeTotp({ userId: user.id, code })).ok
    : consumeRecoveryCode(user.id, code);
};

/** Phase 6 で追加: 再認証用 Passkey challenge への assertion を検証する（D-34-11）。 */
const passkeyVerifier: StrongReauthVerifier = async ({ user, body }) => {
  const response = readPasskeyAssertion(body); // body.passkey
  if (!response) return false;
  // credential を引く → consumeChallenge('authentication', user.id) → verifyPasskeyAuthentication
  // → advanceSignCount。成功で true。
};

const verifiers: StrongReauthVerifier[] = [passwordAndCodeVerifier, passkeyVerifier];

export async function requireStrongReauth(input: StrongReauthInput): Promise<{ method: StrongReauthMethod }>;
```

- **判定順は「パスワード＋コード → Passkey」**。どれか 1 つ通れば成功（Phase 5 D-33-24 の構造を維持）。
- **`availableStrongReauthMethods`** は `countCredentialsByUser(user.id) > 0` で判定する。**DB を引く**ため同期関数から**非同期**に変える（`Promise<StrongReauthMethod[]>`）。呼び出し側（`GET /2fa` と `/settings/security` のページ）を `await` に更新する。
- **`REAUTH_REQUIRED` と `INVALID_CODE` の使い分け**は Phase 5 と同じ: 再認証未了 → 401 `REAUTH_REQUIRED`、再認証済みでコード誤り → 400 `INVALID_CODE`。**Passkey 検証に失敗しても、パスワード再認証が未了なら `REAUTH_REQUIRED` を返す**（UI がパスワード欄を出すため）。

#### 7.3.8 `src/lib/util/logger.ts` の redaction 追加（D-34-14）

`SENSITIVE_KEYS` に追加する（正規化は `toLowerCase().replace(/[^a-z0-9]/g, '')` 済み）:

- `credentialId` → `credentialid`
- `publicKey` → `publickey`
- `attestationObject` → `attestationobject`
- `authenticatorData` → `authenticatordata`
- `clientDataJSON` → `clientdatajson`
- `signature` → `signature`
- `challenge` → `challenge`

> `code` / `state` / `nonce` / `secret` は Phase 5 までに登録済み。`challenge` は OIDC の `code_challenge`（PKCE）とは別物だが、**平文で残す理由が無い**ので redact する（PKCE の `code_challenge` は公開値だが、WebAuthn の challenge は使い捨ての乱数で、ログに残す必要が無い）。

---
## 8. API 契約

全 API は **`withAuthPipeline` を通す**（Origin → CSRF → session → user → body → reauth → handler）。
エラーは §58 の統一形式（`{ success: false, error: { code, message } }`）。応答は `Cache-Control: no-store`。
**新規 API はすべて `withAuthPipeline` を通し、レート制限を課す。**

### 8.1 `GET /api/auth/passkey` — 一覧

```ts
// withAuthPipeline({ requireAuth: true })
type Response = {
  passkeys: {
    id: string;             // 内部 ID（wac_...）。削除の URL に使う
    device_name: string | null;
    created_at: string;     // ISO
    last_used_at: string | null;
    backed_up: boolean;
    transports: string[] | null;
  }[];
};
```

- **`credential_id` / `public_key` は返さない**（§45。応答に外部 ID を出さない。削除は内部 ID で行う）。
- レート制限: `rateLimitKeys.settingsUser(user.id)`（120/分・soft 60）。
- ページ `/settings/security` はサーバ側で直接クエリする（API を経由しない）。この API は将来の他画面・Phase 7 用。

### 8.2 `POST /api/auth/passkey/register/options` — 登録 options

```ts
// withAuthPipeline({ requireAuth: true, requireReauth: true })
// 追加ガード: email_verified === true かつ status === 'active'（D-34-02）
type Response = {
  options: PublicKeyCredentialCreationOptionsJSON; // @simplewebauthn/server の戻り
  challenge_id: string;
};
```

- **再認証必須**（§8 / D-34-08）。`requireReauth: true` を使う（パスワード再認証の 5 分猶予）。
- 未確認 email は **403 `EMAIL_NOT_VERIFIED`**（D-34-02）。
- 既存 credential を `excludeCredentials` に入れる（二重登録防止）。
- `issueChallenge({ userId: user.id, type: 'registration' })` で challenge を保存。
- レート制限: `rateLimitKeys.passkeyIp(ip)`（30/5分・soft 10）。
- 応答の `options.challenge` に challenge が含まれる（クライアントに必要）。**ログには出さない**。

### 8.3 `POST /api/auth/passkey/register/verify` — 登録検証

```ts
// withAuthPipeline({ requireAuth: true, requireReauth: true })
// body: { response: RegistrationResponseJSON, challenge_id: string, device_name?: string }
type Response = {
  passkey: { id: string; device_name: string | null; created_at: string };
};
```

- 手順（**この順序**）:
  1. `consumeChallenge({ id: challenge_id, type: 'registration', userId: user.id })` で **1 回限り消費**し、保存された challenge 文字列を得る。失敗なら 400 `INVALID_CODE`（§48「challenge 再利用」）。
  2. `verifyPasskeyRegistration({ response, expectedChallenge, config })`。
  3. `insertCredential(...)`（`public_key` は base64url。**公開鍵のみ**）。
  4. `recordSecurityEvent('passkey_added', user.id, ip, ua, { device_name })`。
  5. 通知メール（`passkey_change`・best-effort・D-34-15）。
- `device_name` は `body.device_name`（切り詰め・制御文字除去）または `deriveDeviceName(ua)`（D-34-10）。
- レート制限: `passkeyIp(ip)`。

> **challenge の特定方法**: `verifyRegistrationResponse` は `expectedChallenge` を**呼び出し側が渡す**。DB から引くために、**options 発行時に `challenge_id` を返し、verify の body に含めてもらう**方式を採る。`response.response.clientDataJSON` を事前にパースして challenge を取り出す方式は、**検証前のデータを信用する**ことになるため採らない。`challenge_id` は内部 ID（`wch_`）で外部に意味を持たない。

### 8.4 `POST /api/auth/passkey/login/options` — ログイン options

```ts
// withAuthPipeline({ requireAuth: false })   ← 未認証で呼べる（D-34-07）
// body: {} （任意で { username } を受けるが MVP は discoverable のみ）
type Response = {
  options: PublicKeyCredentialRequestOptionsJSON;
  challenge_id: string;
};
```

- **`requireAuth: false`**。セッションがあっても無くても呼べる。
- discoverable 対応のため `allowCredentials` は**空**で発行する。`user_id` は `null` で challenge を保存する。
- レート制限: `passkeyIp(ip)`。
- **応答は列挙耐性**: この API はユーザーを特定しないので、存在有無の情報を漏らさない（`username` を受けても**常に同じ形**を返す）。

### 8.5 `POST /api/auth/passkey/login/verify` — ログイン検証

```ts
// withAuthPipeline({ requireAuth: false })
// body: { response: AuthenticationResponseJSON, challenge_id: string }
type Response = { message: string };  // 成功時は Set-Cookie で新セッション
```

- 手順:
  1. `consumeChallenge({ id: challenge_id, type: 'authentication', userId: null })` で **1 回限り消費**。失敗は 400 `INVALID_CODE`。
  2. `response.id`（credential ID）で `findCredentialByCredentialId` → 行が無ければ 400 `INVALID_CODE`（§48「削除済み credential」）。
  3. **user の状態を再確認**: `status = 'active'` / `email_verified = true` / `deleted_at IS NULL`。違反は **403 `ACCOUNT_SUSPENDED`**（削除も同じ 403 にまとめ、どちらの事実か教えない）。
  4. `verifyPasskeyAuthentication({ response, expectedChallenge, storedCredential, config })`。失敗（sign_count 後退含む）は 400 `INVALID_CODE`。
  5. **`advanceSignCount`（atomic・D-34-06）**。`newCounter === 0` は `last_used_at` のみ更新。
  6. **`createSession(user.id, request)`（新セッション・D-34-07）**。`setSessionCookie` ＋ `setAnonCookie`。
  7. `recordSecurityEvent('login_success', user.id, ip, ua, { method: 'passkey' })`。
  8. 新規デバイス通知（既存 `isFirstSessionFromDevice` / `notifyNewDeviceLogin`）。
- 失敗時は `recordSecurityEvent('login_failed', <特定できた user.id または null>, ip, ua, { scope: 'passkey' })`。**user が特定できない場合は `user_id = null`**（列挙耐性）。
- レート制限: `passkeyIp(ip)`。

> **challenge 消費と検証の順序**: challenge を**先に**消費し、検証に失敗したら消費済みのままにする（再送を防ぐ）。Phase 5 の「再認証 → コード」と同じく、**失敗時に再利用させない**方針（R11）。

### 8.6 `DELETE /api/auth/passkey/{id}` — 削除

```ts
// withAuthPipeline({ requireAuth: true })  ← 削除の「強い再認証」は body で行う
// body: { code?: string, passkey?: AuthenticationResponseJSON, challenge_id?: string }
type Response = { message: string };
```

- **再認証必須**（§8 / D-34-08）。**`requireStrongReauth` を通す**（パスワード＋コード、または Passkey）。
- **最後のログイン手段チェック**: `password_hash IS NULL` かつ **Passkey 1 件** かつ **TOTP 無効** のとき削除すると締め出される → **409 `LAST_LOGIN_METHOD`**。
  - 判定: `user.passwordHash === null && countCredentialsByUser(user.id) <= 1 && !totpEnabled`.
- `deleteCredential(id, user.id)`（owner 確認・§49）。存在しない / 他人は同じ 404 `INVALID_TOKEN`（どちらの事実か教えない）。
- `recordSecurityEvent('passkey_removed', user.id, ip, ua, { device_name })` ＋ 通知（best-effort）。
- レート制限: `settingsUser(user.id)`。

### 8.7 `POST /api/auth/reauth/passkey/options` — 再認証用 Passkey challenge

```ts
// withAuthPipeline({ requireAuth: true })
type Response = { options: PublicKeyCredentialRequestOptionsJSON; challenge_id: string };
```

- ログイン中のユーザーの credential を `allowCredentials` に入れて challenge を発行する（`user_id` 付き・D-34-12）。
- この challenge は `requireStrongReauth` の `passkeyVerifier` が消費する（`type: 'authentication'`、`user_id` 一致必須）。
- レート制限: `settingsUser(user.id)`。
- **`reauth`（パスワード）API は変更しない**。

### 8.8 エラーコード一覧（Phase 6 で使う）

| コード | ステータス | 使用箇所 |
|---|---|---|
| `INVALID_CODE` | 400 | challenge 消費失敗・署名検証失敗・sign_count 後退・削除済み credential |
| `EMAIL_NOT_VERIFIED` | 403 | Passkey 登録の未確認 email（既存コード・Phase 5 で追加済み） |
| `ACCOUNT_SUSPENDED` | 403 | ログイン時に user が suspended/deleted（既存コード） |
| `REAUTH_REQUIRED` | 401 | `requireStrongReauth` の再認証未了（既存コード） |
| `LAST_LOGIN_METHOD` | 409 | 最後のログイン手段の削除（既存コード） |
| `INVALID_TOKEN` | 404 | 存在しない / 他人の credential の削除（既存コード。status を 404 に上書き） |
| `RATE_LIMITED` | 429 | レート制限超過（既存コード） |
| `VALIDATION_ERROR` | 400 | zod 検証失敗（既存コード） |

> **新規エラーコードを追加しない**（D-34-13）。既存コードで表現できる。

---

## 9. フロー設計

### 9.1 登録（`/settings/security` → register options → verify）

```text
1. 利用者が「Passkey を追加」を押す
2. （再認証が必要なら）StrongReauthDialog。パスワード＋コード or Passkey で再認証
3. POST /api/auth/passkey/register/options
     - requireReauth（5 分猶予）を確認。未了なら 401 REAUTH_REQUIRED
     - email_verified を確認。未確認なら 403 EMAIL_NOT_VERIFIED
     - issueChallenge(registration, user.id) → challenge_id と options を返す
4. クライアント: startRegistration(options)（@simplewebauthn/browser）→ navigator.credentials.create
5. POST /api/auth/passkey/register/verify { response, challenge_id, device_name }
     - consumeChallenge(challenge_id, registration, user.id) → 失敗なら 400 INVALID_CODE
     - verifyPasskeyRegistration → 失敗なら 400 INVALID_CODE
     - insertCredential（公開鍵のみ・秘密鍵はサーバに来ない）
     - recordSecurityEvent(passkey_added) ＋ 通知メール
6. 一覧を再取得して表示（device_name / created_at）
```

### 9.2 ログイン（`/login` → login options → verify → 新セッション）

```text
1. 利用者が「[パスキーでログイン]」を押す
2. POST /api/auth/passkey/login/options（requireAuth: false）
     - issueChallenge(authentication, null) → challenge_id と options（allowCredentials 空）
3. クライアント: startAuthentication(options) → navigator.credentials.get
4. POST /api/auth/passkey/login/verify { response, challenge_id }
     - consumeChallenge(challenge_id, authentication, null) → 失敗なら 400 INVALID_CODE
     - findCredentialByCredentialId(response.id) → 無ければ 400 INVALID_CODE
     - user の状態確認（active / email_verified / 未削除）→ 違反は 403 ACCOUNT_SUSPENDED
     - verifyPasskeyAuthentication（origin / rpIDHash / signature / flags / sign_count）→ 失敗は 400
     - advanceSignCount（atomic）→ 0 行なら 400（並行 replay・D-34-06）
     - createSession → Set-Cookie（新セッション）
     - recordSecurityEvent(login_success, method=passkey) ＋ 新規デバイス通知
5. トップ（または returnTo）へ遷移
```

### 9.3 再認証（Passkey・D-34-11 / D-34-12）

```text
1. 2FA 無効化 / 再生成 / Passkey 削除で StrongReauthDialog が Passkey タブを出す
   （GET /api/auth/2fa の strong_reauth_methods に 'passkey' が含まれるとき）
2. POST /api/auth/reauth/passkey/options（requireAuth: true）
     - 自分の credential を allowCredentials に入れて challenge を発行
3. クライアント: startAuthentication(options)
4. 本体 API（例: DELETE /api/auth/passkey/{id}、POST /api/auth/2fa/disable）に
   { passkey: response, challenge_id } を送る
5. requireStrongReauth が passkeyVerifier で
     consumeChallenge → verifyPasskeyAuthentication → advanceSignCount
   を実行し、成功なら本体処理へ進む
```

### 9.4 challenge の 1 回限り（D-34-05）

```text
- 発行: INSERT webauthn_challenges（expires_at = now + 5分）
- 消費: UPDATE webauthn_challenges SET consumed_at = now()
        WHERE id = $ AND type = $ AND consumed_at IS NULL AND expires_at > now()
          AND (user_id = $ OR user_id IS NULL)
        更新行数 = 1 のときだけ成功（単文・D-16）
- 失敗の扱い: 400 INVALID_CODE（再利用・期限切れ・type 不一致・他人の challenge を区別しない）
```

---

## 10. セキュリティ設計（脅威モデル）

§48「Passkey」の 5 項目を、テストで固定する。

| 脅威 | 対策 | テスト |
|---|---|---|
| **challenge 再利用** | DB 保存 ＋ 単文 UPDATE の 1 回限り消費（D-34-05） | `webauthn-challenge-reuse.test.ts` |
| **origin mismatch** | `expectedOrigin: allowedOrigins`（配列）で検証。request の `Origin` を信頼しない（D-34-01） | `webauthn-origin.test.ts` |
| **RP ID mismatch** | `expectedRPID: rpID`（明示設定）で検証。host から導出しない（D-34-01） | `webauthn-rpid.test.ts` |
| **credential 削除後の認証** | 行を物理削除。無ければ 400（§48） | `webauthn-deleted.test.ts` |
| **sign counter 処理** | 後退を拒否。更新は atomic。`newCounter === 0` は例外（D-34-06） | `webauthn-signcount.test.ts` |

### 10.1 §45（情報漏洩防止）のチェック

- 秘密鍵はサーバに送られない（WebAuthn の仕様）。サーバは**公開鍵のみ**保存する（§12）。
- `credential_id` / `public_key` / `challenge` / `signature` / `attestation_object` を**ログ・API 応答・`security_events.metadata` に出さない**（D-34-14）。
  - `GET /api/auth/passkey` は内部 ID のみ返す（§8.1）。
  - `security_events.metadata` には `device_name` と `method` だけを入れる。
- `challenge` は応答（options）に含めるが、**ログには出さない**。
- 通知メール本文には credential ID・公開鍵・署名を**入れない**（D-34-15）。

### 10.2 追加の脅威

| 脅威 | 対策 |
|---|---|
| セッション窃取者による Passkey 追加 | 登録に**再認証必須**（D-34-08）。追加すると通知メールが飛ぶ |
| セッション窃取者による Passkey 削除（締め出し） | 削除に**再認証必須**。最後のログイン手段は 409（D-34-08） |
| IDOR（他人の credential を削除） | `deleteCredential(id, userId)` で owner 確認。存在しない/他人は同じ 404（§49） |
| 列挙（login/options でユーザー特定） | discoverable 発行でユーザーを特定しない。応答は常に同一形（§46） |
| 総当たり | `rl:passkey:ip:{ip}` = 30/5分（§16） |
| クローンされた authenticator | `sign_count` の後退検知（D-34-06） |

---

## 11. テスト設計

### 11.1 新規テストファイル（13）

| # | パス | 種別 | 内容 |
|---|---|---|---|
| 1 | `src/test/unit/passkey-config.test.ts` | unit | env → config の解決。prod で `localhost`・未設定・空を throw。origin と rpID のサフィックス整合 |
| 2 | `src/test/unit/passkey-registration.test.ts` | unit | options の構造（rpID / userID 固定 / excludeCredentials / residentKey）。verify の戻り |
| 3 | `src/test/unit/passkey-authentication.test.ts` | unit | options の構造（allowCredentials 空 / transports）。verify の戻り・`sign_count` 後退で throw |
| 4 | `src/test/unit/passkey-challenge.test.ts` | unit | 発行 → 消費が 1 回限り。期限切れ・type 不一致・他人の challenge を弾く |
| 5 | `src/test/integration/webauthn-queries.test.ts` | integration | `advanceSignCount` の 2 経路（0 / 正の単調増加）。`deleteCredential` の owner 確認。`bigint` の往復 |
| 6 | `src/test/security/webauthn-register.test.ts` | security | 登録の happy path。未確認 email は 403。二重登録の拒否。`passkey_added` 記録 |
| 7 | `src/test/security/webauthn-login.test.ts` | security | ログインの happy path。**新セッション**発行。削除済み user の拒否 |
| 8 | `src/test/security/webauthn-challenge-reuse.test.ts`★ | security | 同じ `challenge_id` を 2 回 → 2 回目 400（DoD 直結） |
| 9 | `src/test/security/webauthn-origin.test.ts`★ | security | 許可外 origin の応答 → 400。`Origin` ヘッダ偽装でも通らない |
| 10 | `src/test/security/webauthn-rpid.test.ts`★ | security | 別 rpID の応答 → 400 |
| 11 | `src/test/security/webauthn-signcount.test.ts`★ | security | `sign_count` 後退 → 400。`newCounter === 0` は通る |
| 12 | `src/test/security/webauthn-deleted.test.ts`★ | security | 削除後の credential で認証 → 400 |
| 13 | `src/test/security/passkey-reauth.test.ts` | security | Passkey での再認証が `requireStrongReauth` を通る。最後のログイン手段の削除が 409 |

### 11.2 既存テストへの追記

| # | パス | 追記 |
|---|---|---|
| 1 | `src/test/unit/strong-reauth.test.ts` | 入力を `{ body }` に変更。`passkeyVerifier` を足すと通る（Phase 5 の布石を実証）。`availableStrongReauthMethods` が `['password', 'passkey']` を返す |
| 2 | `src/test/security/rate-limit.test.ts` | `RATE_LIMITS.passkey`（30/300_000）を追加 |
| 3 | `src/test/security/security-events-coverage.test.ts` | `passkey/**` ルートの `recordSecurityEvent` を追加 |
| 4 | `src/test/security/log-redaction.test.ts` | `credentialId` / `publicKey` / `challenge` / `signature` 等のケースを追加（D-34-14） |
| 5 | `src/test/integration/purge-expired.test.ts` | `webauthn_challenges` の掃除を追加（D-34-16） |
| 6 | `src/test/unit/oauth-client-boundary.test.ts` | Passkey のサーバ専用モジュールを検査対象に追加 |

### 11.3 静的な検査（回帰防止）

- `@simplewebauthn/server` / `passkey/config` / `db/queries/webauthn` が**クライアントコンポーネントから import されていない**（`oauth-client-boundary.test.ts` に追加・BUG-11）。
- `rpID` / `origin` が **request の `Host` / `Origin` ヘッダから導出されていない**（`passkey/config.ts` が `request` / `headers` を受け取っていないことを grep で検査）。
- `webauthn_credentials.public_key` を**応答に含めていない**（`credentialId` / `publicKey` を返す応答が無いことを grep で検査）。

### 11.4 テストの実装方式

- **`src/test/helpers/webauthn-mock.ts` が肝**。`@simplewebauthn/server` は**実際の署名を検証する**ため、スタブでは通らない。テスト用の **P-256 鍵ペアを生成**し、`clientDataJSON` / `authenticatorData` / `attestationObject` / `signature` を**仕様どおり組み立てて署名**する。
  - 実 HTTP テスト（`app-server.ts`）では、この helper が作った応答を `POST` する。
  - `expectedOrigin` / `expectedRPID` を**わざと外した**応答も作れるようにし、`webauthn-origin` / `webauthn-rpid` を検証する。
  - `sign_count` を任意に設定できるようにし、後退ケースを作る。
- 実ブラウザの `navigator.credentials` は**テストしない**（Phase 8-B の Playwright）。サーバ検証を実鍵で通すことが本フェーズのテストの主眼。
- 時間依存（challenge の TTL 5 分）は `vi.setSystemTime` を使う。

---

## 12. UI 設計

### 12.1 `/settings/security` の Passkey カード

- 未登録: 「Passkey はまだ登録されていません」＋「Passkey を追加」ボタン。
- 登録済み: 一覧（`device_name` /「追加日時」/「最終使用」/「同期」バッジ）＋「Passkey を追加」＋ 各行に「削除」。
- 削除は **`StrongReauthDialog`** を通す（D-34-08）。
- 残り 1 件で `password_hash` が無く TOTP 無効なら、削除ボタンを**無効化**し理由を出す（409 の事前提示。サーバでも弾く）。

### 12.2 `/login` の Passkey ボタン

- サーバ側で `passkeyEnabled` を判定し、props で渡す（**`process.env` をクライアントで読まない**・BUG-11）。
- ボタン押下 → `login/options` → `startAuthentication` → `login/verify` → トップへ。
- 失敗（`INVALID_CODE`）は「パスキーでログインできませんでした。別の方法をお試しください。」を表示し、**ユーザー列挙に資する情報を出さない**。

### 12.3 `StrongReauthDialog` の Passkey タブ（D-34-11）

- `strong_reauth_methods` に `'passkey'` が含まれるときだけタブを出す。
- Passkey タブ: `reauth/passkey/options` → `startAuthentication` → 本体 API へ `{ passkey, challenge_id }` を送る。
- パスワードタブは Phase 5 のまま（パスワード＋コード）。

### 12.4 文言（`src/messages/ja.ts`）

```ts
passkey: {
  title: 'Passkey',
  count: '{count} 件',
  none: 'Passkey はまだ登録されていません。',
  add: 'Passkey を追加',
  addHint: '端末の生体認証やセキュリティキーでログインできます。',
  remove: '削除',
  removeConfirm: 'この Passkey を削除しますか？',
  lastMethod: '最後のログイン手段のため削除できません。先にパスワードまたは 2 段階認証を設定してください。',
  createdAt: '追加日時',
  lastUsedAt: '最終使用',
  neverUsed: '未使用',
  synced: '同期',
  deviceNameLabel: 'デバイス名（任意）',
  deviceNamePlaceholder: '例: MacBook の Touch ID',
  registerFailed: 'Passkey を登録できませんでした。',
  loginFailed: 'パスキーでログインできませんでした。別の方法をお試しください。',
  loginButton: 'パスキーでログイン',
  notSupported: 'この端末・ブラウザは Passkey に対応していません。',
  reauthTabPasskey: 'Passkey で確認',
},
```

---

## 13. タスク分解と工数

`実装Todo.md` の P6-A-01 / P6-A-02 を起点に、実装順に分解する。★ は DoD 直結。

### 13.1 P6-A: 基盤（8.9h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P6-A-01 | `package.json` に `@simplewebauthn/server` / `browser` を追加 | — | 0.3h | `pnpm install` が通り、型が解決する |
| P6-A-02 | `drizzle/0018_passkey.sql` ＋ `schema.ts` ＋ `verify-migrations.ts` 期待値 | — | 1.2h | `pnpm db:migrate` と `pnpm db:verify-migrations` が green |
| P6-A-03★ | `env.ts` に WebAuthn 変数 ＋ `passkey/config.ts`（fail fast・許可リスト） | A-01 | 1.2h | `passkey-config.test.ts` green |
| P6-A-04 | `src/lib/db/queries/webauthn.ts`（CRUD ＋ atomic sign_count ＋ challenge） | A-02 | 1.4h | `webauthn-queries.test.ts` green |
| P6-A-05★ | `src/lib/auth/passkey/challenge.ts`（1 回限り消費） | A-04 | 1.0h | `passkey-challenge.test.ts` green |
| P6-A-06 | `src/lib/auth/passkey/registration.ts` / `authentication.ts` | A-01, A-03 | 2.0h | `passkey-registration.test.ts` / `passkey-authentication.test.ts` green |
| P6-A-07 | `src/test/helpers/webauthn-mock.ts`（実鍵で署名） | A-06 | 1.5h | mock の応答が `verify*` を通る |
| P6-A-08 | `src/lib/validate/passkey.ts` ＋ `logger.ts` redaction ＋ `ID_PREFIXES` | — | 0.3h | 型が通り、`log-redaction.test.ts` green |

### 13.2 P6-B: API とフロー（10.3h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P6-B-01 | `POST /passkey/register/options` | A-06 | 1.0h | 未確認 403・再認証未了 401・options が返る |
| P6-B-02 | `POST /passkey/register/verify`（＋通知・`passkey_added`） | B-01 | 1.4h | `webauthn-register.test.ts` green |
| P6-B-03 | `POST /passkey/login/options`（未認証・discoverable） | A-06 | 0.8h | 未認証で呼べる |
| P6-B-04★ | `POST /passkey/login/verify`（新セッション・atomic sign_count） | B-03 | 1.8h | `webauthn-login.test.ts` green |
| P6-B-05 | `GET /passkey`（一覧・内部 ID のみ） | A-04 | 0.6h | 応答に `credential_id` / `public_key` が出ない |
| P6-B-06 | `DELETE /passkey/{id}`（再認証・最後の手段 409） | B-05 | 1.4h | `passkey-reauth.test.ts`（削除部分）green |
| P6-B-07 | `POST /reauth/passkey/options`（D-34-12） | B-03 | 0.8h | 再認証用 challenge が発行される |
| P6-B-08★ | `strong-reauth.ts` に `passkeyVerifier` ＋ 2FA ルートの小改修（D-34-11） | B-07 | 1.5h | `strong-reauth.test.ts` green。2FA の無効化・再生成が Passkey で通る |
| P6-B-09 | `deliver.ts` の `EmailKind` ＋ 通知（D-34-15） | B-02 | 0.6h | 追加・削除で通知が飛ぶ（best-effort） |
| P6-B-10 | `purge-expired.ts` に challenge 掃除（D-34-16） | A-02 | 0.4h | `purge-expired.test.ts` green |

### 13.3 P6-C: セキュリティテスト（6.2h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P6-C-01★ | `webauthn-challenge-reuse.test.ts` | B-04 | 1.2h | green（DoD 直結） |
| P6-C-02★ | `webauthn-origin.test.ts` | B-04 | 1.0h | green（DoD 直結） |
| P6-C-03★ | `webauthn-rpid.test.ts` | B-04 | 0.8h | green（DoD 直結） |
| P6-C-04★ | `webauthn-signcount.test.ts` | B-04 | 1.2h | green（DoD 直結） |
| P6-C-05★ | `webauthn-deleted.test.ts` | B-06 | 0.8h | green（DoD 直結） |
| P6-C-06 | `passkey-reauth.test.ts`（再認証・最後の手段） | B-08 | 1.0h | green |
| P6-C-07 | 既存テストへの追記（§11.2） | C-01 | 0.4h | 全 green |

### 13.4 P6-D: UI（5.0h）

| ID | タスク | 依存 | 工数 | 完了定義 |
|---|---|---|---|---|
| P6-D-01 | `PasskeyPanel` ＋ `security-overview.tsx` 差し替え | B-06 | 1.6h | 登録 → 一覧 → 削除が画面で動く |
| P6-D-02 | `PasskeyLoginButton` ＋ `auth-form.tsx` / `login/page.tsx` 接続 | B-04 | 1.4h | Passkey でログインできる |
| P6-D-03 | `StrongReauthDialog` の Passkey タブ | B-08 | 1.2h | Passkey タブで 2FA 無効化・Passkey 削除が通る |
| P6-D-04 | `messages/ja.ts` の文言追加 | — | 0.3h | 型安全に引ける |
| P6-D-05 | `security.passkeyCount` / `notAvailable` の後始末 | D-01 | 0.5h | 未使用文言を整理 |

### 13.5 合計

| 区分 | 工数 |
|---|---|
| P6-A 基盤 | 8.9h |
| P6-B API / フロー | 10.3h |
| P6-C セキュリティテスト | 6.2h |
| P6-D UI | 5.0h |
| **合計** | **30.4h（約 4 日）** |

> 計画 `実装計画.md` §15 の見積もり「2〜3 日」を**上回る**。理由は **`webauthn-mock.ts`（実鍵での署名生成・1.5h）**、**許可リスト検証を含む config（1.2h）**、**challenge の 1 回限り消費と atomic sign_count（2.4h）**、**強い再認証への差し込み（1.5h）** を含むこと。**計画側の見積もりを 4 日に更新することを推奨**（§17 改訂履歴）。

---

## 14. 完了定義（DoD）

計画 `実装計画.md` §15 の Phase 6 DoD を、確認可能な形に展開する。**すべて green で M6 達成**。

### 14.1 機能

- [ ] `/settings/security` から Passkey を**複数登録**できる（`device_name` / 追加日時 / 最終使用が出る）
- [ ] DB には**公開鍵のみ**が保存される（秘密鍵はサーバに送られない）
- [ ] `/login` の「[パスキーでログイン]」でパスワード無しにログインでき、**新セッション**が発行される
- [ ] Passkey を削除でき、**最後のログイン手段**の削除は 409 で拒否される
- [ ] Passkey の追加・削除で通知メールが送られる（best-effort）
- [ ] `strong_reauth_methods` に `'passkey'` が含まれ、**2FA 無効化・再生成が Passkey でも通る**

### 14.2 セキュリティ（§48 / §64）

- [ ] **challenge が 1 回限り**（`webauthn-challenge-reuse.test.ts`）
- [ ] **origin 不一致を拒否**（`webauthn-origin.test.ts`）
- [ ] **rpID 不一致を拒否**（`webauthn-rpid.test.ts`）
- [ ] **sign_count の後退を拒否**（`webauthn-signcount.test.ts`）。`newCounter === 0` は通る
- [ ] **削除済み credential の認証を拒否**（`webauthn-deleted.test.ts`）
- [ ] 登録・削除に**再認証**が必要（`passkey-reauth.test.ts`）
- [ ] `credential_id` / `public_key` / `challenge` / `signature` がログ・応答・metadata に 1 件も現れない（`log-redaction.test.ts` ＋ `webauthn-login.test.ts`）
- [ ] Passkey 入力が 30/5分で制限される（`rate-limit.test.ts`）
- [ ] `rpID` / `origin` が request ヘッダから導出されていない（静的検査・§11.3）

### 14.3 品質ゲート（各 PR）

- [ ] `pnpm lint`（0 errors）
- [ ] `pnpm typecheck`
- [ ] `pnpm test`（既存＋Phase 6 の新規が green）
- [ ] `pnpm build`
- [ ] `pnpm db:verify-migrations`（0018 の up/down/往復）
- [ ] §20.3 の DoD チェックリスト（計画書）を全項目確認
  - 新規 API が `withAuthPipeline` / レート制限 / `require*` ガードを通っているか
  - 秘密情報がログ・応答・metadata に漏れていないか（§45）
  - 認可をサーバー側で行っているか（§49）
  - `security_events` へ記録しているか
  - 新テーブル/列に制約・index・migration があるか
  - mutation が POST/PUT/PATCH/DELETE か（§25）
  - **「1 回限り」の値（challenge / sign_count）が atomic 更新か**
  - エラーが統一形式（§58）か

### 14.4 実機での手動確認（実装後に実施）

1. `/settings/security` から Passkey を登録できる（Touch ID / Windows Hello / セキュリティキー）
2. 同じ端末で 2 つ目の Passkey（別の認証器）を登録できる
3. ログアウト → `/login` →「[パスキーでログイン]」でログインできる
4. 別の端末（同期 passkey）でもログインできる
5. Passkey を削除 → 同じ Passkey でログインできない
6. **パスワード未設定・Passkey 1 件・TOTP 無効**のユーザーで削除 → 409 で拒否される
7. 2FA 無効化ダイアログで **Passkey タブ**が出て、Passkey で無効化できる
8. 時計を進めた端末でもログインできる（`sign_count` が 0 の端末で確認）
9. 開発者ツールで `login/verify` の body を改竄（別 origin 相当）→ 400 になる

---

## 15. リスクと対策

| # | リスク | 影響 | 確率 | 対策 |
|---|---|---|---|---|
| R1★ | **`expectedOrigin` / `expectedRPID` / `expectedChallenge` の組み立てミス** | 全検証が素通り（origin 偽装が通る）or 全滅（正規ログイン不可） | 中 | D-34-01 を `config.ts` に閉じ込め、`webauthn-origin` / `webauthn-rpid` を**最初に**書く。`config` は request ヘッダを受け取らない（静的検査・§11.3） |
| R2★ | **challenge の消費が read → 判定 → write になる** | 並行 replay が成立。§48 未達 | 中 | D-34-05 を**単文 UPDATE** で固定。`passkey-challenge.test.ts` を**最初に**書く（TDD） |
| R3★ | **`sign_count` を厳密な単調増加にして正規ログインが全滅** | プラットフォーム passkey で誰もログインできない | 中 | D-34-06 で `newCounter === 0` を例外にする。`webauthn-signcount.test.ts` で 0 ケースを通す |
| R4 | **`userID` を毎回ランダムにしてしまう** | 同じユーザーの Passkey が別ユーザー扱いになり、discoverable ログインで解決できない | 中 | `generatePasskeyRegistrationOptions` で `userID` を `user.id` の bytes に**固定**（§7.3.2）。`passkey-registration.test.ts` で固定を検証 |
| R5★ | **テスト用の署名付き応答が作れず、実 HTTP テストが書けない** | DoD の 5 テストが green にできない | 高 | `webauthn-mock.ts` を**最初に**作る（P6-A-07）。`@simplewebauthn/server` の検証を通る最小の attestation / assertion を実鍵で生成し、単体で検証できることを先に確認する |
| R6 | `@simplewebauthn/browser` をサーバ側で import して bundle が壊れる | ビルド失敗 | 低 | `browser` は**クライアントコンポーネントからのみ** import する。静的検査（§11.3）に追加 |
| R7 | `env.ts` の WebAuthn 変数が dev/test で未設定 → 起動失敗 | 開発・テストが止まる | 中 | `NODE_ENV !== 'production'` は `localhost` の既定値を入れる。`src/test/setup.ts` にも注入する |
| R8 | `availableStrongReauthMethods` の非同期化で既存呼び出しが壊れる | 手戻り | 中 | `GET /2fa` と `/settings/security` の 2 箇所のみ。`await` に更新し、`strong-reauth.test.ts` で固定 |
| R9 | `jsonb` の `transports` の型が `unknown` になる | 型エラー・実行時 cast ミス | 低 | `$type<string[]>()` を明示（§6.3）。統合テストで往復を確認 |
| R10 | 通知メール送信失敗で登録が失敗する | 登録できない | 低 | `deliverEmailSafely`（best-effort）。失敗しても 200 を返す（既存方針） |
| R11 | `sign_count` 更新と challenge 消費の順序ミスで、失敗時に challenge が再利用可能になる | replay の穴 | 中 | challenge を**先に消費**する（§8.5）。失敗しても消費済みのままにする |
| R12 | クライアント境界（BUG-11）の再発（`passkey/config` をクライアントから import） | hydration mismatch | 中 | `oauth-client-boundary.test.ts` に Passkey の項目を追加（P6-A-08） |
| R13 | 削除の owner 確認漏れ（IDOR） | 他人の Passkey を削除できる | 中 | `deleteCredential(id, userId)` を必須にし、`webauthn-deleted.test.ts` / `passkey-reauth.test.ts` で固定（§49） |

---

## 16. 仕様トレーサビリティ

| 仕様 | 章 | 担当タスク | テスト |
|---|---|---|---|
| Passkey の複数登録・登録情報 | §12 | P6-A-02, A-06, B-01, B-02 | `webauthn-register.test.ts`, `webauthn-queries.test.ts` |
| 公開鍵のみ保存・秘密鍵を送らない | §12 | P6-B-02 | `webauthn-register.test.ts` |
| WebAuthn Level 3 準拠 | §12 | P6-A-06 | `passkey-registration.test.ts`, `passkey-authentication.test.ts` |
| Passkey API 6 本 | §32 | P6-B-01〜B-06 | `webauthn-register.test.ts`, `webauthn-login.test.ts` |
| Passkey 削除時の再認証 | §8 / §32 | P6-B-06, B-08 | `passkey-reauth.test.ts` |
| Passkey 追加・削除の通知 | §18 | P6-B-02, B-06, B-09 | `webauthn-register.test.ts`, `passkey-reauth.test.ts` |
| `security_events`: passkey_added / passkey_removed | §21 | P6-B-02, B-06 | `security-events-coverage.test.ts` |
| 機密値の redaction | §45 | P6-A-08 | `log-redaction.test.ts` |
| レート制限（Passkey 独立制御） | §16 / §56 | P6-B-01〜B-04 | `rate-limit.test.ts` |
| challenge 再利用の拒否 | §48 | P6-A-05, C-01 | `webauthn-challenge-reuse.test.ts` |
| origin mismatch の拒否 | §48 / D-26 | P6-A-03, C-02 | `webauthn-origin.test.ts` |
| RP ID mismatch の拒否 | §48 / D-26 | P6-A-03, C-03 | `webauthn-rpid.test.ts` |
| credential 削除後の認証拒否 | §48 | P6-B-06, C-05 | `webauthn-deleted.test.ts` |
| sign counter 処理 | §48 | P6-A-04, C-04 | `webauthn-signcount.test.ts` |
| CSRF（状態変更は POST + トークン） | §25 | 全 API（共通パイプライン） | `csrf.test.ts` |
| ログイン画面の Passkey ボタン | §35 | P6-D-02 | `webauthn-login.test.ts`（HTTP） |
| セキュリティ設定画面の Passkey 数 | §37 | P6-D-01 | `webauthn-queries.test.ts` |
| 自作禁止（WebAuthn 検証） | §67 | P6-A-06 | コードレビュー（`@simplewebauthn/server` 使用） |
| 完了条件「高度な認証」Passkey | §64 | 全体 | DoD §14 |

---

## 17. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-24 | 初版（**設計のみ・実装は未着手**）。`実装計画.md` §15 と仕様 §12 / §32 / §8 / §48 / §64 に基づき、DB・API・フロー・脅威・テスト・UI・工数を確定。D-34-01〜D-34-16 を新規採番。Phase 5 の `strong-reauth.ts` 検証器配列へ Passkey を 1 件追加する方針（D-33-24 の約束）を明記 |

---

## 18. 次フェーズへの引継ぎメモ

- **Phase 7（管理者）**: §51 の「管理者は 2FA 必須・Passkey 推奨」は、Phase 5 の `GET /api/auth/2fa` と **Phase 6 の `GET /api/auth/passkey`** を組み合わせて**ログイン時に強制**できる。`users.role_id` で判定する。管理画面からは **Passkey の公開鍵も表示しない**（§51）。
- **Phase 7（監査）**: `passkey_added` / `passkey_removed` は `security_events` に既に乗る。`admin_audit_logs` は別テーブル（§61）で、Phase 6 のイベントとは分離する。
- **Phase 8-B（実ブラウザ）**: `navigator.credentials` の Ceremony は Playwright の**仮想 authenticator**（CDP `WebAuthn.addVirtualAuthenticator`）で検証する。Phase 6 は**サーバ検証を実鍵で通す**ところまで。`webauthn-mock.ts` は Playwright からも再利用できる形にしておく。
- **Phase 9（運用）**: 本番ドメイン確定時に `WEBAUTHN_RP_ID` / `WEBAUTHN_ALLOWED_ORIGINS` を固定する（D-34-01）。**dev と prod で同一値を放置しない**（`env.ts` が fail fast する）。
- **共通パイプライン**: Phase 6 は `denyPasskeyPending` を**追加しない**（D-34-09）。Phase 7 で「管理者は Passkey 必須」を入れる場合、新たな `require*` ガードとして足す（既存の `denyTotpPending` と同じ fail closed の原則）。
- **`sessions.passkey_pending` 列**: Phase 6 では未使用のまま残る。将来「パスワード → Passkey の 2 段」を採る場合に使う。**使わない理由を D-34-09 に記録済み**。
- **`実装Todo.md` の更新**: §8 の P6 セクションに、新規ファイル **18**・テスト **13**・migration **0018**・工数 **30.4h** を反映する。P6-A-01a/b/c（env 明示設定）は **D-34-01 に統合**した旨を注記する。
- **`README.md` / `AGENTS.md`**: Phase 6 完了時に「現在の到達点」を M6 完了へ更新し、Phase 6 の実装詳細節を追記する（Phase 4 / 5 と同じ体裁）。
